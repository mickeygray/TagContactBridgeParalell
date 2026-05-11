import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import type {
  OkEnvelope,
  ReviewQueueItem,
  ReviewQueueOverview,
} from "@/lib/api/types";
import { queryKeys } from "@/lib/api/queries/keys";

export function useReviewOverview(domain: string) {
  return useQuery({
    queryKey: queryKeys.review.overview(domain),
    queryFn: () =>
      api
        .get<OkEnvelope<{ domain: string; counts?: Record<string, number> }>>(
          `/api/read/review/overview/${domain}`,
        )
        .then((env) => ({
          domain: env.result.domain,
          openCount: env.result.counts?.open ?? 0,
          completedCount: env.result.counts?.reviewed ?? 0,
          failedCount: env.result.counts?.critical ?? 0,
          categories: [
            { key: "warning", count: env.result.counts?.warning ?? 0, label: "Warning" },
            { key: "critical", count: env.result.counts?.critical ?? 0, label: "Critical" },
          ],
        } satisfies ReviewQueueOverview)),
    enabled: Boolean(domain),
    staleTime: 30_000,
  });
}

interface QueuePage {
  items: ReviewQueueItem[];
  total?: number;
  filters?: Record<string, unknown>;
}

export function useReviewQueue(
  domain: string,
  filters: { status?: string; category?: string; limit?: number } = {},
) {
  return useQuery({
    queryKey: queryKeys.review.queue(domain, filters),
    queryFn: () =>
      api
        .get<OkEnvelope<Array<Record<string, unknown>>>>(`/api/read/review/queue/${domain}`, {
          query: filters,
        })
        .then((env) => ({
          items: (env.result ?? []).map((item) => ({
            ...(item as ReviewQueueItem),
            id:
              String(
                (item as { id?: string; _id?: string }).id ||
                (item as { _id?: string })._id ||
                `${String((item as { category?: string }).category || "review")}::${String((item as { caseId?: string | number }).caseId || "na")}::${String((item as { createdAt?: string }).createdAt || "now")}`,
              ),
          })),
          total: env.result?.length ?? 0,
          filters,
        } satisfies QueuePage)),
    enabled: Boolean(domain),
    staleTime: 15_000,
  });
}
