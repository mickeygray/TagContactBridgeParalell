"use strict";

// RESYNC pins (2026-07-06 ghost-lead incident): a buffered candidate whose queue row
// drifted (cancelled out-of-band / reaped to ready / foreign reservation) wedges the
// session — the serving CAS refuses it forever and nothing signals. The resync audit
// mirrors the CAS precondition, prunes the session's buffer view (never queue rows),
// and stamps a resync annotation. Triggers: serving-stamp miss (drift proven) and the
// idle-drift sweep (drift rotting quietly, post ghost-guard fix).

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  deriveBufferInvalidations,
  runCxAccountActiveCallWatchOnce,
} = require("../../packages/shared-services/src/cxAccountActiveCallWatcherService");
const { reduceCxBulkLoadState } = require("../../packages/shared-services/src/cxBulkLoadStateMachine");

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

function row(queueItemId, state, reservationSessionId) {
  return {
    _id: queueItemId,
    state,
    metadata: { reservationSessionId },
  };
}

test("deriveBufferInvalidations mirrors the serving CAS: cancelled/reaped/foreign/missing pruned, claimed+owned kept", () => {
  const session = {
    sessionId: "cxbl-resync-1",
    acceptedBuffer: [
      candidate("qi-healthy", "e-healthy"),
      candidate("qi-cancelled", "e-cancelled"),   // the Codex one-off shape
      candidate("qi-reaped", "e-reaped"),         // the long-call-hold-reaper shape
      candidate("qi-foreign", "e-foreign"),
      candidate("qi-gone", "e-gone"),
    ],
  };
  const invalid = deriveBufferInvalidations(session, [
    row("qi-healthy", "claimed", "cxbl-resync-1"),
    row("qi-cancelled", "cancelled", "cxbl-resync-1"),
    row("qi-reaped", "ready", "cxbl-resync-1"),
    row("qi-foreign", "claimed", "cxbl-SOMEONE-ELSE"),
    // qi-gone: no row at all
  ]);
  const byId = Object.fromEntries(invalid.map((entry) => [entry.queueItemId, entry.why]));
  assert.equal(invalid.length, 4);
  assert.equal(byId["qi-cancelled"], "row-cancelled");
  assert.equal(byId["qi-reaped"], "row-state-unadoptable");
  assert.equal(byId["qi-foreign"], "reservation-foreign");
  assert.equal(byId["qi-gone"], "row-missing");
  assert.equal(byId["qi-healthy"], undefined, "a claimed row owned by this session must never be flagged");
});

test("reducer buffer.invalidated prunes the buffer, stamps resync, and records NO outcome", () => {
  const state = {
    sessionId: "cxbl-resync-2",
    status: "running",
    acceptedBuffer: [candidate("qi-a", "e-a"), candidate("qi-b", "e-b")],
    completed: [],
    current: null,
  };
  const next = reduceCxBulkLoadState(state, {
    type: "buffer.invalidated",
    reason: "serving-stamp-miss",
    removed: [{ queueItemId: "qi-a", rowState: "cancelled", why: "row-cancelled" }],
  }, new Date("2026-07-06T16:00:00.000Z"));
  assert.deepEqual(next.acceptedBuffer.map((c) => c.queueItemId), ["qi-b"]);
  assert.equal(next.completed.length, 0, "pruning must not invent an outcome for a lead never worked");
  assert.equal(next.current, null);
  assert.equal(next.resync.reason, "serving-stamp-miss");
  assert.equal(next.resync.removed[0].queueItemId, "qi-a");
  assert.equal(next.resync.removed[0].why, "row-cancelled");
});

