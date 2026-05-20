"use strict";

// Ubuntu home smoke script.
//
// Live mode sends one SMS to Mickey through the cadence SMS plumbing,
// writes/updates one synthetic LD lead, places one no-dial queue card in
// Mickey's CX workspace, and sends one summary email.
//
// Usage:
//   node scripts/ubuntu-home-smoke.js --run
//   node scripts/ubuntu-home-smoke.js --run --domain TAG --phone 3106665997

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const {
  CaseProfile,
  CxDialQueue,
  LeadCadence,
  MasterProspectIndex,
} = require("../packages/shared-models/src");
const {
  caseProfileRepository,
  leadCadenceRepository,
  masterProspectRepository,
  userAccountRepository,
} = require("../packages/shared-repositories/src");
const { getCompanyConfig } = require("../packages/shared-config/src");
const { sendMail } = require("../packages/shared-services/src/mailerService");
const { sendOutboundText } = require("../packages/shared-services/src/outboundTextService");

const ACTIVE_QUEUE_STATES = ["queued", "ready", "claimed", "serving", "paused"];

function readFlag(argv, name, fallback = null) {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1) return argv[idx + 1];
  return fallback;
}

function normalizeDomain(value) {
  return String(value || "TAG").trim().toUpperCase();
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function boolResult(result) {
  if (!result) return false;
  return result.ok === true || result.queued === true || result.insertedId || result.upsertedId;
}

function formatJson(value) {
  return JSON.stringify(value, null, 2);
}

function buildSummaryText(summary) {
  return [
    "Ubuntu home smoke completed.",
    "",
    `Live mode: ${summary.live}`,
    `Domain: ${summary.domain}`,
    `Fake LD case: ${summary.caseId}`,
    `Lead: ${summary.name} / ${summary.phone} / ${summary.email}`,
    `Assigned workspace user: ${summary.agentName} <${summary.agentEmail}>`,
    `Assigned extension: ${summary.agentExtensionId}`,
    "",
    "Results:",
    `- Synthetic LD lead upserted: ${summary.leadUpserted ? "yes" : "no"}`,
    `- Cadence SMS action: ${summary.smsOk ? "sent" : "failed/skipped"}`,
    `- CX queue card: ${summary.queueOk ? "created" : "failed"}`,
    `- Queue item id: ${summary.queueItemId || "(none)"}`,
    `- Temp URL: ${summary.tempUrl || "(none)"}`,
    "",
    "SMS result:",
    formatJson(summary.smsResult || null),
    "",
    "Queue result:",
    formatJson(summary.queueResult || null),
    "",
    "Notes:",
    "- This script does not publish to RingCX and does not dial.",
    "- Nightly/background workers should remain disabled on Ubuntu.",
  ].join("\n");
}

function buildSummaryHtml(summary) {
  const text = buildSummaryText(summary);
  return `<pre style="white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;line-height:1.4">${escapeHtml(text)}</pre>`;
}

async function sendSummaryEmail({ domain, to, summary }) {
  const subject = `Ubuntu smoke: ${summary.smsOk && summary.queueOk ? "passed" : "check needed"} - ${summary.caseId}`;
  const options = {
    to,
    from: "Chatboy <chatboy@taxadvocategroup.com>",
    subject,
    text: buildSummaryText(summary),
    html: buildSummaryHtml(summary),
  };

  try {
    return await sendMail(domain, options);
  } catch (firstError) {
    const fallbackOptions = {
      to,
      subject: `[fallback sender] ${subject}`,
      text: `${options.text}\n\nChatboy sender failed first:\n${firstError.message}`,
      html: buildSummaryHtml({
        ...summary,
        emailFallbackReason: firstError.message,
      }),
    };
    return sendMail(domain, fallbackOptions);
  }
}

function buildCadenceSchedule(now, smsActionKey, cxActionKey) {
  const smsAt = new Date(now);
  const cxAt = new Date(now.getTime() + 60 * 1000);
  const actions = [
    {
      key: smsActionKey,
      type: "ubuntu-home-smoke-sms",
      channel: "sms",
      templateKey: "ubuntu-home-smoke",
      scheduledFor: smsAt,
      status: "pending",
    },
    {
      key: cxActionKey,
      type: "ubuntu-home-smoke-cx",
      channel: "cx",
      templateKey: "ubuntu-home-smoke",
      scheduledFor: cxAt,
      status: "pending",
    },
  ];

  return {
    planVersion: "ubuntu-home-smoke-v1",
    timezone: "America/Los_Angeles",
    nextActionType: "sms:ubuntu-home-smoke-sms",
    nextActionAt: smsAt,
    actions,
  };
}

async function upsertSyntheticLead({
  domain,
  caseId,
  name,
  firstName,
  lastName,
  email,
  phone,
  trackingNumber,
  now,
  smsActionKey,
  cxActionKey,
}) {
  const validation = {
    phone: {
      onNationalDNC: false,
      onStateDNC: false,
      isLitigator: false,
      isCell: true,
      source: "ubuntu-home-smoke",
    },
    phoneValid: true,
    phoneCanCall: true,
    phoneCanText: true,
    phoneIsCell: true,
    emailValid: true,
    emailCanSend: true,
    emailResult: "test-recipient",
  };
  const schedule = buildCadenceSchedule(now, smsActionKey, cxActionKey);
  const cadenceState = leadCadenceRepository.buildCadenceStateFromActions(schedule.actions);
  const commonSource = {
    intakeSource: "ld",
    intakeRoute: "ld-lead",
    partnerSource: "ld-home-smoke",
    sourceName: "LD Ubuntu Home Smoke",
    sourceChannel: "ld-smoke",
    routeCampaignKey: "ld-ubuntu-home-smoke",
    routeCampaignName: "LD Ubuntu Home Smoke",
    vendorSourceName: "LD Ubuntu Home Smoke",
  };

  const master = await masterProspectRepository.upsertMasterProspect(domain, caseId, {
    statusId: 2,
    statusLabelRaw: "Opened",
    statusCategory: "prospect",
    firstName,
    lastName,
    name,
    email,
    cellPhone: phone,
    normalizedPhones: [phone],
    intakeRoute: commonSource.intakeRoute,
    partnerSource: commonSource.partnerSource,
    firstSeenAt: now,
    lastSeenAt: now,
    needsStatusRefresh: false,
    needsSourceRefresh: false,
    metadata: {
      intakeSource: commonSource.intakeSource,
      sourceName: commonSource.sourceName,
      sourceChannel: commonSource.sourceChannel,
      routeCampaignKey: commonSource.routeCampaignKey,
      routeCampaignName: commonSource.routeCampaignName,
      vendorSourceName: commonSource.vendorSourceName,
      lastImportBatch: "ubuntu-home-smoke",
      validation,
    },
  });

  await caseProfileRepository.upsertCaseProfile(domain, caseId, {
    masterProspectId: master?._id || null,
    statusId: 2,
    statusCategory: "prospect",
    firstName,
    lastName,
    name,
    email,
    primaryPhone: phone,
    normalizedPhones: [phone],
    sourceName: commonSource.sourceName,
    sourceChannel: commonSource.sourceChannel,
    notes: "Synthetic LD smoke lead created by scripts/ubuntu-home-smoke.js",
    convertedAt: null,
  });

  const lead = await leadCadenceRepository.upsertLeadCadence(domain, caseId, {
    externalLeadId: `LD-UBUNTU-HOME-SMOKE-${caseId}`,
    ...commonSource,
    firstName,
    lastName,
    name,
    email,
    primaryPhone: phone,
    normalizedPhone: phone,
    statusId: 2,
    active: true,
    currentStage: "ubuntu-home-smoke-armed",
    cadenceMode: "scheduled-actions",
    schedule,
    cadenceState,
    validationContext: validation,
    attributionContext: {
      trackingNumber,
      contactDomain: domain,
      lockContactDomain: true,
      intakeSource: commonSource.intakeSource,
      intakeRoute: commonSource.intakeRoute,
      sourceName: commonSource.sourceName,
      smokeSource: "ubuntu-home-smoke",
    },
    payloadSnapshot: {
      smoke: true,
      smokeSource: "ubuntu-home-smoke",
      leadBody: {
        caseId: String(caseId),
        firstName,
        lastName,
        name,
        email,
        phone,
        sourceName: commonSource.sourceName,
        intakeSource: commonSource.intakeSource,
        intakeRoute: commonSource.intakeRoute,
      },
      createdBy: "scripts/ubuntu-home-smoke.js",
      createdAt: now.toISOString(),
    },
  });

  return { lead, master };
}

async function sendCadenceSms({ domain, caseId, lead, phone, trackingNumber, actionKey, now }) {
  await leadCadenceRepository.claimScheduledAction(domain, caseId, actionKey, {
    currentStage: "ubuntu-home-smoke-sms-requested",
  });

  const content = [
    "Ubuntu cadence smoke ran.",
    "Email, fake LD lead, and CX queue card are being checked.",
    "No dial was launched.",
  ].join(" ");

  const result = await sendOutboundText({
    domain,
    toPhone: phone,
    trackingNumber,
    content,
    actionKey,
    caseId,
  });

  await leadCadenceRepository.markScheduledActionStatus(
    domain,
    caseId,
    actionKey,
    result.ok ? "completed" : "failed",
    {
      currentStage: result.ok ? "ubuntu-home-smoke-sms-sent" : "ubuntu-home-smoke-sms-failed",
      actionPatch: {
        providerDelivery: {
          provider: "callrail",
          checkedAt: now,
          result,
        },
      },
    },
  );
  await leadCadenceRepository.syncLeadCadenceState(domain, caseId);

  return result;
}

async function createNoDialQueueCard({
  domain,
  caseId,
  lead,
  phone,
  name,
  agent,
  now,
  cxActionKey,
}) {
  await CxDialQueue.updateMany(
    {
      domain,
      caseId,
      "metadata.smokeSource": "ubuntu-home-smoke",
      state: { $in: ACTIVE_QUEUE_STATES },
    },
    {
      $set: {
        state: "cancelled",
        cancelledAt: now,
        "metadata.cancelReason": "superseded-by-new-ubuntu-home-smoke",
      },
    },
  );

  const claimUntil = new Date(now.getTime() + 12 * 60 * 60 * 1000);
  const update = {
    domain,
    caseId,
    leadCadenceId: lead?._id ? String(lead._id) : null,
    phone,
    name,
    intakeSource: "ld",
    intakeRoute: "ld-lead",
    sourceName: "LD Ubuntu Home Smoke",
    state: "claimed",
    queueFamily: "fresh-day1",
    queueFamilyRank: 0,
    queueTier: "day0",
    progressiveStageKey: "just-came-in",
    progressiveStageIndex: 0,
    progressiveStageLabel: "Smoke",
    priorityScore: 1000,
    releaseAt: now,
    claimUntil,
    lastClaimedAt: now,
    assignment: {
      extensionId: agent.extensionId,
      agentName: agent.name || agent.email,
      assignedAt: now,
      queueFamilySnapshot: "fresh-day1",
    },
    callPlan: {
      phaseIndex: 0,
      delaysMinutes: [5, 115, 120],
      activeDay: 0,
      nextDelayMinutes: 5,
    },
    metadata: {
      actionKey: cxActionKey,
      smokeSource: "ubuntu-home-smoke",
      smokeTest: true,
      fakeLdLead: true,
      noDial: true,
      doNotPublishToRingCx: true,
      rcxVisibilityStatus: "not-published",
      rcxVisibilityReason: "home-smoke-no-dial-test",
      assignedEmail: agent.email,
      assignedExtensionId: agent.extensionId,
      assignedAgentName: agent.name || agent.email,
      createdBy: "scripts/ubuntu-home-smoke.js",
      createdAt: now.toISOString(),
    },
  };

  return CxDialQueue.findOneAndUpdate(
    {
      domain,
      caseId,
      "metadata.actionKey": cxActionKey,
    },
    { $set: update },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
}

async function verifyState({ domain, caseId, agentExtensionId }) {
  const [lead, master, caseProfile, queueItems] = await Promise.all([
    LeadCadence.findOne({ domain, caseId }).lean(),
    MasterProspectIndex.findOne({ domain, caseId }).lean(),
    CaseProfile.findOne({ domain, caseId }).lean(),
    CxDialQueue.find({
      domain,
      caseId,
      state: { $in: ACTIVE_QUEUE_STATES },
      "assignment.extensionId": agentExtensionId,
    }).lean(),
  ]);
  return {
    lead: Boolean(lead),
    master: Boolean(master),
    caseProfile: Boolean(caseProfile),
    queueItems: queueItems.map((item) => ({
      id: String(item._id),
      state: item.state,
      name: item.name,
      phone: item.phone,
      assignedExtensionId: item.assignment?.extensionId || null,
      noDial: item.metadata?.noDial === true,
    })),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const live = argv.includes("--run");
  const now = new Date();
  const domain = normalizeDomain(readFlag(argv, "--domain", "TAG"));
  const name = readFlag(argv, "--name", "Mickey Gray");
  const email = readFlag(argv, "--email", "mgray@taxadvocategroup.com");
  const phone = normalizePhone(readFlag(argv, "--phone", "3106665997"));
  const agentEmail = readFlag(argv, "--agent-email", email);
  const caseId = Number(readFlag(argv, "--case-id", "99005997"));
  const company = getCompanyConfig(domain);
  const trackingNumber = normalizePhone(
    readFlag(argv, "--tracking-number", company.integrations?.callrail?.trackingNumber || ""),
  );
  const tempUrl =
    readFlag(argv, "--url", process.env.UBUNTU_SMOKE_TEST_URL || process.env.PUBLIC_APP_URL || "");

  if (!live) {
    console.log("Dry run only. Pass --run to write DB rows and send email/SMS.");
    console.log(formatJson({ domain, name, email, phone, agentEmail, caseId, trackingNumber, tempUrl }));
    return;
  }

  if (!Number.isFinite(caseId) || caseId <= 0) {
    throw new Error(`Invalid --case-id: ${caseId}`);
  }
  if (!phone || phone.length !== 10) {
    throw new Error(`Invalid --phone: ${phone || "(empty)"}`);
  }
  if (!trackingNumber || trackingNumber.length !== 10) {
    throw new Error(`Missing ${domain} CallRail tracking number`);
  }

  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(process.env.MONGO_URI, { dbName });

  const agent = await userAccountRepository.findUserAccountByEmail(agentEmail);
  if (!agent) throw new Error(`Agent user not found: ${agentEmail}`);
  if (!agent.extensionId) throw new Error(`Agent ${agentEmail} has no extensionId`);

  const [firstName, ...restName] = name.trim().split(/\s+/);
  const lastName = restName.join(" ") || "Smoke";
  const stamp = now.getTime();
  const smsActionKey = `ubuntu-home-smoke-sms-${stamp}`;
  const cxActionKey = `ubuntu-home-smoke-cx-${stamp}`;

  const { lead } = await upsertSyntheticLead({
    domain,
    caseId,
    name,
    firstName,
    lastName,
    email,
    phone,
    trackingNumber,
    now,
    smsActionKey,
    cxActionKey,
  });

  let smsResult = null;
  try {
    smsResult = await sendCadenceSms({
      domain,
      caseId,
      lead,
      phone,
      trackingNumber,
      actionKey: smsActionKey,
      now,
    });
  } catch (error) {
    smsResult = { ok: false, error: error.message, stack: error.stack };
    await leadCadenceRepository.markScheduledActionStatus(
      domain,
      caseId,
      smsActionKey,
      "failed",
      { currentStage: "ubuntu-home-smoke-sms-exception" },
    ).catch(() => null);
  }

  const queueItem = await createNoDialQueueCard({
    domain,
    caseId,
    lead,
    phone,
    name,
    agent,
    now,
    cxActionKey,
  });

  const verification = await verifyState({
    domain,
    caseId,
    agentExtensionId: agent.extensionId,
  });

  const summary = {
    live,
    domain,
    caseId,
    name,
    email,
    phone,
    tempUrl,
    agentName: agent.name || agent.email,
    agentEmail: agent.email,
    agentExtensionId: agent.extensionId,
    leadUpserted: verification.lead && verification.master && verification.caseProfile,
    smsOk: Boolean(smsResult?.ok),
    smsResult,
    queueOk: Boolean(queueItem?._id),
    queueItemId: queueItem?._id ? String(queueItem._id) : null,
    queueResult: verification.queueItems,
  };

  let emailResult = null;
  try {
    emailResult = await sendSummaryEmail({ domain, to: email, summary });
  } catch (error) {
    emailResult = { ok: false, error: error.message, stack: error.stack };
  }
  summary.emailOk = boolResult(emailResult);
  summary.emailResult = emailResult;

  console.log(formatJson(summary));

  await mongoose.disconnect();

  if (!summary.queueOk || !summary.leadUpserted || !summary.emailOk || !summary.smsOk) {
    process.exitCode = 1;
  }
}

main().catch(async (error) => {
  console.error(error.stack || error.message);
  try {
    await mongoose.disconnect();
  } catch (_) {
    // ignore shutdown cleanup errors
  }
  process.exit(1);
});
