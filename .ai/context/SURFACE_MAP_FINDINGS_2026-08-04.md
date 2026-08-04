# Surface map — findings

Date: 2026-08-04
Method: two adversarial mapping passes (16 agents). Every removal claim was
handed to a verifier whose job was to REFUTE it. Static analysis only — no
Mongo reads, no writes, nothing started or restarted.
Companion to: REVISION_WORK_ORDER_2026-08-04.md

---

## THE ANSWER: don't rewrite. Sever.

The question was whether to move what works into a new app and retire this one,
rather than removing CX. The map says sever, for four measured reasons.

**1. Both of your purposes are ALREADY decoupled from CX.**

- The trainer's entire server spine is `/api/sales-trainer` (server.js:2700) →
  `taxResolutionSalesTrainerService.js`. **Zero** `cx*` service or `Cx*` model
  dependencies. The only literal "cx" in the whole chain is
  `account.cxAuth?.rcUserEmail` at `taxResolutionSalesTrainerService.js:355-356`
  — two optional fields widening an email allowlist, which degrade to "fewer
  emails" if absent.
- The report path — `reportComposerService`, `nightReportService`,
  `nightPassService`, `dailyReportFactService` — requires **no** cx module.
  `frontendReadService` only reads an `agent.cxRouting` field off a document
  already in hand.

That clean separation is exactly what a rewrite would be trying to build. It
already exists.

**2. Auth was the feared wall. It is a no-op.**

`middleware/auth.js:15` requires `cxTokenStorageService`, but both symbols are
used **only** inside `requireCxOAuth` (auth.js:128-154), and that function
cannot do anything:

- Line 130 returns `next()` when `isCxUserOAuthRequired()` is false, which reads
  `RC_CX_REQUIRE_USER_OAUTH` defaulting false — **absent from `.env`**.
- `REQUIRED_CX_RINGCENTRAL_SCOPES = Object.freeze([])` (auth.js:20), so the
  scope check is `[].every(...)` — vacuously true even if the flag were on.

Severing the import is a **provable zero-behavior-change edit**. Login is
email-OTP only; there is no password anywhere in the repo.

**3. Twelve edits move ~62 files / ~57k lines into one severable component**,
dropping the live-path keep set from 25 files to 7. The four edit groups are in
§4 of the work order.

**4. A rewrite does none of that work.** The 57k lines of CX services, the
installed `ParallelRingCentralCx` service, the 1-second watcher — all backend.
They survive a front-end rewrite completely untouched. You would do the same 12
edits either way, **plus** port a working trainer.

### What makes it a re-plumbing job, not a delete

The front end is the part where CX is genuinely load-bearing — for the trainer:

- **The trainer's shell IS the CX shell.** `/cx/coach` → SalesTrainerWorkspace
  (routes.tsx:251-257) and `/cx/manual` → FieldManualWorkspace
  (routes.tsx:259-265). The field manual's **only** route is `/cx/manual`.
- **Post-login landing is `/cx` for every non-admin** (`lib/auth/landing.ts:21-25`).
  A future hire logs in and lands on the dialer behind a RingCX OAuth
  redirect (`CxAuthGuard.tsx:38-56`, "Admins are NOT exempt") — not on the
  trainer.
- The trainer's "My calls" tab fetches `/api/read/cx/recordings/library`
  (`TrainingCenterPanels.tsx:303`), served by `readCx.js:971`.

Saving grace: the trainer **also** mounts at `/trainer/*` (routes.tsx:92-99)
**outside** the AuthGate, with its own OTP sign-in against
`/api/sales-trainer/auth/*`. A future hire can be given trainer access with no
app account at all. Purpose #1 survives a full CX teardown — but only because
`/trainer` exists.

So the front-end CX removal is roughly three edits — repoint `landing.ts`,
mount the field manual outside `/cx`, repoint the recordings library — not an
`rm -rf`.

---

## URGENT — surfaced in passing, unrelated to CX

**1. A live public-facing bot has no off switch.**
`socialResponderService` talks to `graph.facebook.com/v21.0` off stored
`SocialResponderConfig`, with a registered retry handler
(`hourlyJobHandlers.js:372-373`). Server routes are mounted and live:
`server.js:2557-2558` (`/fb/webhook`, `/tt/webhook`), `:2662`
(`/api/commands/social`), `:2693` (`/api/read/social`).

The **only** UI that can read or write its `enabled` flag, trigger keywords, and
reply templates is `SocialWorkspace.tsx` — which is **parked**: not routed, not
in the nav, carrying an explicit `Do NOT delete this file` banner with restore
instructions. A bot is auto-replying to Facebook/Instagram comments and DMs in
the company's name right now, and the only way to change a template or shut it
off is a hand-edit in Mongo. Restoring the screen is two edits (a lazy import +
`<Route>` in `routes.tsx`, an entry in `workspaceRegistry.ts`).

