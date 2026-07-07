"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// THE SMALL RETRY QUEUE (Mickey, 2026-07-07: "a small retry queue that looks for 429 404
// whatever specifically from rc — other than that assume we have what we need from system").
// A terminal observation that could not get a LABEL defers instead of routing: RC errors/
// timeouts retry because they're OUR blindness; clean-but-empty reads retry because his
// premise says we always see something — seeing nothing means "not stamped yet". Two
// re-reads (~5s, ~20s), then the verdict finalizes by what the reads actually were.
// End-to-end lanes (resolve/exhaust-gamut/exhaust-blind) live in cxSysDispoSplit.test.js;
// this file pins the decision matrix and the queue mechanics.

const {
  runCxAccountActiveCallWatchOnce,
  deriveSysDispoRetryDecision,
} = require("../../packages/shared-services/src/cxAccountActiveCallWatcherService");

function session(id, accountId, current) {
  return {
    sessionId: id,
    status: "running",
    phase: current ? "active" : "ready",
    agentEmail: `${id}@example.test`,
    agentExtensionId: id,
    domain: "TAG",
    ringcx: { accountId, campaignId: 2306 },
    current: current || null,
    acceptedBuffer: [],
    completed: [],
    stats: {},
    prevActiveExternIds: current ? [current.externId] : [],
    trace: current ? { prevActiveCalls: [{ externId: current.externId, uii: "u1" }] } : {},
  };
}

function candidate(queueItemId, externId) {
  return {
    queueItemId,
    caseId: Number(queueItemId.replace(/\D/g, "")) || 1,
    domain: "TAG",
    name: `Lead ${queueItemId}`,
    externId,
    ringcx: { externId },
  };
}

test("RETRY DECISION MATRIX: labels and structural misses persist; RC failures and clean-unstamped reads defer; flag-off never defers", () => {
  const on = { enabled: true };
  // RingCX spoke — route now, both directions
  assert.equal(deriveSysDispoRetryDecision({ label: "ANSWER", read: true, reason: "clean" }, "did_not_connect", on), "persist");
  assert.equal(deriveSysDispoRetryDecision({ label: "MACHINE", read: true, reason: "clean" }, "answered", on), "persist");
  // Mickey's lane: 429/404/timeout/whatever from RC — retry
  assert.equal(deriveSysDispoRetryDecision({ label: null, read: false, reason: "error" }, "answered", on), "defer");
  assert.equal(deriveSysDispoRetryDecision({ label: null, read: false, reason: "timeout" }, "did_not_connect", on), "defer");
  // the not-stamped-yet lane: a clean read that saw NOTHING isn't "something" yet — retry
  assert.equal(deriveSysDispoRetryDecision({ label: null, read: true, reason: "clean" }, "answered", on), "defer");
  assert.equal(deriveSysDispoRetryDecision({ label: null, read: true, reason: "clean" }, "did_not_connect", on), "defer");
  // structural: retrying can never help — persist with the guard verdict now
  assert.equal(deriveSysDispoRetryDecision({ label: null, read: false, reason: "no-client" }, "answered", on), "persist");
  assert.equal(deriveSysDispoRetryDecision({ label: null, read: false, reason: "missing-ids" }, "answered", on), "persist");
  assert.equal(deriveSysDispoRetryDecision({ label: null, read: false, reason: "not-attempted" }, "voicemail", on), "persist");
  // non-binary outcomes never enter the queue
  assert.equal(deriveSysDispoRetryDecision({ label: null, read: false, reason: "error" }, "voicemail", on), "persist");
  // flag off: byte-for-byte legacy — no deferral machinery at all
  assert.equal(deriveSysDispoRetryDecision({ label: null, read: false, reason: "error" }, "answered", { enabled: false }), "persist");
  assert.equal(deriveSysDispoRetryDecision({ label: null, read: true, reason: "clean" }, "answered", {}), "persist");
});

async function runOneTick({ current, stash = null, searchBehavior, classifierOn = true, now }) {
  const terminalWrites = [];
  const stashWrites = [];
  let searchCalls = 0;
  const s1 = session("s1", "acct-a", current);
  if (stash) s1.sysDispoRetries = stash;
  await runCxAccountActiveCallWatchOnce({
    sessionRepository: {
      async listActiveBulkLoadSessions() { return [s1]; },
      async updateBulkLoadSession(sessionId, patch) {
        if (patch.sysDispoRetries !== undefined) stashWrites.push(patch.sysDispoRetries);
        Object.assign(s1, patch);
        return s1;
      },
    },
    client: {
      async listActiveCalls() { return []; },
      async searchLeads(payload = {}) {
        searchCalls += 1;
        if (searchBehavior === "throw") throw new Error("429 Too Many Requests");
        const fields = searchBehavior || {};
        // Honest RingCX: disposition-filtered probes only match dispositioned leads.
        if (Array.isArray(payload.systemDispositions)) {
          const token = String(fields.systemDisposition || fields.lastPassDispo || "").toUpperCase();
          if (!payload.systemDispositions.includes(token)) return { leads: [] };
        }
        return { leads: [{ externId: "cxbl-q1", ...fields }] };
      },
    },
    outcomeAdapter: {
      async persistTerminalOutcome(input) { terminalWrites.push(input); return { written: true }; },
    },
    sysDispoClassifierEnabled: classifierOn,
    now: now || new Date("2026-07-07T12:00:00.000Z"),
  });
  return { terminalWrites, stashWrites, searchCalls, session: s1 };
}

