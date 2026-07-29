# Sales Trainer Completion Plan

**Date:** 2026-07-29
**Status:** Panel-audited plan (5 seam audits + adversarial synthesis); execution not started
**Parent contract:** SALES_TRAINER_TARGETED_TALK_BUILD_GUIDE_2026-07-28.md
**Product intent (Mickey, 2026-07-29):** "udemy and free call" — Targeted Talk scenario
modules spanning all trainer topics + open Free Call full-process practice, one app.

## ⟳ BUILD STATUS (update as slices land)

- [ ] Slice 0 — commit the trainer working tree (HARD PRECONDITION; models/repos/tests untracked)
- [ ] Slice 1 — Phase A validator hardening + typed AST (needs 2 owner rulings: referent registries, ruleRevision semantics)
- [ ] Slice 2 — Phase B gauntletState + runs-within-attempt (design gate: terminal-fail must not brick the {enrollmentId,itemId} unique index)
- [ ] Slice 3 — Phase C text-only runtime (fake evaluator first; read/mutation gate split)
- [ ] Slice 4 — Phase D Talk Session UI (parallel w/ 3 against extended mock)
- [ ] §20 INTEGRATION GATE — synthetic objection Talk end-to-end, text-only, zero doctrine
- [ ] Slice 5 — Phase E voice body extraction + target-audio cache mechanics
- [ ] Slice 6 — Phase F QA/reflection/Review Coach
- [ ] Slice 7 — Phase G sealed course Free Call
- [ ] Slice 8 — §17 adversarial sweep (11 of 20 missing; #19/#20 need owner definitions)
- [ ] Slice 9 — Phase H real content + pilot (BLOCKED: DG-SOURCE-01/RULE-01/AUDIO-01/CERT-01/LIVE-01)

Topic universe for content derivation: field-manual content (114 entries: objections 38,
strategies 35, psychology 22, script 19; 95 drills) — curriculum derives from it at Slice 9.

---


## 1. WHERE IT STANDS

The platform half of this build is substantially done and battle-tested; the product half barely exists. The course vertical (enroll/home/item/attempt with CAS, eventId idempotency, restart reconciliation, fail-closed flags) is complete and pinned by 118 green tests, and Call Review is a finished vertical whose patterns (generation fencing, citation-or-fail-closed, fresh authorization) are the exact templates the gauntlet needs. What does not exist is everything with "gauntlet" or "free-call course" in its name: no trainingGauntletService, no evaluator, no sealed Free Call adapter, no players, no clients, no gauntlet routes, no typed transition AST, no gauntletState, no TTS cache. The legacy Free Call monolith (4,290-line service + 2,836-line workspace) contains all the raw voice/prospect material as inline code. Critically, **the entire tested trainer layer is untracked in git** — the safety net exists only in this working tree.

| Guide phase | % built | What exists |
|---|---|---|
| A — Static contract | ~40% | 690-ln validator with issue-collector, deterministic-gate, graph-sanity, testOnly fail-closed (validatePublishedTrainingContent.js); enums already include gauntlet/free-call (publishedTrainingContentContracts.js:14-21). Missing: AST, envelope, sections, variants, criteria, audio manifest — string `edge.when` REQUIRED today (:531-533, inverted vs guide) |
| B — Durable state | ~60% | TrainingAttempt/Enrollment models, 4 indexes incl. unique {enrollmentId,itemId} (TrainingAttempt.js:87-93), CAS append with duplicate/conflict triple (trainingCourseRepository.js:162-194), restart reconciliation (trainingCourseService.js:833-907). Missing: gauntletState, 7 event types, expectedTurn, runs, fail/invalidate terminals |
| C — Text runtime | ~5% | Pure prospect-physics reducer (trainerProspectStateService.js) + prompts as raw material. No controller, evaluator, or routes |
| D — Talk UI | ~30% | Course shell/home/rail/player/results + hooks with eventId+CAS discipline (useTrainingAttempt.ts:98-115). No gauntlet/free-call players, clients, resume, or rail-collapse |
| E — Voice body/audio | ~25% | All STT/TTS/VAD/recording/pinning works — inline in two monoliths. Zero extraction, zero cache, opposite readiness posture (opening TTS is best-effort, service:2934-2960) |
| F — Q&A/reflection/Coach | ~15% | reflection_added event + input-bound eventId retry (TrainerAttemptResults.tsx:74-80); two-station observer as advisory pattern. No semantic Q&A, no Review Coach |
| G — Free Call adapter | ~20% | `runSalesTrainerTurn` takes everything as params (good seam, service:3788-3823); recordingStorageService standalone. No sealed session, course prompt, or routes; every §12-banned field currently client-supplied (salesTrainer.js:668-722) |
| H — Content/pilot | 0% | Registries deliberately empty (correct); blocked by DG-SOURCE-01/DG-RULE-01/DG-AUDIO-01 |

---

## 2. THE CRITICAL PATH

Everything through Slice 8 is **BUILDABLE NOW** on synthetic `test-fixture` content — the registry's test-content authority gate (trainingContentRegistry.test.js:33-42) is the §20 mechanism and already enforced. Only Slice 9 is **BLOCKED BY DOCTRINE**.

### Slice 0 — Commit the working tree (precondition, S)
Track everything: `trainer-content/`, TrainingAttempt/TrainingCallReview/TrainingEnrollment, both training repositories, `salesTrainerFeatureFlags.js`, 21 of 22 test files, `tests/fixtures/trainer/`. Add an npm script for `node --test tests/trainer/*.test.js` (directory-arg form fails on this Node/Windows). **Blocked by:** nothing. **Proof:** clean checkout passes the 118-test suite. Nothing else may start before this.

### Slice 1 — Phase A: validator hardening (M, one PR)
**Build:** AST fact/op/combinator enums + detector types + terminal outcomes in `publishedTrainingContentContracts.js`; extend `validatePublishedTrainingContent.js` with typed-AST validation (flip :531-533 to REJECT strings), §6 envelope fields, section confinement, unique-priority/single-fallback, reverse-reachability-to-terminal, bounded cycles, requiredCriteria with revision pinning, variant gate-parity, audio-manifest coverage, learner-projection leak scan; rewrite the fixture blueprint (trainingContentRegistry.fixture.js:94-143) to full §6 shape; new `trainingGauntletContentValidation.test.js`.
**Leans on:** addIssue/collect pattern, `assertRuleRefs` (:170-189), `validateDeterministicGate` (:191-221) — already implements §6.2's core; `DETERMINISTIC_AUTHORITY_TYPES` (:10-13) reused verbatim for hintPolicy.
**Two small rulings needed first (owner decisions, not doctrine gates):** (a) referent registries — persona/factSet/utteranceSet/voiceProfile IDs are homeless; recommend adding minimal registries to the bundle rather than opaque-ID validation; (b) `ruleRevision` semantics — recommend revision == rule.version until DG-RULE-01 says otherwise.
**Proof gate (§16-A):** string `when` fails; cross-section edge fails; unbounded cycle fails; variant with different gates fails; missing target audio fails; synthetic blueprint passes.

### Slice 2 — Phase B: durable controller state (M-L)
**Build:** `gauntletState` subdoc + safe public projection on TrainingAttempt; extend event enum additively (7 `gauntlet_*` types — MUST land before any writer, `runValidators:true` at repo:169 rejects unknowns); extend `appendAttemptEvent` to take projection-set + expectedTurn in the CAS filter (additive params); centralize normalized-payload duplicate comparison in the repo (closes the footgun at repo:183-189); runNumber/retry-run semantics; attempt-level reconstruction from accepted events; gauntlet branch in completion authority with passed/failed/invalidated terminals; wire `gauntletV1Enabled` into `runtimeItemAvailable` (fix the ignored flags arg at trainingCourseService.js:217-219, unlocking `gauntlet` ONLY).
**Leans on:** the accept/duplicate/conflict CAS triple (repo:162-194) mapping 1:1 onto §7.1; `reconcileAcceptedAttemptProjections` (svc:833-907) as the reconstruction pattern; unique request-idempotency indexes.
**Design-before-code:** run semantics vs the unique {enrollmentId,itemId} index (a hard-failed terminal today would permanently brick the item — retries must be runs inside one attempt); pin the version/sequence/turn counter mapping explicitly.
**Proof gate (§16-B):** exact duplicate → same result; dup-ID/changed-payload → 409; stale version/turn → 409; restart reconstructs node/variant/evidence/voice/hint; old run tape survives retry. Clone the course-suite tests at trainingCourseService.test.js:383-486 as the template.
**Blocked by:** Slice 1 (blueprint shape feeds gauntletState).

### Slice 3 — Phase C: text-only Targeted Talk runtime (L)
**Build:** NEW `trainingGauntletService.js` (deterministic controller — do NOT bolt onto the 1,856-ln course service), deterministic detectors, `trainingEvidenceEvaluatorService.js` with a **fake evaluator first**, synthetic prospect adapter, pre-TTS dialogue validator, thin turn/hint/retry routes in salesTrainerCourse.js with a read/mutation gate SPLIT (do not copy `requireFeature()`, which 503s reads — conflicts with §18 mid-attempt readability).
**Leans on:** Slice 2's append+projection CAS; Call Review's citation-or-fail-closed contract (trainingCallReviewTranscriptContract.test.js) as the evaluator template; generation-fenced lease (trainingCallReviewProcessingLease.test.js:37-90) as turn-fencing template; `trainerProspectStateService` pure reducer for prospect disposition.
**Proof gate (§16-C):** model output cannot advance; fake pass with nonexistent citation ignored; Discovery cannot enter close; seeded context ≠ learner evidence; bounded terminal behavior; infra error never penalizes.
**Blocked by:** Slice 2.

### Slice 4 — Phase D: Talk Session UI (L) — can start in parallel with Slice 3 against the mock
**Build:** extend `mock-control-plane.js` with §12 gauntlet endpoints (its rail already lists locked gauntlet/free-call items, :46-60; it 404s the routes, :380-384 — extend the mock, never restart :5001); NEW `lib/api/trainingGauntlet.ts` modeled on trainingCourse.ts's envelope posture (:250-258), NOT on `salesTrainer.ts.turn()` (:465-514, sends every banned field); NEW `TrainerGauntletPlayer.tsx` with text fallback + live transcript; `useGauntletRun` hook with expectedTurn tracking + resume (current `loadItem` discards attempt state, useTrainingAttempt.ts:32-37); wire gauntlet branch in TrainerCoursePlayer.tsx consuming `capabilities.gauntletV1Enabled` (typed-but-unread today, trainingCourse.ts:72); rail collapse (S); talk-first home copy swap (S); **update the regex contract test in the same commit** (trainingCourseFrontendContract.test.js:102-109 hard-asserts the fail-closed string) + new gauntlet frontend contract suite.
**Proof gate (§16-D):** hidden rules never render; refresh resumes the run; rail collapses; text-only completion uses the same controller; draft content fails closed.
**Blocked by:** Slice 2 (API shape); real-backend verification blocked by Slice 3.

### ✅ Integration gate — §20 first executable slice
One test-only synthetic objection Talk (one section, two behaviors, two variants with identical gates, one recoverable miss, one bounded retry) running end-to-end text-only through Slices 1-4. This is the "prove the machine" milestone and requires **zero decision gates**.

### Slice 5 — Phase E: shared voice body + audio mechanics (L overall)
**Backend (S/M each):** extract STT adapter (service:1486-1667, cleanest cut), TTS adapter cluster (:655-750, 1124-1409), turn-artifact recording helper (lift :3899-4156); course routes simply don't accept `recordTurn`/`archiveToDrive`/`audio` options (server recording policy + server-pinned voice on the attempt); keep every legacy export working (§15).
**Frontend (L, highest-risk extraction):** `TrainerVoiceLoop` + `useTrainerAudioSession` + `trainerPlaybackQueue` from the workspace monolith (~20 state vars + ~16 refs, :1365-1447); sever three tangles: `transcribeRecording`'s embedded transport choice/greeting fast-path (:2237-2263), auto-arm gating on phaseNotes/scorecard (:2412-2413), the `<audio>` element living inside `Transcript` (:1301-1320). Preserve StrictMode re-arm (:1516-1529) and 15s stuck-audio safety (:2435-2444) — both load-bearing.
**Target-audio cache (L):** content-addressed store seeded from `normalizeTtsProfile`'s sha256 profileId (:741-749) + provider/model/text/schema-version; all-or-nothing readiness gate (today's posture is the opposite — best-effort non-blocking).
**Proof gate (§16-E):** blank STT retries without a miss (backend half already holds, service:3870-3889); partial fixed TTS invalidates; TTS retry doesn't duplicate the turn; voice pinned across refresh; protected-trait gate parity. **Cache MECHANICS buildable now; production audio blocked by DG-AUDIO-01.**
**Blocked by:** Slice 4 (players to host the voice loop); E5/E7 need Slice 2's durable turn records.

