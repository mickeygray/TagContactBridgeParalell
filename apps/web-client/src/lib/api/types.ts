/**
 * Frontend-facing API response types.
 *
 * These mirror the shapes exposed by 5001 today. Keep them close to the
 * backend's contract but treat every optional field as potentially missing —
 * 5001 is still evolving.
 *
 * When backend route families land or change, update this file and lean on
 * TypeScript to find everything affected.
 */

export type OkEnvelope<T> = { ok: true; result: T };
export type ListEnvelope<T, K extends string = "result"> = { ok: true } & Record<K, T>;

export type DomainKey = string;

// ─── Auth ───────────────────────────────────────────────────────────────────

export type AuthRole = "admin" | "manager" | "internal-agent" | "widget-user" | "service";
export type AuthAudience = "admin" | "user";

export interface AuthUser {
  id: string;
  email: string;
  name?: string | null;
  role: AuthRole;
  audience?: AuthAudience;
  capabilities?: string[];
  permissions?: string[];
  views?: string[];
  workspace?: string | null;
  stationLabel?: string | null;
  company?: string | null;
  extensionId?: string | null;
  extensionNumber?: string | null;
  cxAgentId?: string | null;
  phone?: string | null;
  exShells?: ExShellRecord[];
  logicsUserId?: number | null;
  logicsDisplayName?: string | null;
  tagLogicsId?: number | null;
  tagSOId?: number | null;
  tagEmail?: string | null;
  tagLogicsName?: string | null;
  tagLogicsRoles?: string | null;
  wynnLogicsId?: number | null;
  wynnSOId?: number | null;
  wynnEmail?: string | null;
  wynnLogicsName?: string | null;
  wynnLogicsRoles?: string | null;
  logicsAuth?: AccountLogicsAuth | null;
  cxAuth?: CxAuthSummary | null;
}

export interface CxAuthSummary {
  oauthRequired?: boolean;
  isOAuthValidated: boolean;
  invalidReason?: string | null;
  rcUserEmail?: string | null;
  refreshTokenExpiresAt?: string | null;
  consentGrantedAt?: string | null;
}

export interface AccountLogicsAuth {
  credentialMode?: string | null;
  credentialStatus?: string | null;
  scopes?: string[];
  permissionsLabel?: string | null;
  externalSecretRef?: string | null;
}

export type CxQueueTier =
  | "no_leads"
  | "red_only"
  | "old_balanced"
  | "fresh_capped"
  | "fresh_priority";

export interface CxQueuePolicy {
  tier?: CxQueueTier | null;
  enabled?: boolean;
  fresh?: {
    eligible?: boolean | null;
    targetOpen?: number | null;
    hourlyCap?: number | null;
    priorityWeight?: number | null;
  };
  day2to15?: {
    targetOpen?: number | null;
  };
  aged?: {
    targetOpen?: number | null;
  };
  updatedAt?: string | null;
  updatedBy?: string | null;
}

export interface ExShellRecord {
  company?: string | null;
  email?: string | null;
  name?: string | null;
  extensionNumber?: string | null;
  loginPhones?: string[];
  primaryPhone?: string | null;
  rcExtensionId?: string | null;
  source?: string | null;
}

export interface SendCodeResponse {
  ok: true;
  challengeId: string;
  email: string;
  expiresAt: string;
  delivery: { channel: string; previewEnabled?: boolean };
  previewCode?: string;
}

export interface VerifyCodeResponse {
  ok: true;
  token: string;
  user: AuthUser;
}

export interface ConsentRecord {
  _id?: string;
  domain?: string;
  company?: string;
  source?: string;
  caseId?: number | null;
  email?: string | null;
  phone?: string | null;
  trustedFormCertUrl?: string | null;
  jornayaLeadId?: string | null;
  receivedAt?: string;
  ip?: string | null;
  userAgent?: string | null;
  intakeRoute?: string | null;
  intakeSource?: string | null;
}

export interface ConsentStats {
  total?: number;
  withTrustedForm?: number;
  withJornaya?: number;
}

// ─── Metrics ────────────────────────────────────────────────────────────────

export interface MetricsSnapshotSlice {
  _id?: string;
  leads?: number;
  calls?: number;
  spend?: number;
  revenue?: number;
  roas?: number;
  date?: string;
  [key: string]: unknown;
}

export interface MetricsWorkspace {
  domain: string;
  snapshots: {
    daily?: MetricsSnapshotSlice;
    lifetime?: MetricsSnapshotSlice;
    [key: string]: MetricsSnapshotSlice | undefined;
  };
  counts: {
    prospects?: number;
    caseProfiles?: number;
    payments?: number;
    openReviewItems?: number;
    [key: string]: number | undefined;
  };
  latestDeepCutRun?: {
    _id?: string;
    runId?: string;
    domain?: string;
    status?: string;
    startedAt?: string;
    completedAt?: string;
    recordsProcessed?: number;
    recordsCleaned?: number;
  } | null;
}

