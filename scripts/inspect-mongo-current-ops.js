"use strict";

// Snapshot what Mongo is doing right now. Prints the active operations
// + the most-frequent slow query shapes if the profiler is enabled.
// Used to pin down "what's hammering Atlas?" without waiting for the
// Performance Advisor to catch up.
//
// Usage: node scripts/inspect-mongo-current-ops.js [--sample 5]

require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
const mongoose = require("mongoose");

function parseArgs(argv) {
  const args = { sample: 1, sleepMs: 1000 };
  for (let i = 0; i < argv.length; i += 1) {
    const v = argv[i];
    if (v === "--sample") {
      args.sample = Math.max(Number(argv[i + 1]) || 1, 1);
      i += 1;
    } else if (v === "--sleep") {
      args.sleepMs = Math.max(Number(argv[i + 1]) || 1000, 100);
      i += 1;
    }
  }
  return args;
}

function fmtMs(ns) {
  if (!Number.isFinite(ns)) return "?";
  return ns >= 1000 ? `${(ns / 1000).toFixed(1)}s` : `${ns}ms`;
}

async function snapshot(adminDb) {
  const res = await adminDb.command({
    currentOp: 1,
    active: true,
    $or: [
      { op: "query" },
      { op: "command" },
      { op: "getmore" },
      { "command.aggregate": { $exists: true } },
      { "command.find": { $exists: true } },
    ],
  });
  return res.inprog || [];
}

function summarizeOp(op) {
  const ns = op.ns || "?";
  const planSummary = op.planSummary || op.command?.planSummary || "?";
  const command = op.command || {};
  const verb = command.find
    ? "find"
    : command.aggregate
      ? "aggregate"
      : command.update
        ? "update"
        : command.delete
          ? "delete"
          : op.op || "?";
  const filter = command.filter || command.q || (command.pipeline ? { pipeline: command.pipeline.slice(0, 2) } : {});
  const filterPreview = JSON.stringify(filter).slice(0, 180);
  return {
    opid: op.opid,
    ns,
    verb,
    msRunning: op.microsecs_running ? Math.round(op.microsecs_running / 1000) : op.secs_running ? op.secs_running * 1000 : null,
    planSummary,
    docsExamined: op.docsExamined ?? op.numYields ?? null,
    docsReturned: op.nreturned ?? null,
    keysExamined: op.keysExamined ?? null,
    client: op.client || op.clientMetadata?.application?.name || null,
    desc: op.desc || null,
    filter: filterPreview,
  };
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  await mongoose.connect(uri, { dbName: process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel" });
  const adminDb = mongoose.connection.db.admin();
  console.log(`\nConnected to ${process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel"}`);
  console.log(`Sampling ${args.sample} time(s), ${args.sleepMs}ms apart\n`);

  const allOpsBySig = new Map();

  for (let i = 0; i < args.sample; i += 1) {
    const ops = await snapshot(adminDb);
    console.log(`=== sample ${i + 1}/${args.sample} (${new Date().toISOString()}) — ${ops.length} active op(s) ===`);
    for (const op of ops) {
      const s = summarizeOp(op);
      // Skip Mongo's own internal ops + idle cursors
      if (s.ns?.startsWith("admin.") || s.ns?.startsWith("config.") || s.ns?.startsWith("local.")) continue;
      if (s.desc?.includes("conn") && s.verb === "?" && !s.msRunning) continue;
      const sig = `${s.verb} ${s.ns} plan=${s.planSummary}`;
      if (!allOpsBySig.has(sig)) allOpsBySig.set(sig, { ...s, count: 0, totalMs: 0 });
      const agg = allOpsBySig.get(sig);
      agg.count += 1;
      agg.totalMs += s.msRunning || 0;
      console.log(`  [${s.opid}] ${s.verb} ${s.ns} — running ${fmtMs(s.msRunning)}, plan=${s.planSummary}`);
      if (s.docsExamined != null || s.docsReturned != null) {
        console.log(`      docsExamined=${s.docsExamined} docsReturned=${s.docsReturned} keysExamined=${s.keysExamined}`);
      }
      console.log(`      filter: ${s.filter}`);
      if (s.client) console.log(`      client: ${s.client}`);
    }
    console.log("");
    if (i < args.sample - 1) await new Promise((r) => setTimeout(r, args.sleepMs));
  }

  if (args.sample > 1 && allOpsBySig.size > 0) {
    console.log("\n=== Across all samples — by query shape ===");
    for (const [sig, agg] of [...allOpsBySig.entries()].sort((a, b) => b[1].count - a[1].count)) {
      console.log(`  ${agg.count}× ${sig}`);
      console.log(`      total wall time: ${fmtMs(agg.totalMs)}, avg=${fmtMs(Math.round(agg.totalMs / agg.count))}`);
    }
  }

  // Profiler check — if enabled, show the top recent slow queries.
  try {
    const db = mongoose.connection.db;
    const profileLevel = await db.command({ profile: -1 });
    console.log(`\nProfiler level: ${profileLevel.was} (slowms=${profileLevel.slowms})`);
    if (profileLevel.was > 0) {
      const recent = await db
        .collection("system.profile")
        .find({})
        .sort({ ts: -1 })
        .limit(10)
        .toArray();
      console.log(`\nLast 10 profiled queries:`);
      for (const p of recent) {
        const ratio = p.nreturned > 0 ? Math.round(p.docsExamined / p.nreturned) : "∞";
        console.log(`  ${p.ts?.toISOString()} ${p.op} ${p.ns} — ${p.millis}ms scanned=${p.docsExamined} returned=${p.nreturned} (${ratio}:1) plan=${p.planSummary}`);
        if (p.filter) console.log(`    filter: ${JSON.stringify(p.filter).slice(0, 180)}`);
      }
    } else {
      console.log("Profiler is off — enable with `db.setProfilingLevel(1, { slowms: 100 })` in Atlas to capture slow query details.");
    }
  } catch (error) {
    console.log(`Profiler query failed: ${error.message}`);
  }

  await mongoose.disconnect();
})().catch(async (e) => {
  console.error(e);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
