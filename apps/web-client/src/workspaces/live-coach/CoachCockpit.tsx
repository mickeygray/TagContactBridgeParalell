import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Flag,
  Headset,
  ListChecks,
  RefreshCw,
  Star,
  StickyNote,
  UserRound,
  Zap,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { cn } from "@/lib/utils/cn";
import { SCRIPT_SECTION_IDS, getScriptSection, getScriptSectionForBeat } from "@/lib/liveCoach/taxGroupSections";
import { useCoachCockpit, type CockpitConnection } from "@/lib/liveCoach/useCoachCockpit";

type CoachCockpitProps = {
  sessionId: string | null;
  className?: string;
};

const SECTION_LABELS: Record<string, string> = {
  "1": "Intro",
  "2": "Case",
  "3": "Expert",
  "4": "Pitch",
  "4B": "Payment",
  "5": "Info",
  "6": "Think",
  "7": "Close",
};

const SAY_TONE: Record<string, string> = {
  objection: "border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200",
  tactic: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200",
  line: "border-border bg-muted text-foreground",
};

const CONNECTION_TONE: Record<CockpitConnection, { label: string; tone: "neutral" | "success" | "warning" | "danger" | "info" }> = {
  idle: { label: "idle", tone: "neutral" },
  connecting: { label: "connecting", tone: "info" },
  open: { label: "live", tone: "success" },
  reconnecting: { label: "reconnecting", tone: "warning" },
  error: { label: "offline", tone: "danger" },
};

function relativeTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  return `${mins}m ago`;
}

// Split the flattened dialog say ("Read: ...\nSteer: ...\nTry: ...") into labeled lines.
function splitDialogLines(say: string | null | undefined): Array<{ label: string; text: string }> {
  if (!say) return [];
  return say
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(Read|Steer|Try):\s*(.*)$/i);
      return m ? { label: m[1], text: m[2] } : { label: "", text: line };
    });
}

