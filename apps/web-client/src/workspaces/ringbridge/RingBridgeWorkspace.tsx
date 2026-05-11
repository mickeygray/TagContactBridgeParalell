import * as React from "react";
import { Activity, BellRing, Headset, PhoneIncoming, PhoneMissed, PhoneOutgoing, Radio } from "lucide-react";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Button } from "@/components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle, KpiCard } from "@/components/ui/Card";
import { StatusPill, toneFromStatus, type StatusTone } from "@/components/ui/StatusPill";
import { CaseLink } from "@/components/ui/CaseLink";
import { ErrorState } from "@/components/ui/ErrorState";
import { SkeletonRow } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { useDomainStore } from "@/lib/domain/domainStore";
import { useWorkflowEventReader } from "@/lib/events/useWorkflowEventReader";
import { presentImportantWorkflowRecords } from "@/lib/events/presentation";
import {
  useRingBridgeWorkspace,
  useRingCentralCallLog,
  useRingCentralEvents,
  useRingCentralRuntime,
  useRingCentralStatus,
} from "@/lib/api/queries/ringcentral";
import type { CallLogRow, FreshLeadGate, RingCentralAgent, RingcentralPollingRuntime } from "@/lib/api/types";
import { formatDateTime, formatDuration, formatNumber, formatRelative } from "@/lib/utils/format";

const CALL_LOG_WINDOWS = [
  { label: "24h", sinceMs: 24 * 60 * 60 * 1000 },
  { label: "7d", sinceMs: 7 * 24 * 60 * 60 * 1000 },
  { label: "30d", sinceMs: 30 * 24 * 60 * 60 * 1000 },
];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function hasCurrentCall(call: unknown): boolean {
  const currentCall = asRecord(call);
  return Boolean(
    currentCall.sessionId ||
      currentCall.telephonySessionId ||
      currentCall.from ||
      currentCall.to,
  );
}

function resolveFreshLeadGate(agent: RingCentralAgent): FreshLeadGate {
  if (agent.freshLeadGate) return agent.freshLeadGate;
  const cxRouting = asRecord(agent.cxRouting);
  const desiredAvailability = String(cxRouting.desiredAvailability || "").trim().toLowerCase();
  const reason = String(cxRouting.reason || "").trim().toLowerCase();
  const exCallActive =
    reason === "ex-busy" ||
    hasCurrentCall(agent.currentCall) ||
    ["callconnected", "onhold"].includes(String(agent.exTelephonyStatus || "").trim().toLowerCase());
  const blocked = exCallActive || desiredAvailability === "unavailable";
  return {
    allowed: !blocked,
    blocked,
    source: exCallActive ? "ex-call" : blocked ? "manual" : "none",
    reason: reason || null,
    desiredAvailability: desiredAvailability || null,
    exCallActive,
    label: exCallActive
      ? "Fresh leads paused: EX call"
      : blocked
        ? "Fresh leads paused"
        : "Fresh leads allowed",
    detail: exCallActive
      ? "EX call is active; fresh leads stay off for this agent."
      : blocked
        ? "Manual pause is holding this agent out of fresh lead serving."
        : "EX is idle and this agent can receive fresh leads.",
  };
}

function freshLeadGateTone(gate: FreshLeadGate): StatusTone {
  return gate.blocked ? "warning" : "success";
}

