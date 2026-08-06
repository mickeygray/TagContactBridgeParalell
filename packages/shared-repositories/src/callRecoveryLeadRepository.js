"use strict";

// callRecoveryLeadRepository — thin, atomic access to CallRecoveryLead.
//
// Work order CR-2. This layer is DELIBERATELY stupid: it upserts evidence,
// moves state under compare-and-set, and hands out bounded cursors. It decides
// nothing. Pool, priority, cap, timing, ownership and outcome all belong to
// `leadDeliveryService` — if a rule ever appears in this file, the architecture
// has a second decision owner and the parent contract is broken.
//
// Every write here is idempotent or CAS-guarded, because the callers are a
// nightly task, a delivery tick and a callback drain that can all touch the same
// episode in the same second, and because a process restart replays work.

const CallRecoveryLead = require("../../shared-models/src/CallRecoveryLead");

const {
  PROGRAM_KEY,
  TRANSITIONS,
  EVIDENCE_CALL_ID_CAP,
} = CallRecoveryLead;

/** Canonical case identity. caseId is a STRING here — see the model. */
function canonicalCaseKey(domain, caseId) {
  return `${String(domain || "").trim().toUpperCase()}:${String(caseId ?? "").trim()}`;
}

/**
 * Deterministic episode id.
 *
 * Derived, never random: a replayed discovery for the same case and episode
 * number must compute the SAME id, so a retry collides on the unique index
 * instead of minting a second episode.
 */
function buildEpisodeId(domain, caseId, episodeNumber, programKey = PROGRAM_KEY) {
  return `${programKey}:${String(domain || "").trim().toUpperCase()}:${String(caseId ?? "").trim()}:${episodeNumber}`;
}

function assertTransitionAllowed(from, to) {
  const allowed = TRANSITIONS[from];
  if (!allowed) throw new Error(`unknown recovery state "${from}"`);
  if (!allowed.includes(to)) {
    // Absorbing states produce the clearest possible message, because "terminal
    // -> eligible" is exactly the bug this guard exists to make loud.
    throw new Error(`illegal recovery transition ${from} -> ${to}`);
  }
}

/** The one open episode for a case, or null. */
async function findActiveEpisode(domain, caseId, { programKey = PROGRAM_KEY } = {}) {
  return CallRecoveryLead.findOne({
    programKey,
    domain: String(domain || "").trim().toUpperCase(),
    caseId: String(caseId ?? "").trim(),
    activeEpisode: true,
  }).lean();
}

/** Has this exact CallRail call already been recorded as evidence anywhere? */
async function findEpisodeByQualifyingCallId(providerCallId, { programKey = PROGRAM_KEY } = {}) {
  const id = String(providerCallId || "").trim();
  if (!id) return null;
  return CallRecoveryLead.findOne({ programKey, qualifyingCallIds: id }).lean();
}

/**
 * Record a qualifying call.
 *
 * IDEMPOTENT AND CONCURRENCY-SAFE, which between them are most of this file:
 *
 *  - the same CallRail id twice is a no-op (`$addToSet` plus an evidence probe);
 *  - two processes discovering the same case at once produce ONE episode — the
 *    loser of the partial unique index re-reads and appends evidence instead of
 *    inserting;
 *  - a case whose previous episode expired gets the NEXT episode number, and the
 *    new episode links back via `supersedesEpisodeId`.
 *
 * `firstQualifyingCallAt` and `expiresAt` are written once on insert and never
 * moved — a later call inside an open episode must not extend the 120 days.
 */
