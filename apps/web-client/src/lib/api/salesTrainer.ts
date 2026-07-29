import { API_BASE_URL, ApiError, TOKEN_STORAGE_KEY } from "@/lib/api/client";

export const SALES_TRAINER_TOKEN_KEY = "parallel_sales_trainer_token";
export const SALES_TRAINER_EXPIRES_KEY = "parallel_sales_trainer_expires_at";

export type TrainerRole = "user" | "assistant";

export interface TrainerMessage {
  role: TrainerRole;
  content: string;
}

export interface TrainerVoiceProfile {
  profileId?: string;
  model?: string;
  voice?: string;
  persona?: string;
  personality?: string;
  emotion?: string;
  pacing?: string;
  intensity?: string;
  extraInstructions?: string;
  responseFormat?: string;
  speed?: number;
  locked?: boolean;
}

export interface TrainerAudio {
  audioBase64: string;
  byteLength: number;
  mimeType: string;
  format: string;
  model: string;
  voice: string;
  speed: number;
  voiceProfile?: TrainerVoiceProfile;
  disclosure?: string;
  // Server-side parallel TTS: when present, the response is broken
  // into sentence-sized chunks rendered concurrently. The client plays
  // them in order. The top-level fields above mirror chunks[0] for
  // backwards compatibility.
  chunks?: TrainerAudio[];
}

export interface TrainerTranscript {
  text: string;
  language?: string | null;
  durationSec?: number | null;
  model?: string;
  byteLength?: number;
}

export interface TrainerConfig {
  configured: boolean;
  model: string;
  providers: {
    available: string[];
    default: string;
    openai: { configured: boolean; model: string };
    anthropic: { configured: boolean; model: string };
  };
  tts?: {
    configured: boolean;
    model: string;
    defaultVoice: string;
    defaultFormat: string;
    defaultSpeed: number;
    instructionsSupported: boolean;
    voices: string[];
    formats: string[];
    personas: string[];
    profileLocking: string;
    disclosure: string;
  };
  // Two-station trainer: when enabled the server-side observer publishes
  // the coach panel via ui-state; the client must not fire the legacy
  // per-turn /coach call on top of it.
  twoStation?: {
    enabled: boolean;
    dialogueModel?: string;
  };
  features?: {
    courseV1Enabled: boolean;
    gauntletV1Enabled: boolean;
    callReviewV1Enabled: boolean;
  };
  modes: string[];
}

export interface TrainerSessionBundle {
  sessionId: string;
  profile: Record<string, unknown>;
  // Sonnet-generated story map. Pinned for the session; passed back on
  // every /turn or /respond call so Haiku has the same script.
  playbook?: Record<string, unknown> | null;
  playbookError?: { message?: string; status?: number | null } | null;
  voice: TrainerVoiceProfile;
  mode?: string;
  scenarioArchetype?: string;
  openingLine: string;
  openingAudio?: TrainerAudio | null;
  openingAudioError?: { message?: string; status?: number | null } | null;
  models?: Record<string, string>;
  trainee?: string | null;
}

export interface TrainerResponse {
  text: string;
  model?: string;
  responseId?: string | null;
  usage?: unknown;
  provider?: string;
  audio?: TrainerAudio | ({ ok: false; error: string; code?: string });
}

export interface TrainerPlayback {
  autoplay: boolean;
  mimeType: string;
  format: string;
  voice?: string;
  audioBase64: string;
  dataUrl: string;
  chunks?: Array<{
    index: number;
    text: string;
    mimeType: string;
    format: string;
    audioBase64: string;
    dataUrl: string;
  }>;
}

export interface TrainerTurnResult {
  transcript: TrainerTranscript | null;
  sttError: { message: string; status?: number | null; details?: unknown } | null;
  response: TrainerResponse;
  audio: TrainerAudio | null;
  audioError: { message: string; status?: number | null } | null;
  playback: TrainerPlayback | null;
  recordings: unknown;
  messages: TrainerMessage[];
  elapsedMs: number;
}

export interface TrainerCoachPanel {
  phase: {
    key: string;
    label: string;
    reason: string;
  };
  confidence: number;
  oneSentenceFocus: string;
  tips: string[];
  suggestedMoves: string[];
  listenFor: string[];
  riskFlags: string[];
  nextBestQuestion: string;
  provider?: string;
  model?: string;
}

