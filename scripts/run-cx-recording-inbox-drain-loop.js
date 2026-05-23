#!/usr/bin/env node
"use strict";

// Small standalone runner for the RingCX SFTP recording inbox drain.
//
// The drain service itself is intentionally just one tick of work. This
// script owns the "keep checking every few minutes" behavior for the local
// SFTP receiver / Windows test bed, without tying it to the control-plane
// hourly worker.
//
// Usage:
//   node scripts/run-cx-recording-inbox-drain-loop.js
//   node scripts/run-cx-recording-inbox-drain-loop.js --once
//   node scripts/run-cx-recording-inbox-drain-loop.js --dry-run --interval-ms 300000

const path = require("path");
const mongoose = require("mongoose");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const {
  runCxRecordingInboxDrainTick,
  getConfig,
} = require("../packages/shared-services/src/cxRecordingInboxDrainService");

function arg(name, fallback = null) {
  const inline = process.argv.find((entry) => entry.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && idx < process.argv.length - 1) return process.argv[idx + 1];
  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function now() {
  return new Date().toISOString();
}

function createLogger() {
  return {
    info(message, meta) {
      console.log(JSON.stringify({ at: now(), level: "info", message, meta: meta || null }));
    },
    warn(message, meta) {
      console.warn(JSON.stringify({ at: now(), level: "warn", message, meta: meta || null }));
    },
    error(message, meta) {
      console.error(JSON.stringify({ at: now(), level: "error", message, meta: meta || null }));
    },
  };
}

async function connectMongo() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(uri, { dbName });
}

async function main() {
  const intervalMs = Math.max(Number(arg("--interval-ms") || process.env.CX_RECORDING_INBOX_DRAIN_INTERVAL_MS || 300000), 30000);
  const once = hasFlag("--once");
  const dryRun = hasFlag("--dry-run");
  const logger = createLogger();
  const cfg = getConfig();
  let running = false;
  let stopping = false;

  console.log(JSON.stringify({
    at: now(),
    level: "info",
    message: "cx-inbox-drain-loop.starting",
    meta: {
      inboxDir: cfg.inboxDir,
      processedDir: cfg.processedDir,
      unknownDir: cfg.unknownDir,
      maxPerTick: cfg.maxPerTick,
      intervalMs,
      once,
      dryRun,
    },
  }));

  await connectMongo();

  async function tick(reason) {
    if (running) {
      logger.warn("cx-inbox-drain-loop.tick_skipped_running", { reason });
      return null;
    }
    running = true;
    try {
      const result = await runCxRecordingInboxDrainTick({ logger, dryRun });
      logger.info("cx-inbox-drain-loop.tick_completed", {
        reason,
        scanned: result.scanned,
        uploaded: result.uploaded,
        deduped: result.deduped,
        unknownNoUii: result.unknownNoUii,
        unknownNoCallLog: result.unknownNoCallLog,
        errors: result.errors,
        skipped: result.skipped || false,
        skipReason: result.reason || null,
        durationMs: result.durationMs,
      });
      return result;
    } catch (error) {
      logger.error("cx-inbox-drain-loop.tick_failed", { reason, error: error.message });
      return null;
    } finally {
      running = false;
    }
  }

  async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    logger.info("cx-inbox-drain-loop.stopping", { signal });
    try {
      await mongoose.disconnect();
    } catch (_) {
      // best effort
    }
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await tick("startup");
  if (once) {
    await shutdown("once");
    return;
  }

  setInterval(() => {
    tick("interval").catch((error) => {
      logger.error("cx-inbox-drain-loop.interval_error", { error: error.message });
    });
  }, intervalMs);
}

main().catch(async (error) => {
  console.error(JSON.stringify({
    at: now(),
    level: "error",
    message: "cx-inbox-drain-loop.fatal",
    meta: { error: error.message },
  }));
  try {
    await mongoose.disconnect();
  } catch (_) {
    // best effort
  }
  process.exit(1);
});
