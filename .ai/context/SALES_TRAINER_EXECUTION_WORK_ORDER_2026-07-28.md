# Sales Trainer Course, Gauntlet, and Call Review Execution Work Order

**Date:** 2026-07-28  
**Status:** Ready to execute Phases 0-3 locally; later content and real-call enablement remain decision-gated  
**Companion design:** `.ai/context/SALES_TRAINER_CURRICULUM_AND_CALL_REVIEW_DESIGN_2026-07-28.md`  
**Scope:** Local Sales Trainer course shell, durable learning records, section-bounded Gauntlets, Free Call integration, results/remediation, and the disabled-by-default Call Review bridge  
**Not authorized:** Live deployment, Windows service start/restart, production data access, CX/RingCX mutation, operational DNC mutation, employee discipline, or certification based only on model output

## 1. Mission and implementation decision

Turn the existing Trainer frontend into one course-driven learning system without discarding the working voice simulator.

The implementation strategy is additive:

1. Preserve the current `SalesTrainerWorkspace` behavior as the legacy Free Call implementation.
2. Add a server-owned, versioned course spine behind a default-off feature flag.
3. Make `/trainer` the canonical course home when the flag is enabled.
4. Reuse the current simulator inside the course as `TrainerFreeCallPlayer` before behaviorally refactoring it.
5. Build Gauntlet as a separate deterministic runtime. Do not implement it as a `drill:` prompt or a flag on the current Free Call conversation.
6. Build Call Review behind an independent default-off flag. Do not enable real-recording access until ownership, privacy, retention, and speaker-confidence gates pass.
7. Retain the old Study and My Calls paths as a rollback surface until their replacements are proven. Do not physically delete them during this work order.

The product loop remains:

```text
Learn
  -> retrieve
  -> recognize
  -> say the move
  -> targeted Gauntlet
  -> Free Call transfer
  -> real-call review
  -> remediation
```

Knowledge, guided execution, transfer, and real-call evidence are separate mastery dimensions. No one dimension may silently stand in for another.

## 2. Authority and fail-closed rules

### 2.1 Content authority

The authority order is:

1. Mickey's direct rulings.
2. The original Tax Resolution Script, or a specifically approved faithful extraction.
3. Model-generated interpretation and coaching.

Only sources 1 and 2 may create a required rule or deterministic failure gate. Model-generated material must be labeled as a "thing to consider" and cannot unlock, certify, fail, discipline, or mutate an operational record by itself.

### 2.2 Runtime authority

- The server owns published course content, canonical answers, rubrics, rule versions, prerequisites, unlocks, mastery, remediation, and attempt state.
- The browser owns presentation and user input only.
- The model may generate natural dialogue and structured evidence proposals.
- The deterministic controller owns Gauntlet progression and pass/fail.
- A grader finding without cited support remains advisory.
- Unknown speaker identity or low-confidence transcription cannot produce a confirmed agent violation.
- Trainer DNC judgment is a learning record only. It never changes an operational DNC record.
- Trainer state must never mutate live-call state.

### 2.3 Existing-work protection

The Trainer files already contain uncommitted live-test recovery work. Before editing, inspect and preserve the current diffs in:

- `apps/control-plane/src/routes/salesTrainer.js`
- `apps/web-client/src/lib/api/salesTrainer.ts`
- `apps/web-client/src/workspaces/trainer/SalesTrainerWorkspace.tsx`
- `packages/shared-services/src/taxResolutionSalesTrainerService.js`

In particular, preserve:

- two-station observer and UI-state polling;
- legacy single-station Coach fallback;
- current voice-session startup and fixed-voice behavior;
- mic/VAD/STT/TTS and hands-free behavior;
- the collapsed in-call setup surface and morphing mic control;
- StrictMode microphone cleanup fixes;
- recording-manifest creation;
- current model-selection defaults and options.

Do not rebase this work on `HEAD`, reset the worktree, or delete the legacy surfaces.

## 3. Current state being transformed

| Current surface | Evidence | Required treatment |
|---|---|---|
| Three local tabs: Practice, Study, My Calls | `SalesTrainerWorkspace.tsx` | Replace with course navigation only when the course flag is on. Keep the old shell as rollback. |
| Large voice simulator | `SalesTrainerWorkspace.tsx` and `taxResolutionSalesTrainerService.js` | Wrap first as `TrainerFreeCallPlayer`; preserve behavior. |
| Study generated in the browser from the Field Manual | `TrainingCenterPanels.tsx` | Reuse reading components, but load version-pinned items from the server. |
| Browser sends `referenceAnswer` to the grader | `TrainingCenterPanels.tsx`, `salesTrainer.ts`, `salesTrainer.js` | Replace with server-owned `itemId`, `attemptId`, and rubric version. |
| Learner/session state in component state and process-memory maps | `SalesTrainerWorkspace.tsx`, `taxResolutionSalesTrainerService.js` | Add durable enrollment and append-only attempt records. Keep transient voice session state separate. |
| No distinct Gauntlet runtime | Current `mode` and `drill:` behavior | Add `experienceMode` independently from `direction`; create a separate controller. |
| My Calls accepts a raw Drive file ID | `TrainingCenterPanels.tsx`, `salesTrainer.js` | Disable when Call Review v1 is on; replace with opaque, reauthorized source IDs. |
| Existing scorer grades lead quality | `transcriptionScoringService.js` | Do not reuse as the agent-performance authority. |
| Recording library is folder scoped | `readCx.js` | Do not call it "personal" until authenticated-user ownership is proved server-side. |
| Domain-specific settlement-officer IDs exist | `UserAccount.js`, `userAccountRepository.js` | Reload the authenticated account inside the source service; do not rely on the reduced normal Trainer principal. |
| Metrics/nightly code parses Logics assignment events and finds PhoneBurner/CallRail recordings | `activityEventService.js`, `nightPassService.js`, `nightRecordingsService.js` | Reuse the assignment/download primitives only after extracting bounded, provider-neutral seams. Do not reuse notable-call selection or lead-quality scoring. |
| `CallLog` supports domain/case lookup and durable recording metadata | `CallLog.js`, `callLogRepository.js` | Use it as the case-to-call join and server-held recording locator; return only opaque source IDs. |
| No direct Logics “cases by settlement officer” API exists locally | `logicsClient.js`; `CaseInfo` lacks the officer field | Build a durable domain-scoped assignment projection from a cap-safe historical baseline plus incremental reassignment/unassignment events before exposing real cases. |
| "Your stats" is placeholder UI | `SalesTrainerWorkspace.tsx` | Replace with durable enrollment/mastery data. |

