# AI Bus Audit — 2026-07-01

Correctness + streamline audit of the AI bus (port 7000) and everything that rides it. Scope:
`apps/ai-bus/src/*` (server.js 4,644 + satellites), the provider/task spine
(`aiProviders` / `aiTaskRegistry` / `aiTaskRunner` / `aiBusRegistry` / `aiTaskClient` / `aiPrimitives`),
the coach loops (`coachFloorLoop` / `coachSoloLoop` / `coachBatchRunner` / transports),
`liveCoachBusService.js` (3,381), and the consumer side (control-plane proxy, web-client stream,
grader/blogger, repo-wide AI callsites). Method: five parallel audit agents under strict
cite-current-code discipline, then an independent verification pass on the highest-impact findings
(10/10 spot-checks upheld; one severity corrected against the live box env).

**Not covered** (second-class per audit doctrine): Docker/infra, secrets handling, AWS.

Legend: severity `HIGH/MED/LOW` · `V` = independently re-verified this session · `×N` = found
independently by N audit agents.

---

## TL;DR

No HIGHs — nothing is corrupting live floor behavior today, largely because the risky lanes
(batch/solo coach) are still default-off. But the solo pilot would trip three confirmed MEDs on day
one (truncation retry loop, write-only steering, partials-driven fire rate), the client SSE layer has
a frozen-cockpit failure mode that already bites on every bus restart, the model-policy admin surface
is largely fictional, and the "universal bus" doctrine is honored by exactly three consumers while
the biggest AI spend runs beside it. Streamline: ~2,600 lines of server.js are extractable/deletable
(embedded dashboards + dead routes + dormant judge era), three copy-pasted Anthropic transports
should be one, and liveCoachBusService needs a cohesion split, not deletion.

---

## A. Correctness — the coach lanes (batch/solo; default-off today, solo pilot imminent)

- **A1 [MED][V] Reactor truncation silently swallows a batch and advances the cursor.**
  `coachBatchTransports.js:126` caps reactor max_tokens (default 700) and never checks
  `stop_reason`; truncated JSON survives none of `repairModelJson`'s three passes
  (`coachBatchRunner.js:363-388`), `coerceResponse` degrades to `{guidance:[]}` (:403), and
  `tickReactor` treats that as an accepted pass — cursor advances over the dropped turns
  (`coachFloorLoop.js:132-135`). On boot/cursor-reset the whole floor lands in one call, easily
  >700 output tokens. This is the same silent-drop class `repairModelJson` was shipped to fix.
  *Fix:* transport returns `ok:false` when `stop_reason === "max_tokens"`; mirror the solo loop's
  empty-guidance non-advance.

- **A2 [MED] Solo truncation = a permanent, paid 10-second retry loop.** Same truncation path,
  opposite cursor policy: solo does NOT advance on empty guidance (`coachSoloLoop.js:158-171`), so a
  response that will always exceed `coachSoloTransport.js:48`'s max_tokens re-fires the identical
  billed request every 10s forever — no backoff, no escalation, coach silent. Fine at pilot scale
  (1 call), wrong at 4+ concurrent. *Fix:* same stop_reason signal + scale max_tokens with
  conversation count.

- **A3 [MED][V] The growth gate fires on STT partials, not committed turns.** The change signature
  hashes `provisionalTranscript` counts and last-rows (`liveCoachBatchProjectionService.js:341-354`),
  so continuous speech holds the gate open: solo pays a full-floor Sonnet call every 10s, the reactor
  re-reacts to the same turn's partials every 4s. This is the eval's "unfiltered count fires ~70%
  more" gap, live in the current loops — and the substance-floored trigger the two-station design
  needs has to land here anyway. *Fix:* signature over committed transcript only.

- **A4 [MED] No backoff or circuit breaker on transport failure.** 429/401/dead-metered-key →
  fixed-cadence retries (4s reactor / 10s solo) with Retry-After ignored and no operator signal
  beyond a warn log. Deliberate no-failover to the Max key is correct for rate isolation, but a dead
  key mid-shift = silent coach + a failed HTTP call per tick. *Fix:* exponential backoff on
  consecutive `ok:false` + counter/alert.

