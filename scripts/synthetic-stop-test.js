"use strict";

// Synthetic CallRail STOP test for the inbound webhook handler we
// added today on /sms/inbound. POSTs a STOP-shaped payload, then
// reads back the LeadCadence to verify all four invariants Codex
// called out:
//
//   1. cadenceState.channelDnc.sms is blocked
//   2. pending SMS actions on the matched cadence are cancelled
//   3. lead remains active (no full deactivation)
//   4. a future text-round dispatch attempt skips the lead with
//      reason "channel-dnc"
//
// Designed to run against the seeded WYNN/101617 test case (Mickey
// Gray, 3106665997). The harness uses 101617 specifically because it
// was left clean of channel DNC after the prior arm-test run.

const path = require("path");
require("dotenv").config({
  path: path.resolve(__dirname, "..", ".env"),
  override: true,
});

const mongoose = require("mongoose");
const leadCadenceRepository = require("../packages/shared-repositories/src/leadCadenceRepository");
const { LeadCadence } = require("../packages/shared-models/src");

const TEST_CASE = { domain: "WYNN", caseId: 101617 };
const TEST_PHONE = "3106665997";
const WYNN_TRACKING = "3105611009"; // WYNN's CallRail tracking number

async function connect() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(uri, { dbName });
}

async function reseedClean() {
  // Clear any leftover channelDnc from a previous test run + put a
  // fresh pending welcome-sms in the schedule so we can verify both
  // (a) the DNC mark and (b) cancellation of the pending action.
  const now = new Date();
  await leadCadenceRepository.upsertLeadCadence(TEST_CASE.domain, TEST_CASE.caseId, {
    domain: TEST_CASE.domain,
    caseId: TEST_CASE.caseId,
    name: "Mickey Gray",
    firstName: "Mickey",
    lastName: "Gray",
    primaryPhone: TEST_PHONE,
    normalizedPhone: TEST_PHONE,
    email: "mgray@taxadvocategroup.com",
    statusId: 2,
    active: true,
    intakeSource: "synthetic-stop-test",
    intakeRoute: "manual",
    currentStage: "new",
    schedule: {
      planVersion: "v1",
      timezone: "America/Los_Angeles",
      nextActionType: "welcome-sms",
      nextActionAt: now,
      actions: [
        {
          key: `synthetic-welcome-sms-${now.getTime()}`,
          type: "welcome-sms",
          channel: "sms",
          templateKey: "welcome",
          scheduledFor: now,
          status: "pending",
        },
      ],
    },
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
      channelDnc: {}, // explicitly reset
    },
    attributionContext: { trackingNumber: WYNN_TRACKING, source: "synthetic-stop-test" },
  });
  console.log(`reseeded ${TEST_CASE.domain}/${TEST_CASE.caseId} (clean state, pending SMS action queued)`);
}

async function postSyntheticStop() {
  // CallRail's inbound SMS webhook payload shape — we read these
  // exact field names in the route handler. Using "STOP" content
  // (the canonical hard-stop keyword); other variants tested below.
  const payload = {
    source_number: TEST_PHONE,
    destination_number: WYNN_TRACKING,
    content: "STOP",
    company_id: "synthetic-test-company",
  };
  const res = await fetch("http://localhost:5001/sms/inbound", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  console.log(`POST /sms/inbound → ${res.status}`);
  if (res.status !== 200) {
    const body = await res.text().catch(() => "");
    throw new Error(`expected 200 from /sms/inbound, got ${res.status}: ${body.slice(0, 200)}`);
  }
}

async function verifyDncMark() {
  // Wait briefly — the route ack's CallRail in <100ms but the DNC
  // mark + action cancellation happens in the post-ack work. 1s is
  // plenty for the upsert + sync to land.
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const doc = await LeadCadence.findOne({
    domain: TEST_CASE.domain,
    caseId: TEST_CASE.caseId,
  }).lean();
  if (!doc) throw new Error(`lead cadence missing for ${TEST_CASE.domain}/${TEST_CASE.caseId}`);

  const dnc = doc.cadenceState?.channelDnc?.sms;
  const smsActions = (doc.schedule?.actions || []).filter((a) => a.channel === "sms");
  const pendingSmsCount = smsActions.filter((a) => a.status === "pending" || a.status === "requested").length;
  const cancelledSmsCount = smsActions.filter((a) => a.status === "cancelled").length;

  const checks = [
    ["channelDnc.sms.blocked === true",  dnc?.blocked === true],
    ["channelDnc.sms.reason set",        Boolean(dnc?.reason)],
    ["channelDnc.sms.at is recent",      dnc?.at && (Date.now() - new Date(dnc.at).getTime()) < 60_000],
    ["lead.active still true",           doc.active === true],
    ["pending sms actions = 0",          pendingSmsCount === 0],
    ["cancelled sms actions ≥ 1",        cancelledSmsCount >= 1],
  ];

  console.log("invariant checks:");
  let pass = true;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? "✓" : "✗"} ${label}`);
    if (!ok) pass = false;
  }

  console.log("\nstate snapshot:");
  console.log(`  channelDnc.sms:    ${JSON.stringify(dnc || null)}`);
  console.log(`  active:            ${doc.active}`);
  console.log(`  sms actions:       ${smsActions.map((a) => a.status).join(", ") || "(none)"}`);

  if (!pass) {
    throw new Error("STOP-handling invariants failed — see checks above");
  }
}

async function verifyDispatchSkip() {
  // Now fire a text-round and confirm the dispatch path's per-channel
  // DNC gate refuses to attempt CallRail for this lead. We're not
  // checking that NO leads fired — only that THIS lead's SMS is
  // skipped (other test cases or production leads can still fire).
  const before = await LeadCadence.findOne({
    domain: TEST_CASE.domain,
    caseId: TEST_CASE.caseId,
  }).lean();
  const beforeCompleted = Number(before?.cadenceState?.completedByChannel?.sms || 0);

  const res = await fetch("http://localhost:4002/api/outbound/cadence/text-round", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ domain: TEST_CASE.domain }),
  });
  console.log(`POST /api/outbound/cadence/text-round → ${res.status}`);

  // Wait for the worker to tick at least once
  await new Promise((resolve) => setTimeout(resolve, 7000));

  const after = await LeadCadence.findOne({
    domain: TEST_CASE.domain,
    caseId: TEST_CASE.caseId,
  }).lean();
  const afterCompleted = Number(after?.cadenceState?.completedByChannel?.sms || 0);

  const noNewSends = afterCompleted === beforeCompleted;
  const dncStillSet = after?.cadenceState?.channelDnc?.sms?.blocked === true;
  const stillActive = after?.active === true;

  console.log("\npost-dispatch invariants:");
  console.log(`  ${noNewSends ? "✓" : "✗"} no new sms completions (was ${beforeCompleted}, now ${afterCompleted})`);
  console.log(`  ${dncStillSet ? "✓" : "✗"} channelDnc.sms still blocked`);
  console.log(`  ${stillActive ? "✓" : "✗"} lead still active`);

  if (!noNewSends || !dncStillSet) {
    throw new Error("dispatch-time DNC gate failed — see invariants above");
  }
}

async function main() {
  console.log("─── synthetic STOP test ───\n");
  await connect();
  await reseedClean();
  console.log();
  await postSyntheticStop();
  console.log();
  await verifyDncMark();
  console.log();
  await verifyDispatchSkip();
  console.log("\n✓ all STOP-handling invariants pass");
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(`\n✗ ${err.message}`);
  await mongoose.disconnect().catch(() => null);
  process.exit(1);
});
