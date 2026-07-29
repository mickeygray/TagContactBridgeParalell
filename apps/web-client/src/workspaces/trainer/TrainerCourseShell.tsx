import {
  ArrowLeft,
  BookOpen,
  Headphones,
  LogOut,
  Sparkles,
} from "lucide-react";
import {
  Navigate,
  Route,
  Routes,
  useNavigate,
  useParams,
} from "react-router-dom";
import { Button } from "@/components/ui/Button";
import type { TrainingCourseRailItem } from "@/lib/api/trainingCourse";
import { TrainerAttemptResults } from "./TrainerAttemptResults";
import { TrainerCourseHome } from "./TrainerCourseHome";
import { TrainerCoursePlayer } from "./TrainerCoursePlayer";
import { useTrainingEnrollment } from "./hooks/useTrainingEnrollment";

interface TrainerCourseShellProps {
  basePath: "/trainer" | "/cx/coach";
  learnerLabel: string;
  onBack: () => void;
  onSignOut: () => void;
  onOpenPractice: () => void;
}

function CourseItemRoute({
  home,
  onOpenPractice,
  basePath,
}: {
  home: ReturnType<typeof useTrainingEnrollment>["home"];
  onOpenPractice: () => void;
  basePath: "/trainer" | "/cx/coach";
}) {
  const { courseId = "", itemId = "" } = useParams();
  if (!courseId || !itemId) return <Navigate to={basePath} replace />;
  return (
    <TrainerCoursePlayer
      basePath={basePath}
      courseId={courseId}
      itemId={itemId}
      home={home}
      onOpenPractice={onOpenPractice}
    />
  );
}

function AttemptResultsRoute({ basePath }: { basePath: "/trainer" | "/cx/coach" }) {
  const { attemptId = "" } = useParams();
  if (!attemptId) return <Navigate to={basePath} replace />;
  return <TrainerAttemptResults attemptId={attemptId} basePath={basePath} />;
}

export function TrainerCourseShell({
  basePath,
  learnerLabel,
  onBack,
  onSignOut,
  onOpenPractice,
}: TrainerCourseShellProps) {
  const navigate = useNavigate();
  const enrollment = useTrainingEnrollment();

  function openItem(courseId: string, item: TrainingCourseRailItem) {
    navigate(
      `${basePath}/course/${encodeURIComponent(courseId)}/item/${encodeURIComponent(item.itemId)}`,
    );
  }

  return (
    <div className="shell-gradient min-h-screen text-foreground">
      <header className="border-b border-border bg-card/80 backdrop-blur">
        <div className="mx-auto flex min-h-16 max-w-[1500px] flex-wrap items-center justify-between gap-3 px-6 py-3">
          <button
            type="button"
            onClick={() => navigate(basePath)}
            className="flex items-center gap-3 rounded-md text-left focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Sparkles className="h-5 w-5" />
            </span>
            <span>
              <span className="block text-sm font-semibold">Sales Trainer</span>
              <span className="block text-xs text-muted-foreground">{learnerLabel}</span>
            </span>
          </button>

          <nav aria-label="Trainer navigation" className="order-3 flex w-full gap-2 sm:order-none sm:w-auto">
            <Button size="sm" variant="secondary" onClick={() => navigate(basePath)}>
              <BookOpen className="h-4 w-4" />
              Course
            </Button>
            <Button size="sm" variant="secondary" onClick={onOpenPractice}>
              <Headphones className="h-4 w-4" />
              Free Call
            </Button>
          </nav>

          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={onBack}>
              <ArrowLeft className="h-3.5 w-3.5" />
              Back
            </Button>
            <Button variant="ghost" size="sm" onClick={onSignOut}>
              <LogOut className="h-3.5 w-3.5" />
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1500px] px-6 py-7">
        <Routes>
          <Route
            index
            element={
              <TrainerCourseHome
                status={enrollment.status}
                home={enrollment.home}
                error={enrollment.error}
                enrolling={enrollment.enrolling}
                onRetry={() => void enrollment.refresh()}
                onEnroll={() => void enrollment.enroll()}
                onOpenItem={openItem}
                onOpenPractice={onOpenPractice}
              />
            }
          />
          <Route
            path="course/:courseId/item/:itemId"
            element={
              <CourseItemRoute
                home={enrollment.home}
                basePath={basePath}
                onOpenPractice={onOpenPractice}
              />
            }
          />
          <Route
            path="attempt/:attemptId/results"
            element={<AttemptResultsRoute basePath={basePath} />}
          />
          <Route path="*" element={<Navigate to={basePath} replace />} />
        </Routes>
      </div>
    </div>
  );
}
