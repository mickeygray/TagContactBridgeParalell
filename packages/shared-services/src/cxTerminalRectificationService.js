"use strict";

const {
  callLogRepository,
  cxDialQueueRepository,
  cxTerminalOutboxRepository,
} = require("../../shared-repositories/src");
const { makeOutcomeIdemKey } = require("./cxBulkLoadOutcomeAdapter");

const DEFAULT_SINCE_MS = 65 * 60 * 1000;
const DEFAULT_MIN_AGE_MS = 5 * 60 * 1000;
const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 5000;
const TERMINAL_QUEUE_STATES = new Set(["completed", "cancelled", "canceled"]);

function str(value) {
  return String(value == null ? "" : value).trim();
}

function normalizeDomain(value) {
  return str(value).toUpperCase();
}

function normalizeLimit(value) {
  return Math.min(Math.max(Number(value) || DEFAULT_LIMIT, 1), MAX_LIMIT);
}

function normalizeActiveUiiSet(options = {}) {
  if (options.activeUiiSet instanceof Set) return options.activeUiiSet;
  const values = Array.isArray(options.activeUiis) ? options.activeUiis : [];
  return new Set(values.map(str).filter(Boolean));
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isRealRingcxUii(value) {
  const text = str(value);
  if (!text) return false;
  return !text.toLowerCase().startsWith("cx-synth:");
}

function normalizeRectificationWindow(input = {}) {
  const now = toDate(input.now) || new Date();
  const sinceMs = Math.max(Number(input.sinceMs) || DEFAULT_SINCE_MS, 5 * 60 * 1000);
  const minAgeMs = Math.max(Number(input.minAgeMs) || DEFAULT_MIN_AGE_MS, 30 * 1000);
  const maxAgeMs = Math.max(Number(input.maxAgeMs) || sinceMs, sinceMs);
  const to = new Date(now.getTime() - minAgeMs);
  const from = new Date(Math.max(to.getTime() - sinceMs, now.getTime() - maxAgeMs));
  return {
    now,
    from,
    to,
    minEndedBefore: to,
    sinceMs,
    minAgeMs,
    maxAgeMs,
  };
}

function buildTerminalRectificationIdemKey({ queueItemId, uii } = {}) {
  const qid = str(queueItemId);
  const identity = str(uii);
  if (!qid) return null;
  if (!isRealRingcxUii(identity)) return null;
  return makeOutcomeIdemKey({ queueItemId: qid, uii: identity, eventType: "terminal" });
}

function extractRectificationKeysFromCallLog(callLog = {}) {
  const ringcx = callLog.ringcx || {};
  return {
    domain: normalizeDomain(callLog.domain),
    caseId: Number.isFinite(Number(callLog.caseId)) ? Number(callLog.caseId) : null,
    uii: str(callLog.telephonySessionId),
    queueItemId: str(ringcx.queueItemId),
    externId: str(ringcx.externId) || null,
    agentEmail: ringcx.agentEmail || null,
    callStartTime: toDate(callLog.callStartTime),
    callEndTime: toDate(callLog.callEndTime),
  };
}

function queueState(queueItem = null) {
  return str(queueItem && queueItem.state).toLowerCase();
}

function isTerminalQueueState(queueItem = null) {
  return TERMINAL_QUEUE_STATES.has(queueState(queueItem));
}

function hasTerminalMetadata(queueItem = null, uii = null) {
  const metadata = (queueItem && queueItem.metadata) || {};
  const terminalUii = str(metadata.lastTerminalOutcomeUii);
  if (!terminalUii) return false;
  return !uii || terminalUii === str(uii);
}

function classifyRectificationEvidence(input = {}) {
  const keys = extractRectificationKeysFromCallLog(input.callLog || {});
  const activeUiiSet = input.activeUiiSet instanceof Set ? input.activeUiiSet : new Set();
  const minEndedBefore = toDate(input.minEndedBefore);
  const idemKey = buildTerminalRectificationIdemKey({
    queueItemId: keys.queueItemId,
    uii: keys.uii,
  });

  const base = {
    level: "weak",
    action: "report-only",
    outcome: null,
    reason: null,
    idemKey,
    queueItemId: keys.queueItemId || null,
    uii: keys.uii || null,
    domain: keys.domain || null,
    caseId: keys.caseId,
    agentEmail: keys.agentEmail || null,
    externId: keys.externId || null,
  };

  if (!isRealRingcxUii(keys.uii)) {
    return { ...base, reason: "missing-real-uii" };
  }
  if (!keys.queueItemId) {
    return { ...base, reason: "missing-queue-item-id" };
  }
  if (!idemKey) {
    return { ...base, reason: "missing-idem-key" };
  }
  if (input.existingOutbox) {
    return {
      ...base,
      level: "ignore",
      action: "skip",
      reason: "already-has-terminal-outbox",
    };
  }
  if (activeUiiSet.has(keys.uii)) {
    return {
      ...base,
      level: "ignore",
      action: "skip",
      reason: "still-active",
    };
  }
  if (!input.queueItem) {
    return { ...base, reason: "queue-item-not-found" };
  }
  if (isTerminalQueueState(input.queueItem)) {
    return {
      ...base,
      level: "ignore",
      action: "skip",
      reason: `queue-terminal:${queueState(input.queueItem)}`,
    };
  }
  if (hasTerminalMetadata(input.queueItem, keys.uii)) {
    return {
      ...base,
      level: "ignore",
      action: "skip",
      reason: "queue-already-has-terminal-metadata",
    };
  }

  const hasCallEnd = Boolean(keys.callEndTime);
  const owned = str(input.queueItem._id) === keys.queueItemId;
  if (!owned) {
    return { ...base, reason: "queue-item-id-mismatch" };
  }
  if (!keys.callEndTime) {
    return {
      ...base,
      level: "medium",
      action: "report-only",
      reason: "missing-call-end-time",
    };
  }
  if (minEndedBefore && keys.callEndTime > minEndedBefore) {
    return {
      ...base,
      level: "medium",
      action: "report-only",
      reason: "call-ended-too-recent",
    };
  }

  return {
    ...base,
    level: "strong",
    action: "insert-terminal-outbox",
    outcome: "did_not_connect",
    reason: "ended-cx-call-without-terminal",
  };
}

function buildTerminalOutboxPayloadFromEvidence(evidence = {}, input = {}) {
  if (evidence.action !== "insert-terminal-outbox") return null;
  const idemKey = evidence.idemKey || buildTerminalRectificationIdemKey(evidence);
  if (!idemKey) return null;
  const at = (toDate(input.at) || new Date()).toISOString();
  return {
    idemKey,
    sessionId: null,
    rail: "rectifier",
    domain: evidence.domain || null,
    queueItemId: evidence.queueItemId || null,
    uii: evidence.uii || null,
    caseId: evidence.caseId != null ? Number(evidence.caseId) : null,
    agentEmail: evidence.agentEmail || null,
    externId: evidence.externId || null,
    outcome: "did_not_connect",
    source: "hourly-terminal-rectifier",
    payload: {
      queueItemId: evidence.queueItemId || null,
      domain: evidence.domain || null,
      caseId: evidence.caseId != null ? Number(evidence.caseId) : null,
      uii: evidence.uii || null,
      externId: evidence.externId || null,
      outcome: "did_not_connect",
      source: "hourly-terminal-rectifier",
      sourceService: "cx-terminal-rectifier",
      agentEmail: evidence.agentEmail || null,
      at,
    },
  };
}

function summarizeEvidence(evidence = {}) {
  return {
    level: evidence.level,
    action: evidence.action,
    reason: evidence.reason,
    queueItemId: evidence.queueItemId || null,
    uii: evidence.uii || null,
    domain: evidence.domain || null,
    caseId: evidence.caseId,
    idemKey: evidence.idemKey || null,
  };
}

async function buildEvidenceRows(deps = {}, options = {}) {
  const callLogs = await deps.callLogRepository.listCxCallLogsForTerminalRectification({
    from: options.window.from,
    to: options.window.to,
    domains: options.domains,
    limit: options.limit,
  });
  const idemKeys = callLogs
    .map((callLog) => {
      const keys = extractRectificationKeysFromCallLog(callLog);
      return buildTerminalRectificationIdemKey(keys);
    })
    .filter(Boolean);
  const existingOutboxRows = await deps.outboxRepository.findByIdemKeys(idemKeys);
  const existingByKey = new Map(existingOutboxRows.map((row) => [str(row.idemKey), row]));
  const rows = [];

  for (const callLog of callLogs) {
    const keys = extractRectificationKeysFromCallLog(callLog);
    const queueItem = keys.queueItemId
      ? await deps.queueRepository.findQueueItemById(keys.queueItemId).catch(() => null)
      : null;
    const idemKey = buildTerminalRectificationIdemKey(keys);
    const evidence = classifyRectificationEvidence({
      callLog,
      queueItem,
      existingOutbox: idemKey ? existingByKey.get(idemKey) : null,
      activeUiiSet: options.activeUiiSet,
      minEndedBefore: options.window.minEndedBefore,
    });
    rows.push({ callLog, queueItem, evidence });
  }

  return rows;
}

function emptySummary({ dryRun, window, domains, limit } = {}) {
  return {
    ok: true,
    dryRun: Boolean(dryRun),
    window: {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      minEndedBefore: window.minEndedBefore.toISOString(),
    },
    domains: Array.isArray(domains) ? domains.map(normalizeDomain).filter(Boolean) : [],
    limit,
    scanned: 0,
    strong: 0,
    medium: 0,
    weak: 0,
    ignored: 0,
    wouldInsert: 0,
    inserted: 0,
    duplicates: 0,
    errors: [],
    reasons: {},
    samples: [],
  };
}

function addEvidenceToSummary(summary, evidence) {
  if (evidence.level === "strong") summary.strong += 1;
  else if (evidence.level === "medium") summary.medium += 1;
  else if (evidence.level === "ignore") summary.ignored += 1;
  else summary.weak += 1;
  if (evidence.action === "insert-terminal-outbox") summary.wouldInsert += 1;
  const reason = evidence.reason || "unknown";
  summary.reasons[reason] = (summary.reasons[reason] || 0) + 1;
  if (summary.samples.length < 10) summary.samples.push(summarizeEvidence(evidence));
}

function defaultDeps() {
  return {
    callLogRepository,
    queueRepository: cxDialQueueRepository,
    outboxRepository: cxTerminalOutboxRepository,
  };
}

function resolveDepsAndOptions(depsOrOptions = {}, maybeOptions = {}) {
  const hasInjectedDeps = Boolean(
    depsOrOptions.callLogRepository ||
      depsOrOptions.queueRepository ||
      depsOrOptions.outboxRepository,
  );
  return {
    deps: hasInjectedDeps ? { ...defaultDeps(), ...depsOrOptions } : defaultDeps(),
    options: hasInjectedDeps ? maybeOptions : depsOrOptions,
  };
}

function buildRunContext(options = {}) {
  const window = normalizeRectificationWindow(options);
  const limit = normalizeLimit(options.limit);
  const activeUiiSet = normalizeActiveUiiSet(options);
  return {
    ...options,
    window,
    limit,
    activeUiiSet,
  };
}

async function runCxTerminalRectification(depsOrOptions = {}, maybeOptions = {}) {
  const { deps, options } = resolveDepsAndOptions(depsOrOptions, maybeOptions);
  const dryRun = options.dryRun !== false;
  const context = buildRunContext(options);
  const summary = emptySummary({
    dryRun,
    window: context.window,
    domains: context.domains,
    limit: context.limit,
  });
  const rows = await buildEvidenceRows(deps, context);
  summary.scanned = rows.length;

  for (const row of rows) {
    const evidence = row.evidence;
    addEvidenceToSummary(summary, evidence);
    if (dryRun || evidence.action !== "insert-terminal-outbox") continue;
    const payload = buildTerminalOutboxPayloadFromEvidence(evidence, { at: context.window.now });
    if (!payload) continue;
    try {
      const inserted = await deps.outboxRepository.insertOnce(payload);
      if (inserted === null) {
        summary.duplicates += 1;
      } else {
        summary.inserted += 1;
      }
    } catch (error) {
      summary.errors.push({
        queueItemId: evidence.queueItemId,
        uii: evidence.uii,
        error: error.message || String(error),
      });
    }
  }

  return summary;
}

module.exports = {
  buildTerminalOutboxPayloadFromEvidence,
  buildTerminalRectificationIdemKey,
  classifyRectificationEvidence,
  extractRectificationKeysFromCallLog,
  isRealRingcxUii,
  normalizeRectificationWindow,
  runCxTerminalRectification,
};
