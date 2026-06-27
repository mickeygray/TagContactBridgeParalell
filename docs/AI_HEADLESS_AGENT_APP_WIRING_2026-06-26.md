# AI Headless Agent App Wiring (2026-06-26)

Purpose: make Linux Codex and Claude useful to the app without creating a second invisible application. Headless agents may reason, draft, summarize, or grade, but the app should only trust results that come back through a backend-owned contract.

## Current Linux State

```text
host: tagcontactbridge
service user: parallel
repo: /opt/tagcontactbridge-parallel

codex cli: /usr/bin/codex
codex auth home: /opt/tagcontactbridge-parallel/runtime/codex-agent-home

claude cli: /usr/bin/claude
claude auth home: /home/parallel
claude auth mode: Claude Max login under user parallel
```

The shared config now exposes these as:

```js
config.aiAgents.enabled
config.aiAgents.user
config.aiAgents.resultRoot
config.aiAgents.stripApiKeys
config.aiAgents.codex.enabled
config.aiAgents.codex.cliPath
config.aiAgents.codex.home
config.aiAgents.codex.model
config.aiAgents.codex.timeoutMs
config.aiAgents.claude.enabled
config.aiAgents.claude.cliPath
config.aiAgents.claude.home
config.aiAgents.claude.authMode
config.aiAgents.claude.model
config.aiAgents.claude.timeoutMs
```

Recommended Linux env:

```bash
AI_AGENTS_ENABLED=true
AI_AGENT_USER=parallel
AI_AGENT_RESULT_ROOT=/opt/tagcontactbridge-parallel/runtime/ai-agent-results
AI_AGENT_STRIP_API_KEYS=true

AI_AGENT_CODEX_ENABLED=true
CODEX_CLI_PATH=/usr/bin/codex
CODEX_HOME=/opt/tagcontactbridge-parallel/runtime/codex-agent-home
CODEX_AGENT_TIMEOUT_MS=180000

AI_AGENT_CLAUDE_ENABLED=true
CLAUDE_CLI_PATH=/usr/bin/claude
CLAUDE_AGENT_HOME=/home/parallel
CLAUDE_AGENT_AUTH_MODE=max
CLAUDE_AGENT_TIMEOUT_MS=60000
```

## Non-Negotiable Boundary

Do not let the client or app read random agent files as source of truth.

Agents may write local receipts under `runtime/ai-agent-results`, but app state must be written by trusted backend code after validation:

```text
agent stdout/json -> backend validator -> repository/service write -> app reads Mongo/API
```

Files are audit artifacts. Mongo/API state is the product contract.

## Three Valid Return Patterns

### 1. Synchronous Bus Return

Use for live or near-live coach work where a caller is already waiting.

```text
5001/control-plane
  -> createAiTaskClient.runAiTask(taskId, payload, options)
  -> 7000/ai-bus
  -> agent provider adapter
  -> validated envelope returned to caller
```

Result shape:

```js
{
  ok: true,
  taskId,
  provider: "claude-agent" | "codex-agent",
  result,
  timing,
  usage,
  receiptPath: null
}
```

Use this only when the model call is short and the UI/backend needs the answer now.

### 2. Durable Async Result

Use for nightly grading, call summaries, document summaries, blog prep, and anything allowed to finish later.

```text
backend creates job row
  -> worker claims job
  -> worker invokes agent
  -> backend validates result
  -> backend writes target repository
  -> backend marks job completed/failed
```

Minimum job row:

```js
{
  jobId,
  taskId,
  aggregateType,
  aggregateId,
  idempotencyKey,
  status: "pending" | "running" | "completed" | "failed",
  inputRef,
  resultRef,
  error,
  attempts,
  createdAt,
  updatedAt,
  completedAt
}
```

This is the preferred pattern for headless agents.

### 3. Receipt-Only File

Use for dry runs and operator review.

Examples already follow this pattern:

```text
scripts/codex-agent/run-nightly-call-grades.js
  writes runtime/codex-agent/nightly-call-grades/*.json

scripts/codex-agent/run-blog-prompt-sequence.js
  writes runtime/codex-agent/blog-sequence/<run>/*.json
```

