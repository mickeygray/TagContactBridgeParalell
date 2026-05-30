"use strict";

// Backfill active CX queue items with lead state/timezone metadata from the
// source LeadCadence / MasterProspectIndex rows. Dry-run by default.
//
// Usage:
//   node scripts/backfill-cx-dial-queue-lead-state.js
//   node scripts/backfill-cx-dial-queue-lead-state.js --commit

const mongoose = require("mongoose");
const { getSharedConfig } = require("../packages/shared-config/src");
const {
  CxDialQueue,
  LeadCadence,
  MasterProspectIndex,
} = require("../packages/shared-models/src");

const ACTIVE_STATES = ["queued", "ready", "claimed", "serving", "paused"];

function hasFlag(argv, name) {
  return argv.includes(name);
}

function readFlag(argv, name, fallback = "") {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  if (index >= 0 && index < argv.length - 1) return argv[index + 1];
  return fallback;
}

function clean(value) {
  return String(value || "").trim();
}

function cleanState(value) {
  const raw = clean(value).toUpperCase();
  return /^[A-Z]{2}$/.test(raw) ? raw : "";
}

function pickLeadState(cadence = null, prospect = null) {
  return cleanState(
    cadence?.state ||
      cadence?.payloadSnapshot?.state ||
      prospect?.state ||
      prospect?.payloadSnapshot?.state,
  );
}

function pickLeadTimeZone(cadence = null, prospect = null) {
  return clean(
    cadence?.payloadSnapshot?.timezone ||
      cadence?.payloadSnapshot?.timeZone ||
      prospect?.timezone ||
      prospect?.timeZone ||
      prospect?.payloadSnapshot?.timezone ||
      prospect?.payloadSnapshot?.timeZone,
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const commit = hasFlag(argv, "--commit");
  const limit = Math.min(Math.max(Number(readFlag(argv, "--limit", "5000")) || 5000, 1), 50000);
  const domain = clean(readFlag(argv, "--domain", "")).toUpperCase();
  const config = getSharedConfig();

  await mongoose.connect(config.mongoUri, { dbName: config.parallelDbName });
  try {
    const query = {
      state: { $in: ACTIVE_STATES },
      $or: [
        { "metadata.leadState": { $exists: false } },
        { "metadata.leadState": null },
        { "metadata.leadState": "" },
        { "metadata.leadTimeZone": { $exists: false } },
        { "metadata.leadTimeZone": null },
        { "metadata.leadTimeZone": "" },
      ],
    };
    if (domain) query.domain = domain;

    const items = await CxDialQueue.find(query)
      .select({ domain: 1, caseId: 1, metadata: 1 })
      .limit(limit)
      .lean();

    const summary = {
      commit,
      scanned: items.length,
      patched: 0,
      patchable: 0,
      unresolved: 0,
      byState: {},
      examples: [],
    };

    for (const item of items) {
      const [cadence, prospect] = await Promise.all([
        LeadCadence.findOne({ domain: item.domain, caseId: item.caseId })
          .select({
            state: 1,
            "payloadSnapshot.state": 1,
            "payloadSnapshot.timezone": 1,
            "payloadSnapshot.timeZone": 1,
          })
          .lean(),
        MasterProspectIndex.findOne({ domain: item.domain, caseId: item.caseId })
          .select({
            state: 1,
            timezone: 1,
            timeZone: 1,
            "payloadSnapshot.state": 1,
            "payloadSnapshot.timezone": 1,
            "payloadSnapshot.timeZone": 1,
          })
          .lean(),
      ]);
      const leadState = pickLeadState(cadence, prospect);
      const leadTimeZone = pickLeadTimeZone(cadence, prospect);
      if (!leadState && !leadTimeZone) {
        summary.unresolved += 1;
        continue;
      }

      summary.patchable += 1;
      if (leadState) summary.byState[leadState] = (summary.byState[leadState] || 0) + 1;
      if (summary.examples.length < 15) {
        summary.examples.push({
          domain: item.domain,
          caseId: item.caseId,
          leadState: leadState || null,
          leadTimeZone: leadTimeZone || null,
        });
      }
      if (!commit) continue;

      const set = {};
      if (leadState) set["metadata.leadState"] = leadState;
      if (leadTimeZone) set["metadata.leadTimeZone"] = leadTimeZone;
      set["metadata.leadStateBackfilledAt"] = new Date();
      const result = await CxDialQueue.updateOne({ _id: item._id }, { $set: set });
      if (result.modifiedCount > 0) summary.patched += 1;
    }

    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
