import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import type {
  ClientSearchMatch,
  CxCommandResult,
  CxLeadCandidatesResult,
  CxLeadLookupResult,
  CxSearchData,
  CxTaskListData,
  CxWorkspaceData,
  PostDateHoldsResult,
} from "@/lib/api/types";
import { queryKeys } from "@/lib/api/queries/keys";

function invalidateCxScope(qc: ReturnType<typeof useQueryClient>, domain: string) {
  qc.invalidateQueries({ queryKey: queryKeys.cx.all() });
  qc.invalidateQueries({ queryKey: queryKeys.review.all() });
  qc.invalidateQueries({ queryKey: queryKeys.workflows.all() });
  qc.invalidateQueries({ queryKey: queryKeys.ringcentral.all() });
  qc.invalidateQueries({ queryKey: queryKeys.cx.workspace(domain) });
  qc.invalidateQueries({ queryKey: queryKeys.cx.callQueue(domain) });
  qc.invalidateQueries({ queryKey: queryKeys.cx.tasks(domain) });
}

export function useCxWorkspace(domain: string) {
  return useQuery({
    queryKey: queryKeys.cx.workspace(domain),
    queryFn: () =>
      api
        .get<{ ok: true; result: CxWorkspaceData }>(`/api/read/cx/workspace/${domain}`)
        .then((r) => r.result),
    enabled: Boolean(domain),
    // This query carries `data.ex.currentCall`, the signal a new call
    // has connected. The CX workspace's auto-scramble chain is keyed
    // on it, so polling cadence directly drives how fast a fresh
    // inbound surfaces in the UI.
    //
    // This drives live call/scramble state in the CX workspace. Keep it
    // tight while the tab is active so progressive dialing feels snappy.
    staleTime: 1_500,
    refetchInterval: 3_000,
    refetchIntervalInBackground: false,
  });
}

export function useCxCallQueue(domain: string) {
  return useQuery({
    queryKey: queryKeys.cx.callQueue(domain),
    queryFn: () =>
      api
        .get<{ ok: true; result: { domain: string; items: CxWorkspaceData["callQueue"] } }>(
          `/api/read/cx/call-queue/${domain}`,
        )
        .then((r) => r.result.items),
    enabled: Boolean(domain),
    // Tight polling so queue items popping off / new dial requests
    // landing show up promptly while the operator is on a call.
    staleTime: 1_000,
    refetchInterval: 2_000,
  });
}

export function useCxCallQueueMulti(domains: string[]) {
  const normalizedDomains = Array.from(
    new Set(
      (domains || [])
        .map((domain) => String(domain || "").trim().toUpperCase())
        .filter(Boolean),
    ),
  );

  return useQueries({
    queries: normalizedDomains.map((domain) => ({
      queryKey: queryKeys.cx.callQueue(domain),
      queryFn: () =>
        api
          .get<{ ok: true; result: { domain: string; items: CxWorkspaceData["callQueue"] } }>(
            `/api/read/cx/call-queue/${domain}`,
          )
          .then((r) => r.result.items),
      enabled: Boolean(domain),
      staleTime: 1_000,
      refetchInterval: 2_000,
    })),
  });
}

export function useCxPostDateHolds(
  domain: string,
  filters: { status?: string; date?: string; from?: string; to?: string; caseId?: string } = {},
) {
  return useQuery({
    queryKey: queryKeys.cx.postdates(domain, filters),
    queryFn: () =>
      api
        .get<{ ok: true; result: PostDateHoldsResult }>(`/api/read/cx/postdates/${domain}`, {
          query: {
            status: filters.status || "active",
            date: filters.date || undefined,
            from: filters.from || undefined,
            to: filters.to || undefined,
            caseId: filters.caseId || undefined,
          },
        })
        .then((r) => r.result),
    enabled: Boolean(domain),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}

export function useCxReleasePostDateHold(domain: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { holdId?: string; caseId?: number; reason?: string }) =>
      api
        .post<{ ok: true; result: unknown }>(`/api/commands/cx/${domain}/postdates/release`, body)
        .then((r) => r.result),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.cx.all() });
      qc.invalidateQueries({ queryKey: queryKeys.cx.postdates(domain) });
    },
  });
}

