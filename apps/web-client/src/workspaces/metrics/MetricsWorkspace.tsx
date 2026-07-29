import * as React from "react";
import { Banknote, CalendarRange, PhoneCall } from "lucide-react";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Button } from "@/components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle, KpiCard } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { StatusPill } from "@/components/ui/StatusPill";
import { useMetricsSimpleSources } from "@/lib/api/queries/metrics";
import type { SimpleMarketingRow } from "@/lib/api/queries/metrics";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { AttributionReviewPanel } from "./AttributionReviewPanel";
import { PaymentsCsvImportCard } from "./PaymentsCsvImportCard";

// Spartan rebuild (2026-07-24): active sources only — the 3 live mailers,
// one "Aged" rollup for stray trickle, LD when the spend feed lands.
// Responses = CallRail originations (first-time callers). Reads ONLY the
// lean /simple-sources endpoint (DailyCallStat + SpendEntry + PaymentLedger
// + CaseProfile — no legacy aggregation layers, sub-second). Numbers return
// to this board one at a time as each pipeline is proven.

const METRICS_TIMEZONE = "America/Los_Angeles";
const PAYMENTS_CSV_IMPORT_VISIBLE = false;
function today() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: METRICS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function monthStart() {
  const date = new Date();
  return new Date(date.getFullYear(), date.getMonth(), 1).toISOString().slice(0, 10);
}

function prevMonthStart() {
  const date = new Date();
  return new Date(date.getFullYear(), date.getMonth() - 1, 1).toISOString().slice(0, 10);
}

function prevMonthEnd() {
  const date = new Date();
  return new Date(date.getFullYear(), date.getMonth(), 0).toISOString().slice(0, 10);
}

function daysAgo(count: number) {
  const date = new Date();
  date.setDate(date.getDate() - count);
  return date.toISOString().slice(0, 10);
}

const QUICK_PRESETS = [
  { label: "Today", from: () => today(), to: () => today() },
  { label: "Yesterday", from: () => daysAgo(1), to: () => daysAgo(1) },
  { label: "Last 7d", from: () => daysAgo(7), to: () => today() },
  { label: "MTD", from: () => monthStart(), to: () => today() },
  { label: "Last Mo", from: () => prevMonthStart(), to: () => prevMonthEnd() },
];

