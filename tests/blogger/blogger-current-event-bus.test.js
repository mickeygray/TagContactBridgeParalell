"use strict";

// Blogger current-event → AI bus migration. Offline only (fake runner / fake
// client / stubbed fetch). The live web_search execution is NOT exercised here —
// it needs one real run on a box with ANTHROPIC_API_KEY; these lock the WIRING:
// the task descriptor, the runner routing, the search-kind loop, result mapping,
// fail-closed→throw, and the tool_choice-omit behavior the loop depends on.

const test = require("node:test");
const assert = require("node:assert/strict");

const { generateCurrentEventBlog } = require("../../scripts/blogger-current-event");
const { createAnthropicAdapter } = require("../../packages/shared-services/src/aiProviders");
const registry = require("../../packages/shared-services/src/aiTaskRegistry");

const VALID_BODY = [
  "<p><em>Disclaimer: general info, not advice.</em></p>",
  "<h2>What happened</h2>",
  "<p>The IRS announced a thing.</p>",
  "<ul><li>Point one</li><li>Point two</li></ul>",
  "<p>Bottom line: act early.</p>",
].join("\n");

const VALID_SUBMIT = {
  id: "irs-launches-thing-april-2026",
  title: "IRS Launches Thing",
  teaser: "A new thing.",
  contentTitle: "IRS Launches Thing",
  bodyHtml: VALID_BODY,
  slide: { eyebrow: "IRS NEWS — APRIL 2026", headline1: "A", headline2: "B" },
  sourcesUsed: ["https://www.irs.gov/x", "https://www.treasury.gov/y"],
};

function fakeRunner(response, capture = {}) {
  return {
    runAiTask: async (taskId, payload, options) => {
      capture.taskId = taskId;
      capture.payload = payload;
      capture.options = options;
      return response;
    },
  };
}

test("blogger routes through the bus and maps the submit result to a canonical draft", async () => {
  const capture = {};
  const runner = fakeRunner(
    { ok: true, provider: "anthropic", model: "claude-sonnet-4-6", result: VALID_SUBMIT },
    capture,
  );

  const draft = await generateCurrentEventBlog({ runner, recentPublishedTitles: ["Old Post"] });

  // Routed to the right bus task with the agentic search payload.
  assert.equal(capture.taskId, "blogger.currentEvent");
  assert.equal(capture.options.label, "blogger.currentEvent");
  assert.ok(typeof capture.payload.system === "string" && capture.payload.system.length > 0);
  assert.ok(Array.isArray(capture.payload.tools) && capture.payload.tools[0].name === "web_search");
  assert.equal(capture.payload.submitTool.name, "submit_current_event_blog");
  assert.ok(capture.payload.submitTool.schema && capture.payload.submitTool.schema.type === "object");

  // Mapped to the canonical draft shape the daily-runner consumes.
  assert.equal(draft.id, VALID_SUBMIT.id);
  assert.equal(draft.category, "current-event");
  assert.equal(draft.contentBody.length, 5);
  assert.equal(draft.generatedBy, "claude-sonnet-4-6"); // from the bus, not a hardcoded snapshot
  assert.deepEqual(draft.sourcesUsed, VALID_SUBMIT.sourcesUsed);
  assert.match(draft.sourceNotes, /2 sources/);
});

test("blogger throws on a bus failure (ok:false) so the daily-runner fallback fires", async () => {
  const runner = fakeRunner({
    ok: false,
    code: "all_providers_failed",
    attempts: [{ provider: "anthropic", status: "error", error: "boom" }],
  });
  await assert.rejects(() => generateCurrentEventBlog({ runner }), /all_providers_failed/);
});

test("blogger throws when the body splits into fewer than 5 blocks", async () => {
  const runner = fakeRunner({
    ok: true,
    model: "claude-sonnet-4-6",
    result: { ...VALID_SUBMIT, bodyHtml: "<p>only one block</p>" },
  });
  await assert.rejects(() => generateCurrentEventBlog({ runner }), /only 1 blocks/);
});

// ── The adapter's agentic `search` kind ──────────────────────────────────────

function fakeAnthropicClient(responses) {
  const calls = [];
  const client = {
    calls,
    createMessage: async (args) => {
      calls.push(args);
      return responses[calls.length - 1];
    },
    extractToolUse: (res, name) => {
      const block = (res.content || []).find(
        (b) => b && b.type === "tool_use" && (!name || b.name === name),
      );
      return block ? { name: block.name, input: block.input || {} } : null;
    },
    extractTextBlocks: () => "",
  };
  return client;
}