export function useCxTasks(domain: string) {
  return useQuery({
    queryKey: queryKeys.cx.tasks(domain),
    queryFn: () =>
      api
        .get<{ ok: true; result: CxTaskListData }>(`/api/read/cx/tasks/${domain}`)
        .then((r) => r.result),
    enabled: Boolean(domain),
    staleTime: 10_000,
  });
}

export function useCxSearch(domain: string, search: string, scope = "all") {
  return useQuery({
    queryKey: queryKeys.cx.search(domain, search, scope),
    queryFn: () =>
      api
        .get<{ ok: true; result: CxSearchData }>(`/api/read/cx/search/${domain}`, {
          query: { search, limit: 20, scope },
        })
        .then((r) => r.result),
    enabled: Boolean(domain && search.trim().length >= 2),
    staleTime: 10_000,
  });
}

/**
 * Unified lead lookup across CaseProfile → MasterProspect →
 * LeadCadence → Logics. Used by the CX center panel when a call
 * connects or the operator types a phone / case id.
 *
 * Only one of `phone` or `caseId` needs a value to fire; pass both to
 * force a caseId-first lookup. When the key becomes blank the query
 * disables itself so the form stays on its last-known state.
 */
export function useCxLeadLookup(
  domain: string,
  args: {
    phone?: string | null;
    caseId?: number | null;
    skipLogics?: boolean;
    skipMongoFallback?: boolean;
    domainFallback?: string[] | null;
  } = {},
) {
  const phone = (args.phone || "").replace(/\D/g, "");
  const caseId = args.caseId != null ? Number(args.caseId) : null;
  // For phone-only inbound calls we don't yet know which tenant owns
  // the lead, so we walk WYNN then TAG by default. When the operator
  // already pasted a caseId, the active domain is the source of truth
  // (cross-tenant case ids are meaningless) — skip fallback.
  const fallback =
    args.domainFallback ??
    (caseId == null && phone ? ["WYNN", "TAG"] : null);
  return useQuery({
    queryKey: [
      ...queryKeys.cx.all(),
      "lookup",
      domain,
      phone || null,
      caseId,
      Boolean(args.skipLogics),
      Boolean(args.skipMongoFallback),
      fallback ? fallback.join(",") : null,
    ],
    queryFn: () =>
      api
        .get<{ ok: true; result: CxLeadLookupResult }>(`/api/read/cx/lookup/${domain}`, {
          query: {
            phone: phone || undefined,
            caseId: caseId != null ? caseId : undefined,
            skipLogics: args.skipLogics ? "true" : undefined,
            skipMongoFallback: args.skipMongoFallback ? "true" : undefined,
            // Comma-joined; the route splits on "," to rebuild the array.
            domainFallback: fallback ? fallback.join(",") : undefined,
          },
        })
        .then((r) => r.result),
    enabled: Boolean(domain && (phone.length >= 7 || (caseId != null && caseId > 0))),
    // Longer staleTime than search — lookups are heavier (Logics +
    // three collections) and the caller's identity doesn't change
    // while they're on the call.
    staleTime: 30_000,
  });
}

/**
 * Logics activities for a case. Fetched on-demand when the operator
 * opens the Logics workspace panel. Logics returns a flat list;
 * nesting is modeled via a parent-activity reference on child rows.
 */
export function useCxCaseActivities(domain: string, caseId: number | null | undefined) {
  return useQuery({
    queryKey: [...queryKeys.cx.all(), "case-activities", domain, caseId],
    queryFn: () =>
      api
        .get<{ ok: true; result: unknown }>(
          `/api/read/cx/case/${domain}/${caseId}/activities`,
        )
        .then((r) => r.result),
    enabled: Boolean(domain && caseId != null && Number(caseId) > 0),
    staleTime: 15_000,
  });
}

/**
 * Logics case-level fields (Notes, status, etc.) fetched fresh per call.
 * Used by the Notes panel so the editor pre-loads with whatever Logics
 * currently has — including edits made in Logics' own UI since our last
 * sync. The shape is the raw Logics passthrough; consumers read
 * `data.data.Notes` (or whatever case-level field they need).
 */