function makeResyncHarness({ sessionId, activeCalls, rowsById, servingResult, rescueResult = null, current = null }) {
  const sessionDoc = {
    sessionId,
    __v: 7,
    status: "running",
    phase: current ? "active" : "ready",
    agentEmail: `${sessionId}@example.test`,
    agentExtensionId: sessionId,
    domain: "TAG",
    ringcx: { accountId: "acct-1" },
    current,
    acceptedBuffer: [candidate("qi-dead", `cxbl-${sessionId}-qi-dead`)],
    completed: [],
    stats: {},
    trace: {},
  };
  const updates = [];
  const sessionRepository = {
    async listActiveBulkLoadSessions() { return [sessionDoc]; },
    async updateBulkLoadSession(id, patch, options) {
      updates.push({ id, patch, options });
      return { ...patch, sessionId: id };
    },
  };
  const client = { async listActiveCalls() { return activeCalls; } };
  const rcxCancels = [];
  const rescues = [];
  const hangups = [];
  const queueStateAdapter = {
    async markCandidateServing() { return servingResult; },
    async rescueCandidateServing({ candidate }) {
      rescues.push(candidate.queueItemId);
      return rescueResult;
    },
    async hangupGhostCall({ uii }) {
      hangups.push(uii);
      return { ok: true, executed: true };
    },
    async loadCandidateRows(ids) { return ids.map((id) => rowsById[id]).filter(Boolean); },
    async cancelPrunedCandidateCopies({ removed }) {
      rcxCancels.push(...removed.map((r) => r.queueItemId));
      return removed.map((r) => ({ queueItemId: r.queueItemId, cancelled: true, ok: true }));
    },
  };
  return { sessionRepository, client, queueStateAdapter, updates, rcxCancels, rescues, hangups, sessionDoc };
}

test("RINGING ghost: the miss is recorded but the prune is DEFERRED — the rescue window stays open", async () => {
  // Mickey's catch (2026-07-06): every ghost rings before it connects. Pruning mid-ring
  // would sweep the candidate before the callee answers and the rescue could never fire.
  const sessionId = "cxbl-resync-A";
  const harness = makeResyncHarness({
    sessionId,
    activeCalls: [{ externId: `cxbl-${sessionId}-qi-dead`, uii: "u-ghost", callState: "OUTDIAL" }],
    rowsById: { "qi-dead": row("qi-dead", "cancelled", sessionId) },
    servingResult: null, // the CAS refuses — exactly the incident
  });
  const result = await runCxAccountActiveCallWatchOnce({
    sessionRepository: harness.sessionRepository,
    client: harness.client,
    queueStateAdapter: harness.queueStateAdapter,
    now: new Date("2026-07-06T16:10:00.000Z"),
  });
  assert.ok(
    result.applied.skipped.some((s) => s.reason === "serving-ownership-stamp-miss"),
    "the adoption itself must still be refused",
  );
  assert.equal(harness.updates.filter((u) => u.patch.resync).length, 0, "NO prune while the ghost is ringing");
  assert.deepEqual(harness.rescues, [], "a RINGING ghost is never rescued — only a connected one");
  assert.deepEqual(harness.hangups, [], "a RINGING ghost is never hung up — hangup is a no-op on ringing anyway");
  assert.deepEqual(harness.rcxCancels, [], "no RC cancel mid-ring — the sweep handles a never-connect later");
});

test("GHOST POLICY: a CONNECTED ghost that passes the rescue gate gets SYNCED — adopted as current, no prune, no hangup", async () => {
  const sessionId = "cxbl-resync-rescue";
  const harness = makeResyncHarness({
    sessionId,
    activeCalls: [{ externId: `cxbl-${sessionId}-qi-dead`, uii: "u-ghost", callState: "ACTIVE" }],
    rowsById: { "qi-dead": row("qi-dead", "cancelled", sessionId) },
    servingResult: null,                       // normal CAS refuses (the row is dead)
    rescueResult: { adopted: { ok: true } },   // the compliance-gated rescue re-claims it
  });
  const result = await runCxAccountActiveCallWatchOnce({
    sessionRepository: harness.sessionRepository,
    client: harness.client,
    queueStateAdapter: harness.queueStateAdapter,
    now: new Date("2026-07-06T17:00:00.000Z"),
  });
  assert.deepEqual(harness.rescues, ["qi-dead"], "the connected ghost must attempt rescue");
  assert.deepEqual(harness.hangups, [], "a rescued call is never hung up");
  assert.equal(harness.updates.filter((u) => u.patch.resync).length, 0, "no prune — the candidate came back to life");
  assert.ok(
    result.applied.skipped.every((s) => s.reason !== "serving-ownership-stamp-miss"),
    "a rescued adoption is not a miss",
  );
  const sessionWrite = harness.updates.find((u) => u.patch.current);
  assert.ok(sessionWrite, "the session write must proceed — the ghost becomes current");
  assert.equal(sessionWrite.patch.current.queueItemId, "qi-dead");
});

