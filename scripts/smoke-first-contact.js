"use strict";

// End-to-end smoke for the new first-contact flow.
//
// Drives the production `fireImmediateContact` path so we exercise the
// real dispatch chain (eligibility check → action claim → send →
// status flip). Case 101617's Logics status has been reset to 2
// (prospect) externally so the eligibility guard lets it through.
//
// Verifies:
//   - SMS sent to 310-666-5997
//   - Welcome email sent to mgray@taxadvocategroup.com
//   - CxDialQueue item written + locked to mgray for visible dial

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const {
  fireImmediateContact,
} = require("../packages/shared-services/src");
const {
  createLegacyCadenceSchedule,
} = require("../packages/shared-services/src/cadencePlanService");
const {
  caseProfileRepository,
  leadCadenceRepository,
  masterProspectRepository,
  userAccountRepository,
} = require("../packages/shared-repositories/src");

const DOMAIN = "WYNN";
const CASE_ID = 101617;
const TEST_PHONE = "3106665997";
const TEST_EMAIL = "mgray@taxadvocategroup.com";
const TEST_NAME = "Mickey Gray";

async function main() {
  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(process.env.MONGO_URI, { dbName });
  console.log(`[smoke] connected db=${mongoose.connection.name}\n`);

  const now = new Date();

  // ── 1. Validation context (synthesized) ─────────────────────────
  const validation = {
    phone: { onNationalDNC: false, onStateDNC: false, isLitigator: false, isCell: true, source: "smoke-test" },
    phoneValid: true, phoneCanCall: true, phoneCanText: true, phoneIsCell: true,
    emailValid: true, emailCanSend: true, emailResult: "valid",
  };

  // ── 2. Cadence schedule ─────────────────────────────────────────
  const schedule = createLegacyCadenceSchedule(now, {}, validation);
  console.log(`[smoke] schedule armed — ${schedule.actions.length} actions, first 3:`);
  for (const a of schedule.actions.slice(0, 3)) {
    console.log(`  ${a.key.padEnd(14)} ch=${a.channel.padEnd(5)} type=${a.type.padEnd(20)} at=${a.scheduledFor?.toISOString?.() || "?"}`);
  }
  console.log("");

  // ── 3. Defensive: ensure masterProspect + caseProfile + leadCadence
  // mirror what live Logics says (status 2, prospect). The eligibility
  // check uses caseProfile.statusId via the legacy lookup, so leaving
  // it stale at 173 ("dnc") trips logics-nonprospect-status / blocked-stage.
  await masterProspectRepository.upsertMasterProspect(DOMAIN, CASE_ID, {
    statusId: 2, statusLabelRaw: "Opened", statusCategory: "prospect",
    firstName: "Mickey", lastName: "Gray", name: TEST_NAME,
    email: TEST_EMAIL, cellPhone: TEST_PHONE, normalizedPhones: [TEST_PHONE],
    firstSeenAt: now, lastSeenAt: now,
    needsStatusRefresh: true, needsSourceRefresh: true,
    metadata: { intakeSource: "ld", sourceName: "LD Smoke Test" },
  });
  await caseProfileRepository.upsertCaseProfile(DOMAIN, CASE_ID, {
    statusId: 2,
    statusCategory: "prospect",
    firstName: "Mickey", lastName: "Gray", name: TEST_NAME,
    email: TEST_EMAIL,
    primaryPhone: TEST_PHONE, normalizedPhones: [TEST_PHONE],
    convertedAt: null,
  });

  const leadCadence = await leadCadenceRepository.upsertLeadCadence(DOMAIN, CASE_ID, {
    externalLeadId: `smoke-101617-${now.getTime()}`,
    intakeRoute: "ld-lead", intakeSource: "ld", partnerSource: "ld-smoke",
    firstName: "Mickey", lastName: "Gray", name: TEST_NAME,
    email: TEST_EMAIL,
    primaryPhone: TEST_PHONE, normalizedPhone: TEST_PHONE,
    sourceName: "LD Smoke Test", sourceChannel: "ld-smoke",
    statusId: 2, active: true, currentStage: "cadence-armed",
    schedule,
    cadenceState: leadCadenceRepository.buildCadenceStateFromActions(schedule.actions || []),
    validationContext: validation,
    // dispatchForLead pulls trackingNumber from
    // `lead.attributionContext.trackingNumber` for the CallRail SMS
    // call. Without it the SMS path returns missing-tracking-number.
    // Use the WYNN CallRail tracking number from .env.
    attributionContext: {
      trackingNumber: process.env.WYNN_CALL_RAIL_TRACKING_NUMBER || "3105611009",
      contactDomain: DOMAIN,
      intakeRoute: "ld-lead",
      intakeSource: "ld",
    },
    payloadSnapshot: { smoke: true, caseId: CASE_ID, phone: TEST_PHONE, email: TEST_EMAIL, name: TEST_NAME },
  });
  console.log(`[smoke] leadCadence ${leadCadence._id} upserted\n`);

  // ── 4. Fire immediate contact (production path) ─────────────────
  console.log("[smoke] firing immediate contact via fireImmediateContact...");
  const fired = await fireImmediateContact(leadCadence, validation, {
    logger: {
      info: (msg, meta) => console.log(`  [info] ${msg}`, JSON.stringify(meta || {}).slice(0, 220)),
      warn: (msg, meta) => console.warn(`  [warn] ${msg}`, JSON.stringify(meta || {}).slice(0, 220)),
    },
    sourceService: "smoke-first-contact",
  });
  console.log("[smoke] fire result:");
  console.log(`  sms:   ok=${fired.sms?.ok} skipped=${fired.sms?.skipped || false} reason=${fired.sms?.result?.reason || fired.sms?.reason || "(none)"} error=${fired.sms?.error || ""}`);
  console.log(`  email: ok=${fired.email?.ok} skipped=${fired.email?.skipped || false} reason=${fired.email?.result?.reason || fired.email?.reason || "(none)"} error=${fired.email?.error || ""}`);
  console.log(`  cx:    queued=${fired.cx?.queued} skipped=${fired.cx?.skipped || false} reason=${fired.cx?.reason || "(none)"}`);
  console.log("");

  // ── 5. Lock the freshly-queued CX item to mgray ─────────────────
  const mgray = await userAccountRepository.findUserAccountByEmail(TEST_EMAIL);
  if (!mgray) throw new Error(`[smoke] user not found: ${TEST_EMAIL}`);
  const farFuture = new Date(now.getTime() + 4 * 60 * 60 * 1000);
  const { CxDialQueue } = require("../packages/shared-models/src");
  const lockResult = await CxDialQueue.updateMany(
    { domain: DOMAIN, caseId: CASE_ID, state: { $in: ["queued", "ready"] } },
    {
      $set: {
        state: "claimed",
        claimUntil: farFuture,
        assignment: {
          extensionId: mgray.extensionId,
          agentName: mgray.name || TEST_NAME,
          assignedAt: now,
          queueFamilySnapshot: "fresh-day1",
        },
        "metadata.smokeLocked": true,
      },
    },
  );
  console.log(`[smoke] queue lock to ${mgray.extensionId} (${mgray.name}) — modified ${lockResult.modifiedCount}\n`);

  // ── 6. Verify ───────────────────────────────────────────────────
  const items = await CxDialQueue.find({
    domain: DOMAIN,
    caseId: CASE_ID,
    state: { $in: ["queued", "ready", "claimed", "serving", "paused"] },
  }).lean();
  console.log("[smoke] active CxDialQueue rows:");
  for (const it of items) {
    console.log(`  state=${it.state} ext=${it.assignment?.extensionId || "(none)"} agent=${it.assignment?.agentName || "(none)"} phone=${it.phone}`);
  }

  const { LeadCadence } = require("../packages/shared-models/src");
  const fresh = await LeadCadence.findOne({ domain: DOMAIN, caseId: CASE_ID }).lean();
  const freshActions = fresh?.schedule?.actions || [];
  console.log("\n[smoke] cadence action statuses (post-fire), first 4:");
  for (const a of freshActions.slice(0, 4)) {
    console.log(`  ${a.key.padEnd(14)} ch=${a.channel.padEnd(5)} status=${a.status}`);
  }
  const completedSms = freshActions.find((a) => a.channel === "sms" && (a.status === "completed" || a.status === "requested"));
  const completedEmail = freshActions.find((a) => a.channel === "email" && (a.status === "completed" || a.status === "requested"));

  console.log("\n[smoke] SUMMARY");
  console.log(`  SMS to ${TEST_PHONE}:    ${completedSms ? "✅ SENT" : "❌ FAILED"}`);
  console.log(`  email to ${TEST_EMAIL}: ${completedEmail ? "✅ SENT" : "❌ FAILED"}`);
  console.log(`  CX queue (locked):     ${items.length > 0 ? "✅ DIALABLE in /cx" : "❌ MISSING"}`);

  await mongoose.disconnect();
  console.log("\n[smoke] done");
}

main().catch((error) => {
  console.error("[smoke] FATAL:", error.stack || error.message);
  process.exit(1);
});
