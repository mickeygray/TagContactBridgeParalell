# AI Live Coach Active Batch Object - 2026-06-26

Purpose: prep the next coach architecture where one cacheable coach prompt reads all active conversations in one pass and returns per-agent guidance.

This document only covers the data-flow seam. It does not choose the final model mix.

## Flow

```text
RingCX audio / gRPC stream
  -> STT fragments/finals
  -> liveCoachBus.appendInput()
  -> session.memory arrays
  -> buildActiveConversationBatch()
  -> one model request later
  -> per-session guidance deltas back to agents
```

## Current Implementation

- `packages/shared-services/src/liveCoachBatchProjectionService.js`
  - Pure projector.
  - Input: serialized live coach sessions.
  - Output: one JSON object with `conversations[]`.
  - No model calls, no DB writes, no session mutation.

- `packages/shared-services/src/liveCoachBusService.js`
  - Adds `buildActiveConversationBatch(input)`.
  - Uses `listSessions()` as the source of truth.

- `apps/ai-bus/src/server.js`
  - Adds internal read endpoint:
    - `GET /api/ai/live-coach/grpc/active-conversation-batch`
  - This is for inspection and future runner plumbing only.
  - Adds internal delta endpoint:
    - `POST /api/ai/live-coach/grpc/active-conversation-changes`
  - This is the cheap loop contract for deciding whether to call a model.
  - Adds internal dispatch-plan endpoint:
    - `POST /api/ai/live-coach/grpc/batch-guidance-dispatch-plan`
  - This splits one batch model response back into per-agent targets without mutating UI state yet.

## Batch Shape

```json
{
  "schemaVersion": "live-coach.active-conversation-batch.v1",
  "generatedAt": "2026-06-26T...",
  "activeConversationCount": 2,
  "limits": {
    "maxSessions": 12,
    "maxTranscriptRows": 40,
    "maxProvisionalRows": 8,
    "maxContextRows": 12,
    "maxGuidanceRows": 8,
    "maxAskRows": 5
  },
  "conversations": [
    {
      "sessionId": "coach-...",
      "status": "listening",
      "source": "grpc-mongo",
      "agent": {
        "email": "agent@example.com",
        "name": "Agent",
        "extension": "101"
      },
      "call": {
        "domain": "WYNN",
        "caseId": "123456",
        "queueItemId": "queue-row-id",
        "uii": "ringcx-uii",
        "phoneLast4": "1234"
      },
      "latest": {
        "transcript": {},
        "provisionalTranscript": {},
        "context": {},
        "guidance": {},
        "streamStatus": {}
      },
      "arrays": {
        "transcript": [],
        "provisionalTranscript": [],
        "context": [],
        "guidance": [],
        "asks": [],
        "facts": []
      }
    }
  ]
}
```

## Why This Shape

- Stable field names make the giant system prompt cacheable; the changing data lives in the user payload.
- Each conversation is isolated by `sessionId`, `agent`, and `call.uii`.
- Transcript rows stay ordered and capped so one noisy call cannot eat the whole batch.
- Provisional STT is separate from final transcript so the future model can treat it as lower confidence.
- Prior guidance/context arrays are included so the next model can avoid repeating itself.
- No full phone numbers are included; only `phoneLast4` is exposed for traceability.

## Future Runner Contract

The future one-shot coach runner should return something like:

```json
{
  "schemaVersion": "live-coach.batch-guidance.v1",
  "generatedAt": "2026-06-26T...",
  "guidance": [
    {
      "sessionId": "coach-...",
      "uii": "ringcx-uii",
      "agentEmail": "agent@example.com",
      "mode": "reaction|guidepost|quiet",
      "read": "What the model thinks is happening.",
      "steer": "How to move the call forward.",
      "try": "Optional short line.",
      "phase": "discovery",
      "completed": [],
      "next": [],
      "confidence": "low|medium|high"
    }
  ]
}
```

Writeback should be a separate reducer that validates `sessionId` and current `uii` before touching agent UI state.

