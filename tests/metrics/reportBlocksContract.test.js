"use strict";

// A block that declares a source gatherMaterial does not gather renders an
// empty table and looks like a fact. That shipped three times, so the
// contract is enforced here as well as at module load.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const blocks = require("../../packages/shared-services/src/reportBlocksService");
const { summarizeDealHistory } = require("../../packages/shared-services/src/reportComposerService");

const EMPTY = {
  payments: [], declines: [], dials: [], events: [], callsRange: [],
  postdateBilling: [], spend: {}, calls: [], activity: [], recordings: [],
  queueStreams: {}, queueByAgent: {},
};

test("every block declares only sources gatherMaterial knows how to gather", () => {
  for (const b of blocks.BLOCKS) {
    for (const need of b.needs) {
      assert.ok(blocks.SOURCES.includes(need), `block "${b.id}" needs unknown source "${need}"`);
    }
  }
});

test("gatherMaterial actually handles every declared SOURCE", () => {
  // The mirror of the test above: a source can be declared, validated, and
  // still never gathered if the composer has no branch for it.
  const fs = require("fs");
  const src = fs.readFileSync(
    require.resolve("../../packages/shared-services/src/reportComposerService"), "utf8",
  );
  for (const source of blocks.SOURCES) {
    assert.ok(src.includes(`want.has("${source}")`), `gatherMaterial never gathers "${source}"`);
  }
});

test("every block renders and exports with nothing to report", () => {
  for (const b of blocks.BLOCKS) {
    const data = b.compute(EMPTY);
    assert.equal(typeof b.renderText(data), "string", `${b.id} renderText`);
    const csv = b.csv(data);
    assert.ok(Array.isArray(csv.rows) && Array.isArray(csv.columns), `${b.id} csv shape`);
  }
});

test("a preset name never silently expands a ticked block id", () => {
  // "money" was both a block and a preset: ticking one box gave three.
  for (const name of Object.keys(blocks.PRESETS)) {
    assert.ok(!blocks.BY_ID.has(name), `preset "${name}" collides with a block id`);
  }
});

test("blocks that consume payment attribution also gather contacts", () => {
  for (const id of ["lag", "declines"]) {
    assert.ok(blocks.BY_ID.get(id).needs.includes("caseContacts"), `${id} must declare caseContacts`);
  }
});

test("the recordings block marks WHICH call earned the attribution", () => {
  // Every call from a deal's number is tagged DEAL, so a case with three
  // calls shows three DEAL rows. Only one earned the source — the longest on
  // the close day. Live 2026-07-27: A SKRZYPEK had a 46m call and a 7.8m
  // call; only the 46m one is SOURCE.
  const block = blocks.BY_ID.get("recordings");
  const rows = [
    { reasons: ["DEAL", "LONG", "SOURCE"], isAttributionCall: true, minutes: 46,
      caller: "A SKRZYPEK", officer: "Phil Olson", source: "3rd Day (Pink) Urgent Third State",
      listenUrl: "https://app.callrail.com/x" },
    { reasons: ["DEAL"], minutes: 7.8, caller: "A SKRZYPEK", officer: "Phil Olson",
      source: "Urgent Third State", listenUrl: "https://app.callrail.com/y" },
  ];
  const text = block.renderText(block.compute({ recordings: rows }));
  assert.match(text, /SOURCE\] 46m A SKRZYPEK/, "the attribution call is marked");
  assert.match(text, /\(source: 3rd Day \(Pink\) Urgent Third State\)/);
  // The non-attribution call must NOT claim a source, even though it has one
  // on the row — otherwise two calls appear to explain the same deal.
  const shortLine = text.split(String.fromCharCode(10)).find((l) => l.includes("7.8m"));
  assert.ok(shortLine && !shortLine.includes("source:"),
    "a non-attribution DEAL call must not print a source");
});

// ── the work log: calls received / taken / made, deals written ───────────

const worked = () => blocks.BY_ID.get("worked");

const QUEUE = {
  queueByAgent: {
    "Phil Olson": { MAILER: 27, LD: 79 },
    "Chris Bolt": { MAILER: 1, LD: 528 },
    "Andrew Wells": { MAILER: 8, BCD: 1 },
  },
  queueStreams: {
    MAILER: { calls: 80, connected: 72, missed: 8 },
    BCD: { calls: 1, connected: 1, missed: 0 },
  },
};

test("inbound is TAKEN, outbound is MADE — they never mix", () => {
  const d = worked().compute({ ...QUEUE, payments: [] });
  const phil = d.rows.find((r) => r.agent === "Phil Olson");
  assert.equal(phil.taken, 27, "MAILER + BCD are calls taken");
  assert.equal(phil.made, 79, "LD is PhoneBurner outbound");
  // Andrew is customer service, so he is credited in alsoAnswering rather
  // than ranked among sales — see staffRoster.test.js.
  const andrew = d.alsoAnswering.find((r) => r.agent === "Andrew Wells");
  assert.equal(andrew.taken, 9, "BCD counts as taken alongside MAILER");
  assert.equal(andrew.made, 0);
});

test("outbound is counted ONCE — the block must not also declare dials", () => {
  // readLdDials reads the same DailyDial rows the LD counts come from
  // (verified live 2026-07-27: chris_bolt 528 in both). Declaring "dials" as
  // well would double every outbound number on the board.
  // caseContacts joined the list so a MIDDAY board can resolve the officer
  // live; dials must still never appear, as LD already carries outbound.
  assert.deepEqual(worked().needs, ["queue", "payments", "caseContacts"]);
  assert.ok(!worked().needs.includes("dials"), "dials would double-count LD");
});

