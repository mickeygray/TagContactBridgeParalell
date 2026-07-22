// Training Center panels — the learning environment around the roleplay bot.
//   STUDY    — the field manual, merged with its drills: read a topic, answer
//              its questions (model-graded), see the house answer. One surface.
//   MY CALLS — the trainee's recorded calls + on-demand scoring (bottom).
// Kept out of SalesTrainerWorkspace.tsx so the (delicate) voice-call component
// only gains a tab switch, not new logic.

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { salesTrainerApi, type TrainerDrillGrade } from "@/lib/api/salesTrainer";
import { API_BASE_URL, TOKEN_STORAGE_KEY } from "@/lib/api/client";
import { ALL_ENTRIES, PARTS, type ManualEntry } from "../field-manual/content";
import { cn } from "@/lib/utils/cn";

// ── study model: guide entries + their drills, grouped by topic ──────────────

interface StudyDrill {
  id: string;
  entryTitle: string;
  prompt: string;
  referenceAnswer: string;
}
interface StudyTopic {
  key: string; // `${part}/${section}`
  partTitle: string;
  sectionTitle: string;
  entries: ManualEntry[];
  drills: StudyDrill[];
}

function stripRefs(text: string): string {
  return text.replace(/\[\[[a-z0-9.-]+\]\]/g, "");
}

function buildStudyTopics(): StudyTopic[] {
  const byKey = new Map<string, StudyTopic>();
  for (const entry of ALL_ENTRIES) {
    const key = `${entry.part}/${entry.section}`;
    let topic = byKey.get(key);
    if (!topic) {
      const partMeta = PARTS.find((p) => p.id === entry.part);
      const sectionTitle = partMeta?.sections.find((s) => s.id === entry.section)?.title || entry.section;
      topic = { key, partTitle: partMeta?.title || entry.part, sectionTitle, entries: [], drills: [] };
      byKey.set(key, topic);
    }
    topic.entries.push(entry);
    entry.blocks.forEach((block, i) => {
      if (block.kind === "drill") {
        topic!.drills.push({ id: `${entry.id}#${i}`, entryTitle: entry.title, prompt: block.prompt, referenceAnswer: block.answer });
      }
    });
  }
  const partOrder = new Map(PARTS.map((p, i) => [p.id, i] as const));
  const sectionOrder = new Map<string, number>(
    PARTS.flatMap((p) => p.sections.map((s, i) => [`${p.id}/${s.id}`, i] as [string, number])),
  );
  return [...byKey.values()].sort((a, b) => {
    const pa = partOrder.get(a.entries[0]?.part) ?? 99;
    const pb = partOrder.get(b.entries[0]?.part) ?? 99;
    if (pa !== pb) return pa - pb;
    return (sectionOrder.get(a.key) ?? 99) - (sectionOrder.get(b.key) ?? 99);
  });
}

// ── one guide entry, readable (drills are surfaced separately as questions) ──

function EntryReader({ entry }: { entry: ManualEntry }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <span className="font-medium">{entry.title}</span>
        <span className="text-xs text-muted-foreground">{open ? "close" : "read"}</span>
      </button>
      {open ? (
        <div className="space-y-3 border-t border-border px-4 py-3 text-sm leading-relaxed">
          <p className="font-medium">{entry.lead}</p>
          {entry.blocks.map((block, i) => {
            if (block.kind === "prose") {
              return (
                <div key={i}>
                  {block.heading ? <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{block.heading}</div> : null}
                  <p>{stripRefs(block.text)}</p>
                </div>
              );
            }
            if (block.kind === "moves" || block.kind === "lines" || block.kind === "avoid") {
              return (
                <div key={i}>
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {block.heading || (block.kind === "avoid" ? "Avoid" : block.kind === "lines" ? "Lines" : "Moves")}
                  </div>
                  <ul className="list-disc space-y-1 pl-5">
                    {block.items.map((item, j) => <li key={j}>{stripRefs(item)}</li>)}
                  </ul>
                </div>
              );
            }
            if (block.kind === "example") {
              return (
                <div key={i} className="space-y-1">
                  <p className="rounded-md border border-red-500/20 bg-red-500/5 p-2"><span className="font-semibold">Weak:</span> {block.weak}</p>
                  <p className="rounded-md border border-emerald-500/20 bg-emerald-500/5 p-2"><span className="font-semibold">Strong:</span> {block.strong}</p>
                  {block.note ? <p className="text-xs text-muted-foreground">{block.note}</p> : null}
                </div>
              );
            }
            if (block.kind === "compliance") {
              return (
                <p key={i} className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs">
                  <span className="font-semibold">Compliance: </span>{block.text}
                </p>
              );
            }
            return null; // drills are asked in the Test-yourself section
          })}
        </div>
      ) : null}
    </div>
  );
}

