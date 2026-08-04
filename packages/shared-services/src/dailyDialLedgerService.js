"use strict";

const {
  DailyDial,
} = require("../../shared-models/src");
const {
  dailyAttemptLimitForLeadAge,
  getPacificDateKey,
  leadAgeInPacificDays,
  normalizeOutcome,
} = require("./leadDeliveryService");

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const TERMINAL_OUTCOMES = new Set([
  "dnc",
  "bad_lead",
  "appointment",
  "client",
]);

function isWeakOutcome(value) {
  return ["answered", "review"].includes(String(value || "").trim().toLowerCase());
}

// Shape guard for a locator that has ALREADY passed the exact-host policy
// upstream (recordingReferencePromotionService). PhoneBurner delivers plain
// `http:` links, so refusing them here is what kept every live recording out
// of the attempt — but the ledger still refuses anything that is not a
// bounded, credential-free, absolute locator, so a caller can never park an
// arbitrary string in this field.
//
// Each refusal names its own cause so a failure is diagnosable. NO message may
// ever interpolate the value: a thrown error is the classic way a link escapes
// into a log that no deliberate log site ever touched.
function normalizeRecordingUrl(value) {
  if (value == null || value === "") return null;
  const normalized = String(value).trim();
  if (!normalized) throw new TypeError("recordingUrl is blank");
  if (normalized.length > 2048) throw new TypeError("recordingUrl exceeds the bounded length");
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new TypeError("recordingUrl is not an absolute url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("recordingUrl protocol is not http or https");
  }
  if (parsed.username || parsed.password) throw new TypeError("recordingUrl carries embedded credentials");
  if (parsed.href.length > 2048) throw new TypeError("recordingUrl exceeds the bounded length");
  return parsed.toString();
}

// Strength, not recency, decides which locator an attempt keeps. A validated
// https locator outranks a promoted http reference; only two locators of the
// SAME strength disagreeing is a real conflict.
function recordingLocatorRank(url) {
  if (!url) return 0;
  return String(url).startsWith("https:") ? 2 : 1;
}

function snapshotLead(cadence = {}) {
  return {
    normalizedPhone: cadence.normalizedPhone || cadence.phone || null,
    firstName: cadence.firstName || cadence.metadata?.firstName || null,
    lastName: cadence.lastName || cadence.metadata?.lastName || null,
    domain: cadence.domain || null,
    caseId: cadence.caseId || null,
  };
}

