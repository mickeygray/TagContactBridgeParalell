import * as React from "react";
import { CalendarClock, CheckCircle2, RefreshCw, RotateCcw, Users } from "lucide-react";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Button } from "@/components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle, KpiCard } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { SkeletonRow } from "@/components/ui/Skeleton";
import { StatusPill } from "@/components/ui/StatusPill";
import { toast } from "@/components/ui/Toaster";
import { useCxAppointments, useCxReleaseAppointmentAny } from "@/lib/api/queries/cx";
import type { CxAppointment, CxAppointmentStatus } from "@/lib/api/types";
import { formatDateTime, formatNumber, formatRelative } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

type AppointmentFilter = CxAppointmentStatus | "active" | "all";

const STATUS_FILTERS: Array<{ label: string; value: AppointmentFilter }> = [
  { label: "Active", value: "active" },
  { label: "Scheduled", value: "scheduled" },
  { label: "Due", value: "due" },
  { label: "Fired", value: "fired" },
  { label: "Blocked", value: "blocked" },
  { label: "Released", value: "released" },
  { label: "All", value: "all" },
];

const RELEASABLE_STATUSES = new Set(["scheduled", "due", "fired", "blocked"]);

function statusTone(status: string): "success" | "warning" | "danger" | "info" | "neutral" {
  if (status === "completed") return "success";
  if (status === "blocked") return "warning";
  if (status === "cancelled") return "danger";
  if (status === "released" || status === "fired" || status === "due") return "info";
  if (status === "scheduled") return "neutral";
  return "neutral";
}

function compactPhone(value?: string | null) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length < 10) return value || "";
  const d = digits.slice(-10);
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

function agentKey(appointment: CxAppointment) {
  return String(appointment.agentExtensionId || appointment.agentEmail || appointment.agentName || "unassigned");
}

function agentLabel(appointment: CxAppointment) {
  const name = String(appointment.agentName || "").trim();
  const extension = String(appointment.agentExtensionId || "").trim();
  if (name && extension) return `${name} (${extension})`;
  return name || appointment.agentEmail || (extension ? `Extension ${extension}` : "Unassigned");
}

function groupAppointmentsByAgent(items: CxAppointment[]) {
  const groups = new Map<string, { key: string; label: string; items: CxAppointment[] }>();
  for (const appointment of items) {
    const key = agentKey(appointment);
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(appointment);
      continue;
    }
    groups.set(key, {
      key,
      label: agentLabel(appointment),
      items: [appointment],
    });
  }
  return Array.from(groups.values()).sort((a, b) => {
    const nextA = Date.parse(String(a.items[0]?.legalDialAt || a.items[0]?.appointmentAt || "")) || 0;
    const nextB = Date.parse(String(b.items[0]?.legalDialAt || b.items[0]?.appointmentAt || "")) || 0;
    return nextA - nextB || a.label.localeCompare(b.label);
  });
}

function summarize(items: CxAppointment[]) {
  const now = Date.now();
  return items.reduce(
    (acc, item) => {
      acc.total += 1;
      if (RELEASABLE_STATUSES.has(String(item.status || ""))) acc.active += 1;
      if (item.status === "blocked") acc.blocked += 1;
      const legalAt = Date.parse(String(item.legalDialAt || item.appointmentAt || ""));
      if (Number.isFinite(legalAt) && legalAt <= now && RELEASABLE_STATUSES.has(String(item.status || ""))) {
        acc.due += 1;
      }
      if (item.status === "released") acc.released += 1;
      return acc;
    },
    { total: 0, active: 0, due: 0, blocked: 0, released: 0 },
  );
}

