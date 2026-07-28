"use strict";

// Stage 2–3 of the nightly pass: a case → its complete billing picture →
// PaymentTruth rows. (Pipeline contract Part I; master plan §3.)
//
// THE LAW: money is a claim, never a fact, until Billing says so. An
// activity subject only TELLS US TO LOOK; every number here comes from
// Billing/CasePayment, and the case's own CaseBillingSummary.PaidAmount is
// the external check on our arithmetic.

const { PaymentTruth } = require("../../shared-models/src");

// ── seeds (live-pinned 2026-07-27; the lookup table learns the rest) ─────
// PaymentTypeID = payment METHOD (NOT the CSV's "Payment Type" column,
// which means initial/recurring — different axis, same words).
const METHOD_SEED = Object.freeze({
  1: "Credit Card", 2: "Check", 6: "Charge Back", 8: "Loan", 9: "Loan Offset",
});

// TagName is NULL on live rows, so TagID must be resolved by table — and
// tag IDs are PER-TENANT (WYNN uses 1 where TAG never does), exactly like
// status IDs. Never resolve a TagID without its domain.
const TAG_SEED = Object.freeze({
  TAG: { 0: "(untagged)", 2: "Ad-Serv 1", 3: "Origination Fee", 4: "Initial Payment", 5: "Ad-Serv 2", 6: "Ad-Serv 3+" },
  WYNN: { 0: "(untagged)", 1: "(wynn-1)" },
  AMITY: { 0: "(untagged)" },
});

// Tag → initial/recurring, the VALIDATOR for the first-date rule (99.2% on
// 353 deduped CSV rows). Disagreement is a review line, never a silent pick.
//
// TAG 0 IS NOT "INITIAL". The CSV's BLANK tag correlated 18/18 with Initial,
// but the API's TagID 0 just means untagged and is everywhere on the back
// book (10 of 31 rows on one sampled case). Treating it as initial produced
// ~100 false "rules disagree" lines on a single day. Untagged tells us
// nothing, so it votes on nothing.
const INITIAL_TAGS = new Set(["Initial Payment", "Investigation Fee"]);
const UNINFORMATIVE_TAGS = new Set(["(untagged)", "(wynn-1)"]);

/** Every Logics GET returns an envelope; unwrap once at the pull boundary.
 * Feeding the envelope onward fails SILENTLY (empty history, empty phone
 * patch) — this is the single most repeated bug in this integration. */
function unwrapLogics(result) {
  let d = result;
  if (typeof d === "string") { try { d = JSON.parse(d); } catch { return null; } }
  if (typeof d?.Data === "string") { try { d = { ...d, Data: JSON.parse(d.Data) }; } catch { /* keep */ } }
  return d?.Data ?? d;
}

function asRows(value) {
  const d = unwrapLogics(value);
  if (Array.isArray(d)) return d;
  if (Array.isArray(d?.Data)) return d.Data;
  return [];
}

function dateKeyOf(value) {
  const s = String(value || "");
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

function monthKeyOf(dateKey) {
  return dateKey ? String(dateKey).slice(0, 7) : null;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor;
      cursor += 1;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, worker));
  return out;
}

/** Commission note grammar (§3.5). Payout math is DEFERRED — we only
 * preserve what the note says, verbatim plus parsed, because it is free
 * here and unrecoverable later. */
