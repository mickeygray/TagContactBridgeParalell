"use strict";

// CX 2.0 stale-serving SHELL detector — DIAGNOSTIC ONLY (no mutation).
//
// The bug (the "Bruce" edge case, docs/CX_STALE_SERVING_EDGE_CASE_BRUCE_2026-06-29.md): RingCX ends a
// call but the app never writes a terminal/release fact, so the CxDialQueue row stays state:"serving"
// (metadata.servingAt + wrapUpRequired) and the agent loops — the row is INVISIBLE to the claim
// reaper (it excludes servingAt/reservationSessionId rows) and only the slow legacy
// requeueStaleServingQueueItems (~8 min) frees it.
//
// This module ONLY OBSERVES. It scans serving rows, applies the conservative "proven stale shell"
// predicate, and LOGS what it found + the action it WOULD take. It performs ZERO queue/outbox/agent
// mutation. A later pass adds the (gated) act path. The whole thing is default-off: nothing runs
// unless a caller invokes runStaleServingDiagnosticOnce.
//
// The proven predicate (the doc's guardrail) — terminalize/release ONLY when ALL hold:
//   previously-matched identity present  +  RingCX gone proof (NONE of the row's stored UIIs OR
//   externIds appear in a CONFIRMED-GOOD active-call snapshot — matched the SAME externId-first way
//   the live watcher matches, never inferred from a failed read)  +  NO terminal outbox row
//   (buildTerminalEvidenceKeys -> findByIdemKeys)  +  no replacement call for the agent  +  agent not
//   active (when the activity guard is wired).
// Anything short of that is a SKIP with an explicit reason. Fail-CLOSED everywhere: a snapshot read
// error or an evidence-check error means "cannot prove gone" -> skip, never "assume gone".
//
// Confidence note (read this before enabling any act path): a SINGLE snapshot that comes back EMPTY
// (a campaign pause / dialer lull) makes every aged UII look "gone". The idle shape from an empty
// snapshot is therefore marked confidence:"low" / actionable:false; only a non-empty confirmed
// snapshot (or a replacement call for the agent) yields a high-confidence/actionable verdict — and
// even then act-mode must additionally wire the agent-active guard (see agentActivityGuard in the
// report) and a second confirming read. This file is diagnostic-only; it never acts on any of this.
//
// Pure helpers (classifyStaleServingRow / resolve* / collect*) test with zero mocks; the sweep
// injects all I/O. No Mongo/RingCX detail lives here.

const DEFAULT_STALE_MINUTES = 6; // observe a touch earlier than the legacy 8-min path
const DEFAULT_SCAN_LIMIT = 500;
const MAX_SCAN_LIMIT = 1000; // cxDialQueueRepository.listQueueItems hard cap
const CANDIDATE_SAMPLE_CAP = 25;

function str(value) {
  return String(value == null ? "" : value).trim();
}

function isRealUii(value) {
  const text = str(value);
  return Boolean(text) && !text.toLowerCase().startsWith("cx-synth:");
}

