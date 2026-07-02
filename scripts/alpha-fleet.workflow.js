export const meta = {
  name: 'alpha-log-fleet',
  description: 'Grade each alpha-test log section against the CX 0.2 observability rubric; return a tick rollup',
  phases: [{ title: 'Grade', detail: 'one grader agent per log section' }],
};

// Self-contained: each section has a FIXED delta path written by scripts/alpha-log-sections.js.
// No args needed — the grader reads the delta header for tick/freshness/coach-intent.
const DELTA_DIR = 'C:/code/tagcontactbridgeparalell/runtime/alpha-log-sections';

const SECTIONS = [
  {
    id: 'control-plane',
    title: 'App / Bulk runtime / Buttons / Drain / DNC+Logics (rubric 2,3,5,6,8,9)',
    criteria: `STOP-class (rubric sec.12): an existing CLIENT/prospect appears in a dial queue; a test lead leaks to another agent OR a real lead leaks into the test agent; a button/terminal write lands on the WRONG uii/case/agent; the app confidently shows lead B while RingCX dialed lead A and does NOT self-correct on the next tick.
THUMBS-DOWN (flag): workspace/read 500s; a STALE last-lead shown in the middle card; a button click ejects the middle card BEFORE RingCX advances; buttons missing during a real active call; the drain/outbox counts the same UII TWICE (duplicate/already-counted); a call counted with NO uii evidence; an auto-advanced call never counted; a Logics lookup that changes the middle-card identity; agent stuck unavailable after a disposition.
ALPHA TRACE lines to surface: cx.alpha.disposition.transport (note ok/executed/releaseStatus), cx.alpha.publish.batch (phantomSuspected:true = accepted-by-us but NOT inserted by RingCX), cx.alpha.session.killed.
HEALTHY (ok): reserve/serve/refill/terminalize lines with matching uii; routine hourly ticks.`,
  },
  {
    id: 'ringcx',
    title: 'RingCX upload / active-call watcher / refill (rubric 4,5,7)',
    criteria: `STOP-class: a 429 / rate-limit STORM during upload or call-download that PAUSES or CANCELS the session; route-lock rejections.
THUMBS-DOWN (flag): '400 invalid phone'; UI implies a lead is queued but there is no RingCX accepted evidence; surprising dial order with no accepted-result to reconcile; refill firing REPEATEDLY while one upload is already in flight; refill pulling from the wrong pool.
WATCHER: the middle card advancing AHEAD of RingCX; a released/stale UII stuck as current after a newer UII appears.
NOTE: a single one-off 429 on call-download with the watcher otherwise healthy is watch, not stop. The cheap pre-scan trips on any '429' substring (even a timestamp/id) — adjudicate, do not trust it.`,
  },
  {
    id: 'web',
    title: 'Web client / vite (rubric 2)',
    criteria: `THUMBS-DOWN (flag): workspace mode wrong after login; repeated 500s around /api/read/cx/workspace; stale lead data from another mode/agent; a working UI while the server shows repeated failed workspace refreshes.
HEALTHY (ok): vite build/serve/hmr noise.`,
  },
  {
    id: 'inbound',
    title: 'Inbound gateway / first-contact forward (rubric 11)',
    criteria: `Only meaningful if the live->local first-contact forward is INTENTIONALLY enabled.
THUMBS-DOWN (flag): forward attempted before the local receiver is loaded; a forward failure BLOCKING intake; the local side creating DUPLICATE queue rows from a forwarded notification.
HEALTHY (ok): near-silence when forward is disabled.`,
  },
  {
    id: 'ai-bus',
    title: 'AI bus 7000 / coach (rubric 10 coach)',
    criteria: `Judge SEPARATELY from gRPC transport. coach.kill_switch.active is OK when coach is INTENTIONALLY OFF (set needsIntent:true) but a THUMBS-DOWN when coach is intentionally on.
THUMBS-DOWN (flag): repeated stt.realtime.error / connect_error AFTER credits/model access are restored; credit/401/403/429 from the model; coach sessions created but never receiving segment input.
HEALTHY (ok): provider/flag lines and zero-session health when coach is off.`,
  },
  {
    id: 'grpc-bridge',
    title: 'gRPC bridge 3344 / transport (rubric 10 transport)',
    criteria: `Judge transport SEPARATELY from coach/model availability.
HEALTHY: stream.start, dialogInit, two segmentStart, media frames (mediaBytes>0), stream.end, dialog.attributes.uii present.
THUMBS-DOWN (flag): RingCX creates NO stream.start; only smoke events with no real dialogInit; streams that start but never end or never include media; a stream accepted but UII/call binding never resolves.`,
  },
  {
    id: 'grpc-events',
    title: 'gRPC events.ndjson / transport (rubric 10 transport)',
    criteria: `NDJSON events compacted to type/uii/error.
HEALTHY: a stream.start -> dialogInit -> segmentStart(x2) -> media -> stream.end lifecycle with a uii present.
THUMBS-DOWN (flag): stream.start with no stream.end; no media; repeated stt.realtime.error/connect_error.
NOTE: coach.kill_switch.active is the coach-OFF signal (set needsIntent:true) — not itself a transport failure.`,
  },
];

