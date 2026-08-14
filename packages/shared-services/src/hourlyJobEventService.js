"use strict";

const { HourlyJobEvent } = require("../../shared-models/src");
const {
  hourlyJobEventRepository,
  reviewQueueRepository,
} = require("../../shared-repositories/src");
const { getInternalFromEmail } = require("../../shared-config/src");
const { sendPlainEmail } = require("./sendgridMailService");
const { recordWorkflowStage } = require("./workflowStateService");
const {
  addLocalDays,
  zonedTimeToUtc,
} = require("./timezoneDateWindowService");

const DEFAULT_ALERT_EMAIL = "mgray@taxadvocategroup.com";
const EMAIL_ALERT_SEVERITIES = new Set(["critical"]);

function normalizeDomain(domain) {
  return domain ? String(domain).trim().toUpperCase() : "TAG";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(Number(ms) || 0, 0)));
}

const PACIFIC_TIME_ZONE = "America/Los_Angeles";
const THREE_PASS_TIMES = Object.freeze([
  { hour: 8, minute: 0 },
  { hour: 12, minute: 0 },
  { hour: 19, minute: 50 },
]);

function pacificCalendarParts(at) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const value = (type) => Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day") };
}

/** Durable failures are revisited by the next named business pass. */
function computeNextPassRunAt(fromDate = new Date()) {
  const base = new Date(fromDate);
  const start = pacificCalendarParts(base);

  for (let offset = 0; offset < 8; offset += 1) {
    const localDay = addLocalDays(start, offset);
    const weekday = new Date(Date.UTC(localDay.year, localDay.month - 1, localDay.day)).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    for (const pass of THREE_PASS_TIMES) {
      const candidate = zonedTimeToUtc(
        { ...localDay, hour: pass.hour, minute: pass.minute, second: 0, millisecond: 0 },
        PACIFIC_TIME_ZONE,
      );
      if (candidate > base) return candidate;
    }
  }

  throw new Error("unable to find the next three-pass retry boundary");
}

function computeNextLaneRunAt(_lane = "hourly", fromDate = new Date()) {
  return computeNextPassRunAt(fromDate);
}

function buildAlertSubject(job) {
  return `[${job.domain || "TAG"}] Retry queued: ${job.eventType}${job.provideSummary ? " (summary requested)" : ""}`;
}

function buildAlertBody(job, deduped = false) {
  return [
    deduped ? "A retry job was re-observed and deduped." : "A retry job was queued for reprocessing.",
    "",
    `Lane: ${job.lane}`,
    `Target service: ${job.targetService}`,
    `Handler: ${job.handlerKey}`,
    `Resolution check: ${job.resolutionCheckKey || "none"}`,
    `Event type: ${job.eventType}`,
    `Aggregate: ${job.aggregateType}:${job.aggregateId}`,
    `Case ID: ${job.caseId != null ? job.caseId : "n/a"}`,
    `Next attempt: ${job.nextAttemptAt ? new Date(job.nextAttemptAt).toISOString() : "n/a"}`,
    `Last error: ${job.lastError || job.firstError || "n/a"}`,
    `Provide summary: ${job.provideSummary ? "yes" : "no"}`,
    job.summaryLabel ? `Summary label: ${job.summaryLabel}` : null,
  ].join("\n");
}

function shouldEmailAlert(input = {}) {
  if (input.notify === false) return false;
  if (input.notify === true) return true;

  const severity = String(input.severity || "warning").toLowerCase();
  if (EMAIL_ALERT_SEVERITIES.has(severity)) return true;

  const priority = Number(input.priority);
  if (Number.isFinite(priority) && priority >= 90) return true;

  return false;
}

