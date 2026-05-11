"use strict";

// Replay a single legacy LeadCadence into the parallel intake pipeline.
//
// During the FORWARD_LD_TO_NEW_GATEWAY cutover window, leads that
// arrived BEFORE the forwarder was active landed in the old monolith's
// `test` DB only. They have a real Logics caseId already, but no
// presence in the parallel DB — so they're invisible to the cadence
// engine and the CX queue.
//
// This script reads one legacy lead by caseId, then calls
// `intakeLdLead` directly with `skipLogicsCreate: true` so the
// parallel-side LeadCadence + CaseProfile + cadence schedule are
// created without double-creating the Logics case.
//
// Usage:
//   node scripts/migrate-legacy-lead-by-caseid.js --caseId 112285
//   node scripts/migrate-legacy-lead-by-caseid.js --caseId 112285 --dry
//
// Reads MONGO_URI from .env. The legacy DB is the URI's default db
// ("test"); the parallel DB comes from PARALLEL_DB_NAME.

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const {
  LeadCadence,
  CaseProfile,
} = require("../packages/shared-models/src");
const {
  intakeLdLead,
} = require("../packages/shared-services/src");
const {
  leadCadenceRepository,
} = require("../packages/shared-repositories/src");

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

async function fetchLegacyLeadByCaseId(legacyConn, caseIdStr) {
  // Legacy LeadCadence schema isn't loaded here (different shape from
  // parallel), so query the raw collection. Mongoose persists in
  // `leadcadences` for the model name "LeadCadence".
  const coll = legacyConn.collection("leadcadences");
  // Legacy stores caseId as a STRING (per the row we already saw).
  // Try both string and number for safety.
  const doc = await coll.findOne({
    $or: [{ caseId: caseIdStr }, { caseId: Number(caseIdStr) }],
  });
  return doc;
}