function timeMs(value) {
  if (!value) return null;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

// PURE. Every NON-synthetic UII the live system would have matched this serving row by — the live
// ownership predicate (ringcxAgentMonitorService.scoreQueueItemForActiveCall / hasHeldServingQueueForAgent)
// keys on ANY of these, so the "gone" proof must check ALL of them, not a single resolved UII.
function collectStoredUiis(metadata = {}, row = {}) {
  const out = new Set();
  const active = metadata.lastRingcxActiveCall || {};
  for (const v of [
    metadata.lastDialExecutionUii,
    metadata.lastQueueAttemptUii,
    metadata.lastRingcxMonitorUii,
    metadata.lastHangupRequestUii,
    row.uii,
    active.uii,
    active.callId, // RingCX surfaces some live calls under callId (empty uii) — match it too
  ]) {
    const s = str(v);
    if (s && isRealUii(s)) out.add(s);
  }
  return out;
}

// PURE. Every externId the row was published/dialed under. externId is the PRIMARY identity the live
// watcher matches on (it can match a live call with uii:null purely by externId), so a "gone" proof
// that ignores externId would misread a still-live externId-only call as gone.
function collectStoredExternIds(metadata = {}, row = {}) {
  const out = new Set();
  const active = metadata.lastRingcxActiveCall || {};
  const ringcx = row.ringcx || {};
  for (const v of [
    metadata.lastDialExecutionExternId,
    metadata.lastRingcxPublishedExternId,
    metadata.rcxVisibilityExternId,
    active.externId,
    ringcx.externId,
    row.externId,
  ]) {
    const s = str(v);
    if (s) out.add(s);
  }
  return out;
}

// PURE. The identity facts a serving row carries. Reads the BULK serving fields;
// WO-2 removed the old adopted-active variant. The RingCX account lives on the top-level
// rcxAccountId column (and metadata.rcxAccountId on reserved rows), NOT lastDialExecutionAccountId
// (that is the legacy non-bulk dial path). No I/O.
function resolveServingIdentity(row = {}) {
  const metadata = row && typeof row.metadata === "object" && row.metadata ? row.metadata : {};
  const assignment = row && typeof row.assignment === "object" && row.assignment ? row.assignment : {};
  const allUiis = collectStoredUiis(metadata, row);
  const externIds = collectStoredExternIds(metadata, row);
  const priorUii = str(metadata.lastDialExecutionUii || metadata.lastQueueAttemptUii || row.uii); // for logging + the no-identity gate
  // Agent identity for the "replacement call for the agent" check. The RingCX snapshot carries
  // agentId (username); the serving stamp's lastRingcxActiveCall.agentId is the same normalized id.
  const agentKey = str(
    (metadata.lastRingcxActiveCall && metadata.lastRingcxActiveCall.agentId)
      || metadata.lastDialExecutionDialerCxAgentId
      || metadata.lastDialExecutionDialerExtensionId
      || assignment.extensionId,
  );
  // Account-to-poll resolution = the codebase's canonical chain, top-level column FIRST (the bulk
  // field), legacy metadata.lastDialExecutionAccountId only as a last resort.
  const accountId = str(
    row.rcxAccountId
      || metadata.rcxAccountId
      || metadata.rcxVisibilityAccountId
      || metadata.lastRingcxPublishedAccountId
      || metadata.lastDialExecutionAccountId,
  );
  // dequeueTime source. The legacy slow-lane monitor stamps it under lastRingcxMonitorActiveCall.raw;
  // the BULK serving stamp carries it flat on lastRingcxActiveCall (normalizeActiveCall). Read both —
  // the bulk field is the one populated for the rows this diagnostic targets. (.raw fallback kept for
  // any summary shape that nests it.)
  const monitorRaw = metadata.lastRingcxMonitorActiveCall && metadata.lastRingcxMonitorActiveCall.raw;
  const bulkActive = metadata.lastRingcxActiveCall;
  const dequeueTimeValue =
    (monitorRaw && monitorRaw.dequeueTime != null) ? monitorRaw.dequeueTime
      : (bulkActive && bulkActive.dequeueTime != null) ? bulkActive.dequeueTime
        : (bulkActive && bulkActive.raw && bulkActive.raw.dequeueTime != null) ? bulkActive.raw.dequeueTime
          : null;
  return {
    queueItemId: str(row._id || row.queueItemId),
    caseId: row.caseId != null ? row.caseId : null,
    domain: str(row.domain) || null,
    accountId: accountId || null,
    reservationSessionId: str(metadata.reservationSessionId) || null,
    extensionId: str(assignment.extensionId) || null,
    priorUii,
    allUiis,
    externIds,
    agentKey: agentKey || null,
    servingAtMs: timeMs(metadata.servingAt),
    // dequeueTime is CORROBORATING ONLY (unreliable — a real terminal was seen with dequeueTime:null
    // and Bruce had it set). It RAISES confidence; it is never load-bearing on its own.
    dequeueTime: dequeueTimeValue,
  };
}

// PURE. Best-effort probe for a disposition the agent already selected (Q2: "match the disposition
// that was selected if found, otherwise did_not_connect"). Returns {disposition, field} or null.
const SELECTED_DISPOSITION_FIELDS = [
  "lastHangupRequestDisposition",
  "lastHangupRequestRcxDisposition",
  "lastDispositionHangupIntent",
  "lastDisposition",
  "disposition",
];
function resolveSelectedDisposition(row = {}) {
  const metadata = row && typeof row.metadata === "object" && row.metadata ? row.metadata : {};
  for (const field of SELECTED_DISPOSITION_FIELDS) {
    const value = str(metadata[field]);
    if (value) return { disposition: value, field };
  }
  return null;
}

// PURE. Classify ONE serving row against the proven stale-shell predicate. Returns a compact verdict
// (never the full row). verdict.verdict is "stale-shell" (a candidate) or "skip" (verdict.reason
// says why). NEVER mutates / NEVER does I/O — every external fact is passed in by the sweep.
function classifyStaleServingRow({
  row = {},
  now = new Date(),
  staleCutoffMs = DEFAULT_STALE_MINUTES * 60_000,
  snapshotOk = false,
  activeUiiSet = null,
  activeExternIdSet = null,
  agentActiveIds = null, // Map<agentId, {uiis:Set, externIds:Set}>
  hasTerminalEvidence = false,
  agentActivity = null,
} = {}) {
  const id = resolveServingIdentity(row);
  const selected = resolveSelectedDisposition(row);
  const nowMs = now instanceof Date ? now.getTime() : timeMs(now) || Date.now();
  const ageMs = id.servingAtMs != null ? Math.max(nowMs - id.servingAtMs, 0) : null;
  const uiiSet = activeUiiSet instanceof Set ? activeUiiSet : new Set();
  const externSet = activeExternIdSet instanceof Set ? activeExternIdSet : new Set();
  const agentMap = agentActiveIds instanceof Map ? agentActiveIds : new Map();
  const emptyAccountSnapshot = uiiSet.size === 0 && externSet.size === 0;

  const base = {
    queueItemId: id.queueItemId,
    accountId: id.accountId,
    agentKey: id.agentKey,
    extensionId: id.extensionId,
    priorUii: id.priorUii || null,
    domain: id.domain,
    caseId: id.caseId,
    servingAtMs: id.servingAtMs,
    ageMs,
    dequeueTime: id.dequeueTime,
    hasTerminalEvidence: Boolean(hasTerminalEvidence),
    reservationSessionId: id.reservationSessionId,
    emptyAccountSnapshot,
    selectedDisposition: selected,
    // The outcome the cleaner WOULD assert IF it acted: a selected disposition if found, else
    // did_not_connect (the operator's choice). Diagnostic-only — not applied.
    proposedOutcome: selected ? selected.disposition : "did_not_connect",
    replacementUii: null,
    shape: null,
    confidence: null,
    actionable: false,
    recommendedAction: null,
  };

  const skip = (reason) => ({ ...base, verdict: "skip", reason });

  // --- the fail-closed predicate ladder ---
  if (str(row.state) && str(row.state) !== "serving") return skip("not-serving");
  if (id.servingAtMs == null) return skip("no-serving-timestamp");
  if (id.allUiis.size === 0 && id.externIds.size === 0) return skip("no-call-identity");
  if (ageMs != null && ageMs < staleCutoffMs) return skip("not-yet-stale");
  // FAIL-CLOSED: without a confirmed-good snapshot we cannot prove the call is gone (a failed/empty
  // RingCX read must NEVER be read as "no call" — the 2026-06-17 false-release class).
  if (!snapshotOk) return skip("snapshot-read-failed");
  // A terminal outbox row already exists -> the drain will de-serve it; never touch it.
  if (hasTerminalEvidence) return skip("already-terminalized");
  // STILL-ACTIVE: the call is present in a good snapshot under ANY of the row's stored UIIs OR
  // externIds (externId-first, exactly how the live watcher matches). This is the load-bearing guard.
  const stillActive = [...id.allUiis].some((u) => uiiSet.has(u)) || [...id.externIds].some((e) => externSet.has(e));
  if (stillActive) return skip("still-active");
  // Respect the live-call guard when wired (the diagnostic runner leaves it unwired — see report
  // agentActivityGuard — so this only fires for an injected probe).
  if (agentActivity && agentActivity.active === true) return skip("agent-active");

  // PROVEN gone: serving + aged + none of the row's identities active + no terminal row.
  // Shape (informational):
  //  - agent-advanced: a DIFFERENT call is active for this agent now -> RingCX auto-advanced; the old
  //    call definitely ended. Kept observable but actionable:false (an act path must NOT terminalize
  //    the old row while the agent is live on a new one without an explicit gate — the doc's
  //    "no replacement UII" precondition).
  //  - idle-stale-shell: the agent has no active call -> the doc's strict release+observe shape.
  const agentIds = id.agentKey ? agentMap.get(id.agentKey) : null;
  let replacementUii = null;
  if (agentIds) {
    replacementUii = [...(agentIds.uiis || [])].map(str).find((u) => u && !id.allUiis.has(u)) || null;
    if (!replacementUii) {
      const ext = [...(agentIds.externIds || [])].map(str).find((e) => e && !id.externIds.has(e));
      if (ext) replacementUii = `extern:${ext}`;
    }
  }
  if (replacementUii) {
    return {
      ...base,
      replacementUii,
      shape: "agent-advanced",
      confidence: "high",
      actionable: false, // observe only — the agent is live on a new call
      recommendedAction: "observe-only",
      verdict: "stale-shell",
    };
  }
  // idle shape. NOT actionable when either:
  //  (a) an EMPTY account snapshot with no dequeue corroboration (could be a pause/lull, not a real
  //      release), OR
  //  (b) the snapshot carried active calls but NONE bore an agentId (agentMap empty while the snapshot
  //      is non-empty) -> the agent-advanced check above ran BLIND, so we cannot rule out THIS agent
  //      being live on an unattributable replacement call. Down-rank rather than over-report it idle.
  const agentAdvancedBlind = Boolean(id.agentKey) && agentMap.size === 0 && !emptyAccountSnapshot;
  const lowConfidence = emptyAccountSnapshot && id.dequeueTime == null;
  const notActionable = lowConfidence || agentAdvancedBlind;
  return {
    ...base,
    shape: "idle-stale-shell",
    confidence: lowConfidence ? "low-empty-snapshot" : (agentAdvancedBlind ? "low-agent-visibility" : "high"),
    actionable: !notActionable,
    recommendedAction: notActionable ? "observe-only" : "release-shell-and-observe", // DIAGNOSTIC — not executed
    verdict: "stale-shell",
  };
}

function bump(map, key) {
  const k = str(key) || "unknown";
  map[k] = (map[k] || 0) + 1;
}

// DIAGNOSTIC sweep factory. All I/O injected. runStaleServingDiagnosticOnce performs ZERO mutation —
// it reads serving rows, reads a fresh per-account RingCX snapshot, reads terminal-outbox evidence,
// classifies, LOGS candidates, and returns a structured report.
function createCxStaleServingReconcilerService({
  cxDialQueueRepository, // listQueueItems({states:["serving"], limit})
  terminalEvidence, // async (row) => Boolean — a terminal outbox row already exists for this row
  loadAccountActiveCalls, // async (accountId) => [{uii, externId, agentId, ...}] — throws on a failed read
  resolveAccountId, // optional async (row) => accountId — fallback when the row carries none (e.g. session join)
  evaluateServingActivity, // optional sync/async (row) => {active, reason} — the live-call guard
  logger = console,
  now,
} = {}) {
  if (!cxDialQueueRepository || typeof cxDialQueueRepository.listQueueItems !== "function") {
    throw new Error("cxStaleServingReconcilerService requires cxDialQueueRepository.listQueueItems");
  }
  if (typeof terminalEvidence !== "function") {
    throw new Error("cxStaleServingReconcilerService requires a terminalEvidence(row) function");
  }
  if (typeof loadAccountActiveCalls !== "function") {
    throw new Error("cxStaleServingReconcilerService requires a loadAccountActiveCalls(accountId) function");
  }
  const resolveNow = () => (typeof now === "function" ? now() : now instanceof Date ? now : new Date());

  function buildAccountIndex(calls) {
    const activeUiiSet = new Set();
    const activeExternIdSet = new Set();
    const agentActiveIds = new Map();
    for (const call of Array.isArray(calls) ? calls : []) {
      const u = str(call && call.uii);
      const e = str(call && call.externId);
      const a = str(call && call.agentId);
      if (u) activeUiiSet.add(u);
      if (e) activeExternIdSet.add(e);
      if (a) {
        if (!agentActiveIds.has(a)) agentActiveIds.set(a, { uiis: new Set(), externIds: new Set() });
        const rec = agentActiveIds.get(a);
        if (u) rec.uiis.add(u);
        if (e) rec.externIds.add(e);
      }
    }
    return { ok: true, activeUiiSet, activeExternIdSet, agentActiveIds };
  }

  async function runStaleServingDiagnosticOnce({ staleMinutes, limit, activeSessionIds = [] } = {}) {
    const minutes = Number(staleMinutes) > 0 ? Number(staleMinutes) : DEFAULT_STALE_MINUTES;
    const staleCutoffMs = minutes * 60_000;
    const effectiveLimit = Math.min(Number(limit) > 0 ? Number(limit) : DEFAULT_SCAN_LIMIT, MAX_SCAN_LIMIT);
    const nowDate = resolveNow();
    const activityGuardWired = typeof evaluateServingActivity === "function";

    const rows = await cxDialQueueRepository.listQueueItems({ states: ["serving"], limit: effectiveLimit });
    const serving = Array.isArray(rows) ? rows : [];

    // Resolve each row's RingCX account (top-level rcxAccountId first, then the canonical fallbacks,
    // then an optional injected resolver e.g. session join). Rows with no resolvable account get a
    // DISTINCT skip reason so a missing account is never confused with a failed RingCX read.
    const accountByRow = new Map();
    for (const row of serving) {
      let accountId = resolveServingIdentity(row).accountId;
      if (!accountId && typeof resolveAccountId === "function") {
        try {
          accountId = str(await resolveAccountId(row)) || null;
        } catch (err) {
          logger.warn?.("cx_stale_serving_diagnostic.account_resolve_failed", { id: str(row._id), err: err && err.message });
          accountId = null;
        }
      }
      accountByRow.set(row, accountId || null);
    }

    const accountIds = [...new Set([...accountByRow.values()].filter(Boolean))];
    const snapshots = new Map();
    for (const accountId of accountIds) {
      try {
        snapshots.set(accountId, buildAccountIndex(await loadAccountActiveCalls(accountId)));
      } catch (err) {
        snapshots.set(accountId, { ok: false, error: err && (err.message || String(err)) });
        logger.warn?.("cx_stale_serving_diagnostic.snapshot_read_failed", { accountId, err: err && err.message });
      }
    }

    const activeSessionSet = new Set((Array.isArray(activeSessionIds) ? activeSessionIds : []).map(str).filter(Boolean));
    const report = {
      scannedServing: serving.length,
      truncated: serving.length >= effectiveLimit,
      accountsPolled: accountIds.length,
      accountsFailed: [...snapshots.values()].filter((s) => !s.ok).length,
      agentActivityGuard: activityGuardWired ? "enabled" : "disabled",
      candidateCount: 0,
      actionableCandidateCount: 0,
      byShape: {},
      byConfidence: {},
      skippedCount: 0,
      bySkipReason: {},
      candidates: [],
      checkedAt: nowDate instanceof Date ? nowDate.toISOString() : null,
    };

    for (const row of serving) {
      const id = resolveServingIdentity(row);
      // Never diagnose a row a LIVE session legitimately owns mid-promotion.
      if (id.reservationSessionId && activeSessionSet.has(id.reservationSessionId)) {
        report.skippedCount += 1;
        bump(report.bySkipReason, "owning-session-live");
        continue;
      }
      const accountId = accountByRow.get(row);
      if (!accountId) {
        report.skippedCount += 1;
        bump(report.bySkipReason, "no-account-id"); // distinct from a failed read
        continue;
      }
      const snap = snapshots.get(accountId);
      const snapshotOk = Boolean(snap && snap.ok);

      let hasTerminalEvidence = false;
      try {
        hasTerminalEvidence = Boolean(await terminalEvidence(row));
      } catch (err) {
        report.skippedCount += 1;
        bump(report.bySkipReason, "evidence-check-failed"); // fail-closed: can't confirm "no terminal row"
        logger.warn?.("cx_stale_serving_diagnostic.evidence_check_failed", { id: id.queueItemId, err: err && err.message });
        continue;
      }

      let agentActivity = null;
      if (activityGuardWired) {
        try {
          agentActivity = await evaluateServingActivity(row);
        } catch (err) {
          agentActivity = { active: true, reason: "activity-probe-failed" }; // fail-closed -> skip
          logger.warn?.("cx_stale_serving_diagnostic.activity_probe_failed", { id: id.queueItemId, err: err && err.message });
        }
      }

      const verdict = classifyStaleServingRow({
        row,
        now: nowDate,
        staleCutoffMs,
        snapshotOk,
        activeUiiSet: snap && snap.activeUiiSet,
        activeExternIdSet: snap && snap.activeExternIdSet,
        agentActiveIds: snap && snap.agentActiveIds,
        hasTerminalEvidence,
        agentActivity,
      });

      if (verdict.verdict === "stale-shell") {
        report.candidateCount += 1;
        if (verdict.actionable) report.actionableCandidateCount += 1;
        bump(report.byShape, verdict.shape);
        bump(report.byConfidence, verdict.confidence);
        if (report.candidates.length < CANDIDATE_SAMPLE_CAP) report.candidates.push(verdict);
        logger.info?.("cx_stale_serving_diagnostic.candidate", {
          queueItemId: verdict.queueItemId,
          accountId: verdict.accountId,
          agentKey: verdict.agentKey,
          priorUii: verdict.priorUii,
          ageMs: verdict.ageMs,
          shape: verdict.shape,
          confidence: verdict.confidence,
          actionable: verdict.actionable,
          replacementUii: verdict.replacementUii,
          emptyAccountSnapshot: verdict.emptyAccountSnapshot,
          dequeueTimeSeen: verdict.dequeueTime != null,
          selectedDisposition: verdict.selectedDisposition ? verdict.selectedDisposition.disposition : null,
          proposedOutcome: verdict.proposedOutcome,
          wouldAction: verdict.recommendedAction,
          note: "DIAGNOSTIC-ONLY: no mutation performed",
        });
      } else {
        report.skippedCount += 1;
        bump(report.bySkipReason, verdict.reason);
      }
    }

    logger.info?.("cx_stale_serving_diagnostic.summary", {
      scannedServing: report.scannedServing,
      truncated: report.truncated,
      accountsPolled: report.accountsPolled,
      accountsFailed: report.accountsFailed,
      agentActivityGuard: report.agentActivityGuard,
      candidateCount: report.candidateCount,
      actionableCandidateCount: report.actionableCandidateCount,
      byShape: report.byShape,
      byConfidence: report.byConfidence,
      skippedCount: report.skippedCount,
      bySkipReason: report.bySkipReason,
    });

    return report;
  }

  return { runStaleServingDiagnosticOnce };
}

module.exports = {
  DEFAULT_STALE_MINUTES,
  // pure (exported for offline tests)
  resolveServingIdentity,
  resolveSelectedDisposition,
  collectStoredUiis,
  collectStoredExternIds,
  classifyStaleServingRow,
  // diagnostic sweep
  createCxStaleServingReconcilerService,
};
