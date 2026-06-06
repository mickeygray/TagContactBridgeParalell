"use strict";

const {
  CALL_SCREENER_MATCHES,
  CONTEXT_RULES,
  VOICEMAIL_MATCHES,
  analyzeCallScreener,
  analyzeVoicemail,
  cleanText,
  findContextMatches,
  normalizeTaxTerms,
} = require("./liveCoachSanitizedPipeline");

const DEFAULT_MAX_TEXT_CHARS = 2400;
const DEFAULT_MAX_CANDIDATES = 24;
const DEFAULT_INITIAL_VOICEMAIL_WINDOW_CHARS = 900;

function normalizeWatchText(value, maxLength = DEFAULT_MAX_TEXT_CHARS) {
  return normalizeTaxTerms(cleanText(value, maxLength));
}

function compactText(value) {
  return cleanText(value, DEFAULT_MAX_TEXT_CHARS).toLowerCase();
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => cleanText(value, 160)).filter(Boolean))];
}

function makeMatchFragment(text, hit, radius = 38) {
  const source = cleanText(text, DEFAULT_MAX_TEXT_CHARS);
  const lower = source.toLowerCase();
  const needle = String(hit || "").toLowerCase();
  const idx = needle ? lower.indexOf(needle) : -1;
  if (idx < 0) return source.slice(0, Math.min(source.length, 120));
  const start = Math.max(0, idx - radius);
  const end = Math.min(source.length, idx + needle.length + radius);
  return source.slice(start, end).trim();
}

function buildRuleSummaries(rules = CONTEXT_RULES) {
  return rules.map((rule) => ({
    key: rule.key,
    label: rule.label,
    family: rule.family,
    priority: Number(rule.priority || 0),
    keywords: uniqueStrings(rule.keywords),
    summary: cleanText(rule.guidance, 300),
  }));
}

function rankContextCandidates(text, options = {}) {
  const limit = Math.max(1, Number(options.limit || DEFAULT_MAX_CANDIDATES));
  const normalized = normalizeWatchText(text);
  return findContextMatches(normalized, { limit: CONTEXT_RULES.length })
    .map((rule) => {
      const hits = uniqueStrings(rule.hits);
      const score = Number(rule.priority || 0) + hits.length * 12;
      return {
        key: rule.key,
        label: rule.label,
        family: rule.family,
        priority: Number(rule.priority || 0),
        score,
        hits,
        fragment: makeMatchFragment(normalized, hits[0]),
        summary: cleanText(rule.guidance, 300),
      };
    })
    .sort((a, b) => b.score - a.score || b.hits.length - a.hits.length || a.key.localeCompare(b.key))
    .slice(0, limit);
}

function mergeCandidates(existing = [], incoming = [], options = {}) {
  const byKey = new Map();
  for (const candidate of [...existing, ...incoming]) {
    if (!candidate?.key) continue;
    const current = byKey.get(candidate.key);
    if (!current) {
      byKey.set(candidate.key, {
        ...candidate,
        hits: uniqueStrings(candidate.hits),
      });
      continue;
    }
    current.score = Math.max(Number(current.score || 0), Number(candidate.score || 0));
    current.priority = Math.max(Number(current.priority || 0), Number(candidate.priority || 0));
    current.hits = uniqueStrings([...(current.hits || []), ...(candidate.hits || [])]);
    if (!current.fragment && candidate.fragment) current.fragment = candidate.fragment;
  }
  const limit = Math.max(1, Number(options.limit || DEFAULT_MAX_CANDIDATES));
  return [...byKey.values()]
    .sort((a, b) => b.score - a.score || b.hits.length - a.hits.length || a.key.localeCompare(b.key))
    .slice(0, limit);
}

