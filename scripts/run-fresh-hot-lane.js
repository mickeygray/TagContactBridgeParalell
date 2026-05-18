"use strict";

const path = require("path");
require("dotenv").config({
  path: path.resolve(__dirname, "..", ".env"),
  override: true,
});

const mongoose = require("mongoose");
const {
  getFreshHotLaneSnapshot,
  rebuildFreshHotLane,
  runFreshHotLaneAllocator,
} = require("../packages/shared-services/src");

function readFlag(argv, name) {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  if (index >= 0 && index < argv.length - 1) return argv[index + 1];
  return null;
}

function readBooleanFlag(argv, name) {
  return argv.includes(name) || String(readFlag(argv, name) || "").toLowerCase() === "true";
}

function parseDomains(raw) {
  if (!raw) return null;
  return String(raw)
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
}

function summarizeAssignment(entry = {}) {
  return {
    domain: entry.domain || null,
    ok: Boolean(entry.ok),
    requested: Number(entry.requested || 0),
    assigned: Number(entry.assigned || 0),
    skipped: Number(entry.skipped || 0),
    reasons: Array.from(new Set(
      (entry.results || [])
        .map((result) => result.reason || result.detail || null)
        .filter(Boolean),
    )),
  };
}

function summarizeResult(result = {}) {
  return {
    ok: Boolean(result.ok),
    mode: result.mode || null,
    generatedAt: result.generatedAt || null,
    windowStart: result.windowStart || null,
    windowEnd: result.windowEnd || null,
    domains: result.domains || [],
    count: Number(result.count || 0),
    byState: result.byState || null,
    before: result.before || null,
    after: result.after || null,
    sweep: result.sweep
      ? {
        requeuedCount: Number(result.sweep.requeuedCount || 0),
        staleServingRequeuedCount: Number(result.sweep.staleServingRequeuedCount || 0),
        releasedCount: Number(result.sweep.releasedCount || 0),
      }
      : null,
    assigned: Number(result.assigned || 0),
    assignments: Array.isArray(result.assignments)
      ? result.assignments.map(summarizeAssignment)
      : [],
  };
}

async function connectMongo() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new Error("MONGO_URI is required; this app uses the Atlas database, not a local Mongo fallback.");
  }
  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(uri, { dbName });
  return dbName;
}

async function main() {
  const argv = process.argv.slice(2);
  const domains = parseDomains(readFlag(argv, "--domains") || readFlag(argv, "--domain"));
  const maxCount = Math.min(Math.max(Number(readFlag(argv, "--max")) || 50, 1), 500);
  const claimMinutes = Math.max(Number(readFlag(argv, "--claim-minutes")) || 15, 1);
  const mode = readFlag(argv, "--mode") || "manual-script";
  const rebuildOnly = readBooleanFlag(argv, "--rebuild-only");
  const dbName = await connectMongo();

  try {
    const result = rebuildOnly
      ? await rebuildFreshHotLane({ mode, domains })
      : await runFreshHotLaneAllocator({
        mode,
        domains,
        maxCount,
        claimMinutes,
        requestKeyPrefix: `fresh-hot-lane:script:${Date.now()}`,
      });

    const snapshot = getFreshHotLaneSnapshot();
    console.log(JSON.stringify({
      ok: true,
      dbName,
      rebuildOnly,
      result: summarizeResult(result),
      snapshot: {
        generatedAt: snapshot.generatedAt,
        windowStart: snapshot.windowStart,
        windowEnd: snapshot.windowEnd,
        domains: snapshot.domains,
        count: snapshot.count,
      },
    }, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(async (error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error.message,
    stack: error.stack,
  }, null, 2));
  try {
    await mongoose.disconnect();
  } catch (_error) {
    // best effort shutdown
  }
  process.exit(1);
});
