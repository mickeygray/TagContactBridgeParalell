#!/usr/bin/env node
"use strict";

// Conservatively stamp each agent's dedicated headless BARGE MONITOR extension
// onto their UserAccount record, under metadata.barge (Mixed field -> no schema
// change, preserves any existing metadata.* keys). Idempotent: skips records
// already set to the same value. Matches by EMAIL (unique) to avoid name drift.
//
// Dry-run by default. To actually write:  node scripts/assign-barge-monitor-extensions.js --apply
//
// The monitor extension is the headless softphone that dials *82<agentExt> on the
// agent's behalf (the "barger"); it is NOT the agent's own extensionNumber.

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
const mongoose = require("mongoose");

// monitor extension -> { name, email of the agent it serves }
const MONITOR_ASSIGNMENTS = [
  { monitorExt: "987", monitorName: "PHIL", email: "polson@taxadvocategroup.com" },
  { monitorExt: "1101", monitorName: "SEAN", email: "slucas@taxadvocategroup.com" },
  { monitorExt: "1102", monitorName: "BRUCE", email: "ballen@taxadvocategroup.com" },
  { monitorExt: "1103", monitorName: "ANTHONY", email: "acalloway@taxadvocategroup.com" },
  { monitorExt: "1104", monitorName: "CHRIS", email: "cbolt@taxadvocategroup.com" },
  { monitorExt: "1105", monitorName: "JAMES", email: "jsharp@taxadvocategroup.com" },
  { monitorExt: "1106", monitorName: "BRAD", email: "bhansen@taxadvocategroup.com" },
];

(async () => {
  const apply = process.argv.includes("--apply");
  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(process.env.MONGO_URI, { dbName });
  const col = mongoose.connection.db.collection("useraccounts");

  console.log(`DB=${dbName}  mode=${apply ? "APPLY (writing)" : "DRY-RUN (no writes)"}\n`);

  let planned = 0;
  let skipped = 0;
  let missing = 0;

  for (const a of MONITOR_ASSIGNMENTS) {
    const email = a.email.toLowerCase();
    const doc = await col.findOne(
      { email },
      { projection: { name: 1, email: 1, extensionNumber: 1, "metadata.barge": 1 } },
    );

    if (!doc) {
      missing += 1;
      console.log(`MISSING  ${a.monitorName} -> ${email}  (no UserAccount; skipped)`);
      continue;
    }

    const current = doc.metadata?.barge?.monitorExtension || null;
    const label = `${a.monitorName} mon=${a.monitorExt} -> ${doc.name} (agentExt=${doc.extensionNumber || "?"})`;

    if (current === a.monitorExt) {
      skipped += 1;
      console.log(`UNCHANGED ${label}  (already set)`);
      continue;
    }

    planned += 1;
    const action = current ? `CHANGE (was ${current})` : "SET";
    console.log(`${apply ? "WROTE   " : "WOULD   "} ${action}  ${label}`);

    if (apply) {
      await col.updateOne(
        { _id: doc._id },
        {
          $set: {
            "metadata.barge.monitorExtension": a.monitorExt,
            "metadata.barge.monitorName": a.monitorName,
            "metadata.barge.source": "assign-barge-monitor-extensions",
            "metadata.barge.updatedAt": new Date(),
          },
        },
      );
    }
  }

  console.log(`\nsummary: planned=${planned} unchanged=${skipped} missing=${missing} (${apply ? "applied" : "dry-run"})`);
  await mongoose.disconnect();
})().catch(async (e) => {
  console.error("failed:", e.message);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
