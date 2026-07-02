# CX Bulk-Load — Ready-to-Insert Code Blocks (2026-07-02, Fable)

Draft implementations for the next work orders, written OUT of the codebase for review-then-
paste. Each block names its insertion target, its contract, and the test that pins it. These
encode the rulings already made (one-screen law, modal layer, three-way routing, correction
lane, two-tick debounce) so the executor/big-guns passes start from working shapes instead of
blank files. Field names marked `⚠ verify` must be checked against the live session doc before
paste.

> **TRUNK AMENDMENT (2026-07-02 evening — governs all blocks below):** call end ≠ outcome for
> a CONNECTED call. The watcher holds the lead in a WRAP state (no auto-write, no clear); the
> projection gains `lead.mode: "wrap"` with buttons ENABLED and status "Call ended — enter the
> outcome for <name>"; the click is a NORMAL disposition (route 1 in BLOCK B), not a
> correction. **BLOCK F (wrap-up modal) is RETIRED before it was built** — the wrap state on
> the base screen replaces it; M2/M3 stand. BLOCK C demotes to the safety net (wrap-timeout
> defaults, never-connected mislabels, late fixes). Wrap timeout: `CX_BULK_WRAP_TIMEOUT_MS`
> default 180000 → `did_not_connect` w/ `source:"wrap-timeout"`. Full ruling: THE TRUNK RULING
> in the work-orders doc. Projection test gains the trunk rows: connected release → wrap mode +
> buttons enabled + NO modal; wrap disposition → route "current"; timeout expiry → ghost +
> correction still available.

---

## BLOCK A — `bulkLoadProjection.ts` (WO-16 core; new file
`apps/web-client/src/workspaces/cx/bulkLoadProjection.ts`)

The one-screen law as one pure function. No React, no fetch, no Date.now — everything injected,
so the table test enumerates every state.