The existing Field Manual remains an independent reference library. Course items may link to curated, version-pinned excerpts but must not derive their canonical rubric from mutable browser content at runtime.

## 4. Feature flags and rollback contract

Add independent, server-configured, default-off booleans:

```text
SALES_TRAINER_COURSE_V1_ENABLED=false
SALES_TRAINER_GAUNTLET_V1_ENABLED=false
SALES_TRAINER_CALL_REVIEW_V1_ENABLED=false
```

Expose only the resolved booleans to the browser through the existing safe runtime-config path. Never expose provider credentials or private policy configuration.

Flag behavior:

- Course off: render the current three-tab Trainer exactly as it behaves before this work.
- Course on, Gauntlet off: render Course Home, lessons, quizzes, reflection/results, and legacy Free Call. Gauntlet items remain visibly locked/unavailable.
- Gauntlet on: allow only published, approved Scenario Blueprints.
- Call Review off: do not expose the new source picker or review actions.
- Call Review on: hide/disable the raw Drive-ID scoring action and use only the new opaque source contract.

Rollback is flags-off. Collections and immutable published definitions remain; no rollback performs deletion or data rewriting.

## 5. Single owners and file boundaries

### 5.1 Static published definitions

Create server-owned definitions under:

```text
packages/shared-services/src/trainer-content/
  ruleRegistry.v1.js
  courseManifest.v1.js
  scenarioBlueprints/
  validatePublishedTrainingContent.js
```

Rules, manifests, and blueprints are immutable after publication. A correction creates a new version. Draft content may be stored in source but the validator must reject any draft rule referenced by a deterministic gate.

`validatePublishedTrainingContent.js` owns structural validation:

- globally unique IDs;
- version presence;
- source authority and citations;
- company/direction overlays;
- item references;
- prerequisite graph without cycles;
- no draft rule in required grading;
- Scenario Blueprint node/edge validity;
- all 32 script beats covered exactly once by the 28 approved bundle mappings.

It does not decide learner state.

### 5.2 Durable course service

Create:

```text
packages/shared-services/src/trainingCourseService.js
```

This is the single decision owner for:

- enrollment creation and version pinning;
- resume target;
- item availability;
- answer grading orchestration;
- attempt completion;
- four-dimensional mastery;
- remediation assignment;
- next-item selection.

Models, repositories, routes, and React components remain thin and do not independently decide unlock, mastery, or remediation.

### 5.3 Gauntlet controller

Create:

```text
packages/shared-services/src/trainingGauntletService.js
```

This is the single decision owner for:

- current blueprint node;
- required evidence;
- allowed transitions;
- hint level;
- retry and terminal state;
- section boundary;
- expected-turn compare-and-swap.

The prospect model returns dialogue plus proposed evidence labels. It never selects the next node or determines pass/fail.

### 5.4 Call Review source and processing services

Create:

```text
packages/shared-services/src/trainingCallReviewSourceService.js
packages/shared-services/src/trainingCallReviewService.js
```

`trainingCallReviewSourceService.js` is the single decision owner for:

- fresh `UserAccount` reload and domain-specific settlement-officer identity;
- building and refreshing the current Logics assignment projection;
- safe assigned-case and case-call discovery;
- source reauthorization;
- source fingerprinting;
- provider/Drive allowlisting and bounded recording retrieval;
- opaque source capability creation and resolution.

`trainingCallReviewService.js` is the single decision owner for:

- processing generation;
- transcript/diarization/redaction versions;
- evidence confidence;
- immutable findings;
- reflection and remediation handoff.

The source service never grades. The review service never independently decides case assignment or accepts a client locator. The assignment projection model/repository remain thin. The existing lead-quality transcription scorer is neither service; only its transport/transcription implementation ideas may be extracted after timestamp preservation is proved.

### 5.5 Thin route modules

Keep legacy endpoints in `apps/control-plane/src/routes/salesTrainer.js`. Add and mount thin modules:

```text
apps/control-plane/src/routes/salesTrainerCourse.js
apps/control-plane/src/routes/salesTrainerGauntlet.js
apps/control-plane/src/routes/salesTrainerCallReview.js
```

Every route derives learner identity and company from the authenticated server principal. It never trusts a client-supplied learner email, company, role, course version, rule version, answer key, rubric, source locator, or mastery value.

### 5.6 Frontend modules

Add:

```text
apps/web-client/src/workspaces/trainer/
  TrainerCourseShell.tsx
  TrainerCourseHome.tsx
  TrainerCoursePlayer.tsx
  TrainerCurriculumRail.tsx
  TrainerLessonItem.tsx
  TrainerQuizItem.tsx
  TrainerGauntletPlayer.tsx
  TrainerFreeCallPlayer.tsx
  TrainerAttemptResults.tsx
  TrainerCallReviewWorkspace.tsx
  hooks/useTrainingEnrollment.ts
  hooks/useTrainingAttempt.ts
  hooks/useTrainerAudio.ts

apps/web-client/src/lib/api/
  trainingCourse.ts
  trainingGauntlet.ts
  trainingCallReview.ts
```

