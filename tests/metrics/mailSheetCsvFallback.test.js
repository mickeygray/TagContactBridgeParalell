"use strict";

// MAIL SPEND HAS TWO SOURCES AND THE DAY TAKES WHICHEVER ARRIVED.
//
// Mickey 2026-08-03: "they updated the sheet but didnt send me invoices" /
// "when they normally send me invoices and dont update the sheet" / "so it
// sorta needs to be able to use both" / "just read the csv if we have no email
// at 7:50" / "and if neither matches".
//
// The vendor does one or the other on a given day. The invoice is preferred —
// it is what they actually billed — and the sheet CSV is the fallback. Read
// live, so it does not depend on the sync service being up: that service runs
// only inside the control plane, which was Manual+Stopped while the vendor was
// still updating the sheet, and three days of mail cost silently read $0.00.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { readMailSheetCsv, parseCsv, toDateKey } = require("../../packages/shared-services/src/mailSheetCsvService");

const CSV = [
  "Data Date,Job Name,Pieces,Postage,Total",
  "2026-08-03,Urgent 3rd White,827,$400.00,$537.46",
  "2026-08-03,Afford Csnap,784,$380.00,$509.56",
  "2026-08-02,Old Drop,100,$50.00,$60.00",
  ",,,,",
  "2026-08-03,Spacer Line,0,$0.00,$0.00",
].join("\n");

const fetchOk = (body) => async () => ({ ok: true, status: 200, text: async () => body });

test("reads only the days asked for", async () => {
  const r = await readMailSheetCsv({
    from: "2026-08-03", to: "2026-08-03", url: "https://x/csv", fetchImpl: fetchOk(CSV),
  });
  assert.equal(r.unavailable, null);
  assert.deepEqual(r.days, ["2026-08-03"]);
  assert.equal(r.rows.length, 2, "08-02 is out of range, the spacer has no money");
  assert.equal(Math.round(r.rows.reduce((s, x) => s + x.spend, 0) * 100) / 100, 1047.02);
});

test("rows arrive in the shape the spend merge already consumes", async () => {
  const r = await readMailSheetCsv({
    from: "2026-08-03", to: "2026-08-03", url: "https://x/csv", fetchImpl: fetchOk(CSV),
  });
  const row = r.rows[0];
  assert.equal(row.channel, "mailer");
  assert.equal(typeof row.date, "string");
  assert.equal(typeof row.spend, "number");
  assert.equal(typeof row.pieces, "number");
  // `cost` is what the night board sums as its postage subtotal.
  assert.equal(row.cost, 400);
  assert.equal(row.leadsReported, 0);
});

test("a blank or zero line is not a drop", async () => {
  const r = await readMailSheetCsv({
    from: "2026-08-01", to: "2026-08-31", url: "https://x/csv", fetchImpl: fetchOk(CSV),
  });
  assert.equal(r.rows.some((x) => x.source === "Spacer Line"), false);
});

test("a sheet we could not READ is not an empty sheet", async () => {
  // The whole failure this stack keeps repeating. "They did not update it" and
  // "we could not fetch it" have different fixes and must never render alike.
  const cases = [
    [async () => ({ ok: false, status: 403, text: async () => "" }), /403/],
    [async () => { throw new Error("socket hang up"); }, /unreadable/],
    [fetchOk("<!doctype html><html>login</html>"), /HTML, not CSV/],
  ];
  for (const [impl, re] of cases) {
    const r = await readMailSheetCsv({ from: "2026-08-03", to: "2026-08-03", url: "https://x/csv", fetchImpl: impl });
    assert.match(String(r.unavailable), re);
    assert.deepEqual(r.rows, [], "an unreadable sheet yields no rows AND says why");
  }
});

test("no configured URL is reported, never silently zero", async () => {
  const r = await readMailSheetCsv({ from: "2026-08-03", to: "2026-08-03", url: "", fetchImpl: fetchOk(CSV) });
  assert.match(String(r.unavailable), /no mail sheet URL/);
});