const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['ok', 'watch', 'flag', 'stop'] },
    oneLine: { type: 'string' },
    needsIntent: { type: 'boolean' },
    events: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['stop', 'flag', 'watch', 'info'] },
          what: { type: 'string' },
          rubricRef: { type: 'string' },
          evidence: { type: 'string' },
        },
        required: ['severity', 'what'],
      },
    },
  },
  required: ['verdict', 'oneLine', 'events'],
};

function graderPrompt(s) {
  return `You are a log-section grader for a CX 2.0 bulk-dial ALPHA test. Grade ONLY your section against its rubric criteria. Be precise and conservative — this drives a go/stop decision, so do NOT cry wolf, but never miss a STOP-class issue.

SECTION: ${s.id} — ${s.title}
RUBRIC CRITERIA:
${s.criteria}

YOUR INPUT: Read the delta file at ${DELTA_DIR}/${s.id}.delta.txt. Its header line shows "tick / fresh / newLines / stopHits / watchHits" and "coach_intent" (use coach_intent to adjudicate coach-off signals like kill_switch). The body is ONLY the log lines new this tick.
- If the header says fresh:false or newLines:0, return verdict "ok", oneLine "no new lines this tick", events [].
- stopHits/watchHits are a NOISY cheap pre-scan (a timestamp/id containing "429" trips it). Adjudicate every candidate; do not trust the counts.
- If lines look like SEEDED backlog (older timestamps on a first/seed tick), grade the content but note it is historical in 'what'.

Return:
- verdict: stop (a sec.12 stop-the-test pattern present), flag (a real thumbs-down a human should see now), watch (minor/recurrence/one-off), or ok (nothing notable).
- oneLine: terse status (e.g. "202 lines: healthy poller; the '429' hit is a timestamp false-positive").
- events: each REAL finding with severity + what + rubricRef + the evidence line. Empty if clean.
- needsIntent: true only if your verdict hinges on intended state you cannot confirm (e.g. kill_switch when coach_intent is unknown).`;
}

phase('Grade');
const verdicts = await parallel(SECTIONS.map((s) => () =>
  // Sonnet 4.6 for the grading — criteria-based log classification, not deep reasoning. ~1.7x cheaper
  // + faster than Opus with no real recall loss here (criteria are explicit + the cheap pre-scan flags
  // candidates). If control-plane (the stop-class lane) ever under-grades, bump just it back to opus.
  agent(graderPrompt(s), { label: `grade:${s.id}`, phase: 'Grade', schema: VERDICT_SCHEMA, model: 'sonnet', effort: 'medium' })
    .then((v) => (v ? { id: s.id, ...v }
      : { id: s.id, verdict: 'error', oneLine: 'grader returned null', events: [], needsIntent: false }))
    .catch((e) => ({ id: s.id, verdict: 'error', oneLine: `grader threw: ${String((e && e.message) || e)}`, events: [], needsIntent: false }))
));

const all = verdicts.filter(Boolean);
const pick = (lvl) => all.filter((v) => v.verdict === lvl).map((v) => v.id);
return {
  rollup: { stop: pick('stop'), flag: pick('flag'), watch: pick('watch'), ok: pick('ok'), error: pick('error') },
  sections: all,
};