async function recordQualifyingCall({
  domain,
  caseId,
  normalizedPhone,
  displayName = null,
  sourceDateKey = null,
  providerCallId,
  callAt,
  durationSec,
  mailSourceCanonicalId = null,
  mailSourceName = null,
  humanAnswerEvidence = null,
  discoveredAt = new Date(),
  eligibleFrom,
  expiresAt,
  state = "discovered",
  stateReason = null,
  programKey = PROGRAM_KEY,
} = {}) {
  const dom = String(domain || "").trim().toUpperCase();
  const cid = String(caseId ?? "").trim();
  const callId = String(providerCallId || "").trim();
  if (!dom || !cid) throw new Error("recordQualifyingCall requires domain and caseId");
  if (!callId) throw new Error("recordQualifyingCall requires providerCallId");
  if (!/^\d{10}$/.test(String(normalizedPhone || ""))) {
    throw new Error("recordQualifyingCall requires a normalized ten-digit phone");
  }
  const at = callAt instanceof Date ? callAt : new Date(callAt);
  if (!Number.isFinite(at.getTime())) throw new Error("recordQualifyingCall requires a valid callAt");
  const duration = Number(durationSec);
  if (!Number.isInteger(duration) || duration < 0) {
    throw new Error("recordQualifyingCall requires an integer durationSec");
  }
  const dateKey = sourceDateKey == null ? null : String(sourceDateKey).trim();
  if (dateKey != null && !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    throw new Error("recordQualifyingCall sourceDateKey must be YYYY-MM-DD");
  }

  // Already recorded — replay is a no-op that returns the owning episode.
  const seen = await findEpisodeByQualifyingCallId(callId, { programKey });
  if (seen) {
    const needsDateKey = Boolean(dateKey) && !(seen.qualifyingDateKeys || []).includes(dateKey);
    const safeDisplayName = String(displayName || "").trim() || null;
    const needsDisplayName = Boolean(safeDisplayName) && !String(seen.displayName || "").trim();
    if (!needsDateKey && !needsDisplayName) {
      return { episode: seen, inserted: false, evidenceAdded: false, duplicate: true };
    }
    const update = {};
    if (needsDateKey) update.$addToSet = { qualifyingDateKeys: dateKey };
    if (needsDisplayName) update.$set = { displayName: safeDisplayName };
    const repaired = await CallRecoveryLead.findOneAndUpdate(
      { _id: seen._id },
      update,
      { new: true },
    ).lean();
    return { episode: repaired || seen, inserted: false, evidenceAdded: false, duplicate: true };
  }

  const open = await findActiveEpisode(dom, cid, { programKey });
  if (open) {
    // Append evidence to the open episode. Timestamps and max duration move
    // MONOTONICALLY and independently of the capped id list (§7.3).
    const updated = await CallRecoveryLead.findOneAndUpdate(
      { _id: open._id, state: { $nin: ["terminal", "expired"] } },
      {
        $addToSet: {
          qualifyingCallIds: callId,
          ...(dateKey ? { qualifyingDateKeys: dateKey } : {}),
        },
        $max: { latestQualifyingCallAt: at, maximumObservedDurationSec: duration },
        $set: {
          updatedAt: new Date(),
          ...(displayName ? { displayName: String(displayName).trim() } : {}),
        },
      },
      { new: true },
    ).lean();
    if (!updated) {
      // It terminalized between the read and the write. Evidence is not worth
      // resurrecting anything for.
      return { episode: open, inserted: false, evidenceAdded: false, raced: true };
    }
    if ((updated.qualifyingCallIds || []).length > EVIDENCE_CALL_ID_CAP) {
      await CallRecoveryLead.updateOne(
        { _id: updated._id },
        { $push: { qualifyingCallIds: { $each: [], $slice: -EVIDENCE_CALL_ID_CAP } } },
      ).catch(() => { /* capping is hygiene; it must never fail the discovery */ });
    }
    return { episode: updated, inserted: false, evidenceAdded: true };
  }

  // No open episode: mint the next one. Episode numbers are per case, so a
  // second program run years later is episode 2, not a mutation of episode 1.
  const previous = await CallRecoveryLead.findOne({ programKey, domain: dom, caseId: cid })
    .sort({ episodeNumber: -1 }).lean();
  const episodeNumber = (previous?.episodeNumber || 0) + 1;
  const episodeId = buildEpisodeId(dom, cid, episodeNumber, programKey);

  try {
    const created = await CallRecoveryLead.create({
      programKey,
      episodeId,
      episodeNumber,
      domain: dom,
      caseId: cid,
      normalizedPhone: String(normalizedPhone),
      displayName,
      firstQualifyingCallAt: at,
      latestQualifyingCallAt: at,
      qualifyingCallIds: [callId],
      qualifyingDateKeys: dateKey ? [dateKey] : [],
      maximumObservedDurationSec: duration,
      mailSourceCanonicalId,
      mailSourceName,
      humanAnswerEvidence: humanAnswerEvidence || {},
      discoveredAt,
      eligibleFrom,
      expiresAt,
      state,
      stateReason,
      activeEpisode: true,
      supersedesEpisodeId: previous?.episodeId || null,
      version: 0,
    });
    return { episode: created.toObject(), inserted: true, evidenceAdded: true };
  } catch (error) {
    // E11000 on either unique index means a concurrent discovery won. Re-read
    // and append to whatever it created — never retry the insert.
    if (error?.code !== 11000) throw error;
    const winner = await findActiveEpisode(dom, cid, { programKey });
    if (!winner) throw error;
    const updated = await CallRecoveryLead.findOneAndUpdate(
      { _id: winner._id, state: { $nin: ["terminal", "expired"] } },
      {
        $addToSet: {
          qualifyingCallIds: callId,
          ...(dateKey ? { qualifyingDateKeys: dateKey } : {}),
        },
        $max: { latestQualifyingCallAt: at, maximumObservedDurationSec: duration },
      },
      { new: true },
    ).lean();
    return { episode: updated || winner, inserted: false, evidenceAdded: Boolean(updated), raced: true };
  }
}

