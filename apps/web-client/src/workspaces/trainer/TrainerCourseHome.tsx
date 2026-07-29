import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Loader2,
  RotateCcw,
  Sparkles,
  Target,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import type {
  TrainingCourseHome,
  TrainingCourseRailItem,
} from "@/lib/api/trainingCourse";
import { TrainerCurriculumRail } from "./TrainerCurriculumRail";

interface TrainerCourseHomeProps {
  status: "loading" | "ready" | "error";
  home: TrainingCourseHome | null;
  error: string;
  enrolling: boolean;
  onRetry: () => void;
  onEnroll: () => void;
  onOpenItem: (courseId: string, item: TrainingCourseRailItem) => void;
  onOpenPractice: () => void;
}

function progressPercent(completed: number, total: number) {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((completed / total) * 100)));
}

export function TrainerCourseHome({
  status,
  home,
  error,
  enrolling,
  onRetry,
  onEnroll,
  onOpenItem,
  onOpenPractice,
}: TrainerCourseHomeProps) {
  if (status === "loading") {
    return (
      <div
        role="status"
        className="flex min-h-[420px] items-center justify-center gap-2 text-sm text-muted-foreground"
      >
        <Loader2 className="h-5 w-5 animate-spin" />
        Loading your course...
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="mx-auto max-w-xl rounded-xl border border-destructive/30 bg-card p-6 text-center">
        <h2 className="text-lg font-semibold">The course could not be loaded</h2>
        <p className="mt-2 text-sm text-muted-foreground">{error}</p>
        <Button className="mt-5" variant="secondary" onClick={onRetry}>
          <RotateCcw className="h-4 w-4" />
          Try again
        </Button>
      </div>
    );
  }

  if (!home?.course) {
    return (
      <div className="mx-auto max-w-xl rounded-xl border border-dashed border-border bg-card p-8 text-center">
        <BookOpen className="mx-auto h-9 w-9 text-muted-foreground" />
        <h2 className="mt-4 text-lg font-semibold">No course is published yet</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          The course shell is ready, but it will not invent lessons or rules in the browser.
        </p>
        <Button className="mt-5" variant="secondary" onClick={onOpenPractice}>
          Open legacy Free Call
        </Button>
      </div>
    );
  }

  const { course, enrollment } = home;
  if (!enrollment) {
    return (
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <section className="rounded-xl border border-border bg-card p-7 shadow-soft">
          <div className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
            <Sparkles className="h-3.5 w-3.5" />
            Version {course.courseVersion}
          </div>
          <h1 className="mt-5 text-3xl font-semibold tracking-tight">{course.title}</h1>
          <p className="mt-3 max-w-2xl text-sm leading-7 text-muted-foreground">
            Learn the move, retrieve it, practice saying it, and transfer it to a natural call.
            Your enrollment pins the published course and rule versions.
          </p>
          {error ? (
            <p role="alert" className="mt-4 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="mt-6 flex flex-wrap gap-3">
            <Button onClick={onEnroll} disabled={enrolling}>
              {enrolling ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowRight className="h-4 w-4" />
              )}
              Start course
            </Button>
            <Button variant="secondary" onClick={onOpenPractice}>
              Legacy Free Call
            </Button>
          </div>
        </section>
        <aside className="rounded-xl border border-border bg-card p-5">
          <h2 className="font-semibold">How it works</h2>
          <ol className="mt-4 space-y-4 text-sm text-muted-foreground">
            <li className="flex gap-3"><span className="font-semibold text-foreground">1</span> Read one focused lesson.</li>
            <li className="flex gap-3"><span className="font-semibold text-foreground">2</span> Retrieve and recognize the rule.</li>
            <li className="flex gap-3"><span className="font-semibold text-foreground">3</span> Say the move in your own words.</li>
            <li className="flex gap-3"><span className="font-semibold text-foreground">4</span> Transfer it into a Free Call.</li>
          </ol>
        </aside>
      </div>
    );
  }

  const progress = enrollment.progress;
  const percent = progressPercent(progress.completed, progress.total);
  const resumeItem = enrollment.resumeItemId
    ? enrollment.items.find((item) => item.itemId === enrollment.resumeItemId) || null
    : null;
  const hasRemediation = Array.isArray(enrollment.activeRemediation)
    ? enrollment.activeRemediation.length > 0
    : Boolean(enrollment.activeRemediation);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-6">
        <section className="overflow-hidden rounded-xl border border-border bg-card shadow-soft">
          <div className="bg-gradient-to-br from-primary/15 via-card to-card p-7">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
              Continue learning
            </div>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight">{course.title}</h1>
            <div className="mt-6 max-w-2xl">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">{progress.completed} of {progress.total} items</span>
                <span className="text-muted-foreground">{percent}%</span>
              </div>
              <div
                className="mt-2 h-2.5 overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-label="Course progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
              >
                <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Required: {progress.requiredCompleted} of {progress.requiredTotal}
              </p>
            </div>
            <div className="mt-6 flex flex-wrap gap-3">
              {resumeItem ? (
                <Button onClick={() => onOpenItem(course.courseId, resumeItem)}>
                  <ArrowRight className="h-4 w-4" />
                  Continue: {resumeItem.title}
                </Button>
              ) : null}
              <Button variant="secondary" onClick={onOpenPractice}>
                Practice a Free Call
              </Button>
            </div>
          </div>
        </section>

        {hasRemediation ? (
          <section className="rounded-xl border border-warning/40 bg-warning/10 p-5">
            <div className="flex items-start gap-3">
              <Target className="mt-0.5 h-5 w-5 text-warning" />
              <div>
                <h2 className="font-semibold">Your next targeted rep</h2>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  The course service assigned remediation and placed it ahead of ordinary progression.
                </p>
              </div>
            </div>
          </section>
        ) : null}

        <section className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-success" />
            <h2 className="font-semibold">Course progress</h2>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {enrollment.items.map((item) => (
              <button
                type="button"
                key={item.itemId}
                disabled={item.status === "locked" || item.status === "unavailable"}
                onClick={() => onOpenItem(course.courseId, item)}
                className="rounded-lg border border-border p-4 text-left transition-colors enabled:hover:border-primary/50 enabled:hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <div className="text-sm font-medium">{item.title}</div>
                <div className="mt-1 text-xs capitalize text-muted-foreground">
                  {item.status.replace(/_/g, " ")} - {item.type.replace(/[-_]/g, " ")}
                </div>
              </button>
            ))}
          </div>
        </section>
      </div>

      <aside className="h-fit rounded-xl border border-border bg-card p-4 lg:sticky lg:top-6">
        <TrainerCurriculumRail
          items={enrollment.items}
          onOpenItem={(item) => onOpenItem(course.courseId, item)}
        />
      </aside>
    </div>
  );
}
