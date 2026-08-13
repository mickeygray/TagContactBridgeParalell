"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildNightlyRunSummary,
  sendNightlyRunSummary,
} = require("../../packages/shared-services/src/nightlyRunSummaryService");

test("the nightly receipt distinguishes completed work from follow-ups", () => {
  const summary = buildNightlyRunSummary([
    {
      task: "mail-invoice",
      label: "Mailbox",
      applied: { ncoaProcessed: 1, invoiceProcessed: 1, written: 2 },
    },
    {
      task: "mail-spend-derive",
      label: "Mail spend",
      applied: { written: 1, repaired: 1, held: 2 },
    },
    {
      task: "report-delivery",
      label: "Reports",
      applied: {
        written: 2,
        reports: [{
          agedSourceWrite: { status: "completed", written: 3, failed: 0 },
        }],
      },
    },
    {
      task: "historical-report-repair",
      label: "Historical repair",
      applied: { written: 1, attention: 1 },
    },
    {
      task: "lead-health",
      label: "Lead health",
      applied: {
        leadHealth: {
          inventory: {
            zeroTouch: 8,
            lowTouch: 120,
            highTouch: 40,
            phaseOut: 30,
            zeroTouchOlderThanToday: 2,
            review: 6,
            due: { zeroTouch: 3, lowTouch: 17, highTouch: 4, phaseOut: 1 },
          },
          attempts: { total: 90, firstTouches: 12, lowTouch: 35, highTouch: 30, phaseOut: 13 },
          alerts: {
            zeroTouchDue: true,
            staleZeroTouch: true,
            highTouchWhileLightDue: true,
            noCallsWithOpenWork: false,
          },
          repair: {
            scanned: 7,
            expiredReservationsReleased: 2,
            phaseOutDatesRepaired: 3,
            alreadyHealthy: 1,
            conflicts: 1,
            skippedContradictory: 0,
            truncated: false,
          },
        },
      },
    },
    { task: "activity-review", label: "Activity review", error: "upstream timeout" },
  ], {
    aged: {
      status: "completed",
      checked: 100,
      promoted: 20,
      retired: 5,
      lookupFailures: 10,
      lookupFailureReasons: { paymentRequired: 10 },
    },
    blogger: { status: "completed", durationMs: 45_000 },
  });

  assert.ok(summary.completed.some((line) => /NCOA/.test(line)));
  assert.ok(summary.completed.some((line) => /earlier nightly report/.test(line)));
  assert.ok(summary.completed.some((line) => /3 case source status/.test(line)));
  assert.ok(summary.followUps.some((line) => /remain held/.test(line)));
  assert.ok(summary.followUps.some((line) => /Activity review: failed/.test(line)));
  assert.ok(summary.followUps.some((line) => /insufficient provider credit/.test(line)));
  assert.ok(summary.completed.some((line) => /Blogger completed successfully/.test(line)));
  assert.ok(summary.leadHealth.some((line) => /12 first touch/.test(line)));
  assert.ok(summary.leadHealth.some((line) => /8 zero-touch/.test(line)));
  assert.ok(summary.leadHealth.some((line) => /2 expired reservation\(s\) released/.test(line)));
  assert.ok(summary.leadHealth.some((line) => /3 premature phase-out date\(s\) corrected/.test(line)));
  assert.ok(summary.followUps.some((line) => /below ten touches remain due/.test(line)));
  assert.ok(summary.followUps.some((line) => /zero-touch lead\(s\) remain due/.test(line)));
  assert.ok(summary.followUps.some((line) => /1 compare-and-set conflict/.test(line)));
  assert.equal(summary.followUps.some((line) => /upstream timeout/.test(line)), false,
    "raw error text never enters the receipt");
});

test("the run summary is sent only to the supplied operator audience", async () => {
  let sent = null;
  const result = await sendNightlyRunSummary({
    dateKey: "2026-08-11",
    results: [],
    recipients: ["MGray@taxadvocategroup.com", "mgray@taxadvocategroup.com"],
    mailer: async (domain, options) => {
      sent = { domain, options };
      return { messageId: "accepted" };
    },
    operationalLoader: async () => ({
      aged: { status: "missing" },
      blogger: { status: "missing" },
    }),
  });
  assert.equal(result.sent, true);
  assert.equal(result.recipientCount, 1);
  assert.equal(sent.domain, "TAG");
  assert.deepEqual(sent.options.to, ["mgray@taxadvocategroup.com"]);
  assert.match(sent.options.text, /Successfully completed:/);
  assert.match(sent.options.text, /Lead health:/);
  assert.match(sent.options.text, /Needs attention:/);
});

test("the consolidated receipt makes quiet and missing operational paths explicit", () => {
  const summary = buildNightlyRunSummary([
    {
      task: "mail-invoice",
      label: "Mailbox",
      applied: { ncoaProcessed: 0, ncoaFailed: 0 },
    },
  ], {
    aged: { status: "missing" },
    blogger: { status: "failed", timedOut: true },
  });
  assert.ok(summary.completed.some((line) => /NCOA mailbox checked/.test(line)));
  assert.ok(summary.followUps.some((line) => /Aged\/DNC refresh: no daily run receipt/.test(line)));
  assert.ok(summary.followUps.some((line) => /Blogger failed after timing out/.test(line)));
});
