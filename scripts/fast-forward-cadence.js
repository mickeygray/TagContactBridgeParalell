"use strict";

// Fast-forward cadence smoke.
//
// Pretends a lead was created N hours/days ago, rebuilds its schedule
// with that backdated receipt time, identifies what's now "due," fires
// it through dispatchForLead, and reports back. Use this to verify
// that re-contact happens at the right beat relative to createdate.
//
// Usage:
//   node scripts/fast-forward-cadence.js                # default: 2h ago
//   node scripts/fast-forward-cadence.js --hoursAgo 5   # 5 hours ago
//   node scripts/fast-forward-cadence.js --daysAgo 1    # 1 day ago
//   node scripts/fast-forward-cadence.js --channel cx   # only fire cx-due
//   node scripts/fast-forward-cadence.js --dry          # don't actually fire
//
// Operates on caseId 101617 (WYNN) with mgray's contact info, mirrors
// what the standard smoke uses. Re-arms the schedule fresh on every
// run so previously-fired actions don't block.

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const {
  createLegacyCadenceSchedule,
} = require("../packages/shared-services/src/cadencePlanService");
const { dispatchForLead } = require("../packages/shared-services/src/outboundDispatchService");
const {
  caseProfileRepository,
  leadCadenceRepository,
  masterProspectRepository,
} = require("../packages/shared-repositories/src");

const DOMAIN = "WYNN";
const CASE_ID = 101617;
const TEST_PHONE = "3106665997";
const TEST_EMAIL = "mgray@taxadvocategroup.com";
const TEST_NAME = "Mickey Gray";

