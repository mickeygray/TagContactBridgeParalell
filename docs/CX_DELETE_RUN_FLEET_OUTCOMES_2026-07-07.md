# CX Delete-Run Fleet Outcomes - 2026-07-07

Purpose: record the proof run for the least-risk delete pass that removed dead CX client rails and tombstoned retired route surfaces.

This run was local/fake only. It did not touch live RingCX, Mongo, Logics, NSSM services, or real customer data.

## Deletes Under Test

- `/cx/prep` navbar visibility fix for CX controls.
- Removed the hidden page-level break strip from `CXWorkspaceBulkLoad.tsx`.
- Removed the disabled simple-loop client panel and client API hooks.
- Removed the orphan slow-single client API hook file.
- Tombstoned `/api/cx/simple-loop` with `410 cx-simple-loop-retired`.
- Tombstoned `/api/cx/slow-single` with `410 cx-slow-single-retired`.
- Updated the stale Mickey test script instruction that still pointed at `?cxSimpleLoop=1`.

## Test Fleet Design

The fleet test is `tests/cx-bulk-load/cxDeleteRunFleet.test.js`.

It proves the core loop using fakes:
- create Mickey-like bulk leads and publish them through the bulk rail;
- match a fake RingCX active call to a `cxbl` lead and attach UII;
- simulate button dispositions and verify terminal writes plus advancement;
- create a fake answered drain item and mint a wrap card;
- resolve wrap card DNC and verify interview, correction row, and DNC status effects;
- resolve wrap card appointment and verify appointment effect;
- publish a due appointment with a `cxapt` extern to the owning agent campaign only.

## Commands Run

```powershell
node --test tests/cx-bulk-load/cxDeleteRunFleet.test.js
```

Result: 3 pass, 0 fail.

```powershell
node --test tests/cx-bulk-load/cxDeleteRunFleet.test.js tests/cx-bulk-load/cxLaneDispatch.test.js tests/cx-bulk-load/cxBulkLoadRuntimeService.test.js tests/cx-bulk-load/cxCallWrapCardService.test.js tests/cx-bulk-load/cxServerWireAudit.test.js tests/queue/cxWorkspacePresenceHeal.test.js tests/queue/cxManualUnavailableRelease.test.js
```

Result: 69 pass, 0 fail.

```powershell
node --check apps/control-plane/src/routes/cxSimpleLoop.js
node --check apps/control-plane/src/routes/cxSlowSingle.js
npm.cmd run typecheck --workspace=web-client
npm.cmd run build --workspace=web-client
```

Result: route syntax, web typecheck, and production web build all passed.

## Outcome Notes

- Bulk publish/poller/disposition survived the client rail cuts. The fake Mickey session loaded `cxbl` leads, matched active calls by extern/UII, wrote terminal outcomes, and advanced to the next candidate.
- The no-answer style path still asks RingCX for the next preview lead after disposition.
- Voicemail disposition still terminates through the same single-writer terminal path.
- Wrap-card drain creation survived the route tombstones. Answered drain packets still mint cards.
- Wrap DNC still writes the interview effect, correction outbox row, and DNC status effect.
- Wrap appointment still writes the appointment effect.
- Appointment dispatch still uses the owning agent campaign and `cxapt` externs; future or unmapped appointments did not publish early or borrow another queue.
- Simple-loop and slow-single HTTP surfaces are now explicit retired responses. Their services/models remain in source for deliberate later deletion and archaeology tests.

## Pass 2: Appointment-Wrap Command Cut

Deletes under test:
- Removed the unused `CxBulkLoadAppointmentWrapResult` and `useCxBulkLoadAppointmentWrap` client API surface.
- Removed the `/api/cx/bulk-load/appointment-wrap` control-plane route.
- Removed `submitCxBulkLoadAppointmentWrap` from the bulk runtime and shared-services barrel exports.
- Removed stale appointment-wrap wording from the busy-session runtime test/comments.

Survivors intentionally kept:
- Wrap-card appointment resolution via `/api/cx/bulk-load/wrap-cards/resolve`.
- `createCxAppointment`, appointment dispatch, and appointment list/call-now surfaces.
- The busy-session primitive, because long wrap work can still need watcher protection independent of the retired endpoint.

Pre-fleet verification:

```powershell
rg -n "appointment-wrap|appointment wrap|submitCxBulkLoadAppointmentWrap|CxBulkLoadAppointmentWrapResult|useCxBulkLoadAppointmentWrap|bulk-appointment-wrap|appointmentCommittedTerminalDeferred" apps packages tests scripts
node --check packages/shared-services/src/cxBulkLoadRuntime.js
node --check packages/shared-services/src/cxBulkLoadRuntimeService.js
node --check apps/control-plane/src/routes/cxBulkLoad.js
```

Result before fleet: zero active source hits for the retired command names; runtime, runtime-service, and route syntax passed.

Post-cut verification:

```powershell
node --test tests/cx-bulk-load/cxDeleteRunFleet.test.js
```

Result: 3 pass, 0 fail.

```powershell
node --test tests/cx-bulk-load/cxDeleteRunFleet.test.js tests/cx-bulk-load/cxLaneDispatch.test.js tests/cx-bulk-load/cxBulkLoadRuntimeService.test.js tests/cx-bulk-load/cxCallWrapCardService.test.js tests/cx-bulk-load/cxServerWireAudit.test.js tests/queue/cxWorkspacePresenceHeal.test.js tests/queue/cxManualUnavailableRelease.test.js
```

Result: 70 pass, 0 fail.

```powershell
npm.cmd run typecheck --workspace=web-client
npm.cmd run build --workspace=web-client
```

Result: web typecheck and production web build passed.

## Remaining Not Certified By This Run

- Real RingCX transport behavior.
- Real Logics writes.
- Real Mongo indexes and unique-key behavior.
- Live service restart/bundle pickup.
- Legacy queue auto-serve, auto-review, EX ownership, and wrap cutover. Those are still separate cut-guide items.

## Standard Use After Future Deletes

Run the fleet after every cut:

```powershell
node --test tests/cx-bulk-load/cxDeleteRunFleet.test.js
```

Then add the narrow tests for the area being trimmed. If the fleet fails, stop and inspect before taking another cut.
