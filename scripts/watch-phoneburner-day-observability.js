#!/usr/bin/env node
"use strict";

// Read-only, PII-free observer for the controlled PhoneBurner floor.
//
// This process owns no scheduling or delivery decisions. Every interval it:
//   - reads control-plane health;
//   - reads physical PhoneBurner working-folder counts through the existing
//     read-only validator;
//   - aggregates exact callback, DailyDial, fresh-delivery, appointment, DNC,
//     daily-cap, and two-hour follow-up evidence from Mongo;
//   - appends one compact JSON object to a local JSONL file.

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

require("dotenv").config({
  path: path.resolve(__dirname, "..", ".env"),
  quiet: true,
});

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(__dirname, "..");
const RUNTIME_DIR = path.join(ROOT, "runtime", "phoneburner-day-observer");
const PID_PATH = path.join(RUNTIME_DIR, "watcher.pid");
const CURRENT_LOG_PATH = path.join(RUNTIME_DIR, "current-log-path.txt");
const HEALTH_URL = "http://127.0.0.1:5001/health";
const PACIFIC_TIME_ZONE = "America/Los_Angeles";
const RETRYABLE_OUTCOMES = new Set([
  "no_answer",
  "voicemail",
  "busy",
  "congestion",
  "intercept",
]);
const TERMINAL_OUTCOMES = new Set([
  "dnc",
  "bad_lead",
  "appointment",
  "client",
]);
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

function parseArgs(argv = process.argv.slice(2)) {
  const option = (name, fallback) => {
    const inline = argv.find((value) => value.startsWith(`--${name}=`));
    if (inline) return inline.slice(name.length + 3);
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : fallback;
  };
  const intervalMinutes = Number(option("interval-minutes", 15));
  const durationHours = Number(option("duration-hours", 4));
  if (!Number.isFinite(intervalMinutes) || intervalMinutes < 1) {
    throw new TypeError("interval-minutes must be at least 1");
  }
  if (!Number.isFinite(durationHours) || durationHours <= 0) {
    throw new TypeError("duration-hours must be positive");
  }
  return {
    once: argv.includes("--once"),
    intervalMs: Math.round(intervalMinutes * 60_000),
    durationMs: Math.round(durationHours * 60 * 60_000),
  };
}