```ts
// The one-screen projector: (session, extras) -> exactly what renders.
// Fixed layout law: the lead slot is NEVER empty while a session runs; the SAME
// button row always renders and its meaning is decided by identity, not by mode;
// one status sentence; modals are a closed inventory (M1 wrap-up, M2 new-lead).

export type BulkLeadView = {
  queueItemId: string;
  caseId: number | null;
  name: string;
  domain: string | null;
  uii: string | null;
};

export type BulkProjection = {
  lead: { view: BulkLeadView | null; mode: "live" | "ghost" | "idle" };
  buttons: {
    enabled: boolean;
    // identity the click will carry (WO-17 payload); server decides terminal vs correction
    queueItemId: string | null;
    uii: string | null;
  };
  statusLine: string;
  modal:
    | null
    | { kind: "wrap-up"; lead: BulkLeadView; outcomeRecorded: string }
    | { kind: "new-lead"; name: string; provenance: string };
};

type SessionLike = {
  status?: string | null;
  current?: any;
  acceptedBuffer?: any[];
  lastOutcome?: {
    queueItemId?: string;
    uii?: string | null;
    outcome?: string;
    source?: string;        // "active-call-release" = auto-released (the Joe case)
    connected?: boolean;    // ⚠ verify WO-31 step 3 supplies this (uii + ACTIVE seen)
    manual?: boolean;       // true when the outcome came from a manual click
    name?: string;          // ⚠ verify: lead display fields survive on lastOutcome
    caseId?: number | null;
    domain?: string | null;
    at?: string;
  } | null;
  unownedActiveCall?: { name?: string; provenance?: string; servedToAgent?: boolean } | null; // WO-31 3b
};

function leadView(src: any): BulkLeadView | null {
  if (!src || !src.queueItemId) return null;
  return {
    queueItemId: String(src.queueItemId),
    caseId: src.caseId ?? null,
    name: String(src.name || "Lead"),
    domain: src.domain ?? null,
    uii: src.uii ?? null,
  };
}

export function projectBulkScreen(
  session: SessionLike | null,
  opts: { wrapUpAckKey?: string | null; newLeadAckKey?: string | null } = {},
): BulkProjection {
  const idle: BulkProjection = {
    lead: { view: null, mode: "idle" },
    buttons: { enabled: false, queueItemId: null, uii: null },
    statusLine: "No session running.",
    modal: null,
  };
  if (!session || session.status !== "running") return idle;

  const current = leadView(session.current);
  const last = session.lastOutcome || null;
  const ghost = leadView(last);
  const unowned = session.unownedActiveCall || null;

  // M2 — a brand-new lead from another queue is being served to this agent.
  const newLeadModal =
    unowned && unowned.servedToAgent && opts.newLeadAckKey !== (unowned.name || "") + ":" + (unowned.provenance || "")
      ? { kind: "new-lead" as const, name: unowned.name || "Unknown", provenance: unowned.provenance || "other queue" }
      : null;

  // LIVE: a proven current call. Buttons target it; server routes to terminal.
  if (current && current.uii) {
    return {
      lead: { view: current, mode: "live" },
      buttons: { enabled: true, queueItemId: current.queueItemId, uii: current.uii },
      statusLine: unowned && !unowned.servedToAgent
        ? "This call isn't from your list."
        : `On call with ${current.name}.`,
      modal: newLeadModal,
    };
  }

  // GHOST: between calls — last lead greyed, SAME buttons target its identity;
  // the server's three-way routing turns those clicks into corrections (WO-17/31).
  if (ghost) {
    const released = last?.source === "active-call-release";
    // M1 fires ONLY for a CONNECTED auto-release without a manual terminal —
    // the anti-badger guard. Never-connected drops stay on the status line.
    const wrapUp =
      released && last?.connected === true && last?.manual !== true &&
      opts.wrapUpAckKey !== ghost.queueItemId + ":" + (ghost.uii || "")
        ? { kind: "wrap-up" as const, lead: ghost, outcomeRecorded: String(last?.outcome || "did_not_connect") }
        : null;
    return {
      lead: { view: ghost, mode: "ghost" },
      buttons: { enabled: released, queueItemId: ghost.queueItemId, uii: ghost.uii },
      statusLine: released
        ? `Call ended — you can still mark ${ghost.name}.`
        : (session.acceptedBuffer || []).length > 0
          ? "Dialing the next lead…"
          : "Waiting for leads.",
      modal: wrapUp || newLeadModal,
    };
  }

  // Fresh session, nothing dialed yet.
  return {
    lead: { view: null, mode: "idle" },
    buttons: { enabled: false, queueItemId: null, uii: null },
    statusLine: (session.acceptedBuffer || []).length > 0 ? "Dialing the next lead…" : "Waiting for leads.",
    modal: newLeadModal,
  };
}
```

**Pin (first web-client test — `apps/web-client/src/workspaces/cx/bulkLoadProjection.test.ts`,
or mirror into tests/cx-bulk-load as .js if the web workspace has no runner yet ⚠ verify):**

```ts
import { describe, it, expect } from "vitest"; // ⚠ verify runner; table works in node:test too
import { projectBulkScreen } from "./bulkLoadProjection";

const lead = { queueItemId: "q1", caseId: 1, name: "Joe", domain: "WYNN", uii: "u1" };

const CASES: Array<[string, Parameters<typeof projectBulkScreen>, Partial<ReturnType<typeof projectBulkScreen>>]> = [
  ["no session -> idle", [null, {}], { statusLine: "No session running." }],
  ["live call -> live lead + enabled buttons", [{ status: "running", current: lead }, {}],
    { lead: { view: lead, mode: "live" }, buttons: { enabled: true, queueItemId: "q1", uii: "u1" } }],
  ["Joe: connected auto-release -> ghost + buttons + M1", [
    { status: "running", current: null, acceptedBuffer: [{}],
      lastOutcome: { ...lead, outcome: "did_not_connect", source: "active-call-release", connected: true } }, {}],
    { lead: { view: { ...lead }, mode: "ghost" }, buttons: { enabled: true, queueItemId: "q1", uii: "u1" } }],
  ["never-connected drop -> NO modal (anti-badger)", [
    { status: "running", lastOutcome: { ...lead, source: "active-call-release", connected: false } }, {}],
    { modal: null }],
  ["manual outcome -> no correction buttons, no modal", [
    { status: "running", lastOutcome: { ...lead, source: "manual", manual: true, connected: true } }, {}],
    { modal: null, buttons: { enabled: false, queueItemId: "q1", uii: "u1" } }],
  ["M1 acked -> modal cleared, ghost stays", [
    { status: "running", lastOutcome: { ...lead, source: "active-call-release", connected: true } },
    { wrapUpAckKey: "q1:u1" }],
    { modal: null }],
  ["Jennie: unowned call during live -> status line, no adoption", [
    { status: "running", current: lead, unownedActiveCall: { name: "Jennie", servedToAgent: false } }, {}],
    { statusLine: "This call isn't from your list." }],
  ["M2: unowned served to agent -> new-lead modal", [
    { status: "running", unownedActiveCall: { name: "Jennie", provenance: "fresh", servedToAgent: true } }, {}],
    { modal: { kind: "new-lead", name: "Jennie", provenance: "fresh" } }],
];

describe("bulkLoadProjection table", () => {
  for (const [name, args, want] of CASES) {
    it(name, () => expect(projectBulkScreen(...args)).toMatchObject(want));
  }
});
```

