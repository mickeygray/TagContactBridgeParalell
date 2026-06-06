"use strict";

const {
  buildMiniContextFrame,
  buildSonnetPromptPayload,
  cleanText,
  createSonnetDialogDraft,
  normalizeSttTranscript,
  normalizeTaxTerms,
} = require("./liveCoachSanitizedPipeline");
const {
  createLiveCoachStreamWatcher,
  mergeCandidates,
  rankContextCandidates,
} = require("./liveCoachStreamWatcherService");

function simulateMiniContextJudgement({ vadRelease, metadata = {}, maxMatches = 6 } = {}) {
  const phraseText = normalizeTaxTerms(vadRelease?.phraseText || "");
  const transcript = normalizeSttTranscript({
    text: phraseText,
    role: "prospect",
    source: "local-stream-loop-harness",
    provider: "fixture",
    model: "simulated-stt",
  });
  const baseCandidates = Array.isArray(vadRelease?.candidates) ? vadRelease.candidates : [];
  const broadCandidates = mergeCandidates(
    baseCandidates,
    rankContextCandidates(phraseText, { limit: Math.max(maxMatches * 3, 18) }),
    { limit: Math.max(maxMatches * 3, 18) },
  );
  const frame = buildMiniContextFrame({
    phraseText,
    transcript,
    metadata,
    pendingCount: 0,
    candidateMatches: broadCandidates,
  });
  const taxMatches = frame.matches.filter((match) => match.family === "tax_comprehension");
  const specificity =
    taxMatches.some((match) => (match.hits || []).some((hit) => /\b(CP\d{3,4}|LT11|Letter 1058|941|940|1099|FTB|EDD|IRS)\b/i.test(hit)))
      ? "specific"
      : taxMatches.length
        ? "tax_general"
        : "general";

  return {
    ...frame,
    candidateCount: broadCandidates.length,
    selectedKeyCount: frame.matches.length,
    miniJudgement: {
      ...(frame.miniJudgement || {}),
      simulated: true,
      specificity,
      meaning: buildMeaningSummary({ phraseText, matches: frame.matches, specificity }),
      selectedKeys: frame.matches.map((match) => match.key),
      candidateKeys: broadCandidates.map((candidate) => candidate.key),
    },
  };
}

function buildMeaningSummary({ phraseText, matches = [], specificity = "general" } = {}) {
  const labels = matches.slice(0, 4).map((match) => match.label).filter(Boolean);
  if (!labels.length) {
    return `Prospect said: ${cleanText(phraseText, 240)}. No hard match; use general discovery and emotional/sales guidance.`;
  }
  return [
    `Prospect said: ${cleanText(phraseText, 240)}.`,
    `Likely applies: ${labels.join(", ")}.`,
    `Specificity: ${specificity}.`,
  ].join(" ");
}

function runStreamLoopFixture({ chunks = [], metadata = {}, watcherOptions = {}, maxMatches = 6 } = {}) {
  const watcher = createLiveCoachStreamWatcher(watcherOptions);
  const events = [];
  let final = null;
  const rows = Array.isArray(chunks) ? chunks : [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = typeof rows[index] === "string" ? { text: rows[index] } : rows[index] || {};
    const append = watcher.appendText({
      text: row.text,
      at: row.at,
    });
    events.push({
      stage: "watcher.append",
      index,
      text: row.text,
      action: append.action,
      candidates: append.candidates || [],
      systemMatches: append.systemMatches || [],
    });

    if (append.action === "reject_voicemail") {
      final = {
        status: "voicemail_rejected",
        watcher: append.snapshot,
        events,
      };
      break;
    }

    if (row.vadRelease || index === rows.length - 1) {
      const release = watcher.releaseForVad(row.vadReleaseText ? { text: row.vadReleaseText } : {});
      events.push({
        stage: "watcher.vad_release",
        index,
        action: release.action,
        phraseText: release.phraseText,
        candidates: release.candidates,
        systemMatches: release.systemMatches,
      });

      if (release.action === "hold_call_screener") {
        final = {
          status: "held_call_screener",
          release,
          events,
        };
        break;
      }

      const contextFrame = simulateMiniContextJudgement({
        vadRelease: release,
        metadata,
        maxMatches,
      });
      const promptPayload = buildSonnetPromptPayload({ contextFrame, metadata });
      const dialog = createSonnetDialogDraft({ contextFrame, metadata });
      events.push({
        stage: "mini.judgement",
        selectedKeys: contextFrame.miniJudgement.selectedKeys,
        specificity: contextFrame.miniJudgement.specificity,
        shouldCompose: contextFrame.shouldCompose,
        meaning: contextFrame.miniJudgement.meaning,
      });
      events.push({
        stage: "sonnet.prompt",
        shouldCompose: promptPayload.shouldCompose,
        userChars: promptPayload.user.length,
        systemChars: promptPayload.system.length,
      });
      events.push({
        stage: "sonnet.dialog",
        status: dialog.status,
        label: dialog.label,
        say: dialog.say,
      });
      final = {
        status: dialog.status === "ready" ? "ready" : "wait",
        release,
        contextFrame,
        promptPayload,
        dialog,
        events,
      };
    }
  }

  return final || {
    status: "empty",
    watcher: watcher.snapshot(),
    events,
  };
}

module.exports = {
  buildMeaningSummary,
  runStreamLoopFixture,
  simulateMiniContextJudgement,
};