function createLiveCoachStreamWatcher(options = {}) {
  const maxTextChars = Math.max(200, Number(options.maxTextChars || DEFAULT_MAX_TEXT_CHARS));
  const maxCandidates = Math.max(1, Number(options.maxCandidates || DEFAULT_MAX_CANDIDATES));
  const initialVoicemailWindowChars = Math.max(
    100,
    Number(options.initialVoicemailWindowChars || DEFAULT_INITIAL_VOICEMAIL_WINDOW_CHARS),
  );
  const state = {
    text: "",
    status: "listening",
    rejected: false,
    heldForScreener: false,
    firstTextAt: null,
    lastTextAt: null,
    lastItemId: "",
    lastItemText: "",
    updates: 0,
    candidates: [],
    systemMatches: [],
  };

  function snapshot() {
    return {
      status: state.status,
      rejected: state.rejected,
      heldForScreener: state.heldForScreener,
      text: state.text,
      firstTextAt: state.firstTextAt,
      lastTextAt: state.lastTextAt,
      lastItemId: state.lastItemId,
      updates: state.updates,
      candidates: state.candidates.map((candidate) => ({ ...candidate, hits: [...candidate.hits] })),
      systemMatches: state.systemMatches.map((match) => ({ ...match })),
    };
  }

  function appendText(input = {}) {
    if (state.rejected) {
      return {
        action: "ignored_rejected",
        reason: "watcher_already_rejected",
        snapshot: snapshot(),
      };
    }

    const rawText = typeof input === "string" ? input : input.text || input.delta || input.transcript || "";
    const text = normalizeWatchText(rawText, maxTextChars);
    if (!text) {
      return {
        action: "ignored_empty",
        snapshot: snapshot(),
      };
    }

    const now = cleanText(input.at || "", 80) || new Date().toISOString();
    if (!state.firstTextAt) state.firstTextAt = now;
    state.lastTextAt = now;
    state.updates += 1;
    const itemId = cleanText(input.itemId || input.item_id || input.id || "", 120);
    let previousText = state.text;
    if (itemId && itemId === state.lastItemId && state.lastItemText) {
      const previousItemText = state.lastItemText;
      if (text === previousItemText) {
        return {
          action: "ignored_duplicate_item_text",
          candidates: state.candidates.map((candidate) => ({ ...candidate, hits: [...candidate.hits] })),
          systemMatches: state.systemMatches.map((match) => ({ ...match })),
          snapshot: snapshot(),
        };
      }
      if (previousText.endsWith(previousItemText)) {
        previousText = previousText.slice(0, previousText.length - previousItemText.length).trim();
      }
    }
    state.text = normalizeWatchText(`${previousText} ${text}`.slice(-maxTextChars), maxTextChars);
    if (itemId) {
      state.lastItemId = itemId;
      state.lastItemText = text;
    }

    const voicemailWindow = state.text.slice(0, initialVoicemailWindowChars);
    const voicemail = analyzeVoicemail(voicemailWindow);
    if (voicemail.isVoicemail) {
      state.rejected = true;
      state.status = "voicemail_rejected";
      const match = {
        type: "voicemail",
        match: voicemail.match,
        at: now,
        action: "reject_call",
      };
      state.systemMatches.push(match);
      return {
        action: "reject_voicemail",
        systemMatch: match,
        candidates: [],
        snapshot: snapshot(),
      };
    }

    const screener = analyzeCallScreener(state.text);
    if (screener.isScreener) {
      state.heldForScreener = true;
      state.status = "screener_hold";
      const match = {
        type: "call_screener",
        match: screener.match,
        at: now,
        action: "hold_from_coach_context",
      };
      if (!state.systemMatches.some((entry) => entry.type === match.type && entry.match === match.match)) {
        state.systemMatches.push(match);
      }
    } else if (state.status === "screener_hold") {
      state.status = "listening";
    }

    const candidates = rankContextCandidates(state.text, { limit: maxCandidates });
    state.candidates = mergeCandidates(state.candidates, candidates, { limit: maxCandidates });

    return {
      action: state.heldForScreener ? "hold_call_screener" : "collect_candidates",
      candidates: state.candidates.map((candidate) => ({ ...candidate, hits: [...candidate.hits] })),
      systemMatches: state.systemMatches.map((match) => ({ ...match })),
      snapshot: snapshot(),
    };
  }

  function releaseForVad(input = {}) {
    const vadText = normalizeWatchText(input.text || "", maxTextChars);
    const phraseText = vadText || state.text;
    const candidates = mergeCandidates(
      state.candidates,
      findContextMatches(phraseText, { limit: maxCandidates }),
      { limit: maxCandidates },
    );
    const payload = {
      action: state.rejected
        ? "reject_voicemail"
        : state.heldForScreener
          ? "hold_call_screener"
          : "vad_release",
      phraseText,
      candidates: candidates.map((candidate) => ({
        key: candidate.key,
        label: candidate.label,
        family: candidate.family,
        priority: Number(candidate.priority || 0),
        score: Number(candidate.score || candidate.priority || 0),
        hits: uniqueStrings(candidate.hits),
        fragment: candidate.fragment || makeMatchFragment(phraseText, candidate.hits?.[0]),
        summary: cleanText(candidate.summary || candidate.guidance, 300),
      })),
      systemMatches: state.systemMatches.map((match) => ({ ...match })),
      watcher: snapshot(),
    };
    state.text = "";
    state.candidates = [];
    state.lastItemId = "";
    state.lastItemText = "";
    state.heldForScreener = false;
    state.status = state.rejected ? "voicemail_rejected" : "listening";
    return payload;
  }

  function reset() {
    state.text = "";
    state.status = "listening";
    state.rejected = false;
    state.heldForScreener = false;
    state.firstTextAt = null;
    state.lastTextAt = null;
    state.lastItemId = "";
    state.lastItemText = "";
    state.updates = 0;
    state.candidates = [];
    state.systemMatches = [];
    return snapshot();
  }

  return {
    appendText,
    releaseForVad,
    reset,
    snapshot,
  };
}

module.exports = {
  buildRuleSummaries,
  createLiveCoachStreamWatcher,
  mergeCandidates,
  normalizeWatchText,
  rankContextCandidates,
};
