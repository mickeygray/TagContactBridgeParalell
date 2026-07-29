"use strict";

// B1 — stage 1 of the nightly pass (pipeline contract Part I).
// Replay-verified against the 4,130-row live fixture pulled 2026-07-27
// (Thu 7/23 + Mon 7/27, TAG/WYNN/AMITY), cross-checked against the
// independent censuses in ACTIVITY_FEED_SHAPE_MAP_2026-07-27.md.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildDedupeKey,
  classifyRow,
  insertActivityEvents,
  parseReportRows,
  parseStatusName,
} = require("../../packages/shared-services/src/activityEventService");
const { ActivityEvent } = require("../../packages/shared-models/src");

const FIXTURE = require("../fixtures/activities-2026-07-23_2026-07-27.json");

function replayAll() {
  const agg = { rows: 0, staff: 0, system: 0, byKind: {} };
  const keys = new Set();
  let resurfaced = 0;
  const events = [];
  for (const [dateKey, doms] of Object.entries(FIXTURE)) {
    for (const [domain, rows] of Object.entries(doms)) {
      if (!Array.isArray(rows)) continue;
      const out = parseReportRows(rows, { domain, dateKey });
      agg.rows += out.stats.rows;
      agg.staff += out.stats.staffRows;
      agg.system += out.stats.systemRows;
      for (const [k, c] of Object.entries(out.stats.byKind)) agg.byKind[k] = (agg.byKind[k] || 0) + c;
      for (const e of out.events) {
        if (keys.has(e.dedupeKey)) resurfaced += 1;
        else { keys.add(e.dedupeKey); events.push(e); }
      }
    }
  }
  return { agg, uniqueKeys: keys.size, resurfaced, events };
}

// ── the replay: pinned against the independent censuses ──────────────────

test("replay: every row classifies — zero unclassified across 4,130 rows", () => {
  const { agg } = replayAll();
  assert.equal(agg.rows, 4130);
  assert.equal(agg.byKind.unclassified ?? 0, 0, "an unclassified row means the grammar regressed");
});

test("replay: the system partition matches the census exactly", () => {
  const { agg } = replayAll();
  // 3,389 signature rows (2,904 ABC + 191 LD intake + 294 API echo)
  // + 3 RuleEngine rows deliberately reclassified system-echo = 3,392.
  assert.equal(agg.system, 3392);
  assert.equal(agg.byKind.intake, 3095, "2,904 ABC + 191 LD CUSTOM");
  assert.equal(agg.byKind["system-echo"], 297, "294 Public API echoes + 3 RuleEngine");
  assert.equal(agg.staff, 738);
});

test("replay: the money tip-off lane is exactly the censused 89", () => {
  const { agg } = replayAll();
  // Type Payment 78 + CaseAccount 9 + LOAN 2 — the lane Logics itself types.
  assert.equal(agg.byKind["payment-claim"], 89);
});

test("replay: structured lanes match the censuses", () => {
  const { agg } = replayAll();
  assert.equal(agg.byKind.assignment, 63);        // 57 Set.Officer + 3 AS433a + 2 CPA + 1 OG
  assert.equal(agg.byKind["doc-upload"], 218);
  assert.equal(agg.byKind["doc-sent"], 43);
  assert.equal(agg.byKind.conversation, 97);
  assert.equal(agg.byKind["liability-change"], 15);
  assert.equal(agg.byKind["source-update"], 8);
  assert.equal(agg.byKind["status-change"], 50);
  assert.equal(agg.byKind["credit-score"], 14);   // 11 typed softpull + 3 General score lines
});

test("replay: cross-day resurfacing is real and dedupe catches it", () => {
  const { uniqueKeys, resurfaced } = replayAll();
  // The window keys on LastModifiedDate: 50 rows appear in BOTH days'
  // pulls with identical Created — the dedupeKey must collapse them.
  assert.equal(resurfaced, 50);
  assert.equal(uniqueKeys, 4080);
});

test("replay: moneyCases unions payment-lane with ALL staff-touched cases", () => {
  // The $29,405-check lesson: 2/9 real payments had no payment activity.
  const rows = FIXTURE["2026-07-23"].TAG;
  const out = parseReportRows(rows, { domain: "TAG", dateKey: "2026-07-23" });
  assert.ok(out.moneyCases.size >= out.paymentLaneCases.size);
  for (const id of out.paymentLaneCases) assert.ok(out.moneyCases.has(id));
  // 164652 paid $29,405 by check with NO payment activity — but was touched.
  assert.ok(out.moneyCases.has(164652), "the check-payment case must be in the sweep");
  assert.ok(!out.paymentLaneCases.has(164652), "…without any payment-lane activity");
});

// ── grammar edges ────────────────────────────────────────────────────────

