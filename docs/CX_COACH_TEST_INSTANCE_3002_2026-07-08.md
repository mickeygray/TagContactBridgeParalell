# COACH TEST INSTANCE — THE 3002 RIG (Fable, 2026-07-08; rev 2 after the rig-hardening audit)

Mickey takes test calls with the two-station coach LIVE and watches what it looks like.
This doc: the work to this point, the rig's architecture, the exact startup, the test
protocol, and the kill switch. **Rev 2**: a 24-agent adversarial audit of rev 1 found
12 real issues — the biggest being a MISSING step (the audio ingress leg) and a floor-
exposure hole (production closeout defaults). Both are fenced below; the audit's fixes
are already in the code (355/355 live-coach suite).

---

## 1) THE WORK TO THIS POINT

- **Design landed 2026-07-01**: manual-first + rare certain chime. B/STRATEGIST
  (Sonnet, big prompt + reference) regrounds the cockpit; A/COACH (Haiku, small
  prompt) fires every ~3 substantive turns, adapts from B's menu, or HOLDs — silence
  first-class. Compliance floor: no outcome/OIC/date promises; DNC terminal. Prompts
  validated then (B 27/28, A clean with the floor); the runtime did not exist.
- **The runtime was built overnight 2026-07-07→08**: substance-floored turn
  accumulator (the ~70% noise-overfire fix), the two-station loop (B ~5min +
  immediately on first substantive turn; per-session state; fail-soft cooldowns;
  fires-vs-ticks + token counters), hardened transports (truncation = failure,
  backoff), wired as `LIVE_COACH_COACH_MODE=two_station` through the EXISTING cockpit
  channels — the shipped cockpit UI renders it unchanged.
- **Two adversarial passes since**: a 32-agent review of the build (10 defects fixed +
  pinned, incl. a pre-existing `ensureSession` wipe defeating call-strategy in every
  mode) and a 24-agent audit of THIS rig (12 findings — the fences below + a bridge
  agent-allowlist, built + pinned).
- **The eval artifact**: all 7 fixtures through the REAL loop with REAL API calls —
  every doctrine check passes. hard-no: 1 fire / 7 holds. hostile-dnc: compliant honor
  then silence. **~$0.06/call ⇒ ~$40-65/agent-mo** (intro pricing; +50% B leg after
  2026-08-31). Suites now: live-coach 355/355 · ai-bus 103/103 · cx 379/379.
- Full detail: `docs/CX_COACH_TWO_STATION_PLUGIN_RUNBOOK_2026-07-08.md`.

## 2) THE ARCHITECTURE — an overlay, not a clone

```
Terminal 3: web dev :3002 ──/api──▶ local control-plane :5001 (running, untouched)
   (panel flag ON here only)              └─/api/ai/live-coach──▶ Terminal 1: ai-bus :7000 (NEW)
Your dials: the LOCAL alpha stack, same as your own testing every day        ▲ STT turns
RingCX Workflow Studio ──grpc── bethel ngrok domain ──▶ Terminal 0 tunnel ──▶ Terminal 2: gRPC bridge :3344 (NEW)
```

- A full clone would double-tick the CX workers against the shared Atlas Mongo — the
  coach needs none of that. The rig = **four** new things (one tunnel + three
  processes), zero `.env` edits, zero restarts of anything running.
- Honest identity note (audit): your dials run through the LOCAL alpha stack
  (5001/6101, this working tree) — which is how your own test dialing already works
  every day. The floor's agents ride the Ubuntu production front; they never see this.
