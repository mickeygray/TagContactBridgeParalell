"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  EMPTY_COACH_STATE,
  normalizeCoachState,
  applyGuideDelta,
  selectMode,
  selectFeedback,
  isReactionLive,
  isFeedbackLive,
  hasBlockingFeedback,
  steerBackNeeded,
} = require("../../packages/shared-services/src/coachState");

const liveReaction = (over = {}) => ({ id: "r1", read: "fee resistance", steer: "anchor full", try: "most clients pay at once", at: 1000, ttlMs: 20000, ...over });
const item = (over = {}) => ({ id: "f1", kind: "nudge", severity: "info", read: "r", steer: "s", try: "t", at: 1000, ttlMs: 20000, priority: 0, ...over });

// ── shape + merge ───────────────────────────────────────────────────────────

test("normalizeCoachState fills defaults for a partial object", () => {
  const s = normalizeCoachState({ rev: 3, mode: "reaction" });
  assert.equal(s.rev, 3);
  assert.equal(s.mode, "reaction");
  assert.deepEqual(s.compliance, { flags: [] });
  assert.deepEqual(s.feedback, []); // the channel defaults to empty
  assert.equal(s.phase.current, "intro");
  assert.deepEqual(s.phase.steps, []); // passive checklist defaults to empty
});

test("applyGuideDelta merges only the provided slices and bumps rev", () => {
  const base = { ...EMPTY_COACH_STATE, rev: 1 };
  const next = applyGuideDelta(base, { rev: 2, phase: { current: "payment", order: 4, advanceGoal: "", since: 9 } });
  assert.equal(next.phase.current, "payment");
  assert.equal(next.rev, 2);
  assert.equal(next.mode, "quiet"); // untouched slice unchanged
});

test("applyGuideDelta IGNORES a stale (non-newer rev) delta", () => {
  const base = { ...EMPTY_COACH_STATE, rev: 5, phase: { current: "payment", order: 4, advanceGoal: "", since: 0 } };
  const next = applyGuideDelta(base, { rev: 4, phase: { current: "intro", order: 0, advanceGoal: "", since: 0 } });
  assert.equal(next.phase.current, "payment"); // stale delta did not clobber
  assert.equal(next.rev, 5);
});

test("applyGuideDelta wholesale-replaces the feedback channel under the rev gate", () => {
  const base = applyGuideDelta(EMPTY_COACH_STATE, { rev: 1, feedback: [item()] });
  assert.equal(base.feedback.length, 1);
  // a newer delta replaces the whole array
  const replaced = applyGuideDelta(base, { rev: 2, feedback: [item({ id: "f2", kind: "objection" })] });
  assert.equal(replaced.feedback[0].id, "f2");
  // a STALE-rev feedback delta is ignored
  const stale = applyGuideDelta(replaced, { rev: 1, feedback: [] });
  assert.equal(stale.feedback[0].id, "f2");
});

test("emitting feedback:[] is the single-key clear for the channel -> mode quiet", () => {
  const live = applyGuideDelta(EMPTY_COACH_STATE, { rev: 1, feedback: [item()] });
  assert.equal(selectMode(live, { now: 1500 }), "reaction");
  const cleared = applyGuideDelta(live, { rev: 2, feedback: [] });
  assert.equal(cleared.feedback.length, 0);
  assert.equal(selectMode(cleared, { now: 1500 }), "quiet"); // no fallback resurrection
});

test("applyGuideDelta treats reaction:null as an explicit clear (legacy slice still merges)", () => {
  const base = applyGuideDelta(EMPTY_COACH_STATE, { rev: 1, reaction: liveReaction() });
  assert.ok(base.reaction);
  const cleared = applyGuideDelta(base, { rev: 2, reaction: null });
  assert.equal(cleared.reaction, null);
});

// ── liveness ────────────────────────────────────────────────────────────────

test("isReactionLive respects the TTL window", () => {
  const r = liveReaction({ at: 1000, ttlMs: 20000 });
  assert.equal(isReactionLive(r, 15000), true); // within window
  assert.equal(isReactionLive(r, 25000), false); // expired
  assert.equal(isReactionLive(null, 15000), false);
});

test("isFeedbackLive mirrors the reaction TTL rule", () => {
  assert.equal(isFeedbackLive(item({ at: 1000, ttlMs: 20000 }), 15000), true);
  assert.equal(isFeedbackLive(item({ at: 1000, ttlMs: 2000 }), 15000), false);
});

