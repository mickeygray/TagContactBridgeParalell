"use strict";

const {
  createAnthropicClient,
  extractToolUse,
} = require("../../shared-integrations/src");
const { env } = require("../../shared-config/src");

const CLASSIFIER_MODEL = env("SMS_CLASSIFIER_MODEL", "claude-opus-4-6");
const CLASSIFIER_MAX_TOKENS = Number(env("SMS_CLASSIFIER_MAX_TOKENS", 900));
const MAX_SUGGESTED_REPLY_CHARS = 320;
const WYNN_REPLY_SUFFIX = " - Wynn Tax Solutions";
const PROSPECT_STATES = new Set([
  "scared",
  "shopping",
  "skeptical",
  "resigned",
  "ready",
  "in_progress",
  "defer",
  "partial_clear",
  "investigating",
  "closing",
  "hostile",
  "unclear",
]);

/**
 * Fast carrier-compliant stop-word pass. If this matches after the
 * no-help/DNC rules below, we do not call the LLM. We treat it as
 * `hard_stop` immediately so delivery on any auto-reply cannot look
 * like we ignored a direct opt-out.
 *
 * Scope is intentionally narrow: only literal carrier codes. Other
 * wording with a no-need reason ("stop, I have an attorney") is handled
 * by fastNoHelpCheck first so it can become a true Logics DNC.
 */
const HARD_STOP_KEYWORDS = new Set([
  "stop",
  "stopall",
  "unsubscribe",
  "cancel",
  "end",
  "quit",
  "revoke",
]);

function fastStopCheck(text) {
  const clean = String(text || "").trim().toLowerCase().replace(/[^a-z]/g, "");
  return HARD_STOP_KEYWORDS.has(clean);
}

function soundsAngry(text) {
  const body = String(text || "").trim();
  if (!body) return false;
  return (
    /\b(piss off|fuck|f\W*u|screw you|go away|leave me alone|harass|harassment|lawsuit|sue|report you)\b/i.test(body) ||
    /!{2,}/.test(body)
  );
}

function fastUnrelatedCheck(text) {
  const body = String(text || "").trim();
  if (!body) return null;
  const lower = body.toLowerCase();

  if (/^https?:\/\//i.test(body)) {
    return {
      intent: "unrelated_or_noise",
      rationale: "Inbound appears to be a standalone link, not a tax-help question.",
    };
  }

  if (/^.{1,4}$/.test(body) && !/\b(irs|tax|debt|owe|file|call|help)\b/i.test(body)) {
    return {
      intent: "unrelated_or_noise",
      rationale: "Inbound is too short to be a tax-help request.",
    };
  }

  if (
    /\b(block party|concert|tickets?|sale|promo|coupon|appointment reminder|delivery|package)\b/i.test(lower) ||
    (/^(thanks|thank you|thx|ok|okay)\b/i.test(lower) && !/\b(irs|tax|debt|owe|file|call|help)\b/i.test(lower)) ||
    /to\s+[“"].+[”"]/i.test(body)
  ) {
    return {
      intent: "unrelated_or_noise",
      rationale: "Inbound appears unrelated to tax-relief help.",
    };
  }

  return null;
}

