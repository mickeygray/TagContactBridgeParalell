# PhoneBurner Recording Capture Recovery Work Order

Date: 2026-08-03
Owner: Codex, under Mickey's live-floor direction
Status: DESIGN READY; IMPLEMENTATION NOT STARTED
Parent phase: Provider-neutral lead delivery Phase 9 controlled-floor hardening
Scope: restore exact PhoneBurner recording-link capture and carry it through the existing call evidence pipeline

## Build status

```text
PR-0 durable contract and measured baseline        COMPLETE (this document)
PR-1 pure callback URL extraction                  NOT STARTED
PR-2 monotonic event-evidence upgrade              NOT STARTED
PR-3 DailyDial and CallLog projection proof        NOT STARTED
PR-4 report and trainer consumption hardening      NOT STARTED
PR-5 local regression gate                         NOT STARTED
PR-6 targeted Linux deployment                     COMPLETE (2026-08-03)
PR-7 live callback canary                          ACTIVE
PR-8 controlled-floor observation and closeout     NOT STARTED
```

No provider mutation, Mongo mutation, service restart, or deployment is authorized merely by creating this work order.

## 0. Mandatory re-read and handoff rule

Before every implementation turn:

1. Read this file end to end.
2. Read `AGENTS.md`, `.ai/context/PROJECT_HANDOFF.md`, and
   `.ai/context/CODEX_RECOVERY_NOTES.md`.
3. Re-read
   `.ai/context/PHONEBURNER_PROVIDER_NEUTRAL_LEAD_DELIVERY_WORK_ORDER_2026-07-10.md`.
4. Inspect `git status --short`; preserve unrelated dirty-tree work.
5. State in commentary:
   `Re-read PhoneBurner work orders; active phase: Phase 9 / PR-N`.
6. Do not print or persist raw callback bodies, recording URLs, phone numbers,
   customer data, provider identities, credentials, or tokens in test/live
   evidence.
7. Complete the named proof gate before advancing.
8. At handoff report the phase, files changed, tests, count-only evidence,
   assumptions, next phase, and whether any configuration remains blank.

This is a contained recording-evidence recovery lane. It does not create a new
lead-delivery owner, attempt counter, scheduler, queue, or provider writer.

## 1. Objective

Restore this exact chain for every identity-backed PhoneBurner call:

```text
PhoneBurner callback
  -> select the first valid provider recording URL from the observed aliases
  -> durably capture only normalized recording evidence
  -> monotonically strengthen the exact call event
  -> add the URL to the already-counted DailyDial attempt
  -> project it to the exact PhoneBurner CallLog
  -> make the recording available to authorized reports and trainer review
```

The attempt and its business outcome must still be counted exactly once. A
recording arriving late is evidence about the existing attempt, not a second
call and not permission to replay DNC, cadence, terminal, refill, or Logics
effects.

## 2. Measured evidence baseline

### 2.1 Historical working evidence

Read-only archaeology on 2026-08-03 established:

- the useful historical window is April 2026, not June-August 2025;
- `rb_contactactivities` contains 688 PhoneBurner-marked calls from
  2026-04-09 through 2026-04-29;
- 109 of those rows contain a real HTTPS MP3 recording URI hosted by
  PhoneBurner;
- 84 of the 109 also have completed transcripts;
- all 109 URLs use one provider host;
- a bounded HEAD check against one historical URL still succeeded;
- the evidence was written during the original call window, not by the
  2026-08-03 audit.

The old RingBridge flow queued recording work at call end, waited for provider
finalization, retrieved recording evidence, downloaded audio for transcription,
and stored the returned URI in `transcription.recordingUri`.

The historical database is evidence that PhoneBurner recording URLs existed
and were useful. It must not be bulk-copied into current collections without
exact case/call authorization.

### 2.2 Current broken evidence

The current provider-neutral callback route is a strict whitelist. The measured
post-permission-reset callback population had:

- normal `call_done` traffic;
- zero persisted `safePayload.recordingUrl` values;
- zero projected PhoneBurner recording URLs;
- no observed dedicated `recording` or `recording_ready` callback traffic;
- recording-related field names present on every observed callback in the
  diagnostic sample.

The observed safe field names include:

```text
recording_url
recording_url_public
recording_link
recording_link_public
```

Only field names were retained. Values were not recorded by the diagnostic.

### 2.3 API polling is not the recovery path

Read-only testing of six agent-owned dial session identities through the
currently authenticated service account returned not-found results. Agents dial
on their own PhoneBurner seats, so a shared service token cannot be assumed to
enumerate their sessions or recover recordings after the fact.

`recordingId` remains useful opaque evidence, but it is not a URL and it does
not make an inaccessible session readable. Callback URL capture is the primary
recovery path. Seat-scoped API backfill is optional future work and cannot be a
definition-of-done dependency here.

## 3. Root cause

The current capture expression has two independent defects:

1. It does not examine the measured `recording_link`,
   `recording_link_public`, or `recording_url_public` aliases.
2. It uses one nullish-coalescing expression before URL validation. If an early
   field exists as an empty string or bare recording ID, that invalid value can
   prevent a later alias containing the real HTTPS URL from being examined.

This is a selection bug, not merely one missing field name. The correction must
iterate candidates and return the first candidate that independently passes
the complete URL policy.

The downstream chain is largely present already:

- event strengthening recognizes a newly supplied recording URL;
- `recordDailyDialOffload()` retains a URL on an existing exact attempt;
- DailyDial-to-CallLog projection writes PhoneBurner provider and source URI;
- reports and trainer review already understand persisted PhoneBurner evidence.

Implementation should repair and prove those seams rather than build a new
recording subsystem.

## 4. Non-goals

This work does not:

- change lead selection, allocation, pool sizing, refill, daily caps, or
  PhoneBurner folder behavior;
- add a scheduler, timer process, queue, collection, attempt counter, or second
  event drain;
- restore RingCX or EX recording behavior;
- infer call ownership by phone number;
- retain raw PhoneBurner payloads;
- download or permanently copy every recording;
- automatically transcribe every recording;
- make recording availability block Call End acknowledgement or business
  outcome processing;
- wire the currently unreliable service-account session backfill into a
  scheduled runtime;
- bulk-migrate legacy April recordings;
- expose recording URLs in client list payloads, routine logs, health output,
  checkpoints, test snapshots, or error messages.

## 5. Architecture laws

### 5.1 One call, one outcome, strengthen-only recording evidence

The exact provider call ID plus exact provider contact/external identity owns
the attempt. A later callback may fill a previously absent recording URL or
recording ID. It may not:

- append another attempt;
- increment daily or total counts;
- move `callEndedAt` backward;
- weaken a stronger disposition;
- reopen a terminal lead;
- rerun downstream business actions;
- create another CallLog.

Recording evidence is monotonic: absent may become present; a present URL may
not be silently replaced by a different URL. Conflicting nonempty URLs enter a
safe review state with digests/counts only.

### 5.2 Callback capture is primary

If an exact callback contains a valid recording URL, capture it immediately in
the durable safe event. Do not wait for a recording poller.

If Call End has no usable URL:

- still capture and process the Call End normally;
- retain a separate recording ID when supplied;
- allow a later exact callback to strengthen the same event;
- never delay the callback response while testing or downloading the URL.

### 5.3 One event drain and one attempt ledger

The existing lead-delivery event drain remains the only callback-processing
owner. `DailyDial` remains the sole daytime PhoneBurner attempt ledger. The
existing deterministic projector remains the owner of PhoneBurner CallLog
creation/update.

### 5.4 A recording URL is sensitive evidence

A recording URL can function as an access capability. It may be stored only in
the minimum private evidence chain:

```text
LeadDeliveryEvent.safePayload.recordingUrl
DailyDial.attempts[].recordingUrl
DailyDial.recordingUrl (latest snapshot only)
CallLog.recordingArchive.sourceUri
```

It must not appear in routine structured logs, count checkpoints, provider
error bodies, report-generation diagnostics, browser list payloads, or tests.
Tests use reserved synthetic domains only.

### 5.5 No live provider lookup in reports

Reports and trainer discovery read persisted CallLog evidence. They do not
enumerate PhoneBurner sessions at report time. This keeps report generation
bounded and prevents seat-ownership failures from removing known links.

### 5.6 No independent feature flag