export interface MetricsSourceRow {
  source: string;
  channel: string;
  channelFamilyKey?: string;
  spend?: number;
  pieces?: number;
  impressions?: number;
  clicks?: number;
  leadsReported?: number;
  count?: number;
  payments?: number;
  initialPayments?: number;
  paymentCount?: number;
  initialPaymentCount?: number;
  totalCalls?: number;
  uniqueCallers?: number;
  callsOver5?: number;
  roas?: number;
  [key: string]: unknown;
}

export interface MetricsSources {
  domain: string;
  rows: MetricsSourceRow[];
}

export interface MetricsAttributionReviewItem {
  id: string;
  domain: string | null;
  status: string;
  workflow?: string;
  category?: string;
  severity?: string;
  title?: string | null;
  summary?: string | null;
  happenedAt?: string | null;
  resolvedAt?: string | null;
  resolutionNote?: string | null;
  updatedAt?: string | null;
  reviewKey?: string | null;
  kind?: string | null;
  dateKey?: string | null;
  raw?: {
    source?: string | null;
    channel?: string | null;
    caseId?: number | null;
    casePaymentId?: number | null;
    sample?: Record<string, unknown> | null;
  } | null;
  observed?: Record<string, number> | null;
  resolution?: {
    source?: string | null;
    channel?: string | null;
    note?: string | null;
    resolvedByEmail?: string | null;
    resolvedAt?: string | null;
    ignoredByEmail?: string | null;
    ignoredAt?: string | null;
  } | null;
}

export interface MetricsAttributionReview {
  domain: string;
  counts: {
    open?: number;
    reviewed?: number;
    dismissed?: number;
  };
  items: MetricsAttributionReviewItem[];
}

export interface MetricsDailySummaryRow {
  source?: string;
  channel?: string | null;
  channelFamilyKey?: string;
  spend?: number;
  pieces?: number;
  impressions?: number;
  clicks?: number;
  leadsReported?: number;
  deals?: number;
  paid?: number;
  calls?: number;
  callsOver5?: number;
  [key: string]: unknown;
}

export interface MetricsDailySummary {
  domain: string;
  date: string;
  rows: MetricsDailySummaryRow[];
}

export interface MetricsMailCosts {
  domain: string;
  totals?: { spend?: number; pieces?: number; [key: string]: unknown };
  byPiece?: Array<Record<string, unknown>>;
  rows?: Array<Record<string, unknown>>;
}

export interface MetricsRedlines {
  domain: string;
  counts: {
    pending?: number;
    suppressed?: number;
    sent?: number;
    reviewRedlines?: number;
  };
  alerts?: Array<Record<string, unknown>>;
  reviewItems?: Array<Record<string, unknown>>;
}

/**
 * CallRail aggregates workspace response.
 *
 * `summary` is an ARRAY of by-channel buckets (output of
 * `summarizeCallsByChannel` aggregation — one row per channel with
 * totalCalls, callsOver5, callsOver2, totalDuration, uniqueCallers,
 * pieces). `rows` is the by-piece detail list. The old object typing
 * was wrong — callers were relying on an `as any` cast.
 */
export interface MetricsCallrailChannelSummary {
  _id?: string | null;
  totalCalls?: number;
  callsOver5?: number;
  callsOver2?: number;
  totalDuration?: number;
  uniqueCallers?: number;
  pieces?: string[];
}

export interface MetricsCallrailPieceRow {
  _id?: { piece?: string; channel?: string | null };
  totalCalls?: number;
  callsOver5?: number;
  callsOver2?: number;
  totalDuration?: number;
  uniqueCallers?: number;
  days?: number;
}

export interface MetricsCallrailSummary {
  date?: string | null;
  from?: string | null;
  to?: string | null;
  summary?: MetricsCallrailChannelSummary[];
  rows?: MetricsCallrailPieceRow[];
}

export interface MetricsPulseGroupError {
  _error?: string;
}

export interface MetricsPulse {
  domain: string;
  date: string;
  generatedAt: string;
  mailToday:
    | (MetricsPulseGroupError & {
        entries: Array<{ source: string; pieces: number; spend: number }>;
        total: { pieces: number; spend: number };
      })
    | MetricsPulseGroupError;
  mailCalls:
    | (MetricsPulseGroupError & {
        entries: Array<{
          piece: string;
          totalCalls: number;
          callsOver5: number;
        }>;
        total: { totalCalls: number; callsOver5: number };
      })
    | MetricsPulseGroupError;
  otherChannels:
    | Array<{ key: string; label: string; totalCalls: number }>
    | MetricsPulseGroupError;
  paymentsToday:
    | (MetricsPulseGroupError & {
        initialCount: number;
        initialAmount: number;
        recurringCount: number;
        recurringAmount: number;
        total: number;
        needsReview: number;
      })
    | MetricsPulseGroupError;
  leadsToday:
    | (MetricsPulseGroupError & {
        entries: Array<{ source: string; count: number }>;
        total: number;
      })
    | MetricsPulseGroupError;
  alerts:
    | (MetricsPulseGroupError & {
        pendingRedlines: number;
        attributionReview: number;
      })
    | MetricsPulseGroupError;
}