test("received and missed are QUEUE facts, never charged to a person", () => {
  const d = worked().compute({ ...QUEUE, payments: [] });
  assert.equal(d.totals.received, 81);
  assert.equal(d.totals.taken, 73);
  assert.equal(d.totals.missed, 8);
  // A missed call never reached an agent, so no row may claim it.
  // Sales rows + customer service: everyone NAMED in the report.
  const perAgentTaken = [...d.rows, ...d.alsoAnswering].reduce((a, r) => a + r.taken, 0);
  assert.equal(perAgentTaken, 37, "27 + 1 + (8 + 1) — only connected calls have an agent");
  // The per-agent sum can never exceed the calls the queue says connected;
  // if it did, a missed call would have been charged to someone.
  assert.ok(perAgentTaken <= d.totals.taken,
    "per-agent taken must not exceed queue-connected");
  const text = worked().renderText(d);
  assert.match(text, /8 call\(s\) rang and were not answered/);
  assert.match(text, /queue-wide, not attributable to a person/);
});

test("deals count SALES, and people appear with calls OR deals", () => {
  const d = worked().compute({
    ...QUEUE,
    payments: [
      // one sale, two installments of the first invoice
      { domain: "TAG", caseId: 394513, paymentType: "initial", amount: 500, officerAtSale: "Phil Olson", isChargeback: false },
      { domain: "TAG", caseId: 394513, paymentType: "initial", amount: 500, officerAtSale: "Phil Olson", isChargeback: false },
      // someone with a deal and NO queue activity still belongs on the board
      { domain: "TAG", caseId: 1, paymentType: "initial", amount: 300, officerAtSale: "Brad Hansen", isChargeback: false },
    ],
  });
  const phil = d.rows.find((r) => r.agent === "Phil Olson");
  assert.equal(phil.deals, 1, "two installments of one first invoice is ONE sale");
  assert.equal(phil.cash, 1000);
  assert.ok(d.rows.some((r) => r.agent === "Brad Hansen"), "deals without calls still show");
  assert.ok(d.rows.some((r) => r.agent === "Chris Bolt" && r.deals === 0), "calls without deals still show");
});

test("an unattributed deal is labelled, not silently dropped from the board", () => {
  const d = worked().compute({
    queueByAgent: {}, queueStreams: {},
    payments: [
      { domain: "TAG", caseId: 1, paymentType: "initial", amount: 100, attributionSnapshot: "missing", isChargeback: false },
      { domain: "TAG", caseId: 2, paymentType: "initial", amount: 200, attributionSnapshot: "found", officerAtSale: null, isChargeback: false },
    ],
  });
  const keys = d.rows.map((r) => r.agent).sort();
  assert.deepEqual(keys, ["(no snapshot)", "(unassigned)"]);
});

test("the work log renders with nothing recorded yet (the 1pm edge case)", () => {
  // A 1pm run on a quiet morning must say so, not print an empty table.
  const d = worked().compute({ queueByAgent: {}, queueStreams: {}, payments: [] });
  assert.match(worked().renderText(d), /nothing recorded yet/);
});

// ── ROAS and ROI, exactly as defined ─────────────────────────────────────

test("ROAS is initials/cost; ROI is (total-cost)/cost", () => {
  // Mickey 2026-07-28, verbatim: "roas is just sum initials / sum costs,
  // roi is sum totals - sum costs / sum costs". ROI is NET, so it sits 100
  // points below the gross multiple — reporting total/cost as ROI overstates
  // every piece by exactly its own cost.
  const d = blocks.BY_ID.get("source").compute({
    payments: [
      { domain: "TAG", caseId: 1, paymentType: "initial", amount: 1000, sourceAtSale: "Urgent Third State", isChargeback: false },
      { domain: "TAG", caseId: 2, paymentType: "recurring", amount: 500, sourceAtSale: "Urgent Third State", isChargeback: false },
    ],
    spendBySource: { "Urgent Third State": { spend: 1000, leads: 0 } },
    callsBySource: {},
  });
  const r = d.find((x) => x.source === "Urgent Third State");
  assert.equal(r.roas, 100, "1000 initials / 1000 cost");
  assert.equal(r.roi, 50, "(1500 total - 1000 cost) / 1000 cost");
});

test("a piece that exactly pays for itself is 0% ROI, not 100%", () => {
  const d = blocks.BY_ID.get("source").compute({
    payments: [{ domain: "TAG", caseId: 1, paymentType: "initial", amount: 500, sourceAtSale: "Urgent Third State", isChargeback: false }],
    spendBySource: { "Urgent Third State": { spend: 500, leads: 0 } },
    callsBySource: {},
  });
  assert.equal(d.find((x) => x.source === "Urgent Third State").roi, 0);
});

test("a losing piece shows NEGATIVE roi", () => {
  // LD CUSTOM: $980 new on $8,619 spend. A losing month must look like one.
  const d = blocks.BY_ID.get("source").compute({
    payments: [{ domain: "TAG", caseId: 1, paymentType: "initial", amount: 980, sourceAtSale: "LD CUSTOM", isChargeback: false }],
    spendBySource: { "LD CUSTOM": { spend: 8619, leads: 0 } },
    callsBySource: {},
  });
  // The row is "LD", not "LD CUSTOM": every LD feed variant rolls up to one
  // line (Mickey 2026-08-03, "do a roll up on all LD combining general,
  // custom, etc"). The money and the ratio are unchanged — only the label.
  const r = d.find((x) => x.source === "LD");
  assert.ok(r, `expected a rolled-up LD row, got ${d.map((x) => x.source).join(", ")}`);
  assert.ok(r.roi < 0, `expected a negative return, got ${r.roi}`);
  assert.equal(r.roas, 11.4);
});

