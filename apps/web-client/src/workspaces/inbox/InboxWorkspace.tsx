import * as React from "react";
import { Inbox, MessageCircleWarning, MessageSquareText, Search, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, KpiCard } from "@/components/ui/Card";
import { CaseLink } from "@/components/ui/CaseLink";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Input, Label } from "@/components/ui/Input";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import { Skeleton, SkeletonRow } from "@/components/ui/Skeleton";
import { StatusPill, toneFromStatus, type StatusTone } from "@/components/ui/StatusPill";
import {
  useInboxApprove,
  useInboxCancel,
  useInboxDnc,
  useInboxEditSend,
  useInboxMessageDisposition,
  useInboxRegenerate,
  useInboxSleep,
  useInboxThreadMessages,
  useInboxWake,
  useInboxWorkspace,
} from "@/lib/api/queries/inbox";
import type {
  ConversationMessage,
  ConversationMessageDispositionLabel,
  ConversationMessageProviderStatus,
} from "@/lib/api/types";
import { cn } from "@/lib/utils/cn";
import { useDomainStore } from "@/lib/domain/domainStore";
import { presentImportantWorkflowRecords } from "@/lib/events/presentation";
import { formatDateTime, formatNumber, formatRelative } from "@/lib/utils/format";

export function InboxWorkspace() {
  const domain = useDomainStore((s) => s.domain);
  const [search, setSearch] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("all");
  const [channelFilter, setChannelFilter] = React.useState("all");
  const deferredSearch = React.useDeferredValue(search);
  const inbox = useInboxWorkspace(domain, {
    limit: 25,
    search: deferredSearch || undefined,
    status: statusFilter === "all" ? undefined : statusFilter,
    channel: channelFilter === "all" ? undefined : channelFilter,
  });
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState("");
  const [note, setNote] = React.useState("");
  const [sleepUntil, setSleepUntil] = React.useState("");
  const [commandMessage, setCommandMessage] = React.useState<string | null>(null);

  const approve = useInboxApprove(domain);
  const cancel = useInboxCancel(domain);
  const editSend = useInboxEditSend(domain);
  const regenerate = useInboxRegenerate(domain);
  const sleep = useInboxSleep(domain);
  const wake = useInboxWake(domain);
  const dnc = useInboxDnc(domain);
  const dispose = useInboxMessageDisposition(domain);

  const workflows = inbox.data?.workflows ?? [];
  const selected =
    workflows.find((workflow) => workflow._id === selectedId) ??
    workflows[0] ??
    null;
  const selectedWorkflowId = selected?._id ?? null;
  const selectedCaseId = selected?.caseId ?? null;
  const selectedSleepUntil =
    typeof selected?.metadata?.sleepUntil === "string" ? selected.metadata.sleepUntil : null;

  const threadMessages = useInboxThreadMessages(domain, selectedWorkflowId, { limit: 200 });

  const scopedReviewItems = React.useMemo(() => {
    const items = inbox.data?.recentReviewItems ?? [];
    if (!selected) return items.slice(0, 5);
    return items
      .filter((item) => {
        if (selectedCaseId && Number(item.caseId) === Number(selectedCaseId)) return true;
        return (item as { payload?: { workflowId?: string } }).payload?.workflowId === selectedWorkflowId;
      })
      .slice(0, 5);
  }, [inbox.data?.recentReviewItems, selected, selectedCaseId, selectedWorkflowId]);

  const scopedWorkflowStages = React.useMemo(() => {
    const stages = inbox.data?.recentWorkflowStages ?? [];
    const filtered = !selected ? stages : stages
      .filter((stage) => {
        if (selectedWorkflowId && stage.aggregateId === selectedWorkflowId) return true;
        if (selectedCaseId && Number(stage.caseId) === Number(selectedCaseId)) return true;
        return false;
      });
    return presentImportantWorkflowRecords(filtered, 5);
  }, [inbox.data?.recentWorkflowStages, selected, selectedCaseId, selectedWorkflowId]);

  React.useEffect(() => {
    if (selected?._id) {
      setDraft(selected.aiDraftReply ?? "");
      setSelectedId(selected._id);
    }
  }, [selected?._id, selected?.aiDraftReply]);

  async function runCommand(
    action: () => Promise<{ action: string; status: string; sleepUntil?: string | Date | null }>,
  ) {
    try {
      const result = await action();
      setCommandMessage(`${result.action} saved (${result.status})`);
      if (result.sleepUntil) {
        setSleepUntil(String(result.sleepUntil).slice(0, 16));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Command failed";
      setCommandMessage(message);
    }
  }

  return (
    <div className="space-y-8">
      <SectionHeader
        eyebrow="Workspace"
        title="SMS Inbox"
        description="Conversation workflows, AI drafts, opt-outs, and manual review items, all read and steered through 5001."
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Observed" value={formatNumber(inbox.data?.counts.observed)} icon={<Inbox className="h-4 w-4" />} />
        <KpiCard label="Drafted" value={formatNumber(inbox.data?.counts.drafted)} icon={<MessageSquareText className="h-4 w-4" />} />
        <KpiCard label="Manual review" value={formatNumber(inbox.data?.counts.manualReview)} icon={<MessageCircleWarning className="h-4 w-4" />} />
        <KpiCard label="Opt outs" value={formatNumber(inbox.data?.counts.optOutDetected)} icon={<ShieldAlert className="h-4 w-4" />} />
      </div>

      {inbox.isError ? <ErrorState error={inbox.error} onRetry={() => inbox.refetch()} /> : null}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(300px,340px)_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Conversations</CardTitle>
            <CardDescription>Search and filter the live inbox before taking action on a thread.</CardDescription>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="mb-4 grid grid-cols-1 gap-3">
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search phone, case id, or message text"
                leadingIcon={<Search />}
              />
              <div className="grid grid-cols-2 gap-3">
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger>
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    <SelectItem value="observed">Observed</SelectItem>
                    <SelectItem value="drafted">Drafted</SelectItem>
                    <SelectItem value="manual-review">Manual review</SelectItem>
                    <SelectItem value="suppressed">Suppressed</SelectItem>
                    <SelectItem value="closed">Closed</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={channelFilter} onValueChange={setChannelFilter}>
                  <SelectTrigger>
                    <SelectValue placeholder="Channel" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All channels</SelectItem>
                    <SelectItem value="sms">SMS</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {inbox.isLoading ? (
              <SkeletonRow count={5} />
            ) : workflows.length === 0 ? (
              <EmptyState
                icon={<Inbox />}
                title={`No conversations for ${domain}`}
                description="Conversation workflows will appear here once inbound SMS events are flowing into 5001."
              />
            ) : (
              <ul className="space-y-1">
                {workflows.map((workflow) => (
                  <li key={workflow._id ?? `${workflow.phone}-${workflow.caseId}`}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(workflow._id ?? null)}
                      className="w-full rounded-md border border-transparent px-3 py-2 text-left transition-colors hover:bg-muted"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="truncate text-sm font-medium">
                          {workflow.phone ?? `Case ${workflow.caseId ?? "unknown"}`}
                        </div>
                        <StatusPill tone={toneFromStatus(workflow.status)}>
                          {workflow.status ?? "observed"}
                        </StatusPill>
                      </div>
                      <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                        {workflow.latestInboundText ?? workflow.aiSummary ?? "No message preview yet."}
                      </div>
                      <div className="mt-1 text-[11px] text-muted-foreground">
                        {workflow.latestInboundAt ? formatRelative(workflow.latestInboundAt) : "Awaiting inbound activity"}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Thread</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {!selected ? (
              <EmptyState
                title="Pick a conversation"
                description="Select a workflow to inspect AI recommendations, drafts, and review context."
              />
            ) : (
              <div className="space-y-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-lg font-semibold">{selected.phone ?? "Conversation"}</div>
                    <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
                      {selected.caseId ? (
                        <CaseLink caseId={selected.caseId} domain={domain} />
                      ) : (
                        <span>No case linked yet</span>
                      )}
                      {selected.channel ? <span>· {selected.channel.toUpperCase()}</span> : null}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {(() => {
                      const chip = autoResponderChip(selected.aiRecommendedAction ?? null);
                      return chip ? (
                        <StatusPill tone={chip.tone}>{chip.label}</StatusPill>
                      ) : null;
                    })()}
                    <StatusPill tone={toneFromStatus(selected.status)}>{selected.status ?? "observed"}</StatusPill>
                  </div>
                </div>

                <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
                  <Field label="AI action" value={selected.aiRecommendedAction ?? "-"} />
                  <Field label="AI confidence" value={selected.aiConfidence ?? "-"} />
                  <Field label="Latest inbound" value={selected.latestInboundAt ? formatDateTime(selected.latestInboundAt) : "-"} />
                  <Field label="Opt out" value={selected.optOutDetected ? "yes" : "no"} />
                </dl>

                {selectedSleepUntil ? (
                  <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                    Snoozed until {formatDateTime(selectedSleepUntil)}
                  </div>
                ) : null}

                <Section title="Conversation">
                  <ThreadMessageList
                    isPending={threadMessages.isPending}
                    isError={threadMessages.isError}
                    messages={threadMessages.data?.messages ?? []}
                    fallbackInbound={selected.latestInboundText ?? null}
                    fallbackInboundAt={selected.latestInboundAt ?? null}
                    onDisposition={(messageId, label) =>
                      dispose
                        .mutateAsync({ messageId, label, note: note || undefined })
                        .then((updated) => {
                          setCommandMessage(`Disposition saved: ${updated.disposition?.label ?? label}`);
                        })
                        .catch((error: unknown) => {
                          setCommandMessage(
                            error instanceof Error ? error.message : "Disposition failed",
                          );
                        })
                    }
                    pendingDispositionId={
                      dispose.isPending && dispose.variables ? dispose.variables.messageId : null
                    }
                  />
                </Section>

                {(selected.aiFlags ?? []).length > 0 ? (
                  <Section title="Flags">
                    <div className="flex flex-wrap gap-2">
                      {(selected.aiFlags ?? []).map((flag) => (
                        <StatusPill key={flag} tone="warning">
                          {flag}
                        </StatusPill>
                      ))}
                    </div>
                  </Section>
                ) : null}

                <Section title="Actions">
                  <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
                    <div className="space-y-3 rounded-md border border-border p-4">
                      <div className="space-y-1">
                        <Label htmlFor="inbox-draft">Draft reply</Label>
                        <textarea
                          id="inbox-draft"
                          value={draft}
                          onChange={(event) => setDraft(event.target.value)}
                          className="min-h-[120px] w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm"
                          placeholder="Edit the SMS draft before approving it."
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="inbox-note">Operator note</Label>
                        <Input
                          id="inbox-note"
                          value={note}
                          onChange={(event) => setNote(event.target.value)}
                          placeholder="Why you changed this thread"
                        />
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          isLoading={approve.isPending}
                          disabled={!selectedWorkflowId}
                          onClick={() =>
                            selectedWorkflowId
                              ? runCommand(() =>
                                  approve.mutateAsync({
                                    workflowId: selectedWorkflowId,
                                    draft,
                                    note,
                                  }),
                                )
                              : undefined
                          }
                        >
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          isLoading={editSend.isPending}
                          disabled={!selectedWorkflowId}
                          onClick={() =>
                            selectedWorkflowId
                              ? runCommand(() =>
                                  editSend.mutateAsync({
                                    workflowId: selectedWorkflowId,
                                    draft,
                                    note,
                                  }),
                                )
                              : undefined
                          }
                        >
                          Save draft
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          isLoading={regenerate.isPending}
                          disabled={!selectedWorkflowId}
                          onClick={() =>
                            selectedWorkflowId
                              ? runCommand(() =>
                                  regenerate.mutateAsync({
                                    workflowId: selectedWorkflowId,
                                    seed: note || draft,
                                  }),
                                )
                              : undefined
                          }
                        >
                          Regenerate
                        </Button>
                      </div>
                    </div>

                    <div className="space-y-3 rounded-md border border-border p-4">
                      <div className="space-y-1">
                        <Label htmlFor="inbox-sleep">Sleep until</Label>
                        <Input
                          id="inbox-sleep"
                          type="datetime-local"
                          value={sleepUntil}
                          onChange={(event) => setSleepUntil(event.target.value)}
                        />
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          isLoading={sleep.isPending}
                          disabled={!selectedWorkflowId}
                          onClick={() =>
                            selectedWorkflowId
                              ? runCommand(() =>
                                  sleep.mutateAsync({
                                    workflowId: selectedWorkflowId,
                                    note,
                                    sleepUntil: sleepUntil || undefined,
                                  }),
                                )
                              : undefined
                          }
                        >
                          Sleep
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          isLoading={wake.isPending}
                          disabled={!selectedWorkflowId}
                          onClick={() =>
                            selectedWorkflowId
                              ? runCommand(() =>
                                  wake.mutateAsync({
                                    workflowId: selectedWorkflowId,
                                    note,
                                  }),
                                )
                              : undefined
                          }
                        >
                          Wake
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          isLoading={cancel.isPending}
                          disabled={!selectedWorkflowId}
                          onClick={() =>
                            selectedWorkflowId
                              ? runCommand(() =>
                                  cancel.mutateAsync({
                                    workflowId: selectedWorkflowId,
                                    note,
                                  }),
                                )
                              : undefined
                          }
                        >
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          isLoading={dnc.isPending}
                          disabled={!selectedWorkflowId}
                          onClick={() =>
                            selectedWorkflowId
                              ? runCommand(() =>
                                  dnc.mutateAsync({
                                    workflowId: selectedWorkflowId,
                                    reason: note || "Marked DNC from inbox",
                                  }),
                                )
                              : undefined
                          }
                        >
                          DNC
                        </Button>
                      </div>
                      <CardDescription>
                        These commands update the workflow, record review history, and leave the thread readable through 5001 even before provider-side automation finishes maturing.
                      </CardDescription>
                      {commandMessage ? (
                        <div className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                          {commandMessage}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </Section>

                <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                  <Section title="Recent review items">
                    {scopedReviewItems.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No review items.</p>
                    ) : (
                      <ul className="space-y-2 text-sm">
                        {scopedReviewItems.map((item, index) => (
                          <li key={`${item.caseId ?? "review"}-${index}`} className="rounded-md border border-border p-3">
                            <div className="font-medium text-foreground">
                              {String(item.title ?? item.category ?? "Review item")}
                            </div>
                            <div className="mt-1 text-xs text-muted-foreground">
                              {item.caseId ? `Case ${String(item.caseId)}` : "No case id"}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Section>

                  <Section title="Recent workflow stages">
                    {scopedWorkflowStages.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No workflow stages yet.</p>
                    ) : (
                      <ul className="space-y-2 text-sm">
                        {scopedWorkflowStages.map((stage, index) => (
                          <li key={`${stage.aggregateId ?? "stage"}-${index}`} className="rounded-md border border-border p-3">
                            <div className="font-medium text-foreground">
                              {[stage.family, stage.subtype, stage.stage].filter(Boolean).join(" · ")}
                            </div>
                            <div className="mt-1 text-xs text-muted-foreground">
                              {stage.happenedAt ? formatDateTime(stage.happenedAt) : "No timestamp"}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Section>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium text-foreground">{value}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function autoResponderChip(
  action: string | null,
): { tone: StatusTone; label: string } | null {
  switch (action) {
    case "auto_dnc_confirm":
      return { tone: "danger", label: "Auto-suppressed" };
    case "auto_callback_prompt":
      return { tone: "info", label: "Auto-callback sent" };
    case "suppress_contact":
      return { tone: "danger", label: "Carrier STOP" };
    default:
      return null;
  }
}

const DISPOSITION_CHIPS: Array<{ label: string; value: ConversationMessageDispositionLabel }> = [
  { label: "Approve draft", value: "approve" },
  { label: "Send as-is", value: "send_as_is" },
  { label: "Regenerate", value: "regenerate" },
  { label: "Mark DNC hard", value: "dnc_hard" },
  { label: "Mark DNC soft", value: "dnc_soft" },
  { label: "Hostile", value: "hostile" },
  { label: "Spam", value: "spam" },
  { label: "Already client", value: "already_client" },
  { label: "Wrong number", value: "wrong_number" },
];

function providerStatusTone(
  status: ConversationMessageProviderStatus | undefined,
): { tone: StatusTone; label: string } | null {
  if (!status) return null;
  switch (status) {
    case "delivered":
      return { tone: "success", label: "delivered" };
    case "failed":
      return { tone: "danger", label: "failed" };
    case "queued":
      return { tone: "warning", label: "queued" };
    case "undelivered":
      return { tone: "warning", label: "undelivered" };
    case "sent":
    default:
      return { tone: "neutral", label: "sent" };
  }
}

function dispositionTone(label: ConversationMessageDispositionLabel | undefined): StatusTone {
  switch (label) {
    case "approve":
    case "send_as_is":
      return "success";
    case "regenerate":
      return "info";
    case "dnc_hard":
    case "dnc_soft":
    case "hostile":
    case "spam":
      return "danger";
    case "already_client":
    case "wrong_number":
      return "warning";
    default:
      return "neutral";
  }
}

function dispositionLabelText(label: ConversationMessageDispositionLabel | undefined): string {
  if (!label) return "";
  return String(label).replace(/_/g, " ");
}

interface ThreadMessageListProps {
  isPending: boolean;
  isError: boolean;
  messages: ConversationMessage[];
  fallbackInbound: string | null;
  fallbackInboundAt: string | null;
  onDisposition: (messageId: string, label: ConversationMessageDispositionLabel) => void;
  pendingDispositionId: string | null;
}

function ThreadMessageList({
  isPending,
  isError,
  messages,
  fallbackInbound,
  fallbackInboundAt,
  onDisposition,
  pendingDispositionId,
}: ThreadMessageListProps) {
  if (isPending) {
    return (
      <div className="space-y-2 rounded-md border border-border p-3">
        <Skeleton className="h-12 w-3/4" />
        <Skeleton className="ml-auto h-12 w-2/3" />
        <Skeleton className="h-12 w-1/2" />
        <p className="text-center text-xs text-muted-foreground">Loading messages…</p>
      </div>
    );
  }

  if (isError) {
    return (
      <p className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
        Failed to load messages.
      </p>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="space-y-3 rounded-md border border-border p-3">
        <p className="text-sm text-muted-foreground">No messages yet.</p>
        {fallbackInbound ? (
          <MessageBubble
            direction="inbound"
            body={fallbackInbound}
            timestamp={fallbackInboundAt}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="max-h-[480px] space-y-4 overflow-y-auto rounded-md border border-border bg-muted/20 p-3">
      {messages.map((msg) => (
        <ThreadMessage
          key={msg.id}
          message={msg}
          onDisposition={onDisposition}
          pendingDispositionId={pendingDispositionId}
        />
      ))}
    </div>
  );
}

interface ThreadMessageProps {
  message: ConversationMessage;
  onDisposition: (messageId: string, label: ConversationMessageDispositionLabel) => void;
  pendingDispositionId: string | null;
}

function ThreadMessage({ message, onDisposition, pendingDispositionId }: ThreadMessageProps) {
  const isInbound = message.direction === "inbound";
  const status = providerStatusTone(message.providerStatus);
  const tier = message.aiClassification?.tier;
  const confidence = message.aiClassification?.confidence;
  const dispLabel = message.disposition?.label ?? null;

  return (
    <div className={cn("flex w-full flex-col", isInbound ? "items-start" : "items-end")}>
      <MessageBubble
        direction={message.direction}
        body={message.body}
        timestamp={message.createdAt}
        autoResponded={!!message.autoResponded}
        actorEmail={!isInbound ? message.approvedByEmail : null}
      />
      <div
        className={cn(
          "mt-1 flex max-w-[85%] flex-wrap items-center gap-1.5 text-[11px]",
          isInbound ? "justify-start" : "justify-end",
        )}
      >
        {!isInbound && status ? (
          <StatusPill tone={status.tone}>
            {status.label}
            {message.providerError ? ` · ${message.providerError}` : ""}
          </StatusPill>
        ) : null}
        {isInbound && tier ? (
          <StatusPill tone="neutral">
            {tier}
            {typeof confidence === "number" ? ` · ${confidence.toFixed(2)}` : ""}
          </StatusPill>
        ) : null}
        {dispLabel ? (
          <StatusPill tone={dispositionTone(dispLabel)}>
            {dispositionLabelText(dispLabel)}
          </StatusPill>
        ) : null}
      </div>
      {isInbound ? (
        <div className="mt-2 flex max-w-[85%] flex-wrap gap-1.5">
          {DISPOSITION_CHIPS.map((chip) => (
            <button
              key={chip.value ?? "none"}
              type="button"
              disabled={pendingDispositionId === message.id}
              onClick={() => onDisposition(message.id, chip.value)}
              className={cn(
                "rounded-full border border-border bg-card px-2 py-0.5 text-[11px] font-medium text-foreground shadow-sm transition-colors hover:bg-muted",
                "disabled:opacity-50",
                dispLabel === chip.value && "border-primary/40 bg-primary/10 text-primary",
              )}
            >
              {chip.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface MessageBubbleProps {
  direction: "inbound" | "outbound";
  body: string;
  timestamp?: string | null;
  autoResponded?: boolean;
  actorEmail?: string | null;
}

function MessageBubble({ direction, body, timestamp, autoResponded, actorEmail }: MessageBubbleProps) {
  const isInbound = direction === "inbound";
  const tooltip = timestamp ? new Date(timestamp).toLocaleString() : "";
  return (
    <div
      title={tooltip}
      className={cn(
        "max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm shadow-sm",
        isInbound
          ? "rounded-tl-sm border border-border bg-card text-foreground"
          : "rounded-tr-sm bg-primary/10 text-foreground",
      )}
    >
      <div>{body}</div>
      <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
        {timestamp ? <span>{new Date(timestamp).toLocaleString()}</span> : null}
        {actorEmail && !autoResponded ? (
          <span className="rounded bg-muted px-1 py-0.5 text-[10px] font-medium">
            by {actorEmail}
          </span>
        ) : null}
        {autoResponded ? (
          <span className="rounded bg-muted px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide">
            auto
          </span>
        ) : null}
      </div>
    </div>
  );
}
