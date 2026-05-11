"use strict";

const {
  callLedgerRepository,
  caseProfileRepository,
} = require("../../shared-repositories/src");

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function round(value, precision = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const factor = 10 ** precision;
  return Math.round(numeric * factor) / factor;
}

function getCallTimestamp(call = {}) {
  return (
    toDate(call.callStartTime) ||
    toDate(call.callEndTime) ||
    toDate(call.resolvedAt) ||
    toDate(call.createdAt) ||
    null
  );
}

function buildRecentCallEntry(call = {}) {
  return {
    telephonySessionId: call.telephonySessionId || null,
    callStartTime: toDate(call.callStartTime),
    callEndTime: toDate(call.callEndTime),
    direction: call.direction || null,
    durationSec: toNumber(call.durationSec),
    phone: call.phone || null,
    normalizedPhone: call.normalizedPhone || null,
    agentName: call.agentName || null,
    sourceName: call.sourceName || null,
    sourceChannel: call.sourceChannel || null,
    status: call.status || null,
    confidence: call.confidence || null,
    transcriptionStatus: call?.transcription?.status || call?.transcriptionStatus || null,
    transcriptAvailable:
      call?.transcriptAvailable === true ||
      Boolean(String(call?.transcription?.text || "").trim()),
    recordingAvailable:
      call?.recordingAvailable === true ||
      Boolean(
        String(call?.transcription?.recordingUri || "").trim() ||
        String(call?.recordingArchive?.driveFileId || "").trim() ||
        String(call?.recordingArchive?.driveWebViewLink || "").trim(),
      ),
    scoreOverall: toNumber(call?.callScore?.overall ?? call?.scoreOverall),
    scoreVerdict: call?.callScore?.lead_verdict || call?.scoreVerdict || null,
    scoreSummary: call?.callScore?.summary || call?.scoreSummary || null,
  };
}

