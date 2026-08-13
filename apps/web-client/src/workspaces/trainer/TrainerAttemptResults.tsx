import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  Loader2,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import {
  createTrainingRequestId,
  trainingCourseApi,
  type TrainingAttemptResult,
} from "@/lib/api/trainingCourse";

interface TrainerAttemptResultsProps {
  attemptId: string;
  basePath: "/trainer" | "/cx/coach";
}

function safeSummaryLines(summary: Record<string, unknown> | null) {
  if (!summary) return [];
  return Object.entries(summary)
    .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
    .map(([key, value]) => ({
      label: key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " "),
      value: String(value),
    }));
}

export function TrainerAttemptResults({ attemptId, basePath }: TrainerAttemptResultsProps) {
  const navigate = useNavigate();
  const [result, setResult] = useState<TrainingAttemptResult | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [reflection, setReflection] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const reflectionMutationRef = useRef<{ input: string; eventId: string } | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setStatus("loading");
    setError("");
    try {
      const next = await trainingCourseApi.results(attemptId, signal);
      if (signal?.aborted) return;
      setResult(next);
      setStatus("ready");
    } catch (err) {
      if (signal?.aborted) return;
      setResult(null);
      setError(err instanceof Error ? err.message : "Could not load attempt results.");
      setStatus("error");
    }
  }, [attemptId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const reflectionEvent = result?.events.find(
    (event) =>
      event.type === "reflection_added" ||
      typeof event.payload.reflection === "string",
  );
  const hasReflection = Boolean(reflectionEvent);

  async function submitReflection() {
    if (!result || !reflection.trim() || submitting) return;
    setSubmitting(true);
    setError("");
    const outboundReflection = reflection.trim();
    const priorMutation = reflectionMutationRef.current;
    const eventId =
      priorMutation?.input === outboundReflection
        ? priorMutation.eventId
        : createTrainingRequestId("reflection");
    reflectionMutationRef.current = { input: outboundReflection, eventId };
    try {
      await trainingCourseApi.reflect(attemptId, {
        reflection: outboundReflection,
        eventId,
        expectedVersion: result.attempt.version,
      });
      reflectionMutationRef.current = null;
      setReflection("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save your reflection.");
    } finally {
      setSubmitting(false);
    }
  }

  if (status === "loading") {
    return (
      <div role="status" className="flex min-h-[420px] items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        Loading results...
      </div>
    );
  }

  if (status === "error" || !result) {
    return (
      <div className="mx-auto max-w-xl rounded-xl border border-border bg-card p-7 text-center">
        <h1 className="text-lg font-semibold">Results are unavailable</h1>
        <p className="mt-2 text-sm text-muted-foreground">{error}</p>
        <Button className="mt-5" variant="secondary" onClick={() => void load()}>
          <RotateCcw className="h-4 w-4" />
          Try again
        </Button>
      </div>
    );
  }

  if (result.attempt.status !== "completed" || result.terminalSummary == null) {
    return (
      <div className="mx-auto max-w-xl rounded-xl border border-border bg-card p-7 text-center">
        <h1 className="text-lg font-semibold">This attempt is still in progress</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Results and reflection become available only after the server completes the attempt.
        </p>
        <Button
          className="mt-5"
          variant="secondary"
          onClick={() =>
            navigate(
              `${basePath}/course/${encodeURIComponent(result.attempt.courseId)}/item/${encodeURIComponent(result.attempt.itemId)}`,
            )
          }
        >
          Return to item
        </Button>
      </div>
    );
  }

  const summary = safeSummaryLines(result.terminalSummary);
  const grades = result.events
    .map((event) => event.payload.grade)
    .filter((grade): grade is NonNullable<typeof grade> => Boolean(grade));
  const next = result.nextAssignment || null;
  const passed = result.terminalSummary.status !== "failed";

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <section className="rounded-xl border border-border bg-card p-7 shadow-soft">
        <div className="flex items-start gap-4">
          <div
            className={
              passed
                ? "rounded-full bg-success/10 p-3 text-success"
                : "rounded-full bg-warning/10 p-3 text-warning"
            }
          >
            {passed ? (
              <CheckCircle2 className="h-6 w-6" />
            ) : (
              <RotateCcw className="h-6 w-6" />
            )}
          </div>
          <div>
            <div
              className={`text-xs font-semibold uppercase tracking-[0.16em] ${
                passed ? "text-success" : "text-warning"
              }`}
            >
              {passed ? "Practice passed" : "Practice completed — revisit recommended"}
            </div>
            <h1 className="mt-2 text-2xl font-semibold">Review your rep</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Reflection is kept separate from observed execution evidence.
            </p>
          </div>
        </div>
      </section>

      {grades.length ? (
        <section className="rounded-xl border border-border bg-card p-6">
          <h2 className="font-semibold">Observed evidence</h2>
          <div className="mt-4 space-y-3">
            {grades.map((grade, index) => (
              <div key={index} className="rounded-lg border border-border p-4">
                <div className="font-medium">
                  Score {grade.score} - {grade.passed ? "Passed" : "Keep practicing"}
                </div>
                {grade.feedback ? (
                  <p className="mt-2 text-sm text-muted-foreground">
                    {grade.feedback}
                  </p>
                ) : null}
                {grade.evidence?.length ? (
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                    {grade.evidence.map((line, lineIndex) => (
                      <li key={`${lineIndex}-${line}`}>{line}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {!hasReflection ? (
        <section className="rounded-xl border border-primary/30 bg-card p-6">
          <h2 className="font-semibold">Reflect before Coach feedback</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            What did the prospect or question give you, what move did you choose, and what would you try differently?
          </p>
          <label htmlFor="trainer-reflection" className="mt-4 block text-sm font-medium">
            Your reflection
          </label>
          <textarea
            id="trainer-reflection"
            rows={6}
            value={reflection}
            onChange={(event) => setReflection(event.target.value)}
            className="mt-2 w-full resize-y rounded-md border border-border bg-background p-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
          {error ? <p role="alert" className="mt-2 text-sm text-destructive">{error}</p> : null}
          <div className="mt-4 flex justify-end">
            <Button onClick={() => void submitReflection()} disabled={!reflection.trim() || submitting}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              Save reflection
            </Button>
          </div>
        </section>
      ) : (
        <section className="rounded-xl border border-border bg-card p-6">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            <h2 className="font-semibold">Coach read</h2>
          </div>
          {summary.length ? (
            <dl className="mt-4 grid gap-3 sm:grid-cols-2">
              {summary.map((line) => (
                <div key={line.label} className="rounded-lg border border-border p-4">
                  <dt className="text-xs font-semibold capitalize text-muted-foreground">{line.label}</dt>
                  <dd className="mt-1 text-sm">{line.value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">
              No additional Coach summary was published for this attempt.
            </p>
          )}
        </section>
      )}

      <div className="flex flex-wrap justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => navigate(basePath)}>
            Course home
          </Button>
          {!passed ? (
            <Button
              variant="secondary"
              onClick={() =>
                navigate(
                  `${basePath}/course/${encodeURIComponent(result.attempt.courseId)}/item/${encodeURIComponent(result.attempt.itemId)}`,
                )
              }
            >
              <RotateCcw className="h-4 w-4" />
              Retry this practice
            </Button>
          ) : null}
        </div>
        {next ? (
          <Button
            onClick={() =>
              navigate(
                `${basePath}/course/${encodeURIComponent(next.courseId)}/item/${encodeURIComponent(next.itemId)}`,
              )
            }
          >
            Next assignment
            <ArrowRight className="h-4 w-4" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
