"use strict";

const { runCxAccountActiveCallWatchOnce } = require("./cxAccountActiveCallWatcherService");
const { logCxAlpha } = require("./cxAlphaTraceService");
const { buildVersionGuardOptions, describeBulkLoadMutationEligibility } = require("./cxBulkLoadMutationEligibility");
const { buildExternId: buildBulkLoadExternId } = require("./cxBulkLoadLeadSourceService");

// Bulk_load runtime service — the ONLY sequencer.
//
// It composes the adapters (lead source, publisher, watcher, outcome adapter,
// repo) and applies the pure reducer; it owns no Mongo/RingCX detail itself. Every
// dependency is injected, so the whole orchestration tests with fakes and zero
// real I/O. Dial model: RingCX owns the buffer — disposition closes the current and
// RingCX advances to the next buffered lead, which the watcher observes. There is
// no manual dial here (that is the preview/slow rail's concern).
//
// See plan "### 8. Runtime Service" + the Clean Code Principles section.

// M11 gate 8: canonical full inventory is 35 (15/10/5/5 mix); 30 was never the target.
const DEFAULT_TARGET_BUFFER = 35;
const DEFAULT_REFILL_THRESHOLD = 5;
// M4: reservation lease length. The lease is stamped ONCE at reserve time and is NOT heartbeated —
// there is no renewal tick. Reserved rows are safe regardless of lease age because the expired-claim
// reaper HARD-excludes any row carrying metadata.reservationSessionId (cxDialQueueRepository
// buildExpiredClaimRequeueQuery ownership guard); only the owning session (releaseReserved/
// cancelReserved) or the crash reconciler frees a reserved row. So claimUntil/reservationExpiresAt
// are single-shot audit values, not a live lease. (cxQueueReservationService.renewReserved exists as
// unwired M2 scaffolding; wiring it would be a bulk-watch-tick-only change — never a shared-service
// heartbeat, which would silently alter slow-lane semantics.) (#13)
const DEFAULT_RESERVE_CLAIM_MINUTES = 10;

// ── pure helpers ────────────────────────────────────────────────────────

function str(value) {
  return String(value == null ? "" : value).trim();
}

// #2: stable per-agent serializer key so concurrent /start requests for ONE agent run one-at-a-time
// (the freshly minted sessionId differs per request and would not serialize them). Prefer the
// always-present agentEmail; fall back to the extension.
function agentMutationKey(input = {}) {
  const email = str(input.agentEmail).toLowerCase();
  const ext = str(input.agentExtensionId);
  return `bulk-start:${email || ext || "unknown"}`;
}

// #2: Mongo duplicate-key (E11000) detection for the one-running-session-per-agent partial-unique
// index backstop.
function isDuplicateKeyError(error) {
  return Number(error?.code) === 11000 || String(error?.codeName || "") === "DuplicateKey";
}

function queueItemKey(candidate = null) {
  return str(candidate?.queueItemId || candidate?.id || candidate?._id);
}

function hasTerminalWriteProof(candidate = null) {
  const uii = str(candidate?.uii);
  return Boolean(queueItemKey(candidate) && uii && !uii.toLowerCase().startsWith("cx-synth:"));
}

function firstStartableBufferCandidate(state = {}) {
  const buffer = Array.isArray(state.acceptedBuffer) ? state.acceptedBuffer : [];
  return buffer.find((candidate) => queueItemKey(candidate) && str(candidate?.phone)) || null;
}

function liveSlots(state) {
  const buffered = Array.isArray(state.acceptedBuffer) ? state.acceptedBuffer.length : 0;
  return buffered + (state.current ? 1 : 0);
}

function bufferDeficit(state, targetBuffer) {
  const deficit = Number(targetBuffer || 0) - liveSlots(state);
  return deficit > 0 ? deficit : 0;
}

function summarizeFlowState(state = {}) {
  return {
    sessionId: state.sessionId || null,
    agentEmail: state.agentEmail || null,
    agentExtensionId: state.agentExtensionId || null,
    domain: state.domain || null,
    status: state.status || null,
    phase: state.phase || null,
    currentQueueItemId: queueItemKey(state.current),
    currentExternId: str(state.current?.externId) || null,
    currentUii: str(state.current?.uii) || null,
    bufferCount: Array.isArray(state.acceptedBuffer) ? state.acceptedBuffer.length : 0,
    completedCount: Array.isArray(state.completed) ? state.completed.length : 0,
    liveSlots: liveSlots(state),
  };
}

