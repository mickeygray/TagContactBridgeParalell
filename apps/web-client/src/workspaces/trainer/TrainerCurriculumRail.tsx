import {
  CheckCircle2,
  Circle,
  Dot,
  LockKeyhole,
  PlayCircle,
  RotateCcw,
} from "lucide-react";
import { cn } from "@/lib/utils/cn";
import type {
  TrainingCourseModuleProgress,
  TrainingCourseRailItem,
} from "@/lib/api/trainingCourse";

interface TrainerCurriculumRailProps {
  items: TrainingCourseRailItem[];
  activeItemId?: string | null;
  onOpenItem: (item: TrainingCourseRailItem) => void;
  /**
   * Supplied by the player while a Targeted Talk is open. The section the
   * learner is inside expands to its practices; without this the rail stays a
   * plain section list, which is what course home wants.
   */
  moduleProgress?: TrainingCourseModuleProgress | null;
}

function statusIcon(item: TrainingCourseRailItem) {
  if (item.status === "completed") {
    if (item.completionOutcome === "failed") {
      return <RotateCcw aria-hidden="true" className="h-4 w-4 text-warning" />;
    }
    return <CheckCircle2 aria-hidden="true" className="h-4 w-4 text-success" />;
  }
  if (item.status === "locked" || item.status === "unavailable") {
    return <LockKeyhole aria-hidden="true" className="h-4 w-4 text-muted-foreground" />;
  }
  if (item.status === "in_progress") {
    return <PlayCircle aria-hidden="true" className="h-4 w-4 text-primary" />;
  }
  return <Circle aria-hidden="true" className="h-4 w-4 text-muted-foreground" />;
}

function readableType(type: string) {
  return type.replace(/[-_]/g, " ").replace(/^\w/, (letter) => letter.toUpperCase());
}

export function TrainerCurriculumRail({
  items,
  activeItemId,
  onOpenItem,
  moduleProgress = null,
}: TrainerCurriculumRailProps) {
  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
        No published course items are available yet.
      </div>
    );
  }

  return (
    <nav aria-label="Course curriculum" className="space-y-1">
      <div className="mb-3 px-2">
        <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          Course curriculum
        </div>
        <div className="mt-1 text-sm text-muted-foreground">
          Availability is set by the course service.
        </div>
      </div>
      <ol className="space-y-1">
        {items.map((item, index) => {
          const locked =
            item.status === "locked" || item.status === "unavailable";
          const active = item.itemId === activeItemId;
          // Number from the curriculum, falling back to array position only
          // when the service sent no label.
          const sectionNumber = item.sectionLabel || String(index + 1);
          const showModules =
            active &&
            Boolean(item.modules?.length) &&
            moduleProgress?.itemId === item.itemId;
          const completed = new Set(moduleProgress?.completedModuleIds || []);
          return (
            <li key={item.itemId}>
              <button
                type="button"
                disabled={locked}
                aria-current={active && !showModules ? "step" : undefined}
                aria-label={
                  locked
                    ? `${item.title}, locked`
                    : `${item.title}, ${item.status.replace(/_/g, " ")}`
                }
                onClick={() => onOpenItem(item)}
                className={cn(
                  "flex w-full items-start gap-3 rounded-md border px-3 py-3 text-left transition-colors",
                  active
                    ? "border-primary/50 bg-primary/10"
                    : "border-transparent hover:border-border hover:bg-muted/40",
                  locked && "cursor-not-allowed opacity-60 hover:border-transparent hover:bg-transparent",
                )}
              >
                <span className="mt-0.5 shrink-0">{statusIcon(item)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">
                    {sectionNumber}. {item.title}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {item.modules?.length
                      ? `${item.modules.length} practices`
                      : readableType(item.type)}
                    {item.required ? " - Required" : " - Optional"}
                    {item.status === "completed" && item.completionOutcome === "failed"
                      ? " - Revisit"
                      : ""}
                  </span>
                </span>
              </button>

              {showModules ? (
                <ol
                  aria-label={`${item.title} practices`}
                  className="ml-5 mt-1 space-y-0.5 border-l border-border/70 pl-3"
                >
                  {item.modules?.map((moduleItem, moduleIndex) => {
                    const isCurrent =
                      moduleItem.moduleId === moduleProgress?.currentModuleId;
                    const isDone = completed.has(moduleItem.moduleId);
                    return (
                      <li key={moduleItem.moduleId}>
                        <div
                          aria-current={isCurrent ? "step" : undefined}
                          className={cn(
                            "flex items-start gap-2 rounded-md px-2 py-1.5 text-xs",
                            isCurrent
                              ? "bg-primary/10 font-medium text-foreground"
                              : "text-muted-foreground",
                          )}
                        >
                          <span className="mt-0.5 shrink-0">
                            {isDone ? (
                              <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5 text-success" />
                            ) : isCurrent ? (
                              <PlayCircle aria-hidden="true" className="h-3.5 w-3.5 text-primary" />
                            ) : (
                              <Dot aria-hidden="true" className="h-3.5 w-3.5" />
                            )}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="tabular-nums">
                              {sectionNumber}.{moduleIndex + 1}
                            </span>{" "}
                            {moduleItem.title}
                            {isDone ? <span className="sr-only">, complete</span> : null}
                            {isCurrent ? (
                              <span className="sr-only">, current practice</span>
                            ) : null}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