**2. Contact-safety trap in CX cleanup.**
`leadDeliveryService.js:2764` calls `readLegacyDailyAttemptFloor`, which reads
**CxTerminalOutbox** (`leadDeliveryRepository.js:1200`) and folds
`terminalOutboxCallCount` into a `Math.max` **dial-frequency floor**
(leadDeliveryService.js:2769-2775). Emptying or dropping that collection
**lowers** the floor — the failure mode is **over-dialing, and it is invisible**.
CxTerminalOutbox cannot be dropped as "frozen since Jul 10" without replacing
this read.

**3. Unauthenticated live write path.**
`/api/lead-delivery/phoneburner` (server.js:2405) has no auth middleware;
server.js:2372 literally declares `callbackAuthentication: "none"`.
`/api/client/runtime` (:2427) and the public `/test-lead` proxy (:2561) look
accidental too. The other six unauthenticated mounts are deliberate
signature/ticket-gated capability URLs.

**4. CX cycles — SMALLER than the map claimed. Corrected against `.env`.**
The map warned that six CX workers default ON in code. Four are explicitly
disabled in this repo's `.env`, so only two are live by default:

```
CX_ACCOUNT_ACTIVE_CALL_WATCHER_ENABLED   = false   (:716)  1s tick — OFF
RC_CX_CADENCE_WORKER_ENABLED             = false   (:598)          — OFF
RC_CX_FRESH_HOT_LANE_ENABLED             = false   (:730)          — OFF
CX_APPOINTMENT_WORKER_ENABLED            = false   (:713)          — OFF
CX_TERMINAL_OUTBOX_DRAIN_ENABLED         = ABSENT  -> default TRUE, every 15s
CX_RESERVATION_RECONCILER_STARTUP_ENABLED= ABSENT  -> default TRUE, every boot
```

Still true: three `setInterval` timers at 15s/30s/60s (server.js:2827, 2843,
2865) fire forever only to read an env flag that is false.

**CAVEAT — these are THIS box's values, and this box runs nothing.** See §0
below. The live host has its own `.env`; the two defaults above are unverified
there.

**5. Repo trap — duplicate source trees.**
`runtime/cx-round-2-live-merge-v2/` and `-v3/` are **full source snapshots**.
Any "only N references repo-wide" count made against the top-level tree is
incomplete. Verify which tree the running services load before acting on a
reference count.

**6. Two permanent 404s.**
Deploy's Landing Pages card calls `/api/read/landing-pages/pending` but the
handler is at `/api/read/deploy/landing-pages/pending` (`readDeploy.js:105`
under server.js:2685) — and `readDeploy.js:42` repeats the same wrong prefix.
AdminShell.tsx:138's "Settings" button points at `/admin/settings`, which has no
route and silently bounces to `/`.

---

## The trainer is half-dark — and one half CANNOT light up

This is the most important finding for purpose #1.

| Piece | State |
| --- | --- |
| Voice roleplay cockpit (2,836 lines, 16 personas, 9 presets) | **WORKS** |
| Field manual (114 entries, 95 drills, ~7,600 lines) | **WORKS** |
| Study tab / My Calls | **WORKS** |
| Guided course (home, rail, lesson, quiz, attempt results) | **DARK** — `SALES_TRAINER_COURSE_V1_ENABLED` absent from `.env`. A flag flip. |
| Case Review panel | **DARK** — `SALES_TRAINER_CALL_REVIEW_V1_ENABLED` absent. A flag flip. |
| **Gauntlet player** | **CANNOT REGISTER** — `salesTrainer.js:291` reads `config.trainingGauntletService`, which is **never assigned anywhere in the repo**. Three endpoints (voice-session, voice-turns, module-answer) have no server route at all. |
| **Free Call player** | **CANNOT REGISTER** — same: `config.trainingFreeCallService` never assigned (`salesTrainerCourse.js:375-442` sits behind `if (freeCallService)`). |

Flipping the flags lights the course but leaves Gauntlet and Free Call 404ing.
Those need config wiring, not a flag.

**Two content stores, one populated.** The real curriculum is the front-end
field manual (`workspaces/field-manual/content/*`, compiled into the bundle).
The server-side publish path `packages/shared-services/src/trainer-content/` is
**empty draft stubs** — `courseManifest` items `[]`, `ruleRegistry` rules `[]`,
`scenarioBlueprints` `[]`. This confirms the standing memory note.

**Do not "clean up" the dark gauntlet services.** `trainingGauntletService`,
`trainingGauntletController`, `trainerGauntletState`, and
`trainingFreeCallCourseService` are route-unreachable but are the **sole
writers** of live, boot-loaded persistence contracts that stay:
`TrainingAttempt.js:11` hardcodes ten gauntlet event types in a schema enum,
`:58` declares `gauntletState`, and `trainingCourseRepository.js:166-192`
implements gauntlet CAS with `expectedGauntletStateVersion`. All four are
required at module load by `shared-services/src/index.js` (:826, :827, :828,
:832), which `server.js:208` requires — **deleting any of them without a
same-commit barrel edit is a boot failure of the process that runs lead
delivery, inbound intake and DNC safety.**

