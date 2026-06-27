# Headless-Agent to Coach Wiring - Live vs Local Implementation Review (2026-06-26)

Goal: wire Codex (`/usr/bin/codex`, isolated `CODEX_HOME`) and Claude (`/usr/bin/claude`, Max) as two optional ai-bus providers, and unblock the coach rolling-summary codex branch, with default-off behavior everywhere.

Companion references:
- [AI_HEADLESS_AGENT_APP_WIRING_2026-06-26.md](AI_HEADLESS_AGENT_APP_WIRING_2026-06-26.md)
- [AI_LIVE_COACH_COCKPIT_WIRING_GUIDE_2026-06-26.md](AI_LIVE_COACH_COCKPIT_WIRING_GUIDE_2026-06-26.md)

## 0) Why the wire is small

The bus is already provider-neutral:
- `createAiTaskRunner` resolves by provider id at runtime and failovers across adapters.
- The adapters only need `supports(kind)` and `run(kind, request, {model})`.
- The contract is normalized output (`{text|json|audio, model, usage, provider}`).

So this work is only:
1. Add providers (Codex/Claude adapters).
2. Register them in the bus provider map behind feature flags.
3. Wire the one codex-null seam in coach summary transport.

No runner rewrite is needed.

## 1) Existing code (already in place, reuse)

- `packages/shared-services/src/aiProviders.js`  
  - Current factory only returns Anthropic/OpenAI providers at `createAiProviders({anthropic, openai})`.
- `packages/shared-services/src/aiTaskRunner.js`  
  - `providers[step.provider]` lookup, `supports`, `adapter.run`, failover, validation, telemetry, `retryable` handling already exist.
- `scripts/codex-agent/codexMcpClient.js`
  - `createCodexMcpClient` already strips `OPENAI_API_KEY`/`OPENAI_BASE_URL`, sets `CODEX_HOME`, and owns warm daemon lifecycle.
- `scripts/claudeAgentRunner.js`
  - `createClaudeAgentRunner` already strips `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` and returns `{ok, json, text, usage, raw}`.
- `packages/shared-services/src/aiBusRegistry.js`
  - `assertBusRegistryIntegrity` rejects empty model ladders for any provider in a task's `providerOrder`.
- `apps/ai-bus/src/coachBatchTransports.js`
  - `createSummaryTransport` currently returns `null` for codex/openai substrate.
- `packages/shared-services/src/aiSandbox/tasks.js`
  - `liveCoach.callGrader` currently resolves as `{provider:"openai", kind:"json"}` and maps to `providerOrder: [openai, anthropic]` by default.
- `packages/shared-services/src/liveCoachBusService.js`
  - floor loop already consumes summary runner contract `{ ok, json?, text, usage? }` and applies rolling summary through existing plan/apply path.

## 2) Simplification plan (do this in order)

### 2.1 Add adapter module for headless agents

Create:
- `c:/code/TagContactBridgeParalell/packages/shared-services/src/aiAgentProviders.js`