// ─── Clients ────────────────────────────────────────────────────────────────

export type ClientSearchSource =
  | "caseProfile"
  | "masterProspect"
  | "leadCadence"
  | "logics";

export interface ClientSearchMatch {
  caseId: string;
  name?: string;
  phone?: string;
  email?: string;
  status?: string;
  domain?: string;
  // Tier tag from the search ladder. Present on results from
  // `/api/read/cx/search/:domain` (the four-tier CX search); older
  // consumers of the generic client search may not populate it.
  source?: ClientSearchSource;
}

export interface ClientListItem {
  domain: string;
  caseId: string;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  status?: string | null;
  statusId?: number | null;
  statusCategory?: string | null;
  intakeSource?: string | null;
  intakeRoute?: string | null;
  activeCadence?: boolean;
  totalPaid?: number;
  paymentsCount?: number;
  qcScore?: number | null;
  aiStatus?: string | null;
  optOutDetected?: boolean;
  attributionNeedsReview?: boolean;
  sourceCanonicalId?: string | null;
  attribution?: Record<string, unknown> | null;
  scrubStatus?: string | null;
  lastScrubbedAt?: string | null;
  internalScore?: number;
  updatedAt?: string | null;
}

export interface ClientListResponse {
  domain: string;
  total: number;
  items: ClientListItem[];
  filters?: Record<string, unknown>;
}

export interface ClientTimelineEntry {
  timestamp: string;
  eventType: string;
  label?: string;
  detail?: string | null;
  tone?: "default" | "success" | "warning" | "danger" | "info";
  important?: boolean;
  [key: string]: unknown;
}

export interface ClientDetail {
  caseId: string;
  domain: string;
  name?: string;
  phone?: string;
  email?: string;
  status?: string;
  statusId?: string;
  intakeSource?: string;
  intakeDate?: string;
  prospect?: Record<string, unknown>;
  timeline?: ClientTimelineEntry[];
  enrichment?: Record<string, unknown>;
  attribution?: Record<string, unknown> | null;
  availableSources?: Array<Record<string, unknown>>;
  payments?: Array<Record<string, unknown>>;
  scrubSummary?: {
    status?: string | null;
    reviewedAt?: string | null;
    actorEmail?: string | null;
    activityReviewStatus?: string | null;
    activityReviewConfidence?: string | null;
    activityReviewError?: string | null;
    providers?: {
      activities?: Record<string, unknown> | null;
      payments?: Record<string, unknown> | null;
      invoices?: Record<string, unknown> | null;
      billingSummary?: Record<string, unknown> | null;
    } | null;
  } | null;
  activityAiReview?: Record<string, unknown> | null;
  qualityReview?: Record<string, unknown> | null;
  conversationSummary?: Record<string, unknown> | null;
  // Case-scoped call history — one row per CallLog record linked to
  // this case. `transcription.recordingUri` powers inline audio playback.
  calls?: ClientCaseCall[];
  // Case text chain — ConversationMessage rows for the case's primary
  // phone, newest-first (UI reverses for chronological bubble view).
  textChain?: ClientCaseMessage[];
}

export interface ClientCaseCall {
  _id?: string;
  telephonySessionId?: string | null;
  domain?: string;
  caseId?: number | null;
  extensionId?: string | null;
  agentName?: string | null;
  direction?: "inbound" | "outbound" | string | null;
  fromNumber?: string | null;
  toNumber?: string | null;
  callStartTime?: string | null;
  callEndTime?: string | null;
  durationSec?: number | null;
  sourceCanonicalId?: string | null;
  attribution?: Record<string, unknown> | null;
  transcription?: {
    status?: string | null;
    recordingUri?: string | null;
    recordingDuration?: number | null;
    text?: string | null;
    attempts?: number | null;
  } | null;
  callScore?: {
    score?: number | null;
    verdict?: string | null;
    summary?: string | null;
  } | null;
}

// ─── CX lead lookup (unified across CaseProfile / Prospect / Cadence / Logics) ─

export type CxLeadLookupSource =
  | "caseProfile"
  | "masterProspect"
  | "leadCadence"
  | "logics"
  | "none"
  | null;

export interface CxLeadLookupMatch {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  caseId: number | null;
  sourceName: string | null;
  intakeSource: string | null;
  status: string | null;
  notes: string | null;
}

/**
 * Per-tier enrichment payload — shows which Mongo records we silently
 * tied into the primary Logics match. Each non-null entry has the
 * normalized form-shape (`match`) plus the raw record. The CX UI uses
 * this to decorate the form and surface presence pills like "also in
 * MasterProspect" without overriding Logics-authoritative fields.
 */
