import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, Play, RotateCcw, Send } from "lucide-react";
import { Button } from "@/components/ui/Button";
import type {
  TrainingAnswerResult,
  TrainingAttempt,
  TrainingCourseItem,
} from "@/lib/api/trainingCourse";

interface TrainerQuizItemProps {
  item: TrainingCourseItem;
  attempt: TrainingAttempt | null;
  lastAnswer: TrainingAnswerResult | null;
  busy: boolean;
  onStart: () => void;
  onAnswer: (answer: string) => void;
  onResetAnswer: () => void;
  onComplete: () => void;
  onViewResults?: () => void;
}

function readableEvidence(value: string) {
  return value.replace(/[-_]/g, " ").replace(/^\w/, (letter) => letter.toUpperCase());
}

export function TrainerQuizItem({
  item,
  attempt,
  lastAnswer,
  busy,
  onStart,
  onAnswer,
  onResetAnswer,
  onComplete,
  onViewResults,
}: TrainerQuizItemProps) {
  const [answer, setAnswer] = useState("");
  const prompt = item.content.prompt || "Answer this item in your own words.";
  const choices = item.content.choices || [];

  useEffect(() => {
    setAnswer("");
    onResetAnswer();
  }, [item.itemId, onResetAnswer]);
  if (!attempt && item.status === "completed") {
    return (
      <div className="space-y-5">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Completed knowledge check
          </div>
          <h3 className="mt-2 text-lg font-semibold leading-7">{prompt}</h3>
          {item.content.instructions ? (
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{item.content.instructions}</p>
          ) : null}
        </div>
        {choices.length ? (
          <ul aria-label="Answer choices" className="space-y-2">
            {choices.map((choice) => (
              <li key={choice.choiceId} className="rounded-lg border border-border p-3 text-sm">
                {choice.label}
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-lg border border-border bg-muted/20 p-4 text-sm text-muted-foreground">
            The completed response is read-only. Its answer and rubric remain server-owned.
          </p>
        )}
        <div className="rounded-lg border border-success/40 bg-success/10 p-4">
          <div className="flex items-center gap-2 font-semibold">
            <CheckCircle2 className="h-4 w-4" />
            Item completed
          </div>
          {onViewResults ? (
            <Button className="mt-3" variant="secondary" onClick={onViewResults}>
              View results
            </Button>
          ) : null}
        </div>
      </div>
    );
  }


  if (!attempt) {
    return (
      <div className="rounded-lg border border-primary/30 bg-primary/5 p-5">
        <h3 className="font-semibold">Ready to test the move?</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          The server owns the answer and rubric. The browser receives only this prompt and the final grade evidence.
        </p>
        <Button className="mt-4" onClick={onStart} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          {item.status === "in_progress" ? "Resume attempt" : "Start attempt"}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          {item.type === "say-it" || item.type === "say_it" ? "Say the move" : "Knowledge check"}
        </div>
        <h3 className="mt-2 text-lg font-semibold leading-7">{prompt}</h3>
        {item.content.instructions ? (
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{item.content.instructions}</p>
        ) : null}
      </div>

      {choices.length ? (
        <fieldset className="space-y-2" disabled={Boolean(lastAnswer) || busy}>
          <legend className="sr-only">Answer choices</legend>
          {choices.map((choice) => (
            <label
              key={choice.choiceId}
              className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 hover:bg-muted/30"
            >
              <input
                className="mt-1"
                type="radio"
                name={"course-item-" + item.itemId}
                value={choice.choiceId}
                checked={answer === choice.choiceId}
                onChange={() => setAnswer(choice.choiceId)}
              />
              <span className="text-sm leading-6">{choice.label}</span>
            </label>
          ))}
        </fieldset>
      ) : (
        <div>
          <label htmlFor={"trainer-answer-" + item.itemId} className="text-sm font-medium">
            {item.type === "say-it" || item.type === "say_it"
              ? "How you would actually say it"
              : "Your answer"}
          </label>
          <textarea
            id={"trainer-answer-" + item.itemId}
            rows={item.type === "say-it" || item.type === "say_it" ? 6 : 4}
            value={answer}
            disabled={Boolean(lastAnswer) || busy}
            onChange={(event) => setAnswer(event.target.value)}
            className="mt-2 w-full resize-y rounded-md border border-border bg-background p-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-70"
          />
        </div>
      )}

      {lastAnswer ? (
        <div
          role="status"
          className={
            lastAnswer.grade.passed
              ? "rounded-lg border border-success/40 bg-success/10 p-4"
              : "rounded-lg border border-warning/40 bg-warning/10 p-4"
          }
        >
          <div className="flex items-center gap-2 font-semibold">
            <CheckCircle2 className="h-4 w-4" />
            {lastAnswer.grade.passed ? "Passed" : "Try the move again"}
          </div>
          {lastAnswer.grade.evidence.length ? (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
              {lastAnswer.grade.evidence.map((line, index) => (
                <li key={index}>{readableEvidence(line)}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-5">
        {!lastAnswer ? (
          <Button onClick={() => onAnswer(answer.trim())} disabled={!answer.trim() || busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Submit answer
          </Button>
        ) : null}
        {lastAnswer && !lastAnswer.grade.passed ? (
          <Button
            variant="secondary"
            onClick={() => {
              setAnswer("");
              onResetAnswer();
            }}
            disabled={busy}
          >
            <RotateCcw className="h-4 w-4" />
            Try again
          </Button>
        ) : null}
        {lastAnswer?.completionEligible ? (
          <Button onClick={onComplete} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            Complete attempt
          </Button>
        ) : null}
      </div>
    </div>
  );
}
