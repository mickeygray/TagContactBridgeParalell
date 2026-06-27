"use strict";

// Smoke the warm Codex MCP client.
//   node scripts/codex-agent/smoke-codex.js --probe          # FREE: handshake + tools/list, no model call, no billing
//   node scripts/codex-agent/smoke-codex.js --ask "hello"    # ONE real round-trip (bills the CODEX_HOME account)
//
// Honors CODEX_HOME (which account), CODEX_CLI_PATH (binary), CODEX_AGENT_MODEL.
// OPENAI_API_KEY is stripped by the client so the call rides the subscription.

const { createCodexMcpClient } = require("./codexMcpClient");

const args = process.argv.slice(2);
const mode = args.includes("--ask") ? "ask" : "probe";
const askText = (() => {
  const i = args.indexOf("--ask");
  return i >= 0 && args[i + 1] ? args[i + 1] : "Reply with exactly the single word: READY";
})();

(async () => {
  const events = [];
  const client = createCodexMcpClient({
    onEvent: (m) => {
      // Record the streamed codex/event shapes so the first real run reveals them.
      const t = m.params && m.params.msg && m.params.msg.type;
      events.push({ method: m.method, type: t || null });
    },
    onStderr: (s) => {
      const line = s.trim();
      if (line) process.stderr.write("[codex] " + line + "\n");
    },
  });

  const info = await client.start();
  console.log("connected:", JSON.stringify(info).slice(0, 200));
  console.log("CODEX_HOME:", client.codexHome || process.env.CODEX_HOME || "(default ~/.codex)");

  const tools = await client.listTools();
  console.log("tools:", tools.map((t) => t.name).join(", "), " (tools/list = free, no billing)");

  if (mode === "ask") {
    console.log(`\nasking (real call): ${JSON.stringify(askText)}`);
    const started = Date.now();
    const res = await client.ask(askText, {
      baseInstructions: "You are a terse echo. Follow the user's instruction literally and reply with nothing else.",
      timeoutMs: 90000,
    });
    const ms = Date.now() - started;
    console.log(`\n=== result (${ms}ms) ===`);
    console.log("text:", JSON.stringify(res.text));
    console.log("threadId:", res.threadId);
    console.log("event methods seen:", JSON.stringify(events.slice(0, 40)));
    console.log("raw result keys:", res.raw ? Object.keys(res.raw).join(", ") : "(none)");
    if (!res.text) {
      console.log("\n!! no text extracted — raw result for parser tuning:");
      console.log(JSON.stringify(res.raw, null, 1).slice(0, 2000));
    }
  } else {
    console.log("\n(probe only — no model call. Use --ask \"...\" for a real round-trip.)");
  }

  client.stop();
  setTimeout(() => process.exit(0), 200);
})().catch((e) => {
  console.error("smoke failed:", e && e.stack ? e.stack : e);
  process.exit(1);
});
