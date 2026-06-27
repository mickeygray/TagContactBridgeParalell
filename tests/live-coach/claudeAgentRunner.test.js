"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { createClaudeAgentRunner } = require("../../scripts/claudeAgentRunner");

// A fake spawn: stands in for the `claude` binary so the runner's wiring (env
// stripping, arg construction, envelope parsing, error path) is verifiable offline.
// The only thing this can't prove is that the REAL claude CLI honors these args —
// that's the one box-only check.
function fakeSpawn({ stdout = "", stderr = "", code = 0, capture } = {}) {
  return (bin, args, optsArg) => {
    const cap = { bin, args, env: optsArg.env, opts: optsArg, stdin: "" };
    if (capture) capture(cap);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write(d) { cap.stdin += String(d); }, end() {} };
    child.kill = () => {};
    setImmediate(() => {
      if (stdout) child.stdout.emit("data", stdout);
      if (stderr) child.stderr.emit("data", stderr);
      child.emit("close", code);
    });
    return child;
  };
}

test("strips ANTHROPIC_API_KEY / AUTH_TOKEN from the child env (forces the Max session)", async () => {
  let captured;
  const run = createClaudeAgentRunner({
    spawnImpl: fakeSpawn({ stdout: JSON.stringify({ result: '{"action":"wait"}' }), capture: (c) => { captured = c; } }),
  });
  process.env.ANTHROPIC_API_KEY = "sk-test-should-be-stripped";
  process.env.ANTHROPIC_AUTH_TOKEN = "tok-should-be-stripped";
  try {
    await run({ prompt: "hi" });
    assert.equal(captured.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(captured.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(captured.env.MAX_THINKING_TOKENS, "0"); // composer default: thinking off -> bounded ~5s
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  }
});

test("a thinker (maxThinkingTokens: null) leaves thinking ON — no MAX_THINKING_TOKENS override", async () => {
  let captured;
  const run = createClaudeAgentRunner({
    model: "sonnet",
    maxThinkingTokens: null, // navigator/grader: think a little
    spawnImpl: fakeSpawn({ stdout: JSON.stringify({ result: "{}" }), capture: (c) => { captured = c; } }),
  });
  const before = process.env.MAX_THINKING_TOKENS;
  await run({ prompt: "plan the call" });
  // the runner did not force thinking off for this spawn
  assert.equal(captured.env.MAX_THINKING_TOKENS, before);
  assert.ok(captured.args.includes("sonnet"));
});

test("parses the claude -p json envelope down to the inner JSON + usage", async () => {
  const run = createClaudeAgentRunner({
    spawnImpl: fakeSpawn({ stdout: JSON.stringify({ result: '{"action":"compose","read":"r","steer":"s"}', usage: { input_tokens: 100, output_tokens: 20 } }) }),
  });
  const res = await run({ prompt: "x", system: "sys", schema: { properties: { action: {}, read: {}, steer: {} } } });
  assert.equal(res.ok, true);
  assert.deepEqual(res.json, { action: "compose", read: "r", steer: "s" });
  assert.equal(res.usage.input_tokens, 100);
});

test("uses the harness-stripping flags, replaces system via --system-prompt-file, and sends the prompt on stdin", async () => {
  const fs = require("node:fs");
  let captured;
  const run = createClaudeAgentRunner({
    model: "haiku",
    spawnImpl: fakeSpawn({ stdout: JSON.stringify({ result: "{}" }), capture: (c) => { captured = c; } }),
  });
  await run({ prompt: "the user prompt", system: "THE SYSTEM RULES", schema: { properties: { action: {}, read: {} } } });
  const A = captured.args;
  // lean flags that bring the spawn from ~48s to ~10s
  assert.ok(A.includes("haiku") && A.includes("--output-format") && A.includes("json"));
  assert.ok(A.includes("--strict-mcp-config"));
  assert.ok(A.includes("--exclude-dynamic-system-prompt-sections"));
  assert.ok(A.includes("--setting-sources") && A[A.indexOf("--setting-sources") + 1] === "project");
  assert.ok(A.includes("--disallowedTools"));
  assert.equal(captured.opts.shell, true); // required for the Windows .cmd shim
  assert.ok(captured.opts.cwd && /coach-spawn-cwd/.test(captured.opts.cwd)); // clean cwd: no project CLAUDE.md
  // system is REPLACED via a file (shell-safe), not folded into stdin
  const i = A.indexOf("--system-prompt-file");
  assert.ok(i >= 0);
  assert.match(fs.readFileSync(A[i + 1], "utf8"), /THE SYSTEM RULES/);
  assert.equal(/THE SYSTEM RULES/.test(captured.stdin), false);
  // prompt + schema hint ride stdin
  assert.match(captured.stdin, /the user prompt/);
  assert.match(captured.stdin, /action, read/);
});

test("a non-zero exit surfaces ok:false with stderr (composer falls through to WAIT)", async () => {
  const run = createClaudeAgentRunner({ spawnImpl: fakeSpawn({ stderr: "boom", code: 1 }) });
  const res = await run({ prompt: "x" });
  assert.equal(res.ok, false);
  assert.match(res.error, /boom/);
});

test("the runner result feeds parseComposerResult cleanly (ok:false => no item)", async () => {
  const { parseComposerResult } = require("../../packages/shared-services/src/coachComposer");
  const run = createClaudeAgentRunner({ spawnImpl: fakeSpawn({ stderr: "down", code: 1 }) });
  const res = await run({ prompt: "x" });
  // a failed spawn must not crash the orchestrator — it just yields no feedback item
  assert.equal(parseComposerResult(res, { id: "c1", at: 1000 }), null);
});