function fastHotIntentCheck(text) {
  const body = String(text || "").trim();
  if (!body) return null;
  const checks = [
    {
      pattern: /\b(call me|call back|call us|talk to someone|speak (to|with)|schedule|appointment|when can (we|i) talk)\b/i,
      reason: "asked to talk with someone",
    },
    {
      pattern: /\b(how much|how much do you charge|what(?:'s| is| does| do)?(?: this| it| you)? cost|costs?|pricing|price|fee|charge|retainer|payment plan)\b/i,
      reason: "asked about pricing",
    },
    {
      pattern: /\b(can you help|need help|i need to|help me|what are my options|what can i do)\b/i,
      reason: "asked for tax help",
    },
    {
      pattern: /\b(irs|state tax|tax debt|taxes?|levy|lien|garnish|notice|letter|owe|balance)\b/i,
      reason: "mentioned active tax issue",
    },
  ];
  return checks.find((check) => check.pattern.test(body)) || null;
}

function fastNoHelpCheck(text) {
  const body = String(text || "").trim().toLowerCase();
  if (!body) return null;

  const rules = [
    {
      intent: "wrong_number",
      pattern: /\b(wrong number|not me|this is not me|this isn't me|never applied|did not sign up|didn't sign up)\b/i,
      rationale: "Prospect says this is the wrong person/number or they never requested help.",
      tier: "dnc_confirm",
      prospectState: "closing",
      suggestedReply: "Understood. We will update your file so this number is not worked further. - Wynn Tax Solutions",
    },
    {
      intent: "has_representation",
      pattern: /\b(already have|have|got|working with|represented by)\s+(an?\s+)?(tax\s+)?(lawyer|attorney|cpa|ea|tax pro|representation|representative|firm|company)\b/i,
      rationale: "Prospect says they already have tax representation.",
      tier: "dnc_confirm",
      prospectState: "closing",
      suggestedReply: "Understood. We will update your file so you are not contacted about this further. - Wynn Tax Solutions",
    },
    {
      intent: "doesnt_owe_taxes",
      pattern: /\b(do not owe|don't owe|dont owe)\s+(any\s+)?(tax(es)?|tax debt|debt|irs|state|anything|nothing)\b|\b(no tax debt|no irs debt|no taxes owed|no debt|owe nothing|owe no debt)\b/i,
      rationale: "Prospect says they do not owe taxes.",
      tier: "soft_defer",
      prospectState: "partial_clear",
      suggestedReply: "Understood. If everything is filed too, that usually closes the loop; if not, a rep can review the basics by phone. - Wynn Tax Solutions",
    },
    {
      intent: "taxes_already_filed",
      pattern: /\b(my\s+)?tax(es)?\s+(are|were)?\s*filed\b|\balready filed\b|\bfiled my taxes\b/i,
      rationale: "Prospect says their taxes are already filed.",
      tier: "soft_defer",
      prospectState: "partial_clear",
      suggestedReply: "Understood. Filing is one side of it; if there is still a balance, a rep can review the basics by phone. - Wynn Tax Solutions",
    },
    {
      intent: "resolved_tax_issue",
      pattern: /\b(resolved|handled|settled|took care of it|already paid|paid it)\b.*\b(irs|tax|taxes|debt|balance|case)\b/i,
      rationale: "Prospect says the tax issue is already resolved or paid.",
      tier: "dnc_confirm",
      prospectState: "closing",
      suggestedReply: "Understood. We will update your file so you are not contacted about this further. - Wynn Tax Solutions",
    },
  ];

  for (const rule of rules) {
    if (rule.pattern.test(body)) {
      return rule;
    }
  }

  return null;
}

function validateSuggestedReplyShape(reply, tier) {
  if (tier === "hard_stop" || tier === "needs_human") {
    return String(reply || "").trim()
      ? { ok: false, reason: `${tier}-must-not-include-reply` }
      : { ok: true, reply: "" };
  }
  let body = String(reply || "").trim();
  if (!body) return { ok: true, reply: "" };
  if (body.length > MAX_SUGGESTED_REPLY_CHARS) {
    return { ok: false, reason: "suggested-reply-too-long" };
  }
  if (!new RegExp(`${WYNN_REPLY_SUFFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i").test(body)) {
    return { ok: false, reason: "suggested-reply-missing-wynn-suffix" };
  }
  return { ok: true, reply: body };
}

function normalizeProspectState(value, fallback = "unclear") {
  const state = String(value || "").trim().toLowerCase();
  return PROSPECT_STATES.has(state) ? state : fallback;
}

function baseClassification(patch = {}) {
  return {
    intent: patch.intent || "unknown",
    tier: patch.tier || "needs_human",
    prospectState: normalizeProspectState(patch.prospectState, patch.prospectStateFallback || "unclear"),
    suggestedReply: patch.suggestedReply || "",
    callbackWindow: String(patch.callbackWindow || "").trim(),
    confidence: patch.confidence != null ? patch.confidence : 0,
    rationale: patch.rationale || "",
    hotIntent: patch.hotIntent || { detected: false, reason: "" },
    model: patch.model || null,
    validationError: patch.validationError || null,
  };
}

const CLASSIFIER_TOOL = {
  name: "classify_sms",
  description:
    "Classify an inbound SMS from a Wynn Tax Solutions tax-relief prospect and draft the safest next text when one is appropriate. Return exactly one record.",
  input_schema: {
    type: "object",
    properties: {
      intent: {
        type: "string",
        description:
          "Short label for what the prospect is doing. Examples: 'opt_out', 'do_not_contact', 'has_representation', 'doesnt_owe_taxes', 'taxes_already_filed', 'wrong_number', 'asked_cost', 'asked_process', 'irs_notice', 'gave_callback_time', 'requesting_callback', 'hostile', 'spam', 'other'.",
      },
      tier: {
        type: "string",
        enum: ["hard_stop", "dnc_confirm", "soft_defer", "callback_prompt", "needs_human"],
        description:
          "Action tier. 'hard_stop' = bare carrier opt-out only. 'dnc_confirm' = permanent lead-wide DNC after careful clear/disqualifying signal. 'soft_defer' = not-now, vague disinterest, or partial no that stays in funnel. 'callback_prompt' = engaged, buying signal, tax question, scheduling, or light investigation. 'needs_human' = no reply; human owns it.",
      },
      prospect_state: {
        type: "string",
        enum: ["scared", "shopping", "skeptical", "resigned", "ready", "in_progress", "defer", "partial_clear", "investigating", "closing", "hostile", "unclear"],
        description:
          "The prospect's emotional/situational state. This is the rep-facing brief state and should align with the tier.",
      },
      suggested_reply: {
        type: "string",
        description:
          "The exact SMS draft to send, or empty string when no reply should go out. Keep under 320 chars and end exactly with ' - Wynn Tax Solutions'.",
      },
      callback_window: {
        type: "string",
        description:
          "Free-text callback window captured from the prospect, such as 'Monday, prospect time' or 'after 5pm weekdays'. Empty string when none.",
      },
      confidence: {
        type: "number",
        description:
          "Your confidence 0..1 that the tier is correct. Be honest; low confidence is fine, it routes to human review.",
      },
      rationale: {
        type: "string",
        description:
          "One sentence, under 180 chars, explaining the decisive signal. This gets logged for audit and shown to operators.",
      },
      hot_intent_detected: {
        type: "boolean",
        description:
          "True when the prospect shows ANY signal of interest in tax help that a human rep should respond to NOW. Examples that should set this TRUE: asks a question about their tax situation, asks about pricing/process/timeline, says 'I need help' or 'I need to do something', asks 'can you help me', expresses confusion they want resolved, references an IRS notice or letter, asks 'when can we talk' or 'call me back'. Err on the side of TRUE — borderline interest beats missing a hot lead. Set FALSE for opt-outs, DNC confirms, hostility, spam, deliveries, totally unrelated chatter.",
      },
      hot_intent_reason: {
        type: "string",
        description:
          "If hot_intent_detected is true, a 4-12 word phrase the rep will see, written as a fragment (e.g. 'asked about pricing', 'has IRS notice, wants help', 'ready to talk today'). Empty string when false.",
      },
    },
    required: ["intent", "tier", "prospect_state", "suggested_reply", "callback_window", "confidence", "rationale", "hot_intent_detected", "hot_intent_reason"],
  },
};

const SYSTEM_PROMPT = [
  "You are the senior SMS triage and drafting brain for Wynn Tax Solutions, a tax-relief firm.",
  "You read one new inbound prospect text plus recent thread history. You are the first line of defense - you respond to the prospect directly, and a human rep gets alerted after the fact with what happened, what they said, and what you said. The rep then handles the callback or follow-through.",
  "",
  "When you draft, draft like a competent human rep who works tax cases every day, not a chatbot. The product is a phone call with a tax consultant. SMS exists to earn that call, acknowledge the prospect like a person, and route them correctly. Never try to resolve the tax problem in text.",
  "",
  "What happens after you respond:",
  "  - Every send generates an alert email to a human rep with the inbound, your reply, your tier, and your reasoning. You don't draft the alert - JS handles it - but you are responsible for making sure your tier, state, reasoning, and any structured fields (like a callback time) are clean enough for that alert to be useful.",
  "  - When your tier is callback_prompt and callback_window is empty, the system may queue an immediate hot callback. The rep will dial.",
  "  - When your tier is soft_defer OR callback_prompt and the prospect gave a usable future callback window, capture it in callback_window so the alert email and scheduling path can use it.",
  "  - If the prospect gives a callback time that is not now ('next week,' 'Monday,' 'after 5'), capture callback_window; JS does not move or delay the dialer queue for this today. Reply in an appointment/scheduling posture: acknowledge the window and, when useful, point them to lock in a specific time by replying here or calling the tracking number from context. Do not promise a timed dial.",
  "  - If the prospect asks a tax/service question, says they need help, or describes a problem with no future callback window, leave callback_window empty and flag hot intent so the rep treats it like a day-0 hot lead.",
  "  - When your tier is dnc_confirm, the system fires a Logics status change to DNC. That is a permanent action. Be sure.",
  "  - When your tier is needs_human, no reply goes out and the alert is the only thing that happens.",
  "",
  "The qualifying frame - read this first:",
  "  Tax resolution exists for two questions: (1) do you owe? (2) is everything filed?",
  "  If EITHER answer is yes, the prospect needs help. Most casual no-signals only cover one of the two, which means they're an incomplete answer, not a disqualifier.",
  "  - 'I don't owe anything' covers question 1 only. Worth a follow-up on filing.",
  "  - 'I already filed' covers question 2 only. Worth a follow-up on balance.",
  "  - 'I'm good' / 'I'm fine' / 'no thanks' covers neither. soft_defer.",
  "  - 'I don't need help' covers neither on the merits. soft_defer.",
  "  Genuine disqualifiers require BOTH conditions cleared OR a structural reason the lead can never be worked.",
  "",
  "Your job, in order:",
  "  1. INTERPRET the prospect's message. If they describe a problem, situation, or partial answer, work out what they actually mean before deciding anything. Read the thread for context.",
  "  2. Identify the decisive signal.",
  "  3. Read the prospect's emotional/situational state (see prospect_state).",
  "  4. Pick exactly one tier: hard_stop, dnc_confirm, soft_defer, callback_prompt, or needs_human.",
  "  5. Draft a short reply only when the tier calls for one.",
  "  6. Capture a callback_window if the prospect gave you one (defer or scheduling cases).",
  "  7. Flag hot intent aggressively.",
  "",
  "Tier definitions:",
  "  - hard_stop: bare carrier opt-out only - STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE. Suppresses SMS only. NOT a Logics DNC. suggested_reply empty.",
  "  - dnc_confirm: PERMANENT lead-wide suppression that fires a Logics status change. Use sparingly - see DNC philosophy below.",
  "  - soft_defer: 'not now,' 'needs more info,' or a partial no. Prospect stays in the funnel. Reply is short and door-open. If they offered a callback time, capture it.",
  "  - callback_prompt: engaged or might buy now. Cost/process/timeline questions, notice/balance/levy/lien/garnishment mentions, 'can you help,' scheduling, describes a tax problem, asks an in-reach tax question. The reply offers one piece of value and confirms a rep will be calling them back.",
  "  - needs_human: legal threats, hostility, garbled/spam/unrelated, sensitive case-specific analysis ('should I pay this?' / 'do I qualify for X?' / 'is my lien valid?'), licensing-bait, anything outside this prompt's safe range. No reply sent. Alert goes to a human.",
  "",
  "DNC philosophy - read carefully. This fires a Logics status change:",
  "  Fire dnc_confirm in only three categories of moment:",
  "    1. THREATS or legal/regulatory hostility. 'I'll sue you,' 'I'm reporting you to the FTC/AG/FCC,' explicit harassment claims, lawyer threats. Suppress and let the file close cleanly. suggested_reply = empty.",
  "    2. REPEATED STOPS. The thread shows the prospect has already asked to stop, be removed, or not be contacted - and they're saying it again. One 'stop calling me' with no reason is fatigue and routes to needs_human or soft_defer; two of them is a DNC. suggested_reply = brief acknowledgment that the file is being updated, OR empty if hostile.",
  "    3. CAREFUL, CLEAR EXPLANATION. The prospect calmly and specifically explains why they should never be worked: wrong number confirmed, already represented by an attorney/CPA/EA/firm, deceased family member, both qualifying questions cleared on the merits ('I don't owe anything and everything is filed'), permanent structural reason. suggested_reply = one brief non-defensive line confirming the file will be updated.",
  "  Everything else goes to soft_defer or needs_human. Specifically NOT dnc_confirm:",
  "    - 'I don't owe' alone -> soft_defer",
  "    - 'I already filed' alone -> soft_defer",
  "    - 'I'm good' / 'not interested' / 'no thanks' alone -> soft_defer",
  "    - 'I'm handling it myself' -> soft_defer",
  "    - A single 'stop calling me' with no reason -> needs_human if hostile, soft_defer if neutral",
  "    - Vague disinterest -> soft_defer",
  "  When in doubt between dnc_confirm and soft_defer, choose soft_defer. A misrouted defer is recoverable; a wrongful Logics DNC is a permanent lost lead.",
  "",
  "Light investigation lane:",
  "  When the prospect is ambiguous, thanks you, or gives a polite-but-vague reply with no clear inference, you may ask ONE basic question about the two qualifying principles before tiering them out. Stay within those two principles only - owe and filed. This is the entire extent of the SMS investigation. Anything beyond it goes to a rep on a call.",
  "  Use this lane when the reply is friendly/curious but unclear, they gave a partial answer and the other half is unknown, or they seem open but haven't said anything actionable.",
  "  Don't use this lane when both qualifying questions are already cleared, they've shown buying signal, they are hostile, scheduling, or already engaged.",
  "  Tier = callback_prompt. Question IS the reply. One question only.",
  "",
  "Knowledgeable-answer lane (the 'one piece of guidance'):",
  "  For most callback_prompt sends, the right shape is: one piece of useful, factually correct guidance - then 'if this fits, a rep will call you back about it.' This is what makes the SMS feel valuable instead of robotic.",
  "  You may answer a specific tax question briefly if it is general, well-established, and within reach of an accurate answer. Examples: difference between a lien and a levy, what CP14 means, how failure-to-file penalties generally work, whether the IRS can garnish wages without notice.",
  "  Rules: one or two short plain-English sentences, no jargon dump, general only, no named programs as recommendations, no fees/timelines/outcome promises/remedies prescribed. If you are not confident the answer is correct and stable, do not answer. Pivot to a callback offer or route to needs_human.",
  "  Case-specific questions ('should I pay my CP504?' / 'do I qualify for OIC?' / 'is my lien dischargeable?') -> needs_human.",
  "",
  "Soft_defer with callback collection:",
  "  If the prospect gives you any signal about when they'd be reachable - 'call me Monday,' 'after 5pm,' 'tomorrow morning,' 'next week' - capture it in callback_window as a short string the rep can read.",
  "  Examples: 'Monday, prospect's time', 'after 5pm weekdays', 'next week, no specific day', 'tomorrow morning'.",
  "  Do not put open-ended buying intent in callback_window. 'I need help,' 'can you help with this,' 'I have a question,' or a notice/tax question with no time frame should be callback_prompt with callback_window empty.",
  "  If they give a vague defer with no usable window ('not now,' 'I'm busy'), leave callback_window empty and let the rep choose timing.",
  "  When you have a callback_window, the soft_defer reply should briefly acknowledge the timing or scheduling path and stop. Don't pitch. Don't qualify. Don't stack questions.",
  "",
  "Prospect-state reading (set prospect_state):",
  "  - scared: levy/garnishment urgency, 'I don't know what to do.' Calm, grounded.",
  "  - shopping: cost/process/timeline, comparing. Respectful, no hard sell.",
  "  - skeptical: distrust, 'is this a scam.' No urgency, businesslike.",
  "  - resigned: low energy, 'I know I owe,' 'been avoiding it.' Gentle.",
  "  - ready: clear buying signal, asks for a call, gives a time. Confirm, lock timing.",
  "  - in_progress: payment plan, working with IRS, has CPA. Curious whether Wynn fits.",
  "  - defer: 'not now,' busy, scheduling-only. Short, accommodating.",
  "  - partial_clear: cleared one of the two qualifying questions, not both. Paired with soft_defer.",
  "  - investigating: ambiguous/polite-vague; using the investigation lane. Paired with callback_prompt.",
  "  - closing: true permanent-no. Paired with dnc_confirm.",
  "  - hostile: angry/profane/threatening. Paired with needs_human or dnc_confirm if threats.",
  "  - unclear: garbled, spam-like, off-topic. Paired with needs_human.",
  "",
  "Tax-context recognition (use to read severity and mirror the prospect - never case-specific advice):",
  "  - Urgent: levy, bank levy, wage garnishment, frozen account, lien, NFTL, final notice, intent to levy/seize, CP504, CP90, CP91, LT11, LT1058. Hot intent, scared/ready, prioritize.",
  "  - Standard balance: I owe, back taxes, got a letter, CP14, balance due.",
  "  - Unfiled: haven't filed in X years, behind, never filed, missing years.",
  "  - Self-employment / payroll: 1099, self-employed and got hit, 941, payroll, trust fund. Payroll is serious.",
  "  - State: FTB, state taxes, state notice. Acknowledge state vs federal without prescribing.",
  "  - Spouse / divorce / innocent spouse: emotionally loaded - most nuanced cases -> needs_human.",
  "  - Already engaged: installment agreement, OIC pending, CNC. Usually callback_prompt; only dnc_confirm if fully handled on BOTH qualifying questions.",
  "  When the prospect names a notice or situation, acknowledge it neutrally without confirming legal meaning, suggesting remedies, or quoting deadlines.",
  "",
  "Drafting by tier:",
  "  - hard_stop: suggested_reply = empty.",
  "  - dnc_confirm: threats / hostility / repeated stops with anger -> empty. Calm explanation of permanent-no -> one brief non-defensive line confirming the file will be updated. No upsell, no 'if anything changes.'",
  "  - soft_defer: one short line mirroring their signal (timing or partial answer), door open, stop. No pitch, no urgency. If they gave a callback window, acknowledge the timing/scheduling path AND populate callback_window.",
  "  - callback_prompt: one piece of value (acknowledgment, one short in-reach answer, or one investigation question) followed by a clean confirmation that a rep will call back if it's the right kind of lead. If they gave a future callback time, acknowledge the timing/scheduling path and stop - capture callback_window too.",
  "  - needs_human: suggested_reply = empty.",
  "",
  "Reply constraints:",
  "  - Under 320 characters.",
  "  - Must end exactly with ' - Wynn Tax Solutions'.",
  "  - No emoji, links, exclamation points, hype, or all-caps words.",
  "  - No case-specific tax/legal advice. No named tax programs as recommendations. No outcome promises, fee quotes, timelines, guarantees.",
  "  - Never ask for SSN, bank info, full notice images, documents, passwords, or payment data over SMS.",
  "  - Match the prospect's register. Terse -> terse. Scared -> slow it down. Never marketing copy.",
  "  - suggested_reply must be empty for hard_stop, needs_human, and dnc_confirm cases involving threats/hostility/repeated stops.",
  "",
  "Hot-intent flag:",
  "  - hot_intent_detected=true for any live interest or buying signal, even if soft_defer.",
  "  - Hot examples: cost/pricing, can you help, specific notice/balance, levy/lien/garnishment, call me, scheduling, I need help, what are my options, describing a real tax problem, asking an in-reach tax question.",
  "  - Scheduling with a future window is hot enough for alerting/scheduling, but it is not a dialer boost today. Buying intent or inquiry with no future window is urgent-now.",
  "  - Err HIGH. False positive is cheap, missed hot lead is gone.",
  "  - hot_intent_detected=false for hard_stop, dnc_confirm, hostility without merit-engagement, legal threats, spam, deliveries, unrelated chatter, fully ambiguous messages with no engagement.",
  "  - hot_intent_reason: 4-12 word fragment, plain rep language. Example: 'got a cp504, sounds scared, wants a call.'",
  "",
  "You are accountable:",
  "  When you fire dnc_confirm, you are 100% on it - the Logics status changes permanently. When you send a callback_prompt reply with no future callback_window, the rep is going to dial. When you fire a soft_defer or callback_prompt with a future callback_window, the alert/scheduling path uses that window. The alert email tells the rep what happened, what the prospect said, and what you said. Your tier, state, reasoning, and any captured fields ARE the rep's brief.",
  "",
  "Output discipline:",
  "  - Always call the classify_sms tool.",
  "  - Always set tier, prospect_state, hot_intent_detected, hot_intent_reason, suggested_reply (empty string when not drafting), and callback_window (empty string when none captured).",
  "  - No free text. No markdown. No explanations outside the tool call.",
].join("\n");

/**
 * Run the classifier on one inbound SMS. Returns the structured output
 * or a `needs_human` fallback if the model failed / tool-use missing.
 *
 * @param {Object} input
 * @param {string} input.text - the inbound message body
 * @param {string} input.fromPhone - normalized digits, for logging only
 * @param {string} input.company - WYNN expected for AI-supported path
 * @param {Array<{direction:string,body:string,createdAt?:Date}>} [input.history]
 *   prior turns in this conversation for context (most-recent last).
 */
async function classifySms(input = {}) {
  // All regex short-circuits below are by definition NOT hot-intent
  // (they're STOPs, DNCs, hostility, or noise). Bake the empty hotIntent
  // shape into a shared helper so every return path conforms.
  const noHot = { detected: false, reason: "" };

  const text = String(input.text || "").trim();
  if (!text) {
    return baseClassification({
      intent: "empty",
      tier: "needs_human",
      prospectState: "unclear",
      confidence: 1,
      rationale: "Empty inbound text.",
      hotIntent: noHot,
      model: null,
    });
  }

  const noHelp = fastNoHelpCheck(text);
  if (noHelp) {
    const noReply = Boolean(
      noHelp.noReply ||
        soundsAngry(text) ||
        /\b(stop|stopall|unsubscribe|cancel|end|quit|revoke)\b/i.test(text),
    );
    return baseClassification({
      intent: noHelp.intent,
      tier: noHelp.tier || "dnc_confirm",
      prospectState: noHelp.prospectState || "closing",
      suggestedReply: noReply
        ? ""
        : noHelp.suggestedReply || "Understood. We will update your file so you are not contacted about this. - Wynn Tax Solutions",
      confidence: 0.95,
      rationale: noReply
        ? `${noHelp.rationale} No auto-reply because the message is angry or a no-contact request.`
        : noHelp.rationale,
      hotIntent: noHot,
      model: "regex-no-help-path",
    });
  }

  if (fastStopCheck(text)) {
    return baseClassification({
      intent: "opt_out",
      tier: "hard_stop",
      prospectState: "closing",
      confidence: 1,
      rationale: "Regex-matched carrier STOP keyword with no no-help reason.",
      hotIntent: noHot,
      model: "regex-fast-path",
    });
  }

  if (soundsAngry(text)) {
    return baseClassification({
      intent: "hostile",
      tier: "needs_human",
      prospectState: "hostile",
      confidence: 0.95,
      rationale: "Inbound sounds angry or hostile; no automated response should be sent.",
      hotIntent: noHot,
      model: "regex-hostile-path",
    });
  }

  const unrelated = fastUnrelatedCheck(text);
  if (unrelated) {
    return baseClassification({
      intent: unrelated.intent,
      tier: "needs_human",
      prospectState: "unclear",
      confidence: 0.9,
      rationale: unrelated.rationale,
      hotIntent: noHot,
      model: "regex-unrelated-path",
    });
  }

  const historyLines = Array.isArray(input.history)
    ? input.history
        .slice(-6)
        .map((turn) => {
          const tag = turn.direction === "outbound" ? "WYNN" : "PROSPECT";
          const body = String(turn.body || "").slice(0, 400);
          return `  ${tag}: ${body}`;
        })
        .join("\n")
    : "";

  const trackingNumber = String(input.trackingNumber || "").trim();
  const contextBlock = [
    `Company: ${input.company || "WYNN"}`,
    trackingNumber
      ? `Our outbound tracking number (use this in callback replies): ${trackingNumber}`
      : "Our outbound tracking number: (unknown - omit from reply)",
    historyLines
      ? `Prior thread (most recent last):\n${historyLines}`
      : "Prior thread: (none - this is the first inbound we've tracked)",
    "",
    "New inbound from prospect:",
    text,
  ].join("\n");

  const client = createAnthropicClient();
  let response;
  try {
    response = await client.createMessage({
      model: CLASSIFIER_MODEL,
      maxTokens: CLASSIFIER_MAX_TOKENS,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: contextBlock }],
      tools: [CLASSIFIER_TOOL],
      toolChoice: { type: "tool", name: "classify_sms" },
    });
  } catch (error) {
    return baseClassification({
      intent: "classifier_error",
      tier: "needs_human",
      prospectState: "unclear",
      confidence: 0,
      rationale: `Classifier call failed: ${error.message}`.slice(0, 180),
      hotIntent: noHot,
      model: null,
    });
  }

  const toolUse = extractToolUse(response, "classify_sms");
  if (!toolUse) {
    return baseClassification({
      intent: "classifier_no_tool_use",
      tier: "needs_human",
      prospectState: "unclear",
      confidence: 0,
      rationale: "Model returned no tool_use block.",
      hotIntent: noHot,
      model: response?.model || null,
    });
  }

  const raw = toolUse.input || {};
  const tier =
    raw.tier === "hard_stop" ||
    raw.tier === "dnc_confirm" ||
    raw.tier === "soft_defer" ||
    raw.tier === "callback_prompt"
      ? raw.tier
      : "needs_human";
  const prospectState = normalizeProspectState(raw.prospect_state, tier === "dnc_confirm" ? "closing" : "unclear");
  const callbackWindow = String(raw.callback_window || "").trim().slice(0, 120);
  // Hot-intent only makes sense for live prospects. Force-clear it on
  // the suppression tiers so a model false positive can't route a STOP
  // into a rep's queue.
  const fastHotIntent = fastHotIntentCheck(text);
  const hotIntentDetected =
    tier === "hard_stop" || tier === "dnc_confirm"
      ? false
      : tier === "callback_prompt" ||
        Boolean(callbackWindow) ||
        Boolean(raw.hot_intent_detected) ||
        Boolean(fastHotIntent);
  const replyCheck = validateSuggestedReplyShape(raw.suggested_reply, tier);
  if (!replyCheck.ok) {
    return baseClassification({
      intent: String(raw.intent || "classifier_contract_violation"),
      tier: "needs_human",
      prospectState,
      confidence: 0,
      rationale: `Classifier output invalid: ${replyCheck.reason}`.slice(0, 180),
      hotIntent: noHot,
      model: response?.model || null,
      validationError: replyCheck.reason,
    });
  }
  return baseClassification({
    intent: String(raw.intent || "unknown"),
    tier,
    prospectState,
    suggestedReply: replyCheck.reply || "",
    callbackWindow,
    confidence: Number.isFinite(Number(raw.confidence))
      ? Number(raw.confidence)
      : 0,
    rationale: String(raw.rationale || "").slice(0, 240),
    hotIntent: {
      detected: hotIntentDetected,
      reason: hotIntentDetected
        ? String(raw.hot_intent_reason || fastHotIntent?.reason || "needs agent follow-up").slice(0, 80)
        : "",
    },
    model: response?.model || null,
  });
}

module.exports = {
  classifySms,
  fastStopCheck,
  fastNoHelpCheck,
  fastHotIntentCheck,
  CLASSIFIER_MODEL,
};
