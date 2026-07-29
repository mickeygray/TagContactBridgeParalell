"use strict";

const {
  getPacificDateKey,
} = require("./leadDeliveryService");

const PHONEBURNER_PROVIDER = "phoneburner";
const CALL_LOG_SELECT = {
  domain: 1,
  telephonySessionId: 1,
  callSessionId: 1,
  callStartTime: 1,
  callEndTime: 1,
  durationSec: 1,
  direction: 1,
  provider: 1,
  providerCallId: 1,
  providerAttemptKey: 1,
  providerAgentId: 1,
  outcome: 1,
  connected: 1,
  originPool: 1,
  platform: 1,
  caseId: 1,
  caseDomain: 1,
  strategy: 1,
  confidence: 1,
  status: 1,
};

function normalizeDomain(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeProvider(value) {
  return String(value || PHONEBURNER_PROVIDER).trim().toLowerCase() || PHONEBURNER_PROVIDER;
}

function validDate(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function numericCaseId(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function increment(target, key) {
  target[key] = Number(target[key] || 0) + 1;
}

function assertDateKey(value, name) {
  const dateKey = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    throw new TypeError(`${name} must use YYYY-MM-DD`);
  }
  const parsed = new Date(`${dateKey}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== dateKey) {
    throw new TypeError(`${name} is not a calendar date`);
  }
  return dateKey;
}

function nextDateKey(dateKey) {
  const parsed = new Date(`${assertDateKey(dateKey, "dateKey")}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

function listDateKeys(from, to) {
  const first = assertDateKey(from, "from");
  const last = assertDateKey(to, "to");
  if (first > last) throw new TypeError("from must not be after to");
  const keys = [];
  for (let cursor = first; cursor <= last; cursor = nextDateKey(cursor)) {
    keys.push(cursor);
  }
  return keys;
}

function pacificMidnightUtc(dateKey) {
  const [year, month, day] = assertDateKey(dateKey, "dateKey").split("-").map(Number);
  const desiredLocalMs = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  let candidateMs = desiredLocalMs;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const renderedKey = getPacificDateKey(new Date(candidateMs));
    const [renderedYear, renderedMonth, renderedDay] = renderedKey.split("-").map(Number);
    const renderedParts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(candidateMs));
    const lookup = Object.fromEntries(renderedParts.map((part) => [part.type, part.value]));
    const renderedLocalMs = Date.UTC(
      renderedYear,
      renderedMonth - 1,
      renderedDay,
      Number(lookup.hour),
      Number(lookup.minute),
      Number(lookup.second),
      0,
    );
    const delta = desiredLocalMs - renderedLocalMs;
    candidateMs += delta;
    if (delta === 0) break;
  }
  return new Date(candidateMs);
}

function compareDailyDialRows(left, right) {
  const dateCompare = String(left?.dateKey || "").localeCompare(String(right?.dateKey || ""));
  if (dateCompare !== 0) return dateCompare;
  const leftEnded = validDate(left?.callEndedAt)?.getTime() || 0;
  const rightEnded = validDate(right?.callEndedAt)?.getTime() || 0;
  if (leftEnded !== rightEnded) return leftEnded - rightEnded;
  return String(left?._id || "").localeCompare(String(right?._id || ""));
}

function compareAttempts(left, right) {
  return (validDate(left?.callEndedAt)?.getTime() || 0)
    - (validDate(right?.callEndedAt)?.getTime() || 0);
}

function emptyDateAudit(dateKey) {
  return {
    dateKey,
    ledgerRows: 0,
    allLedgerAttempts: 0,
    attempts: 0,
    nonPhoneBurnerAttempts: 0,
    validIdentities: 0,
    projectedCallLogs: 0,
    targetRowsFound: 0,
    explicitRejects: 0,
    rejectsByReason: {},
    duplicates: 0,
    sourceDuplicates: 0,
    targetDuplicates: 0,
    missing: 0,
    mismatched: 0,
    mismatchesByReason: {},
    unexpectedProjectedCallLogs: 0,
    equalityOk: true,
  };
}

function classifyDailyDialRows({ dailyDials = [], from, to } = {}) {
  const dates = new Map(listDateKeys(from, to).map((dateKey) => [
    dateKey,
    emptyDateAudit(dateKey),
  ]));
  const expected = [];
  const seenByDate = new Map();
  const orderedRows = [...dailyDials].sort(compareDailyDialRows);

  for (const row of orderedRows) {
    const dateKey = String(row?.dateKey || "").trim();
    const day = dates.get(dateKey);
    if (!day) continue;
    day.ledgerRows += 1;
    const domain = normalizeDomain(row.domain);
    const caseId = numericCaseId(row.caseId);
    const attempts = Array.isArray(row.attempts) ? [...row.attempts].sort(compareAttempts) : [];
    if (!seenByDate.has(dateKey)) seenByDate.set(dateKey, new Set());
    const seenProviderCalls = seenByDate.get(dateKey);

    for (const attempt of attempts) {
      day.allLedgerAttempts += 1;
      const provider = normalizeProvider(attempt.provider);
      if (provider !== PHONEBURNER_PROVIDER) {
        day.nonPhoneBurnerAttempts += 1;
        continue;
      }
      day.attempts += 1;
      const providerCallId = String(attempt.providerCallId || "").trim();
      const providerAttemptKey = String(attempt.attemptKey || "").trim();
      const callEndTime = validDate(attempt.callEndedAt);
      const callStartTime = validDate(attempt.callStartedAt) || callEndTime;
      let rejectReason = null;
      if (!domain) rejectReason = "invalid-domain";
      else if (!caseId) rejectReason = "invalid-case-id";
      else if (!providerCallId || !providerAttemptKey) rejectReason = "missing-provider-identity";
      else if (!callEndTime) rejectReason = "invalid-call-end";

      const providerIdentity = `${domain}:${provider}:${providerCallId}`;
      if (!rejectReason && seenProviderCalls.has(providerIdentity)) {
        rejectReason = "duplicate-provider-call";
      }
      if (rejectReason) {
        day.explicitRejects += 1;
        increment(day.rejectsByReason, rejectReason);
        if (rejectReason === "duplicate-provider-call") day.sourceDuplicates += 1;
        continue;
      }
      seenProviderCalls.add(providerIdentity);
      day.validIdentities += 1;
      expected.push({
        dateKey,
        domain,
        caseId,
        provider,
        providerCallId,
        providerAttemptKey,
        providerAgentId: String(attempt.agentId || "").trim().toLowerCase() || null,
        telephonySessionId: `${provider}:${providerCallId}`,
        callSessionId: providerCallId,
        callStartTime,
        callEndTime,
        durationSec: attempt.durationSeconds == null ? null : Number(attempt.durationSeconds),
        outcome: String(attempt.outcome || "review").trim().toLowerCase() || "review",
        connected: attempt.connected === true ? true : attempt.connected === false ? false : null,
        originPool: String(attempt.originPool || row.originPool || "unknown").trim() || "unknown",
      });
    }
  }

  return { dates, expected };
}

function sameDate(left, right) {
  const leftDate = validDate(left);
  const rightDate = validDate(right);
  return leftDate === null && rightDate === null
    ? true
    : Boolean(leftDate && rightDate && leftDate.getTime() === rightDate.getTime());
}

function sameNumber(left, right) {
  if (left == null && right == null) return true;
  return Number(left) === Number(right);
}

function mismatchReasons(expected, actual) {
  const reasons = [];
  const check = (ok, reason) => {
    if (!ok) reasons.push(reason);
  };
  check(normalizeDomain(actual.domain) === expected.domain, "domain");
  check(String(actual.telephonySessionId || "") === expected.telephonySessionId, "session-identity");
  check(String(actual.callSessionId || "") === expected.callSessionId, "call-session-id");
  check(
    String(actual.provider || "").trim().toLowerCase() === expected.provider,
    "provider",
  );
  check(String(actual.providerCallId || "") === expected.providerCallId, "provider-call-id");
  check(String(actual.providerAttemptKey || "") === expected.providerAttemptKey, "attempt-key");
  check(
    (String(actual.providerAgentId || "").trim().toLowerCase() || null)
      === expected.providerAgentId,
    "agent-id",
  );
  check(String(actual.platform || "") === "phoneburner", "platform");
  check(String(actual.direction || "") === "outbound", "direction");
  check(String(actual.strategy || "") === "lead-delivery", "strategy");
  check(String(actual.confidence || "") === "high", "confidence");
  check(String(actual.status || "") === "resolved", "status");
  check(numericCaseId(actual.caseId) === expected.caseId, "case-id");
  check(normalizeDomain(actual.caseDomain) === expected.domain, "case-domain");
  check(sameDate(actual.callStartTime, expected.callStartTime), "call-start");
  check(sameDate(actual.callEndTime, expected.callEndTime), "call-end");
  check(sameNumber(actual.durationSec, expected.durationSec), "duration");
  check(
    String(actual.outcome || "").trim().toLowerCase() === expected.outcome,
    "outcome",
  );
  check(
    (actual.connected === true ? true : actual.connected === false ? false : null)
      === expected.connected,
    "connected",
  );
  check(
    String(actual.originPool || "").trim() === expected.originPool,
    "origin-pool",
  );
  return reasons;
}

function callLogKey(value) {
  return `${normalizeDomain(value?.domain)}:${String(value?.telephonySessionId || "").trim()}`;
}

function expectedKey(value) {
  return `${value.domain}:${value.telephonySessionId}`;
}

function finalizeAudit({ dates, expected, callLogs = [], from, to }) {
  const targetsByKey = new Map();
  const uniqueCallLogs = new Map();
  for (const [index, callLog] of callLogs.entries()) {
    const id = String(callLog?._id || "").trim()
      || `${callLogKey(callLog)}:${validDate(callLog?.callEndTime)?.toISOString() || "no-end"}:${index}`;
    if (!uniqueCallLogs.has(id)) uniqueCallLogs.set(id, callLog);
  }
  for (const callLog of uniqueCallLogs.values()) {
    const key = callLogKey(callLog);
    if (!targetsByKey.has(key)) targetsByKey.set(key, []);
    targetsByKey.get(key).push(callLog);
  }

  const expectedKeysByDate = new Map();
  for (const item of expected) {
    if (!expectedKeysByDate.has(item.dateKey)) expectedKeysByDate.set(item.dateKey, new Set());
    expectedKeysByDate.get(item.dateKey).add(expectedKey(item));
    const day = dates.get(item.dateKey);
    const targets = targetsByKey.get(expectedKey(item)) || [];
    if (!targets.length) {
      day.missing += 1;
      continue;
    }
    day.targetRowsFound += 1;
    if (targets.length > 1) {
      day.targetDuplicates += targets.length - 1;
    }
    const candidateReasons = targets.map((target) => mismatchReasons(item, target));
    const exact = candidateReasons.find((reasons) => reasons.length === 0);
    if (exact) {
      day.projectedCallLogs += 1;
      continue;
    }
    day.mismatched += 1;
    const best = candidateReasons.sort((left, right) => left.length - right.length)[0] || ["unknown"];
    for (const reason of best) increment(day.mismatchesByReason, reason);
  }

  for (const callLog of uniqueCallLogs.values()) {
    if (normalizeProvider(callLog.provider) !== PHONEBURNER_PROVIDER
      || String(callLog.strategy || "") !== "lead-delivery") {
      continue;
    }
    const callEndTime = validDate(callLog.callEndTime);
    if (!callEndTime) continue;
    const dateKey = getPacificDateKey(callEndTime);
    const day = dates.get(dateKey);
    if (!day) continue;
    if (!(expectedKeysByDate.get(dateKey) || new Set()).has(callLogKey(callLog))) {
      day.unexpectedProjectedCallLogs += 1;
    }
  }

  for (const day of dates.values()) {
    day.duplicates = day.sourceDuplicates + day.targetDuplicates;
    day.equalityOk = day.validIdentities === day.projectedCallLogs
      && day.explicitRejects === 0
      && day.duplicates === 0
      && day.missing === 0
      && day.mismatched === 0
      && day.unexpectedProjectedCallLogs === 0;
  }

  const dateRows = [...dates.values()];
  const totals = dateRows.reduce((summary, day) => {
    for (const field of [
      "ledgerRows",
      "allLedgerAttempts",
      "attempts",
      "nonPhoneBurnerAttempts",
      "validIdentities",
      "projectedCallLogs",
      "targetRowsFound",
      "explicitRejects",
      "duplicates",
      "sourceDuplicates",
      "targetDuplicates",
      "missing",
      "mismatched",
      "unexpectedProjectedCallLogs",
    ]) {
      summary[field] += Number(day[field] || 0);
    }
    for (const [reason, count] of Object.entries(day.rejectsByReason)) {
      increment(summary.rejectsByReason, reason);
      summary.rejectsByReason[reason] += Number(count) - 1;
    }
    for (const [reason, count] of Object.entries(day.mismatchesByReason)) {
      increment(summary.mismatchesByReason, reason);
      summary.mismatchesByReason[reason] += Number(count) - 1;
    }
    return summary;
  }, {
    ledgerRows: 0,
    allLedgerAttempts: 0,
    attempts: 0,
    nonPhoneBurnerAttempts: 0,
    validIdentities: 0,
    projectedCallLogs: 0,
    targetRowsFound: 0,
    explicitRejects: 0,
    rejectsByReason: {},
    duplicates: 0,
    sourceDuplicates: 0,
    targetDuplicates: 0,
    missing: 0,
    mismatched: 0,
    mismatchesByReason: {},
    unexpectedProjectedCallLogs: 0,
  });

  return {
    ok: true,
    readOnly: true,
    provider: PHONEBURNER_PROVIDER,
    source: "DailyDial.attempts",
    target: "CallLog",
    range: { from, to },
    equalityOk: dateRows.every((day) => day.equalityOk),
    totals,
    dates: dateRows,
  };
}

async function queryLean(model, filter, select, sort = null) {
  let query = model.find(filter);
  if (sort) query = query.sort(sort);
  if (select) query = query.select(select);
  return query.lean();
}

async function auditDailyDialCallLogs({
  DailyDial,
  CallLog,
  from,
  to,
  identityChunkSize = 500,
} = {}) {
  if (!DailyDial || typeof DailyDial.find !== "function") {
    throw new TypeError("DailyDial model is required");
  }
  if (!CallLog || typeof CallLog.find !== "function") {
    throw new TypeError("CallLog model is required");
  }
  const first = assertDateKey(from, "from");
  const last = assertDateKey(to, "to");
  if (first > last) throw new TypeError("from must not be after to");

  const dailyDials = await queryLean(
    DailyDial,
    { dateKey: { $gte: first, $lte: last } },
    {
      domain: 1,
      caseId: 1,
      dateKey: 1,
      callEndedAt: 1,
      originPool: 1,
      attempts: 1,
    },
    { dateKey: 1, callEndedAt: 1, _id: 1 },
  );
  const classified = classifyDailyDialRows({ dailyDials, from: first, to: last });
  const callLogs = await queryLean(
    CallLog,
    {
      provider: PHONEBURNER_PROVIDER,
      strategy: "lead-delivery",
      callEndTime: {
        $gte: pacificMidnightUtc(first),
        $lt: pacificMidnightUtc(nextDateKey(last)),
      },
    },
    CALL_LOG_SELECT,
  );

  const seenClauses = new Set();
  const clauses = [];
  for (const item of classified.expected) {
    const clauseKey = expectedKey(item);
    if (seenClauses.has(clauseKey)) continue;
    seenClauses.add(clauseKey);
    clauses.push({ domain: item.domain, telephonySessionId: item.telephonySessionId });
  }
  const chunkSize = Math.max(1, Math.min(1000, Number(identityChunkSize) || 500));
  for (let offset = 0; offset < clauses.length; offset += chunkSize) {
    const exact = await queryLean(
      CallLog,
      { $or: clauses.slice(offset, offset + chunkSize) },
      CALL_LOG_SELECT,
    );
    callLogs.push(...exact);
  }

  return finalizeAudit({
    ...classified,
    callLogs,
    from: first,
    to: last,
  });
}

module.exports = {
  auditDailyDialCallLogs,
  classifyDailyDialRows,
  finalizeAudit,
  listDateKeys,
  mismatchReasons,
  pacificMidnightUtc,
};
