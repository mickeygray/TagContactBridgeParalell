export const meta = {
  name: 'cx020-scrub-to-end-all-scrubs',
  description: 'Verify each known CX 0.2.0 blocker against CURRENT code + fresh adversarial sweep for new defects; produce the definitive confirmed-open list with exact fixes',
  phases: [
    { title: 'VerifyKnown', detail: 'one reader per known blocker: still OPEN in current code, or FIXED?' },
    { title: 'Sweep', detail: 'fresh adversarial finders over the whole rail for NEW defects' },
    { title: 'VerifySweep', detail: 'adversarially verify each new candidate' },
    { title: 'Synthesize', detail: 'definitive confirmed-open list + exact current fixes + test needs' },
  ],
}

const ROOT = 'C:/code/tagcontactbridgeparalell'
const SS = 'packages/shared-services/src'

const COMMON = [
  'You are running the DEFINITIVE deep scrub of the CX 0.2.0 bulk-load rail at ' + ROOT + '. GROUND EVERYTHING',
  'IN CURRENT CODE — Read the actual files, cite file:line, quote the offending line VERBATIM as it stands NOW.',
  'The full test suite currently passes (208/0) and the rail advanced well past the prior audit (docs/',
  'CX_0_2_0_DEEP_SCRUB_AUDIT_GUIDE_2026-06-25.md §20.8), so many prior blockers may ALREADY be fixed — and',
  'tests-green does NOT mean fixed (several sites are untested). Do not trust the guide\'s line numbers; re-find',
  'the real current line. The rail files (under ' + SS + ' unless noted): cxBulkLoadRuntime.js,',
  'cxBulkLoadRuntimeService.js, cxBulkLoadStateMachine.js, cxBulkLoadLeadSourceService.js,',
  'cxBulkLoadOutcomeAdapter.js, cxBulkLoadRingcxPublisher.js, cxBulkLoadActiveCallWatcher.js,',
  'cxBulkLoadMutationEligibility.js, cxQueueReservationService.js, cxReserveModeService.js,',
  'cxQueuePolicyService.js, cxQueueFairnessService.js, cxReservationReconcilerService.js,',
  'cxTerminalOutboxDrain.js, cxTerminalRectificationService.js, cxAccountActiveCallWatcherService.js;',
  'tests under tests/cx-bulk-load/.',
].join('\n')

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['blocker', 'status', 'currentEvidence', 'fixIfOpen', 'testNeed'],
  properties: {
    blocker: { type: 'string' },
    status: { type: 'string', enum: ['OPEN', 'FIXED', 'PARTIAL'] },
    currentEvidence: { type: 'string', description: 'the exact current line(s) + file:line proving the status' },
    fixIfOpen: { type: 'string' },
    testNeed: { type: 'string' },
  },
}

const KNOWN = [
  { key: 'reconciler-merge', prompt: 'KNOWN BLOCKER: reconciler metadata-merge + evidence-error-release. Read cxReservationReconcilerService.js fully. (a) Is the CAS-adopted row merged with the original row\'s metadata before terminalEvidence/completeCxQueueItem/releaseReserved (the `adoptedRow = {...row, ...adopted, metadata:{...row.metadata, ...adopted.metadata}}` shape)? (b) On a terminalEvidence() THROW after adoption, does the catch RELEASE the adopted row (not just log) — i.e. no adopt-then-strand? Report OPEN/FIXED with the current lines.' },
  { key: 'release-guard', prompt: 'KNOWN BLOCKER: releaseReserved missing-session guard. Read cxQueueReservationService.js releaseReserved. Does it still pass `metadata.reservationSessionId ?? null` (or undefined) into the CAS match — releasing a row it may not own when the field is missing? Or does it now skip+log rows with no metadata.reservationSessionId before calling transitionQueueItemState()? Also: are existsForLead()/UCQ-interlock errors fail-CLOSED (release as unsafe) or do they keep the row?' },
  { key: 'reservemode-policy', prompt: 'KNOWN BLOCKER: reserveMode policy bypass. Read cxReserveModeService.js. (a) Does green-first assign the full deficit to fresh-day1 WITHOUT checking open("fresh-day1")/fresh.eligible? (b) Does the aged floor apply even when the policy is DISABLED? Report current lines + status.' },
  { key: 'outcome-idemkey', prompt: 'KNOWN BLOCKER: outcome idem key too coarse. Read cxBulkLoadOutcomeAdapter.js idem-key builder. (a) Does `qid && u` return `${qid}:${u}` IGNORING eventType (so terminal + DNC/appointment corrections collide)? (b) Is UII dropped when qid is absent? (c) Is recordCadenceEvent() null result reported as written:true instead of written:Boolean(result && result.written!==false)? Report status + current lines.' },
  { key: 'publisher-guards', prompt: 'KNOWN BLOCKER: publisher accept-unsent + cancel guard. Read cxBulkLoadRingcxPublisher.js. (a) Does publish map the RingCX result against input.candidates (the ORIGINAL list) rather than the uploadable subset, so a phone/externId-less candidate can be marked accepted though RingCX never received it? (b) Does cancelBatchForSession require a campaignId? Report status + current lines.' },
  { key: 'drain-scan-crash', prompt: 'KNOWN BLOCKER: drain scan-failure crash. Read cxTerminalOutboxDrain.js. Does listPendingForDrain() rejection bubble and abort the drain (no try/catch around the scan), or is the scan wrapped to return {scanned:0,drained:0,failed:0,scanError:true} and normalize non-array→[]? Report status + current lines.' },
  { key: 'watcher-serialization', prompt: 'KNOWN BLOCKER: watcher/refill per-session serialization (double-reserve). Read cxBulkLoadRuntimeService.js watchAccountActiveCalls + maybeRefill + the command mutation tail (withSessionMutation/promise-tail). Does maybeRefill() run via beforePersist OUTSIDE the per-session command mutation tail, so two overlapping watchAccountActiveCalls() ticks can double-reserve? Or is the apply/refill now routed through the same per-session tail? Report status + current lines.' },
  { key: 'missing-tests', prompt: 'KNOWN BLOCKER: missing test files. Confirm tests/cx-bulk-load/cxBulkLoadRuntime.test.js AND cxBulkLoadMutationEligibility.test.js EXIST and are non-trivial (what do they cover?). If present, status FIXED; note any obvious coverage gap (route-boundary start/off-hook gate for runtime; __v/updatedAt/busy/stale/matched for eligibility).' },
]