test("GHOST POLICY: a CONNECTED ghost the rescue REFUSES gets hung up, then pruned — agent freed without touching CX", async () => {
  const sessionId = "cxbl-resync-hangup";
  const harness = makeResyncHarness({
    sessionId,
    activeCalls: [{ externId: `cxbl-${sessionId}-qi-dead`, uii: "u-ghost", callState: "ACTIVE" }],
    rowsById: { "qi-dead": row("qi-dead", "cancelled", sessionId) },
    servingResult: null,
    rescueResult: { refused: "contact-blocked", definitive: true }, // compliance says no, PROVABLY
  });
  const result = await runCxAccountActiveCallWatchOnce({
    sessionRepository: harness.sessionRepository,
    client: harness.client,
    queueStateAdapter: harness.queueStateAdapter,
    now: new Date("2026-07-06T17:10:00.000Z"),
  });
  assert.deepEqual(harness.rescues, ["qi-dead"], "the rescue must be attempted first");
  assert.deepEqual(harness.hangups, ["u-ghost"], "the refused connected ghost must be hung up by the system");
  assert.ok(result.applied.skipped.some((s) => s.reason === "serving-ownership-stamp-miss"));
  const resyncWrite = harness.updates.find((u) => u.patch.resync);
  assert.ok(resyncWrite, "a CONNECTED-refused ghost prunes immediately (post-hangup)");
  assert.deepEqual(resyncWrite.patch.acceptedBuffer, []);
  assert.equal(resyncWrite.patch.resync.removed[0].why, "row-cancelled");
  assert.equal(resyncWrite.options.expectedVersion, 7, "the resync write must be version-guarded");
  assert.deepEqual(harness.rcxCancels, ["qi-dead"], "the pruner must tell RingCX to stop the pruned lead");
});

test("SWITCH GUARD: a ghost promotion that would complete a LIVE current is never rescued — the flicker clobber stays dead", async () => {
  // Adversarial blocker #1 (2026-07-06): live connected current C1 flickers out of one
  // snapshot while a connected ghost G matches — the switch would force-complete C1 as
  // "answered" MID-CONVERSATION and install the ghost. The rescue must refuse any
  // promotion with completePrevious, restoring the pre-rescue harmless miss (no write).
  const sessionId = "cxbl-resync-switch";
  const harness = makeResyncHarness({
    sessionId,
    current: {
      queueItemId: "qi-live",
      caseId: 999,
      domain: "TAG",
      name: "Live Human",
      uii: "u-live-conversation",
      externId: `cxbl-${sessionId}-qi-live`,
      ringcx: { externId: `cxbl-${sessionId}-qi-live` },
      connectedAt: "2026-07-06T17:29:00.000Z",
    },
    // C1's call is MISSING from this snapshot (the flicker); only the ghost shows.
    activeCalls: [{ externId: `cxbl-${sessionId}-qi-dead`, uii: "u-ghost", callState: "ACTIVE" }],
    rowsById: { "qi-dead": row("qi-dead", "cancelled", sessionId) },
    servingResult: null,
    rescueResult: { adopted: { ok: true } }, // would succeed if ever asked — it must not be asked
  });
  const result = await runCxAccountActiveCallWatchOnce({
    sessionRepository: harness.sessionRepository,
    client: harness.client,
    queueStateAdapter: harness.queueStateAdapter,
    now: new Date("2026-07-06T17:30:00.000Z"),
  });
  assert.deepEqual(harness.rescues, [], "a completePrevious promotion must never attempt rescue");
  assert.deepEqual(harness.hangups, [], "and never hang up");
  assert.equal(harness.updates.length, 0, "NO session write — the flicker tick stays harmless, C1 survives");
  assert.ok(result.applied.skipped.some((s) => s.reason === "serving-ownership-stamp-miss"));
});

