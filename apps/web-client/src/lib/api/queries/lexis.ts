import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import type { OkEnvelope } from "@/lib/api/types";
import { queryKeys } from "@/lib/api/queries/keys";

export interface NcoaRow {
  firstName: string | null;
  lastName: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  cell: string | null;
  notes: string;
  sourceName: string | null;
  raw?: Record<string, unknown>;
}

export interface NcoaPreviewResult {
  total: number;
  rows: NcoaRow[];
}

export interface NcoaUploadRowResult {
  ok: boolean;
  caseId?: number;
  row: NcoaRow;
  error?: string;
  response?: unknown;
}

export interface NcoaUploadResult {
  domain: string;
  importBatch: string;
  total: number;
  succeeded: number;
  failed: number;
  /** Rows skipped because a prospect with this importBatch already exists. */
  skipped?: number;
  results: NcoaUploadRowResult[];
}

/** Live progress snapshot for a running NCOA upload, derived from
 *  workflow stages so it survives restarts and connection drops. */
export interface NcoaUploadProgress {
  domain: string | null;
  importBatch: string | null;
  total: number;
  succeeded: number;
  failed: number;
  pending: number;
  mostRecent: string | null;
  batchStarted: string | null;
  batchCompleted: string | null;
  /** When set, the batch envelope landed a `failed` stage —
   *  uploadNcoaRows threw and emitted the failsafe terminal event. */
  batchFailed?: string | null;
  /** True when the batch has had no row activity for >5min and
   *  no terminal envelope has landed. UI should treat as dead. */
  stalled?: boolean;
  /** True iff the batch is in any terminal state (completed,
   *  failed, OR stalled). UI's "show progress strip" gate should
   *  switch to "show final tally / show retry CTA" when true. */
  terminal?: boolean;
  /** Milliseconds since the most recent row activity. 0 when not
   *  applicable (no activity yet, or already terminal). */
  staleSinceMs?: number;
}

export function useNcoaPreview() {
  return useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return api
        .post<OkEnvelope<NcoaPreviewResult>>("/api/lexis/ncoa/preview", form)
        .then((env) => env.result);
    },
  });
}

// Hard ceiling on how long we'll keep a single NCOA upload POST
// open from the browser. Matches the server's 2h request timeout.
// `fetch` itself has no client-side timeout — without this, a hung
// connection (server crashed mid-batch, proxy dropped the response,
// network blackhole that doesn't surface a TCP reset) leaves the
// mutation `isPending: true` forever and the spinner spins
// indefinitely. After the abort the existing catch path runs, the
// connection-lost toast fires, and the operator can re-upload to
// resume (server skips already-landed rows).
const NCOA_UPLOAD_HARD_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export function useNcoaUpload() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ file, importBatch }: { file: File; importBatch?: string }) => {
      const form = new FormData();
      form.append("file", file);
      if (importBatch) form.append("importBatch", importBatch);

      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => {
        controller.abort();
      }, NCOA_UPLOAD_HARD_TIMEOUT_MS);

      return api
        .post<OkEnvelope<NcoaUploadResult>>(
          "/api/lexis/ncoa/upload",
          form,
          { signal: controller.signal },
        )
        .then((env) => env.result)
        .finally(() => {
          window.clearTimeout(timeoutId);
        });
    },
    onSuccess: () => {
      // New prospects → invalidate anything that surfaces prospect counts.
      qc.invalidateQueries({ queryKey: queryKeys.metrics.all() });
      qc.invalidateQueries({ queryKey: queryKeys.clients.all() });
      qc.invalidateQueries({ queryKey: queryKeys.workflows.all() });
    },
  });
}

/**
 * Poll the upload-progress endpoint while a long NCOA POST is in
 * flight so the operator sees live counts instead of a frozen
 * spinner. Pass `enabled` from the upload mutation's `isPending`
 * (plus a brief tail after it lands so the final tally syncs).
 */
export function useNcoaProgress(importBatch: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["lexis", "ncoa", "progress", importBatch ?? ""] as const,
    queryFn: () =>
      api
        .get<OkEnvelope<NcoaUploadProgress>>("/api/lexis/ncoa/progress", {
          query: { importBatch: importBatch ?? "" },
        })
        .then((env) => env.result),
    enabled: enabled && Boolean(importBatch),
    // 3s feels live enough without hammering Mongo. The aggregation
    // is index-friendly (`{family, "payload.importBatch"}`) so cost
    // per poll stays small.
    refetchInterval: enabled ? 3000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
}
