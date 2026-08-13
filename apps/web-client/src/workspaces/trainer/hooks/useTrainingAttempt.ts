import { useCallback, useEffect, useRef, useState } from "react";
import {
  createTrainingRequestId,
  trainingCourseApi,
  type TrainingAnswerResult,
  type TrainingAttempt,
  type TrainingAttemptCompleteResult,
  type TrainingCourseItem,
} from "@/lib/api/trainingCourse";

type ItemLoadState = "loading" | "ready" | "error";
type AttemptAction = "starting" | "answering" | "completing" | null;

export function useTrainingAttempt(courseId: string, itemId: string) {
  const [status, setStatus] = useState<ItemLoadState>("loading");
  const [item, setItem] = useState<TrainingCourseItem | null>(null);
  const [attempt, setAttempt] = useState<TrainingAttempt | null>(null);
  const [lastAnswer, setLastAnswer] = useState<TrainingAnswerResult | null>(null);
  const [completion, setCompletion] =
    useState<TrainingAttemptCompleteResult | null>(null);
  const [action, setAction] = useState<AttemptAction>(null);
  const [error, setError] = useState("");
  const mountedRef = useRef(true);
  const startRequestIdRef = useRef<string | null>(null);
  const answerEventIdsRef = useRef<Map<string, string>>(new Map());
  const completeEventIdRef = useRef<string | null>(null);

  const loadItem = useCallback(
    async (signal?: AbortSignal) => {
      setStatus("loading");
      setError("");
      setAttempt(null);
      setLastAnswer(null);
      setCompletion(null);
      startRequestIdRef.current = null;
      answerEventIdsRef.current.clear();
      completeEventIdRef.current = null;
      try {
        const result = await trainingCourseApi.item(courseId, itemId, signal);
        if (!mountedRef.current || signal?.aborted) return;
        setItem(result.item);
        setStatus("ready");
      } catch (err) {
        if (!mountedRef.current || signal?.aborted) return;
        setItem(null);
        setError(
          err instanceof Error
            ? err.message
            : "This course item is not available.",
        );
        setStatus("error");
      }
    },
    [courseId, itemId],
  );

  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();
    void loadItem(controller.signal);
    return () => {
      mountedRef.current = false;
      controller.abort();
    };
  }, [loadItem]);

  const start = useCallback(async () => {
    if (!item || action) return null;
    setAction("starting");
    setError("");
    try {
      const result = await trainingCourseApi.startAttempt({
        itemId: item.itemId,
        requestId:
          startRequestIdRef.current ||
          (startRequestIdRef.current = createTrainingRequestId("attempt")),
      });
      if (mountedRef.current) {
        startRequestIdRef.current = null;
        setAttempt(result.attempt);
      }
      return result.attempt;
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : "Could not start this item.");
      }
      return null;
    } finally {
      if (mountedRef.current) setAction(null);
    }
  }, [action, courseId, item, itemId]);

  const answer = useCallback(
    async (value: string) => {
      if (!attempt || action) return null;
      setAction("answering");
      setError("");
      const outboundAnswer = value.trim();
      const eventKey = outboundAnswer;
      const eventId =
        answerEventIdsRef.current.get(eventKey) ||
        createTrainingRequestId("answer");
      answerEventIdsRef.current.set(eventKey, eventId);
      try {
        const result = await trainingCourseApi.answer(attempt.attemptId, {
          answer: outboundAnswer,
          eventId,
          expectedVersion: attempt.version,
        });
        if (mountedRef.current) {
          answerEventIdsRef.current.delete(eventKey);
          setLastAnswer(result);
          setAttempt((current) =>
            current ? { ...current, version: result.version } : current,
          );
        }
        return result;
      } catch (err) {
        if (mountedRef.current) {
          setError(
            err instanceof Error ? err.message : "Could not submit your answer.",
          );
        }
        return null;
      } finally {
        if (mountedRef.current) setAction(null);
      }
    },
    [action, attempt],
  );

  const complete = useCallback(async () => {
    if (!attempt || action) return null;
    setAction("completing");
    setError("");
    const eventId =
      completeEventIdRef.current ||
      (completeEventIdRef.current = createTrainingRequestId("complete"));
    try {
      const result = await trainingCourseApi.complete(attempt.attemptId, {
        eventId,
        expectedVersion: attempt.version,
      });
      if (mountedRef.current) {
        setCompletion(result);
        setAttempt((current) =>
          current
            ? { ...current, version: result.version, status: "completed" }
            : current,
        );
      }
      return result;
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : "Could not complete this item.");
      }
      return null;
    } finally {
      if (mountedRef.current) setAction(null);
    }
  }, [action, attempt]);

  const clearLastAnswer = useCallback(() => setLastAnswer(null), []);
  const syncAttempt = useCallback((nextAttempt: TrainingAttempt) => {
    if (mountedRef.current) setAttempt(nextAttempt);
  }, []);

  return {
    status,
    item,
    attempt,
    lastAnswer,
    completion,
    action,
    error,
    loadItem,
    start,
    answer,
    complete,
    syncAttempt,
    clearLastAnswer,
  };
}