Keep `salesTrainer.ts` as the legacy Free Call API during migration. Do not mix new course authority into its existing client contracts.

## 6. Durable records and mutation rules

Add exports in `packages/shared-models/src/index.js` for the following additive models.

### 6.1 `TrainingEnrollment`

Minimum fields:

```text
enrollmentId
learnerEmailNormalized
companySnapshot
courseId
courseVersion
rulePackVersion
status
resumeItemId
itemStates[]
masteryByRule {
  knowledge
  guidedExecution
  transfer
  realCallEvidence
}
activeRemediation[]
version
createdAt
updatedAt
```

Indexes:

- unique: `learnerEmailNormalized + courseId + courseVersion`;
- lookup: `learnerEmailNormalized + status + updatedAt`;
- lookup: `companySnapshot + courseId + courseVersion`.

The server derives normalized email from the authenticated principal. Company is snapshotted at enrollment. Cross-company rule reuse is prohibited unless an approved overlay explicitly allows it.

### 6.2 `TrainingAttempt`

Minimum immutable identity:

```text
attemptId
enrollmentId
learnerEmailNormalized
companySnapshot
courseId/courseVersion
itemId/itemVersion
itemType
rulePackVersion
ruleIds[]
blueprintId/blueprintVersion/variantId (when applicable)
recordingManifestRef (when applicable)
createdAt
```

Mutable behavior is append-only through versioned events:

```text
events[] {
  eventId
  sequence
  type
  occurredAt
  expectedPriorVersion
  safe payload
  grader/model provenance when applicable
}
version
terminalSummary
```

Indexes:

- unique: `attemptId`;
- unique: `attemptId + events.eventId` or equivalent idempotency ledger;
- lookup: `enrollmentId + itemId + createdAt`;
- lookup: `learnerEmailNormalized + createdAt`.

Rules:

- Every mutation supplies an idempotency key and `expectedVersion`.
- Duplicate event IDs return the already-accepted result.
- Stale expected versions return HTTP 409 and do not append.
- Observed evidence is never overwritten by reflection or later model analysis.
- Attempts pin all content, scenario, prompt, and grader versions used.

### 6.3 `TrainingCallReview`

Minimum fields:

```text
reviewId
learnerEmailNormalized
companySnapshot
callLogId
opaqueRecordingSourceId
recordingFingerprint
authorizedSourceSnapshot {
  domain
  settlementOfficerIdentityFingerprint
  assignmentAuthority
  assignmentObservedAt
  assignmentSnapshotVersion
  opaqueCaseFingerprint
  callIdentityFingerprint
  provider
  callStartedAt
  recordingLocatorFingerprint
}
status
reviewGeneration
transcriptEngineVersion
diarizationVersion
rulePackVersion
graderPromptVersion
modelVersion
redactedSegments[]
findings[]
reflection
remediation
retentionClass
version
createdAt
updatedAt
```

`authorizedSourceSnapshot` is immutable evidence of the server authorization decision. It contains no raw Logics case ID, provider URL, Drive ID, extension/provider identity exposed to the browser, customer data, or transcript text. The raw recording locator remains server-only.

Indexes:

- unique: `reviewId`;
- unique: `learnerEmailNormalized + recordingFingerprint + reviewGeneration`;
- unique idempotency key for processing requests;
- lookup: `learnerEmailNormalized + status + updatedAt`.

Visible latest-generation pointers update only with expected-generation compare-and-swap. Temporary media must be deleted in a `finally` path, with deletion evidence recorded without local paths, provider IDs, customer data, or transcript text.

### 6.4 `LogicsCaseAssignmentProjection`

This additive, server-only projection is the authorization bridge missing from the current runtime. Minimum fields:

```text
domain
caseId
canonicalSettlementOfficerIdentity
assignmentState: assigned | unassigned | ambiguous
lastAssignmentEventId
lastAssignmentEventAt
assignmentAuthority: logics-assignment-activity
baselineVersion
projectionVersion
updatedAt
```

Indexes:

- unique: `domain + caseId`;
- lookup: `domain + canonicalSettlementOfficerIdentity + assignmentState`;
- lookup: `domain + lastAssignmentEventAt`.

Seed it from the cap-safe historical ActivityReport gatherer, sort events deterministically, preserve explicit unassignment, and then update it incrementally. Never rebuild all history on every UI request. A name maps to an officer only when the domain roster produces exactly one canonical identity. Ambiguous, missing, stale, or unsupported mappings fail closed.

## 7. API contract

All new endpoints are under `/api/sales-trainer`. Existing Free Call endpoints remain unchanged until their adapter phase.