test("no spend means no ratio — never Infinity", () => {
  const d = blocks.BY_ID.get("source").compute({
    payments: [{ domain: "TAG", caseId: 1, paymentType: "initial", amount: 1000, sourceAtSale: "Urgent Third State", isChargeback: false }],
    spendBySource: {}, callsBySource: {},
  });
  const r = d.find((x) => x.source === "Urgent Third State");
  assert.equal(r.roas, null);
  assert.equal(r.roi, null);
});

test("an implausible return flags the SPEND, not the campaign", () => {
  // BCD: $6,850 against $8.00 of recorded spend. BCD cost derives from call
  // counts and July had 2 on record — a hole in the feed, not a 855x campaign.
  const d = blocks.BY_ID.get("source").compute({
    payments: [
      { domain: "TAG", caseId: 1, paymentType: "initial", amount: 1850, sourceAtSale: "BCD", isChargeback: false },
      { domain: "TAG", caseId: 2, paymentType: "recurring", amount: 5000, sourceAtSale: "BCD", isChargeback: false },
    ],
    spendBySource: { BCD: { spend: 8, leads: 0 } },
    callsBySource: {},
  });
  const r = d.find((x) => x.source === "BCD");
  assert.equal(r.spendSuspect, true);
  const text = blocks.BY_ID.get("source").renderText(d);
  assert.match(text, /spend looks incomplete/);
  assert.match(text, /BCD on \$8\.00/);
});

test("the mail-house placeholder is not a mail piece", () => {
  // A stored snapshot literally reading "ABC" rendered as its own row,
  // splitting the catch-all in two.
  const d = blocks.BY_ID.get("source").compute({
    payments: [
      { domain: "TAG", caseId: 1, paymentType: "initial", amount: 1000, sourceAtSale: "ABC", isChargeback: false },
      { domain: "TAG", caseId: 2, paymentType: "initial", amount: 500, sourceOrigin: "catch-all", catchAllLabel: "ABC", isChargeback: false },
    ],
    spendBySource: {}, callsBySource: {},
  });
  const abc = d.filter((x) => x.source.startsWith("ABC"));
  assert.equal(abc.length, 1, `ABC must be ONE row, got ${abc.map((x) => x.source).join(" | ")}`);
  assert.equal(abc[0].deals, 2);
});

test("a piece name folds to one row whichever tenant paid", () => {
  // WYNN case 134815 carried "Urgent Third Pink State" — a TAG mail piece.
  // WYNN has no registry, so it failed to fold and the piece appeared twice,
  // splitting its own ROAS.
  const d = blocks.BY_ID.get("source").compute({
    payments: [
      { domain: "TAG", caseId: 1, paymentType: "initial", amount: 100, sourceAtSale: "3rd Day (Pink) Urgent Third State", isChargeback: false },
      { domain: "WYNN", caseId: 2, paymentType: "initial", amount: 200, sourceAtSale: "Urgent Third Pink State", isChargeback: false },
    ],
    spendBySource: {}, callsBySource: {},
  });
  const pink = d.filter((x) => /Pink/i.test(x.source));
  assert.equal(pink.length, 1, `one piece, one row — got ${pink.map((x) => x.source).join(" | ")}`);
  assert.equal(pink[0].deals, 2);
});

test("every block states its TERMS", () => {
  // Mickey 2026-07-28: "thats why its important to define the terms of the
  // report. an roi report is just this months money, a profit loss kinda
  // thing can look at a broader picture."
  //
  // A block without stated terms invites exactly the mistake that produced
  // two different ROIs — one net, one gross — with identical-looking output.
  for (const b of blocks.BLOCKS) {
    assert.equal(typeof b.terms, "string", `block "${b.id}" has no terms`);
    assert.ok(b.terms.length > 30, `block "${b.id}" terms are too thin to settle an argument`);
  }
});

test("terms name the BOUNDARY, not just the calculation", () => {
  // The boundary is the thing that differs between an ROI report and a P&L:
  // which money counts, and from when.
  const boundaryish = /range|inside|at sale|first paid|close day|carry-forward|now/i;
  for (const b of blocks.BLOCKS) {
    assert.match(b.terms, boundaryish, `block "${b.id}" terms do not state a boundary`);
  }
});

test("the source block's terms pin BOTH ratios", () => {
  // These two formulas were the actual disagreement; they are now written
  // down where the number is printed.
  const t = blocks.BY_ID.get("source").terms;
  assert.match(t, /ROAS = initial payments \/ spend/);
  assert.match(t, /ROI = \(all money - spend\) \/ spend/);
  // The aged rule is part of the terms: which money is eligible to be a
  // return at all is as load-bearing as the formula applied to it.
  assert.match(t, /ATTRIBUTABLE CALL is primary/);
  assert.match(t, /final 14 calendar days of the prior month/);
  assert.match(t, /one POST DATE status also keeps it/);
  assert.match(t, /a case sold earlier is residual and is Aged/);
});

// ── AGED: money that is real but is not this month's advertising ─────────

const active = require("../../packages/shared-config/src/activeSources");

