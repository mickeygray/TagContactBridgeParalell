import { API_BASE_URL, TOKEN_STORAGE_KEY } from "@/lib/api/client";

export type LiveCoachTranscript = {
  id?: string | null;
  itemId?: string | null;
  at?: string | null;
  role?: string | null;
  text?: string | null;
  source?: string | null;
  provider?: string | null;
  model?: string | null;
  wordCount?: number | null;
  provisional?: boolean | null;
  coachHeld?: boolean | null;
  awaitingCoach?: boolean | null;
};

export type LiveCoachContext = {
  id?: string | null;
  at?: string | null;
  phraseText?: string | null;
  text?: string | null;
  shouldCompose?: boolean | null;
  actionReason?: string | null;
  primaryContextKey?: string | null;
  jurisdiction?: string | null;
  completeThought?: boolean | null;
  matches?: Array<{ key?: string | null; label?: string | null; family?: string | null }>;
  deterministicCandidates?: Array<{ key?: string | null; label?: string | null; family?: string | null }>;
  miniJudgement?: {
    model?: string | null;
    provider?: string | null;
    selectedKeys?: string[] | null;
    selectedTactics?: string[] | null;
    rejected?: Array<{ key?: string | null; reason?: string | null }> | null;
    candidateCount?: number | null;
    elapsedMs?: number | null;
    transcriptMeaning?: string | null;
    confidence?: number | null;
  } | null;
};

export type LiveCoachDialog = {
  id?: string | null;
  at?: string | null;
  status?: string | null;
  label?: string | null;
  say?: string | null;
  guidance?: string | null;
  composer?: string | null;
  model?: string | null;
  composerSkipped?: string | null;
  composerError?: string | null;
};

export type LiveCoachStreamStatus = {
  at?: string | null;
  role?: string | null;
  source?: string | null;
  streamId?: string | null;
  segmentId?: string | null;
  mediaCount?: number | null;
  rawBytes?: number | null;
  durationSec?: number | null;
  activePct?: number | null;
  rms?: number | null;
  maxAbs?: number | null;
  state?: string | null;
};

export type LiveCoachSession = {
  id: string;
  status?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  lastEventAt?: string | null;
  metadata?: {
    source?: string | null;
    agentName?: string | null;
    agentEmail?: string | null;
    agentExtension?: string | null;
    uii?: string | null;
    queueItemId?: string | null;
    caseId?: string | null;
    phone?: string | null;
    domain?: string | null;
    streamId?: string | null;
  } | null;
  counters?: {
    input?: number | null;
    provisional?: number | null;
    transcript?: number | null;
    context?: number | null;
    dialog?: number | null;
    voicemailRejected?: number | null;
  } | null;
  latest?: {
    provisionalTranscript?: LiveCoachTranscript | null;
    transcript?: LiveCoachTranscript | null;
    context?: LiveCoachContext | null;
    dialog?: LiveCoachDialog | null;
    streamStatus?: LiveCoachStreamStatus | null;
  } | null;
};

export type LiveCoachEvent = {
  type?: string;
  at?: string;
  sessionId?: string;
  session?: LiveCoachSession;
  streamStatus?: LiveCoachStreamStatus;
  transcript?: LiveCoachTranscript;
  provisionalTranscript?: LiveCoachTranscript;
  context?: LiveCoachContext;
  dialog?: LiveCoachDialog;
  action?: string;
  hold?: { reason?: string | null; match?: string | null } | null;
  candidateCount?: number | null;
  selectedKeys?: string[] | null;
  shouldCompose?: boolean | null;
  actionReason?: string | null;
  elapsedMs?: number | null;
  model?: string | null;
  dialogId?: string | null;
  activeDialogId?: string | null;
  queuedDialogId?: string | null;
  windowMs?: number | null;
  rateLimitPerMinute?: number | null;
  error?: string | null;
};

export type LiveCoachCallEvent = {
  id?: string | null;
  eventType?: string | null;
  createdAt?: string | null;
  agentName?: string | null;
  agentEmail?: string | null;
  extensionId?: string | null;
  phone?: string | null;
  domain?: string | null;
  caseId?: string | null;
  queueItemId?: string | null;
  uii?: string | null;
};