test("RETRY GUARD: a non-definitive refusal on a CANCELLED row does NOT prune — the retry it promises stays possible", async () => {
  // Adversarial blocker #2 (2026-07-06): the audit calls every rescuable row (ready/
  // cancelled) "unadoptable", so pruning on a transient refusal would delete the exact
  // candidate the next-tick retry needs — stranding the answered human forever.
  const sessionId = "cxbl-resync-retry";
  const harness = makeResyncHarness({
    sessionId,
    activeCalls: [{ externId: `cxbl-${sessionId}-qi-dead`, uii: "u-ghost", callState: "ACTIVE" }],
    rowsById: { "qi-dead": row("qi-dead", "cancelled", sessionId) },
    servingResult: null,
    rescueResult: { refused: "eligibility-unavailable", definitive: false }, // transient blip
  });
  await runCxAccountActiveCallWatchOnce({
    sessionRepository: harness.sessionRepository,
    client: harness.client,
    queueStateAdapter: harness.queueStateAdapter,
    now: new Date("2026-07-06T17:40:00.000Z"),
  });
  assert.deepEqual(harness.rescues, ["qi-dead"], "the rescue was attempted");
  assert.deepEqual(harness.hangups, [], "no hangup on a transient refusal");
  assert.equal(harness.updates.filter((u) => u.patch.resync).length, 0, "and NO prune — the candidate survives for the retry");
});

test("FLICKER GUARD: a non-definitive refusal (healthy-row race / read blip) hangs up NOTHING and just retries", async () => {
  // Mickey's question (2026-07-06): "no way for the rescue to fire unnecessarily for a
  // flicker effect?" The dangerous shape: a HEALTHY row's serving stamp misses for one
  // tick (Mongo blip) while the agent is mid-conversation. The rescue refuses with a
  // non-definitive reason — the hangup must NOT fire, or a database hiccup kills a live
  // good call. The next tick retries the normal stamp.
  const sessionId = "cxbl-resync-flicker";
  const harness = makeResyncHarness({
    sessionId,
    activeCalls: [{ externId: `cxbl-${sessionId}-qi-dead`, uii: "u-live-good-call", callState: "ACTIVE" }],
    rowsById: { "qi-dead": row("qi-dead", "claimed", sessionId) }, // HEALTHY row — the miss was a race
    servingResult: null, // transient CAS miss
    rescueResult: { refused: "state-claimed", definitive: false },
  });
  const result = await runCxAccountActiveCallWatchOnce({
    sessionRepository: harness.sessionRepository,
    client: harness.client,
    queueStateAdapter: harness.queueStateAdapter,
    now: new Date("2026-07-06T17:20:00.000Z"),
  });
  assert.deepEqual(harness.hangups, [], "NEVER hang up on a non-definitive refusal");
  assert.equal(harness.updates.filter((u) => u.patch.resync).length, 0, "the audit finds the healthy row valid — nothing pruned");
  assert.ok(
    result.applied.skipped.some((s) => s.reason === "serving-ownership-stamp-miss"),
    "the miss is recorded and the next tick retries",
  );
});

test("the RingCX cancel is fail-soft: a canceller crash never undoes the prune", async () => {
  const sessionId = "cxbl-resync-cancelfail";
  const harness = makeResyncHarness({
    sessionId,
    // connected + DEFINITIVELY refused ghost — the only shape that prunes immediately
    activeCalls: [{ externId: `cxbl-${sessionId}-qi-dead`, uii: "u-ghost", callState: "ACTIVE" }],
    rowsById: { "qi-dead": row("qi-dead", "cancelled", sessionId) },
    servingResult: null,
    rescueResult: { refused: "contact-blocked", definitive: true },
  });
  harness.queueStateAdapter.cancelPrunedCandidateCopies = async () => {
    throw new Error("ringcx-down");
  };
  await runCxAccountActiveCallWatchOnce({
    sessionRepository: harness.sessionRepository,
    client: harness.client,
    queueStateAdapter: harness.queueStateAdapter,
    now: new Date("2026-07-06T16:50:00.000Z"),
  });
  const resyncWrite = harness.updates.find((u) => u.patch.resync);
  assert.ok(resyncWrite, "the prune must land even when the RingCX cancel crashes");
  assert.deepEqual(resyncWrite.patch.acceptedBuffer, []);
});

test("Trigger B: an idle session holding a reaped (ready) batch gets swept without any call activity", async () => {
  const sessionId = "cxbl-resync-B";
  const harness = makeResyncHarness({
    sessionId,
    activeCalls: [], // nothing dialing — the quiet-drift shape
    rowsById: { "qi-dead": row("qi-dead", "ready", sessionId) },
    servingResult: { ok: true }, // never reached
  });
  const result = await runCxAccountActiveCallWatchOnce({
    sessionRepository: harness.sessionRepository,
    client: harness.client,
    queueStateAdapter: harness.queueStateAdapter,
    now: new Date("2026-07-06T16:20:00.000Z"),
  });
  assert.equal(result.applied.writeCount, 0, "no projection write — the session looked idle");
  const resyncWrite = harness.updates.find((u) => u.patch.resync);
  assert.ok(resyncWrite, "the idle sweep must find the dead buffer");
  assert.deepEqual(resyncWrite.patch.acceptedBuffer, []);
  assert.equal(resyncWrite.patch.resync.removed[0].why, "row-state-unadoptable");
  assert.equal(resyncWrite.patch.resync.reason, "idle-drift-sweep");
});

