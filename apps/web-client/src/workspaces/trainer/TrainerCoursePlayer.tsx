import { ArrowLeft, Loader2, LockKeyhole, RotateCcw } from "lucide-react";
import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import type {
  TrainingCourseHome,
  TrainingCourseModuleProgress,
} from "@/lib/api/trainingCourse";
import { TrainerCurriculumRail } from "./TrainerCurriculumRail";
import { TrainerLessonItem } from "./TrainerLessonItem";
import { TrainerQuizItem } from "./TrainerQuizItem";
import { TrainerGauntletPlayer } from "./TrainerGauntletPlayer";
import { TrainerFreeCallPlayer } from "./TrainerFreeCallPlayer";
import { useTrainingAttempt } from "./hooks/useTrainingAttempt";

interface TrainerCoursePlayerProps {
  basePath: "/trainer" | "/cx/coach";
  courseId: string;
  itemId: string;
  home: TrainingCourseHome | null;
  onOpenPractice: () => void;
}

export function TrainerCoursePlayer({
  basePath,
  courseId,
  itemId,
  home,
  onOpenPractice,
}: TrainerCoursePlayerProps) {
  const navigate = useNavigate();
  const attemptState = useTrainingAttempt(courseId, itemId);
  const items = home?.enrollment?.items || [];
  // Lifted here so the curriculum rail can show the OPEN section's practices
  // (4B.1–4B.4) instead of listing every section again. Declared above the
  // early returns below — hook order has to stay stable across renders.
  const [moduleProgress, setModuleProgress] = useState<TrainingCourseModuleProgress | null>(null);
  const handleModuleProgress = useCallback(
    (progress: { currentModuleId: string | null; completedModuleIds: string[] }) => {
      setModuleProgress({ itemId, ...progress });
    },
    [itemId],
  );

  if (attemptState.status === "loading") {
    return (
      <div role="status" className="flex min-h-[420px] items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        Loading course item...
      </div>
    );
  }

  if (attemptState.status === "error" || !attemptState.item) {
    return (
      <div className="mx-auto max-w-xl rounded-xl border border-border bg-card p-7 text-center">
        <LockKeyhole className="mx-auto h-8 w-8 text-muted-foreground" />
        <h1 className="mt-4 text-lg font-semibold">This item is not available</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {attemptState.error || "The course service did not make this item available."}
        </p>
        <div className="mt-5 flex justify-center gap-2">
          <Button variant="secondary" onClick={() => navigate(basePath)}>
            <ArrowLeft className="h-4 w-4" />
            Course home
          </Button>
          <Button variant="secondary" onClick={() => void attemptState.loadItem()}>
            <RotateCcw className="h-4 w-4" />
            Retry
          </Button>
        </div>
      </div>
    );
  }

  const item = attemptState.item;
  const busy = attemptState.action !== null;
  const isFreeCall = item.type === "free_call" || item.type === "free-call";
  const isLesson = item.type === "lesson";
  const isGauntlet = item.type === "gauntlet";
  const isAssessed =
    item.type === "quiz" || item.type === "say_it" || item.type === "say-it";
  const completedAttemptId = item.completedAttemptId;
  const viewCompletedResults = completedAttemptId
    ? () =>
        navigate(
          `${basePath}/attempt/${encodeURIComponent(completedAttemptId)}/results`,
        )
    : undefined;

  async function complete(attemptOverride?: Parameters<typeof attemptState.complete>[0]) {
    const result = await attemptState.complete(attemptOverride);
    if (result?.attemptId) {
      navigate(`${basePath}/attempt/${encodeURIComponent(result.attemptId)}/results`);
    }
    return Boolean(result?.attemptId);
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
      <aside className="h-fit rounded-xl border border-border bg-card p-4 lg:sticky lg:top-6">
        <Button variant="ghost" size="sm" onClick={() => navigate(basePath)}>
          <ArrowLeft className="h-4 w-4" />
          Course home
        </Button>
        <div className="mt-4">
          <TrainerCurriculumRail
            items={items}
            activeItemId={itemId}
            moduleProgress={moduleProgress}
            onOpenItem={(next) =>
              navigate(
                `${basePath}/course/${encodeURIComponent(courseId)}/item/${encodeURIComponent(next.itemId)}`,
              )
            }
          />
        </div>
      </aside>

      <main className="min-w-0 rounded-xl border border-border bg-card shadow-soft">
        <header className="border-b border-border p-6">
          <div className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">
            {item.type.replace(/[-_]/g, " ")}
            {item.required ? " - Required" : " - Optional"}
          </div>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">{item.title}</h1>
          <p className="mt-2 text-xs text-muted-foreground">
            Item version {item.itemVersion}
          </p>
        </header>
        <div className="p-6">
          {attemptState.error ? (
            <div role="alert" className="mb-5 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              {attemptState.error}
            </div>
          ) : null}
          {isFreeCall ? (
            <TrainerFreeCallPlayer onOpenLegacyPractice={onOpenPractice} />
          ) : isGauntlet && home?.capabilities.gauntletV1Enabled === true ? (
            <TrainerGauntletPlayer
              item={item}
              attempt={attemptState.attempt}
              onStart={attemptState.start}
              onAttemptChange={attemptState.syncAttempt}
              onComplete={complete}
              onModuleProgress={handleModuleProgress}
            />
          ) : isLesson ? (
            <TrainerLessonItem
              item={item}
              attempt={attemptState.attempt}
              busy={busy}
              onStart={() => void attemptState.start()}
              onComplete={() => void complete()}
              onViewResults={viewCompletedResults}
            />
          ) : isAssessed ? (
            <TrainerQuizItem
              item={item}
              attempt={attemptState.attempt}
              lastAnswer={attemptState.lastAnswer}
              busy={busy}
              onStart={() => void attemptState.start()}
              onAnswer={(answer) => void attemptState.answer(answer)}
              onResetAnswer={attemptState.clearLastAnswer}
              onComplete={() => void complete()}
              onViewResults={viewCompletedResults}
            />
          ) : (
            <div role="alert" className="rounded-lg border border-border bg-muted/20 p-5">
              <LockKeyhole className="h-6 w-6 text-muted-foreground" />
              <h2 className="mt-3 font-semibold">This course experience is not available yet</h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                Only lesson, quiz, and say-it items are enabled in this release. Return to the course home for server-provided available work.
              </p>
              <Button className="mt-4" variant="secondary" onClick={() => navigate(basePath)}>
                Course home
              </Button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
