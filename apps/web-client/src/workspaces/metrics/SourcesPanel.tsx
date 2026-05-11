import * as React from "react";
import { type UseQueryResult } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { SkeletonRow } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/ErrorState";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/Button";
import type { MetricsSourceRow, MetricsSources } from "@/lib/api/types";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import {
  getMetricFamilyKey,
  getMetricRowValues,
  type MetricFamilyKey,
} from "./metricFamilies";

interface Props {
  query: UseQueryResult<MetricsSources>;
  emptyHint?: string;
}

/**
 * Per-channel visual accent — matches the old app's color scheme so
 * operators moving between the two see the same grouping at a glance.
 */
const CHANNEL_STYLE: Record<
  string,
  { label: string; order: number; barClass: string; chipClass: string }
> = {
  mail: {
    label: "Direct Mail",
    order: 1,
    barClass: "bg-amber-500",
    chipClass: "text-amber-400 border-amber-500/30 bg-amber-500/5",
  },
  bcd: {
    label: "BCD",
    order: 2,
    barClass: "bg-sky-500",
    chipClass: "text-sky-400 border-sky-500/30 bg-sky-500/5",
  },
  ld: {
    label: "Lead Data",
    order: 3,
    barClass: "bg-violet-500",
    chipClass: "text-violet-400 border-violet-500/30 bg-violet-500/5",
  },
  meta: {
    label: "Meta",
    order: 4,
    barClass: "bg-fuchsia-500",
    chipClass: "text-fuchsia-400 border-fuchsia-500/30 bg-fuchsia-500/5",
  },
  dialer: {
    label: "Dialer",
    order: 5,
    barClass: "bg-rose-500",
    chipClass: "text-rose-400 border-rose-500/30 bg-rose-500/5",
  },
};

const OTHER_STYLE = {
  label: "Other",
  order: 99,
  barClass: "bg-zinc-500",
  chipClass: "text-zinc-400 border-zinc-500/30 bg-zinc-500/5",
};

type RowMetrics = {
  spend: number;
  pieces: number;
  totalCalls: number;
  callsOver5: number;
  deals: number;
  initials: number;
  paid: number;
};

function rowMetrics(row: MetricsSourceRow): RowMetrics {
  const values = getMetricRowValues(row);
  return {
    spend: values.spend,
    pieces: values.pieces,
    totalCalls: values.totalCalls,
    callsOver5: values.callsOver5,
    deals: values.deals,
    initials: values.initials,
    paid: values.paid,
  };
}

/**
 * Old app uses `callsOver5` as the CPL denominator for mail/bcd/dialer
 * (phone-originated channels where conversions come from long calls),
 * and `leads` for ld/meta (form-based channels). Mirror that here so
 * CPL numbers line up when operators cross-check.
 */
function deriveCpl(channel: MetricFamilyKey, m: RowMetrics, row: MetricsSourceRow): number | null {
  if (m.spend <= 0) return null;
  const basis = channel === "ld" || channel === "meta"
    ? getMetricRowValues(row).leads
    : m.callsOver5;
  if (basis <= 0) return null;
  return m.spend / basis;
}

function deriveCpa(m: RowMetrics): number | null {
  if (m.spend <= 0 || m.deals <= 0) return null;
  return m.spend / m.deals;
}

function deriveRoas(m: RowMetrics): number | null {
  if (m.spend <= 0) return null;
  return m.initials / m.spend;
}

function deriveRoi(m: RowMetrics): number | null {
  if (m.spend <= 0) return null;
  return (m.paid - m.spend) / m.spend;
}

/**
 * Totals row per channel group — aggregates raw values then derives
 * CPL/CPA/ROAS/ROI from the aggregates (not an average of per-row
 * values, which would mislead on channels with uneven spend).
 */