Recording evidence is part of the already-enabled callback contract. Do not
add another on/off switch that can drift dark after restart. The callback
capture flag remains the governing switch.

A non-secret recording-host allowlist is required configuration, not a feature
flag. Missing/invalid host configuration fails closed for the URL while still
allowing the Call End and recording ID to be captured.

## 6. Callback extraction contract

### 6.1 Candidate aliases

The pure extractor must examine every supported candidate independently. The
initial measured set is:

```text
recording_url_public
recording_link_public
recording_url
recording_link
recordingUrlPublic
recordingLinkPublic
recordingUrl
recordingLink
recording.url_public
recording.link_public
recording.url
recording.link
call.recording_url_public
call.recording_link_public
call.recording_url
call.recording_link
audio_url
```

Public variants are considered first, but order never replaces validation.
Blank strings, whitespace, numbers, objects, arrays, and bare IDs are skipped;
they do not stop examination of later candidates.

The selected field name may be retained as `recordingSourceKey` because it is
non-PII diagnostic evidence. The value may exist only in `recordingUrl`.

### 6.2 URL policy

A captured URL must:

- parse as an absolute URL;
- use HTTPS;
- contain no username or password;
- be no longer than 2,048 characters;
- target an explicitly allowed provider recording hostname;
- not target localhost, a literal private/link-local IP, or a `.local` name;
- retain its query string because provider recording links may be signed;
- never be fetched during callback capture.

Use one canonical non-secret configuration input:

```text
PHONEBURNER_RECORDING_ALLOWED_HOSTS
```

The value is a comma-separated exact/suffix rule list. It must be populated
from the measured historical provider host and verified provider evidence,
without printing URLs. The same normalized host rules must be supplied to the
trainer downloader. Capture and consumption must not maintain divergent host
lists.

### 6.3 Recording ID

Continue capturing an opaque provider recording ID independently from the URL.
A bare ID in any URL-shaped field is not promoted to a URL. It may be retained
only in `recordingId` and never interpolated into a guessed endpoint.

### 6.4 Conflict policy

For the same exact call:

- missing URL plus valid URL is an allowed upgrade;
- identical normalized URL is an idempotent no-op;
- different valid nonempty URL values are a conflict;
- invalid incoming URL never erases valid stored evidence;
- a recording ID may be filled when absent but not replaced when contradictory.

Conflict evidence records only a reason code and non-reversible digests. It
must not record both URLs.

## 7. Durable event upgrade contract

The current event-upgrade mechanism may move `review`, `pending`, `processing`,
`failed`, or `completed` back to `pending` when stronger outcome or recording
evidence arrives. The implementation must explicitly prove the recording-only
case:

1. Exact provider identities agree.
2. The event type remains canonical `call_done`.
3. Existing normalized outcome remains unchanged.
4. Existing `localAppliedAt` remains set.
5. The safe payload receives only the newly validated recording fields.
6. The drain runs the evidence projection portion without replaying the local
   attempt count or downstream action.
7. The event returns to `completed` after DailyDial and CallLog contain the
   link.

If the present implementation cannot separate business effects from evidence
projection, add a narrow evidence-only branch. Do not clear business-effect
markers as a shortcut.

## 8. DailyDial contract

`recordDailyDialOffload()` already uses stable `attemptKey`, provider, and call
identity. The proof must show:

- the original callback appends one attempt and returns `counted: true`;
- a recording-only upgrade updates the same attempt and returns
  `counted: false`;
- the attempt keeps the strongest outcome and latest safe timing evidence;
- a missing incoming URL preserves an existing URL;
- a conflicting URL fails closed;
- the top-level latest-call recording snapshot changes only when that attempt
  is still the latest call;
- a delayed historical recording does not overwrite a newer call snapshot;
- terminal/capped state remains terminal/capped.

No new DailyDial collection or recording ledger is permitted.

## 9. CallLog projection contract

The deterministic DailyDial projector must upsert the same CallLog identity:

```text
telephonySessionId = phoneburner:<providerCallId>
provider = phoneburner
providerCallId = exact callback call ID
recordingArchive.provider = phoneburner
recordingArchive.sourceUri = validated persisted URL
```

Rules:

- a recording-only rerun updates the existing CallLog;
- it does not create another CallLog or alter attribution/case ownership;
- it does not mark the audio as copied to Drive;
- absence of a URL never erases an existing `sourceUri`;
- conflicting URL evidence fails closed;
- projection remains deterministic and retryable at nightly close;
- CallLog list/read shapes expose availability, never the raw locator.

Do not overload `recordingArchive.status = completed` to mean merely "a remote
URL exists." The source URI itself is the current availability evidence unless
a separately defined status is added with tests.

## 10. Report and trainer contract

### 10.1 Reports

PhoneBurner report rows may contain a listen action only when the exact
case-bound CallLog has persisted recording evidence. Report diagnostics show
counts, not URLs. Preview and recipient restrictions remain unchanged.

Report generation must not call `listDialSessions()` or `getDialSession()` to
recover the link. Existing live PhoneBurner session enumeration is a degraded
optional path and must not be represented as complete evidence.

### 10.2 Trainer call review

Trainer discovery lists safe call metadata and `recordingStatus` only. The
browser never supplies or receives the raw recording locator.

When the user explicitly analyzes an authorized call, the server must:

1. re-read the exact case-bound CallLog;
2. confirm provider `phoneburner` and exact persisted `sourceUri`;
3. apply the canonical provider-host allowlist;
4. resolve DNS and reject private/link-local targets;
5. validate every redirect against the same rules;
6. enforce timeout, byte, content-type, and audio-magic bounds;
7. download to a temporary artifact;
8. delete the artifact after analysis.

No recording URL is stored in trainer state or returned to the browser.

## 11. Historical compatibility

The 109 April recording rows remain useful evidence but are not automatically
rewritten into current CallLogs.

Allowed historical work after the live fix:

- a read-only count audit by month/provider;
- exact case-bound retrieval through the legacy fallback when authorization is
  proven;
- an explicitly approved one-time migration keyed by exact case and call
  identity.

Forbidden:

- phone-number-only matching;
- copying all legacy links into a new collection;
- printing or exporting the URLs;
- treating an April row as proof about a current attempt;
- replaying transcription or business actions during migration.

## 12. Observability contract

Expose count-only recording health:

```text
phoneburnerCallDoneReceived
recordingUrlCaptured
recordingIdOnly
recordingCandidatePresentButInvalid
recordingHostRejected
recordingEvidenceUpgrade
recordingEvidenceConflict
dailyDialRecordingPersisted
callLogRecordingProjected
recordingProjectionFailed
```

Safe dimensions:

- Pacific time bucket;
- source hook;
- selected candidate field name;
- terminal/retry status;
- counts and age buckets.

Never expose:

- URL, hostname, path, query, fragment, or redirect target;
- provider call/contact/session identity;
- phone, name, email, case/customer data;
- raw payload or payload excerpt;
- token or credentials.

`observedKeys` remains capped, one-level, field-name-only diagnostic evidence.
Once the candidate contract is proven, retain it only as long as it remains
operationally useful; it is not a substitute for capture tests.

## 13. File plan

Expected implementation scope:

```text
apps/control-plane/src/routes/phoneBurnerLeadDelivery.js
apps/control-plane/src/server.js
packages/shared-config/src/index.js
packages/shared-services/src/recordingHostPolicyService.js
packages/shared-services/src/leadDeliveryService.js          (only if evidence-only drain needs repair)
packages/shared-services/src/dailyDialLedgerService.js       (tests first; change only if a proof fails)
packages/shared-services/src/dailyDialCallLogProjectionService.js
packages/shared-services/src/trainingCallReviewProviderService.js
packages/shared-services/src/nightRecordingsService.js       (remove live lookup ownership only if still active)
packages/shared-services/src/nightPassService.js
packages/shared-services/src/reportComposerService.js
packages/shared-services/src/reportBlocksService.js
packages/shared-services/src/simpleMarketingReadService.js
tests/lead-delivery/phoneBurnerCallbackCapture.test.js
tests/lead-delivery/phoneBurnerLeadDeliveryRoute.test.js
tests/lead-delivery/dailyDialLedgerService.test.js
tests/lead-delivery/dailyDialCallLogProjectionService.test.js
tests/metrics/phoneBurnerNightlyReconciliation.test.js
tests/metrics/longCallsMerged.test.js
tests/metrics/reportOpsSharedResolvers.test.js
tests/trainer/trainingCallReviewSourceContract.test.js
tests/trainer/trainingCallReviewProviderService.test.js
```

