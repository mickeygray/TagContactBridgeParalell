"use strict";

// The sanitizer writes to LIVE client records, so its guards are tested
// harder than its happy path.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const svc = require("../../packages/shared-services/src/logicsSourceSanitizerService");

test("a 404 is a FINDING, not a failure", () => {
  // FindCaseByPhone 404s for every caller who is not a client — measured at
  // 97 of 152 in one week. Counting those as errors made a normal week look
  // broken, exactly like the Billing 404s did.
  assert.equal(svc.isNotFound({ details: { responseStatus: 404 } }), true);
  assert.equal(svc.isNotFound({ status: 404 }), true);
  assert.equal(svc.isNotFound(new Error("Logics request failed for TAG GET Find/FindCaseByPhone?phone=2125550199: 404")), true);
  assert.equal(svc.isNotFound(new Error("Logics request failed: 500")), false);
  assert.equal(svc.isNotFound(new Error("socket hang up")), false);
});

test("phone keys normalise to the last 10 digits", () => {
  // CallRail returns +1XXXXXXXXXX (11 digits); Logics stores (XXX)XXX-XXXX.
  assert.equal(svc.last10("+16199775178"), "6199775178");
  assert.equal(svc.last10("(619)977-5178"), "6199775178");
  assert.equal(svc.last10("619-977-5178"), "6199775178");
  assert.equal(svc.last10("5178"), null, "too short to be a phone — must not key on it");
  assert.equal(svc.last10(null), null);
});

test("case ids survive whatever shape findCaseByPhone returns", () => {
  assert.deepEqual(svc.caseIdsFrom({ Data: { CaseID: 426256 }, Success: true }), [426256]);
  assert.deepEqual(svc.caseIdsFrom({ Data: [{ CaseID: 1 }, { CaseId: 2 }, { caseId: 3 }], Success: true }), [1, 2, 3]);
  assert.deepEqual(svc.caseIdsFrom({ Data: [{ CaseID: 7 }, { CaseID: 7 }], Success: true }), [7], "deduped");
  assert.deepEqual(svc.caseIdsFrom({ Data: null, Success: true }), []);
  assert.deepEqual(svc.caseIdsFrom({ Data: [{ CaseID: 0 }, { CaseID: -3 }, {}], Success: true }), [],
    "0, negative and missing ids are not case ids");
});

test("day keys span the window inclusively", () => {
  assert.deepEqual(svc.dayKeys("2026-07-26", "2026-07-28"), ["2026-07-26", "2026-07-27", "2026-07-28"]);
  assert.deepEqual(svc.dayKeys("2026-07-28", "2026-07-28"), ["2026-07-28"]);
});

test("apply REFUSES while the writer is disarmed", async () => {
  const prior = process.env.LOGICS_SOURCE_WRITER_ENABLED;
  delete process.env.LOGICS_SOURCE_WRITER_ENABLED;
  try {
    const r = await svc.applySourceSanitization(
      [{ domain: "TAG", caseId: 426256, piece: "Affordability Federal", sourceId: 75 }],
    );
    assert.equal(r.armed, false);
    assert.equal(r.written, 0);
    assert.match(r.refused, /LOGICS_SOURCE_WRITER_ENABLED/);
  } finally {
    if (prior === undefined) delete process.env.LOGICS_SOURCE_WRITER_ENABLED;
    else process.env.LOGICS_SOURCE_WRITER_ENABLED = prior;
  }
});

test("apply refuses even when explicitly handed a plan and 'false' is a string", async () => {
  const prior = process.env.LOGICS_SOURCE_WRITER_ENABLED;
  process.env.LOGICS_SOURCE_WRITER_ENABLED = "false";
  try {
    const r = await svc.applySourceSanitization([{ domain: "TAG", caseId: 1, piece: "Urgent Third State" }]);
    assert.equal(r.armed, false);
    assert.equal(r.written, 0);
  } finally {
    if (prior === undefined) delete process.env.LOGICS_SOURCE_WRITER_ENABLED;
    else process.env.LOGICS_SOURCE_WRITER_ENABLED = prior;
  }
});

test("an unmapped tenant plans NOTHING rather than guessing", async () => {
  // WYNN has no registry. Every WYNN piece must be skipped, not approximated.
  const r = await svc.planSourceSanitization({ domain: "WYNN", days: 1 });
  assert.deepEqual(r.plan, []);
  assert.match(r.skipped, /no source registry for WYNN/);
  assert.equal(r.stats.planned, 0);
});

test("runSourceSanitizer without apply never reaches the writer", async () => {
  const r = await svc.runSourceSanitizer({ domain: "WYNN", days: 1, apply: false });
  assert.equal(r.applied, null, "applied must be null when apply is false");
});
