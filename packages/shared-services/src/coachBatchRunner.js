"use strict";

/**
 * coachBatchRunner — the whole-floor coach model runner (prompt build + parse + gate).
 *
 *   IN   liveCoachBatchProjectionService.buildActiveLiveCoachBatch()  -> conversations[]
 *        liveCoachBatchProjectionService.buildActiveLiveCoachChangeSet() -> changedConversations[]
 *   ===> coachBatchRunner  (build prompt -> model -> parse)  <===  (this file)
 *   OUT  reactor rows -> buildLiveCoachGuidanceDispatchPlan() -> dispatches[] (the live say)
 *        deep rows    -> reduceDeepPullSteering() -> per-session cockpit STATE (script/summary/say cols)
 *
 * Pure: builds a request, parses a response, answers the firing gate. No model
 * call, no Mongo, no mutation. The caller owns transport + dispatch.
 *
 * THREE-SUBSTRATE split (docs/AI_LIVE_COACH_COCKPIT_DESIGN_2026-06-26.md):
 *   - Codex (sidecar, ~60-120s) maintains the rolling SUMMARY + tax facts + captured facts.
 *   - DEEP_PULL (Opus, ~once/min) READS that summary and INTERPRETS it into the
 *     strategic cockpit state: currentSection, script beats (status), remember,
 *     a few SAYS the agent could use, priorFlags. It does NOT write the summary/tax facts.
 *   - REACTOR (Haiku, per changed turn) gives the live nudge: read/steer + one say.
 *
 * The prompt FEEDS THE MODEL THE RESPONSE OBJECT and says "fill this in" — clearer
 * than prose field lists, and load-bearing on the claude -p path (shape-hint only,
 * no strict schema).
 */

const { TAX_GROUP_SECTIONS, SCRIPT_SECTION_IDS } = require("./taxGroupScript");

const DEEP_PULL = "deep";
const REACTOR = "reactor";

// Compact catalog fed into the DEEP system so the model can tag each beat with a STABLE
// beatId (the client overlays status by id, never by fuzzy text). Derived from the approved
// script — one source of truth (taxGroupScript.TAX_GROUP_SECTIONS).
const DEEP_BEAT_CATALOG = TAX_GROUP_SECTIONS
  .map((s) => `  ${s.id} (${s.title}): ${s.beats.map((b) => `${b.id}=${b.point}`).join("; ")}`)
  .join("\n");

const SECTION_IDS_HINT = SCRIPT_SECTION_IDS.join(", ");

const TIER_INSTRUCTION = Object.freeze({
  [DEEP_PULL]: [
    "You are the STRATEGIC tier (Opus) of a live sales-call coach for The Tax Group's approved 7-section method.",
    "Roughly once a minute you read every active call. A rolling SUMMARY SO FAR is maintained for you by another",
    "system — READ it and INTERPRET it; do NOT rewrite it, and do NOT list tax facts (handled elsewhere).",
    "Your DEFAULT LENS is overcoming objections: for every call, think first 'what objection — stated, or beneath",
    "the surface (fear, skepticism, inertia) — is in the way of the next step, and how does the agent turn the call",
    "by overcoming it?'. Sales tactics and other moves are still valid to consider when they genuinely fit.",
    "For each call: mark the current section's script beats, note what to remember, and give the agent a few things they could SAY.",
  ].join(" "),
  [REACTOR]: [
    "You are the FAST reaction tier (Haiku). You see only calls that just changed, with the strategy + summary already set.",
    "React to the latest turn IN SERVICE OF that strategy with ONE line the agent could say now.",
    "Your default lens is overcoming the live objection (stated or beneath the surface); a tactic is fine when it fits better.",
    "Stay quiet (mode \"quiet\", omit say) when nothing useful can be added.",
  ].join(" "),
});

// The response object each tier fills in — fed verbatim into the prompt.
const DEEP_SHAPE = `{
  "sessionId": "<copy EXACTLY from the call header>",
  "uii": "<copy exactly, or omit>",
  "agentEmail": "<copy exactly, or omit>",
  "currentSection": "<the script section this call is in now: one of ${SECTION_IDS_HINT}>",
  "summary": "<one line: what has happened in THIS section of the call so far>",
  "beats": [ { "beatId": "<the id from this section's SCRIPT BEATS catalog>", "point": "<the matching script point>", "status": "hit | pending | fumbled" } ],
  "remember": [ { "text": "<something to keep front-of-mind right now>", "kind": "watch | key" } ],
  "says": [ { "type": "objection | tactic | line", "tag": "<2-4 word label>", "rec": true, "text": "<a line the agent could say>" } ],
  "priorFlags": [ { "section": "<an earlier section id>", "issue": "<what was skipped or fumbled there>" } ]
}`;

