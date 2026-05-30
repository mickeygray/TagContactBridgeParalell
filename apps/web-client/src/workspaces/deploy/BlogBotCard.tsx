import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  PenSquare,
  PlayCircle,
  RotateCcw,
  Server,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatusPill, type StatusTone } from "@/components/ui/StatusPill";
import { ErrorState } from "@/components/ui/ErrorState";
import { SkeletonRow } from "@/components/ui/Skeleton";
import { toast } from "@/components/ui/Toaster";
import {
  useBlogBotStatus,
  useTriggerBlogBotRun,
  type BlogBotRunLogEntry,
} from "@/lib/api/queries/blog-bot";
import { formatDateTime, formatRelative } from "@/lib/utils/format";

const OUTCOME_TONE: Record<BlogBotRunLogEntry["outcome"], StatusTone> = {
  success: "success",
  failed: "danger",
  skipped: "neutral",
  started: "info",
  unknown: "neutral",
};

const OUTCOME_LABEL: Record<BlogBotRunLogEntry["outcome"], string> = {
  success: "posted",
  failed: "failed",
  skipped: "skipped",
  started: "started",
  unknown: "unknown",
};

// Defensive read of a field that the type system says is a string but
// that the backend could theoretically return as something else (an
// object, a Date, etc.). Returns "" for anything that React can't
// render as a string child.
function asText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // Anything else — object, array, function — gets stringified rather
  // than handed to React as a child (which would throw
  // "Objects are not valid as a React child").
  try {
    return JSON.stringify(value);
  } catch {
    return "[unrenderable]";
  }
}

// Defensive .slice(0, 7) — short SHA. Returns "" for null/non-string.
function shortSha(hash: unknown): string {
  return typeof hash === "string" ? hash.slice(0, 7) : "";
}

