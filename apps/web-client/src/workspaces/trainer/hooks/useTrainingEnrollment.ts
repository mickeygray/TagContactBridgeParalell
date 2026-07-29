import { useCallback, useEffect, useRef, useState } from "react";
import {
  createTrainingRequestId,
  trainingCourseApi,
  type TrainingCourseHome,
} from "@/lib/api/trainingCourse";

type EnrollmentLoadState = "loading" | "ready" | "error";

export function useTrainingEnrollment(courseAlias?: string) {
  const [status, setStatus] = useState<EnrollmentLoadState>("loading");
  const [home, setHome] = useState<TrainingCourseHome | null>(null);
  const [error, setError] = useState("");
  const [enrolling, setEnrolling] = useState(false);
  const mountedRef = useRef(true);
  const enrollRequestIdRef = useRef<string | null>(null);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      setStatus("loading");
      setError("");
      try {
        const next = await trainingCourseApi.home(courseAlias, signal);
        if (!mountedRef.current || signal?.aborted) return;
        setHome(next);
        setStatus("ready");
      } catch (err) {
        if (!mountedRef.current || signal?.aborted) return;
        setHome(null);
        setError(err instanceof Error ? err.message : "Could not load the course.");
        setStatus("error");
      }
    },
    [courseAlias],
  );

  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => {
      mountedRef.current = false;
      controller.abort();
    };
  }, [refresh]);

  const enroll = useCallback(async () => {
    if (enrolling) return;
    setEnrolling(true);
    setError("");
    try {
      await trainingCourseApi.enroll({
        courseAlias,
        requestId:
          enrollRequestIdRef.current ||
          (enrollRequestIdRef.current = createTrainingRequestId("enroll")),
      });
      enrollRequestIdRef.current = null;
      if (mountedRef.current) await refresh();
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : "Could not start the course.");
      setStatus(home ? "ready" : "error");
    } finally {
      if (mountedRef.current) setEnrolling(false);
    }
  }, [courseAlias, enrolling, home, refresh]);

  return {
    status,
    home,
    error,
    enrolling,
    refresh,
    enroll,
  };
}
