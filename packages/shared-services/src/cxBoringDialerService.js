"use strict";

// Contact Bridge 5.6 dialer trunk.
//
// Before RingCX: choose and claim eligible work.
// After RingCX accepts: observe its list and active call.
// At terminal: write one durable fact through the existing outbox adapter.
//
// Four boundaries only:
//   inventory  - eligible pool + atomic claim/release
//   ringcx     - accepted list + active call + disposition transport
//   projection - rebuildable outstanding/current display state
//   terminal   - existing insert-once terminal outbox

const {
  buildExternId,
  buildExternSessionToken,
} = require("./cxBulkLoadLeadSourceService");
const {
  normalizeActiveCall,
} = require("./cxBulkLoadActiveCallWatcher");

const FAMILIES = Object.freeze([
  "fresh-day1",
  "fresh-day2to10",
  "fresh-day16to30",
  "aged",
]);
const AGENT_OUTCOMES = new Set(["answered", "did_not_connect", "bad_number", "voicemail"]);
const SYSTEM_OUTCOMES = new Set([...AGENT_OUTCOMES, "dnc"]);
const BUTTON_NEXT_ACTIONS = Object.freeze({
  answered: "call_wrap",
  did_not_connect: "cadence",
  bad_number: "logics_dnc",
  voicemail: "ringcx_vm_drop",
});
const RELEASE_GRACE_MS = 2_000;

function bucketPool(rows = []) {
  const pool = Object.fromEntries(FAMILIES.map((family) => [family, []]));
  for (const row of Array.isArray(rows) ? rows : []) {
    if (pool[row?.queueFamily]) pool[row.queueFamily].push(row);
  }
  return pool;
}

function selectFromPool(pool = {}, familyTargets = {}, outstanding = []) {
  const selected = [];
  let remaining = Math.max(
    0,
    FAMILIES.reduce((sum, family) => sum + Math.max(0, Number(familyTargets[family]) || 0), 0)
      - (Array.isArray(outstanding) ? outstanding.length : 0),
  );

  for (const family of FAMILIES) {
    if (remaining <= 0) break;
    const target = Math.max(0, Number(familyTargets[family]) || 0);
    const live = (Array.isArray(outstanding) ? outstanding : [])
      .filter((row) => row?.queueFamily === family).length;
    const take = Math.min(Math.max(0, target - live), remaining);
    if (take > 0) selected.push(...(pool[family] || []).splice(0, take));
    remaining -= take;
  }

  return selected;
}