Optional count-only audit:

```text
scripts/audit-phoneburner-recording-capture.js
```

Do not add a model, collection, scheduler, service process, raw-payload store,
or recurring API backfill.

## 14. Implementation phases and proof gates

### PR-0 - durable contract and baseline

Work:

- record the historical and current evidence;
- settle capture, upgrade, storage, consumption, and security contracts;
- amend the parent Phase 9 work order;
- make no runtime change.

Gate:

- documentation-only diff for this slice;
- no secrets, URLs, provider/customer identities, or raw payloads;
- active parent phase remains Phase 9.

### PR-1 - pure callback URL extraction

Work:

- replace nullish preselection with candidate iteration;
- add all measured aliases;
- add canonical host-policy validation;
- retain safe `recordingSourceKey` and independent `recordingId`;
- correct comments that claim the recording ID is more valuable than the URL.

Tests:

- every alias independently captures a synthetic HTTPS provider URL;
- blank/invalid early aliases do not hide a later valid URL;
- public alias is preferred when two equivalent values exist;
- bare ID remains ID only;
- HTTP, credentialed, oversized, private, and unapproved-host URLs fail closed;
- query string survives normalization;
- callback fixture serialization contains no raw value outside
  `safePayload.recordingUrl`.

Gate: focused pure/callback tests pass; no Mongo or provider call.

### PR-2 - monotonic event-evidence upgrade

Work:

- prove or repair completed-event recording upgrades;
- preserve business-effect markers;
- add conflict behavior;
- keep canonical call-done dedupe.

Tests:

- completed Call End plus later URL becomes one completed strengthened event;
- recording-only upgrade does not change outcome;
- no attempt/business effect is replayed;
- identical replay is a no-op;
- conflicting exact identity or URL enters review;
- malformed later callback cannot erase evidence.

Gate: route/service/repository event tests pass.

### PR-3 - DailyDial and CallLog projection

Work:

- run the existing ledger and projector against recording-only replay;
- change production code only where a proof fails;
- make projection non-erasing and conflict-safe.

Tests:

- first Call End counts once;
- recording upgrade counts zero additional attempts;
- one DailyDial attempt and one CallLog remain;
- source URI reaches the exact CallLog;
- delayed older evidence cannot replace the latest DailyDial snapshot;
- terminal/capped state and attribution remain unchanged;
- nightly rerun is idempotent.

Gate: DailyDial, projection, and nightly reconciliation suites pass.

### PR-4 - report and trainer consumption hardening

Work:

- make persisted CallLog evidence the PhoneBurner report source;
- remove any claim that shared-token session enumeration is complete;
- feed the canonical host allowlist into trainer retrieval;
- verify no client list response contains the locator.

Tests:

- report row has listen availability from persisted CallLog;
- missing source stays unavailable without live polling;
- trainer authorizes exact case/call before retrieval;
- host/DNS/redirect/size/content/audio checks fail closed;
- temporary audio is deleted;
- client payload contains no URL, case ID, provider ID, or storage locator.

Gate: targeted metrics and trainer suites pass.

### PR-5 - local regression gate

Required commands:

```text
node --check apps/control-plane/src/routes/phoneBurnerLeadDelivery.js
node --check packages/shared-services/src/leadDeliveryService.js
node --check packages/shared-services/src/dailyDialLedgerService.js
node --check packages/shared-services/src/dailyDialCallLogProjectionService.js
node --test tests/lead-delivery/phoneBurnerCallbackCapture.test.js
node --test tests/lead-delivery/phoneBurnerLeadDeliveryRoute.test.js
node --test tests/lead-delivery/dailyDialLedgerService.test.js
node --test tests/lead-delivery/dailyDialCallLogProjectionService.test.js
node --test tests/metrics/phoneBurnerNightlyReconciliation.test.js
node --test tests/metrics/reportOpsSharedResolvers.test.js
node --test tests/trainer/trainingCallReviewSourceContract.test.js
node --test tests/trainer/trainingCallReviewProviderService.test.js
```

