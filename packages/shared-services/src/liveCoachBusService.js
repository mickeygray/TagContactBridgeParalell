"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  CONTEXT_RULES,
  VOICEMAIL_MATCHES,
  buildAskPrompt,
  createSonnetDialogDraft,
  createSanitizedLiveCoachPipeline,
  deriveConversationTactics,
  normalizeContextCandidates,
} = require("./liveCoachSanitizedPipeline");
const {
  createLiveCoachStreamWatcher,
} = require("./liveCoachStreamWatcherService");

const TERMINAL_SESSION_STATUSES = Object.freeze(["stopped", "stale", "voicemail_rejected", "released"]);
const GRPC_SESSION_SOURCES = Object.freeze(["grpc", "grpc-mongo", "grpc-live-bridge", "mongo-cx", "control-plane-cx"]);
const CALL_ENDING_STALE_REASONS = Object.freeze(new Set([
  "agent-current-call-changed",
  "binding-inactive",
  "disposition-hangup",
  "event-expired",
  "no-current-binding",
  "not_current",
]));
const MEMORY_LIMITS = Object.freeze({
  provisionalTranscripts: 40,
  transcripts: 240,
  contexts: 140,
  coachingSuggestions: 140,
  holds: 120,
  asks: 30,
});
const DEFAULT_THOUGHT_BUFFER_MAX_CHARS = 900;
const DEFAULT_THOUGHT_BUFFER_MAX_CHUNKS = 5;

function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function cleanText(value, maxLength = 4000) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function cleanLower(value, maxLength = 4000) {
  return cleanText(value, maxLength).toLowerCase();
}

function canonicalAgentEmail(value) {
  const email = cleanLower(value, 180);
  const at = email.indexOf("@");
  if (at <= 0) return email;
  const local = email.slice(0, at).replace(/\+.*/, "");
  const domain = email.slice(at + 1);
  return local && domain ? `${local}@${domain}` : email;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJsonLine(file, event) {
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
}

function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildProvisionalChunks(text, input = {}) {
  const words = cleanText(text, 4000).split(/\s+/).filter(Boolean);
  const chunkWords = Math.max(2, Math.min(12, Number(input.chunkWords || 5) || 5));
  const maxDeltas = Math.max(1, Math.min(20, Number(input.maxDeltas || 8) || 8));
  const chunks = [];
  for (let count = chunkWords; count < words.length && chunks.length < maxDeltas; count += chunkWords) {
    chunks.push(words.slice(0, count).join(" "));
  }
  return chunks;
}

function normalizeMetadata(input = {}) {
  return {
    source: cleanText(input.source || "manual", 80),
    agentEmail: cleanText(input.agentEmail || input.agent || "", 160).toLowerCase(),
    agentExtension: cleanText(input.agentExtension || input.agentExt || input.extensionId || "", 80),
    agentName: cleanText(input.agentName || "", 120),
    firmName: cleanText(input.firmName || "Wynn Tax Solutions", 120),
    uii: cleanText(input.uii || input.UII || input.callUii || "", 120),
    queueItemId: cleanText(input.queueItemId || input.queueTicketId || "", 120),
    caseId: cleanText(input.caseId || input.sourceLogicsCaseId || "", 120),
    phone: cleanText(input.phone || input.phoneNumber || "", 80),
    domain: cleanText(input.domain || "", 40).toUpperCase(),
    contactName: cleanText(input.contactName || "", 160),
    eventId: cleanText(input.eventId || "", 120),
    callSessionId: cleanText(input.callSessionId || "", 160),
    streamId: cleanText(input.streamId || "", 160),
    workflowInstanceId: cleanText(input.workflowInstanceId || "", 180),
  };
}

function firstClean(values, maxLength = 240) {
  for (const value of values) {
    const clean = cleanText(value, maxLength);
    if (clean) return clean;
  }
  return "";
}

function extractInputIdentity(input = {}) {
  return {
    uii: firstClean([input.uii, input.UII, input.rcxUii, input.callUii, input.telephonySessionId], 160),
    agentExtension: firstClean([input.agentExtension, input.agentExt, input.extensionId, input.agentExtensionId], 80),
    agentEmail: cleanLower(firstClean([input.agentEmail, input.agent, input.email], 180)),
    queueItemId: firstClean([input.queueItemId, input.queueTicketId], 160),
    eventId: firstClean([input.eventId], 160),
    streamId: firstClean([input.streamId], 160),
  };
}

function callIdentityFromMetadata(metadata = {}) {
  return firstClean([metadata.uii, metadata.queueItemId, metadata.eventId, metadata.callSessionId], 180);
}

function callIdentityFromBinding(binding = {}) {
  return firstClean([
    binding.event?.uii,
    binding.metadata?.uii,
    binding.event?.queueItemId,
    binding.metadata?.queueItemId,
    binding.event?.id,
    binding.metadata?.eventId,
  ], 180);
}

function uniqueCleanIdentityKeys(values = []) {
  const seen = new Set();
  const keys = [];
  for (const value of values) {
    const key = cleanText(value, 180);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

function callIdentityKeysFromMetadata(metadata = {}) {
  return uniqueCleanIdentityKeys([
    metadata.uii,
    metadata.queueItemId,
    metadata.eventId,
    metadata.callSessionId,
  ]);
}

function callIdentityKeysFromBinding(binding = {}) {
  return uniqueCleanIdentityKeys([
    binding.event?.uii,
    binding.metadata?.uii,
    binding.event?.queueItemId,
    binding.metadata?.queueItemId,
    binding.event?.id,
    binding.metadata?.eventId,
    binding.event?.callSessionId,
    binding.metadata?.callSessionId,
  ]);
}

function mergeIdentityKeys(...keyGroups) {
  return uniqueCleanIdentityKeys(keyGroups.flatMap((keys) => Array.isArray(keys) ? keys : [keys]));
}

function identityKeysOverlap(left = [], right = []) {
  if (!left.length || !right.length) return false;
  const rightSet = new Set(right);
  return left.some((key) => rightSet.has(key));
}

function hasUiiIdentityKey(keys = []) {
  return (Array.isArray(keys) ? keys : []).some((key) => /^\d{18,}$/.test(String(key || "")));
}

function agentMatchesSession(session = {}, identity = {}) {
  const metadata = session.metadata || {};
  if (identity.agentExtension && metadata.agentExtension && identity.agentExtension !== metadata.agentExtension) {
    return false;
  }
  if (
    identity.agentEmail &&
    metadata.agentEmail &&
    canonicalAgentEmail(identity.agentEmail) !== canonicalAgentEmail(metadata.agentEmail)
  ) {
    return false;
  }
  return true;
}

function shouldCleanupSession(session = {}, sourceFilter = GRPC_SESSION_SOURCES) {
  const source = cleanText(session.metadata?.source || "", 80);
  if (!sourceFilter) return true;
  const allowed = Array.isArray(sourceFilter) ? sourceFilter : String(sourceFilter).split(",");
  return allowed.map((item) => cleanText(item, 80)).filter(Boolean).includes(source);
}

function createMemoryState() {
  return {
    provisionalTranscripts: [],
    transcripts: [],
    contexts: [],
    coachingSuggestions: [],
    holds: [],
    asks: [],
  };
}

function createThoughtBufferState() {
  return {
    unresolved: [],
    nextId: 1,
  };
}

// ── Per-turn timing rollup ───────────────────────────────────────────────────
// One glanceable object on session.latest.turnTimings: when the turn's STT
// finalized, how long the mini took, when Sonnet started / first streamed /
// settled, and the outcome (ready | wait | suppressed | error). latest ships
// whole in serializeSession, so admin UIs read timing truth directly instead
// of re-deriving it from the event log. Diagnostics only — never gates.
function startTurnTimings(session, transcript) {
  if (!session?.latest) return;
  session.latest.turnTimings = {
    vadFinalAt: new Date().toISOString(),
    transcriptId: cleanText(transcript?.id || "", 120) || null,
    channel: cleanText(transcript?.channel || "", 20) || null,
  };
}

function stampTurnTiming(session, key, extra, logger) {
  if (!session?.latest) return;
  const timings = session.latest.turnTimings || (session.latest.turnTimings = {});
  timings[key] = new Date().toISOString();
  if (extra) Object.assign(timings, extra);
  // At settle, emit ONE structured row with the full per-turn critical path so
  // coach latency can be AGGREGATED from logs (the in-memory object is
  // glanceable-only). vadToFirstDeltaMs is the number the rep actually waits for.
  if (key === "settledAt" && logger && logger.info) {
    const t = timings;
    const ms = (a, b) => (a && b ? new Date(b) - new Date(a) : null);
    logger.info("live_coach.turn.timing", {
      sessionId: session.id || null,
      channel: t.channel || null,
      outcome: t.outcome || null,
      miniMs: t.miniMs ?? null,
      vadToComposeMs: ms(t.vadFinalAt, t.composeStartAt),
      composeToFirstDeltaMs: ms(t.composeStartAt, t.firstDeltaAt),
      vadToFirstDeltaMs: ms(t.vadFinalAt, t.firstDeltaAt),
      firstDeltaToSettledMs: ms(t.firstDeltaAt, t.settledAt),
      totalMs: ms(t.vadFinalAt, t.settledAt),
    });
  }
}

function pushMemory(session, key, value) {
  if (!session || !value) return null;
  if (!session.memory) session.memory = createMemoryState();
  if (!Array.isArray(session.memory[key])) session.memory[key] = [];
  const rows = session.memory[key];
  rows.push(value);
  const limit = MEMORY_LIMITS[key] || 100;
  if (rows.length > limit) rows.splice(0, rows.length - limit);
  return value;
}

function buildRecentCallMemory(session = {}, context = {}, {
  maxTranscriptRows = 10,
  maxContextRows = 8,
  maxCoachRows = 2,
  maxChars = 1600,
} = {}) {
  const memory = session.memory || {};
  const currentTranscriptId = cleanText(context.sourceTranscriptId || "", 120);
  const currentPhrase = normalizeSignatureText(context.phraseText || context.text || "");
  const currentMemoryBrief = normalizeMemoryBrief(context.memoryBrief || context.miniJudgement?.memoryBrief || {});
  const filteredRows = (Array.isArray(memory.contexts) ? memory.contexts : [])
    .filter((row) => row?.phraseText || row?.text || row?.memoryBrief || row?.miniJudgement?.memoryBrief)
    .slice(-Math.max(1, Number(maxContextRows) || 8))
    .flatMap((row) => {
      const phrase = cleanText(row.phraseText || row.text || "", 180);
      const brief = normalizeMemoryBrief(row.memoryBrief || row.miniJudgement?.memoryBrief || {});
      const issues = brief?.activeIssues?.length
        ? brief.activeIssues.map((issue) => ({
          key: issue.key,
          snippet: issue.snippet || phrase,
          status: issue.status,
          meaning: brief.whatHappened,
        }))
        : [];
      const matchIssues = (Array.isArray(row.matches) ? row.matches : [])
        .slice(0, 4)
        .map((match) => ({
          key: cleanText(match.key, 120),
          snippet: cleanText(match.miniSnippet || match.hits?.[0] || phrase, 180),
          status: "prior_match",
          meaning: cleanText(row.miniJudgement?.transcriptMeaning || row.actionReason || "", 180),
        }))
        .filter((issue) => issue.key || issue.snippet);
      return issues.length ? issues : matchIssues;
    })
    .filter((issue) => issue.key || issue.snippet)
    .slice(-8)
    .map((issue) => [
      `- ${issue.key || "general"}: ${issue.snippet}`,
      issue.status ? `(${issue.status})` : "",
      issue.meaning ? `=> ${issue.meaning}` : "",
    ].filter(Boolean).join(" "));

  const currentBriefRows = currentMemoryBrief ? [
    currentMemoryBrief.whatHappened ? `- Current compact read: ${currentMemoryBrief.whatHappened}` : "",
    currentMemoryBrief.activeIssues?.length
      ? `- Current filtered matches: ${currentMemoryBrief.activeIssues.map((issue) => `${issue.key}: ${issue.snippet}`).join("; ")}`
      : "",
    currentMemoryBrief.continueFrom ? `- Continue from: ${currentMemoryBrief.continueFrom}` : "",
  ].filter(Boolean) : [];

  const transcriptRows = (Array.isArray(memory.transcripts) ? memory.transcripts : [])
    .filter((row) => row?.text)
    .filter((row) => cleanText(row.role || "prospect", 40) === "prospect")
    .slice(-Math.max(1, Number(maxTranscriptRows) || 6))
    .map((row) => {
      const text = cleanText(row.text, 220);
      const sameId = currentTranscriptId && cleanText(row.id || "", 120) === currentTranscriptId;
      const sameText = currentPhrase && normalizeSignatureText(text) === currentPhrase;
      if (sameId || sameText) return null;
      // Marked-not-dropped STT: tell the model when a line was low confidence
      // so it weighs (not trusts) garbled carrier audio.
      return row.lowConfidence ? `- Prospect (low-confidence transcription): ${text}` : `- Prospect: ${text}`;
    })
    .filter(Boolean);

  // Agent-channel rows (role:"agent" from the bridge's context-only agent STT)
  // surface ONLY here — composer context. The mini judge and the deterministic
  // pipeline never see them; they exist so Claude doesn't suggest what the
  // agent just said and can build on the agent's actual last move.
  const agentRows = (Array.isArray(memory.transcripts) ? memory.transcripts : [])
    .filter((row) => row?.text)
    .filter((row) => cleanText(row.role || "", 40) === "agent")
    .slice(-2)
    .map((row) => `- Agent: ${cleanText(row.text, 220)}`);

  const coachRows = (Array.isArray(memory.coachingSuggestions) ? memory.coachingSuggestions : [])
    .filter((row) => row?.say)
    .slice(-Math.max(0, Number(maxCoachRows) || 2))
    .map((row) => {
      // Navigator-shaped output: the repetition risk is the Try line (spoken
      // words) or the Steer (the direction) — not the Read label preamble.
      const full = cleanText(row.say, 600);
      const tryLine = full.match(/(?:^|\n)\s*Try:\s*"?([^"\n]+)"?/i)?.[1];
      const steer = full.match(/(?:^|\n)\s*Steer:\s*([^\n]+)/i)?.[1];
      return `- Prior coaching (avoid repeating): ${cleanText(tryLine || steer || full, 180)}`;
    });

  const priorCallRows = (Array.isArray(session.priorCallMemory) ? session.priorCallMemory : [])
    .slice(0, 2)
    .map((p) => {
      const parts = [
        Array.isArray(p.issues) && p.issues.length ? `raised ${p.issues.slice(0, 5).join(", ")}` : "",
        p.lastCoachLine ? `last coached: "${cleanText(p.lastCoachLine, 160)}"` : "",
        p.status ? `[${cleanText(p.status, 40)}]` : "",
      ].filter(Boolean).join(" | ");
      return parts ? `- ${parts}` : "";
    })
    .filter(Boolean);

  // ── Whole-call durable memory: the facts ledger never rolls off and the
  // cumulative summary is revised every digest cycle — on a long call these
  // are how the composer "finds things" that left the transcript window.
  const factRows = Object.entries(session.factLedger || {})
    .slice(-24)
    .map(([key, row]) => `- ${key}: ${cleanText(row?.value || "", 120)}`)
    .filter((row) => !row.endsWith(": "));
  const summaryRow = cleanText(session.callSummary || "", 480);

  const sections = [
    priorCallRows.length ? ["Prior calls with this prospect (continuity only; the current call always outranks this):", ...priorCallRows].join("\n") : "",
    summaryRow ? ["The call so far (cumulative, oldest first):", `- ${summaryRow}`].join("\n") : "",
    factRows.length ? ["Key facts discovered this call (steer toward gaps; never re-ask these):", ...factRows].join("\n") : "",
    currentBriefRows.length ? ["Mini compact memory for this turn:", ...currentBriefRows].join("\n") : "",
    agentRows.length ? ["Agent's most recent line(s) - optional context only; do not wait for agent VAD, repeat it, or rephrase it:", ...agentRows].join("\n") : "",
    filteredRows.length ? ["Recent filtered matches with snippets:", ...filteredRows].join("\n") : "",
    // Avoid-repeat BEFORE the raw transcript fallback: the char cap truncates
    // from the END, and losing avoid-repeat invites repeated coaching while
    // losing raw lines only loses redundancy (facts/summary carry the call).
    coachRows.length ? ["Avoid repeating these recent coach lines:", ...coachRows].join("\n") : "",
    transcriptRows.length ? ["Recent raw prospect lines, fallback only:", ...transcriptRows].join("\n") : "",
  ].filter(Boolean);

  const text = cleanText(sections.join("\n"), Math.max(240, Number(maxChars) || 900));
  if (!text) return null;
  return {
    at: new Date().toISOString(),
    transcriptRows: transcriptRows.length,
    contextRows: filteredRows.length,
    coachRows: coachRows.length,
    agentRows: agentRows.length,
    currentBriefRows: currentBriefRows.length,
    text,
  };
}

function attachRecentMemoryToDialog(dialog = {}, recentMemory = null) {
  if (!dialog || !recentMemory?.text) return dialog;
  const promptPayload = dialog.promptPayload || {};
  return {
    ...dialog,
    promptPayload: {
      ...promptPayload,
      user: [
        promptPayload.user || "",
        "",
        "Recent call memory for continuity only. Do not answer old lines; use this to avoid repetition and keep the next line grounded in the current prospect text above:",
        recentMemory.text,
      ].filter(Boolean).join("\n"),
    },
    recentMemory,
  };
}

function normalizeJudgeKeyRows(input = []) {
  const rows = Array.isArray(input) ? input : [];
  const seen = new Set();
  const normalized = [];
  for (const row of rows) {
    const key = cleanText(typeof row === "string" ? row : row?.key, 120);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      key,
      confidence: Number.isFinite(Number(row?.confidence)) ? Number(row.confidence) : undefined,
      reason: cleanText(row?.reason || row?.why || "", 240) || undefined,
      snippet: cleanText(row?.snippet || row?.phrase || row?.quote || "", 180) || undefined,
    });
  }
  return normalized;
}