Receipt files should include:

```js
{
  ok,
  taskId,
  mode,
  generatedAt,
  inputSummary,
  resultSummary,
  receiptPath,
  applied: false
}
```

They should not be consumed by the client directly.

## Where Results Should Land

### Live Coach Short Summary

Target write:

```text
live coach session state / coach cache
```

App-facing shape:

```js
{
  uii,
  agentEmail,
  summaryVersion,
  summaryItems: [],
  objections: [],
  taxIssues: [],
  completedGuideItems: [],
  openQuestions: [],
  updatedAt
}
```

The agent may summarize multiple active calls in one response, but every item must include `uii` and `agentEmail`. Backend drops anything that does not match an active call.

### End Of Call Summary

Target write:

```text
cx_agent_call_notes
```

This is the source material for nightly grading and for later Logics activity writes.

The terminal drain should write the note. Headless agents can enrich the note later, but should not bypass the note service.

### Nightly Call Grade

Target write:

```text
cx_agent_call_notes.grade
cx_agent_call_notes.gradeStatus
```

Existing good pattern:

```text
scripts/codex-agent/run-nightly-call-grades.js
  -> buildCallGradeTaskPacket(note)
  -> Codex response
  -> normalizeCallGradeResult
  -> applyCallGradeResult(noteKey, grade, repository)
```

That is the model to preserve.

### Blog Drafts

Target write:

```text
runtime/codex-agent/blog-sequence/<run> for review
scripts/blog-drafts/*.json only through publish-approved path
```

Agent output should not publish, deploy, commit, or email. It creates reviewed draft JSON. Existing deterministic blogger scripts perform final publish actions.

### Document / Resolution Summaries

Target write:

```text
case profile / document analysis repository / resolution workspace record
```

Do not leave the only copy under `runtime/ai-agent-results`. Store agent output through the same repository the UI already reads.

## Provider Adapter Shape

The 7000 bus should eventually own both agent runners behind a single adapter interface:

```js
async function runAgentTask({ taskId, payload, options }) {
  return {
    ok,
    provider,
    model,
    result,
    rawText,
    usage,
    timing,
    receiptPath,
    error,
  };
}
```

The adapter does four things and only four things:

1. Build the prompt from an existing task contract.
2. Spawn/call Codex or Claude with API keys stripped.
3. Parse/validate JSON.
4. Return a normalized envelope.

It does not write product state. A service/repository owns that write.

## Child Environment Rule

Every agent child process must strip API credentials:

```js
delete env.OPENAI_API_KEY;
delete env.OPENAI_BASE_URL;
delete env.ANTHROPIC_API_KEY;
delete env.ANTHROPIC_AUTH_TOKEN;
```

Then explicitly set only the relevant subscription-auth home:

```js
env.CODEX_HOME = config.aiAgents.codex.home;
env.HOME = config.aiAgents.claude.home; // only for Claude child processes if needed
```

## Recommended Next Patch

1. Add `aiAgents` config to shared config. Done.
2. Add a tiny `agentResultWriter` utility:
   - writes JSON receipts under `config.aiAgents.resultRoot`
   - returns `{ receiptPath, receiptId }`
3. Add one provider adapter for Codex first:
   - wraps `scripts/codex-agent/codexMcpClient.js`
   - strips API keys
   - returns a bus envelope
4. Add one provider adapter for Claude second:
   - wraps `scripts/claudeAgentRunner.js`
   - strips API keys
   - returns the same bus envelope
5. Wire only one task through the adapter first:
   - safest: `liveCoach.callGrader` in dry run or capped nightly mode
6. Only after that, add coach rolling summary:
   - response is an array keyed by `{ uii, agentEmail }`
   - backend applies results only to active matching sessions

## What Not To Do

- Do not let the UI poll `runtime/` files.
- Do not let agent scripts write arbitrary collections.
- Do not let an agent publish blogs directly.
- Do not let agent output mutate call/queue state.
- Do not run both API and agent writers for the same target field.
- Do not treat a receipt file as completion unless the repository write succeeded.

The product rule is simple: agents think, backend validates and writes, the app reads normal app data.
