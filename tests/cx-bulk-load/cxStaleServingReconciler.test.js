"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_STALE_MINUTES,
  resolveServingIdentity,
  resolveSelectedDisposition,
  classifyStaleServingRow,
  createCxStaleServingReconcilerService,
} = require("../../packages/shared-services/src/cxStaleServingReconcilerService");

const NOW = new Date("2026-06-29T18:30:00.000Z");
const CUTOFF_MS = DEFAULT_STALE_MINUTES * 60_000;

// A serving shell as markCandidateServing stamps it. The RingCX account is the TOP-LEVEL rcxAccountId
// column (NOT metadata.lastDialExecutionAccountId — that's the legacy non-bulk path). Stale by default.
function servingRow(over = {}) {
  const md = {
    servingAt: over.servingAt || new Date(NOW.getTime() - 12 * 60_000).toISOString(),
    lastDialExecutionUii: "uii-prior",
    lastDialExecutionExternId: "extern-prior",
    lastRingcxActiveCall: { agentId: "agentA" },
    reservationSessionId: null,
    ...(over.metadata || {}),
  };
  return {
    _id: over._id || "q1",
    state: over.state || "serving",
    domain: "TAG",
    caseId: over.caseId != null ? over.caseId : 130936,
    uii: over.uii,
    rcxAccountId: over.rcxAccountId !== undefined ? over.rcxAccountId : "acct-1",
    assignment: over.assignment || { extensionId: "ext-1" },
    metadata: md,
  };
}

// ── resolveServingIdentity / resolveSelectedDisposition (pure) ──
test("resolveServingIdentity resolves the account from the top-level rcxAccountId column (the bulk field)", () => {
  assert.equal(resolveServingIdentity(servingRow()).accountId, "acct-1");
  // metadata.rcxAccountId fallback (reserved rows) when no top-level column
  assert.equal(resolveServingIdentity(servingRow({ rcxAccountId: null, metadata: { rcxAccountId: "acct-meta" } })).accountId, "acct-meta");
  // a row with NO account anywhere -> null
  assert.equal(resolveServingIdentity(servingRow({ rcxAccountId: null })).accountId, null);
});

test("resolveServingIdentity collects the FULL stored UII + externId identity family", () => {
  const id = resolveServingIdentity(servingRow({
    metadata: {
      lastDialExecutionUii: "uii-a",
      lastQueueAttemptUii: "uii-b",
      lastRingcxMonitorUii: "uii-c",
      lastDialExecutionExternId: "extern-a",
      lastRingcxPublishedExternId: "extern-b",
      lastRingcxActiveCall: { agentId: "agentA", callId: "call-x", externId: "extern-c" },
      lastRingcxMonitorActiveCall: { raw: { dequeueTime: "2026-06-29T18:03:55Z" } },
    },
  }));
  assert.deepEqual([...id.allUiis].sort(), ["call-x", "uii-a", "uii-b", "uii-c"]);
  assert.deepEqual([...id.externIds].sort(), ["extern-a", "extern-b", "extern-c"]);
  assert.equal(id.agentKey, "agentA");
  assert.equal(id.dequeueTime, "2026-06-29T18:03:55Z");
});

test("resolveSelectedDisposition prefers the hangup-request disposition, else null", () => {
  assert.deepEqual(
    resolveSelectedDisposition(servingRow({ metadata: { lastDisposition: "Old", lastHangupRequestDisposition: "Callback" } })),
    { disposition: "Callback", field: "lastHangupRequestDisposition" },
  );
  assert.equal(resolveSelectedDisposition(servingRow()), null);
});

// ── classifyStaleServingRow ──
function ctx(over = {}) {
  return {
    row: servingRow(),
    now: NOW,
    staleCutoffMs: CUTOFF_MS,
    snapshotOk: true,
    activeUiiSet: new Set(["uii-someone-else"]), // non-empty, but NOT the row's UII
    activeExternIdSet: new Set(["extern-someone-else"]),
    // The other live call is attributed to a DIFFERENT agent — realistic: an active call in the account
    // snapshot carries an agentId. agentA (this row's agent) is NOT on it, so the row is a genuine idle
    // shell (and the agent-advanced check is NOT blind).
    agentActiveIds: new Map([["agentOther", { uiis: new Set(["uii-someone-else"]), externIds: new Set(["extern-someone-else"]) }]]),
    hasTerminalEvidence: false,
    agentActivity: null,
    ...over,
  };
}

