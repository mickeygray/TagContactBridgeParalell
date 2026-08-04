"use strict";

// THE TENANT RULE — one place, not four.
//
// Three of our channels are single-tenant and live under TAG: the mail pieces
// (and BCD, bought against them), the CallRail account, and the RingCentral
// inbound queue. A report scoped to any other tenant must not carry any of
// them.
//
// That rule was first written inside the `topline` block, and it stopped
// there. The result, measured on the WYNN vendor board for 2026-07-30..31:
// the top line correctly read "$507 spent (LD only)" while the By source
// table directly underneath listed $2,255 of OUR mail spend at -100% ROI, and
// Calls by agent credited the vendor's board with 27 of TAG's inbound calls.
// Mickey 2026-07-31: "i mean this for the entire email basically gotta solve
// that issue."
//
// So it moved onto gatherMaterial, where every block inherits it. These tests
// pin the GATHER, because the way this regresses is someone re-deriving the
// rule inside a block — which is exactly how it drifted the first time.

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const COMPOSER = require.resolve("../../packages/shared-services/src/reportComposerService");

// The gather talks to Mongo and to CallRail. Neither is the subject here: the
// question is which rows survive the tenant filter, so the models are stubbed
// and the assertions are about what comes back.
const SPEND_ROWS = [
  { date: "2026-07-30", channel: "mailer", source: "Urgent Third State", spend: 1127.75, pieces: 5000 },
  { date: "2026-07-30", channel: "mailer", source: "3rd Day (Pink) Urgent Third State", spend: 1127.75, pieces: 5000 },
  { date: "2026-07-30", channel: "lead-data", source: "LD CUSTOM", spend: 507, leadsReported: 169 },
];

function withStubs(run) {
  const realResolve = Module._resolveFilename;
  const realLoad = Module._load;
  const chain = () => ({ select: chain, lean: async () => [] });
  const stubs = {
    "SpendEntry": { find: () => ({ select: () => ({ lean: async () => SPEND_ROWS.map((r) => ({ ...r })) }) }) },
    // No invoice-derived mail spend in these fixtures, so the sheet's mail rows
    // are the only mail money and the tenant assertions below are unchanged by
    // the merge. The stub still has to exist: an unstubbed model buffers
    // against a database this suite never connects to.
    "MailSpendDay": { find: () => ({ select: () => ({ lean: async () => [] }) }) },
    // The live-sheet fallback must be stubbed or this suite makes a REAL
    // network fetch to the vendor's CSV — 14s per case, and its rows would
    // displace the fixture's mail spend, which is what these tests measure.
    // Empty here: the fixtures are about THE TENANT RULE, not the sheet.
    "mailSheetCsvService": {
      readMailSheetCsv: async () => ({ rows: [], days: [], unavailable: null }),
    },
    // LD spend is DERIVED from lead receipts now, not read off the sheet, so
    // the lead-data fixture row above no longer supplies its dollars. 169
    // leads x $3 = $507 keeps the arithmetic below identical to when the
    // sheet supplied it, so these assertions still test THE TENANT RULE and
    // not the change of source.
    "ldSpendService": {
      readLdSpend: async () => ({
        leads: 169, rate: 3, spend: 507, byDomain: { WYNN: 169 },
        byDay: { "2026-07-30": 169 }, spendByDay: { "2026-07-30": 507 }, unavailable: null,
      }),
      ldCostPerLead: () => 3,
    },
    "DailyCallStat": {
      find: (q) => ({
        select: () => ({
          lean: async () => (q.channel === "bcd"
            ? [{ totalCalls: 12 }]
            : [{ piece: "Urgent Third State", totalCalls: 223, firstTimeCallers: 100 }]),
        }),
      }),
    },
  };
  Module._load = function load(request, parent, isMain) {
    for (const [name, impl] of Object.entries(stubs)) {
      if (request.endsWith(`/${name}`) || request.endsWith(`\\${name}`)) return impl;
    }
    return realLoad.apply(this, [request, parent, isMain]);
  };
  return Promise.resolve()
    .then(run)
    .finally(() => { Module._load = realLoad; Module._resolveFilename = realResolve; void chain; });
}

const gather = async (domain) => {
  const { gatherMaterial } = require(COMPOSER);
  return gatherMaterial({
    needs: ["spend", "calls", "queue"],
    from: "2026-07-30", to: "2026-07-31", domain, live: false,
  });
};

test("a vendor board carries no mail or BCD spend", () => withStubs(async () => {
  const m = await gather("WYNN");
  assert.equal(m.spend.mail, 0, "mail spend is the mail tenant's, never a vendor's");
  assert.equal(m.spend.bcd, 0, "BCD is bought against the mail, so it goes with it");
  assert.equal(m.spend.ld, 507, "LD is bought per case per domain — it stays");
  assert.equal(m.spend.total, 507, "the total must be rebuilt from what applies, not carried over");
  assert.equal(m.spend.mailPieces, 0);
  assert.deepEqual(Object.keys(m.spendBySource), ["LD CUSTOM"],
    "a mail piece must not appear as a zero-deal, -100% ROI row on someone else's board");
}));

