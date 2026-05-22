import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";

export interface BlogBotState {
  lastRunDate: string | null;
  lastPostedId: string | null;
  lastFridayCategory: string | null;
}

export interface BlogBotRunLogEntry {
  name: string;
  mtime: string;
  outcome: "success" | "failed" | "skipped" | "started" | "unknown";
  tail: string;
}

export interface BlogBotRecoveryEntry {
  name: string;
  mtime: string;
  classification: string;
  confidence: string;
  autoExecuted: boolean;
  actionCount: number;
  diagnosisExcerpt: string | null;
}

export interface BlogBotSlugSync {
  inSync: boolean;
  wynnCount: number | null;
  tagCount: number | null;
  duplicates: {
    wynn: { id: string; count: number }[];
    tag: { id: string; count: number }[];
  };
  wynnOnly: string[];
  tagOnly: string[];
}

export interface BlogBotPublishedCommit {
  hash: string;
  subject: string;
  committedAt: string;
}

export interface BlogBotStatus {
  capturedAt: string;
  state: BlogBotState | null;
  lastRunOutcome: BlogBotRunLogEntry["outcome"];
  recentRuns: BlogBotRunLogEntry[];
  recentRecoveries: BlogBotRecoveryEntry[];
  slugSync: BlogBotSlugSync;
  lastPublished: {
    wynn: BlogBotPublishedCommit | null;
    tag: BlogBotPublishedCommit | null;
  };
  health: {
    ok: boolean;
    issues: string[];
  };
}

interface StatusResponse {
  ok: true;
  result: BlogBotStatus;
}

interface RunResponse {
  ok: true;
  message: string;
  spawnedAt: string;
  actor: string | null;
}

export function useBlogBotStatus() {
  return useQuery({
    queryKey: ["blog-bot", "status"],
    queryFn: () =>
      api
        .get<StatusResponse>("/api/read/deploy/blog-bot/status")
        .then((r) => r.result),
    staleTime: 10_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}

export function useTriggerBlogBotRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<RunResponse>("/api/commands/deploy/blog-bot/run", {}),
    onSuccess: () => {
      // Refresh the status panel ~once a process spin-up later. The
      // runner itself runs minutes, so the user will see "new run
      // started" first, then subsequent refetchInterval ticks pick
      // up the progress.
      setTimeout(() => {
        qc.invalidateQueries({ queryKey: ["blog-bot", "status"] });
      }, 3000);
    },
  });
}