| Method and path | Purpose | Client may send | Server-owned response/decision |
|---|---|---|---|
| `GET /course/home` | Load current course/enrollment | Optional course alias | Pinned versions, progress, remediation, resume target, capabilities |
| `POST /enrollments` | Idempotently enroll | Course alias, request ID | Learner/company identity, published versions, enrollment |
| `GET /course/:courseId/items/:itemId` | Load one available item | IDs from prior server response | Sanitized item; never answer key or rubric |
| `POST /attempts` | Start an item attempt | Item ID, request ID | Pinned attempt identity and version |
| `POST /attempts/:attemptId/answers` | Submit quiz/say-it answer | Answer, event ID, expected version | Grade evidence, attempt version; canonical item/rubric stays server-side |
| `POST /attempts/:attemptId/complete` | Complete eligible attempt | Event ID, expected version | Terminal result, mastery delta, next assignment |
| `POST /attempts/:attemptId/reflection` | Add learner reflection | Reflection, event ID, expected version | Appended reflection; never rewrites observed grade |
| `GET /attempts/:attemptId/results` | Load tape/results | Attempt ID | Authorized evidence, Coach read, mastery, remediation |
| `POST /gauntlet/attempts/:attemptId/turns` | Submit one Gauntlet turn | Audio/text, event ID, expected turn/version | Accepted transcript, evidence proposal, controller state, target audio reference |
| `GET /call-review/cases` | List cases currently assigned to the learner's Logics settlement-officer identity | Safe filters/cursor only | Opaque case IDs and minimal safe metadata after fresh account/assignment resolution |
| `GET /call-review/cases/:caseSourceId/calls` | List calls for one still-authorized assigned case | Opaque case source ID and cursor | Opaque recording source IDs, safe call metadata, and eligibility/status; never provider URLs or Drive IDs |
| `POST /call-reviews` | Start/reuse a review | Opaque source ID, request ID | Review ID/status after server reauthorization |
| `GET /call-reviews/:reviewId` | Poll/load review | Review ID | Authorized immutable generation and evidence |
| `POST /call-reviews/:reviewId/reflection` | Add reflection | Reflection, event ID, expected version | Appended reflection and remediation handoff |

Required status behavior:

- 401: no authenticated Trainer principal;
- 403: principal exists but does not own/qualify for the resource;
- 404: unavailable IDs are not disclosed;
- 409: stale version, generation, or turn;
- 422: malformed or ineligible transition;
- 503: feature disabled or required provider unavailable.

Never return answer keys, private rubrics, raw provider payloads, raw recording locators, tokens, local file paths, or unredacted customer data.

## 8. Frontend routes and navigation

When Course v1 is enabled:

```text
/trainer
  Course Home: Continue, section progress, remediation, next checkpoint

/trainer/course/:courseId/item/:itemId
  Curriculum rail and item player

/trainer/attempt/:attemptId/results
  Tape, self-reflection, Coach read, mastery, assigned next rep

/trainer/call-review
  Assigned cases → calls → Review action, processing states, completed reviews, evidence player
```

The visible “link” for a call is an application Review action. Clicking it posts an opaque source ID; the server reauthorizes and performs the download. It is never a direct recording-provider link.

`/cx/coach` must not become a second independent course implementation. It should route to or embed the same canonical Trainer shell while preserving its existing authentication entry.

Resume order:

1. active required remediation;
2. in-progress required item;
3. first available required item;
4. optional practice.

The frontend must render server-provided locked/available/completed state. It must not reproduce prerequisite or mastery decisions locally.

## 9. Proof-gated implementation phases

### Phase 0 - Baseline, contracts, and flags

Tasks:

1. Capture `git status` and diffs for every touched Trainer file.
2. Record the current stopped/running service and port state without starting anything.
3. Run the existing Trainer test and web build before behavioral edits.
4. Add the three default-off feature flags and safe runtime booleans.
5. Add static-definition schemas and the content validator.
6. Add contract fixtures for a test-only course. Do not publish business doctrine in the fixture.
7. Add characterization tests around existing Free Call start, direction, voice lock, turn flow, two-station Coach state, scorecard, and recording manifest.

Proof gate:

- Flags off preserve current visible behavior and existing API behavior.
- Existing Trainer prospect-state test passes.
- `npm run build:web` passes.
- Content validator rejects duplicate IDs, cyclic prerequisites, missing sources, missing versions, uncovered/duplicate script beats, and draft rules in deterministic gates.
- No service restart or live deployment occurred.

Rollback: flags remain off; remove no old code.

### Phase 1 - Durable course spine

Tasks:

1. Add the Phase 1 course models and indexes; defer the Call Review and assignment-projection models until Phase 6.
2. Implement `trainingCourseService.js`.
3. Implement course home, enrollment, item, attempt, answer, completion, reflection, and result route contracts.
4. Keep canonical question, reference answer, rubric, and unlock rules out of browser payloads.
5. Pin enrollment and attempt versions.
6. Implement event idempotency and expected-version compare-and-swap.

Proof gate:

- Editing a browser request cannot change the canonical answer or rubric.
- Duplicate submissions create one event and return one result.
- Stale submissions return 409 without state change.
- Learner A cannot read or mutate Learner B.
- A process restart preserves enrollment, resume item, and attempts.
- Publishing a new manifest/rule version does not rewrite an in-progress enrollment.
- Route tests and model-index tests pass.

Rollback: Course flag off; additive collections retained.

### Phase 2 - Course shell and lesson/quiz player

Tasks:

1. Add canonical nested routes and the shared Trainer course shell.
2. Build Course Home and curriculum rail from server state.
3. Reuse the existing reading presentation in `TrainerLessonItem`.
4. Build server-owned quiz/say-it submission.
5. Add persistent progress, resume, results, reflection, and remediation UI.
6. Keep a clearly labeled legacy-practice entry while proof accumulates.
7. Preserve `/trainer` OTP behavior and `/cx/coach` authenticated behavior.

Proof gate:

- Flag off still renders the old three-tab shell.
- Flag on supports deep links and browser refresh.
- Two browser sessions recover the same server resume target.
- Browser history and back/forward navigation do not duplicate attempts.
- Locked items cannot be opened by URL manipulation.
- Keyboard focus, labels, loading, retry, empty, and error states are usable.
- `npm run build:web` passes.
- UI proof is paired with API response and Mongo record/version evidence; UI state alone is insufficient.

Rollback: Course flag off.

### Phase 3 - First Learn-to-Answer vertical slice

Tasks:

1. Use only an approved published rule subset. If none is approved, use test-only fixture content with the user flag off.
2. Implement one lesson, retrieval questions, recognition items, and say-it items.
3. Persist grade evidence and provenance.
4. Apply one remediation assignment and verify resume precedence.
5. Prove the reflection-before-Coach feedback sequence.

Proof gate:

- Every attempt contains pinned rule/item/grader versions.
- Model interpretation cannot directly unlock an item.
- Reflection cannot overwrite observed execution.
- Remediation becomes the next resume target deterministically.
- Test-only content cannot appear when the user-facing flag is on.

Rollback: Course flag off; no content deletion.

### Phase 4 - Section-bounded Gauntlet

Entry requirements:

- Gauntlet flag remains off until a Scenario Blueprint references only approved, published rules.
- If business doctrine is not approved, controller mechanics may be proven only with a test fixture.

Tasks:

1. Separate `direction` (`inbound`, `outbound`) from `experienceMode` (`gauntlet`, `free`) in all new contracts.
2. Add immutable Scenario Blueprint definitions and variants.
3. Implement controller-owned node, evidence, hint, retry, and terminal state.
4. Use expected-turn and expected-version compare-and-swap.
5. Keep the model limited to dialogue and structured evidence proposals.
6. Pin a server-selected voice for the attempt.
7. Pre-generate or content-address all target audio for an assigned variant.
8. Make target audio all-or-nothing: one missing/failed target invalidates the attempt.
9. Stop at the local section objective. A Discovery Gauntlet cannot proceed to a purchase.

Proof gate:

- Replays vary wording/persona but test identical required evidence.
- The model cannot advance or pass the attempt.
- A stale or duplicated turn cannot double-advance.
- The attempt cannot cross its declared script-section boundary.
- A meaningful prospect reaction follows a failed move.
- Hint escalation follows the configured ladder and is recorded.
- One audio-generation failure invalidates rather than silently mutates the attempt.
- Approved variant-count mastery rules are enforced only after their certification decision gate.

Rollback: Gauntlet flag off; legacy Free Call unaffected.

### Phase 5 - Existing simulator as Free Call transfer

Tasks:

1. Extract/wrap the current voice cockpit as `TrainerFreeCallPlayer` without an initial behavioral rewrite.
2. Map a Free Call course item to the existing session and recording manifest.
3. Persist attempt lifecycle and post-call evidence around the legacy voice runtime.
4. Map supportable findings to published `ruleId`s.
5. Show tape and self-reflection before full Coach feedback.
6. Keep Free Call natural: no artificial phase locks or Gauntlet gates.
7. Keep model-emitted `UI_*` tags presentation-only.

Proof gate:

- Existing inbound/outbound, voice, VAD, STT, TTS, hands-free, Coach ownership, and recording behavior remains green.
- Free Call never uses Gauntlet progression.
- Out-of-order observer completion cannot double-advance mastery.
- The same supported behavior maps to the same rule ID used in lessons and Gauntlets.
- Free Call completion/reflection does not become certification unless the certification gate is separately approved.

Rollback: Course flag off returns to the legacy workspace.

### Phase 6 - Call Review bridge

Build behind the Call Review flag; do not enable it merely because code exists.

Tasks:

1. Reload `UserAccount` from the authenticated principal and resolve the domain-specific settlement-officer ID; missing, ambiguous, unsupported, and accountless Trainer identities fail closed.
2. Build and prove the durable latest Logics assignment projection from a cap-safe historical baseline plus incremental assignment, reassignment, and unassignment events.
3. Return currently assigned cases as opaque case source IDs.
4. Join an authorized domain/case through `listCallLogsByCaseId(domain, caseId)` and return only safe call metadata plus opaque `recordingSourceId` values.
5. Reauthorize current assignment, call membership, recording eligibility, and review access on every list/create/read/play/segment request.
6. Extract a bounded provider-neutral recording download adapter from the Metrics retrieval path. Start with the approved PhoneBurner/CallRail allowlist; keep EX excluded and broad Drive-folder membership unauthorized unless a later gate approves otherwise.
7. Make the Review click idempotently start or reuse a server job: download, fingerprint, timestamp-preserving transcription, diarization, redaction, and Trainer rule grading.
8. Create immutable, generation-pinned Review records with an authorization snapshot.
9. Separate case-assignment access from agent-performance attribution; unattributed/other-agent evidence cannot silently grade the learner.
10. Store cited findings with rule/version and confidence.
11. Add evidence playback, learner reflection, and remediation.
12. Delete temporary media in a `finally` path.
13. Disable the broad recording library/raw Drive-ID scorer when the new flag is enabled.

Enablement gate:

- Visibility, consent, transcription, retention, redaction, and deletion policy are approved.
- Authenticated settlement-officer identity reload and company/domain isolation are proved.
- The assignment projection proves current case ownership across baseline, reassignment, and unassignment; a short ActivityReport window alone is insufficient.
- Case-to-CallLog membership and server-held recording eligibility are proved; folder membership alone is insufficient.
- Reassignment between listing and clicking fails closed on reauthorization.
- The allowed provider set and download security limits are configured.
- Personalized performance findings require confident agent attribution under the approved policy; otherwise they are `ineligible` or `uncertain`.
- Diarization/ASR provider and fail-closed confidence thresholds are configured.
- Every confirmed finding cites and plays a real segment.
- The cited quote is present in that segment.
- Unknown/low-confidence speaker evidence can only be `uncertain`.
- Duplicate async processing is idempotent.
- A stale generation cannot replace a newer visible result.
- No model-only result can affect employment, pay, discipline, or certification.
- Temporary-file cleanup is proved without logging customer data.

Rollback: Call Review flag off; legacy scorer retained but not promoted as agent coaching.

### Phase 7 - Live Coach alignment

