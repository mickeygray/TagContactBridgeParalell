import * as React from "react";
import { TOKEN_STORAGE_KEY } from "@/lib/api/client";
import { toast } from "@/components/ui/Toaster";

const POLL_INTERVAL_MS = 10_000;
const RELOAD_TOAST_ID = "parallel-runtime-reload";
const OFFLINE_TOAST_ID = "parallel-runtime-offline";

interface ClientRuntimeResponse {
  ok: true;
  runtime: {
    runtimeId?: string | null;
    startedAt?: string | null;
    service?: string | null;
  };
}

async function fetchClientRuntime(signal: AbortSignal) {
  const token = (() => {
    try {
      return window.localStorage.getItem(TOKEN_STORAGE_KEY);
    } catch {
      return null;
    }
  })();
  const response = await fetch("/api/client/runtime", {
    method: "GET",
    signal,
    headers: {
      Accept: "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (response.status === 401 || response.status === 403) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`runtime-check-${response.status}`);
  }
  const payload = (await response.json()) as ClientRuntimeResponse;
  return payload.runtime;
}

export function ClientRuntimeSentinel() {
  const initialRuntimeId = React.useRef<string | null>(null);
  const disconnected = React.useRef(false);
  const reloadNoticeShown = React.useRef(false);

  React.useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const scheduleNext = () => {
      if (stopped) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        void poll();
      }, POLL_INTERVAL_MS);
    };

    const showReloadNotice = (title: string, description: string) => {
      if (reloadNoticeShown.current) return;
      reloadNoticeShown.current = true;
      toast.warning(title, {
        id: RELOAD_TOAST_ID,
        description,
        duration: Infinity,
        action: {
          label: "Reload",
          onClick: () => window.location.reload(),
        },
      });
    };

    const poll = async () => {
      const controller = new AbortController();
      try {
        const runtime = await fetchClientRuntime(controller.signal);
        if (stopped) return;

        const runtimeId = runtime?.runtimeId || runtime?.startedAt || null;
        if (runtimeId && !initialRuntimeId.current) {
          initialRuntimeId.current = runtimeId;
        } else if (
          runtimeId
          && initialRuntimeId.current
          && runtimeId !== initialRuntimeId.current
        ) {
          showReloadNotice(
            "Parallel restarted",
            "Reload this tab so the page, session state, and live queues are all on the new server process.",
          );
        }

        if (disconnected.current && !reloadNoticeShown.current) {
          disconnected.current = false;
          toast.dismiss(OFFLINE_TOAST_ID);
          toast.warning("Server connection restored", {
            id: RELOAD_TOAST_ID,
            description:
              "The server came back after a connection gap. Reload if anything on the page looks stale.",
            duration: 20_000,
            action: {
              label: "Reload",
              onClick: () => window.location.reload(),
            },
          });
        }
      } catch (error) {
        if (stopped) return;
        if ((error as Error).name === "AbortError") return;
        if (!disconnected.current && !reloadNoticeShown.current) {
          disconnected.current = true;
          toast.warning("Server connection paused", {
            id: OFFLINE_TOAST_ID,
            description: "Trying to reconnect. If this follows a restart, reload when the server is back.",
            duration: Infinity,
          });
        }
      } finally {
        scheduleNext();
      }
    };

    const pollWhenVisible = () => {
      if (document.visibilityState === "visible") void poll();
    };

    window.addEventListener("online", pollWhenVisible);
    document.addEventListener("visibilitychange", pollWhenVisible);
    void poll();

    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      window.removeEventListener("online", pollWhenVisible);
      document.removeEventListener("visibilitychange", pollWhenVisible);
    };
  }, []);

  return null;
}
