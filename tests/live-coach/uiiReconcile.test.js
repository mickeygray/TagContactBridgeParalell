"use strict";

// STREAM 4 self-healing coverage for the gRPC live-coach bridge:
//   1) MISS->ADOPT  -- a 'not_current' bind result whose event carries the
//      agent's real current uii is adopted (non-terminal, retry rebinds).
//   2) DRIFT->REBIND -- a bound session whose agent rolled to a new uii is
//      torn down and rebound, but only after the SAME new uii is confirmed on
//      2 consecutive reconcile ticks (debounce).
//   3) DISABLED is a no-op -- nothing happens (and no network) unless
//      LIVE_COACH_UII_RECONCILE_ENABLED is set.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const bridge = require("../../scripts/ringcx-grpc-live-coach-bridge.js");
const {
  createSegmentState,
  ensureCoachSession,
  reconcileCoachUii,
} = bridge;

function makeTempLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uii-reconcile-"));
  return { outDir: dir, eventLog: path.join(dir, "events.ndjson") };
}

function readEvents(eventLog) {
  if (!fs.existsSync(eventLog)) return [];
  return fs
    .readFileSync(eventLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function eventsOfType(eventLog, type) {
  return readEvents(eventLog).filter((event) => event.type === type);
}

// Minimal prospect segment. createSegmentState reads the reconcile env flags at
// construction, so callers set process.env before invoking.
function makeProspectSegment(overrides = {}) {
  const { outDir, eventLog } = makeTempLog();
  const segment = createSegmentState({
    streamId: "stream-test",
    sessionId: "STREAM-test-session",
    segmentId: "seg-1",
    decoded: { participant: { type: "CONTACT", id: "3105551000" } },
    outDir,
    aiBusUrl: "http://ai-bus.local",
    chunkSec: 4,
    provisionalPreviewMs: 0,
    provisionalPreviewChunks: 4,
    sttProvider: "openai", // not realtime -> no STT socket scheduled
    sttModel: "gpt-4o-transcribe",
    sttModelMap: new Map(),
    openAiApiKey: "test-key",
    turnDetection: "semantic_vad",
    semanticEagerness: "high",
    noiseReduction: "near_field",
    realtimeProvisionalEnabled: false,
    allowUnboundCoachSessions: false,
    language: "en",
    eventLog,
    dialogIdentity: {
      agentExtensionId: "4545",
      agentEmail: "agent@example.com",
      ...(overrides.dialogIdentity || {}),
    },
  });
  segment.eventLog = eventLog;
  segment.__eventLog = eventLog;
  return segment;
}

// Route stubbed fetch responses by URL substring. handler => returns body obj.
function withFetch(routes, fn) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push({ url: String(url), body });
    const matched = routes.find((route) => String(url).includes(route.match));
    const payload = matched ? matched.respond(body, calls.length) : {};
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload || {}),
    };
  };
  return Promise.resolve(fn(calls)).finally(() => {
    global.fetch = original;
  });
}

test("MISS->ADOPT (opt-in): not_current bind adopts the agent's current uii and stays non-terminal", async () => {
  delete process.env.LIVE_COACH_UII_RECONCILE_ENABLED;
  process.env.LIVE_COACH_UII_ADOPT_ENABLED = "true";
  try {
    const segment = makeProspectSegment({
      dialogIdentity: { uii: "OLD-UII", queueItemId: "q-old", callSessionId: "cs-old" },
    });

    await withFetch(
      [
        {
          match: "/mongo/bind/latest",
          respond: () => ({
            ok: true,
            status: "not_current",
            session: null,
            binding: {
              status: "not_current",
              active: false,
              reason: "agent-current-uii-mismatch",
              event: {
                uii: "NEW-UII",
                queueItemId: "q-new",
                callSessionId: "cs-new",
              },
            },
          }),
        },
      ],
      async () => {
        const result = await ensureCoachSession(segment, { forceBind: true });
        // Adopt returns non-terminal (null) so the next attempt can rebind.
        assert.equal(result, null);
        // Identity advanced to the agent's real current call.
        assert.equal(segment.dialogIdentity.uii, "NEW-UII");
        assert.equal(segment.dialogIdentity.queueItemId, "q-new");
        assert.equal(segment.dialogIdentity.callSessionId, "cs-new");
        // Still unbound (not terminal) -- ready to rebind.
        assert.equal(segment.coachSessionStarted, false);
        assert.equal(segment.coachTerminal, false);
        const adopted = eventsOfType(segment.__eventLog, "coach.session.uii_adopted");
        assert.equal(adopted.length, 1);
        assert.equal(adopted[0].fromUii, "OLD-UII");
        assert.equal(adopted[0].toUii, "NEW-UII");
        // No misleading bind_miss line when we adopt.
        assert.equal(eventsOfType(segment.__eventLog, "coach.session.bind_miss").length, 0);
      },
    );
  } finally {
    delete process.env.LIVE_COACH_UII_ADOPT_ENABLED;
  }
});

