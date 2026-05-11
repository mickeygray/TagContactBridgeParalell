import * as React from "react";
import {
  AlertTriangle,
  Banknote,
  CalendarRange,
  CircleDollarSign,
  Handshake,
  Mail,
  PhoneCall,
  Shield,
  TrendingUp,
  Users,
} from "lucide-react";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Button } from "@/components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle, KpiCard } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { StatusPill } from "@/components/ui/StatusPill";
import {
  useMetricsCallrail,
  useMetricsDailySummary,
  useMetricsMailCosts,
  useMetricsPulse,
  useMetricsRedlines,
  useMetricsSources,
  useMetricsWorkspace,
} from "@/lib/api/queries/metrics";
import { formatCurrency, formatNumber, formatRatio } from "@/lib/utils/format";
import { SourcesPanel } from "./SourcesPanel";
import { DailySummaryPanel } from "./DailySummaryPanel";
import { RedlinesPanel } from "./RedlinesPanel";
import { MailCostsPanel } from "./MailCostsPanel";
import { CallrailPanel } from "./CallrailPanel";
import { FixedCostsPanel } from "./FixedCostsPanel";
import { DailyPulsePanel } from "./DailyPulsePanel";
import { getMetricRowValues } from "./metricFamilies";
import { AttributionReviewPanel } from "./AttributionReviewPanel";

const METRICS_TIMEZONE = "America/Los_Angeles";

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

function quarterStart() {
  const date = new Date();
  return new Date(date.getFullYear(), Math.floor(date.getMonth() / 3) * 3, 1).toISOString().slice(0, 10);
}

function yearStart() {
  return `${new Date().getFullYear()}-01-01`;
}

function daysAgo(count: number) {
  const date = new Date();
  date.setDate(date.getDate() - count);
  return date.toISOString().slice(0, 10);
}

function buildMonthPresets() {
  const date = new Date();
  const year = date.getFullYear();
  const currentMonth = date.getMonth();
  const labels = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  return Array.from({ length: currentMonth + 1 }, (_, index) => {
    const isCurrent = index === currentMonth;
    return {
      key: `${year}-${String(index + 1).padStart(2, "0")}`,
      label: labels[index],
      from: new Date(year, index, 1).toISOString().slice(0, 10),
      to: isCurrent ? today() : new Date(year, index + 1, 0).toISOString().slice(0, 10),
    };
  });
}

const QUICK_PRESETS = [
  { label: "Today", from: () => today(), to: () => today() },
  { label: "MTD", from: () => monthStart(), to: () => today() },
  { label: "Last Mo", from: () => prevMonthStart(), to: () => prevMonthEnd() },
  { label: "QTD", from: () => quarterStart(), to: () => today() },
  { label: "YTD", from: () => yearStart(), to: () => today() },
  { label: "Last 90d", from: () => daysAgo(90), to: () => today() },
  { label: "All Time", from: () => "2024-01-01", to: () => today() },
];

