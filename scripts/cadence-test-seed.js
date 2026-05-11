"use strict";

// Cadence test harness — seeds two LeadCadence rows in the PARALLEL
// `controlplaneleadcadences` collection (NOT the legacy db) for Mickey
// Gray's contact info, then triggers a text-round and reports back.
//
// Usage:
//   node scripts/cadence-test-seed.js seed       # seed both cases
//   node scripts/cadence-test-seed.js inspect    # read both back
//   node scripts/cadence-test-seed.js fire       # POST text-round to 4002
//   node scripts/cadence-test-seed.js cleanup    # mark both inactive
//
// The two cases (101656, 101617) are real WYNN Logics cases with the
// tester's contact info. We do NOT touch the legacy DB; orchestration
// queries the parallel collection per
// shared-repositories/leadCadenceRepository.js comments.

const path = require("path");
require("dotenv").config({
  path: path.resolve(__dirname, "..", ".env"),
  override: true,
});

const mongoose = require("mongoose");
const leadCadenceRepository = require("../packages/shared-repositories/src/leadCadenceRepository");
const { upsertLeadCadence } = leadCadenceRepository;
const { LeadCadence } = require("../packages/shared-models/src");

const TEST_LEADS = [
  { caseId: 101656, name: "Mickey Gray" },
  { caseId: 101617, name: "Mickey Gray" },
];

const COMMON = {
  domain: "WYNN",
  firstName: "Mickey",
  lastName: "Gray",
  name: "Mickey Gray",
  email: "mgray@taxadvocategroup.com",
  primaryPhone: "3106665997",
  normalizedPhone: "3106665997",
  statusId: 2,
  active: true,
  intakeSource: "cadence-test",
  intakeRoute: "manual",
  sourceName: "cadence-harness",
};

// Build a fresh schedule.actions[] with one welcome SMS, scheduledFor =
// now. We deliberately DO NOT pre-stamp day-1 etc — we'll add those in
// later stages of the test.
function buildWelcomeSchedule(now = new Date()) {
  return {
    planVersion: "v1",
    timezone: "America/Los_Angeles",
    nextActionType: "welcome-sms",
    nextActionAt: now,
    actions: [
      {
        key: `welcome-sms-${now.getTime()}`,
        type: "welcome-sms",
        channel: "sms",
        templateKey: "welcome",
        scheduledFor: now,
        status: "pending",
      },
    ],
  };
}

// Realistic on-add schedule — text + email fire immediately; RVM is
// delayed a few minutes so we observe the worker picking it up at the
// right time rather than all three slamming at once. Mirrors the
// real-world cadence pattern (give the recipient a beat between text
// and an unprompted voicemail).
const RVM_DELAY_MINUTES = 5;

function buildOnAddSchedule(now = new Date()) {
  const rvmAt = new Date(now.getTime() + RVM_DELAY_MINUTES * 60 * 1000);
  const base = now.getTime();
  return {
    planVersion: "v1",
    timezone: "America/Los_Angeles",
    nextActionType: "welcome-sms",
    nextActionAt: now,
    actions: [
      {
        key: `welcome-sms-${base}`,
        type: "welcome-sms",
        channel: "sms",
        templateKey: "welcome",
        scheduledFor: now,
        status: "pending",
      },
      {
        key: `welcome-email-${base}`,
        type: "welcome-email",
        channel: "email",
        templateKey: "welcome",
        scheduledFor: now,
        status: "pending",
      },
      {
        key: `welcome-rvm-${base}`,
        type: "welcome-rvm",
        channel: "rvm",
        templateKey: "welcome",
        scheduledFor: rvmAt,
        status: "pending",
      },
    ],
  };
}

// Multichannel seed — welcome email + welcome rvm both due now. Used
// to prove the dispatcher recognises non-SMS channels and routes them
// to the right handler. The RVM is expected to fail downstream at
// Drop.co because the test phone is on the National DNC; that failure
// path is also informative — we want to see the engine try.
function buildMultiChannelSchedule(now = new Date()) {
  const base = now.getTime();
  return {
    planVersion: "v1",
    timezone: "America/Los_Angeles",
    nextActionType: "welcome-email",
    nextActionAt: now,
    actions: [
      {
        key: `welcome-email-${base}`,
        type: "welcome-email",
        channel: "email",
        templateKey: "welcome",
        scheduledFor: now,
        status: "pending",
      },
      {
        key: `welcome-rvm-${base}`,
        type: "welcome-rvm",
        channel: "rvm",
        templateKey: "welcome",
        scheduledFor: now,
        status: "pending",
      },
    ],
  };
}

