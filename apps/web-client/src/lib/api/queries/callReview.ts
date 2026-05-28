import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queries/keys";

// Shape of one row returned by /api/admin/call-review/agent/:extensionId/today
// and /api/admin/call-review/case/:caseId/today. Mirrors the projectCallRow
// helper in apps/control-plane/src/routes/adminCallReview.js — keep these
// in sync (no schema generation; small surface).
export type CallScoreVerdict =
  | "hot"
  | "warm"
  | "cold"
  | "dead"
  | "fake"
  | string;

export interface CallReviewRow {
  id: string;
  telephonySessionId: string | null;
  callStartTime: string | null;
  callEndTime: string | null;
  durationSec: number | null;
  direction: "inbound" | "outbound" | "unknown" | string | null;
  platform: "cx" | "ex" | string | null;
  phone: string | null;
  caseId: number | null;
  caseProfileId: string | null;
  agentName: string | null;
  extensionId: string | null;
  // Vendor / campaign attribution. sourceName is the canonical intake
  // source ("LD Posting", "Affiliate X", etc.). routeCampaignKey is
  // the LD subsplit ("ld-custom" | "ld-general") for vendor email
  // rollups.
  sourceName: string | null;
  sourceChannel: string | null;
  routeCampaignKey: string | null;
  routeCampaignName: string | null;
  // Claude-scored lead quality. Null until transcription + scoring
  // completes (transcriptionScoringService).
  score: {
    overall: number | null;
    verdict: CallScoreVerdict | null;
    summary: string | null;
    scoredAt: string | null;
  };
  transcription: {
    status: string | null;
    hasText: boolean;
  };
  recording: {
    driveFileId: string | null;
    provider?: string | null;
    mimeType?: string | null;
    fileName?: string | null;
    groupKey?: string | null;
    groupLabel?: string | null;
    uploadedAt?: string | null;
    playbackUrl: string | null;
    sessionPlaybackUrl: string | null;
    available: boolean;
    archiveStatus: string | null;
  };
  status: string | null;
  // Reserved for the future "this call triggered a case status change"
  // correlation. Null today; UI renders "—".
  statusShift: {
    fromStatusId?: number | null;
    fromStatusLabel?: string | null;
    toStatusId?: number | null;
    toStatusLabel?: string | null;
    changedAt?: string | null;
    confidence?: "exact" | "heuristic" | null;
  } | null;
}

export interface CallReviewSummary {
  callCount: number;
  totalDurationSec: number;
  longestDurationSec: number;
  withRecording: number;
  withoutRecording: number;
  byDirection: Record<string, number>;
}

export interface AgentCallReviewResponse {
  ok: true;
  dateKey: string;
  domain: string;
  extensionId: string;
  summary: CallReviewSummary;
  calls: CallReviewRow[];
}

export interface CaseCallReviewAgentBucket {
  extensionId: string | null;
  agentName: string | null;
  callCount: number;
  totalDurationSec: number;
  lastCallAt: string | null;
}

export interface CaseCallReviewResponse {
  ok: true;
  dateKey: string;
  domain: string;
  caseId: number;
  summary: CallReviewSummary;
  agents: CaseCallReviewAgentBucket[];
  calls: CallReviewRow[];
}

export type CallSortKey = "time" | "duration" | "score";

/**
 * Today's calls for a specific agent extension. Server queries CallLog
 * directly — no snapshot cache, fresh on every fetch. Returns null if
 * the extensionId is missing (an unpaired admin account).
 */
export function useAgentCallReviewToday(
  extensionId: string | null,
  options: { domain?: string; sort?: CallSortKey } = {},
) {
  const { domain = "TAG", sort = "time" } = options;
  return useQuery({
    queryKey: queryKeys.callReview.agentToday(
      extensionId ?? "",
      domain,
      sort,
    ),
    queryFn: () =>
      api.get<AgentCallReviewResponse>(
        `/api/admin/call-review/agent/${encodeURIComponent(extensionId ?? "")}/today`,
        { query: { domain, sort } },
      ),
    enabled: Boolean(extensionId),
    // Match the accounts-list cadence so the panel stays in step with
    // the rest of the admin board's live numbers.
    staleTime: 5_000,
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
  });
}

