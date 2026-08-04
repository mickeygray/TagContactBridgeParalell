"use strict";

// THE DOUBLE-COUNT GUARD.
//
// Mail cost now has two possible sources — the hand-kept spend sheet and the
// vendor's invoice. If both are summed for one day, mail cost doubles and ROAS
// halves, and the resulting number is plausible enough to go unnoticed. These
// tests exist to make that failure loud.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { partitionMailSpend } = require("../../packages/shared-services/src/reportComposerService");

const sum = (rows) => Math.round(rows.reduce((s, r) => s + Number(r.spend || 0), 0) * 100) / 100;
const mailOf = (rows) => rows.filter((r) => String(r.channel || "").toLowerCase() === "mailer");

const SHEET = [
  { date: "2026-07-31", channel: "mailer", source: "TAG A", spend: 1200, pieces: 1323 },
  { date: "2026-07-31", channel: "lead-data", source: "LD", spend: 300, leadsReported: 100 },
  { date: "2026-07-30", channel: "mailer", source: "TAG A", spend: 900, pieces: 1000 },
];

const DERIVED = [
  { serviceDate: "2026-07-31", source: "TAG A", spend: 610, pieces: 800 },
  { serviceDate: "2026-07-31", source: "TAG B", spend: 624.11, pieces: 523 },
];

test("an invoiced day takes the INVOICE and drops the sheet — never both", () => {
  const { rows } = partitionMailSpend({ sheetRows: SHEET, derivedMail: DERIVED });
  const mail = mailOf(rows);
  // 1234.11 (the invoice) for 07-31 + 900 (the sheet) for the uninvoiced 07-30.
  // If the sheet's 1200 leaked through, this would read 3334.11.
  assert.equal(sum(mail), 2134.11);
  assert.equal(mail.filter((r) => r.date === "2026-07-31").length, 2, "only the invoice's rows");
});

test("a day WITHOUT an invoice keeps its sheet row untouched", () => {
  const { rows } = partitionMailSpend({ sheetRows: SHEET, derivedMail: DERIVED });
  const jul30 = mailOf(rows).filter((r) => r.date === "2026-07-30");
  assert.equal(jul30.length, 1);
  assert.equal(jul30[0].spend, 900);
});

test("NON-mail rows are never displaced, even on an invoiced day", () => {
  // The partition is about mail only. Dropping the day's LD spend would be a
  // far worse bug than the one it is preventing.
  const { rows } = partitionMailSpend({ sheetRows: SHEET, derivedMail: DERIVED });
  const ld = rows.filter((r) => r.channel === "lead-data");
  assert.equal(ld.length, 1);
  assert.equal(ld[0].spend, 300);
});

test("a sheet row spelled \"Mailer\" is STILL displaced", () => {
  // The sheet is hand-typed. A case-sensitive test here would let a
  // capitalised row survive alongside the invoice and double the day.
  const shouty = [{ date: "2026-07-31", channel: "Mailer", source: "TAG A", spend: 1200, pieces: 1323 }];
  const { rows, supersededSheetRows } = partitionMailSpend({ sheetRows: shouty, derivedMail: DERIVED });
  assert.equal(supersededSheetRows.length, 1);
  assert.equal(sum(mailOf(rows)), 1234.11);
});

test("with no invoice at all, the sheet passes through completely unchanged", () => {
  // The behaviour every board had before this existed. Nothing about adding a
  // second source may alter a day the second source says nothing about.
  const { rows, supersededSheetRows } = partitionMailSpend({ sheetRows: SHEET, derivedMail: [] });
  assert.equal(supersededSheetRows.length, 0);
  assert.deepEqual(rows, SHEET);
});

test("with no sheet row, the invoice still reports the day", () => {
  // The realistic near-term case: nobody types the sheet, the invoice arrives.
  const { rows, supersededSheetRows } = partitionMailSpend({ sheetRows: [], derivedMail: DERIVED });
  assert.equal(supersededSheetRows.length, 0);
  assert.equal(sum(mailOf(rows)), 1234.11);
});

test("the superseded sheet rows are reported, so a disagreement can be named", () => {
  const { supersededSheetRows } = partitionMailSpend({ sheetRows: SHEET, derivedMail: DERIVED });
  assert.equal(sum(supersededSheetRows), 1200);
});

test("derived rows arrive in the shape the spend loop consumes", () => {
  // The loop reads r.date, r.channel, r.source, r.spend, r.pieces and
  // r.leadsReported. A missing field would silently read as 0.
  const { rows } = partitionMailSpend({ sheetRows: [], derivedMail: DERIVED });
  for (const r of rows) {
    assert.equal(typeof r.date, "string");
    assert.equal(r.channel, "mailer");
    assert.equal(typeof r.source, "string");
    assert.equal(typeof r.spend, "number");
    assert.equal(typeof r.pieces, "number");
    assert.equal(r.leadsReported, 0, "an invoice reports no leads");
  }
});

test("pieces follow the same partition as money", () => {
  // Mixing the sheet's piece count with the invoice's spend would corrupt
  // every cost-per-piece on the board.
  const { rows } = partitionMailSpend({ sheetRows: SHEET, derivedMail: DERIVED });
  const jul31 = mailOf(rows).filter((r) => r.date === "2026-07-31");
  assert.equal(jul31.reduce((s, r) => s + r.pieces, 0), 1323, "the invoice's pieces, not the sheet's");
});
