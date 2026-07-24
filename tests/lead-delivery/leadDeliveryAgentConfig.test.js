"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  POOLS,
  validateLeadDeliveryConfiguration,
} = require("../../packages/shared-services/src/leadDeliveryService");

const DEFAULTS = Object.freeze({
  providerBufferTarget: 20,
  refillAtOrBelow: 5,
  freshReservationRange: 20,
  freshReservationMinutes: 15,
  activeEvidenceMinutes: 15,
  maxPendingFreshReservations: 1,
});

function configuredAgent(extra = {}) {
  return {
    enabled: true,
    displayName: "Test Agent",
    provider: "phoneburner",
    phoneBurnerMemberId: "member-test-1",
    phoneBurnerUsername: "",
    distributionFolderId: "distribution-test-1",
    receivingFolderId: "receiving-test-1",
    leadStreamId: "stream-test-1",
    subscribedPools: [POOLS.NEW_TODAY, POOLS.FOLLOW_UP_DUE],
    packetAllowances: {
      [POOLS.NEW_TODAY]: 1,
      [POOLS.OVERNIGHT]: 0,
      [POOLS.OLDER_AVAILABLE]: 0,
      [POOLS.FOLLOW_UP_DUE]: 1,
    },
    ...extra,
  };
}

test("checked-in floor config preserves folder pairs and enables all five floor agents", () => {
  const file = path.join(__dirname, "../../config/lead-delivery-agents.json");
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(config.defaults, DEFAULTS);
  assert.deepEqual(config.curatorFolders, {
    callbacksFolderId: "66253042",
    expiredDailyContactsFolderId: "66209775",
  });
  assert.deepEqual(Object.fromEntries(Object.entries(config.agents).map(([agentId, agent]) => [agentId, {
    displayName: agent.displayName,
    distributionFolderId: agent.distributionFolderId,
    receivingFolderId: agent.receivingFolderId,
  }])), {
    bruce_allen: { displayName: "Bruce Allen", distributionFolderId: "66252220", receivingFolderId: "66252221" },
    phil_olson: { displayName: "Phil Olson", distributionFolderId: "66252218", receivingFolderId: "66252219" },
    sean_lucas: { displayName: "Sean Lucas", distributionFolderId: "66252216", receivingFolderId: "66252217" },
    brad_hansen: { displayName: "Brad Hansen", distributionFolderId: "66252214", receivingFolderId: "66252215" },
    chris_bolt: { displayName: "Chris Bolt", distributionFolderId: "66252212", receivingFolderId: "66252213" },
    bruce_allen_wynn: { displayName: "Bruce Allen (Wynn)", distributionFolderId: "", receivingFolderId: "" },
  });
  const enabledCanary = new Set([
    "bruce_allen",
    "chris_bolt",
    "brad_hansen",
    "sean_lucas",
    "phil_olson",
  ]);
  for (const [agentId, agent] of Object.entries(config.agents)) {
    assert.equal(agent.enabled, enabledCanary.has(agentId));
    assert.equal(agent.phoneBurnerMemberId, "");
    assert.equal(agent.phoneBurnerUsername, "");
    assert.equal(agent.leadStreamId, "");
    assert.deepEqual(agent.domains, agentId === "bruce_allen_wynn" ? ["WYNN"] : ["TAG"]);
    assert.deepEqual(agent.subscribedPools, [
      POOLS.NEW_TODAY,
      POOLS.OVERNIGHT,
      POOLS.OLDER_AVAILABLE,
      POOLS.FOLLOW_UP_DUE,
    ]);
    assert.deepEqual(agent.packetAllowances, {
      [POOLS.NEW_TODAY]: 2,
      [POOLS.OVERNIGHT]: 1,
      [POOLS.OLDER_AVAILABLE]: 1,
      [POOLS.FOLLOW_UP_DUE]: 1,
    });
  }
  const validation = validateLeadDeliveryConfiguration(config);
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.errors, []);
  assert.deepEqual(new Set(validation.enabledAgentIds), enabledCanary);
});

test("disabled blank template is valid but enabled agents require folders and policy, not optional owner metadata", () => {
  const blank = configuredAgent({
    enabled: false,
    displayName: "",
    phoneBurnerMemberId: "",
    distributionFolderId: "",
    receivingFolderId: "",
    leadStreamId: "",
    subscribedPools: [],
    packetAllowances: {
      [POOLS.NEW_TODAY]: 0,
      [POOLS.OVERNIGHT]: 0,
      [POOLS.OLDER_AVAILABLE]: 0,
      [POOLS.FOLLOW_UP_DUE]: 0,
    },
  });
  assert.equal(validateLeadDeliveryConfiguration({ defaults: DEFAULTS, agents: { agent_test: blank } }).valid, true);
  const enabled = validateLeadDeliveryConfiguration({
    defaults: DEFAULTS,
    agents: { agent_test: { ...blank, enabled: true } },
  });
  assert.equal(enabled.valid, false);
  for (const field of ["displayName", "distributionFolderId", "receivingFolderId", "subscribed pool"]) {
    assert.ok(enabled.errors.some((error) => error.includes(field)), `missing enabled-agent error for ${field}`);
  }

  const folderOnly = configuredAgent({
    phoneBurnerMemberId: "",
    phoneBurnerUsername: "",
    leadStreamId: "",
  });
  assert.equal(validateLeadDeliveryConfiguration({
    defaults: DEFAULTS,
    agents: { agent_test: folderOnly },
  }).valid, true);
});

