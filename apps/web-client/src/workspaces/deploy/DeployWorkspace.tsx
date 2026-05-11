import * as React from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  ExternalLink,
  FileText,
  History,
  Loader2,
  RefreshCcw,
  Rocket,
  XCircle,
} from "lucide-react";
import { ConfirmDeployDialog } from "./ConfirmDeployDialog";
import { SectionHeader } from "@/components/ui/SectionHeader";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  KpiCard,
} from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatusPill, type StatusTone } from "@/components/ui/StatusPill";
import { SkeletonRow } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/ErrorState";
import { EmptyState, GapCard } from "@/components/ui/EmptyState";
import { toast } from "@/components/ui/Toaster";
import { useActiveDomain } from "@/lib/domain/useActiveDomain";
import {
  useCancelDeployRun,
  useDeployRuns,
  useDeployWorkspace,
  useTriggerDeploy,
} from "@/lib/api/queries/deploy";
import type { DeployAction, DeployRun, DeployTarget } from "@/lib/api/types";
import { formatNumber, formatRelative } from "@/lib/utils/format";

const ACTION_LABEL: Record<DeployAction, string> = {
  full: "Deploy",
  content: "Content push",
  restart: "Restart",
};

function runTone(run: DeployRun): StatusTone {
  if (run.status !== "completed") {
    if (run.status === "queued") return "warning";
    return "info";
  }
  switch (run.conclusion) {
    case "success":
      return "success";
    case "failure":
    case "timed_out":
    case "cancelled":
      return "danger";
    case "action_required":
      return "warning";
    default:
      return "neutral";
  }
}

function runLabel(run: DeployRun): string {
  if (run.status !== "completed") return run.status ?? "pending";
  return run.conclusion ?? "completed";
}

function runIcon(run: DeployRun) {
  if (run.status === "queued") return <History className="h-3.5 w-3.5" />;
  if (run.status === "in_progress")
    return <Loader2 className="h-3.5 w-3.5 animate-spin" />;
  if (run.conclusion === "success")
    return <CheckCircle2 className="h-3.5 w-3.5" />;
  if (run.conclusion === "failure" || run.conclusion === "timed_out")
    return <XCircle className="h-3.5 w-3.5" />;
  if (run.conclusion === "cancelled")
    return <CircleSlash className="h-3.5 w-3.5" />;
  return <Activity className="h-3.5 w-3.5" />;
}