/**
 * Today's calls against a specific lead, across all agents. Powers the
 * "who dialed this lead today" drawer that pops open when an operator
 * clicks a call row's lead column from the agent panel.
 */
export function useCaseCallReviewToday(
  caseId: number | null,
  options: { domain?: string; sort?: CallSortKey } = {},
) {
  const { domain = "TAG", sort = "time" } = options;
  return useQuery({
    queryKey: queryKeys.callReview.caseToday(caseId ?? 0, domain, sort),
    queryFn: () =>
      api.get<CaseCallReviewResponse>(
        `/api/admin/call-review/case/${encodeURIComponent(String(caseId))}/today`,
        { query: { domain, sort } },
      ),
    enabled: Boolean(caseId && caseId > 0),
    staleTime: 5_000,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });
}

// ── CX Call Tracker (org-wide today list) ────────────────────────────

export type CallPlatformFilter = "cx" | "ex" | "all";
export type CallDirectionFilter = "outbound" | "inbound" | "all";

export interface CallTrackerAgentBucket {
  extensionId: string;
  agentName: string | null;
  callCount: number;
  cxCount: number;
  exCount: number;
  totalDurationSec: number;
  withRecording: number;
  lastCallAt: string | null;
}

export interface RecordingGroupBucket {
  key: string;
  label: string;
  callCount: number;
  totalBytes?: number;
  totalDurationSec?: number;
}

export interface DriveRecordingRow {
  id: string;
  driveFileId: string;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  createdTime: string | null;
  modifiedTime: string | null;
  webViewLink: string | null;
  parentFolderId: string | null;
  rootFolderId: string | null;
  rootFolderKey: string | null;
  rootFolderLabel: string | null;
  folderPath: string | null;
  telephonySessionId: string | null;
  domain: string | null;
  provider: string | null;
  platform: "cx" | "ex" | string | null;
  direction: "inbound" | "outbound" | "unknown" | string | null;
  dateKey: string | null;
  callStartTime: string | null;
  phone: string | null;
  agentName: string | null;
  groupKey: string | null;
  groupLabel: string | null;
  playbackUrl: string | null;
  recording: {
    driveFileId: string | null;
    playbackUrl: string | null;
    available: boolean;
    archiveStatus: string | null;
    provider: string | null;
    mimeType: string | null;
    fileName: string | null;
    groupKey: string | null;
    groupLabel: string | null;
    uploadedAt: string | null;
  };
}

export interface CallTrackerResponse {
  ok: true;
  dateKey: string;
  domains: string[];
  domain: string;
  filters: {
    platform: string;
    direction: string;
    extensionId: string | null;
    hasRecording: boolean | null;
  };
  summary: CallReviewSummary;
  agents: CallTrackerAgentBucket[];
  calls: CallReviewRow[];
  truncated: boolean;
}

export interface CallLibraryResponse {
  ok: true;
  dateKey: string;
  source: "google-drive" | string;
  domain: string;
  domains: string[];
  window: {
    allTime: boolean;
    today: boolean;
    days: number | null;
    startAt: string | null;
  };
  filters: {
    platform: string;
    direction: string;
    recordingGroup: string;
    hasRecording: true;
  };
  folders: Array<{
    folderId: string;
    key: string;
    label: string;
  }>;
  summary: CallReviewSummary & {
    totalBytes?: number;
  };
  recordingGroups: RecordingGroupBucket[];
  calls: DriveRecordingRow[];
  recordings: DriveRecordingRow[];
  truncated: boolean;
}

export interface CallTrackerFilters {
  domain?: "ALL" | "TAG" | "WYNN" | string;
  platform?: CallPlatformFilter;
  direction?: CallDirectionFilter;
  hasRecording?: boolean;
  extensionId?: string | null;
  sort?: CallSortKey;
  limit?: number;
}

export type CallLibraryWindow = "today" | 7 | 30 | 90 | 365 | "all" | number;

export interface CallLibraryFilters {
  platform?: CallPlatformFilter;
  direction?: CallDirectionFilter;
  recordingGroup?: string | null;
  days?: CallLibraryWindow;
  sort?: CallSortKey;
  limit?: number;
}

