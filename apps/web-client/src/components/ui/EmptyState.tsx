import * as React from "react";
import { cn } from "@/lib/utils/cn";

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-muted/30 px-6 py-12 text-center",
        className,
      )}
    >
      {icon ? (
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:h-5 [&_svg]:w-5">
          {icon}
        </div>
      ) : null}
      <div className="space-y-1">
        <div className="text-sm font-semibold text-foreground">{title}</div>
        {description ? (
          <div className="mx-auto max-w-md text-xs text-muted-foreground">{description}</div>
        ) : null}
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

interface GapCardProps {
  title: string;
  description?: React.ReactNode;
  routes?: string[];
  className?: string;
}

/**
 * Standard card shown when a workspace needs a 5001 route that doesn't
 * exist yet. Lists the proposed routes so Codex has a concrete punchlist.
 */
export function GapCard({ title, description, routes, className }: GapCardProps) {
  return (
    <div
      className={cn(
        "rounded-lg border border-dashed border-border bg-card p-5 shadow-soft",
        className,
      )}
    >
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-full bg-amber-500" />
          <span className="text-xs font-semibold uppercase tracking-wide text-amber-700">
            Awaiting 5001 route
          </span>
        </div>
        <div className="text-sm font-semibold text-foreground">{title}</div>
        {description ? (
          <div className="text-xs text-muted-foreground">{description}</div>
        ) : null}
      </div>
      {routes && routes.length > 0 ? (
        <ul className="mt-3 space-y-1">
          {routes.map((r) => (
            <li
              key={r}
              className="font-mono text-[11px] text-muted-foreground"
            >
              {r}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
