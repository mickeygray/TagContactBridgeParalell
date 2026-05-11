import * as React from "react";
import { type UseQueryResult } from "@tanstack/react-query";
import { DataTable, type ColumnDef } from "@/components/ui/DataTable";
import { ErrorState } from "@/components/ui/ErrorState";
import { SkeletonRow } from "@/components/ui/Skeleton";
import type { MetricsDailySummary, MetricsDailySummaryRow } from "@/lib/api/types";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import {
  getMetricFamilyKey,
  getMetricFamilyLabel,
  getMetricRowValues,
} from "./metricFamilies";

interface Props {
  query: UseQueryResult<MetricsDailySummary>;
}

export function DailySummaryPanel({ query }: Props) {
  const columns = React.useMemo<ColumnDef<MetricsDailySummaryRow>[]>(
    () => [
      {
        accessorKey: "source",
        header: "Source",
        cell: (info) => (
          <span className="font-medium">{info.getValue<string>() ?? "-"}</span>
        ),
      },
      {
        accessorKey: "channel",
        header: "Channel",
        cell: (info) => (
          <span className="text-xs uppercase tracking-wide text-muted-foreground">
            {getMetricFamilyLabel(getMetricFamilyKey(info.row.original))}
          </span>
        ),
      },
      {
        accessorKey: "leadsReported",
        header: () => <span className="block text-right">Leads</span>,
        cell: (info) => (
          <div className="numeric text-right">
            {formatNumber(info.getValue<number>())}
          </div>
        ),
      },
      {
        accessorKey: "calls",
        header: () => <span className="block text-right">Calls</span>,
        cell: (info) => (
          <div className="numeric text-right">
            {formatNumber(info.getValue<number>())}
          </div>
        ),
      },
      {
        accessorKey: "deals",
        header: () => <span className="block text-right">Deals</span>,
        cell: (info) => (
          <div className="numeric text-right">
            {formatNumber(info.getValue<number>())}
          </div>
        ),
      },
      {
        accessorKey: "spend",
        header: () => <span className="block text-right">Spend</span>,
        cell: (info) => (
          <div className="numeric text-right">
            {formatCurrency(getMetricRowValues(info.row.original).spend)}
          </div>
        ),
      },
      {
        accessorKey: "paid",
        header: () => <span className="block text-right">Paid</span>,
        cell: (info) => (
          <div className="numeric text-right">
            {formatCurrency(info.getValue<number>())}
          </div>
        ),
      },
    ],
    [],
  );

  if (query.isError) {
    return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  }
  if (query.isLoading) {
    return <SkeletonRow count={4} />;
  }

  const rows = query.data?.rows ?? [];

  return (
    <DataTable
      columns={columns}
      data={rows}
      density="compact"
      empty={`No daily summary for ${query.data?.date ?? "today"}.`}
      className="border-0 shadow-none"
    />
  );
}
