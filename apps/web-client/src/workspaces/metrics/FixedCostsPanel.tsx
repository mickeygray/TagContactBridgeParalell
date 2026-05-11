import { Wallet } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { formatCurrency } from "@/lib/utils/format";

/**
 * Fixed operating costs, pro-rated against the selected date range so
 * operators can see how overhead compares to spend/revenue for the
 * same window. Values match the old app (MetricsDashboard.js:233-242)
 * so blended metrics line up during the migration.
 */
const FIXED_COSTS: Array<{ label: string; amount: number }> = [
  { label: "LexisNexis", amount: 2500 },
  { label: "CallRail", amount: 1200 },
  { label: "RingCentral", amount: 3000 },
  { label: "PhoneBurner", amount: 250 },
  { label: "AWS", amount: 250 },
  { label: "MongoDB", amount: 70 },
  { label: "AI", amount: 450 },
  { label: "SendGrid", amount: 80 },
];

const MONTH_DAYS = 30;

function daysBetween(from: string, to: string): number {
  const a = new Date(from);
  const b = new Date(to);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
  const diff = Math.max(0, b.getTime() - a.getTime());
  // +1 so "today to today" counts as 1 day rather than 0.
  return Math.max(1, Math.round(diff / (24 * 60 * 60 * 1000)) + 1);
}

export interface FixedCostsPanelProps {
  from: string;
  to: string;
  rangeLabel?: string;
}

export function FixedCostsPanel({ from, to, rangeLabel }: FixedCostsPanelProps) {
  const days = daysBetween(from, to);
  const proratioFactor = days / MONTH_DAYS;
  const monthlyTotal = FIXED_COSTS.reduce((sum, row) => sum + row.amount, 0);
  const rangeTotal = monthlyTotal * proratioFactor;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Wallet className="h-4 w-4 text-muted-foreground" />
            <CardTitle>Fixed costs</CardTitle>
          </div>
          <span className="text-xs text-muted-foreground">
            {days}d of {MONTH_DAYS} · {formatCurrency(monthlyTotal)}/mo
            {rangeLabel ? ` · ${rangeLabel}` : ""}
          </span>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="py-2 pr-2 font-medium">Service</th>
                <th className="py-2 px-2 text-right font-medium">Monthly</th>
                <th className="py-2 pl-2 text-right font-medium">This period</th>
              </tr>
            </thead>
            <tbody>
              {FIXED_COSTS.map((row) => (
                <tr key={row.label} className="border-b border-border/40 last:border-0">
                  <td className="py-1.5 pr-2 text-foreground">{row.label}</td>
                  <td className="numeric py-1.5 px-2 text-right text-muted-foreground">
                    {formatCurrency(row.amount)}
                  </td>
                  <td className="numeric py-1.5 pl-2 text-right">
                    {formatCurrency(row.amount * proratioFactor)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-muted/50 text-xs font-semibold uppercase tracking-wide">
                <td className="py-2 pr-2 text-muted-foreground">Total</td>
                <td className="numeric py-2 px-2 text-right">
                  {formatCurrency(monthlyTotal)}
                </td>
                <td className="numeric py-2 pl-2 text-right">
                  {formatCurrency(rangeTotal)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