export interface CxLeadLookupEnrichments {
  caseProfile: {
    source: "caseProfile";
    match: CxLeadLookupMatch;
    raw?: Record<string, unknown> | null;
  } | null;
  masterProspect: {
    source: "masterProspect";
    match: CxLeadLookupMatch;
    raw?: Record<string, unknown> | null;
  } | null;
  leadCadence: {
    source: "leadCadence";
    match: CxLeadLookupMatch;
    raw?: Record<string, unknown> | null;
  } | null;
}

/**
 * One row in the multi-candidate lookup — represents a phone match in
 * a specific (domain, tier) cell. The CX UI renders these as buttons
 * at the top of the identity strip so the operator can pick which
 * version of "person calling on this number" to load.
 */
export interface CxLeadCandidate {
  key: string;
  domain: string;
  tier: "logics" | "caseProfile" | "masterProspect" | "leadCadence";
  caseId: number | null;
  firstName: string | null;
  lastName: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  status: string | null;
  sourceName: string | null;
  intakeSource: string | null;
  notes: string | null;
  // Mail-intake context — populated for MasterProspectIndex rows that
  // entered via NCOA / Lexis / mail-house uploads. Lets the CX UI
  // disambiguate identical names by where mail was sent.
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  mailIntake?: {
    lienType?: string | null;
    plaintiff?: string | null;
    amount?: string | null;
    filingDate?: string | null;
    mailDate?: string | null;
    importBatch?: string | null;
  } | null;
  createdAt: string | null;
  raw?: Record<string, unknown> | null;
}

export interface CxLeadCandidatesResult {
  candidates: CxLeadCandidate[];
  lookupPhone: string | null;
  lookupCaseId: number | null;
  triedDomains: string[];
  reason?: string;
}

export interface CxLeadLookupResult {
  source: CxLeadLookupSource;
  match: CxLeadLookupMatch | null;
  raw?: Record<string, unknown> | null;
  /**
   * Domain that produced the match. With the WYNN→TAG fallback walk,
   * this can differ from the domain the operator was viewing — UI uses
   * it to nudge the switcher / surface a "matched in TAG" pill.
   */
  domain?: string;
  /**
   * Domains the lookup actually tried before resolving (or giving up).
   * Useful for telemetry + the "no match in WYNN/TAG" empty-state copy.
   */
  triedDomains?: string[];
  /**
   * Mongo records tied silently to the primary match. Always present
   * when the primary tier is `logics` — empty/null entries when no
   * local record exists for a given tier.
   */
  enrichments?: CxLeadLookupEnrichments;
  lookupPhone: string | null;
  lookupCaseId: number | null;
  reason?: string;
}

export interface ClientCaseMessage {
  id: string;
  domain: string | null;
  phone: string | null;
  channel: string;
  direction: "inbound" | "outbound";
  body: string;
  providerStatus?: string | null;
  autoResponded?: boolean;
  createdAt: string;
  aiClassification?: {
    intent?: string | null;
    tier?: string | null;
    confidence?: number | null;
  } | null;
}

export interface ClientCommandResult {
  domain: string;
  requested: boolean;
  workflowId: string;
  reviewItemId?: string | null;
  completed?: boolean;
  completionWorkflowId?: string;
  response?: unknown;
}

// ─── Schedules ──────────────────────────────────────────────────────────────

export interface SchedulesOverview {
  domain: string;
  activeCadenceCount?: number;
  inactiveCadenceCount?: number;
  dueCounts?: Record<string, number>;
  recentCadence?: Array<Record<string, unknown>>;
}

export interface CadenceItem {
  caseId?: string;
  active?: boolean;
  intakeSource?: string;
  intakeRoute?: string;
  [key: string]: unknown;
}

export interface SchedulesCadence {
  caseId?: string;
  active?: boolean;
  intakeSource?: string;
  intakeRoute?: string;
  limit?: number;
  cadenceList: CadenceItem[];
}

// ─── Review queue ───────────────────────────────────────────────────────────

export interface ReviewQueueOverview {
  domain: string;
  openCount?: number;
  completedCount?: number;
  failedCount?: number;
  categories?: Array<{ key: string; count: number; label?: string }>;
}

export interface ReviewQueueItem {
  id: string;
  domain?: string;
  category?: string;
  status?: string;
  caseId?: string;
  createdAt?: string;
  [key: string]: unknown;
}

// ─── RingCentral ────────────────────────────────────────────────────────────

export interface FreshLeadGate {
  allowed?: boolean;
  blocked?: boolean;
  source?:
    | "none"
    | "ex-call"
    | "manual"
    | "routing"
    | "routing-disabled"
    | string
    | null;
  reason?: string | null;
  desiredAvailability?: "available" | "unavailable" | string | null;
  exCallActive?: boolean;
  label?: string;
  detail?: string;
  updatedAt?: string | null;
}

export interface RingCentralAgent {
  extensionId: string;
  name?: string;
  email?: string;
  presence?: string;
  dndStatus?: string | null;
  telephonyStatus?: string;
  lastUpdate?: string;
  callsToday?: number;
  averageCallDuration?: number;
  company?: string;
  freshLeadGate?: FreshLeadGate | null;
  cxRouting?: Record<string, unknown> | null;
  currentCall?: Record<string, unknown> | null;
  status?: string | null;
  exPresenceStatus?: string | null;
  exTelephonyStatus?: string | null;
  [key: string]: unknown;
}