Minimal shape:
```js
const REASONING_KINDS = new Set(["compose", "json", "classify"]);

function extractAgentJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (_e) {}
  const first = String(text).indexOf("{");
  const last = String(text).lastIndexOf("}");
  if (first >= 0 && last > first) {
    try { return JSON.parse(text.slice(first, last + 1)); } catch (_e) {}
  }
  return null;
}

function createCodexAgentAdapter(config, deps = {}) {
  const { enabled, cliPath, home, model, timeoutMs, cwd } = config || {};
  if (!enabled) return null;
  let client = null;
  return {
    id: "codex-agent",
    supports: (kind) => REASONING_KINDS.has(kind),
    async run(kind, request = {}, opts = {}) {
      const c = client ||= (deps.createCodexMcpClient || require("../../../scripts/codex-agent/codexMcpClient").createCodexMcpClient)({
        codexBin: cliPath,
        codexHome: home,
        model: model || undefined,
        timeoutMs,
        cwd,
      });
      const shapeHint = request.schema
        ? `Return ONLY JSON with keys: ${(request.schema.properties ? Object.keys(request.schema.properties) : []).join(", ")}`
        : "";
      const res = await c.ask(request.user || request.prompt || "", {
        baseInstructions: [request.system, shapeHint].filter(Boolean).join("\n\n"),
        model: opts.model || model,
        timeoutMs: request.timeoutMs || timeoutMs,
      });
      if (kind === "json" || kind === "classify") {
        const json = extractAgentJson(res.text);
        if (!json) {
          const err = new Error("codex-agent empty json");
          err.retryable = true;
          throw err;
        }
        return { json, model: opts.model || model || "codex-default", usage: null, provider: "codex-agent" };
      }
      return { text: res.text, model: opts.model || model || "codex-default", usage: null, provider: "codex-agent" };
    },
  };
}

function createClaudeAgentAdapter(config, deps = {}) {
  const { enabled, cliPath, home, model, timeoutMs, cwd } = config || {};
  if (!enabled) return null;
  let runner = null;
  return {
    id: "claude-agent",
    supports: (kind) => REASONING_KINDS.has(kind),
    async run(kind, request = {}, opts = {}) {
      const modelId = opts.model || model || "sonnet";
      if (!runner) {
        runner = (deps.createClaudeAgentRunner || require("../../../scripts/claudeAgentRunner").createClaudeAgentRunner)({
          model: modelId,
          bin: cliPath,
          timeoutMs,
          cwd: cwd || undefined,
          home,
        });
      }
      const output = await runner({ prompt: request.user || request.prompt || "", system: request.system, schema: request.schema });
      if (!output.ok) {
        const err = new Error(output.error || "claude-agent failed");
        err.retryable = true;
        throw err;
      }
      if ((kind === "json" || kind === "classify") && output.json == null) {
        const err = new Error("claude-agent empty json");
        err.retryable = true;
        throw err;
      }
  const result = (kind === "json" || kind === "classify") ? output.json : output.text;
      return {
        json: kind === "json" || kind === "classify" ? result : undefined,
        text: kind === "json" || kind === "classify" ? undefined : result,
        model: modelId,
        usage: output.usage || null,
        provider: "claude-agent",
      };
    },
  };
}

module.exports = { createCodexAgentAdapter, createClaudeAgentAdapter, extractAgentJson, REASONING_KINDS };
```

Notes:
- This is intentionally shared in one place so both batch summary and bus codex path reuse the same brace-extract JSON parser logic.
- For simplicity, keep `id` names as `codex-agent` and `claude-agent` if you do not care about env var naming convenience.

### 2.2 Add headless env controls to claude runner (small, safe)

In `scripts/claudeAgentRunner.js`:
- allow `home` and `env` in options.
- merge env as `{...process.env, ...env, HOME: home}` and remove Anthropic keys from that merged env.
- do not mutate global process env.
- optional: allow `env` injection for testability.

### 2.3 Register providers in the server provider map

In `packages/shared-services/src/aiProviders.js`:
- expand signature to `createAiProviders({anthropic, openai, codexAgent, claudeAgent})`.
- register providers conditionally.

In `apps/ai-bus/src/server.js` around lines ~3660-3664:
- read `const aiAgents = getSharedConfig().aiAgents || {}`.
- create codex/claude adapters with config values and pass them as `{codexAgent, claudeAgent}` to `createAiProviders(...)`.
- keep `AI_AGENTS_ENABLED` as a coarse gate.

### 2.4 Choose first go-live task routing for callGrader with env only

For first pass, do NOT edit registry tables.
- Keep task registry as-is.
- Use env pin for runtime routing:
  - `AI_TASK_LIVECOACH_CALLGRADE_PROVIDER_ORDER=codex-agent,openai,anthropic`
  - `AI_AGENTS_ENABLED=true`
  - `AI_AGENT_CODEX_ENABLED=true`
  - `AI_AGENT_CLAUDE_ENABLED=true` (optional if codex-first only)

