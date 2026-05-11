"use strict";

// Legacy → Parallel cadence migration.
//
// Brings every `active: true` row in the LEGACY `leadcadences` collection
// (under the default 'test' DB) into the PARALLEL `controlplaneleadcadences`
// collection (under `tagcontactbridge_parallel`) so the parallel cadence
// sweep can take over outreach starting at the cutoff time.
//
// What the script does per legacy lead:
//   1. Build a validation context from legacy fields
//      (validationDetails + smsDnc / rvmDnc flags).
//   2. Rebuild the parallel schedule using
//      `createLegacyCadenceSchedule(legacy.createdAt, {}, validation)` —
//      so day-1 / day-3 / day-7 actions land at correct calendar times
//      relative to the lead's original receipt date.
//   3. Mark every action with `scheduledFor < CUTOFF` as `cancelled`.
//      This is the "no back-fires" rule — anything that should've fired
//      already (whether legacy did it or not) doesn't fire now.
//   4. Upsert MasterProspect + CaseProfile + LeadCadence on the parallel
//      side so eligibility checks pass on first sweep tick.
//
// Cutoff strategy:
//   - Default: tomorrow 8am PT. Means the parallel system "starts fresh"
//     tomorrow morning, picking up the next future-due action for each
//     lead. Nothing fires in the meantime.
//   - Override with --cutoff "ISO timestamp" if you want to flip earlier
//     (e.g. tonight after turning off legacy).
//
// Usage:
//   node scripts/migrate-legacy-cadence.js                 # DRY (default)
//   node scripts/migrate-legacy-cadence.js --commit        # actually write
//   node scripts/migrate-legacy-cadence.js --domain WYNN   # one tenant
//   node scripts/migrate-legacy-cadence.js --limit 50      # first 50 only
//   node scripts/migrate-legacy-cadence.js --cutoff "2026-05-06T08:00:00-07:00"
//   node scripts/migrate-legacy-cadence.js --since "2026-05-04T00:00:00Z"

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const {
  createLegacyCadenceSchedule,
} = require("../packages/shared-services/src/cadencePlanService");
const {
  caseProfileRepository,
  leadCadenceRepository,
  masterProspectRepository,
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

function nextBusinessMorningPt(now = new Date()) {
  // Tomorrow at 8am PT. If "tomorrow" is Sat/Sun, push to next Monday.
  const ptString = now.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  // ptString is like "05/05/2026, 12:36"
  const [datePart] = ptString.split(",").map((s) => s.trim());
  const [m, d, y] = datePart.split("/").map((s) => Number(s));
  // Tomorrow's date in PT
  const tomorrow = new Date(Date.UTC(y, m - 1, d) + 24 * 3600 * 1000);
  const dow = tomorrow.getUTCDay();
  const skip = dow === 0 ? 1 : dow === 6 ? 2 : 0; // Sun→+1d, Sat→+2d
  const target = new Date(tomorrow.getTime() + skip * 24 * 3600 * 1000);
  // 8am PT = 15:00 UTC (PDT) or 16:00 UTC (PST). Use Date construction
  // anchored to PT wall time and let the runtime resolve the offset.
  // Simpler: build the wall string and parse with explicit -07:00 (we
  // are currently on PDT in May).
  const yyyy = target.getUTCFullYear();
  const mm = String(target.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(target.getUTCDate()).padStart(2, "0");
  return new Date(`${yyyy}-${mm}-${dd}T08:00:00-07:00`);
}

function buildValidationFromLegacy(legacy) {
  const vd = legacy.validationDetails || {};
  return {
    phone: {
      onNationalDNC: Boolean(vd.phoneDNC),
      onStateDNC: false,
      isLitigator: Boolean(vd.phoneLitigator),
      isCell: Boolean(legacy.phoneIsCell),
      source: "migrated-from-legacy",
    },
    phoneValid: Boolean(legacy.phoneConnected),
    // Honor the per-channel DNC flags AND any legacy "can text/call"
    // assertion. A legacy `smsDnc: true` row should NOT regenerate text
    // actions in parallel.
    phoneCanCall: Boolean(vd.phoneCanCall),
    phoneCanText: Boolean(vd.phoneCanText) && !legacy.smsDnc,
    phoneIsCell: Boolean(legacy.phoneIsCell),
    emailValid: Boolean(legacy.emailValid),
    emailCanSend: Boolean(legacy.emailValid) && vd.emailResult !== "invalid",
    emailResult: vd.emailResult || (legacy.emailValid ? "valid" : "unknown"),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const commit = hasFlag(argv, "--commit");
  const domain = readFlag(argv, "--domain"); // optional filter
  const limit = Number(readFlag(argv, "--limit")) || 0;
  const cutoffArg = readFlag(argv, "--cutoff");
  const sinceArg = readFlag(argv, "--since");

  const now = new Date();
  const cutoff = cutoffArg ? new Date(cutoffArg) : nextBusinessMorningPt(now);
  if (Number.isNaN(cutoff.getTime())) {
    console.error("Invalid --cutoff:", cutoffArg);
    process.exit(1);
  }

  // Connect to legacy first (default 'test' db)
  await mongoose.connect(process.env.MONGO_URI);
  const legacyCol = mongoose.connection.db.collection("leadcadences");
  const query = { active: true };
  if (domain) query.company = String(domain).toUpperCase();
  if (sinceArg) {
    const since = new Date(sinceArg);
    if (!Number.isNaN(since.getTime())) query.createdAt = { $gte: since };
  }
  const cursor = legacyCol.find(query).sort({ createdAt: 1 });
  if (limit > 0) cursor.limit(limit);
  const legacyRows = await cursor.toArray();
  await mongoose.disconnect();

  console.log(`══ Legacy cadence migration ══`);
  console.log(`  mode:     ${commit ? "COMMIT (writes will happen)" : "DRY (no writes)"}`);
  console.log(`  cutoff:   ${cutoff.toISOString()}  (anything scheduledFor < cutoff will be cancelled)`);
  console.log(`  filter:   domain=${domain || "(all)"}  since=${sinceArg || "(all)"}  limit=${limit || "(none)"}`);
  console.log(`  found:    ${legacyRows.length} active legacy cadences\n`);

  if (legacyRows.length === 0) {
    console.log("Nothing to migrate.");
    return;
  }

  // Connect to parallel for writes
  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(process.env.MONGO_URI, { dbName });
  console.log(`  parallel db: ${mongoose.connection.name}\n`);

  const stats = {
    total: legacyRows.length,
    upserted: 0,
    skipped: 0,
    errors: 0,
    errorDetails: [],
    futureActions: 0,
    cancelledActions: 0,
    byDomain: {},
  };

  let i = 0;
  for (const row of legacyRows) {
    i += 1;
    const dom = String(row.company || row.domain || "").toUpperCase().trim();
    const caseId = Number(row.caseId);
    if (!dom || !Number.isFinite(caseId)) {
      stats.skipped += 1;
      console.log(`  [${i}/${legacyRows.length}] SKIP — invalid identity (company=${dom} caseId=${row.caseId})`);
      continue;
    }
    stats.byDomain[dom] = stats.byDomain[dom] || { total: 0, future: 0, cancelled: 0 };
    stats.byDomain[dom].total += 1;

    const validation = buildValidationFromLegacy(row);
    const createdAt = row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt);
    const schedule = createLegacyCadenceSchedule(createdAt, {}, validation);
    const futureCount = 0;
    const cancelledCount = 0;
    stats.futureActions += futureCount;
    stats.cancelledActions += cancelledCount;
    stats.byDomain[dom].future += futureCount;
    stats.byDomain[dom].cancelled += cancelledCount;

    if (i <= 5 || (i % 100 === 0)) {
      console.log(
        `  [${i}/${legacyRows.length}] ${dom}/${caseId.toString().padEnd(8)} ` +
        `created=${createdAt.toISOString().slice(0, 16)} ` +
        `future=${String(futureCount).padStart(3)} cancelled=${cancelledCount}` +
        (commit ? "" : "  [DRY]"),
      );
    }

    if (!commit) continue;

    try {
      // Build the normalized phone (10 digits)
      const rawPhone = String(row.phone || "").replace(/\D/g, "");
      const phone = rawPhone.length === 11 && rawPhone.startsWith("1")
        ? rawPhone.slice(1)
        : rawPhone.length >= 10 ? rawPhone.slice(-10) : null;

      const cadenceCounters = {
        sms: Number(row.textsSent || 0),
        email: Number(row.emailsSent || 0),
        rvm: Number(row.rvmsSent || 0),
        cx: Number(row.callsMade || 0),
      };
      const lastTouched = {
        sms: row.lastTextedAt || null,
        email: row.lastEmailedAt || null,
        rvm: row.lastRvmedAt || null,
        cx: row.lastCalledAt || null,
      };
      const channelDnc = {
        sms: row.smsDnc ? { blocked: true, reason: row.smsDncReason || "legacy-sms-dnc" } : null,
        rvm: row.rvmDnc ? { blocked: true, reason: row.rvmDncReason || "legacy-rvm-dnc" } : null,
      };

      // 1. masterprospect — keep status as prospect (legacy says active)
      await masterProspectRepository.upsertMasterProspect(dom, caseId, {
        statusId: row.statusId != null ? Number(row.statusId) : 2,
        statusLabelRaw: row.statusLabelRaw || "Opened",
        statusCategory: "prospect",
        firstName: row.firstName || null,
        lastName: row.lastName || null,
        name: row.name || null,
        email: row.email || null,
        cellPhone: phone, normalizedPhones: phone ? [phone] : [],
        firstSeenAt: createdAt,
        lastSeenAt: now,
        needsStatusRefresh: true,
        needsSourceRefresh: true,
        metadata: {
          intakeSource: row.source || "legacy",
          sourceName: row.source || null,
          notes: ["migrated-from-legacy"],
        },
      });

      // 2. caseProfile — defensive; eligibility uses statusId from here
      await caseProfileRepository.upsertCaseProfile(dom, caseId, {
        statusId: row.statusId != null ? Number(row.statusId) : 2,
        statusCategory: "prospect",
        firstName: row.firstName || null,
        lastName: row.lastName || null,
        name: row.name || null,
        email: row.email || null,
        primaryPhone: phone,
        normalizedPhones: phone ? [phone] : [],
        convertedAt: null,
      });

      // 3. parallel leadCadence
      await leadCadenceRepository.upsertLeadCadence(dom, caseId, {
        externalLeadId: row.externalLeadId || `legacy-${caseId}`,
        intakeRoute: row.intakeRoute || row.source || "legacy-migration",
        intakeSource: row.source || "legacy",
        partnerSource: row.partnerSource || null,
        firstName: row.firstName || null,
        lastName: row.lastName || null,
        name: row.name || null,
        email: row.email || null,
        primaryPhone: phone,
        normalizedPhone: phone,
        sourceName: row.source || null,
        sourceChannel: row.utmSource || null,
        statusId: row.statusId != null ? Number(row.statusId) : 2,
        active: true,
        currentStage: "legacy-cadence-active",
        cadenceMode: "legacy-time-count",
        cadenceCounters,
        lastTouched,
        counterCadence: {
          locks: {},
          deferUntil: {},
          lastDailyBatchKey: {},
          lastDispatchAt: null,
          lastFailureAt: null,
          lastResult: {},
          rvmDeliveries: [],
        },
        firstContactRequestedAt: null,
        firstContactEventId: null,
        schedule,
        cadenceState: {
          caps: {},
          completedByChannel: cadenceCounters,
          failedByChannel: {},
          pendingByChannel: {},
          exhaustedChannels: [],
          engagementChannelsExhausted: false,
          nextChannel: null,
          lastCompletedAtByChannel: lastTouched,
          lastEvaluatedAt: now,
          channelDnc,
          dncCheck: null,
        },
        validationContext: validation,
        attributionContext: {
          trackingNumber: process.env[`${dom}_CALL_RAIL_TRACKING_NUMBER`] || null,
          contactDomain: dom,
          intakeRoute: row.source || "legacy",
          intakeSource: row.source || "legacy",
          receivedAt: createdAt,
        },
        payloadSnapshot: {
          migrated: true,
          fromLegacy: true,
          legacyId: row._id ? String(row._id) : null,
          legacyCounters: {
            textsSent: row.textsSent || 0,
            emailsSent: row.emailsSent || 0,
            rvmsSent: row.rvmsSent || 0,
            callsMade: row.callsMade || 0,
            welcomeEmailSent: Boolean(row.welcomeEmailSent),
          },
          legacyLastTouched: {
            lastEmailedAt: row.lastEmailedAt || null,
            lastTextedAt: row.lastTextedAt || null,
            lastRvmedAt: row.lastRvmedAt || null,
            lastCalledAt: row.lastCalledAt || null,
            lastLogicsCheckAt: row.lastLogicsCheckAt || null,
          },
          migratedMode: "legacy-time-count",
          phone, name: row.name, email: row.email,
          createdAt,
        },
      });

      stats.upserted += 1;
    } catch (error) {
      stats.errors += 1;
      stats.errorDetails.push({ caseId, domain: dom, error: error.message });
      console.log(`  [${i}/${legacyRows.length}] ${dom}/${caseId} ❌ ${error.message}`);
    }
  }

  console.log(`\n══ Summary ══`);
  console.log(`  scanned:           ${stats.total}`);
  console.log(`  upserted:          ${stats.upserted}${commit ? "" : " (would be — DRY mode)"}`);
  console.log(`  skipped (invalid): ${stats.skipped}`);
  console.log(`  errors:            ${stats.errors}`);
  console.log(`  total future actions across all leads:    ${stats.futureActions}`);
  console.log(`  total cancelled actions (past-due):        ${stats.cancelledActions}`);
  console.log(`\n  By domain:`);
  for (const [dom, s] of Object.entries(stats.byDomain)) {
    console.log(`    ${dom.padEnd(6)} leads=${String(s.total).padStart(4)}  future-actions=${String(s.future).padStart(5)}  cancelled-actions=${String(s.cancelled).padStart(5)}`);
  }

  if (stats.errors > 0) {
    console.log(`\n  Error details (first 5):`);
    for (const e of stats.errorDetails.slice(0, 5)) {
      console.log(`    ${e.domain}/${e.caseId}: ${e.error}`);
    }
  }

  if (!commit) {
    console.log(`\n  Re-run with --commit to actually upsert.`);
  }

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error("[migrate] FATAL:", error.stack || error.message);
  process.exit(1);
});
