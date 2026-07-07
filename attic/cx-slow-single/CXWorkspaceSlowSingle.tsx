import * as React from "react";
import { CheckCircle2, Loader2, PhoneCall, RotateCw, ShieldCheck, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";
import { StatusPill, toneFromStatus } from "@/components/ui/StatusPill";
import { toast } from "@/components/ui/Toaster";
import {
  useCxAppointments,
  useCxCallAppointmentNowAny,
  useCxReleaseAppointmentAny,
} from "@/lib/api/queries/cx";
import {
  useCxSlowSingleKill,
  useCxSlowSingleOutcome,
  useCxSlowSingleSession,
  useCxSlowSingleStart,
  useCxSlowSingleWatch,
  type CxSlowSingleSession,
} from "@/lib/api/queries/cxSlowSingle";
import type { CxAppointment } from "@/lib/api/types";
import { useSession } from "@/lib/auth/useSession";
import { cn } from "@/lib/utils/cn";
import { AppointmentList } from "../AppointmentList";

type SlowSingleOutcome = "answered" | "did_not_connect" | "voicemail";
const CX_RAIL_MAX_CONSECUTIVE_NO_ACTIVE = 3;
const CX_RAIL_MAX_HTTP_ERRORS = 3;

function describeCurrent(session?: CxSlowSingleSession | null) {
  const current = session?.current;
  if (!current) return "No current confirmed call";
  return [
    current.name || "Unknown",
    current.caseId ? `case ${current.caseId}` : null,
    current.phoneLast4 ? `***${current.phoneLast4}` : null,
    current.uii ? `UII ${current.uii}` : null,
  ].filter(Boolean).join(" | ");
}

function phaseCopy(phase?: string | null) {
  const normalized = String(phase || "").trim();
  if (normalized === "pending_confirmation") return "waiting for RingCX";
  if (normalized === "active") return "call confirmed";
  if (normalized === "releasing") return "releasing call";
  if (normalized === "released") return "ready for next";
  if (normalized === "publishing") return "sending lead";
  if (normalized === "selecting") return "selecting lead";
  return normalized || "ready";
}

function formatEvent(event: Record<string, unknown>) {
  const type = String(event.type || "event");
  const at = String(event.at || "").slice(11, 19);
  const bits = [
    at,
    type,
    event.reason ? String(event.reason) : null,
    event.error ? String(event.error) : null,
  ].filter(Boolean);
  return bits.join(" | ");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(row: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && String(value).trim()) {
      return String(value).trim();
    }
  }
  return "";
}

