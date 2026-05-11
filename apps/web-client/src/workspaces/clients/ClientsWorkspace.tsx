import * as React from "react";
import { PhoneCall, Search, ShieldBan, Sparkles, User } from "lucide-react";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Button } from "@/components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle, KpiCard } from "@/components/ui/Card";
import { Input, Label } from "@/components/ui/Input";
import { StatusPill, toneFromStatus } from "@/components/ui/StatusPill";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { SkeletonRow } from "@/components/ui/Skeleton";
import { useActiveDomain } from "@/lib/domain/useActiveDomain";
import { useAuthStore } from "@/lib/auth/authStore";
import {
  useClientDetail,
  useClientDial,
  useClientDnc,
  useClientEmail,
  useClientList,
  useClientRunScrub,
  useClientSetSource,
  useClientText,
  useClientUpdateStatus,
} from "@/lib/api/queries/clients";
import { formatDateTime, formatNumber, formatRelative } from "@/lib/utils/format";
import { toast } from "@/components/ui/Toaster";
import { cn } from "@/lib/utils/cn";

function useDebounce<T>(value: T, ms = 350): T {
  const [v, setV] = React.useState(value);
  React.useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return v;
}

function onErrorToast(scope: string) {
  return (err: unknown) =>
    toast.error(scope, {
      description: err instanceof Error ? err.message : "Request failed",
    });
}

