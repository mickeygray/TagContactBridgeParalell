"use strict";

const DEFAULT_MAX_TEXT_CHARS = 6000;
const DEFAULT_MAX_CANDIDATES = 24;

const EXTRA_CONTEXT_ALIASES = Object.freeze({
  legitimacy: [
    "fake call",
    "fraud",
    "fraudulent",
    "is this fake",
    "is this a scam",
    "are you a scam",
    "is this legitimate",
    "where are you calling from",
    "what business is this",
    "what organization",
    "what is your company",
    "why is this number calling me",
    "why do you have my information",
    "i did not ask for this",
    "i never requested this",
    "i don't remember filling anything out",
    "i dont remember filling anything out",
    "how do i know this is real",
    "how do i know you are real",
  ],
  irs_notice: [
    "government letter",
    "treasury letter",
    "irs bill",
    "irs balance",
    "irs debt",
    "federal balance",
    "federal taxes owed",
    "federal tax debt",
    "past due tax",
    "tax debt",
    "taxes owed",
    "owe taxes",
    "owe money to the irs",
    "owe the irs",
    "back tax balance",
    "amount you owe",
    "intent to seize",
    "intent to garnish",
    "final demand",
    "cp 501",
    "cp 503",
    "cp 504",
    "cp 2000",
    "lt 11",
    "letter eleven",
    "letter ten fifty eight",
    "1058 letter",
    "certified notice",
  ],
  state_tax: [
    "state taxes owed",
    "owe the state",
    "state tax debt",
    "state tax bill",
    "state revenue",
    "state collections department",
    "state tax department",
    "california ftb",
    "ftb notice",
    "ftb balance",
    "edd notice",
    "edd payroll",
    "board of equalization",
    "department of revenue",
    "dor",
    "department of taxation and finance",
    "comptroller",
    "tax commission",
    "state withholding",
    "state sales tax",
    "state unemployment",
  ],
  collection_pressure: [
    "taking money",
    "take money from me",
    "took my refund",
    "took my tax refund",
    "intercepted my refund",
    "refund offset",
    "offset my refund",
    "put a hold on my account",
    "hold on my wages",
    "hold on my paycheck",
    "they are after me",
    "coming after me",
    "levy my account",
    "levy my wages",
    "levy my paycheck",
    "garnish my wages",
    "garnish my check",
    "garnish my pay",
    "wage attachment",
    "bank freeze",
    "bank hold",
    "account hold",
    "account locked",
    "money taken out",
    "money out of my wages",
    "money out of my paycheck",
    "notice of levy",
    "notice of lien",
    "tax warrant",
    "property seizure",
    "asset seizure",
  ],
  unfiled_returns: [
    "behind on taxes",
    "behind on my taxes",
    "missing years",
    "missed years",
    "not filed for years",
    "did not file for years",
    "haven't filed for years",
    "havent filed for years",
    "haven't filed since",
    "havent filed since",
    "no return filed",
    "never filed",
    "forgot to file",
    "did not submit returns",
    "back filing",
    "catch up on filing",
    "catch up taxes",
    "old returns",
    "prior year returns",
    "compliance issue",
  ],
  payroll_tax: [
    "941 tax",
    "940 tax",
    "payroll debt",
    "payroll balance",
    "payroll withholding",
    "withheld taxes",
    "employment taxes owed",
    "business payroll problem",
    "business payroll taxes",
    "trust fund penalty",
    "responsible person penalty",
    "tfrp penalty",
    "employee tax deposits",
    "payroll deposits",
    "failed payroll deposits",
    "missed payroll deposits",
    "quarterly 941",
    "irs business account",
    "business is still operating",
    "shut down the business",
  ],
  self_employment: [
    "gig income",
    "app income",
    "rideshare",
    "delivery driver",
    "delivery income",
    "contract work",
    "contract labor",
    "cash jobs",
    "cash business",
    "side business",
    "sole proprietor",
    "llc income",
    "1099 income",
    "ten ninety nine",
    "ten ninety nine k",
    "1099k",
    "1099 nec",
    "platform income",
    "payment processor",
    "third party payments",
    "did not pay estimated",
    "no taxes taken out",
  ],
  audit_adjustment: [
    "they changed what i owe",
    "they changed my taxes",
    "computer notice",
    "matching notice",
    "income they say i missed",
    "missed income",
    "reported income",
    "under reported",
    "underreported",
    "disallowed expense",
    "disallowed credit",
    "disallowed deduction",
    "prove expenses",
    "show receipts",
    "notice of deficiency",
    "statutory notice",
    "ninety-day letter",
    "90-day letter",
    "audit letter",
    "audit appointment",
  ],
  spouse_identity: [
    "old spouse",
    "former spouse",
    "ex filed",
    "ex wife filed",
    "ex husband filed",
    "my spouse filed",
    "joint return problem",
    "joint tax debt",
    "married filing jointly",
    "innocent spouse relief",
    "injured spouse relief",
    "stolen social",
    "someone used my social",
    "identity issue",
    "id theft",
    "refund was offset",
    "refund offset for spouse",
  ],
  money_pressure: [
    "can't make rent",
    "cant make rent",
    "can't pay rent",
    "cant pay rent",
    "behind on rent",
    "behind on mortgage",
    "living paycheck to paycheck",
    "fixed income",
    "disability",
    "ssi",
    "social security check",
    "retirement check",
    "unemployed",
    "job loss",
    "lost work",
    "hours cut",
    "medical debt",
    "medical expenses",
    "child expenses",
    "kids to feed",
    "need my paycheck",
    "need my bank account",
    "cannot afford",
    "barely getting by",
  ],
  emotional_pressure: [
    "freaked out",
    "losing sleep",
    "keeping me up",
    "don't know what to do",
    "dont know what to do",
    "don't know where to start",
    "dont know where to start",
    "i feel stuck",
    "this is too much",
    "i'm overwhelmed",
    "im overwhelmed",
    "i'm scared",
    "im scared",
    "i'm worried",
    "im worried",
    "i'm stressed",
    "im stressed",
    "i feel embarrassed",
    "i feel ashamed",
    "this is embarrassing",
    "this is stressful",
    "i'm pissed",
    "im pissed",
    "this is ridiculous",
  ],
  objection: [
    "i don't want to talk",
    "i dont want to talk",
    "not a good time",
    "now is not good",
    "i'm at work",
    "im at work",
    "call later",
    "call another time",
    "send information",
    "send me information",
    "text me",
    "email information",
    "mail information",
    "let me think",
    "need to think",
    "talk to my spouse",
    "ask my spouse",
    "talk to my accountant",
    "talk to my cpa",
    "already working with someone",
    "already paid someone",
    "i'll handle it myself",
    "ill handle it myself",
    "i can do it myself",
  ],
  representation: [
    "you talk to them for me",
    "talk to them for me",
    "speak with them for me",
    "call them for me",
    "can you call the irs",
    "can you deal with them",
    "can you negotiate",
    "negotiate with them",
    "get my transcripts",
    "access my transcripts",
    "authorization to pull",
    "sign a poa",
    "sign power of attorney",
    "form 2848",
    "form 8821",
    "take this off my plate",
    "handle the agency",
    "be my representative",
  ],
  fees_close: [
    "what's the price",
    "whats the price",
    "what's your fee",
    "whats your fee",
    "what are your fees",
    "what would it cost",
    "how much money",
    "how much do i need",
    "how much down",
    "monthly payment",
    "payment plan with you",
    "can i finance",
    "can i make payments",
    "how do i start",
    "how do we start",
    "what do i sign",
    "send the agreement",
    "retainer agreement",
    "engagement agreement",
    "onboarding",
    "move forward",
  ],
});

