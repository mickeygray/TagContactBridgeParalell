"use strict";

// A block that declares a source gatherMaterial does not gather renders an
// empty table and looks like a fact. That shipped three times, so the
// contract is enforced here as well as at module load.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const blocks = require("../../packages/shared-services/src/reportBlocksService");

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
  assert.deepEqual(worked().needs, ["queue", "payments"]);
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
