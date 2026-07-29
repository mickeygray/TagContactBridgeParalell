"use strict";

// Logics Payments CSV importer — the daily truth-up for PaymentLedger.
//
// Design (2026-07-24): the hourly API reconcile stays as the live stream;
// the manually-exported Logics PaymentsReport CSV is the AUTHORITATIVE
// corrector Mickey drops in once a day. CSV rows win: matching ledger rows
// are updated in place (correct paymentType — the API mistypes chargebacks
// as "recurring" — plus officer/tag stashed in raw.csv and the row marked
// authoritativeSource="logics-csv"); rows the API missed are inserted.
//
// Identity: PaymentLedger.casePaymentId is unique and comes from Logics'
// monotonic positive sequence, which the CSV does not carry. Inserted rows
// therefore use a SYNTHETIC NEGATIVE casePaymentId (stable hash of
// domain|caseId|date|amount|txnId) — negative ids can never collide with
// Logics' positives, and re-imports of the same CSV are idempotent.

const crypto = require("crypto");
const Papa = require("papaparse");
const PaymentLedger = require("../../shared-models/src/PaymentLedger");

const DAY_MS = 24 * 60 * 60 * 1000;

function utcDayKey(date) {
  return date instanceof Date && !Number.isNaN(date.getTime())
    ? date.toISOString().slice(0, 10)
    : null;
}

function decodeCsvBuffer(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.toString("utf16le");
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    return buffer.swap16().toString("utf16le");
  }
  // Heuristic: UTF-16LE without BOM has NULs in even/odd positions.
  const nulls = buffer.slice(0, 200).filter((b) => b === 0).length;
  if (nulls > 40) return buffer.toString("utf16le");
  return buffer.toString("utf8");
}

function parseAmount(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const negative = text.includes("(");
  const num = Number(text.replace(/[$(),\s]/g, ""));
  if (!Number.isFinite(num)) return null;
  return negative ? -num : num;
}

