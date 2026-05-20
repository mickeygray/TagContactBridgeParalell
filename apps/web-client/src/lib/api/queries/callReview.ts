import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/queries/keys";

// Shape of one row returned by /api/admin/call-review/agent/:extensionId/today
// and /api/admin/call-review/case/:caseId/today. Mirrors the projectCallRow
// helper in apps/control-plane/src/routes/adminCallReview.js — keep these
// in sync (no schema generation; small surface).
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
  recording: {
    driveFileId: string | null;
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

type CallSortKey = "time" | "duration";

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
