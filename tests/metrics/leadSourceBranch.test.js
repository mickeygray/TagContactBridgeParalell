"use strict";

// ST/FD lead-source branching (phase 6, forward-only, ships DISABLED).
//
// Doctrine under test (Mickey, 2026-07-24/27):
//   - branch by SOURCE NAME at posting time from the lien plaintiff;
//     57/76 are Logics source IDS, reference only — never dollar amounts
//   - unparseable plaintiff posts the BARE name (the exception list)
//   - mail sources NEVER branch
//   - bare "ABC" stays generic; only the branched names are lead-data

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyLienBranch,
  isBranchedDataLeadSource,
  resolveBranchedSourceName,
} = require("../../packages/shared-services/src/leadSourceBranchService");
const {
  buildSimpleNightlyPaymentRollup,
} = require("../../packages/shared-services/src/simpleMarketingReadService");

const ENABLED = { LEAD_SOURCE_BRANCH_ENABLED: "true" };

test("plaintiff text classifies exactly the two proven shapes", () => {
  assert.equal(classifyLienBranch({ plaintiff: "INTERNAL REVENUE SERVICE" }), "FD");
  assert.equal(classifyLienBranch({ plaintiff: "internal revenue service" }), "FD");
  assert.equal(classifyLienBranch({ plaintiff: "STATE OF CALIFORNIA" }), "ST");
  assert.equal(classifyLienBranch({ plaintiff: "State of New York" }), "ST");
  // Anything else refuses to guess.
  assert.equal(classifyLienBranch({ plaintiff: "COUNTY OF ORANGE" }), null);
  assert.equal(classifyLienBranch({ plaintiff: "" }), null);
  assert.equal(classifyLienBranch({}), null);
});

test("an explicit lienType outranks plaintiff text", () => {
  assert.equal(classifyLienBranch({ lienType: "FEDERAL", plaintiff: "STATE OF OHIO" }), "FD");
  assert.equal(classifyLienBranch({ lienType: "ST" }), "ST");
});

test("DISABLED is a hard identity — the default ships inert", () => {
  const result = resolveBranchedSourceName({
    sourceName: "ABC",
    plaintiff: "INTERNAL REVENUE SERVICE",
    env: {},
  });
  assert.equal(result.sourceName, "ABC");
  assert.equal(result.branched, false);
});

test("enabled: ABC branches to ABC ST (57) / ABC FD (76) by lien", () => {
  const fd = resolveBranchedSourceName({
    sourceName: "ABC", plaintiff: "INTERNAL REVENUE SERVICE", env: ENABLED,
  });
  assert.deepEqual(
    { sourceName: fd.sourceName, branch: fd.branch, logicsSourceId: fd.logicsSourceId },
    { sourceName: "ABC FD", branch: "FD", logicsSourceId: 76 },
  );

  const st = resolveBranchedSourceName({
    sourceName: "ABC", plaintiff: "STATE OF ALABAMA", env: ENABLED,
  });
  assert.deepEqual(
    { sourceName: st.sourceName, branch: st.branch, logicsSourceId: st.logicsSourceId },
    { sourceName: "ABC ST", branch: "ST", logicsSourceId: 57 },
  );
});

test("no plaintiff posts the BARE name — bare ABC IS the exception list", () => {
  const result = resolveBranchedSourceName({ sourceName: "ABC", env: ENABLED });
  assert.equal(result.sourceName, "ABC");
  assert.equal(result.branched, false);
});

test("mail and non-matrix sources never branch, even fully enabled", () => {
  for (const sourceName of ["Urgent Third State", "Affordability Federal", "LD CUSTOM", "Client Referral"]) {
    const result = resolveBranchedSourceName({
      sourceName, plaintiff: "INTERNAL REVENUE SERVICE", env: ENABLED,
    });
    assert.equal(result.sourceName, sourceName, `${sourceName} must not branch`);
    assert.equal(result.branched, false);
  }
});

test("the matrix is env-extendable without a deploy", () => {
  const env = {
    LEAD_SOURCE_BRANCH_ENABLED: "true",
    LEAD_SOURCE_BRANCH_MATRIX: JSON.stringify({
      BCD: { ST: { sourceName: "BCD ST", logicsSourceId: 91 }, FD: { sourceName: "BCD FD", logicsSourceId: 92 } },
    }),
  };
  const result = resolveBranchedSourceName({
    sourceName: "BCD", plaintiff: "STATE OF TEXAS", env,
  });
  assert.equal(result.sourceName, "BCD ST");
  assert.equal(result.logicsSourceId, 91);
  // Malformed JSON falls back to the default matrix rather than crashing.
  const fallback = resolveBranchedSourceName({
    sourceName: "ABC", plaintiff: "STATE OF TEXAS",
    env: { LEAD_SOURCE_BRANCH_ENABLED: "true", LEAD_SOURCE_BRANCH_MATRIX: "{not json" },
  });
  assert.equal(fallback.sourceName, "ABC ST");
});

test("branched names are lead-data; bare ABC stays generic", () => {
  assert.equal(isBranchedDataLeadSource("ABC ST"), true);
  assert.equal(isBranchedDataLeadSource("abc fd"), true);
  assert.equal(isBranchedDataLeadSource("ABC"), false);
  assert.equal(isBranchedDataLeadSource(""), false);
});

test("on the board, an ABC ST deal buckets under LD, never Aged", () => {
  const rows = [{
    domain: "TAG", caseId: 42, transactionStatus: "SUCCESS",
    paymentType: "initial", amount: 750, paymentDateKey: "2026-08-03",
    raw: { csv: { sourceName: "ABC ST" } },
  }];
  const result = buildSimpleNightlyPaymentRollup({
    dayPayments: rows,
    cashPayments: rows,
    profiles: [],
    activeContext: { pieces: new Set(["Affordability Federal"]), sheetToCanonical: new Map() },
  });
  assert.ok(result.initialsBySource.has("LD"), "ABC ST lands in the LD bucket");
  assert.equal(result.initialsBySource.get("LD").count, 1);
  assert.ok(!result.initialsBySource.has("Aged"), "and never in Aged");
});
