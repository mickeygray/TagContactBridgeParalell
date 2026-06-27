"use strict";

// claudeAgentRunner — the ONE live seam for the warm coach orchestrator.
//
// Spawns an ephemeral, HARNESS-STRIPPED `claude -p` agent on the MAX SUBSCRIPTION
// (not the metered API): deletes ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN from the
// child env so the CLI uses the logged-in Max session (flat cost). Returns
// { ok, json, text, usage } matching the orchestrator's runner contract.
//
// ── Why the lean flags matter (measured on a real box) ───────────────────────
// A bare `claude -p` loads the whole Claude Code agent harness per spawn — its
// system prompt + every MCP/tool definition + user settings (CLAUDE.md / MEMORY.md)
// — ~29K of context the composer never needs. Measured lag: 48s. Stripping it:
//   --system-prompt-file        REPLACE the giant CC system prompt (file form is
//                               shell-safe; the prompt itself rides stdin)
//   --exclude-dynamic-system-prompt-sections
//   --strict-mcp-config         no MCP servers (the bulk of the tool defs)
//   --setting-sources project + clean cwd   skip user CLAUDE.md / MEMORY.md / skills
//   --disallowedTools ...       no built-in tool schemas
// brought it to ~9-10s, of which the CLI boot is ~150ms and the rest is the agent
// path's ttft floor. Repeat spawns ride the server-side prompt cache (cache_read).

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const DISALLOWED_TOOLS =
  "Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,Task,TodoWrite,NotebookEdit,MultiEdit";

// A clean working dir so --setting-sources project finds no project CLAUDE.md.
function leanCwd() {
  const dir = path.join(os.tmpdir(), "coach-spawn-cwd");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {}
  return dir;
}

// Stable, content-hashed temp file for the system prompt (reused across spawns so
// the server-side prompt cache hits; file form dodges shell-quoting of a multi-word
// --system-prompt under shell:true).
function systemPromptFile(system) {
  const hash = crypto.createHash("sha1").update(String(system)).digest("hex").slice(0, 12);
  const p = path.join(os.tmpdir(), `coach-sys-${hash}.txt`);
  try {
    if (!fs.existsSync(p)) fs.writeFileSync(p, String(system));
  } catch (_) {}
  return p;
}

function extractJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    const m = String(text).match(/\{[\s\S]*\}/); // tolerate ```json fences / preamble
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch (_) {
        return null;
      }
    }
    return null;
  }
}

function createClaudeAgentRunner(opts = {}) {
  const {
    model = "haiku", // the render seat — fast, faithful on supplied content
    bin = "claude",
    timeoutMs = 30000,
    spawnImpl = spawn, // injectable so tests drive the wiring without a real binary
    cwd = leanCwd(),
    extraArgs = [], // extra single-token CLI args (e.g. ["--settings", "/path/fast.json"])
    effort = "low", // a one-line render from supplied doctrine needs no deep reasoning
    // maxThinkingTokens: 0 = thinking OFF (the composer: 0 thinking, 100% fed prompt,
    // ~5s bounded). Pass null to let the model think (navigator/grader/blog "think a
    // little"). Any other number caps the thinking budget.
    maxThinkingTokens = 0,
  } = opts;

  return async function run(req = {}) {
    const { system, prompt, schema } = req;

    const shapeHint =
      schema && schema.properties
        ? `Return ONLY a JSON object with these keys (no prose, no code fences): ${Object.keys(schema.properties).join(", ")}`
        : null;
    const stdinInput = [prompt, shapeHint].filter(Boolean).join("\n\n");

    const args = [
      "-p",
      "--output-format",
      "json",
      "--model",
      model,
      "--effort",
      effort,
      "--exclude-dynamic-system-prompt-sections",
      "--strict-mcp-config",
      "--setting-sources",
      "project",
      "--disallowedTools",
      DISALLOWED_TOOLS,
    ];
    if (system) args.push("--system-prompt-file", systemPromptFile(system));
    if (Array.isArray(extraArgs) && extraArgs.length) args.push(...extraArgs);

    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY; // force the Max session
    delete env.ANTHROPIC_AUTH_TOKEN;
    // Thinking control — the headless equivalent of the web client's thinking
    // toggle. maxThinkingTokens=0 disables it: collapses Haiku's output from
    // 1000-4700 thinking tokens to ~110 and the lag from 10-40s (unbounded) to
    // ~5s (bounded). --effort only LOWERS thinking; this KILLS it. Pass null to
    // let a thinker (navigator/grader) reason. (No effect on Fable 5.)
    if (maxThinkingTokens != null) env.MAX_THINKING_TOKENS = String(maxThinkingTokens);

    return await new Promise((resolve) => {
      let child;
      try {
        child = spawnImpl(bin, args, { env, shell: true, cwd });
      } catch (e) {
        return resolve({ ok: false, error: `spawn: ${String((e && e.message) || e)}` });
      }
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch (_) {}
        resolve({ ok: false, error: "timeout" });
      }, timeoutMs);

      child.stdout.on("data", (d) => {
        out += d;
      });
      child.stderr.on("data", (d) => {
        err += d;
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ ok: false, error: String((e && e.message) || e) });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) return resolve({ ok: false, error: err.trim() || `exit ${code}`, text: out });
        const envelope = extractJson(out); // claude -p --output-format json wrapper
        const text = (envelope && (envelope.result || envelope.text)) || out;
        const json = extractJson(text);
        resolve({ ok: true, json, text, usage: envelope && envelope.usage, raw: envelope });
      });

      try {
        child.stdin.write(stdinInput);
        child.stdin.end();
      } catch (e) {
        clearTimeout(timer);
        resolve({ ok: false, error: `stdin: ${String((e && e.message) || e)}` });
      }
    });
  };
}

module.exports = { createClaudeAgentRunner, DISALLOWED_TOOLS };
