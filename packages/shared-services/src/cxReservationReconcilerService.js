"use strict";

// CX reservation crash reconciler (M3 §4). Run ONCE at startup, BEFORE the claim reaper
// loop resumes, so a dangling reserved row (claimed by a session that died) is adopted and
// resolved deterministically instead of either leaking `claimed` forever (the M2 reaper now
// excludes session-held rows) or being stolen mid-flight from a restarted live session.
//
// For each `claimed` row whose owning session is NOT currently live:
//   - adopt it via a reservationSessionId-guarded CAS (a restarted live session that re-adopts
//     its own buffer is the CAS winner; the reconciler then leaves it alone — FM-11);
//   - if terminal evidence exists (released-UII / terminal-outbox row), FORCE-complete via
//     completeCxQueueItem (fromStates includes 'claimed', no held-for-disposition gate — FM-8b),
//     NOT the gated handleCxTerminalCallOutcome which would leave it un-completed;
//   - otherwise release it back to `ready`.
//
// All I/O injected; idempotent; unit-tests with fakes and no Mongo.

function createCxReservationReconcilerService({
  cxDialQueueRepository, // listQueueItems (w/ metadataReservationSessionIdNotIn), transitionQueueItemState
  cxCadenceService, // completeCxQueueItem (force path)
  cxQueueReservationService, // releaseReserved
  terminalEvidence, // async (row) => Boolean — released-UII / terminal-outbox row exists
  logger = console,
} = {}) {
  if (!cxDialQueueRepository || typeof cxDialQueueRepository.listQueueItems !== "function") {
    throw new Error("cxReservationReconcilerService requires cxDialQueueRepository.listQueueItems");
  }
  if (typeof terminalEvidence !== "function") {
    throw new Error("cxReservationReconcilerService requires a terminalEvidence(row) function");
  }

  // Call once at startup BEFORE the reaper loop starts. Idempotent.
  async function reconcileDanglingReservations({ activeSessionIds = [] } = {}) {
    const dangling = await cxDialQueueRepository.listQueueItems({
      states: ["claimed"],
      metadataReservationSessionIdNotIn: activeSessionIds,
      limit: "all",
    });
    const result = { scanned: dangling.length, adopted: 0, completed: 0, released: 0, skipped: 0 };
    for (const row of dangling) {
      const sessionId = row?.metadata?.reservationSessionId;
      if (!sessionId) {
        result.skipped += 1;
        continue;
      }
      // Adopt via reservationSessionId-guarded CAS — a live session re-adopting its own buffer
      // wins the CAS and the reconciler must not clobber it (FM-11).
      const adoptedRow = await cxDialQueueRepository.transitionQueueItemState(
        row._id,
        ["claimed"],
        { "metadata.reservationReconciledAt": new Date() },
        { match: { "metadata.reservationSessionId": sessionId }, returnNew: true },
      );
      if (!adoptedRow) {
        result.skipped += 1;
        continue; // a live session re-adopted it first — leave it
      }
      const adopted = {
        ...row,
        ...adoptedRow,
        metadata: { ...(row.metadata || {}), ...(adoptedRow.metadata || {}) },
      };
      result.adopted += 1;
      let hasEvidence = false;
      try {
        hasEvidence = await terminalEvidence(adopted);
      } catch (err) {
        logger.warn?.("reconcileDanglingReservations evidence failed", {
          id: String(row?._id),
          err: err?.message,
        });
        await cxQueueReservationService.releaseReserved([adopted], "reservation-reconciler:evidence-error");
        result.released += 1;
        continue;
      }
      try {
        if (hasEvidence) {
          await cxCadenceService.completeCxQueueItem({
            queueItemId: adopted?._id || row._id,
            queueOutcome: "reservation-reconciled-terminal",
            actorEmail: "system:reservation-reconciler",
          });
          result.completed += 1;
        } else {
          await cxQueueReservationService.releaseReserved([adopted], "reservation-reconciler:session-gone");
          result.released += 1;
        }
      } catch (err) {
        logger.warn?.("reconcileDanglingReservations row failed", { id: String(row?._id), err: err?.message });
      }
    }
    return result;
  }

  return { reconcileDanglingReservations };
}

module.exports = { createCxReservationReconcilerService };