---

## BLOCK B — WO-17 three-way disposition routing (insert in
`cxBulkLoadRuntimeService.js`, top of the disposition command before the current-only logic)

```js
// WO-17: the click carries the DISPLAYED lead's identity; the server decides meaning.
// current-match -> terminal (today's path) · lastOutcome-match -> correction lane (WO-31)
// · neither -> stale-click no-op (sub-second race, silent for the agent, logged here).
function classifyDispositionTarget(state, input = {}) {
  const qid = str(input.queueItemId);
  const uii = str(input.uii);
  if (!qid && !uii) return { route: "current", legacy: true }; // old client mid-deploy: accept, log deprecation
  const cur = state.current || {};
  if (qid && str(queueItemKey(cur)) === qid && (!uii || str(cur.uii) === uii)) {
    return { route: "current" };
  }
  const last = state.lastOutcome || {};
  if (qid && str(last.queueItemId) === qid && (!uii || str(last.uii || "") === uii)) {
    return { route: "correction", target: last };
  }
  return { route: "stale" };
}
```

And in the disposition handler:

```js
const target = classifyDispositionTarget(state, input);
if (target.legacy) log?.warn?.("cx.bulk.disposition.identity_missing", { sessionId: state.sessionId });
if (target.route === "stale") {
  traceBulkFlow?.("disposition.stale_click", state, { queueItemId: str(input.queueItemId) });
  return { ...sanitizeSession(state), dispositionOk: false, code: "stale-click" };
}
if (target.route === "correction") {
  return submitCxBulkLoadReviewOutcome({          // ⚠ verify: reuse the existing review-outcome
    sessionId: state.sessionId,                   // command as the correction entry point,
    outcome: input.disposition,                   // extended per BLOCK C
    queueItemId: target.target.queueItemId,
    uii: target.target.uii || null,
  });
}
// fall through to today's terminal path
```

**Pin:** three tests — current-match writes a terminal outcome; lastOutcome-match writes a
`review-correction` row and NO terminal outcome and leaves `current` untouched; neither-match
returns `{ dispositionOk:false, code:"stale-click" }` with zero writes. Plus the legacy
identity-less back-compat case.

---

## BLOCK C — WO-31 correction row (extend `cxBulkLoadOutcomeAdapter.js` beside
`buildReviewCorrectionRow`)

```js
// WO-31: corrections are LABEL + COMPLIANCE + FORWARD-SCHEDULING — never cadence rewinds.
// A correction is its OWN outbox row with its own idemKey lane; the original terminal row
// is never mutated (#4 design). kinds: voicemail | dnc | schedule{kind, at}.
const CORRECTION_KINDS = new Set(["voicemail", "dnc", "schedule"]);

function buildCorrectionRow({ sessionId, queueItemId, uii = null, correction = {}, at = new Date() } = {}) {
  const kind = str(correction.kind || correction.outcome);
  if (!CORRECTION_KINDS.has(kind)) return null;
  if (!str(queueItemId)) return null;
  return {
    eventType: "review-correction",
    sessionId: str(sessionId) || null,
    queueItemId: str(queueItemId),
    uii: str(uii) || null,
    outcome: kind,
    schedule: kind === "schedule"
      ? { kind: str(correction.schedule?.kind) || "callback", at: correction.schedule?.at || null }
      : null,
    // own idemKey lane — cannot collide with the original terminal row or another kind
    idemKey: `review-corr:${kind}:${str(queueItemId)}:${str(uii) || "no-uii"}`,
    sourceService: "cx-bulk-load",
    recordedAt: at,
  };
}
```