test("MISS->ADOPT default OFF: drift is logged, stream identity preserved, falls through to bind_miss", async () => {
  delete process.env.LIVE_COACH_UII_RECONCILE_ENABLED;
  delete process.env.LIVE_COACH_UII_ADOPT_ENABLED;
  const segment = makeProspectSegment({
    dialogIdentity: { uii: "STREAM-UII", queueItemId: "q-stream", callSessionId: "cs-stream" },
  });
  assert.equal(segment.uiiAdoptEnabled, false);

  await withFetch(
    [
      {
        match: "/mongo/bind/latest",
        respond: () => ({
          ok: true,
          status: "not_current",
          session: null,
          binding: {
            status: "not_current",
            active: false,
            reason: "agent-current-uii-mismatch",
            event: {
              uii: "STALE-EVENT-UII",
              queueItemId: "q-stale",
              callSessionId: "cs-stale",
            },
          },
        }),
      },
    ],
    async () => {
      const result = await ensureCoachSession(segment, { forceBind: true });
      // allowUnboundCoachSessions=false in this harness -> bind_miss is terminal null.
      assert.equal(result, null);
      // The stream's RingCX ground-truth identity is NOT overwritten by the
      // (possibly stale) latest event for the agent.
      assert.equal(segment.dialogIdentity.uii, "STREAM-UII");
      assert.equal(segment.dialogIdentity.queueItemId, "q-stream");
      assert.equal(segment.dialogIdentity.callSessionId, "cs-stream");
      assert.equal(segment.coachSessionStarted, false);
      assert.equal(eventsOfType(segment.__eventLog, "coach.session.uii_adopted").length, 0);
      const drift = eventsOfType(segment.__eventLog, "coach.session.uii_drift");
      assert.equal(drift.length, 1);
      assert.equal(drift[0].streamUii, "STREAM-UII");
      assert.equal(drift[0].latestEventUii, "STALE-EVENT-UII");
      assert.equal(drift[0].adoption, "disabled");
      // Falls through to the normal miss path (which, with unbound sessions
      // allowed in production, degrades to a thin session instead of silence).
      assert.equal(eventsOfType(segment.__eventLog, "coach.session.bind_miss").length, 1);
    },
  );
});

test("closed bind miss does not fall through to unbound fallback", async () => {
  delete process.env.LIVE_COACH_UII_RECONCILE_ENABLED;
  delete process.env.LIVE_COACH_UII_ADOPT_ENABLED;
  const segment = makeProspectSegment({
    dialogIdentity: { uii: "CLOSED-UII", queueItemId: "q-closed", callSessionId: "cs-closed" },
  });
  segment.allowUnboundCoachSessions = true;

  await withFetch(
    [
      {
        match: "/mongo/bind/latest",
        respond: () => ({
          ok: true,
          status: "closed",
          session: null,
          binding: null,
        }),
      },
      {
        match: "/grpc/start",
        respond: () => {
          throw new Error("closed calls must not start unbound sessions");
        },
      },
    ],
    async () => {
      const result = await ensureCoachSession(segment, { forceBind: true });
      assert.equal(result, null);
      assert.equal(segment.coachSessionStarted, false);
      assert.equal(segment.coachTerminal, true);
      assert.equal(eventsOfType(segment.__eventLog, "coach.session.bind_miss").length, 1);
      assert.equal(eventsOfType(segment.__eventLog, "coach.session.bind_miss_terminal").length, 1);
    },
  );
});