function createCxBoringDialer({ inventory, ringcx, projection, terminal } = {}) {
  const contracts = [
    ["inventory", inventory, ["listEligible", "listOwned", "claim", "markPublished", "release", "findByExtern", "normalizeIncoming", "isHardEligible"]],
    ["ringcx", ringcx, ["listOutstanding", "load", "listActiveCalls", "disposition", "listCompleted", "cancel", "hangup"]],
    ["projection", projection, ["replaceOutstanding", "setCurrent", "appendCompleted", "retireObserved", "updateObserved"]],
    ["terminal", terminal, ["persistTerminalOutcome", "hasTerminalOutcome"]],
  ];
  for (const [name, target, methods] of contracts) {
    for (const method of methods) {
      if (!target || typeof target[method] !== "function") {
        throw new Error(`createCxBoringDialer requires ${name}.${method}`);
      }
    }
  }

  async function buildPool(poolParams = {}) {
    const acceptedStatusIds = Array.isArray(poolParams.acceptedStatusIds)
      ? poolParams.acceptedStatusIds.filter(Boolean)
      : [];
    if (!acceptedStatusIds.length) throw new Error("buildPool requires acceptedStatusIds");

    const rows = await inventory.listEligible({
      ...(poolParams.agent ? { agent: poolParams.agent } : {}),
      acceptedStatusIds,
      excludeAppointments: true,
      excludeDnc: true,
      excludeClients: true,
      excludeNonProspects: true,
      cadenceWindowMinutes: Number(poolParams.cadenceWindowMinutes) || 90,
    });
    return bucketPool((Array.isArray(rows) ? rows : []).filter(inventory.isHardEligible));
  }

  async function loadLeads(agent = {}, rows = [], options = {}) {
    const sessionToken = buildExternSessionToken(agent.sessionId);
    if (!sessionToken) throw new Error("loadLeads requires agent.sessionId");

    const outstanding = Array.isArray(options.outstanding)
      ? options.outstanding
      : await ringcx.listOutstanding(agent);
    if (!Array.isArray(outstanding)) throw new Error("ringcx.listOutstanding must return an array");
    await projection.replaceOutstanding(agent, outstanding);

    const liveQueueIds = new Set(outstanding.map((row) => String(row?.queueItemId || "")).filter(Boolean));
    const liveCaseIds = new Set(outstanding.map((row) => String(row?.caseId ?? "")).filter(Boolean));
    const liveExternIds = new Set(outstanding.map((row) => String(row?.externId || "")).filter(Boolean));
    const drafts = [];

    for (const row of Array.isArray(rows) ? rows : []) {
      const queueItemId = String(row?.queueItemId || row?._id || row?.id || "").trim();
      const phone = String(row?.phone || row?.leadPhone || row?.phoneNumber || "").replace(/\D+/g, "");
      if (!queueItemId || !phone || !inventory.isHardEligible(row)) continue;
      const domain = String(row.domain || agent.domain || "TAG").trim().toUpperCase();
      const externId = buildExternId({ domain, queueItemId, sessionId: agent.sessionId });
      const caseKey = String(row.caseId ?? "");
      if (
        liveQueueIds.has(queueItemId)
        || (caseKey && liveCaseIds.has(caseKey))
        || liveExternIds.has(externId)
      ) continue;
      drafts.push({ ...row, queueItemId, phone, domain, externId });
    }

    if (!drafts.length) {
      return { ok: true, reason: "nothing-new", accepted: [], rejected: [] };
    }

    const claimedRows = await inventory.claim(drafts, { agent });
    if (!Array.isArray(claimedRows)) throw new Error("inventory.claim must return an array");
    const draftsById = new Map(drafts.map((row) => [row.queueItemId, row]));
    const claimed = claimedRows.map((row) => {
      const queueItemId = String(row?.queueItemId || row?._id || row?.id || "").trim();
      const draft = draftsById.get(queueItemId);
      return draft ? { ...draft, ...row, queueItemId, externId: draft.externId } : null;
    }).filter(Boolean);
    if (!claimed.length) return { ok: true, reason: "claim-empty", accepted: [], rejected: [] };

    let result;
    try {
      result = await ringcx.load(agent, claimed);
    } catch (error) {
      let cleanup = null;
      try {
        cleanup = await ringcx.cancel(agent, claimed.map((row) => row.externId).filter(Boolean));
      } catch (cleanupError) {
        cleanup = { ok: false, error: cleanupError?.message || String(cleanupError) };
      }
      if (cleanup?.ok !== false) {
        await inventory.release(claimed, "ringcx-load-failed-cancelled");
      }
      const failure = error instanceof Error ? error : new Error(String(error));
      failure.cleanup = cleanup;
      throw failure;
    }

    const claimedById = new Map(claimed.map((row) => [row.queueItemId, row]));
    const accepted = (Array.isArray(result?.accepted) ? result.accepted : [])
      .map((entry) => entry?.candidate || claimedById.get(String(entry?.queueItemId || "")) || null)
      .filter(Boolean);
    const acceptedIds = new Set(accepted.map((row) => row.queueItemId));
    const rejected = claimed.filter((row) => !acceptedIds.has(row.queueItemId));
    if (accepted.length) {
      try {
        await inventory.markPublished(accepted, { agent, result });
      } catch (error) {
        let cleanup = null;
        try {
          cleanup = await ringcx.cancel(agent, accepted.map((row) => row.externId).filter(Boolean));
        } catch (cleanupError) {
          cleanup = { ok: false, error: cleanupError?.message || String(cleanupError) };
        }
        if (cleanup?.ok !== false) {
          try {
            await inventory.release(claimed, "ringcx-published-local-stamp-failed");
          } catch (releaseError) {
            cleanup = { ...cleanup, ok: false, localError: releaseError?.message || String(releaseError) };
          }
        }
        const failure = error instanceof Error ? error : new Error(String(error));
        failure.cleanup = cleanup;
        throw failure;
      }
    }
    if (rejected.length) await inventory.release(rejected, "ringcx-rejected");

    let projectionError = null;
    try {
      const refreshed = await ringcx.listOutstanding(agent);
      if (!Array.isArray(refreshed)) throw new Error("ringcx.listOutstanding must return an array");
      await projection.replaceOutstanding(agent, refreshed);
    } catch (error) {
      projectionError = error?.message || "outstanding-refresh-failed";
    }

    return {
      ok: true,
      accepted,
      rejected,
      ringcx: result,
      projectionError,
    };
  }

  async function addIncomingLead(agent = {}, incomingPost = {}) {
    const lead = await inventory.normalizeIncoming(incomingPost);
    if (!lead || !inventory.isHardEligible(lead)) {
      return { ok: false, reason: "not-eligible", accepted: [], rejected: [] };
    }
    return loadLeads(agent, [lead]);
  }

  async function refillAgent(agent = {}, pool = {}, rules = {}) {
    const outstanding = Array.isArray(rules.outstanding)
      ? rules.outstanding
      : await ringcx.listOutstanding(agent);
    if (!Array.isArray(outstanding)) throw new Error("ringcx.listOutstanding must return an array");
    await projection.replaceOutstanding(agent, outstanding);
    const refillAt = Math.max(0, Number(rules.refillAt) || 0);
    if (outstanding.length > refillAt) {
      return { ok: true, reason: "queue-above-refill", outstanding: outstanding.length, accepted: [], rejected: [] };
    }

    const selection = selectFromPool(
      pool,
      rules.familyTargets || {},
      rules.sendBatch === true ? [] : outstanding,
    );
    if (!selection.length) {
      return { ok: false, reason: "no-pool-inventory", outstanding: outstanding.length, accepted: [], rejected: [] };
    }
    return loadLeads(agent, selection, { outstanding });
  }

  async function refreshAgent(agent = {}) {
    const outstanding = await ringcx.listOutstanding(agent);
    if (!Array.isArray(outstanding)) throw new Error("ringcx.listOutstanding must return an array");
    await projection.replaceOutstanding(agent, outstanding);
    return { ok: true, outstanding };
  }

  async function resolveActiveCall(agent = {}, options = {}) {
    const sessionToken = buildExternSessionToken(agent.sessionId);
    if (!sessionToken) throw new Error("resolveActiveCall requires agent.sessionId");
    const calls = options.activeCalls === undefined
      ? await ringcx.listActiveCalls(agent)
      : options.activeCalls;
    if (!Array.isArray(calls)) throw new Error("ringcx.listActiveCalls must return an array");
    const normalized = calls.map(normalizeActiveCall);
    if (!normalized.length) return { status: "empty", activeCalls: [] };

    const domain = String(agent.domain || "TAG").trim().toLowerCase();
    const prefix = `cxbl-${domain}-${sessionToken}-`;
    const relevant = normalized.filter((call) => call.externId.startsWith(prefix));
    if (!relevant.length) {
      return { status: "ambiguous", reason: "active-call-owned-elsewhere", activeCalls: normalized };
    }

    const retiredUiis = new Set(
      (Array.isArray(agent.completed) ? agent.completed : [])
        .map((row) => String(row?.uii || "").trim())
        .filter(Boolean),
    );
    const uncached = relevant.filter((call) => !retiredUiis.has(call.uii));
    if (!uncached.length) {
      return { status: "retired", reason: "active-call-uii-already-completed", activeCalls: relevant };
    }

    let ambiguityReason = uncached.some((call) => !call.uii)
      ? "session-active-call-missing-uii"
      : null;
    const exactCalls = uncached.filter((call) => call.uii);
    const distinct = new Map(exactCalls.map((call) => [`${call.externId}:${call.uii}`, call]));
    const live = [];
    const observedCalls = [];
    for (const activeCall of distinct.values()) {
      const queueItemId = activeCall.externId.slice(prefix.length).trim();
      if (!queueItemId) {
        ambiguityReason ||= "active-call-queue-identity-missing";
        continue;
      }
      const terminalized = await terminal.hasTerminalOutcome({
        session: agent,
        candidate: { queueItemId, externId: activeCall.externId, uii: activeCall.uii },
      });
      if (terminalized) continue;
      observedCalls.push(activeCall);
      const found = await inventory.findByExtern(agent, activeCall.externId);
      if (!found) {
        ambiguityReason ||= "active-call-candidate-not-found";
        continue;
      }
      const candidate = { ...found, externId: found.externId || activeCall.externId };
      if (candidate.externId !== activeCall.externId) {
        ambiguityReason ||= "active-call-candidate-mismatch";
        continue;
      }
      live.push({ activeCall, candidate });
    }
    if (ambiguityReason) {
      return {
        status: "ambiguous",
        reason: ambiguityReason,
        activeCalls: relevant,
        observedCalls,
      };
    }
    if (!live.length) {
      return {
        status: "retired",
        reason: "active-call-uii-already-terminal",
        activeCalls: relevant,
        observedCalls: [],
      };
    }
    if (live.length !== 1) {
      return {
        status: "ambiguous",
        reason: "multiple-session-active-calls",
        activeCalls: relevant,
        observedCalls,
      };
    }
    const { activeCall, candidate } = live[0];
    return {
      status: "matched",
      candidate,
      activeCall,
      matchReasons: ["externId", "uii"],
      activeCalls: relevant,
      observedCalls,
    };
  }

  async function observeAgent(agent = {}) {
    let resolved;
    try {
      resolved = await resolveActiveCall(agent);
    } catch (error) {
      // A failed read cannot prove a release, so keep pending UIIs; it also cannot
      // prove the middle card is current, so blank only the rebuildable projection.
      await projection.setCurrent(agent, null);
      return {
        ok: false,
        readOk: false,
        reason: "ringcx-read-failed",
        error: error?.message || String(error),
        current: null,
      };
    }

    if (resolved.status === "empty") {
      await projection.setCurrent(agent, null);
      return { ok: true, readOk: true, status: "empty", current: null, activeCalls: [] };
    }
    if (resolved.status !== "matched") {
      await projection.setCurrent(agent, null, { observedCalls: resolved.observedCalls || [] });
      return {
        ok: false,
        readOk: true,
        status: "ambiguous",
        reason: resolved.reason,
        current: null,
        activeCalls: resolved.activeCalls || [],
      };
    }

    const current = {
      ...resolved.candidate,
      uii: resolved.activeCall.uii,
      activeCallSummary: resolved.activeCall,
    };
    await projection.setCurrent(agent, current, { observedCalls: resolved.observedCalls || [] });
    return { ok: true, readOk: true, status: "matched", current, activeCalls: resolved.activeCalls || [] };
  }

  async function finishCall(agent = {}, outcome = null, expectedIdentity = {}) {
    const normalizedOutcome = String(outcome || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (!normalizedOutcome) return { ok: false, reason: "missing-outcome" };
    if (!AGENT_OUTCOMES.has(normalizedOutcome)) return { ok: false, reason: "invalid-outcome" };
    const nextAction = String(expectedIdentity.nextAction || "").trim().toLowerCase();
    if (!nextAction) return { ok: false, reason: "missing-next-action" };
    if (nextAction !== BUTTON_NEXT_ACTIONS[normalizedOutcome]) {
      return { ok: false, reason: "button-action-mismatch" };
    }
    const expectedExternId = String(expectedIdentity.expectedExternId || expectedIdentity.externId || "").trim();
    const expectedUii = String(expectedIdentity.expectedUii || expectedIdentity.uii || "").trim();
    if (!expectedExternId || !expectedUii) {
      return { ok: false, reason: "missing-expected-identity" };
    }

    const pending = (Array.isArray(agent.stats?.observedCalls) ? agent.stats.observedCalls : [])
      .find((row) => String(row?.externId || "").trim() === expectedExternId
        && String(row?.uii || "").trim() === expectedUii) || null;
    const sessionToken = buildExternSessionToken(agent.sessionId);
    const domain = String(agent.domain || "TAG").trim().toLowerCase();
    const prefix = sessionToken ? `cxbl-${domain}-${sessionToken}-` : null;
    const expectedQueueItemId = prefix && expectedExternId.startsWith(prefix)
      ? expectedExternId.slice(prefix.length).trim()
      : "";
    if (!expectedQueueItemId) return { ok: false, reason: "expected-identity-owned-elsewhere" };

    const expectedCandidate = {
      ...(pending || {}),
      queueItemId: String(pending?.queueItemId || expectedQueueItemId),
      externId: expectedExternId,
      uii: expectedUii,
    };
    if (await terminal.hasTerminalOutcome({ session: agent, candidate: expectedCandidate })) {
      await projection.retireObserved(agent, expectedCandidate);
      return { ok: false, reason: "active-call-uii-already-terminal" };
    }

    let resolved = null;
    let readError = null;
    try {
      resolved = await resolveActiveCall(agent);
    } catch (error) {
      readError = error;
    }
    const activeMatchesExpected = resolved?.status === "matched"
      && resolved.activeCall?.externId === expectedExternId
      && resolved.activeCall?.uii === expectedUii;
    if (!activeMatchesExpected && !pending) {
      if (resolved?.status === "matched" && resolved.activeCall?.uii) {
        const actual = {
          ...resolved.candidate,
          uii: resolved.activeCall.uii,
          activeCallSummary: resolved.activeCall,
        };
        await projection.setCurrent(agent, actual);
        return {
          ok: false,
          reason: "active-call-identity-changed",
          expected: { externId: expectedExternId, uii: expectedUii },
          actual: { externId: resolved.activeCall.externId, uii: resolved.activeCall.uii },
        };
      }
      return {
        ok: false,
        reason: readError ? "ringcx-read-failed" : (resolved?.reason || "no-active-uii"),
        ...(readError ? { error: readError?.message || String(readError) } : {}),
      };
    }

    const local = await inventory.findByExtern(agent, expectedExternId).catch(() => null);
    const candidate = {
      ...(pending || {}),
      ...(local || {}),
      ...(activeMatchesExpected ? resolved.candidate : {}),
      queueItemId: expectedQueueItemId,
      externId: expectedExternId,
      uii: expectedUii,
    };
    let transport;
    try {
      transport = await ringcx.disposition(agent, {
        uii: expectedUii,
        outcome: normalizedOutcome,
        candidate,
      });
    } catch (error) {
      transport = { ok: false, error: error?.message || String(error) };
    }
    if (activeMatchesExpected && transport?.ok === false) {
      return { ok: false, reason: "ringcx-disposition-rejected", candidate, transport };
    }
    let hangup = null;
    if (activeMatchesExpected && normalizedOutcome !== "voicemail") {
      try {
        hangup = await ringcx.hangup(agent, expectedUii);
      } catch (error) {
        hangup = { ok: false, error: error?.message || String(error) };
      }
    }
    const terminalWrite = await terminal.persistTerminalOutcome({
      session: agent,
      candidate,
      outcome: normalizedOutcome,
      source: "agent-button",
      eventType: "terminal",
      nextAction,
    });
    if (terminalWrite?.written !== false) {
      await projection.appendCompleted(agent, { ...candidate, outcome: normalizedOutcome });
    } else {
      await projection.retireObserved(agent, candidate);
        return { ok: false, reason: "active-call-uii-already-terminal", candidate, transport, hangup, terminal: terminalWrite };
    }
    await projection.setCurrent(agent, null, {
      expectedExternId: candidate.externId,
      expectedUii: candidate.uii,
    });
    return { ok: true, candidate, transport, hangup, nextAction, terminal: terminalWrite };
  }

  async function recordCompleted(agent = {}, options = {}) {
    const sessionToken = buildExternSessionToken(agent.sessionId);
    if (!sessionToken) throw new Error("recordCompleted requires agent.sessionId");
    const domain = String(agent.domain || "TAG").trim().toLowerCase();
    const prefix = `cxbl-${domain}-${sessionToken}-`;
    const completed = await ringcx.listCompleted(agent, {
      since: options.since || null,
      activeCalls: options.activeCalls || [],
      now: options.now,
      graceMs: options.graceMs,
    });
    if (!Array.isArray(completed)) throw new Error("ringcx.listCompleted must return an array");

    const written = [];
    const skipped = [];
    for (const row of completed) {
      const externId = String(row?.externId || "").trim();
      const queueItemId = String(row?.queueItemId || row?._id || row?.id || "").trim();
      const uii = String(row?.uii || "").trim();
      const outcome = String(row?.outcome || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
      if (!externId.startsWith(prefix) || !queueItemId || !uii || !SYSTEM_OUTCOMES.has(outcome)) {
        skipped.push(row);
        continue;
      }
      const terminalWrite = await terminal.persistTerminalOutcome({
        session: agent,
        candidate: { ...row, queueItemId, externId, uii },
        outcome,
        source: "ringcx-system-disposition",
        eventType: "terminal",
        systemDisposition: row.systemDisposition || null,
      });
      written.push(terminalWrite);
      if (terminalWrite?.written !== false) {
        await projection.appendCompleted(agent, { ...row, queueItemId, externId, uii, outcome });
      } else {
        await projection.retireObserved(agent, { queueItemId, externId, uii });
      }
    }
    return { ok: true, written, skipped };
  }

  async function recordReleased(agent = {}, options = {}) {
    const sessionToken = buildExternSessionToken(agent.sessionId);
    if (!sessionToken) throw new Error("recordReleased requires agent.sessionId");
    const domain = String(agent.domain || "TAG").trim().toLowerCase();
    const prefix = `cxbl-${domain}-${sessionToken}-`;
    const activeKeys = new Set(
      (Array.isArray(options.activeCalls) ? options.activeCalls : [])
        .map(normalizeActiveCall)
        .filter((call) => call.externId.startsWith(prefix) && call.uii)
        .map((call) => `${call.externId}:${call.uii}`),
    );
    const pending = (Array.isArray(agent.stats?.observedCalls) ? agent.stats.observedCalls : [])
      .filter((row) => String(row?.externId || "").trim().startsWith(prefix)
        && String(row?.uii || "").trim());

    const awaitingSystemDisposition = [];
    const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
    const requestedGraceMs = Number(options.graceMs);
    const graceMs = Number.isFinite(requestedGraceMs) ? Math.max(requestedGraceMs, 0) : RELEASE_GRACE_MS;
    for (const observed of pending) {
      const externId = String(observed.externId).trim();
      const uii = String(observed.uii).trim();
      const queueItemId = String(observed.queueItemId || externId.slice(prefix.length)).trim();
      const identity = { ...observed, queueItemId, externId, uii };
      if (await terminal.hasTerminalOutcome({ session: agent, candidate: identity })) {
        await projection.retireObserved(agent, identity);
        continue;
      }
      if (activeKeys.has(`${externId}:${uii}`)) continue;
      const lastSeenAt = new Date(observed.lastSeenAt || 0).getTime();
      if (!Number.isFinite(lastSeenAt) || lastSeenAt <= 0) {
        await projection.updateObserved(agent, identity, { lastSeenAt: now.toISOString() });
        continue;
      }
      if (now.getTime() - lastSeenAt < graceMs) continue;
      if (!observed.releasedAt) {
        await projection.updateObserved(agent, identity, {
          releasedAt: now.toISOString(),
          releaseSource: "active-call-feed",
        });
      }
      awaitingSystemDisposition.push(identity);
    }
    return { ok: true, written: [], awaitingSystemDisposition };
  }

  async function resetAgent(agent = {}, reason = "manual") {
    let resolved;
    try {
      resolved = await resolveActiveCall(agent);
    } catch (error) {
      return { ok: false, reason: "ringcx-read-failed", error: error?.message || String(error) };
    }
    const sessionToken = buildExternSessionToken(agent.sessionId);
    const domain = String(agent.domain || "TAG").trim().toLowerCase();
    const prefix = sessionToken ? `cxbl-${domain}-${sessionToken}-` : null;
    const ownedActive = (Array.isArray(resolved.activeCalls) ? resolved.activeCalls : [])
      .filter((call) => prefix && String(call?.externId || "").startsWith(prefix));
    let outstanding;
    let ownedRows;
    try {
      [outstanding, ownedRows] = await Promise.all([
        Array.isArray(resolved.outstanding) ? resolved.outstanding : ringcx.listOutstanding(agent),
        inventory.listOwned(agent),
      ]);
    } catch (error) {
      return { ok: false, reason: "cleanup-inventory-read-failed", error: error?.message || String(error) };
    }
    if (!Array.isArray(outstanding) || !Array.isArray(ownedRows)) {
      return { ok: false, reason: "cleanup-inventory-read-invalid" };
    }
    const externIds = new Set((Array.isArray(outstanding) ? outstanding : [])
      .map((row) => String(row?.externId || "").trim()).filter(Boolean));
    for (const row of ownedRows) {
      const externId = String(
        row?.externId || row?.metadata?.lastRingcxPublishedExternId || "",
      ).trim();
      if (prefix && externId.startsWith(prefix)) externIds.add(externId);
    }
    const pendingByIdentity = new Map();
    for (const row of [
      ...(Array.isArray(agent.stats?.observedCalls) ? agent.stats.observedCalls : []),
      agent.current,
      ...(Array.isArray(agent.completed) ? agent.completed : []),
    ].filter(Boolean)) {
      const externId = String(row?.externId || "").trim();
      const uii = String(row?.uii || "").trim();
      if (!prefix || !externId.startsWith(prefix) || !uii) continue;
      const queueItemId = String(row?.queueItemId || externId.slice(prefix.length)).trim();
      if (!queueItemId) continue;
      pendingByIdentity.set(`${externId}:${uii}`, { ...row, queueItemId, externId, uii });
      externIds.add(externId);
    }
    const retainedIdentityKeys = new Set(pendingByIdentity.keys());
    const unretainedActive = ownedActive.filter((activeCall) => {
      const externId = String(activeCall?.externId || "").trim();
      const uii = String(activeCall?.uii || "").trim();
      return externId && uii && !retainedIdentityKeys.has(`${externId}:${uii}`);
    });
    if (unretainedActive.length) {
      let retained;
      try {
        retained = await projection.setCurrent(agent, agent.current || null, { observedCalls: unretainedActive });
      } catch (error) {
        return { ok: false, reason: "cleanup-snapshot-retention-failed", error: error?.message || String(error) };
      }
      if (retained === null || retained === false) {
        return { ok: false, reason: "cleanup-snapshot-retention-failed" };
      }
    }
    for (const activeCall of ownedActive) {
      const externId = String(activeCall?.externId || "").trim();
      const uii = String(activeCall?.uii || "").trim();
      if (externId) externIds.add(externId);
      if (!externId || !uii) continue;
      const queueItemId = externId.slice(prefix.length).trim();
      if (!queueItemId) continue;
      const key = `${externId}:${uii}`;
      pendingByIdentity.set(key, {
        ...(pendingByIdentity.get(key) || {}),
        queueItemId,
        externId,
        uii,
        activeCallSummary: activeCall,
      });
      externIds.add(externId);
    }

    const releaseByQueueItemId = new Map();
    const localByExtern = new Map();
    for (const row of [...ownedRows, ...outstanding]) {
      const queueItemId = String(row?.queueItemId || row?._id || "").trim();
      const externId = String(
        row?.externId || row?.metadata?.lastRingcxPublishedExternId || "",
      ).trim();
      const snapshot = { ...row, ...(queueItemId ? { queueItemId } : {}), ...(externId ? { externId } : {}) };
      if (queueItemId) releaseByQueueItemId.set(queueItemId, snapshot);
      if (externId) localByExtern.set(externId, snapshot);
    }
    const terminalCandidateSnapshot = [];
    for (const remembered of pendingByIdentity.values()) {
      const local = localByExtern.get(remembered.externId) || null;
      const candidate = {
        ...remembered,
        ...(local || {}),
        queueItemId: String(local?.queueItemId || remembered.queueItemId || "").trim(),
        externId: remembered.externId,
        uii: remembered.uii,
      };
      const caseId = candidate.caseId == null || String(candidate.caseId).trim() === ""
        ? null
        : Number(candidate.caseId);
      const phoneDigits = String(candidate.phone || candidate.leadPhone || candidate.phoneNumber || "").replace(/\D+/g, "");
      const phone = phoneDigits.length === 11 && phoneDigits.startsWith("1")
        ? phoneDigits.slice(1)
        : (phoneDigits.length === 10 ? phoneDigits : null);
      let existingTerminal = false;
      try {
        existingTerminal = await terminal.hasTerminalOutcome({ session: agent, candidate });
      } catch (error) {
        return { ok: false, reason: "terminal-proof-read-failed", error: error?.message || String(error) };
      }
      if (!candidate.queueItemId || (!existingTerminal && !Number.isFinite(caseId) && !phone)) {
        return {
          ok: false,
          reason: "terminal-identity-missing",
          identity: { queueItemId: candidate.queueItemId || null, externId: candidate.externId, uii: candidate.uii },
        };
      }
      terminalCandidateSnapshot.push({ candidate, existingTerminal });
      releaseByQueueItemId.set(candidate.queueItemId, candidate);
    }

    let cancelled;
    let cancelError = null;
    try {
      cancelled = await ringcx.cancel(agent, [...externIds]);
    } catch (error) {
      cancelError = error?.message || String(error);
      cancelled = { ok: false, error: cancelError };
    }
    const activeUiis = [...new Set(ownedActive.map((call) => String(call?.uii || "").trim()).filter(Boolean))];
    const hangups = [];
    for (const uii of activeUiis) {
      try {
        const result = await ringcx.hangup(agent, uii);
        hangups.push({ uii, result });
      } catch (error) {
        hangups.push({ uii, result: { ok: false, error: error?.message || String(error) } });
      }
    }

    let verifiedActive;
    let verifiedOutstanding;
    try {
      // Read the lead list first, then active calls. A READY/PENDING lead that
      // advances during verification is therefore caught by the later active read.
      verifiedOutstanding = await ringcx.listOutstanding(agent);
      verifiedActive = await ringcx.listActiveCalls(agent);
    } catch (error) {
      return {
        ok: false,
        reason: "ringcx-cleanup-verification-failed",
        error: error?.message || String(error),
        cancelled,
        hangups,
      };
    }
    if (!Array.isArray(verifiedActive) || !Array.isArray(verifiedOutstanding)) {
      return { ok: false, reason: "ringcx-cleanup-verification-invalid", cancelled, hangups };
    }
    const remainingActive = verifiedActive
      .map(normalizeActiveCall)
      .filter((call) => prefix && call.externId.startsWith(prefix));
    const remainingOutstanding = verifiedOutstanding.filter((row) => {
      const externId = String(row?.externId || "").trim();
      return prefix && externId.startsWith(prefix);
    });
    if (remainingActive.length || remainingOutstanding.length) {
      const rejectedHangup = hangups.find((row) => row.result?.ok === false);
      const failureReason = remainingActive.length && rejectedHangup
        ? "ringcx-hangup-rejected"
        : (remainingOutstanding.length && (cancelled?.ok === false || cancelError)
          ? "ringcx-cancel-rejected"
          : "ringcx-cleanup-unconfirmed");
      return {
        ok: false,
        reason: failureReason,
        cancelled,
        hangups,
        remainingActive,
        remainingOutstanding,
      };
    }

    const terminalWrites = [];
    const terminalCandidates = [];
    for (const { candidate, existingTerminal } of terminalCandidateSnapshot) {
      if (existingTerminal) {
        terminalCandidates.push({ candidate, terminalWrite: { written: false, existing: true } });
        continue;
      }
      const terminalWrite = await terminal.persistTerminalOutcome({
        session: agent,
        candidate,
        outcome: "did_not_connect",
        source: "manual-reset",
        eventType: "terminal",
      });
      terminalWrites.push(terminalWrite);
      terminalCandidates.push({ candidate, terminalWrite });
    }
    const releasable = [...releaseByQueueItemId.values()];
    if (releasable.length) {
      const released = await inventory.release(releasable, "session-killed");
      if (released?.ok === false) {
        return { ok: false, reason: "local-release-unconfirmed", released, terminals: terminalWrites };
      }
    }

    const projectionErrors = [];
    for (const { candidate, terminalWrite } of terminalCandidates) {
      try {
        if (terminalWrite?.written !== false) {
          await projection.appendCompleted(agent, { ...candidate, outcome: "did_not_connect" });
        } else {
          await projection.retireObserved(agent, candidate);
        }
      } catch (error) {
        projectionErrors.push(error?.message || String(error));
      }
    }
    await projection.replaceOutstanding(agent, []).catch((error) => projectionErrors.push(error?.message || String(error)));
    await projection.setCurrent(agent, null).catch((error) => projectionErrors.push(error?.message || String(error)));
    return {
      ok: true,
      reason,
      cancelled: externIds.size,
      terminals: terminalWrites,
      hangups,
      projectionErrors,
    };
  }

  return {
    buildPool,
    loadLeads,
    addIncomingLead,
    refillAgent,
    refreshAgent,
    observeAgent,
    finishCall,
    recordCompleted,
    recordReleased,
    resetAgent,
  };
}

module.exports = { BUTTON_NEXT_ACTIONS, createCxBoringDialer, RELEASE_GRACE_MS };
