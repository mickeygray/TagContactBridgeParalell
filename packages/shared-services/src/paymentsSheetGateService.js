"use strict";

// The daily payments-sheet gate (2026-07-24).
//
// Mickey: "it's something that's only fixable by it reading payments every
// day ... you can basically say no night time clean up until that sheet is
// present kinda thing."
//
// WHY: the hourly API reconcile is not a complete record of revenue. Against
// Logics' own export for TAG July the ledger was 34.6% short — $279,500.86
// vs $412,579.15 — and every missing dollar was RECURRING. Initials
// reconciled exactly. 29 legacy payment-plan clients had never been ingested
// at all; 26 more had gone stale, the oldest since 2025-01-21. Publishing a
// money number off the API alone means publishing a number that is a third
// light and confidently labelled.
//
// WHAT IT GATES — and what it deliberately does NOT:
//
//   HELD until the sheet lands : financial/vendor emails and the money
//                                rollups they carry. A number nobody sees is
//                                recoverable; a wrong number in the owner's
//                                inbox is not.
//
//   NEVER HELD                 : DNC and lead-status safety work. Blocking
//                                the queue status refresh on a missing
//                                spreadsheet would leave DNC leads dialable
//                                overnight — exactly the bleed fixed on
//                                2026-07-24 (WYNN 137190). A finance control
//                                must never become a compliance regression.

const crypto = require("crypto");
const PaymentsSheetImport = require("../../shared-models/src/PaymentsSheetImport");
const PaymentLedger = require("../../shared-models/src/PaymentLedger");
const { parsePaymentsCsv } = require("./logicsPaymentsCsvImportService");

// Domains the nightly money pass refuses to publish without. Defaults to the
// two the upload UI offers. AMITY collects recurring but sells nothing and
// has no export path yet — it is reported as unreconciled rather than
// silently treated as complete.
const DEFAULT_REQUIRED_DOMAINS = Object.freeze(["TAG", "WYNN"]);

function requiredDomains() {
  const configured = String(process.env.PAYMENTS_SHEET_REQUIRED_DOMAINS || "")
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
  return configured.length ? configured : [...DEFAULT_REQUIRED_DOMAINS];
}

function paymentsSheetGateEnabled() {
  // Default ON once wired: the whole point is refusing to publish blind.
  return String(process.env.PAYMENTS_SHEET_GATE_ENABLED ?? "true") !== "false";
}

function hashBuffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * Read the date span a PaymentsReport export actually covers.
 * A sheet only closes a day if its rows REACH that day.
 */
function describePaymentsCsv(buffer) {
  const rows = parsePaymentsCsv(buffer);
  const dates = rows.map((row) => row.paidDateKey).filter(Boolean).sort();
  return {
    rows,
    rowCount: rows.length,
    coversFrom: dates[0] || null,
    coversThrough: dates[dates.length - 1] || null,
    caseIds: [...new Set(rows.map((row) => row.caseId).filter(Number.isFinite))],
  };
}

/**
 * Guard against uploading the TAG export under WYNN (or vice versa).
 *
 * The export does not name its own company, so the picker is the only thing
 * saying which it is — and a mis-pick would insert a whole company's
 * payments under the wrong domain as synthetic rows. Case ids are globally
 * unique across the shared Logics tenant, so matching them against the
 * ledger fingerprints the file independently of the human.
 *
 * Returns { ok, claimed, detected, matched, total, confidence }. Unknown
 * cases (a brand-new client) do not count against the file, and a file we
 * cannot fingerprint at all passes — this catches mis-picks, it does not
 * demand omniscience.
 */
async function verifyPaymentsCsvDomain({ domain, caseIds = [] } = {}) {
  const claimed = String(domain || "").trim().toUpperCase();
  if (!claimed || !caseIds.length) {
    return { ok: true, claimed, detected: null, matched: 0, total: 0, confidence: 0 };
  }
  const known = await PaymentLedger.aggregate([
    { $match: { caseId: { $in: caseIds } } },
    { $group: { _id: "$domain", cases: { $addToSet: "$caseId" } } },
  ]);
  if (!known.length) {
    return { ok: true, claimed, detected: null, matched: 0, total: caseIds.length, confidence: 0 };
  }
  const ranked = known
    .map((row) => ({ domain: String(row._id || "").toUpperCase(), n: row.cases.length }))
    .sort((left, right) => right.n - left.n);
  const top = ranked[0];
  const identified = ranked.reduce((sum, row) => sum + row.n, 0);
  const confidence = identified > 0 ? top.n / identified : 0;

  // Only reject when the file clearly belongs to a DIFFERENT company.
  const ok = top.domain === claimed || confidence < 0.8;
  return {
    ok,
    claimed,
    detected: top.domain,
    matched: top.n,
    total: caseIds.length,
    confidence: Math.round(confidence * 1000) / 1000,
  };
}

