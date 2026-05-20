import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { StatusPill, toneFromStatus } from "@/components/ui/StatusPill";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/Tabs";
import { ErrorState } from "@/components/ui/ErrorState";
import { SkeletonRow } from "@/components/ui/Skeleton";
import { Link2Off, Pencil, RefreshCw } from "lucide-react";
import { toast } from "@/components/ui/Toaster";
import {
  useAccountCallStats,
  useDeactivateAccount,
  useEnableAccount,
  useRefreshAccountCallStats,
  useUpdateAccount,
  type CallStatsBucket,
} from "@/lib/api/queries/accounts";
import type { AccountRecord } from "@/lib/api/types";
import { formatDateTime, formatRelative, formatNumber } from "@/lib/utils/format";
import { CallsTodayPanel } from "./CallsTodayPanel";
import { CaseCallsDrawer } from "./CaseCallsDrawer";

interface UserDetailDrawerProps {
  account: AccountRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEdit: (account: AccountRecord) => void;
}

type Window = "today" | "week" | "month" | "lifetime";

function formatDurationSec(sec: number | null | undefined): string {
  if (!sec || sec < 1) return "—";
  const minutes = Math.floor(sec / 60);
  const seconds = Math.floor(sec % 60);
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}h ${mins}m`;
  }
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

export function UserDetailDrawer({
  account,
  open,
  onOpenChange,
  onEdit,
}: UserDetailDrawerProps) {
  const update = useUpdateAccount();
  const deactivate = useDeactivateAccount();
  const enable = useEnableAccount();
  const callStats = useAccountCallStats(account?.id ?? null);
  const refreshStats = useRefreshAccountCallStats();
  const [window, setWindow] = React.useState<Window>("today");
  // Per-lead drawer state — opens when an operator clicks a case id
  // chip on a call row, showing every agent who dialed that lead today.
  const [caseDrawerId, setCaseDrawerId] = React.useState<number | null>(null);

  if (!account) return null;
  const current = account;

  async function unpair() {
    if (!current.extensionId) return;
    try {
      await update.mutateAsync({
        id: current.id,
        patch: { extensionId: null },
      });
      toast.success("Extension unpaired");
    } catch (err) {
      toast.error("Could not unpair", {
        description: (err as Error).message,
      });
    }
  }

  async function toggleStatus() {
    try {
      if (current.status === "disabled") {
        await enable.mutateAsync(current.id);
        toast.success("Account enabled");
      } else {
        await deactivate.mutateAsync(current.id);
        toast.success("Account deactivated");
      }
    } catch (err) {
      toast.error("Status change failed", {
        description: (err as Error).message,
      });
    }
  }

  async function refresh() {
    try {
      await refreshStats.mutateAsync(current.id);
      toast.success("Call stats refreshed");
    } catch (err) {
      toast.error("Could not refresh", {
        description: (err as Error).message,
      });
    }
  }

  const snapshot = callStats.data?.snapshot;
  const bucket: CallStatsBucket | null = snapshot ? snapshot[window] : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {account.name}
            <StatusPill dotted tone={toneFromStatus(account.status)}>
              {account.status}
            </StatusPill>
          </DialogTitle>
          <DialogDescription>{account.email}</DialogDescription>
        </DialogHeader>

        <div className="space-y-1 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Extension</span>
            <span className="font-mono">
              {account.extensionId ?? <span className="text-muted-foreground">unpaired</span>}
              {account.extensionNumber ? ` · #${account.extensionNumber}` : ""}
            </span>
          </div>
          {account.company ? (
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Company</span>
              <span>{account.company}</span>
            </div>
          ) : null}
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Last login</span>
            <span title={formatDateTime(account.lastLoginAt)}>
              {account.lastLoginAt ? formatRelative(account.lastLoginAt) : "never"}
            </span>
          </div>
        </div>

        <div className="rounded-lg border border-border p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Call stats
            </div>
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
              {callStats.data?.cached ? "cached" : "fresh"}
              {snapshot?.computedAt ? (
                <span title={formatDateTime(snapshot.computedAt)}>
                  · {formatRelative(snapshot.computedAt)}
                </span>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                isLoading={refreshStats.isPending}
                onClick={refresh}
                className="h-6 px-1"
                aria-label="Refresh call stats"
              >
                <RefreshCw className="h-3 w-3" />
              </Button>
            </div>
          </div>

          {callStats.isError ? (
            <ErrorState
              error={callStats.error}
              onRetry={() => callStats.refetch()}
            />
          ) : callStats.isLoading ? (
            <SkeletonRow count={3} />
          ) : !bucket ? (
            <p className="py-2 text-center text-xs text-muted-foreground">
              No call data yet.
            </p>
          ) : (
            <Tabs value={window} onValueChange={(v) => setWindow(v as Window)}>
              <TabsList className="w-full justify-between">
                <TabsTrigger value="today">Today</TabsTrigger>
                <TabsTrigger value="week">Week</TabsTrigger>
                <TabsTrigger value="month">Month</TabsTrigger>
                <TabsTrigger value="lifetime">Lifetime</TabsTrigger>
              </TabsList>
              <TabsContent value={window} className="pt-3">
                <CallStatsGrid bucket={bucket} />
              </TabsContent>
            </Tabs>
          )}
        </div>

        {/* Per-call review — list of today's individual calls with
            duration, recording playback, and a case chip that opens the
            "who else dialed this lead today" drawer. Lives below the
            rollup so the bucket totals stay the first thing the eye
            lands on. */}
        <div className="rounded-lg border border-border p-3">
          <CallsTodayPanel
            extensionId={current.extensionId ?? null}
            domain={current.company || "TAG"}
            onCaseClick={(caseId) => setCaseDrawerId(caseId)}
          />
        </div>

        <CaseCallsDrawer
          caseId={caseDrawerId}
          domain={current.company || "TAG"}
          open={caseDrawerId !== null}
          onOpenChange={(open) => {
            if (!open) setCaseDrawerId(null);
          }}
        />

        <DialogFooter className="flex-row flex-wrap items-center justify-between gap-2 sm:justify-between">
          <div className="flex items-center gap-2">
            {account.extensionId ? (
              <Button
                variant="ghost"
                size="sm"
                isLoading={update.isPending}
                onClick={unpair}
              >
                <Link2Off className="h-3.5 w-3.5" />
                Unpair
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              disabled={Boolean(account.isHardened) && account.status !== "disabled"}
              isLoading={deactivate.isPending || enable.isPending}
              onClick={toggleStatus}
            >
              {account.status === "disabled" ? "Enable" : "Deactivate"}
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <Button size="sm" onClick={() => onEdit(account)}>
              <Pencil className="h-3.5 w-3.5" />
              Edit
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CallStatsGrid({ bucket }: { bucket: CallStatsBucket }) {
  return (
    <dl className="grid grid-cols-2 gap-3 text-sm">
      <Field label="Total calls" value={formatNumber(bucket.totalCalls)} />
      <Field
        label="Last call"
        value={
          bucket.lastCallAt ? (
            <span title={formatDateTime(bucket.lastCallAt)}>
              {formatRelative(bucket.lastCallAt)}
            </span>
          ) : (
            "—"
          )
        }
      />
      <Field
        label="Longest call"
        value={formatDurationSec(bucket.longestCallSec)}
      />
      <Field
        label="Outbound · Inbound"
        value={`${formatNumber(bucket.outboundCalls)} · ${formatNumber(bucket.inboundCalls)}`}
      />
      <Field
        label="EX (desk app)"
        value={formatNumber(bucket.exCalls)}
        hint={
          bucket.cxCalls + bucket.exCalls === 0 && bucket.totalCalls > 0
            ? "platform stamping started recently — historical rows un-tagged"
            : undefined
        }
      />
      <Field
        label="CX (queue)"
        value={formatNumber(bucket.cxCalls)}
      />
    </dl>
  );
}

function Field({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
}) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-0.5 font-medium">{value}</dd>
      {hint ? (
        <div className="mt-0.5 text-[10px] text-muted-foreground">{hint}</div>
      ) : null}
    </div>
  );
}