test("QUEUE MECHANICS: a 429 read defers — no terminal write, a durable stash entry with the error and the 5s re-read clock", async () => {
  const { terminalWrites, stashWrites, session: s1 } = await runOneTick({
    current: candidate("q1", "cxbl-q1"),
    searchBehavior: "throw",
  });
  assert.equal(terminalWrites.length, 0, "the terminal write WAITS for the retry lane");
  assert.equal(stashWrites.length, 1, "one durable stash write before the tick ends");
  assert.equal(s1.sysDispoRetries.length, 1);
  const entry = s1.sysDispoRetries[0];
  assert.equal(entry.guardOutcome, "did_not_connect");
  assert.equal(entry.externId, "cxbl-q1");
  assert.equal(entry.attempts, 0);
  assert.equal(entry.sawClean, false, "an errored read is not a clean sighting");
  assert.equal(entry.lastReason, "error");
  assert.match(entry.lastError, /429/, "the RC error rides the entry for forensics");
  assert.equal(
    new Date(entry.nextAttemptAt).getTime() - new Date("2026-07-07T12:00:00.000Z").getTime(),
    5000,
    "first re-read waits one tick",
  );
});

test("QUEUE MECHANICS: a clean read of an UNSTAMPED lead also defers (his premise says we always see something — this wasn't something yet)", async () => {
  const { terminalWrites, session: s1 } = await runOneTick({
    current: candidate("q1", "cxbl-q1"),
    searchBehavior: {}, // lead found, zero disposition fields
  });
  assert.equal(terminalWrites.length, 0);
  assert.equal(s1.sysDispoRetries.length, 1);
  assert.equal(s1.sysDispoRetries[0].sawClean, true, "clean sighting remembered — exhaustion will apply the gamut, not the guard");
  assert.equal(s1.sysDispoRetries[0].lastReason, "clean");
});

test("QUEUE MECHANICS: flag OFF never defers — the read may fail, the legacy write lands immediately", async () => {
  const { terminalWrites, stashWrites } = await runOneTick({
    current: candidate("q1", "cxbl-q1"),
    searchBehavior: "throw",
    classifierOn: false,
  });
  assert.equal(terminalWrites.length, 1, "legacy byte-for-byte: immediate persist");
  assert.equal(terminalWrites[0].outcome, "did_not_connect");
  assert.equal(stashWrites.length, 0, "no queue machinery touched");
});

test("QUEUE MECHANICS: an entry that is not due yet just waits — no read, no write, no churn", async () => {
  const { terminalWrites, stashWrites, searchCalls } = await runOneTick({
    current: null, // nothing live — only the stash exists
    stash: [{
      queueItemId: "q9", uii: "u9", caseId: 9, domain: "TAG", name: "Lead q9",
      externId: "cxbl-q9", campaignId: 2306, guardOutcome: "answered",
      source: "active-call-release", sawClean: false, attempts: 0,
      enqueuedAt: "2026-07-07T12:00:00.000Z", nextAttemptAt: "2026-07-07T12:00:05.000Z",
      lastReason: "error", lastError: "429",
    }],
    searchBehavior: {},
    now: new Date("2026-07-07T12:00:02.000Z"), // 3s before the entry is due
  });
  assert.equal(searchCalls, 0, "not due = not read");
  assert.equal(terminalWrites.length, 0);
  assert.equal(stashWrites.length, 0, "unchanged stash is not rewritten");
});

test("QUEUE MECHANICS: flag flipped OFF mid-flight flushes pending entries with the guard verdict — no re-read, stash cleared", async () => {
  const { terminalWrites, searchCalls, session: s1 } = await runOneTick({
    current: null,
    stash: [{
      queueItemId: "q9", uii: "u9", caseId: 9, domain: "TAG", name: "Lead q9",
      externId: "cxbl-q9", campaignId: 2306, guardOutcome: "answered",
      source: "active-call-release", sawClean: false, attempts: 1,
      enqueuedAt: "2026-07-07T12:00:00.000Z", nextAttemptAt: "2026-07-07T12:00:05.000Z",
      lastReason: "error", lastError: "429",
    }],
    searchBehavior: {},
    classifierOn: false,
    now: new Date("2026-07-07T12:00:02.000Z"),
  });
  assert.equal(searchCalls, 0, "flag off = no reads");
  assert.equal(terminalWrites.length, 1, "the deferred outcome still lands — nothing is ever stranded");
  assert.equal(terminalWrites[0].outcome, "answered", "the guard verdict, exactly what legacy would have written");
  assert.equal(terminalWrites[0].systemDisposition ?? null, null);
  assert.equal(s1.sysDispoRetries ?? null, null, "stash cleared");
});

