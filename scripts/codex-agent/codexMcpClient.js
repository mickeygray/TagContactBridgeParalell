"use strict";

// Warm Codex MCP client — holds ONE long-lived `codex mcp-server` (stdio) so the
// process/cold-start cost is paid once, then each request is a tools/call over
// the already-open pipe. This is the "daemon" core: a persistent agent driven by
// the ChatGPT SUBSCRIPTION (not the metered API), isolated to its own account
// via a dedicated CODEX_HOME.
//
// SUBSCRIPTION-AUTH discipline (the whole point):
//   - CODEX_HOME points at a dedicated dir seeded with the $20 account's login,
//     so it never shares auth/rate-window with the interactive desktop Codex.
//   - OPENAI_API_KEY (and OPENAI_BASE_URL) are STRIPPED from the child env — if a
//     key is present, codex silently switches to per-token API billing. Mirrors
//     the claude-agent childEnv() trick that strips ANTHROPIC_API_KEY for Max.
//
// Protocol grounded against codex-mcp-server 0.130.0-alpha.5 (MCP 2025-06-18):
//   tool "codex"       {prompt, base-instructions?, model?, sandbox?, approval-policy?, cwd?}
//   tool "codex-reply" {threadId, prompt}
//   during a run the server streams "codex/event" notifications; the assistant's
//   final text arrives as an agent_message event and/or the tools/call result.
//
// Injectable (codexBin/spawn) so it unit-tests with a fake server, no codex.exe.

const { spawn: nodeSpawn } = require("child_process");

const DEFAULT_BIN =
  process.platform === "win32"
    ? "C:\\Users\\micke\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe"
    : "codex";

function createCodexMcpClient(opts = {}) {
  const codexBin = opts.codexBin || process.env.CODEX_CLI_PATH || DEFAULT_BIN;
  const codexHome = opts.codexHome || process.env.CODEX_HOME || undefined;
  const spawn = opts.spawn || nodeSpawn;
  const model = opts.model || process.env.CODEX_AGENT_MODEL || undefined;
  const sandbox = opts.sandbox || "read-only";
  const approvalPolicy = opts.approvalPolicy || "never";
  const baseInstructions = opts.baseInstructions || undefined;
  const cwd = opts.cwd || undefined;
  const defaultTimeoutMs = Number(opts.timeoutMs || process.env.CODEX_AGENT_TIMEOUT_MS || 60000);
  const onEvent = typeof opts.onEvent === "function" ? opts.onEvent : null;

  let child = null;
  let buf = "";
  let nextId = 1;
  const pending = new Map(); // id -> {resolve, reject, timer}
  let started = null;

  function childEnv() {
    const env = { ...process.env };
    delete env.OPENAI_API_KEY; // force ChatGPT-subscription billing, never metered API
    delete env.OPENAI_BASE_URL;
    if (codexHome) env.CODEX_HOME = codexHome;
    return env;
  }

  function rpc(method, params, { timeoutMs = defaultTimeoutMs, isNotification = false } = {}) {
    const msg = { jsonrpc: "2.0", method, ...(params ? { params } : {}) };
    if (isNotification) {
      child.stdin.write(JSON.stringify(msg) + "\n");
      return Promise.resolve();
    }
    const id = nextId++;
    msg.id = id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`codex rpc timeout (${method}, ${timeoutMs}ms)`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify(msg) + "\n");
    });
  }

  function handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // ignore non-JSON banner/log lines
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id);
      clearTimeout(timer);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`codex rpc error: ${JSON.stringify(msg.error).slice(0, 300)}`));
      else resolve(msg.result);
      return;
    }
    // Notification (e.g. codex/event with a streamed msg). Surface for callers
    // that want token/agent_message streaming; otherwise ignored.
    if (onEvent && msg.method) onEvent(msg);
  }

  async function start() {
    if (started) return started;
    started = (async () => {
      child = spawn(codexBin, ["mcp-server"], {
        env: childEnv(),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      child.on("exit", (code) => {
        for (const { reject, timer } of pending.values()) {
          clearTimeout(timer);
          reject(new Error(`codex mcp-server exited (${code}) with request in flight`));
        }
        pending.clear();
        child = null;
        started = null;
      });
      child.stdout.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) handleLine(line);
        }
      });
      if (opts.onStderr) child.stderr.on("data", (d) => opts.onStderr(d.toString("utf8")));

      const init = await rpc(
        "initialize",
        { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex-agent-daemon", version: "0.1.0" } },
        { timeoutMs: 15000 },
      );
      await rpc("notifications/initialized", {}, { isNotification: true });
      return init && init.serverInfo ? init.serverInfo : init;
    })();
    return started;
  }

  async function listTools() {
    await start();
    const res = await rpc("tools/list", {}, { timeoutMs: 15000 });
    return (res && res.tools) || [];
  }

  // Pull the assistant's final text + the thread id out of a tools/call result.
  // The result carries structuredContent / content text blocks; thread id rides
  // in structuredContent or a session/thread field. Tolerant by design.
  function extractFinal(result) {
    const out = { text: "", threadId: null, raw: result };
    if (!result) return out;
    const sc = result.structuredContent || result.structured_content || {};
    out.threadId =
      sc.threadId || sc.thread_id || sc.conversationId || sc.conversation_id || sc.sessionId || sc.session_id || null;
    if (typeof sc.agentMessage === "string") out.text = sc.agentMessage;
    else if (typeof sc.message === "string") out.text = sc.message;
    if (!out.text && Array.isArray(result.content)) {
      out.text = result.content
        .filter((c) => c && c.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("\n")
        .trim();
    }
    return out;
  }

  async function ask(prompt, overrides = {}) {
    await start();
    const args = { prompt: String(prompt) };
    const bi = overrides.baseInstructions || baseInstructions;
    if (bi) args["base-instructions"] = bi;
    const m = overrides.model || model;
    if (m) args.model = m;
    args.sandbox = overrides.sandbox || sandbox;
    args["approval-policy"] = overrides.approvalPolicy || approvalPolicy;
    if (overrides.cwd || cwd) args.cwd = overrides.cwd || cwd;
    const result = await rpc(
      "tools/call",
      { name: "codex", arguments: args },
      { timeoutMs: overrides.timeoutMs || defaultTimeoutMs },
    );
    return extractFinal(result);
  }

  async function reply(threadId, prompt, overrides = {}) {
    await start();
    const result = await rpc(
      "tools/call",
      { name: "codex-reply", arguments: { threadId, prompt: String(prompt) } },
      { timeoutMs: overrides.timeoutMs || defaultTimeoutMs },
    );
    return extractFinal(result);
  }

  function stop() {
    if (child) {
      try {
        child.kill();
      } catch {}
      child = null;
      started = null;
    }
  }

  return { start, listTools, ask, reply, stop, get codexHome() { return codexHome; } };
}

module.exports = { createCodexMcpClient };