async function main() {
  const argv = process.argv.slice(2);
  const caseIdStr = readFlag(argv, "--caseId");
  const dry = hasFlag(argv, "--dry");

  if (!caseIdStr) {
    console.error("Missing --caseId <id>");
    process.exit(1);
  }

  // 1. Open a SECOND connection for the legacy `test` DB. The default
  //    mongoose.connect goes to PARALLEL_DB_NAME (set below).
  const legacyConn = await mongoose
    .createConnection(process.env.MONGO_URI, { dbName: "test" })
    .asPromise();
  const legacyLead = await fetchLegacyLeadByCaseId(legacyConn, caseIdStr);
  if (!legacyLead) {
    console.error(`Legacy lead not found for caseId=${caseIdStr}`);
    await legacyConn.close();
    process.exit(1);
  }

  console.log(`══ Migrate legacy lead → parallel ══`);
  console.log(`  caseId:    ${legacyLead.caseId}`);
  console.log(`  domain:    ${legacyLead.company || legacyLead.domain || "WYNN"}`);
  console.log(`  name:      ${legacyLead.name}`);
  console.log(`  email:     ${legacyLead.email}`);
  console.log(`  phone:     ${legacyLead.phone}`);
  console.log(`  source:    ${legacyLead.source}`);
  console.log(`  legacy createdAt: ${legacyLead.createdAt?.toISOString()}`);
  console.log(`  mode:      ${dry ? "DRY" : "COMMIT"}\n`);

  // 2. Connect to PARALLEL DB on the default mongoose connection.
  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(process.env.MONGO_URI, { dbName });

  // Pre-flight: is this caseId already in the parallel LeadCadence?
  const existing = await LeadCadence.findOne({
    domain: String(legacyLead.company || "WYNN").toUpperCase(),
    caseId: Number(legacyLead.caseId),
  }).lean();
  if (existing) {
    console.log(`[skip] parallel LeadCadence already exists: _id=${existing._id}`);
    await mongoose.disconnect();
    await legacyConn.close();
    return;
  }

  // 3. Build payload that mirrors what the vendor would have POSTed.
  //    Including caseId so the parallel side reuses the existing Logics
  //    case identity instead of creating a duplicate (combined with
  //    skipLogicsCreate: true).
  const payload = {
    name: legacyLead.name || "",
    first_name: legacyLead.firstName || "",
    last_name: legacyLead.lastName || "",
    email: legacyLead.email || "",
    phone: legacyLead.phone || "",
    state: legacyLead.state || "",
    city: legacyLead.city || "",
    company: String(legacyLead.company || "WYNN").toUpperCase(),
    caseId: Number(legacyLead.caseId),
    // Carry over consent tokens if they were captured.
    xxTrustedFormCertUrl: legacyLead.trustedFormCertUrl || "",
    leadid_token: legacyLead.jornayaLeadId || "",
  };

  if (dry) {
    console.log(`[dry] would call intakeLdLead with payload:`);
    console.log(JSON.stringify(payload, null, 2));
    await mongoose.disconnect();
    await legacyConn.close();
    return;
  }

  // 4. Run the parallel intake pipeline.
  console.log(`[intake] calling intakeLdLead with skipLogicsCreate=true...`);
  const result = await intakeLdLead(payload, {
    headers: { "user-agent": "migrate-legacy-lead-by-caseid" },
    sourceService: "migrate-legacy-lead-by-caseid",
    skipLogicsCreate: true,
  });
  console.log(`[intake] result:`, JSON.stringify(result, null, 2));

  // 5. Verify creation.
  const after = await LeadCadence.findOne({
    domain: payload.company,
    caseId: payload.caseId,
  });
  if (!after) {
    console.error(`[verify] ✗ no parallel LeadCadence created — investigate.`);
    await mongoose.disconnect();
    await legacyConn.close();
    return;
  }
  console.log(`\n[verify] ✓ parallel LeadCadence created`);
  console.log(`  _id:          ${after._id}`);
  console.log(`  intakeRoute:  ${after.intakeRoute}`);
  console.log(`  intakeSource: ${after.intakeSource}`);
  console.log(`  scheduled actions: ${after.schedule?.actions?.length || 0}`);

  // 6. Mirror legacy outreach state.
  //
  // The fresh LeadCadence has a brand-new schedule that includes
  // welcome-email, first-text, etc. — actions the legacy app already
  // fired before we migrated. If we don't suppress those here, the
  // parallel cadence engine will re-send them and the lead gets
  // duplicate outreach.
  //
  // Strategy: read legacy counters, sort scheduled actions by
  // scheduledFor ascending per channel, and mark the first N actions
  // per channel as `status: "completed-legacy-mirror"`. Also stamp
  // cadenceCounters + lastTouched so the cadence engine sees a lead
  // that's already past its day-0 outreach.
  const legacyCounters = {
    sms: Number(legacyLead.textsSent || 0),
    email: Number(legacyLead.emailsSent || (legacyLead.welcomeEmailSent ? 1 : 0)),
    rvm: Number(legacyLead.rvmsSent || 0),
  };
  const legacyLastTouched = {
    sms: legacyLead.lastTextedAt ? new Date(legacyLead.lastTextedAt) : null,
    email: legacyLead.lastEmailedAt ? new Date(legacyLead.lastEmailedAt) : null,
    rvm: legacyLead.lastRvmAt ? new Date(legacyLead.lastRvmAt) : null,
  };

  console.log(`\n[mirror] legacy counters: sms=${legacyCounters.sms}  email=${legacyCounters.email}  rvm=${legacyCounters.rvm}`);

  // Per-channel: pick the first N actions (by scheduledFor asc) and
  // flip their status. Using `cancelled` instead of "completed" because
  // the schema's enum only allows pending/requested/completed/cancelled/
  // failed and `completed` implies an actual fire-and-result envelope
  // that we don't have. `cancelled` semantically: "skipped because it
  // was already fired by the legacy system."
  const actions = Array.isArray(after.schedule?.actions) ? after.schedule.actions : [];
  const cancelledByChannel = { sms: 0, email: 0, rvm: 0 };
  for (const channel of ["sms", "email", "rvm"]) {
    const N = legacyCounters[channel];
    if (N <= 0) continue;
    const channelActions = actions
      .map((a, idx) => ({ a, idx }))
      .filter((entry) => entry.a.channel === channel)
      .sort(
        (x, y) =>
          new Date(x.a.scheduledFor).getTime() -
          new Date(y.a.scheduledFor).getTime(),
      )
      .slice(0, N);
    for (const { idx } of channelActions) {
      after.schedule.actions[idx].status = "cancelled";
      cancelledByChannel[channel] += 1;
    }
  }

  // Stamp counters + lastTouched so the cadence engine treats the
  // lead as one whose day-0 has already passed.
  after.cadenceCounters = {
    ...(after.cadenceCounters?.toObject?.() || after.cadenceCounters || {}),
    sms: legacyCounters.sms,
    email: legacyCounters.email,
    rvm: legacyCounters.rvm,
  };
  after.lastTouched = {
    ...(after.lastTouched?.toObject?.() || after.lastTouched || {}),
    sms: legacyLastTouched.sms || after.lastTouched?.sms || null,
    email: legacyLastTouched.email || after.lastTouched?.email || null,
    rvm: legacyLastTouched.rvm || after.lastTouched?.rvm || null,
  };
  after.markModified("schedule.actions");
  after.markModified("cadenceCounters");
  after.markModified("lastTouched");
  await after.save();

  console.log(
    `[mirror] cancelled actions in parallel schedule:  sms=${cancelledByChannel.sms}  email=${cancelledByChannel.email}  rvm=${cancelledByChannel.rvm}`,
  );

  // 7. Mirror legacy DNC blocks.
  // Legacy already decided rvmDnc=true for Vincent (national-dnc). We
  // mirror that decision via channelDnc.rvm so the parallel cadence
  // engine doesn't re-fire RVMs even if there are post-day-0 RVM
  // actions in the schedule.
  if (legacyLead.rvmDnc) {
    await leadCadenceRepository.markChannelDnc(
      payload.company,
      payload.caseId,
      "rvm",
      `legacy-mirror:${legacyLead.rvmDncReason || "rvm-dnc"}`,
    );
    console.log(`[mirror] channelDnc.rvm blocked (legacy reason: ${legacyLead.rvmDncReason || "rvm-dnc"})`);
  }
  if (legacyLead.smsDnc) {
    await leadCadenceRepository.markChannelDnc(
      payload.company,
      payload.caseId,
      "sms",
      `legacy-mirror:${legacyLead.smsDncReason || "sms-dnc"}`,
    );
    console.log(`[mirror] channelDnc.sms blocked (legacy reason: ${legacyLead.smsDncReason || "sms-dnc"})`);
  }

  // 8. Final verify
  const finalDoc = await LeadCadence.findOne({
    domain: payload.company,
    caseId: payload.caseId,
  }).lean();
  const cp = await CaseProfile.findOne({
    domain: payload.company,
    caseId: payload.caseId,
  }).lean();
  const remainingByChannel = { sms: 0, email: 0, rvm: 0, cx: 0 };
  for (const a of finalDoc.schedule?.actions || []) {
    if (a.status === "pending" || a.status === "requested") {
      remainingByChannel[a.channel] = (remainingByChannel[a.channel] || 0) + 1;
    }
  }
  console.log(`\n[verify-final] CaseProfile present: ${cp ? "yes" : "no"}`);
  console.log(
    `[verify-final] cadenceCounters:  sms=${finalDoc.cadenceCounters?.sms}  email=${finalDoc.cadenceCounters?.email}  rvm=${finalDoc.cadenceCounters?.rvm}  cx=${finalDoc.cadenceCounters?.cx}`,
  );
  console.log(
    `[verify-final] remaining-pending: sms=${remainingByChannel.sms}  email=${remainingByChannel.email}  rvm=${remainingByChannel.rvm}  cx=${remainingByChannel.cx}`,
  );
  console.log(
    `[verify-final] channelDnc:        sms=${finalDoc.cadenceState?.channelDnc?.sms?.blocked ? "blocked" : "open"}  rvm=${finalDoc.cadenceState?.channelDnc?.rvm?.blocked ? "blocked" : "open"}  cx=${finalDoc.cadenceState?.channelDnc?.cx?.blocked ? "blocked" : "open"}`,
  );

  await mongoose.disconnect();
  await legacyConn.close();
  console.log(`\n[done]`);
}

main().catch((err) => {
  console.error("FATAL:", err.stack || err.message);
  process.exit(1);
});
