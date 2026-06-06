"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  CONTEXT_RULES,
  VOICEMAIL_MATCHES,
  createSonnetDialogDraft,
  createSanitizedLiveCoachPipeline,
  deriveConversationTactics,
  normalizeContextCandidates,
} = require("./liveCoachSanitizedPipeline");
const {
  createLiveCoachStreamWatcher,
} = require("./liveCoachStreamWatcherService");

const TERMINAL_SESSION_STATUSES = Object.freeze(["stopped", "stale", "voicemail_rejected"]);
const GRPC_SESSION_SOURCES = Object.freeze(["grpc", "grpc-mongo", "grpc-live-bridge", "mongo-cx"]);
const MEMORY_LIMITS = Object.freeze({
  provisionalTranscripts: 40,
  transcripts: 240,
  contexts: 140,
  coachingSuggestions: 140,
  holds: 120,
});

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
    firmName: cleanText(input.firmName || "Tax Advocate Group", 120),
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

function agentMatchesSession(session = {}, identity = {}) {
  const metadata = session.metadata || {};
  if (identity.agentExtension && metadata.agentExtension && identity.agentExtension !== metadata.agentExtension) {
    return false;
  }
  if (identity.agentEmail && metadata.agentEmail && identity.agentEmail !== cleanLower(metadata.agentEmail, 180)) {
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
  };
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
    });
  }
  return normalized;
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
  };
}

function refineContextWithSemanticJudgement(context = {}, judgement = {}, input = {}) {
  const candidates = normalizeContextCandidates(context.deterministicCandidates || [], { limit: 24 });
  const byKey = new Map(candidates.map((candidate) => [candidate.key, candidate]));
  const selectedRows = normalizeJudgeKeyRows(judgement.selectedKeys || judgement.matches || []);
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
        judgement.transcriptMeaning ||
          judgement.baseUnderstanding ||
          context.miniJudgement?.transcriptMeaning ||
          "",
        500,
      ),
      confidence: Number.isFinite(Number(judgement.confidence)) ? Number(judgement.confidence) : undefined,
      completeThought: judgement.completeThought === undefined ? context.completeThought : Boolean(judgement.completeThought),
      elapsedMs: Number.isFinite(Number(input.elapsedMs)) ? Number(input.elapsedMs) : undefined,
      usage: judgement.usage || null,
    },
  };
}