test("the current month plus the prior month's final fourteen days stays current", () => {
  assert.equal(active.AGED_AFTER_DAYS, 14);
  assert.equal(active.isCaseRecent("2026-07-15", "2026-07-01"), true);
  assert.equal(active.isCaseRecent("2026-06-16", "2026-07-01"), false);
  assert.equal(active.isCaseRecent("2026-06-17", "2026-07-01"), true,
    "June 17 begins the final fourteen days of a 30-day prior month");
  assert.equal(active.isCaseRecent("2026-06-30", "2026-07-31"), true,
    "the boundary is anchored to the calendar month, not the report day");
  assert.equal(active.isCaseRecent("2026-05-01", "2026-07-01"), false);
  assert.equal(active.isCaseRecent("2024-03-02", "2026-07-01"), false);
});

test("one post-date agreement keeps a delayed first payment attributed", () => {
  assert.equal(
    active.sourceBucket("Urgent Third State", {
      firstPaidDateKey: "2026-08-10",
      rangeStart: "2026-08-10",
      rangeEnd: "2026-08-10",
      caseCreatedDate: "2024-01-01",
      attributionCallDate: "2026-07-06",
      hasPostdateStatus: true,
    }),
    "Urgent Third State",
    "a 35-day delayed charge does not erase the call that closed the case",
  );
});

test("one post-date agreement also keeps an old BCD case attributed to BCD", () => {
  assert.equal(
    active.sourceBucket("BCD", {
      firstPaidDateKey: "2026-08-10",
      rangeStart: "2026-08-10",
      rangeEnd: "2026-08-10",
      caseCreatedDate: "2024-01-01",
      attributionCallDate: "2026-07-06",
      hasPostdateStatus: true,
    }),
    "BCD",
    "a real post-date close must not be reported as an aged BCD residual",
  );
});

test("the source report passes post-date evidence through for the actual deal row", () => {
  const rows = blocks.BY_ID.get("source").compute({
    from: "2026-08-10",
    to: "2026-08-10",
    payments: [{
      domain: "TAG", caseId: 35, paymentType: "initial", amount: 900,
      sourceAtSale: "Urgent Third State", caseCreatedDate: "2024-01-01",
      hasPostdateStatus: true, metricsTreatment: { firstPaidDateKey: "2026-08-10" },
      isChargeback: false,
    }],
    spendBySource: {}, callsBySource: {}, callsRange: [],
  });
  assert.equal(rows.find((row) => row.source === "Urgent Third State")?.deals, 1);
  assert.equal(rows.some((row) => row.source === active.AGED_LABEL), false);
});

test("an old post-dated BCD deal never enters the private Aged write queue", () => {
  const rows = blocks.BY_ID.get("source").compute({
    from: "2026-08-10",
    to: "2026-08-10",
    payments: [{
      domain: "TAG", caseId: 36, paymentType: "initial", amount: 900,
      sourceAtSale: "BCD", sourceCampaignId: 64, caseCreatedDate: "2024-01-01",
      hasPostdateStatus: true, metricsTreatment: { firstPaidDateKey: "2026-08-10" },
      isChargeback: false,
    }],
    spendBySource: {}, callsBySource: {}, callsRange: [],
  });
  assert.equal(rows.find((row) => row.source === "BCD")?.deals, 1);
  assert.equal(rows.some((row) => row.source === active.AGED_LABEL), false);
  assert.deepEqual(rows[active.AGED_CASE_REFS], []);
});

test("deal history supplies earliest activity and preserves a single post-date close", () => {
  const history = summarizeDealHistory([
    { CreatedDate: "7/2/2026 9:00:00 AM", ActivityType: "General", Subject: "Case created" },
    {
      CreatedDate: "7/6/2026 11:00:00 AM", ActivityType: "General",
      Subject: 'Status changed from "[Active Prospect]-ACTIVE"  to  "[Active Prospect]-POST DATE"',
    },
    { CreatedDate: "8/9/2026 9:00:00 AM", ActivityType: "General", Subject: "Assigned to Set. Officer : Later Owner" },
  ], "2026-08-10");
  assert.equal(history.earliestActivityDate, "2026-07-02");
  assert.equal(history.hasPostdateStatus, true);
  assert.equal(history.officer, "Later Owner");
});

test("an unknown create date is UNKNOWN, never assumed recent", () => {
  // Assuming recent would quietly credit a live piece with residual money —
  // the exact thing the rule exists to stop.
  assert.equal(active.isCaseRecent(null, "2026-07-01"), null);
  assert.equal(active.isCaseRecent("2026-07-15", null), null);
});

test("a CALL in the window beats an old create date", () => {
  // Mickey 2026-07-28: "attributable call to the source = attributed to the
  // source if its in the month its sold regardless of the create date."
  // Mail leads are bulk-loaded and sit about a week, so the create date is a
  // loading artefact — the call is when the prospect actually responded.
  assert.equal(
    active.sourceBucket("Urgent Third State", {
      attributionCallDate: "2026-07-20", caseCreatedDate: "2024-01-01", rangeStart: "2026-07-01",
    }),
    "Urgent Third State",
  );
});

test("the create date decides only when no call can be found", () => {
  // "create date in month = sold this month if you cant find call evidence
  //  but you should be able to find it"
  assert.equal(
    active.sourceBucket("Urgent Third State", { caseCreatedDate: "2026-07-10", rangeStart: "2026-07-01" }),
    "Urgent Third State",
  );
});

test("BOTH signals old is what makes it aged", () => {
  // "sourced call older than a month, create date older than a month aged"
  assert.equal(
    active.sourceBucket("Urgent Third State", {
      attributionCallDate: "2026-01-05", caseCreatedDate: "2024-01-01", rangeStart: "2026-07-01",
    }),
    active.AGED_LABEL,
  );
  // One recent signal is enough to keep it.
  assert.equal(
    active.sourceBucket("Urgent Third State", {
      attributionCallDate: "2026-01-05", caseCreatedDate: "2026-07-10", rangeStart: "2026-07-01",
    }),
    "Urgent Third State",
  );
});