- **A5 [MED][V] Deep/solo steering writeback is write-only — `serializeSession` drops it.**
  `applyDeepSteering` writes `session.callStrategy` (`liveCoachBusService.js:3194`) but
  `serializeSession` (:1110-1130) has no such field, and the batch projection reads the serialized
  row (`liveCoachBatchProjectionService.js:266` falls back to `metadata.callStrategy`, which only
  `attachCallStrategy` writes). The comment ":3187 callStrategy feeds the fast reactor" is currently
  false. Silently no-ops the moment solo pilots. *Fix:* write `metadata.callStrategy` in
  `applyDeepSteering` (or serialize the field).

- **A6 [MED][SUSPECTED] Turn-ordering race under `asyncContextPipeline` (prod default true).** Two
  overlapping `processContextAndDialog` runs have no sequence token; whichever judge resolves last
  owns `session.latest.context/dialog` (`liveCoachBusService.js:1703/1729`) and can supersede the
  newer turn's compose (:2095-2116) — an older utterance's coaching can win. Related hold-clear
  interleaving can drop a buffered utterance silently (:608, :893). Window is measurable from
  emitted `elapsedMs`. *Fix:* monotonic turn seq; discard stale results.

- **A7 [MED] `appendInput` serializes the full session per STT packet; the bridge reads one field.**
  Every return path sends `serializeSession(session)` (:2513/2540/2546/2580) — memory arrays, 50
  events, thought buffer — hundreds of KB of JSON per VAD packet per agent on long calls; the only
  live caller reads `result?.session?.status` (`scripts/ringcx-grpc-live-coach-bridge.js:464-471`).
  *Fix:* return `serializeSessionSummary` (or `{id,status}`) from `appendInput`.

- **A8 [MED][SUSPECTED] `askCoach` can wedge for the rest of the call.** `askInFlight` (:2663/:2684)
  is cleared only in then/catch (:2726/:2735); no timeout, no AbortController, and
  stopSession/markSessionStale don't clear it. A hung composer promise = dead Ask button until the
  session ends. Severity depends on the composer transport's own timeout (unverified). *Fix:*
  timeout+abort around the ask compose; clear the flag in `abortActiveDialogComposer`.

- **A9 [LOW] Pruned sessions can fire an orphaned hold-expiry composer call.** `pruneSession`
  (:1243-1269) and `markSessionStale` (:1225-1236) never `clearHoldExpiry`; `pruneSessionsForCall`
  prunes any-status sessions, so a still-"listening" pruned session's armed hold fires ≤2.5s later —
  one wasted Sonnet request, dies at first `isCurrent()`. *Fix:* clear the timer in both.

- **A10 [LOW][×2] `emitBatchGuidance` never returns `true`** despite its contract comment
  (:3154-3155 vs :3184); solo dedup survives only because it tests `!== false`
  (`coachSoloLoop.js:189`). Also note: batch-mode lines never enter avoid-repeat memory or
  dialog.ndjson (may be deliberate). *Fix:* `return true`.

- **A11 [LOW] `coerceResponse` drops a single-row `res.json`** (`coachBatchRunner.js:392-399`) —
  only json-returning transports (stub, codex summary) can hit it.

- **A12 [LOW] Solo mode force-disables the summary sidecar (`server.js:3498`) while the DEEP prompt
  still claims a rolling summary is maintained** (`coachBatchRunner.js:44-45`); structured buckets
  (:239-247) always absent in solo.

**Verified clean (traced, worth knowing):** the two loops cannot run simultaneously from current
call sites (single ternary start + runner-set double-guard); tick reentrancy is guarded everywhere;
one bad session can't poison a batch; call-end mid-tick is handled; **the prompt-cache layout claim
holds** (stable system block, no timestamps, single `cache_control`; the claude -p deep path uses a
content-hashed temp file); session memory is bounded everywhere (disk ndjson is the only unbounded
growth, plus a sync `appendFileSync` per event on the hot path worth making async).