async function recordDailyDialOffload({
  cadence,
  originPool,
  providerAttemptKey,
  providerCallId,
  provider = "phoneburner",
  agentId = null,
  normalizedOutcome = "review",
  connected = null,
  dailyAttemptDateKey = null,
  dailyAttemptCount = null,
  totalAttemptCount = null,
  nextContactAt = null,
  callStartedAt = null,
  callEndedAt = null,
  durationSeconds = null,
  recordingUrl = null,
  now = new Date(),
  model = DailyDial,
} = {}) {
  if (!cadence?.domain || !cadence?.caseId) throw new TypeError("cadence domain and caseId are required");
  if (!model || typeof model.findOneAndUpdate !== "function" || typeof model.findOne !== "function"
    || typeof model.updateOne !== "function") {
    throw new TypeError("DailyDial model is required");
  }
  const attemptKey = String(providerAttemptKey || "").trim();
  const callId = String(providerCallId || "").trim();
  const providerName = String(provider || "phoneburner").trim().toLowerCase();
  if (!attemptKey || !callId) throw new TypeError("provider attempt identity is required");
  if (!providerName) throw new TypeError("provider is required");
  const at = new Date(callEndedAt || now);
  if (Number.isNaN(at.getTime())) throw new TypeError("callEndedAt is invalid");
  const leadCreatedAt = new Date(cadence.createdAt || cadence.receivedAt);
  if (Number.isNaN(leadCreatedAt.getTime())) throw new TypeError("cadence createdAt is required");
  const leadAgeDays = leadAgeInPacificDays({ receivedAt: leadCreatedAt }, at);
  const allowedToday = dailyAttemptLimitForLeadAge(
    { receivedAt: leadCreatedAt },
    { now: at, maximum: 3 },
  );
  const dateKey = String(dailyAttemptDateKey || getPacificDateKey(at)).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw new TypeError("dailyAttemptDateKey is invalid");
  const canonicalCount = Number(dailyAttemptCount);
  if (!Number.isSafeInteger(canonicalCount) || canonicalCount < 1) {
    throw new TypeError("dailyAttemptCount must be a positive integer");
  }
  const canonicalTotal = Number(totalAttemptCount);
  if (!Number.isSafeInteger(canonicalTotal) || canonicalTotal < canonicalCount) {
    throw new TypeError("totalAttemptCount must cover dailyAttemptCount");
  }
  const incomingOutcome = normalizeOutcome(normalizedOutcome || "review");
  const incomingTerminal = TERMINAL_OUTCOMES.has(incomingOutcome);
  const dueAt = nextContactAt == null || nextContactAt === "" ? null : new Date(nextContactAt);
  if (dueAt && Number.isNaN(dueAt.getTime())) throw new TypeError("nextContactAt is invalid");
  const startedAt = callStartedAt == null || callStartedAt === "" ? null : new Date(callStartedAt);
  if (startedAt && Number.isNaN(startedAt.getTime())) throw new TypeError("callStartedAt is invalid");
  const seconds = durationSeconds == null || durationSeconds === "" ? null : Number(durationSeconds);
  if (seconds != null && (!Number.isFinite(seconds) || seconds < 0)) {
    throw new TypeError("durationSeconds is invalid");
  }
  const safeRecordingUrl = normalizeRecordingUrl(recordingUrl);
  const identity = { domain: String(cadence.domain).trim().toLowerCase(), caseId: String(cadence.caseId).trim(), dateKey };
  const pool = String(originPool || "unknown").trim() || "unknown";
  const normalizedAgentId = String(agentId || "").trim().toLowerCase() || null;
  const leadSnapshot = snapshotLead(cadence);

  await model.findOneAndUpdate(
    identity,
    {
      $setOnInsert: {
        ...identity,
        leadCreatedAt,
        leadAgeDays,
        allowedToday,
        contactedToday: 0,
        capped: false,
        leadReceivedAt: leadCreatedAt,
        lastOffloadAt: at,
        receivedAt: at,
        nextEligibleAt: incomingTerminal ? null : dueAt,
        callStartedAt: startedAt,
        callEndedAt: at,
        durationSeconds: seconds,
        recordingUrl: safeRecordingUrl,
        originPool: pool,
        lastAgentId: normalizedAgentId,
        lastOutcome: incomingOutcome,
        terminal: incomingTerminal,
      },
      $set: {
        cadencePersistedAt: null,
        leadSnapshot,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  const before = await model.findOne(identity).lean();
  const existingAttempt = (before?.attempts || []).find((entry) => entry.attemptKey === attemptKey) || null;
  if (existingAttempt
    && (String(existingAttempt.provider || providerName).trim().toLowerCase() !== providerName
      || String(existingAttempt.providerCallId || "").trim() !== callId)) {
    throw new Error("DailyDial provider attempt identity conflict");
  }
  const existingRecordingUrl = normalizeRecordingUrl(existingAttempt?.recordingUrl);
  const existingRecordingRank = recordingLocatorRank(existingRecordingUrl);
  const incomingRecordingRank = recordingLocatorRank(safeRecordingUrl);
  // A weaker late locator is IGNORED, not a conflict: a promoted reference may
  // never displace a validated URL already on the attempt. Two locators of the
  // same strength that disagree are a genuine contradiction and fail closed.
  if (existingRecordingUrl
    && safeRecordingUrl
    && existingRecordingUrl !== safeRecordingUrl
    && existingRecordingRank === incomingRecordingRank) {
    throw new Error("DailyDial provider attempt recording conflict");
  }
  const attemptRecordingUrl = incomingRecordingRank > existingRecordingRank
    ? safeRecordingUrl
    : (existingRecordingUrl || safeRecordingUrl || null);

  const existingOutcome = String(existingAttempt?.outcome || "").trim().toLowerCase();
  let outcome = incomingOutcome;
  if (existingOutcome && existingOutcome !== incomingOutcome) {
    if (!isWeakOutcome(existingOutcome) && isWeakOutcome(incomingOutcome)) {
      outcome = existingOutcome;
    } else if (!isWeakOutcome(existingOutcome) && !isWeakOutcome(incomingOutcome)) {
      throw new Error("DailyDial provider attempt outcome conflict");
    }
  }
  const terminal = TERMINAL_OUTCOMES.has(outcome);
  const incomingConnected = connected === true ? true : connected === false ? false : null;
  const attemptConnected = incomingConnected == null
    ? (existingAttempt?.connected === true ? true : existingAttempt?.connected === false ? false : null)
    : incomingConnected;
  const existingEndedAt = existingAttempt?.callEndedAt ? new Date(existingAttempt.callEndedAt) : null;
  const attemptEndedAt = existingEndedAt && !Number.isNaN(existingEndedAt.getTime())
    && existingEndedAt.getTime() > at.getTime() ? existingEndedAt : at;
  const existingStartedAt = existingAttempt?.callStartedAt ? new Date(existingAttempt.callStartedAt) : null;
  const attemptStartedAt = startedAt && existingStartedAt && !Number.isNaN(existingStartedAt.getTime())
    ? new Date(Math.min(startedAt.getTime(), existingStartedAt.getTime()))
    : (startedAt || (existingStartedAt && !Number.isNaN(existingStartedAt.getTime()) ? existingStartedAt : null));
  const attempt = {
    attemptKey,
    provider: providerName,
    providerCallId: callId,
    agentId: normalizedAgentId || existingAttempt?.agentId || null,
    outcome,
    connected: attemptConnected,
    callStartedAt: attemptStartedAt,
    callEndedAt: attemptEndedAt,
    durationSeconds: seconds == null ? (existingAttempt?.durationSeconds ?? null) : seconds,
    recordingUrl: attemptRecordingUrl,
    originPool: pool === "unknown" ? (existingAttempt?.originPool || pool) : pool,
    dailyAttemptCount: Math.max(canonicalCount, Number(existingAttempt?.dailyAttemptCount || 0)),
    totalAttemptCount: Math.max(canonicalTotal, Number(existingAttempt?.totalAttemptCount || 0)),
  };

  const latestSnapshotFilter = {
    ...identity,
    $or: [
      { callEndedAt: null },
      { callEndedAt: { $exists: false } },
      { callEndedAt: { $lte: at } },
    ],
  };
  if (!terminal) {
    latestSnapshotFilter.terminal = { $ne: true };
    latestSnapshotFilter.capped = { $ne: true };
  }
  const latestSnapshot = {
    leadAgeDays,
    allowedToday,
    lastOffloadAt: at,
    receivedAt: at,
    nextEligibleAt: terminal ? null : dueAt,
    callStartedAt: attemptStartedAt,
    callEndedAt: at,
    durationSeconds: attempt.durationSeconds,
    recordingUrl: attempt.recordingUrl,
    originPool: attempt.originPool,
    lastAgentId: attempt.agentId,
    lastOutcome: outcome,
  };
  if (terminal) latestSnapshot.terminal = true;
  await model.updateOne(latestSnapshotFilter, { $set: latestSnapshot });
  await model.updateOne(identity, { $max: { contactedToday: canonicalCount } });

  let attemptWrite = await model.updateOne(
    { ...identity, "attempts.attemptKey": attemptKey },
    { $set: {
      "attempts.$.providerCallId": attempt.providerCallId,
      "attempts.$.provider": attempt.provider,
      "attempts.$.agentId": attempt.agentId,
      "attempts.$.outcome": attempt.outcome,
      "attempts.$.connected": attempt.connected,
      "attempts.$.callStartedAt": attempt.callStartedAt,
      "attempts.$.callEndedAt": attempt.callEndedAt,
      "attempts.$.durationSeconds": attempt.durationSeconds,
      "attempts.$.recordingUrl": attempt.recordingUrl,
      "attempts.$.originPool": attempt.originPool,
      "attempts.$.dailyAttemptCount": attempt.dailyAttemptCount,
      "attempts.$.totalAttemptCount": attempt.totalAttemptCount,
    } },
  );
  let counted = false;
  if (Number(attemptWrite.matchedCount || 0) === 0) {
    attemptWrite = await model.updateOne(
      { ...identity, countedAttemptKeys: { $ne: attemptKey } },
      {
        $addToSet: { countedAttemptKeys: attemptKey },
        $push: { attempts: attempt },
      },
    );
    counted = Number(attemptWrite.matchedCount || 0) > 0;
    if (!counted) {
      await model.updateOne(
        { ...identity, "attempts.attemptKey": attemptKey },
        { $set: {
          "attempts.$.outcome": attempt.outcome,
          "attempts.$.provider": attempt.provider,
          "attempts.$.connected": attempt.connected,
          "attempts.$.callStartedAt": attempt.callStartedAt,
          "attempts.$.callEndedAt": attempt.callEndedAt,
          "attempts.$.durationSeconds": attempt.durationSeconds,
          "attempts.$.recordingUrl": attempt.recordingUrl,
          "attempts.$.dailyAttemptCount": attempt.dailyAttemptCount,
          "attempts.$.totalAttemptCount": attempt.totalAttemptCount,
        } },
      );
    }
  }

  const capped = terminal || attempt.dailyAttemptCount >= allowedToday || before?.capped === true;
  if (capped) {
    await model.updateOne(identity, { $set: { capped: true, nextEligibleAt: null } });
  }
  const item = await model.findOne(identity).lean();
  return { status: "recorded", item, counted };
}

module.exports = {
  TWO_HOURS_MS,
  recordDailyDialOffload,
};
