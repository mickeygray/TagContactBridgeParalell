"use strict";

// FIRST-TOUCH DRIP DISPATCHER (the serving half of the cxft lane, 2026-07-07).
// Stamped rows (metadata.firstTouchPending — minted by the 4001 intake, F0 slice) are
// invisible to the bulk rails (H5 exclusions). This dispatcher is what serves them:
// round-robin over the per-agent first-touch campaigns, published IMMEDIATE so the new
// lead rings while it is still warm. Mickey's flag model: the mark releases on
// consumption (F2, the drain) — this file only CLAIMS and PUBLISHES.
//
// Exactly-once: a dotted CAS claim (metadata.firstTouchDispatch stamped only when null)
// BEFORE the publish; a rejected publish releases the claim so the next tick retries.
// Flag: CX_FIRST_TOUCH_ENABLED (default off) + CX_FIRST_TOUCH_QUEUE_MAP (JSON, per-agent
// campaign ids). No map = no dispatch, loudly.

const { CxDialQueue } = require("../../shared-models/src");
const { publishBatchToRingcx } = require("./cxBulkLoadRingcxPublisher");
const { buildLaneExternId, parseAgentQueueMap } = require("./cxLaneRegistry");
const { logCxAlpha } = require("./cxAlphaTraceService");

function str(value) {
  return String(value == null ? "" : value).trim();
}

// PURE. Deterministic round-robin: row i (oldest first) goes to agent (offset + i) % n.
function assignRoundRobin(rows = [], agents = [], offset = 0) {
  if (!rows.length || !agents.length) return [];
  return rows.map((row, index) => ({
    row,
    agent: agents[(offset + index) % agents.length],
  }));
}

function defaultDeps() {
  return {
    isEnabled: () =>
      String(process.env.CX_FIRST_TOUCH_ENABLED || "false").trim().toLowerCase() === "true",
    resolveQueueMap: () => parseAgentQueueMap(process.env.CX_FIRST_TOUCH_QUEUE_MAP),
    loadPendingRows: (limit) =>
      CxDialQueue.find({
        "metadata.firstTouchPending": true,
        "metadata.firstTouchDispatch": null,
        state: { $in: ["queued", "ready"] },
      })
        .sort({ createdAt: 1 })
        .limit(limit)
        .lean(),
    // the CAS claim: only the winner sees modifiedCount 1
    claimRow: async (rowId, claim) => {
      const result = await CxDialQueue.updateOne(
        { _id: rowId, "metadata.firstTouchDispatch": null },
        { $set: { "metadata.firstTouchDispatch": claim } },
      );
      return (result.modifiedCount ?? result.nModified ?? 0) > 0;
    },
    stampRow: (rowId, fields) => CxDialQueue.updateOne({ _id: rowId }, { $set: fields }),
    releaseClaim: (rowId) =>
      CxDialQueue.updateOne({ _id: rowId }, { $set: { "metadata.firstTouchDispatch": null } }),
    publishBatch: publishBatchToRingcx,
  };
}

function createCxFirstTouchDispatcher(input = {}) {
  const deps = { ...defaultDeps(), ...input };
  const { client, logger = console } = input;
  let rrOffset = 0; // in-memory fairness cursor; a restart just restarts the rotation

  async function tickOnce({ now = new Date(), limit = 25 } = {}) {
    if (!deps.isEnabled()) return { skipped: true, reason: "flag-off" };
    const agents = deps.resolveQueueMap();
    if (!agents.length) {
      logCxAlpha("cx.alpha.firsttouch.dispatch.skipped", { reason: "empty-queue-map" }, { logger });
      return { skipped: true, reason: "empty-queue-map" };
    }
    const rows = await deps.loadPendingRows(limit);
    if (!rows.length) return { dispatched: 0, pending: 0 };

    const assignments = assignRoundRobin(rows, agents, rrOffset);
    rrOffset = (rrOffset + rows.length) % agents.length;

    let dispatched = 0;
    let failed = 0;
    for (const { row, agent } of assignments) {
      const externId = buildLaneExternId("firstTouch", {
        domain: row.domain,
        queueItemId: row._id,
      });
      const claim = {
        claimedAt: now.toISOString(),
        agentEmail: agent.agentEmail,
        campaignId: agent.campaignId,
        externId,
      };
      const won = await deps.claimRow(row._id, claim).catch(() => false);
      if (!won) continue; // another tick/process owns it

      try {
        const publish = await deps.publishBatch(client, {
          campaignId: agent.campaignId,
          dialPriority: "IMMEDIATE",
          candidates: [{
            externId,
            phone: row.phone || null,
            name: row.name || row.metadata?.name || null,
            domain: row.domain,
            caseId: row.caseId,
            queueItemId: String(row._id),
          }],
        });
        const accepted = Array.isArray(publish?.accepted) && publish.accepted.length > 0;
        if (!accepted) throw new Error(publish?.rejected?.[0]?.reason || "publish-rejected");
        await deps.stampRow(row._id, {
          "metadata.firstTouchDispatch": { ...claim, dispatchedAt: new Date().toISOString() },
          "metadata.firstTouchExternId": externId,
        });
        dispatched += 1;
        logCxAlpha("cx.alpha.firsttouch.dispatched", {
          queueItemId: String(row._id),
          caseId: row.caseId,
          agentEmail: agent.agentEmail,
          campaignId: agent.campaignId,
          externId,
        }, { logger });
      } catch (error) {
        failed += 1;
        await deps.releaseClaim(row._id).catch(() => null); // next tick retries
        logCxAlpha("cx.alpha.firsttouch.dispatch.failed", {
          queueItemId: String(row._id),
          agentEmail: agent.agentEmail,
          error: error?.message,
        }, { logger });
      }
    }
    return { dispatched, failed, pending: rows.length - dispatched - failed };
  }

  return { tickOnce };
}

module.exports = {
  createCxFirstTouchDispatcher,
  assignRoundRobin, // exported for pins; pure
};
