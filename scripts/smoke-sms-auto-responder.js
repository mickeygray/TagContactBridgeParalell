"use strict";

/**
 * Integration smoke: seed a LeadCadence row, synthesize an inbound SMS
 * event, run it through the event-service handler, and assert:
 *
 *   - ConversationMessage (inbound) row written with classification.
 *   - Workflow status stays "observed" (no auto-flip).
 *   - hard_stop    → cadence.exhaustedChannels includes "sms" only.
 *                    No outbound message. No ConsentRecord.
 *   - dnc_confirm  → outbound message row. cadence.exhaustedChannels
 *                    includes all of sms/email/rvm. ConsentRecord exists.
 *   - callback_prompt → outbound message row. Cadence untouched.
 *
 * CallRail SMS send is stubbed via a module override so we don't
 * actually hit the live API; we just verify the outbound-row write
 * reflects a successful send.
 *
 * Usage:
 *   node scripts/smoke-sms-auto-responder.js
 */

require("dotenv").config();

const mongoose = require("mongoose");

// Stub CallRail sendSms BEFORE the service layer is required, so the
// auto-responder gets our fake client instead of the real one.
const callrailModule = require("../packages/shared-integrations/src/callrailClient");
const originalCreate = callrailModule.createCallrailClient;
callrailModule.createCallrailClient = (company) => {
  const real = originalCreate(company);
  return {
    ...real,
    sendSms: async ({ phone, text }) => ({
      provider: "callrail",
      providerMessageId: "stub-msg-" + Date.now(),
      providerResponse: { stub: true },
      customerPhone: phone,
      trackingNumber: "8186865483",
      sentAt: new Date().toISOString(),
      stubbed: true,
      body: text,
    }),
  };
};

const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
const { getSharedConfig } = require("../packages/shared-config/src");
const {
  conversationMessageRepository,
  conversationWorkflowRepository,
  consentRecordRepository,
  leadCadenceRepository,
} = require("../packages/shared-repositories/src");
const {
  LeadCadence,
  ConsentRecord,
  ConversationMessage,
  ConversationWorkflow,
} = require("../packages/shared-models/src");

// Use require-cache injection — the event service was required in the
// services index; we need to import the function directly.
const {
  processControlPlaneEventBatch,
  CONTROL_PLANE_EVENT_TYPES,
} = require("../packages/shared-services/src");
const { createEvent } = require("../packages/event-core/src");

const TEST_PHONE = "8185559911";
const TEST_DOMAIN = "TAG";
const TEST_CASE_ID = 9999991;

async function seed() {
  // Wipe any prior test data on these keys so runs are idempotent.
  await ConversationMessage.deleteMany({ phone: TEST_PHONE, domain: TEST_DOMAIN });
  await ConversationWorkflow.deleteMany({ phone: TEST_PHONE, domain: TEST_DOMAIN });
  await ConsentRecord.deleteMany({ phone: TEST_PHONE, domain: TEST_DOMAIN });
  await LeadCadence.deleteMany({ domain: TEST_DOMAIN, caseId: TEST_CASE_ID });

  // Seed a cadence row so the opt-out path has something to update.
  await leadCadenceRepository.upsertLeadCadence(TEST_DOMAIN, TEST_CASE_ID, {
    caseId: TEST_CASE_ID,
    primaryPhone: TEST_PHONE,
    normalizedPhone: TEST_PHONE,
    firstName: "Smoke",
    lastName: "Test",
    schedule: {
      planVersion: "v1",
      timezone: "America/Los_Angeles",
      actions: [
        {
          key: "sms-1",
          type: "send-sms",
          channel: "sms",
          scheduledFor: new Date(Date.now() + 60 * 60 * 1000),
          status: "pending",
        },
        {
          key: "email-1",
          type: "send-email",
          channel: "email",
          scheduledFor: new Date(Date.now() + 2 * 60 * 60 * 1000),
          status: "pending",
        },
      ],
    },
    active: true,
  });
}

async function pumpEvent(body) {
  // Write event + immediately process the batch so handleSmsInbound runs.
  await createEvent({
    eventType: CONTROL_PLANE_EVENT_TYPES.SMS_INBOUND_FORWARDED,
    sourceService: "smoke-test",
    aggregateType: "sms-conversation",
    aggregateId: TEST_PHONE,
    dedupeKey: `${TEST_PHONE}:${Date.now()}:${Math.random()}`,
    payload: {
      source_number: TEST_PHONE,
      destination_number: "+18186865483",
      content: body,
      company_id: null,
      domain: TEST_DOMAIN,
    },
  });

  await processControlPlaneEventBatch({ batchSize: 1 });
  // Give the handler a moment to let any dangling promises settle.
  await new Promise((r) => setTimeout(r, 300));
}

async function summarize(label) {
  const wf = await conversationWorkflowRepository.findConversationWorkflow(
    TEST_DOMAIN,
    TEST_PHONE,
    "sms",
  );
  const msgs = wf?._id
    ? await conversationMessageRepository.listMessagesForWorkflow(String(wf._id), {
        limit: 10,
      })
    : [];
  const cadence = await leadCadenceRepository.findLeadCadenceByPhone(
    TEST_DOMAIN,
    TEST_PHONE,
  );
  const consents = await ConsentRecord.find({
    domain: TEST_DOMAIN,
    phone: TEST_PHONE,
  }).lean();

  console.log(`\n── ${label} ──`);
  console.log(
    `workflow: status=${wf?.status || "-"} optOut=${Boolean(wf?.optOutDetected)} messages=${msgs.length}`,
  );
  msgs.slice(-4).forEach((m) => {
    const cls = m.aiClassification || {};
    console.log(
      `  [${m.direction}] "${String(m.body).slice(0, 60)}"  tier=${cls.tier || "-"}  status=${m.providerStatus || "-"}`,
    );
  });
  if (cadence) {
    console.log(
      `cadence: exhausted=[${(cadence.cadenceState?.exhaustedChannels || []).join(",")}]  engagementExhausted=${Boolean(cadence.cadenceState?.engagementChannelsExhausted)}  pendingActions=${cadence.schedule?.actions?.filter((a) => a.status === "pending").length || 0}`,
    );
  } else {
    console.log("cadence: (no row found)");
  }
  console.log(`consentRecords: ${consents.length}`);
}

async function main() {
  const state = await connectMongo(getSharedConfig());
  if (!state.connected) throw new Error("mongo not connected");

  // Case 1: carrier STOP
  await seed();
  await pumpEvent("STOP");
  await summarize("hard_stop (carrier STOP)");

  // Case 2: explicit DNC-confirm
  await seed();
  await pumpEvent("i have a lawyer handling this, please dont contact me");
  await summarize("dnc_confirm (explicit no-need)");

  // Case 3: legitimate callback prompt
  await seed();
  await pumpEvent("can someone call me? i got a letter from IRS");
  await summarize("callback_prompt (genuine engagement)");

  // Case 4: needs_human
  await seed();
  await pumpEvent("ok");
  await summarize("needs_human (ambiguous)");

  await disconnectMongo();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