const REACTOR_SHAPE = `{
  "sessionId": "<copy EXACTLY>",
  "uii": "<copy exactly, or omit>",
  "agentEmail": "<copy exactly, or omit>",
  "mode": "reaction | quiet",
  "read": "<one line: what is happening right now>",
  "steer": "<one line: the move>",
  "say": { "type": "objection | tactic | line", "tag": "<short label>", "text": "<the one line to say now>" }
}`;

const TIER_CONTRACT = Object.freeze({
  [DEEP_PULL]: [
    "Return ONLY JSON: { \"guidance\": [ <one object per call> ] }. Fill in this object for each call:",
    DEEP_SHAPE,
    "RULES:",
    "- Copy sessionId/uii/agentEmail EXACTLY from the call header — never invent them, never cross calls.",
    "- says: 2-4 options the agent COULD say, LED BY OBJECTION-OVERCOMES — for each, think 'which objection (stated or",
    "  beneath the surface) does this overcome to move the call forward?'. A sales TACTIC or other move is valid when it",
    "  genuinely fits the moment; don't force them and don't suppress them. NEVER a tax fact (tax lives in the summary). Mark exactly ONE rec:true.",
    "- currentSection: the call's section, one of " + SECTION_IDS_HINT + " (use these EXACT ids; '4B' is the payment close).",
    "- beats: ONLY this section's points, using the beatId from the SCRIPT BEATS catalog for this section; set status from the transcript + the summary.",
    "- summary: ONE line on what happened in THIS section so far — NOT the whole call (the rolling summary owns the whole-call view).",
    "- remember: kind \"watch\" = a caution/gap to fix now; kind \"key\" = a fact to hold.",
    "- priorFlags: earlier sections that were skipped or fumbled; [] if none.",
  ].join("\n"),
  [REACTOR]: [
    "Return ONLY JSON: { \"guidance\": [ <one object per call> ] }. Fill in this object for each changed call:",
    REACTOR_SHAPE,
    "RULES:",
    "- Copy sessionId/uii/agentEmail EXACTLY.",
    "- say: ONE line, prefer an objection-overcome or a sales tactic (never a tax fact).",
    "- If nothing useful can be added, set mode \"quiet\" and omit say.",
  ].join("\n"),
});

function cleanText(value, max = 600) {
  return String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function tierOf(tier) {
  return tier === DEEP_PULL ? DEEP_PULL : REACTOR;
}

const SAY_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["type", "text"],
  properties: {
    type: { type: "string", enum: ["objection", "tactic", "line"] },
    tag: { type: "string" },
    rec: { type: "boolean" },
    text: { type: "string" },
  },
};

function buildGuidanceSchema(tier) {
  const routing = {
    sessionId: { type: "string", description: "Echo verbatim from the call header." },
    uii: { type: "string" },
    agentEmail: { type: "string" },
  };
  if (tierOf(tier) === DEEP_PULL) {
    return {
      type: "object",
      additionalProperties: false,
      required: ["guidance"],
      properties: {
        guidance: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["sessionId"],
            properties: {
              ...routing,
              currentSection: { type: "string", enum: SCRIPT_SECTION_IDS },
              summary: { type: "string" },
              beats: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["point", "status"],
                  properties: {
                    beatId: { type: "string" },
                    point: { type: "string" },
                    status: { type: "string", enum: ["hit", "pending", "fumbled"] },
                  },
                },
              },
              remember: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["text", "kind"],
                  properties: { text: { type: "string" }, kind: { type: "string", enum: ["watch", "key"] } },
                },
              },
              says: { type: "array", items: SAY_ITEM_SCHEMA },
              priorFlags: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["section", "issue"],
                  properties: { section: { type: "string", enum: SCRIPT_SECTION_IDS }, issue: { type: "string" } },
                },
              },
            },
          },
        },
      },
    };
  }
  return {
    type: "object",
    additionalProperties: false,
    required: ["guidance"],
    properties: {
      guidance: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["sessionId", "mode"],
          properties: {
            ...routing,
            mode: { type: "string", enum: ["reaction", "quiet"] },
            read: { type: "string" },
            steer: { type: "string" },
            say: SAY_ITEM_SCHEMA,
          },
        },
      },
    },
  };
}