### Slice 6 — Phase F: Q&A, reflection, Review Coach (M/L)
**Build:** server-owned semantic Q&A with cited/versioned grading; reflection-before-feedback ordering; Review Coach with `thingsToConsider` labeling; remediation mapping. **Leans on:** reflection event + eventId-bound retry already durable (svc:1724-1741); Call Review's neutral-error/failed-review-persistence outage handling as the grader-outage template.
**Proof gate (§16-F).** **Blocked by:** Slice 3 (evidence to review). Practice/reflection allowed now; certification semantics blocked by DG-CERT-01.

### Slice 7 — Phase G: sealed course Free Call (L)
**Build:** NEW `trainingFreeCallCourseService.js` — mint session bound to attempt; hold profile/playbook/messages/voice/prospect-state server-side; internally call `runSalesTrainerTurn` with server-held args; 4 thin routes accepting only audio/text + eventId/expectedVersion/expectedTurn; new prompt variant WITHOUT continue/redo pauses (liveTurn.md:211-217), same fail-loud readFileSync pattern; `<UI_*>` tags presentation-only; **expected-turn stamp on observer writes** (both the in-band path :3976-3986 and observer :3357-3362 call `mergeProspectState` and each bumps `turn` — the double-writer race); pin the manifest date at session mint (midnight fragmentation, recordingStorageService:135,448); fail closed on missing sealed state (never the silent fresh-start fallback, :3948-3949); NEW `TrainerFreeCallPlayer.tsx` reusing the voice body (M); post-call cited evaluator writing `transfer` evidence only.
**Proof gate (§16-G):** no gauntlet gates appear; model tags cannot complete/master; stale observer cannot double-advance; absent opportunity → `no_evidence`; legacy unchanged flags-off.
**Blocked by:** Slices 2, 3 (evaluator), 5 (voice body).