test("status safety classes match on the LABEL suffix, never the full string", () => {
  // POST DATE appears under THREE brackets in real data.
  for (const name of ["[Active Prospect]-POST DATE", "[Pending Approval]-POST DATE ", "[Active Prospect]-POST DATE"]) {
    assert.equal(parseStatusName(name).safetyClass, "postdate", name);
  }
  assert.equal(parseStatusName('[Bad/Inactive]-DO NOT CALL').safetyClass, "dnc");
  assert.equal(parseStatusName("[Suspended]-PAYMENT DEFAULT STOP WORK ").safetyClass, "suspended");
  assert.equal(parseStatusName("[Suspended]-1st Payment Default").safetyClass, "suspended");
  assert.equal(parseStatusName("[TIER 1]-ACTIVE").safetyClass, null);
});

test("a DNC→DNC self-transition is flagged so folds can skip the no-op", () => {
  const { kind, payload } = classifyRow({
    Type: "General",
    ActivitySubject: 'Status changed from "[Bad/Inactive]-DO NOT CALL"  to  "[Bad/Inactive]-DO NOT CALL"',
  });
  assert.equal(kind, "status-change");
  assert.equal(payload.selfTransition, true);
  assert.equal(payload.safetyClass, "dnc");
});

test("--Unassigned-- clears the slot rather than becoming a person", () => {
  const { payload } = classifyRow({ Type: "General", ActivitySubject: "Assigned to Set. Officer : --Unassigned--" });
  assert.equal(payload.role, "Set. Officer");
  assert.equal(payload.assignee, null);
});

test("payment verbs and amounts parse from the subject", () => {
  const made = classifyRow({ Type: "Payment", ActivitySubject: "Payment made $11,050.00" });
  assert.deepEqual([made.kind, made.payload.verb, made.payload.amountClaimed], ["payment-claim", "made", 11050]);
  const declined = classifyRow({ Type: "Payment", ActivitySubject: "Payment Declined $562.50" });
  assert.deepEqual([declined.payload.verb, declined.payload.amountClaimed], ["declined", 562.5]);
  const deleted = classifyRow({ Type: "Payment", ActivitySubject: "Payment deleted $1,679.00" });
  assert.equal(deleted.payload.verb, "deleted");
  const invoice = classifyRow({ Type: "Payment", ActivitySubject: "New invoice item added" });
  assert.equal(invoice.payload.verb, "invoice");
});

test("dedupeKey is built from Created — a LastModified touch cannot change it", () => {
  const base = { domain: "TAG", caseId: 46111, subject: "RE REDLINE:", created: "11/20/2025 5:11:14 PM" };
  const key1 = buildDedupeKey(base);
  // Same activity resurfacing months later (edited => new LastModifiedDate)
  // must produce the SAME key — Created is immutable.
  const key2 = buildDedupeKey({ ...base });
  assert.equal(key1, key2);
  assert.notEqual(key1, buildDedupeKey({ ...base, created: "7/27/2026 4:55:35 PM" }),
    "a genuinely different Created is a different activity");
});

test("intake keeps its source; API echoes are never interpreted", () => {
  const intake = classifyRow({ Type: "General", ActivitySubject: "Case received from ABC" });
  assert.deepEqual([intake.kind, intake.staff, intake.payload.source], ["intake", false, "ABC"]);
  const echo = classifyRow({ Type: "General", ActivitySubject: "Case updated by Public API" });
  assert.deepEqual([echo.kind, echo.staff], ["system-echo", false]);
});

// ── the writer: first-seen vs resurfaced from insert outcomes ────────────

test("insertActivityEvents counts first-seen vs resurfaced from outcomes", async () => {
  const stored = new Set();
  const original = ActivityEvent.insertMany;
  ActivityEvent.insertMany = async (docs) => {
    const insertedDocs = [];
    const writeErrors = [];
    for (const d of docs) {
      if (stored.has(d.dedupeKey)) { writeErrors.push({ code: 11000 }); continue; }
      stored.add(d.dedupeKey);
      insertedDocs.push(d);
    }
    if (writeErrors.length) {
      const err = new Error("bulk");
      err.writeErrors = writeErrors;
      err.insertedDocs = insertedDocs;
      throw err;
    }
    return insertedDocs;
  };
  try {
    const rows = FIXTURE["2026-07-23"].TAG;
    const { events } = parseReportRows(rows, { domain: "TAG", dateKey: "2026-07-23" });
    // WITHIN-day duplicates are real: the report has no ActivityID, so two
    // activities with identical (caseId, subject, Created) — e.g. the double
    // "Payment deleted $1,679.00" keyed the same second — are
    // indistinguishable and collapse to one event. 8 such rows on 7/23 TAG.
    const unique = new Set(events.map((e) => e.dedupeKey)).size;
    assert.equal(events.length - unique, 8, "the within-day duplicate census moved — recheck the feed");
    const first = await insertActivityEvents(events);
    assert.equal(first.inserted, unique);
    assert.equal(first.resurfaced, events.length - unique);
    // Re-run the same night: EVERYTHING resurfaces, nothing double-counts.
    const second = await insertActivityEvents(events);
    assert.equal(second.inserted, 0);
    assert.equal(second.resurfaced, events.length);
  } finally { ActivityEvent.insertMany = original; }
});
