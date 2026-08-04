# Daily report fact capture — work order

Date: 2026-08-03
Status: LOCAL COMBINED-DAY CAPTURE READY. Call projection, deployment, and live
verification remain pending.
Owners: Mickey / Codex (daily core facts) / Claude (call facts and longer-report presentation)

---

## 0. Decision

Persist **one `DailyReportFact` document per Pacific calendar day**. It contains
the non-customer daily facts used to build the canonical all-company nightly
rollup. Week and month reports read a small ordered set of these daily documents
instead of replaying Logics, CallRail, RingCentral, and PhoneBurner history.

This is not a saved email, rendered board, raw provider payload, or second CRM.
It is the additive daily substrate from which a longer report can be rebuilt.

The write happens **after the email provider accepts the nightly email** and
uses the exact in-memory report material already built for that email. It never
gathers a source a second time. If the email fails, no fact is written. If the
email succeeds but the fact write fails, the scheduler raises an alert and does
not resend the email.

Only an unfiltered, unscoped, one-day report containing the full `rollup`
preset is eligible. Vendor boards, tenant-filtered reports, multi-day reports,
and dry runs cannot overwrite the canonical day.

The canonical definition is named exactly `financial roll up with calls`
(case-insensitive after trimming). Shape alone is not authority: another
unscoped one-day definition may reuse the same blocks without becoming a daily
fact writer.

---

## 1. Ownership and collision boundary

### Codex owns

- the `DailyReportFact` collection and one-document-per-day invariant;
- automatic capture from the successful canonical nightly email;
- non-call sections: financial, by source, by agent, and status movement;
- sanitization that excludes customer/case/call rows, phones, email addresses,
  recording references, URLs, payloads, and non-additive presentation ratios;
- explicit complete/degraded/missing/unavailable coverage;
- the daily range reader used to assemble week and month inputs;
- the full DST-aware Pacific day fix for the RingCentral queue readers;
- hard-gating the superseded standalone queue-only writer.

### Claude owns

- projecting the aggregate PhoneBurner and CallRail call facts into
  `facts.calls` on the same daily document;
- using the stored days to render combined week/month reports;
- recomputing ratios from summed bases rather than averaging daily percentages.

PhoneBurner recording URLs are already arriving. This work order deliberately
does not add URL discovery, parsing, provider polling, backfill, or a second
recording writer.

---

## 2. Canonical document contract

Collection model: `packages/shared-models/src/DailyReportFact.js`

```js
{
  dateKey: "YYYY-MM-DD",       // unique; Pacific business day
  captureVersion: 1,
  definitionName,
  selection,
  emailAcceptedAt,
  capturedAt,
  revision,

  facts: {
    financial,                  // additive daily money/count bases
    bySource,                   // daily aggregate source facts
    byAgent,                    // daily aggregate agent facts
    statusMovement,             // daily aggregate status facts
    calls,                      // Claude-owned aggregate slot
  },

  coverage: {
    requiredSections,
    capturedSections,
    missingSections,
    sectionErrors,
    reportDegraded,
    coreComplete,
    callProjection,             // pending | complete | unavailable
    complete,
  },
}
```

`dateKey` is the unique key. A deliberate re-send/rebuild of the same day
updates that document and increments `revision`; it never creates a second day.

The capture strips daily ROI, ROAS, rates, percentages, cost-per values, and
other derived ratios. Range reports must sum the stored bases and recompute
those values. They must never average daily ratios.

The call slot initially receives only a count-safe pending marker. Claude fills
it through:

```js
attachDailyCallFacts({ dateKey, callFacts, status: "complete" })
```

That call updates the existing document; it does not create another collection
or competing daily row.

---

## 3. Trigger and lifecycle

The authoritative path is `reportDefinitionService.runDefinition()`:

1. Resolve the one-day Pacific range.
2. Compose the report once.
3. Send the nightly email.
4. After provider acceptance, pass the exact report object to
   `captureDeliveredDailyFact()`.
5. Upsert `DailyReportFact` by `dateKey`.
6. If capture fails, retain the successful email result and raise a high-priority
   `daily-report-fact` service alert. Never rerun the definition just to repair
   the fact, because that would duplicate the email.

There is no new feature flag for this write. It follows the already-authorized
canonical nightly report. The scheduler and report definition still need to be
enabled normally, but `QUEUE_ROLLUP_ENABLED` is not part of this path.

The former `queue-rollup` hygiene writer is superseded and hard-gated off even
if a stale environment value says otherwise. Its code and reader remain for
recovery/backfill under the repository's no-delete rule; they are not the
canonical forward writer.

---

## 4. Coverage and range rules

`readDailyReportFactRange({ from, to })` returns ordered `days` plus:

```js
coverage: {
  daysRequested,
  daysStored,
  missing,
  incomplete,
  callsPending,
  complete,
}
```

Rules:

- missing source data is never converted to a confident zero;
- a degraded email can be stored for audit, but its day remains incomplete;
- a day remains incomplete while the call projection is pending/unavailable;
- longer reports must show incomplete coverage rather than silently treating
  missing days as zero;
- consumer aggregation occurs over the day facts, not over saved HTML/text.

---

## 5. Source timing and correction policy

The canonical day is Pacific midnight through 23:59:59.999, using a DST-aware
window. Both RingCentral readers now use the full day rather than ending at
16:59 Pacific.

Late corrections are handled by a deliberate recapture of the affected day,
which updates the unique daily row and increments `revision`. A future audit
history may retain retired revisions, but version 1 intentionally keeps one
authoritative row per day so range reads cannot double-count.

The email material is the initial capture boundary. It provides a single
consistent snapshot across sections and avoids the previous problem where a
writer gathered a source again after the email and stored different numbers.

---

## 6. Existing adjacent writers

These remain separate because they have different ownership and retention
semantics:

| Task | Purpose | This work order |
| --- | --- | --- |
| `night-persist` | attribution written onto payment/client facts | unchanged; explicit live-write authorization still required |
| `mail-invoice` | raw vendor invoice intake | unchanged |
| `mail-spend-derive` | canonical daily mail spend derivation | unchanged |
| `call-links` | marketing call link capture | unchanged; not a daily report fact writer |
| legacy `queue-rollup` | old queue-only daily collection | hard-gated; superseded |

The combined day may consume values computed from those sources, but it does
not replace their source-of-truth collections.

---

## 7. Local implementation

Implemented locally:

- `packages/shared-models/src/DailyReportFact.js`
- `packages/shared-services/src/dailyReportFactService.js`
- delivered-email hook in
  `packages/shared-services/src/reportDefinitionService.js`
- capture-failure alert in
  `apps/control-plane/src/services/reportScheduleRuntime.js`
- index setup in `scripts/ensure-daily-report-fact-indexes.js`
- hard gate on the legacy queue-only writer in
  `apps/control-plane/src/services/nightlyHygieneRuntime.js`
- focused tests in `tests/metrics/dailyReportFactService.test.js`

The hook reuses the exact report object passed to the successful mail send and
has a source-order test proving no `composeReport()` call occurs between mail
acceptance and fact capture.

Local proof completed:

- JavaScript syntax checks passed for the model, writer, scheduler hook,
  hygiene hard gate, and index setup script.
- 179/179 combined daily-fact, delivery, scheduler, queue, attribution,
  source-reconciliation, tenant-scope, and report-contract tests passed.
- The delivery proof includes a simulated post-SendGrid fact-store failure:
  the email remains delivered and claimed, while capture records a failure.
- `git diff --check` passed for the targeted slice.

---

## 8. Acceptance gates

1. One successful canonical one-day email produces exactly one daily document.
2. Rebuilding the same day increments `revision` and does not duplicate it.
3. Failed email delivery produces no daily document.
4. Vendor/filter/tenant/multi-day definitions do not capture.
5. Capture uses the existing report object and performs no second gather.
6. A source failure stores explicit degraded/incomplete coverage.
7. PII, case/call rows, recording references, URLs, and raw payloads are absent.
8. Non-additive ratios are absent and must be recomputed for ranges.
9. Claude can attach aggregate call facts to the same document.
10. Fact-write failure cannot trigger a duplicate email and does create an alert.
11. Legacy queue-only writes remain off regardless of stale configuration.
12. Focused and adjacent report/scheduler tests pass and `git diff --check` is clean.

Hardening note: sanitization rejects absolute locator strings regardless of
their property name and explicitly drops provider call/contact/session IDs,
source/media URIs, customer-name aliases, transcripts, and capability tokens.
This keeps Claude's aggregate call attachment seam from becoming a second
call/customer store when a future payload adds unfamiliar fields.

---

## 9. Deployment checklist (not executed)

1. Reconcile the shared dirty report/runtime files with Claude's in-flight work.
2. Deploy only the targeted model/service/runtime/index files.
3. Run `scripts/ensure-daily-report-fact-indexes.js` once on the target.
4. Run the focused and adjacent report/scheduler tests as the service user.
5. Do **not** arm `QUEUE_ROLLUP_ENABLED`; that writer is superseded.
6. Do **not** add a PhoneBurner recording flag or migration.
7. Restart only the Linux control plane under the Linux authority rules, then
   verify systemd active and health 200. Codex must not restart local Windows
   `Parallel*` services; Mickey owns those restarts.
8. Verify the next canonical email produces one fact with `coreComplete=true`
   and `callProjection=pending` until Claude attaches the call facts.