Drain side (inside the existing drain row handler, new branch BEFORE the terminal branch):

```js
if (row.eventType === "review-correction") {
  // label + compliance only: update the recorded outcome surface; DNC stays absorbing;
  // schedule routes through the EXISTING appointment/callback machinery keyed to the
  // released lead — no cadence re-step of the original outcome.
  if (row.outcome === "dnc") return applyDncCorrection(row);            // existing review-dnc path ⚠ verify name
  if (row.outcome === "voicemail") return applyOutcomeLabelCorrection(row, "voicemail"); // new, label-only
  if (row.outcome === "schedule") return applyRetroSchedule(row);       // wraps existing appointment path
}
```

**Pin:** voicemail correction lands with its own idemKey (no collision with the original
`did_not_connect` row or a dnc row for the same call); double-submit dedups via insertOnce;
correction targeting anything but the session's LAST released identity is rejected
`stale-correction` (enforced in WO-17's router by construction); drain applies label-only.

---

## BLOCK D — WO-10 two-tick release debounce (pure layer,
`cxBulkLoadActiveCallWatcher.js`, `deriveCurrentRelease` + the buffered twin)

```js
// WO-10: ONE empty/partial poll must not kill a live call. Release requires the extern
// to be absent in TWO consecutive polls. The marker lives in watcher memory (prev tick
// state), NEVER on the session doc.
function deriveCurrentRelease({ current = null, prevActiveCalls = [], activeCalls = [], releaseMarks = new Map() } = {}) {
  if (!current) return null;
  const ext = candidateExternId(current);
  if (!ext) return null;
  const nowActive = new Set((activeCalls || []).map((c) => normalizeActiveCall(c).externId).filter(Boolean));
  if (nowActive.has(ext)) { releaseMarks.delete(ext); return null; }  // reappeared -> clear mark
  if (!releaseMarks.has(ext)) { releaseMarks.set(ext, 1); return null; } // first miss -> mark, hold
  releaseMarks.delete(ext);
  // second consecutive miss -> the existing release logic proceeds unchanged below
  /* ...original prev-proof / releaseFromCurrentProof logic... */
}
```

**Pin (REWRITES the test at `cxAccountActiveCallWatcherService.test.js:125` that locks the old
1-tick behavior):** first miss-tick → no release + mark set; second consecutive miss → release;
miss-then-reappear → mark cleared, call still current. The service tick passes one
`releaseMarks` Map per account, held between ticks alongside `prevActiveCalls`.

---

## Sequencing check (on target, 2026-07-02)

Executor lane next: WO-4 (dead-code, bullet-by-bullet) · WO-6 (cadence guard) · WO-9 (inspect
script) — none blocked. Then WO-5/7/8, then Phase B where BLOCK D lands (WO-10). BLOCKs B+C
land with Phase C (WO-17/31, executor) — paste-and-pin from here. BLOCK A is mine (WO-16) after
WO-14/15 shrink the workspace file; the table test above becomes the repo's first web-client
test either way. Today's live run feeds: the Joe reproduction validates BLOCK A's M1 guard
inputs (`connected`, `source`) — if the session doc can't distinguish connected-vs-ringing at
release time, that's the ⚠ to resolve in WO-31 step 3 before BLOCK A pastes.

---

## BLOCK E — The button row (WO-16; new file
`apps/web-client/src/workspaces/cx/BulkButtonRow.tsx`)

The SAME four buttons, always rendered, always in the same order. They never know whether
they're terminal or correction — the identity payload decides that server-side (BLOCK B). One
in-flight guard, no toasts, no per-mode branching.

