#!/usr/bin/env node
"use strict";

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
const mongoose = require("mongoose");

const { createRingcxVoiceClient } = require("../packages/shared-integrations/src");
const { cxBulkLoadSessionRepository } = require("../packages/shared-repositories/src");
const {
  buildCxAccountActiveCallWatchPlan,
} = require("../packages/shared-services/src/cxAccountActiveCallWatcherService");
const { watchCxBulkLoadAccountActiveCalls } = require("../packages/shared-services/src");

function argValue(name) {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length).trim() : "";
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function numArg(name, fallback = 0) {
  const n = Number(argValue(name));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redactProjection(projection = {}) {
  return {
    rail: projection.rail,
    sessionId: projection.sessionId,
    agentEmail: projection.agentEmail,
    agentExtensionId: projection.agentExtensionId,
    accountId: projection.accountId,
    changed: projection.changed === true,
    error: projection.error || null,
    activeCallCount: projection.activeCallCount || 0,
    releasedCount: projection.releasedCount || 0,
    matchStatus: projection.matchStatus || null,
    transitionKind: projection.transitionKind || null,
    currentQueueItemId: projection.currentQueueItemId || null,
    currentUii: projection.currentUii || null,
    terminalObservations: Array.isArray(projection.terminalObservations)
      ? projection.terminalObservations.map((obs) => ({
          source: obs.source || null,
          outcome: obs.outcome || null,
          queueItemId: obs.candidate?.queueItemId || null,
          uii: obs.candidate?.uii || null,
        }))
      : [],
  };
}

async function runOnce({ apply, client, domain, accountId, sessionId, agentEmail, agentExtensionId }) {
  if (apply) {
    return watchCxBulkLoadAccountActiveCalls({ domain, accountId, sessionId, agentEmail, agentExtensionId });
  }
  const sessions = await cxBulkLoadSessionRepository.listActiveBulkLoadSessions({
    domain,
    accountId,
    sessionId,
    agentEmail,
    agentExtensionId,
  });
  return buildCxAccountActiveCallWatchPlan({ client, sessions });
}

function buildPayload({ result, apply }) {
  return {
    mode: apply ? "apply" : "dry-run",
    checkedAt: result.checkedAt,
    summary: result.summary,
    accounts: result.accounts,
    skipped: result.skipped,
    projections: (result.projections || []).map(redactProjection),
    applied: result.applied || null,
  };
}

function printPayload(payload, { json }) {
  if (json) {
    console.log(JSON.stringify(payload));
    return;
  }
  console.log(`[cx-account-watch] ${payload.mode} ${payload.checkedAt}`);
  console.log(JSON.stringify(payload.summary, null, 2));
  for (const account of payload.accounts || []) {
    console.log(`[account] ${account.accountId} sessions=${account.sessionCount} activeCalls=${account.activeCallCount} error=${account.error || "none"}`);
  }
  for (const projection of payload.projections || []) {
    if (!projection.changed && !projection.error && !projection.terminalObservations.length) continue;
    console.log(
      `[session] ${projection.agentEmail || projection.sessionId} changed=${projection.changed} match=${projection.matchStatus} transition=${projection.transitionKind} current=${projection.currentQueueItemId || "none"} uii=${projection.currentUii || "none"} terminals=${projection.terminalObservations.length} error=${projection.error || "none"}`,
    );
  }
  if (payload.applied) {
    console.log(
      `[applied] writes=${payload.applied.writeCount} skipped=${payload.applied.skippedCount || 0} terminals=${payload.applied.terminalWriteCount || 0}`,
    );
  } else {
    console.log("[dry-run] no writes performed; rerun with --apply after inspecting output");
  }
}

async function main() {
  const apply = hasFlag("apply");
  const json = hasFlag("json");
  const domain = argValue("domain") || "";
  const accountId = argValue("accountId") || "";
  const sessionId = argValue("sessionId") || "";
  const agentEmail = argValue("agentEmail") || "";
  const agentExtensionId = argValue("agentExtensionId") || "";
  const intervalMs = numArg("intervalMs", 0);
  const durationMs = numArg("durationMs", 0);
  const explicitIterations = numArg("iterations", 0);
  const iterations = intervalMs > 0
    ? explicitIterations || (durationMs > 0 ? Math.max(Math.ceil(durationMs / intervalMs), 1) : 1)
    : 1;
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.MONGO_URL;
  const dbName = process.env.PARALLEL_DB_NAME || process.env.MONGO_DB_NAME || process.env.DB_NAME || "tagcontactbridge";
  if (!mongoUri) throw new Error("Missing MONGO_URI");

  await mongoose.connect(mongoUri, { dbName });
  const client = createRingcxVoiceClient();

  for (let i = 0; i < iterations; i += 1) {
    const result = await runOnce({ apply, client, domain, accountId, sessionId, agentEmail, agentExtensionId });
    printPayload(buildPayload({ result, apply }), { json });
    if (intervalMs > 0 && i < iterations - 1) await sleep(intervalMs);
  }

  await mongoose.disconnect();
}

main().catch(async (error) => {
  try { await mongoose.disconnect(); } catch {}
  console.error("[cx-account-watch] failed:", error && error.message ? error.message : error);
  process.exitCode = 1;
});