test("two unknowns are a data gap, not evidence of age", () => {
  // Demoting money because we failed to look would invent a finding.
  assert.equal(
    active.sourceBucket("Urgent Third State", { rangeStart: "2026-07-01" }),
    "Urgent Third State",
  );
});

test("an old case on a LIVE source still goes to Aged", () => {
  // The upsell case: "that one upsell from the guy who was technically a
  // phoneburner aged lead" wears BCD's name but is not BCD's return.
  const d = blocks.BY_ID.get("source").compute({
    from: "2026-07-01",
    payments: [
      { domain: "TAG", caseId: 1, paymentType: "initial", amount: 1850, sourceAtSale: "BCD", caseCreatedDate: "2024-05-01", isChargeback: false },
      { domain: "TAG", caseId: 2, paymentType: "initial", amount: 1000, sourceAtSale: "BCD", caseCreatedDate: "2026-07-10", isChargeback: false },
    ],
    spendBySource: { BCD: { spend: 8, leads: 0 } }, callsBySource: {},
  });
  const aged = d.find((x) => x.source === active.AGED_LABEL);
  const bcd = d.find((x) => x.source === "BCD");
  assert.equal(aged.newCash, 1850, "the 2024 case is aged");
  assert.equal(bcd.newCash, 1000, "the recent case stays with the live source");
});

test("Aged never carries a ratio", () => {
  // A dead list has no advertising to return on; printing one re-creates the
  // 23,125% that started this.
  const d = blocks.BY_ID.get("source").compute({
    from: "2026-07-01",
    payments: [{ domain: "TAG", caseId: 1, paymentType: "initial", amount: 5000, sourceAtSale: "BCD", caseCreatedDate: "2023-01-01", isChargeback: false }],
    spendBySource: { BCD: { spend: 8, leads: 0 } }, callsBySource: {},
  });
  const aged = d.find((x) => x.source === active.AGED_LABEL);
  assert.equal(aged.roas, null);
  assert.equal(aged.roi, null);
  assert.ok(aged.totalCash > 0, "the money is still counted, just not as a return");
});

test("a stopped source with RECENT money keeps its row, minus the ratio", () => {
  // Superseded the earlier "inactive is always aged" rule: a stopped piece
  // still produces in-month responses, and that money counts toward the
  // channel. It just cannot claim a return of its own.
  const d = blocks.BY_ID.get("source").compute({
    from: "2026-07-01",
    payments: [{ domain: "TAG", caseId: 1, paymentType: "initial", amount: 400, sourceAtSale: "Urgent Third Postcard State", caseCreatedDate: "2026-07-20", isChargeback: false }],
    spendBySource: {}, callsBySource: {}, callsRange: [],
  });
  const row = d.find((x) => x.source === "Urgent Third Postcard State");
  assert.ok(row, "the stopped piece keeps its own row");
  assert.equal(row.newCash, 400);
  assert.equal(row.roas, null, "no ratio for a piece that is not running");
  assert.ok(!d.some((x) => x.source === active.AGED_LABEL), "recent money is not aged");
});

test("a stopped source with OLD money is aged", () => {
  const d = blocks.BY_ID.get("source").compute({
    from: "2026-07-01",
    payments: [{ domain: "TAG", caseId: 1, paymentType: "initial", amount: 400, sourceAtSale: "Urgent Third Postcard State", caseCreatedDate: "2023-01-01", isChargeback: false }],
    spendBySource: {}, callsBySource: {}, callsRange: [],
  });
  assert.ok(d.some((x) => x.source === active.AGED_LABEL && x.newCash === 400));
});

test("bucket labels are never treated as live sources", () => {
  for (const n of ["(unsourced)", "ABC (catch-all)", active.AGED_LABEL, ""]) {
    assert.equal(active.isActiveSource(n), false, `"${n}" must not be a live source`);
  }
  assert.equal(active.isActiveSource("Urgent Third State"), true);
});

// ── channel totals: where "did mail work this month" gets answered ───────

test("an inactive piece keeps its money in the CHANNEL total", () => {
  // Mickey 2026-07-28: "a piece thats not active but can still count if its
  // in month to a total mail roi total mail initial roas." Mail lags — a drop
  // stops and responses keep arriving — so the piece earns no ratio of its
  // own, but the spend was real and so is the revenue.
  const d = blocks.BY_ID.get("source").compute({
    from: "2026-07-01",
    payments: [
      { domain: "TAG", caseId: 1, paymentType: "initial", amount: 1000, sourceAtSale: "Urgent Third State", caseCreatedDate: "2026-07-10", isChargeback: false },
      { domain: "TAG", caseId: 2, paymentType: "initial", amount: 500, sourceAtSale: "Urgent Third Postcard State", caseCreatedDate: "2026-07-12", isChargeback: false },
    ],
    spendBySource: { "Urgent Third State": { spend: 1000, leads: 0, channel: "mailer" } },
    callsBySource: {}, callsRange: [],
  });
  const stopped = d.find((x) => x.source === "Urgent Third Postcard State");
  assert.ok(stopped, "the stopped piece keeps its own row");
  assert.equal(stopped.roas, null, "but earns no ratio of its own");

  const mail = d.channels.find((c) => c.channel === "mail");
  assert.equal(mail.newCash, 1500, "BOTH pieces' money counts toward mail");
  assert.equal(mail.roas, 150, "1500 initials / 1000 mail spend");
});

