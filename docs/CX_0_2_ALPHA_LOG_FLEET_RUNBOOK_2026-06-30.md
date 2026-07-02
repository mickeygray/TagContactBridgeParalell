# CX 0.2 Alpha — Live Log-Grading Fleet (Runbook)

Real-time observability for the alpha test: a deterministic extractor carves the live runtime
logs into per-**section** deltas, and a fleet of grader agents reads each delta and judges it
against the matching block of `CX_0_2_ALPHA_TEST_OBSERVABILITY_RUBRIC_2026-06-29.md`. The goal is
"do not guess from the UI" — every observation is grounded in a log line, graded as
**stop / flag / watch / ok**.

This **complements** `scripts/alpha-test-monitor.js` (ports/health/ngrok/gRPC-event counts, §1). The
monitor answers "is the stack up?"; the fleet answers "is what the stack is *doing* correct?".

## The two pieces

1. **`scripts/alpha-log-sections.js`** — deterministic, no LLM. Per section it reads only the bytes
   new since the last run (offsets persisted in `runtime/alpha-log-sections/_state.json`), caps the
   output (1500 lines / 220 KB), runs a cheap rubric-pattern pre-scan, and writes:
   - `runtime/alpha-log-sections/<id>.delta.txt` — the new lines for that section this tick
   - `runtime/alpha-log-sections/_manifest.json` — per-section counts + candidate hits
   - `runtime/alpha-log-sections/_workflow-args.json` — ready-to-launch args for the fleet
2. **The grader fleet** (a Workflow) — one agent per **changed** section. Each reads its delta file
   and returns `{verdict, oneLine, events[], needsIntent}`. The workflow returns a tick rollup
   (stop / flag / watch / ok per section).

## Sections (log → rubric block)

| id | log file(s) | rubric |
|---|---|---|
| `control-plane` | `runtime/logs/control-plane.local.out.log` | §2,3,5,6,8,9 + `cx.alpha.*` trace |
| `ringcx` | `runtime/logs/ringcentral-cx.local.out.log` | §4,5,7 |
| `web` | `runtime/logs/vite-3001.out.log` | §2 |
| `inbound` | `runtime/logs/inbound-gateway.local.out.log` | §11 |
| `ai-bus` | `runtime/alpha-cutover/ai-bus-7000-safe.out.log` | §10 coach |
| `grpc-bridge` | `runtime/alpha-cutover/grpc-bridge-3344.out.log` | §10 transport |
| `grpc-events` | `runtime/live-coach-grpc-bridge/events.ndjson` (140 MB — tailed, never read whole) | §10 transport |

## One tick (what the operator/loop does)

```powershell
# 1. carve the new log deltas (set coach intent so the graders adjudicate kill_switch correctly)
$env:ALPHA_COACH_INTENT = "off"   # or "on"
node scripts\alpha-log-sections.js
```

Then launch the fleet against the fresh args (Claude does this via the Workflow tool):
read `runtime/alpha-log-sections/_workflow-args.json` and pass it as the Workflow `args` object to
the persisted fleet script. The rollup comes back; surface anything `stop`/`flag` immediately.

### Cadence
- **Active dialing:** ~45–90 s/tick. Each tick only grades sections with new lines, so quiet ticks
  are cheap. The cheap pre-scan (`stopHits` in the manifest) is an always-on tripwire between ticks.
- **Idle / between phases:** 5–10 min, or pause the loop.

### First run
`--reset` (or first sight) seeds a bounded tail (64 KB) so the first tick has context; subsequent
ticks are pure new-only. Pass `--seed-lines 0` to start with zero backlog.

## Reading the rollup
- **stop** → a §12 stop-the-test pattern (client in queue, cross-agent leak, wrong-UII write, app
  shows B while RingCX dialed A). **Halt dialing, surface the evidence line.**
- **flag** → a real thumbs-down worth a human now (early card eject, duplicate count, 429 storm,
  workspace 500s).
- **watch** → minor / one-off / recurrence to track (single 429, cosmetic flicker).
- **needsIntent** → the verdict depends on intended state the grader can't confirm (e.g.
  `kill_switch.active` is OK iff coach is intentionally off) — confirm intent, then accept/reject.

## Notes / gotchas
- The pre-scan is a **noisy tripwire** (a timestamp/id containing "429" trips the `ringcx` stop
  pattern). Graders adjudicate; never act on a raw `stopHits` count without the grader verdict.
- Deltas for a quiet section are **not** rewritten — only `changedSections`/`_workflow-args.json`
  list fresh ones. Grade only what's in `changed`.
- `events.ndjson` lines are compacted to `type/uii/error` before an agent sees them.
- The fleet is read-only: it never touches the app, RingCX, or Mongo.
