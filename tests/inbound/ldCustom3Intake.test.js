"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeLdLeadPayload,
} = require("../../packages/shared-services/src/inboundIntakeService");

function basePayload(overrides = {}) {
  return {
    company: "WYNN",
    firstName: "Jane",
    lastName: "Doe",
    phone: "5551234567",
    email: "jane@example.com",
    trustedFormCertUrl: "https://cert.example.test/abc",
    ...overrides,
  };
}

test("LD Custom 3 vendor value routes to source id 48", () => {
  const normalized = normalizeLdLeadPayload(basePayload({ vendor: "ldcustom3" }));

  assert.equal(normalized.routeCampaignKey, "ld-custom-3");
  assert.equal(normalized.routeCampaignName, "LD CUSTOM 3");
  assert.equal(normalized.sourceName, "LD CUSTOM 3");
  assert.equal(normalized.logicsSourceName, "LD CUSTOM 3");
  assert.equal(normalized.logicsCampaignName, "LD CUSTOM 3");
  assert.equal(normalized.sourceId, 48);
  assert.equal(normalized.vendorSourceName, "LD CUSTOM 3");
  assert.equal(normalized.payloadSnapshot.ldSubsourceKind, "custom-3");
  assert.equal(normalized.payloadSnapshot.ldSubsourceLabel, "LD CUSTOM 3");
});

test("LD Custom 3 alias can be detected from flat payload values", () => {
  const normalized = normalizeLdLeadPayload(basePayload({ sourceName: "Wynn Tax Custom 3" }));

  assert.equal(normalized.routeCampaignKey, "ld-custom-3");
  assert.equal(normalized.sourceId, 48);
  assert.equal(normalized.payloadSnapshot.ldSubsourceField, "sourceName");
});