test("AGED money is excluded from the channel total", () => {
  // Aged is not this month's advertising at all, so it cannot flatter the
  // channel either.
  const d = blocks.BY_ID.get("source").compute({
    from: "2026-07-01",
    payments: [
      { domain: "TAG", caseId: 1, paymentType: "initial", amount: 1000, sourceAtSale: "Urgent Third State", caseCreatedDate: "2026-07-10", isChargeback: false },
      { domain: "TAG", caseId: 2, paymentType: "initial", amount: 9000, sourceAtSale: "Urgent Third State", caseCreatedDate: "2023-01-01", isChargeback: false },
    ],
    spendBySource: { "Urgent Third State": { spend: 1000, leads: 0, channel: "mailer" } },
    callsBySource: {}, callsRange: [],
  });
  assert.ok(d.some((x) => x.source === "Aged / inactive source" && x.newCash === 9000));
  const mail = d.channels.find((c) => c.channel === "mail");
  assert.equal(mail.newCash, 1000, "aged money must not inflate the channel");
  assert.equal(mail.roas, 100);
});

test("channels are kept apart — mail spend never answers for LD", () => {
  const d = blocks.BY_ID.get("source").compute({
    from: "2026-07-01",
    payments: [
      { domain: "TAG", caseId: 1, paymentType: "initial", amount: 1000, sourceAtSale: "Urgent Third State", caseCreatedDate: "2026-07-10", isChargeback: false },
      { domain: "TAG", caseId: 2, paymentType: "initial", amount: 100, sourceAtSale: "LD CUSTOM", caseCreatedDate: "2026-07-10", isChargeback: false },
    ],
    spendBySource: {
      "Urgent Third State": { spend: 1000, leads: 0, channel: "mailer" },
      "LD CUSTOM": { spend: 900, leads: 0, channel: "lead-data" },
    },
    callsBySource: {}, callsRange: [],
  });
  const mail = d.channels.find((c) => c.channel === "mail");
  const ld = d.channels.find((c) => c.channel === "ld");
  assert.equal(mail.roas, 100);
  assert.ok(ld.roi < 0, "LD lost money and must say so on its own line");
});

test("the spend sheet's channel beats a guess from the name", () => {
  const active = require("../../packages/shared-config/src/activeSources");
  assert.equal(active.sourceChannel("Something Unrecognised", "mailer"), "mail");
  assert.equal(active.sourceChannel("Something Unrecognised"), "other",
    "an unknown name is NOT quietly folded into mail");
  assert.equal(active.sourceChannel("Urgent Third Postcard State"), "mail", "a known stopped piece is still mail");
});

test("a SERVICE call is not evidence that a case is freshly sourced", () => {
  // CallRail tracks servicing numbers too ("Client Contact - TAG"). An
  // existing client ringing support must not make a years-old case look
  // recent — that would keep residual money attached to a live piece.
  const older = { domain: "TAG", caseId: 1, paymentType: "initial", amount: 5000,
    sourceAtSale: "Urgent Third State", caseCreatedDate: "2023-01-01",
    phone: "4192170047", isChargeback: false, paymentDateKey: "2026-07-20" };

  const serviced = blocks.BY_ID.get("source").compute({
    from: "2026-07-01", payments: [older], spendBySource: {}, callsBySource: {},
    callsRange: [{ phone: "4192170047", dateKey: "2026-07-18", durationSec: 900, source: "Client Contact - TAG" }],
  });
  assert.ok(serviced.some((x) => x.source === active.AGED_LABEL),
    "a support call must not rescue an old case from Aged");

  const marketed = blocks.BY_ID.get("source").compute({
    from: "2026-07-01", payments: [older], spendBySource: {}, callsBySource: {},
    callsRange: [{ phone: "4192170047", dateKey: "2026-07-18", durationSec: 900, source: "Urgent Third State" }],
  });
  assert.ok(marketed.some((x) => x.source === "Urgent Third State"),
    "a call on the MAIL line is a real marketing response and keeps the source");
});

// ── the settled attribution precedence (2026-07-28, both real cases) ─────

test("sold in an EARLIER month is residual, however fresh the calls", () => {
  // The gate: first payment outside the window means this is last month's
  // business arriving late.
  assert.equal(
    active.sourceBucket("Urgent Third State", {
      firstPaidDateKey: "2026-06-15", attributionCallDate: "2026-07-20",
      rangeStart: "2026-07-01", rangeEnd: "2026-07-28",
    }),
    active.AGED_LABEL,
  );
});

test("case 368274: an attributable CALL beats an old lead", () => {
  // Real case. Bulk-loaded 2026-05-29, called the Urgent Third State mail
  // line for 27 minutes on 2026-07-08, sold the same day. Mickey: "lead age
  // is secondary to attributable call."
  assert.equal(
    active.sourceBucket("Urgent Third State", {
      firstPaidDateKey: "2026-07-08", caseCreatedDate: "2026-05-29",
      attributionCallDate: "2026-07-08",
      rangeStart: "2026-07-01", rangeEnd: "2026-07-28",
    }),
    "Urgent Third State",
  );
});

test("case 275341: an aged lead with NO call is Aged, even sold in-month", () => {
  // Real case. Created 2026-01-21 as a BCD aged lead, ZERO calls in the
  // window, first paid 2026-07-17 with a $5,000 follow-on. Real revenue —
  // but not a return on this month's advertising, so BCD gets no credit.
  assert.equal(
    active.sourceBucket("BCD", {
      firstPaidDateKey: "2026-07-17", caseCreatedDate: "2026-01-21",
      rangeStart: "2026-07-01", rangeEnd: "2026-07-28",
    }),
    active.AGED_LABEL,
  );
});