export function MetricsWorkspace() {
  const metricsScope = "ALL";
  const [dateRange, setDateRange] = React.useState(() => ({
    from: monthStart(),
    to: today(),
    label: "MTD",
  }));
  const [selectedDay, setSelectedDay] = React.useState(() => today());

  const monthPresets = React.useMemo(buildMonthPresets, []);
  const rangeFilters = React.useMemo(
    () => ({
      from: dateRange.from,
      to: dateRange.to,
    }),
    [dateRange.from, dateRange.to],
  );

  const workspace = useMetricsWorkspace(metricsScope);
  const sources = useMetricsSources(metricsScope, rangeFilters);
  const dayDetail = useMetricsDailySummary(metricsScope, selectedDay);
  const mail = useMetricsMailCosts(metricsScope, rangeFilters);
  const redlines = useMetricsRedlines(metricsScope);
  const callrail = useMetricsCallrail(metricsScope, rangeFilters);
  const pulse = useMetricsPulse(metricsScope);

  const ws = workspace.data;
  const lifetimeSlice = ws?.snapshots.lifetime;
  const sourceRows = sources.data?.rows ?? [];
  const rangeSpend = sourceRows.reduce((sum, row) => sum + getMetricRowValues(row).spend, 0);
  const rangeRevenue = sourceRows.reduce((sum, row) => sum + getMetricRowValues(row).paid, 0);
  const rangeLeads = sourceRows.reduce((sum, row) => {
    const values = getMetricRowValues(row);
    if (values.family === "ld" || values.family === "meta") {
      return sum + values.leads;
    }
    return sum;
  }, 0);
  const rangeDeals = sourceRows.reduce((sum, row) => sum + getMetricRowValues(row).deals, 0);
  const rangeCalls = sourceRows.reduce((sum, row) => sum + getMetricRowValues(row).totalCalls, 0);
  const rangeRoas = rangeSpend > 0 ? rangeRevenue / rangeSpend : null;

  const handlePreset = React.useCallback((label: string, from: string, to: string) => {
    setDateRange({ from, to, label });
  }, []);

  return (
    <div className="space-y-8">
      <SectionHeader
        eyebrow="Workspace"
        title="Metrics"
        description="Month-style reporting with expandable presets, plus a separate single-day detail panel."
        actions={
          <StatusPill dotted tone={workspace.isError ? "danger" : workspace.isFetching ? "info" : "success"}>
            {workspace.isError ? "Stale" : workspace.isFetching ? "Refreshing" : "Live"}
          </StatusPill>
        }
      />

      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="flex flex-wrap items-center gap-2">
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
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {new Date().getFullYear()}
            </span>
            {monthPresets.map((preset) => (
              <Button
                key={preset.key}
                variant={dateRange.from === preset.from && dateRange.to === preset.to ? "primary" : "secondary"}
                size="sm"
                onClick={() => handlePreset(preset.label, preset.from, preset.to)}
              >
                {preset.label}
              </Button>
            ))}
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Input
                type="date"
                value={dateRange.from}
                onChange={(event) =>
                  setDateRange((current) => ({
                    ...current,
                    from: event.target.value,
                    label: "Custom",
                  }))
                }
                className="h-9 w-[150px]"
              />
              <span className="text-sm text-muted-foreground">to</span>
              <Input
                type="date"
                value={dateRange.to}
                onChange={(event) =>
                  setDateRange((current) => ({
                    ...current,
                    to: event.target.value,
                    label: "Custom",
                  }))
                }
                className="h-9 w-[150px]"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <section aria-label="Headline KPIs">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
          <KpiCard
            label={`Leads (${dateRange.label})`}
            value={formatNumber(rangeLeads)}
            hint={`Range ${dateRange.from} to ${dateRange.to}`}
            icon={<Users className="h-4 w-4" />}
          />
          <KpiCard
            label={`Calls (${dateRange.label})`}
            value={formatNumber(rangeCalls)}
            hint={`Lifetime ${formatNumber(lifetimeSlice?.calls)}`}
            icon={<PhoneCall className="h-4 w-4" />}
          />
          <KpiCard
            label={`Spend (${dateRange.label})`}
            value={formatCurrency(rangeSpend, true)}
            hint={`Lifetime ${formatCurrency(lifetimeSlice?.spend)}`}
            icon={<Banknote className="h-4 w-4" />}
          />
          <KpiCard
            label={`Revenue (${dateRange.label})`}
            value={formatCurrency(rangeRevenue, true)}
            hint={`Lifetime ${formatCurrency(lifetimeSlice?.revenue)}`}
            icon={<CircleDollarSign className="h-4 w-4" />}
          />
          <KpiCard
            label={`Deals (${dateRange.label})`}
            value={formatNumber(rangeDeals)}
            hint={
              rangeDeals > 0 && rangeRevenue > 0
                ? `AOV ${formatCurrency(rangeRevenue / rangeDeals, true)}`
                : "No deals yet"
            }
            icon={<Handshake className="h-4 w-4" />}
          />
          <KpiCard
            label={`CPA (${dateRange.label})`}
            value={
              rangeSpend > 0 && rangeDeals > 0
                ? formatCurrency(rangeSpend / rangeDeals, true)
                : "—"
            }
            hint={
              rangeDeals > 0
                ? `${formatNumber(rangeDeals)} deal${rangeDeals === 1 ? "" : "s"}`
                : "Need deals"
            }
            icon={<CalendarRange className="h-4 w-4" />}
          />
          <KpiCard
            label={`ROAS (${dateRange.label})`}
            value={formatRatio(rangeRoas)}
            hint={`Lifetime ${formatRatio(lifetimeSlice?.roas)}`}
            icon={<TrendingUp className="h-4 w-4" />}
          />
          <KpiCard
            label="Redlines pending"
            value={formatNumber(redlines.data?.counts?.pending)}
            hint={
              (redlines.data?.counts?.pending ?? 0) > 0
                ? "Review in Metrics → Redlines"
                : "All clear"
            }
            icon={
              (redlines.data?.counts?.pending ?? 0) > 0 ? (
                <AlertTriangle className="h-4 w-4 text-rose-400" />
              ) : (
                <Shield className="h-4 w-4 text-emerald-400" />
              )
            }
          />
        </div>
      </section>

      <section aria-label="Inventory counts">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Card className="p-4">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Prospects
            </div>
            <div className="numeric mt-1 text-xl font-semibold">
              {formatNumber(ws?.counts.prospects)}
            </div>
          </Card>
          <Card className="p-4">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Case profiles
            </div>
            <div className="numeric mt-1 text-xl font-semibold">
              {formatNumber(ws?.counts.caseProfiles)}
            </div>
          </Card>
          <Card className="p-4">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Payments tracked
            </div>
            <div className="numeric mt-1 text-xl font-semibold">
              {formatNumber(ws?.counts.payments)}
            </div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Open review items
                </div>
                <div className="numeric mt-1 text-xl font-semibold">
                  {formatNumber(ws?.counts.openReviewItems)}
                </div>
              </div>
              {ws?.counts.openReviewItems && ws.counts.openReviewItems > 0 ? (
                <AlertTriangle className="h-4 w-4 text-amber-500" />
              ) : null}
            </div>
          </Card>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Source performance
              <StatusPill tone="info">{dateRange.label}</StatusPill>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <SourcesPanel
              query={sources}
              emptyHint={`No source metrics in ${dateRange.from} to ${dateRange.to}.`}
            />
          </CardContent>
        </Card>

        <DailyPulsePanel query={pulse} />
      </div>

      <AttributionReviewPanel domain={metricsScope} />

      <Card>
        <CardHeader className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <CardTitle>Day detail</CardTitle>
            <StatusPill tone="accent">{selectedDay}</StatusPill>
          </div>
          <Input
            type="date"
            value={selectedDay}
            onChange={(event) => setSelectedDay(event.target.value)}
            className="h-9 max-w-[180px]"
          />
        </CardHeader>
        <CardContent className="pt-0">
          <DailySummaryPanel query={dayDetail} />
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Mail className="h-4 w-4 text-muted-foreground" />
              Mail costs
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <MailCostsPanel query={mail} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Redlines & payment alerts</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <RedlinesPanel query={redlines} />
          </CardContent>
        </Card>
      </div>

      <FixedCostsPanel
        from={dateRange.from}
        to={dateRange.to}
        rangeLabel={dateRange.label}
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <PhoneCall className="h-4 w-4 text-muted-foreground" />
            Callrail aggregates
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <CallrailPanel query={callrail} />
        </CardContent>
      </Card>
    </div>
  );
}