function parseDateKey(value) {
  // "7/21/2026 12:00:00 AM" or "7/21/2026 4:49:58 PM" → 2026-07-21
  const match = String(value || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!match) return null;
  return `${match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
}

function stableHash(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) || 1;
}

function withUnconsumedCandidates(filter, consumedCandidateIds) {
  if (consumedCandidateIds.size > 0) {
    filter._id = { $nin: [...consumedCandidateIds] };
  }
  return filter;
}

async function findPaymentCandidate({
  domain,
  row,
  dateAnchor,
  consumedCandidateIds,
  // A CSV row may only ever claim a ledger row of the SAME status — a
  // declined attempt must never claim (or be claimed by) the success that
  // followed it a day later at the same amount.
  transactionStatus = "SUCCESS",
}) {
  if (row.txnId) {
    const exact = await PaymentLedger.findOne(
      withUnconsumedCandidates(
        {
          domain,
          caseId: row.caseId,
          transactionStatus,
          "raw.csv.txnId": row.txnId,
        },
        consumedCandidateIds,
      ),
    ).sort({ paymentDate: 1 });
    if (exact) return exact;
  }

  const missingTxnIdentity = [
    { "raw.csv.txnId": null },
    { "raw.csv.txnId": { $exists: false } },
  ];
  return PaymentLedger.findOne(
    withUnconsumedCandidates(
      {
        domain,
        caseId: row.caseId,
        amount: row.amount,
        transactionStatus,
        paymentDate: {
          $gte: new Date(dateAnchor.getTime() - 3 * DAY_MS),
          $lte: new Date(dateAnchor.getTime() + 3 * DAY_MS),
        },
        $or: row.txnId
          ? [{ "raw.csv.txnId": row.txnId }, ...missingTxnIdentity]
          : missingTxnIdentity,
      },
      consumedCandidateIds,
    ),
  ).sort({ paymentDate: 1 });
}

function parsePaymentsCsv(buffer) {
  const text = decodeCsvBuffer(buffer);
  const parsed = Papa.parse(text.trim(), { header: true, skipEmptyLines: true });
  const rows = [];
  for (const record of parsed.data) {
    const caseId = Number(String(record["Case ID"] || "").trim());
    if (!Number.isFinite(caseId) || caseId <= 0) continue; // grand-total / junk rows
    const amount = parseAmount(record.Amount);
    if (amount == null || amount === 0) continue;
    const txnMatch = String(record.Comment || "").match(/Transaction ID\s*:?\s*(\d{6,})/i);
    rows.push({
      caseId,
      client: String(record["Client Name"] || "").trim(),
      officer: String(record["Settlement Officer"] || "").trim(),
      amount,
      paymentTypeRaw: String(record["Payment Type"] || "").trim(),
      method: String(record["Payment Method"] || "").trim(),
      status: String(record["Payment Status"] || "").trim().toUpperCase(),
      sourceName: String(record["Source Name"] || "").trim(),
      // Human-entered payment-lifecycle tag (Initial Payment / Origination
      // Fee / Ad-Serv N). Stored for reference ONLY — never drives counting
      // or attribution (Mickey, 2026-07-24: "Payment Type Initial vs
      // Recurring is the correct split").
      tag: String(record.Tag || "").trim(),
      paidDateKey: parseDateKey(record.PaidDate) || parseDateKey(record["Transaction Time"]),
      transactionTime: String(record["Transaction Time"] || "").trim(),
      txnId: txnMatch ? txnMatch[1] : null,
      // Chargeback signal lives in Payment Type per Mickey (2026-07-27),
      // though observed exports carry it in Payment Method — test both.
      isChargeback:
        /charge\s*back/i.test(String(record["Payment Method"] || ""))
        || /charge\s*back/i.test(String(record["Payment Type"] || ""))
        || amount < 0,
      // The rest of the sheet, kept so the daily import carries everything
      // the export knows (people, team, merchant plumbing).
      caseManager: String(record["Case Manager"] || "").trim() || null,
      caseWorker: String(record["Case Worker"] || "").trim() || null,
      teamName: String(record["Team Name"] || "").trim() || null,
      opener: String(record.Opener || "").trim() || null,
      taxPreparer: String(record["Tax Preparer"] || "").trim() || null,
      createdBy: String(record.CreatedBy || "").trim() || null,
      merchantAccount: String(record["Merchant Account"] || "").trim() || null,
      accountType: String(record["Account Type"] || "").trim() || null,
      authorizationCode: String(record.AuthorizationCode || "").trim() || null,
    });
  }
  return rows;
}

// Everything the sheet knows about a row, stashed under raw.csv on the
// ledger row. Reference data only — counting/attribution read amount,
// paymentType, and dates, never these.
function csvRawFields(row) {
  return {
    officer: row.officer,
    tag: row.tag,
    sourceName: row.sourceName,
    method: row.method,
    chargeback: row.isChargeback,
    txnId: row.txnId,
    client: row.client,
    caseManager: row.caseManager,
    caseWorker: row.caseWorker,
    teamName: row.teamName,
    opener: row.opener,
    taxPreparer: row.taxPreparer,
    createdBy: row.createdBy,
    merchantAccount: row.merchantAccount,
    accountType: row.accountType,
    authorizationCode: row.authorizationCode,
  };
}

function normalizedType(row) {
  // The settlement report's "Initial" stays initial — INCLUDING chargebacks
  // of initials (negative amount, type Initial): a reversed deal must
  // reverse under initials, never haunt recurring.
  const type = row.paymentTypeRaw.toLowerCase();
  if (type === "initial") return "initial";
  if (type === "recurring") return "recurring";
  return "unknown";
}

async function importLogicsPaymentsCsv({ domain, buffer, dryRun = false } = {}) {
  const normalizedDomain = String(domain || "").trim().toUpperCase();
  if (!normalizedDomain) throw new Error("domain is required (TAG or WYNN)");
  if (!buffer || !buffer.length) throw new Error("csv buffer is required");

  const rows = parsePaymentsCsv(buffer);
  const consumedCandidateIds = new Set();
  const occurrenceByIdentity = new Map();
  const summary = {
    domain: normalizedDomain,
    dryRun: Boolean(dryRun),
    parsed: rows.length,
    skippedNonSuccess: 0,
    matchedAlreadyCorrect: 0,
    matchedUpdated: 0,
    inserted: 0,
    chargebacksTyped: 0,
    failedMatched: 0,
    failedInserted: 0,
    totalAmount: 0,
    actions: [],
  };

  for (const row of rows) {
    const status = String(row.status || "").trim().toUpperCase();
    if (status !== "SUCCESS") {
      // Failed/declined rows are INGESTED, not skipped. Ruling (Mickey
      // 2026-07-27): "in the payment status anything but success is a
      // failed payment" — binary, no special cases, PENDING included.
      // They power the card-chasing list, so the sheet fully replaces the
      // hourly API sweep as the payments record. Only a BLANK status is
      // skipped (no signal to record).
      //
      // Money math is untouched: totalAmount counts SUCCESS only, and every
      // read path (deal math, cash, rollups) filters SUCCESS.
      if (!status) {
        summary.skippedNonSuccess += 1;
        continue;
      }
      const failAnchor = row.paidDateKey ? new Date(`${row.paidDateKey}T12:00:00Z`) : new Date();
      const failCandidate = await findPaymentCandidate({
        domain: normalizedDomain,
        row,
        dateAnchor: failAnchor,
        consumedCandidateIds,
        transactionStatus: status,
      });
      if (failCandidate) {
        consumedCandidateIds.add(failCandidate._id);
        summary.failedMatched += 1;
        if (!dryRun) {
          await PaymentLedger.updateOne(
            { _id: failCandidate._id },
            {
              $set: {
                paymentType: normalizedType(row),
                authoritativeSource: "logics-csv",
                authoritativeAt: new Date(),
                "raw.csv": csvRawFields(row),
              },
            },
          );
        }
        continue;
      }
      // Identity is SALTED WITH STATUS: a $500 decline and the $500 success
      // that followed at the same identity must never share a synthetic id.
      const failIdentity = [
        normalizedDomain, row.caseId, row.paidDateKey, row.amount, row.txnId || "", status,
      ].join("|");
      const failOrdinal = occurrenceByIdentity.get(failIdentity) || 0;
      occurrenceByIdentity.set(failIdentity, failOrdinal + 1);
      const failSyntheticId = -stableHash(
        failOrdinal > 0 ? `${failIdentity}#${failOrdinal}` : failIdentity,
      );
      summary.failedInserted += 1;
      summary.actions.push({
        action: "insert-failed",
        caseId: row.caseId,
        client: row.client,
        amount: row.amount,
        status,
        date: row.paidDateKey,
      });
      if (!dryRun) {
        await PaymentLedger.updateOne(
          { casePaymentId: failSyntheticId },
          {
            $setOnInsert: {
              domain: normalizedDomain,
              caseId: row.caseId,
              casePaymentId: failSyntheticId,
              paymentDate: failAnchor,
              paymentDateKey: row.paidDateKey,
              recordedAt: new Date(),
            },
            $set: {
              amount: row.amount,
              paymentType: normalizedType(row),
              transactionStatus: status,
              authoritativeSource: "logics-csv",
              authoritativeAt: new Date(),
              raw: { csv: csvRawFields(row) },
            },
          },
          { upsert: true },
        );
      }
      continue;
    }
    summary.totalAmount = Math.round((summary.totalAmount + row.amount) * 100) / 100;
    const wantType = normalizedType(row);
    const dateAnchor = row.paidDateKey ? new Date(`${row.paidDateKey}T12:00:00Z`) : new Date();

    // Two identical CSV rows (same case, same amount, same day — a client
    // who really did pay $500 twice) are DISTINCT payments. Give each an
    // occurrence ordinal so they can never collapse into one identity.
    // Ordinal is assigned over every SUCCESS row in CSV order, so it stays
    // deterministic across re-imports even when the first of a pair matches
    // an existing ledger row and the second has to be inserted.
    const identityKey = [normalizedDomain, row.caseId, row.paidDateKey, row.amount, row.txnId || ""].join("|");
    const ordinal = occurrenceByIdentity.get(identityKey) || 0;
    occurrenceByIdentity.set(identityKey, ordinal + 1);

    // Match an existing ledger row: exact transaction id when the CSV
    // comment carries one, else same case/signed amount within ±3 days
    // (API paymentDate and CSV PaidDate can straddle a boundary). Rows
    // already claimed by an earlier CSV row this import are excluded, so
    // the second of two identical rows cannot re-claim the first's match.
    const candidate = await findPaymentCandidate({
      domain: normalizedDomain,
      row,
      dateAnchor,
      consumedCandidateIds,
    });

    if (candidate) {
      consumedCandidateIds.add(candidate._id);
      const needsType = candidate.paymentType !== wantType;
      const needsAuthority = candidate.authoritativeSource !== "logics-csv";
      if (!needsType && !needsAuthority) {
        summary.matchedAlreadyCorrect += 1;
        continue;
      }
      summary.matchedUpdated += 1;
      if (needsType && row.isChargeback) summary.chargebacksTyped += 1;
      summary.actions.push({
        action: "update",
        caseId: row.caseId,
        client: row.client,
        amount: row.amount,
        typeBefore: candidate.paymentType,
        typeAfter: wantType,
      });
      if (!dryRun) {
        await PaymentLedger.updateOne(
          { _id: candidate._id },
          {
            $set: {
              paymentType: wantType,
              authoritativeSource: "logics-csv",
              authoritativeAt: new Date(),
              "raw.csv": csvRawFields(row),
            },
          },
        );
      }
      continue;
    }

    // No match — the API missed this payment entirely. Insert with a
    // synthetic NEGATIVE casePaymentId (idempotent across re-imports).
    //
    // Ordinal 0 hashes the bare identity, byte-identical to what this
    // importer produced before ordinals existed, so rows already inserted
    // by a previous run still match and re-import stays idempotent. Only
    // the 2nd+ copy of an identical row gets a distinct "#n" identity.
    const syntheticId = -stableHash(ordinal > 0 ? `${identityKey}#${ordinal}` : identityKey);
    summary.inserted += 1;
    summary.actions.push({
      action: "insert",
      caseId: row.caseId,
      client: row.client,
      amount: row.amount,
      type: wantType,
      date: row.paidDateKey,
    });
    if (!dryRun) {
      await PaymentLedger.updateOne(
        { casePaymentId: syntheticId },
        {
          $setOnInsert: {
            domain: normalizedDomain,
            caseId: row.caseId,
            casePaymentId: syntheticId,
            paymentDate: dateAnchor,
            paymentDateKey: row.paidDateKey,
            recordedAt: new Date(),
          },
          $set: {
            amount: row.amount,
            paymentType: wantType,
            transactionStatus: "SUCCESS",
            authoritativeSource: "logics-csv",
            authoritativeAt: new Date(),
            raw: { csv: csvRawFields(row) },
          },
        },
        { upsert: true },
      );
    }
  }

  return summary;
}

module.exports = {
  importLogicsPaymentsCsv,
  parsePaymentsCsv,
};
