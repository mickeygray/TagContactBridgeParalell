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
const { userAccountRepository } = require("../../shared-repositories/src");
const { publishBatchToRingcx } = require("./cxBulkLoadRingcxPublisher");
const { buildLaneExternId, parseAgentQueueMap } = require("./cxLaneRegistry");
const { logCxAlpha } = require("./cxAlphaTraceService");

function str(value) {
  return String(value == null ? "" : value).trim();
}

// THE CLOCK (Mickey's operating plan, 2026-07-08): "5pm new stuff stops writing to the
// call-now queue and goes to a buffer; 6pm consume that buffer round-robin building each
// agent's morning queue in advance, and keep assigning as they come in; 8am it turns on."
//   drip   Mon-Fri 08:00-16:59 PT — live dispatch to the first-contact campaigns
//   hold   Mon-Fri 17:00-17:59 PT — agents finishing queues; buffer accumulates untouched
//   assign 18:00-07:59 + weekends — round-robin ASSIGNMENT (no RingCX); the morning
//          queue build consumes assigned rows first (the post-8am build).
// PURE; env force-override CX_FIRST_TOUCH_WINDOW_MODE for tests/off-hours drills.
function deriveFirstTouchWindowMode(now = new Date(), opts = {}) {
  const forced = String(opts.force ?? process.env.CX_FIRST_TOUCH_WINDOW_MODE ?? "").trim().toLowerCase();
  if (forced === "drip" || forced === "hold" || forced === "assign") return forced;
  const timeZone = opts.timeZone || process.env.CX_FIRST_TOUCH_TZ || "America/Los_Angeles";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    weekday: "short",
    hour: "numeric",
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const weekday = String(get("weekday") || "");
  const hour = Number(get("hour")) % 24;
  const isWeekend = weekday === "Sat" || weekday === "Sun";
  const dripStart = Number(opts.dripStartHour ?? process.env.CX_FIRST_TOUCH_DRIP_START_HOUR) || 8;
  const dripEnd = Number(opts.dripEndHour ?? process.env.CX_FIRST_TOUCH_DRIP_END_HOUR) || 17;
  const assignStart = Number(opts.assignStartHour ?? process.env.CX_FIRST_TOUCH_ASSIGN_START_HOUR) || 18;
  if (!isWeekend && hour >= dripStart && hour < dripEnd) return "drip";
  if (!isWeekend && hour >= dripEnd && hour < assignStart) return "hold";
  return "assign";
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
    isMainQueueMode: () =>
      String(process.env.CX_BORING_DIALER_ENABLED || "false").trim().toLowerCase() === "true",
    resolveMainQueueAgent: async (agent) => {
      const account = await userAccountRepository.findUserAccountByEmail(agent.agentEmail).catch(() => null);
      const agentExtensionId = String(account?.extensionId || "").trim();
      return agentExtensionId ? { ...agent, agentExtensionId } : null;
    },
    loadPendingRows: (limit) =>
      CxDialQueue.find({
        "metadata.firstTouchPending": true,
        "metadata.firstTouchDispatch": null,
        // morning-assigned rows belong to the post-8am QUEUE BUILD, never the drip
        "metadata.firstTouchAssignment": null,
        state: { $in: ["queued", "ready"] },
      })
        .sort({ createdAt: 1 })
        .limit(limit)
        .lean(),
    loadUnassignedRows: (limit) =>
      CxDialQueue.find({
        "metadata.firstTouchPending": true,
        "metadata.firstTouchDispatch": null,
        "metadata.firstTouchAssignment": null,
        state: { $in: ["queued", "ready"] },
      })
        .sort({ createdAt: 1 })
        .limit(limit)
        .lean(),
    assignRow: async (rowId, assignment) => {
      const result = await CxDialQueue.updateOne(
        { _id: rowId, "metadata.firstTouchAssignment": null },
        { $set: { "metadata.firstTouchAssignment": assignment } },
      );
      return (result.modifiedCount ?? result.nModified ?? 0) > 0;
    },
    activateRow: async (rowId, assignment, now) => {
      const result = await CxDialQueue.updateOne(
        {
          _id: rowId,
          "metadata.firstTouchPending": true,
          "metadata.firstTouchDispatch": null,
        },
        {
          $set: {
            state: "ready",
            releaseAt: now,
            "assignment.extensionId": assignment.agentExtensionId,
            "assignment.assignedAt": now,
            "assignment.queueFamilySnapshot": "first-touch",
            "metadata.firstTouchPending": false,
            "metadata.firstTouchAssignment": assignment,
            "metadata.firstTouchRoutedTo": "boring-dial-queue",
            "metadata.firstTouchRoutedAt": now,
          },
        },
      );
      return (result.modifiedCount ?? result.nModified ?? 0) > 0;
    },
    resolveWindowMode: (now) => deriveFirstTouchWindowMode(now),
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

  async function tickOnce({ now = new Date(), limit = 25, maxPages = 40 } = {}) {
    if (!deps.isEnabled()) return { skipped: true, reason: "flag-off" };
    let agents = deps.resolveQueueMap();
    if (!agents.length) {
      logCxAlpha("cx.alpha.firsttouch.dispatch.skipped", { reason: "empty-queue-map" }, { logger });
      return { skipped: true, reason: "empty-queue-map" };
    }
    const mode = deps.resolveWindowMode(now);
    const mainQueueMode = deps.isMainQueueMode();
    if (mainQueueMode) {
      agents = (await Promise.all(agents.map((agent) => deps.resolveMainQueueAgent(agent))))
        .filter(Boolean);
      if (!agents.length) return { skipped: true, mode, reason: "no-main-queue-agents" };
    }
    if (mode === "hold") return { skipped: true, mode, reason: "hold-window" };
    if (mode === "assign") {
      // THE 6PM LOADER: round-robin assignment only — no RingCX. The morning queue
      // build consumes these first (the post-8am build), so 8am needs zero ceremony.
      let assigned = 0;
      let pages = 0;
      for (;;) {
        const rows = await deps.loadUnassignedRows(limit);
        if (!rows.length) break;
        pages += 1;
        const assignments = assignRoundRobin(rows, agents, rrOffset);
        rrOffset = (rrOffset + rows.length) % agents.length;
        for (const { row, agent } of assignments) {
          const won = await deps.assignRow(row._id, {
            agentEmail: agent.agentEmail,
            campaignId: agent.campaignId,
            agentExtensionId: agent.agentExtensionId || null,
            assignedAt: now.toISOString(),
          }).catch(() => false);
          if (won) {
            assigned += 1;
            logCxAlpha("cx.alpha.firsttouch.assigned", {
              queueItemId: String(row._id),
              caseId: row.caseId,
              agentEmail: agent.agentEmail,
            }, { logger });
          }
        }
        if (rows.length < limit || pages >= maxPages) break;
      }
      return { mode, assigned, pages };
    }

    if (mainQueueMode) {
      let queued = 0;
      let failed = 0;
      let pages = 0;
      for (;;) {
        const rows = await deps.loadPendingRows(limit);
        if (!rows.length) break;
        pages += 1;
        const assignments = assignRoundRobin(rows, agents, rrOffset);
        rrOffset = (rrOffset + rows.length) % agents.length;
        for (const { row, agent } of assignments) {
          const activated = await deps.activateRow(row._id, {
            agentEmail: agent.agentEmail,
            campaignId: agent.campaignId,
            agentExtensionId: agent.agentExtensionId,
            assignedAt: now.toISOString(),
          }, now).catch(() => false);
          if (activated) queued += 1;
          else failed += 1;
        }
        if (rows.length < limit || pages >= maxPages) break;
      }
      return { mode, routedTo: "boring-dial-queue", queued, failed, pages };
    }

    let dispatched = 0;
    let failed = 0;
    let pages = 0;
    // BURST-UNTIL-EMPTY (2026-07-08, the 750-weekend-leads math): a backlog drains in one
    // tick — pages keep coming while full, capped so a runaway can't hold the interval.
    for (;;) {
      const rows = await deps.loadPendingRows(limit);
      if (!rows.length) break;
      pages += 1;

      const assignments = assignRoundRobin(rows, agents, rrOffset);
      rrOffset = (rrOffset + rows.length) % agents.length;

      // PER-AGENT BATCHING: loadLeads is a batch API — one call per agent per page,
      // not one per lead. The publisher reconciles accept/reject per candidate.
      const byAgent = new Map();
      for (const { row, agent } of assignments) {
        if (!byAgent.has(agent.agentEmail)) byAgent.set(agent.agentEmail, { agent, rows: [] });
        byAgent.get(agent.agentEmail).rows.push(row);
      }

      for (const { agent, rows: agentRows } of byAgent.values()) {
        const claimed = [];
        for (const row of agentRows) {
          const externId = buildLaneExternId("firstTouch", { domain: row.domain, queueItemId: row._id });
          const claim = {
            claimedAt: now.toISOString(),
            agentEmail: agent.agentEmail,
            campaignId: agent.campaignId,
            externId,
          };
          const won = await deps.claimRow(row._id, claim).catch(() => false);
          if (won) claimed.push({ row, externId, claim });
        }
        if (!claimed.length) continue;

        try {
          const publish = await deps.publishBatch(client, {
            campaignId: agent.campaignId,
            dialPriority: "IMMEDIATE",
            candidates: claimed.map(({ row, externId }) => ({
              externId,
              phone: row.phone || null,
              name: row.name || row.metadata?.name || null,
              domain: row.domain,
              caseId: row.caseId,
              queueItemId: String(row._id),
            })),
          });
          const acceptedKeys = new Set(
            (Array.isArray(publish?.accepted) ? publish.accepted : [])
              .flatMap((c) => [String(c.queueItemId || ""), String(c.externId || "")])
              .filter(Boolean),
          );
          for (const { row, externId, claim } of claimed) {
            const accepted = acceptedKeys.has(String(row._id)) || acceptedKeys.has(externId);
            if (accepted) {
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
            } else {
              failed += 1;
              await deps.releaseClaim(row._id).catch(() => null); // next tick retries
              logCxAlpha("cx.alpha.firsttouch.dispatch.failed", {
                queueItemId: String(row._id),
                agentEmail: agent.agentEmail,
                reason: "rejected-by-ringcx",
              }, { logger });
            }
          }
        } catch (error) {
          for (const { row } of claimed) {
            failed += 1;
            await deps.releaseClaim(row._id).catch(() => null);
          }
          logCxAlpha("cx.alpha.firsttouch.dispatch.failed", {
            agentEmail: agent.agentEmail,
            batchSize: claimed.length,
            error: error?.message,
          }, { logger });
        }
      }

      if (rows.length < limit || pages >= maxPages) break;
    }
    return { dispatched, failed, pages };
  }

  return { tickOnce };
}

module.exports = {
  createCxFirstTouchDispatcher,
  assignRoundRobin, // exported for pins; pure
  deriveFirstTouchWindowMode, // exported for pins; pure
};