// ── selection: post_call + compliance pre-emption ─────────────────────────────

test("selectMode: post_call wins when a grade is present", () => {
  assert.equal(selectMode({ grade: { overallScore: 3 }, feedback: [item()] }, { now: 1000 }), "post_call");
});

test("selectMode: a blocking compliance FLAG pre-empts a live feedback item", () => {
  const s = { feedback: [item()], compliance: { flags: [{ severity: "block", message: "no settlement promises" }] } };
  assert.equal(selectMode(s, { now: 1000 }), "compliance");
});

test("selectMode: a block-severity feedback item beats a fresher nudge EVEN WHEN EXPIRED (severity outranks liveness)", () => {
  // The fix-1 regression: an expired/finite-TTL compliance item must NOT be starved
  // by a fresher info nudge. Compliance is severity-only, pre-liveness.
  const s = {
    feedback: [
      item({ id: "c1", kind: "compliance", severity: "block", at: 1000, ttlMs: 5000 }), // expired by now=9000
      item({ id: "n1", kind: "nudge", severity: "info", at: 9000, ttlMs: 20000 }), // fresh
    ],
  };
  assert.equal(hasBlockingFeedback(s.feedback), true);
  assert.equal(selectMode(s, { now: 9000 }), "compliance");
  assert.equal(selectFeedback(s, { now: 9000 }).id, "c1"); // the blocking item is the one to render
});

// ── selection: the channel maps to render modes ───────────────────────────────

test("selectMode: a live nudge/objection item maps to mode 'reaction'", () => {
  assert.equal(selectMode({ feedback: [item({ kind: "objection" })] }, { now: 1500 }), "reaction");
});

test("selectMode: an opportunity item maps to mode 'play'", () => {
  assert.equal(selectMode({ feedback: [item({ kind: "opportunity" })] }, { now: 1500 }), "play");
});

test("selectMode: a steer_back item maps to mode 'steer_back'", () => {
  assert.equal(selectMode({ feedback: [item({ kind: "steer_back" })] }, { now: 1500 }), "steer_back");
});

test("selectFeedback: ranks the loudest live item (severity beats recency)", () => {
  const s = {
    feedback: [
      item({ id: "info", kind: "nudge", severity: "info", at: 9000 }), // fresher
      item({ id: "warn", kind: "objection", severity: "warn", at: 1000 }), // louder
    ],
  };
  assert.equal(selectFeedback(s, { now: 9500 }).id, "warn");
});

// ── determinism: the tie-break chain resolves every tie (fix 5) ───────────────

test("selectFeedback: priority breaks a same-severity/same-kind/same-time tie", () => {
  const s = {
    feedback: [
      item({ id: "low", kind: "objection", severity: "warn", at: 1000, priority: 1 }),
      item({ id: "high", kind: "objection", severity: "warn", at: 1000, priority: 9 }),
    ],
  };
  assert.equal(selectFeedback(s, { now: 1500 }).id, "high");
});

test("selectFeedback: id is the stable terminal tie-break (deterministic, not arbitrary)", () => {
  const a = { feedback: [item({ id: "bbb", priority: 0 }), item({ id: "aaa", priority: 0 })] };
  const b = { feedback: [item({ id: "aaa", priority: 0 }), item({ id: "bbb", priority: 0 })] };
  // same inputs in either array order resolve to the same winner
  assert.equal(selectFeedback(a, { now: 1500 }).id, "aaa");
  assert.equal(selectFeedback(b, { now: 1500 }).id, "aaa");
});

// ── the passive list drives nothing (fix 4) ───────────────────────────────────

test("the discovery list ALONE cannot raise a mode — a missing CORE beat past pitch with an empty channel is quiet", () => {
  const s = { phase: { current: "pitch", order: 3 }, discovery: { missing: ["balance"] }, feedback: [] };
  assert.equal(selectMode(s, { now: 1000 }), "quiet"); // NOT steer_back — the list is passive
});

test("steerBackNeeded stays exported as the orchestrator's trigger (gated at pitch)", () => {
  assert.equal(steerBackNeeded({ phase: { current: "discovery" }, discovery: { missing: ["balance"] } }), false);
  assert.equal(steerBackNeeded({ phase: { current: "pitch" }, discovery: { missing: ["balance"] } }), true);
});

test("selectMode: quiet is the default with no signals", () => {
  assert.equal(selectMode(EMPTY_COACH_STATE, { now: 1000 }), "quiet");
});