const WEAK_CONTEXT_HITS = new Set([
  "notice",
  "letter",
  "state",
  "company",
  "paycheck",
  "my check",
  "spouse",
  "payment",
  "card",
  "today",
  "sign",
  "paperwork",
  "talk to them",
  "handle this",
  "contact them",
]);

function cleanText(value, maxLength = 4000) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeBankText(value, maxLength = DEFAULT_MAX_TEXT_CHARS) {
  return cleanText(value, maxLength)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[._/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function uniqueStrings(values, maxLength = 160) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => cleanText(value, maxLength))
    .filter(Boolean))];
}

function escapedRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function keywordHit(normalizedText, keyword) {
  const needle = normalizeBankText(keyword, 240);
  if (!needle) return false;
  if (/^[a-z0-9]+(?:-[a-z0-9]+)?$/i.test(needle)) {
    return new RegExp(`(^|[^a-z0-9])${escapedRegex(needle)}($|[^a-z0-9])`, "i").test(normalizedText);
  }
  return normalizedText.includes(needle);
}

function isWeakContextHit(keyword) {
  return WEAK_CONTEXT_HITS.has(normalizeBankText(keyword, 160));
}

function makeMatchFragment(text, hit, radius = 42) {
  const source = cleanText(text, DEFAULT_MAX_TEXT_CHARS);
  const lower = source.toLowerCase();
  const needle = String(hit || "").toLowerCase();
  const idx = needle ? lower.indexOf(needle) : -1;
  if (idx < 0) return source.slice(0, Math.min(source.length, 140));
  const start = Math.max(0, idx - radius);
  const end = Math.min(source.length, idx + needle.length + radius);
  return source.slice(start, end).trim();
}

