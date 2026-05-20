#!/usr/bin/env node
"use strict";

// Read-only smoke runner for the Linux staging box.
//
// Goal:
//   Exercise the heavy hourly/nightly code paths and the external APIs they rely
//   on, while making production data mutation impossible. This script writes only
//   local receipt JSON under runtime/linux-heavy-api-smoke/.
//
// What it DOES:
//   - Connects to the configured Parallel Mongo database.
//   - Installs a Mongo write guard unless --allow-db-writes is supplied.
//   - Runs hourly-style database counters and the read-only hourly call ledger
//     preview for inbound/outbound calls.
//   - Probes Logics read APIs from one recent case per domain.
//   - Probes RingCX read/list APIs and, optionally, one recording metadata poll.
//   - Builds the grouped nightly close payload with email/final-close/payment
//     mutation paths disabled.
//
// What it DOES NOT do by default:
//   - Send email.
//   - Queue leads.
//   - Dial.
//   - Change Logics status.
//   - Update payment ledgers, attribution, queues, or any Mongo collection.

require("dotenv").config({
  path: require("path").resolve(__dirname, "..", ".env"),
});

const fs = require("fs");
const os = require("os");
const path = require("path");
const mongoose = require("mongoose");

function readFlag(argv, name) {
  const prefixed = argv.find((arg) => arg.startsWith(`${name}=`));
  if (prefixed) return prefixed.slice(name.length + 1);
  const index = argv.indexOf(name);
  if (index >= 0 && index < argv.length - 1) return argv[index + 1];
  return null;
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function parseDomains(value) {
  const raw = value || "TAG,WYNN";
  return [...new Set(
    String(raw)
      .split(",")
      .map((item) => item.trim().toUpperCase())
      .filter(Boolean),
  )];
}

function normalizeBool(value) {
  const raw = String(value || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function formatDateKey(date = new Date(), timeZone = "America/Los_Angeles") {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function yesterdayInTz(timeZone = "America/Los_Angeles") {
  return formatDateKey(new Date(Date.now() - 24 * 60 * 60 * 1000), timeZone);
}

function installDbWriteGuard({ enabled = true } = {}) {
  if (!enabled) {
    return { enabled: false, patched: [] };
  }

  const writeMethods = [
    "bulkWrite",
    "deleteMany",
    "deleteOne",
    "findOneAndDelete",
    "findOneAndReplace",
    "findOneAndUpdate",
    "insertMany",
    "insertOne",
    "replaceOne",
    "save",
    "updateMany",
    "updateOne",
  ];
  const patched = [];

  function patchPrototype(label, prototype) {
    if (!prototype) return;
    for (const method of writeMethods) {
      if (typeof prototype[method] !== "function") continue;
      const original = prototype[method];
      if (original.__parallelSmokeWriteGuard) continue;
      const guarded = function guardedMongoWrite(...args) {
        const error = new Error(
          `Blocked Mongo write during linux-heavy-api-smoke: ${label}.${method}`,
        );
        error.code = "LINUX_HEAVY_API_SMOKE_WRITE_BLOCKED";
        error.method = `${label}.${method}`;
        error.argsPreview = args.slice(0, 2);
        throw error;
      };
      guarded.__parallelSmokeWriteGuard = true;
      guarded.__original = original;
      prototype[method] = guarded;
      patched.push(`${label}.${method}`);
    }
  }

  patchPrototype("mongoose.Collection", mongoose.Collection && mongoose.Collection.prototype);
  try {
    const mongodb = require("mongodb");
    patchPrototype("mongodb.Collection", mongodb.Collection && mongodb.Collection.prototype);
  } catch {
    // The direct driver prototype is best-effort. Mongoose collection guarding
    // is enough for the app's normal repository path.
  }

  return { enabled: true, patched };
}

const argv = process.argv.slice(2);
const writeGuard = installDbWriteGuard({
  enabled: !hasFlag(argv, "--allow-db-writes"),
});

const { connectMongo, disconnectMongo, getMongoState } = require("../packages/event-core/src");
const { getSharedConfig } = require("../packages/shared-config/src");
const {
  CallLog,
  CaseProfile,
  CxDialQueue,
  HourlyJobEvent,
  LeadCadence,
  MasterProspectIndex,
} = require("../packages/shared-models/src");
const { createRingcxVoiceClient } = require("../packages/shared-integrations/src");
const { previewHourlyCallLedger } = require("../packages/shared-services/src/hourlyCallLedgerPreviewService");
const { createLogicsFacade } = require("../packages/shared-services/src/logicsFacadeService");
const { runGroupedNightlyClose } = require("../packages/shared-services/src/nightlyCloseService");

function log(line = "") {
  // eslint-disable-next-line no-console
  console.log(line);
}

function logHeader(line) {
  log(`\n== ${line} ==`);
}

function logKv(key, value) {
  log(`  ${String(key).padEnd(32, " ")} ${value}`);
}

function errorToObject(error) {
  return {
    name: error?.name || "Error",
    code: error?.code || error?.details?.code || null,
    status: error?.status || error?.details?.status || error?.details?.responseStatus || null,
    message: error?.message || String(error),
    retryAfter: error?.details?.retryAfter || error?.details?.rateLimitHeaders?.retryAfter || null,
    responseBody: error?.details?.responseBody || null,
  };
}

async function safeStep(name, fn) {
  const startedAt = new Date();
  const startMs = Date.now();
  try {
    const result = await fn();
    return {
      name,
      ok: true,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startMs,
      result,
    };
  } catch (error) {
    return {
      name,
      ok: false,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startMs,
      error: errorToObject(error),
    };
  }
}

function pick(object, keys) {
  const out = {};
  for (const key of keys) {
    if (object && object[key] !== undefined && object[key] !== null) {
      out[key] = object[key];
    }
  }
  return out;
}

function asArrayResponse(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const key of ["records", "items", "data", "rows", "result", "results", "campaigns", "dialGroups", "agents", "activeCalls", "interactions", "segments"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

function summarizeEntity(row) {
  if (!row || typeof row !== "object") return row;
  return pick(row, [
    "id",
    "dialGroupId",
    "campaignId",
    "agentId",
    "agentGroupId",
    "name",
    "campaignName",
    "dialGroupName",
    "username",
    "email",
    "state",
    "status",
    "active",
    "isActive",
    "uii",
    "ani",
    "dnis",
    "dialogId",
    "segmentId",
    "segmentStartTime",
    "segmentEndTime",
  ]);
}

function summarizeApiList(value, sampleSize = 5) {
  const rows = asArrayResponse(value);
  return {
    count: rows.length,
    responseKeys: value && typeof value === "object" ? Object.keys(value).slice(0, 20) : [],
    sample: rows.slice(0, sampleSize).map(summarizeEntity),
  };
}

function summarizePreview(preview) {
  return {
    previewedAt: preview.previewedAt,
    summary: preview.summary,
    domains: (preview.domains || []).map((domain) => ({
      domain: domain.domain,
      window: domain.window,
      scan: domain.scan,
      totals: domain.totals,
      unmatchedSample: (domain.unmatched || []).slice(0, 5),
      operationSample: (domain.operations || []).slice(0, 5).map((operation) => ({
        collection: operation.collection,
        filter: operation.filter,
        meta: operation.meta,
        setKeys: Object.keys(operation.update?.$set || {}).slice(0, 25),
      })),
      errors: (domain.errors || []).slice(0, 10),
    })),
  };
}

function summarizeNightly(result) {
  const payload = result?.payload || {};
  const management = payload.managementSnapshot || {};
  const monthToDate = payload.monthToDate || {};
  const vendor = payload.vendorReport || {};
  return {
    date: payload.date || null,
    domains: payload.domains || null,
    vendorDomain: payload.vendorDomain || null,
    finalClose: result?.finalClose || null,
    emailResults: result?.results || null,
    managementSnapshot: {
      leads: management.leads || null,
      calls: management.calls || null,
      payments: management.payments || null,
      spend: management.spend || null,
      alerts: management.alerts || null,
    },
    monthToDate: {
      leads: monthToDate.leads || null,
      calls: monthToDate.calls || null,
      payments: monthToDate.payments || null,
      spend: monthToDate.spend || null,
    },
    bugWrap: {
      unresolvedCount: payload.bugWrap?.unresolvedCount || 0,
      prunedResolved: payload.bugWrap?.prunedResolved || 0,
      unresolvedSample: (payload.bugWrap?.unresolved || []).slice(0, 10).map((job) => ({
        id: job?._id ? String(job._id) : null,
        lane: job?.lane || null,
        eventType: job?.eventType || null,
        handlerKey: job?.handlerKey || null,
        domain: job?.domain || null,
        aggregateType: job?.aggregateType || null,
        aggregateId: job?.aggregateId || null,
        caseId: job?.caseId || null,
        status: job?.status || null,
        attemptCount: job?.attemptCount || 0,
        maxAttempts: job?.maxAttempts || 0,
        nextAttemptAt: job?.nextAttemptAt || null,
        firstError: job?.firstError || null,
        lastError: job?.lastError || null,
        createdAt: job?.createdAt || null,
        updatedAt: job?.updatedAt || null,
      })),
    },
    vendorReport: {
      totals: vendor.totals || null,
      rows: Array.isArray(vendor.rows) ? vendor.rows.length : 0,
      families: Array.isArray(vendor.families) ? vendor.families.length : 0,
      trackedFamilies: vendor.trackedFamilies || [],
      attributionReview: vendor.attributionReview || null,
    },
    rowCounts: {
      vendorLeadRows: (payload.vendorLeadRows || []).length,
      vendorCallRows: (payload.vendorCallRows || []).length,
      vendorOutcomeRows: (payload.vendorOutcomeRows || []).length,
      dealsByCase: (payload.dealsByCase || []).length,
      dealsBySource: (payload.dealsBySource || []).length,
      spendByChannel: (payload.spendByChannel || []).length,
      todaysAlerts: (payload.todaysAlerts || []).length,
      todaysCalls: (payload.todaysCalls || []).length,
      openServiceAlerts: (payload.openServiceAlerts || []).length,
      mtdRoiBySource: (payload.mtdRoiBySource || []).length,
    },
    perDomain: (payload.perDomain || []).map((entry) => ({
      domain: entry.domain,
      leads: entry.managementSnapshot?.leads?.total || 0,
      calls: entry.managementSnapshot?.calls?.total || 0,
      spend: entry.managementSnapshot?.spend?.total || 0,
      moneyIn: entry.managementSnapshot?.payments?.totalAmount || 0,
      deals: (entry.dealsByCase || []).length,
      redlines: (entry.todaysAlerts || []).length,
      hourlyUnresolved: entry.bugWrap?.unresolvedCount || 0,
    })),
  };
}

function summarizeDbAggregation(rows, key = "_id") {
  return (rows || []).map((row) => ({
    key: row[key],
    count: row.count,
  }));
}

async function databaseCounters(domains, from, to) {
  const domainMatch = { $in: domains };
  const [callCounts, queueCounts, hourlyCounts, cadenceCounts, prospectCounts, caseCounts] = await Promise.all([
    CallLog.aggregate([
      {
        $match: {
          domain: domainMatch,
          callStartTime: { $gte: from, $lte: to },
        },
      },
      {
        $group: {
          _id: { domain: "$domain", direction: "$direction", status: "$status" },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.domain": 1, "_id.direction": 1, "_id.status": 1 } },
    ]),
    CxDialQueue.aggregate([
      { $match: { domain: domainMatch } },
      {
        $group: {
          _id: { domain: "$domain", state: "$state", family: "$queueFamily" },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.domain": 1, "_id.state": 1, "_id.family": 1 } },
    ]),
    HourlyJobEvent.aggregate([
      { $match: { domain: domainMatch } },
      {
        $group: {
          _id: { domain: "$domain", status: "$status", type: "$type" },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.domain": 1, "_id.status": 1, "_id.type": 1 } },
      { $limit: 100 },
    ]),
    LeadCadence.aggregate([
      { $match: { domain: domainMatch } },
      {
        $group: {
          _id: { domain: "$domain", status: "$status" },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.domain": 1, "_id.status": 1 } },
    ]),
    MasterProspectIndex.aggregate([
      { $match: { domain: domainMatch } },
      { $group: { _id: "$domain", count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    CaseProfile.aggregate([
      { $match: { domain: domainMatch } },
      { $group: { _id: "$domain", count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
  ]);

  return {
    window: { from: from.toISOString(), to: to.toISOString() },
    callLogsRecent: callCounts,
    cxDialQueue: queueCounts,
    hourlyJobEvents: hourlyCounts,
    leadCadence: cadenceCounts,
    masterProspects: summarizeDbAggregation(prospectCounts),
    caseProfiles: summarizeDbAggregation(caseCounts),
  };
}

async function logicsReadProbe(domains) {
  const out = [];
  for (const domain of domains) {
    const sample = await CaseProfile.findOne({
      domain,
      caseId: { $ne: null },
    })
      .sort({ updatedAt: -1 })
      .select({ domain: 1, caseId: 1, statusName: 1, sourceName: 1, updatedAt: 1 })
      .lean();

    if (!sample?.caseId) {
      out.push({ domain, skipped: true, reason: "no-caseprofile-sample" });
      continue;
    }

    const facade = createLogicsFacade(domain);
    const caseId = Number(sample.caseId);
    const [caseInfo, activities, payments, billing] = await Promise.all([
      facade.fetchCaseInfo(caseId),
      facade.fetchActivities(caseId).catch((error) => ({ error: error.message })),
      facade.fetchPayments(caseId).catch((error) => ({ error: error.message })),
      facade.fetchBillingSummary(caseId).catch((error) => ({ error: error.message })),
    ]);

    out.push({
      domain,
      caseId,
      sample,
      caseInfo: {
        ok: caseInfo?.ok === true,
        status: caseInfo?.status ?? null,
        error: caseInfo?.error || null,
        dataKeys: caseInfo?.data && typeof caseInfo.data === "object"
          ? Object.keys(caseInfo.data).slice(0, 30)
          : [],
      },
      activities: Array.isArray(activities)
        ? { count: activities.length, sample: activities.slice(0, 3).map((item) => pick(item, ["ActivityID", "Type", "Subject", "CreatedDate", "DateCreated"])) }
        : activities,
      payments: Array.isArray(payments)
        ? { count: payments.length, sample: payments.slice(0, 3).map((item) => pick(item, ["PaymentID", "Amount", "PaymentDate", "Status", "Type"])) }
        : payments,
      billing: billing && typeof billing === "object"
        ? { keys: Object.keys(billing).slice(0, 30) }
        : { valueType: typeof billing },
    });
  }
  return out;
}

function resolveDialGroupId() {
  return (
    process.env.RINGCX_VOICE_DEFAULT_DIAL_GROUP_ID
    || process.env.RINGCX_AGENT_ROUTE_63730035004_DIAL_GROUP_ID
    || process.env.RINGCX_AGENT_ROUTE_DEFAULT_DIAL_GROUP_ID
    || null
  );
}

function resolveAgentGroupId() {
  return (
    process.env.RINGCX_VOICE_DEFAULT_AGENT_GROUP_ID
    || process.env.RINGCX_AGENT_ROUTE_63730035004_AGENT_GROUP_ID
    || process.env.RINGCX_AGENT_ROUTE_DEFAULT_AGENT_GROUP_ID
    || null
  );
}

function buildRecordingMetadataWindow(now = new Date()) {
  // RingCX recordings can lag after call end. Polling a finished window ending
  // 20 minutes ago avoids hammering fresh calls that may not be indexed yet.
  const end = new Date(now.getTime() - 20 * 60 * 1000);
  const start = new Date(end.getTime() - 30 * 60 * 1000);
  return { start, end };
}

async function ringcxReadProbe({ includeRecordingMetadata = true } = {}) {
  if (normalizeBool(process.env.PARALLEL_RC_SUSPENDED)) {
    return { skipped: true, reason: "PARALLEL_RC_SUSPENDED is enabled" };
  }

  const client = createRingcxVoiceClient();
  const dialGroupId = resolveDialGroupId();
  const agentGroupId = resolveAgentGroupId();
  const out = {
    config: {
      accountId: client.config.accountId,
      defaultDialGroupId: client.config.defaultDialGroupId || null,
      selectedDialGroupId: dialGroupId,
      defaultCampaignId: client.config.defaultCampaignId || null,
      defaultAgentGroupId: client.config.defaultAgentGroupId || null,
      selectedAgentGroupId: agentGroupId,
    },
    dialGroups: await safeStep("ringcx.listDialGroups", async () =>
      summarizeApiList(await client.listDialGroups())),
    campaigns: dialGroupId
      ? await safeStep("ringcx.listCampaigns", async () =>
          summarizeApiList(await client.listCampaigns(dialGroupId)))
      : { ok: false, skipped: true, reason: "no-dial-group-id" },
    agentGroups: await safeStep("ringcx.listAgentGroups", async () =>
      summarizeApiList(await client.listAgentGroups())),
    agents: agentGroupId
      ? await safeStep("ringcx.listAgents", async () =>
          summarizeApiList(await client.listAgents(agentGroupId)))
      : { ok: false, skipped: true, reason: "no-agent-group-id" },
    activeCalls: await safeStep("ringcx.listActiveCalls", async () =>
      summarizeApiList(await client.listActiveCalls({
        product: "ACCOUNT",
        productId: client.config.accountId,
      }))),
  };

  if (includeRecordingMetadata) {
    const window = buildRecordingMetadataWindow();
    out.recordingMetadata = await safeStep("ringcx.fetchInteractionMetadata", async () => ({
      window: {
        startTime: window.start.toISOString(),
        endTime: window.end.toISOString(),
        intervalSeconds: Math.round((window.end.getTime() - window.start.getTime()) / 1000),
      },
      response: summarizeApiList(await client.fetchInteractionMetadata({
        startTime: window.start,
        endTime: window.end,
      }), 3),
    }));
  } else {
    out.recordingMetadata = { skipped: true, reason: "disabled-by-flag" };
  }

  return out;
}

async function runHourlySmoke(options) {
  const now = new Date();
  const from = new Date(now.getTime() - options.lookbackMinutes * 60 * 1000);
  const [db, inbound, outbound, logics, ringcx] = await Promise.all([
    safeStep("hourly.databaseCounters", async () =>
      databaseCounters(options.domains, from, now)),
    safeStep("hourly.previewCallLedger.inbound", async () =>
      summarizePreview(await previewHourlyCallLedger({
        domains: options.domains,
        from,
        to: now,
        direction: "inbound",
        includePending: true,
        limit: options.limit,
      }))),
    safeStep("hourly.previewCallLedger.outbound", async () =>
      summarizePreview(await previewHourlyCallLedger({
        domains: options.domains,
        from,
        to: now,
        direction: "outbound",
        includePending: true,
        limit: options.limit,
      }))),
    safeStep("hourly.logicsReadProbe", async () =>
      logicsReadProbe(options.domains)),
    safeStep("hourly.ringcxReadProbe", async () =>
      ringcxReadProbe({
        includeRecordingMetadata: options.includeRecordingMetadata,
      })),
  ]);

  return {
    window: { from: from.toISOString(), to: now.toISOString() },
    lookbackMinutes: options.lookbackMinutes,
    databaseCounters: db,
    callLedgerPreview: { inbound, outbound },
    logics,
    ringcx,
  };
}

async function runNightlySmoke(options) {
  return safeStep("nightly.groupedClose.noWrite", async () => {
    const result = await runGroupedNightlyClose(options.domains, {
      date: options.dateKey,
      timezone: options.timeZone,
      vendorDomain: options.vendorDomain,
      sendDomain: "TAG",
      sendEmail: false,
      skipFinalClosePass: true,
      refreshAttribution: false,
      updatePaymentLedger: false,
      vendorLeadRowLimit: options.vendorRowLimit,
      vendorCallRowLimit: options.vendorRowLimit,
      vendorOutcomeRowLimit: options.vendorRowLimit,
      financialEmail: { recipients: [] },
      leadDataEmail: { recipients: [] },
      redlineEmail: { recipients: [] },
      opsEmail: { recipients: [] },
    });
    return summarizeNightly(result);
  });
}

async function writeReceipt(receipt, outputDir) {
  await fs.promises.mkdir(outputDir, { recursive: true });
  const runPath = path.join(outputDir, `${receipt.runId}.json`);
  const latestPath = path.join(outputDir, "latest.json");
  const receiptWithPaths = {
    ...receipt,
    receiptPaths: { runPath, latestPath },
  };
  const body = `${JSON.stringify(receiptWithPaths, null, 2)}\n`;
  await fs.promises.writeFile(runPath, body, "utf8");
  await fs.promises.writeFile(latestPath, body, "utf8");
  return { runPath, latestPath };
}

function countFailures(value) {
  if (!value || typeof value !== "object") return 0;
  let count = value.ok === false ? 1 : 0;
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") count += countFailures(child);
  }
  return count;
}

async function main() {
  const domains = parseDomains(readFlag(argv, "--domains"));
  const timeZone = readFlag(argv, "--timezone") || "America/Los_Angeles";
  const dateKey = readFlag(argv, "--date") || yesterdayInTz(timeZone);
  const modeHourly = hasFlag(argv, "--hourly") || (!hasFlag(argv, "--nightly"));
  const modeNightly = hasFlag(argv, "--nightly") || (!hasFlag(argv, "--hourly"));
  const includeRecordingMetadata = !hasFlag(argv, "--skip-ringcx-recordings");
  const limit = Math.min(Math.max(Number(readFlag(argv, "--limit")) || 40, 1), 250);
  const lookbackMinutes = Math.min(Math.max(Number(readFlag(argv, "--lookback-minutes")) || 90, 5), 24 * 60);
  const vendorDomain = String(readFlag(argv, "--vendor-domain") || "WYNN").trim().toUpperCase();
  const vendorRowLimit = Math.min(Math.max(Number(readFlag(argv, "--vendor-row-limit")) || 5000, 100), 50000);
  const outputDir = readFlag(argv, "--out")
    || path.resolve(__dirname, "..", "runtime", "linux-heavy-api-smoke");
  const startedAt = new Date();
  const runId = `linux-heavy-api-smoke-${startedAt.toISOString().replace(/[:.]/g, "-")}`;

  const receipt = {
    runId,
    startedAt: startedAt.toISOString(),
    completedAt: null,
    host: os.hostname(),
    platform: process.platform,
    pid: process.pid,
    cwd: process.cwd(),
    node: process.version,
    mode: {
      hourly: modeHourly,
      nightly: modeNightly,
      includeRecordingMetadata,
    },
    safety: {
      dbWriteGuard: writeGuard,
      sendEmail: false,
      finalClosePass: false,
      attributionRefresh: false,
      paymentLedgerUpdates: false,
    },
    options: {
      domains,
      dateKey,
      timeZone,
      lookbackMinutes,
      limit,
      vendorDomain,
      vendorRowLimit,
      outputDir,
    },
    mongo: null,
    hourly: null,
    nightly: null,
    failures: 0,
    receiptPaths: null,
  };

  logHeader("linux-heavy-api-smoke");
  logKv("domains", domains.join(","));
  logKv("date", dateKey);
  logKv("hourly", modeHourly ? "yes" : "no");
  logKv("nightly", modeNightly ? "yes" : "no");
  logKv("db write guard", writeGuard.enabled ? `on (${writeGuard.patched.length} methods)` : "off");
  logKv("ringcx recordings poll", includeRecordingMetadata ? "one read-only metadata call" : "skipped");

  await connectMongo(getSharedConfig());
  receipt.mongo = getMongoState();

  try {
    if (modeHourly) {
      logHeader("hourly smoke");
      receipt.hourly = await runHourlySmoke({
        domains,
        lookbackMinutes,
        limit,
        includeRecordingMetadata,
      });
      logKv("db counters", receipt.hourly.databaseCounters.ok ? "ok" : "failed");
      logKv("inbound preview", receipt.hourly.callLedgerPreview.inbound.ok ? "ok" : "failed");
      logKv("outbound preview", receipt.hourly.callLedgerPreview.outbound.ok ? "ok" : "failed");
      logKv("logics probe", receipt.hourly.logics.ok ? "ok" : "failed");
      logKv("ringcx probe", receipt.hourly.ringcx.ok ? "ok" : "failed");
    }

    if (modeNightly) {
      logHeader("nightly smoke");
      receipt.nightly = await runNightlySmoke({
        domains,
        dateKey,
        timeZone,
        vendorDomain,
        vendorRowLimit,
      });
      logKv("nightly payload", receipt.nightly.ok ? "ok" : "failed");
      if (receipt.nightly.ok) {
        const rows = receipt.nightly.result.rowCounts || {};
        logKv("vendor lead rows", rows.vendorLeadRows || 0);
        logKv("vendor call rows", rows.vendorCallRows || 0);
        logKv("todays calls", rows.todaysCalls || 0);
        logKv("deals by case", rows.dealsByCase || 0);
      }
    }
  } finally {
    receipt.completedAt = new Date().toISOString();
    receipt.failures = countFailures({
      hourly: receipt.hourly,
      nightly: receipt.nightly,
    });
    receipt.receiptPaths = await writeReceipt(receipt, outputDir);
    await disconnectMongo();
  }

  logHeader("receipt");
  logKv("run", receipt.receiptPaths.runPath);
  logKv("latest", receipt.receiptPaths.latestPath);
  logKv("failures", receipt.failures);

  if (receipt.failures > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exitCode = 1;
});
