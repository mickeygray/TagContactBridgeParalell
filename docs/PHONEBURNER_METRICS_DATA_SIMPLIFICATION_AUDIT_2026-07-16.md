# PhoneBurner Metrics and Data Simplification Audit

Date: 2026-07-16  
Scope: PhoneBurner call facts, agent productivity, outcomes, appointments, recordings, and the metrics read path  
Work-order phase: 9  
Posture: audit only; no runtime or data changes

## Verdict

The PhoneBurner daytime loop has a usable exact call ledger, but the existing metrics system does not consume it.

The core problem is not missing data. It is that the repository currently uses the word `calls` for three different facts:

1. inbound marketing-response calls grouped by source/piece;
2. outbound agent dial attempts;
3. per-agent productivity/activity.

Those facts must remain separate. Trying to make one existing counter represent all three is the shortest route back to “close but not perfect.”

The clean end state is:

```text
PhoneBurner callback
  -> LeadDeliveryEvent             transport/replay only
  -> LeadDeliveryItem              live queue state only
  -> DailyDial.attempts            exact daytime PhoneBurner facts
  -> end-of-day CallLog            normalized cross-provider call record
  -> optional CallLedger           reporting projection from CallLog only
  -> reporting queries/snapshots   derived, replaceable, never authoritative
```

`LeadCadence` remains the durable lead/cadence projection. It must not become the source of historical call totals.

## What is authoritative

| Fact | Owner | Rule |
| --- | --- | --- |
| Webhook delivery and replay | `LeadDeliveryEvent` | Transport evidence only. Do not count it as a call. |
| Whether a lead is eligible/reserved/in-call/held | `LeadDeliveryItem` | Live operational state only. Do not use it for historical metrics. |
| A PhoneBurner attempt happened | `DailyDial.attempts[]` | Canonical daytime fact, keyed by exact provider attempt identity. |
| Current daily retry/cap state | `DailyDial` top-level projection | Convenience state derived from attempts; not historical truth. |
| Lead's durable cadence state | `LeadCadence` | End-of-day compatibility and next-day scheduling projection. |
| One normalized call across providers | `CallLog` | Post-close analytical/enrichment row. |
| Flattened reporting row | `CallLedger` | Optional projection from `CallLog`; never an independent source. |
| Inbound response calls by mail/source | `DailyCallStat` | Marketing-response metric only; must not absorb outbound dials. |
| Dashboard cache | `MetricsSnapshot` | Replaceable projection only. |
| Frozen reported close | `MetricClose` | Immutable audit snapshot, after reconciliation. |

## Proven findings

### 1. PhoneBurner attempts are not connected to the metrics readers

`DailyDial` is currently consumed only by:

- the PhoneBurner call-end writer;
- the end-of-day `LeadCadence` persistence action;
- observability scripts/tests.

There is no `DailyDial` reader in `buildMetricsWorkspace`, `buildMetricSourcesWorkspace`, `buildDailySummaryWorkspace`, `buildMetricsPulse`, `agentCallStatsService`, or the nightly call reconciliation.

Result: PhoneBurner activity can be operationally correct while remaining invisible to the existing call/productivity metrics.

### 2. The main dashboard's `calls` value is an inbound-response metric

`metricsBackfillService.buildDailyCallStatsFromCallLogs()` defaults to `direction: "inbound"`. `frontendReadService` then reads `DailyCallStat` and exposes `totalCalls` as `calls`.

That is valid for source/ROI reporting, but the label is ambiguous. It is not the number of outbound dials agents made.

Required semantic split:

- `inboundResponseCalls`
- `outboundAttempts`
- `connectedCalls`
- `appointmentsSet`
- `dncOutcomes`

Never add inbound response calls and outbound attempts into one headline counter.

### 3. Per-agent call stats cannot see PhoneBurner

`agentCallStatsService` aggregates only `CallLog` rows matched by RingCentral extension IDs. `CallLog.platform` currently allows only `ex`, `cx`, or null.

Result: PhoneBurner agents can dial all day and still show zero/understated activity in that read model.

### 4. The nightly “honest calls” reconciliation is CX-specific

`callMetricsReconciliationService` invokes `scripts/reconcile-monthly-call-totals.js`. That script:

- reads `controlplanecalllogs` with `platform: "cx"`;
- calls the facts `cxAttempts`;
- restricts generated-lead totals to active `LeadCadence` rows created in the report window;
- uses a soft fallback identity when a session ID is missing.

It cannot be the PhoneBurner reconciliation without a rewrite. It also should not require a script from a shared service.

### 5. `DailyDial.attempts[]` is strong; its top-level snapshot is weaker