export function RingBridgeWorkspace() {
  const domain = useDomainStore((s) => s.domain);
  const [callLogWindow, setCallLogWindow] = React.useState<number>(24 * 60 * 60 * 1000);
  const workspace = useRingBridgeWorkspace(domain);
  const events = useRingCentralEvents(domain, { limit: 20 });
  const callLog = useRingCentralCallLog(domain, { limit: 50, sinceMs: callLogWindow });
  const runtime = useRingCentralRuntime(domain);
  const status = useRingCentralStatus();
  const watchedFamilies = React.useMemo(() => ["ringcentral", "outbound", "metrics"], []);
  const eventReader = useWorkflowEventReader({
    domain,
    families: watchedFamilies,
    pollMs: 4_000,
    limit: 50,
    maxEntries: 30,
  });

  const agents = workspace.data?.presence?.agents ?? [];
  const summary = workspace.data?.presence?.summary ?? {};
  const available = agents.filter((a) =>
    (a.presence ?? "").toLowerCase().includes("available"),
  ).length;
  const callsToday = agents.reduce((sum, a) => sum + (a.callsToday ?? 0), 0);
  const freshLeadBlocked = Number(
    summary.freshLeadBlocked ??
      agents.filter((agent) => {
        const gate = resolveFreshLeadGate(agent);
        return gate.blocked && gate.source !== "routing-disabled";
      }).length,
  );
  const freshLeadBlockedByEx = Number(
    summary.freshLeadBlockedByEx ??
      agents.filter((agent) => resolveFreshLeadGate(agent).source === "ex-call").length,
  );
  const importantReaderEvents = React.useMemo(
    () => presentImportantWorkflowRecords(eventReader.events, 12),
    [eventReader.events],
  );
  const importantRingCentralEvents = React.useMemo(
    () => presentImportantWorkflowRecords(events.data ?? [], 12),
    [events.data],
  );

  return (
    <div className="space-y-8">
      <SectionHeader
        eyebrow="Workspace"
        title="RingBridge"
        description="Live EX presence, telephony state, and recent RingCentral workflow records read through 5001."
        actions={
          <div className="flex items-center gap-2">
            <StatusPill dotted tone={workspace.isError ? "danger" : workspace.isFetching ? "info" : "success"}>
              {workspace.isFetching ? "Refreshing" : "Live"}
            </StatusPill>
            <StatusPill
              dotted
              tone={status.isError ? "danger" : status.data ? "success" : "warning"}
            >
              RC runtime
            </StatusPill>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Agents online" value={formatNumber(available)} hint={`${agents.length} total`} icon={<Radio className="h-4 w-4" />} />
        <KpiCard label="Active calls" value={formatNumber(summary.activeCalls)} icon={<PhoneIncoming className="h-4 w-4" />} />
        <KpiCard label="Calls today" value={formatNumber(callsToday)} icon={<PhoneOutgoing className="h-4 w-4" />} />
        <KpiCard
          label="Fresh paused"
          value={formatNumber(freshLeadBlocked)}
          hint={`${formatNumber(freshLeadBlockedByEx)} on EX call`}
          icon={<Headset className="h-4 w-4" />}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Agent presence</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {workspace.isError ? (
            <ErrorState error={workspace.error} onRetry={() => workspace.refetch()} />
          ) : workspace.isLoading ? (
            <SkeletonRow count={5} />
          ) : agents.length === 0 ? (
            <EmptyState
              icon={<Headset />}
              title={`No agents reported for ${domain}`}
              description="EX presence and mirrored agent states will appear here as events land."
            />
          ) : (
            <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
              {agents.map((agent) => {
                const gate = resolveFreshLeadGate(agent);
                const exCallActive = Boolean(gate.exCallActive) || gate.source === "ex-call";
                return (
                <li
                  key={agent.extensionId}
                  className="rounded-lg border border-border p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <div className="truncate text-sm font-medium text-foreground">
                        {agent.name ?? `ext ${agent.extensionId}`}
                      </div>
                      <StatusPill dotted tone={toneFromStatus(agent.presence)}>
                        {agent.presence ?? "Unknown"}
                      </StatusPill>
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {agent.email ?? agent.extensionId}
                      {agent.lastUpdate ? ` · ${formatRelative(agent.lastUpdate)}` : ""}
                    </div>
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      {agent.telephonyStatus ?? "NoCall"}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="numeric text-sm font-semibold">
                      {formatNumber(agent.callsToday)}
                    </div>
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      calls today
                    </div>
                  </div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <StatusPill dotted tone={exCallActive ? "info" : "neutral"}>
                      {exCallActive ? "On EX call" : "Off EX call"}
                    </StatusPill>
                    <StatusPill dotted tone={freshLeadGateTone(gate)}>
                      {gate.label ?? (gate.blocked ? "Fresh leads paused" : "Fresh leads allowed")}
                    </StatusPill>
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    {gate.detail ??
                      (gate.blocked
                        ? "This agent is held out of fresh lead serving."
                        : "This agent can receive fresh leads.")}
                  </div>
                </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle>Call log</CardTitle>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>
                  {formatNumber(callLog.data?.summary?.total)} sessions · {formatNumber(
                    callLog.data?.summary?.attributed,
                  )} attributed · {formatNumber(callLog.data?.summary?.missed)} missed
                  {callLog.data?.summary?.legacy
                    ? ` · ${formatNumber(callLog.data.summary.legacy)} legacy`
                    : ""}
                </span>
                <StatusPill dotted tone={callLog.isError ? "danger" : callLog.isFetching ? "info" : "success"}>
                  {callLog.isFetching ? "Refreshing" : "Live"}
                </StatusPill>
              </div>
              <div className="flex items-center gap-2">
                {CALL_LOG_WINDOWS.map((window) => (
                  <Button
                    key={window.label}
                    variant={callLogWindow === window.sinceMs ? "primary" : "secondary"}
                    size="sm"
                    onClick={() => setCallLogWindow(window.sinceMs)}
                  >
                    {window.label}
                  </Button>
                ))}
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {callLog.isError ? (
              <ErrorState error={callLog.error} onRetry={() => callLog.refetch()} />
            ) : callLog.isLoading ? (
              <SkeletonRow count={6} />
            ) : (callLog.data?.calls ?? []).length === 0 ? (
              <EmptyState
                icon={<PhoneIncoming />}
                title={`No telephony sessions for ${domain}`}
                description="Rows appear per telephony session as EX presence flips to / from CallConnected."
              />
            ) : (
              <CallLogTable rows={callLog.data?.calls ?? []} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <CardTitle>Polling runtime</CardTitle>
              <StatusPill
                dotted
                tone={
                  !runtime.data
                    ? "info"
                    : runtime.data.healthy
                      ? "success"
                      : runtime.data.reachable
                        ? "warning"
                        : "danger"
                }
              >
                {runtime.data
                  ? runtime.data.healthy
                    ? "Healthy"
                    : runtime.data.reachable
                      ? "Degraded"
                      : "Unreachable"
                  : "—"}
              </StatusPill>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <RuntimePanel runtime={runtime.data ?? null} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle>Live client event reader</CardTitle>
            <div className="flex items-center gap-2">
              <StatusPill
                dotted
                tone={
                  eventReader.error
                    ? "danger"
                    : eventReader.newCount > 0
                      ? "warning"
                      : "success"
                }
              >
                {eventReader.error
                  ? "Reader error"
                  : eventReader.newCount > 0
                    ? `${eventReader.newCount} new`
                    : "Watching"}
              </StatusPill>
              <Button variant="ghost" size="sm" onClick={() => eventReader.markAllRead()}>
                Mark seen
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {eventReader.error ? (
            <ErrorState error={eventReader.error} onRetry={() => void eventReader.refetch()} />
          ) : eventReader.isLoading ? (
            <SkeletonRow count={5} />
          ) : importantReaderEvents.length === 0 ? (
            <EmptyState
              icon={<BellRing />}
              title="No live client events yet"
              description="This browser-side reader keeps a rolling in-memory view of recent ringcentral, outbound, and metrics workflow events."
            />
          ) : (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>Watching ringcentral, outbound, and metrics workflow families.</span>
                {eventReader.lastSeenAt ? <span>Last poll {formatRelative(eventReader.lastSeenAt)}</span> : null}
              </div>
              <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
                {importantReaderEvents.map((event, index) => (
                  <li
                    key={`${event._id ?? event.aggregateId ?? "workflow"}-${index}`}
                    className="rounded-md border border-border p-3 text-sm"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-medium text-foreground">
                        {[event.family, event.subtype, event.stage].filter(Boolean).join(" · ")}
                      </div>
                      <StatusPill dotted tone={event.family === "ringcentral" ? "info" : event.family === "metrics" ? "warning" : "success"}>
                        {event.family ?? "workflow"}
                      </StatusPill>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {event.caseId != null ? (
                        <CaseLink caseId={event.caseId} domain={domain} compact />
                      ) : (
                        <span className="truncate max-w-[220px]">
                          {event.aggregateId ?? event.aggregateType ?? "no aggregate id"}
                        </span>
                      )}
                      {event.happenedAt || event.createdAt ? (
                        <span>· {formatDateTime(event.happenedAt ?? event.createdAt ?? "")}</span>
                      ) : null}
                    </div>
                    {event.summary ? (
                      <div className="mt-1 text-xs text-muted-foreground">{event.summary}</div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent RC workflow records</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {events.isError ? (
            <ErrorState error={events.error} onRetry={() => events.refetch()} />
          ) : events.isLoading ? (
            <SkeletonRow count={5} />
          ) : importantRingCentralEvents.length === 0 ? (
            <EmptyState
              title="No recent events"
              description="This feed will populate as new EX presence and call workflow records arrive."
            />
          ) : (
            <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {importantRingCentralEvents.map((event, index) => (
                <li
                  key={`${event.aggregateId ?? "event"}-${index}`}
                  className="rounded-md border border-border p-3 text-sm"
                >
                  <div className="font-medium text-foreground">
                    {[event.family, event.subtype, event.stage].filter(Boolean).join(" · ")}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    {event.caseId != null ? (
                      <CaseLink caseId={event.caseId} domain={domain} compact />
                    ) : (
                      <span className="truncate max-w-[220px]">{event.aggregateId ?? "no aggregate id"}</span>
                    )}
                    {event.happenedAt ? <span>· {formatDateTime(event.happenedAt)}</span> : null}
                  </div>
                  {event.summary ? (
                    <div className="mt-1 text-xs text-muted-foreground">{event.summary}</div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function directionIcon(direction: string | null | undefined) {
  const d = (direction || "").toLowerCase();
  if (d === "inbound") return <PhoneIncoming className="h-3.5 w-3.5 text-sky-500" />;
  if (d === "outbound") return <PhoneOutgoing className="h-3.5 w-3.5 text-emerald-500" />;
  return <Activity className="h-3.5 w-3.5 text-muted-foreground" />;
}

function outcomeTone(row: CallLogRow): "danger" | "warning" | "success" | "info" {
  if (row.missed) return "danger";
  const o = (row.outcome || "").toLowerCase();
  if (o === "completed" || o === "accepted" || o === "call connected") return "success";
  if (o === "in-progress") return "info";
  return "warning";
}

function contactSide(row: CallLogRow): { name: string | null; number: string | null } {
  // The "contact" side of the call is whichever end isn't the agent.
  // For inbound calls the contact is the caller (from); for outbound it's
  // the callee (to). Also borrow caseName from attribution as a fallback.
  const dir = (row.direction || "").toLowerCase();
  if (dir === "inbound") {
    return {
      name: row.fromName || row.attribution?.caseName || null,
      number: row.fromNumber || null,
    };
  }
  if (dir === "outbound") {
    return {
      name: row.toName || row.attribution?.caseName || null,
      number: row.toNumber || null,
    };
  }
  // unknown direction — whatever we have
  return {
    name: row.toName || row.fromName || row.attribution?.caseName || null,
    number: row.toNumber || row.fromNumber || null,
  };
}

function CallLogTable({ rows }: { rows: CallLogRow[] }) {
  return (
    <div className="-mx-2 overflow-x-auto">
      <table className="w-full min-w-[760px] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-2 py-2 font-medium">When</th>
            <th className="px-2 py-2 font-medium">Direction</th>
            <th className="px-2 py-2 font-medium">Contact</th>
            <th className="px-2 py-2 font-medium">Case</th>
            <th className="px-2 py-2 font-medium">Agent</th>
            <th className="px-2 py-2 font-medium">Duration</th>
            <th className="px-2 py-2 font-medium">Outcome</th>
            <th className="px-2 py-2 font-medium">Source</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const contact = contactSide(row);
            const caseId = row.attribution?.caseId ?? null;
            const caseDomain = row.attribution?.caseDomain ?? null;
            return (
              <tr key={row.sessionId} className="border-b border-border/60 last:border-0 align-top">
                <td className="px-2 py-2 whitespace-nowrap">
                  <div className="text-foreground">{row.startedAt ? formatRelative(row.startedAt) : "—"}</div>
                  <div className="text-xs text-muted-foreground">
                    {row.startedAt ? formatDateTime(row.startedAt) : ""}
                  </div>
                </td>
                <td className="px-2 py-2 whitespace-nowrap">
                  <div className="flex items-center gap-1.5">
                    {directionIcon(row.direction)}
                    <span className="capitalize">{row.direction ?? "unknown"}</span>
                  </div>
                </td>
                <td className="px-2 py-2">
                  <div className="truncate max-w-[200px] font-medium text-foreground">
                    {contact.name ?? <span className="text-muted-foreground">—</span>}
                  </div>
                  <div className="numeric truncate max-w-[200px] text-xs text-muted-foreground">
                    {contact.number ?? ""}
                  </div>
                </td>
                <td className="px-2 py-2 whitespace-nowrap">
                  {caseId != null ? (
                    <div className="flex flex-col gap-0.5">
                      <CaseLink caseId={caseId} domain={caseDomain ?? undefined} compact />
                      {caseDomain ? (
                        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                          {caseDomain}
                        </span>
                      ) : null}
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-2 py-2 whitespace-nowrap">
                  <div className="truncate max-w-[180px]">{row.agentName ?? `ext ${row.extensionId ?? "?"}`}</div>
                  {row.extensionId ? (
                    <div className="text-xs text-muted-foreground">ext {row.extensionId}</div>
                  ) : null}
                </td>
                <td className="px-2 py-2 whitespace-nowrap numeric">{formatDuration(row.durationSec)}</td>
                <td className="px-2 py-2 whitespace-nowrap">
                  <div className="flex items-center gap-1.5">
                    {row.missed ? <PhoneMissed className="h-3.5 w-3.5 text-rose-500" /> : null}
                    <StatusPill dotted tone={outcomeTone(row)}>{row.outcome ?? "unknown"}</StatusPill>
                  </div>
                  {row.attribution?.status === "pending" ? (
                    <div className="mt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                      attribution pending
                    </div>
                  ) : null}
                </td>
                <td className="px-2 py-2">
                  {row.source?.matched ? (
                    <div className="space-y-0.5">
                      <div className="truncate max-w-[160px] text-foreground">{row.source.name}</div>
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <span className="capitalize">{row.source.channel}</span>
                        {row.attribution?.strategy ? (
                          <span className="rounded bg-muted px-1 py-[1px] text-[10px] uppercase tracking-wide">
                            {row.attribution.strategy}
                            {row.attribution.reconcile ? " · reconciled" : ""}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  ) : row.attribution?.strategy === "legacy" ? (
                    <span className="rounded bg-muted px-1 py-[1px] text-[10px] uppercase tracking-wide text-muted-foreground">
                      legacy
                    </span>
                  ) : row.source ? (
                    <span className="text-xs text-muted-foreground">Unmatched DID</span>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RuntimePanel({ runtime }: { runtime: RingcentralPollingRuntime | null }) {
  if (!runtime) {
    return <SkeletonRow count={4} />;
  }

  const poller = runtime.presencePoller;

  return (
    <dl className="space-y-3 text-sm">
      {!runtime.reachable ? (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-xs text-rose-500">
          ringcentral-cx unreachable{runtime.reason ? ` — ${runtime.reason}` : ""}
        </div>
      ) : null}

      <div className="flex items-center justify-between">
        <dt className="text-muted-foreground">Poller</dt>
        <dd className="font-medium">
          {poller?.enabled ? (poller.running ? "Running tick" : "Idle") : "Disabled"}
        </dd>
      </div>

      <div className="flex items-center justify-between">
        <dt className="text-muted-foreground">Interval</dt>
        <dd className="numeric">{poller?.intervalMs ? `${Math.round(poller.intervalMs / 1000)}s` : "—"}</dd>
      </div>

      <div className="flex items-center justify-between">
        <dt className="text-muted-foreground">Last tick</dt>
        <dd className="text-right">
          <div>{poller?.lastCompletedAt ? formatRelative(poller.lastCompletedAt) : "Never"}</div>
          {poller?.lastCompletedAt ? (
            <div className="text-[11px] text-muted-foreground">{formatDateTime(poller.lastCompletedAt)}</div>
          ) : null}
        </dd>
      </div>

      <div className="flex items-center justify-between">
        <dt className="text-muted-foreground">Lag</dt>
        <dd className="numeric">
          {runtime.ageMs != null ? `${Math.round(runtime.ageMs / 1000)}s` : "—"}
          <span className="ml-1 text-[11px] text-muted-foreground">
            / stale @ {Math.round(runtime.staleThresholdMs / 1000)}s
          </span>
        </dd>
      </div>

      <div className="flex items-center justify-between">
        <dt className="text-muted-foreground">Last result</dt>
        <dd className="text-right">
          {poller?.lastResult ? (
            <>
              <div>{formatNumber(poller.lastResult.checked)} checked</div>
              <div className="text-[11px] text-muted-foreground">
                {formatNumber(poller.lastResult.changed)} changed ·{" "}
                {formatNumber(poller.lastResult.staleCount)} stale
              </div>
            </>
          ) : (
            "—"
          )}
        </dd>
      </div>

      {poller?.lastError ? (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-amber-500">
          {poller.lastError}
        </div>
      ) : null}
    </dl>
  );
}
