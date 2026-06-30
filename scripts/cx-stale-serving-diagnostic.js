"use strict";

// CX stale-serving SHELL diagnostic (the "Bruce" edge case) — READ-ONLY.
//
// Scans CxDialQueue rows stuck in state:"serving" past a staleness cutoff, reads a fresh per-account
// RingCX active-call snapshot, checks the terminal outbox, and reports which rows are PROVEN stale
// shells (previously-matched UII gone from a confirmed-good snapshot + no terminal outbox row) plus
// the outcome the cleaner WOULD assert. It mutates NOTHING — no queue/outbox/agent writes. Use it to
// observe how often the shape occurs before enabling any auto-clean action.
//
// Usage:
//   node scripts/cx-stale-serving-diagnostic.js                 # default 6-min cutoff, 500 rows
//   node scripts/cx-stale-serving-diagnostic.js --stale-minutes=4
//   node scripts/cx-stale-serving-diagnostic.js --limit=1000 --json
//
// Requires MONGO_URI (+ optional PARALLEL_DB_NAME) and the RingCX env the voice client uses. A RingCX
// read failure for an account is fail-soft: that account's rows are reported skipped
// "snapshot-read-failed", never assumed gone.
//
// NOTE: this read-only runner intentionally does NOT wire the agent-active guard
// (evaluateServingActivity is an internal cadence-service function, not exported), so the report's
// agentActivityGuard is "disabled" and candidateCount is an UPPER BOUND — a mid-wrap agent whose
// RingCX call already dropped can appear as an idle candidate. Wiring that guard is a hard
// precondition before any act-mode. Candidates are also tagged confidence (low-empty-snapshot for an
// idle shape proven only by an empty snapshot) and actionable (false for agent-advanced + low-conf).

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const {
  cxDialQueueRepository,
  cxBulkLoadSessionRepository,
  cxTerminalOutboxRepository,
} = require("../packages/shared-repositories/src");
const {
  createCxStaleServingReconcilerService,
} = require("../packages/shared-services/src/cxStaleServingReconcilerService");
const {
  buildTerminalEvidenceKeys,
} = require("../packages/shared-services/src/cxBulkLoadOutcomeAdapter");
const cxBulkLoadActiveCallWatcher = require("../packages/shared-services/src/cxBulkLoadActiveCallWatcher");
const { createRingcxVoiceClient } = require("../packages/shared-integrations/src");

function parseArgs(argv) {
  const args = { staleMinutes: undefined, limit: undefined, json: false };
  for (const v of argv) {
    if (v === "--json") args.json = true;
    else if (v.startsWith("--stale-minutes=")) args.staleMinutes = Number(v.split("=")[1]);
    else if (v.startsWith("--limit=")) args.limit = Number(v.split("=")[1]);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(uri, { dbName });
  console.log(`Connected to ${dbName} — running stale-serving diagnostic (READ-ONLY)\n`);

  // Reuse the SAME terminal-evidence predicate the control-plane reconciler uses (#12 superset).
  const terminalEvidence = async (row) => {
    const keys = buildTerminalEvidenceKeys(row);
    if (!keys.length) return false;
    const rows = await cxTerminalOutboxRepository.findByIdemKeys(keys);
    return Array.isArray(rows) && rows.length > 0;
  };

  // One RingCX voice client; load each account's active-call snapshot on demand (normalized to
  // {externId, uii, callState, agentId, ...}). A throw here is fail-soft inside the sweep.
  const client = createRingcxVoiceClient();
  const loadAccountActiveCalls = async (accountId) =>
    cxBulkLoadActiveCallWatcher.loadActiveCallsSnapshot(client, {
      product: "ACCOUNT",
      accountId,
      productId: accountId,
    });

  const activeSessions = await cxBulkLoadSessionRepository.listActiveBulkLoadSessions({});
  const activeSessionIds = (Array.isArray(activeSessions) ? activeSessions : [])
    .map((s) => String(s && s.sessionId ? s.sessionId : "").trim())
    .filter(Boolean);

  // Session-join fallback for any serving row whose RingCX account can't be read off the row
  // (rcxAccountId column / metadata) directly — map reservationSessionId -> session.ringcx.accountId.
  const sessionAccount = new Map();
  for (const s of Array.isArray(activeSessions) ? activeSessions : []) {
    const sid = String(s && s.sessionId ? s.sessionId : "").trim();
    const acct = String(s && s.ringcx && s.ringcx.accountId ? s.ringcx.accountId : "").trim();
    if (sid && acct) sessionAccount.set(sid, acct);
  }
  const envAccount = String(process.env.RINGCX_VOICE_ACCOUNT_ID || "").trim();
  const resolveAccountId = async (row) => {
    const sid = String(row && row.metadata && row.metadata.reservationSessionId ? row.metadata.reservationSessionId : "").trim();
    return (sid && sessionAccount.get(sid)) || envAccount || null;
  };

  const service = createCxStaleServingReconcilerService({
    cxDialQueueRepository,
    terminalEvidence,
    loadAccountActiveCalls,
    resolveAccountId,
    logger: console,
  });

  const report = await service.runStaleServingDiagnosticOnce({
    staleMinutes: args.staleMinutes,
    limit: args.limit,
    activeSessionIds,
  });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("\n──────── stale-serving diagnostic ────────");
    console.log(`serving rows scanned : ${report.scannedServing}${report.truncated ? " (TRUNCATED — raise --limit)" : ""}`);
    console.log(`accounts polled      : ${report.accountsPolled} (failed reads: ${report.accountsFailed})`);
    console.log(`agent-active guard   : ${report.agentActivityGuard} (candidateCount is an UPPER BOUND while disabled)`);
    console.log(`stale-shell shells   : ${report.candidateCount}  ${JSON.stringify(report.byShape)}  confidence=${JSON.stringify(report.byConfidence)}`);
    console.log(`  ...high-confidence ACTIONABLE (idle, non-empty snapshot): ${report.actionableCandidateCount}`);
    console.log(`skipped              : ${report.skippedCount}  ${JSON.stringify(report.bySkipReason)}`);
    if (report.candidates.length) {
      console.log("\nsample candidates (no action taken):");
      for (const c of report.candidates) {
        console.log(
          `  • q=${c.queueItemId} acct=${c.accountId} agent=${c.agentKey} uii=${c.priorUii} ` +
          `age=${Math.round((c.ageMs || 0) / 60000)}m shape=${c.shape} conf=${c.confidence} actionable=${c.actionable}` +
          (c.replacementUii ? ` replacedBy=${c.replacementUii}` : "") +
          (c.emptyAccountSnapshot ? " [empty-snapshot]" : "") +
          ` dequeueSeen=${c.dequeueTime != null} -> WOULD ${c.recommendedAction} as ${c.proposedOutcome}`,
        );
      }
    }
    console.log("──────────────────────────────────────────");
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("cx-stale-serving-diagnostic failed:", err && (err.stack || err.message || err));
  try {
    await mongoose.disconnect();
  } catch (_) {
    /* ignore */
  }
  process.exitCode = 1;
});