## B. Correctness — the bus app (server.js + satellites)

- **B1 [MED][×3] The model-policy admin surface is largely fictional.** (a) The dialog composer
  never calls `resolveCoachModel` — an override for `liveCoach.dialogComposer` is accepted, echoed,
  and ignored (`server.js:1070-1315`; the only real call sites are :365/:580/:707/:882). (b) All
  four batch/solo coach transports resolve policy **at factory time** (boot), so a runtime push can
  never reach them (`coachBatchTransports.js:81/:121/:276`, `coachSoloTransport.js:43`) — and their
  four keys aren't in `COACH_ALLOW` (`liveCoachModelPolicy.js:32-41`), so the documented read-time
  clamp is skipped for exactly them. (c) The claimed 5001 cold-load / policy push
  (`liveCoachModelPolicy.js:10-17`) does not exist anywhere — an override does not survive restart;
  `applyCoachPolicy` has exactly one caller (the POST at `server.js:4141`). *Fix:* resolve per-call,
  register the allow-sets, and either build the cold-load or rewrite the module comment and treat
  the surface as curl-only.

- **B2 [MED-posture / LOW-live][V] Dashboard auth fails open when `AI_BUS_DASHBOARD_TOKEN` is
  unset** (`server.js:1002-1016` — contrast the always-fail-closed `aiRoutesAuth` :3719-3726).
  Unauthenticated in that state: session stop/ask, fixtures, composer-tier POST, model-policy POST,
  and two Opus-burning routes (`/call-strategy` :4033, `/api/ai/resolution/pitch` :4071).
  **Verified: the token IS set in the live box `/opt/tagcontactbridge-parallel/.env`** — so this is
  posture, not exposure. *Fix:* mirror the fail-closed pattern anyway (one forgotten env var away).

- **B3 [MED] Dashboard GETs mutate state and hit Mongo per poll, per client.**
  `buildLiveCoachDashboardPayload` (:3884-3902) runs a Mongo query AND
  `retireReplacedSessions...{apply:true}` on every 1.5s poll from every open dashboard; the
  wallboard's 10s sync-current re-ensures shells — the ghost-recency fallout is documented in-code
  (:2533-2535) and patched around in three places (:1787, :2536, :3940). *Fix:* read-only GETs; one
  server-side sync/retire interval beside the stale sweep.

- **B4 [MED] Shutdown hangs while SSE clients are connected.** `shutdown()` (:4612-4635) waits on
  `server.close()`; SSE routes hold connections open with heartbeats; no `closeAllConnections()`,
  no force-exit timer → SIGTERM hangs until systemd SIGKILL; `disconnectMongo` never runs. *Fix:*
  close SSE responses + 5s force-exit.

- **B5 [MED] Boot listen failure = zombie process.** `app.listen` (:4608) has no error handler; a
  port conflict lands in the process-level handler (:101-103) which deliberately does not exit —
  the process stays "healthy" serving nothing. *Fix:* `server.on("error")` → log + exit non-zero.

- **B6 [MED] Without Mongo, no sweep ever runs.** The stale-sweep timer (:4565-4600) exists only
  when `mongoBridge` does; boot survives Mongo failure (:3411-3420), but `pruneTerminalSessions`
  (which needs no Mongo) only runs inside the sweep → unbounded session Map in that mode. *Fix:*
  unconditional terminal-prune timer; Mongo-gate only `cleanupDeadStreams`.

- **B7 [LOW] Call strategist silently runs with an empty doctrine** if the script file read fails
  (:333-342, no check at :356) — contrast the pitch agent, which disables itself (:454).

- **B8 [LOW] `localBusServer.js:72` run route has no try/catch** — a runner throw hangs the request
  (dev-only tool).

## C. Correctness — the provider/task spine

- **C1 [MED][V][×2] The runner retries non-retryable errors across the whole model ladder.**
  `classifyError` computes `fatal` for `retryable === false` (`aiTaskRunner.js:39-43`) but the loop
  only breaks on `err.unsupported` (:285) — a deterministic 400 (bad schema, oversized prompt,
  missing key) burns every model on every provider before failing closed. The provider clients mark
  4xx non-retryable *specifically for this classification* (`openaiClient.js:10`). *Fix:* break the
  model loop on fatal (keep cross-provider failover for key/config errors).

