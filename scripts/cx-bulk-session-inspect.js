"use strict";

// WO-9: the sprint's microscope. READ-ONLY. Prints the current bulk session state,
// its buffer + reserved CxDialQueue rows, and the recent terminal-outbox tail so a
// human can see exactly what the rail believes — and, when a lead vanishes, WHICH
// writer's source stamped the outcome. PII-masked (phone digits truncated).
//
// Usage: node scripts/cx-bulk-session-inspect.js [--agent email] [--session id] [--json] [--outbox N]

const mongoose = require("mongoose");
const { getSharedConfig } = require("../packages/shared-config/src");
const { CxBulkLoadSession, CxDialQueue, CxTerminalOutbox } = require("../packages/shared-models/src");

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--json") args.json = true;
  else if (a.startsWith("--")) args[a.slice(2)] = argv[++i];
}

function maskPhone(value) {
  const digits = String(value == null ? "" : value).replace(/\D/g, "");
  return digits.length >= 4 ? `***${digits.slice(-4)}` : digits ? "***" : null;
}

function compactCandidate(c) {
  if (!c) return null;
  return {
    queueItemId: c.queueItemId || null,
    caseId: c.caseId ?? null,
    name: c.name || null,
    externId: c.externId || c.ringcx?.externId || null,
    uii: c.uii || null,
    wrap: c.wrap || null,
    connectedAt: c.connectedAt || null,
    outcome: c.outcome || null,
    phone: maskPhone(c.phone),
  };
}

