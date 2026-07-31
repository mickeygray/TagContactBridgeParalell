#!/usr/bin/env node
"use strict";

// Isolated RingCX SUSPECT reproduction for Chris Bolt.
//
// This script talks directly to RingCX. It does not read or write Mongo, does
// not start the CX runtime, and does not touch the PhoneBurner delivery loop.
//
//   node scripts/cx-chris-suspect-minute-canary.js status
//   node scripts/cx-chris-suspect-minute-canary.js wipe --apply
//   node scripts/cx-chris-suspect-minute-canary.js once --apply
//   node scripts/cx-chris-suspect-minute-canary.js run --apply --wipe-first
//   node scripts/cx-chris-suspect-minute-canary.js stop --apply
//
// Mutations require --apply. The default run interval is exactly one minute.

const fs = require("fs");
const path = require("path");

require("dotenv").config({
  path: path.resolve(__dirname, "..", ".env"),
  quiet: true,
});

// Keep transport tracing from printing provider identities for this test.
process.env.CX_ALPHA_TRACE_ENABLED = "false";

const {
  createRingcxVoiceClient,
} = require("../packages/shared-integrations/src/ringcxVoiceClient");
const {
  buildBulkLeadLoaderPayload,
  toCandidatePublishPatch,
} = require("../packages/shared-services/src/cxBulkLoadRingcxPublisher");

const TARGET = Object.freeze({
  label: "Chris Bolt",
  campaigns: Object.freeze([
    { key: "regular", label: "regular", id: "2458" },
    { key: "first_touch", label: "first-touch", id: "2829" },
    { key: "appointment", label: "appointment", id: "2900" },
  ]),
  canaryCampaignKey: "regular",
});

const ACTIVE_QUEUE_STATES = Object.freeze(["PENDING", "READY"]);
const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 5_000;
const CANCEL_BATCH_SIZE = 250;
const MAX_WIPE_PASSES = 20;
const RUNTIME_DIR = path.resolve(__dirname, "..", "runtime", "cx-chris-suspect-canary");
const PID_PATH = path.join(RUNTIME_DIR, "canary.pid");
const LOG_PATH = path.join(
  RUNTIME_DIR,
  `canary-${new Date().toISOString().slice(0, 10)}.jsonl`,
);

function hasFlag(argv, name) {
  return argv.includes(name);
}

function readFlag(argv, name, fallback = null) {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  if (index >= 0 && index < argv.length - 1 && !argv[index + 1].startsWith("--")) {
    return argv[index + 1];
  }
  return fallback;
}

function str(value) {
  return String(value == null ? "" : value).trim();
}

function normalizePhone(value) {
  const digits = str(value).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.length >= 10 ? digits.slice(-10) : "";
}

function configuredTestPhone() {
  return normalizePhone(
    process.env.CX_BULK_MICKEY_TEST_PHONE
      || process.env.PARALLEL_TEST_PHONE
      || process.env.DEPLOY_PANEL_PHONE,
  );
}

function canaryCampaign() {
  return TARGET.campaigns.find((campaign) => campaign.key === TARGET.canaryCampaignKey);
}

function rowsFromResponse(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.leads)) return value.leads;
  if (Array.isArray(value?.records)) return value.records;
  if (Array.isArray(value?.data)) return value.data;
  const error = new Error("RingCX lead search returned an unexpected response");
  error.code = "unexpected-lead-search-shape";
  throw error;
}

function rowState(row) {
  return str(row?.leadState || row?.state || row?.physicalState).toUpperCase();
}

function rowExternId(row) {
  return str(row?.externId || row?.externalId);
}

function leadSearchPayload(campaign, states = ACTIVE_QUEUE_STATES) {
  const campaignId = Number(campaign.id) || campaign.id;
  return {
    campaignId,
    campaignIds: [campaignId],
    listIds: [],
    agentDispositions: [],
    systemDispositions: [],
    leadStates: [...states],
    physicalStates: [],
    leadTimezones: [],
    suppressed: "ALL",
  };
}

function safeError(error) {
  const status = Number(error?.status || error?.statusCode) || null;
  const code = str(error?.code) || null;
  const message = str(error?.message || error)
    .replace(/\b\d{7,}\b/g, "[masked]")
    .slice(0, 180);
  return { status, code, message };
}