test("a failed row read prunes NOTHING — a Mongo blip must never look like a deleted row", async () => {
  // Adversarial-verify blocker (2026-07-06): loadCandidateRows used to swallow per-id
  // errors, so a transient read failure produced a partial array and healthy leads got
  // pruned as row-missing. The contract: any read failure rejects the whole batch and
  // the trigger does nothing. Exercised via the idle sweep (the read-then-prune path).
  const sessionId = "cxbl-resync-readfail";
  const harness = makeResyncHarness({
    sessionId,
    activeCalls: [], // idle-drift shape — the sweep is what reads rows here
    rowsById: {},
    servingResult: null,
  });
  harness.queueStateAdapter.loadCandidateRows = async () => {
    throw new Error("mongo-transient-timeout");
  };
  await runCxAccountActiveCallWatchOnce({
    sessionRepository: harness.sessionRepository,
    client: harness.client,
    queueStateAdapter: harness.queueStateAdapter,
    now: new Date("2026-07-06T16:40:00.000Z"),
  });
  assert.equal(harness.updates.filter((u) => u.patch.resync).length, 0, "no prune on a failed read");
});

test("kill switch: resyncEnabled=false disables rescue, hangup, and prune even on a connected ghost", async () => {
  const sessionId = "cxbl-resync-off";
  const harness = makeResyncHarness({
    sessionId,
    activeCalls: [{ externId: `cxbl-${sessionId}-qi-dead`, uii: "u-ghost", callState: "ACTIVE" }],
    rowsById: { "qi-dead": row("qi-dead", "cancelled", sessionId) },
    servingResult: null,
    rescueResult: { ok: true },
  });
  await runCxAccountActiveCallWatchOnce({
    sessionRepository: harness.sessionRepository,
    client: harness.client,
    queueStateAdapter: harness.queueStateAdapter,
    resyncEnabled: false,
    now: new Date("2026-07-06T16:30:00.000Z"),
  });
  assert.equal(harness.updates.filter((u) => u.patch.resync).length, 0, "no prune");
  assert.deepEqual(harness.rescues, [], "no rescue");
  assert.deepEqual(harness.hangups, [], "no hangup");
});

test("WRAP JANITOR: unresolved wraps default to a 30-minute auto-resolve; explicit 0 restores hold-forever", () => {
  const { resolveWrapTimeoutMs } = require("../../packages/shared-services/src/cxAccountActiveCallWatcherService");
  const prior = process.env.CX_BULK_WRAP_TIMEOUT_MS;
  try {
    delete process.env.CX_BULK_WRAP_TIMEOUT_MS;
    assert.equal(resolveWrapTimeoutMs({}), 30 * 60 * 1000, "the auto-opt-out default (Mickey's ruling 2026-07-06)");
    assert.equal(resolveWrapTimeoutMs({ wrapTimeoutMs: 5000 }), 5000, "per-call option wins");
    assert.equal(resolveWrapTimeoutMs({ wrapTimeoutMs: 0 }), 0, "explicit option 0 = hold forever");
    process.env.CX_BULK_WRAP_TIMEOUT_MS = "120000";
    assert.equal(resolveWrapTimeoutMs({}), 120000, "env override");
    process.env.CX_BULK_WRAP_TIMEOUT_MS = "0";
    assert.equal(resolveWrapTimeoutMs({}), 0, "env 0 = hold forever, the pre-ruling behavior");
  } finally {
    if (prior == null) delete process.env.CX_BULK_WRAP_TIMEOUT_MS;
    else process.env.CX_BULK_WRAP_TIMEOUT_MS = prior;
  }
});

