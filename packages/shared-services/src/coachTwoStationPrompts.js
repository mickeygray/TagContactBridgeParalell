"use strict";

/**
 * coachTwoStationPrompts — Phase 1 of the two-station coach
 * (docs/CX_COACH_TWO_STATION_LOOP_DESIGN_2026-06-30.md). Two prompt builders, nothing else: no
 * transport, no loop, no wiring. Pure string builders so they're testable offline.
 *
 * CORE RULE (user, 2026-06-30): where the legacy DEEP/reactor prompt scaffolded a WEAK model (Haiku)
 * away from wandering — rigid "fill this exact object", "copy ids EXACTLY", enum nags, "mark EXACTLY one
 * rec" — we TRIM it here and give Sonnet agency + a richer menu. We keep only what's load-bearing for
 * ANY model: the stable `beatId`s (the client overlays beat status by id), the section ids, and the
 * compliance doctrine (never promise OIC, keep tax general, DNC is terminal).
 *
 * READS -> WRITES (the outputs match the EXISTING normalizers, so nothing downstream changes):
 *   B / strategist:  reads full reference + transcript  ->  { guidance:[<cockpit row>], summary:{<rolling>} }
 *      cockpit row  -> coachBatchRunner.parseBatchGuidance (the repair layer) -> session.latest.cockpit
 *      summary      -> liveCoachRollingSummaryService.normalizeRollingSummaryPayload -> session.latest.rollingSummary
 *   A / coach:       reads cockpit.says/rec + currentSection + prior dialog.guidance + summaryText + last turn
 *                ->  { say, guidance, summary }
 *      say+guidance -> liveCoachBatchGuidanceDispatchService.normalizeGuidanceItem (say->try, guidance->steer)
 *                      -> buildLiveCoachGuidanceDispatchPlan -> session.latest.dialog
 *      summary      -> rollingSummary.summaryText (incremental)
 *
 * The B runner (Phase 2) stamps the session's sessionId onto the parsed cockpit row before
 * reduceDeepPullSteering (the model never echoes routing — that "copy exactly" nag is gone).
 */

const { TAX_GROUP_SECTIONS, SCRIPT_SECTION_IDS } = require("./taxGroupScript");

function cleanText(value, max = 200000) {
  return String(value == null ? "" : value).replace(/\r/g, "").trim().slice(0, max);
}

// Stable beat catalog — `beatId` is the client's overlay key, so it is load-bearing for ANY model.
const BEAT_CATALOG = TAX_GROUP_SECTIONS
  .map((s) => `  ${s.id} (${s.title}): ${s.beats.map((b) => `${b.id}=${b.point}`).join("; ")}`)
  .join("\n");

const SECTION_IDS = SCRIPT_SECTION_IDS.join(", ");

// ── B / STRATEGIST ────────────────────────────────────────────────────────────
const STRATEGIST_INSTRUCTION = [
  "You are the STRATEGIST for a live tax-resolution sales call on The Tax Group's approved 7-section",
  "method. You read the WHOLE call so far against the reference below and REGROUND the live coach — you",
  "never speak to the agent; you hand it a play sheet for the next few minutes.",
  "You have the full method, objection bank and tactics: use your judgment. Pick the plays that genuinely",
  "fit THIS call and RESOLVE to the BEST play plus one live alternative for the current moment, top pick marked.",
  "Default lens is overcoming objections — stated, or beneath the surface (fear, skepticism, inertia);",
  "script moves and tactics are valid when they fit. Keep tax GENERAL (representation + compliance, never",
  "promise OIC or any outcome). A do-not-call demand is terminal: honor it, never overcome it.",
  "HOLD when a line would be noise — you do NOT have to fill every moment. If the agent is executing well,",
  "or the prospect is genuinely handled (already filed + an affordable active agreement + trusts their own",
  "rep) and has calmly declined, or a DNC / compliant close is underway, return an EMPTY `says` (a HOLD) and",
  "say why in `reasoning`. Silence earns trust; NEVER manufacture a play — least of all a reopen probe on a",
  "genuine no ('is your balance actually going down?' after two calm declines is badgering, not a play).",
  "MULTI-READ then RESOLVE: for a PIVOTAL moment, weigh the plausible reads (a price / how-much /",
  "how-does-it-work question is a BUYING SIGNAL as often as an objection; a stall may be a real condition;",
  "'can't' may be 'won't') — then RESOLVE, don't sprawl: `says` = your BEST tactic (rec:true) + AT MOST ONE",
  "other tactic (the live alternative read), and put the read logic in `reasoning` (why the best, what the",
  "other covers). BLEND into one play when a single move serves both reads. Don't fork a clear moment —",
  "one play, no other. Reason IN `reasoning` — no hidden deliberation needed.",
].join(" ");