function createLiveCoachBus({
  rootDir,
  logger,
  persistence = null,
  persistenceIntervalMs = 120_000,
  dialogComposer = null,
  semanticContextJudge = null,
  composeDedupWindowMs = 4000,
  composeRateLimitPerMinute = 3,
  composeDeltaThrottleMs = 100,
  asyncContextPipeline = false,
} = {}) {
  const runtimeRoot = path.join(rootDir || process.cwd(), "runtime", "ai-bus", "live-coach");
  ensureDir(runtimeRoot);

  const sessions = new Map();
  const subscribers = new Map();
  const pendingPersistence = new Map();
  const activeDialogComposers = new Map();
  const pendingDialogCompositions = new Map();

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
    for (const listener of subscribers.get(sessionId) || []) {
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
      },
      memory: createMemoryState(),
      events: [],
    };
    session.pipeline = createSanitizedLiveCoachPipeline({ metadata: session.metadata });
    session.streamWatcher = createLiveCoachStreamWatcher();
    sessions.set(id, session);
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
    return serializeSession(session);
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
    const currentIdentity = callIdentityFromBinding(binding);
    const currentAgentExtension = cleanText(binding.metadata?.agentExtension || binding.event?.extensionId || "", 80);
    const currentAgentEmail = cleanLower(binding.metadata?.agentEmail || binding.event?.agentEmail || "", 180);
    const sourceFilter = input.sourceFilter === undefined ? GRPC_SESSION_SOURCES : input.sourceFilter;
    const retired = [];

    if (!currentIdentity || (!currentAgentExtension && !currentAgentEmail)) {
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
      const sessionIdentity = callIdentityFromMetadata(metadata) || callIdentityFromBinding(session.binding || {});
      if (!sessionIdentity || sessionIdentity === currentIdentity) continue;

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
    if (typeof semanticContextJudge === "function") {
      const started = Date.now();
      emit(session.id, "context.judge.start", {
        transcript,
        candidateCount: contextFrame.deterministicCandidateCount || contextFrame.deterministicCandidates?.length || 0,
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
        emit(session.id, "context.judge.done", {
          selectedKeys: contextFrame.miniJudgement?.selectedKeys || [],
          shouldCompose: contextFrame.shouldCompose,
          actionReason: contextFrame.actionReason,
          elapsedMs: contextFrame.miniJudgement?.elapsedMs || null,
          model: contextFrame.miniJudgement?.model || null,
        });
        if (!contextFrame.shouldCompose) {
          const hold = {
            reason: contextFrame.actionReason,
            context: contextFrame,
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
          return {
            ...pipelineResult,
            action: "hold_semantic_context",
            hold,
            transcript,
            context: contextFrame,
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
      }
    }

    if (!session || TERMINAL_SESSION_STATUSES.includes(session.status)) {
      return { ...pipelineResult, transcript, context: null, dialog: null };
    }

    const context = {
      ...contextFrame,
      id: `ctx-${String(session.counters.context + 1).padStart(4, "0")}`,
      text: contextFrame.phraseText,
    };
    session.counters.context += 1;
    session.latest.context = context;
    pushMemory(session, "contexts", context);
    writeJsonLine(path.join(session.dir, "ai", "context.ndjson"), context);
    emit(session.id, "context", { context });

    const dialog = {
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

    return { ...pipelineResult, transcript, context, dialog };
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
    session.latest.transcript = transcript;
    session.latest.provisionalTranscript = null;
    pushMemory(session, "transcripts", transcript);
    writeJsonLine(path.join(session.dir, "ai", "transcript.ndjson"), transcript);
    emit(session.id, "transcript", { transcript });

    if (pipelineResult.action === "reject_voicemail") {
      abortActiveDialogComposer(session.id, "voicemail-rejected");
      session.status = "voicemail_rejected";
      session.counters.voicemailRejected += 1;
      session.updatedAt = new Date().toISOString();
      const dialog = pipelineResult.dialog;
      session.latest.dialog = dialog;
      if (dialog?.say) pushMemory(session, "coachingSuggestions", dialog);
      emit(session.id, "voicemail.reject", { transcript, dialog });
      return { ...pipelineResult, transcript, context: null, dialog };
    }

    if (pipelineResult.action !== "compose_dialog") {
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

  function requestDialogComposition(session, context, dialog) {
    if (!session || !context || !dialog || typeof dialogComposer !== "function") return;
    if (TERMINAL_SESSION_STATUSES.includes(session.status)) return;
    const baseDialog = { ...dialog };
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
      return;
    }

    guard.startedAtMs = (guard.startedAtMs || []).filter((at) => now - at < 60_000);
    if (rateLimit > 0 && guard.startedAtMs.length >= rateLimit) {
      emit(session.id, "compose.rate_limited", {
        dialogId: baseDialog.id,
        rateLimitPerMinute: rateLimit,
        recentStarts: guard.startedAtMs.length,
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
      selectedKeys: signature.keys ? signature.keys.split("|") : [],
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
        const say = cleanText(composed?.say || composed || "", 1000);
        if (!say) return;
        latest.latest.dialog = {
          ...latest.latest.dialog,
          status: "ready",
          say,
          at: new Date().toISOString(),
          composer: cleanText(composed?.composer || "anthropic", 80),
          model: cleanText(composed?.model || "", 120) || latest.latest.dialog.model || null,
        };
        pushMemory(latest, "coachingSuggestions", latest.latest.dialog);
        writeJsonLine(path.join(latest.dir, "ai", "dialog.ndjson"), latest.latest.dialog);
        emit(latest.id, "dialog", { dialog: latest.latest.dialog });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        if (!isCurrent()) return;
        const latest = sessions.get(session.id);
        latest.latest.dialog = {
          ...latest.latest.dialog,
          status: "ready",
          composerError: error.message,
          at: new Date().toISOString(),
        };
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
      itemId: cleanText(input.itemId || input.item_id || "", 120) || null,
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
        fs.writeFileSync(path.join(session.dir, "raw", rawName), Buffer.from(base64, "base64"));
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

  function stopSession(sessionId, input = {}) {
    const session = sessions.get(String(sessionId || ""));
    if (!session) return { ok: false, error: "Session not found" };
    abortActiveDialogComposer(session.id, cleanText(input.reason || "manual", 120));
    session.status = cleanText(input.status || "stopped", 40);
    session.updatedAt = new Date().toISOString();
    emit(session.id, "session.stop", { reason: cleanText(input.reason || "manual", 120) });
    return { ok: true, session: serializeSession(session) };
  }

  async function runFixture(input = {}) {
    const session = startSession({
      source: "fixture",
      agentEmail: input.agentEmail || "fixture@local",
      agentName: input.agentName || "Agent",
      firmName: input.firmName || "Tax Advocate Group",
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
        firmName: input.firmName || "Tax Advocate Group",
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

  async function cleanupDeadStreams(input = {}) {
    const resolveBinding = input.resolveBinding;
    if (typeof resolveBinding !== "function") {
      return { ok: false, error: "resolveBinding function is required" };
    }

    const apply = Boolean(input.apply);
    const maxIdleMs = Math.max(1000, Number(input.maxIdleMs || 5 * 60 * 1000));
    const sourceFilter = input.sourceFilter === undefined ? GRPC_SESSION_SOURCES : input.sourceFilter;
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
      const sessionIdentity = callIdentityFromMetadata(metadata) || callIdentityFromBinding(session.binding || {});
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
        const currentIdentity = callIdentityFromBinding(current?.binding || {});
        row.currentIdentity = currentIdentity || null;
        if (!current?.binding) {
          row.decision = "stale";
          row.reason = "no-current-binding";
        } else if (!current.binding.active) {
          row.decision = "stale";
          row.reason = current.binding.reason || current.status || "binding-inactive";
        } else if (sessionIdentity && currentIdentity && sessionIdentity !== currentIdentity) {
          row.decision = "stale";
          row.reason = "agent-current-call-changed";
        }
      }

      if (row.decision === "stale") {
        stale.push(row);
        if (apply) {
          markSessionStale(session, row.reason, {
            idleMs,
            sessionIdentity,
            currentIdentity: row.currentIdentity || null,
            bindingStatus: row.bindingStatus || null,
          });
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
    stopSession,
    getSession,
    listSessions,
    listSessionSummaries,
    getSummary,
    runFixture,
    runProvisionalFixture,
    replaySession,
    cleanupStale,
    cleanupDeadStreams,
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