export function ClientsWorkspace() {
  const domain = useActiveDomain();
  const isAdmin = useAuthStore((s) => s.isAdmin());
  const [rawSearch, setRawSearch] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("");
  const [sortBy, setSortBy] = React.useState("updated");
  const [sortDir, setSortDir] = React.useState("desc");
  const [selectedCaseId, setSelectedCaseId] = React.useState<string | null>(null);
  const [actionForm, setActionForm] = React.useState({
    phone: "",
    emailTo: "",
    textMessage: "",
    emailSubject: "",
    emailBody: "",
    dialPhone: "",
    status: "",
    statusId: "",
    sourceKey: "",
    sourceNote: "",
    notes: "",
  });

  const search = useDebounce(rawSearch);
  const list = useClientList(domain, {
    search,
    status: statusFilter || undefined,
    sortBy,
    sortDir,
    limit: 100,
  });
  const detail = useClientDetail(domain, selectedCaseId);
  const sendText = useClientText(domain);
  const sendEmail = useClientEmail(domain);
  const dial = useClientDial(domain);
  const updateStatus = useClientUpdateStatus(domain);
  const dnc = useClientDnc(domain);
  const setSource = useClientSetSource(domain);
  const runScrub = useClientRunScrub(domain);

  const items = list.data?.items ?? [];
  const selectedItem = items.find((item) => item.caseId === selectedCaseId) ?? null;

  React.useEffect(() => {
    if (!selectedCaseId && items.length > 0) {
      setSelectedCaseId(items[0].caseId);
    }
  }, [items, selectedCaseId]);

  React.useEffect(() => {
    if (!selectedItem) return;
    setActionForm((current) => ({
      ...current,
      phone: current.phone || selectedItem.phone || "",
      emailTo: current.emailTo || selectedItem.email || "",
      dialPhone: current.dialPhone || selectedItem.phone || "",
    }));
  }, [selectedItem]);

  React.useEffect(() => {
    if (!detail.data) return;
    const attribution = detail.data.attribution ?? {};
    const currentSourceKey =
      typeof attribution.sourceKey === "string"
        ? attribution.sourceKey
        : typeof attribution.canonicalKey === "string"
          ? attribution.canonicalKey
          : typeof selectedItem?.sourceCanonicalId === "string"
            ? selectedItem.sourceCanonicalId
            : "";
    setActionForm((current) => ({
      ...current,
      sourceKey: current.sourceKey || currentSourceKey,
    }));
  }, [detail.data, selectedItem?.sourceCanonicalId]);

  return (
    <div className="space-y-8">
      <SectionHeader
        eyebrow="Workspace"
        title="Clients"
        description="Search, sort, and touch any prospect or case profile from one place."
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Visible" value={formatNumber(list.data?.total)} />
        <KpiCard
          label="High score"
          value={formatNumber(items.filter((item) => (item.internalScore ?? 0) >= 70).length)}
        />
        <KpiCard
          label="Needs review"
          value={formatNumber(items.filter((item) => item.attributionNeedsReview).length)}
        />
        <KpiCard
          label="Opt-out risk"
          value={formatNumber(items.filter((item) => item.optOutDetected).length)}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[360px_1fr]">
        <Card className="flex flex-col">
          <CardHeader>
            <CardTitle>Find cases</CardTitle>
            <div className="space-y-3">
              <Input
                autoFocus
                leadingIcon={<Search />}
                placeholder="Name, phone, email, or case id"
                value={rawSearch}
                onChange={(event) => setRawSearch(event.target.value)}
              />
              <div className="grid grid-cols-2 gap-2">
                <select
                  className="h-9 rounded-md border border-input bg-card px-3 text-sm"
                  value={sortBy}
                  onChange={(event) => setSortBy(event.target.value)}
                >
                  <option value="updated">Sort: updated</option>
                  <option value="score">Sort: score</option>
                  <option value="status">Sort: status</option>
                  <option value="payments">Sort: payments</option>
                  <option value="name">Sort: name</option>
                </select>
                <select
                  className="h-9 rounded-md border border-input bg-card px-3 text-sm"
                  value={sortDir}
                  onChange={(event) => setSortDir(event.target.value)}
                >
                  <option value="desc">Desc</option>
                  <option value="asc">Asc</option>
                </select>
              </div>
              <Input
                placeholder="Filter status contains…"
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value)}
              />
            </div>
          </CardHeader>
          <CardContent className="flex-1 pt-0">
            {list.isError ? (
              <ErrorState error={list.error} onRetry={() => list.refetch()} />
            ) : list.isLoading ? (
              <SkeletonRow count={6} />
            ) : items.length === 0 ? (
              <EmptyState
                icon={<User />}
                title="No matches"
                description={`Nothing visible for "${search}" in ${domain}.`}
              />
            ) : (
              <ul className="space-y-1">
                {items.map((item) => (
                  <li key={item.caseId}>
                    <button
                      type="button"
                      onClick={() => setSelectedCaseId(item.caseId)}
                      className={cn(
                        "w-full rounded-md border border-transparent px-3 py-2 text-left transition-colors hover:bg-muted",
                        selectedCaseId === item.caseId && "border-primary/40 bg-primary/5",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium">
                          {item.name ?? item.caseId}
                        </span>
                        <div className="flex items-center gap-2">
                          <StatusPill tone={toneFromStatus(item.status)}>{item.status ?? "unknown"}</StatusPill>
                          {item.scrubStatus ? (
                            <StatusPill tone={item.scrubStatus === "completed" ? "success" : "warning"}>
                              {item.scrubStatus}
                            </StatusPill>
                          ) : null}
                          <StatusPill tone="neutral">Score {item.internalScore ?? 0}</StatusPill>
                        </div>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
                        {item.phone ? <span>{item.phone}</span> : null}
                        {item.email ? <span className="truncate">{item.email}</span> : null}
                        {item.intakeSource ? <span>· {item.intakeSource}</span> : null}
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
            <CardTitle>
              {selectedCaseId ? `Case ${selectedCaseId}` : "Select a case"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6 pt-0">
            {!selectedCaseId ? (
              <EmptyState
                icon={<User />}
                title="Pick a case"
                description="Choose a row to view the profile and act on it."
              />
            ) : detail.isError ? (
              <ErrorState error={detail.error} onRetry={() => detail.refetch()} />
            ) : detail.isLoading ? (
              <SkeletonRow count={6} />
            ) : !detail.data ? null : (
              <>
                {(() => {
                  const scrubSummary = detail.data.scrubSummary ?? null;
                  const scrubProviders = scrubSummary?.providers ?? null;
                  const scrubActivities =
                    scrubProviders?.activities as { total?: number } | null | undefined;
                  const scrubPayments =
                    scrubProviders?.payments as
                      | { successfulCount?: number; totalAmount?: number }
                      | null
                      | undefined;
                  const scrubInvoices =
                    scrubProviders?.invoices as
                      | { total?: number; totalAmount?: number }
                      | null
                      | undefined;
                  const scrubBilling =
                    scrubProviders?.billingSummary as { balance?: number } | null | undefined;

                  return (
                    <>
                <header className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-lg font-semibold">
                      {detail.data.name ?? detail.data.caseId}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-3 text-sm text-muted-foreground">
                      {detail.data.phone ? <span>{detail.data.phone}</span> : null}
                      {detail.data.email ? <span>{detail.data.email}</span> : null}
                      {selectedItem?.intakeSource ? <span>· {selectedItem.intakeSource}</span> : null}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <StatusPill tone={toneFromStatus(detail.data.status)}>
                      {detail.data.status ?? "unknown"}
                    </StatusPill>
                    <StatusPill tone="neutral">Score {selectedItem?.internalScore ?? 0}</StatusPill>
                  </div>
                </header>

                <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                  <KpiCard label="Paid" value={formatNumber(selectedItem?.totalPaid)} />
                  <KpiCard label="Payments" value={formatNumber(selectedItem?.paymentsCount)} />
                  <KpiCard
                    label="Last update"
                    value={selectedItem?.updatedAt ? formatRelative(selectedItem.updatedAt) : "—"}
                    hint={selectedItem?.updatedAt ? formatDateTime(selectedItem.updatedAt) : undefined}
                  />
                </div>

                <Section title="Scrub & review">
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill tone={scrubSummary?.status === "completed" ? "success" : scrubSummary?.status === "partial" ? "warning" : "neutral"}>
                        {scrubSummary?.status ?? "Not scrubbed"}
                      </StatusPill>
                      {scrubSummary?.reviewedAt ? (
                        <span className="text-xs text-muted-foreground">
                          {formatRelative(scrubSummary.reviewedAt)} · {formatDateTime(scrubSummary.reviewedAt)}
                        </span>
                      ) : null}
                      {isAdmin ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          isLoading={runScrub.isPending}
                          onClick={async () => {
                            try {
                              await runScrub.mutateAsync({ caseId: selectedCaseId, body: {} });
                              toast.success("Client scrub completed");
                            } catch (error) {
                              onErrorToast("Could not run client scrub")(error);
                            }
                          }}
                        >
                          Run scrub
                        </Button>
                      ) : null}
                    </div>

                    <div className="grid grid-cols-1 gap-4 xl:grid-cols-4">
                      <KpiCard
                        label="Activities"
                        value={formatNumber(scrubActivities?.total)}
                      />
                      <KpiCard
                        label="Successful payments"
                        value={formatNumber(scrubPayments?.successfulCount)}
                        hint={
                          scrubPayments?.totalAmount != null
                            ? `$${formatNumber(scrubPayments.totalAmount)}`
                            : undefined
                        }
                      />
                      <KpiCard
                        label="Invoices"
                        value={formatNumber(scrubInvoices?.total)}
                        hint={
                          scrubInvoices?.totalAmount != null
                            ? `$${formatNumber(scrubInvoices.totalAmount)}`
                            : undefined
                        }
                      />
                      <KpiCard
                        label="Billing balance"
                        value={
                          scrubBilling?.balance != null
                            ? `$${formatNumber(scrubBilling.balance)}`
                            : "—"
                        }
                      />
                    </div>

                    {scrubSummary ? (
                      <div className="rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
                        <div className="flex flex-wrap gap-3">
                          {scrubSummary.activityReviewStatus ? (
                            <span>AI activity review: {scrubSummary.activityReviewStatus}</span>
                          ) : null}
                          {scrubSummary.activityReviewConfidence ? (
                            <span>Confidence: {scrubSummary.activityReviewConfidence}</span>
                          ) : null}
                          {scrubSummary.actorEmail ? (
                            <span>By: {scrubSummary.actorEmail}</span>
                          ) : null}
                        </div>
                        {scrubSummary.activityReviewError ? (
                          <div className="mt-2 text-amber-600">
                            Activity review issue: {scrubSummary.activityReviewError}
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <div className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
                        Run a manual scrub to pull fresh Logics activities, payments, invoices, and billing summary into this case profile.
                      </div>
                    )}
                  </div>
                </Section>

                <Section title="Source & attribution">
                  <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
                    <div className="space-y-3">
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <StatusPill
                          tone={detail.data.attribution?.lockedManual ? "warning" : "neutral"}
                        >
                          {detail.data.attribution?.lockedManual ? "Manual lock" : "Auto / unresolved"}
                        </StatusPill>
                        {detail.data.attribution?.sourceName ? (
                          <StatusPill tone="info">
                            {String(detail.data.attribution.sourceName)}
                          </StatusPill>
                        ) : null}
                        {detail.data.attribution?.confidence ? (
                          <StatusPill tone="neutral">
                            {String(detail.data.attribution.confidence)}
                          </StatusPill>
                        ) : null}
                      </div>
                      <div className="rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
                        {detail.data.attribution?.reason ? (
                          <div>{String(detail.data.attribution.reason)}</div>
                        ) : (
                          <div>
                            Use this when a deal lands without the right source and you want to
                            lock it manually for downstream metrics and review.
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="space-y-3">
                      <div>
                        <Label>Manual source</Label>
                        <select
                          className="mt-1 h-9 w-full rounded-md border border-input bg-card px-3 text-sm"
                          value={actionForm.sourceKey}
                          onChange={(event) =>
                            setActionForm((current) => ({
                              ...current,
                              sourceKey: event.target.value,
                            }))
                          }
                        >
                          <option value="">Select source…</option>
                          {(detail.data.availableSources ?? []).map((source) => {
                            const key =
                              typeof source.canonicalKey === "string"
                                ? source.canonicalKey
                                : typeof source._id === "string"
                                  ? source._id
                                  : "";
                            if (!key) return null;
                            const label =
                              typeof source.internalName === "string"
                                ? source.internalName
                                : typeof source.displayName === "string"
                                  ? source.displayName
                                  : key;
                            return (
                              <option key={key} value={key}>
                                {label}
                              </option>
                            );
                          })}
                        </select>
                      </div>
                      <div>
                        <Label>Reason</Label>
                        <textarea
                          className="min-h-[88px] w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
                          placeholder="Why are we overriding attribution?"
                          value={actionForm.sourceNote}
                          onChange={(event) =>
                            setActionForm((current) => ({
                              ...current,
                              sourceNote: event.target.value,
                            }))
                          }
                        />
                      </div>
                      <Button
                        variant="secondary"
                        isLoading={setSource.isPending}
                        onClick={async () => {
                          if (!actionForm.sourceKey) {
                            toast.error("Pick a source first");
                            return;
                          }
                          try {
                            await setSource.mutateAsync({
                              caseId: selectedCaseId,
                              body: {
                                sourceKey: actionForm.sourceKey,
                                note: actionForm.sourceNote,
                                matchedBy: "manual",
                              },
                            });
                            toast.success("Source locked");
                          } catch (error) {
                            onErrorToast("Could not set source")(error);
                          }
                        }}
                      >
                        Save source
                      </Button>
                    </div>
                  </div>
                </Section>

                <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
                  <Section title="Direct contact">
                    <div className="space-y-3">
                      <div>
                        <Label>Text phone</Label>
                        <Input
                          value={actionForm.phone}
                          onChange={(event) =>
                            setActionForm((current) => ({ ...current, phone: event.target.value }))
                          }
                        />
                      </div>
                      <div>
                        <Label>Text message</Label>
                        <textarea
                          className="min-h-[88px] w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
                          value={actionForm.textMessage}
                          onChange={(event) =>
                            setActionForm((current) => ({ ...current, textMessage: event.target.value }))
                          }
                        />
                      </div>
                      <Button
                        isLoading={sendText.isPending}
                        onClick={async () => {
                          try {
                            await sendText.mutateAsync({
                              caseId: selectedCaseId,
                              body: {
                                phone: actionForm.phone,
                                message: actionForm.textMessage,
                              },
                            });
                            toast.success("Text queued");
                          } catch (error) {
                            onErrorToast("Could not queue text")(error);
                          }
                        }}
                      >
                        <Sparkles className="h-4 w-4" />
                        Send text
                      </Button>

                      <div className="border-t border-border pt-3" />

                      <div>
                        <Label>Email to</Label>
                        <Input
                          value={actionForm.emailTo}
                          onChange={(event) =>
                            setActionForm((current) => ({ ...current, emailTo: event.target.value }))
                          }
                        />
                      </div>
                      <div>
                        <Label>Email subject</Label>
                        <Input
                          value={actionForm.emailSubject}
                          onChange={(event) =>
                            setActionForm((current) => ({ ...current, emailSubject: event.target.value }))
                          }
                        />
                      </div>
                      <div>
                        <Label>Email body</Label>
                        <textarea
                          className="min-h-[88px] w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
                          value={actionForm.emailBody}
                          onChange={(event) =>
                            setActionForm((current) => ({ ...current, emailBody: event.target.value }))
                          }
                        />
                      </div>
                      <Button
                        variant="secondary"
                        isLoading={sendEmail.isPending}
                        onClick={async () => {
                          try {
                            await sendEmail.mutateAsync({
                              caseId: selectedCaseId,
                              body: {
                                to: actionForm.emailTo,
                                subject: actionForm.emailSubject,
                                body: actionForm.emailBody,
                              },
                            });
                            toast.success("Email queued");
                          } catch (error) {
                            onErrorToast("Could not queue email")(error);
                          }
                        }}
                      >
                        Send email
                      </Button>

                      <div className="border-t border-border pt-3" />

                      <div>
                        <Label>Dial phone</Label>
                        <Input
                          value={actionForm.dialPhone}
                          onChange={(event) =>
                            setActionForm((current) => ({ ...current, dialPhone: event.target.value }))
                          }
                        />
                      </div>
                      <Button
                        variant="secondary"
                        isLoading={dial.isPending}
                        onClick={async () => {
                          try {
                            await dial.mutateAsync({
                              caseId: selectedCaseId,
                              body: { phone: actionForm.dialPhone },
                            });
                            toast.success("Dial queued");
                          } catch (error) {
                            onErrorToast("Could not queue dial")(error);
                          }
                        }}
                      >
                        <PhoneCall className="h-4 w-4" />
                        Dial
                      </Button>
                    </div>
                  </Section>

                  <Section title="Status & suppression">
                    <div className="space-y-3">
                      <div>
                        <Label>Status label</Label>
                        <Input
                          placeholder="Post Date, Bad, Inactive, DNC…"
                          value={actionForm.status}
                          onChange={(event) =>
                            setActionForm((current) => ({ ...current, status: event.target.value }))
                          }
                        />
                      </div>
                      <div>
                        <Label>Logics Status ID</Label>
                        <Input
                          placeholder="Optional numeric StatusID"
                          value={actionForm.statusId}
                          onChange={(event) =>
                            setActionForm((current) => ({ ...current, statusId: event.target.value }))
                          }
                        />
                      </div>
                      <div>
                        <Label>Notes</Label>
                        <textarea
                          className="min-h-[88px] w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
                          value={actionForm.notes}
                          onChange={(event) =>
                            setActionForm((current) => ({ ...current, notes: event.target.value }))
                          }
                        />
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          isLoading={updateStatus.isPending}
                          onClick={async () => {
                            try {
                              await updateStatus.mutateAsync({
                                caseId: selectedCaseId,
                                body: {
                                  status: actionForm.status,
                                  statusId: actionForm.statusId ? Number(actionForm.statusId) : undefined,
                                  notes: actionForm.notes,
                                },
                              });
                              toast.success("Status action sent");
                            } catch (error) {
                              onErrorToast("Could not update status")(error);
                            }
                          }}
                        >
                          Update status
                        </Button>
                        <Button
                          variant="destructive"
                          isLoading={dnc.isPending}
                          onClick={async () => {
                            try {
                              await dnc.mutateAsync({
                                caseId: selectedCaseId,
                                body: {
                                  status: "DNC",
                                  statusId: actionForm.statusId ? Number(actionForm.statusId) : undefined,
                                  notes: actionForm.notes || "DNC from client workspace",
                                },
                              });
                              toast.success("DNC action sent");
                            } catch (error) {
                              onErrorToast("Could not apply DNC")(error);
                            }
                          }}
                        >
                          <ShieldBan className="h-4 w-4" />
                          DNC
                        </Button>
                      </div>
                    </div>
                  </Section>
                </div>

                {detail.data.timeline && detail.data.timeline.length > 0 ? (
                  <Section title="Timeline">
                    <ul className="relative space-y-3 border-l border-border pl-5">
                      {detail.data.timeline.slice(0, 10).map((entry, index) => (
                        <li key={index} className="relative">
                          <span className="absolute -left-[22px] top-1.5 h-2 w-2 rounded-full bg-primary" />
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm font-medium text-foreground">
                              {String(entry.label ?? entry.eventType)}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {formatRelative(entry.timestamp)}
                            </span>
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {formatDateTime(entry.timestamp)}
                          </div>
                          {entry.detail ? (
                            <div className="mt-1 text-xs text-muted-foreground">
                              {String(entry.detail)}
                            </div>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </Section>
                ) : null}
                    </>
                  );
                })()}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}