- **The floor-exposure truth (the audit's big find):** "the loop only sees mgray" was
  true but insufficient — a bridge hears whatever the RingCX streaming profile sends
  it, and a heard call would have gotten the OLD deterministic per-turn coach plus the
  closeout worker (production defaults: agent recap EMAILS + prod-Mongo writes). Three
  fences now close that: the Terminal-1 env kills closeout/composer/judge/digest, the
  Terminal-2 **agent allowlist** (new, pinned) refuses coach sessions for any resolved
  non-mgray identity at all three resolution points (pre-bind, post-bind, enrichment),
  and the test window should sit OUTSIDE floor dialing hours (identity-less foreign
  streams still transcribe until torn down — that residual is bounded by the window).

## 3) STARTUP (in this order)

**Terminal 0 — the audio ingress leg (the step rev 1 missed entirely).** The bridge is
a passive gRPC SERVER; RingCX Workflow Studio pushes audio to a FIXED URL:
`grpc://bethel-twee-agonisedly.ngrok-free.dev:443`. At audit time that domain was
OFFLINE (nothing local on 3344; the floor coach is dark everywhere — kill file engaged,
no ai-bus on 7000). Without this step the rig boots green and hears NOTHING.

```powershell
# a SECOND ngrok agent (the first one carries tag-webhook -> :81); admin UI lands on :4041
ngrok http --url=bethel-twee-agonisedly.ngrok-free.dev 3344
```

Verify: `http://127.0.0.1:4041/api/tunnels` shows bethel → `http://localhost:3344`.
Then two RingCX-side checks before dialing: (1) Workflow Studio's streaming step still
points at the bethel URL; (2) the streaming step COVERS the campaign your
`RINGCX_AGENT_ROUTE_MGRAY` route dials on (the June tests only worked on profiled
campaigns — an unprofiled campaign = silent preflight with everything green).
**Scope warning:** claiming bethel routes EVERY streaming-profiled campaign's audio to
this rig — the allowlist + fences below contain it, but prefer a test window outside
floor dialing hours, and if Ubuntu's `parallel-live-coach-grpc` is ever the live
terminus for a running floor coach, coordinate before claiming (today it is not — the
domain is unclaimed and the coach is dark).

**Terminal 1 — ai-bus with the coach ON and the floor fenced OFF (repo root):**

```powershell
$env:LIVE_COACH_SOLO_ANTHROPIC_API_KEY = (Select-String -Path .env -Pattern '^ANTHROPIC_API_KEY=(.+)$').Matches[0].Groups[1].Value
$env:LIVE_COACH_RUNTIME_MODE_BATCH_ENABLED = "true"
$env:LIVE_COACH_RUNTIME_MODE_DEFAULT = "deterministic"
$env:LIVE_COACH_RUNTIME_MODE_AGENT_OVERRIDES = "mgray@taxadvocategroup.com:batch"
$env:LIVE_COACH_COACH_MODE = "two_station"
# THE FENCES (audit): production .env defaults would otherwise run the closeout worker
# (agent recap emails + caseProfile/leadCadence/callNote writes to the SHARED prod
# Mongo) and the old per-turn composer for ANY heard call. None are used by two-station.
$env:LIVE_COACH_CLOSEOUT_ENABLED = "false"
$env:LIVE_COACH_ANTHROPIC_COMPOSER_ENABLED = "false"
$env:LIVE_COACH_CONTEXT_JUDGE_ENABLED = "false"
$env:LIVE_COACH_MINI_DIGEST_ENABLED = "false"
npm run ai:bus
```

Boot check: `live_coach.floor_coach.config` shows `twoStation: true, started: true`.

**Terminal 2 — the bridge, kill-scoped AND agent-scoped:**

```powershell
$env:LIVE_COACH_KILL_FILE = "C:\code\TagContactBridgeParalell\runtime\live-coach-test.killed"
$env:LIVE_COACH_AGENT_EMAIL_ALLOWLIST = "mgray@taxadvocategroup.com"
node scripts/ringcx-grpc-live-coach-bridge.js
```

Kill-file facts (audit): the STANDING floor kill file (`runtime/live-coach.killed`)
exists on purpose — this override re-arms coaching for what THIS bridge hears (hence
the allowlist), and forgetting the override in a fresh window silently disables
everything (the only tell: `coach.kill_switch.active` in the bridge log).

**Terminal 3 — the panel-enabled web view:**

```powershell
cd apps/web-client
$env:VITE_LIVE_COACH_PANEL_ENABLED = "true"
npm run dev -- --port 3002
```

`http://localhost:3002` → log in → `/cx`. (CORS admits localhost:3002 via the
non-strict private-origin branch — verified.)

**Preflight (the sharpened version):** dial one test lead **through the CX queue**
(off-queue manual dials can never bind — no `cx.call.placed` event). Within seconds:
Terminal 1 prints `coach_two_station.b.reground` and the cockpit paints. **If silent
past ~15s, diagnose the BIND before the loop:** Terminal 2 should show
`coach.session.bind` / `coach.session.enriched` carrying
`agentEmail=mgray@taxadvocategroup.com` — a repeating `bind_wait`, an empty agentEmail,
or `agent_not_allowlisted` tells you exactly which link broke (Mongo event miss /
identity gap / allowlist read). The bus dashboard (`http://127.0.0.1:7000/live-coach`)
shows the session's bound email + mode as the tiebreaker.

## 4) THE TEST PROTOCOL

| Call | Do | The coach should |
|---|---|---|
| Normal discovery | run the 7-section method plainly | track your section; tick beats; chime rarely; summary reads true |
| Price objection | prospect balks at cost | B crowns a price play; A adapts ONCE — with **$3,500**, never `$X` |
| Hard no | calm repeated decline | mostly SILENCE (eval: 1 fire / 7 holds) — grade the restraint |
| DNC | "take me off your list" | one compliant honor line max, then NOTHING — a reopen is a STOP-IF |
| Fast yes | roll to the close | supportive momentum chimes, no obstruction |
| Noise | speakerphone, TV, mumble | the accumulator drops it silently; no fire |

**Rubric per call:** did each chime EARN its interruption? · section right when you
glanced? · first cockpit within seconds? · fee always real? · anything promised? ·
did silence ever feel like abandonment?

**Watch surfaces:** Terminal 1 = truth (`coach_two_station.*` per event + the 5-min
`live_coach.two_station.meter`: expect holds ≥ fires on normal calls, ~$0.06/call).
Terminal 2 = the bind story + any `agent_not_allowlisted` lines (foreign streams being
fenced — expected during floor hours, a STOP-IF only if the fence ISN'T holding).

**Known limits (design, not bugs):** A's say renders in the existing dialog card; no
rolling-summary sidecar in two-station mode (B carries its own); B's cache pays writes
at real call spacing (the 5-min TTL boundary — visible in the meter's cacheWrite split).

## 5) KILL / TEARDOWN

- **Instant coach kill:** `New-Item C:\code\TagContactBridgeParalell\runtime\live-coach-test.killed`
- Full teardown: Ctrl+C all four terminals (tunnel included). The standing floor kill
  file was never touched; nothing to un-flip.

## APPENDIX — if a FULL third stack is ever truly needed

A real clone (control-plane 5002 + gateways + ringcentral-cx) against the shared Mongo
must boot with its CX workers dead: RC_CX_CADENCE_WORKER_ENABLED=false,
RINGCX_AGENT_MONITOR_ENABLED=false, CX_MORNING_QUEUE_BUILDER_ENABLED=false,
CX_DIAL_RUNTIME_BULK_LOAD_ENABLED=false, watcher/drain/dispatcher/lane/drip flags off —
and point it at a SEPARATE Mongo database name. For coach testing it buys nothing.
