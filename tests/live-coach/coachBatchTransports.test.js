"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  createDeepPullTransport,
  createReactorTransport,
} = require("../../apps/ai-bus/src/coachBatchTransports");
const { parseBatchGuidance } = require("../../packages/shared-services/src/coachBatchRunner");

// ── Reactor (Anthropic direct fetch) ────────────────────────────────────────

test("reactor is DISABLED (null) when the separate key is unset — never falls back to the shared key", () => {
  const runner = createReactorTransport({ env: { ANTHROPIC_API_KEY: "shared-key-should-not-be-used" } });
  assert.equal(runner, null);
});

test("reactor posts to Anthropic with the separate key + cached system, and feeds parseBatchGuidance", async () => {
  let captured = null;
  const fakeFetch = async (url, init) => {
    captured = { url, init, body: JSON.parse(init.body) };
    return {
      ok: true,
      json: async () => ({
        model: "claude-haiku-4-5",
        usage: { input_tokens: 10, output_tokens: 20 },
        content: [
          {
            type: "text",
            text: JSON.stringify({
              guidance: [
                { sessionId: "coach-A", uii: "uii-A", agentEmail: "sean@tag.com", mode: "reaction", try: "what has waiting cost you?" },
              ],
            }),
          },
        ],
      }),
    };
  };

  const runReactor = createReactorTransport({
    env: { LIVE_COACH_REACTOR_ANTHROPIC_API_KEY: "reactor-only-key" },
    fetchImpl: fakeFetch,
  });
  assert.equal(typeof runReactor, "function");

  const res = await runReactor({ system: "REFERENCE + CONTRACT", prompt: "CHANGED CALLS: ..." });
  assert.equal(res.ok, true);

  // Right endpoint, the SEPARATE key, the cached system block, volatile prompt as user msg.
  assert.equal(captured.url, "https://api.anthropic.com/v1/messages");
  assert.equal(captured.init.headers["x-api-key"], "reactor-only-key");
  assert.equal(captured.body.model, "claude-haiku-4-5");
  assert.equal(captured.body.system[0].cache_control.type, "ephemeral");
  assert.equal(captured.body.system[0].text, "REFERENCE + CONTRACT");
  assert.equal(captured.body.messages[0].content, "CHANGED CALLS: ...");

  // Output flows straight into the parser.
  const parsed = parseBatchGuidance(res);
  assert.equal(parsed.guidance.length, 1);
  assert.equal(parsed.guidance[0].sessionId, "coach-A");
  assert.equal(parsed.guidance[0].try, "what has waiting cost you?");
});

test("reactor returns ok:false on an HTTP error (loop treats it as a no-op, cursor not advanced)", async () => {
  const fakeFetch = async () => ({ ok: false, status: 429, text: async () => "rate limited" });
  const runReactor = createReactorTransport({
    env: { LIVE_COACH_REACTOR_ANTHROPIC_API_KEY: "k" },
    fetchImpl: fakeFetch,
  });
  const res = await runReactor({ system: "s", prompt: "p" });
  assert.equal(res.ok, false);
  assert.match(res.error, /429/);
});

// ── Deep pull (claude -p / Max) ──────────────────────────────────────────────

function fakeSpawn(envelope) {
  const calls = [];
  function spawnImpl(bin, args) {
    calls.push({ bin, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write() {}, end() {} };
    child.kill = () => {};
    process.nextTick(() => {
      child.stdout.emit("data", JSON.stringify(envelope));
      child.emit("close", 0);
    });
    return child;
  }
  spawnImpl.calls = calls;
  return spawnImpl;
}

test("deep pull wraps claude -p (Max), passes the resolved model, and feeds parseBatchGuidance", async () => {
  const envelope = {
    result: JSON.stringify({
      guidance: [
        {
          sessionId: "coach-A",
          uii: "uii-A",
          currentSection: "2",
          beats: [{ point: "Ask amount owed", status: "pending" }],
          says: [{ type: "tactic", rec: true, text: "Roughly how much are we talking?" }],
        },
      ],
    }),
    usage: { input_tokens: 100, output_tokens: 50 },
  };
  const spawnImpl = fakeSpawn(envelope);

  const runDeep = createDeepPullTransport({
    env: { LIVE_COACH_DEEP_MODEL: "opus" },
    spawnImpl,
    fast: true,
  });
  const res = await runDeep({ system: "REF", prompt: "ACTIVE CALLS", schema: { properties: { guidance: {} } } });
  assert.equal(res.ok, true);

  // model + fast settings made it onto the claude -p command.
  const args = spawnImpl.calls[0].args;
  assert.ok(args.includes("--model"));
  assert.equal(args[args.indexOf("--model") + 1], "opus");
  assert.ok(args.includes("--settings"), "fast-mode settings passed");

  const parsed = parseBatchGuidance(res);
  assert.equal(parsed.guidance.length, 1);
  assert.equal(parsed.guidance[0].sessionId, "coach-A");
  assert.equal(parsed.guidance[0].currentSection, "2");
  assert.equal(parsed.guidance[0].says[0].text, "Roughly how much are we talking?");
});
