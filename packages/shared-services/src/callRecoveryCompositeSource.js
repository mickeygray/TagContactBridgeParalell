"use strict";

// CR-6 — the composite source.
//
// `leadDeliveryService`'s ingest loop reads from ONE object with a `readBatch`
// method. This wraps the existing cadence source so that same loop also sees
// eligible CallRecoveryLead episodes, without the loop knowing recovery exists.
//
// That is the entire integration. There is no second ingest, no second cursor
// driver, no second writer — §15.1's "the adapter only reads and normalizes",
// and the reason the four-pool law and the one-item-per-case law survive a new
// cohort arriving.
//
// THREE RULES, all of which have a failure mode behind them:
//
//  1. CADENCE DRAINS FIRST. Fresh bought leads are perishable and recovery
//     episodes are not — an episode is good for 120 days. If recovery could
//     starve the head of the cadence cursor, a slow recovery backlog would
//     delay every new lead by exactly as long as it took to walk.
//
//  2. THE CURSOR IS TYPED. §15.1 forbids merging two independent cursors by
//     Mongo natural order. This one carries which source it is walking plus
//     that source's own cursor, so a page boundary is never ambiguous and a
//     restart resumes in the right half.
//
//  3. A CASE THE CADENCE ALREADY OWNS IS NOT EMITTED TWICE. The canonical work
//     item is per case, so two source rows for one case would race each other
//     into `insertActiveItemOnce` and the loser would silently become a refresh
//     of a row built under the OTHER policy.

const { admitEpisode, buildRecoverySourceRow } = require("./callRecoveryAdmissionService");

const RECOVERY_KIND = "recovery";
const CADENCE_KIND = "cadence";

function decodeCursor(cursor) {
  if (!cursor) return { kind: CADENCE_KIND, inner: null };
  if (typeof cursor === "object" && cursor.kind) return { kind: cursor.kind, inner: cursor.inner ?? null };
  // A bare cursor is a legacy cadence cursor — the composite must be able to
  // resume a pass that started before it was wired in.
  return { kind: CADENCE_KIND, inner: cursor };
}

const encodeCursor = (kind, inner) => (inner == null && kind === CADENCE_KIND ? null : { kind, inner });

/**
 * @param base       the existing cadence source (must expose readBatch)
 * @param repository callRecoveryLeadRepository
 * @param activation resolveCallRecoveryActivation(config) result
 * @param resolveAdmissionInputs async ({episode}) -> {caseState, dncState, contactWindowOpen, existingWorkItem}
 * @param onDecision optional ({episode, decision}) -> void, for counters/alerts
 */
function createCallRecoveryCompositeSource({
  base,
  repository,
  activation,
  resolveAdmissionInputs,
  onDecision = null,
  recoveryPageSize = 50,
} = {}) {
  if (!base || typeof base.readBatch !== "function") {
    throw new TypeError("base source with readBatch is required");
  }
  if (!repository) throw new TypeError("callRecoveryLeadRepository is required");
  if (typeof resolveAdmissionInputs !== "function") {
    throw new TypeError("resolveAdmissionInputs is required — admission cannot be skipped");
  }

  async function readRecoveryBatch({ inner, limit, now }) {
    const episodes = await repository.listEpisodesForConsideration({
      states: ["eligible", "awaiting_start"],
      asOf: now,
      limit: Math.min(limit, recoveryPageSize),
      after: inner,
    });
    const items = [];
    for (const episode of episodes) {
      // ADMISSION RUNS HERE, on every pass, not once at discovery. A clean
      // nightly snapshot cannot authorize a call this afternoon.
      let decision;
      try {
        const inputs = await resolveAdmissionInputs({ episode });
        decision = admitEpisode({ episode, now, ...inputs });
      } catch (error) {
        // An admission input that could not be read is a HOLD, never a pass.
        decision = { decision: "hold", reason: "admission-inputs-unavailable", retryable: true };
        void error;
      }
      onDecision?.({ episode, decision });
      if (decision.decision !== "admit") continue;
      items.push(buildRecoverySourceRow(episode, { now }));
    }
    const done = episodes.length === 0;
    return {
      items,
      nextCursor: done ? null : episodes[episodes.length - 1].episodeId,
      done,
    };
  }

  async function readBatch({ cursor = null, limit = 250, now = new Date() } = {}) {
    const { kind, inner } = decodeCursor(cursor);

    if (kind === CADENCE_KIND) {
      const batch = await base.readBatch({ cursor: inner, limit, now });
      if (!batch?.done) {
        return { ...batch, nextCursor: encodeCursor(CADENCE_KIND, batch?.nextCursor ?? null), done: false };
      }
      // Cadence is drained. Hand over to recovery rather than reporting done,
      // so one ingest pass walks both halves.
      if (!activation?.delivery) return { ...batch, nextCursor: null, done: true };
      const recovery = await readRecoveryBatch({ inner: null, limit, now });
      return {
        items: [...(batch.items || []), ...recovery.items],
        nextCursor: recovery.done ? null : encodeCursor(RECOVERY_KIND, recovery.nextCursor),
        done: recovery.done,
      };
    }

    // Mid-recovery. If delivery was disarmed between pages, stop cleanly —
    // a flag flip must take effect on the next page, not the next restart.
    if (!activation?.delivery) return { items: [], nextCursor: null, done: true };
    const recovery = await readRecoveryBatch({ inner, limit, now });
    return {
      items: recovery.items,
      nextCursor: recovery.done ? null : encodeCursor(RECOVERY_KIND, recovery.nextCursor),
      done: recovery.done,
    };
  }

  return {
    readBatch,
    // Pass the rest of the source interface straight through — the ingest loop
    // is not the only caller, and a partial wrapper would break the others.
    readOne: base.readOne ? (...args) => base.readOne(...args) : undefined,
    readWindowBatch: base.readWindowBatch ? (...args) => base.readWindowBatch(...args) : undefined,
  };
}

module.exports = {
  RECOVERY_KIND,
  CADENCE_KIND,
  createCallRecoveryCompositeSource,
};
