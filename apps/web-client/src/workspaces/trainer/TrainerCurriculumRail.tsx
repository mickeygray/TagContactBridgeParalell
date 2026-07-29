import {
  CheckCircle2,
  Circle,
  LockKeyhole,
  PlayCircle,
} from "lucide-react";
import { cn } from "@/lib/utils/cn";
import type { TrainingCourseRailItem } from "@/lib/api/trainingCourse";

interface TrainerCurriculumRailProps {
  items: TrainingCourseRailItem[];
  activeItemId?: string | null;
  onOpenItem: (item: TrainingCourseRailItem) => void;
}

function statusIcon(item: TrainingCourseRailItem) {
  if (item.status === "completed") {
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
          return (
            <li key={item.itemId}>
              <button
                type="button"
                disabled={locked}
                aria-current={active ? "step" : undefined}
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
                    {index + 1}. {item.title}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {readableType(item.type)}
                    {item.required ? " - Required" : " - Optional"}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
