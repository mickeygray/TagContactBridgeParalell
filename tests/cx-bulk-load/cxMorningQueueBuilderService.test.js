"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  agentDomain,
  filterTargetAgentsByAllowlist,
  hasTargetAllowlist,
  isCxMorningQueueBuilderEnabled,
  normalizeOptions,
  readCxMorningQueueBuilderOptionsFromEnv,
  runCxMorningQueueBuilder,
} = require("../../packages/shared-services/src/cxMorningQueueBuilderService");

test("morning queue builder defaults to WYNN, not the account company", () => {
  const options = normalizeOptions({});
  const agent = {
    account: {
      company: "TAG",
    },
  };

  assert.equal(options.domain, "WYNN");
  assert.equal(agentDomain(agent, options), "WYNN");
});

test("morning queue builder allows an explicit TAG override", () => {
  const options = normalizeOptions({ domain: "TAG" });
  const agent = {
    account: {
      company: "WYNN",
    },
  };

  assert.equal(options.domain, "TAG");
  assert.equal(agentDomain(agent, options), "TAG");
});

test("morning queue builder parses an explicit working-agent allowlist", () => {
  const options = normalizeOptions({
    all: true,
    agentEmails: "CBolt@TaxAdvocateGroup.com, polson@taxadvocategroup.com",
    extensionIds: "445 556",
  });

  assert.equal(options.all, false);
  assert.deepEqual(options.agentEmails, [
    "cbolt@taxadvocategroup.com",
    "polson@taxadvocategroup.com",
  ]);
  assert.deepEqual(options.extensionIds, ["445", "556"]);
  assert.equal(hasTargetAllowlist(options), true);
});

test("morning queue builder filters broad discovery to the configured working agents", () => {
  const options = normalizeOptions({
    agentEmails: "cbolt@taxadvocategroup.com",
    extensionIds: "777",
  });
  const agents = [
    { account: { email: "slucas@taxadvocategroup.com", extensionId: "445" } },
    { account: { email: "CBolt@TaxAdvocateGroup.com", extensionId: "556" } },
    { account: { email: "bhansen@taxadvocategroup.com", extensionId: "777" } },
    { account: { email: "inactive@example.com", extensionId: "888" } },
  ];

  const filtered = filterTargetAgentsByAllowlist(agents, options);

  assert.deepEqual(filtered.map((agent) => agent.account.extensionId), ["556", "777"]);
});

test("env reader defaults the scheduled worker to WYNN and keeps mirror off", () => {
  const options = readCxMorningQueueBuilderOptionsFromEnv({
    CX_DIAL_RUNTIME_BULK_LOAD_ENABLED: "true",
  });

  assert.equal(options.domain, "WYNN");
  assert.equal(options.build, true);
  assert.equal(options.drain, true);
  assert.equal(options.mirror, false);
  assert.equal(options.allowBroadDiscovery, false);
});

test("env reader can limit the scheduled worker to the named floor", () => {
  const options = readCxMorningQueueBuilderOptionsFromEnv({
    CX_MORNING_QUEUE_BUILDER_AGENT_EMAILS: "slucas@taxadvocategroup.com,bhansen@taxadvocategroup.com,cbolt@taxadvocategroup.com,polson@taxadvocategroup.com",
  });

  assert.equal(options.all, false);
  assert.deepEqual(options.agentEmails, [
    "slucas@taxadvocategroup.com",
    "bhansen@taxadvocategroup.com",
    "cbolt@taxadvocategroup.com",
    "polson@taxadvocategroup.com",
  ]);
  assert.equal(hasTargetAllowlist(normalizeOptions(options)), true);
});

test("scheduled broad discovery fails closed unless it is explicitly allowed", async () => {
  const summary = await runCxMorningQueueBuilder({
    apply: false,
    all: true,
    logger: null,
  });

  assert.equal(summary.totals.agents, 0);
  assert.equal(summary.options.allowBroadDiscovery, false);
});

test("env mirror is force-off while pacing queue is enabled", () => {
  const options = readCxMorningQueueBuilderOptionsFromEnv({
    CX_MORNING_QUEUE_BUILDER_MIRROR: "true",
    PACING_QUEUE_ENABLED: "true",
  });

  assert.equal(options.mirror, false);
});

test("worker enablement is explicit, or follows bulk-load runtime", () => {
  assert.equal(isCxMorningQueueBuilderEnabled({ CX_MORNING_QUEUE_BUILDER_ENABLED: "false", CX_DIAL_RUNTIME_BULK_LOAD_ENABLED: "true" }), false);
  assert.equal(isCxMorningQueueBuilderEnabled({ CX_MORNING_QUEUE_BUILDER_ENABLED: "true" }), true);
  assert.equal(isCxMorningQueueBuilderEnabled({ CX_DIAL_RUNTIME_BULK_LOAD_ENABLED: "true" }), true);
  assert.equal(isCxMorningQueueBuilderEnabled({ CX_BORING_DIALER_ENABLED: "true" }), true);
  assert.equal(isCxMorningQueueBuilderEnabled({}), false);
});

test("boring dialer mode makes the morning builder local-queue-only", () => {
  const options = normalizeOptions({
    boringDialerEnabled: true,
    drain: true,
    mirror: true,
  });

  assert.equal(options.build, true);
  assert.equal(options.drain, false);
  assert.equal(options.mirror, false);
  assert.equal(options.boringDialerEnabled, true);
});