export function CoachCockpit({ sessionId, className }: CoachCockpitProps) {
  const { session, cockpit, dialog, rollingSummary, connection, terminal } = useCoachCockpit(sessionId);

  if (!sessionId) {
    return (
      <Card className={cn("shadow-none", className)}>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          No call selected. Open a session to start coaching.
        </CardContent>
      </Card>
    );
  }

  const meta = session?.metadata || {};
  const agentName = meta.agentName || meta.agentEmail || "Agent";
  const contactName = meta.contactName || "Prospect";
  const statusByBeat = new Map<string, string>();
  for (const beat of cockpit?.beats || []) {
    if (beat?.beatId && beat.status) statusByBeat.set(beat.beatId, beat.status);
  }
  // Recover the section even when the model emits an off-enum currentSection (clamped to null
  // server-side): derive it from the first beat that carries a known beatId.
  const firstBeatId = (cockpit?.beats || []).map((b) => b?.beatId).find(Boolean) || null;
  const section = getScriptSection(cockpit?.currentSection) || getScriptSectionForBeat(firstBeatId);
  const currentSection = section?.id || cockpit?.currentSection || null;
  const statusOf = (id: string) => statusByBeat.get(id) || "pending";
  // The "active" beat = the first still-pending one in the section (reveal its script detail).
  const firstPendingIdx = section ? section.beats.findIndex((b) => statusOf(b.id) === "pending") : -1;
  const priorFlagSections = new Set((cockpit?.priorFlags || []).map((f) => f?.section).filter(Boolean) as string[]);
  const says = [...(cockpit?.says || [])].filter((s) => s?.text);
  const recSay = says.find((s) => s?.rec) || says[0] || null;
  const altSays = says.filter((s) => s !== recSay);
  const dialogLines = splitDialogLines(dialog?.say);
  const taxIssues = (rollingSummary?.taxIssues || []).filter(Boolean) as string[];
  const facts = Object.entries(session?.factLedger || {})
    .map(([key, v]) => ({ key, value: v?.value || "" }))
    .filter((f) => f.value);
  const capturedFacts = (rollingSummary?.factsCaptured || []).filter(Boolean) as string[];
  const freshness = relativeTime(cockpit?.generatedAt || cockpit?.at);
  const conn = CONNECTION_TONE[connection];

  return (
    <Card className={cn("shadow-none", className)}>
      <CardHeader className="border-b border-border px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex min-w-0 items-center gap-2 text-base">
            <Headset className="h-4 w-4 shrink-0 text-sky-700" aria-hidden="true" />
            <span className="truncate">
              {agentName} <span className="text-muted-foreground">&rarr;</span> {contactName}
            </span>
          </CardTitle>
          <div className="flex shrink-0 items-center gap-2">
            {freshness ? <span className="text-[11px] text-muted-foreground">updated {freshness}</span> : null}
            <StatusPill tone={terminal ? "neutral" : conn.tone}>{terminal ? "ended" : conn.label}</StatusPill>
          </div>
        </div>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {[meta.domain, meta.caseId ? `case ${meta.caseId}` : null].filter(Boolean).join(" · ") || "live call"}
        </p>
      </CardHeader>

      <CardContent className="space-y-3 bg-slate-50/60 p-3 dark:bg-slate-950/30">
        {dialogLines.length ? (
          <div className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 dark:border-rose-900 dark:bg-rose-950/40">
            <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-rose-700 dark:text-rose-300">
              <Zap className="h-3.5 w-3.5" aria-hidden="true" /> react now
            </div>
            {dialogLines.map((line, i) => (
              <p key={i} className="text-[13px] leading-snug text-foreground">
                {line.label ? <span className="font-medium text-muted-foreground">{line.label}: </span> : null}
                {line.text}
              </p>
            ))}
          </div>
        ) : null}

        <div>
          <div className="mb-1.5 flex items-center gap-2">
            <span className="text-[11px] font-medium text-muted-foreground">say &mdash; a few options, recommended</span>
            <Star className="h-3 w-3 text-sky-600" aria-hidden="true" />
            <span className="h-px flex-1 bg-border" />
          </div>
          {recSay ? (
            <div className="mb-2 rounded-md border-2 border-sky-400 bg-background p-2.5 dark:border-sky-700">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className={cn("rounded-md px-1.5 py-0.5 text-[11px] font-medium", SAY_TONE[recSay.type || "line"] || SAY_TONE.line)}>
                  {recSay.type || "line"}{recSay.tag ? ` · ${recSay.tag}` : ""}
                </span>
                <Star className="h-3.5 w-3.5 shrink-0 text-sky-600" aria-hidden="true" />
              </div>
              <p className="text-sm leading-relaxed text-foreground">{recSay.text}</p>
            </div>
          ) : (
            <p className="rounded-md border border-border bg-background px-3 py-2 text-[13px] text-muted-foreground">
              {terminal ? "Call ended." : "Listening — the coach will surface a line when there's a moment to act on."}
            </p>
          )}
          {altSays.length ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {altSays.map((s, i) => (
                <div key={i} className="rounded-md border border-border bg-background p-2">
                  <span className={cn("rounded-md px-1.5 py-0.5 text-[11px] font-medium", SAY_TONE[s.type || "line"] || SAY_TONE.line)}>
                    {s.type || "line"}{s.tag ? ` · ${s.tag}` : ""}
                  </span>
                  <p className="mt-1.5 text-[12.5px] leading-snug text-foreground">{s.text}</p>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div className="flex gap-1 overflow-x-auto">
          {SCRIPT_SECTION_IDS.map((id) => {
            const active = id === currentSection;
            const flagged = priorFlagSections.has(id);
            return (
              <div
                key={id}
                className={cn(
                  "flex-1 whitespace-nowrap rounded-md border px-1.5 py-1 text-center text-[11px]",
                  active
                    ? "border-sky-500 bg-sky-600 font-medium text-white"
                    : flagged
                      ? "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
                      : "border-border bg-background text-muted-foreground",
                )}
                title={flagged ? (cockpit?.priorFlags || []).find((f) => f?.section === id)?.issue || undefined : undefined}
              >
                {flagged && !active ? <Flag className="mx-auto h-3 w-3" aria-hidden="true" /> : null}
                <div>
                  {id} {SECTION_LABELS[id] || ""}
                </div>
              </div>
            );
          })}
        </div>

        <div className="grid grid-cols-1 gap-2 lg:grid-cols-3">
          <div className="rounded-md border border-border bg-background p-2.5">
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
              <ListChecks className="h-3.5 w-3.5" aria-hidden="true" /> script{section ? ` · ${section.title}` : ""}
            </div>
            {section ? (
              <ul className="space-y-1.5">
                {section.beats.map((beat, idx) => {
                  const status = statusOf(beat.id);
                  const isActive = idx === firstPendingIdx;
                  return (
                    <li key={beat.id}>
                      <div className="flex items-start gap-2 text-[12.5px]">
                        {status === "hit" ? (
                          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" aria-hidden="true" />
                        ) : status === "fumbled" ? (
                          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-600" aria-hidden="true" />
                        ) : (
                          <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                        )}
                        <span className={cn(status === "hit" ? "text-muted-foreground line-through" : "text-foreground")}>{beat.point}</span>
                      </div>
                      {isActive ? <p className="ml-5 mt-1 text-[11.5px] leading-snug text-sky-800 dark:text-sky-200">{beat.detail}</p> : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-[12px] text-muted-foreground">Waiting for the coach to place the call on the script.</p>
            )}
          </div>

          <div className="rounded-md border border-border bg-background p-2.5">
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
              <StickyNote className="h-3.5 w-3.5" aria-hidden="true" /> summary &amp; remember
            </div>
            <p className="mb-2.5 text-[12.5px] leading-snug text-foreground">{cockpit?.summary || <span className="text-muted-foreground">No section summary yet.</span>}</p>
            {(cockpit?.remember || []).length ? (
              <ul className="mb-2.5 space-y-1">
                {(cockpit?.remember || []).filter((r) => r?.text).map((r, i) => (
                  <li key={i} className="flex gap-1.5 text-[11.5px]">
                    <span className={cn("mt-0.5 w-0.5 shrink-0 rounded-sm", r.kind === "key" ? "bg-sky-500" : "bg-amber-500")} />
                    <span>{r.text}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {taxIssues.length ? (
              <>
                <div className="mb-1 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">tax memory</div>
                <ul className="space-y-0.5 text-[11px] text-muted-foreground">
                  {taxIssues.map((t, i) => (
                    <li key={i}>&middot; {t}</li>
                  ))}
                </ul>
              </>
            ) : null}
          </div>

          <div className="rounded-md border border-border bg-background p-2.5">
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
              <UserRound className="h-3.5 w-3.5" aria-hidden="true" /> case
            </div>
            {facts.length || capturedFacts.length ? (
              <ul className="mb-2 space-y-1 text-[11.5px]">
                {facts.map((f) => (
                  <li key={f.key} className="flex justify-between gap-2">
                    <span className="text-muted-foreground">{f.key}</span>
                    <span className="text-right">{f.value}</span>
                  </li>
                ))}
                {capturedFacts.map((f, i) => (
                  <li key={`c-${i}`} className="text-foreground">&middot; {f}</li>
                ))}
              </ul>
            ) : (
              <p className="mb-2 text-[12px] text-muted-foreground">No facts captured yet.</p>
            )}
            <button
              type="button"
              className="w-full rounded-md border border-border bg-background px-2 py-1 text-[11.5px] text-foreground transition hover:bg-muted"
            >
              <RefreshCw className="mr-1 inline h-3 w-3" aria-hidden="true" /> Update case context
            </button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