This is a separate release after local Trainer and Review proof.

Tasks:

1. Read the same published rule versions and safe mastery context.
2. Map supported observations to the same `ruleId`s.
3. Keep advice advisory and silence/HOLD first-class.
4. Measure whether assigned remediation improves later simulated and real-call evidence.

Proof gate:

- The same supported behavior maps to the same rule ID in Trainer, Call Review, and Live Coach.
- Trainer writes cannot mutate live-call state.
- Live Coach does not certify or impose disciplinary consequences.

## 10. Decision gates

The companion design reuses some `Q` identifiers for answered and unanswered text. Those duplicated IDs are traceability notes only. This work order uses the unique gates below.

| Gate ID | Status | Blocks | Does not block |
|---|---|---|---|
| `DG-SOURCE-01` | Pending | Publishing Rule Registry v1 | Flags, schemas, models, test fixtures, course shell |
| `DG-RULE-01` | Per-rule pending | Any deterministic rule depending on unresolved design Q05-Q17 or Q33-Q41 | Unrelated approved rules and platform work |
| `DG-CERT-01` | Pending | Certification, pass thresholds, skip/override behavior | Learning, practice, reflection, pilot progress |
| `DG-REVIEW-01` | Pending | Enabling real-call review | Disabled pipeline and synthetic tests |
| `DG-OWNERSHIP-01` | Mechanism selected; proof pending | Showing or reviewing real recordings | Simulated-call review and disabled source-contract tests |
| `DG-AUDIO-01` | Pending configuration | Production Gauntlet audio | Text/controller tests |
| `DG-LIVE-01` | Pending separate authorization | Live Coach alignment/deployment | All local Trainer work |

### `DG-SOURCE-01`

A named approver must confirm either:

- `packages/shared-services/src/taxGroupScript.js` is the accepted faithful canonical extraction; or
- the original script document is supplied and a verified extraction replaces/supersedes it.

### `DG-RULE-01`

Resolve only the rules entering the next authoring slice. Do not block platform work on every unanswered doctrine question.

Affected areas include:

- identity, trade name, title, disclosures, and lead provenance;
- clear DNC/revocation and persistence limits;
- prerequisites for sensitive data and payment;
- prohibited outcome, savings, timeline, activation, and service claims;
- credentials, forms, representation, and tax/legal escalation;
- mandatory discovery facts and ordering;
- price, scope, payment plans, recurring charges, and card-on-file;
- differentiation/proof sources, privacy/security wording, callbacks, and SLAs;
- instant-fail versus recoverable Gauntlet behavior.

### `DG-CERT-01`

Before certification is enabled, decide:

- pass thresholds by item type;
- required wording variants;
- Free Call unlock behavior;
- real-call evidence effect;
- skip-ahead rules;
- manager override authority and audit trail.

Safe pilot default: certification off; quizzes and approved Gauntlets may record learning progress; early Free Calls require completion and reflection only.

### `DG-REVIEW-01` and `DG-OWNERSHIP-01`

Before Call Review is enabled, decide and prove:

- who may view a review;
- consent and recording/transcription rules;
- retention, redaction, and deletion;
- speaker-confidence thresholds;
- whether an officer may grade every call on an assigned case or only calls confidently attributed to that officer;
- current-assignment versus at-call-assignment policy;
- TAG/WYNN first-slice scope versus an added, authoritative AMITY settlement-officer identity;
- manager visibility;
- the initial approved provider set;
- verified source authorization through the selected chain:

```text
authenticated learner
→ freshly loaded company-specific settlement-officer identity
→ current Logics assignment
→ domain/case
→ CallLog call
→ eligible server-held recording locator
```

Safe defaults for disabled-pipeline development:

- trainee-selected calls from currently assigned cases only;
- trainee-only visibility;
- PhoneBurner/CallRail only; EX and broad Drive folders excluded;
- access to a case call does not imply learner-performance attribution;
- model findings never consequential;
- uncertain speaker evidence fails closed;
- company overlays remain isolated.

## 11. Named verification battery

Run at the relevant phase; do not start stopped Windows services to satisfy a gate.

Baseline:

```powershell
git status --short
node --test tests/trainer/trainerProspectState.test.js
npm run build:web
```

Add these tests as their phases are implemented:

```text
tests/trainer/trainingContentRegistry.test.js
tests/trainer/trainingCourseService.test.js
tests/trainer/trainingCourseRoutes.test.js
tests/trainer/trainingEnrollmentAuthorization.test.js
tests/trainer/trainingAttemptIdempotency.test.js
tests/trainer/trainingQuizTamperRejection.test.js
tests/trainer/trainingGauntletController.test.js
tests/trainer/trainingGauntletBoundary.test.js
tests/trainer/trainingCallReviewAuthorization.test.js
tests/trainer/trainingCallReviewAssignmentSources.test.js
tests/trainer/trainingCallReviewReassignment.test.js
tests/trainer/trainingCallReviewOpaqueSource.test.js
tests/trainer/trainingCallReviewProviderDownload.test.js
tests/trainer/trainingCallReviewIdempotency.test.js
tests/trainer/trainingCallReviewAgentAttribution.test.js
tests/trainer/trainingCallReviewEvidence.test.js
tests/trainer/trainingCallReviewCleanup.test.js
```

Call Review tests also assert that:

- no raw Logics case ID, recording URL, Drive ID, local path, transcript, or customer data leaks through list/create/error responses or logs;
- every source is reauthorized after reassignment;
- duplicate clicks reuse one processing generation;
- timestamped segments survive transcription into cited review evidence;
- downloads enforce provider, HTTPS/host, redirect, size, and timeout limits;
- unsupported/ambiguous settlement-officer identity and uncertain agent attribution fail closed.

Every implementation phase reports:

