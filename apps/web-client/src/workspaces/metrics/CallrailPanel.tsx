import { type UseQueryResult } from "@tanstack/react-query";
import { ErrorState } from "@/components/ui/ErrorState";
import { SkeletonRow } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import type {
  MetricsCallrailPieceRow,
  MetricsCallrailSummary,
} from "@/lib/api/types";
import { formatDuration, formatNumber } from "@/lib/utils/format";

interface Props {
  query: UseQueryResult<MetricsCallrailSummary>;
}

export function CallrailPanel({ query }: Props) {
  if (query.isError) {
    return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  }
  if (query.isLoading) {
    return <SkeletonRow count={4} />;
  }

  const rows: MetricsCallrailPieceRow[] = (query.data?.rows ?? []).slice(0, 12);
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No calls yet"
        description="Callrail data will appear as new calls land."
      />
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs uppercase tracking-wide text-muted-foreground">
          <tr className="border-b border-border">
            <th className="py-2 text-left">Piece</th>
            <th className="py-2 text-left">Channel</th>
            <th className="py-2 text-right">Total</th>
            <th className="py-2 text-right">Over 2m</th>
            <th className="py-2 text-right">Over 5m</th>
            <th className="py-2 text-right">Unique</th>
            <th className="py-2 text-right">Duration</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const piece = row._id?.piece ?? "—";
            const channel = row._id?.channel ?? null;
            return (
              <tr key={`${piece}-${i}`} className="border-b border-border/60 last:border-b-0">
                <td className="py-2 font-medium">{piece}</td>
                <td className="py-2 text-xs uppercase tracking-wide text-muted-foreground">
                  {channel ?? "—"}
                </td>
                <td className="numeric py-2 text-right">
                  {formatNumber(row.totalCalls)}
                </td>
                <td className="numeric py-2 text-right">
                  {formatNumber(row.callsOver2)}
                </td>
                <td className="numeric py-2 text-right">
                  {formatNumber(row.callsOver5)}
                </td>
                <td className="numeric py-2 text-right">
                  {formatNumber(row.uniqueCallers)}
                </td>
                <td className="numeric py-2 text-right text-muted-foreground">
                  {formatDuration(row.totalDuration)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