export interface TrainerUiState {
  sessionId: string;
  version: number;
  updatedAt: string;
  source: string;
  actor: string;
  coach: TrainerCoachPanel;
  suggestedDraft?: string;
  metadata?: Record<string, unknown> | null;
}

function readToken(): string | null {
  try {
    return (
      window.localStorage.getItem(SALES_TRAINER_TOKEN_KEY) ||
      window.localStorage.getItem(TOKEN_STORAGE_KEY)
    );
  } catch {
    return null;
  }
}

function storeTrainerToken(token: string, expiresAt?: string | null): void {
  try {
    window.localStorage.setItem(SALES_TRAINER_TOKEN_KEY, token);
    if (expiresAt) window.localStorage.setItem(SALES_TRAINER_EXPIRES_KEY, expiresAt);
  } catch {
    /* storage disabled */
  }
}

export function clearTrainerToken(): void {
  try {
    window.localStorage.removeItem(SALES_TRAINER_TOKEN_KEY);
    window.localStorage.removeItem(SALES_TRAINER_EXPIRES_KEY);
  } catch {
    /* storage disabled */
  }
}

async function trainerRequest<T>(
  path: string,
  {
    method = "GET",
    body,
    auth = true,
    signal,
  }: {
    method?: "GET" | "POST";
    body?: unknown;
    auth?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const isMultipart = typeof FormData !== "undefined" && body instanceof FormData;
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (body !== undefined && !isMultipart) headers["Content-Type"] = "application/json";
  if (auth) {
    const token = readToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  const requestBody =
    body === undefined ? undefined : isMultipart ? body : JSON.stringify(body);
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    body: requestBody as BodyInit | undefined,
    signal,
  });
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!response.ok) {
    const errorBody =
      payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
    throw new ApiError(
      String(errorBody.error || `Trainer request failed (${response.status})`),
      response.status,
      typeof errorBody.code === "string" ? errorBody.code : undefined,
      errorBody,
    );
  }
  return payload as T;
}

function unwrap<T>(payload: { ok: boolean; result: T }): T {
  return payload.result;
}

export interface TrainerDrillGrade {
  score: number;
  verdict: "nailed" | "close" | "partial" | "miss";
  strengths: string[];
  gaps: string[];
  coaching: string;
  suggestedLine: string | null;
  doctrineFlag: string | null;
  model: string | null;
}

export interface TrainerScoredCall {
  transcript: string;
  score: Record<string, unknown>;
}

export type TrainerCallReviewProvider = "ex" | "phoneburner" | "callrail";
export type TrainerCallReviewRecordingStatus =
  | "available"
  | "pending"
  | "unavailable";
export type TrainerCallReviewStatus =
  | "not_started"
  | "processing"
  | "completed"
  | "failed";

export interface TrainerCaseReviewCall {
  sourceId: string | null;
  provider: TrainerCallReviewProvider;
  startedAt: string;
  durationSec: number;
  direction: string;
  agentName: string | null;
  outcome: string | null;
  recordingStatus: TrainerCallReviewRecordingStatus;
  reviewStatus: TrainerCallReviewStatus;
  reviewId: string | null;
}

export interface TrainerCaseReviewLookup {
  caseSourceId: string;
  domain: string;
  caseNumber: string | number;
  authorizationCheckedAt: string;
  calls: TrainerCaseReviewCall[];
}

export interface TrainerCallReviewStart {
  reviewId: string;
  status: TrainerCallReviewStatus;
  generation: number;
}

export interface TrainerCallReviewSource {
  provider: TrainerCallReviewProvider;
  startedAt: string;
  durationSec: number;
  direction: string;
  agentName: string | null;
  outcome: string | null;
}

export interface TrainerCallReviewTranscriptSegment {
  segmentId: string;
  startMs: number;
  endMs: number;
  speaker: "agent" | "prospect" | "unknown";
  speakerConfidence: number | null;
  text: string;
}

export interface TrainerCallReviewCitation {
  segmentId: string;
  startMs: number;
  endMs: number;
  quote: string;
}

export interface TrainerCallReviewFinding {
  findingId: string;
  title: string;
  summary: string;
  confidence: number | null;
  citations: TrainerCallReviewCitation[];
}

export type TrainerCallReviewScriptStatus =
  | "observed"
  | "partial"
  | "missed"
  | "not_applicable"
  | "uncertain";

export interface TrainerCallReviewScriptFinding
  extends TrainerCallReviewFinding {
  sectionId: string | null;
  beatId: string | null;
  status: TrainerCallReviewScriptStatus;
}