function expandRuleKeywords(rule = {}) {
  const aliases = EXTRA_CONTEXT_ALIASES[rule.key] || [];
  return uniqueStrings([...(rule.keywords || []), ...aliases], 120);
}

function buildContextRuleCatalog(rules = []) {
  return (Array.isArray(rules) ? rules : [])
    .map((rule) => ({
      key: cleanText(rule.key, 120),
      label: cleanText(rule.label, 120),
      family: cleanText(rule.family, 80),
      priority: Number(rule.priority || 0),
      keywords: expandRuleKeywords(rule).slice(0, 80),
      summary: cleanText(rule.guidance || rule.summary || "", 300),
    }))
    .filter((rule) => rule.key);
}

function findContextCandidateMatches(text, rules = [], options = {}) {
  const limit = Math.max(1, Number(options.limit || DEFAULT_MAX_CANDIDATES));
  const normalizedText = normalizeBankText(text);
  return (Array.isArray(rules) ? rules : [])
    .map((rule) => {
      const allKeywords = expandRuleKeywords(rule);
      const hits = uniqueStrings(allKeywords.filter((keyword) => keywordHit(normalizedText, keyword)), 120);
      if (!hits.length) return null;
      const strongHits = hits.filter((hit) => !isWeakContextHit(hit));
      const score =
        Number(rule.priority || 0) +
        hits.length * 8 +
        strongHits.length * 10 +
        Math.min(12, Math.max(0, 8 - hits[0].length / 10));
      return {
        key: cleanText(rule.key, 120),
        label: cleanText(rule.label || rule.key, 120),
        family: cleanText(rule.family || "sales", 80),
        priority: Number(rule.priority || 0),
        score: Number(score.toFixed(2)),
        hits,
        fragment: makeMatchFragment(text, hits[0]),
        guidance: cleanText(rule.guidance || rule.summary || "", 300),
        summary: cleanText(rule.guidance || rule.summary || "", 300),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || b.priority - a.priority || b.hits.length - a.hits.length || a.key.localeCompare(b.key))
    .slice(0, limit);
}

function normalizeContextCandidate(candidate = {}) {
  const key = cleanText(candidate.key || "", 80);
  if (!key) return null;
  return {
    key,
    label: cleanText(candidate.label || key, 120),
    family: cleanText(candidate.family || "sales", 80),
    priority: Number(candidate.priority || candidate.score || 0) || 0,
    score: Number(candidate.score || candidate.priority || 0) || 0,
    hits: Array.isArray(candidate.hits)
      ? candidate.hits.map((hit) => cleanText(hit, 120)).filter(Boolean)
      : [],
    fragment: cleanText(candidate.fragment || "", 240),
    guidance: cleanText(candidate.guidance || candidate.summary || "", 300),
    summary: cleanText(candidate.summary || candidate.guidance || "", 300),
  };
}

function normalizeContextCandidates(candidates = [], options = {}) {
  const limit = Math.max(1, Number(options.limit || DEFAULT_MAX_CANDIDATES));
  const byKey = new Map();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const normalized = normalizeContextCandidate(candidate);
    if (!normalized) continue;
    const current = byKey.get(normalized.key);
    if (!current) {
      byKey.set(normalized.key, normalized);
      continue;
    }
    current.priority = Math.max(current.priority, normalized.priority);
    current.score = Math.max(current.score, normalized.score);
    current.hits = uniqueStrings([...current.hits, ...normalized.hits], 120);
    if (!current.fragment && normalized.fragment) current.fragment = normalized.fragment;
    if (!current.guidance && normalized.guidance) current.guidance = normalized.guidance;
    if (!current.summary && normalized.summary) current.summary = normalized.summary;
    if (!current.label && normalized.label) current.label = normalized.label;
    if (!current.family && normalized.family) current.family = normalized.family;
  }
  return [...byKey.values()]
    .sort((a, b) => b.score - a.score || b.priority - a.priority || b.hits.length - a.hits.length || a.key.localeCompare(b.key))
    .slice(0, limit);
}

function mergeContextCandidates(existing = [], incoming = [], options = {}) {
  return normalizeContextCandidates([...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])], options);
}

module.exports = {
  EXTRA_CONTEXT_ALIASES,
  WEAK_CONTEXT_HITS,
  buildContextRuleCatalog,
  cleanText,
  findContextCandidateMatches,
  isWeakContextHit,
  makeMatchFragment,
  mergeContextCandidates,
  normalizeBankText,
  normalizeContextCandidates,
  uniqueStrings,
};