export function useCxCaseLogicsInfo(domain: string, caseId: number | null | undefined) {
  return useQuery({
    queryKey: [...queryKeys.cx.all(), "case-logics-info", domain, caseId],
    queryFn: () =>
      api
        .get<{ ok: true; result: unknown }>(
          `/api/read/cx/case/${domain}/${caseId}/logics-info`,
        )
        .then((r) => r.result),
    enabled: Boolean(domain && caseId != null && Number(caseId) > 0),
    staleTime: 15_000,
  });
}

/**
 * Unified communication log entry — what the fan-out reader emits per
 * row. Channel + direction + source + ts are the columns the timeline
 * UI actually renders; metadata is channel-specific extras (durationMs,
 * templateKey, providerMessageId, etc.).
 */
export interface CommLogEntry {
  ts: string;
  channel: "sms" | "email" | "call" | "rvm";
  direction: "inbound" | "outbound" | "scheduled";
  status: string;
  body: string | null;
  actor: { email: string | null; name: string | null } | null;
  source: "case-profile" | "conversation-message" | "call-log" | "lead-cadence";
  refId: string;
  metadata?: Record<string, unknown>;
}

export interface CommLogResult {
  ok: true;
  domain: string;
  caseId: number | null;
  phone: string | null;
  identityResolved: boolean;
  convertedAt?: string | null;
  counts: {
    total: number;
    caseProfile: number;
    leadCadence: number;
    conversationMessages: number;
    callLogs: number;
  };
  entries: CommLogEntry[];
}

/**
 * Unified communication log for a case (or a phone-only prospect). Pulls
 * from CaseProfile.communications, ConversationMessage, CallLog,
 * and LeadCadence.schedule.actions — sorted newest-first. Pass either
 * caseId or phone (or both); the backend resolves the missing half.
 */
export function useCxCommLog(
  domain: string,
  args: { caseId?: number | null; phone?: string | null; limit?: number },
) {
  const caseIdNum = args.caseId != null && Number(args.caseId) > 0
    ? Number(args.caseId)
    : null;
  const phone = args.phone || null;
  const caseIdParam = caseIdNum != null ? String(caseIdNum) : "phone";
  const enabled = Boolean(domain && (caseIdNum != null || phone));
  return useQuery({
    queryKey: [
      ...queryKeys.cx.all(),
      "comm-log",
      domain,
      caseIdNum,
      phone,
      args.limit ?? null,
    ],
    queryFn: () =>
      api
        .get<{ ok: true; result: CommLogResult }>(
          `/api/read/cx/case/${domain}/${caseIdParam}/comm-log`,
          {
            query: {
              phone: phone ?? undefined,
              limit: args.limit ?? undefined,
            },
          },
        )
        .then((r) => r.result),
    enabled,
    staleTime: 10_000,
  });
}

/**
 * Logics invoices for a case. Same on-demand pattern as activities.
 */
export function useCxCaseInvoices(domain: string, caseId: number | null | undefined) {
  return useQuery({
    queryKey: [...queryKeys.cx.all(), "case-invoices", domain, caseId],
    queryFn: () =>
      api
        .get<{ ok: true; result: unknown }>(
          `/api/read/cx/case/${domain}/${caseId}/invoices`,
        )
        .then((r) => r.result),
    enabled: Boolean(domain && caseId != null && Number(caseId) > 0),
    staleTime: 15_000,
  });
}

/**
 * Multi-candidate lookup — returns every phone match across domains ×
 * tiers (Logics top-3 by createDate per domain + Mongo CaseProfile /
 * MasterProspect / LeadCadence per domain). Powers the "found in N
 * places, pick one" buttons in the CX identity strip.
 */
