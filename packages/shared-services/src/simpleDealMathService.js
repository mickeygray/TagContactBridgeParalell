"use strict";

const MISSING_SOURCE_NAMES = new Set(["", "abc", "unknown"]);

function normalizeSourceName(value) {
  return String(value ?? "").trim();
}

function isMissingDealSource(value) {
  return MISSING_SOURCE_NAMES.has(normalizeSourceName(value).toLowerCase());
}

function rawCsvDealSource(payment = {}) {
  return payment.raw?.csv?.sourceName || null;
}

function resolveDealSource({
  manualSource = null,
  profileSource = null,
  paymentSource = null,
} = {}) {
  const candidates = [
    ["manual", manualSource],
    ["profile", profileSource],
    ["payment", paymentSource],
  ];

  for (const [attributionPath, candidate] of candidates) {
    if (isMissingDealSource(candidate)) continue;
    return {
      sourceName: normalizeSourceName(candidate),
      attributionPath,
      missing: false,
    };
  }

  return {
    sourceName: null,
    attributionPath: "missing",
    missing: true,
  };
}

function normalizeDomain(value) {
  const domain = String(value ?? "").trim().toUpperCase();
  if (!domain) throw new TypeError("payment domain is required");
  return domain;
}

function normalizeCaseId(value) {
  const caseId = String(value ?? "").trim();
  if (!caseId) throw new TypeError("payment caseId is required");
  return caseId;
}

function casePaymentKey(domain, caseId) {
  return `${normalizeDomain(domain)}:${normalizeCaseId(caseId)}`;
}

function amountToCents(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) throw new TypeError("payment amount must be finite");
  return Math.round(amount * 100);
}

function centsToAmount(value) {
  return value / 100;
}

function isSuccessfulPayment(row) {
  return String(row?.transactionStatus || "").trim().toUpperCase() === "SUCCESS";
}

function isInitialPayment(row) {
  return String(row?.paymentType || "").trim().toLowerCase() === "initial";
}

function isReversalPayment(row) {
  return isSuccessfulPayment(row) && isInitialPayment(row) && amountToCents(row.amount) < 0;
}

// INITIAL MONEY BELONGS TO THE MONTH OF THE SALE (Mickey, 2026-07-24).
//
// Two rulings, one mechanism:
//
//   "that's a need to update June metrics and not tax July metrics"
//     — a chargeback restates the month that BOOKED the deal, not the month
//       the money moved back. TAG 365360 sold +$3,200 on 2026-06-01 and was
//       reversed on 2026-07-10; charging that to July cost July a deal it
//       never made and dragged 32 sold down to 31.
//
//   "you'll have recurring installments on the first invoice, those are not
//    new clients they are people on a payment plan ... so Kye is June and
//    only June"
//     — MOST CLIENTS PAY THE FIRST INVOICE OVER TIME. A later installment
//       against that same invoice is still typed `initial` by Logics, but it
//       is not a new client. TAG 336405 took $500 on 2026-06-08 and another
//       on 2026-07-08: one June sale, not one in each month.
//
// So EVERY initial-type row — later installment or reversal — attributes to
// the case's FIRST positive initial. Recurring revenue is untouched and
// stays in the month it was collected.
//
// Two consequences, both deliberate:
//   1. A closed month can be RESTATED later, by an installment or a
//      chargeback. Rebuild months on read; never freeze them.
//   2. A month's initial dollars are what its SALES were worth, not what
//      was banked that month. Cash-basis reconciliation will differ.
function resolveAttributionDateKey(row, firstInitialDateByCase) {
  const ownDateKey = row?.paymentDateKey ?? null;
  if (!isSuccessfulPayment(row) || !isInitialPayment(row)) return ownDateKey;
  const saleDateKey = firstInitialDateByCase?.get?.(
    casePaymentKey(row.domain, row.caseId),
  );
  return saleDateKey || ownDateKey;
}

/**
 * Re-window payment rows by attribution date rather than payment date.
 *
 * `rows` must contain the window's own rows PLUS any reversals that landed
 * after the window (their sale may fall inside it). Date keys are
 * "YYYY-MM-DD", so lexicographic comparison matches the Mongo range query.
 *
 * Returns the rows that belong to [from, to] once chargebacks are attributed
 * to their sale month, plus both halves of the restatement so callers can
 * show what moved and why.
 */
function attributePaymentsToSaleWindow({
  rows = [],
  firstInitialDateByCase = new Map(),
  from,
  to,
} = {}) {
  if (!Array.isArray(rows)) throw new TypeError("payment rows must be an array");
  if (!from || !to) throw new TypeError("from and to are required");

  const attributed = [];
  const pulledIn = [];
  const pushedOut = [];

  for (const row of rows) {
    const ownDateKey = row?.paymentDateKey ?? null;
    const attributionDateKey = resolveAttributionDateKey(row, firstInitialDateByCase);
    const belongsHere =
      attributionDateKey != null && attributionDateKey >= from && attributionDateKey <= to;
    const landedHere = ownDateKey != null && ownDateKey >= from && ownDateKey <= to;

    if (belongsHere) {
      attributed.push(row);
      if (!landedHere) {
        // Money that arrived later against a deal sold INSIDE this window:
        // a payment-plan installment on the first invoice, or a chargeback.
        pulledIn.push({
          domain: row.domain,
          caseId: row.caseId,
          amount: row.amount,
          kind: isReversalPayment(row) ? "chargeback" : "installment",
          paidOn: ownDateKey,
          soldOn: attributionDateKey,
        });
      }
      continue;
    }
    if (landedHere) {
      // Money that landed here against a deal sold in an EARLIER window —
      // an installment on an older first invoice, or a chargeback. It is not
      // this month's, and the client is not a new client this month.
      pushedOut.push({
        domain: row.domain,
        caseId: row.caseId,
        amount: row.amount,
        kind: isReversalPayment(row) ? "chargeback" : "installment",
        paidOn: ownDateKey,
        soldOn: attributionDateKey,
      });
    }
  }

  return { rows: attributed, pulledIn, pushedOut };
}