1. exact files changed;
2. feature-flag state;
3. tests/commands and exit status;
4. API contract evidence;
5. durable-record/version evidence when applicable;
6. browser evidence when applicable;
7. unresolved decision gates;
8. rollback action.

No phase passes on UI appearance alone.

## 12. Completion definition

This work order is complete only when:

- the current Free Call experience remains available and regression-proved;
- `/trainer` is a durable course home;
- lessons/quizzes use server-owned content and rubrics;
- enrollments and attempts survive restart and enforce authorization/idempotency;
- Gauntlet is a separate, deterministic, section-bounded runtime;
- Free Call records transfer evidence without artificial gates;
- results require self-reflection before full Coach teaching;
- mastery is separated into knowledge, guided execution, transfer, and real-call evidence;
- Call Review, if enabled, discovers only currently assigned Logics cases, joins their calls through `CallLog`, uses opaque authorized sources, downloads server-side, and produces cited fail-closed evidence;
- the same published `ruleId` vocabulary is used across Trainer, Review, and later Live Coach;
- no unresolved rule was embedded as a deterministic company requirement;
- no legacy code was physically deleted without later explicit approval;
- no live deployment or Windows service restart was performed under this work order without separate authorization.

## 13. Immediate next action

Begin Phase 0 only:

1. preserve and characterize the current Trainer WIP;
2. add default-off flags;
3. define/validate static contracts using test-only content;
4. add regression coverage;
5. run the baseline proof battery;
6. stop and report the Phase 0 gate before creating durable learner records.


## 14. 2026-07-28 Case Review execution amendment

Mickey subsequently authorized local implementation beyond the Phase 0 stop
gate. This amendment is authoritative for the Case Review slice and supersedes
older provider and assignment-source assumptions in this work order.

### Locked request and ownership contract

1. `POST /api/sales-trainer/call-review/case-calls` accepts only a validated
   Logics domain and positive case number.
2. The decision-owning service makes one case-scoped `getActivities(caseId)`
   call and folds the latest created `Assigned to Set. Officer` activity.
3. Non-admin access requires exact normalized equality with the freshly loaded
   company-specific Logics name. Latest unassignment, missing/ambiguous
   chronology, missing identity, or mismatch denies neutrally.
4. Only `role === "admin"` bypasses assignment comparison. Admin requests still
   require exact domain/case/CallLog membership.
5. No broad activity report or assignment projection participates in this
   path.

### Locked call-source contract

- Query CallLog by exact domain and case with `includeLegacy: false`.
- Return only connected EX, PhoneBurner, and CallRail calls whose actual
  duration is at least 300 seconds.
- Browser-visible identifiers are opaque and bound to learner, domain, case,
  and exact call.
- EX is listable but analyzable only through an exact telephony-session-bound
  provider lookup.
- CallRail requires an exact provider call ID.
- PhoneBurner requires its exact persisted call-end recording URL.
- Broad Drive libraries, broad EX session/day recordings, phone-only matching,
  client-supplied provider locators, and client-supplied Drive IDs are
  prohibited.

### Locked review contract

- Reauthorize on list, Analyze, and saved-review read.
- Persist one versioned processing generation per learner, exact recording
  fingerprint, transcription version, rule-pack version, and analysis version.
- Preserve timestamped transcript segments and cite them in findings.
- The original Tax Resolution Script and direct Mickey rulings are binding
  rules. All model-only additions are returned under the exact label
  `thingsToConsider`.
- Duplicate Analyze requests reuse the in-flight/current generation; a
  compatible cached transcript may be reused without re-transcription.
- Temporary media is removed in `finally` paths.
- Responses never expose phone numbers, customer data, Logics IDs, CallLog IDs,
  provider locators, Drive IDs, local paths, tokens, or raw upstream payloads.

### Rollout boundary and proof gate

- `SALES_TRAINER_CALL_REVIEW_V1_ENABLED` remains default off.
- Flag off preserves the existing My Calls UI and legacy endpoint as rollback.
- Flag on replaces the third Trainer tab with Case Review and disables the raw
  Drive-ID scoring path.
- Verification is synthetic/injected. Do not use live cases or recordings.
- No live deployment, Windows/Linux service restart, or destructive cleanup is
  authorized by this amendment.

The first implementation gate is:

```powershell
node --test tests/trainer/trainingCallReviewAuthorization.test.js tests/trainer/trainingCallReviewReassignment.test.js tests/trainer/trainingCallReviewOpaqueSource.test.js tests/trainer/trainingCallReviewRoutes.test.js tests/trainer/trainingCallReviewSourceContract.test.js tests/trainer/trainingCallReviewTranscriptContract.test.js
npm run build:web
```

## 15. 2026-07-28 local implementation checkpoint

**State:** The first Case Review implementation gate is complete locally. Real-recording enablement remains blocked, and `SALES_TRAINER_CALL_REVIEW_V1_ENABLED` stays off.

### Implemented and proved

- Default-off routing preserves My Calls and the legacy scorer as the rollback surface.
- Every request reloads the authenticated account and performs one case-scoped activity read; only a freshly loaded `admin` bypasses the assignment comparison.
- Exact nonlegacy CallLog membership, five-minute connected-call eligibility, and fresh list/Analyze/read authorization are enforced.
- EX, PhoneBurner, and CallRail use exact provider evidence; broad Drive, nearby-call, phone-only, and client-locator matching are rejected.
- Browser identifiers are short-lived opaque capabilities bound to learner, domain, case, and exact call.
- Provider retrieval is HTTPS/host/redirect/size/time/content bounded and removes temporary media in `finally`.
- Versioned review persistence is idempotent, reclaims stale processing leases, fences stale generations, and privately retains the source needed for saved-review reauthorization.
- Timestamped transcript evidence, authoritative Script Review findings, and separately labeled `thingsToConsider` are represented in the API and Case Review UI.