async function connect() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(uri, { dbName });
  console.log(`connected: db=${mongoose.connection.name}`);
}

async function seed() {
  const now = new Date();
  for (const lead of TEST_LEADS) {
    const update = {
      ...COMMON,
      caseId: lead.caseId,
      currentStage: "new",
      schedule: buildWelcomeSchedule(now),
      cadenceState: {
        caps: {},
        completedByChannel: {},
        failedByChannel: {},
        pendingByChannel: { sms: 1 },
        exhaustedChannels: [],
        engagementChannelsExhausted: false,
        nextChannel: "sms",
        lastCompletedAtByChannel: {},
        lastEvaluatedAt: null,
      },
      attributionContext: {
        trackingNumber: "3105611009", // WYNN's CallRail tracking number
        source: "cadence-test",
      },
    };
    const doc = await upsertLeadCadence(COMMON.domain, lead.caseId, update);
    console.log(`seeded ${COMMON.domain}/${lead.caseId} → _id=${doc._id} status=${doc.statusId} active=${doc.active}`);
    console.log(`  schedule.actions[0]: ${JSON.stringify(doc.schedule.actions[0])}`);
  }
}

async function inspect() {
  for (const lead of TEST_LEADS) {
    const doc = await LeadCadence.findOne({
      domain: COMMON.domain,
      caseId: lead.caseId,
    }).lean();
    if (!doc) {
      console.log(`NOT FOUND: ${COMMON.domain}/${lead.caseId}`);
      continue;
    }
    console.log(`${COMMON.domain}/${lead.caseId}:`);
    console.log(`  active:           ${doc.active}`);
    console.log(`  statusId:         ${doc.statusId}`);
    console.log(`  currentStage:     ${doc.currentStage}`);
    console.log(`  primaryPhone:     ${doc.primaryPhone}`);
    console.log(`  email:            ${doc.email}`);
    console.log(`  schedule.actions: ${(doc.schedule?.actions || []).length} action(s)`);
    for (const action of doc.schedule?.actions || []) {
      console.log(`    - ${action.channel}/${action.type} status=${action.status} scheduledFor=${new Date(action.scheduledFor).toISOString()}`);
    }
    console.log(`  cadenceState.completedByChannel: ${JSON.stringify(doc.cadenceState?.completedByChannel || {})}`);
    console.log(`  cadenceState.lastCompletedAtByChannel: ${JSON.stringify(doc.cadenceState?.lastCompletedAtByChannel || {})}`);
    console.log(`  cadenceState.channelDnc: ${JSON.stringify(doc.cadenceState?.channelDnc || {})}`);
    console.log(`  updatedAt: ${doc.updatedAt}`);
  }
}

async function fire() {
  const url = "http://localhost:4002/api/outbound/cadence/text-round";
  const body = JSON.stringify({ domain: "WYNN" });
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const text = await res.text();
  console.log(`POST ${url}`);
  console.log(`  status: ${res.status}`);
  console.log(`  body:   ${text}`);
}

async function fireChannel(channel) {
  const url = `http://localhost:4002/api/outbound/cadence/${channel}-round`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ domain: "WYNN" }),
  });
  const text = await res.text();
  console.log(`POST ${url}`);
  console.log(`  status: ${res.status}`);
  console.log(`  body:   ${text}`);
}

async function reseedOnAdd() {
  const now = new Date();
  for (const lead of TEST_LEADS) {
    const update = {
      ...COMMON,
      caseId: lead.caseId,
      currentStage: "new",
      schedule: buildOnAddSchedule(now),
      cadenceState: {
        caps: {},
        completedByChannel: {},
        failedByChannel: {},
        pendingByChannel: { sms: 1, email: 1, rvm: 1 },
        exhaustedChannels: [],
        engagementChannelsExhausted: false,
        nextChannel: "sms",
        lastCompletedAtByChannel: {},
        lastEvaluatedAt: null,
        channelDnc: {},
      },
      attributionContext: {
        trackingNumber: "3105611009",
        source: "cadence-test",
      },
    };
    const doc = await upsertLeadCadence(COMMON.domain, lead.caseId, update);
    console.log(`reseeded ${COMMON.domain}/${lead.caseId} → on-add schedule (text+email now, rvm +${RVM_DELAY_MINUTES}min)`);
    for (const action of doc.schedule.actions) {
      console.log(`  - ${action.channel}/${action.type} status=${action.status} scheduledFor=${action.scheduledFor.toISOString()}`);
    }
  }
}

