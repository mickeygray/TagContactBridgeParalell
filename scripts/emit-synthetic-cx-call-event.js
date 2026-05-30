"use strict";

const crypto = require("crypto");
const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const {
  EventRecord,
  EVENT_STATUS,
  connectMongo,
  disconnectMongo,
} = require("../packages/event-core/src");
const { getSharedConfig } = require("../packages/shared-config/src");

function readFlag(argv, name, fallback = "") {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1) return argv[idx + 1];
  return fallback;
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function env(name, fallback = "") {
  const value = process.env[name];
  return value === undefined || value === null || value === "" ? fallback : value;
}

function clean(value, max = 240) {
  return String(value || "").trim().slice(0, max);
}

function timestampForId(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function normalizePhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

function buildSyntheticCxCallEventDoc(options = {}) {
  const now = options.now || new Date();
  const durationSec = Math.max(30, Number(options.durationSec) || 2700);
  const sourceService = clean(options.sourceService || "ringcentral-cx", 120);
  const suffix = options.suffix || `${timestampForId(now)}-${crypto.randomBytes(3).toString("hex")}`;
  const caseId = clean(options.caseId || "synthetic-live-coach", 120);
  const queueItemId = clean(options.queueItemId || `synthetic-live-coach-${suffix}`, 160);
  const callSessionId = clean(options.callSessionId || `synthetic-call-${suffix}`, 160);
  const payload = {
    id: queueItemId,
    eventType: "cx.call.placed",
    synthetic: true,
    testSource: clean(options.testSource || "emit-synthetic-cx-call-event", 120),
    placedAt: now.toISOString(),
    createdAt: now.toISOString(),
    expiresAtMs: now.getTime() + durationSec * 1000,
    queueItemId,
    caseId,
    extensionId: clean(options.extensionId || "", 80),
    agentName: clean(options.agentName || "Michael Gray", 120),
    agentEmail: clean(options.agentEmail || "", 180),
    phone: normalizePhone(options.phone || ""),
    campaignId: clean(options.campaignId || "", 80),
    dialGroupId: clean(options.dialGroupId || "", 80),
    uii: clean(options.uii || "", 120),
    callSessionId,
    confirmedCall: true,
    countAsAttempt: false,
    ringcxPublished: false,
    holdUntilDisposition: false,
  };

  return {
    eventType: "cx.call.placed",
    sourceService,
    aggregateType: "case",
    aggregateId: String(caseId || queueItemId || "synthetic-live-coach"),
    payload,
    status: EVENT_STATUS.COMPLETED,
    processedAt: now,
    nextAttemptAt: null,
    dedupeKey: clean(options.dedupeKey || `synthetic-live-coach:${queueItemId}:${now.getTime()}`, 240),
    lastWorker: "synthetic-live-coach-test",
  };
}

async function emitSyntheticCxCallEvent(options = {}) {
  const doc = buildSyntheticCxCallEventDoc(options);
  const event = await EventRecord.create(doc);
  return {
    ok: true,
    event,
    summary: {
      eventId: String(event._id),
      sourceService: event.sourceService,
      eventType: event.eventType,
      status: event.status,
      queueItemId: doc.payload.queueItemId,
      caseId: doc.payload.caseId,
      agentEmail: doc.payload.agentEmail,
      extensionId: doc.payload.extensionId,
      callSessionId: doc.payload.callSessionId,
      expiresAt: new Date(doc.payload.expiresAtMs).toISOString(),
    },
  };
}

function printHelp() {
  console.log(`Emit a synthetic RingCX call-placed event for local live-coach testing.

Usage:
  node scripts/emit-synthetic-cx-call-event.js [options]

Options:
  --agent-email EMAIL       Agent email. Defaults to live-monitor/RingCX env.
  --extension-id ID         Agent RingEX extension id. Optional when email matches.
  --duration-sec N          Active gate duration in seconds. Default 2700.
  --case-id ID              Synthetic case id. Default synthetic-live-coach.
  --queue-item-id ID        Synthetic queue item id. Default generated.
  --uii UII                 Optional RingCX UII if known.
  --call-session-id ID      Optional call session id. Default generated.
  --phone PHONE             Optional lead phone for payload/debugging.
  --campaign-id ID          Optional RingCX campaign id.
  --dial-group-id ID        Optional RingCX dial group id.
  --source-service NAME     Event source. Default ringcentral-cx.
  --dry                     Print the document without writing Mongo.
`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
    printHelp();
    return;
  }

  const now = new Date();
  const suffix = `${timestampForId(now)}-${crypto.randomBytes(3).toString("hex")}`;
  const durationSec = Math.max(30, Number(readFlag(argv, "--duration-sec", "2700")) || 2700);
  const agentEmail = clean(
    readFlag(
      argv,
      "--agent-email",
      env(
        "EX_LIVE_MONITOR_EVENT_GATE_AGENT_EMAIL",
        env("RINGCX_VOICE_AGENT_EMAIL", env("RINGCX_VOICE_RC_USER_EMAIL", "mgray@taxadvocategroup.com")),
      ),
    ),
    180,
  );
  const extensionId = clean(
    readFlag(
      argv,
      "--extension-id",
      env("EX_LIVE_MONITOR_EVENT_GATE_AGENT_EXTENSION_ID", env("EX_LIVE_MONITOR_AGENT_EXTENSION_ID", "")),
    ),
    80,
  );
  const doc = buildSyntheticCxCallEventDoc({
    now,
    suffix,
    durationSec,
    sourceService: readFlag(argv, "--source-service", "ringcentral-cx"),
    caseId: readFlag(argv, "--case-id", "synthetic-live-coach"),
    queueItemId: readFlag(argv, "--queue-item-id", `synthetic-live-coach-${suffix}`),
    callSessionId: readFlag(argv, "--call-session-id", `synthetic-call-${suffix}`),
    agentEmail,
    agentName: readFlag(argv, "--agent-name", "Michael Gray"),
    extensionId,
    phone: readFlag(argv, "--phone", env("PARALLEL_TEST_PHONE", env("DEPLOY_PANEL_PHONE", ""))),
    uii: readFlag(argv, "--uii", ""),
    campaignId: readFlag(argv, "--campaign-id", env("RINGCX_VOICE_DEFAULT_CAMPAIGN_ID", "")),
    dialGroupId: readFlag(argv, "--dial-group-id", env("RINGCX_VOICE_DEFAULT_DIAL_GROUP_ID", "")),
  });

  if (hasFlag(argv, "--dry")) {
    console.log(JSON.stringify({ ok: true, dryRun: true, doc }, null, 2));
    return;
  }

  await connectMongo(getSharedConfig());
  try {
    const result = await emitSyntheticCxCallEvent({
      ...doc.payload,
      sourceService: doc.sourceService,
      dedupeKey: doc.dedupeKey,
      durationSec,
    });
    console.log(JSON.stringify(result.summary, null, 2));
  } finally {
    await disconnectMongo().catch(() => null);
  }
}

if (require.main === module) {
  main().catch(async (error) => {
    console.error(`fatal: ${error.message}`);
    await disconnectMongo().catch(() => null);
    process.exit(1);
  });
}

module.exports = {
  buildSyntheticCxCallEventDoc,
  emitSyntheticCxCallEvent,
};