export function BlogBotCard() {
  const status = useBlogBotStatus();
  const trigger = useTriggerBlogBotRun();
  const data = status.data;

  async function onTriggerRun() {
    try {
      const res = await trigger.mutateAsync();
      toast.success("Daily-runner spawned", {
        description: res.message,
      });
    } catch (err) {
      toast.error("Could not trigger run", {
        description: (err as Error).message,
      });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2">
            <PenSquare className="h-4 w-4" />
            Blog bot
          </span>
          {data ? (
            <StatusPill
              dotted
              tone={data.health.ok ? "success" : "warning"}
            >
              {data.health.ok ? (
                <span className="inline-flex items-center gap-1">
                  <ShieldCheck className="h-3 w-3" /> healthy
                </span>
              ) : (
                <span className="inline-flex items-center gap-1">
                  <ShieldAlert className="h-3 w-3" /> attention
                </span>
              )}
            </StatusPill>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 pt-0">
        {status.isError ? (
          <ErrorState error={status.error} onRetry={() => status.refetch()} />
        ) : status.isLoading || !data ? (
          <SkeletonRow count={4} />
        ) : (
          <>
            {/* Health issues */}
            {!data.health.ok ? (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
                <div className="mb-1 flex items-center gap-1.5 font-semibold text-amber-700 dark:text-amber-200">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  Issues
                </div>
                <ul className="ml-4 list-disc space-y-0.5">
                  {(Array.isArray(data.health?.issues) ? data.health.issues : []).map((issue, i) => (
                    <li key={i}>{asText(issue)}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {/* State + slug sync row */}
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Field
                label="Last run"
                value={
                  data.state?.lastRunDate ? (
                    <span>
                      <span className="text-xs text-muted-foreground">
                        {data.state.lastRunDate}
                      </span>
                      <span className="ml-2">
                        <StatusPill
                          tone={OUTCOME_TONE[data.lastRunOutcome]}
                          dotted
                        >
                          {OUTCOME_LABEL[data.lastRunOutcome]}
                        </StatusPill>
                      </span>
                    </span>
                  ) : (
                    "never"
                  )
                }
              />
              <Field
                label="Last posted slug"
                value={
                  data.state?.lastPostedId ? (
                    <span className="font-mono text-xs">
                      {data.state.lastPostedId}
                    </span>
                  ) : (
                    "—"
                  )
                }
              />
              <Field
                label="Slug sync (Wynn / TAG)"
                value={
                  <span className="inline-flex items-center gap-2">
                    <span className="font-mono text-xs">
                      {data.slugSync.wynnCount ?? "?"} /{" "}
                      {data.slugSync.tagCount ?? "?"}
                    </span>
                    <StatusPill
                      tone={data.slugSync.inSync ? "success" : "danger"}
                      dotted
                    >
                      {data.slugSync.inSync ? "in sync" : "drift"}
                    </StatusPill>
                  </span>
                }
              />
              <Field
                label="Friday rotation"
                value={
                  data.state?.lastFridayCategory ? (
                    <span className="text-xs">
                      last: {data.state.lastFridayCategory}
                    </span>
                  ) : (
                    "—"
                  )
                }
              />
            </div>

            {data.runtime ? (
              <div className="rounded-md border border-border p-3">
                <div className="mb-2 flex items-center justify-between gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <Server className="h-3 w-3" />
                    Control-plane runtime
                  </span>
                  <StatusPill
                    dotted
                    tone={data.runtime.running ? "info" : data.runtime.enabled ? "success" : "neutral"}
                  >
                    {data.runtime.running ? "running" : data.runtime.enabled ? "armed" : "disabled"}
                  </StatusPill>
                </div>
                <div className="grid grid-cols-1 gap-2 text-xs md:grid-cols-2">
                  <Field
                    label="Next run"
                    value={
                      data.runtime.nextRunAt ? (
                        <span title={formatDateTime(data.runtime.nextRunAt)}>
                          {formatRelative(data.runtime.nextRunAt)}
                        </span>
                      ) : (
                        "manual only"
                      )
                    }
                  />
                  <Field
                    label="Schedule"
                    value={`${String(data.runtime.hour).padStart(2, "0")}:${String(data.runtime.minute).padStart(2, "0")} ${data.runtime.timezone}`}
                  />
                  <Field
                    label="Wynn route"
                    value={
                      <span className="font-mono text-[10px]">
                        {asText(data.runtime.routing?.wynnRepo)}
                      </span>
                    }
                  />
                  <Field
                    label="TAG route"
                    value={
                      <span className="font-mono text-[10px]">
                        {asText(data.runtime.routing?.tagRepo)}
                      </span>
                    }
                  />
                </div>
              </div>
            ) : null}

            {/* Last published per repo */}
            <div className="rounded-md border border-border p-3">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Last bot publish (per repo)
              </div>
              <ul className="space-y-1.5 text-xs">
                <li className="flex items-start justify-between gap-3">
                  <span className="text-muted-foreground">Wynn</span>
                  <span className="min-w-0 flex-1 text-right">
                    {data.lastPublished?.wynn ? (
                      <>
                        <span className="font-mono">
                          {shortSha(data.lastPublished.wynn.hash)}
                        </span>{" "}
                        <span className="text-muted-foreground">
                          ({formatRelative(data.lastPublished.wynn.committedAt)})
                        </span>
                        <div className="truncate text-[11px] text-muted-foreground">
                          {asText(data.lastPublished.wynn.subject)}
                        </div>
                      </>
                    ) : (
                      "—"
                    )}
                  </span>
                </li>
                <li className="flex items-start justify-between gap-3">
                  <span className="text-muted-foreground">TAG</span>
                  <span className="min-w-0 flex-1 text-right">
                    {data.lastPublished?.tag ? (
                      <>
                        <span className="font-mono">
                          {shortSha(data.lastPublished.tag.hash)}
                        </span>{" "}
                        <span className="text-muted-foreground">
                          ({formatRelative(data.lastPublished.tag.committedAt)})
                        </span>
                        <div className="truncate text-[11px] text-muted-foreground">
                          {asText(data.lastPublished.tag.subject)}
                        </div>
                      </>
                    ) : (
                      "—"
                    )}
                  </span>
                </li>
              </ul>
            </div>

            {/* Recent runs */}
            <div>
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Recent runs ({data.recentRuns.length})
                </div>
                <Button
                  size="sm"
                  variant="primary"
                  isLoading={trigger.isPending}
                  onClick={onTriggerRun}
                >
                  <PlayCircle className="h-3.5 w-3.5" />
                  Run now
                </Button>
              </div>
              {data.recentRuns.length === 0 ? (
                <p className="py-2 text-xs text-muted-foreground">
                  No runs recorded yet.
                </p>
              ) : (
                <ul className="space-y-1 text-xs">
                  {data.recentRuns.slice(0, 6).map((run) => (
                    <li
                      key={asText(run?.name) || Math.random()}
                      className="flex items-center justify-between gap-2 rounded border border-border/60 px-2 py-1.5"
                    >
                      <span className="inline-flex items-center gap-2">
                        <StatusPill
                          tone={OUTCOME_TONE[run?.outcome] || "neutral"}
                          dotted
                        >
                          {OUTCOME_LABEL[run?.outcome] || asText(run?.outcome) || "unknown"}
                        </StatusPill>
                        <span
                          className="text-muted-foreground"
                          title={formatDateTime(run?.mtime)}
                        >
                          {formatRelative(run?.mtime)}
                        </span>
                      </span>
                      <span className="truncate font-mono text-[10px] text-muted-foreground">
                        {asText(run?.name).replace("-daily-runner.log", "")}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Recovery audits (only show section if any exist) */}
            {data.recentRecoveries.length > 0 ? (
              <div>
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <RotateCcw className="h-3 w-3" />
                    Recovery agent activity
                  </span>
                </div>
                <ul className="space-y-2 text-xs">
                  {data.recentRecoveries.slice(0, 4).map((rec) => (
                    <li
                      key={asText(rec?.name) || Math.random()}
                      className="rounded border border-border/60 p-2"
                    >
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <span className="inline-flex items-center gap-1.5">
                          <StatusPill
                            tone={rec?.autoExecuted ? "success" : "warning"}
                            dotted
                          >
                            {asText(rec?.classification)}
                          </StatusPill>
                          <span className="text-[10px] text-muted-foreground">
                            {asText(rec?.confidence)} confidence ·{" "}
                            {rec?.autoExecuted
                              ? "auto-recovered"
                              : "human needed"}
                          </span>
                        </span>
                        <span
                          className="text-[10px] text-muted-foreground"
                          title={formatDateTime(rec?.mtime)}
                        >
                          <Clock className="mr-0.5 inline h-2.5 w-2.5" />
                          {formatRelative(rec?.mtime)}
                        </span>
                      </div>
                      {rec?.diagnosisExcerpt ? (
                        <p className="line-clamp-2 text-muted-foreground">
                          {asText(rec.diagnosisExcerpt)}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                <CheckCircle2 className="mr-1 inline h-3 w-3 text-emerald-500" />
                No recovery actions on file. Pipeline has self-healed cleanly.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 text-sm font-medium">{value}</div>
    </div>
  );
}