Why this is safer:
- Keeps `assertBusRegistryIntegrity` unchanged.
- Avoids forcing per-task model ladder edits for this first increment.

### 2.5 Fill the codex summary seam

In `apps/ai-bus/src/coachBatchTransports.js`:
- replace the codex branch at `createSummaryTransport` null return with a Codex runner using `createCodexMcpClient`.
- Keep strict coach contract `{ ok, json?, text, usage? }`.
- parse JSON via shared `extractAgentJson`.
- return `{ok:false, error}` on throw/timeouts.
- only return a runner when `LIVE_COACH_ROLLING_SUMMARY_SUBSTRATE=codex` and `AI_AGENT_CODEX_ENABLED=true`.

For shutdown hygiene:
- if codex client is created, expose `runSummary.stop` or add a no-op cleanup path in server shutdown so daemon is explicit.

## 3) Line-by-line audit and rewrite suggestions

Current guide lines (old draft) vs production state:

1) `apps/ai-bus/src/server.js:3663`
- Replace one-liner provider map to include headless adapters once `createAiProviders` supports them.

2) `packages/shared-services/src/aiProviders.js:238-243`
- extend `createAiProviders(...)`; no existing runner or registry changes required.

3) `packages/shared-services/src/aiBusRegistry.js:179-190`
- If you later hard-code `codex-agent` in task `providerOrder`, set a non-empty ladder (e.g. `"codex-default"` or `AI_AGENT_CODEX_MODEL`) before integrity check.
- If you stay env-only routing (recommended first), no registry edit is needed.

4) `scripts/claudeAgentRunner.js:70-166`
- add `home` + safe env merge and delete ANTHROPIC keys from merged env.

5) `scripts/codex-agent/codexMcpClient.js:26-29`
- Windows default is correct for dev; Linux host path is injected from config/env. Ensure `codexBin` is set from `CODEX_CLI_PATH`/`aiAgents.codex.cliPath` in production.

6) `apps/ai-bus/src/coachBatchTransports.js:157-169`
- replace documented null codex seam with real one.

7) `apps/ai-bus/src/server.js` shutdown path
- add explicit stop for codex summary/adapter daemons if you keep long-lived codex transport objects.

## 4) Risks (ranked for production)

R1. `assertBusRegistryIntegrity` still enforces non-empty ladders for task-defined providers.  
Mitigation: env-only routing first; if hardcoding order in `toRegistryTask`, inject a sentinel.

R2. No double-write on grade persistence.  
The bus and standalone `run-nightly-call-grades --apply` both write `markGradeStatus`; keep one path active.

R3. Warm daemon lifecycle ownership.  
Codex should be started once, shared per process use, and stopped cleanly.

R4. Spend telemetry blind spot.  
Headless adapters return `usage:null`; this is expected without raw extraction support.

R5. Key stripping and model defaults.  
Keep `AI_AGENTS_ENABLED` off by default and only flip in live hosts.

## 5) Open questions (decide before go-live)

- Provider IDs: keep `codex-agent`/`claude-agent` or simplify to `codex`/`claude` to avoid hyphen side-effects in env-derived config keys.
- Shared codex daemon vs two daemons (bus + summary); for first pass, one daemon in bus process is simpler.
- Whether to include receipts during first live pass (`agentResultWriter`) or keep write-path in standalone script temporarily.

## 6) Execution order check

1. Add `aiAgentProviders.js` and `claudeAgentRunner` env options.
2. Extend provider factory and server wiring.
3. Turn on env-based callGrader order in a non-production host.
4. Wire codex summary seam.
5. Only after E2E dry-run success, flip batch summary and grading flags in the same direction as `AI_AGENTS_ENABLED`.