test("proven idle stale shell -> stale-shell, idle-stale-shell, high confidence, actionable, did_not_connect", () => {
  const v = classifyStaleServingRow(ctx());
  assert.equal(v.verdict, "stale-shell");
  assert.equal(v.shape, "idle-stale-shell");
  assert.equal(v.confidence, "high");
  assert.equal(v.actionable, true);
  assert.equal(v.proposedOutcome, "did_not_connect");
  assert.equal(v.recommendedAction, "release-shell-and-observe");
});

test("a selected disposition becomes the proposedOutcome (Q2)", () => {
  const v = classifyStaleServingRow(ctx({ row: servingRow({ metadata: { lastHangupRequestDisposition: "Voicemail" } }) }));
  assert.equal(v.proposedOutcome, "Voicemail");
});

test("STILL-ACTIVE via externId — a live call present under externId (uii absent/callId) is NOT stale", () => {
  // The callId/externId-identity class: the row's UII is a callId, the snapshot reports the call by
  // externId with no uii. externId match must catch it.
  const v = classifyStaleServingRow(ctx({
    row: servingRow({ metadata: { lastDialExecutionUii: "call-123", lastDialExecutionExternId: "extern-prior" } }),
    activeUiiSet: new Set(),
    activeExternIdSet: new Set(["extern-prior"]),
  }));
  assert.equal(v.reason, "still-active");
});

test("STILL-ACTIVE via a NON-priorUii stored UII (lastQueueAttemptUii) the snapshot reports", () => {
  const v = classifyStaleServingRow(ctx({
    row: servingRow({ metadata: { lastDialExecutionUii: "uii-prior", lastQueueAttemptUii: "uii-on-snapshot" } }),
    activeUiiSet: new Set(["uii-on-snapshot"]),
    activeExternIdSet: new Set(),
  }));
  assert.equal(v.reason, "still-active");
});

test("EMPTY account snapshot makes the idle shape LOW confidence + non-actionable (campaign-pause guard)", () => {
  const v = classifyStaleServingRow(ctx({ activeUiiSet: new Set(), activeExternIdSet: new Set() }));
  assert.equal(v.verdict, "stale-shell");
  assert.equal(v.shape, "idle-stale-shell");
  assert.equal(v.confidence, "low-empty-snapshot");
  assert.equal(v.actionable, false);
  assert.equal(v.recommendedAction, "observe-only");
});

test("dequeueTime corroboration restores HIGH confidence even on an empty snapshot", () => {
  const v = classifyStaleServingRow(ctx({
    row: servingRow({ metadata: { lastRingcxMonitorActiveCall: { raw: { dequeueTime: "2026-06-29T18:10:00Z" } } } }),
    activeUiiSet: new Set(),
    activeExternIdSet: new Set(),
  }));
  assert.equal(v.confidence, "high");
  assert.equal(v.actionable, true);
});

test("agent-advanced shape is OBSERVE-ONLY (non-actionable) — agent is live on a new call", () => {
  const v = classifyStaleServingRow(ctx({
    activeUiiSet: new Set(["uii-next-call"]),
    agentActiveIds: new Map([["agentA", { uiis: new Set(["uii-next-call"]), externIds: new Set() }]]),
  }));
  assert.equal(v.verdict, "stale-shell");
  assert.equal(v.shape, "agent-advanced");
  assert.equal(v.replacementUii, "uii-next-call");
  assert.equal(v.actionable, false);
  assert.equal(v.recommendedAction, "observe-only");
});

test("dequeueTime corroboration also reads the BULK stamp (lastRingcxActiveCall.dequeueTime) — N1", () => {
  // Bulk serving shells stamp dequeueTime flat on lastRingcxActiveCall (NOT the legacy monitor field),
  // so the corroboration channel must read it there too.
  const v = classifyStaleServingRow(ctx({
    row: servingRow({ metadata: { lastRingcxActiveCall: { agentId: "agentA", dequeueTime: "2026-06-29T18:10:00Z" } } }),
    activeUiiSet: new Set(),
    activeExternIdSet: new Set(),
  }));
  assert.equal(v.dequeueTime, "2026-06-29T18:10:00Z");
  assert.equal(v.confidence, "high"); // corroboration restores confidence on an empty snapshot
  assert.equal(v.actionable, true);
});

