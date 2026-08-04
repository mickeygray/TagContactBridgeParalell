"use strict";

// SPEND PER AGENT — what the calls a person took actually cost.
//
// Mickey 2026-08-03: "derive a spend per agent basically how many calls they
// took of mail, BCD and LD sorta blended together you can sorta get rid of
// connected and talk minutes and do like attributed spend." Then the method:
// "read mailer queue divide by spend multiply total agent calls by that avg
// cost / same with bcd queue by agent / for LD you need to sorta track new lead
// case ids and see who called them and attribute that way."
//
// Two properties carry the whole feature, and both are pinned here.
//
// IT RECONCILES. Agents plus what nobody can be charged with must add back to
// the spend it was divided out of. A per-agent cost that does not reconcile is
// a number people argue with instead of acting on — and the earlier attempts
// were off by an order of magnitude, not a rounding: distinct-cases-DIALLED
// summed to $4,005 on a day that cost $318, and crediting every toucher of a
// new lead summed to 52 leads against 32 real ones.
//
// A ZERO AND AN UNKNOWN ARE DIFFERENT NUMBERS. "$0.00" says the agent worked
// nothing we paid for. A component we could not read has to look different, or
// a RingCentral outage prints as a floor that did no marketing work — which
// reads as a fact about people rather than about a vendor.
//
// Every assertion below is on RETURNED DATA. Grepping the source for a formula
// proves the formula is written down, not that it is the one being applied.

const test = require("node:test");
const assert = require("node:assert/strict");

const blocks = require("../../packages/shared-services/src/reportBlocksService");

const ldcalls = () => blocks.BY_ID.get("ldcalls");
const compute = (m) => ldcalls().compute(m);
const emailCell = (data, header, row) => {
  const table = ldcalls().csv(data);
  const col = table.emailColumns.find((c) => c.header === header);
  assert.ok(col, `no email column "${header}"`);
  return col.get(row || table.rows[0]);
};
// new_ld is WITHHELD from the email while lead distribution is fixed (see
// NEW_LD_EMAIL_HIDDEN in reportBlocksService). It stays in the CSV so the fix
// remains measurable, so its assertions read the CSV rather than being dropped.
const csvCellOf = (data, header, row) => {
  const table = ldcalls().csv(data);
  const col = table.columns.find((c) => c.header === header);
  assert.ok(col, `no CSV column "${header}"`);
  return col.get(row || table.rows[0]);
};
const agent = (data, name) => data.agents.find((a) => a.agent === name);

// ── fixtures ──────────────────────────────────────────────────────────────
//
// Real spellings on purpose: the dial side arrives from PhoneBurner as
// "chris_bolt" and the queue side as "Chris Bolt", and one row per person only
// happens because canonicalStaffName folds them.

const dialDoc = (caseId, leadAgeDays, attempts) => ({
  domain: "tag", caseId: String(caseId), dateKey: "2026-07-31",
  leadAgeDays,
  attempts: attempts.map((a, i) => ({
    attemptKey: `${caseId}-${i}`, provider: "phoneburner", providerCallId: `${caseId}-${i}`,
    outcome: "no-answer", originPool: "ld", dailyAttemptCount: i + 1, totalAttemptCount: i + 1,
    connected: false, durationSeconds: 20,
    ...a,
  })),
});

const at = (hhmm) => `2026-07-31T${hhmm}:00.000Z`;

// One day, three channels, and numbers chosen so every component is checkable
// by hand: mail $200 over 40 offered calls = $5.00; BCD $40 over 10 = $4.00;
// LD 30 leads x $3 = $90.
const SPEND = {
  mail: 200, bcd: 40, ld: 90, ldLeads: 30, ldRate: 3, bcdRate: 4, bcdCalls: 10,
  mailPieces: 0, ldUnavailable: null, total: 330,
};

const QUEUE_STREAMS = {
  MAILER: { calls: 40, connected: 32, missed: 8 },
  BCD: { calls: 10, connected: 8, missed: 2 },
};

const QUEUE_BY_AGENT = {
  "Chris Bolt": { MAILER: 20, BCD: 5, LD: 528 },
  "Phil Olson": { MAILER: 12, BCD: 3, LD: 79 },
};