function alphaEventFromBulkStage(stage) {
  const suffix = str(stage)
    .replace(/[^a-zA-Z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .toLowerCase();
  return suffix ? `cx.alpha.bulk.${suffix}` : "cx.alpha.bulk.event";
}

function traceBulkFlow(stage, state = {}, extra = {}) {
  const payload = {
    ...summarizeFlowState(state),
    ...extra,
    at: new Date().toISOString(),
  };
  logCxAlpha(alphaEventFromBulkStage(stage), payload);
}

// Pool the matcher looks at: the buffer plus the present current (so an unchanged
// active call resolves to "same", not a phantom switch).
function candidatePool(state) {
  const pool = Array.isArray(state.acceptedBuffer) ? state.acceptedBuffer.slice() : [];
  if (state.current) pool.push(state.current);
  return pool;
}

// M11 gate 8: refill toward the per-family targets from the CURRENT live composition, so a
// buffer already heavy on green replenishes the SHORT families (blue/yellow/red) instead of
// blindly re-front-loading green and starving aged. Residual = max(0, target - liveInBuffer).
function familyRefillTargets(state, familyTargets = {}) {
  const live = {};
  for (const c of candidatePool(state)) {
    const fam = c && c.queueFamily;
    if (fam) live[fam] = (live[fam] || 0) + 1;
  }
  const residual = {};
  for (const fam of Object.keys(familyTargets || {})) {
    const need = Math.max(Number(familyTargets[fam]) || 0, 0) - (live[fam] || 0);
    if (need > 0) residual[fam] = need;
  }
  return residual;
}


// The mutable domain fields we persist back — never the reducer's string
// updatedAt/startedAt (Mongoose timestamps own those) nor identity.
function persistableState(state) {
  const out = {
    status: state.status,
    phase: state.phase,
    current: state.current != null ? state.current : null,
    ringcx: state.ringcx && typeof state.ringcx === "object" ? state.ringcx : {},
    acceptedBuffer: Array.isArray(state.acceptedBuffer) ? state.acceptedBuffer : [],
    prevActiveExternIds: Array.isArray(state.prevActiveExternIds) ? state.prevActiveExternIds : [],
    completed: Array.isArray(state.completed) ? state.completed : [],
    stats: state.stats || {},
    trace: state.trace || {},
    lastOutcome: state.lastOutcome != null ? state.lastOutcome : null,
    reviewHoldUntil: state.reviewHoldUntil || null,
    reviewHoldReason: state.reviewHoldReason || null,
    lastError: state.lastError != null ? state.lastError : null,
  };
  if (state.completedAt) out.completedAt = new Date(state.completedAt);
  if (state.killedAt) out.killedAt = new Date(state.killedAt);
  return out;
}

function isRetryableWatchError(error) {
  const status = Number(
    error?.status ||
      error?.statusCode ||
      error?.details?.responseStatus ||
      error?.response?.status ||
      0,
  );
  if (status === 429 || status >= 500) return true;
  if (error?.retryable === true) return true;
  const text = String(error?.message || error || "").toLowerCase();
  return /\b429\b|rate.?limit|too many requests|timeout|econnreset|etimedout/.test(text);
}

function watchErrorTracePatch(error) {
  return {
    lastWatchSoftErrorAt: new Date().toISOString(),
    lastWatchSoftError: String(error?.message || error || "watch failed").slice(0, 240),
    lastWatchSoftErrorStatus:
      Number(
        error?.status ||
          error?.statusCode ||
          error?.details?.responseStatus ||
          error?.response?.status ||
          0,
      ) || null,
  };
}

function readBulkReviewHoldMs() {
  const raw = Number(process.env.CX_BULK_LOAD_PROGRESSIVE_PAUSE_MS);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return 3000;
}

function buildReviewHoldUntil(base = new Date()) {
  const holdMs = readBulkReviewHoldMs();
  if (holdMs <= 0) return null;
  const at = base instanceof Date ? base : new Date(base || Date.now());
  if (Number.isNaN(at.getTime())) return null;
  return new Date(at.getTime() + holdMs).toISOString();
}

// The watcher's activeCallSummary carries raw ani/dnis phone digits (compactActiveCall). Strip
// them so the same redaction intent as `delete out.phone` isn't defeated by a nested object.
function sanitizeActiveCallSummary(summary = null) {
  if (!summary || typeof summary !== "object") return summary;
  const out = { ...summary };
  delete out.ani;
  delete out.dnis;
  delete out.phone;
  return out;
}

function sanitizeCandidateForClient(candidate = null) {
  if (!candidate || typeof candidate !== "object") return candidate;
  const out = { ...candidate };
  delete out.phone;
  delete out.leadPhone;
  if (out.activeCallSummary && typeof out.activeCallSummary === "object") {
    out.activeCallSummary = sanitizeActiveCallSummary(out.activeCallSummary);
  }
  return out;
}

// Client-safe projection: do not expose full phone numbers or internal fields.
function sanitizeSession(state) {
  if (!state) return null;
  return {
    sessionId: state.sessionId,
    runtime: "bulk_load",
    status: state.status,
    phase: state.phase,
    agentEmail: state.agentEmail || null,
    ringcx: state.ringcx || {},
    current: sanitizeCandidateForClient(state.current || null),
    remainingQueue: (Array.isArray(state.acceptedBuffer) ? state.acceptedBuffer : []).map(sanitizeCandidateForClient),
    lastOutcome: sanitizeCandidateForClient(state.lastOutcome || null),
    reviewHoldUntil: state.reviewHoldUntil || null,
    reviewHoldReason: state.reviewHoldReason || null,
    bufferCount: Array.isArray(state.acceptedBuffer) ? state.acceptedBuffer.length : 0,
    completedCount: Array.isArray(state.completed) ? state.completed.length : 0,
    stats: state.stats || {},
    lastError: state.lastError != null ? state.lastError : null,
    // RESYNC annotation (2026-07-06): {at, reason, removed[{queueItemId,rowState,why}]} —
    // no PII (ids + states only). Exposed so the UI can render a "batch resynced" status
    // line when that lands (WO-16 territory); inspect prints it today.
    resync: state.resync || null,
  };
}

function serializeError(err) {
  if (!err) return "unknown-error";
  return String(err.message || err.reason || err);
}

// ── service factory ─────────────────────────────────────────────────────

function createCxBulkLoadRuntimeService(deps = {}) {
  const {
    repo,
    leadSource,
    publisher,
    watcher,
    outcomeAdapter,
    terminalExecutor,
    queueStateAdapter = {},
    agentLifecycleAdapter = {},
    leadStarter = null,
    contactEligibilityAdapter = {},
    offhookGate,
    client,
    listReadyQueueItems,
    reduce,
    reservationService, // M4: the shared cxQueueReservationService — the ONLY source of claimed rows
  } = deps;
  const now = typeof deps.now === "function" ? deps.now : () => new Date();
  const newSessionId = typeof deps.newSessionId === "function" ? deps.newSessionId : () => `cxbl-${Date.now()}`;
  const busySessionCounts = new Map();
  const sessionOperationTails = new Map();

  for (const [name, value] of Object.entries({ repo, leadSource, publisher, watcher, outcomeAdapter, offhookGate, client, listReadyQueueItems, reduce, reservationService })) {
    if (!value) throw new Error(`createCxBulkLoadRuntimeService requires deps.${name}`);
  }

  function targetBufferFor(state) {
    return Number((state.stats && state.stats.targetSize) || DEFAULT_TARGET_BUFFER);
  }
  function refillThresholdFor(state) {
    return Number((state.stats && state.stats.refillThreshold) || DEFAULT_REFILL_THRESHOLD);
  }

  function isSessionBusy(sessionId) {
    const key = str(sessionId);
    return Boolean(key && (busySessionCounts.get(key) || 0) > 0);
  }

  function addBusySession(key) {
    busySessionCounts.set(key, (busySessionCounts.get(key) || 0) + 1);
  }

  function removeBusySession(key) {
    const next = (busySessionCounts.get(key) || 0) - 1;
    if (next > 0) busySessionCounts.set(key, next);
    else busySessionCounts.delete(key);
  }

  async function withSessionOperation(sessionId, work, { markBusy = false } = {}) {
    const key = str(sessionId);
    if (!key) return work();
    const prior = sessionOperationTails.get(key) || Promise.resolve();
    if (markBusy) addBusySession(key);

    let cleanup;
    const run = prior.catch(() => null).then(async () => {
      try {
        return await work();
      } finally {
        if (markBusy) removeBusySession(key);
        if (sessionOperationTails.get(key) === cleanup) sessionOperationTails.delete(key);
      }
    });
    cleanup = run.catch(() => null);
    sessionOperationTails.set(key, cleanup);
    try {
      return await run;
    } catch (error) {
      throw error;
    }
  }

  async function withSessionMutation(sessionId, work) {
    return withSessionOperation(sessionId, work, { markBusy: true });
  }

  async function withSessionApply(sessionId, work) {
    return withSessionOperation(sessionId, work, { markBusy: false });
  }

  // #2: serialize concurrent starts for one agent on a stable agent key. markBusy:false — the key is
  // not a sessionId, so it must not enter busySessionCounts (which the watcher's skip set reads).
  async function withAgentMutation(agentKey, work) {
    return withSessionOperation(agentKey, work, { markBusy: false });
  }

  // #11: hold the per-session BUSY counter (the watcher-skip signal) WITHOUT the serializer tail, so
  // a long external sequence can keep the account watcher from
  // clearing state.current mid-flight. Because it does NOT chain sessionOperationTails, an inner
  // withSessionMutation on the same sessionId still runs (empty tail) — no self-deadlock. Returns an
  // idempotent release the caller MUST invoke (try/finally).
  function markSessionBusy(sessionId) {
    const key = str(sessionId);
    if (!key) return () => {};
    addBusySession(key);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      removeBusySession(key);
    };
  }

  // Reservation-sourced refill (M4): the SOURCE is now an atomic claim. Reserve up to the
  // deficit ready->claimed per family (policy-driven familyTargets), then publish ONE AT A TIME
  // in family order. Reserved rows are already `claimed` and owned by this session; on a publish
  // reject/error the candidate is dropped from the buffer (reducer event) BEFORE releaseReserved
  // so no renewal tick can re-stamp a row this session just released (§4 release-vs-renew TOCTOU).
  async function releaseFailedReservation(current, row, reason, releaseReason) {
    const next = reduce(current, { type: "buffer.publish_failed", candidate: { queueItemId: row._id }, reason }, now());
    traceBulkFlow("fill.publish_failed", next, {
      queueItemId: str(row._id),
      caseId: row.caseId || null,
      queueFamily: row.queueFamily || null,
      reason,
    });
    await reservationService.releaseReserved([row], releaseReason);
    return next;
  }

  async function dropReservedCandidate(current, row, reason, options = {}) {
    const next = reduce(current, { type: "buffer.publish_failed", candidate: { queueItemId: row._id }, reason }, now());
    traceBulkFlow("fill.candidate_dropped", next, {
      queueItemId: str(row._id),
      caseId: row.caseId || null,
      queueFamily: row.queueFamily || null,
      reason,
      releaseReserved: options.releaseReserved !== false,
      cancelReserved: options.cancelReserved === true,
    });
    if (options.cancelReserved === true && typeof reservationService.cancelReserved === "function") {
      await reservationService.cancelReserved([row], options.cancelReason || reason);
    } else if (options.releaseReserved !== false) {
      await reservationService.releaseReserved([row], options.releaseReason || reason);
    }
    return next;
  }

  async function checkReservedContactEligibility(row, state) {
    if (!contactEligibilityAdapter || typeof contactEligibilityAdapter.resolve !== "function") {
      return { ok: true };
    }
    try {
      const result = await contactEligibilityAdapter.resolve({
        session: state,
        queueItem: row,
        candidate: row,
        domain: row.domain || state.domain,
        caseId: row.caseId,
      });
      return result && typeof result === "object" ? result : { ok: result !== false };
    } catch (error) {
      return {
        ok: false,
        reason: "contact-eligibility-check-failed",
        error: error && error.message ? error.message : String(error),
      };
    }
  }

  async function fillBuffer(state) {
    const deficit = bufferDeficit(state, targetBufferFor(state));
    if (deficit <= 0) {
      traceBulkFlow("fill.no_deficit", state, {
        targetBuffer: targetBufferFor(state),
        refillThreshold: refillThresholdFor(state),
      });
      return state;
    }

    const effectiveFamilyTargets = familyRefillTargets(state, (state.stats && state.stats.familyTargets) || {});
    traceBulkFlow("fill.reserve_started", state, {
      targetBuffer: targetBufferFor(state),
      deficit,
      familyTargets: effectiveFamilyTargets,
    });

    const { reserved } = await reservationService.reserveFromFamilyOrder({
      domain: state.domain,
      agentExtensionId: state.agentExtensionId,
      sessionId: state.sessionId,
      // M11 gate 8: residual per-family deficits from the live buffer, not the static start map.
      familyTargets: effectiveFamilyTargets,
      totalLimit: deficit,
      claimMinutes: Number((state.stats && state.stats.claimMinutes) || DEFAULT_RESERVE_CLAIM_MINUTES),
      metadata: {
        rail: "bulk_load",
        rcxAccountId: state.ringcx && state.ringcx.accountId,
        rcxCampaignId: state.ringcx && state.ringcx.campaignId,
        rcxDialGroupId: state.ringcx && state.ringcx.dialGroupId,
      },
    });
    traceBulkFlow("fill.reserve_finished", state, {
      requested: deficit,
      reserved: reserved.length,
      familyTargets: effectiveFamilyTargets,
    });
    if (!reserved.length) return state;

    let next = state;
    const sessionCampaignId = String((state.ringcx && state.ringcx.campaignId) || "").trim();
    for (const row of reserved) {
      // M11 gate 7 (route-lock): a row carrying its OWN explicit campaign must never be published
      // to a different route than the one it was reserved for. Fail closed — release, don't dial.
      const rowCampaignId = String(row.rcxCampaignId || (row.metadata && row.metadata.rcxCampaignId) || "").trim();
      if (rowCampaignId && sessionCampaignId && rowCampaignId !== sessionCampaignId) {
        next = await releaseFailedReservation(next, row, "route-changed-before-publish", "bulk-route-changed-before-publish");
        continue;
      }
      // M11 gate 7 (cross-pool sibling): a case already active (claimed/serving) on ANOTHER queue
      // row must not be published again — that is the legacy/UCQ double-dial. Mirrors the publish
      // interlock the slow/legacy publisher already runs (findActiveClaimForCase, _id != self).
      if (typeof queueStateAdapter.findActiveSibling === "function") {
        const sibling = await queueStateAdapter
          .findActiveSibling({ domain: row.domain, caseId: row.caseId, excludeId: row._id })
          .catch(() => null);
        if (sibling) {
          next = await releaseFailedReservation(next, row, "cross-pool-interlock:active-sibling", "bulk-cross-pool-active-sibling");
          continue;
        }
      }
      const contactEligibility = await checkReservedContactEligibility(row, state);
      if (!contactEligibility.ok) {
        const reason = contactEligibility.reason || "contact-blocked";
        next = await dropReservedCandidate(next, row, reason, {
          releaseReason: `bulk-contact-blocked:${reason}`,
          cancelReason: `bulk-contact-blocked:${reason}`,
          cancelReserved: contactEligibility.enforced === true,
          releaseReserved: contactEligibility.enforced !== true,
        });
        continue;
      }
      const externId = buildBulkLoadExternId({
        domain: state.domain,
        sessionId: state.sessionId,
        queueItemId: row._id,
      });
      let pub = null;
      try {
        pub = await publisher.publishBatchToRingcx(client, {
          campaignId: state.ringcx && state.ringcx.campaignId,
          // phone + name are required: the publisher drops any candidate without a phone
          // (cxBulkLoadRingcxPublisher.js:40/53) — the doc's M4 snippet omits them.
          // queueFamily rides the candidate so refill can read the live buffer composition (gate 8).
          candidates: [{ queueItemId: row._id, domain: state.domain, caseId: row.caseId, externId, phone: row.phone, name: row.name, queueFamily: row.queueFamily }],
          dialPriority: state.ringcx && state.ringcx.dialPriority,
        });
      } catch (err) {
        const reason = serializeError(err);
        next = await releaseFailedReservation(next, row, reason, `bulk-publish-error:${reason}`);
        continue;
      }
      if (pub.accepted && pub.accepted.length) {
        // M11 gate 4+5: the publish stamp is the ownership write-proof. If the adapter is wired
        // and its guarded CAS misses (row no longer ours) or throws, fail closed — drop the
        // candidate and release rather than buffer a row we cannot prove we own. When no adapter
        // is wired (offline tests) `stamped` defaults truthy so behavior is unchanged.
        let stamped = true;
        if (typeof queueStateAdapter.markCandidatePublished === "function") {
          stamped = await queueStateAdapter.markCandidatePublished({
            session: state,
            candidate: pub.accepted[0].candidate,
            externId: pub.accepted[0].externId,
            campaignId: state.ringcx && state.ringcx.campaignId,
          }).catch(() => null);
        }
        if (stamped) {
          next = reduce(next, {
            type: "buffer.publish_accepted",
            candidate: pub.accepted[0].candidate,
            externId: pub.accepted[0].externId,
            campaignId: state.ringcx && state.ringcx.campaignId,
          }, now());
          traceBulkFlow("fill.publish_accepted", next, {
            queueItemId: str(row._id),
            caseId: row.caseId || null,
            queueFamily: row.queueFamily || null,
            externId: pub.accepted[0].externId || null,
          });
        } else {
          next = await releaseFailedReservation(next, row, "ownership-stamp-unconfirmed", "bulk-publish-stamp-unconfirmed");
        }
      } else {
        const reason = (pub.rejected && pub.rejected[0] && pub.rejected[0].reason) || "unknown";
        next = await releaseFailedReservation(next, row, reason, `bulk-publish-rejected:${reason}`);
      }
    }
    return next;
  }

  async function maybeRefill(state) {
    if (state.status !== "running") return state;
    if (liveSlots(state) > refillThresholdFor(state)) {
      traceBulkFlow("refill.skip_above_threshold", state, {
        liveSlots: liveSlots(state),
        refillThreshold: refillThresholdFor(state),
      });
      return state;
    }
    traceBulkFlow("refill.started", state, {
      liveSlots: liveSlots(state),
      refillThreshold: refillThresholdFor(state),
      targetBuffer: targetBufferFor(state),
    });
    const started = reduce(state, { type: "buffer.refill_started", refillThreshold: refillThresholdFor(state) }, now());
    const filled = await fillBuffer(started);
    traceBulkFlow("refill.finished", filled, {
      liveSlots: liveSlots(filled),
      refillThreshold: refillThresholdFor(filled),
      targetBuffer: targetBufferFor(filled),
    });
    return filled;
  }

  async function persist(state) {
    const options = buildVersionGuardOptions(state);
    const saved = await repo.updateBulkLoadSession(state.sessionId, persistableState(state), options);
    if (!saved) {
      traceBulkFlow("persist.version_miss", state, {
        expectedVersion: options.expectedVersion ?? null,
        expectedUpdatedAt: options.expectedUpdatedAt ?? null,
      });
    }
    return state;
  }

  async function clearTerminalHold(state = {}, current = {}, outcome = null) {
    if (typeof agentLifecycleAdapter.clearTerminalHold !== "function") return null;
    return agentLifecycleAdapter
      .clearTerminalHold({ session: state, candidate: current, outcome })
      .catch(() => null);
  }

  function shouldGetLeadsAfterDisposition(outcome) {
    return String(outcome || "").trim().toLowerCase().replace(/[\s-]+/g, "_") === "did_not_connect";
  }

  function normalizeTerminalResult(terminal) {
    return terminal;
  }

  async function runGetLeadsFromReadyState(state, trigger = "get-leads") {
    if (!state) return { state, getLeads: null };
    if (state.status !== "running") {
      return { state, getLeads: { ok: false, reason: "session-not-running" } };
    }
    if (state.current) {
      return {
        state,
        getLeads: {
          ok: false,
          reason: state.current.uii ? "current-call-active" : "current-call-awaiting-uii",
          queueItemId: queueItemKey(state.current) || null,
        },
      };
    }
    const candidate = firstStartableBufferCandidate(state);
    if (!candidate) {
      return { state, getLeads: { ok: false, reason: "no-startable-buffer-candidate" } };
    }
    if (!leadStarter || typeof leadStarter.getLeads !== "function") {
      return { state, getLeads: { ok: false, reason: "get-leads-unavailable" } };
    }

    traceBulkFlow("get_leads.started", state, {
      trigger,
      queueItemId: queueItemKey(candidate),
      externId: str(candidate.externId) || null,
    });
    const getLeads = await leadStarter.getLeads({ session: state, candidate });
    if (!getLeads || getLeads.ok === false) {
      traceBulkFlow("get_leads.failed", state, {
        trigger,
        queueItemId: queueItemKey(candidate),
        reason: getLeads?.reason || getLeads?.error || "get-leads-failed",
      });
      return {
        state,
        getLeads: {
          ok: false,
          reason: getLeads?.reason || "get-leads-failed",
          error: getLeads?.error || null,
        },
      };
    }

    const startedAt = now();
    const next = {
      ...state,
      phase: state.phase || "ready",
      stats: {
        ...(state.stats || {}),
        lastGetLeadsAt: startedAt.toISOString(),
        lastGetLeadsQueueItemId: queueItemKey(candidate) || null,
        lastGetLeadsElapsedMs: getLeads.elapsedMs || null,
      },
      trace: {
        ...(state.trace || {}),
        lastGetLeads: {
          at: startedAt.toISOString(),
          trigger,
          queueItemId: queueItemKey(candidate) || null,
          externId: str(candidate.externId) || null,
          source: getLeads.source || "ringcx-preview-sdk",
        },
      },
    };
    traceBulkFlow("get_leads.accepted", next, {
      trigger,
      queueItemId: queueItemKey(candidate),
      elapsedMs: getLeads.elapsedMs || null,
    });
    return {
      state: next,
      getLeads: {
        ok: true,
        queueItemId: queueItemKey(candidate) || null,
        elapsedMs: getLeads.elapsedMs || null,
      },
    };
  }

  async function loadState(sessionId) {
    return repo.findBulkLoadSessionById(sessionId);
  }

  // ── public API ─────────────────────────────────────────────────────────

  // Retire any prior running session(s) for this agent through the full runtime kill path (not the
  // repository shortcut) so RC buffered leads and reserved rows are released. Reused on the E11000
  // recovery path. (#2)
  async function retireActiveSessionsForAgent(input = {}, exceptSessionId = null) {
    const activeSessions = typeof repo.findActiveBulkLoadSessionsForAgent === "function"
      ? await repo.findActiveBulkLoadSessionsForAgent({ agentEmail: input.agentEmail, agentExtensionId: input.agentExtensionId })
      : [await repo.findActiveBulkLoadSessionForAgent({ agentEmail: input.agentEmail, agentExtensionId: input.agentExtensionId })].filter(Boolean);
    for (const existing of activeSessions) {
      if (!existing || existing.sessionId === exceptSessionId) continue;
      await killCxBulkLoadSession({ sessionId: existing.sessionId, reason: "replaced-by-new-session" });
    }
    return activeSessions;
  }

  async function startCxBulkLoadSession(input = {}) {
    const sessionId = input.sessionId || newSessionId();
    const agentKey = agentMutationKey(input);
    // #2: serialize concurrent starts for the SAME agent on a STABLE agent key (two no-sessionId
    // starts mint different ids and would NOT serialize, creating two running sessions per agent).
    // The inner sessionId mutation still marks the NEW session busy so the account watcher skips it
    // during preload. agentKey != sessionId, so the nested locks never self-deadlock.
    return withAgentMutation(agentKey, async () =>
      withSessionMutation(sessionId, async () => {
        await retireActiveSessionsForAgent(input, sessionId);

        const seed = {
          sessionId,
          agentEmail: input.agentEmail,
          agentExtensionId: input.agentExtensionId,
          cxAgentId: input.cxAgentId,
          domain: input.domain,
          status: "running",
          phase: "idle",
          ringcx: input.ringcx || {},
          stats: {
            targetSize: Number(input.targetSize || DEFAULT_TARGET_BUFFER),
            refillThreshold: Number(input.refillThreshold || DEFAULT_REFILL_THRESHOLD),
            // M4: policy-driven reservation config, computed once at start and carried in the
            // free-form (persisted) stats so fillBuffer reserves without re-resolving policy per tick.
            familyTargets: input.familyTargets && typeof input.familyTargets === "object" ? input.familyTargets : {},
            claimMinutes: Number(input.claimMinutes || DEFAULT_RESERVE_CLAIM_MINUTES),
          },
        };

        let created;
        try {
          created = await repo.createBulkLoadSession(seed);
        } catch (err) {
          if (!isDuplicateKeyError(err)) throw err;
          // #2 backstop: the one-running-session-per-agent partial-unique index rejected this insert
          // — a concurrent process raced our retire-then-create. Retire the conflicting running
          // session(s) and retry once; if it STILL conflicts, recover the winner rather than
          // creating a duplicate.
          await retireActiveSessionsForAgent(input, sessionId);
          try {
            created = await repo.createBulkLoadSession(seed);
          } catch (retryErr) {
            if (!isDuplicateKeyError(retryErr)) throw retryErr;
            const winner = typeof repo.findActiveBulkLoadSessionForAgent === "function"
              ? await repo.findActiveBulkLoadSessionForAgent({ agentEmail: input.agentEmail, agentExtensionId: input.agentExtensionId })
              : null;
            const recovered = winner ? await loadState(winner.sessionId) : null;
            if (recovered) {
              traceBulkFlow("session.start_recovered_existing", recovered, { sessionId: recovered.sessionId });
              return sanitizeSession(recovered);
            }
            throw retryErr;
          }
        }
        traceBulkFlow("session.created", created, {
          targetBuffer: targetBufferFor(created),
          refillThreshold: refillThresholdFor(created),
          familyTargets: created.stats && created.stats.familyTargets,
          ringcx: created.ringcx || {},
        });

        let state = reduce(created, { type: "session.started" }, now());
        const offhook = await offhookGate.isAgentOffhook(state, { client });
        if (offhook.ok) {
          state = reduce(state, { type: "agent.offhook_ready", reason: offhook.reason || "agent-offhook" }, now());
          traceBulkFlow("session.offhook_ready", state, { reason: offhook.reason || "agent-offhook" });
        }
        state = reduce(state, { type: "buffer.preload_started", targetSize: targetBufferFor(state) }, now());
        traceBulkFlow("session.preload_started", state, {
          targetBuffer: targetBufferFor(state),
          offhookOk: Boolean(offhook.ok),
        });
        state = await fillBuffer(state);
        traceBulkFlow("session.preload_finished", state, {
          targetBuffer: targetBufferFor(state),
          offhookOk: Boolean(offhook.ok),
        });
        if (!offhook.ok) {
          const preloadError = state.lastError;
          state = reduce(state, { type: "agent.waiting_offhook", reason: offhook.reason || "agent-not-offhook" }, now());
          if (preloadError) state.lastError = preloadError;
          traceBulkFlow("session.waiting_offhook", state, { reason: offhook.reason || "agent-not-offhook" });
        }
        await persist(state);
        return sanitizeSession(state);
      }));
  }

  async function getCxBulkLoadSession(query = {}) {
    const state = query.sessionId
      ? await loadState(query.sessionId)
      : await repo.findActiveBulkLoadSessionForAgent({ agentEmail: query.agentEmail, agentExtensionId: query.agentExtensionId });
    return sanitizeSession(state);
  }

  // Close the current call. Terminal executor -> single terminal write -> complete.
  // RingCX advances to the next buffered lead; the next watch picks it up.
  async function submitCxBulkLoadDisposition(input = {}) {
    return withSessionMutation(input.sessionId, async () => {
    const state = await loadState(input.sessionId);
    if (!state || !state.current) {
      traceBulkFlow("disposition.no_current", state || {}, {
        requestedDisposition: input.disposition || null,
      });
      return {
        ...sanitizeSession(state),
        dispositionOk: false,
        terminal: {
          ok: false,
          executed: false,
          reason: state ? "missing-current-call" : "missing-session",
        },
      };
    }
    const current = state.current;
    const outcome = input.disposition || "did_not_connect";
    traceBulkFlow("disposition.started", state, {
      outcome,
      queueItemId: queueItemKey(current),
      externId: str(current?.externId) || null,
      uii: str(current?.uii) || null,
    });
    // M8b §5 — PII-safe trace: caseId/domain/uii are the correlators; full phone is dropped.

    let next = reduce(state, { type: "terminal.started", outcome }, now());

    let terminal = typeof terminalExecutor === "function"
      ? await terminalExecutor({
          session: state,
          candidate: current,
          outcome,
          callback: input.callback,
          callBackDTS: input.callBackDTS,
          notes: input.notes,
        })
      : null;
    terminal = normalizeTerminalResult(terminal);
    if (terminal && terminal.ok === false) {
      next = reduce(next, { type: "terminal.failed", error: terminal.error || terminal.reason || "terminal-rejected" }, now());
      await persist(next);
      traceBulkFlow("disposition.terminal_rejected", next, {
        outcome,
        reason: terminal.error || terminal.reason || "terminal-rejected",
      });
      return { ...sanitizeSession(next), dispositionOk: false, terminal };
    }

    // single idempotent terminal write, then complete + clear current.
    // The call has ALREADY hung up (terminalExecutor succeeded above; terminal.ok===false returned
    // earlier). Durable recording must NOT be allowed to strand the reducer at terminal.started: if
    // persistTerminalOutcome throws, or reports the double-fault (outbox insert AND fallback dispatch
    // both failed), capture a replay marker and STILL advance to terminal.accepted so the lead is
    // counted and current is cleared. The outbox idemKey keeps any later drain/reconciler re-record
    // idempotent. Do NOT use terminal.failed here — that path is for a call that did NOT hang up. (#8)
    let terminalRecordError = null;
    try {
      const persistResult = await outcomeAdapter.persistTerminalOutcome({
        session: state,
        candidate: current,
        outcome,
        source: "disposition",
        eventType: "terminal",
      });
      if (persistResult && persistResult.written === false && persistResult.result?.fallbackFailed === true) {
        const err = persistResult.result?.error;
        terminalRecordError = (err && (err.message || String(err))) || "terminal-record-fallback-failed";
      }
    } catch (err) {
      terminalRecordError = err?.message || String(err);
    }
    await clearTerminalHold(state, current, outcome).catch(() => null);
    const acceptedAt = now();
    next = reduce(next, {
      type: "terminal.accepted",
      outcome,
      hangup: terminal || input.hangup,
      reviewHoldUntil: null,
      reviewHoldReason: null,
    }, acceptedAt);
    next = await maybeRefill(next);
    let getLeads = null;
    if (shouldGetLeadsAfterDisposition(outcome)) {
      const getLeadsResult = await runGetLeadsFromReadyState(next, "after-disposition");
      next = getLeadsResult.state || next;
      getLeads = getLeadsResult.getLeads;
    }
    if (terminalRecordError) {
      // Fail-CLOSED to an observable replay marker, not fail-silent: the reducer reached a terminal
      // state (call counted, current cleared) but durable cadence/DNC recording did not land. Stamp
      // AFTER maybeRefill so the reduce path there does not clear it.
      next = { ...next, lastError: `terminal-record-deferred: ${terminalRecordError}` };
      traceBulkFlow("disposition.terminal_record_deferred", next, { outcome, error: terminalRecordError });
    }
    await persist(next);
    traceBulkFlow("disposition.finished", next, {
      outcome,
      terminalOk: terminal ? terminal.ok !== false : null,
      getLeadsOk: getLeads ? getLeads.ok === true : null,
      getLeadsReason: getLeads?.reason || null,
      terminalRecordDeferred: Boolean(terminalRecordError),
    });
    return { ...sanitizeSession(next), dispositionOk: true, terminal, getLeads, terminalRecordDeferred: Boolean(terminalRecordError) };
    });
  }

  // Skip the current lead — same terminal path, explicit skipped outcome, no
  // RingCX disposition (skip is an app decision, not a call result).
  async function skipCxBulkLoadCurrent(input = {}) {
    return withSessionMutation(input.sessionId, async () => {
    const state = await loadState(input.sessionId);
    if (!state || !state.current) return sanitizeSession(state);
    await outcomeAdapter.persistTerminalOutcome({
      session: state,
      candidate: state.current,
      outcome: "skipped",
      source: "skip",
      eventType: "terminal",
    });
    const acceptedAt = now();
    let next = reduce(state, {
      type: "terminal.accepted",
      outcome: "skipped",
      reviewHoldUntil: buildReviewHoldUntil(acceptedAt),
      reviewHoldReason: "manual-skip",
    }, acceptedAt);
    next = await maybeRefill(next);
    await persist(next);
    return sanitizeSession(next);
    });
  }


  async function startCxBulkLoadGetLeads(input = {}) {
    return withSessionMutation(input.sessionId, async () => {
    const state = await loadState(input.sessionId);
    if (!state) return null;
    const getLeadsResult = await runGetLeadsFromReadyState(state, "api-get-leads");
    const next = getLeadsResult.state || state;
    await persist(next);
    return {
      ...sanitizeSession(next),
      getLeads: getLeadsResult.getLeads,
    };
    });
  }

  // Kill: cancel still-buffered candidates in RingCX, RELEASE every reserved row back to the
  // pool, terminalize the in-flight current, then mark killed + clear.
  async function killCxBulkLoadSession(input = {}) {
    return withSessionMutation(input.sessionId, async () => {
    const state = await loadState(input.sessionId);
    if (!state) return null;
    try {
      await publisher.cancelBatchForSession(client, {
        campaignId: state.ringcx && state.ringcx.campaignId,
        candidates: state.acceptedBuffer || [],
      });
    } catch (err) {
      // cancellation is best-effort; killing the session still proceeds.
    }
    // M11 gate 10: release every reserved-but-not-current row. Under the M2 reaper
    // ownership-exclusion, a leaked `claimed` row carrying this session's reservationSessionId
    // is invisible to the global reaper forever — kill is the ONLY path that can free it, so a
    // reset that skips this manufactures tomorrow's ghost rows (FM-8). Buffer candidates carry
    // `queueItemId`; reconstruct the {_id, reservationSessionId} shape releaseReserved's guarded
    // CAS needs (all buffer rows were reserved under this session's id).
    const currentQueueItemId = queueItemKey(state.current);
    const bufferRows = (state.acceptedBuffer || [])
      .map((c) => ({ _id: c.queueItemId || c._id, metadata: { reservationSessionId: state.sessionId } }))
      .filter((r) => r._id);
    const repositoryRows = typeof reservationService.listReservedForSession === "function"
      ? await reservationService
        .listReservedForSession(state.sessionId, { states: ["claimed", "ready"], limit: "all" })
        .catch(() => [])
      : [];
    const reservedRowsById = new Map();
    for (const row of [...bufferRows, ...(Array.isArray(repositoryRows) ? repositoryRows : [])]) {
      const id = str(row?._id);
      if (!id || id === currentQueueItemId) continue;
      reservedRowsById.set(id, row);
    }
    const reservedRows = Array.from(reservedRowsById.values());
    if (reservedRows.length) {
      await reservationService.releaseReserved(reservedRows, "session-killed");
    }
    // Terminalize the in-flight current (a serving row releaseReserved won't touch) so it is not
    // left claimed/serving with no disposition coming — recorded as a manual-reset release.
    if (state.current) {
      await outcomeAdapter
        .persistTerminalOutcome({
          session: state,
          candidate: state.current,
          outcome: "did_not_connect",
          source: "manual-reset",
          eventType: "terminal",
        })
        .catch(() => null);
    }
    const next = reduce(state, { type: "session.killed", reason: input.reason || "manual" }, now());
    await persist(next);
    traceBulkFlow("session.killed", next, {
      reason: input.reason || "manual",
      reservedReleased: reservedRows.length,
      currentTerminalized: Boolean(state.current),
    });
    return sanitizeSession(next);
    });
  }

  async function watchAccountActiveCalls(input = {}) {
    return runCxAccountActiveCallWatchOnce({
      sessionRepository: repo,
      client,
      domain: input.domain,
      accountId: input.accountId,
      sessionId: input.sessionId,
      agentEmail: input.agentEmail,
      agentExtensionId: input.agentExtensionId,
      answeredMinConnectedMs: input.answeredMinConnectedMs,
      watcher,
      reduce,
      queueStateAdapter,
      outcomeAdapter,
      skipSessionIds: Array.from(busySessionCounts.keys()),
      isSessionBusy,
      applySessionMutation: withSessionApply,
      // #10/#6: a latest-state read for the apply-time staleness guard (before the serving stamp)
      // and for the version-miss re-projection retry. Same loader the beforePersist hook uses.
      loadLatestState: (sessionId) => loadState(sessionId),
      beforePersist: async ({ projection, state }) => {
        const latest = await loadState(projection.sessionId);
        const eligibility = describeBulkLoadMutationEligibility({
          session: projection.before,
          latest,
          busy: isSessionBusy(projection.sessionId),
        });
        if (!eligibility.ok) {
          traceBulkFlow(`watch.refill_skipped_${eligibility.reason}`, state, eligibility);
          return state;
        }
        return maybeRefill(state);
      },
      now: input.now,
    });
  }

  return {
    startCxBulkLoadSession,
    getCxBulkLoadSession,
    watchAccountActiveCalls,
    submitCxBulkLoadDisposition,
    startCxBulkLoadGetLeads,
    skipCxBulkLoadCurrent,
    killCxBulkLoadSession,
    markSessionBusy, // #11: long wrap work can hold this while preserving current
    // exposed for tests/diagnostics
    _fillBuffer: fillBuffer,
  };
}

module.exports = {
  DEFAULT_TARGET_BUFFER,
  DEFAULT_REFILL_THRESHOLD,
  bufferDeficit,
  familyRefillTargets, // exported for the M11 gate-8 refill-math test; pure
  persistableState,
  sanitizeSession,
  createCxBulkLoadRuntimeService,
};
