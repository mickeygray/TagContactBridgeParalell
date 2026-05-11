import {
  AlertTriangle,
  CircleDollarSign,
  Mail,
  PhoneCall,
  RefreshCw,
  Users,
} from "lucide-react";
import { type UseQueryResult } from "@tanstack/react-query";
import { Button } from "@/components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { SkeletonRow } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/ErrorState";
import type { MetricsPulse } from "@/lib/api/types";
import { formatCurrency, formatNumber, formatRelative } from "@/lib/utils/format";

interface Props {
  query: UseQueryResult<MetricsPulse>;
}

function hasError<T extends { _error?: string }>(value: T | undefined | null): value is T & {
  _error: string;
} {
  return Boolean(value && value._error);
}

function Group({
  title,
  icon,
  children,
  error,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  error?: string;
}) {
  return (
    <div className="rounded-md border border-border bg-card/50">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {icon}
        <span>{title}</span>
      </div>
      <div className="px-3 py-2 text-sm">
        {error ? (
          <div className="text-xs text-rose-400">{error}</div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  detail,
  emphasis,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  detail?: React.ReactNode;
  emphasis?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-0.5">
      <span
        className={
          emphasis
            ? "truncate text-xs font-semibold text-foreground"
            : "truncate text-xs text-muted-foreground"
        }
      >
        {label}
      </span>
      <span className="flex items-baseline gap-1.5 whitespace-nowrap">
        {detail ? (
          <span className="text-[10px] text-muted-foreground">{detail}</span>
        ) : null}
        <span
          className={
            emphasis
              ? "numeric text-sm font-semibold text-foreground"
              : "numeric text-xs text-foreground"
          }
        >
          {value}
        </span>
      </span>
    </div>
  );
}

export function DailyPulsePanel({ query }: Props) {
  if (query.isError) {
    return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  }
  if (query.isLoading || !query.data) {
    return <SkeletonRow count={6} />;
  }

  const data = query.data;
  const mail = data.mailToday;
  const calls = data.mailCalls;
  const other = data.otherChannels;
  const payments = data.paymentsToday;
  const leads = data.leadsToday;
  const alerts = data.alerts;

  return (
    <Card className="h-full">
      <CardHeader className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">Daily pulse</CardTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <StatusPill tone={query.isFetching ? "info" : "success"}>
            {data.date}
          </StatusPill>
          <span>
            {query.isFetching
              ? "Refreshing…"
              : `Updated ${formatRelative(data.generatedAt)}`}
          </span>
        </div>
      </CardHeader>

      <CardContent className="space-y-3 pt-0">
        {/* Mail Today */}
        <Group
          title="Mail today"
          icon={<Mail className="h-3.5 w-3.5" />}
          error={hasError(mail) && !("entries" in mail) ? mail._error : undefined}
        >
          {"entries" in mail && mail.entries.length > 0 ? (
            <>
              {mail.entries.slice(0, 6).map((entry) => (
                <Row
                  key={entry.source}
                  label={entry.source}
                  detail={`${formatNumber(entry.pieces)} pc`}
                  value={formatCurrency(entry.spend)}
                />
              ))}
              <div className="mt-1 border-t border-border pt-1">
                <Row
                  label="Total"
                  detail={
                    "total" in mail ? `${formatNumber(mail.total.pieces)} pc` : undefined
                  }
                  value={"total" in mail ? formatCurrency(mail.total.spend) : "—"}
                  emphasis
                />
              </div>
            </>
          ) : (
            <div className="text-xs text-muted-foreground">No drops today.</div>
          )}
        </Group>

        {/* Mail Calls */}
        <Group
          title="Mail calls"
          icon={<PhoneCall className="h-3.5 w-3.5" />}
          error={hasError(calls) && !("entries" in calls) ? calls._error : undefined}
        >
          {"entries" in calls && calls.entries.length > 0 ? (
            <>
              {calls.entries.slice(0, 6).map((entry) => (
                <Row
                  key={entry.piece}
                  label={entry.piece}
                  detail={`${formatNumber(entry.callsOver5)} > 5m`}
                  value={formatNumber(entry.totalCalls)}
                />
              ))}
              <div className="mt-1 border-t border-border pt-1">
                <Row
                  label="Total"
                  detail={
                    "total" in calls
                      ? `${formatNumber(calls.total.callsOver5)} > 5m`
                      : undefined
                  }
                  value={"total" in calls ? formatNumber(calls.total.totalCalls) : "—"}
                  emphasis
                />
              </div>
            </>
          ) : (
            <div className="text-xs text-muted-foreground">No mail calls yet today.</div>
          )}
        </Group>

        {/* Other Channels */}
        <Group
          title="Other channels"
          icon={<PhoneCall className="h-3.5 w-3.5" />}
          error={
            hasError(other as { _error?: string })
              ? (other as { _error?: string })._error
              : undefined
          }
        >
          {Array.isArray(other) && other.length > 0 ? (
            other.map((bucket) => (
              <Row
                key={bucket.key}
                label={bucket.label}
                value={formatNumber(bucket.totalCalls)}
              />
            ))
          ) : (
            <div className="text-xs text-muted-foreground">No activity.</div>
          )}
        </Group>

        {/* Payments Today */}
        <Group
          title="Payments today"
          icon={<CircleDollarSign className="h-3.5 w-3.5" />}
          error={
            hasError(payments) && !("total" in payments) ? payments._error : undefined
          }
        >
          {"total" in payments ? (
            <>
              <Row
                label={`Initials · ${formatNumber(payments.initialCount)}`}
                value={formatCurrency(payments.initialAmount)}
              />
              <Row
                label={`Recurring · ${formatNumber(payments.recurringCount)}`}
                value={formatCurrency(payments.recurringAmount)}
              />
              <div className="mt-1 border-t border-border pt-1">
                <Row
                  label="Total in"
                  value={formatCurrency(payments.total)}
                  emphasis
                />
              </div>
              {payments.needsReview > 0 ? (
                <div className="mt-1 text-xs text-amber-400">
                  {formatNumber(payments.needsReview)} needs review
                </div>
              ) : null}
            </>
          ) : null}
        </Group>

        {/* Leads Today */}
        <Group
          title="Leads today"
          icon={<Users className="h-3.5 w-3.5" />}
          error={hasError(leads) && !("entries" in leads) ? leads._error : undefined}
        >
          {"entries" in leads && leads.entries.length > 0 ? (
            <>
              {leads.entries.slice(0, 6).map((entry) => (
                <Row
                  key={entry.source}
                  label={entry.source}
                  value={formatNumber(entry.count)}
                />
              ))}
              <div className="mt-1 border-t border-border pt-1">
                <Row
                  label="Total"
                  value={"total" in leads ? formatNumber(leads.total) : "—"}
                  emphasis
                />
              </div>
            </>
          ) : (
            <div className="text-xs text-muted-foreground">No new leads yet.</div>
          )}
        </Group>

        {/* Alerts */}
        <Group
          title="Alerts"
          icon={<AlertTriangle className="h-3.5 w-3.5" />}
          error={
            hasError(alerts) && !("pendingRedlines" in alerts)
              ? alerts._error
              : undefined
          }
        >
          {"pendingRedlines" in alerts ? (
            <>
              <Row
                label="Pending redlines"
                value={
                  <span
                    className={
                      alerts.pendingRedlines > 0 ? "text-rose-400" : "text-emerald-400"
                    }
                  >
                    {formatNumber(alerts.pendingRedlines)}
                  </span>
                }
              />
              <Row
                label="Attribution review"
                value={
                  <span
                    className={
                      alerts.attributionReview > 0
                        ? "text-amber-400"
                        : "text-emerald-400"
                    }
                  >
                    {formatNumber(alerts.attributionReview)}
                  </span>
                }
              />
            </>
          ) : null}
        </Group>
      </CardContent>
    </Card>
  );
}