```tsx
import * as React from "react";
import { Button } from "@/components/ui/Button";
import type { BulkProjection } from "./bulkLoadProjection";

// Fixed inventory. "schedule" opens the appointment wrap (M3) for a LIVE call,
// or fires a schedule correction for a ghost (server routes it — same click shape).
const BUTTONS = [
  { key: "no_answer", label: "No Answer" },
  { key: "voicemail", label: "Voicemail" },
  { key: "dnc", label: "DNC" },
  { key: "schedule", label: "Schedule" },
] as const;

export function BulkButtonRow({
  projection,
  onDisposition, // (payload: {disposition, queueItemId, uii}) => Promise<unknown>
  onSchedule, // ({queueItemId, uii, mode: "live"|"ghost"}) => void  (opens M3 / picker)
}: {
  projection: BulkProjection;
  onDisposition: (p: { disposition: string; queueItemId: string; uii: string | null }) => Promise<unknown>;
  onSchedule: (p: { queueItemId: string; uii: string | null; mode: "live" | "ghost" }) => void;
}) {
  const [inFlight, setInFlight] = React.useState<string | null>(null);
  const { enabled, queueItemId, uii } = projection.buttons;
  const mode = projection.lead.mode;

  async function click(key: string) {
    if (!enabled || !queueItemId || inFlight) return;
    if (key === "schedule") return onSchedule({ queueItemId, uii, mode: mode === "live" ? "live" : "ghost" });
    setInFlight(key);
    try {
      await onDisposition({ disposition: key, queueItemId, uii });
    } finally {
      setInFlight(null); // a stale-click comes back dispositionOk:false — the poll moves the screen, we do nothing
    }
  }

  return (
    <div className="flex items-center gap-2">
      {BUTTONS.map((b) => (
        <Button
          key={b.key}
          size="sm"
          variant={mode === "ghost" ? "outline" : "default"} // greyed lead = outline row; same buttons
          disabled={!enabled || !queueItemId || Boolean(inFlight)}
          onClick={() => click(b.key)}
        >
          {inFlight === b.key ? "…" : b.label}
        </Button>
      ))}
    </div>
  );
}
```

**Pin:** rides the projection table test (enabled/identity per state) + one interaction test:
double-click fires ONE request; a `dispositionOk:false, code:"stale-click"` response produces
no toast and no state write (the next poll owns the screen).

---

## BLOCK F — Wrap-up modal, M1 (WO-16; new file
`apps/web-client/src/workspaces/cx/BulkWrapUpModal.tsx`)

Fires only when the projection says so (connected auto-release, un-acked). Uses the SAME
disposition mutation with the ghost identity — the server's router makes it a correction. Keep
= ack only, writes nothing. Schedule offers three presets, not a datetime widget — the
one-screen law applies to modals too.

```tsx
import * as React from "react";
import { Button } from "@/components/ui/Button";
import type { BulkProjection } from "./bulkLoadProjection";

const SCHEDULE_PRESETS = [
  { key: "2h", label: "In 2 hours", offsetMs: 2 * 3600_000 },
  { key: "am", label: "Tomorrow AM", offsetMs: null }, // server resolves 9:00 local next day
  { key: "2d", label: "In 2 days", offsetMs: 2 * 86_400_000 },
] as const;

export function BulkWrapUpModal({
  modal, onDisposition, onAck, now = () => new Date(),
}: {
  modal: Extract<NonNullable<BulkProjection["modal"]>, { kind: "wrap-up" }>;
  onDisposition: (p: {
    disposition: string; queueItemId: string; uii: string | null;
    schedule?: { kind: string; at: string | null };
  }) => Promise<unknown>;
  onAck: () => void; // stamps wrapUpAckKey = `${queueItemId}:${uii}` in the ONE ui state atom
  now?: () => Date;
}) {
  const lead = modal.lead;
  const [scheduling, setScheduling] = React.useState(false);
  async function act(disposition: string, schedule?: { kind: string; at: string | null }) {
    await onDisposition({ disposition, queueItemId: lead.queueItemId, uii: lead.uii, schedule });
    onAck();
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div className="w-96 rounded-lg border border-border bg-card p-5 shadow-lg">
        <div className="text-sm font-semibold">{lead.name} — call ended</div>
        <p className="mt-1 text-sm text-muted-foreground">
          Recorded as “{modal.outcomeRecorded}”. Change it?
        </p>
        {!scheduling ? (
          <div className="mt-4 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => act("voicemail")}>Voicemail</Button>
            <Button size="sm" variant="destructive" onClick={() => act("dnc")}>DNC</Button>
            <Button size="sm" variant="outline" onClick={() => setScheduling(true)}>Schedule</Button>
            <Button size="sm" variant="ghost" onClick={onAck}>Keep</Button>
          </div>
        ) : (
          <div className="mt-4 flex flex-wrap gap-2">
            {SCHEDULE_PRESETS.map((p) => (
              <Button
                key={p.key}
                size="sm"
                onClick={() =>
                  act("schedule", {
                    kind: "callback",
                    at: p.offsetMs ? new Date(now().getTime() + p.offsetMs).toISOString() : null,
                  })
                }
              >
                {p.label}
              </Button>
            ))}
            <Button size="sm" variant="ghost" onClick={() => setScheduling(false)}>Back</Button>
          </div>
        )}
      </div>
    </div>
  );
}
```

