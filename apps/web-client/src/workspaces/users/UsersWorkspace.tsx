import * as React from "react";
import {
  Activity,
  CheckCircle2,
  Headphones,
  Link2,
  Link2Off,
  Lock,
  MailCheck,
  PauseCircle,
  PhoneCall,
  PlayCircle,
  Search,
  ShieldCheck,
  UserPlus,
} from "lucide-react";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Card, CardContent, CardHeader, CardTitle, KpiCard } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import { DataTable, type ColumnDef } from "@/components/ui/DataTable";
import { StatusPill, toneFromStatus } from "@/components/ui/StatusPill";
import { ErrorState } from "@/components/ui/ErrorState";
import { SkeletonRow } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { toast } from "@/components/ui/Toaster";
import {
  useAccounts,
  useDeactivateAccount,
  useEnableAccount,
  useUnassignedExtensions,
  useUpdateAccount,
} from "@/lib/api/queries/accounts";
import type {
  AccountRecord,
  AccountStatus,
  AuthRole,
  CxQueueTier,
  FreshLeadGate,
  UnassignedExtension,
} from "@/lib/api/types";
import { formatRelative } from "@/lib/utils/format";
import { CreateUserDialog } from "./CreateUserDialog";
import { EditUserDialog } from "./EditUserDialog";
import { UserDetailDrawer } from "./UserDetailDrawer";

type StatusFilter = "all" | AccountStatus;
type RoleFilter = "all" | AuthRole;
type CompanyFilter = "all" | "TAG" | "WYNN" | "AMITY";

const credentialTone = (status: string) => {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "active") return "success" as const;
  if (normalized === "revoked" || normalized === "disabled") return "danger" as const;
  if (normalized === "pending") return "warning" as const;
  return "neutral" as const;
};

const queueTierLabels: Record<string, string> = {
  no_leads: "No leads",
  red_only: "Red only",
  old_balanced: "Old balanced",
  fresh_capped: "Fresh capped",
  fresh_priority: "Fresh priority",
};

const queueTierOptions: Array<{ value: CxQueueTier; label: string }> = [
  { value: "no_leads", label: "No leads" },
  { value: "red_only", label: "Red only" },
  { value: "old_balanced", label: "Old balanced" },
  { value: "fresh_capped", label: "Fresh capped" },
  { value: "fresh_priority", label: "Fresh priority" },
];

function hasCurrentCall(call: unknown): boolean {
  if (!call || typeof call !== "object") return false;
  const currentCall = call as Record<string, unknown>;
  return Boolean(
    currentCall.sessionId ||
      currentCall.telephonySessionId ||
      currentCall.from ||
      currentCall.to,
  );
}

function resolveFreshLeadGate(gate: FreshLeadGate | null | undefined) {
  return {
    blocked: Boolean(gate?.blocked),
    exCallActive: Boolean(gate?.exCallActive) || gate?.source === "ex-call",
    label: gate?.label || (gate?.blocked ? "Fresh paused" : "Fresh allowed"),
  };
}