export interface RingCentralPresence {
  domain: string;
  summary?: {
    total?: number;
    cxUnavailable?: number;
    freshLeadBlocked?: number;
    freshLeadBlockedByEx?: number;
    activeCalls?: number;
    byStatus?: Record<string, number>;
  };
  agents: RingCentralAgent[];
}

export interface WorkflowRecord {
  _id?: string;
  family?: string;
  subtype?: string | null;
  stage?: string;
  aggregateType?: string;
  aggregateId?: string;
  caseId?: number | null;
  title?: string | null;
  summary?: string | null;
  createdAt?: string;
  happenedAt?: string;
  payload?: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
}

export interface RingBridgeWorkspaceData {
  domain: string;
  presence: {
    domain: string;
    summary?: {
      total?: number;
      cxUnavailable?: number;
      freshLeadBlocked?: number;
      freshLeadBlockedByEx?: number;
      activeCalls?: number;
      byStatus?: Record<string, number>;
    };
    agents: RingCentralAgent[];
  };
  runtime?: Record<string, unknown> | null;
  providerHealth?: Record<string, unknown> | null;
  recentWorkflowStages?: WorkflowRecord[];
  recentReviewItems?: Array<Record<string, unknown>>;
}

export interface CallLogSource {
  matched: boolean;
  canonicalKey?: string | null;
  name?: string | null;
  channel?: string | null;
  did?: string | null;
}

export interface CallLogRow {
  sessionId: string;
  extensionId?: string | null;
  agentName?: string | null;
  agentCompany?: string | null;
  direction?: string | null;
  fromNumber?: string | null;
  fromName?: string | null;
  toNumber?: string | null;
  toName?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  durationSec?: number | null;
  outcome?: string | null;
  missed?: boolean;
  hasRecording?: boolean;
  source?: CallLogSource | null;
  attribution?: {
    status?: "resolved" | "missed" | "pending";
    attempts?: number | null;
    strategy?:
      | "logics-intake"
      | "callrail"
      | "legs[0]"
      | "did"
      | "legacy"
      | "none"
      | string
      | null;
    confidence?: "high" | "medium" | "low" | "none" | string | null;
    legIndex?: number | null;
    caseId?: number | null;
    caseDomain?: string | null;
    caseName?: string | null;
    intakeSource?: string | null;
    reconcile?: boolean;
  };
  stages?: Array<{ subtype?: string; stage?: string; at?: string }>;
}

export interface CallLogResponse {
  domain: string;
  generatedAt: string;
  summary: {
    total: number;
    missed: number;
    attributed: number;
    sourceMatched: number;
    legacy?: number;
    nativeSessions?: number;
    legacyMerged?: number;
    byDirection: Record<string, number>;
    byOutcome: Record<string, number>;
  };
  calls: CallLogRow[];
}

export interface RingcentralPollingRuntime {
  domain: string;
  reachable: boolean;
  healthy: boolean;
  staleThresholdMs: number;
  ageMs: number | null;
  presencePoller: {
    enabled?: boolean;
    running?: boolean;
    intervalMs?: number;
    lastStartedAt?: string | null;
    lastCompletedAt?: string | null;
    lastError?: string | null;
    lastResult?: {
      checked?: number;
      changed?: number;
      staleCount?: number;
    } | null;
  } | null;
  auth?: Record<string, unknown> | null;
  telephonyQueue?: Record<string, unknown> | null;
  reason?: string | null;
}

export interface CxCallQueueItem {
  domain: string;
  caseId: string;
  intakeSource?: string | null;
  intakeRoute?: string | null;
  active?: boolean;
  currentStage?: string | null;
  nextActionType?: string | null;
  nextActionAt?: string | null;
  cxAction?: Record<string, unknown> | null;
  score?: number | null;
  queueFamily?: string | null;
  queueDayIndex?: number | null;
  progressiveStageKey?: string | null;
  progressiveStageIndex?: number | null;
  progressiveStageLabel?: string | null;
  payloadSnapshot?: Record<string, unknown> | null;
  leadBody?: Record<string, unknown> | null;
  queueState?: string | null;
  queueTicketId?: string | null;
  rcxAccountId?: string | null;
  rcxDialGroupId?: string | null;
  rcxCampaignId?: string | null;
  assignedExtensionId?: string | null;
  assignedAgentName?: string | null;
}