function aggregateTotals(rows: MetricsSourceRow[]): RowMetrics & {
  cpl: number | null;
  cpa: number | null;
  roas: number | null;
  roi: number | null;
} {
  const total: RowMetrics = {
    spend: 0,
    pieces: 0,
    totalCalls: 0,
    callsOver5: 0,
    deals: 0,
    initials: 0,
    paid: 0,
  };
  let leadsBasis = 0;
  let usingLeads = false;
  for (const row of rows) {
    const m = rowMetrics(row);
    total.spend += m.spend;
    total.pieces += m.pieces;
    total.totalCalls += m.totalCalls;
    total.callsOver5 += m.callsOver5;
    total.deals += m.deals;
    total.initials += m.initials;
    total.paid += m.paid;
    const ch = getMetricFamilyKey(row);
    if (ch === "ld" || ch === "meta") {
      leadsBasis += getMetricRowValues(row).leads;
      usingLeads = true;
    }
  }
  const cplBasis = usingLeads ? leadsBasis : total.callsOver5;
  return {
    ...total,
    cpl: total.spend > 0 && cplBasis > 0 ? total.spend / cplBasis : null,
    cpa: total.spend > 0 && total.deals > 0 ? total.spend / total.deals : null,
    roas: total.spend > 0 ? total.initials / total.spend : null,
    roi: total.spend > 0 ? (total.paid - total.spend) / total.spend : null,
  };
}

