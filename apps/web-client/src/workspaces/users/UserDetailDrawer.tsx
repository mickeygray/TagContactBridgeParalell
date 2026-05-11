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
import { Link2Off, Pencil } from "lucide-react";
import { toast } from "@/components/ui/Toaster";
import {
  useDisableAccount,
  useEnableAccount,
  useUpdateAccount,
} from "@/lib/api/queries/accounts";
import type { AccountRecord, FreshLeadGate } from "@/lib/api/types";
import { formatDateTime, formatRelative } from "@/lib/utils/format";

interface UserDetailDrawerProps {
  account: AccountRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEdit: (account: AccountRecord) => void;
}

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
    label: gate?.label || (gate?.blocked ? "Fresh leads paused" : "Fresh leads allowed"),
    detail: gate?.detail || null,
  };
}

export function UserDetailDrawer({
  account,
  open,
  onOpenChange,
  onEdit,
}: UserDetailDrawerProps) {
  const update = useUpdateAccount();
  const disable = useDisableAccount();
  const enable = useEnableAccount();

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
        await disable.mutateAsync(current.id);
        toast.success("Account disabled");
      }
    } catch (err) {
      toast.error("Status change failed", {
        description: (err as Error).message,
      });
    }
  }

  const onCall = hasCurrentCall(current.agentState?.currentCall);
  const freshLeadGate = resolveFreshLeadGate(current.agentState?.freshLeadGate);
  const liveStatus = current.agentState
    ? onCall
      ? "On call"
      : current.agentState.exTelephonyStatus ||
        current.agentState.exPresenceStatus ||
        current.agentState.status ||
        "online"
    : "—";

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

        <dl className="grid grid-cols-2 gap-3 text-sm">
          <Field label="Role" value={account.role} />
          <Field label="Audience" value={account.audience} />
          <Field label="Company" value={account.company ?? "—"} />
          <Field label="Workspace" value={account.workspace ?? "—"} />
          <Field
            label="Extension"
            value={
              account.extensionId ? (
                <span className="font-mono text-xs">{account.extensionId}</span>
              ) : (
                <span className="text-muted-foreground">unpaired</span>
              )
            }
          />
          <Field label="Ext number" value={account.extensionNumber ?? "—"} />
          <Field label="CX agent id" value={account.cxAgentId ?? "—"} />
          <Field label="Station" value={account.stationLabel ?? "—"} />
          <Field label="Phone" value={account.phone ?? "—"} />
          <Field label="Live status" value={liveStatus} />
          <Field
            label="EX call"
            value={
              current.agentState ? (
                <StatusPill dotted tone={freshLeadGate.exCallActive ? "info" : "neutral"}>
                  {freshLeadGate.exCallActive ? "On EX call" : "Off EX call"}
                </StatusPill>
              ) : (
                "unpaired"
              )
            }
          />
          <Field
            label="Fresh leads"
            value={
              current.agentState ? (
                <StatusPill dotted tone={freshLeadGate.blocked ? "warning" : "success"}>
                  {freshLeadGate.label}
                </StatusPill>
              ) : (
                "unpaired"
              )
            }
          />
          <Field
            label="Presence event"
            value={
              account.agentState?.lastEventReceived ? (
                <span title={formatDateTime(account.agentState.lastEventReceived)}>
                  {formatRelative(account.agentState.lastEventReceived)}
                </span>
              ) : (
                "—"
              )
            }
          />
          <Field
            label="Last login"
            value={
              account.lastLoginAt ? (
                <span title={formatDateTime(account.lastLoginAt)}>
                  {formatRelative(account.lastLoginAt)}
                </span>
              ) : (
                "never"
              )
            }
          />
          <Field
            label="Created"
            value={
              account.createdAt ? (
                <span title={formatDateTime(account.createdAt)}>
                  {formatRelative(account.createdAt)}
                </span>
              ) : (
                "—"
              )
            }
          />
          <Field label="Source" value={account.source} />
          {account.isSeed ? (
            <Field label="Seed admin" value={<StatusPill tone="accent">hardcoded</StatusPill>} />
          ) : account.isHardened ? (
            <Field label="Hardened user" value={<StatusPill tone="info">hardcoded</StatusPill>} />
          ) : null}
        </dl>

        <Section title="Logics identities">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <LogicsIdentityBlock
              tenant="TAG"
              id={account.tagLogicsId}
              soId={account.tagSOId}
              email={account.tagEmail}
              name={account.tagLogicsName}
              roles={account.tagLogicsRoles}
            />
            <LogicsIdentityBlock
              tenant="Wynn"
              id={account.wynnLogicsId}
              soId={account.wynnSOId}
              email={account.wynnEmail}
              name={account.wynnLogicsName}
              roles={account.wynnLogicsRoles}
            />
          </div>
          {account.logicsUserId != null ? (
            <div className="mt-2 text-[11px] text-muted-foreground">
              Legacy logicsUserId:{" "}
              <span className="font-mono">{account.logicsUserId}</span>
              {account.logicsDisplayName ? ` · ${account.logicsDisplayName}` : ""}
            </div>
          ) : null}
        </Section>

        <Section title="Credential state">
          {account.logicsAuth ? (
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <Field
                label="Mode"
                value={account.logicsAuth.credentialMode ?? "—"}
              />
              <Field
                label="Status"
                value={
                  account.logicsAuth.credentialStatus ? (
                    <StatusPill tone={credentialTone(account.logicsAuth.credentialStatus)}>
                      {account.logicsAuth.credentialStatus}
                    </StatusPill>
                  ) : (
                    "—"
                  )
                }
              />
              <Field
                label="Permissions"
                value={account.logicsAuth.permissionsLabel ?? "—"}
              />
              <Field
                label="Secret ref"
                value={
                  account.logicsAuth.externalSecretRef ? (
                    <span className="font-mono text-xs">
                      {account.logicsAuth.externalSecretRef}
                    </span>
                  ) : (
                    "—"
                  )
                }
              />
              <div className="col-span-2">
                <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Scopes
                </dt>
                <dd className="mt-0.5 font-medium">
                  {account.logicsAuth.scopes && account.logicsAuth.scopes.length > 0 ? (
                    <span className="font-mono text-xs">
                      {account.logicsAuth.scopes.join(", ")}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">No credentials configured.</p>
          )}
        </Section>

        {account.agentState ? (
          <Section title="Live presence">
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <Field label="Status" value={account.agentState.status ?? "—"} />
              <Field
                label="Presence"
                value={account.agentState.exPresenceStatus ?? "—"}
              />
              <Field
                label="Telephony"
                value={account.agentState.exTelephonyStatus ?? "—"}
              />
              <Field
                label="Platform"
                value={account.agentState.activePlatform ?? "—"}
              />
              <div className="col-span-2">
                <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Current call
                </dt>
                <dd className="mt-0.5 font-medium">
                  {onCall ? (
                    <span className="text-xs">
                      {formatCall(account.agentState.currentCall || {})}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">idle</span>
                  )}
                </dd>
              </div>
              <Field
                label="Last status change"
                value={
                  account.agentState.lastStatusChange ? (
                    <span title={formatDateTime(account.agentState.lastStatusChange)}>
                      {formatRelative(account.agentState.lastStatusChange)}
                    </span>
                  ) : (
                    "—"
                  )
                }
              />
              <Field
                label="Last event"
                value={
                  account.agentState.lastEventReceived ? (
                    <span title={formatDateTime(account.agentState.lastEventReceived)}>
                      {formatRelative(account.agentState.lastEventReceived)}
                    </span>
                  ) : (
                    "—"
                  )
                }
              />
            </dl>
          </Section>
        ) : null}

        {account.capabilities && account.capabilities.length > 0 ? (
          <div className="mt-2">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Capabilities
            </div>
            <div className="flex flex-wrap gap-1.5">
              {account.capabilities.map((cap) => (
                <StatusPill key={cap} tone="neutral">
                  {cap}
                </StatusPill>
              ))}
            </div>
          </div>
        ) : null}

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
              isLoading={disable.isPending || enable.isPending}
              onClick={toggleStatus}
            >
              {account.status === "disabled" ? "Enable" : "Disable"}
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

function Field({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-0.5 font-medium">{value}</dd>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-3 rounded-xl border border-border/60 bg-muted/20 p-3">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      {children}
    </div>
  );
}

function LogicsIdentityBlock({
  tenant,
  id,
  soId,
  email,
  name,
  roles,
}: {
  tenant: "TAG" | "Wynn";
  id: number | null | undefined;
  soId: number | null | undefined;
  email: string | null | undefined;
  name: string | null | undefined;
  roles: string | null | undefined;
}) {
  const empty = id == null && soId == null && !email && !name && !roles;
  return (
    <div className="rounded-md border border-border/60 bg-background/40 p-2">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {tenant}
      </div>
      {empty ? (
        <div className="mt-1 text-xs text-muted-foreground">
          No {tenant} pairing
        </div>
      ) : (
        <dl className="mt-1 space-y-1 text-sm">
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
              ID
            </dt>
            <dd className="font-mono text-xs">{id ?? "—"}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Email
            </dt>
            <dd className="truncate text-xs">{email ?? "—"}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
              SO
            </dt>
            <dd className="font-mono text-xs">{soId ?? "—"}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Name
            </dt>
            <dd className="truncate text-xs">{name ?? "—"}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Roles
            </dt>
            <dd className="truncate text-xs">{roles ?? "—"}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}

function credentialTone(
  status: string,
): "success" | "warning" | "danger" | "neutral" {
  const s = status.toLowerCase();
  if (s.includes("active") || s.includes("ok") || s.includes("valid")) return "success";
  if (s.includes("pending") || s.includes("expiring") || s.includes("needs")) return "warning";
  if (s.includes("revoked") || s.includes("expired") || s.includes("error") || s.includes("fail")) {
    return "danger";
  }
  return "neutral";
}

function formatCall(call: Record<string, unknown>): string {
  const from = typeof call.from === "string" ? call.from : null;
  const to = typeof call.to === "string" ? call.to : null;
  const direction = typeof call.direction === "string" ? call.direction : null;
  const parts: string[] = [];
  if (direction) parts.push(direction);
  if (from) parts.push(`from ${from}`);
  if (to) parts.push(`to ${to}`);
  return parts.length > 0 ? parts.join(" · ") : "in progress";
}
