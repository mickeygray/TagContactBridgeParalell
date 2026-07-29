"use strict";

// The payments-sheet reconcile pass: one daily upload also corrects
// case/client profiles (Mickey, 2026-07-24: "its a good opportunity to
// reconcile both at the time right because we get every processed payment").
//
// Measured stakes on the 2026-07-24 TAG export: 29 paying clients with NO
// CaseProfile at all, 59 cases where the sheet's real source fixes a
// null/ABC/Unknown profile.
//
// Hard rules under test:
//   - a real profile source is NEVER overwritten by the sheet
//   - names fill only when the profile has none
//   - true conflicts are reported, not resolved

const { test } = require("node:test");
const assert = require("node:assert/strict");

const CaseProfile = require("../../packages/shared-models/src/CaseProfile");
const { caseProfileRepository } = require("../../packages/shared-repositories/src");
const caseProfilePaymentSync = require("../../packages/shared-services/src/caseProfilePaymentSyncService");
const {
  canonicalSourceName,
  collectSheetCases,
  reconcileSheetCases,
  splitClientName,
} = require("../../packages/shared-services/src/paymentsSheetReconcileService");

function sheetRow(overrides = {}) {
  return {
    caseId: 1000,
    client: "CLARK DANNAR",
    sourceName: "RVM Schwint #3",
    amount: 500,
    status: "SUCCESS",
    ...overrides,
  };
}

async function run({ rows, profiles, dryRun = false }) {
  const originalFind = CaseProfile.find;
  const originalUpsert = caseProfileRepository.upsertCaseProfile;
  const originalProcess = caseProfilePaymentSync.processCandidateCase;
  const upserts = [];
  const rollups = [];
  CaseProfile.find = () => ({
    select() { return this; },
    async lean() { return profiles; },
  });
  caseProfileRepository.upsertCaseProfile = async (domain, caseId, update) => {
    upserts.push({ domain, caseId, update });
    return { caseId };
  };
  caseProfilePaymentSync.processCandidateCase = async ({ caseId }) => {
    rollups.push(caseId);
    return { caseId, drifted: caseId % 2 === 0 };
  };
  try {
    const summary = await reconcileSheetCases({ domain: "TAG", rows, dryRun });
    return { summary, upserts, rollups };
  } finally {
    CaseProfile.find = originalFind;
    caseProfileRepository.upsertCaseProfile = originalUpsert;
    caseProfilePaymentSync.processCandidateCase = originalProcess;
  }
}

test("a paying client with no profile gets one, as a client", async () => {
  const { summary, upserts } = await run({
    rows: [sheetRow({ caseId: 47734, client: "Maria Alvarez Lopez" })],
    profiles: [],
  });
  assert.equal(summary.profilesCreated, 1);
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].caseId, 47734);
  assert.equal(upserts[0].update.firstName, "Maria");
  assert.equal(upserts[0].update.lastName, "Alvarez Lopez");
  assert.equal(upserts[0].update.sourceName, "RVM Schwint #3");
  assert.equal(upserts[0].update.statusCategory, "client");
});

test("the sheet fills a missing/generic profile source, and only then", async () => {
  const { summary, upserts } = await run({
    rows: [
      sheetRow({ caseId: 1, sourceName: "Google Ads 2.0" }),
      sheetRow({ caseId: 2, sourceName: "Client Referral" }),
      sheetRow({ caseId: 3, sourceName: "Google Ads 2.0" }),
    ],
    profiles: [
      { caseId: 1, name: "A", sourceName: null },
      { caseId: 2, name: "B", sourceName: "Unknown" },
      // Case 3 already has a REAL source — must not be touched.
      { caseId: 3, name: "C", sourceName: "Affordability Federal" },
    ],
  });
  assert.equal(summary.sourcesFilled, 2);
  assert.deepEqual(
    upserts.map((u) => [u.caseId, u.update.sourceName]),
    [[1, "Google Ads 2.0"], [2, "Client Referral"]],
    "case 3's real source stays exactly as it was",
  );
  // Google Ads 2.0 vs Affordability Federal IS a real disagreement.
  assert.equal(summary.sourceConflicts.length, 1);
  assert.equal(summary.sourceConflicts[0].caseId, 3);
  assert.equal(summary.sourceConflicts[0].kind, "profile-vs-sheet");
});

