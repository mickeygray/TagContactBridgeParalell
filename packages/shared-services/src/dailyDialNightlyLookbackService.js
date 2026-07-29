"use strict";

function requireDateKey(value) {
  const dateKey = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw new TypeError("dateKey is required");
  const parsed = new Date(`${dateKey}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== dateKey) {
    throw new TypeError("dateKey is invalid");
  }
  return dateKey;
}

function nightlyLookbackDateKeys(dateKey, days = 3) {
  const selected = requireDateKey(dateKey);
  const count = Math.max(1, Math.min(14, Number(days) || 3));
  const selectedDate = new Date(`${selected}T00:00:00.000Z`);
  const keys = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(selectedDate);
    date.setUTCDate(date.getUTCDate() - offset);
    keys.push(date.toISOString().slice(0, 10));
  }
  return keys;
}

async function reconcilePhoneBurnerNightlyLookback(dateKey, options = {}) {
  const selectedDateKey = requireDateKey(dateKey);
  const dateKeys = nightlyLookbackDateKeys(
    selectedDateKey,
    options.lookbackDays == null ? 3 : options.lookbackDays,
  );
  if (options.skip === true) {
    return {
      status: "skipped",
      reason: "final-close-pass-skipped",
      dateKey: selectedDateKey,
      dateKeys,
      trigger: "nightly-retry-lookback",
    };
  }
  if (typeof options.reconcileDailyDialCalls !== "function") {
    return {
      status: "not-configured",
      reason: "daily-dial-projector-unavailable",
      dateKey: selectedDateKey,
      dateKeys,
      trigger: "nightly-retry-lookback",
    };
  }

  const dates = [];
  for (const retryDateKey of dateKeys) {
    try {
      const result = await options.reconcileDailyDialCalls({ dateKey: retryDateKey });
      dates.push({
        status: String(result?.status || "completed"),
        dateKey: retryDateKey,
        attempts: Number(result?.attempts || 0),
        reconciled: Number(result?.reconciled || 0),
        rejected: Number(result?.rejected || 0),
        agentUnmapped: Number(result?.agentUnmapped || 0),
      });
    } catch (error) {
      const errorCode = String(
        error?.code || error?.name || "daily-dial-call-log-failed",
      ).slice(0, 80);
      options.logger?.error?.("nightly-close.phoneburner_call_reconciliation_failed", {
        dateKey: retryDateKey,
        reason: errorCode,
      });
      dates.push({
        status: "failed",
        dateKey: retryDateKey,
        attempts: 0,
        reconciled: 0,
        rejected: 0,
        agentUnmapped: 0,
        errorCode,
      });
    }
  }

  const totals = dates.reduce((summary, row) => ({
    attempts: summary.attempts + row.attempts,
    reconciled: summary.reconciled + row.reconciled,
    rejected: summary.rejected + row.rejected,
    agentUnmapped: summary.agentUnmapped + row.agentUnmapped,
  }), {
    attempts: 0,
    reconciled: 0,
    rejected: 0,
    agentUnmapped: 0,
  });
  const failed = dates.some((row) => row.status === "failed");
  const partial = dates.some((row) => row.status === "partial" || row.rejected > 0);
  const firstFailure = dates.find((row) => row.status === "failed") || null;
  return {
    status: failed ? "failed" : partial ? "partial" : "completed",
    dateKey: selectedDateKey,
    dateKeys,
    trigger: "nightly-retry-lookback",
    ...totals,
    dates,
    ...(firstFailure?.errorCode ? { errorCode: firstFailure.errorCode } : {}),
  };
}

module.exports = {
  nightlyLookbackDateKeys,
  reconcilePhoneBurnerNightlyLookback,
};