test("DRIFT->REBIND: requires the same new uii on 2 consecutive ticks before rebinding", async () => {
  process.env.LIVE_COACH_UII_RECONCILE_ENABLED = "true";
  process.env.LIVE_COACH_UII_RECONCILE_MS = "5000";
  try {
    const segment = makeProspectSegment({
      dialogIdentity: { uii: "BOUND-UII", queueItemId: "q-bound", callSessionId: "cs-bound" },
    });
    // Pretend we are already bound to BOUND-UII.
    segment.coachSessionStarted = true;
    segment.coachSessionId = "coach-existing";
    segment.coachBinding = { metadata: { uii: "BOUND-UII" } };

    let bindLatestCalls = 0;
    let stopCalls = 0;
    let startBindCalls = 0;
    await withFetch(
      [
        {
          match: "/stop",
          respond: () => {
            stopCalls += 1;
            return { ok: true };
          },
        },
        {
          match: "/mongo/bind/latest",
          respond: (body) => {
            bindLatestCalls += 1;
            if (body.source === "grpc-live-bridge-reconcile") {
              // Reconcile probe is agent-only (no call identity filters).
              assert.equal(body.uii, undefined);
              assert.equal(body.callSessionId, undefined);
              assert.equal(body.queueItemId, undefined);
              assert.ok(body.agentExtensionId || body.agentEmail);
              // The agent's current call rolled to DRIFT-UII.
              return {
                ok: true,
                status: "active",
                binding: {
                  status: "active",
                  active: true,
                  event: { uii: "DRIFT-UII", queueItemId: "q-drift", callSessionId: "cs-drift" },
                },
              };
            }
            // The post-rebind ensureCoachSession bind for the new identity.
            startBindCalls += 1;
            return {
              ok: true,
              status: "active",
              session: { id: "coach-rebound", metadata: { uii: "DRIFT-UII" } },
              binding: { status: "active", active: true, metadata: { uii: "DRIFT-UII" }, event: { uii: "DRIFT-UII" } },
            };
          },
        },
      ],
      async () => {
        // Tick 1: drift seen, candidate recorded, NO rebind yet (debounce).
        const first = await reconcileCoachUii(segment);
        assert.equal(first, null);
        assert.equal(stopCalls, 0);
        assert.equal(segment.uiiDriftCandidate, "DRIFT-UII");
        assert.equal(segment.uiiDriftConfirmCount, 1);
        assert.equal(segment.dialogIdentity.uii, "BOUND-UII");
        assert.equal(eventsOfType(segment.__eventLog, "coach.uii.reconciled").length, 0);
        assert.equal(eventsOfType(segment.__eventLog, "coach.uii.reconcile_candidate").length, 1);

        // Force the throttle window open so the second tick runs.
        segment.nextUiiReconcileAt = 0;

        // Tick 2: same new uii confirmed -> stop + rebind.
        const second = await reconcileCoachUii(segment);
        assert.deepEqual(second, { fromUii: "BOUND-UII", toUii: "DRIFT-UII" });
        assert.equal(stopCalls, 1);
        assert.equal(segment.dialogIdentity.uii, "DRIFT-UII");
        assert.equal(segment.dialogIdentity.queueItemId, "q-drift");
        assert.equal(segment.dialogIdentity.callSessionId, "cs-drift");
        assert.equal(segment.uiiDriftCandidate, null);
        assert.equal(segment.uiiDriftConfirmCount, 0);
        assert.ok(startBindCalls >= 1, "expected a rebind call after reconcile");
        const reconciled = eventsOfType(segment.__eventLog, "coach.uii.reconciled");
        assert.equal(reconciled.length, 1);
        assert.equal(reconciled[0].fromUii, "BOUND-UII");
        assert.equal(reconciled[0].toUii, "DRIFT-UII");
      },
    );
  } finally {
    delete process.env.LIVE_COACH_UII_RECONCILE_ENABLED;
    delete process.env.LIVE_COACH_UII_RECONCILE_MS;
  }
});

test("DISABLED is a no-op: reconcile does nothing and makes no network call", async () => {
  delete process.env.LIVE_COACH_UII_RECONCILE_ENABLED;
  delete process.env.LIVE_COACH_UII_RECONCILE_MS;
  const segment = makeProspectSegment({
    dialogIdentity: { uii: "BOUND-UII" },
  });
  segment.coachSessionStarted = true;
  segment.coachSessionId = "coach-existing";
  segment.coachBinding = { metadata: { uii: "BOUND-UII" } };
  assert.equal(segment.uiiReconcileEnabled, false);

  await withFetch([], async (calls) => {
    const result = await reconcileCoachUii(segment);
    assert.equal(result, null);
    assert.equal(calls.length, 0, "disabled reconcile must not hit the network");
    assert.equal(segment.dialogIdentity.uii, "BOUND-UII");
    assert.equal(eventsOfType(segment.__eventLog, "coach.uii.reconciled").length, 0);
    assert.equal(eventsOfType(segment.__eventLog, "coach.uii.reconcile_candidate").length, 0);
  });
});

test("reconcile interval enforces a 5000ms floor", () => {
  process.env.LIVE_COACH_UII_RECONCILE_ENABLED = "true";
  process.env.LIVE_COACH_UII_RECONCILE_MS = "1000";
  try {
    const segment = makeProspectSegment();
    assert.equal(segment.uiiReconcileEnabled, true);
    assert.equal(segment.uiiReconcileIntervalMs, 5000);
  } finally {
    delete process.env.LIVE_COACH_UII_RECONCILE_ENABLED;
    delete process.env.LIVE_COACH_UII_RECONCILE_MS;
  }
});
