# CX Account Active-Call Watcher Plan

This is the active-call truth layer for the broader rail unification plan:

- [CX_RAIL_UNIFICATION_PLAN_2026-06-23.md](C:/code/TagContactBridgeParalell/docs/CX_RAIL_UNIFICATION_PLAN_2026-06-23.md)

## Purpose

The account active-call watcher is the shared truth layer for every CX dial rail:

- slow/steady single-call mode
- legacy/next-call-send mode
- bulk-load mode

RingCX is the source of "who is on the phone now." The app should not guess from local queue order, phone enrichment, or optimistic button state.

## RingCX Shape

Use one account-level call per RingCX account:

```text
GET /voice/api/v1/admin/accounts/{accountId}/activeCalls/list?product=ACCOUNT&productId={accountId}
```

Then filter locally by `externalId`, `queueItemId`, and `uii`.

Do not poll per agent. RingCX documents `AGENT` as a reserved product value that does not return useful active-call results. Per-agent polling also burns rate limit and makes cross-agent state drift more likely.

## Core Rule

One account snapshot fans out to every active rail session for that account.

```text
RingCX account active calls
  -> normalize once
  -> group active local sessions by accountId
  -> project each session from only its relevant externIds
  -> write only changed session projections
```

The first implementation lives in:

- `packages/shared-services/src/cxAccountActiveCallWatcherService.js`
- `scripts/cx-account-active-call-watch-once.js`

## Boundary Rules

The watcher may update:

- current `uii`
- current `externId`
- current queue item identity
- active-call summary
- seen/released trace fields

The watcher must not:

- run Logics lookups
- write DNC
- write cadence/call counts directly
- refill queues
- select leads
- enrich the middle panel by phone
- infer a lead by phone number

Terminal/count writes belong to a separate terminal outbox/drain. If RingCX auto-advances a call with no button outcome, that should become an explicit terminal observation event, not hidden watcher business logic.

## Mode Integration

### Slow/Steady

Slow mode should still load one lead at a time, but it should not maintain a private active-call poller. It should read the shared account watcher projection.

The slow rail owns:

- selecting one lead
- publishing one lead
- terminal button handling
- next lead request

The account watcher owns:

- detecting when RingCX has actually made that lead current
- exposing the current UII to the UI

### Next-Call Send / Legacy

Legacy should use the same watcher projection to remove the old desync-prone assumption that "the lead we sent is definitely the lead now active."

The legacy rail owns:

- terminal submission
- next-call send
- queue bookkeeping

The account watcher owns:

- current call identity
- active UII proof
- detecting that RingCX advanced to the next call

### Bulk Load

Bulk load should use the watcher as the primary current-call source. Bulk may have a larger accepted buffer, but the UI should only show the lead RingCX reports active.

The bulk rail owns:

- reserving a buffer
- loading accepted leads
- terminal button writes
- refill when remaining buffer crosses threshold

The account watcher owns:

- crossing accepted buffer items into `current`
- detecting RingCX auto-advance
- preserving UII proof for terminal/outbox handling

## First-Draft Behavior

The first draft is conservative:

- one `activeCalls/list` request per account
- local fan-out to active bulk sessions
- only writes changed session projections
- filters the account snapshot to each session's relevant `externId`s before projecting
- strips phone fields from stored watcher trace
- dry-run one-off by default

Run dry:

```bash
node scripts/cx-account-active-call-watch-once.js --json
```

Run apply after inspection:

```bash
node scripts/cx-account-active-call-watch-once.js --apply --json
```

## Control-Plane Worker

Implemented as a control-plane worker:

1. Ticks every 1 second by default (`CX_ACCOUNT_ACTIVE_CALL_WATCHER_INTERVAL_MS`, minimum 500ms).
2. Lists running bulk sessions first; with no sessions, it does not call RingCX.
3. Groups sessions by RingCX account.
4. Calls `activeCalls/list` once per account per tick.
5. Fans out projections to matching sessions only.
6. Writes only changed projections.
7. Stores compact health output under `workers.cxAccountActiveCallWatcher`.
8. Skips only sessions currently inside a bulk command mutation (`session-busy`) so one agent's disposition/refill cannot pause the rest of the floor.
9. Browser bulk mode no longer posts `/api/cx/bulk-load/watch`; the UI refetches `/session` and renders the server-projected state.

Keep browser polling as read-only after this is stable. The browser should display state, not create state.