type StreamHandlers = {
  signal?: AbortSignal;
  onOpen?: () => void;
  onEvent: (eventName: string, payload: LiveCoachEvent) => void;
  onError?: (error: Error) => void;
};

function readToken() {
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function parseSseBlock(block: string): { eventName: string; payload: LiveCoachEvent } | null {
  let eventName = "message";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim() || "message";
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }
  if (!dataLines.length) return null;
  const raw = dataLines.join("\n");
  try {
    return { eventName, payload: JSON.parse(raw) as LiveCoachEvent };
  } catch {
    return { eventName, payload: { type: eventName, error: raw } };
  }
}

export async function streamLiveCoachEvents(path: string, handlers: StreamHandlers) {
  const token = readToken();
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      headers,
      signal: handlers.signal,
    });
    if (!response.ok) {
      throw new Error(`Coach stream failed (${response.status})`);
    }
    if (!response.body) {
      throw new Error("Coach stream did not return a body");
    }
    handlers.onOpen?.();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseSseBlock(block);
        if (parsed) handlers.onEvent(parsed.eventName, parsed.payload);
        boundary = buffer.indexOf("\n\n");
      }
    }
  } catch (error) {
    if ((error as Error).name === "AbortError") return;
    const err = error instanceof Error ? error : new Error("Coach stream failed");
    handlers.onError?.(err);
    throw err;
  }
}

export type LiveCoachRetryConfig = {
  initialDelayMs?: number;
  maxDelayMs?: number;
  maxRetries?: number;
};

const DEFAULT_RETRY_CONFIG: Required<LiveCoachRetryConfig> = {
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  maxRetries: 12,
};

/**
 * Reconnecting wrapper around {@link streamLiveCoachEvents}. Re-establishes
 * the SSE stream with exponential backoff + jitter on transient failure.
 * Never retries on AbortError (intentional teardown). On the first retry it
 * surfaces a "Reconnecting..." message via handlers.onError so the UI can
 * show a soft (non-fatal) reconnecting state; the underlying error is only
 * treated as fatal once retries are exhausted.
 */
export async function streamLiveCoachEventsWithRetry(
  path: string,
  handlers: StreamHandlers,
  config: LiveCoachRetryConfig = {},
) {
  const { initialDelayMs, maxDelayMs, maxRetries } = { ...DEFAULT_RETRY_CONFIG, ...config };
  let attempt = 0;
  for (;;) {
    try {
      await streamLiveCoachEvents(path, { ...handlers, onError: undefined });
      return;
    } catch (error) {
      if ((error as Error)?.name === "AbortError" || handlers.signal?.aborted) return;
      if (attempt >= maxRetries) {
        const fatal = error instanceof Error ? error : new Error("Coach stream failed");
        handlers.onError?.(fatal);
        throw fatal;
      }
      attempt += 1;
      handlers.onError?.(new Error("Reconnecting..."));
      const base = Math.min(maxDelayMs, initialDelayMs * 2 ** (attempt - 1));
      const delay = base / 2 + Math.random() * (base / 2);
      const aborted = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          handlers.signal?.removeEventListener("abort", onAbort);
          resolve(false);
        }, delay);
        const onAbort = () => {
          clearTimeout(timer);
          resolve(true);
        };
        if (handlers.signal?.aborted) {
          clearTimeout(timer);
          resolve(true);
          return;
        }
        handlers.signal?.addEventListener("abort", onAbort, { once: true });
      });
      if (aborted) return;
    }
  }
}

export function isLiveCoachTerminal(status: string | null | undefined) {
  return ["stopped", "stale", "voicemail_rejected", "released"].includes(String(status || ""));
}

export function isLiveCoachRejected(session: LiveCoachSession | null | undefined) {
  return (
    String(session?.status || "") === "voicemail_rejected" ||
    String(session?.latest?.dialog?.status || "") === "rejected" ||
    Number(session?.counters?.voicemailRejected || 0) > 0
  );
}