### Slice 8 — Adversarial completion sweep (M)
Fill the §17 gaps: 4 of 20 are pattern-proven, 5 partial, 11 missing (tests-flags audit table). Two need **owner definition first**: #19 simulated-DNC (concept exists nowhere in the trainer) and #20 write-isolation. Plus: explicit rollback-retention test, mid-attempt flag-off readable-state test (enabled by Slice 3's gate split).

### Slice 9 — Phase H: real content + pilot — **BLOCKED BY DOCTRINE**
DG-SOURCE-01 (publish rule registry), per-rule DG-RULE-01, DG-AUDIO-01 (production audio), DG-CERT-01 (certification/thresholds), DG-LIVE-01 (live Coach). All engineering (Slices 0-8) proceeds without them; nothing in Slices 0-8 should be deferred waiting on these.

---

## 3. REUSE MAP — the five hats (§5)

| Hat | Existing code | Ruling |
|---|---|---|
| 1. Prospect | liveTurn.md dialogue behavior + `trainerProspectStateService` pure physics (trust ±1, monotonic disclosure, :109-166) + TTS persona cluster | Physics reducer: keep and lean on (tested). Prompt: source material only — strip its judge/health/scorecard authority for course use |
| 2. Evaluator | Call Review citation contract ("findings must cite existing timestamped segments") + fail-closed-on-unknown-evidence | Pattern to clone into new `trainingEvidenceEvaluatorService`; nothing to extract |
| 3. Controller | The CAS/idempotency/reconciliation machinery in trainingCourseService + repository | Keep as course-shell authority; NEW `trainingGauntletService` owns turns, built ON the repo's CAS core (keep + extend, never replace) |
| 4. Live Coach | Two-station observer (service:3313-3371) + versioned UI-state polling | Advisory PATTERN only — its prospect-memory write path needs the staleness guard first; deployment blocked by DG-LIVE-01 |
| 5. Review Coach | Reflection event plumbing + Call Review's analysis/remediation shape | Pattern; build new in Slice 6 |
| Voice (cross-hat) | STT/TTS/chunking/recording adapters (inline), frontend VAD/recorder/playback/pinning | Extract-and-reuse, legacy exports preserved (§15) |
| Never port | Client-carried messages/profile/playbook/provider/turnNumber/recording-policy; `promptVariant:"full"` escape hatch (route:696); `gradeDrill` referenceAnswer; model-authored phase/health/scorecard authority; auto-`continue` countdown (:1622-1635) | Replace — these are exactly §12's banned surface |