test("shared optional owner passes while shared provider folders fail closed", () => {
  const valid = {
    defaults: DEFAULTS,
    agents: {
      agent_a: configuredAgent(),
      agent_b: configuredAgent({
        displayName: "Test Agent B",
        phoneBurnerMemberId: "member-test-1",
        phoneBurnerUsername: "",
        distributionFolderId: "distribution-test-2",
        receivingFolderId: "receiving-test-2",
        leadStreamId: "stream-test-2",
      }),
    },
  };
  assert.deepEqual(validateLeadDeliveryConfiguration(valid), {
    valid: true,
    errors: [],
    enabledAgentIds: ["agent_a", "agent_b"],
  });

  const duplicate = structuredClone(valid);
  duplicate.agents.agent_b.distributionFolderId = "receiving-test-1";
  const result = validateLeadDeliveryConfiguration(duplicate);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("folder is shared")));
});

test("configuration rejects policy drift, unknown pools, fractional allowances, and dual owners", () => {
  const config = {
    defaults: {
      ...DEFAULTS,
      freshReservationMinutes: 16,
      refillAtOrBelow: 20,
      providerBufferTargets: 5,
    },
    agents: {
      agent_test: configuredAgent({
        phoneBurnerUsername: "second-owner-test",
        oauthToken: "must-not-live-in-config",
        subscribedPools: [POOLS.NEW_TODAY, "mystery_pool"],
        packetAllowances: {
          [POOLS.NEW_TODAY]: 0.5,
          mystery_pool: 1,
        },
      }),
    },
    webhookSecret: "must-not-live-in-config",
  };
  const result = validateLeadDeliveryConfiguration(config);
  assert.equal(result.valid, false);
  for (const expected of [
    "freshReservationMinutes must remain 15",
    "refillAtOrBelow must be below",
    "at most one PhoneBurner owner identity",
    "unknown pool mystery_pool",
    "must be a non-negative integer",
    "config contains unknown field webhookSecret",
    "defaults contains unknown field providerBufferTargets",
    "contains unknown field oauthToken",
  ]) {
    assert.ok(result.errors.some((error) => error.includes(expected)), `missing error: ${expected}`);
  }
});

test("curator folders are optional, distinct, provider-shaped, and cannot overlap agent folders", () => {
  const base = { defaults: DEFAULTS, agents: { agent_test: configuredAgent() } };
  assert.equal(validateLeadDeliveryConfiguration(base).valid, true);
  assert.equal(validateLeadDeliveryConfiguration({
    ...base,
    curatorFolders: {
      callbacksFolderId: "70001",
      expiredDailyContactsFolderId: "70002",
    },
  }).valid, true);

  for (const curatorFolders of [
    { callbacksFolderId: "", expiredDailyContactsFolderId: "70002" },
    { callbacksFolderId: "70001", expiredDailyContactsFolderId: "70001" },
    { callbacksFolderId: "distribution-test-1", expiredDailyContactsFolderId: "70002" },
  ]) {
    assert.equal(validateLeadDeliveryConfiguration({ ...base, curatorFolders }).valid, false);
  }
});

test("agent domains are optional, non-empty, alphanumeric, and duplicate-free", () => {
  const valid = (agents) => validateLeadDeliveryConfiguration({ defaults: DEFAULTS, agents });
  assert.equal(valid({ agent_test: configuredAgent() }).valid, true);
  assert.equal(valid({ agent_test: configuredAgent({ domains: ["TAG"] }) }).valid, true);
  assert.equal(valid({ agent_test: configuredAgent({ domains: ["tag", "WYNN"] }) }).valid, true);

  for (const [domains, expected] of [
    [[], "domains must be a non-empty array when supplied"],
    ["TAG", "domains must be a non-empty array when supplied"],
    [["TAG", "tag"], "domains contains duplicates"],
    [["TAG:1"], "domains must contain alphanumeric domain keys"],
    [[""], "domains must contain alphanumeric domain keys"],
  ]) {
    const result = valid({ agent_test: configuredAgent({ domains }) });
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some((error) => error.includes(expected)),
      `missing error: ${expected} for ${JSON.stringify(domains)}`,
    );
  }
});