export function UsersWorkspace() {
  const [search, setSearch] = React.useState("");
  const [status, setStatus] = React.useState<StatusFilter>("all");
  const [role, setRole] = React.useState<RoleFilter>("all");
  const [company, setCompany] = React.useState<CompanyFilter>("all");
  const [detailId, setDetailId] = React.useState<string | null>(null);
  const [editId, setEditId] = React.useState<string | null>(null);
  const [pairTargetId, setPairTargetId] = React.useState<string | null>(null);

  const accounts = useAccounts({
    search,
    status: status === "all" ? undefined : status,
    role: role === "all" ? undefined : role,
    company: company === "all" ? undefined : company,
    limit: 500,
  });
  const extensions = useUnassignedExtensions(
    company === "all" ? undefined : company,
  );
  const deactivate = useDeactivateAccount();
  const enable = useEnableAccount();
  const update = useUpdateAccount();

  const rows = accounts.data ?? [];
  const active = rows.filter((r) => r.status === "active").length;
  const invited = rows.filter((r) => r.status === "invited").length;
  const paired = rows.filter((r) => Boolean(r.extensionId)).length;
  const cxLive = rows.filter((r) => r.agentState?.cxLive?.workspaceFresh).length;
  const servingCx = rows.filter((r) => r.agentState?.cxLive?.serving).length;
  const dialingNow = rows.filter((r) => r.agentState?.cxLive?.dialing).length;

  const selectedForDetail = rows.find((r) => r.id === detailId) ?? null;
  const selectedForEdit = rows.find((r) => r.id === editId) ?? null;

  const updateQueueTier = React.useCallback(
    async (row: AccountRecord, nextTier: CxQueueTier) => {
      const currentTier =
        (row.cxQueuePolicy?.tier as CxQueueTier | undefined) ||
        (row.role === "admin" ? "no_leads" : "fresh_priority");
      if (currentTier === nextTier) return;

      try {
        await update.mutateAsync({
          id: row.id,
          patch: {
            cxQueuePolicy: {
              tier: nextTier,
              enabled: nextTier !== "no_leads",
            },
          },
        });
        toast.success("Queue tier updated", {
          description: `${row.name} is now ${queueTierLabels[nextTier]}.`,
        });
      } catch (err) {
        toast.error("Tier update failed", {
          description: (err as Error).message,
        });
      }
    },
    [update],
  );

  const columns = React.useMemo<ColumnDef<AccountRecord>[]>(
    () => [
      {
        accessorKey: "name",
        header: "User",
        cell: (info) => {
          const row = info.row.original;
          return (
            <div className="flex flex-col leading-tight">
              <span className="flex items-center gap-1.5 text-sm font-medium">
                {row.name}
                {row.isSeed ? (
                  <ShieldCheck className="h-3.5 w-3.5 text-primary" />
                ) : row.isHardened ? (
                  <Lock className="h-3.5 w-3.5 text-primary" />
                ) : null}
              </span>
              <span className="text-xs text-muted-foreground">{row.email}</span>
            </div>
          );
        },
      },
      {
        accessorKey: "role",
        header: "Role",
        cell: (info) => (
          <StatusPill tone={info.getValue<string>() === "admin" ? "accent" : "info"}>
            {info.getValue<string>()}
          </StatusPill>
        ),
      },
      {
        id: "queueTier",
        header: "Tier",
        cell: (info) => {
          const row = info.row.original;
          const tier =
            (row.cxQueuePolicy?.tier as CxQueueTier | undefined) ||
            (row.role === "admin" ? "no_leads" : "fresh_priority");
          const savingTier =
            update.isPending &&
            update.variables?.id === row.id &&
            Boolean(update.variables?.patch?.cxQueuePolicy);
          return (
            <div
              className="w-36"
              onClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <Select
                value={tier}
                disabled={savingTier}
                onValueChange={(value) => {
                  void updateQueueTier(row, value as CxQueueTier);
                }}
              >
                <SelectTrigger className="h-8 border-transparent bg-muted/35 px-2 text-xs shadow-none hover:border-border">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {queueTierOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          );
        },
      },
      {
        accessorKey: "company",
        header: "Co.",
        cell: (info) => (
          <span className="text-xs uppercase tracking-wide text-muted-foreground">
            {info.getValue<string>() ?? "—"}
          </span>
        ),
      },
      {
        id: "ext",
        header: "Ext",
        cell: (info) => {
          const row = info.row.original;
          const display = row.extensionNumber ?? row.extensionId;
          if (!display) {
            return <span className="text-xs text-muted-foreground">—</span>;
          }
          return (
            <span className="inline-flex items-center gap-1 font-mono text-xs">
              <Link2 className="h-3 w-3 text-muted-foreground" />
              {display}
            </span>
          );
        },
      },
      {
        id: "logics",
        header: "Logics",
        cell: (info) => {
          const row = info.row.original;
          if (
            row.tagLogicsId == null &&
            row.wynnLogicsId == null &&
            row.tagSOId == null &&
            row.wynnSOId == null
          ) {
            return <span className="text-xs text-muted-foreground">—</span>;
          }
          return (
            <div className="flex flex-col leading-tight text-xs">
              <span className="font-mono text-foreground/80">
                TAG: {row.tagLogicsId ?? "—"} / SO {row.tagSOId ?? "—"}
              </span>
              <span className="font-mono text-muted-foreground">
                Wynn: {row.wynnLogicsId ?? "—"} / SO {row.wynnSOId ?? "—"}
              </span>
            </div>
          );
        },
      },
      {
        id: "cred",
        header: "Cred",
        cell: (info) => {
          const auth = info.row.original.logicsAuth;
          const status = auth?.credentialStatus ?? null;
          if (!status) {
            return <span className="text-xs text-muted-foreground">—</span>;
          }
          const tone = credentialTone(status);
          return (
            <StatusPill tone={tone}>{status}</StatusPill>
          );
        },
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: (info) => (
          <StatusPill dotted tone={toneFromStatus(info.getValue<string>())}>
            {info.getValue<string>()}
          </StatusPill>
        ),
      },
      {
        id: "live",
        header: "CX live",
        cell: (info) => {
          const state = info.row.original.agentState;
          if (!state) {
            return <span className="text-xs text-muted-foreground">—</span>;
          }
          const live = state.cxLive;
          const onCall = hasCurrentCall(state.currentCall);
          const gate = resolveFreshLeadGate(state.freshLeadGate);
          const label = onCall
            ? "on call"
            : [state.exPresenceStatus, state.status].filter(Boolean).join("·") ||
              "online";
          const activity = String(
            live?.activityState || state.activityState || state.status || "",
          ).toLowerCase();
          const activityLabel = live?.dialing
            ? activity === "dialing"
              ? "Dialing"
              : "On call"
            : live?.wrappingUp
              ? "Wrap"
              : live?.activityState || state.activityState || label || "Idle";
          const workspaceLabel = live?.workspaceFresh
            ? "CX live"
            : live?.workspaceActive
              ? "CX stale"
              : "CX off";
          const workspaceTone = live?.workspaceFresh
            ? "success"
            : live?.workspaceActive
              ? "warning"
              : "neutral";
          const servingLabel = live?.serving
            ? "Serving"
            : live?.desiredAvailability === "unavailable"
              ? "Paused"
              : live?.routingEnabled === false
                ? "Routing off"
                : gate.blocked
                  ? "Not serving"
                  : "Ready";
          const servingTone = live?.serving
            ? "success"
            : live?.routingEnabled === false
              ? "neutral"
              : "warning";
          const openAssignments = Number(live?.openAssignments || 0);
          return (
            <div className="flex min-w-[250px] flex-wrap gap-1.5">
              <StatusPill
                dotted
                tone={workspaceTone}
                title={
                  live?.workspaceLastSeenAt
                    ? `Last seen ${formatRelative(live.workspaceLastSeenAt)}`
                    : undefined
                }
              >
                {workspaceLabel}
              </StatusPill>
              <StatusPill dotted tone={servingTone}>
                {servingLabel}
              </StatusPill>
              <StatusPill
                dotted
                tone={toneFromStatus(onCall ? "on call" : activityLabel)}
              >
                {activityLabel}
              </StatusPill>
              <StatusPill tone="neutral">
                Open {openAssignments}
              </StatusPill>
            </div>
          );
        },
      },
      {
        accessorKey: "lastLoginAt",
        header: "Last login",
        cell: (info) => (
          <span className="text-xs text-muted-foreground">
            {info.getValue<string>() ? formatRelative(info.getValue<string>()) : "—"}
          </span>
        ),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        cell: (info) => {
          const row = info.row.original;
          const toggling =
            (deactivate.isPending && deactivate.variables === row.id) ||
            (enable.isPending && enable.variables === row.id);
          return (
            <div className="flex justify-end gap-1">
              {row.status === "disabled" ? (
                <Button
                  size="sm"
                  variant="secondary"
                  isLoading={toggling}
                  onClick={async (e) => {
                    e.stopPropagation();
                    try {
                      await enable.mutateAsync(row.id);
                      toast.success("Account enabled", { description: row.email });
                    } catch (err) {
                      toast.error("Enable failed", {
                        description: (err as Error).message,
                      });
                    }
                  }}
                >
                  <PlayCircle className="h-3.5 w-3.5" />
                  Enable
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={Boolean(row.isHardened)}
                  isLoading={toggling}
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (row.isHardened) return;
                    try {
                      await deactivate.mutateAsync(row.id);
                      toast.success("Account deactivated", { description: row.email });
                    } catch (err) {
                      toast.error("Deactivate failed", {
                        description: (err as Error).message,
                      });
                    }
                  }}
                >
                  {row.isSeed ? (
                    <Lock className="h-3.5 w-3.5" />
                  ) : row.isHardened ? (
                    <Lock className="h-3.5 w-3.5" />
                  ) : (
                    <PauseCircle className="h-3.5 w-3.5" />
                  )}
                  {row.isSeed ? "Seed" : row.isHardened ? "Locked" : "Deactivate"}
                </Button>
              )}
              {row.extensionId ? (
                <Button
                  size="sm"
                  variant="ghost"
                  isLoading={update.isPending && update.variables?.id === row.id}
                  onClick={async (e) => {
                    e.stopPropagation();
                    try {
                      await update.mutateAsync({
                        id: row.id,
                        patch: { extensionId: null },
                      });
                      toast.success("Extension unpaired", { description: row.email });
                    } catch (err) {
                      toast.error("Unpair failed", {
                        description: (err as Error).message,
                      });
                    }
                  }}
                >
                  <Link2Off className="h-3.5 w-3.5" />
                </Button>
              ) : null}
            </div>
          );
        },
      },
    ],
    [deactivate, enable, update, updateQueueTier],
  );

  async function pairExtension(userId: string, extensionId: string) {
    try {
      await update.mutateAsync({
        id: userId,
        patch: { extensionId },
      });
      toast.success("Extension paired");
      setPairTargetId(null);
    } catch (err) {
      toast.error("Pair failed", {
        description: (err as Error).message,
      });
    }
  }

  const unpairedUsers = rows.filter((r) => !r.extensionId && r.status !== "disabled");

  return (
    <div className="space-y-8">
      <SectionHeader
        eyebrow="Operations"
        title="Users & Agents"
        description="Create accounts, pair them to RingCentral extensions, and send OTP invites. Seed admins are hardcoded and cannot be deactivated."
        actions={<CreateUserDialog />}
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-6">
        <KpiCard
          label="Active"
          value={active}
          hint={`${rows.length} total shown`}
          icon={<CheckCircle2 className="h-4 w-4" />}
        />
        <KpiCard
          label="CX live"
          value={cxLive}
          hint="Workspace seen recently"
          icon={<Headphones className="h-4 w-4" />}
        />
        <KpiCard
          label="Serving"
          value={servingCx}
          hint="Eligible for CX leads"
          icon={<Activity className="h-4 w-4" />}
        />
        <KpiCard
          label="Dialing"
          value={dialingNow}
          hint="Dialing or on call"
          icon={<PhoneCall className="h-4 w-4" />}
        />
        <KpiCard
          label="Invited"
          value={invited}
          hint="Awaiting first OTP sign-in"
          icon={<MailCheck className="h-4 w-4" />}
        />
        <KpiCard
          label="Paired to RC"
          value={paired}
          hint="With a RingCentral extension"
          icon={<Link2 className="h-4 w-4" />}
        />
      </div>

      <Card>
        <CardHeader className="space-y-3">
          <CardTitle className="flex items-center justify-between gap-3">
            <span>Accounts</span>
            <div className="w-72">
              <Input
                leadingIcon={<Search />}
                placeholder="Search by name or email"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <FilterSelect
              label="Status"
              value={status}
              onChange={(v) => setStatus(v as StatusFilter)}
              options={[
                { value: "all", label: "All statuses" },
                { value: "active", label: "Active" },
                { value: "invited", label: "Invited" },
                { value: "disabled", label: "Disabled" },
              ]}
            />
            <FilterSelect
              label="Role"
              value={role}
              onChange={(v) => setRole(v as RoleFilter)}
              options={[
                { value: "all", label: "All roles" },
                { value: "admin", label: "Admin" },
                { value: "internal-agent", label: "Internal agent" },
                { value: "widget-user", label: "CX user" },
                { value: "service", label: "Service" },
              ]}
            />
            <FilterSelect
              label="Company"
              value={company}
              onChange={(v) => setCompany(v as CompanyFilter)}
              options={[
                { value: "all", label: "All companies" },
                { value: "TAG", label: "TAG" },
                { value: "WYNN", label: "WYNN" },
                { value: "AMITY", label: "AMITY" },
              ]}
            />
            {(status !== "all" ||
              role !== "all" ||
              company !== "all" ||
              search) ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setStatus("all");
                  setRole("all");
                  setCompany("all");
                  setSearch("");
                }}
              >
                Reset
              </Button>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {accounts.isError ? (
            <ErrorState error={accounts.error} onRetry={() => accounts.refetch()} />
          ) : accounts.isLoading ? (
            <SkeletonRow count={5} />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={<UserPlus />}
              title={search ? `No matches for "${search}"` : "No accounts match filters"}
              description="Add your first user with the button above, or clear filters to see everyone."
            />
          ) : (
            <DataTable
              columns={columns}
              data={rows}
              density="cozy"
              className="border-0 shadow-none"
              onRowClick={(row) => setDetailId(row.id)}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Unpaired RingCentral extensions</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {extensions.isError ? (
            <ErrorState
              error={extensions.error}
              onRetry={() => extensions.refetch()}
            />
          ) : extensions.isLoading ? (
            <SkeletonRow count={3} />
          ) : !extensions.data || extensions.data.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">
              Every RingCentral extension the poller has seen is paired to a user.
            </p>
          ) : (
            <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
              {extensions.data.map((ext) => (
                <ExtensionRow
                  key={ext.extensionId}
                  ext={ext}
                  unpairedUsers={unpairedUsers}
                  activePair={pairTargetId}
                  onBeginPair={() => setPairTargetId(ext.extensionId)}
                  onCancelPair={() => setPairTargetId(null)}
                  onPair={(userId) => pairExtension(userId, ext.extensionId)}
                  isPairing={update.isPending}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <UserDetailDrawer
        account={selectedForDetail}
        open={Boolean(selectedForDetail)}
        onOpenChange={(next) => setDetailId(next ? detailId : null)}
        onEdit={(account) => {
          setDetailId(null);
          setEditId(account.id);
        }}
      />
      <EditUserDialog
        account={selectedForEdit}
        open={Boolean(selectedForEdit)}
        onOpenChange={(next) => setEditId(next ? editId : null)}
      />
    </div>
  );
}

const FilterSelect = ({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) => {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-8 w-[160px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
};

function ExtensionRow({
  ext,
  unpairedUsers,
  activePair,
  onBeginPair,
  onCancelPair,
  onPair,
  isPairing,
}: {
  ext: UnassignedExtension;
  unpairedUsers: AccountRecord[];
  activePair: string | null;
  onBeginPair: () => void;
  onCancelPair: () => void;
  onPair: (userId: string) => void;
  isPairing: boolean;
}) {
  const isActive = activePair === ext.extensionId;

  return (
    <li className="space-y-2 rounded-md border border-border p-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-medium">
            {ext.name ?? `ext ${ext.extensionId}`}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {ext.extensionId}
            {ext.company ? ` · ${ext.company}` : ""}
            {ext.lastStatusChange ? ` · ${formatRelative(ext.lastStatusChange)}` : ""}
          </div>
        </div>
        <StatusPill dotted tone={toneFromStatus(ext.exPresenceStatus ?? ext.status)}>
          {ext.exPresenceStatus ?? ext.status ?? "unknown"}
        </StatusPill>
      </div>
      {isActive ? (
        <div className="flex items-center gap-2">
          <Select
            onValueChange={(v) => {
              if (v) onPair(v);
            }}
          >
            <SelectTrigger className="h-8 flex-1">
              <SelectValue placeholder="Choose user" />
            </SelectTrigger>
            <SelectContent>
              {unpairedUsers.length === 0 ? (
                <SelectItem value="__none" disabled>
                  No unpaired users
                </SelectItem>
              ) : (
                unpairedUsers.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.name} · {u.email}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
          <Button
            variant="ghost"
            size="sm"
            onClick={onCancelPair}
            disabled={isPairing}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex justify-end">
          <Button variant="secondary" size="sm" onClick={onBeginPair}>
            <Link2 className="h-3.5 w-3.5" />
            Pair to user
          </Button>
        </div>
      )}
    </li>
  );
}