async function armTest() {
  // Reseed both leads, then mark 101656 SMS DNC in the same connection.
  // Run order matters: reseed (which writes a fresh cadenceState
  // including an empty channelDnc) MUST happen before the DNC mark.
  // Sub-second turnaround beats the auto-sweep's 5s tick — so by the
  // time the worker next polls, 101656 has its SMS action cancelled
  // and the gate flag set; 101617 stays clean.
  await reseedOnAdd();
  console.log("");
  await markSmsDnc(101656, "opted-out-test");
}

async function markSmsDnc(caseIdArg, reason) {
  const caseId = Number(caseIdArg);
  const r = String(reason || "opted-out");
  const result = await leadCadenceRepository.markChannelDnc(COMMON.domain, caseId, "sms", r);
  if (!result) {
    console.log(`markChannelDnc: no doc found for ${COMMON.domain}/${caseId}`);
    return;
  }
  console.log(`marked ${COMMON.domain}/${caseId} SMS DNC reason=${r}`);
  console.log(`  active:                          ${result.active}`);
  console.log(`  cadenceState.channelDnc.sms:     ${JSON.stringify(result.cadenceState?.channelDnc?.sms || null)}`);
  const smsActions = (result.schedule?.actions || []).filter((a) => a.channel === "sms");
  console.log(`  sms actions after mark:          ${smsActions.map((a) => a.status).join(", ") || "(none)"}`);
  const otherActions = (result.schedule?.actions || []).filter((a) => a.channel !== "sms");
  console.log(`  other-channel actions untouched: ${otherActions.map((a) => `${a.channel}=${a.status}`).join(", ") || "(none)"}`);
}

async function reseedMulti() {
  const now = new Date();
  for (const lead of TEST_LEADS) {
    const update = {
      ...COMMON,
      caseId: lead.caseId,
      currentStage: "new",
      schedule: buildMultiChannelSchedule(now),
      cadenceState: {
        caps: {},
        completedByChannel: {},
        failedByChannel: {},
        pendingByChannel: { email: 1, rvm: 1 },
        exhaustedChannels: [],
        engagementChannelsExhausted: false,
        nextChannel: "email",
        lastCompletedAtByChannel: {},
        lastEvaluatedAt: null,
      },
      attributionContext: {
        trackingNumber: "3105611009",
        source: "cadence-test",
      },
    };
    const doc = await upsertLeadCadence(COMMON.domain, lead.caseId, update);
    console.log(`reseeded ${COMMON.domain}/${lead.caseId} → email + rvm pending now`);
    for (const action of doc.schedule.actions) {
      console.log(`  - ${action.channel}/${action.type} status=${action.status}`);
    }
  }
}

async function cleanup() {
  for (const lead of TEST_LEADS) {
    await upsertLeadCadence(COMMON.domain, lead.caseId, { active: false });
    console.log(`marked ${COMMON.domain}/${lead.caseId} inactive`);
  }
}

async function main() {
  const cmd = process.argv[2] || "inspect";
  await connect();
  if (cmd === "seed") await seed();
  else if (cmd === "inspect") await inspect();
  else if (cmd === "fire") await fire();
  else if (cmd === "cleanup") await cleanup();
  else if (cmd === "reseed-multi") await reseedMulti();
  else if (cmd === "reseed-on-add") await reseedOnAdd();
  else if (cmd === "fire-email") await fireChannel("email");
  else if (cmd === "fire-rvm") await fireChannel("rvm");
  else if (cmd === "mark-sms-dnc") await markSmsDnc(process.argv[3], process.argv[4]);
  else if (cmd === "arm-test") await armTest();
  else throw new Error(`unknown cmd: ${cmd}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
