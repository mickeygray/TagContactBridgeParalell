import { useEffect, useState } from "react";

import {
  isLiveCoachTerminal,
  streamLiveCoachEventsWithRetry,
  type LiveCoachCockpitState,
  type LiveCoachDialog,
  type LiveCoachEvent,
  type LiveCoachRollingSummary,
  type LiveCoachSession,
} from "@/lib/liveCoach/stream";

export type CockpitConnection = "idle" | "connecting" | "open" | "reconnecting" | "error";

export type CoachCockpitSnapshot = {
  session: LiveCoachSession | null;
  cockpit: LiveCoachCockpitState | null;
  dialog: LiveCoachDialog | null;
  rollingSummary: LiveCoachRollingSummary | null;
  connection: CockpitConnection;
  error: string | null;
  terminal: boolean;
};

const EMPTY: CoachCockpitSnapshot = {
  session: null,
  cockpit: null,
  dialog: null,
  rollingSummary: null,
  connection: "idle",
  error: null,
  terminal: false,
};

// Fold a full session snapshot into the cockpit view. The snapshot ships latest.* whole, so
// (re)connects/late-joins repaint the cockpit/dialog/rolling-summary without replaying events.
function applySnapshot(prev: CoachCockpitSnapshot, session: LiveCoachSession): CoachCockpitSnapshot {
  const latest = session.latest || {};
  return {
    ...prev,
    session,
    cockpit: latest.cockpit ?? prev.cockpit,
    dialog: latest.dialog ?? prev.dialog,
    rollingSummary: latest.rollingSummary ?? session.memory?.rollingSummary ?? prev.rollingSummary,
    terminal: isLiveCoachTerminal(session.status),
  };
}

// The call-ended events. They do NOT carry a full session (just {reason}/{status}/etc.), so
// `terminal` must be flipped on the event TYPE, not by re-reading session.status.
const TERMINAL_EVENT_TYPES = new Set(["session.stop", "session.stale", "session.pruned", "voicemail.reject"]);

// Fold one live event. coach.cockpit -> cockpit, coach.summary -> rollingSummary, dialog -> dialog.
// A payload carrying a full `session` re-seeds (snapshot-on-connect).
function applyEvent(prev: CoachCockpitSnapshot, payload: LiveCoachEvent): CoachCockpitSnapshot {
  let next = prev;
  if (payload.session) next = applySnapshot(next, payload.session);
  if (payload.cockpit) next = { ...next, cockpit: payload.cockpit };
  if (payload.dialog) next = { ...next, dialog: payload.dialog };
  if (payload.rollingSummary) next = { ...next, rollingSummary: payload.rollingSummary };
  // Call ended: flip terminal and CLEAR the live guidance so stale say/react-now lines for a
  // dead call don't keep showing (the snapshot path never fires these — see set above).
  if (payload.type && TERMINAL_EVENT_TYPES.has(payload.type)) {
    next = { ...next, terminal: true, dialog: null, cockpit: null };
  }
  return next;
}

/**
 * Stream ONE coach session and maintain the cockpit-focused slice of its state. Reuses the
 * reconnecting SSE consumer + the snapshot-seeding contract the wallboard/legacy panel use.
 * Aborts on unmount or sessionId change. Pure rendering downstream — this owns no business logic.
 */
export function useCoachCockpit(sessionId: string | null | undefined): CoachCockpitSnapshot {
  const [state, setState] = useState<CoachCockpitSnapshot>(EMPTY);

  useEffect(() => {
    if (!sessionId) {
      setState(EMPTY);
      return undefined;
    }
    const controller = new AbortController();
    setState({ ...EMPTY, connection: "connecting" });

    void streamLiveCoachEventsWithRetry(
      `/api/ai/live-coach/sessions/${encodeURIComponent(sessionId)}/events`,
      {
        signal: controller.signal,
        onOpen: () => setState((s) => ({ ...s, connection: "open", error: null })),
        onEvent: (_eventName, payload) => setState((s) => applyEvent(s, payload)),
        onError: (err) =>
          setState((s) =>
            err.message === "Reconnecting..."
              ? { ...s, connection: "reconnecting", error: null }
              : { ...s, connection: "error", error: err.message },
          ),
      },
    ).catch(() => undefined);

    return () => controller.abort();
  }, [sessionId]);

  return state;
}
