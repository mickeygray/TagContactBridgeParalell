import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import type { OkEnvelope } from "@/lib/api/types";

function unwrap<T>(envelope: OkEnvelope<T>): T {
  return envelope.result;
}

export interface ReportBlock {
  id: string;
  label: string;
  hint: string;
  /** What the numbers in this block actually mean. Shown with the results. */
  terms: string | null;
  needs: string[];
}

export interface ReportPreset {
  key: string;
  blocks: string[];
}

export interface ReportFunction {
  key: string;
  label: string;
  unit: string;
  hint: string;
}

export interface ReportCatalogue {
  blocks: ReportBlock[];
  presets: ReportPreset[];
  filterKeys: string[];
  functions: ReportFunction[];
  ranges: string[];
}

export interface ReportSection {
  id: string;
  label: string;
  terms: string | null;
  error: string | null;
  text: string | null;
  table: { columns: string[]; rows: unknown[][] } | null;
}

export interface ReportPreview {
  from: string;
  to: string;
  domain: string;
  notes: string[];
  gathered: { activityRows?: number; casesConfirmed?: number; durationMs?: number } | null;
  text: string;
  sections: ReportSection[];
}

export interface ReportDefinition {
  _id?: string;
  name: string;
  description: string | null;
  blocks: string[];
  filters: string[];
  domain: string | null;
  range: string;
  recipients: string[];
  sendEmail: boolean;
  schedule: {
    enabled: boolean;
    hour: number;
    minute: number;
    daysOfWeek: number[];
    daysOfMonth: number[];
  };
  lastRunKey: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  runCount: number;
  resolvedRange?: { from: string; to: string };
  due?: boolean;
  dueReason?: string | null;
}

export interface PreviewRequest {
  blocks: string[];
  from: string;
  to: string;
  domain?: string | null;
  where?: string[];
}

const keys = {
  all: () => ["reports"] as const,
  catalogue: () => ["reports", "catalogue"] as const,
  definitions: () => ["reports", "definitions"] as const,
};

/** The block/preset/function catalogue the builder renders its controls from. */
export function useReportCatalogue() {
  return useQuery({
    queryKey: keys.catalogue(),
    queryFn: async () => unwrap(await api.get<OkEnvelope<ReportCatalogue>>("/api/reports/catalogue")),
    // The catalogue only changes when code ships.
    staleTime: 30 * 60 * 1000,
  });
}

export function useReportDefinitions() {
  return useQuery({
    queryKey: keys.definitions(),
    queryFn: async () => unwrap(await api.get<OkEnvelope<ReportDefinition[]>>("/api/reports/definitions")),
  });
}

/**
 * Compose a report live.
 *
 * Deliberately a mutation rather than a query: it is an expensive, explicitly
 * triggered action (13s for a day, up to ~150s for a month) and must never be
 * re-fired by a refetch or a window focus.
 */
export function usePreviewReport() {
  return useMutation({
    mutationFn: async (body: PreviewRequest) =>
      unwrap(await api.post<OkEnvelope<ReportPreview>>("/api/reports/preview", body)),
  });
}

export function useSaveDefinition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: Partial<ReportDefinition>) =>
      unwrap(await api.post<OkEnvelope<ReportDefinition>>("/api/reports/definitions", body)),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.definitions() }),
  });
}

export function useArchiveDefinition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) =>
      unwrap(await api.delete<OkEnvelope<ReportDefinition>>(`/api/reports/definitions/${encodeURIComponent(name)}`)),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.definitions() }),
  });
}

export interface RunResult {
  definition: string;
  range: { from: string; to: string };
  sections: number;
  delivered: boolean;
  errors: string[];
  notes: string[];
  text: string;
  recipients: string[];
}

/**
 * Run a saved definition. `send` defaults to false, so the default action
 * shows what recipients WOULD get without anyone receiving it.
 */
export function useRunDefinition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ name, send = false }: { name: string; send?: boolean }) =>
      unwrap(await api.post<OkEnvelope<RunResult>>(
        `/api/reports/definitions/${encodeURIComponent(name)}/run`, { send },
      )),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.definitions() }),
  });
}

/** Download a composed report without routing it through react-query. */
export function reportDownloadUrl(): string {
  return "/api/reports/preview";
}