const SEARCH_REQUEST = {
  system: "sys",
  user: "find a story",
  tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }],
  submitTool: { name: "submit_x", schema: { type: "object" } },
  maxToolTurns: 8,
  maxTokens: 8000,
  timeoutMs: 90000,
};

test("search kind loops over web_search then returns the submit tool input", async () => {
  const client = fakeAnthropicClient([
    { content: [{ type: "text", text: "searching..." }], stop_reason: "tool_use", model: "m" },
    {
      content: [{ type: "tool_use", name: "submit_x", input: { id: "z", bodyHtml: "b", slide: {} } }],
      stop_reason: "tool_use",
      model: "m",
    },
  ]);
  const adapter = createAnthropicAdapter(client);
  assert.equal(adapter.supports("search"), true);

  const out = await adapter.run("search", SEARCH_REQUEST, { model: "claude-sonnet-4-6" });
  assert.equal(out.provider, "anthropic");
  assert.equal(out.json.id, "z");
  assert.equal(client.calls.length, 2);
  // The loop must OMIT tool_choice and pass both tools (web_search + submit).
  assert.equal(client.calls[0].toolChoice, false);
  assert.equal(client.calls[0].tools.length, 2);
});

test("search kind throws (retryable) when the model stops without submitting", async () => {
  const client = fakeAnthropicClient([
    { content: [{ type: "text", text: "I give up" }], stop_reason: "end_turn", model: "m" },
  ]);
  const adapter = createAnthropicAdapter(client);
  await assert.rejects(
    () => adapter.run("search", SEARCH_REQUEST, { model: "claude-sonnet-4-6" }),
    (err) => err.retryable === true && /without submitting/.test(err.message),
  );
});

test("search kind throws after exhausting maxToolTurns", async () => {
  const noSubmit = { content: [{ type: "text", text: "still searching" }], stop_reason: "tool_use", model: "m" };
  const client = fakeAnthropicClient([noSubmit, noSubmit, noSubmit]);
  const adapter = createAnthropicAdapter(client);
  await assert.rejects(
    () => adapter.run("search", { ...SEARCH_REQUEST, maxToolTurns: 2 }, { model: "m" }),
    /maxToolTurns \(2\)/,
  );
});

test("search kind rejects a request with no submitTool name as unsupported", async () => {
  const adapter = createAnthropicAdapter(fakeAnthropicClient([]));
  await assert.rejects(
    () => adapter.run("search", { ...SEARCH_REQUEST, submitTool: {} }, { model: "m" }),
    (err) => err.unsupported === true,
  );
});

// ── The shared anthropicClient tool_choice-omit change ───────────────────────

test("anthropicClient omits tool_choice when toolChoice is false, keeps default otherwise", async () => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  const { createAnthropicClient } = require("../../packages/shared-integrations/src");
  const client = createAnthropicClient();

  let body = null;
  const origFetch = global.fetch;
  global.fetch = async (_url, opts) => {
    body = JSON.parse(opts.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ content: [], stop_reason: "end_turn" }) };
  };
  try {
    const base = {
      system: "s",
      messages: [{ role: "user", content: "x" }],
      tools: [{ name: "t", input_schema: { type: "object" } }],
      model: "claude-sonnet-4-6",
    };
    await client.createMessage({ ...base, toolChoice: false });
    assert.ok(body.tools, "tools should still be sent");
    assert.equal(body.tool_choice, undefined, "tool_choice omitted when toolChoice:false");

    await client.createMessage(base); // toolChoice undefined → default
    assert.deepEqual(body.tool_choice, { type: "any" });
  } finally {
    global.fetch = origFetch;
  }
});

// ── Registry wiring ──────────────────────────────────────────────────────────

test("blogger.currentEvent is a registered bus task with a real contract", () => {
  const task = registry.getTask("blogger.currentEvent");
  assert.ok(task, "task is registered");
  assert.equal(task.kind, "search");
  assert.deepEqual(task.providerOrder, ["anthropic"]);
  assert.equal(task.contract, "blogDraft");
  assert.equal(typeof registry.getValidator("blogDraft"), "function");
  // The contract rejects a draft missing id/body/slide (→ runner fails over / closed).
  assert.equal(registry.getValidator("blogDraft")({ id: "x", bodyHtml: "b" }).ok, false);
  assert.equal(registry.getValidator("blogDraft")(VALID_SUBMIT).ok, true);
  assert.doesNotThrow(() => registry.assertRegistryIntegrity());
});