test("agent-advanced BLIND: snapshot has calls but NONE carry an agentId -> observe-only (N2)", () => {
  const v = classifyStaleServingRow(ctx({
    activeUiiSet: new Set(["uii-unattributed"]),
    activeExternIdSet: new Set(),
    agentActiveIds: new Map(), // no call bore an agentId -> the agent-advanced check is blind for THIS agent
  }));
  assert.equal(v.verdict, "stale-shell");
  assert.equal(v.shape, "idle-stale-shell");
  assert.equal(v.confidence, "low-agent-visibility");
  assert.equal(v.actionable, false);
  assert.equal(v.recommendedAction, "observe-only");
});

// ── fail-closed skip ladder ──
test("SKIP not-yet-stale / snapshot-read-failed / already-terminalized / agent-active / no-call-identity / not-serving", () => {
  assert.equal(classifyStaleServingRow(ctx({ row: servingRow({ servingAt: new Date(NOW.getTime() - 60_000).toISOString() }) })).reason, "not-yet-stale");
  // fail-closed: a failed read is NEVER "gone", even with an empty active set
  assert.equal(classifyStaleServingRow(ctx({ snapshotOk: false, activeUiiSet: new Set(), activeExternIdSet: new Set() })).reason, "snapshot-read-failed");
  assert.equal(classifyStaleServingRow(ctx({ hasTerminalEvidence: true })).reason, "already-terminalized");
  assert.equal(classifyStaleServingRow(ctx({ agentActivity: { active: true, reason: "active-ui-disposition-hold" } })).reason, "agent-active");
  assert.equal(classifyStaleServingRow(ctx({ row: servingRow({ metadata: { lastDialExecutionUii: "", lastQueueAttemptUii: "", lastDialExecutionExternId: "", lastRingcxActiveCall: { agentId: "agentA" } } }) })).reason, "no-call-identity");
  assert.equal(classifyStaleServingRow(ctx({ row: servingRow({ state: "ready" }) })).reason, "not-serving");
});

test("SKIP synthetic identity (cx-synth: UII with no externId)", () => {
  const v = classifyStaleServingRow(ctx({ row: servingRow({ metadata: { lastDialExecutionUii: "cx-synth:abc", lastQueueAttemptUii: "", lastDialExecutionExternId: "" } }) }));
  assert.equal(v.reason, "no-call-identity");
});

// ── runStaleServingDiagnosticOnce (read-only sweep) ──
function buildSweep(over = {}) {
  const repo = { async listQueueItems() { return over.rows || []; } };
  const evidence = new Set(over.evidence || []);
  const accountCalls = over.accountCalls || { "acct-1": [] };
  const failingAccounts = new Set(over.failingAccounts || []);
  const logs = [];
  const svc = createCxStaleServingReconcilerService({
    cxDialQueueRepository: repo,
    async terminalEvidence(row) {
      if (over.evidenceThrowsFor && over.evidenceThrowsFor.includes(String(row._id))) throw new Error("evidence boom");
      return evidence.has(String(row._id));
    },
    async loadAccountActiveCalls(accountId) {
      if (failingAccounts.has(accountId)) throw new Error("ringcx 503");
      return accountCalls[accountId] || [];
    },
    resolveAccountId: over.resolveAccountId,
    evaluateServingActivity: over.evaluateServingActivity,
    logger: { info: (...a) => logs.push(["info", ...a]), warn: (...a) => logs.push(["warn", ...a]) },
    now: () => NOW,
  });
  return { svc, logs };
}

test("REGRESSION (blocker): a bulk row with ONLY rcxAccountId resolves + polls + is classified (not skipped)", async () => {
  const { svc } = buildSweep({
    rows: [servingRow({ _id: "qBulk" })], // rcxAccountId:"acct-1", no metadata.lastDialExecutionAccountId
    accountCalls: { "acct-1": [{ uii: "uii-other", externId: "extern-other", agentId: "agentB" }] },
  });
  const report = await svc.runStaleServingDiagnosticOnce();
  assert.equal(report.accountsPolled, 1, "the bulk account WAS polled (was 0 before the fix)");
  assert.equal(report.candidateCount, 1);
  assert.equal(report.byShape["idle-stale-shell"], 1);
  assert.equal(report.agentActivityGuard, "disabled");
});

