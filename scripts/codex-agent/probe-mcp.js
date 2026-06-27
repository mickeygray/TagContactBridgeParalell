"use strict";

// Throwaway probe: spawn `codex mcp-server`, do the MCP handshake (initialize +
// tools/list), print the tool names + input schemas, exit. NO model call, NO
// billing — tools/list is free. Points CODEX_HOME at a scratch dir so it never
// touches the real ~/.codex. Used once to ground the real client in the actual
// protocol of this codex build, then deleted.

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CODEX_BIN =
  process.env.CODEX_CLI_PATH ||
  "C:\\Users\\micke\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe";

const scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-probe-"));

const env = { ...process.env, CODEX_HOME: scratchHome };
delete env.OPENAI_API_KEY; // prove the no-key path doesn't break the handshake

const child = spawn(CODEX_BIN, ["mcp-server"], {
  env,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

let buf = "";
const pending = new Map();
let nextId = 1;

function send(method, params, isNotification = false) {
  const msg = { jsonrpc: "2.0", method, ...(params ? { params } : {}) };
  if (!isNotification) {
    const id = nextId++;
    msg.id = id;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify(msg) + "\n");
    });
  }
  child.stdin.write(JSON.stringify(msg) + "\n");
  return Promise.resolve();
}

child.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.log("[non-json]", line);
      continue;
    }
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else {
      console.log("[notify]", JSON.stringify(msg).slice(0, 200));
    }
  }
});

child.stderr.on("data", (d) => process.stderr.write("[codex stderr] " + d));
child.on("exit", (code) => console.log("\n(codex mcp-server exited", code + ")"));

(async () => {
  const init = await send("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "codex-probe", version: "0.0.1" },
  });
  console.log("=== initialize result ===");
  console.log(JSON.stringify(init.result || init.error, null, 2).slice(0, 1200));

  await send("notifications/initialized", {}, true);

  const tools = await send("tools/list", {});
  console.log("\n=== tools/list ===");
  const list = (tools.result && tools.result.tools) || [];
  for (const t of list) {
    console.log("\n• tool:", t.name);
    if (t.description) console.log("  desc:", String(t.description).slice(0, 160));
    const full = t.name === "codex";
    console.log("  required:", JSON.stringify((t.inputSchema && t.inputSchema.required) || []));
    console.log("  props:", Object.keys((t.inputSchema && t.inputSchema.properties) || {}).join(", "));
    if (full) console.log("  FULL inputSchema:", JSON.stringify(t.inputSchema || {}, null, 1));
  }
  if (!list.length) console.log(JSON.stringify(tools.result || tools.error, null, 2).slice(0, 800));

  child.kill();
  setTimeout(() => {
    try {
      fs.rmSync(scratchHome, { recursive: true, force: true });
    } catch {}
    process.exit(0);
  }, 300);
})().catch((e) => {
  console.error("probe failed:", e);
  child.kill();
  process.exit(1);
});

setTimeout(() => {
  console.error("probe timeout (15s)");
  child.kill();
  process.exit(1);
}, 15000);
