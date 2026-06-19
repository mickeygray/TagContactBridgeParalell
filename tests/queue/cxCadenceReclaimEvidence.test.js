"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildClaimedDialingEvidenceQuery,
} = require("../../packages/shared-services/src/cxCadenceService");

test("claimed dialing reclaim does not treat plain relay-failed as dial evidence", () => {
  const query = buildClaimedDialingEvidenceQuery();
  const broadStatusValues = query.$or
    .flatMap((clause) => clause?.["metadata.lastDialIntentStatus"]?.$in || []);

  assert.equal(broadStatusValues.includes("relay-failed"), false);
});

test("relay-failed reclaim requires correlated publish or dial evidence", () => {
  const query = buildClaimedDialingEvidenceQuery();
  const relayClause = query.$or.find((clause) =>
    Array.isArray(clause?.$and)
      && clause.$and.some((part) => part?.["metadata.lastDialIntentStatus"] === "relay-failed"));

  assert.ok(relayClause, "relay-failed should still be reclaimable with evidence");
  const evidenceClause = relayClause.$and.find((part) => Array.isArray(part?.$or));
  assert.ok(evidenceClause, "relay-failed reclaim must require a correlated evidence $or");

  const evidenceKeys = evidenceClause.$or.flatMap((part) => Object.keys(part || {}));
  assert.ok(evidenceKeys.includes("metadata.servingAt"));
  assert.ok(evidenceKeys.includes("metadata.lastQueueAttemptAt"));
  assert.ok(evidenceKeys.includes("metadata.lastDialExecutionUii"));
  assert.ok(evidenceKeys.includes("metadata.lastRingcxPublishedAt"));
});