function renderTurns(rows, limit) {
  return (Array.isArray(rows) ? rows : [])
    .slice(-limit)
    .map((row) => `${cleanText(row.role || "?", 24)}: ${cleanText(row.text || "", 400)}`)
    .filter((line) => line.length > 3)
    .join("\n");
}

/**
 * The rolling summary (Codex's sidecar) lands on `conversation.rollingSummary` as a
 * normalized memory object: summaryText + string[] of factsCaptured / openQuestions /
 * objections / taxIssues + a nextBestFocus string. The deep pull INTERPRETS these into
 * cockpit state — it never rewrites them (Codex owns the summary). The labels carry the
 * routing so the model knows where each bucket goes.
 */
function renderRollingSummaryDetail(rs) {
  if (!rs || typeof rs !== "object") return "";
  const line = (label, arr, max) => {
    const items = (Array.isArray(arr) ? arr : [])
      .map((x) => cleanText(x, 160))
      .filter(Boolean)
      .slice(0, max);
    return items.length ? `${label}: ${items.join("; ")}` : "";
  };
  return [
    line("KNOWN FACTS (already discovered — don't re-ask)", rs.factsCaptured, 8),
    line("OPEN QUESTIONS (still unknown — surface as asks/remember)", rs.openQuestions, 6),
    line("OBJECTIONS RAISED (overcome these in says)", rs.objections, 6),
    line("TAX ISSUES (carry into tax-memory remember items)", rs.taxIssues, 6),
    rs.nextBestFocus ? `SUMMARY'S NEXT-BEST FOCUS: ${cleanText(rs.nextBestFocus, 300)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function renderConversation(conversation = {}, tier = REACTOR) {
  const call = conversation.call || {};
  const agent = conversation.agent || {};
  const arrays = conversation.arrays || {};
  const latest = conversation.latest || {};

  const header =
    `--- sessionId=${cleanText(conversation.sessionId, 160)}` +
    (call.uii ? ` uii=${cleanText(call.uii, 160)}` : "") +
    (agent.email ? ` agent=${cleanText(agent.email, 180)}` : "") +
    " ---";

  const context = [
    call.domain ? `tenant=${cleanText(call.domain, 40)}` : "",
    call.caseId ? `case=${cleanText(call.caseId, 60)}` : "",
    call.contactName ? `prospect=${cleanText(call.contactName, 80)}` : "",
    call.phoneLast4 ? `phone=***${cleanText(call.phoneLast4, 8)}` : "",
    conversation.status ? `status=${cleanText(conversation.status, 40)}` : "",
  ]
    .filter(Boolean)
    .join("  ");

  // The rolling SUMMARY (maintained by Codex) + last pass's STRATEGY — read, don't rewrite.
  // The deep pull also gets the summary's STRUCTURED buckets (objections/tax/facts/questions)
  // to interpret into cockpit state; the reactor stays lean on the headline text + latest turns.
  const rollingDetail = tierOf(tier) === DEEP_PULL ? renderRollingSummaryDetail(conversation.rollingSummary) : "";
  const memory = [
    conversation.callSummary ? `ROLLING SUMMARY SO FAR (interpret, do not rewrite): ${cleanText(conversation.callSummary, 1200)}` : "",
    rollingDetail,
    conversation.callStrategy ? `STRATEGY: ${cleanText(conversation.callStrategy, 700)}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const turns = renderTurns(arrays.transcript, tierOf(tier) === DEEP_PULL ? 40 : 6);
  const provisional = latest.provisionalTranscript?.text
    ? `(partial) ${cleanText(latest.provisionalTranscript.text, 400)}`
    : "";

  return [header, context, memory, "TRANSCRIPT:", turns, provisional]
    .filter((part) => part && part.length)
    .join("\n");
}

/** Pick which conversations this tier reads from a batch / change-set. */
function selectConversations(input = {}, tier = REACTOR) {
  if (tierOf(tier) === REACTOR && Array.isArray(input.changedConversations)) {
    return input.changedConversations;
  }
  if (Array.isArray(input.conversations)) return input.conversations;
  if (Array.isArray(input)) return input;
  return [];
}

/**
 * Build the model request for one batch tick.
 * Cache discipline: `system` (tier instruction + reference + the response object to
 * fill) is STABLE -> cache breakpoint at its end. `prompt` (the live calls) is volatile.
 */
function buildBatchGuidanceRequest(input = {}, options = {}) {
  const tier = tierOf(options.tier);
  const reference = cleanText(options.reference || "", 200000);
  const conversations = selectConversations(input, tier);

  const system = [
    TIER_INSTRUCTION[tier],
    "",
    "=== COACH REFERENCE (stable) ===",
    reference || "(reference not supplied)",
    // The deep tier tags beats with stable ids from this catalog (the client overlays status by id).
    ...(tier === DEEP_PULL ? ["", "=== SCRIPT BEATS BY SECTION (use these beatIds) ===", DEEP_BEAT_CATALOG] : []),
    "",
    "=== FILL IN THIS RESPONSE ===",
    TIER_CONTRACT[tier],
  ].join("\n");

  const body = conversations.length
    ? conversations.map((c) => renderConversation(c, tier)).join("\n\n")
    : "(no active calls)";

  const prompt = [
    tier === DEEP_PULL
      ? "ACTIVE CALLS (full pass — interpret each call's rolling summary into the cockpit state):"
      : "CHANGED CALLS (react to the latest turn, in service of each call's strategy):",
    "",
    body,
    "",
    "Return the JSON now.",
  ].join("\n");

  return {
    system,
    prompt,
    schema: buildGuidanceSchema(tier),
    tier,
    conversationCount: conversations.length,
  };
}

function stripFences(text) {
  return String(text || "")
    .replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

/**
 * Parse model JSON that may be lightly malformed. Sonnet occasionally emits a trailing comma
 * before a closing } or ] (observed ~1/28 strategist regrounds in the 7-fixture scale eval) — strict
 * JSON.parse rejects it and the whole reground is lost. This repairs the KNOWN-safe failure modes
 * (code fences, a trailing comma, a leading/trailing prose wrapper around the outermost object/array)
 * and returns null only when the text is genuinely not JSON. The trailing-comma strip only matches a
 * comma immediately followed by whitespace-then-brace, so commas INSIDE string values are never touched.
 */
function repairModelJson(text) {
  const raw = stripFences(text);
  if (!raw) return null;
  const attempt = (candidate) => {
    try {
      return JSON.parse(candidate);
    } catch (_error) {
      return undefined;
    }
  };
  // 1. strict
  let out = attempt(raw);
  if (out !== undefined) return out;
  // 2. strip trailing commas (`, }` / `, ]`), then retry
  const noTrailingCommas = raw.replace(/,(\s*[}\]])/g, "$1");
  out = attempt(noTrailingCommas);
  if (out !== undefined) return out;
  // 3. isolate the outermost object/array (drop any prose wrapper), repair its trailing commas, retry
  const first = raw.search(/[[{]/);
  const last = Math.max(raw.lastIndexOf("}"), raw.lastIndexOf("]"));
  if (first !== -1 && last > first) {
    out = attempt(raw.slice(first, last + 1).replace(/,(\s*[}\]])/g, "$1"));
    if (out !== undefined) return out;
  }
  return null;
}

