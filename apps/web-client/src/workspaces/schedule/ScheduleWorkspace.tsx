import { CalendarClock, PauseCircle, Play, TrendingUp } from "lucide-react";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Card, CardContent, CardHeader, CardTitle, KpiCard } from "@/components/ui/Card";
import { ErrorState } from "@/components/ui/ErrorState";
import { SkeletonRow } from "@/components/ui/Skeleton";
import { GapCard } from "@/components/ui/EmptyState";
import { StatusPill, toneFromStatus } from "@/components/ui/StatusPill";
import { CaseLink } from "@/components/ui/CaseLink";
import { useDomainStore } from "@/lib/domain/domainStore";
import {
  useSchedulesCadence,
  useSchedulesOverview,
} from "@/lib/api/queries/schedules";
import { formatNumber } from "@/lib/utils/format";

export function ScheduleWorkspace() {
  const domain = useDomainStore((s) => s.domain);
  const overview = useSchedulesOverview(domain);
  const cadence = useSchedulesCadence(domain, { active: true, limit: 25 });

  const totals = overview.data;

  return (
    <div className="space-y-8">
      <SectionHeader
        eyebrow="Workspace"
        title="Schedule"
        description="Contact cadence, mail pieces, and active campaigns for the selected domain."
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Active cadences"
          value={formatNumber(totals?.activeCadenceCount)}
          icon={<Play className="h-4 w-4" />}
        />
        <KpiCard
          label="Paused"
          value={formatNumber(totals?.inactiveCadenceCount)}
          icon={<PauseCircle className="h-4 w-4" />}
        />
        <KpiCard
          label="Due text"
          value={formatNumber(totals?.dueCounts?.sms)}
          icon={<TrendingUp className="h-4 w-4" />}
        />
        <KpiCard
          label="Due email"
          value={formatNumber(totals?.dueCounts?.email)}
          icon={<CalendarClock className="h-4 w-4" />}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Active cadences</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {cadence.isError ? (
            <ErrorState error={cadence.error} onRetry={() => cadence.refetch()} />
          ) : cadence.isLoading ? (
            <SkeletonRow count={5} />
          ) : !cadence.data?.cadenceList || cadence.data.cadenceList.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No active cadences for {domain}.
            </p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {cadence.data.cadenceList.slice(0, 25).map((c, i) => {
                const active = Boolean(c.active);
                return (
                  <li key={i} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate font-medium">
                        {typeof c.caseId === "string" || typeof c.caseId === "number" ? (
                          <CaseLink caseId={c.caseId} domain={domain} />
                        ) : (
                          "—"
                        )}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {typeof c.intakeSource === "string" ? c.intakeSource : "—"}
                        {typeof c.intakeRoute === "string" ? ` · ${c.intakeRoute}` : ""}
                      </div>
                    </div>
                    <StatusPill tone={toneFromStatus(active ? "active" : "paused")}>
                      {active ? "active" : "paused"}
                    </StatusPill>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <GapCard
          title="Calendar view & range moves"
          description="Drag-and-move cadence events and mail pieces across a date range."
          routes={[
            "GET /api/read/schedules/:domain/calendar",
            "POST /api/commands/schedules/move-range",
            "POST /api/commands/schedules/case/:caseId/pause",
            "POST /api/commands/schedules/case/:caseId/resume",
          ]}
        />
        <GapCard
          title="Active mail pieces"
          description="Portfolio of in-flight mail pieces with reassignment + mail-house hooks."
          routes={[
            "GET /api/read/schedules/:domain/active-mail",
            "GET /api/read/schedules/:domain/pieces",
            "POST /api/commands/schedules/reassign-piece",
            "POST /api/commands/schedules/build-mail-job",
          ]}
        />
      </div>
    </div>
  );
}
