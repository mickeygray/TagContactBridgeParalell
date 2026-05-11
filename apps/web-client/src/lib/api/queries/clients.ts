import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import type {
  ClientDetail,
  ClientCaseCall,
  ClientCaseMessage,
  ClientCommandResult,
  ClientListResponse,
  ClientListItem,
  ClientSearchMatch,
  OkEnvelope,
} from "@/lib/api/types";
import { presentImportantWorkflowRecords } from "@/lib/events/presentation";
import { queryKeys } from "@/lib/api/queries/keys";

interface RawSearchResult {
  domain: string;
  prospects?: Array<Record<string, unknown>>;
  caseProfiles?: Array<Record<string, unknown>>;
}

interface RawClientDetail {
  domain: string;
  caseId: number;
  prospect?: Record<string, unknown> | null;
  caseProfile?: Record<string, unknown> | null;
  cadence?: Record<string, unknown> | null;
  attribution?: Record<string, unknown> | null;
  availableSources?: Array<Record<string, unknown>>;
  payments?: Array<Record<string, unknown>>;
  scrubSummary?: Record<string, unknown> | null;
  reviewItems?: Array<Record<string, unknown>>;
  latestActivityReview?: Record<string, unknown> | null;
  latestQualityReview?: Record<string, unknown> | null;
  latestConversationWorkflow?: Record<string, unknown> | null;
  recentWorkflowStages?: Array<Record<string, unknown>>;
  calls?: Array<Record<string, unknown>>;
  textChain?: Array<Record<string, unknown>>;
}

function getDisplayName(raw: Record<string, unknown> | null | undefined): string | undefined {
  if (!raw) return undefined;
  const direct = [raw.name, raw.fullName, raw.primaryName].find(Boolean);
  if (typeof direct === "string") return direct;
  const first = typeof raw.firstName === "string" ? raw.firstName : "";
  const last = typeof raw.lastName === "string" ? raw.lastName : "";
  const joined = [first, last].filter(Boolean).join(" ").trim();
  return joined || undefined;
}

function getDisplayPhone(raw: Record<string, unknown> | null | undefined): string | undefined {
  if (!raw) return undefined;
  return [raw.primaryPhone, raw.cellPhone, raw.homePhone, raw.workPhone, raw.phone]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function getDisplayEmail(raw: Record<string, unknown> | null | undefined): string | undefined {
  if (!raw) return undefined;
  return [raw.email, raw.primaryEmail]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function getDisplayStatus(caseProfile?: Record<string, unknown> | null, prospect?: Record<string, unknown> | null): string | undefined {
  return [caseProfile?.statusLabel, caseProfile?.status, prospect?.statusCategory, prospect?.status]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeClientScrubSummary(value: unknown): ClientDetail["scrubSummary"] {
  const raw = toRecord(value);
  if (!raw) return null;
  const providers = toRecord(raw.providers);
  return {
    status: typeof raw.status === "string" ? raw.status : null,
    reviewedAt: typeof raw.reviewedAt === "string" ? raw.reviewedAt : null,
    actorEmail: typeof raw.actorEmail === "string" ? raw.actorEmail : null,
    activityReviewStatus:
      typeof raw.activityReviewStatus === "string" ? raw.activityReviewStatus : null,
    activityReviewConfidence:
      typeof raw.activityReviewConfidence === "string" ? raw.activityReviewConfidence : null,
    activityReviewError:
      typeof raw.activityReviewError === "string" ? raw.activityReviewError : null,
    providers: providers
      ? {
          activities: toRecord(providers.activities),
          payments: toRecord(providers.payments),
          invoices: toRecord(providers.invoices),
          billingSummary: toRecord(providers.billingSummary),
        }
      : null,
  };
}

export function useClientSearch(domain: string, q: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.clients.search(domain, q),
    queryFn: () =>
      api
        .get<OkEnvelope<RawSearchResult>>(`/api/read/clients/search/${domain}`, {
          query: { search: q },
        })
        .then((env) => {
          const byCaseId = new Map<string, ClientSearchMatch>();
          const prospects = env.result.prospects ?? [];
          const caseProfiles = env.result.caseProfiles ?? [];

          for (const raw of [...prospects, ...caseProfiles]) {
            const caseId = String(raw.caseId ?? "");
            if (!caseId) continue;
            const current = byCaseId.get(caseId) ?? { caseId, domain: env.result.domain };
            byCaseId.set(caseId, {
              ...current,
              name: current.name ?? getDisplayName(raw),
              phone: current.phone ?? getDisplayPhone(raw),
              email: current.email ?? getDisplayEmail(raw),
              status:
                current.status ??
                (typeof raw.status === "string" ? raw.status : undefined) ??
                (typeof raw.statusLabel === "string" ? raw.statusLabel : undefined),
            });
          }

          return [...byCaseId.values()];
        }),
    enabled: enabled && Boolean(domain) && q.trim().length >= 2,
    staleTime: 10_000,
  });
}

type ClientListFilters = {
  search?: string;
  status?: string;
  statusCategory?: string;
  sortBy?: string;
  sortDir?: string;
  activeCadence?: string;
  hasPayments?: string;
  aiStatus?: string;
  limit?: number;
};

export function useClientList(domain: string, filters: ClientListFilters = {}) {
  return useQuery({
    queryKey: queryKeys.clients.list(domain, filters),
    queryFn: () =>
      api
        .get<OkEnvelope<ClientListResponse>>(`/api/read/clients/list/${domain}`, {
          query: filters,
        })
        .then((env) => ({
          ...env.result,
          items: (env.result.items ?? []).map((item) => ({
            ...item,
            caseId: String(item.caseId),
          })) as ClientListItem[],
        })),
    enabled: Boolean(domain),
    staleTime: 15_000,
  });
}

export function useClientDetail(domain: string, caseId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.clients.detail(domain, caseId ?? ""),
    queryFn: () =>
      api
        .get<OkEnvelope<RawClientDetail>>(`/api/read/clients/case/${domain}/${caseId}`)
        .then((env) => {
          const result = env.result;
          const prospect = result.prospect ?? null;
          const caseProfile = result.caseProfile ?? null;
          const cadence = result.cadence ?? null;
          const workflow = result.latestConversationWorkflow ?? null;
          const scrubSummary = normalizeClientScrubSummary(result.scrubSummary);

          return {
            domain: result.domain,
            caseId: String(result.caseId),
            name: getDisplayName(caseProfile) ?? getDisplayName(prospect),
            phone: getDisplayPhone(caseProfile) ?? getDisplayPhone(prospect),
            email: getDisplayEmail(caseProfile) ?? getDisplayEmail(prospect),
            status: getDisplayStatus(caseProfile, prospect),
            statusId:
              typeof caseProfile?.statusId === "string"
                ? caseProfile.statusId
                : typeof caseProfile?.statusId === "number"
                  ? String(caseProfile.statusId)
                  : undefined,
            intakeSource:
              (typeof cadence?.intakeSource === "string" && cadence.intakeSource) ||
              (typeof prospect?.intakeSource === "string" && prospect.intakeSource) ||
              undefined,
            intakeDate:
              (typeof prospect?.createdAt === "string" && prospect.createdAt) ||
              (typeof caseProfile?.createdAt === "string" && caseProfile.createdAt) ||
              undefined,
            prospect: prospect ?? undefined,
            timeline: presentImportantWorkflowRecords(result.recentWorkflowStages ?? []),
            enrichment: {
              cadenceActive: cadence?.active ?? undefined,
              intakeRoute:
                typeof cadence?.intakeRoute === "string" ? cadence.intakeRoute : undefined,
              reviewItemCount: result.reviewItems?.length ?? 0,
              conversationStatus:
                typeof workflow?.status === "string" ? workflow.status : undefined,
              qualityStatus:
                typeof result.latestQualityReview?.status === "string"
                  ? result.latestQualityReview.status
                  : undefined,
              activityAiStatus:
                typeof result.latestActivityReview?.status === "string"
                  ? result.latestActivityReview.status
                  : undefined,
            },
            attribution: result.attribution ?? null,
            availableSources: result.availableSources ?? [],
            payments: result.payments ?? [],
            scrubSummary,
            activityAiReview: result.latestActivityReview ?? null,
            qualityReview: result.latestQualityReview ?? null,
            conversationSummary: workflow ?? null,
            calls: (result.calls ?? []) as unknown as ClientCaseCall[],
            textChain: (result.textChain ?? []) as unknown as ClientCaseMessage[],
          } satisfies ClientDetail;
        }),
    enabled: Boolean(domain) && Boolean(caseId),
    staleTime: 15_000,
  });
}