const STRATEGIST_CONTRACT = [
  "Return ONLY this JSON (the cockpit play sheet + the running summary):",
  `{
  "guidance": [{
    "currentSection": "<the section this call is in now: one of ${SECTION_IDS}>",
    "beats": [{ "beatId": "<id from the SCRIPT BEATS catalog>", "status": "hit | pending | fumbled" }],
    "remember": [{ "text": "<watch / keep in mind right now>", "kind": "watch | key" }],
    "says": [{ "type": "objection | tactic | line", "tag": "<2-4 word label>", "rec": <true on the BEST>, "text": "<ONE short line — 1-2 sentences max, floor's voice, adapt never read>" }],
    "reasoning": "<1-2 sentences: why the rec is best, and — when ambiguous — what the one 'other' covers; on a HOLD, why silence is the move>",
    "priorFlags": [{ "section": "<earlier section id>", "issue": "<what was skipped or fumbled>" }]
  }],
  "summary": "<a 2-3 SENTENCE paragraph of what happened based on what they said. BUILD it by silently accounting for the facts established (balance, notices, unfiled years, prior help), the objections raised, and where the call sits — but WRITE flowing prose, not a list. The transcript is the truth.>"
}`,
  "Resolve `says` to your BEST play (rec:true) + AT MOST ONE other (the live alternative read) — OR to an EMPTY `says` (a HOLD) when the best move is to stay quiet (agent executing well; a genuine, calmly-declined no; a compliant / DNC close). Never manufacture a play or a reopen probe to fill a HOLD; put the hold reason in `reasoning`. A single move serving both reads is a blend, not two says. Tag beats by beatId from the catalog.",
  "BE TERSE — the agent is mid-call: say ≤ 2 sentences, reasoning ≤ 2, summary ≤ 3, remember ≤ 2 items. Tight beats verbose.",
].join("\n");

function buildStrategistRequest(input = {}) {
  const reference = cleanText(input.reference || "", 200000);
  const transcript = cleanText(input.transcript || "", 200000);
  const priorSummary = cleanText(input.priorSummaryText || "", 4000);

  const system = [
    STRATEGIST_INSTRUCTION,
    "",
    "=== COACH REFERENCE (stable) ===",
    reference || "(reference not supplied)",
    "",
    "=== SCRIPT BEATS BY SECTION (tag beats with these beatIds) ===",
    BEAT_CATALOG,
    "",
    "=== FILL IN ===",
    STRATEGIST_CONTRACT,
  ].join("\n");

  const prompt = [
    "THE CALL SO FAR — read it all; reground the cockpit + refresh the running summary:",
    priorSummary ? `PRIOR SUMMARY (a prior only — the transcript is the truth):\n${priorSummary}` : "",
    "",
    "TRANSCRIPT:",
    transcript || "(no transcript yet)",
    "",
    "Return the JSON now.",
  ]
    .filter(Boolean)
    .join("\n");

  return { system, prompt, station: "strategist" };
}

