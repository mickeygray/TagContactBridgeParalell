"use strict";

// CX Source Pool reservation service — the ONE shared instance all three rails
// (and the M5 publish-time interlock) inject. It is the only sanctioned way a rail
// turns queue inventory into live-dialable rows: it reserves `ready -> claimed`
// atomically per family via the net-new repo helper `reserveReadyRows`, and releases
// claimed-but-unpublished rows back to `ready` with a reservationSessionId-guarded CAS.
//
// Pure-core orchestration; all I/O is injected so it unit-tests with fakes and no Mongo.
//
// MILESTONE SCOPE (M1): reserveFromFamilyOrder + releaseReserved + newSessionId only.
// Later, by the build plan: renewReserved heartbeat (M2), the claim-time cross-pool
// guard `assertNotActiveInUcq` via queueItemRepository.existsForLead (M5), and the
// slow-lane dialability post-filter via resolveQueueDialability (M4). Those injected
// deps are accepted here so the factory signature stays stable as they land.

const { randomUUID } = require("crypto");

function createCxQueueReservationService({
  cxDialQueueRepository, // reserveReadyRows, transitionQueueItemState (+ findActiveClaimForCase in M5)
  queueItemRepository, // existsForLead — cross-pool interlock (M5; unused in M1)
  resolveQueueDialability, // from cxQueuePolicyService — slow-lane post-filter (M4; unused in M1)
  logger = console,
} = {}) {
  if (!cxDialQueueRepository || typeof cxDialQueueRepository.reserveReadyRows !== "function") {
    throw new Error("cxQueueReservationService requires cxDialQueueRepository.reserveReadyRows");
  }

  // Reserve up to the per-family targets, in family (rank) order, capped at totalLimit.
  // Returns the atomically-claimed rows (already state:'claimed', owned by this session)
  // plus a `missing` map of genuine short supply per family.
  async function reserveFromFamilyOrder({
    domain,
    agentExtensionId,
    sessionId,
    familyTargets,
    totalLimit = null,
    claimMinutes,
    metadata = {},
    firstTouchOnly = false,
    greenCoverageBatchId = null,
    queueLane = null,
  } = {}) {
    if (!sessionId) throw new Error("reserveFromFamilyOrder requires a sessionId");
    let remaining = Number.isFinite(totalLimit) ? Math.max(Number(totalLimit), 0) : Infinity;
    const reserved = [];
    const missing = {};

    for (const family of Object.keys(familyTargets || {})) {
      if (remaining <= 0) break;
      const requested = Math.max(Number(familyTargets[family]) || 0, 0);
      const take = Math.min(requested, remaining);
      if (take <= 0) continue;

      const { reserved: rawReserved, missing: familyMissing } = await cxDialQueueRepository.reserveReadyRows(domain, { [family]: take }, {
        sessionId,
        agentExtensionId,
        claimMinutes,
        now: new Date(),
        metadata,
        rcxAccountId: metadata.rcxAccountId,
        rcxCampaignId: metadata.rcxCampaignId,
        rcxDialGroupId: metadata.rcxDialGroupId,
        firstTouchOnly,
        greenCoverageBatchId,
        queueLane,
      });

      // M5: claim-time cross-pool interlock — drop+release any reserved row already active in the UCQ pool.
      const usable = await assertNotActiveInUcq(rawReserved);
      reserved.push(...usable);
      if (Number.isFinite(remaining)) remaining -= usable.length;

      const short = Math.max(take - usable.length, Number(familyMissing?.[family]) || 0);
      if (short > 0) {
        missing[family] = (missing[family] || 0) + short;
      }
    }

    return { reserved, missing };
  }

  // M5: claim-time cross-pool interlock. A caseId must not be live in both CxDialQueue (reserved here)
  // and the legacy QueueItem/UCQ pool — the two share only a caseId/leadId string, so a mis-set pacing
  // flag could otherwise double-dial. Drop+release any reserved row whose caseId is already active in
  // QueueItem (fail-closed). NO-OP (keeps all rows) when queueItemRepository isn't wired — the rails
  // that don't inject it rely on the flag-OFF belt; this DB interlock is the suspenders (§0/CR4).
  async function assertNotActiveInUcq(rows = []) {
    if (!queueItemRepository || typeof queueItemRepository.existsForLead !== "function") return rows;
    const keep = [];
    for (const row of rows) {
      const leadId = String(row.caseId);
      try {
        const active = await queueItemRepository.existsForLead(leadId);
        if (active) {
          await releaseReserved([row], "cross-pool-interlock:active-in-queueitem");
        } else {
          keep.push(row);
        }
      } catch (err) {
        logger.warn?.("assertNotActiveInUcq lead check failed", {
          leadId,
          id: String(row?._id),
          err: err?.message,
        });
        await releaseReserved([row], "cross-pool-interlock:lead-check-failed");
      }
    }
    return keep;
  }

  // Release reserved-but-unpublished rows back to `ready`. The RAIL drops the row from
  // its buffer BEFORE calling this (the §4 release-vs-renew TOCTOU); the reservationSessionId
  // match makes the transition a real CAS so we only release rows we still own. `ready` is
  // included to clean rows that were already knocked back by an older cross-rail release bug.
  async function releaseReserved(rows = [], reason = "reserved-released") {
    for (const row of rows) {
      const reservationSessionId = row?.metadata?.reservationSessionId;
      if (!reservationSessionId) {
        logger.warn?.("releaseReserved skipped row without reservationSessionId", { id: String(row?._id) });
        continue;
      }
      await cxDialQueueRepository
        .transitionQueueItemState(
          row._id,
          ["claimed", "ready"],
          {
            state: "ready",
            claimUntil: null,
            assignment: { extensionId: null, agentName: null, assignedAt: null, queueFamilySnapshot: null },
            "metadata.reservationSessionId": null,
            "metadata.reservedAt": null,
            "metadata.reservationExpiresAt": null,
            "metadata.lastReleasedAt": new Date(),
            "metadata.lastReleaseReason": reason,
          },
          { match: { "metadata.reservationSessionId": reservationSessionId } },
        )
        .catch((err) => logger.warn?.("releaseReserved miss", { id: String(row?._id), err: err?.message }));
    }
  }

  // Terminalize reserved rows that must never return to ready. This is for fail-closed
  // inventory outcomes such as enforced DNC/contact blocking after claim.
  async function cancelReserved(rows = [], reason = "reserved-cancelled") {
    for (const row of rows) {
      const reservationSessionId = row?.metadata?.reservationSessionId;
      if (!reservationSessionId) {
        logger.warn?.("cancelReserved skipped row without reservationSessionId", { id: String(row?._id) });
        continue;
      }
      await cxDialQueueRepository
        .transitionQueueItemState(
          row._id,
          ["claimed", "ready"],
          {
            state: "cancelled",
            claimUntil: null,
            cancelledAt: new Date(),
            assignment: { extensionId: null, agentName: null, assignedAt: null, queueFamilySnapshot: null },
            "metadata.reservationSessionId": null,
            "metadata.reservedAt": null,
            "metadata.reservationExpiresAt": null,
            "metadata.lastReleasedAt": new Date(),
            "metadata.lastReleaseReason": reason,
            "metadata.cancelledByReservation": true,
            "metadata.cancelledReason": reason,
          },
          { match: { "metadata.reservationSessionId": reservationSessionId } },
        )
        .catch((err) => logger.warn?.("cancelReserved miss", { id: String(row?._id), err: err?.message }));
    }
  }

  // renewReserved (M2 §3.2) — heartbeat the lease for rows still held in the rail's buffer.
  // Delegates to the repo guarded CAS, grouping ids by reservationSessionId so a stray
  // foreign-session row can never be renewed under the wrong owner. Returns the ids actually
  // renewed; the caller drops the rest (serving / reaped / re-owned) from its heartbeat set.
  //
  // UNWIRED (#13): no production caller invokes this — the lease is single-shot and reserved rows
  // are reaper-exempt by ownership (cxDialQueueRepository buildExpiredClaimRequeueQuery), so no
  // heartbeat is needed for safety. Kept as M2 scaffolding + tested in isolation. If renewal is ever
  // wanted, wire it from the BULK watch tick only (cxBulkLoadRuntimeService) — never here, since this
  // is the shared instance the slow-lane rail also uses.
  async function renewReserved(rows = [], claimMinutes) {
    if (typeof cxDialQueueRepository.renewClaim !== "function") {
      throw new Error("cxQueueReservationService.renewReserved requires cxDialQueueRepository.renewClaim");
    }
    const idsBySession = new Map();
    for (const row of rows) {
      const sessionId = row?.metadata?.reservationSessionId;
      if (!sessionId || !row?._id) continue;
      if (!idsBySession.has(sessionId)) idsBySession.set(sessionId, []);
      idsBySession.get(sessionId).push(row._id);
    }
    const renewed = [];
    for (const [sessionId, ids] of idsBySession) {
      const got = await cxDialQueueRepository.renewClaim(ids, claimMinutes, sessionId);
      renewed.push(...got);
    }
    return renewed;
  }

  async function listReservedForSession(sessionId, options = {}) {
    const normalizedSessionId = String(sessionId || "").trim();
    if (!normalizedSessionId) return [];
    if (typeof cxDialQueueRepository.listClaimedByReservationSession !== "function") {
      return [];
    }
    return cxDialQueueRepository.listClaimedByReservationSession({
      sessionId: normalizedSessionId,
      states: Array.isArray(options.states) && options.states.length > 0
        ? options.states
        : ["claimed"],
      limit: options.limit || "all",
    });
  }

  return {
    reserveFromFamilyOrder,
    listReservedForSession,
    cancelReserved,
    releaseReserved,
    renewReserved,
    newSessionId: () => randomUUID(),
  };
}

module.exports = { createCxQueueReservationService };