function parseCommissionNote(comment) {
  const raw = String(comment || "");
  // The human note precedes the gateway blob.
  const head = raw.split(/\[Transaction/i)[0].trim();
  if (!head) return null;
  const splits = [];
  const STOP = new Set(["transaction", "status", "response", "code", "reason", "account", "manual", "payment", "loan", "ucfs", "gateway", "terminal", "portal", "checkings", "savings"]);
  for (const m of head.matchAll(/([a-z][a-z.\s]{1,16}?)\s{0,2}(\d{1,3})(?![\d])/gi)) {
    const alias = m[1].toLowerCase().replace(/[.\s]/g, "");
    const pct = Number(m[2]);
    if (STOP.has(alias) || alias.length < 4 || pct > 100 || pct === 0) continue;
    splits.push({ alias, sharePct: pct, house: alias === "house" });
  }
  if (!splits.length) return null;
  const total = splits.reduce((s, x) => s + x.sharePct, 0);
  return {
    rawNote: head.slice(0, 200),
    splits,
    sumsTo100: total === 100,
    voided: /\bVOID\b/i.test(raw),
    needsReview: total !== 100,
    payoutMathDeferred: true,
  };
}

/**
 * Initial vs recurring — a DERIVATION, not a column (it exists nowhere on
 * the API row). Primary: the case's earliest-ever PaidDate across FULL
 * history (no export-window bias — the exact thing the CSV couldn't do).
 * Validator: the tag rule. They disagree → needsReview.
 */
function deriveMetricsTreatment({ row, history, domain }) {
  const positives = history.filter((p) => Number(p.Amount) > 0
    && String(p.TransactionStatus).toUpperCase() === "SUCCESS");
  const firstPaidDateKey = positives
    .map((p) => dateKeyOf(p.PaidDate))
    .filter(Boolean)
    .sort()[0] || null;

  const myDateKey = dateKeyOf(row.PaidDate);
  const amount = Number(row.Amount);
  const isChargeback = Number(row.PaymentTypeID) === 6 || amount < 0;

  const tagName = (TAG_SEED[domain] || {})[Number(row.TagID)] ?? null;
  const tagRuleSays = tagName && !UNINFORMATIVE_TAGS.has(tagName)
    ? (INITIAL_TAGS.has(tagName) ? "initial" : "recurring")
    : null;

  // A chargeback is a reversal of the sale, not a new one.
  const firstDateRuleSays = isChargeback
    ? "recurring"
    : (myDateKey && firstPaidDateKey && myDateKey === firstPaidDateKey ? "initial" : "recurring");

  const paymentType = firstDateRuleSays;
  const rulesAgree = tagRuleSays == null || isChargeback || tagRuleSays === firstDateRuleSays;

  return {
    paymentType,
    decidedBy: "first-date-rule",
    firstPaidDateKey,
    tagRuleSays,
    rulesAgree,
    // Sale-month attribution stays doctrine: ALL initial-typed money
    // (including chargebacks) belongs to the month of the case's FIRST
    // positive initial. simpleDealMathService remains the arbiter for
    // deal counting / split tender — these are denormalised snapshots.
    saleMonthKey: monthKeyOf(firstPaidDateKey),
    isChargeback,
  };
}

/** Assemble one history row into a PaymentTruth document. Pure. */
function assemblePaymentTruth({ domain, caseId, row, history, invoices, summary, dateKey }) {
  const treatment = deriveMetricsTreatment({ row, history, domain });
  const methodId = Number(row.PaymentTypeID);
  const tagId = Number(row.TagID);
  const status = String(row.TransactionStatus || "").toUpperCase() || null;
  const paymentDateKey = dateKeyOf(row.PaidDate);

  const successRows = history.filter((p) => String(p.TransactionStatus).toUpperCase() === "SUCCESS");
  const ledgerSumForCase = Math.round(successRows.reduce((s, p) => s + Number(p.Amount || 0), 0) * 100) / 100;
  const logicsPaidAmount = Number(summary?.PaidAmount ?? NaN);
  const reconciles = Number.isFinite(logicsPaidAmount)
    ? Math.abs(ledgerSumForCase - logicsPaidAmount) < 0.01
    : null;

  const commission = parseCommissionNote(row.Comment);

  return {
    domain, caseId,
    casePaymentId: Number(row.CasePaymentID),
    amount: Number(row.Amount),
    paymentDateKey,
    paymentDate: paymentDateKey ? new Date(`${paymentDateKey}T12:00:00Z`) : null,
    paymentType: treatment.paymentType,
    transactionStatus: status,
    detectedDateKey: dateKey || null,
    keyedAt: row.CreatedDate ? new Date(row.CreatedDate) : null,
    keyedBy: row.CreatedByUserFullName || null,
    method: { id: methodId, name: row.PaymentTypeName || METHOD_SEED[methodId] || null },
    tag: { id: tagId, name: (TAG_SEED[domain] || {})[tagId] ?? null },
    transactionId: row.TransactionID || null,
    authorizationCode: row.AuthorizationCode || null,
    merchantAccountId: row.MerchantAccountID ?? null,
    accountUsed: row.AccountUsed || null,
    checkNumber: row.CheckNumber || null,
    isChargeback: treatment.isChargeback,
    metricsTreatment: treatment,
    billingContext: {
      asOf: new Date(),
      totalFees: Number(summary?.TotalFees ?? 0) || 0,
      paidAmount: Number.isFinite(logicsPaidAmount) ? logicsPaidAmount : null,
      paidPercentage: summary?.PaidPercentage || null,
      balance: Number(summary?.Balance ?? 0) || 0,
      amountDue: Number(summary?.AmountDue ?? 0) || 0,
      dueDate: summary?.DueDate || null,
      pastDue: Number(summary?.PastDue ?? 0) || 0,
      invoices: (invoices || []).map((iv) => ({
        caseInvoiceId: iv.CaseInvoiceID, invoiceTypeName: iv.InvoiceTypeName,
        invoiceTypeGroup: iv.InvoiceTypeGroup, unitPrice: Number(iv.UnitPrice) || 0,
        quantity: Number(iv.Quantity) || 1, date: dateKeyOf(iv.Date), description: iv.Description || null,
      })),
    },
    verification: { ledgerSumForCase, logicsPaidAmount: Number.isFinite(logicsPaidAmount) ? logicsPaidAmount : null, reconciles, lastCheckedAt: new Date() },
    commission,
    // Commission does NOT drive review while payout math is deferred — the
    // note is preserved, not adjudicated.
    needsReview: !treatment.rulesAgree || reconciles === false,
  };
}

/** A 404 from a billing endpoint means the case has NO such records (a
 * fresh prospect with no payments/invoices yet) — an absence, not an
 * outage. Only real errors belong in unconfirmedCases; 404-as-failure put
 * 10 ordinary prospects on the review list in the first trial run. */
async function billingGet(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    if (error?.details?.responseStatus === 404) return { ok: true, value: null, absent: true };
    return { ok: false, error };
  }
}