function normalizeThoughtBufferItem(item = {}) {
  const text = cleanText(item.text || item.phraseText || "", 420);
  if (!text) return null;
  const matches = normalizeContextCandidates(item.matches || item.contextMatches || [], { limit: 8 });
  return {
    vadId: cleanText(item.vadId || item.id || "", 120),
    at: cleanText(item.at || "", 80),
    text,
    charCount: text.length,
    approvedKeys: Array.isArray(item.approvedKeys)
      ? item.approvedKeys.map((key) => cleanText(key, 120)).filter(Boolean).slice(0, 8)
      : matches.map((match) => match.key).filter(Boolean).slice(0, 8),
    matches,
    contextBrief: cleanText(item.contextBrief || item.memoryBrief?.whatHappened || "", 280),
  };
}

function getThoughtBufferItems(session = {}, {
  maxChars = DEFAULT_THOUGHT_BUFFER_MAX_CHARS,
  maxChunks = DEFAULT_THOUGHT_BUFFER_MAX_CHUNKS,
} = {}) {
  const items = Array.isArray(session.thoughtBuffer?.unresolved) ? session.thoughtBuffer.unresolved : [];
  const selected = [];
  let chars = 0;
  for (let index = items.length - 1; index >= 0 && selected.length < maxChunks; index -= 1) {
    const normalized = normalizeThoughtBufferItem(items[index]);
    if (!normalized) continue;
    if (selected.length && chars + normalized.charCount > maxChars) break;
    chars += normalized.charCount;
    selected.unshift(normalized);
  }
  return selected;
}

function contextToThoughtBufferItem(session = {}, context = {}, transcript = {}) {
  if (!session.thoughtBuffer) session.thoughtBuffer = createThoughtBufferState();
  const vadId = cleanText(
    context.thoughtVadId ||
      context.sourceTranscriptId ||
      transcript.id ||
      `vad-${String(session.thoughtBuffer.nextId || 1).padStart(4, "0")}`,
    120,
  );
  session.thoughtBuffer.nextId = Math.max(1, Number(session.thoughtBuffer.nextId || 1) + 1);
  const text = cleanText(context.phraseText || context.text || transcript.text || "", 900);
  const memoryBrief = normalizeMemoryBrief(context.memoryBrief || context.miniJudgement?.memoryBrief || {});
  const matches = normalizeContextCandidates(context.matches || [], { limit: 8 });
  return normalizeThoughtBufferItem({
    vadId,
    at: context.at || transcript.at || new Date().toISOString(),
    text,
    approvedKeys: context.miniJudgement?.selectedKeys || matches.map((match) => match.key),
    matches,
    contextBrief: memoryBrief?.whatHappened || context.miniJudgement?.transcriptMeaning || context.actionReason || "",
  });
}

function appendThoughtBufferItem(session, context = {}, transcript = {}, options = {}) {
  if (!session) return null;
  if (!session.thoughtBuffer) session.thoughtBuffer = createThoughtBufferState();
  const item = contextToThoughtBufferItem(session, context, transcript);
  if (!item) return null;
  session.thoughtBuffer.unresolved.push(item);
  const maxChars = Math.max(120, Number(options.maxChars || DEFAULT_THOUGHT_BUFFER_MAX_CHARS));
  const maxChunks = Math.max(1, Number(options.maxChunks || DEFAULT_THOUGHT_BUFFER_MAX_CHUNKS));
  session.thoughtBuffer.unresolved = getThoughtBufferItems(session, { maxChars, maxChunks });
  return item;
}

function clearThoughtBuffer(session, reason = "released") {
  if (!session) return [];
  if (!session.thoughtBuffer) session.thoughtBuffer = createThoughtBufferState();
  const cleared = session.thoughtBuffer.unresolved || [];
  session.thoughtBuffer.unresolved = [];
  session.thoughtBuffer.lastClearedAt = new Date().toISOString();
  session.thoughtBuffer.lastClearReason = cleanText(reason, 120);
  return cleared;
}

function buildThoughtBufferSnapshot(session = {}, context = {}, transcript = {}, options = {}) {
  const maxChars = Math.max(120, Number(options.maxChars || DEFAULT_THOUGHT_BUFFER_MAX_CHARS));
  const maxChunks = Math.max(1, Number(options.maxChunks || DEFAULT_THOUGHT_BUFFER_MAX_CHUNKS));
  const unresolved = getThoughtBufferItems(session, { maxChars, maxChunks });
  const current = contextToThoughtBufferItem(
    { ...session, thoughtBuffer: { ...(session.thoughtBuffer || {}), nextId: session.thoughtBuffer?.nextId || 1 } },
    context,
    transcript,
  );
  const totalChars = unresolved.reduce((sum, item) => sum + item.charCount, 0) + (current?.charCount || 0);
  return {
    unresolved,
    currentVad: current ? {
      vadId: current.vadId,
      text: current.text,
      charCount: current.charCount,
      approvedKeys: current.approvedKeys,
    } : null,
    maxChars,
    maxChunks,
    totalChars,
    forceReleaseByCap: totalChars >= maxChars,
  };
}

function mergeThoughtBufferIntoContext(session = {}, context = {}, transcript = {}, options = {}) {
  const maxChars = Math.max(120, Number(options.maxChars || DEFAULT_THOUGHT_BUFFER_MAX_CHARS));
  const maxChunks = Math.max(1, Number(options.maxChunks || DEFAULT_THOUGHT_BUFFER_MAX_CHUNKS));
  const prior = getThoughtBufferItems(session, { maxChars, maxChunks });
  const current = contextToThoughtBufferItem(session, context, transcript);
  const chunks = [...prior, current].filter(Boolean);
  if (chunks.length <= 1) {
    clearThoughtBuffer(session, options.reason || context.actionReason || "single_vad_release");
    return context;
  }
  const phraseText = cleanText(chunks.map((chunk) => chunk.text).join(" "), maxChars + 220);
  const matches = normalizeContextCandidates(chunks.flatMap((chunk) => chunk.matches || []), { limit: 10 });
  const thoughtVadIds = chunks.map((chunk) => chunk.vadId).filter(Boolean);
  const thoughtCharCount = chunks.reduce((sum, chunk) => sum + chunk.charCount, 0);
  const activeIssues = matches.slice(0, 8).map((match) => ({
    key: match.key,
    snippet: cleanText(match.miniSnippet || match.fragment || phraseText, 180),
    status: "new",
  }));
  const contextBrief = cleanText(
    context.memoryBrief?.whatHappened ||
      context.miniJudgement?.transcriptMeaning ||
      `Current read: ${phraseText}`,
    300,
  );
  clearThoughtBuffer(session, options.reason || context.actionReason || "released_for_coach");
  return {
    ...context,
    phraseText,
    text: phraseText,
    matches,
    primaryContextKey: matches[0]?.key || context.primaryContextKey || null,
    memoryBrief: {
      whatHappened: contextBrief,
      activeIssues,
      continueFrom: cleanText(
        context.memoryBrief?.continueFrom ||
          `Respond to these grouped VAD chunks as one thought, grounded in the current prospect text.`,
        280,
      ),
    },
    miniJudgement: {
      ...(context.miniJudgement || {}),
      selectedKeys: matches.map((match) => match.key),
      thoughtVadIds,
      thoughtCharCount,
      releaseReason: cleanText(options.reason || context.actionReason || "released_for_coach", 160),
    },
    thoughtVadIds,
    thoughtCharCount,
  };
}

function normalizeMemoryBrief(input = {}) {
  if (!input || typeof input !== "object") return null;
  const activeIssues = (Array.isArray(input.activeIssues) ? input.activeIssues : [])
    .slice(0, 8)
    .map((issue) => ({
      key: cleanText(issue?.key || "general", 120),
      snippet: cleanText(issue?.snippet || issue?.phrase || issue?.quote || "", 180),
      status: cleanText(issue?.status || "", 80),
    }))
    .filter((issue) => issue.key || issue.snippet);
  const brief = {
    whatHappened: cleanText(input.whatHappened || input.summary || "", 300),
    activeIssues,
    continueFrom: cleanText(input.continueFrom || input.nextStep || input.instruction || "", 280),
  };
  if (!brief.whatHappened && !brief.continueFrom && !brief.activeIssues.length) return null;
  return brief;
}

function normalizeSignatureText(value = "") {
  return cleanLower(value, 800)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1)
    .join(" ");
}

function buildComposeSignature(context = {}) {
  const keys = (Array.isArray(context.matches) ? context.matches : [])
    .map((match) => cleanText(match.key, 120))
    .filter(Boolean)
    .sort()
    .join("|");
  const phrase = normalizeSignatureText(context.phraseText || context.text || "");
  return {
    keys,
    phrase,
    hash: crypto
      .createHash("sha1")
      .update(`${keys}\n${phrase}`)
      .digest("hex"),
  };
}

function textSimilarity(left = "", right = "") {
  const leftWords = new Set(normalizeSignatureText(left).split(/\s+/).filter(Boolean));
  const rightWords = new Set(normalizeSignatureText(right).split(/\s+/).filter(Boolean));
  if (!leftWords.size && !rightWords.size) return 1;
  if (!leftWords.size || !rightWords.size) return 0;
  let intersection = 0;
  for (const word of leftWords) {
    if (rightWords.has(word)) intersection += 1;
  }
  const union = new Set([...leftWords, ...rightWords]).size;
  return union ? intersection / union : 0;
}

function candidateToSemanticMatch(candidate = {}, selectedRow = {}) {
  return {
    key: candidate.key,
    label: candidate.label,
    family: candidate.family,
    priority: Number(candidate.priority || 0),
    hits: Array.isArray(candidate.hits) ? candidate.hits : [],
    guidance: cleanText(candidate.guidance || candidate.summary || "", 300),
    miniConfidence: Number.isFinite(Number(selectedRow.confidence)) ? Number(selectedRow.confidence) : undefined,
    miniReason: cleanText(selectedRow.reason || "semantic judge selected this context", 240),
    miniSnippet: cleanText(selectedRow.snippet || "", 180),
  };
}

function refineContextWithSemanticJudgement(context = {}, judgement = {}, input = {}) {
  const candidates = normalizeContextCandidates(context.deterministicCandidates || [], { limit: 24 });
  const byKey = new Map(candidates.map((candidate) => [candidate.key, candidate]));
  const selectedRows = normalizeJudgeKeyRows(judgement.selectedKeys || judgement.approvedKeys || judgement.matches || []);
  const fallbackMemoryBrief = judgement.contextBrief
    ? {
      whatHappened: judgement.contextBrief,
      activeIssues: selectedRows.map((row) => ({
        key: row.key,
        snippet: row.snippet || judgement.contextBrief,
        status: "new",
      })),
      continueFrom: judgement.contextBrief,
    }
    : {};
  const memoryBrief = normalizeMemoryBrief(judgement.memoryBrief || judgement.callMemory || fallbackMemoryBrief);
  const selectedMatches = selectedRows
    .map((row) => {
      const candidate = byKey.get(row.key);
      return candidate ? candidateToSemanticMatch(candidate, row) : null;
    })
    .filter(Boolean);
  const explicitShouldCompose = judgement.shouldCompose;
  const shouldCompose = explicitShouldCompose === false
    ? false
    : explicitShouldCompose === true
      ? true
      : Boolean(context.shouldCompose);
  const matches = selectedMatches.length || explicitShouldCompose === true ? selectedMatches : (context.matches || []);
  const primary = matches[0] || null;
  const tactics = deriveConversationTactics({
    phraseText: context.phraseText || context.text || input.transcript?.text || "",
    matches,
    jurisdiction: context.jurisdiction || "ambiguous",
    maxTactics: 4,
  });
  const rejected = Array.isArray(judgement.rejected)
    ? judgement.rejected.map((row) => ({
      key: cleanText(row?.key || "", 120),
      reason: cleanText(row?.reason || "", 240),
    })).filter((row) => row.key)
    : [];

  return {
    ...context,
    matches,
    tactics,
    primaryContextKey: primary?.key || null,
    actionable: shouldCompose,
    shouldCompose,
    actionReason: cleanText(
      judgement.actionReason ||
        (shouldCompose ? "semantic_context_judge_selected" : "semantic_context_judge_hold"),
      160,
    ),
    miniJudgement: {
      modelRole: "semantic_context_judge",
      provider: cleanText(judgement.provider || "", 80) || null,
      model: cleanText(judgement.model || "", 120) || null,
      selectedKeys: matches.map((match) => match.key),
      selectedTactics: tactics.map((tactic) => tactic.key),
      rejected,
      candidateCount: candidates.length,
      transcriptMeaning: cleanText(
        judgement.contextBrief ||
        judgement.transcriptMeaning ||
          judgement.baseUnderstanding ||
          context.miniJudgement?.transcriptMeaning ||
          "",
        500,
      ),
      memoryBrief,
      confidence: Number.isFinite(Number(judgement.confidence)) ? Number(judgement.confidence) : undefined,
      completeThought: judgement.completeThought === undefined ? context.completeThought : Boolean(judgement.completeThought),
      elapsedMs: Number.isFinite(Number(input.elapsedMs)) ? Number(input.elapsedMs) : undefined,
      usage: judgement.usage || null,
    },
    memoryBrief,
  };
}

