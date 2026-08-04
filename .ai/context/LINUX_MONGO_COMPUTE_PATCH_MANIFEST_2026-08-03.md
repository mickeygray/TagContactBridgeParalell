# Linux Mongo Compute Patch Manifest — 2026-08-03

Status: Patch A and Patch B deployed independently on 2026-08-03; immediate gates passed; boundary observation remains open

Target: `/opt/tagcontactbridge-parallel`

Governing work orders:

- `MONGO_POOL_AND_OFF_HOURS_LEAD_DELIVERY_WORK_ORDER_2026-08-03.md`
- `PHONEBURNER_PROVIDER_NEUTRAL_LEAD_DELIVERY_WORK_ORDER_2026-07-10.md`, Phase 9

## Hard boundaries

- Patch A and Patch B are separate archives, backups, restart sets, rollback
  units, and observation gates. Do not combine them during deployment.
- Patch C is not deployable yet. It remains held behind the separately owned
  Google Sheet retirement patch and its remaining named-job claim proof.
- Neither archive contains an environment file, credential, token, runtime
  state, log, provider payload, customer row, PhoneBurner folder identifier,
  MailInvoice/NCOA work, or the canonical PhoneBurner work order that records
  historical folder configuration.
- The abandoned `LeadDeliverySourceState.js` experiment is not imported,
  packaged, indexed, or deployed. It remains inert pending proof-gated
  physical deletion.
- Index promotion is additive only. Never run `syncIndexes()`, drop an index,
  or delete data.
- This manifest and the archives do not authorize deployment or restart by
  themselves.

## Patch A — bounded shared Mongo pool

Archive:

```text
runtime/linux-patches/mongo-pool-patch-a-2026-08-03.zip
```

SHA-256: `aeac4ce12dfae24423c1acb9e6c1b4147bcda4d4d14fb72d3f5b24f4e29cc3b2`

Production files:

```text
packages/shared-config/src/index.js
packages/event-core/src/index.js
packages/event-core/src/services/mongo.js
```

Proof files:

```text
tests/config/mongoPoolConfig.test.js
tests/event-core/mongoConnectionOptions.test.js
```

Focused gate:

```text
node --test \
  tests/config/mongoPoolConfig.test.js \
  tests/event-core/mongoConnectionOptions.test.js
```

Rollout order is inbound gateway, outbound gateway, AI bus, then control plane,
one service and health/connection observation gate at a time. A Patch A
rollback restores only its three production files and restarts only the
affected shared-connector service.

## Patch B — lead-delivery compute boundary

Archive:

```text
runtime/linux-patches/lead-delivery-compute-patch-b-2026-08-03.zip
```

SHA-256: `aec825557947fa437092fde0d3bc460db3394ac2c66473232cb2d7a057a8f713`

Production files:

```text
apps/control-plane/src/routes/phoneBurnerLeadDelivery.js
packages/shared-models/src/LeadCadence.js
packages/shared-models/src/LeadDeliveryCheckpoint.js
packages/shared-models/src/LeadDeliveryEvent.js
packages/shared-repositories/src/leadDeliveryRepository.js
packages/shared-services/src/leadDeliveryService.js
scripts/ensure-lead-delivery-compute-indexes.js
scripts/verify-lead-delivery-compute-indexes.js
```

Proof files:

```text
tests/lead-delivery/leadDeliveryCadenceSource.test.js
tests/lead-delivery/leadDeliveryRepository.test.js
tests/lead-delivery/leadDeliveryRepositoryCas.test.js
tests/lead-delivery/leadDeliveryRuntime.test.js
tests/lead-delivery/leadDeliveryService.test.js
tests/lead-delivery/phoneBurnerLeadDeliveryRoute.test.js
```

Focused gate:

```text
node --test \
  tests/lead-delivery/leadDeliveryRepository.test.js \
  tests/lead-delivery/leadDeliveryRepositoryCas.test.js \
  tests/lead-delivery/leadDeliveryCadenceSource.test.js \
  tests/lead-delivery/leadDeliveryService.test.js \
  tests/lead-delivery/phoneBurnerLeadDeliveryRoute.test.js

node --test --test-force-exit \
  --test-name-pattern="durable daily repair|incomplete daily repair|completed empty daily repair|provider runtime performs no weekend|weekday off-hours matrix|completed 17:30 close|off-hours Call End|actions-disabled off-hours|exact prior-day DNC|cross-midnight historical completion" \
  tests/lead-delivery/leadDeliveryRuntime.test.js
```