async function main() {
  const config = getSharedConfig();
  await mongoose.connect(config.mongoUri, { dbName: config.parallelDbName });
  try {
    const sessionQuery = args.session
      ? { sessionId: args.session }
      : { status: "running", ...(args.agent ? { agentEmail: args.agent } : {}) };
    let session = await CxBulkLoadSession.findOne(sessionQuery).sort({ updatedAt: -1 }).lean();
    if (!session && !args.session) {
      session = await CxBulkLoadSession.findOne(args.agent ? { agentEmail: args.agent } : {})
        .sort({ updatedAt: -1 })
        .lean();
    }
    if (!session) {
      console.log("No bulk session found.");
      return;
    }

    const reserved = await CxDialQueue.find(
      { "metadata.reservationSessionId": session.sessionId },
      {
        state: 1,
        caseId: 1,
        queueFamily: 1,
        "metadata.reservationSessionId": 1,
        "metadata.lastRingcxPublishedExternId": 1,
        "metadata.servingAt": 1,
        "metadata.wrapUpRequired": 1,
        updatedAt: 1,
      },
    ).sort({ updatedAt: -1 }).limit(40).lean();

    const outboxLimit = Number(args.outbox) > 0 ? Number(args.outbox) : 12;
    const outbox = await CxTerminalOutbox.find(
      { sessionId: session.sessionId },
      { eventType: 1, queueItemId: 1, uii: 1, outcome: 1, source: 1, systemDisposition: 1, "payload.systemDisposition": 1, status: 1, idemKey: 1, recordedAt: 1, createdAt: 1 },
    ).sort({ createdAt: -1 }).limit(outboxLimit).lean();

    const report = {
      session: {
        sessionId: session.sessionId,
        status: session.status,
        phase: session.phase || null,
        agentEmail: session.agentEmail || null,
        domain: session.domain || null,
        updatedAt: session.updatedAt || null,
        v: session.__v ?? null,
        current: compactCandidate(session.current),
        lastOutcome: session.lastOutcome
          ? { ...compactCandidate(session.lastOutcome), outcome: session.lastOutcome.outcome || null, source: session.lastOutcome.source || null, at: session.lastOutcome.at || null }
          : null,
        reviewHoldUntil: session.reviewHoldUntil || null,
        reviewHoldReason: session.reviewHoldReason || null,
        bufferCount: (session.acceptedBuffer || []).length,
        buffer: (session.acceptedBuffer || []).map(compactCandidate),
        completedTail: (session.completed || []).slice(-6).map((c) => ({
          queueItemId: c.queueItemId || null,
          uii: c.uii || null,
          outcome: c.outcome || null,
          source: c.source || null,
          at: c.at || c.completedAt || null,
        })),
        completedCount: (session.completed || []).length,
        prevActiveExternIds: session.prevActiveExternIds || [],
      },
      reservedRows: reserved.map((row) => ({
        id: String(row._id),
        state: row.state,
        caseId: row.caseId ?? null,
        family: row.queueFamily || null,
        reservationSessionId: row.metadata?.reservationSessionId || null,
        publishedExtern: row.metadata?.lastRingcxPublishedExternId || null,
        servingAt: row.metadata?.servingAt || null,
        wrapUpRequired: row.metadata?.wrapUpRequired ?? null,
        updatedAt: row.updatedAt || null,
      })),
      outboxTail: outbox.map((row) => ({
        eventType: row.eventType || null,
        queueItemId: row.queueItemId || null,
        uii: row.uii || null,
        outcome: row.outcome || null,
        source: row.source || null,
        systemDisposition: row.systemDisposition || row.payload?.systemDisposition || null,
        status: row.status || null,
        idemKey: row.idemKey || null,
        at: row.recordedAt || row.createdAt || null,
      })),
    };

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    const s = report.session;
    console.log(`SESSION ${s.sessionId}  status=${s.status} phase=${s.phase} agent=${s.agentEmail} v=${s.v} updated=${s.updatedAt}`);
    console.log(`CURRENT: ${s.current ? `${s.current.queueItemId} (${s.current.name}) uii=${s.current.uii} lane=${s.current.connectedAt ? `CONNECTED@${s.current.connectedAt}` : "never-connected"} wrap=${s.current.wrap ? JSON.stringify(s.current.wrap) : "no"}` : "(none)"}`);
    if (session.resync) console.log(`RESYNC: ${session.resync.at || "-"} reason=${session.resync.reason || "-"} removed=${(session.resync.removed || []).map((r) => `${r.queueItemId}(${r.why})`).join(", ") || "-"}`);
    console.log(`LAST OUTCOME: ${s.lastOutcome ? `${s.lastOutcome.queueItemId} -> ${s.lastOutcome.outcome} source=${s.lastOutcome.source} at=${s.lastOutcome.at}` : "(none)"}`);
    console.log(`REVIEW HOLD: ${s.reviewHoldReason || "(none)"} until=${s.reviewHoldUntil || "-"}`);
    console.log(`BUFFER (${s.bufferCount}): ${s.buffer.map((b) => `${b.queueItemId}${b.uii ? "*" : ""}`).join(", ") || "-"}`);
    console.log(`COMPLETED (${s.completedCount}), tail:`);
    for (const c of s.completedTail) console.log(`  ${c.at || "-"}  ${c.queueItemId} -> ${c.outcome} source=${c.source || "-"} uii=${c.uii || "-"}`);
    console.log(`PREV ACTIVE EXTERNS: ${s.prevActiveExternIds.join(", ") || "-"}`);
    console.log(`RESERVED ROWS (${report.reservedRows.length}):`);
    for (const r of report.reservedRows) console.log(`  ${r.state.padEnd(9)} case=${String(r.caseId).padEnd(8)} extern=${r.publishedExtern || "-"} sess=${r.reservationSessionId ? "ok" : "MISSING"} serving=${r.servingAt || "-"}`);
    console.log(`OUTBOX TAIL (${report.outboxTail.length}):`);
    for (const o of report.outboxTail) console.log(`  ${o.at || "-"}  [${o.eventType}] ${o.queueItemId} -> ${o.outcome} source=${o.source || "-"}${o.systemDisposition ? ` sys=${o.systemDisposition}` : ""} status=${o.status} uii=${o.uii || "-"}`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error("inspect failed:", error?.message || error);
  process.exitCode = 1;
});