// 30 new leads, so the LD component can attribute in full: cases 1..3 are
// contested (more than one agent dialled them), the rest are single-touch.
const NEW_LEAD_DIALS = [
  // contested — chris ends first, so chris owns it
  dialDoc(1, 0, [
    { agentId: "phil_olson", callEndedAt: at("18:00") },
    { agentId: "chris_bolt", callEndedAt: at("09:00") },
    { agentId: "brad_hansen", callEndedAt: at("12:00") },
  ]),
  // contested — phil ends first
  dialDoc(2, 0, [
    { agentId: "chris_bolt", callEndedAt: at("15:30") },
    { agentId: "phil_olson", callEndedAt: at("15:00") },
  ]),
  // contested — brad ends first
  dialDoc(3, 0, [
    { agentId: "chris_bolt", callEndedAt: at("17:00") },
    { agentId: "brad_hansen", callEndedAt: at("08:15") },
  ]),
  ...Array.from({ length: 9 }, (_, i) => dialDoc(100 + i, 0, [{ agentId: "chris_bolt", callEndedAt: at("10:00") }])),
  ...Array.from({ length: 8 }, (_, i) => dialDoc(200 + i, 0, [{ agentId: "phil_olson", callEndedAt: at("11:00") }])),
  // aged inventory — dialled hard, bought long ago, so it carries no LD cost
  ...Array.from({ length: 20 }, (_, i) => dialDoc(300 + i, 6, [{ agentId: "chris_bolt", callEndedAt: at("13:00") }])),
];

const material = (over = {}) => ({
  dials: NEW_LEAD_DIALS,
  queueByAgent: QUEUE_BY_AGENT,
  queueStreams: QUEUE_STREAMS,
  spend: SPEND,
  payments: [],
  domain: null,
  dialsUnavailable: null, queueUnavailable: null,
  ...over,
});

// ── 1. it reconciles ──────────────────────────────────────────────────────

test("agents plus unattributed equals the spend, to the cent", () => {
  const d = compute(material());
  const r = d.attribution.reconciliation;

  assert.equal(r.expected, 330, "mail 200 + BCD 40 + LD 90");
  assert.equal(r.ok, true, `did not reconcile: ${JSON.stringify(r)}`);
  assert.equal(r.drift, 0);
  assert.equal(Math.round((r.attributed + r.unattributed) * 100) / 100, r.expected);

  // And per component, because a total can reconcile while two halves are
  // wrong in opposite directions.
  const sum = (k) => Math.round(d.agents.reduce((s, a) => s + (a[k] || 0), 0) * 100) / 100;
  assert.equal(sum("attributedMail") + d.attribution.unattributed.mail, 200);
  assert.equal(sum("attributedBcd") + d.attribution.unattributed.bcd, 40);
  assert.equal(sum("attributedLd") + d.attribution.unattributed.ld, 90);

  // The per-agent number is the sum of its own three parts and nothing else.
  for (const a of d.agents) {
    assert.equal(
      a.attributedSpend,
      Math.round((a.attributedMail + a.attributedBcd + a.attributedLd) * 100) / 100,
      `${a.agent} components do not sum to the total shown`,
    );
  }
});

test("the rates are the ones the operator asked for", () => {
  const d = compute(material());
  assert.equal(d.attribution.mailRate, 5, "$200 of mail over 40 calls offered");
  assert.equal(d.attribution.bcdRate, 4, "BCD lands on the $4 pay-per-call it is bought at");
  assert.equal(d.attribution.ldRate, 3);

  const chris = agent(d, "Chris Bolt");
  assert.equal(chris.attributedMail, 100, "20 mail calls x $5.00");
  assert.equal(chris.attributedBcd, 20, "5 BCD calls x $4.00");
  assert.equal(chris.attributedLd, 30, "10 new leads first-touched x $3.00");
  assert.equal(chris.attributedSpend, 150);
});

// ── 2. first toucher wins, exclusively ────────────────────────────────────