**Pin:** modal renders only for the wrap-up projection state; every action path calls
disposition exactly once THEN acks; Keep acks with zero requests; the ack key kills re-render
(the projection table test already covers ack behavior).

---

## BLOCK G — Poller → coach connectivity (new file
`packages/shared-services/src/cxCoachBridge.js`)

"The one connection to make" from the coach plan: the account watcher already knows the exact
moment a call becomes real and the moment it dies — the coach should inherit that truth instead
of discovering calls through its own matching.

```js
"use strict";

// CX bulk -> live-coach bridge. Fire-and-forget, fail-soft, default-off.
// current PROVEN (uii attached) -> notify bind; current CLEARED -> notify eject
// so guidance never bleeds into the next call. Never blocks or throws into the
// call loop; 1.5s timeout; errors are one warn, never a retry storm.
//
// Env: CX_COACH_BRIDGE_ENABLED=true arms it. CX_COACH_BRIDGE_URL defaults to the
// local ai-bus. Uses the internal service secret like every 5001->7000 call.

const DEFAULT_URL = "http://127.0.0.1:7000";

function createCxCoachBridge({
  enabled = String(process.env.CX_COACH_BRIDGE_ENABLED || "false") === "true",
  baseUrl = process.env.CX_COACH_BRIDGE_URL || DEFAULT_URL,
  secret = process.env.INTERNAL_SERVICE_SECRET || "",
  fetchImpl = fetch,
  logger = console,
  timeoutMs = 1500,
} = {}) {
  async function post(path, body) {
    if (!enabled) return { ok: false, skipped: "disabled" };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-service-secret": secret },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      return { ok: res.ok, status: res.status };
    } catch (error) {
      logger?.warn?.("cx.coach_bridge.post_failed", { path, error: error?.message });
      return { ok: false, error: error?.message };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    // Call from the watcher at the moment markCandidateServing succeeds.
    async currentProven({ session = {}, current = {} } = {}) {
      return post("/api/ai/live-coach/grpc/mongo/bind/latest", { // ⚠ verify existing bind route
        agentEmail: session.agentEmail || null,
        agentExtensionId: session.agentExtensionId || null,
        uii: current.uii || null,
        externId: current.externId || null,
        caseId: current.caseId || null,
        queueItemId: current.queueItemId || null,
        source: "cx-bulk-watcher",
        retireReplaced: false, // observational — never a destructive gate (06-17 law)
      });
    },
    // Call when current clears (accepted terminal OR watcher release).
    async currentCleared({ session = {}, last = {} } = {}) {
      return post("/api/ai/live-coach/grpc/session-eject", { // ⚠ verify eject route name
        agentEmail: session.agentEmail || null,
        agentExtensionId: session.agentExtensionId || null,
        uii: last.uii || null,
        reason: last.source || "terminal",
        source: "cx-bulk-watcher",
      });
    },
  };
}

module.exports = { createCxCoachBridge };
```