The attempt array is identity-backed and append-only. That is the good fact source.

The top-level fields (`lastOutcome`, `terminal`, `callEndedAt`, `durationSeconds`, `lastAgentId`, `originPool`) are overwritten by each processed offload. A delayed older callback can therefore make the top-level snapshot describe an older call. A later non-terminal outcome can also overwrite `terminal: true` unless all upstream ordering assumptions hold.

Metrics must read attempts, not the top-level snapshot. The snapshot should later be made monotonic:

- latest-call fields advance only when `callEndedAt` advances;
- `terminal` is monotonic within the day;
- capped/terminal rows never receive `nextEligibleAt`.

### 6. `DailyDial.receivedAt` has two meanings

On `LeadDeliveryItem`, `receivedAt` means when the lead entered the system. In `recordDailyDialOffload`, the top-level `DailyDial.receivedAt` is updated to the call offload/end time.

That is a dangerous name collision because retry eligibility is time-sensitive.

Rename the DailyDial field to `lastOffloadAt`. Keep an explicit `leadReceivedAt` in the lead snapshot if it is needed for age/latency reporting.

### 7. Provider identity is missing from each DailyDial attempt

`DailyDial.attempts[]` stores `providerCallId` and `attemptKey`, but not `provider`. The event and live item both store provider explicitly.

Add `provider` to the attempt fact. Never infer it from an ID prefix. The durable call key should be:

```text
provider + providerCallId
```

The attempt key remains the exact dedupe key.

### 8. Domain and case identity types disagree across stores

- `DailyDial.domain` is lowercase.
- `LeadDeliveryItem.domain` is uppercase.
- `DailyDial.caseId` is a string.
- `CallLog`/`CallLedger.caseId` are numbers.

This is survivable operationally but unsafe for silent analytical joins. The reconciliation boundary must normalize both explicitly and reject an invalid case ID instead of producing an unmatched metric row.

### 9. `LeadCadence` is a projection, not a second call ledger

The end-of-day writer is well protected:

- it records attempts in call-time order;
- `leadDeliveryCountedAttemptKeys` makes the cadence increment exact-once;
- latest-touch fields advance monotonically;
- a crash between the cadence write and `cadencePersistedAt` is replay-safe.

Keep that behavior, but stop reporting historical call totals from `cadenceCounters.cx`, `cxDailyCalls`, or `lastCxDialedAt` after PhoneBurner cutover. Those names are compatibility fields and now misstate the provider.

### 10. Appointment and DNC counts each have one proper fact

For reporting:

- an appointment conversion is the exact call attempt whose normalized outcome is `appointment`;
- a DNC is the exact call attempt whose normalized outcome is `dnc` or `bad_lead`, preserving the normalized subtype for analysis.

Do not count appointment documents, Logics tasks, or Logics case status as additional conversions. Those are downstream business effects and may be retried, rescheduled, or deduplicated independently.

### 11. Recordings/scoring are still RingCentral-shaped

The existing recording and scoring pipeline is centered on `CallLog.telephonySessionId`, RingCX UII, `CxAgentCallNote`, and RingCX recording metadata. PhoneBurner has no proven bridge into it yet.

Do not match PhoneBurner recordings by phone, customer name, or approximate time. The only acceptable join is exact provider call identity.

The simplest reuse path is:

1. create the normalized PhoneBurner `CallLog` row after close;
2. use a namespaced session ID such as `phoneburner:<providerCallId>`;
3. extend `CallLog.platform` with `phoneburner`;
4. store the raw provider call ID in a provider-neutral identity field;
5. let recording/transcription/scoring enrich that row asynchronously.

Do not put transcripts, recording URLs, or AI scores into `DailyDial` or `LeadCadence`.

## The “too many cooks” inventory

| Component | Current issue | Decision |
| --- | --- | --- |
| `DailyDial` | Exact PB fact exists but no reporting reader | Keep as daytime write truth. |
| `LeadDeliveryItem` counters | Easy to mistake live state for totals | Keep operational only. |
| `LeadDeliveryAgent.providerCompletedCount` | Repairable cache, not immutable history | Health/status only. |
| `LeadCadence.cadenceCounters.cx` | Compatibility name now implies wrong provider | Keep temporarily; deprecate as metric source. |
| `CallLog` | Rich canonical call/enrichment model is RC-only by enum and writers | Make provider-neutral at reconciliation. |
| `CallLedger` | Duplicates a flattened subset of `CallLog`; optional source selection causes drift | Retain only as a one-way projection, or remove after measuring query cost. |
| `DailyCallStat` | Correct inbound source rollup but generically named | Keep; label and constrain as inbound response calls. |
| `MetricsSnapshot` | Can hide stale or mixed inputs | Cache only; stamp source version/watermark. |
| legacy mirror | Full-copy fallback can silently become the selected source | Read-only migration fallback; remove from primary reads after shadow proof. |
| hourly metrics source switches | Can choose CallLog, CallLedger, legacy activity, CallRail, or mirror | Replace with one declared source per metric family. |
| CX nightly reconciliation script | CX-only, soft-deduped, and required backwards from a shared service | Replace with a shared provider-neutral reconciliation service. |