const FIND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['angle', 'findings'],
  properties: {
    angle: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'line', 'summary', 'failureScenario'],
        properties: {
          file: { type: 'string' },
          line: { type: 'string' },
          summary: { type: 'string' },
          failureScenario: { type: 'string' },
        },
      },
    },
  },
}

const SWEEP_ANGLES = [
  { key: 'A-line-by-line', prompt: 'ANGLE A — line-by-line correctness across the rail. For each function ask what input/state/timing makes a line wrong: inverted/wrong condition, off-by-one, null/undefined deref, missing await, falsy-zero (a count/index of 0 treated as absent), wrong-variable copy-paste, error swallowed in catch, unescaped regex. Up to 8 NEW candidates (NOT the known-8 below).' },
  { key: 'B-concurrency-state', prompt: 'ANGLE B — concurrency, ordering & state-machine correctness. The rail has a per-session command tail, a watcher loop, refill, reservations with CAS, an outbox drain, a reconciler. Hunt: races beyond the known watcher/refill one, CAS guards that match null/missing fields, lost-update on session state clones, idempotency-key collisions, cursor/advance bugs, double-fire on terminal. Up to 8 NEW candidates.' },
  { key: 'C-cross-file-contract', prompt: 'ANGLE C — cross-file contract & call-site correctness. For each changed/public function find callers (Grep) and check the call breaks on a new precondition/return-shape/exception; check callees a parallel change makes unsafe; check repository method signatures match (existsForLead/transitionQueueItemState/listPendingForDrain/recordCadenceEvent/completeCxQueueItem). Up to 8 NEW candidates.' },
  { key: 'D-fail-closed-boundaries', prompt: 'ANGLE D — fail-closed boundaries & money/queue safety. This rail dials real leads + writes RingCX/Logics/cadence. Hunt places that should fail CLOSED but fail open: a thrown/null check that keeps a row dialable, a guard that lets a lead publish/cancel/count wrongly, a terminal outcome that double-counts or never counts, a DNC that reaches metrics but not the drain/Logics path, an off-hook gate that lets a non-bulk or already-active agent start. Up to 8 NEW candidates.' },
  { key: 'E-cleanup-altitude', prompt: 'ANGLE E — dead path / fragile-bandaid / altitude. Flag: dead/superseded paths still wired (snapshotCandidates/normalizeQueueRow per the guide), special-cases layered on shared infra that should be generalized, copy-paste drift, a guard added at the wrong depth. Concrete cost in failureScenario (what is dead/duplicated/fragile), not a crash. Up to 8 candidates.' },
]

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'reason', 'evidence'],
  properties: {
    status: { type: 'string', enum: ['CONFIRMED', 'PLAUSIBLE', 'REFUTED'] },
    reason: { type: 'string' },
    evidence: { type: 'string' },
  },
}