---

## 4. LANDMINES

1. **Untracked safety net** — models, repos, flags, trainer-content, 21/22 test files exist only in this working tree. *Mitigation:* Slice 0 is a hard precondition; verify with clean-checkout test run.
2. **Terminal-fail bricks the item** — unique {enrollmentId,itemId} + `findOrCreateAttempt` returning existing docs (repo:131-139) means a hard-failed attempt can never get a second doc. *Mitigation:* design runs-within-attempt before ANY failed/invalidated terminal ships (Slice 2 design gate).
3. **Repo duplicate check ignores payload** (repo:183-189) — a forgetful new writer silently returns `duplicate:true` on changed payloads. *Mitigation:* centralize the comparator in the repo (Slice 2 delta 6) before any gauntlet writer exists.
4. **`runtimeItemAvailable` ignores its flags arg** (:217-219) — naively adding types to `ACTIVE_COURSE_ITEM_TYPES` unlocks gauntlet AND free-call with no flag check. *Mitigation:* per-type flag honor; free-call stays locked until Slice 7.
5. **`requireFeature()` gates reads** — copying it into the gauntlet service makes §18's "mid-attempt readable" impossible. *Mitigation:* read/mutation split from day one (Slice 3).
6. **Double-writer prospect ledger** — in-band tag path and observer both merge and bump `turn`. *Mitigation:* expected-turn stamps + stale rejection before the sealed adapter uses either (Slice 7, §16-G proof).
7. **Frontend extraction endangers the rollback path** — the legacy Free Call is the mandated flags-off rollback; StrictMode re-arm and stuck-audio safety are load-bearing; playback advance is DOM-`onEnded`-driven. *Mitigation:* extract behind the flag, keep legacy transports byte-identical, pin with the currentBehavior suite; playback queue must own its element story.
8. **Regex contract test goes red on wiring** (trainingCourseFrontendContract.test.js:102-109). *Mitigation:* revise in the same commit as Player dispatch changes.
9. **Silent restart amnesia** (service:3948-3949) would invisibly corrupt an assessed run. *Mitigation:* sealed adapter fails closed on missing state; never inherit the fresh-start fallback.
10. **Manifest append is unlocked read-modify-write** (recordingStorageService:439-466) + date-keyed midnight split. *Mitigation:* eventId idempotency gates before persistence; session date pinned at mint.
11. **Validator cost on every bundle resolution** (svc:179) — new passes are free while content is empty; matters once real blueprints publish. *Mitigation:* flag for a cached-validation decision in Slice 3, don't solve now.
12. **:5001 is a mock; live ops on this box** — extend the mock for UI dev, verify backend via the test suite by name-pattern batches, never restart ops services or the real control plane.
13. **STT-fatal asymmetry** (:3852-3868) — timeouts throw turn-level errors; only blank transcripts are soft. *Mitigation:* STT-retryable semantics in course turn handling (Slice 5), client never auto-submits an empty turn with a fresh eventId.