/**
 * Move an episode's state under compare-and-set.
 *
 * The version check is what makes a nightly refresh, a delivery tick and a
 * callback drain safe to run concurrently: the loser gets `{ ok: false }` and
 * re-reads, rather than stomping a newer verdict with a staler one.
 */
async function transitionState(episodeId, {
  from,
  to,
  expectedVersion,
  reason = null,
  set = {},
  terminal = false,
} = {}) {
  if (!episodeId) throw new Error("transitionState requires an episodeId");
  assertTransitionAllowed(from, to);

  const $set = { state: to, stateReason: reason };
  for (const [key, value] of Object.entries(set || {})) {
    // Never let a caller rewrite identity, the clock, or the concurrency token
    // through the generic patch door.
    if ([
      "_id", "episodeId", "episodeNumber", "programKey", "domain", "caseId",
      "version", "state", "firstQualifyingCallAt", "expiresAt", "createdAt",
    ].includes(key) || key.startsWith("$")) {
      throw new Error(`transitionState may not set "${key}"`);
    }
    $set[key] = value;
  }
  // Leaving an absorbing state is impossible, so the active flag is dropped with
  // it — that frees the partial unique index for a future episode.
  const update = { $set, $inc: { version: 1 } };
  if (terminal || to === "terminal" || to === "expired") update.$unset = { activeEpisode: "" };

  const filter = { episodeId, state: from };
  if (expectedVersion !== undefined && expectedVersion !== null) {
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      throw new Error("expectedVersion must be a non-negative integer");
    }
    filter.version = expectedVersion;
  }

  const episode = await CallRecoveryLead.findOneAndUpdate(filter, update, { new: true }).lean();
  return episode ? { ok: true, episode } : { ok: false, episode: null };
}

/** Record a DNC verdict and schedule (or stop) the next checkpoint. */
async function recordDncResult(episodeId, {
  result,
  reason = null,
  checkedAt = new Date(),
  nextCheckAt = null,
  expectedVersion,
} = {}) {
  if (!CallRecoveryLead.DNC_RESULTS.includes(result)) {
    throw new Error(`unknown dnc result "${result}"`);
  }
  const filter = { episodeId };
  if (expectedVersion !== undefined && expectedVersion !== null) filter.version = expectedVersion;
  const episode = await CallRecoveryLead.findOneAndUpdate(
    filter,
    {
      $set: {
        "dnc.result": result,
        "dnc.reason": reason,
        "dnc.checkedAt": checkedAt,
        // A hit gets no next check — the episode is about to terminalize and a
        // scheduled recheck on a dead record is just noise in the sweep.
        "dnc.nextCheckAt": result === "hit" ? null : nextCheckAt,
      },
      $inc: { version: 1 },
    },
    { new: true },
  ).lean();
  return episode ? { ok: true, episode } : { ok: false, episode: null };
}

/**
 * Bounded, deterministic cursor over episodes a caller may consider.
 *
 * Sorted by a STABLE compound key, never Mongo natural order — §15.1 forbids
 * merging independent cursors by natural order, and a non-deterministic page
 * boundary silently drops or repeats rows under concurrent writes.
 */
async function listEpisodesForConsideration({
  states = ["eligible"],
  asOf = new Date(),
  limit = 200,
  after = null,
  programKey = PROGRAM_KEY,
  domain = null,
  unlinkedOnly = false,
} = {}) {
  const query = {
    programKey,
    state: { $in: states },
    eligibleFrom: { $lte: asOf },
    expiresAt: { $gt: asOf },
  };
  if (domain) query.domain = String(domain).trim().toUpperCase();
  if (unlinkedOnly === true) query.linkedLeadDeliveryItemId = null;
  // Keyset pagination on the sort key itself — skip/limit would repeat rows as
  // the set mutates underneath the pass.
  if (after) query.episodeId = { $gt: String(after) };
  return CallRecoveryLead.find(query)
    .sort({ episodeId: 1 })
    .limit(Math.max(1, Math.min(1000, Number(limit) || 200)))
    .lean();
}