function SourceRowsTable({ rows }: { rows: SimpleMarketingRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        No source activity in this range.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[920px] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase text-muted-foreground">
            <th className="px-4 py-2 pl-5 font-medium">Source</th>
            <th className="px-2 py-2 text-right font-medium">Unique Leads</th>
            <th className="px-2 py-2 text-right font-medium">Calls</th>
            <th className="px-2 py-2 text-right font-medium">&gt;5m</th>
            <th className="px-2 py-2 text-right font-medium">Spend</th>
            <th className="px-2 py-2 text-right font-medium">Cost/Lead</th>
            <th className="px-2 py-2 text-right font-medium">Deals</th>
            <th className="px-2 py-2 text-right font-medium">Initial $</th>
            <th className="px-2 py-2 text-right font-medium">Collected</th>
            <th className="px-2 py-2 pr-5 text-right font-medium">Days</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.source}
              className={
                row.source === "Aged"
                  ? "border-b border-border/50 text-muted-foreground"
                  : "border-b border-border/50"
              }
            >
              <td className="px-4 py-2 pl-5">{row.source}</td>
              <td className="numeric px-2 py-2 text-right font-semibold">{formatNumber(row.responses)}</td>
              <td className="numeric px-2 py-2 text-right">{formatNumber(row.calls)}</td>
              <td className="numeric px-2 py-2 text-right">{formatNumber(row.over5)}</td>
              <td className="numeric px-2 py-2 text-right">
                {row.spend > 0 ? formatCurrency(row.spend, true) : "—"}
              </td>
              <td className="numeric px-2 py-2 text-right">
                {row.costPerResponse != null ? formatCurrency(row.costPerResponse, true) : "—"}
              </td>
              <td className="numeric px-2 py-2 text-right font-semibold">
                {row.deals !== 0 ? formatNumber(row.deals) : "\u2014"}
              </td>
              <td className="numeric px-2 py-2 text-right">
                {row.initialsNet !== 0 ? formatCurrency(row.initialsNet, true) : "\u2014"}
              </td>
              <td className="numeric px-2 py-2 text-right">
                {row.totalCollected !== 0
                  ? formatCurrency(row.totalCollected, true)
                  : "\u2014"}
              </td>
              <td className="numeric px-2 py-2 pr-5 text-right">{formatNumber(row.activeDays)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MetricsWorkspace() {
  const metricsScope = "ALL";
  const [dateRange, setDateRange] = React.useState(() => ({
    from: monthStart(),
    to: today(),
    label: "MTD",
  }));

  const rangeFilters = React.useMemo(
    () => ({ from: dateRange.from, to: dateRange.to }),
    [dateRange.from, dateRange.to],
  );

  const summary = useMetricsSimpleSources(metricsScope, rangeFilters);
  const rows = summary.data?.rows ?? [];
  const totals = summary.data?.totals ?? {
    responses: 0,
    calls: 0,
    spend: 0,
    ldLeads: 0,
    deals: 0,
    initialsNet: 0,
    totalCollected: 0,
    paymentsCount: 0,
    multiplePositiveInitialCases: 0,
    costPerResponse: null,
  };
  const feeds = summary.data?.feeds;

  const feedAge = (iso: string | null | undefined) => {
    if (!iso) return "never";
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 90) return `${mins}m ago`;
    if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`;
    return `${Math.round(mins / (24 * 60))}d ago`;
  };

  const handlePreset = React.useCallback((label: string, from: string, to: string) => {
    setDateRange({ from, to, label });
  }, []);

  return (
    <div className="space-y-8">
      <SectionHeader
        eyebrow="Workspace"
        title="Metrics"
        description="Active sources only — unique leads are first-time callers (mail) and delivered leads (LD). Numbers return to this board as each pipeline is proven."
        actions={
          <StatusPill dotted tone={summary.isError ? "danger" : summary.isFetching ? "info" : "success"}>
            {summary.isError ? "Stale" : summary.isFetching ? "Refreshing" : "Live"}
          </StatusPill>
        }
      />

      <Card>
        <CardContent className="flex flex-wrap items-center gap-2 pt-6">
          {QUICK_PRESETS.map((preset) => (
            <Button
              key={preset.label}
              variant={dateRange.label === preset.label ? "primary" : "secondary"}
              size="sm"
              onClick={() => handlePreset(preset.label, preset.from(), preset.to())}
            >
              {preset.label}
            </Button>
          ))}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Input
              type="date"
              value={dateRange.from}
              onChange={(event) =>
                setDateRange((current) => ({ ...current, from: event.target.value, label: "Custom" }))
              }
              className="h-9 w-[150px]"
            />
            <span className="text-sm text-muted-foreground">to</span>
            <Input
              type="date"
              value={dateRange.to}
              onChange={(event) =>
                setDateRange((current) => ({ ...current, to: event.target.value, label: "Custom" }))
              }
              className="h-9 w-[150px]"
            />
          </div>
        </CardContent>
      </Card>

      <section aria-label="Headline numbers">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-5">
          <KpiCard
            label={`Unique leads — mail (${dateRange.label})`}
            value={formatNumber(totals.responses)}
            hint={`${formatNumber(totals.calls)} total calls · ${formatNumber(totals.ldLeads)} LD leads`}
            icon={<PhoneCall className="h-4 w-4" />}
          />
          <KpiCard
            label={`Deals (${dateRange.label})`}
            value={formatNumber(totals.deals)}
            hint={`${formatCurrency(totals.initialsNet, true)} net initial payments`}
            icon={<Banknote className="h-4 w-4" />}
          />
          <KpiCard
            label={`Collected (${dateRange.label})`}
            value={formatCurrency(totals.totalCollected, true)}
            hint={`${formatNumber(totals.paymentsCount)} successful payment rows`}
            icon={<Banknote className="h-4 w-4" />}
          />
          <KpiCard
            label={`Marketing spend (${dateRange.label})`}
            value={totals.spend > 0 ? formatCurrency(totals.spend, true) : "—"}
            hint={totals.spend > 0 ? "Mail sheet + LD" : "Spend feed coming online"}
            icon={<Banknote className="h-4 w-4" />}
          />
          <KpiCard
            label={`Cost per lead — mail (${dateRange.label})`}
            value={totals.costPerResponse != null ? formatCurrency(totals.costPerResponse, true) : "—"}
            hint={`${dateRange.from} to ${dateRange.to}`}
            icon={<CalendarRange className="h-4 w-4" />}
          />
        </div>
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Source performance
            <StatusPill tone="info">{dateRange.label}</StatusPill>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <SourceRowsTable rows={rows} />
        </CardContent>
      </Card>

      {PAYMENTS_CSV_IMPORT_VISIBLE ? <PaymentsCsvImportCard /> : null}

      <AttributionReviewPanel domain={metricsScope} />

      {feeds ? (
        <div className="text-center text-[11px] text-muted-foreground">
          Feeds — CallRail sync {feedAge(feeds.callrail.lastSyncedAt)} (through {feeds.callrail.latestDay ?? "—"}) ·
          Spend sheet {feedAge(feeds.spend.lastSyncedAt)} ·
          PhoneBurner bridge {feedAge(feeds.phoneburner?.lastProjectedCallAt)} {" / "}
          Payments reconcile {feedAge(feeds.payments.lastReconciledAt)}
          {feeds.payments.lastSource ? ` (${feeds.payments.lastSource})` : ""}
        </div>
      ) : null}
    </div>
  );
}
