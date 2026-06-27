import { useState } from "react";
import { useSearchParams } from "react-router-dom";

import { Button } from "@/components/ui/Button";
import { CoachCockpit } from "./CoachCockpit";

// Per-session Focus Card cockpit (the agent-on-call view). Reads ?session=<id> from the URL
// and streams that session. To develop against live-shaped data with NO model spend, boot the
// ai-bus with LIVE_COACH_RUNTIME_MODE_BATCH_ENABLED=1 LIVE_COACH_BATCH_TRANSPORT=stub and open
// an active session here. Later this mounts inline in the CX call workspace / wallboard drill-in.
export function CoachCockpitWorkspace() {
  const [params, setParams] = useSearchParams();
  const sessionId = params.get("session");
  const [draft, setDraft] = useState("");

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 p-4">
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const next = draft.trim();
          if (next) setParams({ session: next });
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={sessionId || "session id"}
          className="h-9 flex-1 rounded-md border border-border bg-background px-3 text-sm outline-none focus:border-sky-400"
        />
        <Button type="submit" disabled={!draft.trim()}>
          Open
        </Button>
        {sessionId ? (
          <Button type="button" variant="ghost" onClick={() => setParams({})}>
            Clear
          </Button>
        ) : null}
      </form>

      <CoachCockpit sessionId={sessionId} />
    </div>
  );
}