- **C2 [MED] Caller-abort doesn't bound spend.** The abort signal is checked only at the top of the
  provider loop (:188-194), never in the model loop, and never forwarded into the adapters' fetches
  — after a client disconnect the runner still starts every remaining model of the current provider.
  `aiTaskRoutes.js:69-83` wires req-close→abort expecting exactly this bound. *Fix:* check in the
  model loop + pass the signal through to the HTTP calls.

- **C3 [MED, latent] The planned agent providers will silently vaporize the whole task surface.**
  A descriptor with `provider: "codex"`/`"claude-agent"` → `defaultModelFor()` null → empty ladder →
  `assertBusRegistryIntegrity` throws at `buildBusRegistry()` (`aiBusRegistry.js:38-53`); and
  `otherProvider()` (:29) is a hardcoded anthropic↔openai toggle. The server wraps the mount in
  try/catch marked "non-fatal" (`server.js:3730`) — so the real failure is one console.error and
  ALL `/api/ai/task` routes gone, with downstream consumers failing closed. This is the
  headless-wiring plan's named risk, confirmed worse than predicted. *Fix:* allow model-less
  declared providers in the assert; surface mount failure in `/health`.

- **C4 [MED][SUSPECTED] Anthropic search loop treats `pause_turn` as failure**
  (`aiProviders.js:86-90` — any non-`tool_use` stop aborts/restarts the whole multi-turn search).
  Bites on long searches; blogger has been lucky so far.

- **C5 [LOW] `aiPrimitives` bare `model` becomes `forceModel` for BOTH providers**
  (`aiPrimitives.js:52-56` + `aiTaskRunner.js:107`) — guaranteed 4xx on the failover leg. Zero
  production callers today; becomes MED the day one appears.

- **C6 [LOW] `qualityMode`/`useAi` tiers are a no-op** — no task anywhere defines `task.quality`
  (`aiTaskRunner.js:116`, `aiTaskClient.js:83-85`).

- **C7 [LOW] Base registry vs sandbox registry drift.** The live bus takes only primitives from the
  base registry (`aiBusRegistry.js:138-150`); the base's named tasks (activity review, sms.classify,
  `liveCoach.callGrade`, resolution.pitch, blogger) are shadowed by sandbox versions with real
  drift (two different activity prompts; dead `callGrade` vs live `callGrader`). *Fix:* delete or
  quarantine the superseded base entries.

- **C8 [LOW]** Synthetic provider `supports: () => true` but runs 5 kinds (`aiSyntheticProvider.js:57`);
  `aiTaskClient` JSON.stringify mangles Buffers so modality tasks aren't actually transportable
  (:51); `liveCoachTranscriptTranslator` is built-but-unwired (scripts + tests only).

**Verified clean:** bidirectional failover is real and asserted both directions; route auth on the
task surface is genuinely fail-closed (refuses to mount open even in dev); no provider is ever
marked permanently dead; privileged-option stripping tested.

## D. Correctness — consumers (proxy, web-client)

- **D1 [MED][V] Frozen cockpit after a graceful stream close.** Reader `done` → `break` →
  `streamLiveCoachEvents` returns normally (`stream.ts:311`) → the retry wrapper treats return as
  terminal success and never reconnects (:358-360). A bus restart or idle close freezes the cockpit
  (and the legacy panel, which recovers only from fatal errors) with connection showing "open".
  *Fix:* treat `done` without an intentional abort as a retryable condition.