function pacificParts(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function pacificDateKey(value = new Date()) {
  const parts = pacificParts(value);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function zonedMidnightUtc(dateKey) {
  const [year, month, day] = String(dateKey).split("-").map(Number);
  const desiredLocalMs = Date.UTC(year, month - 1, day, 0, 0, 0);
  let candidateMs = desiredLocalMs;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = pacificParts(new Date(candidateMs));
    const representedLocalMs = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    candidateMs += desiredLocalMs - representedLocalMs;
  }
  return new Date(candidateMs);
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(ordered.length - 1, Math.ceil(ordered.length * ratio) - 1);
  return ordered[Math.max(0, index)];
}

function countBy(rows, field) {
  return Object.fromEntries(
    [...rows.reduce((counts, row) => {
      const key = String(row?.[field] || "unknown").trim().toLowerCase() || "unknown";
      counts.set(key, (counts.get(key) || 0) + 1);
      return counts;
    }, new Map()).entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function safeWriteJsonLine(logPath, value) {
  fs.appendFileSync(logPath, `${JSON.stringify(value)}\n`, "utf8");
}

async function readHealth() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(HEALTH_URL, { signal: controller.signal });
    if (!response.ok) {
      return { ok: false, reason: `health-http-${response.status}` };
    }
    const payload = await response.json();
    const leadDelivery = payload?.runtimes?.leadDelivery || {};
    return {
      ok: payload?.ok === true,
      timestamp: payload?.timestamp || null,
      mongoConnected: payload?.mongo?.connected === true,
      leadDelivery: {
        running: leadDelivery.running === true,
        enabled: leadDelivery.enabled === true,
        actionsEnabled: leadDelivery.actionsEnabled === true,
        refillEnabled: leadDelivery.refillEnabled === true,
        lastTickAt: leadDelivery.lastTickAt || null,
        lastErrorCode: leadDelivery.lastErrorCode || null,
        sourceDone: leadDelivery.sourceDone === true,
        ingested: Number(leadDelivery.ingested || 0),
        accepted: Number(leadDelivery.accepted || 0),
        completed: Number(leadDelivery.completed || 0),
        freshAccepted: Number(leadDelivery.freshDispatch?.accepted || 0),
        freshLastStatus: leadDelivery.freshDispatch?.lastStatus || null,
        providerQueueDepth: Number(leadDelivery.providerPostQueueDepth || 0),
        providerInFlight: Number(leadDelivery.providerPostInFlight || 0),
        providerRateLimited: Number(leadDelivery.providerPostRateLimited || 0),
        providerCircuitOpen: leadDelivery.providerPostCircuitOpen === true,
        productivityStatus: leadDelivery.productivityRebalance?.status || null,
        productivityMoved: Number(leadDelivery.productivityRebalance?.movedCount || 0),
        dayStartStatus: leadDelivery.dayStart?.status || null,
        dayStartCompletedAt: leadDelivery.dayStart?.lastCompletedAt || null,
      },
    };
  } catch (error) {
    return {
      ok: false,
      reason: error?.name === "AbortError" ? "health-timeout" : "health-read-failed",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readPhysicalFolders() {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [path.join(ROOT, "scripts", "validate-phoneburner-lead-delivery-folders.js")],
      { cwd: ROOT, timeout: 120_000, windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    const parsed = JSON.parse(String(stdout || "").trim().split(/\r?\n/).filter(Boolean).at(-1));
    const agents = {};
    for (const result of Array.isArray(parsed.results) ? parsed.results : []) {
      const agentId = String(result.agentId || "").trim().toLowerCase();
      if (!agentId) continue;
      if (!agents[agentId]) agents[agentId] = { pool: null, consumer: null, ok: true };
      agents[agentId][result.role === "receiving" ? "consumer" : "pool"] = result.count;
      if (result.ok !== true) agents[agentId].ok = false;
    }
    return { ok: parsed.ok === true, agents };
  } catch {
    return { ok: false, reason: "folder-read-failed", agents: {} };
  }
}

async function readMongoEvidence({ now, dateKey, dayStart }) {
  const {
    DailyDial,
    LeadDeliveryAgent,
    LeadDeliveryEvent,
    LeadDeliveryItem,
  } = require("../packages/shared-models/src");

  const dayStartAgents = await LeadDeliveryAgent.find({
    "metadata.simpleDayStart.dateKey": dateKey,
    "metadata.simpleDayStart.status": "completed",
  })
    .select({ agentId: 1, "metadata.simpleDayStart": 1 })
    .lean();
  const dayStartTimes = dayStartAgents
    .map((agent) => new Date(agent?.metadata?.simpleDayStart?.lastAttemptAt))
    .filter((value) => !Number.isNaN(value.getTime()));
  const dayStartAt = dayStartTimes.length
    ? new Date(Math.min(...dayStartTimes.map((value) => value.getTime())))
    : null;
  const dayStartEnd = dayStartAt
    ? new Date(dayStartAt.getTime() + 20 * 60_000)
    : null;

  const [dailyDials, events, freshRows, dayStartHistoryRows] = await Promise.all([
    DailyDial.find({ dateKey })
      .select({
        allowedToday: 1,
        contactedToday: 1,
        capped: 1,
        receivedAt: 1,
        nextEligibleAt: 1,
        lastOutcome: 1,
        terminal: 1,
        cadencePersistedAt: 1,
        attempts: 1,
      })
      .lean(),
    LeadDeliveryEvent.find({
      provider: "phoneburner",
      receivedAt: { $gte: dayStart, $lte: now },
    })
      .select({
        eventType: 1,
        normalizedOutcome: 1,
        status: 1,
        receivedAt: 1,
        localAppliedAt: 1,
        downstreamAppliedAt: 1,
        processedAt: 1,
        lastError: 1,
      })
      .lean(),
    LeadDeliveryItem.find({
      $or: [
        {
          sourcePool: "new_today",
          receivedAt: { $gte: dayStart, $lte: now },
        },
        {
          providerAttemptHistory: {
            $elemMatch: {
              event: "accepted",
              packetId: /^fresh-/,
              occurredAt: { $gte: dayStart, $lte: now },
            },
          },
        },
      ],
    })
      .select({
        receivedAt: 1,
        state: 1,
        providerAttemptHistory: 1,
        providerAcceptedAt: 1,
      })
      .lean(),
    dayStartAt ? LeadDeliveryItem.find({
      providerAttemptHistory: {
        $elemMatch: {
          event: "accepted",
          occurredAt: { $gte: dayStartAt, $lte: dayStartEnd },
        },
      },
    })
      .select({ providerAttemptHistory: 1 })
      .lean() : [],
  ]);

  const attempts = dailyDials.flatMap((row) => (
    Array.isArray(row.attempts) ? row.attempts : []
  ));
  const outcomeCounts = countBy(attempts, "outcome");
  const cappedRows = dailyDials.filter((row) => row.capped === true);
  const cappedWithDueTime = cappedRows.filter((row) => row.nextEligibleAt != null).length;
  const overCap = dailyDials.filter(
    (row) => Number(row.contactedToday || 0) > Number(row.allowedToday || 0),
  ).length;
  const dueCallbacks = dailyDials.filter((row) => (
    row.terminal !== true
    && row.capped !== true
    && row.nextEligibleAt
    && new Date(row.nextEligibleAt).getTime() <= now.getTime()
  )).length;
  const earlyCallbackTimers = dailyDials.filter((row) => {
    if (row.terminal === true || row.capped === true || !row.nextEligibleAt || !row.receivedAt) return false;
    const delta = new Date(row.nextEligibleAt).getTime() - new Date(row.receivedAt).getTime();
    return delta < TWO_HOURS_MS - 1000;
  }).length;
  const redialableWithoutTimer = dailyDials.filter((row) => (
    row.terminal !== true
    && row.capped !== true
    && (
      RETRYABLE_OUTCOMES.has(String(row.lastOutcome || "").trim().toLowerCase())
      || String(row.lastOutcome || "").trim().toLowerCase() === "review"
    )
    && !row.nextEligibleAt
  )).length;
  const terminalTimerViolations = dailyDials.filter((row) => (
    (row.terminal === true || TERMINAL_OUTCOMES.has(String(row.lastOutcome || "").trim().toLowerCase()))
    && row.nextEligibleAt != null
  )).length;
  const uncopiedToCadence = dailyDials.filter((row) => row.cadencePersistedAt == null).length;
  const durationPresent = attempts.filter((attempt) => Number.isFinite(Number(attempt.durationSeconds))).length;

  const callDoneEvents = events.filter((event) => event.eventType === "call_done");
  const failedOrReviewEvents = events.filter(
    (event) => event.status === "failed" || event.status === "review",
  );
  const localNotDownstream = callDoneEvents.filter(
    (event) => event.localAppliedAt && !event.downstreamAppliedAt,
  );

  const freshLatencies = [];
  let freshAccepted = 0;
  let freshEligible = 0;
  let freshOverdue = 0;
  for (const row of freshRows) {
    const receivedAt = new Date(row.receivedAt);
    const history = Array.isArray(row.providerAttemptHistory) ? row.providerAttemptHistory : [];
    const acceptedTimes = history
      .filter((entry) => (
        entry.event === "accepted"
        && String(entry.packetId || "").startsWith("fresh-")
        && entry.occurredAt
        && new Date(entry.occurredAt).getTime() >= dayStart.getTime()
      ))
      .map((entry) => new Date(entry.occurredAt))
      .filter((entry) => !Number.isNaN(entry.getTime()));
    const acceptedAt = acceptedTimes.length
      ? new Date(Math.min(...acceptedTimes.map((entry) => entry.getTime())))
      : (row.providerAcceptedAt ? new Date(row.providerAcceptedAt) : null);
    if (acceptedAt && !Number.isNaN(acceptedAt.getTime())) {
      freshAccepted += 1;
      freshLatencies.push(Math.max(0, acceptedAt.getTime() - receivedAt.getTime()));
    } else if (row.state === "eligible") {
      freshEligible += 1;
      if (now.getTime() - receivedAt.getTime() > FIFTEEN_MINUTES_MS) freshOverdue += 1;
    }
  }

  const dayStartTargets = new Map(dayStartAgents.map((agent) => [
    String(agent.agentId || "").trim().toLowerCase(),
    Number(agent?.metadata?.simpleDayStart?.accepted || 0),
  ]));
  const acceptedByAgent = new Map();
  for (const row of dayStartHistoryRows) {
    for (const entry of Array.isArray(row.providerAttemptHistory) ? row.providerAttemptHistory : []) {
      const occurredAt = new Date(entry?.occurredAt);
      const packetId = String(entry?.packetId || "");
      const agentId = String(entry?.deliveryAgentId || "").trim().toLowerCase();
      if (entry?.event !== "accepted"
        || Number.isNaN(occurredAt.getTime())
        || occurredAt.getTime() < dayStartAt.getTime()
        || occurredAt.getTime() > dayStartEnd.getTime()
        || packetId.startsWith("fresh-")
        || packetId.startsWith("productivity-")
        || !dayStartTargets.has(agentId)) {
        continue;
      }
      if (!acceptedByAgent.has(agentId)) acceptedByAgent.set(agentId, []);
      acceptedByAgent.get(agentId).push(occurredAt);
    }
  }
  const countedDayStartAcceptances = [];
  for (const [agentId, target] of dayStartTargets.entries()) {
    const accepted = (acceptedByAgent.get(agentId) || [])
      .sort((left, right) => left.getTime() - right.getTime())
      .slice(0, Math.max(0, target));
    countedDayStartAcceptances.push(...accepted);
  }
  const dayStartExpected = [...dayStartTargets.values()].reduce((sum, value) => sum + value, 0);
  const dayStartCompletedAt = countedDayStartAcceptances.length === dayStartExpected
    && dayStartExpected > 0
    ? new Date(Math.max(...countedDayStartAcceptances.map((value) => value.getTime())))
    : null;

  return {
    dayStart: {
      scheduledAt: dayStartAt,
      expectedAccepted: dayStartExpected,
      observedAccepted: countedDayStartAcceptances.length,
      completedAt: dayStartCompletedAt,
      durationSeconds: dayStartCompletedAt
        ? Math.round((dayStartCompletedAt.getTime() - dayStartAt.getTime()) / 1000)
        : null,
    },
    calls: {
      uniqueLeads: dailyDials.length,
      attempts: attempts.length,
      outcomes: outcomeCounts,
      durationCaptured: durationPresent,
      durationMissing: attempts.length - durationPresent,
      uncopiedToCadence,
    },
    callbacks: {
      dueNow: dueCallbacks,
      earlyTimerViolations: earlyCallbackTimers,
      redialableWithoutTimer,
    },
    caps: {
      cappedLeads: cappedRows.length,
      overCapViolations: overCap,
      cappedWithDueTime,
      terminalTimerViolations,
    },
    appointments: {
      appointment: Number(outcomeCounts.appointment || 0),
    },
    dnc: {
      dnc: Number(outcomeCounts.dnc || 0),
      badLead: Number(outcomeCounts.bad_lead || 0),
      eventCompleted: callDoneEvents.filter(
        (event) => ["dnc", "bad_lead"].includes(event.normalizedOutcome)
          && event.status === "completed",
      ).length,
      downstreamPending: localNotDownstream.filter(
        (event) => ["dnc", "bad_lead"].includes(event.normalizedOutcome),
      ).length,
    },
    events: {
      total: events.length,
      callDone: callDoneEvents.length,
      statuses: countBy(events, "status"),
      failedOrReview: failedOrReviewEvents.length,
      localNotDownstream: localNotDownstream.length,
      errorReasons: countBy(failedOrReviewEvents, "lastError"),
    },
    fresh: {
      observed: freshRows.length,
      accepted: freshAccepted,
      eligible: freshEligible,
      overdue: freshOverdue,
      latencySeconds: {
        average: freshLatencies.length
          ? Math.round(freshLatencies.reduce((sum, value) => sum + value, 0) / freshLatencies.length / 1000)
          : null,
        p95: freshLatencies.length ? Math.round(percentile(freshLatencies, 0.95) / 1000) : null,
        maximum: freshLatencies.length ? Math.round(Math.max(...freshLatencies) / 1000) : null,
      },
    },
  };
}

function deriveAlerts({ health, folders, evidence }) {
  const alerts = [];
  if (!health.ok) alerts.push(health.reason || "control-plane-unhealthy");
  if (health.ok && (!health.mongoConnected || !health.leadDelivery.running)) {
    alerts.push("lead-delivery-runtime-unhealthy");
  }
  if (health.leadDelivery?.lastErrorCode) alerts.push("lead-delivery-error");
  if (health.leadDelivery?.providerCircuitOpen) alerts.push("provider-circuit-open");
  if (health.leadDelivery?.providerRateLimited > 0) alerts.push("provider-rate-limit-observed");
  if (!folders.ok) alerts.push("physical-folder-read-failed");
  if (evidence.fresh.overdue > 0) alerts.push("fresh-overdue");
  if (evidence.callbacks.earlyTimerViolations > 0) alerts.push("callback-timer-too-early");
  if (evidence.callbacks.redialableWithoutTimer > 0) alerts.push("redialable-call-missing-timer");
  if (evidence.caps.overCapViolations > 0) alerts.push("daily-cap-exceeded");
  if (evidence.caps.cappedWithDueTime > 0) alerts.push("capped-lead-has-due-time");
  if (evidence.caps.terminalTimerViolations > 0) alerts.push("terminal-lead-has-due-time");
  if (evidence.events.failedOrReview > 0) alerts.push("callback-event-needs-review");
  if (evidence.dnc.downstreamPending > 0) alerts.push("dnc-downstream-pending");
  return alerts;
}

async function sample(modelsReady) {
  const now = new Date();
  const dateKey = pacificDateKey(now);
  const dayStart = zonedMidnightUtc(dateKey);
  const [health, folders, evidence] = await Promise.all([
    readHealth(),
    readPhysicalFolders(),
    modelsReady.then(() => readMongoEvidence({ now, dateKey, dayStart })),
  ]);
  const result = {
    sampledAt: now.toISOString(),
    dateKey,
    health,
    folders,
    evidence,
  };
  result.alerts = deriveAlerts(result);
  return result;
}

async function main() {
  const options = parseArgs();
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  if (fs.existsSync(PID_PATH)) {
    const existingPid = Number(fs.readFileSync(PID_PATH, "utf8").trim());
    if (alive(existingPid)) {
      process.stdout.write(`${JSON.stringify({ ok: false, reason: "watcher-already-running" })}\n`);
      process.exitCode = 2;
      return;
    }
  }

  const startedAt = new Date();
  const logPath = path.join(
    RUNTIME_DIR,
    `watch-${startedAt.toISOString().replace(/[:.]/g, "-")}.jsonl`,
  );
  fs.writeFileSync(PID_PATH, String(process.pid), "utf8");
  fs.writeFileSync(CURRENT_LOG_PATH, logPath, "utf8");

  const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
  const { getSharedConfig } = require("../packages/shared-config/src");
  const modelsReady = connectMongo(getSharedConfig());
  let stopping = false;
  const cleanup = async () => {
    if (stopping) return;
    stopping = true;
    try {
      if (fs.existsSync(PID_PATH) && fs.readFileSync(PID_PATH, "utf8").trim() === String(process.pid)) {
        fs.rmSync(PID_PATH, { force: true });
      }
    } catch {
      // A stale PID file is harmless and will be replaced after liveness proof.
    }
    await disconnectMongo().catch(() => null);
  };
  process.once("SIGINT", () => cleanup().finally(() => process.exit(0)));
  process.once("SIGTERM", () => cleanup().finally(() => process.exit(0)));

  const stopAt = startedAt.getTime() + options.durationMs;
  try {
    do {
      try {
        const result = await sample(modelsReady);
        safeWriteJsonLine(logPath, result);
        process.stdout.write(`${JSON.stringify({
          ok: true,
          sampledAt: result.sampledAt,
          alerts: result.alerts,
          fresh: result.evidence.fresh,
          calls: result.evidence.calls.attempts,
        })}\n`);
      } catch {
        const failure = {
          sampledAt: new Date().toISOString(),
          ok: false,
          alerts: ["observer-sample-failed"],
        };
        safeWriteJsonLine(logPath, failure);
        process.stdout.write(`${JSON.stringify(failure)}\n`);
      }
      if (options.once || Date.now() >= stopAt) break;
      await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
    } while (!stopping);
  } finally {
    await cleanup();
  }
}

if (require.main === module) {
  main().catch(() => {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: "observer-failed" })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  deriveAlerts,
  pacificDateKey,
  parseArgs,
  percentile,
  zonedMidnightUtc,
};