// The mini's veto is scoped to JUNK only. Completeness is Claude's call (the WAIT
// sentinel) — a small model gating composition on "incomplete thought" is the
// exact failure mode that was already moved out of the mini once. Strong junk
// (clearly non-conversation) holds with no expiry; weak junk (filler/greeting —
// which can also be a trailing-off human moment) holds but expires on silence.
const MINI_STRONG_JUNK_PATTERN = /(voicemail|voice\s*mail|screener|screening|ivr|automated|recording|robocall|music|beep|dial\s*tone|answering\s*(machine|service))/i;
const MINI_WEAK_JUNK_PATTERN = /(filler|greeting|noise|silence|junk|non.?coachable|no\s+(useful|sales|tax|human)\s+(context|content)|empty)/i;

function createLiveCoachBus({
  rootDir,
  logger,
  persistence = null,
  persistenceIntervalMs = 120_000,
  closeoutWorker = null,
  dialogComposer = null,
  semanticContextJudge = null,
  composeDedupWindowMs = 4000,
  composeRateLimitPerMinute = 3,
  composeDeltaThrottleMs = 100,
  asyncContextPipeline = false,
  thoughtBufferMaxChars = DEFAULT_THOUGHT_BUFFER_MAX_CHARS,
  thoughtBufferMaxChunks = DEFAULT_THOUGHT_BUFFER_MAX_CHUNKS,
  // "junk-only" (default): the mini may hold composition only for junk reasons;
  // any other refusal composes anyway and Claude's WAIT judges completeness.
  // "all": restore the mini's full veto (pre-override behavior).
  miniVetoScope = "junk-only",
  // A hold is "wait for more audio" — but more audio is not guaranteed. Expire
  // non-strong-junk holds after this silence window and force-compose the
  // buffered thought (flagged forcedBySilence). 0 disables.
  holdExpiryMs = 2500,
  // Coach-triggered voicemail drop (liveCoachVmTransferService): fire-and-forget
  // hook invoked on voicemail rejection. null disables (default); the trigger
  // itself enforces enable-flag + hard phone allowlist.
  vmTransferTrigger = null,
  // Rolling relevance digest (mini's dual-VAD role): continuously reads the
  // fast channel's caught packets against the last few completed turns and
  // recent coach lines — NOT to understand the present (Sonnet's job at turn
  // time) but to answer "is this relevant to what came before?". Maintains
  // session.rollingDigest; never gates anything. null disables.
  rollingDigest = null,
  // Mini wakes only after the prospect's first N semantic turns — before that
  // there's nothing to read and Sonnet runs the scripted OPENING prompt
  // (release → fire → stream, no memory needed).
  digestWarmupTurns = 3,
  // Quiet start: coach LINES stay invisible until the prospect's Nth turn —
  // the composer still RUNS from turn 1 (prompt caches warm, the first
  // comment builds) but its output settles silently. Lets the agent get into
  // the call before coaching appears. 0 (default) = show from the first
  // turn; production sets 3 via LIVE_COACH_VISIBLE_AFTER_TURNS in server.js.
  visibleAfterTurns = 0,
} = {}) {
  const runtimeRoot = path.join(rootDir || process.cwd(), "runtime", "ai-bus", "live-coach");
  ensureDir(runtimeRoot);
  // Cross-call (between-calls) coach memory: load the prospect's prior call summary at
  // session start and surface it in the digest for continuity. Default OFF -- flip when ready.
  const crossCallMemoryEnabled = /^(1|true|yes|on)$/i.test(String(process.env.LIVE_COACH_CROSS_CALL_MEMORY_ENABLED || "").trim());

  const sessions = new Map();
  const subscribers = new Map();
  const pendingPersistence = new Map();
  const activeDialogComposers = new Map();
  const pendingDialogCompositions = new Map();
  // Timers live OUTSIDE session objects (serialization/persistence must never
  // see a Timeout handle).
  const holdExpiryBySession = new Map();

  function clearHoldExpiry(sessionId) {
    const key = String(sessionId || "");
    const timer = holdExpiryBySession.get(key);
    if (timer) clearTimeout(timer);
    holdExpiryBySession.delete(key);
  }

  function armHoldExpiry(session, heldContext, transcript, thoughtOptions, meta = {}) {
    if (!session || !(Number(holdExpiryMs) > 0)) return;
    clearHoldExpiry(session.id);
    const armedAtTranscript = session.counters.transcript;
    const timer = setTimeout(() => {
      holdExpiryBySession.delete(String(session.id));
      try {
        releaseExpiredHold(session, heldContext, transcript, thoughtOptions, { ...meta, armedAtTranscript });
      } catch (error) {
        emit(session.id, "pipeline.error", { error: error.message, stage: "hold_expiry" });
      }
    }, Number(holdExpiryMs));
    if (typeof timer.unref === "function") timer.unref();
    holdExpiryBySession.set(String(session.id), timer);
  }

  function releaseExpiredHold(session, heldContext, transcript, thoughtOptions, meta = {}) {
    if (!session || TERMINAL_SESSION_STATUSES.includes(session.status)) return null;
    // Superseded: newer audio arrived after the hold; the live turn owns the
    // buffer now and the held chunk merges through the normal path.
    if (session.counters.transcript !== meta.armedAtTranscript) return null;
    // The held chunk was already appended to the unresolved buffer; remove it so
    // the merge below (which re-adds the current context) doesn't double it.
    const heldVadId = cleanText(meta.heldVadId || "", 120);
    if (heldVadId && Array.isArray(session.thoughtBuffer?.unresolved)) {
      session.thoughtBuffer.unresolved = session.thoughtBuffer.unresolved.filter((item) => item.vadId !== heldVadId);
    }
    let contextFrame = {
      ...heldContext,
      held: false,
      actionable: true,
      shouldCompose: true,
      actionReason: "hold_expired_silence",
      forcedBySilence: true,
      miniJudgement: {
        ...(heldContext.miniJudgement || {}),
        forcedBySilence: true,
        holdReason: cleanText(meta.holdReason || heldContext.actionReason || "", 200),
      },
    };
    contextFrame = mergeThoughtBufferIntoContext(session, contextFrame, transcript, {
      ...thoughtOptions,
      reason: "hold_expired_silence",
    });
    const context = {
      ...contextFrame,
      id: `ctx-${String(session.counters.context + 1).padStart(4, "0")}`,
      text: contextFrame.phraseText,
    };
    if (meta.commitPendingOnRelease && typeof session.pipeline?.commitPending === "function") {
      session.pipeline.commitPending("prospect", context.phraseText || transcript?.text || "");
    }
    session.counters.context += 1;
    session.latest.context = context;
    pushMemory(session, "contexts", context);
    writeJsonLine(path.join(session.dir, "ai", "context.ndjson"), context);
    emit(session.id, "pipeline.hold_released", {
      reason: "silence_expiry",
      holdReason: cleanText(meta.holdReason || "", 200) || null,
      expiredAfterMs: Number(holdExpiryMs),
    });
    emit(session.id, "context", { context });
    // Scribe pass: this force-composed thought is a completed turn too — keep
    // the facts ledger + cumulative summary current (same gate as the main
    // compose path).
    if ((session.prospectTurnCount || 0) >= Math.max(0, Number(digestWarmupTurns) || 0)) {
      scheduleRollingDigest(session);
    }
    const dialogFrame = createSonnetDialogDraft({ contextFrame, metadata: session.metadata });
    const composerActive = typeof dialogComposer === "function";
    const dialog = composerActive && dialogFrame?.status === "ready"
      ? {
        ...dialogFrame,
        id: `dlg-${String(session.counters.dialog + 1).padStart(4, "0")}`,
        at: new Date().toISOString(),
        status: "composing",
        say: "",
        fallbackSay: cleanText(dialogFrame?.say || "", 1000),
      }
      : {
        ...dialogFrame,
        id: `dlg-${String(session.counters.dialog + 1).padStart(4, "0")}`,
        at: new Date().toISOString(),
      };
    session.counters.dialog += 1;
    session.latest.dialog = dialog;
    if (dialog?.say) pushMemory(session, "coachingSuggestions", dialog);
    writeJsonLine(path.join(session.dir, "ai", "dialog.ndjson"), dialog);
    emit(session.id, "dialog", { dialog });
    requestDialogComposition(session, context, dialog);
    return context;
  }

  function abortActiveDialogComposer(sessionId, reason = "session-ended") {
    const key = String(sessionId || "");
    pendingDialogCompositions.delete(key);
    const active = activeDialogComposers.get(key);
    if (!active) return false;
    activeDialogComposers.delete(key);
    try {
      active.controller.abort();
    } catch {}
    logger?.info?.("live_coach.dialog_composer.abort", {
      sessionId: key,
      dialogId: active.dialogId || null,
      reason,
    });
    return true;
  }

  function serializeSessionForPersistence(session) {
    const row = serializeSession(session);
    if (!row) return null;
    return {
      id: row.id,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastEventAt: row.lastEventAt,
      metadata: row.metadata,
      binding: row.binding,
      counters: row.counters,
      latest: row.latest,
      memory: row.memory,
      factLedger: row.factLedger,
      callSummary: row.callSummary,
    };
  }

  function persistSession(session, reason = "event") {
    if (!session || !persistence || typeof persistence.saveSessionSnapshot !== "function") return;
    const snapshot = serializeSessionForPersistence(session);
    if (!snapshot) return;
    Promise.resolve()
      .then(() => persistence.saveSessionSnapshot(snapshot, { reason }))
      .catch((error) => {
        logger?.warn?.("live_coach.persistence.error", {
          sessionId: session.id,
          reason,
          error: error.message,
        });
      });
  }

  function requestPersist(session, reason = "event", input = {}) {
    if (!session || !persistence || typeof persistence.saveSessionSnapshot !== "function") return;
    const immediate = Boolean(input.immediate);
    if (immediate) {
      const existing = pendingPersistence.get(session.id);
      if (existing) {
        clearTimeout(existing);
        pendingPersistence.delete(session.id);
      }
      persistSession(session, reason);
      return;
    }
    if (pendingPersistence.has(session.id)) return;
    const delayMs = Math.max(10_000, Number(persistenceIntervalMs) || 120_000);
    const timer = setTimeout(() => {
      pendingPersistence.delete(session.id);
      const latestSession = sessions.get(session.id);
      if (latestSession) persistSession(latestSession, reason);
    }, delayMs);
    if (typeof timer.unref === "function") timer.unref();
    pendingPersistence.set(session.id, timer);
  }

  function enqueueCloseout(session, reason = "session-ended", extra = {}) {
    if (!session || !closeoutWorker || typeof closeoutWorker.enqueue !== "function") return null;
    if (session.closeout?.queuedAt) return session.closeout;
    const queuedAt = new Date().toISOString();
    session.closeout = {
      queuedAt,
      reason: cleanText(reason, 160),
    };
    try {
      const result = closeoutWorker.enqueue(serializeSession(session), {
        reason,
        ...extra,
      });
      session.closeout.result = result || null;
      logger?.info?.("live_coach.closeout.queued", {
        sessionId: session.id,
        reason,
        queued: Boolean(result?.queued),
        skipped: Boolean(result?.skipped),
      });
    } catch (error) {
      session.closeout.error = error.message;
      logger?.warn?.("live_coach.closeout.enqueue_error", {
        sessionId: session.id,
        reason,
        error: error.message,
      });
    }
    return session.closeout;
  }

  function emit(sessionId, type, payload = {}) {
    const session = sessions.get(sessionId);
    const event = {
      type,
      at: new Date().toISOString(),
      sessionId,
      ...payload,
    };
    if (session) {
      session.events.push(event);
      session.lastEventAt = event.at;
      if (session.events.length > 200) {
        session.events.splice(0, session.events.length - 200);
      }
      writeJsonLine(path.join(session.dir, "events.ndjson"), event);
      requestPersist(session, type, {
        immediate: TERMINAL_SESSION_STATUSES.includes(session.status) ||
          ["session.stop", "session.stale", "voicemail.reject"].includes(type),
      });
    }
    const sessionSubscribers = subscribers.get(sessionId);
    if (session && sessionSubscribers && sessionSubscribers.size > 0) {
      session.lastSubscriberEventAt = event.at;
    }
    for (const listener of sessionSubscribers || []) {
      try {
        listener(event);
      } catch (error) {
        logger?.warn?.("live_coach.listener.error", {
          sessionId,
          type,
          error: error.message,
        });
      }
    }
    logger?.info?.(`live_coach.${type}`, { sessionId, status: session?.status || null });
    return event;
  }

  function serializeSession(session) {
    if (!session) return null;
    return {
      id: session.id,
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      lastEventAt: session.lastEventAt,
      dir: session.dir,
      metadata: session.metadata,
      binding: session.binding || null,
      counters: session.counters,
      latest: session.latest,
      memory: session.memory,
      factLedger: session.factLedger || {},
      callSummary: session.callSummary || "",
      thoughtBuffer: session.thoughtBuffer || createThoughtBufferState(),
      closeout: session.closeout || null,
      events: session.events.slice(-50),
    };
  }

  function serializeSessionSummary(session) {
    if (!session) return null;
    return {
      id: session.id,
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      lastEventAt: session.lastEventAt,
      metadata: session.metadata,
      binding: session.binding
        ? {
          status: session.binding.status || null,
          active: Boolean(session.binding.active),
          reason: session.binding.reason || null,
        }
        : null,
      counters: session.counters,
      latest: session.latest,
      thoughtBuffer: session.thoughtBuffer || createThoughtBufferState(),
    };
  }

  function startSession(input = {}) {
    const id = cleanText(input.sessionId || "", 120) ||
      `coach-${timestampForFile()}-${crypto.randomBytes(4).toString("hex")}`;
    const dir = path.join(runtimeRoot, id);
    ensureDir(dir);
    ensureDir(path.join(dir, "raw"));
    ensureDir(path.join(dir, "ai"));

    const session = {
      id,
      dir,
      status: "starting",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastEventAt: null,
      metadata: normalizeMetadata(input),
      binding: input.binding || null,
      pipeline: null,
      streamWatcher: null,
      composeGuard: {
        lastSignature: null,
        lastPhrase: "",
        lastKeys: "",
        lastStartedAtMs: 0,
        startedAtMs: [],
      },
      counters: {
        input: 0,
        provisional: 0,
        transcript: 0,
        context: 0,
        dialog: 0,
        voicemailRejected: 0,
      },
      latest: {
        provisionalTranscript: null,
        transcript: null,
        context: null,
        dialog: null,
        streamStatus: null,
      },
      memory: createMemoryState(),
      thoughtBuffer: createThoughtBufferState(),
      events: [],
    };
    session.pipeline = createSanitizedLiveCoachPipeline({ metadata: session.metadata });
    session.streamWatcher = createLiveCoachStreamWatcher();
    sessions.set(id, session);
    if (crossCallMemoryEnabled && persistence && typeof persistence.loadPriorCallSummaries === "function") {
      const md = session.metadata || {};
      Promise.resolve(persistence.loadPriorCallSummaries({
        caseId: md.caseId,
        phone: md.phone || md.contactPhone,
        excludeSessionId: id,
        limit: 2,
      }))
        .then((priors) => {
          // Only attach if this session is still the live one (not stale/replaced).
          if (Array.isArray(priors) && priors.length && sessions.get(id) === session) {
            session.priorCallMemory = priors;
            emit(id, "memory.prior_calls", { count: priors.length });
          }
        })
        .catch(() => {});
    }
    fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify(session.metadata, null, 2));
    session.status = "listening";
    emit(id, "session.start", { metadata: session.metadata });
    return serializeSession(session);
  }

  function markSessionStale(session, reason = "stale", extra = {}) {
    if (!session || TERMINAL_SESSION_STATUSES.includes(session.status)) return serializeSession(session);
    abortActiveDialogComposer(session.id, reason);
    session.status = cleanText(extra.status || "stale", 40);
    session.updatedAt = new Date().toISOString();
    emit(session.id, "session.stale", {
      reason: cleanText(reason, 160),
      ...extra,
    });
    enqueueCloseout(session, reason, { terminalType: "stale" });
    return serializeSession(session);
  }

  function terminalAgeMs(session, now = Date.now()) {
    const terminalAt = Date.parse(session?.updatedAt || session?.lastEventAt || session?.createdAt) || 0;
    return terminalAt ? Math.max(0, now - terminalAt) : Number.POSITIVE_INFINITY;
  }

  function pruneSession(session, reason = "terminal-prune") {
    if (!session) return null;
    const sessionId = session.id;
    const subscriberCount = subscribers.get(sessionId)?.size || 0;
    emit(sessionId, "session.pruned", {
      reason: cleanText(reason, 120),
      status: session.status,
      subscriberCount,
    });
    enqueueCloseout(session, reason, { terminalType: "pruned", subscriberCount });
    abortActiveDialogComposer(sessionId, reason);
    pendingDialogCompositions.delete(sessionId);
    const pending = pendingPersistence.get(sessionId);
    if (pending) {
      clearTimeout(pending);
      pendingPersistence.delete(sessionId);
    }
    subscribers.delete(sessionId);
    sessions.delete(sessionId);
    return {
      id: sessionId,
      status: session.status,
      reason,
      subscriberCount,
      metadata: session.metadata,
    };
  }

  function ensureSession(input = {}) {
    const id = cleanText(input.sessionId || "", 120);
    if (!id || !sessions.has(id)) return startSession(input);

    const session = sessions.get(id);
    session.metadata = normalizeMetadata({
      ...session.metadata,
      ...input,
    });
    session.binding = input.binding || session.binding || null;
    session.updatedAt = new Date().toISOString();
    fs.writeFileSync(path.join(session.dir, "metadata.json"), JSON.stringify(session.metadata, null, 2));
    emit(id, "session.bind", {
      metadata: session.metadata,
      binding: session.binding,
    });
    return serializeSession(session);
  }

  function getSession(sessionId) {
    return serializeSession(sessions.get(String(sessionId || "")));
  }

  function listSessions() {
    return Array.from(sessions.values()).map(serializeSession);
  }

  function listSessionSummaries() {
    return Array.from(sessions.values()).map(serializeSessionSummary);
  }

  function getSummary() {
    const rows = listSessions();
    return {
      total: rows.length,
      listening: rows.filter((row) => row.status === "listening").length,
      rejected: rows.filter((row) => row.status === "voicemail_rejected").length,
      stopped: rows.filter((row) => row.status === "stopped").length,
      stale: rows.filter((row) => row.status === "stale").length,
    };
  }

  function validateInputForSession(session, input = {}) {
    const identity = extractInputIdentity(input);
    const expectedUii = firstClean([
      session.metadata?.uii,
      session.binding?.event?.uii,
      session.binding?.metadata?.uii,
    ], 160);
    const expectedQueueItemId = firstClean([
      session.metadata?.queueItemId,
      session.binding?.event?.queueItemId,
      session.binding?.metadata?.queueItemId,
    ], 160);

    if (identity.uii && expectedUii && identity.uii !== expectedUii) {
      return {
        ok: false,
        reason: "uii-mismatch",
        statusCode: 409,
        expected: { uii: expectedUii },
        actual: { uii: identity.uii },
      };
    }
    if (!identity.uii && identity.queueItemId && expectedQueueItemId && identity.queueItemId !== expectedQueueItemId) {
      return {
        ok: false,
        reason: "queue-item-mismatch",
        statusCode: 409,
        expected: { queueItemId: expectedQueueItemId },
        actual: { queueItemId: identity.queueItemId },
      };
    }
    if (!agentMatchesSession(session, identity)) {
      return {
        ok: false,
        reason: "agent-mismatch",
        statusCode: 409,
        expected: {
          agentExtension: session.metadata?.agentExtension || null,
          agentEmail: session.metadata?.agentEmail || null,
        },
        actual: {
          agentExtension: identity.agentExtension || null,
          agentEmail: identity.agentEmail || null,
        },
      };
    }
    return { ok: true, identity };
  }

  function retireReplacedSessions(binding = {}, input = {}) {
    const apply = input.apply !== false;
    const currentIdentityKeys = callIdentityKeysFromBinding(binding);
    const currentIdentity = currentIdentityKeys[0] || "";
    const currentHasUii = hasUiiIdentityKey(currentIdentityKeys);
    const currentAgentExtension = cleanText(binding.metadata?.agentExtension || binding.event?.extensionId || "", 80);
    const currentAgentEmail = cleanLower(binding.metadata?.agentEmail || binding.event?.agentEmail || "", 180);
    const sourceFilter = input.sourceFilter === undefined ? GRPC_SESSION_SOURCES : input.sourceFilter;
    const retired = [];

    if (!currentIdentityKeys.length || (!currentAgentExtension && !currentAgentEmail)) {
      return { ok: true, apply, retiredCount: 0, retired };
    }

    for (const session of sessions.values()) {
      if (TERMINAL_SESSION_STATUSES.includes(session.status)) continue;
      if (!shouldCleanupSession(session, sourceFilter)) continue;
      const metadata = session.metadata || {};
      const sameAgent =
        (currentAgentExtension && metadata.agentExtension === currentAgentExtension) ||
        (currentAgentEmail && cleanLower(metadata.agentEmail, 180) === currentAgentEmail);
      if (!sameAgent) continue;
      const sessionIdentityKeys = mergeIdentityKeys(
        callIdentityKeysFromMetadata(metadata),
        callIdentityKeysFromBinding(session.binding || {}),
      );
      const sessionIdentity = sessionIdentityKeys[0] || "";
      if (!sessionIdentity || identityKeysOverlap(sessionIdentityKeys, currentIdentityKeys)) continue;
      if (hasUiiIdentityKey(sessionIdentityKeys) && !currentHasUii) continue;

      const summary = serializeSession(session);
      retired.push({
        session: summary,
        reason: "agent-current-call-changed",
        currentIdentity,
        previousIdentity: sessionIdentity,
      });
      if (apply) {
        markSessionStale(session, "agent-current-call-changed", {
          currentIdentity,
          previousIdentity: sessionIdentity,
        });
      }
    }

    return {
      ok: true,
      apply,
      retiredCount: retired.length,
      retired,
    };
  }

  async function processContextAndDialog(session, pipelineResult, transcript, input = {}) {
    if (!session || TERMINAL_SESSION_STATUSES.includes(session.status)) {
      return { ...pipelineResult, transcript, context: null, dialog: null };
    }

    let contextFrame = pipelineResult.context;
    let dialogFrame = pipelineResult.dialog;
    const thoughtOptions = {
      maxChars: Math.max(120, Number(thoughtBufferMaxChars || DEFAULT_THOUGHT_BUFFER_MAX_CHARS)),
      maxChunks: Math.max(1, Number(thoughtBufferMaxChunks || DEFAULT_THOUGHT_BUFFER_MAX_CHUNKS)),
    };
    contextFrame = {
      ...contextFrame,
      thoughtBuffer: buildThoughtBufferSnapshot(session, contextFrame, transcript, thoughtOptions),
    };
    if (typeof semanticContextJudge === "function") {
      const started = Date.now();
      emit(session.id, "context.judge.start", {
        transcript,
        candidateCount: contextFrame.deterministicCandidateCount || contextFrame.deterministicCandidates?.length || 0,
        unresolvedCount: contextFrame.thoughtBuffer?.unresolved?.length || 0,
        thoughtChars: contextFrame.thoughtBuffer?.totalChars || 0,
        forceReleaseByCap: Boolean(contextFrame.thoughtBuffer?.forceReleaseByCap),
      });
      try {
        const judgement = await semanticContextJudge({
          session: serializeSession(session),
          transcript,
          context: contextFrame,
          deterministicCandidates: contextFrame.deterministicCandidates || [],
          watcherRelease: input.watcherRelease || null,
          metadata: session.metadata,
        });
        contextFrame = refineContextWithSemanticJudgement(contextFrame, judgement, {
          elapsedMs: Date.now() - started,
        });
        if (contextFrame.thoughtBuffer?.forceReleaseByCap && !contextFrame.shouldCompose) {
          contextFrame = {
            ...contextFrame,
            actionable: true,
            shouldCompose: true,
            actionReason: "thought_buffer_char_cap",
            miniJudgement: {
              ...(contextFrame.miniJudgement || {}),
              forcedByThoughtBufferCap: true,
            },
          };
        }
        // Reason-scoped veto: the mini may hold ONLY for junk. Any other refusal
        // is a completeness opinion, and completeness is Claude's call (WAIT).
        // holdClass drives the expiry policy below: strong junk never expires,
        // weak junk (filler/greeting — could be a trailing-off human) expires.
        let holdClass = null;
        if (!contextFrame.shouldCompose) {
          const vetoReason = cleanText(contextFrame.actionReason || "", 200);
          if (MINI_STRONG_JUNK_PATTERN.test(vetoReason)) {
            holdClass = "strong-junk";
          } else if (MINI_WEAK_JUNK_PATTERN.test(vetoReason)) {
            holdClass = "weak-junk";
          } else if (miniVetoScope !== "all") {
            contextFrame = {
              ...contextFrame,
              actionable: true,
              shouldCompose: true,
              actionReason: "mini_hold_overridden_non_junk",
              miniJudgement: {
                ...(contextFrame.miniJudgement || {}),
                holdOverridden: true,
                holdReason: vetoReason,
              },
            };
          }
        }
        emit(session.id, "context.judge.done", {
          selectedKeys: contextFrame.miniJudgement?.selectedKeys || [],
          shouldCompose: contextFrame.shouldCompose,
          actionReason: contextFrame.actionReason,
          elapsedMs: contextFrame.miniJudgement?.elapsedMs || null,
          model: contextFrame.miniJudgement?.model || null,
          unresolvedCount: contextFrame.thoughtBuffer?.unresolved?.length || 0,
          thoughtChars: contextFrame.thoughtBuffer?.totalChars || 0,
        });
        if (!contextFrame.shouldCompose) {
          const heldContext = {
            ...contextFrame,
            id: `ctx-${String(session.counters.context + 1).padStart(4, "0")}`,
            text: contextFrame.phraseText,
            held: true,
          };
          session.counters.context += 1;
          session.latest.context = heldContext;
          pushMemory(session, "contexts", heldContext);
          const buffered = appendThoughtBufferItem(session, heldContext, transcript, thoughtOptions);
          writeJsonLine(path.join(session.dir, "ai", "context.ndjson"), heldContext);
          emit(session.id, "context", { context: heldContext });
          emit(session.id, "thought.buffer", {
            action: "append",
            item: buffered,
            unresolvedCount: session.thoughtBuffer?.unresolved?.length || 0,
            maxChars: thoughtOptions.maxChars,
          });
          const hold = {
            reason: heldContext.actionReason,
            holdClass: holdClass || null,
            context: heldContext,
          };
          pushMemory(session, "holds", {
            at: new Date().toISOString(),
            action: "hold_semantic_context",
            transcript,
            hold,
          });
          emit(session.id, "pipeline.hold", {
            action: "hold_semantic_context",
            hold,
          });
          // A hold means "wait for more audio" — which is not guaranteed to come.
          // Everything except strong junk gets a silence expiry so a trailing-off
          // prospect ("I just... I don't know") still gets coached.
          if (holdClass !== "strong-junk") {
            armHoldExpiry(session, heldContext, transcript, thoughtOptions, {
              heldVadId: buffered?.vadId || "",
              holdReason: heldContext.actionReason,
              holdClass,
              commitPendingOnRelease: pipelineResult.action === "hold_for_more_context",
            });
          }
          return {
            ...pipelineResult,
            action: "hold_semantic_context",
            hold,
            transcript,
            context: heldContext,
            dialog: null,
          };
        }
        dialogFrame = createSonnetDialogDraft({ contextFrame, metadata: session.metadata });
      } catch (error) {
        contextFrame = {
          ...contextFrame,
          miniJudgement: {
            ...(contextFrame.miniJudgement || {}),
            semanticFallback: true,
            semanticError: cleanText(error.message, 240),
            elapsedMs: Date.now() - started,
          },
        };
        emit(session.id, "context.judge.error", {
          error: error.message,
          elapsedMs: contextFrame.miniJudgement.elapsedMs,
        });
        if (contextFrame.thoughtBuffer?.forceReleaseByCap && !contextFrame.shouldCompose) {
          contextFrame = {
            ...contextFrame,
            actionable: true,
            shouldCompose: true,
            actionReason: "thought_buffer_char_cap_after_judge_error",
            miniJudgement: {
              ...(contextFrame.miniJudgement || {}),
              forcedByThoughtBufferCap: true,
            },
          };
        }
        if (!contextFrame.shouldCompose) {
          const heldContext = {
            ...contextFrame,
            id: `ctx-${String(session.counters.context + 1).padStart(4, "0")}`,
            text: contextFrame.phraseText,
            held: true,
          };
          session.counters.context += 1;
          session.latest.context = heldContext;
          pushMemory(session, "contexts", heldContext);
          const buffered = appendThoughtBufferItem(session, heldContext, transcript, thoughtOptions);
          writeJsonLine(path.join(session.dir, "ai", "context.ndjson"), heldContext);
          emit(session.id, "context", { context: heldContext });
          emit(session.id, "thought.buffer", {
            action: "append",
            item: buffered,
            unresolvedCount: session.thoughtBuffer?.unresolved?.length || 0,
            maxChars: thoughtOptions.maxChars,
          });
          const hold = {
            reason: heldContext.actionReason || "semantic_context_judge_error_hold",
            context: heldContext,
          };
          pushMemory(session, "holds", {
            at: new Date().toISOString(),
            action: "hold_semantic_context_error",
            transcript,
            hold,
          });
          emit(session.id, "pipeline.hold", {
            action: "hold_semantic_context_error",
            hold,
          });
          armHoldExpiry(session, heldContext, transcript, thoughtOptions, {
            heldVadId: buffered?.vadId || "",
            holdReason: hold.reason,
            commitPendingOnRelease: pipelineResult.action === "hold_for_more_context",
          });
          return {
            ...pipelineResult,
            action: "hold_semantic_context_error",
            hold,
            transcript,
            context: heldContext,
            dialog: null,
          };
        }
      }
    }

    if (!session || TERMINAL_SESSION_STATUSES.includes(session.status)) {
      return { ...pipelineResult, transcript, context: null, dialog: null };
    }

    contextFrame = mergeThoughtBufferIntoContext(session, contextFrame, transcript, {
      ...thoughtOptions,
      reason: contextFrame.actionReason || "ready_to_coach",
    });
    // Call-phase: the prospect's first few turns are the OPENING — Sonnet runs
    // the scripted opening prompt with no memory (release → fire → stream).
    // After the warmup, the established prompt takes over and mini's digest
    // becomes the coach's memory.
    if (contextFrame.shouldCompose && cleanText(transcript?.role || "prospect", 40) === "prospect") {
      session.prospectTurnCount = (session.prospectTurnCount || 0) + 1;
      contextFrame = {
        ...contextFrame,
        prospectTurnCount: session.prospectTurnCount,
        callPhase: session.prospectTurnCount <= Math.max(0, Number(digestWarmupTurns) || 0)
          ? "opening"
          : "established",
        // Quiet start: compose runs (warms caches, builds the first comment)
        // but the line settles silently until the visibility turn.
        warmupSuppressed: session.prospectTurnCount < Math.max(0, Number(visibleAfterTurns) || 0),
      };
    }
    // A turn is composing: attach mini's immediate-past digest (Sonnet is the
    // present, the digest is everything between turns) and start a fresh
    // window — these packets are now part of a completed thought.
    contextFrame = attachRollingDigest(session, contextFrame);
    if (contextFrame.shouldCompose) {
      session.digestWindow = [];
      // Scribe pass on every completed turn: completed thoughts are the most
      // fact-dense rows, and fast packets alone can't be relied on to trigger
      // the cycle (the fast channel degrades to silent on STT heal). The mini
      // reads the fresh turn from memory.transcripts and updates the facts
      // ledger + cumulative summary. Same warmup gate as packet-driven runs.
      if ((session.prospectTurnCount || 0) >= Math.max(0, Number(digestWarmupTurns) || 0)) {
        scheduleRollingDigest(session);
      }
    }
    dialogFrame = createSonnetDialogDraft({ contextFrame, metadata: session.metadata });
    emit(session.id, "thought.buffer", {
      action: "release",
      thoughtVadIds: contextFrame.thoughtVadIds || [],
      thoughtCharCount: contextFrame.thoughtCharCount || cleanText(contextFrame.phraseText || "", 2000).length,
      reason: contextFrame.miniJudgement?.releaseReason || contextFrame.actionReason || "ready_to_coach",
      unresolvedCount: session.thoughtBuffer?.unresolved?.length || 0,
    });

    const context = {
      ...contextFrame,
      id: `ctx-${String(session.counters.context + 1).padStart(4, "0")}`,
      text: contextFrame.phraseText,
    };
    if (
      pipelineResult.action === "hold_for_more_context" &&
      context.shouldCompose &&
      typeof session.pipeline?.commitPending === "function"
    ) {
      session.pipeline.commitPending("prospect", context.phraseText || transcript?.text || "");
    }
    session.counters.context += 1;
    session.latest.context = context;
    pushMemory(session, "contexts", context);
    writeJsonLine(path.join(session.dir, "ai", "context.ndjson"), context);
    emit(session.id, "context", { context });

    // When Claude (the dialog composer) is active it is the turn decider: it reads the
    // text + memory, judges completeness, and either streams the line or holds (WAIT).
    // For a composable turn, DON'T pre-render the deterministic draft line -- it would
    // flicker on partial thoughts that Claude will WAIT on. Keep it as fallbackSay for
    // the composer-error/disabled paths only.
    const composerActive = typeof dialogComposer === "function";
    const dialog = composerActive && dialogFrame?.status === "ready"
      ? {
        ...dialogFrame,
        id: `dlg-${String(session.counters.dialog + 1).padStart(4, "0")}`,
        at: new Date().toISOString(),
        status: "composing",
        say: "",
        fallbackSay: cleanText(dialogFrame?.say || "", 1000),
      }
      : {
        ...dialogFrame,
        id: `dlg-${String(session.counters.dialog + 1).padStart(4, "0")}`,
        at: new Date().toISOString(),
      };
    session.counters.dialog += 1;
    session.latest.dialog = dialog;
    if (dialog?.say) pushMemory(session, "coachingSuggestions", dialog);
    writeJsonLine(path.join(session.dir, "ai", "dialog.ndjson"), dialog);
    emit(session.id, "dialog", { dialog });
    requestDialogComposition(session, context, dialog);

    return {
      ...pipelineResult,
      action: context.shouldCompose ? "compose_dialog" : pipelineResult.action,
      transcript,
      context,
      dialog,
    };
  }

  function startContextAndDialogPipeline(session, pipelineResult, transcript, input = {}) {
    setImmediate(() => {
      processContextAndDialog(session, pipelineResult, transcript, input).catch((error) => {
        emit(session.id, "pipeline.error", {
          error: error.message,
          transcript,
        });
      });
    });
  }

  async function processText(session, text, input = {}) {
    if (!session.pipeline) {
      session.pipeline = createSanitizedLiveCoachPipeline({ metadata: session.metadata });
    }

    const pipelineResult = session.pipeline.handleTranscript({
      ...input,
      id: `tr-${String(session.counters.transcript + 1).padStart(4, "0")}`,
      text,
      source: input.source || "input",
      candidateMatches: input.contextCandidates || input.candidateMatches || [],
    });
    const transcript = pipelineResult.transcript;
    if (!transcript?.text) return { ...pipelineResult, transcript: null, context: null, dialog: null };

    session.counters.transcript += 1;
    // Channel merge policy (dual-VAD):
    //   FAST prospect rows own the UI (ribbon/thread/latest) but stay OUT of
    //   call memory — the turn channel re-transcribes the same audio and its
    //   completed thoughts are the canonical record the composer reads.
    //   TURN prospect rows own memory but don't emit as transcript events —
    //   the thread already painted this speech from the fast channel.
    //   Agent rows and legacy single-channel rows behave as before.
    const transcriptChannel = cleanText(transcript.channel || "", 20);
    const isAgentRow = cleanText(transcript.role || "prospect", 40) === "agent";
    const isProspectFastRow = !isAgentRow && transcriptChannel === "fast";
    const isProspectTurnRow = !isAgentRow && transcriptChannel === "turn";
    if (!isAgentRow && !isProspectTurnRow) {
      session.latest.transcript = transcript;
      session.latest.provisionalTranscript = null;
    }
    if (!isProspectFastRow) pushMemory(session, "transcripts", transcript);
    // New compose-relevant prospect turn → fresh timing frame (fast packets
    // and agent rows never compose, so they never reset the clock).
    if (!isAgentRow && !isProspectFastRow) startTurnTimings(session, transcript);
    writeJsonLine(path.join(session.dir, "ai", "transcript.ndjson"), transcript);
    if (!isProspectTurnRow) emit(session.id, "transcript", { transcript });

    if (pipelineResult.action === "reject_voicemail") {
      abortActiveDialogComposer(session.id, "voicemail-rejected");
      session.status = "voicemail_rejected";
      session.counters.voicemailRejected += 1;
      session.updatedAt = new Date().toISOString();
      const dialog = pipelineResult.dialog;
      session.latest.dialog = dialog;
      if (dialog?.say) pushMemory(session, "coachingSuggestions", dialog);
      // Additive observability: surface any confidence/reason/decision the pipeline
      // exposes on the dialog or result. All optional — never required.
      const voicemailObservability = {};
      const vmConfidence = dialog?.confidence ?? pipelineResult.confidence;
      const vmReason = dialog?.reason ?? pipelineResult.reason ?? dialog?.guidance;
      const vmDecision = dialog?.decision ?? pipelineResult.decision ?? pipelineResult.action;
      const vmMatch = dialog?.match ?? pipelineResult.match ?? pipelineResult.voicemail?.match;
      if (vmConfidence !== undefined && vmConfidence !== null) voicemailObservability.confidence = vmConfidence;
      if (vmReason !== undefined && vmReason !== null) voicemailObservability.reason = vmReason;
      if (vmDecision !== undefined && vmDecision !== null) voicemailObservability.decision = vmDecision;
      if (vmMatch !== undefined && vmMatch !== null) voicemailObservability.match = vmMatch;
      emit(session.id, "voicemail.reject", { transcript, dialog, ...voicemailObservability });
      enqueueCloseout(session, "voicemail-rejected", { terminalType: "voicemail" });
      // Coach-triggered voicemail drop: the gate verdict is the trigger. The
      // trigger self-gates (enable flag + hard phone allowlist) and never throws.
      try {
        vmTransferTrigger?.maybeFire?.(serializeSession(session), {
          match: voicemailObservability.match || null,
          source: "pipeline-voicemail-gate",
        });
      } catch {}
      return { ...pipelineResult, transcript, context: null, dialog };
    }

    if (pipelineResult.action === "clear_context_system_prompt" || pipelineResult.action === "hold_call_screener") {
      abortActiveDialogComposer(session.id, pipelineResult.action === "hold_call_screener" ? "call-screener" : "system-context-clear");
      session.latest.provisionalTranscript = null;
      session.latest.context = null;
      session.latest.dialog = null;
      session.updatedAt = new Date().toISOString();
      pushMemory(session, "holds", {
        at: new Date().toISOString(),
        action: pipelineResult.action,
        transcript,
        hold: pipelineResult.hold || null,
      });
      emit(session.id, "context.clear", {
        action: pipelineResult.action,
        transcript,
        hold: pipelineResult.hold || null,
      });
      return { ...pipelineResult, transcript, context: null, dialog: null };
    }

    if (
      pipelineResult.action === "hold_for_more_context" &&
      pipelineResult.context &&
      typeof semanticContextJudge === "function"
    ) {
      if (asyncContextPipeline || input.asyncContextPipeline === true) {
        startContextAndDialogPipeline(session, pipelineResult, transcript, input);
        return {
          ...pipelineResult,
          action: "semantic_judge_pending",
          transcript,
          context: null,
          dialog: null,
          pendingPipeline: true,
        };
      }
      return processContextAndDialog(session, pipelineResult, transcript, input);
    }

    if (pipelineResult.action !== "compose_dialog") {
      // Fast-channel packets (and any other non-composing prospect context)
      // feed the rolling digest — mini reads them against the last turns and
      // keeps the immediate-past brief warm for the next turn compose.
      if (pipelineResult.context && cleanText(transcript?.role || "prospect", 40) === "prospect") {
        pushDigestPacket(session, pipelineResult.context, transcript);
      }
      // Fast-channel additive packets are EXPECTED several times per utterance:
      // recording each as a hold would flap the panel's stage chip and bury
      // real holds in memory. The digest packet above is their record.
      if (pipelineResult.context?.actionReason === "fast_channel_additive") {
        return pipelineResult;
      }
      pushMemory(session, "holds", {
        at: new Date().toISOString(),
        action: pipelineResult.action,
        transcript,
        hold: pipelineResult.hold || null,
      });
      emit(session.id, "pipeline.hold", {
        action: pipelineResult.action,
        hold: pipelineResult.hold || null,
      });
      return pipelineResult;
    }

    if (asyncContextPipeline || input.asyncContextPipeline === true) {
      startContextAndDialogPipeline(session, pipelineResult, transcript, input);
      return {
        ...pipelineResult,
        action: "compose_dialog_pending",
        transcript,
        context: null,
        dialog: null,
        pendingPipeline: true,
      };
    }

    return processContextAndDialog(session, pipelineResult, transcript, input);
  }

  // ── Rolling relevance digest (mini, dual-VAD role) ────────────────────────
  // Fast-channel packets accumulate in session.digestWindow; one digest runs at
  // a time, re-running while dirty so the brief always reflects the newest
  // packets. The result is attached to the NEXT turn compose as the
  // "immediate past" — Sonnet reads the present, this is everything between.
  function pushDigestPacket(session, context, transcript) {
    if (typeof rollingDigest !== "function" || !session) return;
    // Warmup: mini stays off until the prospect has completed a few turns —
    // it needs something to read before relevance is a meaningful question.
    if ((session.prospectTurnCount || 0) < Math.max(0, Number(digestWarmupTurns) || 0)) return;
    const phrase = cleanText(context?.phraseText || transcript?.text || "", 240);
    if (!phrase) return;
    const keys = (Array.isArray(context?.matches) ? context.matches : [])
      .slice(0, 6)
      .map((match) => ({
        key: cleanText(match.key, 120),
        snippet: cleanText(match.miniSnippet || match.hits?.[0] || phrase, 160),
      }))
      .filter((row) => row.key);
    if (!Array.isArray(session.digestWindow)) session.digestWindow = [];
    session.digestWindow.push({ at: new Date().toISOString(), phrase, keys });
    if (session.digestWindow.length > 8) session.digestWindow.splice(0, session.digestWindow.length - 8);
    scheduleRollingDigest(session);
  }

  function scheduleRollingDigest(session) {
    if (typeof rollingDigest !== "function" || !session) return;
    const state = session.digestState || (session.digestState = { running: false, dirty: false });
    state.dirty = true;
    if (state.running) return;
    state.running = true;
    const run = async () => {
      state.dirty = false;
      try {
        const memory = session.memory || {};
        const lastTurns = (Array.isArray(memory.transcripts) ? memory.transcripts : [])
          .slice(-3)
          .map((row) => ({ role: cleanText(row.role || "prospect", 20), text: cleanText(row.text, 280) }))
          .filter((row) => row.text);
        const coachLines = (Array.isArray(memory.coachingSuggestions) ? memory.coachingSuggestions : [])
          .slice(-2)
          .map((row) => cleanText(row.say, 200))
          .filter(Boolean);
        const result = await rollingDigest({
          session: serializeSession(session),
          lastTurns,
          coachLines,
          packets: (session.digestWindow || []).slice(-6),
          // Scribe inputs: the ledger so far (so the mini emits only NEW/CHANGED
          // facts) and the prior cumulative summary (so it revises, never restarts).
          knownFacts: Object.entries(session.factLedger || {}).map(([key, row]) => ({ key, value: row?.value || "" })),
          priorSummary: cleanText(session.callSummary || "", 480),
          metadata: session.metadata,
        });
        if (result && !TERMINAL_SESSION_STATUSES.includes(session.status)) {
          const relevantKeys = (Array.isArray(result.relevantKeys) ? result.relevantKeys : [])
            .slice(0, 5)
            .map((row) => ({
              key: cleanText(row.key, 120),
              snippet: cleanText(row.snippet, 160),
              why: cleanText(row.why || row.reason || "", 140),
            }))
            .filter((row) => row.key);
          session.rollingDigest = {
            at: new Date().toISOString(),
            relevantKeys,
            droppedKeys: (Array.isArray(result.droppedKeys) ? result.droppedKeys : []).slice(0, 8).map((key) => cleanText(key, 120)).filter(Boolean),
            brief: {
              whatHappened: cleanText(result.brief?.whatHappened || "", 160),
              continueFrom: cleanText(result.brief?.continueFrom || "", 120),
              activeIssues: relevantKeys.map((row) => ({ key: row.key, snippet: row.snippet, status: "relevant" })),
            },
            read: cleanText(result.read || "", 140),
          };
          // ── Facts ledger + cumulative summary (the call's durable memory) ──
          // Merge NEW/CHANGED facts by key (newest value wins); the ledger never
          // rolls off, so the whole conversation stays findable on long calls.
          const newFacts = (Array.isArray(result.facts) ? result.facts : [])
            .map((row) => ({ key: cleanText(row?.key, 60).toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, ""), value: cleanText(row?.value, 120) }))
            .filter((row) => row.key && row.value);
          if (newFacts.length) {
            if (!session.factLedger || typeof session.factLedger !== "object") session.factLedger = {};
            for (const fact of newFacts) {
              session.factLedger[fact.key] = { value: fact.value, at: new Date().toISOString() };
            }
            // Hard cap: oldest entries fall off only past 24 distinct keys.
            const keys = Object.keys(session.factLedger);
            if (keys.length > 24) {
              keys
                .sort((a, b) => String(session.factLedger[a].at).localeCompare(String(session.factLedger[b].at)))
                .slice(0, keys.length - 24)
                .forEach((key) => delete session.factLedger[key]);
            }
          }
          const summary = cleanText(result.callSummary || "", 480);
          if (summary) session.callSummary = summary;
          emit(session.id, "context.digest", {
            digest: session.rollingDigest,
            factLedger: session.factLedger || {},
            callSummary: session.callSummary || "",
          });
        }
      } catch (error) {
        logger?.warn?.("live_coach.rolling_digest.error", {
          sessionId: session.id,
          error: error.message,
        });
      }
      if (state.dirty && !TERMINAL_SESSION_STATUSES.includes(session.status)) return run();
      state.running = false;
      return null;
    };
    run().catch(() => {
      state.running = false;
    });
  }

  // Attach the digest's immediate-past brief to a composing turn context.
  // Additive only: the turn's own deterministic matches stay the approved
  // keys; the digest rides as memory (whatHappened/relevant snippets/read).
  function attachRollingDigest(session, contextFrame) {
    const digest = session?.rollingDigest;
    if (!digest || !contextFrame?.shouldCompose) return contextFrame;
    return {
      ...contextFrame,
      memoryBrief: contextFrame.memoryBrief && contextFrame.memoryBrief.whatHappened
        ? contextFrame.memoryBrief
        : digest.brief,
      miniJudgement: {
        ...(contextFrame.miniJudgement || {}),
        transcriptMeaning: contextFrame.miniJudgement?.transcriptMeaning || digest.read || digest.brief?.whatHappened || "",
        digestRelevantKeys: digest.relevantKeys.map((row) => row.key),
        digestAt: digest.at,
      },
    };
  }

  function requestDialogComposition(session, context, dialog) {
    if (!session || !context || !dialog || typeof dialogComposer !== "function") return;
    if (TERMINAL_SESSION_STATUSES.includes(session.status)) return;
    const recentMemory = buildRecentCallMemory(session, context);
    const baseDialog = { ...attachRecentMemoryToDialog(dialog, recentMemory) };
    const signature = buildComposeSignature(context);
    const now = Date.now();
    const guard = session.composeGuard || {
      lastSignature: null,
      lastPhrase: "",
      lastKeys: "",
      lastStartedAtMs: 0,
      startedAtMs: [],
    };
    session.composeGuard = guard;
    const dedupWindowMs = Math.max(0, Number(composeDedupWindowMs) || 0);
    const rateLimit = Math.max(0, Number(composeRateLimitPerMinute) || 0);
    const recentlyComposed = dedupWindowMs > 0 && guard.lastStartedAtMs && now - guard.lastStartedAtMs <= dedupWindowMs;
    const duplicate =
      recentlyComposed &&
      guard.lastKeys === signature.keys &&
      (
        guard.lastSignature === signature.hash ||
        textSimilarity(guard.lastPhrase, signature.phrase) >= 0.86
      );
    if (duplicate) {
      emit(session.id, "compose.deduped", {
        dialogId: baseDialog.id,
        selectedKeys: signature.keys ? signature.keys.split("|") : [],
        windowMs: dedupWindowMs,
      });
      logger?.info?.("live_coach.compose_guard.deduped", {
        sessionId: session.id,
        dialogId: baseDialog.id,
        selectedKeyCount: signature.keys ? signature.keys.split("|").filter(Boolean).length : 0,
        windowMs: dedupWindowMs,
      });
      const latest = sessions.get(session.id);
      if (latest?.latest?.dialog?.id === baseDialog.id) {
        latest.latest.dialog = {
          ...latest.latest.dialog,
          composerSkipped: "deduped",
          composerSkippedAt: new Date().toISOString(),
        };
        emit(latest.id, "dialog", { dialog: latest.latest.dialog });
      }
      return;
    }

    const active = activeDialogComposers.get(session.id);
    if (active) {
      pendingDialogCompositions.set(session.id, {
        context,
        dialog: baseDialog,
        queuedAt: new Date().toISOString(),
      });
      try {
        active.controller.abort();
      } catch {}
      emit(session.id, "compose.supersede", {
        activeDialogId: active.dialogId || null,
        queuedDialogId: baseDialog.id,
      });
      logger?.info?.("live_coach.compose_guard.supersede", {
        sessionId: session.id,
        activeDialogId: active.dialogId || null,
        queuedDialogId: baseDialog.id,
        selectedKeyCount: signature.keys ? signature.keys.split("|").filter(Boolean).length : 0,
      });
      return;
    }

    guard.startedAtMs = (guard.startedAtMs || []).filter((at) => now - at < 60_000);
    if (rateLimit > 0 && guard.startedAtMs.length >= rateLimit) {
      emit(session.id, "compose.rate_limited", {
        dialogId: baseDialog.id,
        rateLimitPerMinute: rateLimit,
        recentStarts: guard.startedAtMs.length,
      });
      logger?.warn?.("live_coach.compose_guard.rate_limited", {
        sessionId: session.id,
        dialogId: baseDialog.id,
        rateLimitPerMinute: rateLimit,
        recentStarts: guard.startedAtMs.length,
        selectedKeyCount: signature.keys ? signature.keys.split("|").filter(Boolean).length : 0,
      });
      const latest = sessions.get(session.id);
      if (latest?.latest?.dialog?.id === baseDialog.id) {
        latest.latest.dialog = {
          ...latest.latest.dialog,
          composerSkipped: "rate_limited",
          composerSkippedAt: new Date().toISOString(),
        };
        emit(latest.id, "dialog", { dialog: latest.latest.dialog });
      }
      return;
    }

    guard.lastSignature = signature.hash;
    guard.lastPhrase = signature.phrase;
    guard.lastKeys = signature.keys;
    guard.lastStartedAtMs = now;
    guard.startedAtMs.push(now);

    const controller = new AbortController();
    const deltaThrottleMs = Math.max(0, Number(composeDeltaThrottleMs) || 0);
    let lastDeltaEmitAtMs = 0;
    activeDialogComposers.set(session.id, {
      controller,
      dialogId: baseDialog.id,
      signature: signature.hash,
      startedAt: new Date().toISOString(),
    });
    emit(session.id, "compose.start", {
      dialogId: baseDialog.id,
      callPhase: context.callPhase || null,
      prospectTurnCount: context.prospectTurnCount || null,
      selectedKeys: signature.keys ? signature.keys.split("|") : [],
      recentMemory: recentMemory ? {
        transcriptRows: recentMemory.transcriptRows,
        contextRows: recentMemory.contextRows,
        coachRows: recentMemory.coachRows,
      } : null,
    });
    const isCurrent = () => {
      const latest = sessions.get(session.id);
      return Boolean(
        latest &&
        !TERMINAL_SESSION_STATUSES.includes(latest.status) &&
        latest.latest.dialog?.id === baseDialog.id &&
        !controller.signal.aborted,
      );
    };
    stampTurnTiming(session, "composeStartAt", {
      miniMs: context.miniJudgement?.elapsedMs ?? null,
      suppressed: Boolean(context.warmupSuppressed),
    });
    Promise.resolve()
      .then(() => dialogComposer({
        session: serializeSession(session),
        context,
        dialog: baseDialog,
        metadata: session.metadata,
        abortSignal: controller.signal,
        onDelta(delta, output) {
          if (!isCurrent()) {
            controller.abort();
            return;
          }
          {
            const timed = sessions.get(session.id);
            if (timed && !timed.latest?.turnTimings?.firstDeltaAt) stampTurnTiming(timed, "firstDeltaAt");
          }
          // Quiet start: no streaming text to the panel while suppressed.
          if (context.warmupSuppressed) return;
          const latest = sessions.get(session.id);
          const now = Date.now();
          latest.latest.dialog = {
            ...latest.latest.dialog,
            status: "streaming",
            say: cleanText(output, 1000),
            at: new Date().toISOString(),
            composer: "anthropic",
          };
          if (deltaThrottleMs > 0 && lastDeltaEmitAtMs && now - lastDeltaEmitAtMs < deltaThrottleMs) {
            return;
          }
          lastDeltaEmitAtMs = now;
          emit(latest.id, "dialog", { dialog: latest.latest.dialog });
        },
      }))
      .then((composed) => {
        if (!isCurrent()) return;
        const latest = sessions.get(session.id);
        // Only ever accept STRINGS here: composed is normally {say, ...} and a
        // WAIT carries say:"" — the old `composed?.say || composed` fell
        // through to the OBJECT on empty say, String()-ing it into a literal
        // "[object Object]" coach line on the agent's screen.
        const say = cleanText(
          typeof composed === "string" ? composed : composed?.say || "",
          1000,
        );
        if (!say) {
          // Claude held (WAIT) or returned nothing. isCurrent() above already filtered
          // aborts/supersedes, so an empty final here is a genuine hold: always settle the
          // line to a terminal "wait" so the panel clears the composing/streaming state
          // (never strands) and surfaces no coach line.
          //
          // RATE-LIMIT REFUND: a WAIT is a decision, not a coach line — with
          // Claude as the decider (judge off, everything forwards) WAITs must
          // not consume the per-minute compose budget or fragments would
          // starve the real lines that follow them.
          if (Array.isArray(guard.startedAtMs) && guard.startedAtMs.length) {
            const idx = guard.startedAtMs.lastIndexOf(guard.lastStartedAtMs);
            if (idx >= 0) guard.startedAtMs.splice(idx, 1);
            else guard.startedAtMs.pop();
          }
          latest.latest.dialog = {
            ...latest.latest.dialog,
            status: "wait",
            say: "",
            label: "Waiting for a complete thought",
            at: new Date().toISOString(),
            composer: cleanText(composed?.composer || "anthropic", 80),
          };
          stampTurnTiming(latest, "settledAt", { outcome: "wait" }, logger);
          emit(latest.id, "dialog", { dialog: latest.latest.dialog });
          return;
        }
        // Quiet start: the line composed (caches warm, latency real) but the
        // agent doesn't see coach lines until the visibility turn. Settle
        // silently, refund the rate budget, and DON'T put it in the
        // avoid-repeating memory — a line nobody saw is fair to say later.
        if (context.warmupSuppressed) {
          if (Array.isArray(guard.startedAtMs) && guard.startedAtMs.length) {
            const idx = guard.startedAtMs.lastIndexOf(guard.lastStartedAtMs);
            if (idx >= 0) guard.startedAtMs.splice(idx, 1);
            else guard.startedAtMs.pop();
          }
          latest.latest.dialog = {
            ...latest.latest.dialog,
            status: "wait",
            say: "",
            label: "Coach warming up",
            warmup: true,
            at: new Date().toISOString(),
            composer: cleanText(composed?.composer || "anthropic", 80),
          };
          writeJsonLine(path.join(latest.dir, "ai", "dialog.ndjson"), {
            ...latest.latest.dialog,
            suppressedSay: say,
          });
          stampTurnTiming(latest, "settledAt", { outcome: "suppressed" }, logger);
          emit(latest.id, "dialog", { dialog: latest.latest.dialog });
          return;
        }
        latest.latest.dialog = {
          ...latest.latest.dialog,
          status: "ready",
          say,
          at: new Date().toISOString(),
          composer: cleanText(composed?.composer || "anthropic", 80),
          model: cleanText(composed?.model || "", 120) || latest.latest.dialog.model || null,
        };
        stampTurnTiming(latest, "settledAt", { outcome: "ready" }, logger);
        pushMemory(latest, "coachingSuggestions", latest.latest.dialog);
        writeJsonLine(path.join(latest.dir, "ai", "dialog.ndjson"), latest.latest.dialog);
        emit(latest.id, "dialog", { dialog: latest.latest.dialog });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        if (!isCurrent()) return;
        const latest = sessions.get(session.id);
        // Self-heal: if we suppressed the deterministic draft to let Claude compose and
        // Claude then failed, fall back to that draft line so the agent still gets help.
        const fallbackSay = cleanText(latest.latest.dialog?.fallbackSay || "", 1000);
        latest.latest.dialog = {
          ...latest.latest.dialog,
          status: "ready",
          ...(fallbackSay && !cleanText(latest.latest.dialog?.say || "", 1000)
            ? { say: fallbackSay, composerFallback: true }
            : {}),
          composerError: error.message,
          at: new Date().toISOString(),
        };
        if (fallbackSay) pushMemory(latest, "coachingSuggestions", latest.latest.dialog);
        stampTurnTiming(latest, "settledAt", { outcome: "error" }, logger);
        emit(latest.id, "dialog.error", {
          dialog: latest.latest.dialog,
          error: error.message,
        });
      })
      .finally(() => {
        const active = activeDialogComposers.get(session.id);
        if (active?.dialogId === baseDialog.id) {
          activeDialogComposers.delete(session.id);
        }
        const pending = pendingDialogCompositions.get(session.id);
        if (pending) {
          pendingDialogCompositions.delete(session.id);
          const latest = sessions.get(session.id);
          if (
            latest &&
            !TERMINAL_SESSION_STATUSES.includes(latest.status) &&
            latest.latest.dialog?.id === pending.dialog.id
          ) {
            setImmediate(() => requestDialogComposition(latest, pending.context, pending.dialog));
          }
        }
      });
  }

  function appendProvisionalText(session, input = {}) {
    const text = cleanText(input.text || input.transcript || input.delta || "", 4000);
    const itemId = cleanText(input.itemId || input.item_id || "", 120) || null;
    const latestFinal = session.latest?.transcript || null;
    if (
      itemId &&
      latestFinal?.itemId &&
      latestFinal.itemId === itemId &&
      latestFinal.provisional !== true
    ) {
      emit(session.id, "transcript.provisional_ignored", {
        itemId,
        reason: "final-transcript-already-committed",
      });
      return {
        action: "provisional_ignored_after_final",
        provisionalTranscript: session.latest.provisionalTranscript,
      };
    }
    if (!text) {
      return {
        action: "provisional",
        provisionalTranscript: null,
      };
    }
    session.counters.provisional += 1;
    const provisionalTranscript = {
      id: cleanText(input.id || input.itemId || input.item_id || "", 120) ||
        `pv-${String(session.counters.provisional).padStart(4, "0")}`,
      itemId,
      at: new Date().toISOString(),
      role: cleanText(input.role || "prospect", 40),
      text,
      source: cleanText(input.source || "stt-delta", 80),
      model: cleanText(input.model || "", 120) || null,
      wordCount: text.split(/\s+/).filter(Boolean).length,
      provisional: true,
    };
    session.latest.provisionalTranscript = provisionalTranscript;
    session.updatedAt = provisionalTranscript.at;
    pushMemory(session, "provisionalTranscripts", provisionalTranscript);
    writeJsonLine(path.join(session.dir, "ai", "provisional-transcript.ndjson"), provisionalTranscript);
    emit(session.id, "transcript.provisional", { provisionalTranscript });
    return {
      action: "provisional",
      provisionalTranscript,
    };
  }

  function rejectSessionFromStreamingVoicemail(session, provisionalTranscript = null, watcherResult = {}) {
    abortActiveDialogComposer(session.id, "streaming-voicemail-rejected");
    session.status = "voicemail_rejected";
    session.counters.voicemailRejected += 1;
    session.updatedAt = new Date().toISOString();
    const systemMatch = watcherResult.systemMatch ||
      (Array.isArray(watcherResult.systemMatches)
        ? watcherResult.systemMatches.find((match) => match.type === "voicemail")
        : null) ||
      {};
    const transcript = provisionalTranscript?.text
      ? {
        ...provisionalTranscript,
        id: `tr-${String(session.counters.transcript + 1).padStart(4, "0")}`,
        provisional: false,
        source: cleanText(provisionalTranscript.source || "streaming-voicemail-gate", 80),
      }
      : null;
    if (transcript) {
      session.counters.transcript += 1;
      session.latest.transcript = transcript;
      pushMemory(session, "transcripts", transcript);
      writeJsonLine(path.join(session.dir, "ai", "transcript.ndjson"), transcript);
      emit(session.id, "transcript", { transcript });
    }
    session.latest.provisionalTranscript = null;
    const dialog = {
      status: "rejected",
      label: "Call rejected for voicemail match",
      say: "",
      guidance: systemMatch.match
        ? `Streaming deterministic voicemail phrase matched: ${systemMatch.match}`
        : "Streaming deterministic voicemail phrase matched.",
    };
    session.latest.dialog = dialog;
    emit(session.id, "voicemail.reject", {
      transcript,
      dialog,
      match: systemMatch.match || null,
      decision: "streaming_delta_voicemail_reject",
    });
    enqueueCloseout(session, "streaming-voicemail-rejected", { terminalType: "voicemail" });
    // Coach-triggered voicemail drop (streaming-delta path). Self-gated.
    try {
      vmTransferTrigger?.maybeFire?.(serializeSession(session), {
        match: systemMatch.match || null,
        source: "streaming-voicemail-gate",
      });
    } catch {}
    return {
      action: "reject_voicemail",
      transcript,
      context: null,
      dialog,
      watcher: watcherResult,
    };
  }

  async function appendInput(sessionId, input = {}) {
    const session = sessions.get(String(sessionId || ""));
    if (!session) return { ok: false, error: "Session not found" };
    if (TERMINAL_SESSION_STATUSES.includes(session.status)) {
      return { ok: false, error: `Session is ${session.status}`, session: serializeSession(session) };
    }

    const identityCheck = validateInputForSession(session, input);
    if (!identityCheck.ok) {
      markSessionStale(session, identityCheck.reason, {
        expected: identityCheck.expected,
        actual: identityCheck.actual,
      });
      emit(session.id, "input.rejected", identityCheck);
      return {
        ok: false,
        error: identityCheck.reason,
        statusCode: identityCheck.statusCode,
        session: serializeSession(session),
        details: identityCheck,
      };
    }

    const text = cleanText(input.text || input.transcript || "", 4000);
    const base64 = cleanText(input.bytesBase64 || input.audioBase64 || "", 24_000_000);
    session.counters.input += 1;
    session.updatedAt = new Date().toISOString();

    if (base64) {
      try {
        const rawName = `raw-${String(session.counters.input).padStart(4, "0")}.bin`;
        // Fire-and-forget so the hot emit/subscriber path is never blocked by disk IO.
        fs.promises
          .writeFile(path.join(session.dir, "raw", rawName), Buffer.from(base64, "base64"))
          .catch(() => {});
        emit(session.id, "raw.write", { filename: rawName });
      } catch (error) {
        emit(session.id, "raw.error", { error: error.message });
      }
    }

    const inputEventType = cleanText(input.eventType || input.type || "", 120).toLowerCase();
    const isProvisional =
      input.provisional === true ||
      input.final === false ||
      input.isFinal === false ||
      inputEventType === "delta" ||
      inputEventType.endsWith(".delta");
    if (isProvisional) {
      const result = appendProvisionalText(session, input);
      if (!session.streamWatcher) session.streamWatcher = createLiveCoachStreamWatcher();
      const watcherResult = session.streamWatcher.appendText({
        text,
        at: input.at,
        itemId: input.itemId || input.item_id || input.id,
      });
      emit(session.id, "watcher.collect", {
        action: watcherResult.action,
        candidates: watcherResult.candidates || [],
        systemMatches: watcherResult.systemMatches || [],
      });
      if (watcherResult.action === "reject_voicemail") {
        const rejected = rejectSessionFromStreamingVoicemail(
          session,
          result.provisionalTranscript,
          watcherResult,
        );
        return {
          ok: true,
          session: serializeSession(session),
          result: rejected,
        };
      }
      if (
        watcherResult.action === "clear_context_system_prompt" ||
        watcherResult.action === "hold_call_screener"
      ) {
        // Symmetric with the streaming voicemail hang-up: a hold/screener prompt detected in
        // the deltas erases coach context NOW (don't wait for VAD) and holds. The watcher has
        // already suppressed candidate matching for this turn, so nothing screener-side leaks.
        abortActiveDialogComposer(
          session.id,
          watcherResult.action === "hold_call_screener" ? "call-screener" : "system-context-clear",
        );
        session.latest.provisionalTranscript = null;
        session.latest.context = null;
        session.latest.dialog = null;
        session.updatedAt = new Date().toISOString();
        emit(session.id, "context.clear", {
          action: watcherResult.action,
          transcript: result.provisionalTranscript || null,
          systemMatches: watcherResult.systemMatches || [],
        });
        return {
          ok: true,
          session: serializeSession(session),
          result: { ...result, watcher: watcherResult, action: watcherResult.action },
        };
      }
      return {
        ok: true,
        session: serializeSession(session),
        result: {
          ...result,
          watcher: watcherResult,
        },
      };
    }

    if (!session.streamWatcher) session.streamWatcher = createLiveCoachStreamWatcher();
    const watcherAppend = session.streamWatcher.appendText({
      text,
      at: input.at,
      itemId: input.itemId || input.item_id || input.id,
    });
    emit(session.id, "watcher.collect", {
      action: watcherAppend.action,
      candidates: watcherAppend.candidates || [],
      systemMatches: watcherAppend.systemMatches || [],
    });
    const watcherRelease = session.streamWatcher.releaseForVad({ text });
    emit(session.id, "watcher.vad_release", {
      action: watcherRelease.action,
      phraseText: watcherRelease.phraseText,
      candidates: watcherRelease.candidates || [],
      systemMatches: watcherRelease.systemMatches || [],
    });

    const result = await processText(session, watcherRelease.phraseText || text, {
      ...input,
      contextCandidates: watcherRelease.candidates || [],
      watcherRelease,
    });
    return {
      ok: true,
      session: serializeSession(session),
      result: {
        ...result,
        watcher: watcherRelease,
      },
    };
  }

  function appendStreamStatus(sessionId, input = {}) {
    const session = sessions.get(String(sessionId || ""));
    if (!session) return { ok: false, error: "Session not found" };
    if (TERMINAL_SESSION_STATUSES.includes(session.status)) {
      return { ok: false, error: `Session is ${session.status}`, session: serializeSession(session) };
    }

    const identityCheck = validateInputForSession(session, input);
    if (!identityCheck.ok) {
      emit(session.id, "stream.status_rejected", identityCheck);
      return {
        ok: false,
        error: identityCheck.reason,
        statusCode: identityCheck.statusCode,
        session: serializeSession(session),
        details: identityCheck,
      };
    }

    const at = new Date().toISOString();
    const streamStatus = {
      at,
      role: cleanText(input.role || "prospect", 40),
      source: cleanText(input.source || "grpc-audio", 80),
      streamId: cleanText(input.streamId || "", 160),
      segmentId: cleanText(input.segmentId || "", 180),
      mediaCount: Math.max(0, Number(input.mediaCount || 0) || 0),
      rawBytes: Math.max(0, Number(input.rawBytes || 0) || 0),
      durationSec: Math.max(0, Number(input.durationSec || 0) || 0),
      activePct: Math.max(0, Math.min(100, Number(input.activePct || 0) || 0)),
      rms: Math.max(0, Number(input.rms || 0) || 0),
      maxAbs: Math.max(0, Number(input.maxAbs || 0) || 0),
      state: cleanText(input.state || "audio-receiving", 80),
      // Bridge binding visibility (bound / unbound / binding) so the dashboard
      // can show when a live stream is coaching without a matched CX call.
      bindState: cleanText(input.bindState || "", 40),
      bindReason: cleanText(input.bindReason || "", 120),
      pendingDroppedBytes: Math.max(0, Number(input.pendingDroppedBytes || 0) || 0),
    };
    session.latest.streamStatus = streamStatus;
    session.updatedAt = at;
    session.lastEventAt = at;
    emit(session.id, "stream.status", { streamStatus });
    return { ok: true, session: serializeSession(session), streamStatus };
  }

  // Pre-call strategy (Opus, from the agent's interview): rides session
  // metadata so the composer's prompt includes it on every turn. The panel
  // also receives it via the session.strategy event.
  function attachCallStrategy(sessionId, strategy) {
    const session = sessions.get(String(sessionId || ""));
    if (!session) return { ok: false, error: "Session not found" };
    const clean = cleanText(strategy, 2000);
    if (!clean) return { ok: false, error: "Empty strategy" };
    session.metadata = { ...session.metadata, callStrategy: clean };
    session.updatedAt = new Date().toISOString();
    emit(session.id, "session.strategy", { callStrategy: clean, session: serializeSession(session) });
    logger?.info?.("live_coach.session.strategy_attached", {
      sessionId: session.id,
      strategyChars: clean.length,
    });
    return { ok: true, session: serializeSession(session) };
  }

  // ── Agent-initiated ask (the "send an AI call" path) ───────────────────────
  // The agent pulls mid-call: pin a transcript line for a deeper read, ask a
  // direct question, expand a topic, or get objection examples. One in flight
  // per session; the answer streams to the panel as coach.answer events and
  // the finished ask lands in memory.asks (snapshot-rehydratable). Separate
  // budget from live composes on purpose — a pull never costs a push.
  function askCoach(sessionId, input = {}) {
    const session = sessions.get(String(sessionId || ""));
    if (!session) return { ok: false, error: "Session not found" };
    if (TERMINAL_SESSION_STATUSES.includes(session.status)) return { ok: false, error: "Session has ended" };
    if (typeof dialogComposer !== "function") return { ok: false, error: "Composer unavailable" };
    if (session.askInFlight) return { ok: false, error: "Ask already in flight", askId: session.askInFlight };
    const kind = cleanText(input.kind || "question", 20).toLowerCase();
    const question = cleanText(input.question || input.text || "", 600);
    const contextItems = (Array.isArray(input.contextItems) ? input.contextItems : [])
      .slice(0, 6)
      .map((item) => ({
        kind: cleanText(item?.kind || "context", 40),
        label: cleanText(item?.label || "", 140),
        lineText: cleanText(item?.lineText || item?.text || item?.value || "", 500),
      }))
      .filter((item) => item.label || item.lineText);
    const lineText = cleanText(
      input.lineText ||
      input.transcriptText ||
      contextItems.map((item, index) => `Context ${index + 1} (${item.kind}): ${item.lineText || item.label}`).join("\n"),
      1800,
    );
    if (!question && !lineText && !contextItems.length) return { ok: false, error: "Empty ask" };
    session.counters.ask = (Number(session.counters.ask) || 0) + 1;
    const id = `ask-${String(session.counters.ask).padStart(4, "0")}`;
    const ask = { id, kind, question, lineText, contextItems, status: "thinking", answer: "", at: new Date().toISOString() };
    session.askInFlight = id;
    emit(session.id, "coach.answer", { ask: { ...ask } });
    const recentMemory = buildRecentCallMemory(session, {}, { maxTranscriptRows: 16, maxChars: 2600 });
    const promptPayload = buildAskPrompt({
      kind,
      question,
      lineText,
      contextItems,
      metadata: session.metadata,
      recentMemoryText: recentMemory?.text || "",
      callStrategy: session.metadata?.callStrategy || "",
      // Chat continuity: follow-ups read against the prior exchanges.
      recentAsks: (session.memory?.asks || []).slice(-3),
    });
    const startedAtMs = Date.now();
    let lastDeltaEmitMs = 0;
    Promise.resolve()
      .then(() => dialogComposer({
        session: serializeSession(session),
        dialog: { id, promptPayload },
        metadata: session.metadata,
        onDelta(delta, output) {
          const latest = sessions.get(session.id);
          if (!latest || TERMINAL_SESSION_STATUSES.includes(latest.status)) return;
          // Throttle SSE chatter; the final emit below always lands whole.
          const now = Date.now();
          if (now - lastDeltaEmitMs < 150) return;
          lastDeltaEmitMs = now;
          emit(latest.id, "coach.answer", { ask: { ...ask, status: "streaming", answer: cleanText(output, 1600) } });
        },
      }))
      .then((composed) => {
        const answer = cleanText(typeof composed === "string" ? composed : composed?.say || "", 1600);
        const finished = {
          ...ask,
          status: answer ? "ready" : "empty",
          answer,
          model: cleanText(composed?.model || "", 120) || undefined,
          elapsedMs: Date.now() - startedAtMs,
        };
        const latest = sessions.get(session.id);
        if (latest) {
          latest.askInFlight = null;
          pushMemory(latest, "asks", finished);
          writeJsonLine(path.join(latest.dir, "ai", "asks.ndjson"), finished);
          emit(latest.id, "coach.answer", { ask: finished });
        }
        return null;
      })
      .catch((error) => {
        const latest = sessions.get(session.id);
        if (latest) {
          latest.askInFlight = null;
          emit(latest.id, "coach.answer", { ask: { ...ask, status: "error", error: cleanText(error.message, 200) } });
        }
        logger?.warn?.("live_coach.ask.error", {
          sessionId: session.id,
          askId: id,
          error: error.message,
        });
      });
    logger?.info?.("live_coach.ask.start", { sessionId: session.id, askId: id, kind });
    return { ok: true, askId: id };
  }

  function stopSession(sessionId, input = {}) {
    const session = sessions.get(String(sessionId || ""));
    if (!session) return { ok: false, error: "Session not found" };
    clearHoldExpiry(session.id);
    abortActiveDialogComposer(session.id, cleanText(input.reason || "manual", 120));
    session.status = cleanText(input.status || "stopped", 40);
    session.updatedAt = new Date().toISOString();
    emit(session.id, "session.stop", { reason: cleanText(input.reason || "manual", 120) });
    enqueueCloseout(session, cleanText(input.reason || "manual", 120), { terminalType: "stopped" });
    return { ok: true, session: serializeSession(session) };
  }

  async function runFixture(input = {}) {
    const session = startSession({
      source: "fixture",
      agentEmail: input.agentEmail || "fixture@local",
      agentName: input.agentName || "Agent",
      firmName: input.firmName || "Wynn Tax Solutions",
      uii: input.uii || `fixture-${timestampForFile()}`,
    });
    const text = cleanText(input.text || input.transcript || input.prospect || "", 4000);
    const result = await appendInput(session.id, {
      text,
      role: input.role || "prospect",
      source: "fixture",
    });
    return result;
  }

  async function runProvisionalFixture(input = {}) {
    let session = sessions.get(cleanText(input.sessionId || "", 120));
    if (!session) {
      const started = startSession({
        source: "fixture-provisional",
        agentEmail: input.agentEmail || "fixture@local",
        agentName: input.agentName || "Agent",
        firmName: input.firmName || "Wynn Tax Solutions",
        uii: input.uii || `fixture-provisional-${timestampForFile()}`,
      });
      session = sessions.get(started.id);
    }
    const text = cleanText(
      input.text ||
        input.transcript ||
        input.prospect ||
        "I got a CP504 from the IRS and I'm scared they'll levy my paycheck.",
      4000,
    );
    const itemId = cleanText(input.itemId || `fixture-item-${crypto.randomBytes(3).toString("hex")}`, 120);
    const chunks = buildProvisionalChunks(text, input);
    const delayMs = Math.max(0, Math.min(2000, Number(input.delayMs ?? 350) || 0));
    let provisionalCount = 0;

    for (const chunk of chunks) {
      await appendInput(session.id, {
        text: chunk,
        role: input.role || "prospect",
        source: "fixture-delta",
        type: "conversation.item.input_audio_transcription.delta",
        final: false,
        itemId,
      });
      provisionalCount += 1;
      if (delayMs) await sleep(delayMs);
    }

    const finalResult = await appendInput(session.id, {
      text,
      role: input.role || "prospect",
      source: "fixture-final",
      final: true,
      itemId,
    });
    return {
      ...finalResult,
      provisionalCount,
      session: getSession(session.id),
    };
  }

  async function replaySession(input = {}) {
    const session = sessions.get(String(input.sessionId || ""));
    if (!session) return { ok: false, error: "Session not found" };
    const transcripts = readJsonLines(path.join(session.dir, "ai", "transcript.ndjson"));
    const replay = startSession({
      ...session.metadata,
      source: "replay",
      uii: `${session.metadata.uii || session.id}:replay`,
    });
    for (const transcript of transcripts) {
      await appendInput(replay.id, {
        text: transcript.text,
        role: transcript.role,
        source: "replay",
      });
    }
    return { ok: true, sourceSession: serializeSession(session), replaySession: getSession(replay.id) };
  }

  function cleanupStale(input = {}) {
    const maxIdleMs = Math.max(1000, Number(input.maxIdleMs || 15 * 60 * 1000));
    const apply = Boolean(input.apply);
    const now = Date.now();
    const stale = [];
    for (const session of sessions.values()) {
      if (TERMINAL_SESSION_STATUSES.includes(session.status)) continue;
      const last = Date.parse(session.lastEventAt || session.updatedAt || session.createdAt) || 0;
      if (now - last >= maxIdleMs) {
        stale.push(serializeSession(session));
        if (apply) {
          markSessionStale(session, "idle-timeout", { maxIdleMs });
        }
      }
    }
    return { ok: true, apply, maxIdleMs, staleCount: stale.length, stale };
  }

  function pruneTerminalSessions(input = {}) {
    const apply = Boolean(input.apply);
    // FORCE: the admin "clear all terminal NOW" path. Ignores the age floor,
    // the keep-cap, and the source filter — identity-less/odd-source stopped
    // sessions go too. Without force, explicit 0s fall back to defaults (the
    // 15s age floor guards against pruning a terminal row mid-handoff).
    const force = Boolean(input.force);
    const maxAgeMs = force
      ? 0
      : Math.max(15_000, Number(input.maxAgeMs || input.terminalMaxAgeMs || 2 * 60 * 1000) || 2 * 60 * 1000);
    const maxTerminalSessions = force ? 0 : Math.max(0, Number(input.maxTerminalSessions || 21) || 21);
    const sourceFilter = force ? null : (input.sourceFilter === undefined ? GRPC_SESSION_SOURCES : input.sourceFilter);
    const now = Date.now();
    const terminalRows = Array.from(sessions.values())
      .filter((session) => TERMINAL_SESSION_STATUSES.includes(session.status))
      .filter((session) => shouldCleanupSession(session, sourceFilter))
      .map((session) => ({
        session,
        ageMs: terminalAgeMs(session, now),
        terminalAtMs: Date.parse(session.updatedAt || session.lastEventAt || session.createdAt) || 0,
      }))
      .sort((left, right) => right.terminalAtMs - left.terminalAtMs);

    const keepIds = new Set();
    if (maxTerminalSessions > 0) {
      for (const row of terminalRows.slice(0, maxTerminalSessions)) {
        keepIds.add(row.session.id);
      }
    }

    const pruned = [];
    const kept = [];
    for (const row of terminalRows) {
      const overAge = row.ageMs >= maxAgeMs;
      const overCap = maxTerminalSessions > 0 && !keepIds.has(row.session.id);
      if (overAge || overCap) {
        const reason = overAge ? "terminal-age" : "terminal-cap";
        const summary = {
          id: row.session.id,
          status: row.session.status,
          ageMs: row.ageMs,
          reason,
          subscriberCount: subscribers.get(row.session.id)?.size || 0,
          metadata: row.session.metadata,
        };
        pruned.push(summary);
        if (apply) pruneSession(row.session, reason);
      } else {
        kept.push({
          id: row.session.id,
          status: row.session.status,
          ageMs: row.ageMs,
          subscriberCount: subscribers.get(row.session.id)?.size || 0,
        });
      }
    }

    return {
      ok: true,
      apply,
      force,
      maxAgeMs,
      maxTerminalSessions,
      terminalCount: terminalRows.length,
      prunedCount: pruned.length,
      keptCount: kept.length,
      pruned,
      kept,
    };
  }

  function pruneSessionsForCall(input = {}) {
    const apply = input.apply !== false;
    const uii = firstClean([input.uii, input.UII, input.rcxUii, input.callUii], 160);
    if (!uii) {
      return {
        ok: false,
        statusCode: 400,
        error: "uii is required",
      };
    }

    const identity = extractInputIdentity(input);
    const sourceFilter = input.sourceFilter === undefined ? GRPC_SESSION_SOURCES : input.sourceFilter;
    const reason = cleanText(input.reason || "call-ended", 120);
    const matched = [];
    const pruned = [];

    for (const session of sessions.values()) {
      if (!shouldCleanupSession(session, sourceFilter)) continue;
      const sessionUiiKeys = uniqueCleanIdentityKeys([
        session.metadata?.uii,
        session.binding?.event?.uii,
        session.binding?.metadata?.uii,
      ]);
      if (!sessionUiiKeys.includes(uii)) continue;
      if (!agentMatchesSession(session, identity)) continue;

      const summary = {
        id: session.id,
        status: session.status,
        subscriberCount: subscribers.get(session.id)?.size || 0,
        metadata: session.metadata,
      };
      matched.push(summary);
      if (apply) {
        pruned.push(pruneSession(session, reason));
      }
    }

    return {
      ok: true,
      apply,
      uii,
      reason,
      matchedCount: matched.length,
      prunedCount: pruned.length,
      matched,
      pruned,
    };
  }

  async function cleanupDeadStreams(input = {}) {
    const resolveBinding = input.resolveBinding;
    if (typeof resolveBinding !== "function") {
      return { ok: false, error: "resolveBinding function is required" };
    }

    const apply = Boolean(input.apply);
    const maxIdleMs = Math.max(1000, Number(input.maxIdleMs || 5 * 60 * 1000));
    const sourceFilter = input.sourceFilter === undefined ? GRPC_SESSION_SOURCES : input.sourceFilter;
    // Default TRUE: a session with live SSE subscribers (an admin watching the dashboard)
    // should not be swept out from under them.
    const preserveSubscribers =
      String(process.env.LIVE_COACH_STALE_SWEEP_PRESERVE_SUBSCRIBERS || "true").toLowerCase() !== "false";
    const now = Date.now();
    const checked = [];
    const stale = [];
    const kept = [];

    for (const session of sessions.values()) {
      if (TERMINAL_SESSION_STATUSES.includes(session.status)) continue;
      if (!shouldCleanupSession(session, sourceFilter)) continue;

      const last = Date.parse(session.lastEventAt || session.updatedAt || session.createdAt) || 0;
      const idleMs = now - last;
      const metadata = session.metadata || {};
      const sessionIdentityKeys = mergeIdentityKeys(
        callIdentityKeysFromMetadata(metadata),
        callIdentityKeysFromBinding(session.binding || {}),
      );
      const sessionIdentity = sessionIdentityKeys[0] || "";
      const hasAgent = Boolean(metadata.agentExtension || metadata.agentEmail);
      const query = hasAgent
        ? {
          agentExtensionId: metadata.agentExtension || null,
          agentEmail: metadata.agentEmail || null,
          lookbackMs: input.lookbackMs,
          lookbackSec: input.lookbackSec,
        }
        : {
          uii: metadata.uii || null,
          queueItemId: metadata.queueItemId || null,
          lookbackMs: input.lookbackMs,
          lookbackSec: input.lookbackSec,
        };
      const row = {
        session: serializeSession(session),
        sessionIdentity,
        idleMs,
        decision: "keep",
        reason: "current",
      };
      checked.push(row);

      if (idleMs >= maxIdleMs) {
        row.decision = "stale";
        row.reason = "idle-timeout";
      } else {
        const current = await resolveBinding(query);
        row.bindingStatus = current?.status || null;
        row.bindingReason = current?.binding?.reason || current?.reason || null;
        const currentIdentityKeys = callIdentityKeysFromBinding(current?.binding || {});
        const currentIdentity = currentIdentityKeys[0] || "";
        row.currentIdentity = currentIdentity || null;
        if (!current?.binding) {
          row.decision = "stale";
          row.reason = "no-current-binding";
        } else if (!current.binding.active) {
          row.decision = "stale";
          row.reason = current.binding.reason || current.status || "binding-inactive";
        } else if (
          sessionIdentityKeys.length &&
          currentIdentityKeys.length &&
          !(hasUiiIdentityKey(sessionIdentityKeys) && !hasUiiIdentityKey(currentIdentityKeys)) &&
          !identityKeysOverlap(sessionIdentityKeys, currentIdentityKeys)
        ) {
          row.decision = "stale";
          row.reason = "agent-current-call-changed";
        }
      }

      if (row.decision === "stale") {
        const activeSubscribers = subscribers.get(session.id);
        const shouldPreserveForSubscribers =
          preserveSubscribers &&
          activeSubscribers &&
          activeSubscribers.size > 0 &&
          !CALL_ENDING_STALE_REASONS.has(String(row.reason || ""));
        if (shouldPreserveForSubscribers) {
          logger?.info?.("live_coach.stale_sweep.preserved_for_subscribers", {
            sessionId: session.id,
            staleReason: row.reason,
            subscriberCount: activeSubscribers.size,
            idleMs,
          });
          row.staleReasonOverridden = row.reason;
          row.decision = "keep";
          row.reason = "active-subscribers";
          kept.push(row);
        } else {
          stale.push(row);
          if (apply) {
            markSessionStale(session, row.reason, {
              idleMs,
              sessionIdentity,
              currentIdentity: row.currentIdentity || null,
              bindingStatus: row.bindingStatus || null,
            });
          }
        }
      } else {
        kept.push(row);
      }
    }

    return {
      ok: true,
      apply,
      maxIdleMs,
      checkedCount: checked.length,
      staleCount: stale.length,
      keptCount: kept.length,
      checked,
      stale,
      kept,
    };
  }

  function subscribe(sessionId, listener) {
    const key = String(sessionId || "");
    if (!subscribers.has(key)) subscribers.set(key, new Set());
    subscribers.get(key).add(listener);
    const session = sessions.get(key);
    if (session) {
      listener({
        type: "snapshot",
        at: new Date().toISOString(),
        sessionId: key,
        session: serializeSession(session),
      });
    }
    return () => {
      const listeners = subscribers.get(key);
      if (!listeners) return;
      listeners.delete(listener);
      if (listeners.size === 0) subscribers.delete(key);
    };
  }

  return {
    startSession,
    ensureSession,
    retireReplacedSessions,
    appendInput,
    appendStreamStatus,
    attachCallStrategy,
    askCoach,
    stopSession,
    getSession,
    listSessions,
    listSessionSummaries,
    getSummary,
    getCloseoutStats: () => closeoutWorker?.getStats?.() || null,
    runFixture,
    runProvisionalFixture,
    replaySession,
    cleanupStale,
    cleanupDeadStreams,
    pruneTerminalSessions,
    pruneSessionsForCall,
    subscribe,
  };
}

module.exports = {
  CONTEXT_RULES,
  GRPC_SESSION_SOURCES,
  TERMINAL_SESSION_STATUSES,
  VOICEMAIL_MATCHES,
  createLiveCoachBus,
  extractInputIdentity,
};