export interface CxWorkspaceData {
  domain: string;
    agent: {
      email: string;
      name?: string | null;
      extensionId?: string | null;
      cxAgentId?: string | null;
      stationLabel?: string | null;
      workspace?: string | null;
      company?: string | null;
      exShells?: ExShellRecord[];
      requestedExShell?: ExShellRecord | null;
      activeExShell?: ExShellRecord | null;
    };
  ex: {
    status?: string;
    exPresenceStatus?: string;
    exTelephonyStatus?: string;
    currentCall?: Record<string, unknown> | null;
    cxRouting?: Record<string, unknown> | null;
    freshLeadGate?: FreshLeadGate | null;
    lastStatusChange?: string | null;
    lastEventReceived?: string | null;
  };
  counts: {
    callQueue?: number;
    tasks?: number;
    reminders?: number;
    workflowStages?: number;
  };
  callQueue: CxCallQueueItem[];
  tasks: Array<Record<string, unknown>>;
  reminders: Array<Record<string, unknown>>;
  recentWorkflowStages: WorkflowRecord[];
  capabilities?: Record<string, boolean>;
  executionPlan?: Record<string, string>;
  notes?: string[];
}

export interface CxTaskListData {
  domain: string;
  tasks: Array<Record<string, unknown>>;
  reminders: Array<Record<string, unknown>>;
}

export interface CxSearchData {
  scope?: string;
  prospects: ClientSearchMatch[];
  caseProfiles: ClientSearchMatch[];
  merged: ClientSearchMatch[];
}

/**
 * Server-side resolution of an agent's CX availability after a status
 * mutation lands. `desiredAvailability` is the value the server actually
 * applied — which may differ from what the operator requested when an
 * EX call is in flight (server forces `unavailable` with `reason="ex-busy"`).
 * The workspace surfaces this delta as an explicit toast / status note
 * instead of letting the override be silent.
 */
export interface CxStatusResponse {
  extensionId?: string | null;
  cxRouting?: {
    enabled?: boolean;
    desiredAvailability?: "available" | "unavailable";
    reason?: string;
    syncedAt?: string | null;
    lastSource?: string | null;
    assignmentStats?: Record<string, unknown> | null;
  } | null;
  freshLeadGate?: FreshLeadGate | null;
}

export interface CxCommandResult {
  domain: string;
  requested: boolean;
  workflowId: string;
  reviewItemId?: string | null;
  completed?: boolean;
  completionWorkflowId?: string;
  response?: CxStatusResponse | Record<string, unknown> | unknown;
  disposition?: string | null;
  queueOutcome?: string | null;
  rescheduledFor?: string | null;
  statusId?: number | null;
  statusCategory?: string | null;
}

// ─── Dispatch / worklists ───────────────────────────────────────────────────