test("the CSV parser survives quoted commas and escaped quotes", async () => {
  const tricky = [
    "Data Date,Job Name,Pieces,Postage,Total",
    '2026-08-03,"Zeta, Unknown ""X"" Piece",10,$1.00,$2.00',
  ].join("\n");
  const r = await readMailSheetCsv({ from: "2026-08-03", to: "2026-08-03", url: "https://x/csv", fetchImpl: fetchOk(tricky) });
  // An UNMAPPED name passes through as written — the quote handling is what
  // is under test here, not the alias map.
  assert.equal(r.rows[0].source, 'Zeta, Unknown "X" Piece');
  assert.equal(r.rows[0].spend, 2);
});

test("the sheet's date formats all normalise to one key", () => {
  for (const raw of ["2026-08-03", "8/3/2026", "08-03-2026", "8/3/26"]) {
    assert.equal(toDateKey(raw), "2026-08-03", `${raw} must normalise`);
  }
  assert.equal(toDateKey(""), null);
});

test("headers are honoured, not column positions", () => {
  // The vendor reorders columns. Position-based parsing would silently read
  // pieces as dollars.
  const reordered = ["Total,Pieces,Data Date,Job Name", "$99.00,7,2026-08-03,Reordered"].join("\n");
  const [row] = parseCsv(reordered);
  assert.equal(row["Job Name"], "Reordered");
  assert.equal(row.Total, "$99.00");
});

// ── THE PER-DAY RULE ──────────────────────────────────────────────────────
//
// The first version of the fallback asked "does this RANGE have any mailer
// row?" and skipped the CSV if so. Measured on 2026-07-30..08-03: the range
// reported $3,694.52 and silently omitted 08-03's $1,584.48, because 07-30
// happened to be persisted. Every weekly and monthly mail figure would have
// been short. The question has to be asked per DAY.

const { partitionMailSpend } = require("../../packages/shared-services/src/reportComposerService");

test("a persisted day and a CSV-only day both survive the same range", () => {
  // Simulates what gatherMaterial assembles: one persisted day, one from CSV.
  const sheetRows = [
    { date: "2026-07-30", channel: "mailer", source: "TAG A", spend: 2460.41, pieces: 2717 },
    { date: "2026-08-03", channel: "mailer", source: "TAG A", spend: 1584.48, pieces: 2438, fromSheet: true },
  ];
  const { rows } = partitionMailSpend({ sheetRows, derivedMail: [] });
  const total = rows.filter((r) => r.channel === "mailer").reduce((s, r) => s + r.spend, 0);
  assert.equal(Math.round(total * 100) / 100, 4044.89, "neither day may be dropped");
});

test("an INVOICE day still displaces the sheet, even mid-range", () => {
  // The precedence that must survive the per-day change: invoice beats sheet
  // on its own day, and leaves every other day alone.
  const sheetRows = [
    { date: "2026-07-30", channel: "mailer", source: "TAG A", spend: 2460.41, pieces: 2717 },
    { date: "2026-07-31", channel: "mailer", source: "TAG A", spend: 1200, pieces: 1323 },
    { date: "2026-08-03", channel: "mailer", source: "TAG A", spend: 1584.48, pieces: 2438 },
  ];
  const derivedMail = [{ serviceDate: "2026-07-31", source: "TAG A", spend: 1234.11, pieces: 1323, postage: 971.32 }];
  const { rows } = partitionMailSpend({ sheetRows, derivedMail });
  const byDay = {};
  for (const r of rows.filter((x) => x.channel === "mailer")) byDay[r.date] = (byDay[r.date] || 0) + r.spend;
  assert.equal(Math.round(byDay["2026-07-31"] * 100) / 100, 1234.11, "the invoice wins its day");
  assert.equal(byDay["2026-07-30"], 2460.41, "and does not touch the others");
  assert.equal(byDay["2026-08-03"], 1584.48);
});