function groupSuccessfulPaymentsByCase(rows = []) {
  if (!Array.isArray(rows)) throw new TypeError("payment rows must be an array");

  const groups = new Map();
  for (const row of rows) {
    if (!isSuccessfulPayment(row)) continue;

    const domain = normalizeDomain(row.domain);
    const normalizedCaseId = normalizeCaseId(row.caseId);
    const key = casePaymentKey(domain, normalizedCaseId);
    const amountCents = amountToCents(row.amount);
    let group = groups.get(key);

    if (!group) {
      group = {
        key,
        domain,
        caseId: row.caseId,
        transactionCount: 0,
        totalCents: 0,
        initialCents: 0,
        initialTransactionCount: 0,
        positiveInitialCount: 0,
        negativeInitialCount: 0,
        positiveInitialDays: new Set(),
      };
      groups.set(key, group);
    }

    group.transactionCount += 1;
    group.totalCents += amountCents;

    if (isInitialPayment(row)) {
      group.initialTransactionCount += 1;
      group.initialCents += amountCents;
      if (amountCents > 0) {
        group.positiveInitialCount += 1;
        if (row.paymentDateKey) group.positiveInitialDays.add(String(row.paymentDateKey));
      }
      if (amountCents < 0) group.negativeInitialCount += 1;
    }
  }

  return [...groups.values()].map((group) => {
    // A DEAL IS A SALE THAT HAPPENED — counted once per case, never netted
    // away (Mickey, 2026-07-24: July "should be 34 ... Terrence Young
    // cancels himself out but 34 not 32").
    //
    // A chargeback takes the MONEY back; it does not un-sell the deal.
    // Terrence Young bought on 7/13 and charged back on 7/20: July sold 34
    // deals and collected his $1,000 back. Netting the deal count instead
    // reported 33 — and with a cross-month reversal also subtracted, 32.
    //
    // Money still nets (initialAmount below) and is attributed to the month
    // of the sale, so a month can lose dollars to a chargeback but can
    // never show fewer deals than it actually sold.
    const initialDealCount = group.positiveInitialCount > 0 ? 1 : 0;
    // SPLIT TENDER IS NOT AN EXCEPTION (Mickey, 2026-07-24: "he's a $1000
    // initial that paid maybe 2 cards or whatever to cover it"). One initial
    // settled across two cards on the SAME DAY is just how people pay — TAG
    // 394513 is $500 + $500 on 2026-07-01. Flagging it sent an operator to
    // review a non-problem.
    //
    // Positive initials on DIFFERENT days are a different animal and stay
    // flagged: TAG 336405 took $500 on 2026-06-08 and another on 2026-07-08,
    // which is an initial being paid down over time, not one purchase.
    // Requires PROOF of a single day. If the rows carry no date we cannot
    // claim split tender, so the review still fires — fail closed, never
    // suppress an exception just because the data was thin.
    const splitTender =
      group.positiveInitialCount > 1 && group.positiveInitialDays.size === 1;
    const alerts = [];
    if (group.positiveInitialCount > 1 && !splitTender) {
      alerts.push("multiple_positive_initials");
    }

    return {
      key: group.key,
      domain: group.domain,
      caseId: group.caseId,
      transactionCount: group.transactionCount,
      totalAmount: centsToAmount(group.totalCents),
      initialTransactionCount: group.initialTransactionCount,
      initialAmount: centsToAmount(group.initialCents),
      initialDealCount,
      positiveInitialCount: group.positiveInitialCount,
      negativeInitialCount: group.negativeInitialCount,
      splitTender,
      alerts,
    };
  });
}

function rollupCasePaymentGroups(groups = []) {
  if (!Array.isArray(groups)) throw new TypeError("case payment groups must be an array");

  const totals = groups.reduce(
    (sum, group) => {
      sum.caseCount += 1;
      sum.transactionCount += Number(group.transactionCount || 0);
      sum.totalCents += amountToCents(group.totalAmount || 0);
      sum.initialCents += amountToCents(group.initialAmount || 0);
      sum.initialDealCount += Number(group.initialDealCount || 0);
      if (group.alerts?.includes("multiple_positive_initials")) {
        sum.multiplePositiveInitialCases += 1;
      }
      return sum;
    },
    {
      caseCount: 0,
      transactionCount: 0,
      totalCents: 0,
      initialCents: 0,
      initialDealCount: 0,
      multiplePositiveInitialCases: 0,
    },
  );

  return {
    caseCount: totals.caseCount,
    transactionCount: totals.transactionCount,
    totalAmount: centsToAmount(totals.totalCents),
    initialAmount: centsToAmount(totals.initialCents),
    initialDealCount: totals.initialDealCount,
    multiplePositiveInitialCases: totals.multiplePositiveInitialCases,
  };
}

module.exports = {
  attributePaymentsToSaleWindow,
  casePaymentKey,
  groupSuccessfulPaymentsByCase,
  isInitialPayment,
  isReversalPayment,
  isSuccessfulPayment,
  resolveAttributionDateKey,
  isMissingDealSource,
  rawCsvDealSource,
  resolveDealSource,
  rollupCasePaymentGroups,
};