export interface DispatchList {
  id: string;
  domain: string;
  family?: string;
  subtype?: string;
  channel?: string;
  mode?: string;
  status?: string;
  prospectCount?: number;
  templateId?: string;
  sendAfter?: string;
  createdAt?: string;
  createdBy?: string;
  ratePerMinute?: number | null;
  maxCount?: number | null;
  pulseSize?: number | null;
  pulseDelayMs?: number | null;
  title?: string;
  description?: string;
  builtAt?: string;
  queuedAt?: string;
  consumedAt?: string;
  eventId?: string | null;
  stats?: {
    selectedCount?: number;
    attemptedCount?: number;
    successCount?: number;
    failedCount?: number;
  };
  lastResult?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface DispatchBuildRequest {
  domain: string;
  family: string;
  subtype?: string;
  channel?: string;
  audienceSource?: string;
  statusId?: number;
  mode?: string;
  caseIds?: string[];
  prospectIds?: string[];
  templateId?: string;
  templateKey?: string | null;
  sendAfter?: string;
  maxCount?: number;
  ratePerMinute?: number;
  pulseSize?: number;
  pulseDelayMs?: number;
  sourceService?: string;
  notes?: string;
  instructions?: {
    content?: string | null;
    subject?: string | null;
    audioUrl?: string | null;
    trackingNumber?: string | null;
  };
}

// ─── Hygiene ────────────────────────────────────────────────────────────────

export interface HygieneDailyRun {
  _id?: string;
  runId?: string;
  domain: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
  recordsProcessed?: number;
  recordsCleaned?: number;
  recordsFailed?: number;
  createdBy?: string;
  notes?: string[];
}

// ─── Health ─────────────────────────────────────────────────────────────────

export interface ConversationWorkflowSummary {
  _id?: string;
  caseId?: number | null;
  phone?: string | null;
  channel?: string | null;
  status?: string;
  optOutDetected?: boolean;
  latestInboundText?: string | null;
  latestInboundAt?: string | null;
  aiRecommendedAction?: string | null;
  aiDraftReply?: string | null;
  aiConfidence?: string | null;
  aiFlags?: string[];
  aiSummary?: string | null;
  updatedAt?: string;
  createdAt?: string;
  metadata?: Record<string, unknown> | null;
}

export interface InboxWorkspaceData {
  domain: string;
  counts: {
    observed?: number;
    drafted?: number;
    manualReview?: number;
    optOutDetected?: number;
  };
  workflows: ConversationWorkflowSummary[];
  recentReviewItems?: Array<Record<string, unknown>>;
  recentWorkflowStages?: WorkflowRecord[];
}

export interface InboxCommandResult {
  domain: string;
  workflowId: string;
  action: string;
  status: string;
  reviewItemId?: string | null;
  workflowRecordId?: string | null;
  draft?: string | null;
  sleepUntil?: string | Date | null;
}

// ─── Per-turn conversation messages (inbox history view) ────────────────────

export type ConversationMessageDirection = "inbound" | "outbound";
export type ConversationMessageProviderStatus =
  | "queued"
  | "sent"
  | "delivered"
  | "failed"
  | "undelivered"
  | null;

export type ConversationMessageTier =
  | "hard_stop"
  | "dnc_confirm"
  | "callback_prompt"
  | "needs_human"
  | null;

export type ConversationMessageDispositionLabel =
  | "approve"
  | "send_as_is"
  | "regenerate"
  | "dnc_hard"
  | "dnc_soft"
  | "hostile"
  | "spam"
  | "already_client"
  | "wrong_number"
  | null;

export interface ConversationMessageClassification {
  intent?: string | null;
  tier?: ConversationMessageTier;
  suggestedReply?: string | null;
  confidence?: number | null;
  rationale?: string | null;
  model?: string | null;
}

export interface ConversationMessageDisposition {
  label?: ConversationMessageDispositionLabel;
  setByEmail?: string | null;
  setAt?: string | null;
  note?: string | null;
}

export interface ConversationMessage {
  id: string;
  workflowId: string | null;
  domain: string | null;
  phone: string | null;
  caseId: number | null;
  channel: string;
  direction: ConversationMessageDirection;
  body: string;
  provider?: string | null;
  providerMessageId?: string | null;
  providerStatus?: ConversationMessageProviderStatus;
  providerError?: string | null;
  aiClassification?: ConversationMessageClassification | null;
  autoResponded?: boolean;
  approvedByEmail?: string | null;
  approvedAt?: string | null;
  disposition?: ConversationMessageDisposition | null;
  createdAt: string;
  updatedAt?: string | null;
}

export interface InboxThreadMessagesResponse {
  workflow: {
    id: string;
    domain: string;
    phone: string | null;
    channel: string;
    status: string;
    caseId: number | null;
    optOutDetected: boolean;
    aiRecommendedAction?: string | null;
    aiDraftReply?: string | null;
    aiConfidence?: string | null;
    aiSummary?: string | null;
    aiFlags?: string[];
    latestInboundAt?: string | null;
    metadata?: Record<string, unknown> | null;
  };
  messages: ConversationMessage[];
}

export interface LibraryCatalogEntry {
  id: string;
  kind: "text" | "email";
  name?: string;
  category?: string;
  brand?: string;
  audience?: string;
  stage?: string;
  preview?: string;
  sourcePath?: string;
  subject?: string;
  content?: string;
}

export interface LibraryWorkspaceData {
  domain: string;
  catalogs: {
    textMessages: LibraryCatalogEntry[];
    emailTemplates: LibraryCatalogEntry[];
    campaigns?: Array<Record<string, unknown>>;
  };
  summary: {
    smsCount?: number;
    emailCount?: number;
    smsCategories?: Record<string, number>;
    emailCategories?: Record<string, number>;
    emailBrands?: Record<string, number>;
  };
  recentUsage?: {
    emailDispatches?: DispatchList[];
    smsDispatches?: DispatchList[];
  };
  capabilities?: Record<string, boolean>;
  notes?: string[];
  source?: Record<string, unknown>;
}

export interface SocialResponderStats {
  totalWebhookEvents?: number;
  matchedEvents?: number;
  repliesSent?: number;
  lastWebhookAt?: string | null;
  lastMatchedAt?: string | null;
  lastReplyAt?: string | null;
  lastEventType?: string | null;
  lastKeyword?: string | null;
  lastSenderId?: string | null;
  lastError?: string | null;
  lastErrorAt?: string | null;
}

export interface SocialResponderConfigRecord {
  domain: string;
  platform: "facebook" | "instagram" | string;
  enabled?: boolean;
  triggerKeywords?: string[];
  commentReplyTemplate?: string;
  directReplyTemplate?: string;
  stats?: SocialResponderStats;
  updatedBy?: {
    email?: string | null;
    name?: string | null;
  } | null;
  updatedAt?: string | null;
  listener?: {
    pageId?: string | null;
    tokenConfigured?: boolean;
    brandName?: string | null;
    brandHandle?: string | null;
  } | null;
}

export interface SocialResponderWorkspaceData {
  domain: string;
  listener: {
    webhookPath?: string;
    verifyTokenConfigured?: boolean;
    supportedObjects?: string[];
  };
  responders: SocialResponderConfigRecord[];
  notes?: string[];
}

export interface SocialResponderUpdateInput {
  enabled: boolean;
  triggerKeywords: string[];
  commentReplyTemplate: string;
  directReplyTemplate: string;
}

export type DeployAction = "full" | "content" | "restart";

export interface DeployTarget {
  key: string;
  label: string;
  description?: string | null;
  workflow: string;
  ref: string;
  company?: string | null;
  allowedActions: string[];
  /** Whether the target has a complete owner+repo+token set on 5001. */
  ready?: boolean;
  /** Missing fields — ["token"], ["owner"], etc. Never includes the token value. */
  missing?: string[];
  owner?: string | null;
  repo?: string | null;
}

export interface DeployRun {
  id: string;
  runNumber: number | null;
  status: "queued" | "in_progress" | "completed" | string | null;
  conclusion: string | null;
  event?: string | null;
  name?: string | null;
  workflowId?: string | null;
  workflowPath?: string | null;
  headBranch?: string | null;
  headSha?: string | null;
  triggeringActor?: string | null;
  htmlUrl?: string | null;
  runStartedAt?: string | null;
  updatedAt?: string | null;
  createdAt?: string | null;
  targetKey?: string | null;
}

export interface DeployState {
  configured: boolean;
  missing?: string[];
  owner?: string;
  repo?: string;
  targets: DeployTarget[];
  recentRuns: DeployRun[];
  fetchError?: { message: string; status: number | null } | null;
}

export interface DeployWorkspaceData {
  domain: string;
  topology?: Record<string, unknown>;
  controlPlane?: Record<string, unknown>;
  providerHealth?: Record<string, unknown>;
  recentServiceAlerts?: Array<Record<string, unknown>>;
  deploy?: DeployState;
}

export interface DeployActionResult {
  ok: true;
  targetKey: string;
  action: DeployAction;
  workflow: string;
  ref: string;
  dispatchedAt: string;
  workflowRecordId: string;
}

export interface HealthStatus {
  ok?: boolean;
  status?: string;
  [key: string]: unknown;
}

// ─── Accounts / admin user management ───────────────────────────────────────

export type AccountStatus = "active" | "disabled" | "invited";
export type AccountSource = "seed" | "manual" | "rc-poll";

export interface AccountAgentState {
  status?: string | null;
  exPresenceStatus?: string | null;
  exTelephonyStatus?: string | null;
  cxRouting?: Record<string, unknown> | null;
  freshLeadGate?: FreshLeadGate | null;
  currentCall?: Record<string, unknown> | null;
  lastStatusChange?: string | null;
  lastEventReceived?: string | null;
  dailyStats?: Record<string, unknown> | null;
  activePlatform?: string | null;
}

export interface AccountRecord {
  id: string;
  email: string;
  name: string;
  role: AuthRole;
  audience: AuthAudience;
  workspace?: string | null;
  stationLabel?: string | null;
  company?: string | null;
  extensionId?: string | null;
  extensionNumber?: string | null;
  cxAgentId?: string | null;
  phone?: string | null;
  exShells?: ExShellRecord[];
  logicsUserId?: number | null;
  logicsDisplayName?: string | null;
  tagLogicsId?: number | null;
  tagSOId?: number | null;
  tagEmail?: string | null;
  tagLogicsName?: string | null;
  tagLogicsRoles?: string | null;
  wynnLogicsId?: number | null;
  wynnSOId?: number | null;
  wynnEmail?: string | null;
  wynnLogicsName?: string | null;
  wynnLogicsRoles?: string | null;
  logicsAuth?: AccountLogicsAuth | null;
  cxQueuePolicy?: CxQueuePolicy | null;
  agentState?: AccountAgentState | null;
  status: AccountStatus;
  source: AccountSource;
  lastLoginAt?: string | null;
  disabledAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  capabilities?: string[];
  views?: string[];
  isSeed?: boolean;
  isHardened?: boolean;
  metadata?: Record<string, unknown> | null;
}

export interface UnassignedExtension {
  extensionId: string;
  name?: string | null;
  company?: string | null;
  cxAgentId?: string | null;
  status?: string | null;
  exPresenceStatus?: string | null;
  lastStatusChange?: string | null;
  lastEventReceived?: string | null;
}

export interface CreateAccountInput {
  email: string;
  name: string;
  role: AuthRole;
  audience?: AuthAudience;
  workspace?: string;
  stationLabel?: string;
  company?: string;
  extensionId?: string | null;
  extensionNumber?: string | null;
  cxAgentId?: string | null;
  phone?: string | null;
  exShells?: ExShellRecord[];
  logicsUserId?: number | null;
  logicsDisplayName?: string | null;
  tagLogicsId?: number | null;
  tagSOId?: number | null;
  tagEmail?: string | null;
  tagLogicsName?: string | null;
  tagLogicsRoles?: string | null;
  wynnLogicsId?: number | null;
  wynnSOId?: number | null;
  wynnEmail?: string | null;
  wynnLogicsName?: string | null;
  wynnLogicsRoles?: string | null;
  logicsAuth?: AccountLogicsAuth | null;
  cxQueuePolicy?: CxQueuePolicy | null;
  status?: AccountStatus;
}

export type UpdateAccountInput = Partial<CreateAccountInput>;
