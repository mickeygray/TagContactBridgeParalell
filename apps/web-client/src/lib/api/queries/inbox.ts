import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import type {
  ConversationMessage,
  ConversationMessageDispositionLabel,
  InboxCommandResult,
  InboxThreadMessagesResponse,
  InboxWorkspaceData,
  OkEnvelope,
} from "@/lib/api/types";
import { queryKeys } from "@/lib/api/queries/keys";

export function useInboxWorkspace(
  domain: string,
  filters: {
    status?: string;
    channel?: string;
    search?: string;
    workflow?: string;
    family?: string;
    limit?: number;
    includeAutoResponded?: boolean;
  } = {},
) {
  return useQuery({
    queryKey: queryKeys.inbox.workspace(domain, filters),
    queryFn: () =>
      api
        .get<OkEnvelope<InboxWorkspaceData>>(`/api/read/inbox/${domain}`, {
          query: {
            ...filters,
            includeAutoResponded: filters.includeAutoResponded ? "true" : undefined,
          },
        })
        .then((env) => env.result),
    enabled: Boolean(domain),
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
}

// Per-turn message history for one thread. Fires only when a workflow
// is selected in the UI so we don't thrash the backend for every
// keystroke. Polled less aggressively than the thread-list summary.
export function useInboxThreadMessages(
  domain: string,
  workflowId: string | null,
  options: { limit?: number } = {},
) {
  return useQuery({
    queryKey: workflowId
      ? [...queryKeys.inbox.all(), "messages", domain, workflowId, options.limit ?? 200]
      : [...queryKeys.inbox.all(), "messages", "none"],
    queryFn: () =>
      api
        .get<OkEnvelope<InboxThreadMessagesResponse>>(
          `/api/read/inbox/${domain}/threads/${workflowId}/messages`,
          { query: { limit: options.limit ?? 200 } },
        )
        .then((env) => env.result),
    enabled: Boolean(domain && workflowId),
    staleTime: 5_000,
    refetchInterval: 20_000,
  });
}

function invalidateInboxScope(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: queryKeys.inbox.all() });
  qc.invalidateQueries({ queryKey: queryKeys.review.all() });
  qc.invalidateQueries({ queryKey: queryKeys.workflows.all() });
}

function buildInboxCommandHook(
  pathBuilder: (domain: string, workflowId: string) => string,
) {
  return function useInboxCommand(domain: string) {
    const qc = useQueryClient();
    return useMutation({
      mutationFn: ({
        workflowId,
        ...body
      }: {
        workflowId: string;
        note?: string;
        reason?: string;
        draft?: string;
        seed?: string;
        sleepUntil?: string;
      }) =>
        api
          .post<OkEnvelope<InboxCommandResult>>(pathBuilder(domain, workflowId), body)
          .then((env) => env.result),
      onSuccess: () => invalidateInboxScope(qc),
    });
  };
}

export const useInboxApprove = buildInboxCommandHook(
  (domain, workflowId) => `/api/commands/inbox/${domain}/${workflowId}/approve`,
);
export const useInboxCancel = buildInboxCommandHook(
  (domain, workflowId) => `/api/commands/inbox/${domain}/${workflowId}/cancel`,
);
export const useInboxEditSend = buildInboxCommandHook(
  (domain, workflowId) => `/api/commands/inbox/${domain}/${workflowId}/edit-send`,
);
export const useInboxRegenerate = buildInboxCommandHook(
  (domain, workflowId) => `/api/commands/inbox/${domain}/${workflowId}/regenerate`,
);
export const useInboxSleep = buildInboxCommandHook(
  (domain, workflowId) => `/api/commands/inbox/${domain}/${workflowId}/sleep`,
);
export const useInboxWake = buildInboxCommandHook(
  (domain, workflowId) => `/api/commands/inbox/${domain}/${workflowId}/wake`,
);
export const useInboxDnc = buildInboxCommandHook(
  (domain, workflowId) => `/api/commands/inbox/${domain}/${workflowId}/dnc`,
);

// Per-message disposition — independent of workflow status. Operator
// can tag individual messages as hostile / spam / wrong-number without
// flipping the thread state. See `DISPOSITION_LABELS` on the backend
// route for the allowed label set.
export function useInboxMessageDisposition(_domain: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      messageId,
      label,
      note,
    }: {
      messageId: string;
      label: ConversationMessageDispositionLabel;
      note?: string;
    }) =>
      api
        .post<OkEnvelope<ConversationMessage>>(
          `/api/commands/inbox/messages/${messageId}/disposition`,
          { label, note },
        )
        .then((env) => env.result),
    onSuccess: () => {
      invalidateInboxScope(qc);
    },
  });
}