Local proof note: the named runtime boundary set above passes 10/10. A broad
unfiltered run of the historical `leadDeliveryRuntime.test.js` file did not
produce assertion output before the 304-second process timeout, so it is not
represented as a pass. The deployment gate intentionally requires the bounded
named set rather than hiding that limitation.

Deployment gate:

1. Back up exactly the eight production files.
2. Install the archive as `parallel` and verify every package hash.
3. Run syntax and the focused gate.
4. Run the read-only count-only preflight. Before promotion it may report
   missing additive indexes, but it must not expose a collection scan on an
   already-indexed required shape.
5. Run `node scripts/ensure-lead-delivery-compute-indexes.js` once. Require
   exactly four promoted names.
6. Re-run `node scripts/verify-lead-delivery-compute-indexes.js`; require
   `ok:true`, all four required indexes present, both exact-pair indexes
   present, and no blocking sort or collection scan in the six summarized
   plans.
7. Restart only `parallel-control-plane` and verify local health 200 plus safe
   lead-delivery state. Do not create a PhoneBurner write as a health test.

Patch B rollback restores only its six runtime/model/repository/route files;
the two scripts and additive indexes may remain inert. Restart only
`parallel-control-plane` after restoration.

## Live deployment evidence - 2026-08-03

- Patch A backup: `mongo-pool-a-20260803T183150Z`.
- Patch A installed five exact package files, retained `parallel:parallel`
  ownership, passed syntax and 12/12 live tests, and restarted inbound,
  outbound, AI bus, then control plane as separate health gates.
- All four services stayed active with HTTP 200. Aggregate established sockets
  fell from 175 before rollout to 36 after the idle gates. The bounded journal
  scans found zero server-selection, wait-queue, checkout-timeout, uncaught,
  unhandled, or syntax signals.
- Patch B backup: `lead-delivery-compute-b-20260803T185800Z`. Six existing
  production files and six pre-existing untracked proof files were preserved;
  the two index scripts were new. All 14 installed files matched the package
  hashes and retained `parallel:parallel` ownership.
- Patch B passed syntax, 117/117 repository/service/route tests, and 10/10
  named runtime-boundary tests on Linux before activation.
- The pre-index count-only proof found all four expected indexes absent, no
  collection scan, and both exact-pair indexes present. Exactly four additive
  indexes were promoted. The post-proof returned `ok:true` with no collection
  scan or blocking sort in any of the six plans.
- Only `parallel-control-plane` restarted for Patch B. Health stayed 200,
  runtime ticks advanced, delivery remained in `delivery_open`, and no runtime
  or bounded journal error appeared. The one-time daily repair advanced to
  version 25 with 6,250 rows fully accounted for as admitted or skipped; it was
  still running when the bounded observation ended and had not reset.
- No diagnostic PhoneBurner write or customer-data mutation was issued.
- Required natural-boundary observations remain open: repair completion plus
  a subsequent high-water tick, the 17:30 close, weekday overnight, and a
  weekend boundary. Patch C remains excluded.

## Explicit local exclusions

Concurrent MailInvoice, mailbox, NCOA, reporting, and temporary probe work is
not part of either package. In particular, do not copy or stage:

```text
.ai/context/MAIL_INVOICE_COLLECTION_DESIGN_2026-07-31.md
packages/shared-models/src/index.js
packages/shared-models/src/MailInvoice.js
packages/shared-services/src/index.js
packages/shared-services/src/ncoaMailboxIngestService.js
packages/shared-services/src/reportComposerService.js
packages/shared-services/src/mailInvoiceMailboxHandler.js
packages/shared-services/src/mailInvoiceParseService.js
packages/shared-services/src/mailboxIngestService.js
scripts/ingest-mail-invoice.js
scripts/tmp-probe-mailinvoice-types.js
tests/metrics/mailInvoiceIngest.test.js
```

## Patch C hold

The local scheduler WIP includes useful weekend hardening and a resumable
nightly-hygiene task cursor, but it is not in either Linux package. Patch C
cannot be finalized until the separate Patch G call graph establishes that no
enabled Google Sheet caller remains and the remaining spend, recording,
nightly-close, and stale-action owners each have their required durable daily
claim proof.