export function DeployWorkspace() {
  const domain = useActiveDomain();
  const workspace = useDeployWorkspace(domain);
  const runs = useDeployRuns(null, 20);
  const trigger = useTriggerDeploy();
  const cancel = useCancelDeployRun();

  const deploy = workspace.data?.deploy;
  const configured = deploy?.configured ?? false;
  const targets = deploy?.targets ?? [];
  const recentRuns = runs.data?.runs ?? deploy?.recentRuns ?? [];

  const running = recentRuns.filter(
    (run) => run.status === "queued" || run.status === "in_progress",
  ).length;
  const failed = recentRuns.filter(
    (run) =>
      run.status === "completed" &&
      (run.conclusion === "failure" || run.conclusion === "timed_out"),
  ).length;

  const [pending, setPending] = React.useState<{
    target: DeployTarget;
    action: DeployAction;
  } | null>(null);

  async function onTrigger(target: DeployTarget, action: DeployAction) {
    if (!target.allowedActions.includes(action)) return;

    // Destructive actions (full, restart) always go through the type-to-confirm
    // dialog. Content pushes are one-click because they're lower-impact.
    if (action === "full" || action === "restart") {
      setPending({ target, action });
      return;
    }

    try {
      await trigger.mutateAsync({ targetKey: target.key, action });
      toast.success(`${ACTION_LABEL[action]} dispatched`, {
        description: target.label,
      });
    } catch (err) {
      toast.error(`${ACTION_LABEL[action]} failed`, {
        description: (err as Error).message,
      });
    }
  }

  async function onConfirmDestructive(args: { confirm: string; note: string }) {
    if (!pending) return;
    const { target, action } = pending;
    try {
      await trigger.mutateAsync({
        targetKey: target.key,
        action,
        confirm: args.confirm,
        note: args.note || undefined,
      });
      toast.success(`${ACTION_LABEL[action]} dispatched`, {
        description: target.label,
      });
      setPending(null);
    } catch (err) {
      toast.error(`${ACTION_LABEL[action]} failed`, {
        description: (err as Error).message,
      });
    }
  }

  async function onCancel(run: DeployRun) {
    if (!run.targetKey) {
      toast.error("Cancel failed", {
        description: "Run is missing a target key.",
      });
      return;
    }
    try {
      await cancel.mutateAsync({ runId: run.id, targetKey: run.targetKey });
      toast.success("Cancel requested", {
        description: `Run #${run.runNumber ?? run.id}`,
      });
    } catch (err) {
      toast.error("Cancel failed", { description: (err as Error).message });
    }
  }

  return (
    <div className="space-y-8">
      <SectionHeader
        eyebrow="Operations"
        title="Deploy"
        description="One-click GitHub Actions deploys. Every press records a workflow stage on 5001 and triggers the configured workflow_dispatch event."
        actions={
          <StatusPill
            dotted
            tone={
              workspace.isError
                ? "danger"
                : !configured
                  ? "warning"
                  : running > 0
                    ? "info"
                    : "success"
            }
          >
            {workspace.isError
              ? "Error"
              : !configured
                ? "Not configured"
                : running > 0
                  ? `${running} running`
                  : "Idle"}
          </StatusPill>
        }
      />

      {!configured ? (
        <GapCard
          title="GitHub is not wired up yet"
          description={
            (deploy?.missing?.length
              ? `Missing: ${deploy.missing.join(", ")}. `
              : "") +
            "Set GITHUB_OWNER, GITHUB_REPO, GITHUB_DEPLOY_TOKEN, and GITHUB_DEPLOY_TARGETS in the control-plane env to enable one-click deploys."
          }
          routes={[
            'GITHUB_DEPLOY_TARGETS=[{"key":"tag","label":"TAG production","workflow":"deploy.yml","ref":"main","inputs":{"brand":"TAG"}}]',
            "GITHUB_OWNER=your-org",
            "GITHUB_REPO=your-repo",
            "GITHUB_DEPLOY_TOKEN=ghp_... (scope: actions:write)",
          ]}
        />
      ) : null}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Targets"
          value={formatNumber(targets.length)}
          icon={<Rocket className="h-4 w-4" />}
        />
        <KpiCard
          label="Running"
          value={formatNumber(running)}
          hint="Queued or in progress"
          icon={<Loader2 className={running > 0 ? "h-4 w-4 animate-spin" : "h-4 w-4"} />}
        />
        <KpiCard
          label="Recent failures"
          value={formatNumber(failed)}
          hint="In last 20 runs"
          icon={<AlertTriangle className="h-4 w-4" />}
        />
        <KpiCard
          label="Ready targets"
          value={formatNumber(
            targets.filter((target) => target.ready !== false).length,
          )}
          hint={`of ${targets.length}`}
          icon={<FileText className="h-4 w-4" />}
        />
      </div>

      {configured && targets.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Targets</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <ul className="space-y-2">
              {targets.map((target) => {
                const targetRuns = recentRuns.filter(
                  (run) => run.targetKey === target.key,
                );
                const last = targetRuns[0] ?? null;
                const pendingAction =
                  trigger.isPending &&
                  trigger.variables?.targetKey === target.key
                    ? (trigger.variables?.action ?? null)
                    : null;
                const targetReady = target.ready !== false;
                return (
                  <li
                    key={target.key}
                    className="flex flex-col gap-3 rounded-lg border border-border p-4 md:flex-row md:items-center md:justify-between"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold">
                          {target.label}
                        </span>
                        <span className="font-mono text-xs text-muted-foreground">
                          {target.workflow} · {target.ref}
                        </span>
                      </div>
                      {target.description ? (
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {target.description}
                        </div>
                      ) : null}
                      {last ? (
                        <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                          <StatusPill tone={runTone(last)} dotted>
                            {runLabel(last)}
                          </StatusPill>
                          <span>run #{last.runNumber}</span>
                          <span>·</span>
                          <span>{formatRelative(last.updatedAt ?? last.createdAt ?? undefined)}</span>
                          {last.htmlUrl ? (
                            <a
                              href={last.htmlUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-0.5 text-primary hover:underline"
                            >
                              view
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {!targetReady ? (
                        <StatusPill tone="warning">
                          needs {target.missing?.join(" + ") || "config"}
                        </StatusPill>
                      ) : null}
                      {(["full", "content", "restart"] as DeployAction[])
                        .filter((action) => target.allowedActions.includes(action))
                        .map((action) => (
                          <Button
                            key={action}
                            size="sm"
                            variant={action === "full" ? "primary" : "secondary"}
                            isLoading={pendingAction === action}
                            disabled={
                              !targetReady ||
                              (trigger.isPending && pendingAction !== action)
                            }
                            onClick={() => onTrigger(target, action)}
                          >
                            {action === "full" ? (
                              <Rocket className="h-3.5 w-3.5" />
                            ) : action === "content" ? (
                              <RefreshCcw className="h-3.5 w-3.5" />
                            ) : (
                              <Activity className="h-3.5 w-3.5" />
                            )}
                            {ACTION_LABEL[action]}
                          </Button>
                        ))}
                    </div>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {configured ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between gap-3">
              <span>Recent runs</span>
              {deploy?.fetchError ? (
                <StatusPill tone="danger">Feed: {deploy.fetchError.message}</StatusPill>
              ) : null}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {runs.isError ? (
              <ErrorState error={runs.error} onRetry={() => runs.refetch()} />
            ) : runs.isLoading && recentRuns.length === 0 ? (
              <SkeletonRow count={4} />
            ) : recentRuns.length === 0 ? (
              <EmptyState
                icon={<History />}
                title="No recent runs"
                description="Trigger a deploy above; runs will appear here within a few seconds."
              />
            ) : (
              <ul className="divide-y divide-border">
                {recentRuns.slice(0, 15).map((run) => {
                  const targetLabel =
                    targets.find((t) => t.key === run.targetKey)?.label ??
                    run.targetKey ??
                    run.workflowPath?.split("/").pop() ??
                    "—";
                  const cancellable =
                    run.status === "queued" || run.status === "in_progress";
                  const cancelling =
                    cancel.isPending && cancel.variables?.runId === run.id;
                  return (
                    <li
                      key={run.id}
                      className="flex flex-col gap-2 py-3 md:flex-row md:items-center md:justify-between"
                    >
                      <div className="flex min-w-0 items-start gap-3">
                        <StatusPill tone={runTone(run)}>
                          <span className="inline-flex items-center gap-1">
                            {runIcon(run)}
                            {runLabel(run)}
                          </span>
                        </StatusPill>
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">
                            {targetLabel}{" "}
                            <span className="text-muted-foreground">
                              · #{run.runNumber ?? run.id}
                            </span>
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
                            {run.headBranch ?? "—"}
                            {run.triggeringActor ? ` · ${run.triggeringActor}` : ""}
                            {run.updatedAt ? ` · ${formatRelative(run.updatedAt)}` : ""}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {cancellable ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            isLoading={cancelling}
                            onClick={() => onCancel(run)}
                          >
                            <CircleSlash className="h-3.5 w-3.5" />
                            Cancel
                          </Button>
                        ) : null}
                        {run.htmlUrl ? (
                          <Button
                            asChild
                            size="sm"
                            variant="secondary"
                          >
                            <a
                              href={run.htmlUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <ExternalLink className="h-3.5 w-3.5" />
                              Open
                            </a>
                          </Button>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Service alerts</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {workspace.isLoading && !workspace.data ? (
              <SkeletonRow count={3} />
            ) : (workspace.data?.recentServiceAlerts ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No service alerts recorded.
              </p>
            ) : (
              <ul className="space-y-2">
                {(workspace.data?.recentServiceAlerts ?? [])
                  .slice(0, 8)
                  .map((item, index) => {
                    const r = item as Record<string, unknown>;
                    return (
                      <li
                        key={`${String(r.caseId ?? "alert")}-${index}`}
                        className="rounded-md border border-border p-3 text-sm"
                      >
                        <div className="font-medium text-foreground">
                          {String(r.title ?? r.category ?? "Service alert")}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {String(r.workflow ?? r.status ?? "pending")}
                        </div>
                      </li>
                    );
                  })}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className="border-dashed">
          <CardContent className="py-6">
            <div className="text-sm font-semibold">Control-plane snapshot</div>
            <pre className="mt-3 max-h-[280px] overflow-auto rounded-md bg-muted p-3 text-xs">
              <code>
                {JSON.stringify(workspace.data?.controlPlane ?? {}, null, 2)}
              </code>
            </pre>
          </CardContent>
        </Card>
      </div>

      <ConfirmDeployDialog
        target={pending?.target ?? null}
        action={pending?.action ?? null}
        open={Boolean(pending)}
        onOpenChange={(next) => {
          if (!next) setPending(null);
        }}
        onConfirm={onConfirmDestructive}
        isPending={trigger.isPending}
      />
    </div>
  );
}