## Target metric definitions

These definitions should be written into code and UI labels before changing queries.

| Metric | Definition | Source |
| --- | --- | --- |
| Outbound attempts | Count of distinct exact attempt keys | `DailyDial.attempts`, then reconciled `CallLog` |
| Leads attempted | Distinct `(domain, caseId)` with at least one attempt | Same |
| Connected calls | Exact attempts whose provider/system outcome proves connection | Same |
| Talk duration | Provider duration for connected attempt; null when unavailable, never guessed | Same |
| Appointments set | Exact attempts normalized to `appointment` | Same |
| DNC | Exact attempts normalized to `dnc` or `bad_lead` | Same |
| Agent productivity | Attempts grouped by exact delivery agent | Same |
| Fresh response latency | First attempt time minus lead receipt time | DailyDial attempt + explicit lead receipt |
| Inbound response calls | Inbound CallRail/RC response calls by source/piece | `DailyCallStat` |
| Recording coverage | Reconciled calls with exact recording artifact / eligible calls | `CallLog` enrichment |
| Scoring coverage | Reconciled calls with completed score / scorable calls | `CallLog` enrichment |

## Surgical cleanup order

No step below belongs in the live daytime lead churn loop.

### Step 1 — lock the fact contract

Files/functions:

- `packages/shared-models/src/DailyDial.js`
- `packages/shared-services/src/dailyDialLedgerService.js::recordDailyDialOffload`
- `apps/control-plane/src/services/leadDeliveryDailyDialAction.js`

Changes:

- add `provider` to each attempt;
- rename/migrate `receivedAt` to `lastOffloadAt`;
- make top-level latest fields and terminal state monotonic;
- retain exact attempt-key dedupe;
- add tests for delayed/out-of-order callbacks.

Gate: the same callback, a delayed callback, and a delayed terminal callback produce one correct immutable attempt set and a non-regressing snapshot.

### Step 2 — add one post-close PhoneBurner call reconciler

New shared function, not a script-owned computation:

```text
reconcilePhoneBurnerCallsForDate(dateKey)
```

It reads `DailyDial.attempts[]` and idempotently upserts one `CallLog` row per exact provider call. It performs explicit domain/case/agent normalization and emits aggregate rejects for invalid identity.

It does not run during the day.

Gate: attempt count equals reconciled CallLog count plus explicit rejects; rerun changes zero counts.

### Step 3 — make CallLog provider-neutral

Files:

- `packages/shared-models/src/CallLog.js`
- the new reconciliation service
- `packages/shared-services/src/agentCallStatsService.js`

Changes:

- allow platform/provider `phoneburner`;
- add explicit provider call identity;
- map PhoneBurner agent ID to the application agent identity;
- expose platform grouping without hard-coding only CX/EX.

Gate: per-agent PB totals exactly equal DailyDial attempts for the same date.

### Step 4 — separate inbound ROI calls from outbound sales activity

Files:

- `packages/shared-services/src/frontendReadService.js`
- `packages/shared-services/src/metricsPulseService.js`
- web metrics labels/components

Changes:

- preserve `DailyCallStat` as inbound response-call data;
- rename returned/displayed semantics;
- add separate outbound attempt/contact/appointment/DNC fields from the reconciled call source;
- never merge the two totals.

Gate: dashboard values can be independently reconciled to each source with no overlap.

### Step 5 — remove metrics source roulette

Files:

- `packages/shared-services/src/metricsBackfillService.js`
- `packages/shared-services/src/hourlyMetricsRefreshService.js`
- `packages/shared-services/src/legacyMetricsService.js`
- `packages/shared-services/src/legacyMetricsMirrorService.js`

Changes:

- declare one source per metric family;
- remove runtime choices between CallLog, CallLedger, legacy contact activities, CallRail fallback, and mirror for the same metric;
- retain legacy only behind an explicit historical-cutover boundary;
- stamp snapshot source version and source watermark.

Gate: two consecutive rebuilds from the same facts are byte-stable except timestamps.

### Step 6 — replace the CX-only nightly reconciliation

Files:

- `packages/shared-services/src/callMetricsReconciliationService.js`
- `scripts/reconcile-monthly-call-totals.js`
- `packages/shared-services/src/metricCloseService.js`

Changes:

- move pure compute into the shared service;
- group by provider instead of naming everything CX;
- use exact call identity, not soft phone/time identity;
- report unmatched/inactive leads separately instead of excluding them from the headline fact set;
- freeze only after PhoneBurner reconciliation completes.

Gate: provider subtotals sum exactly to total outbound attempts and each frozen close records its source watermark.

### Step 7 — connect recordings after call reconciliation is proven

Files:

- `packages/shared-models/src/CallLog.js`
- `packages/shared-services/src/recordingArchiveService.js`
- `packages/shared-services/src/transcriptionScoringService.js`
- PhoneBurner integration client

Changes:

- fetch/list recordings outside the daytime churn path;
- join only by provider plus provider call ID;
- reuse CallLog transcription/archive/score state;
- leave CX-specific `CxAgentCallNote` as legacy CX history rather than forcing PB into UII fields.

Gate: every archived/scored PB artifact resolves to exactly one reconciled call and one agent; unresolved artifacts remain visible and unassigned.

### Step 8 — retire compatibility reads

After a shadow period proves DailyDial -> CallLog -> metrics equality:

- stop reading PhoneBurner totals from LeadCadence CX-named fields;
- stop using agent provider-completed caches as business metrics;
- stop using the legacy mirror as a primary source for post-cutover dates;
- either remove `CallLedger` or formally retain it as a rebuildable projection from CallLog only;
- remove the old CX-only reconciliation path for post-cutover periods.

## Recommended first implementation slice

Do only Steps 1 and 2 first.

That gives the system one exact, replay-safe bridge from the already-working PhoneBurner call ledger into the existing analytical call model. It does not touch live queue behavior, fairness, fresh delivery, refill, appointment swaps, or PhoneBurner folders.

Once that bridge proves exact for one closed day, agent stats and dashboard fields can be changed one at a time without inventing another source of truth.

## Implemented chain (2026-07-17)

The first slice is now wired as one direction only:

```text
PhoneBurner Call Done
  -> DailyDial.attempts[]
  -> end-of-day dailyDialCallLogProjection
  -> CallLog (platform=phoneburner)
  -> agentCallStatsService
  -> Users / call metrics
```

Contract:

- daytime callbacks write only the exact DailyDial attempt fact;
- end of day replays those facts into deterministic `provider:providerCallId`
  CallLog identities;
- replay upserts the same CallLog row and cannot create a duplicate;
- invalid domain/case/provider identities are explicit aggregate rejects;
- unknown connection evidence stays null and is not guessed from outcome or duration;
- metrics read CallLog only and expose PhoneBurner attempts, proven connections,
  appointments, DNC/bad-lead outcomes, and connected talk time;
- LeadCadence persistence remains a separate compatibility projection and is not
  a metric source.

The daytime refill/fairness/fresh loop is not involved in this reconciliation.

## PB-to-metrics hardening (2026-07-17)

The seam now has one owner per fact and one safe retry path:

```text
exact PhoneBurner Call End
  -> DailyDial attempt (daytime fact owner; exact attempt-key dedupe)
  -> LeadCadence (eligibility compatibility projection only)
  -> CallLog (analytical source; deterministic provider:callId upsert)
  -> vendor email / agent metrics
```

- Delayed callbacks may append their immutable attempt, but cannot move the
  top-level DailyDial snapshot backward. Terminal and capped state are sticky.
- `leadReceivedAt` and `lastOffloadAt` now state the two timestamps explicitly;
  `receivedAt` remains only as a compatibility alias during the no-delete window.
- A weaker retry cannot erase a stronger outcome or a proven connected value.
  A contradictory provider/call identity for one attempt key fails closed.
- The 17:30 floor close projects DailyDial into CallLog. The scheduled nightly
  close invokes the same projector again before source enrichment. This is a
  redundant trigger, not another writer: both use the same source facts,
  function, and deterministic CallLog identity.
- Preview/skip-final-close runs do not invoke the retry writer.
- The live vendor-call builder reads CallLog only. The former CallLedger-first
  implementation is retained as disabled code for the proof-gated deletion
  pass; one legacy row can no longer suppress all PhoneBurner calls.
- Nightly projection status is visible in the vendor email. A partial/failed
  projection cannot masquerade as a healthy zero-call day.

Proof: focused PB ledger/projection/wiring tests passed 15/15 and the complete
metrics suite passed 40/40. The broad lead-delivery glob reached its existing
184-second timeout without an emitted assertion failure and is not claimed as
a full-suite pass.
