"use strict";

const {
  createAnthropicClient,
  extractToolUse,
} = require("../../shared-integrations/src");
const { env } = require("../../shared-config/src");

const CLASSIFIER_MODEL = env("SMS_CLASSIFIER_MODEL", "claude-sonnet-4-5-20250929");
const CLASSIFIER_MAX_TOKENS = Number(env("SMS_CLASSIFIER_MAX_TOKENS", 600));

/**
 * Fast carrier-compliant stop-word pass. If this matches, we do not call
 * the LLM. We treat it as `hard_stop` immediately so delivery on any
 * auto-reply cannot look like we ignored a direct opt-out.
 *
 * Scope is intentionally narrow: only literal carrier codes. Other
 * wording ("do not contact me") is handled by the classifier so we
 * can separate SMS-only suppression from a true Logics DNC.
 */
const HARD_STOP_PATTERN = /\b(stop|stopall|unsubscribe|cancel|end|quit|revoke)\b/i;

function fastStopCheck(text) {
  const body = String(text || "").trim();
  if (!body) return false;
  return HARD_STOP_PATTERN.test(body);
}

function fastNoHelpCheck(text) {
  const body = String(text || "").trim().toLowerCase();
  if (!body) return null;

  const rules = [
    {
      intent: "wrong_number",
      pattern: /\b(wrong number|not me|this is not me|this isn't me|never applied|did not sign up|didn't sign up)\b/i,
      rationale: "Prospect says this is the wrong person/number or they never requested help.",
    },
    {
      intent: "has_representation",
      pattern: /\b(already have|have|got)\s+(an?\s+)?(lawyer|attorney|cpa|ea|tax pro|representation|representative)\b/i,
      rationale: "Prospect says they already have tax representation.",
    },
    {
      intent: "doesnt_owe_taxes",
      pattern: /\b(do not owe|don't owe|dont owe|no tax debt|no irs debt|no taxes owed|owe nothing)\b/i,
      rationale: "Prospect says they do not owe taxes.",
    },
    {
      intent: "taxes_already_filed",
      pattern: /\b(my\s+)?tax(es)?\s+(are|were)?\s*filed\b|\balready filed\b|\bfiled my taxes\b/i,
      rationale: "Prospect says their taxes are already filed.",
    },
    {
      intent: "resolved_tax_issue",
      pattern: /\b(resolved|handled|settled|took care of it|already paid|paid it)\b.*\b(irs|tax|taxes|debt|balance|case)\b/i,
      rationale: "Prospect says the tax issue is already resolved or paid.",
    },
  ];

  for (const rule of rules) {
    if (rule.pattern.test(body)) {
      return rule;
    }
  }

  return null;
}

const CLASSIFIER_TOOL = {
  name: "classify_sms",
  description:
    "Classify an inbound SMS from a Wynn Tax Solutions tax-relief prospect and decide how Wynn should respond. Return exactly one record.",
  input_schema: {
    type: "object",
    properties: {
      intent: {
        type: "string",
        description:
          "Short label for what the prospect is doing. Examples: 'opt_out', 'has_representation', 'doesnt_owe_taxes', 'taxes_already_filed', 'wrong_number', 'question_about_fees', 'question_about_process', 'confirming_appointment', 'requesting_callback', 'hostile', 'spam', 'other'.",
      },
      tier: {
        type: "string",
        enum: ["hard_stop", "dnc_confirm", "callback_prompt", "needs_human"],
        description:
          "Action tier. 'hard_stop' = explicit STOP/no-text opt-out with no reason; suppress SMS only and no reply. 'dnc_confirm' = clear explanation that they do not need tax-relief help (taxes filed/resolved, no tax debt, represented, wrong number, never requested, already handled); send a short polite confirmation and suppress lead-wide. 'callback_prompt' = legitimate question or engagement that deserves a short call/schedule reply with safe basic info. 'needs_human' = ambiguous, legal threat, complex, or low-confidence.",
      },
      suggested_reply: {
        type: "string",
        description:
          "The exact reply Wynn should send for tier=dnc_confirm or tier=callback_prompt. Keep under 320 chars. Must end with ' - Wynn Tax Solutions' (no exceptions). Never promise results, fees, timelines, or specific tax outcomes. Never give tax advice. For callback_prompt, drive toward calling or scheduling. Leave empty string for hard_stop and needs_human.",
      },
      confidence: {
        type: "number",
        description:
          "Your confidence 0..1 that the tier is correct. Be honest; low confidence is fine, it routes to human review.",
      },
      rationale: {
        type: "string",
        description:
          "One sentence, under 180 chars, explaining why you picked this tier. This gets logged for admin audit.",
      },
    },
    required: ["intent", "tier", "suggested_reply", "confidence", "rationale"],
  },
};

const SYSTEM_PROMPT = [
  "You triage inbound SMS for Wynn Tax Solutions, a tax-relief firm.",
  "Every inbound message is from a past or current Wynn prospect. Your job is to decide:",
  "  (a) should we stop SMS only because they used a stop/no-contact opt-out,",
  "  (b) should we mark the lead DNC because they explained why they do not need help,",
  "  (c) should we send a short safe reply that steers them to call or schedule, or",
  "  (d) does a human need to handle this.",
  "",
  "Rules you MUST follow:",
  "  - Signals that mean HARD STOP / SMS ONLY (tier=hard_stop):",
  "      - Carrier words or plain requests to stop texting/calling, without a reason they do not need help.",
  "      - Examples: 'STOP', 'unsubscribe', 'stop texting me', 'do not contact me'.",
  "    Leave suggested_reply empty. This is SMS/channel suppression only, NOT a Logics DNC.",
  "",
  "  - Signals that mean LOGICS DNC (tier=dnc_confirm):",
  "      - They explain why they do not need tax-relief help.",
  "      - Examples: 'my taxes are filed', 'I already resolved it', 'I do not owe taxes', 'I already paid',",
  "        'I have a lawyer/CPA/EA', 'wrong number', 'this is not me', 'I did not sign up', 'never applied'.",
  "      - Profanity does NOT automatically make this human review if the no-need reason is clear.",
  "        Example: 'MY TAXES ARE FILED PISS OFF' is dnc_confirm.",
  "    Respond once confirming we will update their file, then suppress lead-wide. No sales pitch.",
  "",
  "  - Signals that mean CALLBACK PROMPT (tier=callback_prompt):",
  "      - Questions about fees, process, timeline, notices, balances, or whether Wynn can help.",
  "      - 'How does this work', 'What do you do', 'Can you help', 'Call me', 'Can we schedule'.",
  "    Be conversational, but safe. You may provide basic process information and acknowledge one fact they gave,",
  "    then drive to calling the tracking number or scheduling. Do not analyze their tax situation.",
  "",
  "  - Signals that mean HUMAN REVIEW (tier=needs_human):",
  "      - Legal threats, lawsuits, complaints, attorney threats against Wynn.",
  "      - Confusing or garbled messages.",
  "      - Hostile messages WITHOUT a clear no-need reason.",
  "      - Anything you're not confident about.",
  "    Leave suggested_reply empty; a human will write it.",
  "",
  "Reply constraints (hard rules - never break):",
  "  - Under 320 characters.",
  "  - Must end with ' - Wynn Tax Solutions' (no other sign-off).",
  "  - Never: promise outcomes, quote fees, give tax advice, attach links, mention specific IRS programs by name.",
  "  - Never ask for SSN, bank info, or sensitive data over SMS.",
  "  - Tone: professional, warm, brief. No exclamation points. No emoji.",
  "",
  "Always call the classify_sms tool. Do not return free-text.",
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
  const text = String(input.text || "").trim();
  if (!text) {
    return {
      intent: "empty",
      tier: "needs_human",
      suggestedReply: "",
      confidence: 1,
      rationale: "Empty inbound text.",
      model: null,
    };
  }

  if (fastStopCheck(text)) {
    return {
      intent: "opt_out",
      tier: "hard_stop",
      suggestedReply: "",
      confidence: 1,
      rationale: "Regex-matched carrier STOP keyword.",
      model: "regex-fast-path",
    };
  }

  const noHelp = fastNoHelpCheck(text);
  if (noHelp) {
    return {
      intent: noHelp.intent,
      tier: "dnc_confirm",
      suggestedReply:
        "Understood. We will update your file so you are not contacted about this. - Wynn Tax Solutions",
      confidence: 0.95,
      rationale: noHelp.rationale,
      model: "regex-no-help-path",
    };
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
    return {
      intent: "classifier_error",
      tier: "needs_human",
      suggestedReply: "",
      confidence: 0,
      rationale: `Classifier call failed: ${error.message}`.slice(0, 180),
      model: null,
    };
  }

  const toolUse = extractToolUse(response, "classify_sms");
  if (!toolUse) {
    return {
      intent: "classifier_no_tool_use",
      tier: "needs_human",
      suggestedReply: "",
      confidence: 0,
      rationale: "Model returned no tool_use block.",
      model: response?.model || null,
    };
  }

  const raw = toolUse.input || {};
  return {
    intent: String(raw.intent || "unknown"),
    tier:
      raw.tier === "hard_stop" ||
      raw.tier === "dnc_confirm" ||
      raw.tier === "callback_prompt"
        ? raw.tier
        : "needs_human",
    suggestedReply: String(raw.suggested_reply || "").trim(),
    confidence: Number.isFinite(Number(raw.confidence))
      ? Number(raw.confidence)
      : 0,
    rationale: String(raw.rationale || "").slice(0, 240),
    model: response?.model || null,
  };
}

module.exports = {
  classifySms,
  fastStopCheck,
  fastNoHelpCheck,
  CLASSIFIER_MODEL,
};