function coerceResponse(res) {
  if (res && typeof res === "object") {
    if (res.json && typeof res.json === "object" && (Array.isArray(res.json.guidance) || Array.isArray(res.json.items))) {
      return res.json;
    }
    if (Array.isArray(res.guidance) || Array.isArray(res.items) || Array.isArray(res)) return res;
    if (typeof res.text === "string") return coerceResponse(res.text);
    if (typeof res.content === "string") return coerceResponse(res.content);
    return res;
  }
  if (typeof res === "string") {
    const parsed = repairModelJson(res);
    return parsed == null ? { guidance: [] } : parsed;
  }
  return { guidance: [] };
}

// ── THE REPAIR LAYER ─────────────────────────────────────────────────────────
// A model WILL occasionally return a malformed object — a missing key, the line
// at the top level instead of in `say`, `says` as a bare string, a status that
// isn't in the enum, or one object instead of the array. repairGuidanceRow takes
// whatever came back and GUARANTEES the canonical object for the tier with every
// key present. Never throws on garbage.

const ENUM = {
  status: new Set(["hit", "pending", "fumbled"]),
  kind: new Set(["watch", "key"]),
  sayType: new Set(["objection", "tactic", "line"]),
  mode: new Set(["reaction", "quiet"]),
};

function oneOf(value, set, fallback) {
  const v = cleanText(value, 40).toLowerCase();
  return set.has(v) ? v : fallback;
}

