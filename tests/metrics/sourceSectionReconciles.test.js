"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const blocks = require("../../packages/shared-services/src/reportBlocksService");

// 2026-07-31, caught by Mickey reading the rendered email: "theres actually a
// wynn deal today." The top line said "$4,836 in · 1 deal" and every row of the
// By source table said zero — because the day's money sat on Aged and the
// catch-alls, and those rows had been filtered out of the mail to keep the
// table about active pieces.
//
// Keeping the table clean was right. Letting a filter swallow $4,836 and a real
// deal was not. The buckets now collapse into one residual line, so the section
// still reconciles to the top line.

const payment = (over = {}) => ({
  domain: "WYNN", caseId: 1, paymentType: "initial", amount: 100,
  isChargeback: false, sourceAtSale: "Urgent Third State", ...over,
});

const material = (payments) => ({
  payments,
  spend: { total: 0, mail: 0, ld: 0, mailPieces: 0, ldLeads: 0 },
  spendBySource: {},
  callsBySource: {},
  caseContacts: {},
  dials: [],
  ldLeads: null,
});

const sourceRows = (m) => {
  const block = blocks.BY_ID.get("source");
  const rows = block.compute(m);
  return { rows, csv: block.csv(rows) };
};

test("money on an unattributed bucket still appears, as a residual line", () => {
  const m = material([
    payment({ caseId: 10, amount: 700, sourceAtSale: null }),
    payment({ caseId: 11, amount: 250, sourceAtSale: "Urgent Third State" }),
  ]);
  const { csv } = sourceRows(m);
  const labels = csv.emailRows.map((r) => String(r.source));
  assert.ok(labels.some((l) => /Not attributed/i.test(l)),
    "a bucket row must collapse into a residual, never vanish");
});

test("the emailed section reconciles to the same cash the top line reports", () => {
  const payments = [
    payment({ caseId: 10, amount: 700, sourceAtSale: null }),
    payment({ caseId: 11, amount: 250, sourceAtSale: "Urgent Third State" }),
    payment({ caseId: 12, amount: 1200, paymentType: "recurring", sourceAtSale: null }),
  ];
  const m = material(payments);
  const { csv } = sourceRows(m);
  const shown = csv.emailRows.reduce((s, r) => s + (Number(r.totalCash) || 0), 0);
  const top = blocks.BY_ID.get("topline").compute({ ...m, domain: null });
  assert.equal(Math.round(shown), Math.round(top.cash),
    "the rows a reader can see must add up to the headline above them");
});

test("a deal on an unattributed bucket is still counted in the section", () => {
  const m = material([payment({ caseId: 10, amount: 700, sourceAtSale: null })]);
  const { csv } = sourceRows(m);
  const deals = csv.emailRows.reduce((s, r) => s + (Number(r.deals) || 0), 0);
  const top = blocks.BY_ID.get("topline").compute({ ...m, domain: null });
  assert.equal(deals, top.deals);
  assert.equal(deals, 1);
});

test("the residual carries no ratio — there is no campaign behind it to measure", () => {
  const m = material([payment({ caseId: 10, amount: 700, sourceAtSale: null })]);
  const residual = sourceRows(m).csv.emailRows.find((r) => r.residual);
  assert.ok(residual, "residual row expected");
  assert.equal(residual.roi, null);
  assert.equal(residual.roas, null);
  assert.equal(residual.costPer, null);
});

test("with nothing unattributed there is no residual line at all", () => {
  // The table must not grow a permanent empty row on a clean day.
  const m = material([payment({ caseId: 11, amount: 250, sourceAtSale: "Urgent Third State" })]);
  const { csv } = sourceRows(m);
  assert.equal(csv.emailRows.some((r) => r.residual), false);
});

test("the full row set still reaches the CSV, unmerged", () => {
  const m = material([
    payment({ caseId: 10, amount: 700, sourceAtSale: null }),
    payment({ caseId: 11, amount: 250, sourceAtSale: "Urgent Third State" }),
  ]);
  const { rows, csv } = sourceRows(m);
  assert.equal(csv.rows.length, rows.length,
    "reconciliation happens in the CSV, so it keeps every bucket separately");
  assert.ok(csv.rows.length >= csv.emailRows.length);
});

// 2026-07-31, Mickey: "what they wanna see is roas anyway roi is a month based
// thing. so initial payments and spend for that percentage on the daily
// email." The emailed table shipped ROI, which on any single day compares
// RECURRING cash from cases sold months ago against TODAY's spend — a ratio
// that swings on when the recurring batch lands and says nothing about the
// piece. ROI stays in the CSV, where a month-long range makes it mean
// something.

test("the emailed ratio is ROAS — initials over spend, not ROI", () => {
  const m = material([payment({ caseId: 11, amount: 250, sourceAtSale: "Urgent Third State" })]);
  m.spendBySource = { "Urgent Third State": { spend: 1000, leads: 0, channel: "mailer" } };
  const { csv } = sourceRows(m);
  const cols = csv.emailColumns.map((c) => c.header);
  assert.ok(cols.includes("roas_pct"), `expected roas_pct, got ${cols.join(",")}`);
  assert.equal(cols.includes("roi_pct"), false, "ROI is a month measure — it does not belong in a daily");
});

test("ROI still reaches the CSV, where a month range makes it mean something", () => {
  const m = material([payment({ caseId: 11, amount: 250, sourceAtSale: "Urgent Third State" })]);
  const { csv } = sourceRows(m);
  const cols = csv.columns.map((c) => c.header);
  assert.ok(cols.includes("roi_pct"));
  assert.ok(cols.includes("roas_pct"));
});

test("ROAS reads initials over spend, ignoring recurring entirely", () => {
  // The exact thing that makes a daily ROI misleading: recurring cash from
  // cases sold long ago, landing today, against today's spend.
  const m = material([
    payment({ caseId: 11, amount: 250, paymentType: "initial", sourceAtSale: "Urgent Third State" }),
    payment({ caseId: 12, amount: 9000, paymentType: "recurring", sourceAtSale: "Urgent Third State" }),
  ]);
  m.spendBySource = { "Urgent Third State": { spend: 1000, leads: 0, channel: "mailer" } };
  const row = sourceRows(m).csv.emailRows.find((r) => /Urgent Third/.test(String(r.source)));
  const roas = csv_get(sourceRows(m).csv, "roas_pct", row);
  assert.equal(roas, 25, "250 / 1000 — the $9,000 of recurring must not touch it");
});

function csv_get(csv, header, row) {
  return csv.emailColumns.find((c) => c.header === header).get(row);
}