test("Logics alias pairs are NOT conflicts", async () => {
  // Logics says "Urgent Third Pink"; the profile carries the CallRail
  // tracker name. Same mailer — must neither conflict nor rewrite.
  // Likewise BCD: the vendor calls origination "OG", and what WYNN's
  // Logics names "BCD" is "BCD - OG" in TAG's (Mickey, 2026-07-24).
  const { summary, upserts } = await run({
    rows: [
      sheetRow({ caseId: 10, sourceName: "Urgent Third Pink" }),
      sheetRow({ caseId: 11, sourceName: "BCD - OG" }),
    ],
    profiles: [
      { caseId: 10, name: "X", sourceName: "3rd Day (Pink) Urgent Third State 800-921-9263" },
      { caseId: 11, name: "Y", sourceName: "BCD" },
    ],
  });
  assert.equal(summary.sourceConflicts.length, 0);
  assert.equal(summary.sourcesFilled, 0);
  assert.equal(upserts.length, 0);
});

test("ABC and blank never fill anything", async () => {
  const { summary, upserts } = await run({
    rows: [
      sheetRow({ caseId: 20, sourceName: "ABC" }),
      sheetRow({ caseId: 21, sourceName: "" }),
      sheetRow({ caseId: 22, sourceName: "Unknown" }),
    ],
    profiles: [
      { caseId: 20, name: "A", sourceName: null },
      { caseId: 21, name: "B", sourceName: null },
      { caseId: 22, name: "C", sourceName: null },
    ],
  });
  assert.equal(summary.sourcesFilled, 0);
  assert.equal(upserts.length, 0, "generic names must never be written to a profile");
});

test("names fill only when the profile has none", async () => {
  const { summary, upserts } = await run({
    rows: [
      sheetRow({ caseId: 30, client: "KYE BROOKS", sourceName: "" }),
      sheetRow({ caseId: 31, client: "WRONG NAME", sourceName: "" }),
    ],
    profiles: [
      { caseId: 30, name: null, firstName: null, lastName: null, sourceName: "Aged Data" },
      { caseId: 31, name: "Correct Name", sourceName: "Aged Data" },
    ],
  });
  assert.equal(summary.namesFilled, 1);
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].caseId, 30);
  assert.equal(upserts[0].update.name, "KYE BROOKS");
});

test("rollups run per case and dryRun writes nothing at all", async () => {
  const rows = [sheetRow({ caseId: 40 }), sheetRow({ caseId: 41, client: "B B", sourceName: "Raw" })];
  const wet = await run({ rows, profiles: [{ caseId: 40, name: "A", sourceName: null }] });
  assert.equal(wet.rollups.length, 2, "every sheet case gets a rollup check");
  assert.equal(wet.summary.rollupsChecked, 2);
  assert.equal(wet.summary.rollupsCorrected, 1, "case 40 drifted (stub drifts evens)");

  const dry = await run({
    rows,
    profiles: [{ caseId: 40, name: "A", sourceName: null }],
    dryRun: true,
  });
  assert.equal(dry.upserts.length, 0, "dryRun must not upsert");
  assert.equal(dry.rollups.length, 0, "dryRun must not run rollups");
  assert.equal(dry.summary.profilesCreated, 1, "but still reports what it WOULD do");
  assert.equal(dry.summary.sourcesFilled, 1);
});

test("a case whose rows disagree on source is ambiguous, not guessed", async () => {
  const { summary, upserts } = await run({
    rows: [
      sheetRow({ caseId: 50, sourceName: "Google Ads 2.0" }),
      sheetRow({ caseId: 50, sourceName: "TV Campaign" }),
    ],
    profiles: [{ caseId: 50, name: "A", sourceName: null }],
  });
  assert.equal(summary.sourcesFilled, 0);
  assert.equal(upserts.length, 0);
  assert.equal(summary.sourceConflicts.length, 1);
  assert.equal(summary.sourceConflicts[0].kind, "sheet-ambiguous");
});

test("helpers: name split and alias canonicalization", () => {
  assert.deepEqual(splitClientName("STEVEN NEVEL SR."), { firstName: "STEVEN", lastName: "NEVEL SR." });
  assert.deepEqual(splitClientName("Cher"), { firstName: "Cher", lastName: null });
  assert.deepEqual(splitClientName("  "), { firstName: null, lastName: null });
  assert.equal(
    canonicalSourceName("Urgent Third White"),
    "Urgent Third State",
    "Logics name maps to the CallRail tracker label",
  );
  assert.equal(canonicalSourceName("RVM Schwint #3"), "RVM Schwint #3");
  assert.equal(canonicalSourceName(""), null);
});

test("collectSheetCases folds rows and drops junk ids", () => {
  const byCase = collectSheetCases([
    sheetRow({ caseId: 60, sourceName: "ABC" }),
    sheetRow({ caseId: 60, sourceName: "Google Ads 2.0" }),
    sheetRow({ caseId: 0 }),
    sheetRow({ caseId: Number.NaN }),
  ]);
  assert.equal(byCase.size, 1);
  const entry = byCase.get(60);
  assert.deepEqual([...entry.sources], ["Google Ads 2.0"], "generic ABC is not a source");
});