test("a lead worked by three agents is charged to exactly ONE", () => {
  const d = compute(material({
    dials: [dialDoc(1, 0, [
      { agentId: "phil_olson", callEndedAt: at("18:00") },
      { agentId: "chris_bolt", callEndedAt: at("09:00") },
      { agentId: "brad_hansen", callEndedAt: at("12:00") },
    ])],
  }));
  const credited = d.agents.filter((a) => a.newLeads > 0);
  assert.equal(credited.length, 1, `three agents dialled it, ${credited.length} were charged`);
  assert.equal(credited[0].agent, "Chris Bolt", "earliest callEndedAt, not last and not the pool");
  assert.equal(credited[0].newLeads, 1);
  assert.equal(d.newLeadsTouched, 1);
  // The other two dialled it and are on the board — they just did not buy it.
  assert.equal(agent(d, "Phil Olson").newLeads, 0);
  assert.equal(agent(d, "Phil Olson").attributedLd, 0);
});

test("first-touched leads can never exceed the leads we bought", () => {
  const d = compute(material());
  assert.ok(d.newLeadsTouched <= SPEND.ldLeads,
    `${d.newLeadsTouched} first-touched against ${SPEND.ldLeads} received`);
  assert.equal(d.newInventory, 20, "20 dial docs carried leadAgeDays 0");
  assert.equal(d.newLeadsTouched, 20, "every one of them had somebody on it");
  // 10 leads were bought and never dialled — that money is real and belongs to
  // nobody, which is exactly what the unattributed line is for.
  assert.equal(d.attribution.unattributed.ld, 30, "(30 bought - 20 touched) x $3");
});

test("touching more leads than we bought is CLAMPED and said out loud", () => {
  // The failure this guards: a lead-count source that undercounts (or a dial
  // range wider than the spend range) would otherwise credit agents with money
  // we never spent, and the column would still look like a column.
  const d = compute(material({ spend: { ...SPEND, ldLeads: 5, ld: 15, total: 255 } }));
  const r = d.attribution.reconciliation;
  assert.equal(r.ok, false, "the invariant is violated and must say so");
  assert.ok(r.failures.some((f) => /LD/.test(f)), `no failure names LD: ${JSON.stringify(r.failures)}`);
  assert.equal(d.attribution.unattributed.ld, 0, "clamped — never negative money");
});

test("a lead nobody dialled belongs to nobody, not to the pool", () => {
  const d = compute(material({
    dials: [dialDoc(9, 0, [{ agentId: null, callEndedAt: at("10:00") }])],
    spend: { ...SPEND, ldLeads: 1, ld: 3, total: 243 },
  }));
  assert.equal(d.newInventory, 1);
  assert.equal(d.newInventoryUntouched, 1);
  assert.equal(d.newLeadsTouched, 0);
  assert.equal(d.attribution.unattributed.ld, 3);
});

// ── 3. an unreadable lead age is not a zero ───────────────────────────────

test("leadAgeDays missing from the rows makes the LD component NULL, never 0", () => {
  // The real failure mode: leadAgeDays left out of the composer's .select(),
  // so every row reads `undefined`, no lead looks new, and the LD column prints
  // $0.00 for the whole floor — a zero that means "we did not read it".
  const stripped = NEW_LEAD_DIALS.map(({ leadAgeDays, ...rest }) => rest);
  const d = compute(material({ dials: stripped }));

  assert.equal(d.newLeadsKnown, false);
  assert.equal(d.attribution.readable.ld, false);
  for (const a of d.agents) {
    assert.equal(a.attributedLd, null, `${a.agent} priced out at $${a.attributedLd} of unknown LD cost`);
    assert.equal(a.attributedSpend, null, "one unknown component blanks the total");
  }
  assert.equal(d.attribution.reconciliation.ok, null,
    "not tested is not the same claim as failed");
  // Mail and BCD were readable throughout and are NOT blanked by the LD gap.
  assert.equal(agent(d, "Chris Bolt").attributedMail, 100);
  assert.equal(csvCellOf(d, "new_ld", agent(d, "Chris Bolt")), null, "unknown is null in the CSV, never 0");
  assert.equal(emailCell(d, "attributed_spend", agent(d, "Chris Bolt")), "—");
});