### Synthetic verification

- The exact Section 14 command passes: 28 tests, 0 failures.
- The complete Trainer suite passes: 84 tests, 0 failures.
- `npm run build:web` passes its safety check, TypeScript check, and production Vite build.
- No live case, recording, deployment, environment mutation, or service restart was used.

### Required before real-recording enablement

1. Approve visibility, consent, retention, deletion, and redaction policy; then prove customer-data redaction before persistence, model submission, and learner display.
2. Decide whether case owners may review all case calls or only their own, and add explicit learner-to-recorded-agent attribution tests before any result may represent learner performance.
3. Separate the locator/capability fingerprint from a SHA-256 fingerprint of the verified downloaded media bytes, with changed-media and rotated-locator tests.
4. Persist an immutable, non-public authorization snapshot containing the company, assignment authority/observation time, and safe identity/case fingerprints.
5. Move download, transcription, and grading from the synchronous request into a durable queued job while preserving the existing lease and generation fencing.
6. Remove the DNS-check/fetch rebinding gap by pinning the validated public address while preserving TLS hostname verification, with a rebinding test.
7. Deliberately configure and verify provider host allowlists and the dedicated source-capability secret before enablement.

Until every applicable item above is decided and proved, the Call Review flag must remain false.

## 16. 2026-07-28 Phase 1-2 local course checkpoint

**State:** The durable course spine and Udemy-style course shell mechanics are
complete locally. `SALES_TRAINER_COURSE_V1_ENABLED` remains default off, the
production course bundle remains an empty draft, and Phase 3 business-content
publication has not started.

### Implemented and proved

- `TrainingEnrollment` and `TrainingAttempt` persist pinned learner, company,
  course, item, rule-pack, request, event, and optimistic-version state with
  the required unique and lookup indexes.
- `trainingCourseService.js` is the single owner of enrollment, availability,
  resume order, server-owned grading, completion, mastery, remediation, and
  next assignment.
- Thin course routes derive identity and company from freshly authorized
  Trainer state. Browser payloads cannot supply a learner, company, course
  version, answer key, rubric, unlock, mastery, or remediation decision.
- Enrollment and attempt mutations are idempotent and operation-bound.
  Expected-version conflicts fail without appending, and concurrent attempt
  starts converge on one pinned item attempt.
- Accepted completion and answer events repair an interrupted enrollment
  projection after a process restart. Reconciliation revalidates the pinned
  course, item, type, version, rule pack, rule IDs, learner, and company before
  applying any projection.
- Catalog selection chooses the exact explicit enrollment default before
  validating it. A malformed declared default fails closed instead of falling
  back to an older valid course version.
- The shared shell supports canonical deep links under both `/trainer/*` and
  `/cx/coach/*`, with Course Home, progress/resume, curriculum rail,
  lesson/quiz/say-it players, results, reflection, remediation, loading,
  retry, empty, and error states.
- Course-off behavior preserves the legacy three-tab Trainer exactly. Course-on
  behavior keeps a clearly labeled legacy Free Call entry while proof
  accumulates.
- Canonical answers, accepted answers, rubrics, prerequisite rules, and private
  content authority never cross the course API boundary. Unsupported
  later-phase item types remain locked and fail closed.

### Local files in this checkpoint

- `packages/shared-models/src/TrainingEnrollment.js`
- `packages/shared-models/src/TrainingAttempt.js`
- `packages/shared-repositories/src/trainingCourseRepository.js`
- `packages/shared-services/src/trainingCourseService.js`
- `apps/control-plane/src/routes/salesTrainerCourse.js`
- `apps/web-client/src/lib/api/trainingCourse.ts`
- `apps/web-client/src/workspaces/trainer/TrainerCourseShell.tsx`
- `apps/web-client/src/workspaces/trainer/TrainerCourseHome.tsx`
- `apps/web-client/src/workspaces/trainer/TrainerCurriculumRail.tsx`
- `apps/web-client/src/workspaces/trainer/TrainerCoursePlayer.tsx`
- `apps/web-client/src/workspaces/trainer/TrainerLessonItem.tsx`
- `apps/web-client/src/workspaces/trainer/TrainerQuizItem.tsx`
- `apps/web-client/src/workspaces/trainer/TrainerAttemptResults.tsx`
- `apps/web-client/src/workspaces/trainer/hooks/useTrainingEnrollment.ts`
- `apps/web-client/src/workspaces/trainer/hooks/useTrainingAttempt.ts`

The shared model/repository/service indexes, the existing Trainer router and
workspace, outer application routes, test-only content fixtures, content
validator, and Trainer contract tests also received the minimal additive
integration changes required by these files.

### Synthetic verification

- The complete Trainer suite passes: 118 tests, 0 failures.
- The focused course slice passes: 33 tests, 0 failures.
- Backend JavaScript syntax checks pass.
- `npm.cmd run build:web` passes build safety, TypeScript, and the production
  Vite build with 2,169 modules transformed.
- Scoped whitespace/diff checks are clean.
- No live data, deployment, environment mutation, service restart, or
  production-content publication was used.

### Rollback and next gate

- Rollback remains `SALES_TRAINER_COURSE_V1_ENABLED=false`; additive records and
  immutable definitions are retained.
- `DG-SOURCE-01` remains pending. Before publishing the first real lesson,
  Mickey must approve `packages/shared-services/src/taxGroupScript.js` as the
  faithful canonical extraction or provide the original document for a
  verified replacement.
- Gauntlet remains a later, independently flagged deterministic runtime. No
  conversational prompt path has been mislabeled as Gauntlet.