/**
 * Record that the day's authority arrived for one domain.
 * Upserts on {domain, dateKey} so a corrected re-upload replaces the receipt.
 */
async function recordPaymentsSheetImport({
  domain,
  dateKey,
  summary = {},
  coversFrom = null,
  coversThrough = null,
  fileName = null,
  fileHash = null,
  importedBy = null,
  dryRun = false,
} = {}) {
  const normalizedDomain = String(domain || "").trim().toUpperCase();
  if (!normalizedDomain) throw new TypeError("domain is required");
  if (!dateKey) throw new TypeError("dateKey is required");
  if (dryRun) return { recorded: false, dryRun: true };

  const doc = await PaymentsSheetImport.findOneAndUpdate(
    { domain: normalizedDomain, dateKey: String(dateKey) },
    {
      $set: {
        coversFrom,
        coversThrough,
        fileName,
        fileHash,
        rowsParsed: Number(summary.parsed || 0),
        rowsInserted: Number(summary.inserted || 0),
        rowsUpdated: Number(summary.matchedUpdated || 0),
        rowsAlreadyCorrect: Number(summary.matchedAlreadyCorrect || 0),
        totalAmount: Number(summary.totalAmount || 0),
        dryRun: false,
        importedBy,
        importedAt: new Date(),
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
  return { recorded: true, receipt: doc };
}

/**
 * Has the day's authority arrived for every required domain?
 *
 * A receipt only counts when its file actually REACHES the close date —
 * an export pulled at noon does not close the evening.
 */
async function readPaymentsSheetStatus({ dateKey, domains = null } = {}) {
  if (!dateKey) throw new TypeError("dateKey is required");
  const needed = (Array.isArray(domains) && domains.length ? domains : requiredDomains())
    .map((value) => String(value).trim().toUpperCase())
    .filter(Boolean);

  const receipts = await PaymentsSheetImport.find({
    domain: { $in: needed },
    dateKey: String(dateKey),
  }).lean();

  const byDomain = new Map(receipts.map((row) => [String(row.domain).toUpperCase(), row]));
  const present = [];
  const missing = [];
  const stale = [];
  for (const domain of needed) {
    const receipt = byDomain.get(domain);
    if (!receipt) {
      missing.push(domain);
      continue;
    }
    if (receipt.coversThrough && String(receipt.coversThrough) < String(dateKey)) {
      // The sheet exists but stops before the day it is meant to close.
      stale.push({ domain, coversThrough: receipt.coversThrough });
      continue;
    }
    present.push(domain);
  }

  const ready = missing.length === 0 && stale.length === 0;
  return {
    ready,
    enabled: paymentsSheetGateEnabled(),
    dateKey: String(dateKey),
    required: needed,
    present,
    missing,
    stale,
    receipts,
    reason: ready
      ? null
      : [
        missing.length ? `no payments sheet for ${missing.join(", ")}` : null,
        stale.length
          ? `sheet stops before ${dateKey} for ${stale.map((row) => `${row.domain}@${row.coversThrough}`).join(", ")}`
          : null,
      ].filter(Boolean).join("; "),
  };
}

/**
 * The nightly's decision: publish money, or hold it?
 *
 * `holdMoney` gates the financial/vendor emails and their rollups.
 * Safety work reads NOTHING from this — see the header note.
 */
async function evaluatePaymentsSheetGate({ dateKey, domains = null } = {}) {
  const status = await readPaymentsSheetStatus({ dateKey, domains });
  const holdMoney = status.enabled && !status.ready;
  return {
    ...status,
    holdMoney,
    // Stated explicitly so nobody later "tidies" this into one flag.
    holdSafetyWork: false,
  };
}

module.exports = {
  DEFAULT_REQUIRED_DOMAINS,
  describePaymentsCsv,
  evaluatePaymentsSheetGate,
  hashBuffer,
  paymentsSheetGateEnabled,
  readPaymentsSheetStatus,
  recordPaymentsSheetImport,
  requiredDomains,
  verifyPaymentsCsvDomain,
};
