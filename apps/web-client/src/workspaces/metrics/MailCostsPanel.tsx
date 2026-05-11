import { type UseQueryResult } from "@tanstack/react-query";
import { ErrorState } from "@/components/ui/ErrorState";
import { SkeletonRow } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import type { MetricsMailCosts } from "@/lib/api/types";
import { formatCurrency, formatNumber } from "@/lib/utils/format";

interface Props {
  query: UseQueryResult<MetricsMailCosts>;
}

export function MailCostsPanel({ query }: Props) {
  if (query.isError) {
    return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  }
  if (query.isLoading) {
    return <SkeletonRow count={3} />;
  }

  const data = query.data;
  const totals = (data?.totals ?? {}) as { spend?: number; pieces?: number };
  const byPiece = (data?.byPiece ?? []).slice(0, 8);

  if (!data || ((!totals.spend && !totals.pieces) && byPiece.length === 0)) {
    return <EmptyState title="No mail costs yet" description="Spend and piece counts will appear once the next mail run lands." />;
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-md border border-border p-3">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Total spend
          </div>
          <div className="numeric mt-1 text-lg font-semibold">
            {formatCurrency(totals.spend)}
          </div>
        </div>
        <div className="rounded-md border border-border p-3">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Pieces
          </div>
          <div className="numeric mt-1 text-lg font-semibold">
            {formatNumber(totals.pieces)}
          </div>
        </div>
      </div>
      {byPiece.length > 0 ? (
        <ul className="divide-y divide-border text-sm">
          {byPiece.map((row, i) => {
            const r = row as Record<string, unknown>;
            return (
              <li key={i} className="flex items-center justify-between gap-3 py-2">
                <span className="truncate">
                  {(r.piece as string) ?? (r.name as string) ?? (r.code as string) ?? "—"}
                </span>
                <span className="numeric tabular-nums text-muted-foreground">
                  {formatCurrency((r.spend as number) ?? 0)}
                  <span className="mx-1.5">·</span>
                  {formatNumber((r.pieces as number) ?? 0)}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