test("SYS-DISPO CLASSIFIER: when RingCX was READ its verdict is total — ANSWER vs the gamut; only a FAILED read keeps the guard", () => {
  const { applySysDispoClassifier } = require("../../packages/shared-services/src/cxAccountActiveCallWatcherService");
  const on = { enabled: true };
  // downgrade: the guard approved a long screener/VM; RingCX says MACHINE
  assert.equal(applySysDispoClassifier("answered", "MACHINE", on), "did_not_connect");
  assert.equal(applySysDispoClassifier("answered", "NOANSWER", on), "did_not_connect");
  // upgrade: the guard downgraded a short real conversation; RingCX says it was answered.
  // ANSWER is the ONLY wrap-up token in the official closed vocabulary (2026-07-07).
  assert.equal(applySysDispoClassifier("did_not_connect", "ANSWER", on), "answered");
  assert.equal(applySysDispoClassifier("did_not_connect", "APP_DNC", on), "did_not_connect");
  assert.equal(applySysDispoClassifier("answered", "DISCONNECT", on), "did_not_connect");
  assert.equal(applySysDispoClassifier("answered", "INBOUND_CALLBACK", on), "did_not_connect");
  // agreement
  assert.equal(applySysDispoClassifier("answered", "ANSWER", on), "answered");
  assert.equal(applySysDispoClassifier("did_not_connect", "CONGESTION", on), "did_not_connect");
  // Mickey's gamut rule (tightened 2026-07-07: "we should have no no-label — we will see
  // something every time"): a CLEAN read with no label IS the no-answer verdict, and
  // unknown vocabulary is still not-ANSWER. There is no third routing outcome.
  assert.equal(applySysDispoClassifier("answered", null, on), "did_not_connect");
  assert.equal(applySysDispoClassifier("did_not_connect", null, on), "did_not_connect");
  assert.equal(applySysDispoClassifier("answered", "SOME_NEW_TOKEN", on), "did_not_connect");
  assert.equal(applySysDispoClassifier("did_not_connect", "SOME_NEW_TOKEN", on), "did_not_connect");
  // THE ONE SURVIVOR of the old fallback: read=false = API error/timeout = OUR blindness,
  // not RingCX silence. The guard verdict stands, so an RC blip can never mass-downgrade
  // real conversations (and can never upgrade on a label we didn't actually read).
  assert.equal(applySysDispoClassifier("answered", null, { enabled: true, read: false }), "answered");
  assert.equal(applySysDispoClassifier("did_not_connect", null, { enabled: true, read: false }), "did_not_connect");
  assert.equal(applySysDispoClassifier("did_not_connect", "ANSWER", { enabled: true, read: false }), "did_not_connect");
  // flag off (today's default): byte-for-byte the guard's verdict
  assert.equal(applySysDispoClassifier("answered", "MACHINE", { enabled: false }), "answered");
  assert.equal(applySysDispoClassifier("answered", null, { enabled: false }), "answered");
  assert.equal(applySysDispoClassifier("did_not_connect", "ANSWER", {}), "did_not_connect");
  // voicemail/other outcomes are never touched
  assert.equal(applySysDispoClassifier("voicemail", "ANSWER", on), "voicemail");
  assert.equal(applySysDispoClassifier("voicemail", null, on), "voicemail");
});

test("THE CLOSED VOCABULARY: all 15 official RingCX system dispositions classify — ANSWER alone routes to wrap-up", () => {
  const { applySysDispoClassifier } = require("../../packages/shared-services/src/cxAccountActiveCallWatcherService");
  const OFFICIAL = [
    "ANSWER", "NOANSWER", "BUSY", "MACHINE", "INTERCEPT", "DISCONNECT", "ABANDON",
    "CONGESTION", "MANUAL_PASS", "INBOUND_CALLBACK", "APP_DNC", "APP_REQUEUE",
    "APP_REQUEUE_COMPLETE", "APP_REQUEUE_ABANDON", "INBOUND_ABANDON",
  ];
  for (const token of OFFICIAL) {
    const fromAnswered = applySysDispoClassifier("answered", token, { enabled: true });
    const fromNoAnswer = applySysDispoClassifier("did_not_connect", token, { enabled: true });
    if (token === "ANSWER") {
      assert.equal(fromAnswered, "answered", `${token} from answered`);
      assert.equal(fromNoAnswer, "answered", `${token} upgrades`);
    } else {
      assert.equal(fromAnswered, "did_not_connect", `${token} downgrades`);
      assert.equal(fromNoAnswer, "did_not_connect", `${token} stays no-answer`);
    }
  }
});