test("the Aged row carries private case references for the nightly Logics writer", () => {
  const rows = blocks.BY_ID.get("source").compute({
    from: "2026-07-01",
    to: "2026-07-31",
    payments: [{
      domain: "TAG",
      caseId: 275341,
      paymentType: "initial",
      amount: 5000,
      sourceAtSale: "BCD",
      sourceCampaignId: 64,
      caseCreatedDate: "2026-01-21",
      metricsTreatment: { firstPaidDateKey: "2026-07-17" },
      isChargeback: false,
    }],
    spendBySource: {},
    callsBySource: {},
    callsRange: [],
  });
  const refs = rows[active.AGED_CASE_REFS];
  assert.deepEqual(refs, [{
    domain: "TAG", caseId: 275341, expectedSource: "BCD", expectedSourceId: 64,
  }]);
  assert.equal(Object.keys(rows).includes(String(active.AGED_CASE_REFS)), false);
  assert.doesNotMatch(JSON.stringify(rows), /275341/, "private write evidence must not enter report JSON");
});

test("a fresh lead sold in-month needs no call to count", () => {
  assert.equal(
    active.sourceBucket("Urgent Third State", {
      firstPaidDateKey: "2026-07-10", caseCreatedDate: "2026-07-09",
      rangeStart: "2026-07-01", rangeEnd: "2026-07-28",
    }),
    "Urgent Third State",
  );
});

test("the follow-on payment rides with its sale", () => {
  // "the initial and second payment happen in the same month thats the valid
  // total" — both rows carry the same firstPaidDateKey, so both land together.
  const d = blocks.BY_ID.get("source").compute({
    from: "2026-07-01", to: "2026-07-28",
    payments: [
      { domain: "TAG", caseId: 1, paymentType: "initial", amount: 1000, sourceAtSale: "Urgent Third State",
        caseCreatedDate: "2026-07-02", metricsTreatment: { firstPaidDateKey: "2026-07-05" }, isChargeback: false },
      { domain: "TAG", caseId: 1, paymentType: "recurring", amount: 500, sourceAtSale: "Urgent Third State",
        caseCreatedDate: "2026-07-02", metricsTreatment: { firstPaidDateKey: "2026-07-05" }, isChargeback: false },
    ],
    spendBySource: { "Urgent Third State": { spend: 1000, leads: 0, channel: "mailer" } },
    callsBySource: {}, callsRange: [],
  });
  const r = d.find((x) => x.source === "Urgent Third State");
  assert.equal(r.newCash, 1000);
  assert.equal(r.totalCash, 1500, "the second payment belongs to the same month's total");
  assert.equal(r.roas, 100);
  assert.equal(r.roi, 50);
});

// ── P/L over time, and one implementation of every ratio ─────────────────

test("P/L buckets by DAY for a short range and by MONTH for a long one", () => {
  // A daily table across a quarter is noise; the shape people want is monthly.
  const pl = blocks.BY_ID.get("pl");
  const payments = [
    { domain: "TAG", caseId: 1, paymentType: "initial", amount: 100, paymentDateKey: "2026-07-05", isChargeback: false },
    { domain: "TAG", caseId: 2, paymentType: "recurring", amount: 50, paymentDateKey: "2026-08-05", isChargeback: false },
  ];
  const daily = pl.compute({ payments, spendByDay: {}, from: "2026-07-01", to: "2026-07-28" });
  assert.ok(daily.every((r) => r.period.length === 10), "days for a month");

  const monthly = pl.compute({ payments, spendByDay: {}, from: "2026-01-01", to: "2026-08-31" });
  assert.ok(monthly.every((r) => r.period.length === 7), "months for a long range");
  assert.deepEqual(monthly.map((r) => r.period), ["2026-07", "2026-08"]);
});

test("P/L pairs cost and money in the SAME period", () => {
  const d = blocks.BY_ID.get("pl").compute({
    payments: [
      { domain: "TAG", caseId: 1, paymentType: "initial", amount: 1000, paymentDateKey: "2026-07-05", isChargeback: false },
      { domain: "TAG", caseId: 1, paymentType: "recurring", amount: 500, paymentDateKey: "2026-07-05", isChargeback: false },
    ],
    spendByDay: { "2026-07-05": { spend: 500 }, "2026-07-06": { spend: 200 } },
    from: "2026-07-01", to: "2026-07-28",
  });
  const day5 = d.find((r) => r.period === "2026-07-05");
  assert.equal(day5.cost, 500);
  assert.equal(day5.initial, 1000);
  assert.equal(day5.total, 1500);
  assert.equal(day5.net, 1000);
  assert.equal(day5.roi, 200, "(1500 - 500) / 500");
  assert.equal(day5.profitMargin, 700, "1500 x 0.8 - 500");

  // A day with spend and no money is a real loss, not an omission.
  const day6 = d.find((r) => r.period === "2026-07-06");
  assert.equal(day6.net, -200);
  assert.equal(day6.roi, -100);
});

test("the three named reports resolve", () => {
  for (const [preset, expected] of [
    ["roi-by-source", ["source"]],
    ["officer-performance", ["officer", "worked"]],
    ["profit-loss", ["pl", "money", "spend"]],
  ]) {
    const r = blocks.resolveSelection([preset]);
    assert.deepEqual(r.blocks.map((b) => b.id), expected, preset);
    assert.deepEqual(r.unknown, []);
  }
});

