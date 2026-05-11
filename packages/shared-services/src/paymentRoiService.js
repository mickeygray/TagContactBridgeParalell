"use strict";

const {
  caseProfileRepository,
  paymentLedgerRepository,
} = require("../../shared-repositories/src");
const { SourceCanonical } = require("../../shared-models/src");

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

function resolvePaymentDateKey(payment = {}) {
  const explicit = String(payment.paymentDateKey || "").trim();
  if (explicit.length >= 10) return explicit.slice(0, 10);

  const raw = payment.paymentDate;
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return raw.toISOString().slice(0, 10);
  }

  const rawText = String(raw || "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(rawText)) {
    return rawText.slice(0, 10);
  }

  const parsed = rawText ? new Date(rawText) : null;
  if (parsed && !Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }

  return "";
}

function resolveMonthKey(value) {
  if (!value) return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 7);
  }

  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}/.test(text)) {
    return text.slice(0, 7);
  }

  const parsed = text ? new Date(text) : null;
  if (parsed && !Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 7);
  }

  return "";
}

function resolveRoiPaymentSourceMeta(payment = {}, caseProfile = null) {
  const raw = payment.raw || {};
  // Source-of-truth priority:
  //   1. canonical lookup via caseProfile.sourceCanonicalId — when set,
  //      this is the authoritative attribution. Listeners pre-load it
  //      onto `caseProfile.__canonicalSource` (see `listRoiEligiblePayments`)
  //      to avoid an N+1 query at meta-resolve time.
  //   2. caseProfile.sourceName (free-text) — legacy/intake-time value.
  //      Only used when the case has no canonical reference.
  //   3. payment.raw.sourceName / payment.sourceName / raw.internalName
  //      — fallback for payments whose case isn't found.
  //
  // ABC stays visible in reports intentionally. It's the mail-house
  // catch-all and seeing a row labeled "ABC" is the operator's signal
  // that those cases need manual attribution review (the rescue
  // pipeline can't refine them automatically because they have no
  // CallRail tracker / inbound history).
  const source =
    caseProfile?.__canonicalSource ||
    caseProfile?.sourceName ||
    raw.sourceName ||
    payment.sourceName ||
    raw.internalName ||
    "Unknown";
  const explicitChannel =
    caseProfile?.__canonicalChannel ||
    caseProfile?.sourceChannel ||
    raw.sourceChannel ||
    payment.sourceChannel ||
    null;
  const normalizedSource = String(source || "").toLowerCase();
  let inferredChannel = explicitChannel;

  if (!inferredChannel) {
    if (normalizedSource.includes("bcd")) inferredChannel = "bcd";
    else if (normalizedSource.includes("affiliate")) inferredChannel = "affiliate";
    else if (
      normalizedSource.includes("lead data") ||
      normalizedSource.includes("lead post") ||
      normalizedSource.includes("ld posting") ||
      normalizedSource.includes("digital") ||
      normalizedSource.includes("a+ leads") ||
      normalizedSource.includes("ld")
    ) inferredChannel = "ld";
    else if (
      normalizedSource.includes("meta") ||
      normalizedSource.includes("facebook") ||
      normalizedSource.includes("instagram") ||
      normalizedSource.includes("tiktok") ||
      /\bfb\b/.test(normalizedSource) ||
      normalizedSource.includes("paid social") ||
      normalizedSource.includes("paid search") ||
      normalizedSource.includes("google ads") ||
      normalizedSource.includes("adwords")
    ) inferredChannel = "paid-social";
    else if (
      normalizedSource.includes("callfire") ||
      normalizedSource.includes("rvm transfer") ||
      normalizedSource.includes("dialer")
    ) inferredChannel = "dialer";
    else inferredChannel = null;
  }

  return {
    source,
    channel: inferredChannel,
  };
}

function isRoiEligiblePayment(payment = {}, caseProfile = null) {
  if (String(payment.transactionStatus || "").toUpperCase() !== "SUCCESS") {
    return false;
  }

  const paymentType = String(payment.paymentType || "").toLowerCase();
  if (paymentType === "initial") return true;
  if (paymentType !== "recurring") return false;

  const paymentMonth = resolveMonthKey(resolvePaymentDateKey(payment));
  const firstPaymentMonth = resolveMonthKey(caseProfile?.firstPaymentDate);
  return Boolean(paymentMonth && firstPaymentMonth && paymentMonth === firstPaymentMonth);
}

