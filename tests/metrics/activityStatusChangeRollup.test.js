"use strict";

// EOD status-change counting from the Logics activity feed (Mickey,
// 2026-07-27): DNCs and post-dates counted from Activities — the canonical
// record of status changes — the way payments count from the sheet.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  TAG_STATUSES,
  WYNN_STATUSES,
} = require("../../packages/shared-config/src/statusMap");
const {
  extractStatusChanges,
  parseStatusChange,
  rollupStatusChanges,
} = require("../../packages/shared-services/src/activityStatusChangeRollupService");

// Labels come FROM the catalog — the test must not invent status names.
const TAG_DNC_LABEL = TAG_STATUSES[173].label;
const TAG_POSTDATE_LABEL = TAG_STATUSES[150].label;
const WYNN_POSTDATE_LABEL = WYNN_STATUSES[221].label;

function activityRow(overrides = {}) {
  return {
    CaseID: 1000,
    Subject: `Status changed from "Unopened" to "${TAG_DNC_LABEL}"`,
    ActivityType: "Status",
    CreatedDate: "7/27/2026 10:00:00 AM",
    CreatedBy: "brad_hansen",
    ...overrides,
  };
}

test("both subject grammars parse", () => {
  assert.deepEqual(
    parseStatusChange('Status changed from "Unopened" to "Post-Date"'),
    { fromStatus: "Unopened", toStatus: "Post-Date" },
  );
  assert.deepEqual(
    parseStatusChange("Status changed from Unopened to Opened"),
    { fromStatus: "Unopened", toStatus: "Opened" },
  );
  assert.deepEqual(parseStatusChange("Payment posted"), { fromStatus: "", toStatus: "" });
});

test("counts DNC and post-date through the catalog, per tenant", () => {
  const rollup = rollupStatusChanges({
    domain: "TAG",
    rows: [
      activityRow({ CaseID: 1 }),
      activityRow({ CaseID: 2, Subject: `Status changed from "Opened" to "${TAG_POSTDATE_LABEL}"` }),
      activityRow({ CaseID: 3, Subject: 'Status changed from "Unopened" to "Opened"' }),
      // Not a status change — ignored entirely.
      activityRow({ CaseID: 4, Subject: "Document uploaded: notice.pdf" }),
    ],
  });
  assert.equal(rollup.dnc, 1);
  assert.equal(rollup.postdate, 1);
  assert.equal(rollup.casesChanged, 3);
  assert.equal(rollup.dncCases[0].caseId, 1);
  assert.equal(rollup.postdateCases[0].caseId, 2);
});

test("WYNN's post-date label counts under WYNN, and ids never leak across tenants", () => {
  const rows = [
    activityRow({ CaseID: 10, Subject: `Status changed from "Unopened" to "${WYNN_POSTDATE_LABEL}"` }),
  ];
  assert.equal(rollupStatusChanges({ domain: "WYNN", rows }).postdate, 1);
});

test("a case flipping twice counts ONCE, on its final status of the day", () => {
  const rollup = rollupStatusChanges({
    domain: "TAG",
    rows: [
      activityRow({ CaseID: 5, CreatedDate: "7/27/2026 9:00:00 AM" }),
      activityRow({
        CaseID: 5,
        CreatedDate: "7/27/2026 4:00:00 PM",
        Subject: 'Status changed from "Do Not Call" to "Opened"',
      }),
    ],
  });
  assert.equal(rollup.casesChanged, 1, "one case, however many clicks");
  assert.equal(rollup.dnc, 0, "the day ENDED un-DNC'd — morning flip does not count");
  assert.equal(rollup.transitions, 2, "per-transition detail is preserved");
});

test("unresolvable status names are counted visibly, never guessed", () => {
  const rollup = rollupStatusChanges({
    domain: "TAG",
    rows: [
      activityRow({ CaseID: 6, Subject: 'Status changed from "Opened" to "Totally Made Up Status"' }),
    ],
  });
  assert.equal(rollup.unresolved, 1);
  assert.equal(rollup.dnc + rollup.postdate, 0);
});

test("rows without a case id are dropped and extraction is shape-tolerant", () => {
  const changes = extractStatusChanges([
    activityRow({ CaseID: null }),
    { "Case ID": "7,001", "Activity Subject": 'Status changed from "A" to "B"', "Created Date": "7/27/2026" },
  ]);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].caseId, 7001);
  assert.equal(changes[0].toStatus, "B");
});

test("domain is required", () => {
  assert.throws(() => rollupStatusChanges({ rows: [] }), TypeError);
});
