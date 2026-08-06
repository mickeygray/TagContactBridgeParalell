# Big patch release audit — 2026-08-03

Status: **SPLIT REQUIRED. DO NOT DEPLOY THE WORKTREE AS ONE PATCH.**

Branch snapshot: `cleaned-metrics` at base `213f0bf` with a large shared dirty
tree. This audit did not reset, clean, pull, restart, or mutate Linux. Claude's
in-flight report-math files were reviewed but not edited.

## Verdict

The working tree contains several independently useful changes, but it is not
one rollback-safe release:

1. Mongo pool and lead-delivery compute work already has its own live proof and
   must retain that existing rollback boundary.
2. PhoneBurner recording capture/exact-attempt projection is independently
   testable, but the later opaque-reference promotion is a separate security
   decision and is held below.
3. Daily report fact capture is locally ready after the hardening in this
   audit, subject to its index promotion and next-email canary.
4. Mail invoice/spend and report math remain part of Claude's current metrics
   reconciliation and must be frozen only after that work stops changing.
5. Scheduler consolidation (Patch C) remains **not deployable**.

No broad `git pull`, worktree overwrite, or all-files archive is authorized for
the dirty Linux checkout. Every released slice needs an exact-file archive,
backup, hash verification, service-user tests, its named additive index step,
and its own observation/rollback record.

## Release blockers

### 1. Patch C prerequisite is still false

The scheduler manifest requires the post-Google-Sheet-retirement call graph
and durable daily claims for every retained named job. The current tree still:

- starts the dedicated spend-sheet sync runtime from `server.js`;
- makes scheduled Logics activity review wait on/read payment-sheet state;
- has no durable per-day claim around the EOD recording archive runtime;
- proves several duplicate-owner gates with source-text assertions, but does
  not yet prove every retained owner has the required persisted once-per-day
  claim and restart behavior.

Therefore the changes in these files stay out of the next deployment archive:

```text
apps/control-plane/src/server.js                 (scheduler-only hunks)
apps/control-plane/src/services/eodRecordingArchiveRuntime.js
apps/control-plane/src/services/logicsActivityReviewRuntime.js
apps/control-plane/src/services/nightlyHygieneRuntime.js
packages/shared-models/src/DailyLoopRun.js
packages/shared-services/src/nightlyCloseService.js
packages/shared-services/src/spendSyncService.js
tests/metrics/nightlyHygieneRuntime.test.js
tests/metrics/schedulerComputeBoundary.test.js
tests/metrics/weekendRuntimeGates.test.js
```

Some of those files also contain changes owned by another slice. If so, build
the deployment from selected commit blobs/hunks; do not copy the whole local
file merely because one hunk is ready.

### 2. Opaque PhoneBurner recording promotion is not yet hardened for release

Strict callback capture still requires an allowlisted HTTPS URL, but
`recordingReferencePromotionService` deliberately promotes allowlisted plain
HTTP references and sends them through the persisted/email locator chain. It
also treats an already stored `recordingUrl` as authoritative without
re-applying the current host allowlist.

That behavior conflicts with the canonical recording work order's HTTPS-only
acceptance and consumption rules. Exact-host checks prevent arbitrary-host
promotion, but plain HTTP can expose a signed capability in transit. Before
including promotion in the big patch, choose and prove one of:

1. the provider's HTTPS form works and normalize only to that form; or
2. a server-side authenticated download/listen path that validates host, DNS,
   redirects, content, size, and timeout on every use without exposing the
   provider capability to the client.

Until then, strict capture may remain, but exclude:

```text
packages/shared-services/src/recordingReferencePromotionService.js
tests/lead-delivery/recordingReferencePromotion.test.js
```

and exclude any `leadDeliveryService.js` hunks whose only purpose is promoting
`recordingReference` into downstream `recordingUrl` authority.

### 3. The abandoned source-state experiment must remain inert

`packages/shared-models/src/LeadDeliverySourceState.js` is untracked and has no
runtime import. It is explicitly rejected by the Mongo compute manifest. Do
not stage, export, index, deploy, or instantiate it.

## Hardened in this audit

Daily fact capture now:

- authorizes only the exact canonical definition name
  `financial roll up with calls`, in addition to the existing one-day,
  unscoped, unfiltered full-rollup checks;
- rejects provider call/contact/session identity aliases, source/media URIs,
  customer-name variants, transcripts, and capability-token fields;
- drops absolute locator strings and email addresses even under unfamiliar
  property names;
- retains aggregate staff/call counts and Claude's same-document call attach
  seam.

Files changed by this audit:

```text
packages/shared-services/src/dailyReportFactService.js
tests/metrics/dailyReportFactService.test.js
.ai/context/DAILY_FACT_CAPTURE_WORK_ORDER_2026-08-03.md
```

## Proof run

- `git diff --check`: clean (line-ending warnings only).
- Changed/untracked JavaScript syntax: 85/85 passed.
- Full metrics suite: 563/563 passed.
- Lead-delivery suite excluding the documented hanging historical runtime
  file: 385/385 passed.
- Required bounded runtime patterns from that file: 10/10 passed.
- Focused daily-fact/delivery regression after hardening: 28/28 passed.
- Focused recording/daily-fact/scheduler/Mongo gate: 140/140 passed.
- High-risk literal scan: no private key, AWS key, OpenAI key, or bearer-token
  literal found. The four `mongodb+srv://` hits are explanatory DNS comments,
  not connection strings.

The test numbers overlap; they are recorded as gates, not summed as a unique
test count.

## Recommended release order

1. Freeze Claude's metrics files and rerun the 563-test metrics gate.
2. Commit the daily-fact model/service/hook/tests/index script as one slice.
3. Promote only the named daily-fact index, deploy exact files, restart only
   `parallel-control-plane`, and canary the next accepted canonical email.
4. Commit/deploy mail invoice/spend/report math as its own slice after Claude's
   reconciliation and index proof.
5. Resolve the recording HTTP/security decision, then ship the promotion as a
   separate recording slice with a real-call canary.
6. Re-inventory the post-Sheet-retirement scheduler call graph and finish the
   durable-claim matrix before preparing Patch C.

Do not combine these rollback boundaries merely to reduce the number of
deployments.
