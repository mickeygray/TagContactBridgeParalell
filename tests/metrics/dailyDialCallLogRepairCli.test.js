"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  parseArgs,
  unsafeRepairReasons,
} = require("../../scripts/reconcile-phoneburner-daily-dial-calllog");

test("repair CLI is dry-run unless --apply is explicit", () => {
  assert.deepEqual(
    parseArgs(["--from=2026-07-01", "--to=2026-07-23", "--pretty"]),
    {
      from: "2026-07-01",
      to: "2026-07-23",
      apply: false,
      pretty: true,
    },
  );
  assert.equal(
    parseArgs(["--from=2026-07-01", "--to=2026-07-23", "--apply"]).apply,
    true,
  );
});

test("repair preflight permits missing rows but blocks conflicting state", () => {
  assert.deepEqual(unsafeRepairReasons({
    totals: {
      nonPhoneBurnerAttempts: 0,
      explicitRejects: 0,
      duplicates: 0,
      mismatched: 0,
      unexpectedProjectedCallLogs: 0,
      missing: 3270,
    },
  }), []);
  assert.deepEqual(unsafeRepairReasons({
    totals: {
      nonPhoneBurnerAttempts: 5,
      explicitRejects: 1,
      duplicates: 2,
      mismatched: 3,
      unexpectedProjectedCallLogs: 4,
    },
  }), [
    "out-of-scope-provider-attempts",
    "daily-dial-rejects",
    "identity-duplicates",
    "existing-calllog-mismatch",
    "unexpected-calllog-projections",
  ]);
});