function ensureRuntimeDir() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
}

function emit(event, details = {}) {
  const record = {
    at: new Date().toISOString(),
    event,
    target: TARGET.label,
    ...details,
  };
  const line = JSON.stringify(record);
  console.log(line);
  ensureRuntimeDir();
  fs.appendFileSync(LOG_PATH, `${line}\n`, "utf8");
  return record;
}

function requireApply(argv, action) {
  if (!hasFlag(argv, "--apply")) {
    throw Object.assign(new Error(`${action} is a mutation; re-run with --apply`), {
      code: "apply-required",
    });
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid() {
  try {
    const pid = Number(fs.readFileSync(PID_PATH, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function claimPid() {
  ensureRuntimeDir();
  const priorPid = readPid();
  if (priorPid && processIsAlive(priorPid)) {
    const error = new Error("another Chris SUSPECT canary loop is already running");
    error.code = "already-running";
    throw error;
  }
  fs.writeFileSync(PID_PATH, `${process.pid}\n`, "utf8");
}

function releasePid() {
  const pid = readPid();
  if (pid === process.pid) {
    try {
      fs.unlinkSync(PID_PATH);
    } catch {}
  }
}

async function listOutstanding(client, campaign) {
  const response = await client.searchLeads(
    leadSearchPayload(campaign, ACTIVE_QUEUE_STATES),
  );
  return rowsFromResponse(response).filter((row) => {
    const state = rowState(row);
    return ACTIVE_QUEUE_STATES.includes(state) && rowExternId(row);
  });
}

async function readStatus(client) {
  const campaigns = [];
  for (const campaign of TARGET.campaigns) {
    const rows = await listOutstanding(client, campaign);
    const byState = {};
    for (const row of rows) {
      const state = rowState(row) || "UNKNOWN";
      byState[state] = (byState[state] || 0) + 1;
    }
    campaigns.push({
      campaign: campaign.label,
      outstanding: rows.length,
      byState,
    });
  }
  emit("canary.status", {
    outstanding: campaigns.reduce((sum, row) => sum + row.outstanding, 0),
    campaigns,
  });
  return campaigns;
}

async function cancelRows(client, campaign, rows) {
  let cancelled = 0;
  for (let index = 0; index < rows.length; index += CANCEL_BATCH_SIZE) {
    const externIds = rows
      .slice(index, index + CANCEL_BATCH_SIZE)
      .map(rowExternId)
      .filter(Boolean);
    if (!externIds.length) continue;
    const campaignId = Number(campaign.id) || campaign.id;
    const response = await client.leadAction("CANCEL_LEADS", {
      campaignLeadSearchCriteria: {
        campaignId,
        campaignIds: [campaignId],
        externIds,
      },
      leadActionParams: {},
    });
    if (response === false) {
      const error = new Error("RingCX rejected the queue cancellation");
      error.code = "cancel-rejected";
      throw error;
    }
    cancelled += externIds.length;
  }
  return cancelled;
}

async function wipeQueues(client) {
  let cancelled = 0;
  const campaigns = [];

  for (const campaign of TARGET.campaigns) {
    let campaignCancelled = 0;
    let remaining = 0;
    let pass = 0;

    for (pass = 1; pass <= MAX_WIPE_PASSES; pass += 1) {
      const rows = await listOutstanding(client, campaign);
      remaining = rows.length;
      if (!remaining) break;
      campaignCancelled += await cancelRows(client, campaign, rows);
    }

    const verified = await listOutstanding(client, campaign);
    remaining = verified.length;
    if (remaining > 0) {
      const error = new Error(`queue wipe did not converge for ${campaign.label}`);
      error.code = "wipe-incomplete";
      error.details = { campaign: campaign.label, remaining, passes: pass - 1 };
      throw error;
    }

    cancelled += campaignCancelled;
    campaigns.push({
      campaign: campaign.label,
      cancelled: campaignCancelled,
      remaining,
    });
  }

  emit("canary.wipe_completed", { cancelled, remaining: 0, campaigns });
  return { cancelled, campaigns };
}

function buildCandidate(sequence) {
  const phone = configuredTestPhone();
  if (!phone) {
    const error = new Error(
      "missing CX_BULK_MICKEY_TEST_PHONE, PARALLEL_TEST_PHONE, or DEPLOY_PANEL_PHONE",
    );
    error.code = "test-phone-not-configured";
    throw error;
  }
  const now = Date.now();
  const token = `${now.toString(36)}-${Number(sequence).toString(36)}`;
  return {
    queueItemId: `suspect-canary-${token}`,
    domain: "WYNN",
    caseId: null,
    name: "Mickey Suspect Canary",
    phone,
    externId: `cx-suspect-cbolt-${token}`,
  };
}

async function sendOne(client, sequence) {
  const campaign = canaryCampaign();
  const candidate = buildCandidate(sequence);
  const payload = buildBulkLeadLoaderPayload([candidate], {
    dialPriority: "NORMAL",
  });
  payload.description = "Chris SUSPECT minute canary";

  const result = await client.loadLeads(campaign.id, payload);
  const patch = toCandidatePublishPatch(result, [candidate]);
  const accepted = patch.accepted.length;
  const rejected = patch.rejected.length;
  if (accepted !== 1 || rejected !== 0) {
    const error = new Error("RingCX did not accept the canary lead");
    error.code = "canary-rejected";
    error.details = {
      processingStatus: str(result?.processingStatus) || null,
      accepted,
      rejected,
    };
    throw error;
  }

  emit("canary.lead_accepted", {
    sequence,
    campaign: campaign.label,
    accepted,
    processingStatus: str(result?.processingStatus) || null,
  });
  return { accepted };
}

async function runLoop(client, argv) {
  const intervalMs = Math.max(
    MIN_INTERVAL_MS,
    Number(readFlag(argv, "--interval-ms", DEFAULT_INTERVAL_MS)) || DEFAULT_INTERVAL_MS,
  );
  claimPid();

  let stopping = false;
  let sequence = 0;
  let failures = 0;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    emit("canary.stopping", { signal, sequence, failures });
    releasePid();
    process.exitCode = 0;
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));

  emit("canary.started", { pid: process.pid, intervalMs });
  while (!stopping) {
    sequence += 1;
    try {
      await sendOne(client, sequence);
    } catch (error) {
      failures += 1;
      emit("canary.lead_failed", {
        sequence,
        failures,
        error: safeError(error),
      });
    }
    if (stopping) break;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      timer.unref();
      const keepAlive = setInterval(() => {}, Math.min(intervalMs, 1_000));
      setTimeout(() => clearInterval(keepAlive), intervalMs);
    });
  }
}

async function stopLoop() {
  const pid = readPid();
  if (!pid) {
    emit("canary.stop_noop", { reason: "no-pid" });
    return;
  }
  if (!processIsAlive(pid)) {
    try {
      fs.unlinkSync(PID_PATH);
    } catch {}
    emit("canary.stop_noop", { reason: "stale-pid" });
    return;
  }
  process.kill(pid, "SIGTERM");
  emit("canary.stop_requested", { pid });
}

function usage() {
  console.log(`
Chris RingCX SUSPECT minute canary

Commands:
  status
  wipe --apply
  once --apply
  run --apply [--wipe-first] [--interval-ms 60000]
  stop --apply
`);
}

async function main() {
  const argv = process.argv.slice(2);
  const command = str(argv[0] || "status").toLowerCase();

  if (command === "help" || hasFlag(argv, "--help")) {
    usage();
    return;
  }
  if (command === "stop") {
    requireApply(argv, "stop");
    await stopLoop();
    return;
  }

  const client = createRingcxVoiceClient();
  if (command === "status") {
    await readStatus(client);
    return;
  }
  if (command === "wipe") {
    requireApply(argv, "wipe");
    await wipeQueues(client);
    return;
  }
  if (command === "once") {
    requireApply(argv, "once");
    await sendOne(client, 1);
    return;
  }
  if (command === "run") {
    requireApply(argv, "run");
    if (hasFlag(argv, "--wipe-first")) await wipeQueues(client);
    await runLoop(client, argv);
    return;
  }

  usage();
  throw Object.assign(new Error(`unknown command: ${command}`), {
    code: "unknown-command",
  });
}

main()
  .catch((error) => {
    emit("canary.fatal", {
      error: safeError(error),
      details: null,
    });
    releasePid();
    process.exitCode = 1;
  });