export function useCxLeadCandidates(
  domain: string,
  args: {
    phone?: string | null;
    caseId?: number | null;
    skipLogics?: boolean;
    domainFallback?: string[] | null;
    nameSearch?: {
      firstName?: string;
      lastName?: string;
      address?: string;
      city?: string;
      state?: string;
      zip?: string;
    } | null;
    enabled?: boolean;
  } = {},
) {
  const phone = (args.phone || "").replace(/\D/g, "");
  const caseId = args.caseId != null ? Number(args.caseId) : null;
  const fallback =
    args.domainFallback ??
    (caseId == null && phone ? ["WYNN", "TAG"] : ["WYNN", "TAG"]);
  // Only include nameSearch fields if at least one is non-empty —
  // keeps the queryKey stable between empty-vs-present states.
  const ns = args.nameSearch || {};
  const nsParams: Record<string, string> = {};
  for (const [k, v] of Object.entries(ns)) {
    const trimmed = String(v || "").trim();
    if (trimmed) nsParams[k] = trimmed;
  }
  const hasNameSearch = Object.keys(nsParams).length > 0;
  return useQuery({
    queryKey: [
      ...queryKeys.cx.all(),
      "lookup-candidates",
      domain,
      phone || null,
      caseId,
      Boolean(args.skipLogics),
      fallback ? fallback.join(",") : null,
      hasNameSearch ? JSON.stringify(nsParams) : null,
    ],
    queryFn: () =>
      api
        .get<{ ok: true; result: CxLeadCandidatesResult }>(
          `/api/read/cx/lookup-candidates/${domain}`,
          {
            query: {
              phone: phone || undefined,
              caseId: caseId != null ? caseId : undefined,
              skipLogics: args.skipLogics ? "true" : undefined,
              domainFallback: fallback ? fallback.join(",") : undefined,
              ...nsParams,
            },
          },
        )
        .then((r) => r.result),
    enabled: Boolean(
      (args.enabled ?? true)
      && domain &&
      (phone.length >= 7 ||
        (caseId != null && caseId > 0) ||
        hasNameSearch),
    ),
    staleTime: 30_000,
  });
}

/**
 * Logics tasks for a single case. Backed by `getTasksByDateRange` on
 * Logics + server-side caseId filter (Logics has no per-case task
 * endpoint). Replaces the agent-scoped useCxTasks for case-detail view.
 */
export function useCxCaseTasks(domain: string, caseId: number | null | undefined) {
  return useQuery({
    queryKey: [...queryKeys.cx.all(), "case-tasks", domain, caseId],
    queryFn: () =>
      api
        .get<{ ok: true; result: unknown }>(
          `/api/read/cx/case/${domain}/${caseId}/tasks`,
        )
        .then((r) => r.result),
    enabled: Boolean(domain && caseId != null && Number(caseId) > 0),
    staleTime: 15_000,
  });
}

/**
 * Logics payments for a case (read-only). CX agents see these but
 * don't post payments from here — that lives in finance.
 */
export function useCxCasePayments(domain: string, caseId: number | null | undefined) {
  return useQuery({
    queryKey: [...queryKeys.cx.all(), "case-payments", domain, caseId],
    queryFn: () =>
      api
        .get<{ ok: true; result: unknown }>(
          `/api/read/cx/case/${domain}/${caseId}/payments`,
        )
        .then((r) => r.result),
    enabled: Boolean(domain && caseId != null && Number(caseId) > 0),
    staleTime: 15_000,
  });
}

export function useCxLogicsMatch(domain: string, needle: string) {
  return useQuery({
    queryKey: queryKeys.cx.logicsMatch(domain, needle),
    queryFn: () =>
      api
        .get<{ ok: true; result: { domain: string; phone?: string | null; caseId?: number | null; result: unknown } }>(
          `/api/read/cx/logics/match/${domain}`,
          { query: { phone: needle } },
        )
        .then((r) => r.result),
    enabled: Boolean(domain && needle.trim().length >= 7),
    staleTime: 10_000,
  });
}

export function useCxLogicsTasks(domain: string, startDate: string, endDate: string, enabled = false) {
  return useQuery({
    queryKey: queryKeys.cx.logicsTasks(domain, startDate, endDate),
    queryFn: () =>
      api
        .get<{ ok: true; result: { domain: string; startDate: string; endDate: string; result: unknown } }>(
          `/api/read/cx/logics/tasks/${domain}`,
          { query: { startDate, endDate } },
        )
        .then((r) => r.result),
    enabled: Boolean(domain && enabled && startDate && endDate),
    staleTime: 10_000,
  });
}