// Clamp a model section id to the approved set, CASE-PRESERVING (so "4B" stays "4B" — oneOf
// would lowercase it to "4b"). Exact match first, then case-insensitive -> canonical id.
function clampSection(value) {
  const v = cleanText(value, 12);
  if (!v) return null;
  if (SCRIPT_SECTION_IDS.includes(v)) return v;
  const lower = v.toLowerCase();
  return SCRIPT_SECTION_IDS.find((id) => id.toLowerCase() === lower) || null;
}

function repairSayItem(item) {
  if (item == null) return null;
  if (typeof item === "string") {
    const t = cleanText(item, 700);
    return t ? { type: "line", tag: null, rec: false, text: t } : null;
  }
  if (typeof item !== "object") return null;
  const text = cleanText(item.text || item.line || item.say || item.try, 700);
  if (!text) return null;
  return {
    type: oneOf(item.type || item.kind, ENUM.sayType, "line"),
    tag: cleanText(item.tag, 60) || null,
    rec: Boolean(item.rec || item.best),
    text,
  };
}

// Exactly one `rec:true` survives — if none marked, the first wins; if several, the first marked.
function ensureOneRec(says) {
  if (!says.length) return says;
  let recIdx = says.findIndex((s) => s.rec);
  if (recIdx < 0) recIdx = 0;
  return says.map((s, i) => ({ ...s, rec: i === recIdx }));
}

function repairSays(row) {
  if (Array.isArray(row.says)) return ensureOneRec(row.says.map(repairSayItem).filter(Boolean));
  if (row.say) { const s = repairSayItem(row.say); return s ? [{ ...s, rec: true }] : []; }
  // recover a line that landed at the top level
  const recovered = repairSayItem(row.try || row.line || row.text);
  return recovered ? [{ ...recovered, rec: true }] : [];
}

function repairBeats(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((b) => {
      if (typeof b === "string") return { point: cleanText(b, 200), status: "pending" };
      if (b && typeof b === "object") {
        const point = cleanText(b.point || b.text || b.beat, 200);
        const beatId = cleanText(b.beatId || b.id, 80);
        // Keep a beat with EITHER a point OR a beatId — the client overlays status by beatId
        // and renders the point from the static catalog, so a point-less {beatId,status} row
        // is a valid compact overlay (dropping it silently showed the beat as "pending").
        if (!point && !beatId) return null;
        return { ...(point ? { point } : {}), status: oneOf(b.status, ENUM.status, "pending"), ...(beatId ? { beatId } : {}) };
      }
      return null;
    })
    .filter(Boolean);
}

function repairRemember(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((r) => {
      const text = typeof r === "string" ? cleanText(r, 240) : cleanText(r?.text || r?.note, 240);
      return text ? { text, kind: oneOf(r?.kind, ENUM.kind, "watch") } : null;
    })
    .filter(Boolean);
}

function repairPriorFlags(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((f) => {
      if (!f || typeof f !== "object") return null;
      const section = clampSection(f.section);
      const issue = cleanText(f.issue || f.text, 240);
      return section && issue ? { section, issue } : null;
    })
    .filter(Boolean);
}

// Guess the tier from the fields present when the caller didn't say.
function detectTier(row) {
  if (
    row &&
    (row.currentSection != null ||
      Array.isArray(row.beats) ||
      Array.isArray(row.says) ||
      Array.isArray(row.remember) ||
      Array.isArray(row.priorFlags))
  ) {
    return DEEP_PULL;
  }
  return REACTOR;
}

/**
 * Repair one model row into the COMPLETE canonical object for its tier — every key
 * present, types coerced, enums clamped, misplaced fields recovered. `tier` may be
 * forced; otherwise it's detected from the row's shape.
 */
