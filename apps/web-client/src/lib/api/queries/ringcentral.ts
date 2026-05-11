import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import type {
  CallLogResponse,
  HealthStatus,
  OkEnvelope,
  RingBridgeWorkspaceData,
  RingCentralPresence,
  RingcentralPollingRuntime,
  WorkflowRecord,
} from "@/lib/api/types";
import { queryKeys } from "@/lib/api/queries/keys";

export function useRingCentralPresence(domain: string, pollMs = 5_000) {
  return useQuery({
    queryKey: queryKeys.ringcentral.presence(domain),
    queryFn: () =>
      api
        .get<OkEnvelope<RingCentralPresence>>(
          `/api/read/ringcentral/presence/${domain}`,
        )
        .then((env) => env.result),
    enabled: Boolean(domain),
    staleTime: 2_000,
    refetchInterval: pollMs,
  });
}

export function useRingBridgeWorkspace(domain: string, pollMs = 10_000) {
  return useQuery({
    queryKey: queryKeys.ringcentral.workspace(domain),
    queryFn: () =>
      api
        .get<OkEnvelope<RingBridgeWorkspaceData>>(
          `/api/read/ringcentral/workspace/${domain}`,
        )
        .then((env) => env.result),
    enabled: Boolean(domain),
    staleTime: 5_000,
    refetchInterval: pollMs,
  });
}

export function useRingCentralEvents(
  domain: string,
  filters: {
    subtype?: string;
    stage?: string;
    aggregateType?: string;
    aggregateId?: string;
    caseId?: string;
    limit?: number;
  } = {},
) {
  return useQuery({
    queryKey: queryKeys.ringcentral.events(domain, filters),
    queryFn: () =>
      api
        .get<OkEnvelope<WorkflowRecord[]>>(`/api/read/ringcentral/events/${domain}`, {
          query: filters,
        })
        .then((env) => env.result),
    enabled: Boolean(domain),
    staleTime: 5_000,
    refetchInterval: 10_000,
  });
}

export function useRingCentralStatus() {
  return useQuery({
    queryKey: queryKeys.ringcentral.status(),
    queryFn: () => api.get<HealthStatus>("/api/ringcentral/status"),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}

export function useRingCentralCallLog(
  domain: string,
  filters: {
    limit?: number;
    direction?: string;
    outcome?: string;
    extensionId?: string;
    source?: "native" | "legacy" | "all";
    sinceMs?: number;
  } = {},
  pollMs = 10_000,
) {
  return useQuery({
    queryKey: queryKeys.ringcentral.callLog(domain, filters),
    queryFn: () =>
      api
        .get<OkEnvelope<CallLogResponse>>(`/api/read/ringcentral/call-log/${domain}`, {
          query: filters,
        })
        .then((env) => env.result),
    enabled: Boolean(domain),
    staleTime: 5_000,
    refetchInterval: pollMs,
  });
}

export function useRingCentralRuntime(domain: string, pollMs = 15_000) {
  return useQuery({
    queryKey: queryKeys.ringcentral.runtime(domain),
    queryFn: () =>
      api
        .get<OkEnvelope<RingcentralPollingRuntime>>(
          `/api/read/ringcentral/runtime/${domain}`,
        )
        .then((env) => env.result),
    enabled: Boolean(domain),
    staleTime: 5_000,
    refetchInterval: pollMs,
  });
}