## Guidance Dispatch Placeholder

After the future runner returns one batch response, split it before any UI write.

```text
batch model response
  -> POST /api/ai/live-coach/grpc/batch-guidance-dispatch-plan
  -> validate each row against the current active batch
  -> dispatches[] are safe to hand to a future writer
  -> rejected[] are stale, ambiguous, mismatched, or empty rows
```

Request:

```json
{
  "response": {
    "schemaVersion": "live-coach.batch-guidance.v1",
    "generatedAt": "2026-06-26T...",
    "guidance": [
      {
        "sessionId": "coach-...",
        "uii": "ringcx-uii",
        "agentEmail": "agent@example.com",
        "mode": "reaction",
        "read": "Price objection.",
        "steer": "Reframe value.",
        "try": "Let's look at what waiting costs."
      }
    ]
  }
}
```

Response:

```json
{
  "ok": true,
  "dispatchPlan": {
    "schemaVersion": "live-coach.batch-guidance-dispatch.v1",
    "dispatchCount": 1,
    "rejectedCount": 0,
    "dispatches": [
      {
        "status": "ready",
        "delivery": "placeholder",
        "target": {
          "sessionId": "coach-...",
          "uii": "ringcx-uii",
          "agentEmail": "agent@example.com"
        },
        "payload": {
          "schemaVersion": "live-coach.agent-guidance-delta.v1",
          "mode": "reaction",
          "read": "Price objection.",
          "steer": "Reframe value.",
          "try": "Let's look at what waiting costs."
        }
      }
    ],
    "rejected": []
  }
}
```

Routing rules:

- Prefer `sessionId` as the primary target.
- If `uii` is present, it must match the current active conversation for that session.
- If `agentEmail` is present, it must match the current active conversation for that session.
- If `sessionId` is absent, `uii + agentEmail` can route only when it finds exactly one active conversation.
- Empty guidance rows are rejected.
- Ended calls are not valid dispatch targets; they belong to cleanup/writeback, not live UI guidance.

## Cheap Loop Contract

The model runner should not send the full batch on every timer tick. It should keep a local cursor and ask for only changed active conversations.

```text
every 2-5 seconds
  -> POST /api/ai/live-coach/grpc/active-conversation-changes { cursor }
  -> if hasChanges is false, do not call a model
  -> if hasChanges is true, call the model with changedConversations[]
  -> store response.cursor as the next cursor after the model request is accepted
```

Request:

```json
{
  "cursor": {
    "schemaVersion": "live-coach.active-conversation-cursor.v1",
    "conversations": {}
  },
  "maxSessions": 12,
  "maxTranscriptRows": 40,
  "maxProvisionalRows": 8,
  "maxContextRows": 12,
  "maxGuidanceRows": 8,
  "maxAskRows": 5
}
```

No-change response:

```json
{
  "ok": true,
  "changes": {
    "schemaVersion": "live-coach.active-conversation-changes.v1",
    "hasChanges": false,
    "activeConversationCount": 7,
    "changedConversationCount": 0,
    "unchangedConversationCount": 7,
    "changedConversations": [],
    "cursor": {}
  }
}
```

Changed response:

```json
{
  "ok": true,
  "changes": {
    "schemaVersion": "live-coach.active-conversation-changes.v1",
    "hasChanges": true,
    "activeConversationCount": 7,
    "changedConversationCount": 2,
    "changedConversations": [
      {
        "sessionId": "coach-...",
        "agent": {},
        "call": {},
        "arrays": {},
        "change": {
          "reason": "conversation-updated",
          "signature": "fingerprint",
          "previousSignature": "prior-fingerprint"
        }
      }
    ],
    "cursor": {}
  }
}
```

The cursor is caller-owned on purpose. Inspecting the endpoint should not consume changes or interfere with the eventual model runner.

`endedConversations[]` is reported separately from `changedConversations[]`. A call ending may be useful for cleanup/writeback, but it should not force a fresh model call by itself.