test("a NULL lead age is not day zero", () => {
  // Number(null) is 0. A plain `Number(x) === 0` test would read every null as
  // brand-new inventory and charge the whole LD bill to whoever dialled it.
  const d = compute(material({
    dials: [
      dialDoc(1, null, [{ agentId: "chris_bolt", callEndedAt: at("09:00") }]),
      dialDoc(2, 4, [{ agentId: "chris_bolt", callEndedAt: at("09:30") }]),
    ],
  }));
  assert.equal(d.newInventory, 0, "neither row is new inventory");
  assert.equal(agent(d, "Chris Bolt").newLeads, 0);
  assert.equal(agent(d, "Chris Bolt").attributedLd, 0,
    "a real zero: he worked no new leads, and the age WAS readable on row 2");
});

// ── 4. an unreadable source dashes, it does not price ─────────────────────

test("an unreadable queue leaves mail and BCD null and dashes the total", () => {
  const d = compute(material({ queueUnavailable: "429 from RingCentral" }));
  for (const a of d.agents) {
    assert.equal(a.attributedMail, null);
    assert.equal(a.attributedBcd, null);
    assert.equal(a.attributedSpend, null);
  }
  assert.equal(d.attribution.readable.mail, false);
  assert.equal(d.attribution.reconciliation.ok, null);
  assert.equal(emailCell(d, "attributed_spend"), "—");
  // The LD half still works and is not thrown away with it.
  assert.equal(agent(d, "Chris Bolt").attributedLd, 30);
});

test("an unreadable dial gather leaves LD null and dashes the total", () => {
  const d = compute(material({ dials: [], dialsUnavailable: "ECONNREFUSED" }));
  for (const a of d.agents) {
    assert.equal(a.attributedLd, null, "no dials means no first toucher can be known");
    assert.equal(a.attributedSpend, null);
  }
  assert.equal(emailCell(d, "attributed_spend"), "—");
  assert.equal(csvCellOf(d, "new_ld"), null, "unknown is null in the CSV, never 0");
});

test("spend that was never gathered blanks every component", () => {
  // The block declares "spend" in `needs`, but a caller can still compute() it
  // without — and an ungathered cost must not price out as a free day.
  const d = compute(material({ spend: {} }));
  for (const a of d.agents) {
    assert.equal(a.attributedSpend, null);
    assert.equal(a.attributedLd, null);
  }
  assert.equal(d.attribution.reconciliation.ok, null);
});

// ── 5. OFFERED, not connected ─────────────────────────────────────────────

test("the mail rate divides by calls OFFERED, not calls connected", () => {
  // The mail bought every call that RANG. Pricing off connects divides the same
  // dollars over a smaller denominator and overstates every agent's cost — and
  // the overstatement grows with the miss rate, so it is worst on the days
  // somebody would most want to look at it.
  const d = compute(material({
    spend: { ...SPEND, mail: 215, bcd: 0, ld: 0, ldLeads: 0, total: 215 },
    queueStreams: { MAILER: { calls: 43, connected: 40, missed: 3 } },
    queueByAgent: { "Chris Bolt": { MAILER: 40 } },
  }));
  assert.equal(d.attribution.mailOffered, 43);
  assert.equal(d.attribution.mailRate, 5, "$215 / 43 offered — not $215 / 40 connected ($5.375)");
  assert.equal(agent(d, "Chris Bolt").attributedMail, 200, "40 answered x $5.00");
  assert.equal(d.attribution.unattributed.mail, 15, "3 calls rang out — $15 nobody can be charged");
  // And that residual is the same money the missed-call arithmetic names.
  assert.equal(d.attribution.unattributedByMissed.mail, 15);
});

test("calls the queue offered but no agent answered stay unattributed", () => {
  const d = compute(material());
  // MAILER: 40 offered, 32 credited to agents (20 + 12), 8 missed.
  assert.equal(d.attribution.mailMissed, 8);
  assert.equal(d.attribution.unattributed.mail, 40, "8 missed x $5.00");
  assert.equal(d.attribution.unattributed.bcd, 8, "2 missed x $4.00");
});