test("QUEUE MECHANICS: the serving-stamp-miss loop cannot pile up duplicates — one entry per (queueItemId, uii), ever", async () => {
  // The stamp-miss branch re-derives the same released call every ~1s tick; without the
  // dedupe the stash grew one entry per tick (adversarial find). Same key already pending
  // → no new write, no new entry, the original keeps its clock.
  const { terminalWrites, stashWrites, session: s1 } = await runOneTick({
    current: candidate("q1", "cxbl-q1"),
    stash: [{
      // the released observation inherits uii "u1" from prevActiveCalls — same key
      queueItemId: "q1", uii: "u1", caseId: 1, domain: "TAG", name: "Lead q1",
      externId: "cxbl-q1", campaignId: 2306, guardOutcome: "did_not_connect",
      source: "active-call-release", sawClean: false, attempts: 0,
      enqueuedAt: "2026-07-07T12:00:00.000Z", nextAttemptAt: "2026-07-07T12:00:05.000Z",
      lastReason: "error", lastError: "429",
    }],
    searchBehavior: "throw",
  });
  assert.equal(terminalWrites.length, 0, "still deferred");
  assert.equal(stashWrites.length, 0, "duplicate suppressed — no append write");
  assert.equal(s1.sysDispoRetries.length, 1, "one entry per call, not one per sighting");
});

test("QUEUE MECHANICS: a failed stash write fails CLOSED — the guard verdict persists immediately, the outcome is never lost", async () => {
  // Adversarial find: the durable enqueue write failing used to strand the outcome in a
  // discarded in-memory map. Now it falls back to exactly the pre-classifier write.
  const terminalWrites = [];
  const s1 = session("s1", "acct-a", candidate("q1", "cxbl-q1"));
  await runCxAccountActiveCallWatchOnce({
    sessionRepository: {
      async listActiveBulkLoadSessions() { return [s1]; },
      async updateBulkLoadSession(sessionId, patch) {
        if (patch.sysDispoRetries !== undefined) throw new Error("mongo down");
        Object.assign(s1, patch);
        return s1;
      },
    },
    client: {
      async listActiveCalls() { return []; },
      async searchLeads() { throw new Error("429 Too Many Requests"); },
    },
    outcomeAdapter: {
      async persistTerminalOutcome(input) { terminalWrites.push(input); return { written: true }; },
    },
    sysDispoClassifierEnabled: true,
    now: new Date("2026-07-07T12:00:00.000Z"),
  });
  assert.equal(terminalWrites.length, 1, "the outcome landed anyway");
  assert.equal(terminalWrites[0].outcome, "did_not_connect", "the guard verdict — byte-for-byte legacy");
  assert.equal(terminalWrites[0].systemDisposition ?? null, null);
});

test("ORPHAN FLUSH: a killed session's pending entries land — one last read, the label wins, the stash clears", async () => {
  // Adversarial find: entries on a dead session doc were stranded forever (the retry pass
  // only sees running sessions) and the still-claimed row re-dialed an answered lead.
  const terminalWrites = [];
  const stashWrites = [];
  const dead = {
    ...session("s-dead", "acct-a", null),
    status: "killed",
    sysDispoRetries: [{
      queueItemId: "q7", uii: "u7", caseId: 7, domain: "TAG", name: "Lead q7",
      externId: "cxbl-q7", campaignId: 2306, guardOutcome: "did_not_connect",
      source: "active-call-release", sawClean: false, attempts: 1,
      enqueuedAt: "2026-07-07T11:59:00.000Z", nextAttemptAt: "2026-07-07T11:59:20.000Z",
      lastReason: "error", lastError: "429",
    }],
  };
  await runCxAccountActiveCallWatchOnce({
    sessionRepository: {
      async listActiveBulkLoadSessions() { return []; },
      async listBulkLoadSessionsWithPendingSysDispoRetries() { return [dead]; },
      async updateBulkLoadSession(sessionId, patch) {
        if (patch.sysDispoRetries !== undefined) stashWrites.push(patch.sysDispoRetries);
        Object.assign(dead, patch);
        return dead;
      },
    },
    client: {
      async listActiveCalls() { return []; },
      async searchLeads() {
        return { leads: [{ externId: "cxbl-q7", lastPassDispo: "ANSWER", lastPassDisposition: "ANSWER : Auto Dispo" }] };
      },
    },
    outcomeAdapter: {
      async persistTerminalOutcome(input) { terminalWrites.push(input); return { written: true }; },
    },
    sysDispoClassifierEnabled: true,
    sysDispoOrphanSweepMinIntervalMs: 0,
    now: new Date("2026-07-07T12:05:00.000Z"),
  });
  assert.equal(terminalWrites.length, 1, "the dead session's outcome still landed");
  assert.equal(terminalWrites[0].outcome, "answered", "the last read found ANSWER — upgraded, card material");
  assert.equal(terminalWrites[0].systemDisposition, "ANSWER");
  assert.equal(terminalWrites[0].now, "2026-07-07T11:59:00.000Z", "at = the release time, not the flush time");
  assert.deepEqual(stashWrites, [null], "the stash cleared");
});