test("the mail tenant's own board keeps everything", () => withStubs(async () => {
  const m = await gather("TAG");
  assert.equal(m.spend.mail, 2255.5);
  assert.ok(m.spend.bcd > 0);
  // 4, not 5: LD spend is pushed down per receipt sourceName by the ldLeads
  // material, NOT written as a second lump "LD" row here. Counting it in both
  // places is exactly the double-count that put $315 on LD and $321 on Aged.
  assert.equal(Object.keys(m.spendBySource).length, 4, "3 sheet rows + BCD");
}));

test("an unscoped board keeps everything too", () => withStubs(async () => {
  const m = await gather(null);
  assert.equal(m.spend.mail, 2255.5);
  assert.ok(Object.keys(m.spendBySource).includes("Urgent Third State"));
}));

test("CallRail responses never reach a vendor board", () => withStubs(async () => {
  // There is exactly ONE CallRail account and it is TAG's, so a "WYNN
  // response" is not a thing that can exist.
  const m = await gather("WYNN");
  assert.deepEqual(m.callsBySource, {});
}));

test("the TAG inbound queue never reaches a vendor board", () => withStubs(async () => {
  const m = await gather("WYNN");
  assert.deepEqual(m.queueByAgent, {});
  assert.deepEqual(m.queueStreams, {});
}));

test("every omission is stated, never silent", () => withStubs(async () => {
  // A quietly-filtered board and a genuinely empty one look identical. The
  // whole reason these numbers went wrong for weeks is that nothing said so.
  const m = await gather("WYNN");
  const notes = (m.notes || []).join(" | ");
  assert.match(notes, /mail\/BCD spend row\(s\) omitted/);
  assert.match(notes, /CallRail responses omitted/);
  assert.match(notes, /inbound queue omitted/);
}));

test("nothing is omitted on the mail tenant's board, so nothing is announced", () => withStubs(async () => {
  const m = await gather("TAG");
  assert.equal((m.notes || []).some((n) => /omitted/.test(n)), false);
}));

// ── the block that has to agree with it ──────────────────────────────────
const blocks = require("../../packages/shared-services/src/reportBlocksService");

test("Calls by agent drops the inbound column when the board has no inbound", () => {
  // A column of zeros reads as "your leads produced no inbound calls" rather
  // than "this board has no inbound to show". The CSV keeps it regardless.
  const d = {
    attempts: 959, connected: 80, attemptsKnown: 959, attemptsUnknown: 0,
    talkMinutes: 45.9, connectRate: 8.3,
    agents: [{ agent: "Chris Bolt", inbound: 0, dials: 959, connected: 80, talkMinutes: 45.9, deals: 1, cash: 700 }],
  };
  const table = blocks.BY_ID.get("ldcalls").csv(d);
  assert.equal(table.emailColumns.some((c) => c.header === "inbound"), false);
  assert.equal(table.columns.some((c) => c.header === "inbound"), true, "the CSV still carries it");
});

test("connected and talk time are CSV-only — the email carries the cost instead", () => {
  // Mickey 2026-08-03: "you can sorta get rid of connected and talk minutes and
  // do like attributed spend." Retired from the EMAIL table, not from the
  // report: both are still in the CSV and in the section headline, so the
  // connect rate is one glance away rather than seven columns wide.
  const d = {
    attempts: 959, connected: 80, attemptsKnown: 959, attemptsUnknown: 0,
    talkMinutes: 45.9, connectRate: 8.3,
    agents: [{ agent: "Chris Bolt", inbound: 4, dials: 959, connected: 80, talkMinutes: 45.9, deals: 1, cash: 700 }],
  };
  const table = blocks.BY_ID.get("ldcalls").csv(d);
  const emailHas = (h) => table.emailColumns.some((c) => c.header === h);
  const csvHas = (h) => table.columns.some((c) => c.header === h);
  // new_ld joined connected/talk_minutes as CSV-only while lead distribution is
  // fixed — see NEW_LD_EMAIL_HIDDEN in reportBlocksService.
  for (const h of ["connected", "talk_minutes", "new_ld"]) {
    assert.equal(emailHas(h), false, `${h} left the email table`);
    assert.equal(csvHas(h), true, `${h} stays in the CSV`);
  }
  for (const h of ["attributed_spend"]) {
    assert.equal(emailHas(h), true, `${h} took its place`);
    assert.equal(csvHas(h), true);
  }
  for (const h of ["attributed_mail", "attributed_bcd", "attributed_ld"]) {
    assert.equal(csvHas(h), true, "the components are checkable in the CSV");
    assert.equal(emailHas(h), false, "but the email carries one number, not four");
  }
});

test("Calls by agent keeps the inbound column the moment there is inbound", () => {
  const d = {
    attempts: 10, connected: 2, attemptsKnown: 10, attemptsUnknown: 0,
    talkMinutes: 5, connectRate: 20,
    agents: [{ agent: "Phil Olson", inbound: 27, dials: 10, connected: 2, talkMinutes: 5, deals: 0, cash: 0 }],
  };
  const table = blocks.BY_ID.get("ldcalls").csv(d);
  assert.equal(table.emailColumns.some((c) => c.header === "inbound"), true);
});
