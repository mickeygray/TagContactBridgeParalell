"use strict";

function createRecordLeadDeliveryCadenceCall({ LeadCadence } = {}) {
  if (!LeadCadence || typeof LeadCadence.updateOne !== "function"
    || typeof LeadCadence.findOne !== "function"
    || typeof LeadCadence.exists !== "function") {
    throw new TypeError("LeadCadence model is required");
  }

  return async function recordLeadDeliveryCadenceCall(action = {}) {
    const caseId = Number(action.caseId);
    const domain = String(action.domain || "").trim().toUpperCase();
    const providerCallId = String(action.providerCallId || "").trim();
    const providerAttemptKey = String(action.providerAttemptKey || "").trim();
    const completedAt = new Date(action.completedAt);
    const dailyAttemptDateKey = String(action.dailyAttemptDateKey || "").trim();
    const dailyAttemptCount = Number(action.dailyAttemptCount);
    const totalAttemptCount = Number(action.totalAttemptCount);
    if (!domain || !Number.isFinite(caseId) || !providerCallId || !providerAttemptKey
      || Number.isNaN(completedAt.getTime())) {
      throw new Error("PhoneBurner cadence call identity is incomplete");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dailyAttemptDateKey)
      || !Number.isSafeInteger(dailyAttemptCount) || dailyAttemptCount < 1
      || !Number.isSafeInteger(totalAttemptCount) || totalAttemptCount < dailyAttemptCount) {
      throw new Error("PhoneBurner cadence call counter is invalid");
    }

    // Expand migration: copy the old singular exact-once fact into the new
    // append-only ledger before another attempt is allowed to replace it.
    const existing = await LeadCadence.findOne({ domain, caseId })
      .select({
        "counterCadence.lastLeadDeliveryCountedAttemptKey": 1,
        "counterCadence.lastCxDialedAt": 1,
        "lastTouched.cx": 1,
        lastContactAt: 1,
      })
      .lean();
    if (!existing) {
      return {
        ok: true,
        counted: false,
        skipped: true,
        reason: "cadence-source-missing",
      };
    }
    const legacyAttemptKey = String(
      existing?.counterCadence?.lastLeadDeliveryCountedAttemptKey || "",
    ).trim();
    if (legacyAttemptKey) {
      await LeadCadence.updateOne(
        {
          domain,
          caseId,
          "counterCadence.lastLeadDeliveryCountedAttemptKey": legacyAttemptKey,
          "counterCadence.leadDeliveryCountedAttemptKeys": { $ne: legacyAttemptKey },
        },
        { $addToSet: { "counterCadence.leadDeliveryCountedAttemptKeys": legacyAttemptKey } },
      );
    }
    const canonicalLastContactAt = [
      existing?.lastContactAt,
      existing?.counterCadence?.lastCxDialedAt,
      existing?.lastTouched?.cx,
      completedAt,
    ].reduce((latest, value) => {
      if (value == null || value === "") return latest;
      const candidate = new Date(value);
      if (Number.isNaN(candidate.getTime())) return latest;
      return !latest || candidate.getTime() > latest.getTime() ? candidate : latest;
    }, null);

    // Exact-attempt idempotency is an append-only fact. It must not depend on
    // whether this attempt is newer than the current snapshot on LeadCadence.
    const counted = await LeadCadence.updateOne(
      {
        domain,
        caseId,
        "counterCadence.lastLeadDeliveryCountedAttemptKey": { $ne: providerAttemptKey },
        "counterCadence.leadDeliveryCountedAttemptKeys": { $ne: providerAttemptKey },
      },
      {
        $addToSet: { "counterCadence.leadDeliveryCountedAttemptKeys": providerAttemptKey },
        $inc: { "cadenceCounters.cx": 1 },
        $max: { totalAttemptCount, lastContactAt: canonicalLastContactAt },
      },
    );

    // Latest-touch fields are a monotonic snapshot. A delayed historical event
    // may count above, but it can never move these fields or today's counters
    // backwards over a newer attempt.
    await LeadCadence.updateOne(
      {
        domain,
        caseId,
        $or: [
          { "counterCadence.lastCxDialedAt": { $exists: false } },
          { "counterCadence.lastCxDialedAt": null },
          { "counterCadence.lastCxDialedAt": { $lte: completedAt } },
        ],
      },
      {
        $set: {
          "counterCadence.lastLeadDeliveryCountedCallId": providerCallId,
          "counterCadence.lastLeadDeliveryCountedAttemptKey": providerAttemptKey,
          "counterCadence.lastCxDialedAt": completedAt,
          "counterCadence.cxDailyDateKey": dailyAttemptDateKey,
          "counterCadence.cxDailyCalls": dailyAttemptCount,
          "lastTouched.cx": completedAt,
        },
      },
    );

    if (Number(counted.matchedCount || 0) === 0) {
      const exists = await LeadCadence.exists({ domain, caseId });
      if (!exists) {
        return {
          ok: true,
          counted: false,
          skipped: true,
          reason: "cadence-source-missing",
        };
      }
    }
    return { ok: true, counted: Number(counted.matchedCount || 0) > 0 };
  };
}

module.exports = { createRecordLeadDeliveryCadenceCall };