---

## Where the front end actually stands

~40,700 lines, 24 screens across 18 workspace directories, one hand-written
`<Routes>` tree, three shells. Stack is current (React 19, Vite 6, Router 7,
TS 5.7, Tailwind, react-query, zustand) — nothing to escape.

- **~12,000 lines are CX dialer surface** — `CXWorkspaceBulkLoad.tsx` alone is
  5,959 lines, plus a 2,349-line legacy coach panel.
- **Reachability is unusually clean** — every sidebar and CX nav entry points at
  a route that exists. Almost no URL-only screens.
- **Orphans: three modules, not one.** `ClientsWorkspace` (757 lines, never in
  the admin nav — a no-op for you), `metricFamilies.ts` (dead classification
  logic *inside* the metrics workspace), and `queries/review.ts`.
  `queries/hygiene.ts` is a **live API with no UI at all** — `/api/hygiene` is
  mounted at server.js:2668-2675 with ~20 real routes.
- **`drillBank.ts` looks orphaned but keep it** — it is the only implementation
  of `pickDrillSet` (seeded mulberry32 shuffle + sample-N). The live Study panel
  renders every drill in fixed order and has no shuffle logic. It is also a
  named reference in the active trainer curriculum work order.
- **Dead registry exports**: `cxWorkspaces` and `allWorkspaces`
  (`workspaceRegistry.ts:166-177`) have zero consumers; `AdminShell.tsx:24`
  imports only `adminWorkspaces`.
- **`/resolution` has no SPA fallback** (server.js:630-634 lists only `/`,
  `/login`, `/admin/*`, `/cx/*`, `/trainer/*`) — a bookmark or refresh 404s,
  even though `landingPathForUser` can send users there.
- **`live-coach` is honestly dormant** — `VITE_LIVE_COACH_PANEL_ENABLED`,
  documented default-off at `.env:802`. It ships zero bytes of behavior and is
  the only in-call assistant implementation. Keep for purpose #3; it is welded
  to the dialer, so decide it jointly with `CXWorkspaceBulkLoad`, not separately.

---

## §0 PARTIALLY ANSWERED — it is NOT this box

Measured 2026-08-04:

```
ParallelAiBus            Stopped  Manual
ParallelControlPlane     Stopped  Manual
ParallelInboundGateway   Stopped  Manual
ParallelMongo            Stopped  Manual
ParallelNginx            Stopped  Manual
ParallelNgrok            Stopped  Manual
ParallelOutboundGateway  Stopped  Manual
ParallelRestartHelper    Stopped  Manual
ParallelRingCentralCx    Stopped  Manual
```

All nine are stopped — yet spendSync wrote 08-03 19:45, hygiene and night-persist
19:50, and lead intake landed 08-04 09:29. **The live control plane therefore
does not run on this machine.** (`ParallelMongo` being stopped is consistent —
we connect to the shared Atlas cluster, not a local instance.)

Three consequences, all of which matter today:

1. **Commits `eecc0bf` (floor enables) and the `.env` `BLOGGER_ENABLED=true` are
   NOT live**, and will not be until this branch is deployed to whatever host is
   actually serving. §1 and §2 are written, not finished.
2. **Every `.env` value quoted in this document is this box's**, including the
   CX flags above and the missing `SALES_TRAINER_*_V1_ENABLED` flags. The live
   host's values are unverified — the trainer course may already be lit there.
3. `apps/ringcentral-cx` is **not running here**, so its boot-dependency cone is
   only a constraint on the live host.

Remaining: identify the host. `ubuntu@tagcontactbridge` does not resolve from
this shell and there is no `~/.ssh/config`; `docs/` mentions `18.216.244.101`
and `3.22.168.127`. Confirm with Mickey before connecting.

---

## Open questions the map could not answer statically

1. Are the `SALES_TRAINER_*_V1_ENABLED` flags set in the **nssm service
   environment** rather than the repo `.env`? If so the course is already live
   and several verdicts flip.
2. Is `apps/ringcentral-cx` (installed as `ParallelRingCentralCx`,
   `ops/nssm/install-services.ps1:160-166`) actually running? Its top-level
   requires make `cxMorningQueueBuilderService`, `cxRuntimeModeService`,
   `cxCadenceService`, `dialService` and `ringcentralExService` **boot
   dependencies**. If stopped, four more files become severable.
3. Is `apps/ai-bus` running? It is the only consumer of `liveCoachCloseoutService`
   and `liveCoachVmTransferService`.
4. Does `readLegacyDailyAttemptFloor` still return rows? (See urgent #2.)
5. Does `cxRecordingHourlyService` still recover anything, or is it a keep that
   recovers nothing now that PhoneBurner recordings arrive on a separate path?
6. Do the CX workers that default ON have explicit `.env` values? If unset they
   are all running right now.