// ── 6. a vendor board has no mail, and no mail is not $0.00 ───────────────

test("a non-mail tenant shows mail and BCD as NULL, never $0.00", () => {
  // THE TENANT RULE zeroes queueByAgent and mail/BCD spend for a vendor board —
  // there is one CallRail account and one RingCentral queue and they are TAG's.
  // Printing "$0.00 of mail" on a WYNN board states a fact about WYNN's agents
  // that we did not measure; the honest rendering is "does not apply".
  const d = compute(material({
    domain: "WYNN",
    queueByAgent: {}, queueStreams: {},
    spend: { ...SPEND, mail: 0, bcd: 0, total: 90 },
  }));
  assert.equal(d.attribution.mailApplies, false);
  for (const a of d.agents) {
    assert.equal(a.attributedMail, null, "not $0.00");
    assert.equal(a.attributedBcd, null, "not $0.00");
  }
  // But the LD board still adds up — a component that does not APPLY is not a
  // hole in the total the way an outage is, or a vendor board would show a
  // column of dashes and be useless.
  const chris = agent(d, "Chris Bolt");
  assert.equal(chris.attributedLd, 30);
  assert.equal(chris.attributedSpend, 30, "LD only, and it is a number");
  const r = d.attribution.reconciliation;
  assert.equal(r.expected, 90, "the total is rebuilt from what applies");
  assert.equal(r.ok, true);
  assert.equal(Math.round((r.attributed + r.unattributed) * 100) / 100, 90);
});

test("a mail-tenant board with a genuinely quiet queue does show $0.00", () => {
  // The other side of the same rule: TAG with no mail calls offered is a real
  // zero, and must not borrow the dash that means "unknown".
  const d = compute(material({
    domain: "TAG",
    queueByAgent: { "Chris Bolt": { LD: 5 } },
    queueStreams: {},
    spend: { ...SPEND, mail: 0, bcd: 0, total: 90 },
  }));
  const chris = agent(d, "Chris Bolt");
  assert.equal(chris.attributedMail, 0, "he took no mail calls — that is an answer");
  assert.equal(chris.attributedBcd, 0);
  assert.equal(typeof chris.attributedSpend, "number");
});

// ── the column contract the email actually renders ────────────────────────

test("the email carries the cost and the CSV carries the working", () => {
  const d = compute(material());
  const table = ldcalls().csv(d);
  assert.deepEqual(
    table.emailColumns.map((c) => c.header),
    ["agent", "inbound", "dials", "attributed_spend", "deals", "cash"],
  );
  for (const h of ["connected", "talk_minutes", "new_ld", "attributed_mail", "attributed_bcd", "attributed_ld"]) {
    assert.ok(table.columns.some((c) => c.header === h), `the CSV must keep ${h}`);
  }
  // Every column has to survive a real row. A getter that throws is caught by
  // renderCsvs and the whole attachment is silently skipped.
  for (const col of table.columns) {
    for (const r of table.rows) assert.doesNotThrow(() => col.get(r), `csv column ${col.header}`);
  }
  for (const col of table.emailColumns) {
    for (const r of table.emailRows) assert.doesNotThrow(() => col.get(r), `email column ${col.header}`);
  }
  // "attributed_spend" matches the money-formatting regex in toTemplateData, so
  // it renders as dollars without a special case. Pinned because renaming the
  // header to something like "agent_cost" would silently print 150 next to
  // $700.00 in the same row.
  assert.match("attributed_spend", /(cash|amount|spend|collected|revenue|cost|net|margin|profit)/i);
});

test("inbound still equals the two streams it was split into", () => {
  // The split is what lets mail and BCD be priced apart; `inbound` staying
  // their sum is what keeps the column already on the board unchanged.
  const d = compute(material());
  for (const a of d.agents) {
    assert.equal(a.inbound, a.mailerIn + a.bcdIn, `${a.agent} inbound drifted from its parts`);
  }
  assert.equal(agent(d, "Chris Bolt").mailerIn, 20);
  assert.equal(agent(d, "Chris Bolt").bcdIn, 5);
  assert.equal(agent(d, "Chris Bolt").inbound, 25);
});