export interface TrainerCallReviewResult {
  reviewId: string;
  status: TrainerCallReviewStatus;
  generation: number;
  versions: {
    scriptVersion: string | null;
    transcriptVersion: string | null;
    graderVersion: string | null;
  };
  source: TrainerCallReviewSource;
  transcript: {
    segments: TrainerCallReviewTranscriptSegment[];
  } | null;
  scriptFindings: TrainerCallReviewScriptFinding[];
  thingsToConsider: TrainerCallReviewFinding[];
  createdAt: string;
  completedAt: string | null;
  errorCode: string | null;
}

export const salesTrainerApi = {
  async checkAuth() {
    return trainerRequest<{ ok: true; user: Record<string, unknown> }>(
      "/api/sales-trainer/auth/check",
    );
  },
  async sendCode(email: string) {
    return trainerRequest<{
      ok: true;
      challengeId: string;
      email: string;
      expiresAt: string;
      previewCode?: string;
    }>("/api/sales-trainer/auth/send-code", {
      method: "POST",
      auth: false,
      body: { email },
    });
  },
  async verifyCode(email: string, code: string) {
    const payload = await trainerRequest<{
      ok: true;
      token: string;
      expiresAt: string;
      user: Record<string, unknown>;
    }>("/api/sales-trainer/auth/verify-code", {
      method: "POST",
      auth: false,
      body: { email, code },
    });
    storeTrainerToken(payload.token, payload.expiresAt);
    return payload;
  },
  async config() {
    return unwrap(
      await trainerRequest<{ ok: true; result: TrainerConfig }>("/api/sales-trainer/config"),
    );
  },
  async startSession(body: {
    leadSource?: string | null;
    difficulty?: string | null;
    mode?: string | null;
    scenarioArchetype?: string | null;
    situation?: string | null;
    demographicOverrides?: Record<string, unknown>;
    includeAudio?: boolean;
    audio?: Record<string, unknown>;
  }) {
    return unwrap(
      await trainerRequest<{ ok: true; result: TrainerSessionBundle }>(
        "/api/sales-trainer/session/start",
        { method: "POST", body },
      ),
    );
  },
  async respond(body: {
    messages: TrainerMessage[];
    scenario?: string;
    profile?: Record<string, unknown> | null;
    playbook?: Record<string, unknown> | null;
    provider?: string;
    includeAudio?: boolean;
    audio?: Record<string, unknown>;
  }) {
    return unwrap(
      await trainerRequest<{ ok: true; result: TrainerResponse }>(
        "/api/sales-trainer/respond",
        { method: "POST", body: { mode: "roleplay", ...body } },
      ),
    );
  },
  async transcribeAudio(body: {
    blob: Blob;
    filename?: string;
    language?: string | null;
    prompt?: string;
  }) {
    const form = new FormData();
    form.append("audio", body.blob, body.filename || "trainer-mic.webm");
    if (body.language) form.append("language", body.language);
    if (body.prompt) form.append("prompt", body.prompt);
    return unwrap(
      await trainerRequest<{ ok: true; result: TrainerTranscript }>(
        "/api/sales-trainer/transcribe",
        { method: "POST", body: form },
      ),
    );
  },
  async speech(body: {
    text: string;
    voice?: string;
    persona?: string;
    responseFormat?: string;
    speed?: number;
  }) {
    return unwrap(
      await trainerRequest<{ ok: true; result: TrainerAudio }>(
        "/api/sales-trainer/speech",
        { method: "POST", body },
      ),
    );
  },
  // One-shot turn: STT + Claude + TTS server-side, one round-trip.
  // Replaces the legacy two-step pattern of transcribeAudio() →
  // respond(), saving ~150-300ms of network overhead and keeping the
  // server-side prompt cache warm for back-to-back turns.
  async turn(body: {
    blob: Blob;
    filename?: string;
    sessionId?: string;
    turnNumber?: number;
    messages: TrainerMessage[];
    profile?: Record<string, unknown> | null;
    playbook?: Record<string, unknown> | null;
    scenario?: string;
    mode?: string;
    provider?: string;
    includeAudio?: boolean;
    audio?: Record<string, unknown>;
    sttPrompt?: string;
    sttLanguage?: string | null;
    recordTurn?: boolean;
    archiveToDrive?: boolean;
    // "slim" (default) loads the ~3k-token live-turn prompt for fast
    // in-character responses. "full" loads the full ~27k-token v2
    // simulator prompt for a single "break character" recovery turn
    // when the model has drifted off-spec.
    promptVariant?: "slim" | "full";
  }) {
    const form = new FormData();
    form.append("audio", body.blob, body.filename || "trainer-mic.webm");
    const payload: Record<string, unknown> = {
      mode: body.mode || "roleplay",
      messages: body.messages,
    };
    if (body.sessionId) payload.sessionId = body.sessionId;
    if (typeof body.turnNumber === "number") payload.turnNumber = body.turnNumber;
    if (body.profile !== undefined) payload.profile = body.profile;
    if (body.playbook !== undefined) payload.playbook = body.playbook;
    if (body.scenario) payload.scenario = body.scenario;
    if (body.provider) payload.provider = body.provider;
    if (body.includeAudio !== undefined) payload.includeAudio = body.includeAudio;
    if (body.audio) payload.audio = body.audio;
    if (body.sttPrompt) payload.sttPrompt = body.sttPrompt;
    if (body.sttLanguage) payload.sttLanguage = body.sttLanguage;
    if (body.recordTurn !== undefined) payload.recordTurn = body.recordTurn;
    if (body.archiveToDrive !== undefined) payload.archiveToDrive = body.archiveToDrive;
    if (body.promptVariant) payload.promptVariant = body.promptVariant;
    form.append("payload", JSON.stringify(payload));
    return unwrap(
      await trainerRequest<{ ok: true; result: TrainerTurnResult }>(
        "/api/sales-trainer/turn",
        { method: "POST", body: form },
      ),
    );
  },
  async coach(body: {
    messages: TrainerMessage[];
    scenario?: string;
    profile?: Record<string, unknown> | null;
    previousPhase?: string;
    provider?: string;
  }) {
    return unwrap(
      await trainerRequest<{ ok: true; result: TrainerCoachPanel }>(
        "/api/sales-trainer/coach",
        { method: "POST", body },
      ),
    );
  },
  // Training Center: model-graded drill answer (quiz over the field manual).
  async gradeDrill(body: {
    topic?: string;
    question: string;
    referenceAnswer?: string;
    answer: string;
  }) {
    return unwrap(
      await trainerRequest<{ ok: true; result: TrainerDrillGrade }>(
        "/api/sales-trainer/quiz/grade",
        { method: "POST", body },
      ),
    );
  },
  // Training Center: score one of my recorded calls on demand.
  async scoreCall(body: {
    driveFileId: string;
    domain?: string;
    phone?: string;
    direction?: string;
    durationSec?: number;
  }) {
    return unwrap(
      await trainerRequest<{ ok: true; result: TrainerScoredCall }>(
        "/api/sales-trainer/score-call",
        { method: "POST", body },
      ),
    );
  },
  async caseReviewCaseCalls(body: { domain: string; caseNumber: string }) {
    const result = unwrap(
      await trainerRequest<{ ok: true; result: Omit<TrainerCaseReviewLookup, "domain" | "caseNumber"> }>(
        "/api/sales-trainer/call-review/case-calls",
        { method: "POST", body },
      ),
    );
    return {
      ...result,
      domain: body.domain,
      caseNumber: body.caseNumber,
    };
  },
  async startCallReview(body: {
    caseSourceId: string;
    sourceId: string;
    requestId: string;
  }) {
    return unwrap(
      await trainerRequest<{ ok: true; result: TrainerCallReviewStart }>(
        "/api/sales-trainer/call-reviews",
        { method: "POST", body },
      ),
    );
  },
  async callReview(reviewId: string) {
    return unwrap(
      await trainerRequest<{ ok: true; result: TrainerCallReviewResult }>(
        `/api/sales-trainer/call-reviews/${encodeURIComponent(reviewId)}`,
      ),
    );
  },
  async uiState(sessionId: string, sinceVersion?: number) {
    const suffix =
      sinceVersion && Number.isFinite(sinceVersion)
        ? `?sinceVersion=${encodeURIComponent(String(sinceVersion))}`
        : "";
    return unwrap(
      await trainerRequest<{ ok: true; result: TrainerUiState | null }>(
        `/api/sales-trainer/session/${encodeURIComponent(sessionId)}/ui-state${suffix}`,
      ),
    );
  },
};

export function audioDataUrl(audio?: TrainerAudio | null): string {
  if (!audio?.audioBase64 || !audio.mimeType) return "";
  return `data:${audio.mimeType};base64,${audio.audioBase64}`;
}