function buildCxCommandHook(pathBuilder: (domain: string) => string) {
  return function useCxCommand(domain: string) {
    const qc = useQueryClient();
    return useMutation({
      mutationFn: (body: Record<string, unknown>) =>
        api
          .post<{ ok: true; result: CxCommandResult }>(pathBuilder(domain), body)
          .then((r) => r.result),
      onSuccess: () => invalidateCxScope(qc, domain),
    });
  };
}

export const useCxSetStatus = buildCxCommandHook((domain) => `/api/commands/cx/${domain}/set-status`);
export const useCxDisposition = buildCxCommandHook((domain) => `/api/commands/cx/${domain}/disposition`);
export const useCxCreateTask = buildCxCommandHook((domain) => `/api/commands/cx/${domain}/create-task`);
export const useCxCreateReminder = buildCxCommandHook((domain) => `/api/commands/cx/${domain}/create-reminder`);
export const useCxText = buildCxCommandHook((domain) => `/api/commands/cx/${domain}/text`);
export const useCxEmail = buildCxCommandHook((domain) => `/api/commands/cx/${domain}/email`);
export const useCxAssignCaseToMe = buildCxCommandHook((domain) => `/api/commands/cx/${domain}/assign-case-to-me`);
export const useCxDial = buildCxCommandHook((domain) => `/api/commands/cx/${domain}/dial`);
export const useCxEndCall = buildCxCommandHook((domain) => `/api/commands/cx/${domain}/end-call`);
// Domain-per-call variant. Use when the dial target's domain may differ from
// the workspace's currently-rendered domain — e.g. clicking a WYNN queue item
// while the UCQ is showing both TAG+WYNN and the workspace state hasn't yet
// flipped from TAG to WYNN. Mirrors useCxSimulateCallAny so the same site
// can drive either path without a stale-domain race.
export function useCxDialAny() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ domain, ...body }: { domain: string } & Record<string, unknown>) =>
      api
        .post<{ ok: true; result: CxCommandResult }>(
          `/api/commands/cx/${String(domain || "").toUpperCase()}/dial`,
          body,
        )
        .then((r) => r.result),
    onSuccess: (_result, vars) => {
      if (vars?.domain) invalidateCxScope(qc, String(vars.domain).toUpperCase());
    },
  });
}
export function useCxSimulateCall(domain: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api
        .post<{ ok: true; result: unknown }>(`/api/commands/cx/${domain}/simulate-call`, body)
        .then((r) => r.result),
    onSuccess: () => invalidateCxScope(qc, domain),
  });
}
export function useCxSimulateCallAny() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ domain, ...body }: { domain: string } & Record<string, unknown>) =>
      api
        .post<{ ok: true; result: unknown }>(`/api/commands/cx/${domain}/simulate-call`, body)
        .then((r) => r.result),
    onSuccess: (_result, vars) => {
      if (vars?.domain) invalidateCxScope(qc, String(vars.domain).toUpperCase());
    },
  });
}
export const useCxLogicsCreateCase = buildCxCommandHook((domain) => `/api/commands/cx/${domain}/logics/create-case`);
export const useCxSaveCaseProfile = buildCxCommandHook((domain) => `/api/commands/cx/${domain}/save-case-profile`);
export const useCxLogicsFindMatch = buildCxCommandHook((domain) => `/api/commands/cx/${domain}/logics/find-match`);
export const useCxLogicsUpdateStatus = buildCxCommandHook((domain) => `/api/commands/cx/${domain}/logics/update-status`);
export const useCxLogicsTask = buildCxCommandHook((domain) => `/api/commands/cx/${domain}/logics/task`);
export const useCxLogicsActivity = buildCxCommandHook((domain) => `/api/commands/cx/${domain}/logics/activity`);
export const useCxLogicsUpdateCase = buildCxCommandHook((domain) => `/api/commands/cx/${domain}/logics/update-case`);
export const useCxLogicsNotes = buildCxCommandHook((domain) => `/api/commands/cx/${domain}/logics/notes`);
export const useCxLogicsInvoice = buildCxCommandHook((domain) => `/api/commands/cx/${domain}/logics/invoice`);
export const useCxLogicsAmortization = buildCxCommandHook((domain) => `/api/commands/cx/${domain}/logics/amortization`);

export function flattenCxSearch(data?: CxSearchData): ClientSearchMatch[] {
  return data?.merged || [];
}
