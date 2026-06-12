#!/usr/bin/env node
"use strict";

// EOD janitor for the live coach gRPC runtime.
//
// Default is dry-run:
//   node scripts/clear-live-coach-grpc-runtime.js
//
// Clear all AI-bus coach sessions and delete retained gRPC segment directories:
//   node scripts/clear-live-coach-grpc-runtime.js --apply
//
// Optional: restart the gRPC bridge after cleanup if you want to force-close any
// still-attached RingCX streams after the floor is done:
//   node scripts/clear-live-coach-grpc-runtime.js --apply --restart-bridge

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_AI_BUS_URL = `http://127.0.0.1:${process.env.AI_BUS_PORT || 7000}`;
const DEFAULT_SEGMENTS_DIR = path.join(ROOT, "runtime", "live-coach-grpc-bridge", "segments");

function hasFlag(argv, name) {
  return argv.includes(name);
}

function readFlag(argv, name, fallback = "") {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1) return argv[idx + 1];
  return fallback;
}

function normalizeUrl(base, route) {
  return new URL(route, base.endsWith("/") ? base : `${base}/`).toString();
}

function serviceHeaders() {
  const secret = String(
    process.env.INTERNAL_SERVICE_SECRET ||
      process.env.OUTBOUND_GATEWAY_SECRET ||
      "",
  ).trim();
  return {
    "content-type": "application/json",
    ...(secret ? { "x-service-secret": secret } : {}),
  };
}

async function requestJson(baseUrl, route, options = {}) {
  const response = await fetch(normalizeUrl(baseUrl, route), {
    ...options,
    headers: {
      ...serviceHeaders(),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!response.ok) {
    const err = new Error(`${options.method || "GET"} ${route} failed ${response.status}`);
    err.response = json;
    throw err;
  }
  return json;
}

function isSafeSegmentsDir(dir) {
  const resolved = path.resolve(dir);
  const expected = path.resolve(DEFAULT_SEGMENTS_DIR);
  if (resolved === expected) return true;

  const normalized = resolved.replace(/\\/g, "/");
  return normalized.endsWith("/runtime/live-coach-grpc-bridge/segments") &&
    normalized.includes("/tagcontactbridge-parallel/");
}

function listSegmentDirs(segmentsDir) {
  if (!fs.existsSync(segmentsDir)) return [];
  return fs.readdirSync(segmentsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(segmentsDir, entry.name));
}

function removeSegmentDirs(segmentsDir) {
  if (!isSafeSegmentsDir(segmentsDir)) {
    throw new Error(`Refusing to delete unexpected segments dir: ${segmentsDir}`);
  }
  fs.mkdirSync(segmentsDir, { recursive: true });
  const dirs = listSegmentDirs(segmentsDir);
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return dirs.length;
}

function runSystemctl(args, { dryRun = true } = {}) {
  const cmd = `systemctl ${args.join(" ")}`;
  if (dryRun) return { skipped: true, command: cmd };
  execFileSync("sudo", ["systemctl", ...args], { stdio: "inherit" });
  return { skipped: false, command: cmd };
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = hasFlag(argv, "--apply");
  const skipApi = hasFlag(argv, "--skip-api");
  const restartBridge = hasFlag(argv, "--restart-bridge");
  const aiBusUrl = readFlag(argv, "--ai-bus-url", DEFAULT_AI_BUS_URL);
  const segmentsDir = path.resolve(readFlag(argv, "--segments-dir", DEFAULT_SEGMENTS_DIR));
  const stopReason = readFlag(argv, "--reason", "eod-grpc-janitor");

  if (!isSafeSegmentsDir(segmentsDir)) {
    throw new Error(`Refusing unexpected segments dir: ${segmentsDir}`);
  }

  const result = {
    ok: true,
    apply,
    aiBusUrl,
    segmentsDir,
    sessionsBefore: null,
    sessionsStopped: 0,
    terminalPrune: null,
    segmentDirsBefore: listSegmentDirs(segmentsDir).length,
    segmentDirsDeleted: 0,
    segmentDirsAfter: null,
    bridgeRestart: null,
    healthAfter: null,
  };

  if (!skipApi) {
    const before = await requestJson(aiBusUrl, "/api/ai/live-coach/grpc/sessions");
    const sessions = Array.isArray(before.sessions) ? before.sessions : [];
    result.sessionsBefore = {
      total: sessions.length,
      listening: sessions.filter((row) => row.status === "listening").length,
      stopped: sessions.filter((row) => row.status === "stopped").length,
      stale: sessions.filter((row) => row.status === "stale").length,
      voicemailRejected: sessions.filter((row) => row.status === "voicemail_rejected").length,
    };

    if (apply) {
      for (const session of sessions) {
        if (!session?.id) continue;
        await requestJson(aiBusUrl, `/api/ai/live-coach/grpc/${encodeURIComponent(session.id)}/stop`, {
          method: "POST",
          body: JSON.stringify({ reason: stopReason }),
        });
        result.sessionsStopped += 1;
      }
      result.terminalPrune = await requestJson(aiBusUrl, "/api/ai/live-coach/prune-terminal", {
        method: "POST",
        body: JSON.stringify({ force: true, apply: true }),
      });
    }
  }

  if (restartBridge) {
    result.bridgeRestart = {
      stop: runSystemctl(["stop", "parallel-live-coach-grpc"], { dryRun: !apply }),
      start: null,
    };
  }

  if (apply) {
    result.segmentDirsDeleted = removeSegmentDirs(segmentsDir);
  }
  result.segmentDirsAfter = listSegmentDirs(segmentsDir).length;

  if (restartBridge) {
    result.bridgeRestart.start = runSystemctl(["start", "parallel-live-coach-grpc"], { dryRun: !apply });
  }

  if (!skipApi) {
    try {
      result.healthAfter = await requestJson(aiBusUrl, "/health");
    } catch (error) {
      result.healthAfter = { ok: false, error: error.message, response: error.response || null };
    }
  }

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
});
