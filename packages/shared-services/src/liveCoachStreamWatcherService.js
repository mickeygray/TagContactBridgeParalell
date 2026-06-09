"use strict";

const {
  CALL_SCREENER_MATCHES,
  CONTEXT_RULES,
  VOICEMAIL_MATCHES,
  analyzeSystemContextClear,
  analyzeCallScreener,
  analyzeVoicemail,
  cleanText,
  normalizeTaxTerms,
} = require("./liveCoachSanitizedPipeline");
const {
  buildContextRuleCatalog,
  findContextCandidateMatches,
  makeMatchFragment,
  mergeContextCandidates,
  uniqueStrings,
} = require("./liveCoachContextMatchBank");

const DEFAULT_MAX_TEXT_CHARS = 2400;
const DEFAULT_MAX_CANDIDATES = 24;
const DEFAULT_INITIAL_VOICEMAIL_WINDOW_CHARS = 900;

function normalizeWatchText(value, maxLength = DEFAULT_MAX_TEXT_CHARS) {
  return normalizeTaxTerms(cleanText(value, maxLength));
}

function compactText(value) {
  return cleanText(value, DEFAULT_MAX_TEXT_CHARS).toLowerCase();
}

function buildRuleSummaries(rules = CONTEXT_RULES) {
  return buildContextRuleCatalog(rules);
}

function rankContextCandidates(text, options = {}) {
  const limit = Math.max(1, Number(options.limit || DEFAULT_MAX_CANDIDATES));
  const normalized = normalizeWatchText(text);
  return findContextCandidateMatches(normalized, CONTEXT_RULES, { limit });
}

function mergeCandidates(existing = [], incoming = [], options = {}) {
  return mergeContextCandidates(existing, incoming, {
    limit: Math.max(1, Number(options.limit || DEFAULT_MAX_CANDIDATES)),
  });
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

    const contextClear = analyzeSystemContextClear(state.text);
    if (contextClear.shouldClear) {
      state.heldForScreener = true;
      state.status = "system_context_clear";
      const match = {
        type: "system_context_clear",
        match: contextClear.match,
        at: now,
        action: "clear_context",
      };
      if (!state.systemMatches.some((entry) => entry.type === match.type && entry.match === match.match)) {
        state.systemMatches.push(match);
      }
    }

    const screener = analyzeCallScreener(state.text);
    if (screener.isScreener && state.status !== "system_context_clear") {
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

    // Determinism owns the gatekeeper turns. While a hold/screener prompt is talking we do
    // NOT mine its words into coach candidates; a context-clear prompt ERASES what we have
    // gathered so we wait for the human/prospect to resume. Only "listening" turns feed the
    // word bank -- so the lookup never matches on the machine/screener, only on the prospect.
    if (state.status === "system_context_clear") {
      state.candidates = [];
    } else if (!state.heldForScreener) {
      const candidates = rankContextCandidates(state.text, { limit: maxCandidates });
      state.candidates = mergeCandidates(state.candidates, candidates, { limit: maxCandidates });
    }

    return {
      action: state.status === "system_context_clear"
        ? "clear_context_system_prompt"
        : state.heldForScreener
          ? "hold_call_screener"
          : "collect_candidates",
      candidates: state.candidates.map((candidate) => ({ ...candidate, hits: [...candidate.hits] })),
      systemMatches: state.systemMatches.map((match) => ({ ...match })),
      snapshot: snapshot(),
    };
  }

  function releaseForVad(input = {}) {
    const vadText = normalizeWatchText(input.text || "", maxTextChars);
    const phraseText = vadText || state.text;
    // If this release is a hold/screener/voicemail turn, return NO candidates -- determinism
    // gated it, so we never hand the machine/screener words to the mini or the coach.
    const held = state.rejected || state.status === "system_context_clear" || state.heldForScreener;
    const candidates = held
      ? []
      : mergeCandidates(
          state.candidates,
          rankContextCandidates(phraseText, { limit: maxCandidates }),
          { limit: maxCandidates },
        );
    const payload = {
      action: state.rejected
        ? "reject_voicemail"
        : state.status === "system_context_clear"
          ? "clear_context_system_prompt"
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