- **D2 [MED][V] The retry budget never resets after a successful reconnection** (`stream.ts:356-368`
  — `attempt` accumulates for the wrapper's lifetime; 12 blips over a shift = permanent "error").
  *Fix:* reset `attempt` after a healthy open (e.g., N seconds connected).

- **D3 [MED][V] Proxy SSE backpressure wait can hang the handler forever.**
  `liveCoachProxy.js:500-501` awaits `drain` with no close/error race; a slow client that
  disconnects mid-backpressure leaks the handler, the upstream body, and buffered chunks for the
  process lifetime. *Fix:* race drain vs close/error (or `stream.pipeline`).

- **D4 [MED][SUSPECTED] The proxy scope gate degrades to no-op when identity metadata is missing**
  (:147-167 caller-supplied extension passes unchecked for a user with no extensions on record;
  :184-199 a session with neither extension nor agentEmail is readable/stoppable by any
  `coach.view` user). Exploitability depends on metadata stamping uniformity.

- **D5 [MED][SUSPECTED] `GET /session-for-call` is a mutating poll** — it converts to
  `POST bind/latest` with `retireReplaced: true` (:337-362) and the legacy panel polls it every
  1.25–5s per agent. A read-shaped poll continuously driving a bind/retire write is the 06-17
  incident shape in miniature. *Fix:* a genuinely read-only lookup for the poll.

- **D6 [LOW]** 4xx retried as transient (12 retries × session lookup each); client disconnect during
  the connect phase aborts nothing (:493 registered after fetch); dead undici keep-alive agents
  (:21-37, self-admitted). **No memory-growth finding** — snapshots fold, transcripts bus-capped.

## E. Doctrine — the wiring gap

The bus contract (provider-agnostic, bidirectional failover) is real and tested — and almost nobody
uses it. Through the spine today: activity review (default-off), nightly call grades
(default-off), blogger current-event (in-process). Everything else is direct:

- **E1 [MED][V] The live call grader is not what we think it is.** `server.js:3447` wires a
  hand-rolled OpenAI-only fetch (:649-767). `CALL_GRADER_PROVIDER` and `claudeAgentJson` exist in
  **zero code files** (docs only — the 06-24 rollover replaced the agent grader and the docs/memory
  never caught up). Meanwhile the registered `liveCoach.callGrade` task with bidirectional failover
  sits tested with zero callers. OpenAI outage = grade lost (fail-open to no-grade, at least safe).
  *Fix:* call `runAiTask("liveCoach.callGrade", ...)` at closeout and delete the twin.

- **E2 [MED][×3] Max-pool `claude -p` spend is invisible and exhaustion is unguarded.** The deep-pull
  transport discards the CLI envelope's `total_cost_usd` (`coachBatchTransports.js:87-101`; only the
  eval script reads it), there's no distinct credit-exhaustion error class, no alert, no failover to
  a metered key — the deep tier dies silently mid-month. Stale "flat cost"/"no key needed" comments
  (`claudeAgentRunner.js:6-8`, `coachBatchTransports.js:76`) actively mislead. *Fix:* per-spawn cost
  telemetry + distinct exhaustion class + alert (and fix the comments).

- **E3 [MED] Six bespoke provider-hardwired callers live in server.js beside the bus** — Anthropic:
  call strategist (:356-434), resolution pitch (:452-534), dialog composer (:1070-1315); OpenAI:
  rolling digest (:551-633), call grader (:649-767), context judge (:769-975). None fail over. The
  streaming latency-bound composer is legitimately bespoke; the pull-shaped three (strategy, pitch,
  grader) are registry-fit. The coach hot lanes (reactor/solo/summary metered-key transports) are
  *deliberately* off-bus for rate isolation — migrate last, after C1/C2 are fixed.

- **E4 [MED] `smsClassifierService.js:594` is a direct, hard-pinned opus call on a COMPLIANCE
  path** while the `sms.classify` bus task (475-line prompt, `needs_human` fail-closed, failover)
  sits unused. Smallest diff, biggest doctrine win.

- **E5** Other bypass callsites (full map in the audit trail): salesTrainer's four raw fetches
  (responses/tts/transcribe re-implementations), transcriptionScoring raw whisper + anthropic with
  an aging sonnet-4-5 pin, `blogger-claude-writer.js` direct SDK with a dated model pin (flagged
  06-24, still live). Web-client: zero direct AI calls (correct).