Also run the broader lead-delivery, metrics, and trainer slices in proportion
to the files actually changed. A timeout without failures is not a pass.

Gate:

- all named tests pass;
- diff contains only planned files;
- no production URL appears in source, fixtures, output, or git diff;
- no lead-delivery allocation/refill behavior changed.

### PR-6 - targeted Linux deployment

This phase requires separate explicit deployment authorization.

Rules:

- use the `tagcontactbridge-live-linux` skill;
- inspect service/health state first;
- never pull/reset/clean the dirty live checkout;
- build an exact-file archive from the approved commit;
- make a timestamped backup before overwrite;
- install only approved target files as `parallel`;
- verify exact hashes and run the named tests as `parallel`;
- set the non-secret host allowlist without printing other environment values;
- restart only `parallel-control-plane` after all gates pass;
- verify systemd active and local health HTTP 200;
- do not mutate PhoneBurner folders or contacts.

Rollback is the exact-file backup plus one controlled service restart. Mongo
recording evidence already captured is retained; rollback must not erase it.

### PR-7 - live callback canary

Use new calls only. Historical callbacks do not satisfy this gate.

Before restart/deploy snapshot count-only baselines. After activation:

1. Wait for a real post-deploy `call_done`.
2. Confirm capture and processing without printing identities or URLs.
3. If a valid recording URL arrives, confirm the same exact attempt and CallLog
   receive it.
4. Perform one bounded HEAD or Range check server-side; report only
   reachable/unreachable and safe HTTP class.
5. Confirm outcome/attempt counts did not increase during evidence upgrade.
6. Confirm report/trainer availability reads the persisted CallLog.

If no URL is captured after five post-deploy Call Ends or 30 Pacific business
minutes, whichever comes first, stop and report count-only alias/rejection
evidence. Do not broaden the whitelist or inspect raw bodies ad hoc.

Gate:

- at least one real recording URL is captured and projected end to end;
- one late/duplicate replay is proven idempotent naturally or by a safe local
  fixture against the deployed code;
- zero URL/confidential-data leakage;
- control-plane remains healthy.

### PR-8 - controlled-floor observation and closeout

Observe at least one normal business-hour slice with multiple real Call Ends.

Gate:

- capture/ID-only/invalid/conflict counts are explainable;
- every captured URL reaches exactly one DailyDial attempt and one CallLog;
- recording upgrades add zero call attempts;
- reports and trainer can use authorized persisted evidence;
- no PhoneBurner API polling loop was introduced;
- no regression in callback latency, Call End processing, refill, DNC, or
  terminal actions;
- Mickey approves closeout.

## 15. Rollback

Rollback disables only the newly deployed code by restoring the exact prior
files. It must not:

- disable callback capture globally unless callback health itself is broken;
- delete LeadDeliveryEvents, DailyDial attempts, or CallLogs;
- remove already captured recording evidence;
- replay provider callbacks;
- alter PhoneBurner folders, contacts, permissions, or webhooks;
- enable a polling/backfill substitute.

If URL capture causes a security or parsing failure, fail closed for URL
storage while continuing to capture/process Call Ends and recording IDs.

## 16. Definition of done

This recovery is complete only when:

1. Every measured callback alias is tested through one first-valid-candidate
   extractor.
2. Empty/invalid early candidates cannot hide a later valid URL.
3. Only HTTPS URLs on configured public provider hosts are accepted.
4. Recording IDs remain separate and are never treated as URLs.
5. Late recording evidence strengthens the exact event without recounting the
   attempt or replaying business effects.
6. The URL persists on the exact DailyDial attempt and exact PhoneBurner
   CallLog.
7. Missing evidence never erases existing evidence.
8. Conflicting evidence fails closed and is count-observable.
9. Reports use persisted CallLog evidence instead of live session polling.
10. Trainer review reauthorizes the exact case/call and downloads only through
    the bounded allowlisted server path.
11. No raw callback, URL, customer data, provider identity, or secret appears
    in logs, health, checkpoints, tests, or client list payloads.
12. A real post-deploy recording is captured, reachable, projected, and usable.
13. Callback latency, Call End counting, cadence, DNC, terminal actions, and
    refill behavior remain unchanged.