Wiring — two lines, both inside the watcher's EXISTING success paths (the bridge only observes
transitions the watcher already made; it is not a new owner):

```js
// after a successful serving promotion:
coachBridge?.currentProven({ session: next, current: next.current }).catch(() => null);
// after current cleared (terminal accepted or release applied):
coachBridge?.currentCleared({ session: next, last: next.lastOutcome }).catch(() => null);
```

**Pin:** disabled → zero fetches; enabled → one bind per proven current (dedupe by uii), one
eject per clear; a hanging coach endpoint delays NOTHING (the tick completes before the bridge
promise settles). ⚠ verify both route names against `apps/ai-bus/src/server.js` before paste;
if there is no clean eject route, fall back to the existing stop/stale path with
`retireReplaced:false` semantics preserved.

---

## BLOCK H — EX strip out of the bulk screen (WO-16-adjacent whack; breaks and
on/off-hook decisions DEFERRED to the cleanup pass — this removes DISPLAY only)

`apps/web-client/src/app/CXShell.tsx` — the header shows the EX controls on the workspace
route (`showCxControls`, line 30: `CxConnectButton` + `CxAvailabilityToggle`). For the bulk
workspace those are EX-era surface: connect/availability truth belongs to the session poll,
and the one-screen status line says what matters.

```tsx
// CXShell.tsx — replace the showCxControls line:
const onWorkspace = location.pathname === "/cx" || location.pathname === "/cx/";
const bulkMode = import.meta.env.VITE_CX_WORKSPACE_MODE === "bulk_load"; // ⚠ verify mode source
const showCxControls = onWorkspace && !bulkMode;
```

Inside `CXWorkspaceBulkLoad.tsx`: the top-of-workspace EX strips (auto-serve EX readouts,
availability chips) go to the attic in the WO-15/16 pass — their replacement is the
projection's status line plus the WO-28 mode header (`{cxRuntimeMode, exPresencePollMode,
exWebhookState}` in small grey text). Break/on-hook/off-hook BEHAVIOR is explicitly untouched:
those decisions are queued for the cleanup, and the underlying commands stay reachable until
then.

**Pin:** render smoke — bulk workspace header shows no EX controls; legacy `/cx` via
`CXWorkspace.tsx` unchanged; typecheck clean.

---

## BLOCK I — WO-32: the answered-calls follow-up bar (server + client, paste-ready)

The last modal is dead; this is its replacement. Answered calls are done and dusted the moment
they happen — this surfaces them as WORK in the appointments area: a slim bar per call, three
actions, no popups. Prereq in the tree already: connected departures record `answered` with the
real-pickup guard (`CX_BULK_ANSWERED_MIN_CONNECTED_MS`, default 10s, downgrades screener/VM-kick
connects).

### Server half — add to `apps/control-plane/src/routes/cxBulkLoad.js`

```js
// WO-32: the agent's answered-calls worklist (read-only; the record IS the work).
router.get("/answered-today", auth.requireAuth, auth.requireUser, async (req, res) => {
  try {
    const agentEmail = str(req.user?.email || req.query.agentEmail); // ⚠ verify the auth-user shape used by sibling routes
    if (!agentEmail) return res.status(400).json({ ok: false, error: "agent-email-required" });
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const rows = await CxTerminalOutbox.find(
      { agentEmail, outcome: "answered", createdAt: { $gte: startOfDay } },
      { queueItemId: 1, caseId: 1, uii: 1, idemKey: 1, createdAt: 1, domain: 1 },
    ).sort({ createdAt: -1 }).limit(50).lean();
    return res.json({
      ok: true,
      result: rows.map((row) => ({
        idemKey: row.idemKey,
        queueItemId: row.queueItemId,
        caseId: row.caseId ?? null,
        uii: row.uii || null,
        domain: row.domain || null,
        at: row.createdAt,
      })),
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || "answered-list-failed" });
  }
});
```

### Client hook — add to `apps/web-client/src/lib/api/queries/cxBulkLoad.ts`

```ts
export type CxAnsweredCall = {
  idemKey: string; queueItemId: string; caseId: number | null;
  uii: string | null; domain: string | null; at: string;
};