function buildCaseCallRollup(calls = [], options = {}) {
  const recentLimit = Math.min(Math.max(Number(options.recentLimit) || 5, 1), 15);
  const sorted = [...calls].sort((left, right) => {
    const leftTime = getCallTimestamp(left)?.getTime() || 0;
    const rightTime = getCallTimestamp(right)?.getTime() || 0;
    return rightTime - leftTime;
  });

  const callHistorySummary = {
    totalCalls: 0,
    inboundCalls: 0,
    outboundCalls: 0,
    missedCalls: 0,
    callsOver2: 0,
    callsOver5: 0,
    uniquePhoneCount: 0,
    lastCallAt: null,
    lastInboundAt: null,
    lastOutboundAt: null,
    lastAnsweredAt: null,
    recentCalls: [],
  };
  const callScoreSummary = {
    totalScoredCalls: 0,
    totalTranscribedCalls: 0,
    averageScore: null,
    scoreCoverage: null,
    hotCount: 0,
    warmCount: 0,
    coldCount: 0,
    deadCount: 0,
    fakeCount: 0,
    latestScore: null,
    latestVerdict: null,
    latestSummary: null,
    latestScoredAt: null,
    lastTranscriptAt: null,
  };

  const phoneSet = new Set();
  const scoredCalls = [];

  for (const call of sorted) {
    const timestamp = getCallTimestamp(call);
    if (call.normalizedPhone) phoneSet.add(String(call.normalizedPhone));
    else if (call.phone) phoneSet.add(String(call.phone));

    callHistorySummary.totalCalls += 1;
    if (call.direction === "inbound") {
      callHistorySummary.inboundCalls += 1;
      if (!callHistorySummary.lastInboundAt && timestamp) {
        callHistorySummary.lastInboundAt = timestamp;
      }
    } else if (call.direction === "outbound") {
      callHistorySummary.outboundCalls += 1;
      if (!callHistorySummary.lastOutboundAt && timestamp) {
        callHistorySummary.lastOutboundAt = timestamp;
      }
    }
    if (!callHistorySummary.lastCallAt && timestamp) {
      callHistorySummary.lastCallAt = timestamp;
    }
    if (!call.missed && !callHistorySummary.lastAnsweredAt && timestamp) {
      callHistorySummary.lastAnsweredAt = timestamp;
    }
    if (call.missed) callHistorySummary.missedCalls += 1;
    if (Number(call.durationSec || 0) >= 120) callHistorySummary.callsOver2 += 1;
    if (Number(call.durationSec || 0) >= 300) callHistorySummary.callsOver5 += 1;

    if (callHistorySummary.recentCalls.length < recentLimit) {
      callHistorySummary.recentCalls.push(buildRecentCallEntry(call));
    }

    const transcriptText = String(call?.transcription?.text || "").trim();
    if (call?.transcriptAvailable || transcriptText) {
      callScoreSummary.totalTranscribedCalls += 1;
      const transcribedAt = toDate(
        call?.transcription?.transcribedAt || call?.transcribedAt,
      );
      if (
        transcribedAt &&
        (!callScoreSummary.lastTranscriptAt ||
          transcribedAt > callScoreSummary.lastTranscriptAt)
      ) {
        callScoreSummary.lastTranscriptAt = transcribedAt;
      }
    }

    if (Number.isFinite(Number(call?.callScore?.overall ?? call?.scoreOverall))) {
      scoredCalls.push(call);
      const verdict = String(
        call?.callScore?.lead_verdict || call?.scoreVerdict || "",
      )
        .trim()
        .toLowerCase();
      if (verdict === "hot") callScoreSummary.hotCount += 1;
      else if (verdict === "warm") callScoreSummary.warmCount += 1;
      else if (verdict === "cold") callScoreSummary.coldCount += 1;
      else if (verdict === "dead") callScoreSummary.deadCount += 1;
      else if (verdict === "fake") callScoreSummary.fakeCount += 1;
    }
  }

  callHistorySummary.uniquePhoneCount = phoneSet.size;
  callScoreSummary.totalScoredCalls = scoredCalls.length;
  callScoreSummary.scoreCoverage =
    callHistorySummary.totalCalls > 0
      ? round(scoredCalls.length / callHistorySummary.totalCalls)
      : null;

  if (scoredCalls.length > 0) {
    const scoreSum = scoredCalls.reduce(
      (sum, call) =>
        sum + Number((call?.callScore?.overall ?? call?.scoreOverall ?? 0)),
      0,
    );
    const latestScored = [...scoredCalls].sort((left, right) => {
      const leftTime =
        toDate(left?.callScore?.scoredAt || left?.scoredAt)?.getTime() ||
        getCallTimestamp(left)?.getTime() ||
        0;
      const rightTime =
        toDate(right?.callScore?.scoredAt || right?.scoredAt)?.getTime() ||
        getCallTimestamp(right)?.getTime() ||
        0;
      return rightTime - leftTime;
    })[0];

    callScoreSummary.averageScore = round(scoreSum / scoredCalls.length);
    callScoreSummary.latestScore = toNumber(
      latestScored?.callScore?.overall ?? latestScored?.scoreOverall,
    );
    callScoreSummary.latestVerdict =
      latestScored?.callScore?.lead_verdict || latestScored?.scoreVerdict || null;
    callScoreSummary.latestSummary =
      latestScored?.callScore?.summary || latestScored?.scoreSummary || null;
    callScoreSummary.latestScoredAt =
      toDate(latestScored?.callScore?.scoredAt || latestScored?.scoredAt) ||
      getCallTimestamp(latestScored);
  }

  return {
    callHistorySummary,
    callScoreSummary,
  };
}

async function syncCaseCallRollup(domain, caseId, options = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const numericCaseId = Number(caseId);
  if (!normalizedDomain || !Number.isFinite(numericCaseId) || numericCaseId <= 0) {
    return { skipped: true, reason: "invalid-case" };
  }

  const calls = await callLedgerRepository.listCallLedgerByCaseId(
    normalizedDomain,
    numericCaseId,
    {
      limit: Math.min(Math.max(Number(options.recentLimit) || 25, 5), 250),
    },
  );

  const rollup = buildCaseCallRollup(calls, options);
  await caseProfileRepository.upsertCaseProfile(normalizedDomain, numericCaseId, {
    callHistorySummary: rollup.callHistorySummary,
    callScoreSummary: rollup.callScoreSummary,
  });

  return {
    domain: normalizedDomain,
    caseId: numericCaseId,
    totalCalls: rollup.callHistorySummary.totalCalls,
    totalScoredCalls: rollup.callScoreSummary.totalScoredCalls,
    averageScore: rollup.callScoreSummary.averageScore,
    latestScoredAt: rollup.callScoreSummary.latestScoredAt,
  };
}

module.exports = {
  buildCaseCallRollup,
  syncCaseCallRollup,
};