14. No new scheduler, queue, collection, provider writer, or automatic
    PhoneBurner backfill exists.

## 17. First implementation instruction

When implementation is authorized, begin with PR-1 only:

1. Re-read both PhoneBurner work orders.
2. Inspect the dirty tree and current tests.
3. Add pure extraction/validation tests first.
4. Replace nullish preselection with first-valid-candidate iteration.
5. Run the PR-1 gate.
6. Continue automatically through PR-5 when each proof gate passes.
7. Stop before PR-6 unless deployment is separately authorized.

## 18. Local implementation record - 2026-08-03

- PR-0 through PR-4 are implemented locally.
- PR-1 callback and route gate passed 33 tests after the late-upgrade case was
  added (14 callback tests and 19 route tests).
- PR-2 exact-event tests prove recording-only replay preserves completed
  business markers and does not repeat provider cleanup, DNC, refill, or call
  counting.
- PR-3 ledger/projector gate passed 10 tests.
- PR-4 metrics/trainer gate passed, including persisted CallLog availability,
  no live PhoneBurner session enumeration, server-only locator handling, and
  bounded retrieval cleanup.
- The required PR-5 named gate passed 79 tests; broader repository, policy,
  and merged-report coverage passed another 107 tests. The monolithic runtime
  file retains a pre-existing open-handle timeout, so its two changed scenarios
  were also run directly and passed; the timeout itself is not counted as a
  pass.
- PR-6 was not authorized by the PR-1 through PR-5 implementation pass. The
  later, separately authorized deployment is recorded below.

## 19. Targeted Linux deployment record - 2026-08-03

- Mickey separately authorized the recording-only Linux patch and live watcher.
- The live callback route, event decision owner, DailyDial ledger, and new
  recording host-policy utility were backed up and replaced as one exact-file
  bundle. In-progress report/metrics files were excluded.
- The one historical PhoneBurner media host was derived from the measured
  109-row evidence set and installed as the sole non-secret allowlist rule;
  neither the host nor any recording URL was printed.
- Live syntax checks passed. The callback/route/ledger/projector gate passed
  43/43, and both focused recording-upgrade runtime scenarios passed.
- Only `parallel-control-plane` restarted. It returned active/HTTP 200 with no
  startup-error evidence.
- PR-7 is active through the count-only
  `watch-phoneburner-recording-canary` heartbeat. It stops on end-to-end proof,
  five Call Ends without capture, thirty Pacific business minutes without
  capture, an evidence conflict/projection failure, or control-plane failure.

## 20. Live opaque-reference recovery amendment - 2026-08-03

The first live canary observed 26 post-deploy Call Ends. Every callback carried
the measured recording field names, but none of their values passed the strict
HTTPS/host policy. The provider values must therefore be retained before their
format can be classified safely.

- Keep `recordingUrl` strict: only an independently validated, allowlisted
  HTTPS URL may populate or project that field.
- When no candidate validates, retain the first nonempty scalar candidate as
  `safePayload.recordingReference`, capped at 4,096 characters, together with
  its field name in `recordingReferenceSourceKey`.
- Mark that state `retained_unparsed`. It is private diagnostic evidence, not a
  URL, recording ID, download locator, or downstream media authority.
- Never log, display, fetch, interpolate, or project the retained value into
  DailyDial or CallLog. No raw callback body is retained.
- A valid later alias wins and suppresses duplicate opaque retention. Objects,
  arrays, blank values, and oversized values remain rejected.
- A later parser may promote evidence only after count-only classification and
  explicit URL-policy validation. Until then this patch changes capture only;
  it does not replay business effects or add attempts.

Proof requires focused callback and route tests, a targeted control-plane-only
deployment, active/HTTP-200 service health, and a fresh count-only canary that
never prints the retained values.

Deployment proof:

- The live route differed from the prepared route only by this amendment.
- The prior route was backed up under the runtime deploy-backups boundary and
  only the callback route was replaced.
- The current callback/route gate passed 37/37 against the installed live
  modules from a temporary test root; local syntax and the same 37 tests also
  passed.
- Only `parallel-control-plane` restarted at 2026-08-03T20:57:45Z. It returned
  active and HTTP 200.
- A fresh count-only canary is required before interpreting or promoting any
  retained provider value.