test("every ratio comes from ONE implementation", () => {
  // ROI meaning two different things is what started all of this. No block
  // may compute a ratio privately; they all call applyFunctions.
  const fs = require("fs");
  const src = fs.readFileSync(
    require.resolve("../../packages/shared-services/src/reportBlocksService"), "utf8",
  );
  for (const forbidden of ["/ r.spend) * 1000", "/ t.spend) * 1000"]) {
    assert.ok(!src.includes(forbidden),
      `a ratio is being computed inline (${forbidden}) instead of via applyFunctions`);
  }
  assert.ok(src.includes("applyFunctions"), "blocks must use the shared function registry");
});

test("an officer filter cuts the QUEUE, not just the payments", () => {
  // A report headed "officer=Bruce" that showed Bruce's three deals beside
  // every other officer's call counts. The slice looked applied and was not.
  const { filterQueueByAgent, parseFilters } = require("../../packages/shared-services/src/reportComposerService");
  const queue = {
    "Bruce Allen": { MAILER: 25, LD: 26 },
    "Phil Olson": { MAILER: 27, LD: 79 },
    "Chris Bolt": { MAILER: 1, LD: 528 },
  };
  const cut = filterQueueByAgent(queue, parseFilters(["officer=Bruce"]).filters);
  assert.deepEqual(Object.keys(cut), ["Bruce Allen"]);

  // No officer filter must leave the queue untouched.
  assert.deepEqual(filterQueueByAgent(queue, parseFilters(["source=LD"]).filters), queue);
  assert.deepEqual(filterQueueByAgent(queue, []), queue);
});

// ── casework and long calls ──────────────────────────────────────────────

test("casework lists CASES, not counts, and keeps the lanes apart", () => {
  // "post dates dncs failed payments as a list of cases ... a heres what
  // happened with the cases today report."
  const d = blocks.BY_ID.get("casework").compute({
    events: [
      { domain: "TAG", caseId: 1, kind: "status-change", createdBy: "Phil Olson", createdAt: "2026-07-28T10:00:00Z",
        payload: { safetyClass: "postdate", toStatus: "[Active Prospect]-POST DATE" } },
      { domain: "WYNN", caseId: 2, kind: "status-change", createdBy: "Sean Lucas", createdAt: "2026-07-28T11:00:00Z",
        payload: { safetyClass: "dnc", toStatus: "[Bad/Inactive]-DO NOT CALL" } },
      { domain: "TAG", caseId: 3, kind: "doc-upload", createdAt: "2026-07-28T12:00:00Z", payload: null },
      { domain: "TAG", caseId: 3, kind: "doc-upload", createdAt: "2026-07-28T12:05:00Z", payload: null },
      // a case re-saved on the same status is NOT news
      { domain: "TAG", caseId: 9, kind: "status-change", payload: { safetyClass: "dnc", selfTransition: true } },
    ],
    declines: [{ domain: "AMITY", caseId: 4, amount: 250, paymentDateKey: "2026-07-28", name: "A Client" }],
  });
  assert.equal(d.postdate.length, 1);
  assert.equal(d.postdate[0].by, "Phil Olson");
  assert.equal(d.dnc.length, 1, "a self-transition must not appear");
  assert.equal(d.docs[0].count, 2, "two uploads on one case is one row, count 2");
  assert.equal(d.failed[0].amount, 250, "a bounced card is case news even with no status change");
});

test("long calls are scoped to the RANGE, not the 45-day lookback", () => {
  // callsRange reaches back 45 days so lag is not clipped. Measured live: a
  // one-day report listed 319 calls back to 2026-06-15 before this guard.
  const block = blocks.BY_ID.get("longcalls");
  const rows = block.compute({
    from: "2026-07-28", to: "2026-07-28", payments: [],
    callsRange: [
      { dateKey: "2026-07-28", durationSec: 4056, source: "3rd Day (Pink) Urgent Third State", phone: "4192170047" },
      { dateKey: "2026-06-15", durationSec: 3288, source: "Affordability Federal", phone: "5551112222" },
      { dateKey: "2026-07-28", durationSec: 120, source: "Urgent Third State", phone: "5553334444" },
    ],
  });
  assert.equal(rows.length, 1, "only the in-range call over the threshold");
  assert.equal(rows[0].minutes, 67.6);
});

test("a long call with no sale says so rather than being dropped", () => {
  // The whole point of the list is the long conversations that have NOT
  // closed — dropping them would leave only the good news.
  const rows = blocks.BY_ID.get("longcalls").compute({
    from: "2026-07-28", to: "2026-07-28",
    callsRange: [{ dateKey: "2026-07-28", durationSec: 1200, source: "Urgent Third State", phone: "4192170047" }],
    payments: [],
  });
  assert.equal(rows[0].outcome, "no outcome yet");
  assert.equal(rows[0].amount, null);
});

test("an initial payment outranks a recurring one as the outcome", () => {
  const rows = blocks.BY_ID.get("longcalls").compute({
    from: "2026-07-28", to: "2026-07-28",
    callsRange: [{ dateKey: "2026-07-28", durationSec: 1200, source: "Urgent Third State", phone: "4192170047" }],
    payments: [
      { domain: "TAG", caseId: 1, paymentType: "recurring", amount: 100, phone: "4192170047", isChargeback: false },
      { domain: "TAG", caseId: 1, paymentType: "initial", amount: 3000, phone: "4192170047", isChargeback: false },
    ],
  });
  assert.equal(rows[0].outcome, "DEAL", "became a deal beats paid something");
  assert.equal(rows[0].amount, 3000);
});