async function listRoiEligiblePayments(domain, filters = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const payments = await paymentLedgerRepository.listPaymentsByDateRange(
    normalizedDomain,
    {
      ...filters,
      transactionStatus: "SUCCESS",
      limit: filters.limit != null ? filters.limit : 10000,
    },
  );

  if (payments.length === 0) return [];

  const caseIds = [...new Set(
    payments.map((payment) => Number(payment.caseId)).filter(Number.isFinite),
  )];
  const caseProfiles = await caseProfileRepository.listCaseProfilesByCaseIds(
    normalizedDomain,
    caseIds,
  );

  // Pre-load canonicals referenced by these caseProfiles. The metrics
  // bucket-key resolver prefers canonical.internalName over the case's
  // free-text `sourceName` field — see `resolveRoiPaymentSourceMeta`.
  // Doing the lookup once here avoids N+1 per payment at aggregation
  // time and is the cheap fix for "rescue moved canonical, but
  // sourceName text is stale, so metrics still bucket under the old
  // value."
  const canonicalIds = [...new Set(
    caseProfiles
      .map((cp) => (cp?.sourceCanonicalId ? String(cp.sourceCanonicalId) : null))
      .filter(Boolean),
  )];
  const canonicalById = new Map();
  if (canonicalIds.length > 0) {
    const canonicals = await SourceCanonical.find({
      _id: { $in: canonicalIds },
    })
      .select({ internalName: 1, channel: 1, canonicalKey: 1 })
      .lean();
    for (const c of canonicals) {
      canonicalById.set(String(c._id), c);
    }
  }

  // Decorate each caseProfile with the resolved canonical name/channel
  // so downstream `resolveRoiPaymentSourceMeta` calls don't have to
  // re-fetch. Use `__` prefix to make it obvious these are derived
  // (not Mongoose schema fields).
  const caseProfileById = new Map();
  for (const profile of caseProfiles) {
    const key = Number(profile.caseId);
    if (profile?.sourceCanonicalId) {
      const canonical = canonicalById.get(String(profile.sourceCanonicalId));
      if (canonical) {
        profile.__canonicalSource = canonical.internalName || null;
        profile.__canonicalChannel = canonical.channel || null;
      }
    }
    caseProfileById.set(key, profile);
  }

  return payments.map((payment) => {
    const caseProfile = caseProfileById.get(Number(payment.caseId)) || null;
    return {
      payment,
      caseProfile,
      paymentDateKey: resolvePaymentDateKey(payment),
      sourceMeta: resolveRoiPaymentSourceMeta(payment, caseProfile),
      roiEligible: isRoiEligiblePayment(payment, caseProfile),
    };
  });
}

function summarizeRoiPayments(entries = []) {
  return entries.reduce(
    (summary, entry) => {
      if (!entry?.roiEligible) return summary;
      const payment = entry.payment || {};
      const amount = Number(payment.amount || 0);
      const paymentType = String(payment.paymentType || "").toLowerCase();

      summary.total += amount;
      if (paymentType === "initial") {
        summary.initialCount += 1;
        summary.initialAmount += amount;
      } else if (paymentType === "recurring") {
        summary.recurringCount += 1;
        summary.recurringAmount += amount;
      }
      return summary;
    },
    {
      initialCount: 0,
      initialAmount: 0,
      recurringCount: 0,
      recurringAmount: 0,
      total: 0,
    },
  );
}

function summarizeRoiPaymentsBySource(entries = []) {
  const rows = new Map();

  for (const entry of entries) {
    if (!entry?.roiEligible) continue;
    const payment = entry.payment || {};
    const sourceMeta = entry.sourceMeta || {};
    const source = sourceMeta.source || "Unknown";
    const amount = Number(payment.amount || 0);
    const paymentType = String(payment.paymentType || "").toLowerCase();

    if (!rows.has(source)) {
      rows.set(source, {
        _id: {
          source,
          channel: sourceMeta.channel || null,
        },
        payments: 0,
        initialPayments: 0,
        initialPaymentCount: 0,
        paymentCount: 0,
        latestPaymentDate: null,
      });
    }

    const row = rows.get(source);
    row.payments += amount;
    row.paymentCount += 1;
    if (paymentType === "initial") {
      row.initialPayments += amount;
      row.initialPaymentCount += 1;
    }

    const paymentDate = payment.paymentDate ? new Date(payment.paymentDate) : null;
    if (paymentDate && !Number.isNaN(paymentDate.getTime())) {
      if (!row.latestPaymentDate || paymentDate > row.latestPaymentDate) {
        row.latestPaymentDate = paymentDate;
      }
    }
  }

  return [...rows.values()].sort(
    (left, right) =>
      Number(right.payments || 0) - Number(left.payments || 0) ||
      String(left._id?.source || "").localeCompare(String(right._id?.source || "")),
  );
}

module.exports = {
  isRoiEligiblePayment,
  listRoiEligiblePayments,
  resolvePaymentDateKey,
  resolveRoiPaymentSourceMeta,
  summarizeRoiPayments,
  summarizeRoiPaymentsBySource,
};
