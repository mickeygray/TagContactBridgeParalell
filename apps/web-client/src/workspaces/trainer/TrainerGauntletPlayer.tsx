import { useEffect, useRef, useState } from "react";
import { Loader2, MessageCircle, RotateCcw, Send } from "lucide-react";
import { Button } from "@/components/ui/Button";
import {
  createTrainingRequestId,
  trainingCourseApi,
  type TrainingAttempt,
  type TrainingCourseItem,
  type TrainingGauntletResult,
} from "@/lib/api/trainingCourse";

interface TrainerGauntletPlayerProps {
  item: TrainingCourseItem;
  attempt: TrainingAttempt | null;
  onStart: () => Promise<TrainingAttempt | null>;
}

type TapeTurn = {
  id: string;
  speaker: "learner" | "prospect";
  text: string;
};

export function TrainerGauntletPlayer({
  item,
  attempt,
  onStart,
}: TrainerGauntletPlayerProps) {
  const [runtime, setRuntime] = useState<TrainingGauntletResult | null>(null);
  const [tape, setTape] = useState<TapeTurn[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const initializeEventRef = useRef<string | null>(null);
  const turnEventRef = useRef<{ input: string; eventId: string } | null>(null);

  useEffect(() => {
    if (!attempt || runtime) return;
    const controller = new AbortController();
    void trainingCourseApi.gauntlet(attempt.attemptId, controller.signal)
      .then(setRuntime)
      .catch(() => undefined);
    return () => controller.abort();
  }, [attempt, runtime]);

  async function begin() {
    setBusy(true);
    setError("");
    try {
      const started = attempt || await onStart();
      if (!started) return;
      const eventId = initializeEventRef.current ||
        (initializeEventRef.current = createTrainingRequestId("talk-init"));
      const result = await trainingCourseApi.initializeGauntlet(
        started.attemptId,
        { eventId, expectedVersion: started.version },
      );
      initializeEventRef.current = null;
      setRuntime(result);
      setTape([{
        id: "opening",
        speaker: "prospect",
        text: "The prospect is ready. Respond to the situation in this section of the call.",
      }]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start this Talk Session.");
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    const outbound = text.trim();
    const currentAttempt = runtime?.attempt || attempt;
    if (!outbound || !runtime?.state || !currentAttempt || busy) return;
    setBusy(true);
    setError("");
    const mutation = turnEventRef.current?.input === outbound
      ? turnEventRef.current
      : { input: outbound, eventId: createTrainingRequestId("talk-turn") };
    turnEventRef.current = mutation;
    try {
      const result = await trainingCourseApi.submitGauntletTurn(
        currentAttempt.attemptId,
        {
          eventId: mutation.eventId,
          expectedVersion: currentAttempt.version || runtime.version || 0,
          expectedTurn: runtime.state.nextTurn,
          text: outbound,
        },
      );
      turnEventRef.current = null;
      setText("");
      setRuntime(result);
      setTape((current) => [
        ...current,
        { id: mutation.eventId, speaker: "learner", text: outbound },
        ...(result.terminal ? [] : [{
          id: `${mutation.eventId}-prospect`,
          speaker: "prospect" as const,
          text: result.prospectReply?.text || result.reactionIntent || "The prospect responds and keeps this section moving.",
        }]),
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not submit this turn.");
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    const currentAttempt = runtime?.attempt || attempt;
    if (!currentAttempt) return;
    setBusy(true);
    setError("");
    try {
      const result = await trainingCourseApi.retryGauntlet(
        currentAttempt.attemptId,
        {
          eventId: createTrainingRequestId("talk-retry"),
          expectedVersion: currentAttempt.version || runtime?.version || 0,
        },
      );
      setRuntime(result);
      setTape([]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not begin another run.");
    } finally {
      setBusy(false);
    }
  }

  if (!runtime) {
    return (
      <div className="rounded-lg border border-primary/25 bg-primary/5 p-6">
        <MessageCircle className="h-7 w-7 text-primary" />
        <h2 className="mt-3 text-lg font-semibold">Targeted Talk Session</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Practice only this part of the call. The prospect can vary, but the
          server keeps the section, rules, voice, and advancement gates fixed.
        </p>
        {item.content.instructions ? (
          <p className="mt-3 text-sm">{item.content.instructions}</p>
        ) : null}
        {error ? <p role="alert" className="mt-3 text-sm text-destructive">{error}</p> : null}
        <Button className="mt-5" onClick={() => void begin()} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageCircle className="h-4 w-4" />}
          Start Talk Session
        </Button>
      </div>
    );
  }

  const terminal = runtime.state.status === "passed" || runtime.state.status === "failed";
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 p-4">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">
            Targeted Talk · Run {runtime.state.runNumber + 1}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Turn {runtime.state.nextTurn} · {runtime.state.status.replace(/_/g, " ")}
          </p>
        </div>
        <div className="text-xs text-muted-foreground">
          {runtime.state.criteria.filter((criterion) => criterion.status === "satisfied").length}
          /{runtime.state.criteria.length} skills demonstrated
        </div>
      </div>

      <div aria-label="Talk session transcript" className="max-h-[420px] space-y-3 overflow-y-auto rounded-lg border border-border p-4">
        {tape.map((turn) => (
          <div key={turn.id} className={turn.speaker === "learner" ? "ml-auto max-w-[85%] rounded-lg bg-primary p-3 text-sm text-primary-foreground" : "max-w-[85%] rounded-lg bg-muted p-3 text-sm"}>
            <div className="mb-1 text-[10px] font-semibold uppercase opacity-70">{turn.speaker}</div>
            {turn.text}
          </div>
        ))}
      </div>

      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {terminal ? (
        <div className="rounded-lg border border-border p-4">
          <h3 className="font-semibold">{runtime.state.status === "passed" ? "Section passed" : "Run complete"}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Review the cited skill evidence before moving on.
          </p>
          {runtime.state.status === "failed" ? (
            <Button className="mt-3" variant="secondary" onClick={() => void retry()} disabled={busy}>
              <RotateCcw className="h-4 w-4" />
              Try another variation
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="flex gap-2">
          <textarea
            aria-label="Your response"
            value={text}
            onChange={(event) => setText(event.target.value)}
            className="min-h-24 flex-1 rounded-md border border-input bg-background p-3 text-sm"
            placeholder="Say what you would say to the prospect..."
            disabled={busy}
          />
          <Button aria-label="Send response" onClick={() => void submit()} disabled={busy || !text.trim()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
      )}
    </div>
  );
}