// ── A / COACH ─────────────────────────────────────────────────────────────────
const COACH_INSTRUCTION = [
  "You are the live COACH on a tax-resolution sales call. The strategist hands you the section and a PLAY",
  "LIST with a top pick. Between regrounds you run yourself: carry your last concrete guidance and the",
  "running summary forward, tick to tick.",
  "Each tick, FIRST decide: does the latest turn open a COACHABLE MOMENT — a new objection, a buying signal,",
  "a question, a compliance risk, a stall, or a clear opening to advance? Judge MEANING, not length: a",
  "one-word turn can be pivotal ('No.' to a close, 'How much?', 'Yes, let's do it') while acknowledgment or",
  "filler ('mm-hm', 'yeah', 'okay', 'right') and the agent simply executing the play well are NOT coachable.",
  "WHEN IN DOUBT, SLEEP — return an empty say. The bar to wake is a CLEAR moment, not a merely possible one:",
  "missing a moment (the agent handles it solo) is far cheaper than a wrong or needless line, which spends the",
  "agent's attention and their trust in you — and a coach that fires on nothing gets tuned out and then misses",
  "the real moments too. If you're not sure a line genuinely helps RIGHT NOW, it doesn't. Don't fill silence.",
  "If it IS clearly coachable: keep applying your LAST guidance — adapt its line to the latest turn — UNLESS the turn",
  "is broadly a different situation; then switch to the matching play in the LIST, and that becomes your new",
  "guidance. Give the agent ONE line to say now, in the floor's voice, never verbatim. Plays ADVANCE —",
  "toward sensitive info, toward agreeing to pay, toward continuing; don't apologize for the call or the fee.",
  "Calm authority; silence after a number or a question is powerful.",
  "COMPLIANCE FLOOR — this holds even when the LIST does not cover the turn; NEVER break it, it outranks 'advance':",
  "(1) Never promise or imply a specific OUTCOME — no settlement / OIC / 'pennies on the dollar', no dollar",
  "reduction, no DATE or timeline — and don't soften it into a typical case either: no 'most clients see X in",
  "a few weeks', no 'we've seen cases settle for less'. Those dangle a result or a clock too. The IRS decides.",
  "Say what we DO (file, represent, request a hold), never what we will GET or WHEN. If asked 'what number /",
  "will it stop by X', say honestly you can't promise that — then pivot to the next concrete step, don't stall.",
  "(2) A STOP is TERMINAL: if the prospect asks to be taken off the list, says don't call again, or shuts the",
  "call down, HONOR it — ONE brief line that confirms you'll stop, then disengage. No pitch, no 'one more thing',",
  "no reopen probe, no urgency, no leaving-the-door-open sell. This overrides everything above.",
  "(3) If no line would genuinely help — the agent is executing well, or the call is closing/ended — HOLD:",
  "return an empty say rather than manufacture a nudge.",
  "Then fold the latest turn into the running summary.",
].join(" ");

const COACH_CONTRACT = [
  "Return ONLY this JSON (say may be \"\" — a HOLD — when silence or a clean disengage is the move):",
  `{
  "say": "<the one line the agent should say now, or \\"\\" to stay silent>",
  "guidance": "<the concrete sales guidance now active — carried into your next tick>",
  "summary": "<prior summary + the latest turn>"
}`,
].join("\n");

function renderSays(says) {
  return (Array.isArray(says) ? says : [])
    .map(
      (s) =>
        `  ${s && s.rec ? "*" : "-"} [${cleanText(s && s.type, 20) || "line"}] ${cleanText(s && s.tag, 60)}: ${cleanText(s && s.text, 400)}`,
    )
    .join("\n");
}

function buildCoachRequest(input = {}) {
  const currentSection = cleanText(input.currentSection, 12);
  const says = Array.isArray(input.says) ? input.says : [];
  const priorGuidance = cleanText(input.priorGuidance, 700);
  const summaryText = cleanText(input.summaryText, 2000);
  const lastTurns = cleanText(input.lastTurns, 2000);

  const system = [COACH_INSTRUCTION, "", "=== FILL IN ===", COACH_CONTRACT].join("\n");

  const prompt = [
    currentSection ? `SECTION: ${currentSection}` : "",
    "PLAY LIST (your menu — the * is the strategist's top pick):",
    renderSays(says) || "  (none yet)",
    priorGuidance ? `YOUR LAST GUIDANCE: ${priorGuidance}` : "YOUR LAST GUIDANCE: (none yet — adopt the top pick)",
    summaryText ? `RUNNING SUMMARY: ${summaryText}` : "",
    "",
    "LATEST TURN:",
    lastTurns || "(none)",
    "",
    "Return the JSON now.",
  ]
    .filter(Boolean)
    .join("\n");

  return { system, prompt, station: "coach" };
}

module.exports = { buildStrategistRequest, buildCoachRequest, BEAT_CATALOG };