// ── one drill: answer it, get graded, then talk about it ─────────────────────

const VERDICT_TONE: Record<TrainerDrillGrade["verdict"], string> = {
  nailed: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
  close: "bg-sky-500/15 text-sky-600 border-sky-500/30",
  partial: "bg-amber-500/15 text-amber-600 border-amber-500/30",
  miss: "bg-red-500/15 text-red-600 border-red-500/30",
};

function DrillCard({ drill }: { drill: StudyDrill }) {
  const [answer, setAnswer] = useState("");
  const [grading, setGrading] = useState(false);
  const [grade, setGrade] = useState<TrainerDrillGrade | null>(null);
  const [error, setError] = useState("");

  async function submit() {
    if (!answer.trim() || grading) return;
    setGrading(true);
    setError("");
    try {
      const g = await salesTrainerApi.gradeDrill({
        topic: drill.entryTitle,
        question: drill.prompt,
        referenceAnswer: drill.referenceAnswer,
        answer: answer.trim(),
      });
      setGrade(g);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Grading failed — try again.");
    } finally {
      setGrading(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">From “{drill.entryTitle}”</div>
      <p className="mt-1 text-sm font-medium leading-relaxed">{drill.prompt}</p>
      {grade ? (
        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-2">
            <span className={cn("rounded-full border px-2 py-0.5 text-xs font-semibold", VERDICT_TONE[grade.verdict])}>
              {grade.score} · {grade.verdict}
            </span>
            <Button size="sm" variant="ghost" onClick={() => { setGrade(null); }}>Try again</Button>
          </div>
          <p className="whitespace-pre-wrap rounded-md bg-muted/40 p-2 text-sm">{answer}</p>
          {grade.doctrineFlag ? (
            <p className="rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-600">Doctrine flag: {grade.doctrineFlag}</p>
          ) : null}
          <p className="text-sm">{grade.coaching}</p>
          {grade.suggestedLine ? <p className="text-sm italic text-muted-foreground">Try: “{grade.suggestedLine}”</p> : null}
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">The guide's answer</summary>
            <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{stripRefs(drill.referenceAnswer)}</p>
          </details>
        </div>
      ) : (
        <>
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="Your move — the way you'd actually say or run it…"
            rows={3}
            className="mt-3 w-full resize-y rounded-md border border-border bg-background p-3 text-sm outline-none focus:border-primary"
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Graded on substance. Promises and made-up numbers cap the score.</span>
            <Button size="sm" onClick={() => void submit()} disabled={grading || !answer.trim()}>
              {grading ? "Grading…" : "Check my answer"}
            </Button>
          </div>
          {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
        </>
      )}
    </div>
  );
}

// ── STUDY: read a topic, answer its questions ────────────────────────────────

export function StudyPanel() {
  const topics = useMemo(() => buildStudyTopics(), []);
  const [key, setKey] = useState<string>("");
  const topic = topics.find((t) => t.key === key) || null;

  if (!topic) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-border bg-card p-4">
          <h2 className="text-base font-semibold">Study — read the guide, answer the questions</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Pick a topic. Read the plays, then work the drills — each answer is graded by the coach against the house answer.
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {topics.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setKey(t.key)}
              className="rounded-lg border border-border bg-card p-4 text-left transition-colors hover:border-primary/60 hover:bg-primary/5"
            >
              <div className="text-xs uppercase tracking-wide text-muted-foreground">{t.partTitle}</div>
              <div className="mt-1 font-medium">{t.sectionTitle}</div>
              <div className="mt-2 text-xs text-muted-foreground">
                {t.entries.length} {t.entries.length === 1 ? "entry" : "entries"} · {t.drills.length} {t.drills.length === 1 ? "question" : "questions"}
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-lg border border-border bg-card px-4 py-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">{topic.partTitle}</div>
          <div className="font-medium">{topic.sectionTitle}</div>
        </div>
        <Button size="sm" variant="secondary" onClick={() => setKey("")}>All topics</Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          <div className="text-sm font-semibold text-muted-foreground">Read</div>
          {topic.entries.map((e) => <EntryReader key={e.id} entry={e} />)}
        </div>
        <div className="space-y-3">
          <div className="text-sm font-semibold text-muted-foreground">
            Test yourself {topic.drills.length ? `· ${topic.drills.length}` : ""}
          </div>
          {topic.drills.length ? (
            topic.drills.map((d) => <DrillCard key={d.id} drill={d} />)
          ) : (
            <p className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
              No drills in this topic — read the plays and move on.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ── MY CALLS: load one, score it (bottom of the Training Center) ─────────────

interface LibraryRecording {
  driveFileId: string;
  name?: string;
  agentName?: string;
  dateKey?: string;
  phoneMasked?: string;
  playUrl?: string;
  sizeBytes?: number;
  [key: string]: unknown;
}
interface ScoreState {
  status: "scoring" | "done" | "error";
  message?: string;
  score?: Record<string, unknown>;
  transcript?: string;
}

export function MyCallsPanel() {
  const [rows, setRows] = useState<LibraryRecording[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [scores, setScores] = useState<Record<string, ScoreState>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = localStorage.getItem(TOKEN_STORAGE_KEY);
        const res = await fetch(`${API_BASE_URL}/api/read/cx/recordings/library?days=30`, {
          headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          credentials: "include",
        });
        if (!res.ok) {
          throw new Error(res.status === 401 || res.status === 403
            ? "Sign in to the main app to load your recorded calls."
            : `Library load failed (${res.status})`);
        }
        const payload = await res.json();
        const list: LibraryRecording[] = payload?.recordings || payload?.result?.recordings || payload?.rows || [];
        if (!cancelled) setRows(Array.isArray(list) ? list : []);
      } catch (err) {
        if (!cancelled) {
          setRows([]);
          setLoadError(err instanceof Error ? err.message : "Could not load the call library.");
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function scoreOne(rec: LibraryRecording) {
    const id = rec.driveFileId;
    if (!id || scores[id]?.status === "scoring") return;
    setScores((prev) => ({ ...prev, [id]: { status: "scoring" } }));
    try {
      const result = await salesTrainerApi.scoreCall({ driveFileId: id });
      setScores((prev) => ({ ...prev, [id]: { status: "done", score: result.score, transcript: result.transcript } }));
    } catch (err) {
      setScores((prev) => ({ ...prev, [id]: { status: "error", message: err instanceof Error ? err.message : "Scoring failed" } }));
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-base font-semibold">My calls — load one, score it</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Your recorded calls from the last 30 days. “Score it” runs the same grader the nightly review uses — transcript, verdict, coaching notes — on demand.
        </p>
        {loadError ? <p className="mt-2 text-sm text-amber-600">{loadError}</p> : null}
      </div>

      {rows == null ? (
        <p className="text-sm text-muted-foreground">Loading library…</p>
      ) : rows.length === 0 && !loadError ? (
        <p className="text-sm text-muted-foreground">No recordings found in the last 30 days.</p>
      ) : (
        rows.slice(0, 60).map((rec) => {
          const state = scores[rec.driveFileId];
          const scoreObj = (state?.score || {}) as Record<string, unknown>;
          const overall = scoreObj.overallScore ?? scoreObj.score ?? scoreObj.overall;
          const verdict = scoreObj.verdict ?? scoreObj.leadQuality;
          return (
            <div key={rec.driveFileId} className="rounded-lg border border-border bg-card p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{rec.name || rec.driveFileId}</div>
                  <div className="text-xs text-muted-foreground">
                    {[rec.agentName, rec.dateKey, rec.phoneMasked].filter(Boolean).join(" · ")}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {rec.playUrl ? (
                    <a className="text-sm text-primary underline-offset-2 hover:underline" href={`${API_BASE_URL}${rec.playUrl}`} target="_blank" rel="noreferrer">Play</a>
                  ) : null}
                  <Button size="sm" variant="secondary" disabled={state?.status === "scoring"} onClick={() => void scoreOne(rec)}>
                    {state?.status === "scoring" ? "Scoring…" : state?.status === "done" ? "Re-score" : "Score it"}
                  </Button>
                </div>
              </div>
              {state?.status === "error" ? <p className="mt-2 text-sm text-destructive">{state.message}</p> : null}
              {state?.status === "done" ? (
                <div className="mt-3 space-y-2 border-t border-border pt-3">
                  <div className="text-sm font-semibold">
                    {overall != null ? `Score ${String(overall)}` : "Scored"}{verdict ? ` · ${String(verdict)}` : ""}
                  </div>
                  {typeof scoreObj.summary === "string" ? <p className="text-sm">{scoreObj.summary}</p> : null}
                  {Array.isArray(scoreObj.coachingNotes) ? (
                    <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                      {(scoreObj.coachingNotes as unknown[]).slice(0, 5).map((note, i) => <li key={i}>{String(note)}</li>)}
                    </ul>
                  ) : null}
                  <details className="text-sm">
                    <summary className="cursor-pointer text-muted-foreground">Transcript</summary>
                    <p className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap text-xs text-muted-foreground">{state.transcript}</p>
                  </details>
                </div>
              ) : null}
            </div>
          );
        })
      )}
    </div>
  );
}
