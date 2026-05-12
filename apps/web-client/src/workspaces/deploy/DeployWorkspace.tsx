import * as React from "react";
import {
  ExternalLink,
  GitBranch,
  Rocket,
  RotateCcw,
  Server,
  Terminal,
  Undo2,
} from "lucide-react";
import { SectionHeader } from "@/components/ui/SectionHeader";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Input";
import { StatusPill, type StatusTone } from "@/components/ui/StatusPill";
import { SkeletonRow } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/ErrorState";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { EmptyState } from "@/components/ui/EmptyState";
import { toast } from "@/components/ui/Toaster";
import { useActiveDomain } from "@/lib/domain/useActiveDomain";
import {
  useDeployWorkspace,
  useTriggerLocalDeploy,
} from "@/lib/api/queries/deploy";
import type {
  LocalDeployAction,
  LocalDeployActionResult,
  LocalDeployTarget,
} from "@/lib/api/types";
import { BlogBotCard } from "./BlogBotCard";
import { LandingPagesCard } from "./LandingPagesCard";

// Inline error boundary for each top-level card in the Deploy workspace.
// Without this, a render error in (say) BlogBotCard takes the entire
// workspace down to the AdminShell-level boundary. With this, the
// broken card shows its own red panel and the other cards keep
// working — which also tells us at a glance which card is the
// culprit.
function CardErrorBoundary({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <ErrorBoundary
      fallback={({ error, reset }) => (
        <div className="flex flex-col gap-3 rounded-lg border border-rose-200 bg-rose-50/60 p-5 text-sm">
          <div className="font-semibold text-rose-700">
            {label} — render error
          </div>
          <pre className="w-full overflow-x-auto whitespace-pre-wrap rounded-md bg-white/70 p-3 text-xs text-rose-900/80">
            {error.message}
          </pre>
          <button
            type="button"
            onClick={reset}
            className="self-start rounded-md border border-rose-300 bg-white px-3 py-1 text-xs font-medium text-rose-700 hover:bg-rose-100"
          >
            Retry this card
          </button>
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  );
}

// Deploy workspace — simplified to just the local SSH-based deploy
// path (the `node scripts/deploy.js` CLI we ported from legacy) plus
// the Blog Bot tracker. The GitHub Actions integration that lived
// here previously is dropped from the UI; the backend route still
// exists for ad-hoc curl/CLI use but isn't a daily-operator surface.

const LOCAL_ACTION_LABEL: Record<LocalDeployAction, string> = {
  status: "Check status",
  deploy: "Deploy",
  restart: "Restart PM2",
  rollback: "Rollback",
};

const LOCAL_ACTION_ICON: Record<LocalDeployAction, React.ReactNode> = {
  status: <Server className="h-3.5 w-3.5" />,
  deploy: <Rocket className="h-3.5 w-3.5" />,
  restart: <RotateCcw className="h-3.5 w-3.5" />,
  rollback: <Undo2 className="h-3.5 w-3.5" />,
};

function localTargetTone(target: LocalDeployTarget): StatusTone {
  if (!target.ready) return "warning";
  if ((target.repo?.dirtyCount ?? 0) > 0) return "info";
  return "success";
}

function summarizeLocalCommandResult(
  result: LocalDeployActionResult | null,
): string | null {
  if (!result) return null;
  const blob = (result.result || {}) as Record<string, unknown>;
  // Helper to pluck a string-ish field if present.
  const pluck = (key: string): string | null => {
    const value = blob[key];
    return typeof value === "string" && value.trim() ? value : null;
  };
  const fallback = `${result.action} complete`;
  return (
    pluck("summary") ??
    pluck("message") ??
    pluck("note") ??
    fallback
  );
}

export function DeployWorkspace() {
  const domain = useActiveDomain();
  const workspace = useDeployWorkspace(domain);
  const localTrigger = useTriggerLocalDeploy();

  const localDeploy = workspace.data?.localDeploy;
  const localTargets: LocalDeployTarget[] = localDeploy?.targets ?? [];

  const [localNotes, setLocalNotes] = React.useState<Record<string, string>>({});
  const [localResult, setLocalResult] =
    React.useState<LocalDeployActionResult | null>(null);

  async function onLocalAction(
    target: LocalDeployTarget,
    action: LocalDeployAction,
  ) {
    if (!target.ready && action !== "status") return;
    const destructive =
      action === "deploy" || action === "restart" || action === "rollback";
    const note = localNotes[target.key]?.trim() || undefined;
    if (destructive) {
      const ok = window.confirm(
        `${LOCAL_ACTION_LABEL[action]} ${target.label}? This will run against ${target.host ?? "the configured host"}.`,
      );
      if (!ok) return;
    }
    try {
      const result = await localTrigger.mutateAsync({
        targetKey: target.key,
        action,
        note,
        confirm: destructive ? target.key : undefined,
      });
      setLocalResult(result);
      toast.success(`${LOCAL_ACTION_LABEL[action]} finished`, {
        description: summarizeLocalCommandResult(result) ?? target.label,
      });
    } catch (err) {
      toast.error(`${LOCAL_ACTION_LABEL[action]} failed`, {
        description: (err as Error).message,
      });
    }
  }

  return (
    <div className="space-y-8">
      <SectionHeader
        eyebrow="Operations"
        title="Deploy"
        description="SSH-based deploys for the two sales sites + blog bot pipeline status. Uses scripts/deploy.js under the hood — same command line you run manually."
        actions={
          <StatusPill
            dotted
            tone={
              workspace.isError
                ? "danger"
                : localDeploy?.configured
                  ? "success"
                  : "warning"
            }
          >
            {workspace.isError
              ? "Error"
              : localDeploy?.configured
                ? "SSH configured"
                : "Needs local config"}
          </StatusPill>
        }
      />

      <CardErrorBoundary label="Sales sites">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Terminal className="h-4 w-4" />
            Sales sites
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {workspace.isError ? (
            <ErrorState
              error={workspace.error}
              onRetry={() => workspace.refetch()}
            />
          ) : workspace.isLoading && !workspace.data ? (
            <SkeletonRow count={2} />
          ) : localTargets.length === 0 ? (
            <EmptyState
              icon={<Terminal />}
              title="No local sales-site deploy targets"
              description={
                localDeploy?.loadError ??
                "scripts/deployService.js is not available to the control-plane."
              }
            />
          ) : (
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              {localTargets.map((target) => {
                const pendingAction =
                  localTrigger.isPending &&
                  localTrigger.variables?.targetKey === target.key
                    ? localTrigger.variables?.action
                    : null;
                return (
                  <div
                    key={target.key}
                    className="rounded-lg border border-border p-4"
                  >
                    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold">
                            {target.label}
                          </span>
                          <StatusPill tone={localTargetTone(target)} dotted>
                            {target.ready
                              ? (target.repo?.dirtyCount ?? 0) > 0
                                ? `${target.repo?.dirtyCount} local change(s)`
                                : "Ready"
                              : `Needs ${target.missing?.join(" + ") || "config"}`}
                          </StatusPill>
                        </div>
                        <div className="mt-2 grid gap-1 text-xs text-muted-foreground">
                          <span className="truncate">
                            <Server className="mr-1 inline h-3.5 w-3.5" />
                            {target.user}@{target.host}:{target.remotePath}
                          </span>
                          <span className="truncate">
                            <GitBranch className="mr-1 inline h-3.5 w-3.5" />
                            {target.repo?.branch ?? target.branch ?? "branch?"}
                            {target.repo?.headSha
                              ? ` - ${target.repo.headSha} ${target.repo.headMessage ?? ""}`
                              : ""}
                          </span>
                          <span className="truncate font-mono">
                            {target.localRepoPath || "No local repo path"}
                          </span>
                        </div>
                      </div>
                      {target.url ? (
                        <Button asChild size="sm" variant="secondary">
                          <a
                            href={target.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                            Open
                          </a>
                        </Button>
                      ) : null}
                    </div>

                    {target.warnings?.length ? (
                      <div className="mt-3 rounded-md border border-warning/30 bg-warning/10 p-3 text-xs text-warning-foreground">
                        {target.warnings.map((warning) => (
                          <div key={warning}>{warning}</div>
                        ))}
                      </div>
                    ) : null}

                    {target.repo?.dirtyPreview?.length ? (
                      <div className="mt-3 rounded-md bg-muted p-3">
                        <div className="text-xs font-medium text-foreground">
                          Local files waiting on this site
                        </div>
                        <pre className="mt-2 max-h-24 overflow-auto text-xs text-muted-foreground">
                          {target.repo.dirtyPreview.join("\n")}
                        </pre>
                      </div>
                    ) : null}

                    <div className="mt-4 space-y-2">
                      <Label htmlFor={`deploy-note-${target.key}`}>
                        Commit note for deploy
                      </Label>
                      <Input
                        id={`deploy-note-${target.key}`}
                        placeholder="optional, e.g. update sales page copy"
                        value={localNotes[target.key] ?? ""}
                        onChange={(event) =>
                          setLocalNotes((current) => ({
                            ...current,
                            [target.key]: event.target.value,
                          }))
                        }
                      />
                      <p className="text-xs text-muted-foreground">
                        Leave blank to deploy already committed work. Add a note
                        to commit local dirty files before deploy.
                      </p>
                    </div>

                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      {(
                        ["status", "deploy", "restart", "rollback"] as LocalDeployAction[]
                      ).map((action) => (
                        <Button
                          key={action}
                          size="sm"
                          variant={
                            action === "deploy"
                              ? "primary"
                              : action === "rollback"
                                ? "destructive"
                                : "secondary"
                          }
                          disabled={
                            (action !== "status" && !target.ready) ||
                            (localTrigger.isPending && pendingAction !== action)
                          }
                          isLoading={pendingAction === action}
                          onClick={() => onLocalAction(target, action)}
                        >
                          {LOCAL_ACTION_ICON[action]}
                          {LOCAL_ACTION_LABEL[action]}
                        </Button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {localResult ? (
            <div className="mt-4 rounded-lg border border-border bg-muted/40 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-semibold">
                  Last local command: {localResult.label}
                </div>
                <StatusPill tone="success">
                  {LOCAL_ACTION_LABEL[localResult.action]}
                </StatusPill>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {summarizeLocalCommandResult(localResult)}
              </div>
              {localResult.logs?.length ? (
                <pre className="mt-3 max-h-64 overflow-auto rounded-md bg-background p-3 text-xs text-muted-foreground">
                  {localResult.logs.slice(-80).join("\n")}
                </pre>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>
      </CardErrorBoundary>

      <CardErrorBoundary label="Blog bot">
        <BlogBotCard />
      </CardErrorBoundary>

      <CardErrorBoundary label="Landing pages">
        <LandingPagesCard />
      </CardErrorBoundary>

      <Card className="border-dashed">
        <CardContent className="space-y-1 py-4 text-xs text-muted-foreground">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-foreground">
            CLI reference
          </div>
          <p>
            <span className="font-mono">node scripts/deploy.js deploy &lt;tag|wynn&gt; --pull</span>{" "}
            — push, ssh-pull, npm install, pm2 restart
          </p>
          <p>
            <span className="font-mono">node scripts/deploy.js status &lt;tag|wynn&gt;</span>{" "}
            — what's live on EC2
          </p>
          <p>
            <span className="font-mono">node scripts/deploy.js rollback &lt;tag|wynn&gt;</span>{" "}
            — revert EC2 to previous commit
          </p>
          <p>
            <span className="font-mono">node scripts/blogger-daily-runner.js --force</span>{" "}
            — force-run today's blog pipeline (same as the Blog Bot "Run now" button)
          </p>
          <p>
            Full layout reference:{" "}
            <span className="font-mono">ops/site-infrastructure.md</span>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
