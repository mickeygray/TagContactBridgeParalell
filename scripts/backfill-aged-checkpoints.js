"use strict";

// One-shot backfill for the rolling aged-pool refresh.
//
// Stamps LeadCadence.dncCheckpoints.nextAt on every active lead that
// has no checkpoint state yet, so the daily 06:00 PT sweep doesn't try
// to scrub every existing lead the first morning it runs.
//
// Rules:
//   ageDays <   30  → nextAt = createdAt + 30d (will be checked on schedule)
//   ageDays in [30, 60) → nextAt = createdAt + 30d (overdue, will fire next tick)
//                          and count = 0 (still needs first scrub)
//   ageDays in [60, 90) → nextAt = createdAt + 60d (overdue, count = 0
//                          because the original monthly burst never wrote
//                          this field — but the first daily tick after
//                          backfill will scrub them and advance)
//   ageDays >= 90 → nextAt = null, cleared = true (past the re-scrub
//                          window — the monthly burst already handled
//                          this cohort historically)
//
// Idempotent: only writes when dncCheckpoints.nextAt is currently null
// AND dncCheckpoints.cleared is not already true AND graduatedAt is
// null. Re-runs are safe.
//
// Usage:
//   node scripts/backfill-aged-checkpoints.js                  # dry-run
//   node scripts/backfill-aged-checkpoints.js --apply          # write
//   node scripts/backfill-aged-checkpoints.js --apply --domain WYNN
//   node scripts/backfill-aged-checkpoints.js --apply --limit 50000

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const { getSharedConfig } = require("../packages/shared-config/src");
const { LeadCadence } = require("../packages/shared-models/src");

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const CHECKPOINT_DAYS = [30, 60, 90];

function parseArgs(argv) {
  const args = { apply: false, domain: null, limit: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") {
      args.apply = true;
    } else if (arg === "--domain") {
      args.domain = String(argv[i + 1] || "").toUpperCase() || null;
      i += 1;
    } else if (arg === "--limit") {
      args.limit = Math.max(Number(argv[i + 1]) || 0, 0);
      i += 1;
    }
  }
  return args;
}

function classifyLead(intakeAt, now) {
  const intakeMs = new Date(intakeAt).getTime();
  if (!Number.isFinite(intakeMs)) {
    return { skip: true, reason: "no-intake-date" };
  }
  const ageDays = (now.getTime() - intakeMs) / MS_PER_DAY;

  if (ageDays < CHECKPOINT_DAYS[0]) {
    // Pre-30d. Schedule the first scrub.
    return {
      bucket: "pre-30d",
      patch: {
        "dncCheckpoints.count": 0,
        "dncCheckpoints.nextAt": new Date(intakeMs + CHECKPOINT_DAYS[0] * MS_PER_DAY),
        "dncCheckpoints.cleared": false,
        "dncCheckpoints.hit": false,
      },
    };
  }
  if (ageDays < CHECKPOINT_DAYS[1]) {
    return {
      bucket: "30-60d",
      patch: {
        "dncCheckpoints.count": 0,
        "dncCheckpoints.nextAt": new Date(intakeMs + CHECKPOINT_DAYS[0] * MS_PER_DAY),
        "dncCheckpoints.cleared": false,
        "dncCheckpoints.hit": false,
      },
    };
  }
  if (ageDays < CHECKPOINT_DAYS[2]) {
    return {
      bucket: "60-90d",
      patch: {
        "dncCheckpoints.count": 0,
        "dncCheckpoints.nextAt": new Date(intakeMs + CHECKPOINT_DAYS[1] * MS_PER_DAY),
        "dncCheckpoints.cleared": false,
        "dncCheckpoints.hit": false,
      },
    };
  }
  // Past 90d — the original monthly burst already handled this cohort.
  // Mark cleared and skip future re-scrubs.
  return {
    bucket: "90d+",
    patch: {
      "dncCheckpoints.count": 3,
      "dncCheckpoints.nextAt": null,
      "dncCheckpoints.cleared": true,
      "dncCheckpoints.hit": false,
      "dncCheckpoints.source": "backfill-pre-rolling-launch",
    },
  };
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const config = getSharedConfig();
  await mongoose.connect(config.mongoUri, { dbName: config.parallelDbName });

  const query = {
    active: true,
    graduatedAt: null,
    $or: [
      { "dncCheckpoints.nextAt": null },
      { "dncCheckpoints.nextAt": { $exists: false } },
    ],
    "dncCheckpoints.cleared": { $ne: true },
    "dncCheckpoints.hit": { $ne: true },
  };
  if (args.domain) query.domain = args.domain;

  const projection = { _id: 1, domain: 1, caseId: 1, createdAt: 1, dncCheckpoints: 1 };
  const cursor = LeadCadence.find(query, projection).lean().cursor();

  const summary = {
    apply: args.apply,
    domain: args.domain || "ALL",
    scanned: 0,
    skipped: 0,
    buckets: { "pre-30d": 0, "30-60d": 0, "60-90d": 0, "90d+": 0 },
    overdueNow: 0,
    updated: 0,
  };

  const now = new Date();
  let processed = 0;
  for await (const doc of cursor) {
    if (args.limit > 0 && processed >= args.limit) break;
    processed += 1;
    summary.scanned += 1;

    const classification = classifyLead(doc.createdAt, now);
    if (classification.skip) {
      summary.skipped += 1;
      continue;
    }

    summary.buckets[classification.bucket] += 1;
    if (
      classification.patch["dncCheckpoints.nextAt"] &&
      classification.patch["dncCheckpoints.nextAt"].getTime() <= now.getTime()
    ) {
      summary.overdueNow += 1;
    }

    if (args.apply) {
      const result = await LeadCadence.updateOne(
        { _id: doc._id },
        { $set: classification.patch },
      );
      summary.updated += Number(result.modifiedCount || 0);
    }
  }

  console.log(JSON.stringify(summary, null, 2));
  if (!args.apply) {
    console.log("");
    console.log("Dry run only. Re-run with --apply to write dncCheckpoints state.");
    console.log("Critical: 'overdueNow' is the count that will be scrubbed by the FIRST daily tick.");
    console.log("If that number is unreasonably large, narrow with --domain or run in tranches.");
  }

  await mongoose.disconnect();
})().catch(async (error) => {
  console.error(error);
  try {
    await mongoose.disconnect();
  } catch (_) {
    // ignore
  }
  process.exit(1);
});