---

## 5. GIT/DEPLOY HYGIENE — a real workstream

**Now (Slice 0):** commit the whole trainer layer on cx-round-2. The dependency clusters are all-or-nothing — models + repositories + services + flags + tests must land in one sweep or any deploy breaks at boot (prompts and services `readFileSync` at module load, prompt.js:29,56 — a partial commit fails loud, which is at least honest). Per worktree memory: Claude worktrees spawn off master while the live system runs cx-round-2 + drift — every future slice must rebase/import drift first or it builds against a tree with ~0% of the trainer.

**Continuously:** each extraction slice (E1-E3, §14.1) sweeps its full dependency cluster in one commit with legacy exports preserved; the currentBehavior + prospect-state suites are the regression tripwire.

**Linux move (fold into Slices 0/5/7, not after):**
- **Paths:** recordings root (`PARALLEL_RECORDINGS_ROOT`, recordingStorageService:72-75) and prompt-file loads must be path.join'd and case-correct — Linux is case-sensitive; audit `require`/`readFileSync` casing across the trainer cluster when committing.
- **Test runner:** the `node --test tests/trainer/*.test.js` glob vs directory-arg behavior differs by platform; the npm script added in Slice 0 should shell-glob portably (or use `node --test --test-name-pattern` batches, which also dodges the 3 known hanging runtime tests).
- **Service management:** the 8 Manual-start nssm services are Windows-only; the Linux target needs systemd units with the same deliberate-start doctrine (never auto-start ops). Flag env parity: none of the three `SALES_TRAINER_*_V1_ENABLED` keys exist in `.env` (correct = off), but `parseBooleanFlag` accepts `yes`/`on` — add an env audit to the move checklist so a stray value doesn't flip a feature on the new box.
- **Sequencing:** do the move BEFORE Phase H pilot enablement — you do not want first-real-content and first-new-OS in the same change window.

**Bottom line:** Slices 0-4 get you to the §20 "prove the machine" milestone with zero doctrine decisions and only two small owner rulings (referent registries, ruleRevision semantics). Slices 5-8 complete the §21 definition of done except real content. Slice 9 waits on the five decision gates — and on nothing else.