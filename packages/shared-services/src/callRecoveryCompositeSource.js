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

// ── THE CURSOR MUST SURVIVE THE RUNTIME'S PERSISTENCE, WHICH IS TWO SCALARS ─
//
// leadDeliveryService does not store the cursor object. It stores
// `repairCursorCreatedAt` (a Date) and `repairCursorId` (a String) and rebuilds
// `{createdAt, id}` on resume — that is the WHOLE contract, typed by the
// LeadDeliverySourceState schema. The first version of this codec returned
// `{kind, inner}`, which has neither field: both scalars persisted as
// undefined, mongoose dropped them from the $set, and every incomplete page
// lost its position and restarted at page one. Recovery's held-head then
// re-ran forever and later candidates starved — not because pagination was
// wrong, but because its cursor never survived a tick.
//
// So the codec speaks the runtime's own dialect:
//   cadence   -> the inner {createdAt, id} passes through UNMARKED (this is
//                also the legacy shape, so old persisted cursors still resume)
//   recovery  -> {createdAt: epoch sentinel, id: "recovery:<episodeId>"}
//                — both fields valid for the schema, and the id prefix is the
//                discriminator on the way back in.
const RECOVERY_ID_PREFIX = "recovery:";

function decodeCursor(cursor) {
  if (!cursor) return { kind: CADENCE_KIND, inner: null };
  // In-memory callers (and tests) may still hand over the object shape.
  if (typeof cursor === "object" && cursor.kind) return { kind: cursor.kind, inner: cursor.inner ?? null };
  if (typeof cursor === "object" && typeof cursor.id === "string"
      && cursor.id.startsWith(RECOVERY_ID_PREFIX)) {
    return { kind: RECOVERY_KIND, inner: cursor.id.slice(RECOVERY_ID_PREFIX.length) };
  }
  // A bare {createdAt, id} is a cadence cursor — the persisted shape, and the
  // legacy one from before the composite existed.
  return { kind: CADENCE_KIND, inner: cursor };
}

function encodeCursor(kind, inner) {
  if (inner == null) return null;
  if (kind === CADENCE_KIND) return inner;
  return { createdAt: new Date(0), id: `${RECOVERY_ID_PREFIX}${inner}` };
}

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
      states: ["eligible", "awaiting_start", "held"],
      asOf: now,
      limit: Math.min(limit, recoveryPageSize),
      after: inner,
      unlinkedOnly: true,
    });
    const items = [];
    for (const episode of episodes) {
      // ADMISSION RUNS HERE, on every pass, not once at discovery. A clean
      // nightly snapshot cannot authorize a call this afternoon.
      let decision;
      let inputs = null;
      try {
        inputs = await resolveAdmissionInputs({ episode });
        decision = admitEpisode({ episode, now, ...inputs });
      } catch (error) {
        // An admission input that could not be read is a HOLD, never a pass.
        decision = { decision: "hold", reason: "admission-inputs-unavailable", retryable: true };
        void error;
      }
      await onDecision?.({ episode, decision });
      if (decision.decision !== "admit") continue;
      items.push(buildRecoverySourceRow(episode, {
        now,
        firstName: inputs?.caseState?.firstName,
        lastName: inputs?.caseState?.lastName,
      }));
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

  async function readOne({ domain, caseId, now = new Date(), ...rest } = {}) {
    const cadence = typeof base.readOne === "function"
      ? await base.readOne({ domain, caseId, now, ...rest })
      : null;
    if (cadence) return cadence;
    if (!activation?.delivery || typeof repository.findActiveEpisode !== "function") return null;

    const episode = await repository.findActiveEpisode(domain, caseId);
    if (!episode || !["eligible", "awaiting_start"].includes(String(episode.state || ""))) return null;
    let decision;
    let inputs = null;
    try {
      inputs = await resolveAdmissionInputs({ episode });
      decision = admitEpisode({ episode, now, ...inputs });
    } catch (error) {
      decision = { decision: "hold", reason: "admission-inputs-unavailable", retryable: true };
      void error;
    }
    await onDecision?.({ episode, decision });
    return decision.decision === "admit" ? buildRecoverySourceRow(episode, {
      now,
      firstName: inputs?.caseState?.firstName,
      lastName: inputs?.caseState?.lastName,
    }) : null;
  }

  async function readNewerBatch({ after, limit = 250, now = new Date() } = {}) {
    if (typeof base.readNewerBatch !== "function") {
      throw new TypeError("base.readNewerBatch is required for durable composite ingestion");
    }
    const cadence = await base.readNewerBatch({ after, limit, now });
    const cadenceItems = Array.isArray(cadence?.items) ? cadence.items : [];
    if (!activation?.delivery || cadenceItems.length >= limit) return cadence;

    // PAGE THROUGH THE HELD HEAD. This path has no durable cursor on purpose —
    // holds must be re-evaluated every tick, and an admitted episode is linked
    // on insert and drops out of the unlinked listing, so re-scanning from the
    // top is self-truncating. But ONE page from the top is not: fifty held
    // episodes at the head meant every tick read the same fifty holds, admitted
    // nothing, and returned — later eligible episodes were never reached at
    // all. So walk pages within the tick until the ask is filled or the
    // listing is exhausted, bounded so a pathological backlog cannot eat the
    // tick's wall clock.
    const want = Math.max(1, limit - cadenceItems.length);
    const recoveryItems = [];
    let inner = null;
    let recoveryDone = false;
    for (let page = 0; page < 20; page += 1) {
      const recovery = await readRecoveryBatch({
        inner,
        limit: Math.max(1, want - recoveryItems.length),
        now,
      });
      if (recovery.done) {
        recoveryItems.push(...recovery.items);
        recoveryDone = true;
        break;
      }
      // A non-done page that did not MOVE the cursor is a listing that is not
      // paging — and its rows are RE-READS of the tail we already walked, so
      // they are dropped, not appended. A real `after`-scoped listing can never
      // return a last id equal to the id it was asked to read past; equality
      // only happens on a broken listing, and appending its rows would emit
      // the same episode once per page until the bound.
      if (recovery.nextCursor == null || recovery.nextCursor === inner) break;
      recoveryItems.push(...recovery.items);
      if (recoveryItems.length >= want) break;
      inner = recovery.nextCursor;
    }
    return {
      ...cadence,
      items: [...cadenceItems, ...recoveryItems],
      // Recovery rows are linked as soon as the canonical item is inserted;
      // they need no second source high-water and cannot move the cadence
      // arrival cursor backward.
      nextHighWater: cadence?.nextHighWater ?? after ?? null,
      done: cadence?.done === true && recoveryDone,
    };
  }

  return {
    readBatch,
    // Pass the rest of the source interface straight through — the ingest loop
    // is not the only caller, and a partial wrapper would break the others.
    readOne,
    readNewerBatch: typeof base.readNewerBatch === "function" ? readNewerBatch : undefined,
    readWindowBatch: base.readWindowBatch ? (...args) => base.readWindowBatch(...args) : undefined,
  };
}

module.exports = {
  RECOVERY_KIND,
  CADENCE_KIND,
  createCallRecoveryCompositeSource,
};