phase('VerifyKnown')
const known = (await parallel(KNOWN.map((k) => () =>
  agent(COMMON + '\n\n' + k.prompt, { label: 'verify-known:' + k.key, phase: 'VerifyKnown', schema: VERIFY_SCHEMA })
    .then((v) => ({ key: k.key, ...v }))))).filter(Boolean)

phase('Sweep')
const swept = await pipeline(
  SWEEP_ANGLES,
  (a) => agent(
    COMMON + '\n\nEXCLUDE the known-8 blockers (reconciler-merge, releaseReserved-guard, reserveMode-policy, ' +
    'outcome-idemkey, publisher-guards, drain-scan-crash, watcher-refill-serialization, missing-test-files) — ' +
    'find NEW defects only.\n\n' + a.prompt,
    { label: 'sweep:' + a.key, phase: 'Sweep', schema: FIND_SCHEMA },
  ),
  (res, a) => {
    const fs = (res && Array.isArray(res.findings)) ? res.findings : []
    if (!fs.length) return { angle: a.key, findings: [] }
    const checks = fs.map((f) => () =>
      agent(
        COMMON + '\n\nADVERSARIALLY VERIFY this candidate against current code. CONFIRMED only with the exact ' +
        'line + trigger; REFUTED if guarded/wrong (quote the guard); PLAUSIBLE if real but config/timing.\n\n' +
        'FILE: ' + f.file + '\nLINE: ' + f.line + '\nCLAIM: ' + f.summary + '\nSCENARIO: ' + f.failureScenario,
        { label: 'verify-sweep:' + a.key, phase: 'VerifySweep', schema: VERDICT_SCHEMA },
      ).then((v) => ({ ...f, angle: a.key, verdict: v })))
    return parallel(checks).then((arr) => ({ angle: a.key, findings: arr.filter(Boolean) }))
  },
)

const newAll = swept.filter(Boolean).flatMap((r) => r.findings || [])
const newConfirmed = newAll.filter((f) => f.verdict && f.verdict.status !== 'REFUTED')
const knownOpen = known.filter((k) => k.status !== 'FIXED')
log('known: ' + known.filter(k=>k.status==='OPEN').length + ' OPEN / ' + known.filter(k=>k.status==='PARTIAL').length + ' PARTIAL / ' + known.filter(k=>k.status==='FIXED').length + ' FIXED · new: ' + newAll.length + ' found / ' + newConfirmed.length + ' survived verify')

const SYNTH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['oneLineVerdict', 'pilotReady', 'confirmedOpen', 'alreadyFixed', 'refutedNew'],
  properties: {
    oneLineVerdict: { type: 'string' },
    pilotReady: { type: 'boolean' },
    confirmedOpen: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['rank', 'title', 'severity', 'location', 'why', 'fix', 'testNeed'],
        properties: {
          rank: { type: 'number' },
          title: { type: 'string' },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          location: { type: 'string' },
          why: { type: 'string' },
          fix: { type: 'string' },
          testNeed: { type: 'string' },
        },
      },
    },
    alreadyFixed: { type: 'array', items: { type: 'string' } },
    refutedNew: { type: 'array', items: { type: 'string' } },
  },
}

phase('Synthesize')
const verdict = await agent(
  COMMON + '\n\nYou are the SYNTHESIZER for the definitive CX 0.2.0 scrub. Below: the verify of each known' +
  ' blocker (OPEN/FIXED/PARTIAL) + the NEW sweep findings with verdicts. Produce the definitive list. ' +
  'confirmedOpen = every KNOWN blocker still OPEN/PARTIAL + every NEW finding CONFIRMED/PLAUSIBLE, each with the' +
  ' EXACT current location + the minimal fix + the test that locks it; ranked by floor-safety (a lead dialed/' +
  ' counted/published wrongly, or a row stranded, outranks cleanup). alreadyFixed = known blockers now FIXED.' +
  ' refutedNew = sweep candidates refuted. pilotReady = true only if confirmedOpen has no blocker/major. Be' +
  ' exact and honest — this drives real code fixes.\n\n' +
  'KNOWN VERIFY:\n' + JSON.stringify(known, null, 2) +
  '\n\nNEW CONFIRMED/PLAUSIBLE:\n' + JSON.stringify(newConfirmed.map((f) => ({ file: f.file, line: f.line, summary: f.summary, scenario: f.failureScenario, verdict: f.verdict.status, why: f.verdict.reason })), null, 2),
  { label: 'synthesize', phase: 'Synthesize', schema: SYNTH_SCHEMA, effort: 'high' },
)

return { verdict, known, newConfirmed, refutedCount: newAll.length - newConfirmed.length }