function repairGuidanceRow(row, tier) {
  const r = row && typeof row === "object" ? row : {};
  const resolved = tier ? tierOf(tier) : detectTier(r);
  const sessionId = cleanText(r.sessionId, 180) || null;
  const uii = cleanText(r.uii, 180) || null;
  const agentEmail = cleanText(r.agentEmail || r.agent?.email, 180).toLowerCase() || null;
  const routing = { sessionId, uii, agentEmail };
  const drop = !sessionId && !uii ? { _dropReason: "missing-routing-keys" } : {};

  if (resolved === DEEP_PULL) {
    return {
      ...routing,
      currentSection: clampSection(r.currentSection || r.section),
      summary: cleanText(r.summary, 400) || null,
      beats: repairBeats(r.beats),
      remember: repairRemember(r.remember),
      says: repairSays(r),
      priorFlags: repairPriorFlags(r.priorFlags),
      raw: row,
      ...drop,
    };
  }

  const say = r.say ? repairSayItem(r.say) : repairSayItem(r.try || r.line || r.text);
  const mode = oneOf(r.mode, ENUM.mode, say ? "reaction" : "quiet");
  return {
    ...routing,
    mode,
    read: cleanText(r.read, 500) || null,
    steer: cleanText(r.steer, 500) || null,
    say: mode === "quiet" ? null : say,
    try: mode === "quiet" ? null : say ? say.text : null, // dispatch/emit back-compat
    raw: row,
    ...drop,
  };
}

/** Parse a raw model response into `{ schemaVersion, generatedAt, guidance[] }`, every row repaired. */
function parseBatchGuidance(res, options = {}) {
  const coerced = coerceResponse(res);
  let rows = Array.isArray(coerced)
    ? coerced
    : Array.isArray(coerced.guidance)
      ? coerced.guidance
      : Array.isArray(coerced.items)
        ? coerced.items
        : [];
  // Single-object recovery: the model returned one call, not wrapped in guidance[].
  if (!rows.length && coerced && typeof coerced === "object" && (coerced.sessionId || coerced.say || coerced.says || coerced.beats)) {
    rows = [coerced];
  }
  const guidance = rows.map((row) => repairGuidanceRow(row, options.tier));
  return {
    schemaVersion: "live-coach.batch-guidance.v2",
    generatedAt: cleanText(options.generatedAt || coerced.generatedAt || "", 80) || null,
    guidance,
  };
}

/**
 * THE GATE — never fire when no one is on the phone. Reactor additionally needs changes;
 * deep fires on its clock whenever a call is live.
 */
function shouldFireCoach(changeSet = {}, options = {}) {
  const tier = tierOf(options.tier);
  const active = Number(changeSet.activeConversationCount || 0);
  if (!(active > 0)) return { fire: false, reason: "no-active-conversations", tier, active };
  if (tier === DEEP_PULL) return { fire: true, reason: "active-calls-present", tier, active };
  if (changeSet.hasChanges) {
    const changed = Number(changeSet.changedConversationCount || (changeSet.changedConversations || []).length || 0);
    return { fire: true, reason: "changed-conversations", tier, active, changed };
  }
  return { fire: false, reason: "no-changes", tier, active };
}

/**
 * Reduce a parsed DEEP pull into per-session cockpit STATE — the script/summary/say
 * columns the cockpit renders. This is the deep tier's output: it updates session
 * state, it does NOT go through the live dialog dispatch (that's the reactor).
 * `callStrategy` is a short synthesized aim for the reactor (the projection carries it).
 */
function reduceDeepPullSteering(parsed = {}) {
  const rows = Array.isArray(parsed.guidance) ? parsed.guidance : [];
  const updates = [];
  const generatedAt = cleanText(parsed.generatedAt, 80) || null;
  for (const row of rows) {
    if (!row.sessionId) continue;
    const hasState = row.currentSection || row.summary || row.beats || row.remember || row.says || row.priorFlags;
    if (!hasState) continue;
    const recSay = (row.says || []).find((s) => s.rec) || (row.says || [])[0] || null;
    const callStrategy = [row.currentSection ? `section ${row.currentSection}` : "", recSay ? recSay.text : ""]
      .filter(Boolean)
      .join(" — ") || null;
    updates.push({
      sessionId: row.sessionId,
      uii: row.uii || null,
      currentSection: row.currentSection || null,
      summary: row.summary || null,
      beats: row.beats || [],
      remember: row.remember || [],
      says: row.says || [],
      priorFlags: row.priorFlags || [],
      generatedAt,
      ...(callStrategy ? { callStrategy } : {}),
    });
  }
  return updates;
}

module.exports = {
  DEEP_PULL,
  REACTOR,
  buildBatchGuidanceRequest,
  parseBatchGuidance,
  shouldFireCoach,
  reduceDeepPullSteering,
  // the repair layer — guarantee the canonical object for a tier
  repairGuidanceRow,
  repairSayItem,
  // lenient parse for lightly-malformed model JSON (trailing commas, prose wrapper); null if not JSON
  repairModelJson,
  // exported for tests / inspection
  renderConversation,
  buildGuidanceSchema,
};
