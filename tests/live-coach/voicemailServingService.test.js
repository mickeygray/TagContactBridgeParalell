"use strict";

// Domain-aware *82 target resolution. The barge can only join the extension the
// call actually lives on; multi-domain agents (exShells per company) must be
// barged on the shell extension for the route's domain, not the TAG-centric
// base extensionNumber (observed live: *82966 0-for-104 for a Wynn-floor agent).

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveAgentVoicemailPlan,
} = require("../../packages/shared-services/src/voicemailServingService");

const BRUCE = {
  name: "Bruce Allen",
  email: "ballen@taxadvocategroup.com",
  extensionId: "63555286004",
  extensionNumber: "966",
  metadata: { barge: { monitorExtension: "1102" } },
  exShells: [
    { company: "TAG", extensionNumber: "966" },
    { company: "WYNN", extensionNumber: "9661" },
    { company: "AMITY", extensionNumber: "9662" },
  ],
};

function options(overrides = {}) {
  return {
    findAgent: async () => BRUCE,
    fileExists: (p) => String(p).endsWith("voicemail-shared.raw"),
    ...overrides,
  };
}

test("WYNN-domain drop targets the WYNN shell extension, not the base TAG ext", async () => {
  const plan = await resolveAgentVoicemailPlan("ballen@taxadvocategroup.com", options({ domain: "WYNN" }));
  assert.equal(plan.ok, true);
  assert.equal(plan.targetExtensionNumber, "9661");
  assert.equal(plan.baseExtensionNumber, "966");
  assert.equal(plan.domainExtensionUsed, true);
  assert.equal(plan.requestedDomain, "WYNN");
  assert.equal(plan.monitorExtension, "1102");
});

test("TAG-domain drop resolves the TAG shell (same as base ext)", async () => {
  const plan = await resolveAgentVoicemailPlan("966", options({ domain: "TAG" }));
  assert.equal(plan.targetExtensionNumber, "966");
  assert.equal(plan.domainExtensionUsed, false);
});

test("no domain falls back to the base extensionNumber (back-compat)", async () => {
  const plan = await resolveAgentVoicemailPlan("966", options());
  assert.equal(plan.targetExtensionNumber, "966");
  assert.equal(plan.requestedDomain, null);
});

test("domain without a matching shell falls back to base ext", async () => {
  const single = { ...BRUCE, exShells: [{ company: "TAG", extensionNumber: "966" }] };
  const plan = await resolveAgentVoicemailPlan("966", options({
    domain: "WYNN",
    findAgent: async () => single,
  }));
  assert.equal(plan.targetExtensionNumber, "966");
  assert.equal(plan.domainExtensionUsed, false);
});

test("per-agent audio lookup tries the domain shell ext first, then base ext", async () => {
  const tried = [];
  const plan = await resolveAgentVoicemailPlan("ballen@taxadvocategroup.com", options({
    domain: "WYNN",
    fileExists: (p) => {
      tried.push(String(p));
      return String(p).endsWith("966.raw"); // only the base-ext file exists
    },
  }));
  assert.equal(plan.ok, true);
  assert.ok(tried.some((p) => p.endsWith("9661.raw")), "domain shell ext file should be tried");
  assert.ok(plan.voicemailPath.endsWith("966.raw"), "base ext file should still win when shell file absent");
});