export type CallLibraryScope = "admin" | "user";

export interface CallsByPhoneResponse {
  ok: true;
  phone: string;
  phoneDisplay: string;
  domains: string[];
  domain: string;
  window: {
    allTime: boolean;
    days: number | null;
  };
  filters: {
    hasRecording: boolean | null;
  };
  summary: CallReviewSummary & {
    firstCallAt: string | null;
    lastCallAt: string | null;
    uniqueAgents: number;
  };
  agents: CallTrackerAgentBucket[];
  calls: CallReviewRow[];
  truncated: boolean;
}

export interface CallsByPhoneFilters {
  domain?: "ALL" | "TAG" | "WYNN" | string;
  days?: number | "all";
  hasRecording?: boolean;
  sort?: CallSortKey;
  limit?: number;
}

/** Strip a phone string to its 10-digit US trunk, or return null. */
export function normalizeUsPhone(input: string | null | undefined): string | null {
  const digits = String(input || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length === 10) return digits;
  if (digits.length > 10) return digits.slice(-10);
  return null;
}

/**
 * All historical calls to/from a phone number. 90-day default window;
 * pass days="all" for the full history. Returns the same row shape as
 * the other call-review endpoints plus phone-specific summary
 * (first/last call, unique agents).
 */
export function useCallsByPhone(
  phone: string | null,
  filters: CallsByPhoneFilters = {},
) {
  const normalized = normalizeUsPhone(phone);
  const query: Record<string, string | number> = {
    domain: filters.domain ?? "ALL",
    days: filters.days ?? 90,
    sort: filters.sort ?? "time",
  };
  if (filters.hasRecording !== undefined) {
    query.hasRecording = filters.hasRecording ? "true" : "false";
  }
  if (filters.limit) query.limit = filters.limit;
  return useQuery({
    queryKey: queryKeys.callReview.byPhone(normalized ?? "", query),
    queryFn: () =>
      api.get<CallsByPhoneResponse>(
        `/api/admin/call-review/by-phone/${encodeURIComponent(normalized ?? "")}`,
        { query },
      ),
    enabled: Boolean(normalized),
    staleTime: 10_000,
    refetchInterval: false,
    refetchIntervalInBackground: false,
  });
}

/**
 * Drive-backed recording library. Reads configured Google Drive archive
 * folders directly and returns only files that can be played through the
 * authenticated Drive proxy.
 */
export function useCallLibrary(
  filters: CallLibraryFilters = {},
  options: { scope?: CallLibraryScope } = {},
) {
  const scope = options.scope ?? "admin";
  const query: Record<string, string | number> = {
    platform: filters.platform ?? "all",
    direction: filters.direction ?? "all",
    recordingGroup: filters.recordingGroup || "all",
    days: filters.days ?? 7,
  };
  if (filters.sort) query.sort = filters.sort;
  if (filters.limit) query.limit = filters.limit;
  return useQuery({
    queryKey: queryKeys.callReview.library({ scope, ...query }),
    queryFn: () =>
      api.get<CallLibraryResponse>(
        scope === "user"
          ? "/api/read/cx/recordings/library"
          : "/api/admin/call-review/library",
        { query },
      ),
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
}

/**
 * Org-wide today's-calls list — drives the legacy call tracker API.
 * Polls every 10s so the endpoint stays live without spamming the server.
 */
export function useCallTrackerToday(filters: CallTrackerFilters = {}) {
  const query: Record<string, string | number> = {
    domain: filters.domain ?? "ALL",
    platform: filters.platform ?? "cx",
    direction: filters.direction ?? "all",
    sort: filters.sort ?? "time",
  };
  if (filters.extensionId) query.extensionId = filters.extensionId;
  if (filters.hasRecording !== undefined) {
    query.hasRecording = filters.hasRecording ? "true" : "false";
  }
  if (filters.limit) query.limit = filters.limit;
  return useQuery({
    queryKey: queryKeys.callReview.tracker(query),
    queryFn: () =>
      api.get<CallTrackerResponse>("/api/admin/call-review/today", { query }),
    staleTime: 5_000,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });
}
