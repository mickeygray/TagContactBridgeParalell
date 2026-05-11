import * as React from "react";
import { api, ApiError } from "@/lib/api/client";
import type { WorkflowRecord } from "@/lib/api/types";
import { isImportantWorkflowRecord } from "@/lib/events/presentation";

type WorkflowEnvelope = {
  ok: true;
  records: WorkflowRecord[];
};

type WorkflowEventReaderOptions = {
  domain: string;
  families?: string[];
  limit?: number;
  pollMs?: number;
  maxEntries?: number;
};

function recordKey(record: WorkflowRecord) {
  return (
    record._id ??
    [
      record.family ?? "workflow",
      record.subtype ?? "none",
      record.stage ?? "stage",
      record.aggregateType ?? "aggregate",
      record.aggregateId ?? "id",
      record.happenedAt ?? record.createdAt ?? "time",
    ].join(":")
  );
}

function recordTime(record: WorkflowRecord) {
  return record.happenedAt ?? record.createdAt ?? "";
}

function sortRecords(records: WorkflowRecord[]) {
  return [...records].sort((left, right) => recordTime(right).localeCompare(recordTime(left)));
}

export function useWorkflowEventReader({
  domain,
  families = [],
  limit = 40,
  pollMs = 5_000,
  maxEntries = 80,
}: WorkflowEventReaderOptions) {
  const [events, setEvents] = React.useState<WorkflowRecord[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [lastSeenAt, setLastSeenAt] = React.useState<string | null>(null);
  const [newCount, setNewCount] = React.useState(0);
  const seenKeysRef = React.useRef(new Set<string>());
  const initializedRef = React.useRef(false);

  const runPoll = React.useEffectEvent(async () => {
    if (!domain) return;
    try {
      const response = await api.get<WorkflowEnvelope>("/api/workflows", {
        query: {
          domain,
          limit,
        },
      });

      const filtered = sortRecords(
        (response.records ?? []).filter((record) => {
          if (families.length === 0) return true;
          return families.includes(record.family ?? "");
        }).filter(isImportantWorkflowRecord),
      );

      if (!initializedRef.current) {
        seenKeysRef.current = new Set(filtered.map(recordKey));
        setEvents(filtered.slice(0, maxEntries));
        setNewCount(0);
        initializedRef.current = true;
      } else {
        const fresh = filtered.filter((record) => !seenKeysRef.current.has(recordKey(record)));
        for (const record of filtered) {
          seenKeysRef.current.add(recordKey(record));
        }

        if (fresh.length > 0) {
          const normalizedFresh = sortRecords(fresh);
          setEvents((current) =>
            sortRecords([...normalizedFresh, ...current]).filter(
              (record, index, source) =>
                source.findIndex((candidate) => recordKey(candidate) === recordKey(record)) === index,
            ).slice(0, maxEntries),
          );
          setNewCount((current) => current + normalizedFresh.length);
        }
      }

      setLastSeenAt(new Date().toISOString());
      setError(null);
    } catch (nextError) {
      setError(
        nextError instanceof ApiError
          ? nextError
          : new ApiError("Unable to read workflow events", 0, "workflow_event_reader_error", nextError),
      );
    } finally {
      setIsLoading(false);
    }
  });

  React.useEffect(() => {
    seenKeysRef.current = new Set();
    initializedRef.current = false;
    setEvents([]);
    setIsLoading(true);
    setError(null);
    setNewCount(0);
    setLastSeenAt(null);
  }, [domain, families, limit, maxEntries]);

  React.useEffect(() => {
    if (!domain) return undefined;
    void runPoll();
    const timer = window.setInterval(() => {
      void runPoll();
    }, pollMs);
    return () => window.clearInterval(timer);
  }, [domain, pollMs, runPoll]);

  const markAllRead = React.useCallback(() => setNewCount(0), []);

  return {
    events,
    isLoading,
    error,
    lastSeenAt,
    newCount,
    markAllRead,
    refetch: runPoll,
  };
}