function downloadCsv(filename: string, rows: string[][]) {
  const csv = rows
    .map((row) =>
      row
        .map((cell) => {
          const s = String(cell ?? "");
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(","),
    )
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function buildCsv(channelKey: MetricFamilyKey, rows: MetricsSourceRow[]): string[][] {
  const header = [
    "Source",
    "Spend",
    "Pieces",
    "Calls",
    channelKey === "ld" || channelKey === "meta" ? "Leads" : "Calls_Over_5m",
    "Deals",
    "Initials",
    "Paid",
    "CPC",
    "CPL",
    "CPA",
    "ROAS",
    "ROI",
  ];
  const body = rows.map((r) => {
    const m = rowMetrics(r);
    const cpc = m.spend > 0 && m.totalCalls > 0 ? m.spend / m.totalCalls : null;
    return [
      r.source ?? "",
      m.spend.toFixed(2),
      m.pieces.toString(),
      m.totalCalls.toString(),
      String(
        channelKey === "ld" || channelKey === "meta"
          ? getMetricRowValues(r).leads
          : m.callsOver5,
      ),
      m.deals.toString(),
      m.initials.toFixed(2),
      m.paid.toFixed(2),
      cpc != null ? cpc.toFixed(2) : "",
      (deriveCpl(channelKey, m, r) ?? 0).toFixed(2),
      (deriveCpa(m) ?? 0).toFixed(2),
      (deriveRoas(m) ?? 0).toFixed(4),
      (deriveRoi(m) ?? 0).toFixed(4),
    ];
  });
  return [header, ...body];
}

interface Bucket {
  key: MetricFamilyKey;
  style: {
    label: string;
    order: number;
    barClass: string;
    chipClass: string;
  };
  rows: MetricsSourceRow[];
}

function groupRows(rows: MetricsSourceRow[]): Bucket[] {
  const byChannel = new Map<MetricFamilyKey, MetricsSourceRow[]>();
  for (const row of rows) {
    const ch = getMetricFamilyKey(row);
    const m = rowMetrics(row);
    // Keep pure operational/no-revenue noise out of the report, but
    // let zero-cost revenue rows stay inside their real channel bucket.
    if (m.spend <= 0 && m.deals <= 0 && m.paid <= 0 && m.initials <= 0) {
      continue;
    }
    if (!byChannel.has(ch)) byChannel.set(ch, []);
    byChannel.get(ch)!.push(row);
  }
  const buckets: Bucket[] = [];
  for (const [key, bucketRows] of byChannel.entries()) {
    const style = CHANNEL_STYLE[key] || { ...OTHER_STYLE, label: key };
    buckets.push({ key, style, rows: bucketRows });
  }
  buckets.sort((a, b) => a.style.order - b.style.order);
  return buckets;
}

function ChannelSection({
  bucket,
  isUnpaid,
}: {
  bucket: Bucket;
  isUnpaid?: boolean;
}) {
  const sortedRows = React.useMemo(
    () =>
      [...bucket.rows].sort((a, b) => {
        const aM = rowMetrics(a);
        const bM = rowMetrics(b);
        if (aM.spend !== bM.spend) return bM.spend - aM.spend;
        if (aM.totalCalls !== bM.totalCalls) return bM.totalCalls - aM.totalCalls;
        return bM.initials - aM.initials;
      }),
    [bucket.rows],
  );
  const totals = React.useMemo(() => aggregateTotals(sortedRows), [sortedRows]);
  const ch = bucket.key as MetricFamilyKey;
  const leadsColLabel = ch === "ld" || ch === "meta" ? "Leads" : "> 5m";

  return (
    <div className="relative overflow-hidden rounded-lg border border-border bg-card/30">
      <div className={cn("absolute inset-y-0 left-0 w-1", bucket.style.barClass)} />
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5 pl-5">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">{bucket.style.label}</h3>
          <span
            className={cn(
              "rounded-full border px-2 py-[1px] text-[10px] uppercase tracking-wider",
              bucket.style.chipClass,
            )}
          >
            {sortedRows.length} source{sortedRows.length === 1 ? "" : "s"}
          </span>
        </div>
        {!isUnpaid ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              downloadCsv(
                `metrics-${bucket.key}-${new Date().toISOString().slice(0, 10)}.csv`,
                buildCsv(ch, sortedRows),
              )
            }
          >
            <Download className="h-3.5 w-3.5" />
            CSV
          </Button>
        ) : null}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2 pl-5 font-medium">Source</th>
              <th className="px-2 py-2 text-right font-medium">Spend</th>
              <th className="px-2 py-2 text-right font-medium">Pcs</th>
              <th className="px-2 py-2 text-right font-medium">Calls</th>
              <th className="px-2 py-2 text-right font-medium">{leadsColLabel}</th>
              <th className="px-2 py-2 text-right font-medium">Deals</th>
              <th className="px-2 py-2 text-right font-medium">Initials</th>
              <th className="px-2 py-2 text-right font-medium">Paid</th>
              {!isUnpaid ? (
                <>
                  <th className="px-2 py-2 text-right font-medium">CPL</th>
                  <th className="px-2 py-2 text-right font-medium">CPA</th>
                  <th className="px-2 py-2 text-right font-medium">ROAS</th>
                  <th className="px-2 py-2 pr-4 text-right font-medium">ROI</th>
                </>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row, i) => {
              const m = rowMetrics(row);
              const cpl = deriveCpl(ch, m, row);
              const cpa = deriveCpa(m);
              const roas = deriveRoas(m);
              const roi = deriveRoi(m);
              const leadsValue = ch === "ld" || ch === "meta"
                ? getMetricRowValues(row).leads
                : m.callsOver5;
              return (
                <tr
                  key={`${row.source}-${i}`}
                  className="border-b border-border/40 last:border-0"
                >
                  <td className="truncate max-w-[220px] px-4 py-1.5 pl-5 font-medium text-foreground">
                    {row.source ?? "—"}
                  </td>
                  <td className="numeric px-2 py-1.5 text-right">
                    {formatCurrency(m.spend)}
                  </td>
                  <td className="numeric px-2 py-1.5 text-right text-muted-foreground">
                    {formatNumber(m.pieces)}
                  </td>
                  <td className="numeric px-2 py-1.5 text-right text-sky-300">
                    {formatNumber(m.totalCalls)}
                  </td>
                  <td className="numeric px-2 py-1.5 text-right">
                    {formatNumber(leadsValue)}
                  </td>
                  <td className="numeric px-2 py-1.5 text-right text-emerald-400">
                    {formatNumber(m.deals)}
                  </td>
                  <td className="numeric px-2 py-1.5 text-right text-emerald-400">
                    {formatCurrency(m.initials)}
                  </td>
                  <td className="numeric px-2 py-1.5 text-right text-emerald-400">
                    {formatCurrency(m.paid)}
                  </td>
                  {!isUnpaid ? (
                    <>
                      <td className="numeric px-2 py-1.5 text-right">
                        {cpl != null ? formatCurrency(cpl, true) : "—"}
                      </td>
                      <td className="numeric px-2 py-1.5 text-right">
                        {cpa != null ? formatCurrency(cpa, true) : "—"}
                      </td>
                      <td className="numeric px-2 py-1.5 text-right">
                        <span
                          className={cn(
                            roas != null && roas >= 1
                              ? "text-emerald-400"
                              : "text-amber-300",
                          )}
                        >
                          {formatPercent(roas)}
                        </span>
                      </td>
                      <td className="numeric px-2 py-1.5 pr-4 text-right">
                        <span
                          className={cn(
                            roi != null && roi >= 0
                              ? "text-emerald-400"
                              : "text-rose-400",
                          )}
                        >
                          {formatPercent(roi)}
                        </span>
                      </td>
                    </>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="bg-muted/50 text-xs font-semibold uppercase tracking-wide">
              <td className="px-4 py-2 pl-5 text-muted-foreground">Total</td>
              <td className="numeric px-2 py-2 text-right">
                {formatCurrency(totals.spend)}
              </td>
              <td className="numeric px-2 py-2 text-right">
                {formatNumber(totals.pieces)}
              </td>
              <td className="numeric px-2 py-2 text-right text-sky-300">
                {formatNumber(totals.totalCalls)}
              </td>
              <td className="numeric px-2 py-2 text-right">
                {formatNumber(
                  ch === "ld" || ch === "meta"
                    ? sortedRows.reduce(
                        (sum, r) =>
                          sum + getMetricRowValues(r).leads,
                        0,
                      )
                    : totals.callsOver5,
                )}
              </td>
              <td className="numeric px-2 py-2 text-right text-emerald-400">
                {formatNumber(totals.deals)}
              </td>
              <td className="numeric px-2 py-2 text-right text-emerald-400">
                {formatCurrency(totals.initials)}
              </td>
              <td className="numeric px-2 py-2 text-right text-emerald-400">
                {formatCurrency(totals.paid)}
              </td>
              {!isUnpaid ? (
                <>
                  <td className="numeric px-2 py-2 text-right">
                    {totals.cpl != null ? formatCurrency(totals.cpl, true) : "—"}
                  </td>
                  <td className="numeric px-2 py-2 text-right">
                    {totals.cpa != null ? formatCurrency(totals.cpa, true) : "—"}
                  </td>
                  <td className="numeric px-2 py-2 text-right">
                    <span
                      className={cn(
                        totals.roas != null && totals.roas >= 1
                          ? "text-emerald-400"
                          : "text-amber-300",
                      )}
                    >
                      {formatPercent(totals.roas)}
                    </span>
                  </td>
                  <td className="numeric px-2 py-2 pr-4 text-right">
                    <span
                      className={cn(
                        totals.roi != null && totals.roi >= 0
                          ? "text-emerald-400"
                          : "text-rose-400",
                      )}
                    >
                      {formatPercent(totals.roi)}
                    </span>
                  </td>
                </>
              ) : null}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

export function SourcesPanel({ query, emptyHint }: Props) {
  if (query.isError) {
    return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  }
  if (query.isLoading) {
    return <SkeletonRow count={4} />;
  }
  const rows = query.data?.rows ?? [];
  if (rows.length === 0) {
    return <EmptyState title={emptyHint ?? "No sources yet."} />;
  }
  const buckets = groupRows(rows);
  return (
    <div className="space-y-3">
      {buckets.map((bucket) => (
        <ChannelSection
          key={bucket.key}
          bucket={bucket}
        />
      ))}
    </div>
  );
}
