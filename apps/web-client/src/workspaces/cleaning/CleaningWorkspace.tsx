import { PlayCircle, Sparkles } from "lucide-react";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Card, CardContent, CardHeader, CardTitle, KpiCard } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatusPill, toneFromStatus } from "@/components/ui/StatusPill";
import { CaseLink } from "@/components/ui/CaseLink";
import { ErrorState } from "@/components/ui/ErrorState";
import { SkeletonRow } from "@/components/ui/Skeleton";
import { GapCard } from "@/components/ui/EmptyState";
import { useDomainStore } from "@/lib/domain/domainStore";
import { useConsentRecords, useConsentStats } from "@/lib/api/queries/consent";
import { useReviewOverview, useReviewQueue } from "@/lib/api/queries/review";
import {
  useDailyDeepCutRuns,
  useStartDeepCutRun,
  useHygieneOverview,
} from "@/lib/api/queries/hygiene";
import { toast } from "@/components/ui/Toaster";
import { formatDateTime, formatNumber } from "@/lib/utils/format";
import { NcoaUploadCard } from "./NcoaUploadCard";

export function CleaningWorkspace() {
  const domain = useDomainStore((s) => s.domain);
  const hygiene = useHygieneOverview();
  const runs = useDailyDeepCutRuns(domain);
  const reviewOverview = useReviewOverview(domain);
  const queue = useReviewQueue(domain, { status: "open", limit: 25 });
  const consentStats = useConsentStats({ domain });
  const consentRecords = useConsentRecords({ domain, limit: 10 });
  const startRun = useStartDeepCutRun();

  return (
    <div className="space-y-8">
      <SectionHeader
        eyebrow="Workspace"
        title="Cleaning & Review"
        description="Hygiene dashboards, daily deep-cut runs, human review queues, and TCPA vault records."
        actions={
          <Button
            isLoading={startRun.isPending}
            onClick={async () => {
              try {
                await startRun.mutateAsync({ domain });
                toast.success("Deep-cut run started");
              } catch (err) {
                toast.error("Could not start run", {
                  description: (err as Error).message,
                });
              }
            }}
          >
            <PlayCircle className="h-4 w-4" />
            Start deep-cut
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-5">
        <KpiCard
          label="Clean rate"
          value={
            hygiene.data?.cleanRate !== undefined
              ? `${Math.round((hygiene.data.cleanRate ?? 0) * 100)}%`
              : "—"
          }
          icon={<Sparkles className="h-4 w-4" />}
        />
        <KpiCard label="Pending" value={formatNumber(hygiene.data?.pendingCount)} />
        <KpiCard label="Review open" value={formatNumber(reviewOverview.data?.openCount)} />
        <KpiCard
          label="Review completed"
          value={formatNumber(reviewOverview.data?.completedCount)}
        />
        <KpiCard
          label="Consent vault"
          value={formatNumber(consentStats.data?.total)}
          hint={`${formatNumber(consentStats.data?.withTrustedForm)} TrustedForm · ${formatNumber(consentStats.data?.withJornaya)} Jornaya`}
        />
      </div>

      <NcoaUploadCard />

      <Card>
        <CardHeader>
          <CardTitle>Daily deep-cut runs</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {runs.isError ? (
            <ErrorState error={runs.error} onRetry={() => runs.refetch()} />
          ) : runs.isLoading ? (
            <SkeletonRow count={4} />
          ) : !runs.data || runs.data.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No runs recorded for {domain} yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2">Run</th>
                    <th className="py-2">Status</th>
                    <th className="py-2 text-right">Processed</th>
                    <th className="py-2 text-right">Cleaned</th>
                    <th className="py-2">Started</th>
                    <th className="py-2">Completed</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.data.map((run) => (
                    <tr
                      key={run.runId ?? run._id}
                      className="border-b border-border/60 last:border-b-0"
                    >
                      <td className="py-2 font-mono text-xs">{run.runId ?? run._id}</td>
                      <td className="py-2">
                        <StatusPill tone={toneFromStatus(run.status)}>{run.status}</StatusPill>
                      </td>
                      <td className="numeric py-2 text-right">
                        {formatNumber(run.recordsProcessed)}
                      </td>
                      <td className="numeric py-2 text-right">
                        {formatNumber(run.recordsCleaned)}
                      </td>
                      <td className="py-2 text-xs text-muted-foreground">
                        {formatDateTime(run.startedAt)}
                      </td>
                      <td className="py-2 text-xs text-muted-foreground">
                        {run.completedAt ? formatDateTime(run.completedAt) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Review queue · open</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {queue.isError ? (
            <ErrorState error={queue.error} onRetry={() => queue.refetch()} />
          ) : queue.isLoading ? (
            <SkeletonRow count={4} />
          ) : !queue.data?.items || queue.data.items.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Queue empty.</p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {queue.data.items.slice(0, 25).map((item) => (
                <li key={item.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 truncate font-medium">
                      <span>{item.category ?? "review"}</span>
                      {item.caseId ? (
                        <CaseLink caseId={item.caseId} domain={domain} compact />
                      ) : null}
                    </div>
                    {item.createdAt ? (
                      <div className="truncate text-xs text-muted-foreground">
                        {formatDateTime(item.createdAt)}
                      </div>
                    ) : null}
                  </div>
                  <StatusPill tone={toneFromStatus(item.status)}>
                    {item.status ?? "open"}
                  </StatusPill>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>TCPA consent vault</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {consentRecords.isError ? (
            <ErrorState error={consentRecords.error} onRetry={() => consentRecords.refetch()} />
          ) : consentRecords.isLoading ? (
            <SkeletonRow count={4} />
          ) : !consentRecords.data?.records || consentRecords.data.records.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No consent records captured for {domain} yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2">Received</th>
                    <th className="py-2">Case</th>
                    <th className="py-2">Source</th>
                    <th className="py-2">Contact</th>
                    <th className="py-2">Vault</th>
                  </tr>
                </thead>
                <tbody>
                  {consentRecords.data.records.map((record) => (
                    <tr
                      key={record._id ?? `${record.caseId ?? "na"}-${record.receivedAt ?? "now"}`}
                      className="border-b border-border/60 last:border-b-0"
                    >
                      <td className="py-2 text-xs text-muted-foreground">
                        {formatDateTime(record.receivedAt)}
                      </td>
                      <td className="py-2">
                        {record.caseId ? (
                          <CaseLink caseId={record.caseId} domain={domain} compact />
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="py-2">{record.source ?? record.intakeSource ?? "—"}</td>
                      <td className="py-2">
                        <div className="flex flex-col">
                          <span>{record.phone ?? "—"}</span>
                          <span className="text-xs text-muted-foreground">
                            {record.email ?? "—"}
                          </span>
                        </div>
                      </td>
                      <td className="py-2">
                        <div className="flex flex-wrap gap-2">
                          {record.trustedFormCertUrl ? (
                            <StatusPill tone="success">TrustedForm</StatusPill>
                          ) : null}
                          {record.jornayaLeadId ? (
                            <StatusPill tone="info">Jornaya</StatusPill>
                          ) : null}
                          {!record.trustedFormCertUrl && !record.jornayaLeadId ? (
                            <StatusPill tone="warning">Basic only</StatusPill>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <GapCard
          title="Review subpages"
          description="Per Cursor's map: scrubs, enrichment, activity AI, payment checks."
          routes={[
            "GET /api/read/review/:domain/scrubs",
            "GET /api/read/review/:domain/enrichment",
            "GET /api/read/review/:domain/activity-ai",
            "GET /api/read/review/:domain/payment-checks",
          ]}
        />
        <GapCard
          title="Review commands"
          description="Resolve, replay, promote — one click from queue row."
          routes={[
            "POST /api/commands/review/:id/resolve",
            "POST /api/commands/review/:id/replay",
            "POST /api/commands/review/:id/promote",
          ]}
        />
      </div>
    </div>
  );
}