async function notifyHourlyJobAlert(job, options = {}) {
  const domain = normalizeDomain(job.domain);
  const toEmail = options.toEmail || DEFAULT_ALERT_EMAIL;
  // Internal job-failure alert — sent from the Parallel-internal
  // sender so replies hit a human inbox, not the per-domain branded
  // `team@` mailbox.
  try {
    await sendPlainEmail(domain, {
      personalizations: [{ to: [{ email: toEmail }] }],
      from: { email: getInternalFromEmail(), name: `${domain} Parallel` },
      subject: buildAlertSubject(job),
      content: [
        {
          type: "text/plain",
          value: buildAlertBody(job, Boolean(options.deduped)),
        },
      ],
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function emitHourlyJobEvent(input = {}) {
  const lane = input.lane === "nightly" ? "nightly" : "hourly";
  const domain = normalizeDomain(input.domain);
  const happenedAt = input.happenedAt ? new Date(input.happenedAt) : new Date();
  const nextAttemptAt = input.nextAttemptAt
    ? new Date(input.nextAttemptAt)
    // Newly emitted work is immediately due. If it was emitted by morning or
    // night, that same pass's later retry-drain step can handle it. Work born
    // between passes simply waits durably until the next pass; no poller runs.
    : happenedAt;

  const doc = {
    lane,
    eventType: input.eventType,
    targetService: input.targetService,
    handlerKey: input.handlerKey,
    domain,
    aggregateType: input.aggregateType,
    aggregateId: String(input.aggregateId),
    caseId: input.caseId != null ? Number(input.caseId) : null,
    payload: input.payload || {},
    resolutionCheckKey: input.resolutionCheckKey || null,
    resolutionContext: input.resolutionContext || null,
    dedupeKey: input.dedupeKey || null,
    sourceEventId: input.sourceEventId ? String(input.sourceEventId) : null,
    sourceWorkflowId: input.sourceWorkflowId ? String(input.sourceWorkflowId) : null,
    emittedBy: input.emittedBy || input.sourceService || "control-plane",
    priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : 50,
    immediateRetryAttempts: Math.max(Number(input.immediateRetryAttempts) || 0, 0),
    immediateRetryDelayMs: Math.max(Number(input.immediateRetryDelayMs) || 0, 0),
    immediateRetryUsed: Math.max(Number(input.immediateRetryUsed) || 0, 0),
    provideSummary: Boolean(input.provideSummary),
    summaryLabel: input.summaryLabel || null,
    status: "pending",
    maxAttempts: Number.isFinite(Number(input.maxAttempts)) ? Number(input.maxAttempts) : 12,
    nextAttemptAt,
    firstError: input.firstError || input.lastError || null,
    lastError: input.lastError || input.firstError || null,
    lastErrorAt: input.lastError || input.firstError ? new Date() : null,
    notes: input.notes || null,
  };

  if (doc.dedupeKey) {
    const existing = await hourlyJobEventRepository.findHourlyJobEventByDedupeKey(
      lane,
      doc.dedupeKey,
    );
    if (existing) {
      return { job: existing, deduped: true };
    }
  }

  const job = await hourlyJobEventRepository.createHourlyJobEvent(doc);

  await Promise.allSettled([
    recordWorkflowStage({
      domain,
      family: "retry-job",
      subtype: lane,
      stage: "requested",
      aggregateType: "hourly-job-event",
      aggregateId: String(job._id),
      caseId: doc.caseId,
      sourceService: doc.emittedBy,
      status: "warning",
      title: `Retry queued for ${doc.eventType}`,
      summary: `Will retry at ${nextAttemptAt.toISOString()}`,
      payload: {
        eventType: doc.eventType,
        targetService: doc.targetService,
        handlerKey: doc.handlerKey,
        resolutionCheckKey: doc.resolutionCheckKey,
        aggregateType: doc.aggregateType,
        aggregateId: doc.aggregateId,
        immediateRetryAttempts: doc.immediateRetryAttempts,
        immediateRetryDelayMs: doc.immediateRetryDelayMs,
        immediateRetryUsed: doc.immediateRetryUsed,
        provideSummary: doc.provideSummary,
        summaryLabel: doc.summaryLabel,
      },
    }),
    reviewQueueRepository.createReviewQueueItem({
      domain,
      caseId: doc.caseId,
      sourceService: doc.emittedBy,
      workflow: "retry-jobs",
      category: lane,
      severity: input.severity || "warning",
      title: input.alertTitle || `Retry queued: ${doc.eventType}`,
      summary: input.alertSummary || `Trying again at ${nextAttemptAt.toISOString()}`,
      happenedAt: input.happenedAt ? new Date(input.happenedAt) : new Date(),
      payload: {
        hourlyJobEventId: String(job._id),
        eventType: doc.eventType,
        targetService: doc.targetService,
        handlerKey: doc.handlerKey,
        resolutionCheckKey: doc.resolutionCheckKey,
        aggregateType: doc.aggregateType,
        aggregateId: doc.aggregateId,
        nextAttemptAt,
        immediateRetryAttempts: doc.immediateRetryAttempts,
        immediateRetryDelayMs: doc.immediateRetryDelayMs,
        immediateRetryUsed: doc.immediateRetryUsed,
        provideSummary: doc.provideSummary,
        summaryLabel: doc.summaryLabel,
      },
      tags: ["retry-job", lane, doc.targetService].filter(Boolean),
    }),
    shouldEmailAlert(input) ? notifyHourlyJobAlert(job, input.notifyOptions || {}) : Promise.resolve(null),
  ]);

  return { job, deduped: false };
}

async function listHourlyJobEvents(filters = {}) {
  return hourlyJobEventRepository.listHourlyJobEvents(filters);
}

async function claimNextHourlyJobEvent(workerName, options = {}) {
  const now = new Date();
  const lane = options.lane === "nightly" ? "nightly" : "hourly";
  const allowedHandlerKeys = Array.isArray(options.handlerKeys)
    ? options.handlerKeys.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  const excludedHandlerKeys = Array.isArray(options.excludedHandlerKeys)
    ? options.excludedHandlerKeys.map((value) => String(value || "").trim()).filter(Boolean)
    : [];

  const query = {
    lane,
    status: { $in: ["pending", "failed"] },
    nextAttemptAt: { $lte: now },
  };
  if (allowedHandlerKeys.length > 0) {
    query.handlerKey = {
      $in: allowedHandlerKeys.filter((key) => !excludedHandlerKeys.includes(key)),
    };
  } else if (excludedHandlerKeys.length > 0) {
    query.handlerKey = { $nin: excludedHandlerKeys };
  }

  return HourlyJobEvent.findOneAndUpdate(
    query,
    {
      $set: {
        status: "processing",
        claimedBy: workerName,
        claimedAt: now,
      },
      $inc: { attemptCount: 1 },
      $push: {
        attempts: {
          worker: workerName,
          status: "processing",
          startedAt: now,
        },
      },
    },
    {
      sort: { priority: -1, nextAttemptAt: 1, createdAt: 1 },
      new: true,
    },
  );
}

async function markHourlyJobCompleted(jobId, workerName, result = null) {
  const now = new Date();
  return HourlyJobEvent.findOneAndUpdate(
    {
      _id: jobId,
      status: "processing",
    },
    {
      $set: {
        status: "completed",
        completedAt: now,
        claimedBy: workerName,
        result,
        "attempts.$[attempt].status": "completed",
        "attempts.$[attempt].finishedAt": now,
      },
    },
    {
      new: true,
      arrayFilters: [
        {
          "attempt.worker": workerName,
          "attempt.status": "processing",
          "attempt.finishedAt": { $exists: false },
        },
      ],
    },
  );
}

async function markHourlyJobFailed(jobId, workerName, error, options = {}) {
  const now = new Date();
  const job = await hourlyJobEventRepository.findHourlyJobEventById(jobId);
  if (!job) return null;

  const exhausted = job.attemptCount >= (options.maxAttempts || job.maxAttempts || 12);
  const nextStatus = exhausted ? "dead-letter" : "failed";
  const nextAttemptAt = exhausted
    ? null
    : options.nextAttemptAt
      ? new Date(options.nextAttemptAt)
      : computeNextLaneRunAt(job.lane, now);

  return HourlyJobEvent.findOneAndUpdate(
    {
      _id: jobId,
      status: "processing",
      attemptCount: job.attemptCount,
    },
    {
      $set: {
        status: nextStatus,
        claimedBy: workerName,
        lastError: error?.message || String(error || "Unknown retry failure"),
        lastErrorAt: now,
        nextAttemptAt,
        "attempts.$[attempt].status": nextStatus,
        "attempts.$[attempt].finishedAt": now,
        "attempts.$[attempt].error": error?.message || String(error || "Unknown retry failure"),
      },
    },
    {
      new: true,
      arrayFilters: [
        {
          "attempt.worker": workerName,
          "attempt.status": "processing",
          "attempt.finishedAt": { $exists: false },
        },
      ],
    },
  );
}

async function runWithImmediateRetries(task, options = {}) {
  const maxAttempts = Math.max(Number(options.immediateRetryAttempts) || 0, 0) + 1;
  const delayMs = Math.max(Number(options.immediateRetryDelayMs) || 0, 0);
  let lastError = null;
  let attemptsUsed = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await task(attempt);
      return {
        ok: true,
        result,
        attemptsUsed,
      };
    } catch (error) {
      lastError = error;
      const retryAllowed = typeof options.shouldRetry === "function"
        ? options.shouldRetry(error, attempt) !== false
        : true;
      if (attempt >= maxAttempts || !retryAllowed) {
        break;
      }
      attemptsUsed += 1;
      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
  }

  return {
    ok: false,
    error: lastError,
    attemptsUsed,
  };
}

module.exports = {
  DEFAULT_ALERT_EMAIL,
  EMAIL_ALERT_SEVERITIES,
  claimNextHourlyJobEvent,
  computeNextLaneRunAt,
  computeNextPassRunAt,
  emitHourlyJobEvent,
  listHourlyJobEvents,
  markHourlyJobCompleted,
  markHourlyJobFailed,
  notifyHourlyJobAlert,
  runWithImmediateRetries,
  shouldEmailAlert,
};