function readFlag(argv, name) {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1) return argv[idx + 1];
  return null;
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function fmtMs(ms) {
  if (Math.abs(ms) < 60_000) return `${Math.round(ms / 1000)}s`;
  if (Math.abs(ms) < 3_600_000) return `${Math.round(ms / 60_000)}min`;
  if (Math.abs(ms) < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

async function main() {
  const argv = process.argv.slice(2);
  const hoursAgo = Number(readFlag(argv, "--hoursAgo")) || 0;
  const daysAgo = Number(readFlag(argv, "--daysAgo")) || 0;
  const targetChannel = readFlag(argv, "--channel"); // null = first due regardless
  const dry = hasFlag(argv, "--dry");

  let offsetMs = (hoursAgo * 3_600_000) + (daysAgo * 86_400_000);
  // Default: 2h ago — puts cx-day0-2 in the past, ready to fire.
  if (offsetMs === 0) offsetMs = 2 * 3_600_000;

  const realNow = new Date();
  const fakeReceipt = new Date(realNow.getTime() - offsetMs);

  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(process.env.MONGO_URI, { dbName });

  console.log(`══ Fast-forward smoke ══`);
  console.log(`  real now:        ${realNow.toISOString()}`);
  console.log(`  fake receipt:    ${fakeReceipt.toISOString()}  (lead "created" ${fmtMs(offsetMs)} ago)`);
  console.log(`  case:            ${DOMAIN}/${CASE_ID}\n`);

  const validation = {
    phone: { onNationalDNC: false, onStateDNC: false, isLitigator: false, isCell: true },
    phoneValid: true, phoneCanCall: true, phoneCanText: true, phoneIsCell: true,
    emailValid: true, emailCanSend: true, emailResult: "valid",
  };

  // Build the schedule as if the lead had arrived at fakeReceipt.
  const schedule = createLegacyCadenceSchedule(fakeReceipt, {}, validation);

  // Identify what's "due now" vs still future relative to realNow.
  const due = schedule.actions
    .filter((a) => new Date(a.scheduledFor).getTime() <= realNow.getTime())
    .filter((a) => !targetChannel || a.channel === targetChannel)
    .filter((a) => a.status === "pending");

  console.log(`  actions in plan:  ${schedule.actions.length}`);
  console.log(`  due-now (in plan vs realNow): ${due.length}\n`);

  if (due.length === 0) {
    console.log(`  No due actions — bump --hoursAgo / --daysAgo or change --channel.`);
    await mongoose.disconnect();
    return;
  }

  console.log(`  Due actions (in firing order):`);
  for (const a of due) {
    const sched = new Date(a.scheduledFor);
    const ago = realNow.getTime() - sched.getTime();
    console.log(`    ${a.key.padEnd(14)} ch=${a.channel.padEnd(5)} type=${a.type.padEnd(22)} due ${fmtMs(ago)} ago`);
  }
  console.log("");

  // Defensive: ensure caseProfile + masterprospect mirror "prospect"
  // status so eligibility doesn't trip on stale data.
  await masterProspectRepository.upsertMasterProspect(DOMAIN, CASE_ID, {
    statusId: 2, statusLabelRaw: "Opened", statusCategory: "prospect",
    firstName: "Mickey", lastName: "Gray", name: TEST_NAME,
    email: TEST_EMAIL, cellPhone: TEST_PHONE, normalizedPhones: [TEST_PHONE],
    firstSeenAt: fakeReceipt, lastSeenAt: realNow,
    needsStatusRefresh: true, needsSourceRefresh: true,
    metadata: { intakeSource: "ld", sourceName: "LD Fast-Forward Smoke" },
  });
  await caseProfileRepository.upsertCaseProfile(DOMAIN, CASE_ID, {
    statusId: 2,
    statusCategory: "prospect",
    firstName: "Mickey", lastName: "Gray", name: TEST_NAME,
    email: TEST_EMAIL,
    primaryPhone: TEST_PHONE, normalizedPhones: [TEST_PHONE],
    convertedAt: null,
  });

  // Persist the backdated schedule on the leadCadence row.
  const leadCadence = await leadCadenceRepository.upsertLeadCadence(DOMAIN, CASE_ID, {
    externalLeadId: `ff-101617-${realNow.getTime()}`,
    intakeRoute: "ld-lead", intakeSource: "ld", partnerSource: "ld-fast-forward",
    firstName: "Mickey", lastName: "Gray", name: TEST_NAME,
    email: TEST_EMAIL,
    primaryPhone: TEST_PHONE, normalizedPhone: TEST_PHONE,
    sourceName: "LD Fast-Forward Smoke", sourceChannel: "ld-smoke",
    statusId: 2, active: true, currentStage: "cadence-armed",
    schedule,
    cadenceState: leadCadenceRepository.buildCadenceStateFromActions(schedule.actions || []),
    validationContext: validation,
    attributionContext: {
      trackingNumber: process.env.WYNN_CALL_RAIL_TRACKING_NUMBER || "3105611009",
      contactDomain: DOMAIN,
      intakeRoute: "ld-lead",
      intakeSource: "ld",
    },
    payloadSnapshot: {
      smoke: true, fastForward: true, fakeReceipt: fakeReceipt.toISOString(),
      caseId: CASE_ID, phone: TEST_PHONE, email: TEST_EMAIL, name: TEST_NAME,
    },
  });

  // Fire each due action one at a time, sequenced. dispatchForLead
  // will pick its own action from lead.schedule.actions so we just
  // tell it which channel to dispatch and let pickAction find the
  // first pending one — which because of the backdated scheduledFor
  // is now in the past and eligible.
  console.log(`══ Firing due actions ══`);
  if (dry) {
    console.log(`  --dry mode: skipping dispatch`);
  } else {
    for (const a of due) {
      console.log(`  → ${a.key} (${a.channel} ${a.type})`);
      try {
        const result = await dispatchForLead(leadCadence, {
          channel: a.channel,
          actionType: a.type,
          updateCadence: true,
          queueDepth: 1,
        });
        const status = result.ok
          ? "✅ sent"
          : result.result?.skipped
            ? `⊘ skipped (${result.result.reason})`
            : `❌ failed (${result.result?.reason || "unknown"})`;
        console.log(`     ${status}`);
        // Re-load leadCadence so the next dispatchForLead sees the
        // freshly-flipped status (else it'd retarget the same action).
        const refreshed = await mongoose.connection.db
          .collection("controlplaneleadcadences")
          .findOne({ domain: DOMAIN, caseId: CASE_ID });
        if (refreshed) {
          Object.assign(leadCadence, refreshed);
        }
      } catch (error) {
        console.log(`     ❌ THROW: ${error.message}`);
      }
    }
  }

  // Final state
  const final = await mongoose.connection.db
    .collection("controlplaneleadcadences")
    .findOne({ domain: DOMAIN, caseId: CASE_ID });
  console.log(`\n══ Action statuses (post-fire) ══`);
  for (const a of (final?.schedule?.actions || []).slice(0, 12)) {
    const sched = new Date(a.scheduledFor);
    const offset = sched.getTime() - realNow.getTime();
    const offsetLabel = offset < 0 ? `-${fmtMs(-offset)}` : `+${fmtMs(offset)}`;
    console.log(`  ${a.key.padEnd(14)} ch=${a.channel.padEnd(5)} status=${(a.status || "?").padEnd(10)} (${offsetLabel} from now)`);
  }

  await mongoose.disconnect();
  console.log(`\n══ Done ══`);
}

main().catch((error) => {
  console.error("[ff] FATAL:", error.stack || error.message);
  process.exit(1);
});