/** Pull one case's complete billing picture. 3 GETs. Never throws. */
async function pullCaseBilling(domain, caseId, { client } = {}) {
  try {
    const [h, i, sm] = await Promise.all([
      billingGet(() => client.getCasePayments(caseId)),
      billingGet(() => client.getCaseInvoices(caseId)),
      billingGet(() => client.getCaseBillingSummary(caseId)),
    ]);
    const firstError = [h, i, sm].find((r) => !r.ok);
    if (firstError) throw firstError.error;
    const [historyRaw, invoicesRaw, summaryRaw] = [h.value, i.value, sm.value];
    const noBilling = h.absent && i.absent;
    const history = asRows(historyRaw);
    const invoices = asRows(invoicesRaw);
    let summary = unwrapLogics(summaryRaw);
    // Billing summary arrives as either a flat object or a 1-row array.
    if (Array.isArray(summary)) summary = summary[0] || null;
    return { ok: true, domain, caseId, history, invoices, summary, noBilling };
  } catch (error) {
    return { ok: false, domain, caseId, error: String(error.message).slice(0, 180) };
  }
}

/**
 * The money loop over a set of cases.
 *
 * Supersede sweep is CORROBORATED: an empty history only restates a case
 * when Logics' own PaidAmount agrees the case has no money. A 200-with-
 * empty-body pull would otherwise wipe a case's payments and frame it in
 * the email as a normal correction.
 */
async function runMoneyLoop({ domain, caseIds, client, dateKey, concurrency = 3, logger = null }) {
  const truths = [];
  const unconfirmed = [];
  const stats = { cases: 0, pulled: 0, failed: 0, rows: 0, success: 0, declined: 0, chargebacks: 0, mismatches: 0, sweepCandidates: [] };

  await mapLimit([...caseIds], concurrency, async (caseId) => {
    stats.cases += 1;
    const pull = await pullCaseBilling(domain, caseId, { client });
    if (!pull.ok) {
      stats.failed += 1;
      unconfirmed.push({ caseId, error: pull.error, at: new Date() });
      logger?.warn?.("money_loop.pull_failed", { domain, caseId, error: pull.error });
      return;
    }
    stats.pulled += 1;

    const { history, invoices, summary } = pull;
    const paidAmount = Number(summary?.PaidAmount ?? NaN);

    // Corroboration gate: empty history is only believable when Logics says
    // the case has no money. Otherwise treat as a failed pull.
    if (!history.length) {
      if (pull.noBilling) {
        stats.noBilling = (stats.noBilling || 0) + 1;   // fresh prospect, nothing to confirm
      } else if (Number.isFinite(paidAmount) && Math.abs(paidAmount) < 0.01) {
        stats.sweepCandidates.push(caseId);   // legitimately zero
      } else {
        stats.failed += 1;
        unconfirmed.push({ caseId, error: `empty history but PaidAmount=${paidAmount}`, at: new Date() });
      }
      return;
    }

    for (const row of history) {
      stats.rows += 1;
      const status = String(row.TransactionStatus).toUpperCase();
      if (status === "SUCCESS") stats.success += 1;
      if (status === "DECLINED") stats.declined += 1;
      const truth = assemblePaymentTruth({ domain, caseId, row, history, invoices, summary, dateKey });
      if (truth.isChargeback) stats.chargebacks += 1;
      if (truth.verification.reconciles === false) stats.mismatches += 1;
      truths.push(truth);
    }
  });

  return { truths, unconfirmed, stats };
}

/** Persist. Upserting a SEEN casePaymentId always clears supersededAt —
 * self-healing if a prior night superseded wrongly. */
async function persistPaymentTruths(truths = []) {
  if (!truths.length) return { upserted: 0 };
  const ops = truths.map((t) => ({
    updateOne: {
      filter: { domain: t.domain, casePaymentId: t.casePaymentId },
      update: {
        $set: { ...t, lastSeenAt: new Date(), supersededAt: null, supersededReason: null },
        $setOnInsert: { firstSeenAt: new Date() },
      },
      upsert: true,
    },
  }));
  const res = await PaymentTruth.bulkWrite(ops, { ordered: false });
  return { upserted: (res.upsertedCount || 0) + (res.modifiedCount || 0) };
}

module.exports = {
  INITIAL_TAGS,
  UNINFORMATIVE_TAGS,
  METHOD_SEED,
  TAG_SEED,
  assemblePaymentTruth,
  asRows,
  deriveMetricsTreatment,
  mapLimit,
  parseCommissionNote,
  persistPaymentTruths,
  pullCaseBilling,
  runMoneyLoop,
  unwrapLogics,
};