export function CXWorkspaceSlowSingle() {
  const { user } = useSession();
  const [domain, setDomain] = React.useState("TAG");
  const session = useCxSlowSingleSession(true);
  const start = useCxSlowSingleStart();
  const watch = useCxSlowSingleWatch();
  const outcome = useCxSlowSingleOutcome();
  const kill = useCxSlowSingleKill();
  const appointments = useCxAppointments(domain, { status: "active" });
  const callAppointmentNow = useCxCallAppointmentNowAny();
  const releaseAppointment = useCxReleaseAppointmentAny();
  const [handoffPending, setHandoffPending] = React.useState(false);
  const [blockedReason, setBlockedReason] = React.useState<string | null>(null);
  const noActiveCountRef = React.useRef(0);
  const httpErrorCountRef = React.useRef(0);

  function resetRailGuards() {
    noActiveCountRef.current = 0;
    httpErrorCountRef.current = 0;
    setBlockedReason(null);
  }

  const data = session.data;
  const railCurrent = data?.current || null;
  const busy = start.isPending || watch.isPending || outcome.isPending || kill.isPending || handoffPending;
  const railBlocked = Boolean(blockedReason);
  const terminalAdvancePending = handoffPending || (outcome.isPending && Boolean(railCurrent));
  const waitingForActive =
    terminalAdvancePending ||
    data?.phase === "pending_confirmation" ||
    data?.phase === "publishing" ||
    data?.phase === "selecting";
  const buttonsEnabled = Boolean(railCurrent?.uii) && data?.phase === "active" && !busy && !railBlocked;
  const canSendNext = !busy && !railBlocked && !railCurrent && !waitingForActive;
  const canClearSession =
    Boolean(data?.sessionId) &&
    !busy &&
    data?.phase !== "active" &&
    data?.phase !== "releasing";

  React.useEffect(() => {
    if (!waitingForActive || !data?.sessionId || railCurrent?.uii || watch.isPending || railBlocked) return;
    const timer = window.setTimeout(() => {
      void watch
        .mutateAsync({ sessionId: data.sessionId, timeoutMs: 900 })
        .then((result) => {
          httpErrorCountRef.current = 0;
          if (result?.current?.uii) {
            noActiveCountRef.current = 0;
            return;
          }
          const nextNoActive = noActiveCountRef.current + 1;
          noActiveCountRef.current = nextNoActive;
          if (nextNoActive >= CX_RAIL_MAX_CONSECUTIVE_NO_ACTIVE) {
            setBlockedReason("RingCX did not confirm an active call after three watch attempts.");
            toast.error("Slow rail paused", {
              description: "RingCX did not confirm the active call. Refresh, clear, or send the next lead manually.",
            });
          }
        })
        .catch((error) => {
          const nextHttpErrors = httpErrorCountRef.current + 1;
          httpErrorCountRef.current = nextHttpErrors;
          if (nextHttpErrors >= CX_RAIL_MAX_HTTP_ERRORS) {
            setBlockedReason(error instanceof Error ? error.message : "Slow watch failed repeatedly.");
            toast.error("Slow rail paused", {
              description: error instanceof Error ? error.message : "Slow watch failed repeatedly.",
            });
          }
        });
    }, 900);
    return () => window.clearTimeout(timer);
  }, [railCurrent?.uii, data?.phase, data?.sessionId, railBlocked, waitingForActive, watch]);

  React.useEffect(() => {
    if (!railCurrent?.uii) return;
    noActiveCountRef.current = 0;
    httpErrorCountRef.current = 0;
    setBlockedReason(null);
  }, [railCurrent?.uii]);

  async function handleStart() {
    try {
      resetRailGuards();
      await start.mutateAsync({
        domain,
        dialPriority: "NORMAL",
        initialCaptureMs: 1000,
      });
    } catch (error) {
      toast.error("Send next failed", {
        description: error instanceof Error ? error.message : "The next lead could not be sent.",
      });
      session.refetch();
    }
  }

  async function handleOutcome(nextOutcome: SlowSingleOutcome) {
    const currentSnapshot = railCurrent;
    if (!data?.sessionId || !currentSnapshot) return;
    resetRailGuards();
    setHandoffPending(true);
    try {
      const released = await outcome.mutateAsync({
        sessionId: data.sessionId,
        expectedQueueItemId: currentSnapshot.queueItemId || undefined,
        expectedUii: currentSnapshot.uii || undefined,
        outcome: nextOutcome,
        confirmBeforeOutcomeMs: 1500,
        terminalMaxAttempts: 2,
        terminalRetryDelayMs: 250,
      });
      if (released && !released.current && released.phase === "released") {
        await start.mutateAsync({
          domain,
          dialPriority: "NORMAL",
          initialCaptureMs: 1000,
        });
        await session.refetch();
      }
    } catch (error) {
      toast.error("Call update failed", {
        description: error instanceof Error ? error.message : "The current call could not be updated.",
      });
      session.refetch();
    } finally {
      setHandoffPending(false);
    }
  }

  async function handleKill() {
    if (!data?.sessionId) return;
    try {
      resetRailGuards();
      await kill.mutateAsync({ sessionId: data.sessionId, reason: "manual-clear" });
    } catch (error) {
      toast.error("Clear failed", {
        description: error instanceof Error ? error.message : "The session could not be cleared.",
      });
      session.refetch();
    }
  }

  function handleReleaseAppointment(appointment: CxAppointment) {
    releaseAppointment
      .mutateAsync({
        domain: appointment.domain,
        appointmentId: appointment.appointmentId,
        reason: "released-from-cx-slow-single",
      })
      .then(() => {
        toast.success("Appointment released");
        appointments.refetch();
      })
      .catch((error) => {
        toast.error("Release appointment failed", {
          description: error instanceof Error ? error.message : "The appointment could not be released.",
        });
        appointments.refetch();
      });
  }

  function handleCallAppointmentNow(appointment: CxAppointment) {
    callAppointmentNow
      .mutateAsync({
        domain: appointment.domain,
        appointmentId: appointment.appointmentId,
      })
      .then((result) => {
        const row = asRecord(result);
        if (row.deferred === true) {
          const fireResult = asRecord(row.fireResult);
          const inner = asRecord(fireResult.result);
          const nextAllowedAt = readString(inner, "nextAllowedAt");
          toast("Appointment held for legal dial window", {
            description: nextAllowedAt
              ? `Next legal time: ${new Date(nextAllowedAt).toLocaleString()}`
              : "The appointment is still outside the allowed dialing window.",
          });
        } else {
          toast.success("Appointment call queued", {
            description: "CX is dialing this appointment through your agent queue.",
          });
        }
        appointments.refetch();
      })
      .catch((error) => {
        toast.error("Call now failed", {
          description: error instanceof Error ? error.message : "CX could not queue this appointment.",
        });
        appointments.refetch();
      });
  }

  const events = Array.isArray(data?.events) ? data.events.slice(-8).reverse() : [];
  const appointmentItems = appointments.data?.items || [];

  return (
    <div className="min-h-[calc(100vh-5rem)] bg-background p-4">
      <div className="mx-auto flex max-w-6xl flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-foreground">CX Slow Single</h1>
            <p className="text-xs text-muted-foreground">
              One lead at a time. RingCX confirms the active call before buttons unlock.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={domain}
              onChange={(event) => setDomain(event.target.value)}
              className="h-9 rounded-md border border-border bg-card px-3 text-sm text-foreground"
              disabled={busy}
            >
              <option value="TAG">TAG</option>
              <option value="WYNN">WYNN</option>
            </select>
            <Button
              type="button"
              variant="secondary"
              onClick={() => void session.refetch()}
              disabled={busy}
            >
              <RotateCw />
              Refresh
            </Button>
            <Button
              type="button"
              onClick={handleStart}
              isLoading={start.isPending}
              disabled={!canSendNext}
            >
              <PhoneCall />
              Send Next
            </Button>
          </div>
        </div>
        {blockedReason ? (
          <div className="flex items-start justify-between gap-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-950 dark:text-red-100">
            <div className="min-w-0">
              <div className="font-semibold">Slow rail paused</div>
              <div className="text-[11px] opacity-80">{blockedReason}</div>
            </div>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => {
                resetRailGuards();
                void session.refetch();
              }}
            >
              Resume
            </Button>
          </div>
        ) : null}

        <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
          <section className="flex flex-col gap-4">
            <Card className="overflow-hidden">
              <CardHeader>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <CardTitle>Current Call</CardTitle>
                    <CardDescription>{user?.email || data?.agentEmail || "agent"}</CardDescription>
                  </div>
                  <StatusPill tone={toneFromStatus(data?.phase)} dotted>
                    {phaseCopy(data?.phase)}
                  </StatusPill>
                </div>
              </CardHeader>
              <CardContent>
                <div
                  className={cn(
                    "relative rounded-md border border-border bg-muted/20 p-5 transition-opacity",
                    waitingForActive && "opacity-80",
                  )}
                >
                  {waitingForActive ? (
                    <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/70">
                      <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm text-muted-foreground shadow-soft">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {terminalAdvancePending
                          ? "Finishing call and loading next lead"
                          : "Waiting for RingCX active call"}
                      </div>
                    </div>
                  ) : null}
                  <div className="space-y-2">
                    <div className="text-xl font-semibold text-foreground">
                      {railCurrent?.name || "Ready for next lead"}
                    </div>
                    <div className="text-sm text-muted-foreground">{describeCurrent(data)}</div>
                    {railCurrent?.activeCallSummary ? (
                      <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
                        <div>State: {String(railCurrent.activeCallSummary.state || "unknown")}</div>
                        <div>Campaign: {String(railCurrent.activeCallSummary.campaignId || "-")}</div>
                        <div>Match: {(railCurrent.matchReasons || []).join(", ") || "-"}</div>
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="mt-4 grid gap-2 sm:grid-cols-3">
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={!buttonsEnabled}
                    isLoading={outcome.isPending}
                    onClick={() => void handleOutcome("answered")}
                  >
                    <CheckCircle2 />
                    Answered
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={!buttonsEnabled}
                    isLoading={outcome.isPending}
                    onClick={() => void handleOutcome("did_not_connect")}
                  >
                    No Answer
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={!buttonsEnabled}
                    isLoading={outcome.isPending}
                    onClick={() => void handleOutcome("voicemail")}
                  >
                    Voicemail
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Last Outcome</CardTitle>
              </CardHeader>
              <CardContent>
                {data?.lastOutcome ? (
                  <div className="text-sm text-muted-foreground">
                    {[data.lastOutcome.name || "Unknown", data.lastOutcome.outcome, data.lastOutcome.caseId ? `case ${data.lastOutcome.caseId}` : null]
                      .filter(Boolean)
                      .join(" | ")}
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground">Nothing released in this session yet.</div>
                )}
              </CardContent>
            </Card>
          </section>

          <aside className="flex flex-col gap-4">
            <AppointmentList
              appointments={appointmentItems}
              onCallNow={handleCallAppointmentNow}
              onRelease={handleReleaseAppointment}
              callingAppointmentId={String(callAppointmentNow.variables?.appointmentId || "") || null}
              isReleasing={releaseAppointment.isPending}
              isCallingNow={callAppointmentNow.isPending}
            />

            <Card>
              <CardHeader>
                <div className="flex items-center justify-between gap-2">
                  <CardTitle>Rail State</CardTitle>
                  <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                </div>
              </CardHeader>
              <CardContent className="space-y-3 text-xs text-muted-foreground">
                <div className="grid grid-cols-2 gap-2">
                  <div>Status</div>
                  <div className="text-right font-medium text-foreground">{data?.status || "none"}</div>
                  <div>Session</div>
                  <div className="truncate text-right font-mono text-[10px]">{data?.sessionId || "-"}</div>
                  <div>Extension</div>
                  <div className="text-right">{data?.agentExtensionId || "-"}</div>
                  <div>Updated</div>
                  <div className="text-right">{data?.updatedAt ? String(data.updatedAt).slice(11, 19) : "-"}</div>
                </div>
                {data?.lastError ? (
                  <div className="rounded-md border border-rose-200 bg-rose-50 p-2 text-rose-700">
                    {String(data.lastError)}
                  </div>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full"
                  onClick={handleKill}
                  disabled={!canClearSession}
                >
                  <Trash2 />
                  Clear Session
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Trace</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {events.length > 0 ? events.map((event, index) => (
                    <div key={`${String(event.at || index)}-${String(event.type || index)}`} className="rounded-md bg-muted/40 p-2 text-[11px] text-muted-foreground">
                      {formatEvent(event)}
                    </div>
                  )) : (
                    <div className="text-xs text-muted-foreground">No events yet.</div>
                  )}
                </div>
              </CardContent>
            </Card>
          </aside>
        </div>
      </div>
    </div>
  );
}