function invalidateClientScope(qc: ReturnType<typeof useQueryClient>, domain: string, caseId?: string | null) {
  qc.invalidateQueries({ queryKey: queryKeys.clients.all() });
  if (caseId) {
    qc.invalidateQueries({ queryKey: queryKeys.clients.detail(domain, caseId) });
  }
}

function useClientCommandMutation(
  pathBuilder: (domain: string, caseId: string) => string,
  domain: string,
) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: ({
      caseId,
      body,
    }: {
      caseId: string;
      body?: Record<string, unknown>;
    }) =>
      api
        .post<OkEnvelope<ClientCommandResult>>(pathBuilder(domain, caseId), body ?? {})
        .then((env) => env.result),
    onSuccess: (_result, variables) => invalidateClientScope(qc, domain, variables.caseId),
  });
}

export function useClientText(domain: string) {
  return useClientCommandMutation(
    (nextDomain, caseId) => `/api/commands/clients/${nextDomain}/${caseId}/text`,
    domain,
  );
}

export function useClientEmail(domain: string) {
  return useClientCommandMutation(
    (nextDomain, caseId) => `/api/commands/clients/${nextDomain}/${caseId}/email`,
    domain,
  );
}

export function useClientDial(domain: string) {
  return useClientCommandMutation(
    (nextDomain, caseId) => `/api/commands/clients/${nextDomain}/${caseId}/dial`,
    domain,
  );
}

export function useClientUpdateStatus(domain: string) {
  return useClientCommandMutation(
    (nextDomain, caseId) => `/api/commands/clients/${nextDomain}/${caseId}/update-status`,
    domain,
  );
}

export function useClientDnc(domain: string) {
  return useClientCommandMutation(
    (nextDomain, caseId) => `/api/commands/clients/${nextDomain}/${caseId}/dnc`,
    domain,
  );
}

export function useClientSetSource(domain: string) {
  return useClientCommandMutation(
    (nextDomain, caseId) => `/api/commands/clients/${nextDomain}/${caseId}/set-source`,
    domain,
  );
}

export function useClientRunScrub(domain: string) {
  return useClientCommandMutation(
    (nextDomain, caseId) => `/api/commands/clients/${nextDomain}/${caseId}/run-scrub`,
    domain,
  );
}
