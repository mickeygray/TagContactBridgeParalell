import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import type { HealthStatus } from "@/lib/api/types";
import { queryKeys } from "@/lib/api/queries/keys";

export function useControlPlaneHealth() {
  return useQuery({
    queryKey: queryKeys.health.controlPlane(),
    queryFn: () => api.get<HealthStatus>("/api/health/control-plane"),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}

export function useServicesHealth() {
  return useQuery({
    queryKey: queryKeys.health.services(),
    queryFn: () => api.get<HealthStatus>("/api/health/services"),
    staleTime: 15_000,
    refetchInterval: 60_000,
  });
}