test("sweep mutates NOTHING and reports an idle candidate", async () => {
  const { svc, logs } = buildSweep({
    rows: [servingRow({ _id: "qA" })],
    accountCalls: { "acct-1": [{ uii: "uii-other", externId: "extern-other", agentId: "agentB" }] },
  });
  const report = await svc.runStaleServingDiagnosticOnce();
  assert.equal(report.candidateCount, 1);
  assert.equal(report.actionableCandidateCount, 1);
  assert.equal(report.candidates[0].proposedOutcome, "did_not_connect");
  assert.ok(logs.some((l) => l[1] === "cx_stale_serving_diagnostic.candidate"));
});

test("sweep: a row with no resolvable account reports 'no-account-id' (distinct from a failed read)", async () => {
  const { svc } = buildSweep({ rows: [servingRow({ _id: "qN", rcxAccountId: null })] });
  const report = await svc.runStaleServingDiagnosticOnce();
  assert.equal(report.candidateCount, 0);
  assert.equal(report.bySkipReason["no-account-id"], 1);
  assert.equal(report.bySkipReason["snapshot-read-failed"], undefined);
});

test("sweep: injected resolveAccountId recovers an account-less row (e.g. session join)", async () => {
  const { svc } = buildSweep({
    rows: [servingRow({ _id: "qJ", rcxAccountId: null })],
    accountCalls: { "acct-joined": [{ uii: "uii-other", externId: "x", agentId: "agentB" }] },
    resolveAccountId: async () => "acct-joined",
  });
  const report = await svc.runStaleServingDiagnosticOnce();
  assert.equal(report.candidateCount, 1);
});

test("sweep fail-soft: an account snapshot read throw -> its rows skip snapshot-read-failed (never gone)", async () => {
  const { svc } = buildSweep({ rows: [servingRow({ _id: "qF" })], failingAccounts: ["acct-1"] });
  const report = await svc.runStaleServingDiagnosticOnce();
  assert.equal(report.accountsFailed, 1);
  assert.equal(report.candidateCount, 0);
  assert.equal(report.bySkipReason["snapshot-read-failed"], 1);
});

test("sweep fail-closed: an evidence-check error skips the row (evidence-check-failed)", async () => {
  const { svc } = buildSweep({ rows: [servingRow({ _id: "qE" })], accountCalls: { "acct-1": [{ uii: "x", externId: "y" }] }, evidenceThrowsFor: ["qE"] });
  const report = await svc.runStaleServingDiagnosticOnce();
  assert.equal(report.candidateCount, 0);
  assert.equal(report.bySkipReason["evidence-check-failed"], 1);
});

test("sweep skips rows whose owning session is still LIVE", async () => {
  const { svc } = buildSweep({
    rows: [servingRow({ _id: "qL", metadata: { reservationSessionId: "live-sess" } })],
    accountCalls: { "acct-1": [{ uii: "x", externId: "y", agentId: "agentB" }] },
  });
  const report = await svc.runStaleServingDiagnosticOnce({ activeSessionIds: ["live-sess"] });
  assert.equal(report.candidateCount, 0);
  assert.equal(report.bySkipReason["owning-session-live"], 1);
});

test("sweep reports agentActivityGuard:enabled and honors an injected active probe", async () => {
  const { svc } = buildSweep({
    rows: [servingRow({ _id: "qW" })],
    accountCalls: { "acct-1": [{ uii: "uii-other", externId: "extern-other", agentId: "agentB" }] },
    evaluateServingActivity: async () => ({ active: true, reason: "wrapup" }),
  });
  const report = await svc.runStaleServingDiagnosticOnce();
  assert.equal(report.agentActivityGuard, "enabled");
  assert.equal(report.candidateCount, 0);
  assert.equal(report.bySkipReason["agent-active"], 1);
});

test("factory rejects missing required deps", () => {
  assert.throws(() => createCxStaleServingReconcilerService({}), /listQueueItems/);
  assert.throws(() => createCxStaleServingReconcilerService({ cxDialQueueRepository: { listQueueItems() {} } }), /terminalEvidence/);
  assert.throws(
    () => createCxStaleServingReconcilerService({ cxDialQueueRepository: { listQueueItems() {} }, terminalEvidence() {} }),
    /loadAccountActiveCalls/,
  );
});
