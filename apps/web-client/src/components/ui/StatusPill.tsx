import * as React from "react";
import { cn } from "@/lib/utils/cn";

export type StatusTone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "accent";

const toneClasses: Record<StatusTone, string> = {
  neutral: "bg-muted text-muted-foreground ring-1 ring-inset ring-border",
  info: "bg-sky-50 text-sky-700 ring-1 ring-inset ring-sky-200",
  success: "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200",
  warning: "bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-200",
  danger: "bg-rose-50 text-rose-700 ring-1 ring-inset ring-rose-200",
  accent: "bg-primary/10 text-primary ring-1 ring-inset ring-primary/20",
};

export interface StatusPillProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: StatusTone;
  dotted?: boolean;
}

export function StatusPill({
  tone = "neutral",
  dotted,
  className,
  children,
  ...props
}: StatusPillProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
        toneClasses[tone],
        className,
      )}
      {...props}
    >
      {dotted ? (
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            tone === "success" && "bg-emerald-500",
            tone === "warning" && "bg-amber-500",
            tone === "danger" && "bg-rose-500",
            tone === "info" && "bg-sky-500",
            tone === "neutral" && "bg-muted-foreground/50",
            tone === "accent" && "bg-primary",
          )}
        />
      ) : null}
      {children}
    </span>
  );
}

/** Heuristic mapping for RingCentral & workflow statuses. */
export function toneFromStatus(status?: string | null): StatusTone {
  if (!status) return "neutral";
  const s = status.toLowerCase();
  if (["available", "online", "completed", "delivered", "sent", "active", "ok"].some((t) => s.includes(t))) {
    return "success";
  }
  if (["ringing", "oncall", "on call", "busy", "call connected", "processing"].some((t) => s.includes(t))) {
    return "info";
  }
  if (["pending", "queued", "paused", "away", "disposition", "waiting"].some((t) => s.includes(t))) {
    return "warning";
  }
  if (["failed", "offline", "error", "suppressed", "dnc"].some((t) => s.includes(t))) {
    return "danger";
  }
  return "neutral";
}