function AppointmentCard({
  appointment,
  onRelease,
  releasing,
}: {
  appointment: CxAppointment;
  onRelease: (appointment: CxAppointment) => void;
  releasing: boolean;
}) {
  const status = String(appointment.status || "scheduled");
  const canRelease = RELEASABLE_STATUSES.has(status);
  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <CardTitle className="truncate">
            {appointment.prospectName || `Case ${appointment.caseId}`}
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">{appointment.domain} #{appointment.caseId}</span>
            {appointment.phone ? <span>{compactPhone(appointment.phone)}</span> : null}
            {appointment.sourceName ? <span>{appointment.sourceName}</span> : null}
          </div>
        </div>
        <StatusPill tone={statusTone(status)}>
          {status.replace(/_/g, " ")}
        </StatusPill>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 text-xs text-muted-foreground sm:grid-cols-3">
          <div>
            <div className="font-medium text-foreground">Appointment</div>
            <div>{formatDateTime(appointment.appointmentAt)}</div>
            <div>{appointment.appointmentTimezone || "America/Los_Angeles"}</div>
          </div>
          <div>
            <div className="font-medium text-foreground">Legal dial time</div>
            <div>{formatDateTime(appointment.legalDialAt || appointment.appointmentAt)}</div>
            <div>{appointment.legalDialReason || appointment.legalDialTimezone || ""}</div>
          </div>
          <div>
            <div className="font-medium text-foreground">Queue</div>
            <div>{appointment.queueActionKey || appointment.cxQueueRecordId || "Reserved"}</div>
            <div>{appointment.intakeSource || appointment.intakeRoute || ""}</div>
          </div>
        </div>

        {appointment.note ? (
          <div className="rounded-md bg-muted/40 p-2 text-xs text-muted-foreground">
            {appointment.note}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
          <div className="text-xs text-muted-foreground">
            Updated {formatRelative(appointment.updatedAt)}
          </div>
          {canRelease ? (
            <Button
              size="sm"
              variant="secondary"
              isLoading={releasing}
              onClick={() => onRelease(appointment)}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Release appointment
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

export function PostDatesWorkspace() {
  const [status, setStatus] = React.useState<AppointmentFilter>("active");
  const appointments = useCxAppointments("ALL", { status });
  const releaseAppointment = useCxReleaseAppointmentAny();
  const items = appointments.data?.items ?? [];
  const grouped = React.useMemo(() => groupAppointmentsByAgent(items), [items]);
  const summary = React.useMemo(() => summarize(items), [items]);

  const handleRelease = React.useCallback(
    (appointment: CxAppointment) => {
      const label = appointment.prospectName || `case ${appointment.caseId}`;
      if (!window.confirm(`Release ${label} back into the dialable pool?`)) return;
      releaseAppointment.mutate(
        {
          domain: appointment.domain,
          appointmentId: appointment.appointmentId,
          reason: "Released from admin appointment page",
        },
        {
          onSuccess: () => toast.success("Appointment released"),
          onError: (error) =>
            toast.error("Release failed", {
              description: error instanceof Error ? error.message : "Request failed",
            }),
        },
      );
    },
    [releaseAppointment],
  );

  return (
    <div className="space-y-6">
      <SectionHeader
        eyebrow="Admin"
        title="Appointments"
        actions={
          <Button size="sm" variant="secondary" onClick={() => void appointments.refetch()}>
            <RefreshCw className={cn("h-3.5 w-3.5", appointments.isFetching && "animate-spin")} />
            Refresh
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-4">
        <KpiCard
          label="Active"
          value={formatNumber(summary.active)}
          icon={<CalendarClock className="h-4 w-4" />}
        />
        <KpiCard
          label="Due now"
          value={formatNumber(summary.due)}
          icon={<CheckCircle2 className="h-4 w-4" />}
        />
        <KpiCard label="Blocked" value={formatNumber(summary.blocked)} />
        <KpiCard label="Agents" value={formatNumber(grouped.length)} icon={<Users className="h-4 w-4" />} />
      </div>

      <div className="flex flex-wrap gap-2">
        {STATUS_FILTERS.map((filter) => (
          <Button
            key={filter.value}
            size="sm"
            variant={status === filter.value ? "primary" : "secondary"}
            onClick={() => setStatus(filter.value)}
          >
            {filter.label}
          </Button>
        ))}
      </div>

      {appointments.isLoading ? <SkeletonRow count={4} /> : null}
      {appointments.isError ? <ErrorState error={appointments.error} onRetry={() => void appointments.refetch()} /> : null}
      {!appointments.isLoading && !appointments.isError && items.length === 0 ? (
        <EmptyState
          icon={<CalendarClock />}
          title="No appointments"
        />
      ) : null}
      <div className="space-y-4">
        {grouped.map((group) => (
          <section key={group.key} className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-foreground">{group.label}</h2>
                <p className="text-xs text-muted-foreground">
                  {formatNumber(group.items.length)} appointment{group.items.length === 1 ? "" : "s"}
                </p>
              </div>
            </div>
            <div className="grid gap-3">
              {group.items.map((appointment) => (
                <AppointmentCard
                  key={appointment.appointmentId}
                  appointment={appointment}
                  releasing={
                    releaseAppointment.isPending &&
                    releaseAppointment.variables?.appointmentId === appointment.appointmentId
                  }
                  onRelease={handleRelease}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
