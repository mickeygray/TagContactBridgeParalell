"use strict";

// The step that turns a parsed invoice into reportable money. Its refusals
// matter more than its successes: every number it writes lands in ROAS.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  deriveMailSpend, holdReason, rowsForInvoice, UNMAPPED_SOURCE,
} = require("../../packages/shared-services/src/mailSpendDeriveService");

const INVOICE = {
  _id: "inv1",
  invoiceNumber: "83648",
  serviceDate: "2026-07-31",
  state: "reconciled",
  grandTotal: 1234.11,
  fileSha256: "sha-a",
  serviceDateSource: "receipt",
  perPiece: [
    { source: "TAG A", pieces: 800, postage: 500, service: 100, feeShare: 10, total: 610 },
    { source: "TAG B", pieces: 523, postage: 400, service: 200, feeShare: 24.11, total: 624.11 },
  ],
};

/** A stand-in for the two models, recording what the deriver did to them. */
function fakeModels({ invoices = [INVOICE], existing = [] } = {}) {
  const calls = { inserted: [], retired: [], stamped: [] };
  let active = [...existing];
  return {
    calls,
    get active() { return active; },
    models: {
      MailInvoice: {
        find: () => ({ lean: async () => invoices }),
        updateOne: async (filter, update) => { calls.stamped.push({ filter, update }); },
      },
      MailSpendDay: {
        find: () => ({ select: () => ({ lean: async () => active }) }),
        updateMany: async (filter, update) => {
          calls.retired.push({ filter, update });
          const n = active.length;
          active = [];
          return { modifiedCount: n };
        },
        insertMany: async (rows) => { calls.inserted.push(...rows); active = rows; return rows; },
      },
    },
  };
}

test("a reconciled invoice becomes one row per piece, summing to the bill", async () => {
  const f = fakeModels();
  const r = await deriveMailSpend({ from: "2026-07-01", to: "2026-07-31", apply: true, models: f.models });
  assert.equal(r.derived, 1);
  assert.equal(f.calls.inserted.length, 2);
  const sum = f.calls.inserted.reduce((s, x) => s + x.spend, 0);
  assert.ok(Math.abs(sum - 1234.11) < 0.01, `rows must sum to the bill, got ${sum}`);
  // The invoice is stamped so a second pass can tell it is done.
  assert.equal(f.calls.stamped.length, 1);
});

test("an invoice in review NEVER becomes money", async () => {
  // The whole point of the review state. A number nobody has vouched for must
  // not reach ROAS.
  for (const state of ["review", "parsed"]) {
    const f = fakeModels({ invoices: [{ ...INVOICE, state }] });
    const r = await deriveMailSpend({ from: "2026-07-01", to: "2026-07-31", apply: true, models: f.models });
    assert.equal(r.derived, 0, `${state} must not derive`);
    assert.equal(f.calls.inserted.length, 0);
    assert.equal(r.held[0].reason, `state-${state}`);
  }
});

test("an allocation that does not add up to the bill is HELD, not rounded", async () => {
  const f = fakeModels({ invoices: [{ ...INVOICE, grandTotal: 1300 }] });
  const r = await deriveMailSpend({ from: "2026-07-01", to: "2026-07-31", apply: true, models: f.models });
  assert.equal(r.derived, 0);
  assert.match(r.held[0].reason, /^tie-out-off-by-/);
});

test("a rounded cent is tolerated — the parser's own tolerance", () => {
  // Demanding exact equality would hold a day over float noise the parser
  // already accepted, which would be a permanent false alarm.
  assert.equal(holdReason({ ...INVOICE, grandTotal: 1234.12 }), null);
});

test("a guessed YEAR far from the email that carried it is held", () => {
  // "Daily Mail 12-31" read in January files as next December unless caught.
  const far = {
    ...INVOICE,
    serviceDateSource: "assumed-current-year",
    receivedAt: new Date("2026-01-02T00:00:00Z"),
    serviceDate: "2026-12-31",
  };
  assert.equal(holdReason(far), "assumed-year-unsafe");
  const near = { ...far, serviceDate: "2026-01-01" };
  assert.equal(holdReason(near), null, "a guessed year close to the email is fine");
});

test("an unmapped piece becomes a REMAINDER row, so the day still ties to the bill", () => {
  // Holding the day instead would report $0 mail cost against live pieces —
  // a worse lie than an unattributed bucket.
  const partial = { ...INVOICE, grandTotal: 1500 };
  const rows = rowsForInvoice(partial, "run");
  const unmapped = rows.find((r) => r.source === UNMAPPED_SOURCE);
  assert.ok(unmapped, "must carry the remainder");
  assert.ok(Math.abs(rows.reduce((s, r) => s + r.spend, 0) - 1500) < 0.01);
});

test("two lines naming the SAME source fold into one row", () => {
  // The unique index is on (day, source). A postage line and a print line for
  // one mailer would collide at write time if not folded here.
  const dup = {
    ...INVOICE,
    perPiece: [
      { source: "TAG A", pieces: 800, postage: 500, service: 0, feeShare: 0, total: 500 },
      { source: "TAG A", pieces: 0, postage: 0, service: 734.11, feeShare: 0, total: 734.11 },
    ],
  };
  const rows = rowsForInvoice(dup, "run");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].spend, 1234.11);
  // Only the POSTAGE line's pieces — print bills the same physical piece again.
  assert.equal(rows[0].pieces, 800);
});

test("re-deriving the same file is a no-op, not a duplicate", async () => {
  const f = fakeModels({ existing: [{ fileSha256: "sha-a" }] });
  const r = await deriveMailSpend({ from: "2026-07-01", to: "2026-07-31", apply: true, models: f.models });
  assert.equal(r.skipped, 1);
  assert.equal(r.derived, 0);
  assert.equal(f.calls.inserted.length, 0);
  assert.equal(f.calls.retired.length, 0);
});

test("a CORRECTED invoice retires the old rows before writing new ones", async () => {
  // Retire-then-insert, never edit. A corrected bill is a new event, and the
  // unique partial index makes the reverse order fail outright.
  const f = fakeModels({ existing: [{ fileSha256: "sha-OLD" }] });
  const r = await deriveMailSpend({ from: "2026-07-01", to: "2026-07-31", apply: true, models: f.models });
  assert.equal(r.derived, 1);
  assert.equal(f.calls.retired.length, 1);
  assert.equal(f.calls.retired[0].update.$set.active, false);
  assert.match(f.calls.retired[0].update.$set.retiredReason, /superseded-by-83648/);
  assert.equal(f.calls.inserted.length, 2);
});

test("a dry run writes NOTHING but still reports what it would do", async () => {
  const f = fakeModels();
  const r = await deriveMailSpend({ from: "2026-07-01", to: "2026-07-31", apply: false, models: f.models });
  assert.equal(r.derived, 1);
  assert.equal(r.rows.length, 2);
  assert.equal(f.calls.inserted.length, 0);
  assert.equal(f.calls.stamped.length, 0);
});

test("every derived row carries the PDF it came from", async () => {
  // A dollar in ROAS must be traceable back to a specific file.
  const f = fakeModels();
  await deriveMailSpend({ from: "2026-07-01", to: "2026-07-31", apply: true, models: f.models });
  for (const row of f.calls.inserted) {
    assert.equal(row.invoiceNumber, "83648");
    assert.equal(row.fileSha256, "sha-a");
    assert.equal(row.invoiceGrandTotal, 1234.11);
    assert.equal(row.channel, "mailer");
    assert.ok(row.derivationRunId);
  }
});
