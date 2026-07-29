import { CheckCircle2, Clock3, Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/Button";
import type {
  TrainingAttempt,
  TrainingCourseItem,
} from "@/lib/api/trainingCourse";

interface TrainerLessonItemProps {
  item: TrainingCourseItem;
  attempt: TrainingAttempt | null;
  busy: boolean;
  onStart: () => void;
  onComplete: () => void;
  onViewResults?: () => void;
}

export function TrainerLessonItem({
  item,
  attempt,
  busy,
  onStart,
  onComplete,
  onViewResults,
}: TrainerLessonItemProps) {
  return (
    <article className="space-y-6">
      {!attempt ? (
        item.status === "completed" ? (
          <div className="rounded-lg border border-success/40 bg-success/10 p-4">
            <div className="flex items-center gap-2 font-semibold">
              <CheckCircle2 className="h-4 w-4" />
              Lesson completed
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              This pinned lesson is read-only because the server already marked it complete.
            </p>
            {onViewResults ? (
              <Button className="mt-3" variant="secondary" onClick={onViewResults}>
                View results
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
            <p className="text-sm text-muted-foreground">
              Start this lesson to record progress against its pinned version.
            </p>
            <Button className="mt-3" onClick={onStart} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {item.status === "in_progress" ? "Resume lesson" : "Start lesson"}
            </Button>
          </div>
        )
      ) : null}

      {item.content.estimatedMinutes ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Clock3 className="h-3.5 w-3.5" />
          About {item.content.estimatedMinutes} minutes
        </div>
      ) : null}

      {item.content.summary ? (
        <p className="text-base font-medium leading-7">{item.content.summary}</p>
      ) : null}

      {item.content.instructions ? (
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 text-sm leading-6">
          {item.content.instructions}
        </div>
      ) : null}

      {item.content.body ? (
        <div className="whitespace-pre-wrap text-sm leading-7">{item.content.body}</div>
      ) : (
        <div className="rounded-lg border border-dashed border-border p-5 text-sm text-muted-foreground">
          This lesson has no published reading yet.
        </div>
      )}

      {attempt ? (
        <div className="flex justify-end border-t border-border pt-5">
          <Button onClick={onComplete} disabled={busy || attempt.status === "completed"}>
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle2 className="h-4 w-4" />
            )}
            {attempt.status === "completed" ? "Lesson completed" : "Complete lesson"}
          </Button>
        </div>
      ) : null}
    </article>
  );
}