/** Episodes whose DNC checkpoint is due, oldest first. */
async function listDncCheckpointsDue({ asOf = new Date(), limit = 100, programKey = PROGRAM_KEY } = {}) {
  return CallRecoveryLead.find({
    programKey,
    state: { $nin: ["terminal", "expired"] },
    "dnc.nextCheckAt": { $ne: null, $lte: asOf },
  })
    .sort({ "dnc.nextCheckAt": 1, episodeId: 1 })
    .limit(Math.max(1, Math.min(1000, Number(limit) || 100)))
    .lean();
}

/**
 * Close out an episode that has passed day 120.
 *
 * `discovered` has NO legal edge to `expired` (§6) — it may only reach
 * awaiting_start, held, review or terminal. But `listExpiredEpisodes` will
 * happily hand back a `discovered` row that aged out before it was ever
 * started, and calling transitionState(discovered -> expired) on it throws.
 *
 * That is a real footgun rather than a theoretical one: an episode discovered
 * on the last day before a long outage is exactly the row that arrives here.
 * So expiry walks the legal path instead of asking every caller to know the
 * state machine.
 */
async function expireEpisode(episodeId, { from, expectedVersion, reason = "program-expired" } = {}) {
  if (from === "expired" || from === "terminal") return { ok: true, episode: null, alreadyClosed: true };
  if (from === "discovered") {
    const staged = await transitionState(episodeId, {
      from: "discovered",
      to: "awaiting_start",
      expectedVersion,
      reason: "staged-for-expiry",
    });
    if (!staged.ok) return staged;
    return transitionState(staged.episode.episodeId, {
      from: "awaiting_start",
      to: "expired",
      expectedVersion: staged.episode.version,
      reason,
    });
  }
  return transitionState(episodeId, { from, to: "expired", expectedVersion, reason });
}

/** Episodes past their 120 days that have not yet been closed out. */
async function listExpiredEpisodes({ asOf = new Date(), limit = 200, programKey = PROGRAM_KEY } = {}) {
  return CallRecoveryLead.find({
    programKey,
    state: { $nin: ["terminal", "expired"] },
    expiresAt: { $lte: asOf },
  })
    .sort({ expiresAt: 1, episodeId: 1 })
    .limit(Math.max(1, Math.min(1000, Number(limit) || 200)))
    .lean();
}

/** Count-only state census for the health surface (§23 — never row detail). */
async function countByState({ programKey = PROGRAM_KEY } = {}) {
  const rows = await CallRecoveryLead.aggregate([
    { $match: { programKey } },
    { $group: { _id: "$state", n: { $sum: 1 } } },
  ]);
  const out = {};
  for (const state of CallRecoveryLead.STATES) out[state] = 0;
  for (const r of rows) out[r._id] = r.n;
  return out;
}

/** Attach the canonical work item this episode produced. */
async function linkLeadDeliveryItem(episodeId, leadDeliveryItemId) {
  const itemId = leadDeliveryItemId || null;
  const episode = await CallRecoveryLead.findOneAndUpdate(
    { episodeId, linkedLeadDeliveryItemId: { $ne: itemId } },
    { $set: { linkedLeadDeliveryItemId: itemId }, $inc: { version: 1 } },
    { new: true },
  ).lean();
  if (episode) return { ok: true, episode, unchanged: false };
  const existing = await CallRecoveryLead.findOne({ episodeId }).lean();
  const unchanged = Boolean(existing)
    && String(existing.linkedLeadDeliveryItemId || "") === String(itemId || "");
  return unchanged
    ? { ok: true, episode: existing, unchanged: true }
    : { ok: false, episode: existing || null, unchanged: false };
}

module.exports = {
  PROGRAM_KEY,
  EVIDENCE_CALL_ID_CAP,
  buildEpisodeId,
  canonicalCaseKey,
  assertTransitionAllowed,
  findActiveEpisode,
  findEpisodeByQualifyingCallId,
  recordQualifyingCall,
  transitionState,
  expireEpisode,
  recordDncResult,
  listEpisodesForConsideration,
  listDncCheckpointsDue,
  listExpiredEpisodes,
  countByState,
  linkLeadDeliveryItem,
};