export function useCxAnsweredToday(enabled = false) {
  return useQuery({
    queryKey: [...queryKeys.cx.all(), "bulk-load", "answered-today"],
    queryFn: () =>
      api.get<{ ok: true; result: CxAnsweredCall[] }>("/api/cx/bulk-load/answered-today")
        .then((r) => r.result),
    enabled,
    refetchInterval: enabled ? 30_000 : false,
  });
}
```

### The bar — new file `apps/web-client/src/workspaces/cx/AnsweredFollowUpBar.tsx`

```tsx
import * as React from "react";
import { Button } from "@/components/ui/Button";
import { CaseLink } from "@/components/ui/CaseLink"; // existing case-jump component ⚠ verify props
import type { CxAnsweredCall } from "@/lib/api/queries/cxBulkLoad";

// WO-32: one slim row per answered call — X (do nothing, local dismiss only,
// no server write), Set appointment (existing flow, keyed to the case), DNC
// (same disposition mutation; the click carries the record's identity and the
// server's three-way routing lands it in the correction lane). No modals.
const DISMISSED_KEY = "cx-answered-dismissed";

function readDismissed(): Set<string> {
  try { return new Set(JSON.parse(sessionStorage.getItem(DISMISSED_KEY) || "[]")); }
  catch { return new Set(); }
}

export function AnsweredFollowUpBar({
  calls,
  onSetAppointment, // (call: CxAnsweredCall) => void — opens the existing appointment flow
  onDnc,            // (call: CxAnsweredCall) => Promise<unknown> — disposition w/ identity
}: {
  calls: CxAnsweredCall[];
  onSetAppointment: (call: CxAnsweredCall) => void;
  onDnc: (call: CxAnsweredCall) => Promise<unknown>;
}) {
  const [dismissed, setDismissed] = React.useState<Set<string>>(readDismissed);
  const [busy, setBusy] = React.useState<string | null>(null);

  function dismiss(idemKey: string) {
    const next = new Set(dismissed).add(idemKey);
    setDismissed(next);
    try { sessionStorage.setItem(DISMISSED_KEY, JSON.stringify([...next])); } catch { /* view-state only */ }
  }

  const visible = calls.filter((c) => !dismissed.has(c.idemKey));
  if (visible.length === 0) return null;

  return (
    <div className="space-y-1">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Answered today — follow up ({visible.length})
      </div>
      {visible.map((call) => (
        <div key={call.idemKey} className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-2 py-1.5">
          <span className="min-w-0 flex-1 truncate text-xs text-foreground">
            {call.caseId != null ? <CaseLink caseId={call.caseId} domain={call.domain} /> : call.queueItemId}
            <span className="ml-2 text-muted-foreground">
              {new Date(call.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
            </span>
          </span>
          <Button size="sm" variant="outline" disabled={busy === call.idemKey}
            onClick={() => onSetAppointment(call)}>
            Set appointment
          </Button>
          <Button size="sm" variant="destructive" disabled={busy === call.idemKey}
            onClick={async () => {
              setBusy(call.idemKey);
              try { await onDnc(call); dismiss(call.idemKey); } finally { setBusy(null); }
            }}>
            DNC
          </Button>
          <Button size="sm" variant="ghost" aria-label="Dismiss"
            onClick={() => dismiss(call.idemKey)}>
            ✕
          </Button>
        </div>
      ))}
    </div>
  );
}
```

Mount: in the appointments area of the bulk workspace —
`<AnsweredFollowUpBar calls={answered.data ?? []} onSetAppointment={openAppointmentWrapFor} onDnc={(c) => bulkDisposition.mutateAsync({ sessionId, disposition: "dnc", queueItemId: c.queueItemId, uii: c.uii })} />`
(the DNC click rides WO-17's identity routing into the WO-31 correction lane — no new mutation).

**Pins:** endpoint returns only `answered` outcomes for the agent (never-connected rows never
appear — the real-pickup guard is what keeps this list honest); DNC writes a review-correction
row and never mutates the original `answered` record; X writes NOTHING server-side (view-state
only); row disappears after action.