- **E6 [LOW]** Tenant/roster hardwiring in server.js (firm name, closeout email domain, manager
  recipients, wallboard PINNED_AGENTS in HTML) — every roster change is a deploy.

## F. Streamline

- **F1 Extract the two embedded HTML dashboards** — ~1,990 lines of template literals, 43% of
  server.js, inert strings, trivial risk. The single biggest readability win.
- **F2 Delete confirmed-dead server surface:** the six `monitor/*` alias routes (grep: zero
  callers), `GET /api/ai/catalog` (dead AND stale), the duplicated SSE handler (byte-copy of
  `writeCoachSessionEventStream`). ~250 lines.
- **F3 Retire the mini context-judge era** (~420 dormant lines: :205-325 machinery + :769-975
  judge) — default-off, in-code verdict says the deterministic gates + WAIT replaced it, and the
  two-station coachability gate takes this job. Confirm no revival plan first. Related dormant
  knobs (`miniVetoScope`, `thoughtBuffer*`) go with it.
- **F4 One shared metered-Anthropic transport.** `createReactorTransport`, `createSummaryTransport`
  (api branch), `createSoloTransport` are the same ~60-line fetch body ×3 (~180→60 lines) — and the
  single place the A1/A2/A4 stop_reason + backoff fixes land. Also: solo transport currently has
  zero test coverage; a shared transport inherits the batch-transport tests.
- **F5 liveCoachBusService cohesion split** (not deletion — only ~170 lines are actually dead:
  the CONTEXT_RULES/VOICEMAIL_MATCHES re-exports, `getCloseoutStats`, `extractInputIdentity`
  export, the twin ~60-line hold blocks to dedupe, the fixture/replay harness to a dev module).
  Extraction order: batch attachment (:3136-3340, already DI-shaped) → dev harness → session store
  → composer bridge → turn engine LAST — the turn engine is exactly what the two-station runtime
  replaces, so isolating it *is* the migration prep.
- **F6 server.js nine-file split** (line-ranged seams in the audit trail): utils / opus agents /
  openai sidecars / auth / composer / config / dashboards / routers / lifecycle.
- **F7 Registry hygiene:** delete superseded base-registry named tasks (C7), delete or wire
  `liveCoachTranscriptTranslator`, fix the stale codex-substrate comment in coachBatchTransports
  (:176-183 — the MCP runner below it IS wired), `buildGuidanceSchema` built per-request but only
  used as a hint on one path.
- **F8 stream.ts reconnect contract** (one file fixes D1+D2+D6 for cockpit, legacy panel, and
  wallboard simultaneously) + the proxy drain race (D3) as the server half.
- **F9 Unwired-but-future (do NOT delete):** the batch cockpit endpoints
  (`active-conversation-*`, :4326-4347) — pre-cockpit seams per the 06-26 design docs.

---

## Suggested sequencing (small, dainty tranches)

1. **One-liner correctness sweep** (zero behavior risk beyond the fix itself): A10 return true ·
   A9 clearHoldExpiry · B5 listen error handler · B4 closeAllConnections + force-exit · B6
   unconditional terminal prune · C1 fatal break · B7 empty-doctrine guard · F7 stale comments.
2. **Client freeze class:** F8 — stream.ts reconnect contract + proxy drain race.
3. **Two-station prerequisites** (also fixes today's latent MEDs): F4 shared metered transport with
   stop_reason + backoff (A1/A2/A4) · A3 commit-only growth signature.
4. **Pre-solo-pilot:** A5 callStrategy serialization · A8 askCoach timeout · A7 appendInput slim
   return.
5. **Decide the model-policy surface** (B1): finish it (per-call resolve + allow-sets + cold-load)
   or delete it honestly.
6. **Doctrine tranche:** E1 grader onto the bus task · E2 claude -p cost telemetry + exhaustion
   alert · E4 sms.classify migration · C3 registry assert fix ahead of the headless providers.
7. **Streamline tranche:** F1 dashboards out · F2 dead routes · F3 judge era (after revival check) ·
   F5 busService split, batch attachment first.
