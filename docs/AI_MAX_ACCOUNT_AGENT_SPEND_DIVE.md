# AI Spend Dive: Max/Codex Agent vs API

Date: 2026-06-23

## Short Verdict

Do **not** use a ChatGPT/Max/Pro account as a hidden production backend for the app.

Use it as an internal offline worker on the Linux box for slow, non-SLA,
non-customer-facing tasks: graders, summaries, audit reports, batch reviews, and
operator-facing drafts. The live coach stays on the real API. Anything that must
respond while an agent/customer is waiting also stays on the real API.

The cost-saving path should be:

1. Centralize all production model calls through `7000`.
2. Add usage telemetry and spend labels by named task.
3. Cache stable prompts and repeated task results.
4. Move non-critical batch/advisory tasks to either:
   - local open-weight models, or
   - a queued Codex/Max ops agent with gates, logs, and fallback.

## Official Boundary To Respect

OpenAI's help docs distinguish ChatGPT subscriptions from the API. A ChatGPT Business subscription, for example, does not include API usage; API usage is billed separately:

- https://help.openai.com/en/articles/8792828-what-is-chatgpt-business
- https://help.openai.com/en/articles/8542115-chatgpt-business-general-faq

OpenAI's plan-limit help also says usage must follow terms and calls out prohibited patterns such as automated/programmatic extraction, credential sharing, reselling access, or using ChatGPT to power third-party services:

- https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers
- https://help.openai.com/en/articles/12003714-chatgpt-business-models-limits

So the safe line is:

- **Allowed-shaped:** use Codex/ChatGPT interactively or semi-automatically for our own internal development, audits, docs, patch reviews, and human-approved operations.
- **Potentially acceptable if scoped tightly:** offline internal coaching grades,
  internal summaries, nightly report drafts, batch review drafts, and other work
  that can fail/delay without affecting the live app.
- **Not safe-shaped:** route live app traffic, live agent coaching, SMS/DNC
  classification, customer-facing responses, or customer-impacting automation
  through a logged-in ChatGPT browser/Codex account to avoid API billing.

This is an architecture note, not legal advice, but it is enough to rule out "replace every OpenAI API call with a Max account daemon" as a production design.

## What Exists In This Repo Already

There is already a prototype under:

- `scripts/codex-agent/codexMcpClient.js`
- `scripts/codex-agent/smoke-codex.js`
- `scripts/codex-agent/probe-mcp.js`

It starts a long-lived `codex mcp-server`, strips `OPENAI_API_KEY`, and uses a `CODEX_HOME` login to route through the signed-in Codex account instead of a metered API key.

That is useful as an **offline worker / ops agent** prototype, not as a live
production AI provider adapter.

Good uses:

- generate/read audit notes
- inspect logs and summarize them
- draft patch plans
- produce internal Markdown docs
- review low-risk diffs
- run local scripts and report findings
- stage one-off operator recommendations for a human to approve

Bad uses:

- live coach responses
- transcription
- SMS / DNC / compliance decisions
- call grading that blocks the live app
- call grading that mutates customer/contactability state directly
- customer-facing response generation
- anything requiring low latency, exact audit billing, or an SLA
- anything that would involve storing ChatGPT account cookies/secrets on the server as an app dependency

## Best Cost-Reduction Architecture

### 1. Keep `7000` As The Production AI Boundary

All production AI should flow through named tasks:

```text
5001/app/script
  -> 7000 ai task route
  -> task registry
  -> cache / budget / rate gate / provider selection
  -> provider or local model
  -> structured result + telemetry
```

This lets us cut cost without changing every caller:

- model downgrades per task
- hard task budgets
- cache hits
- dedupe/rate caps
- usage ledger by task
- provider fallback
- kill switches

### Background Task Routing Rule

The practical routing rule:

```text
live human waiting, customer-facing, compliance, STT, or DNC
  -> API through 7000

offline internal analysis, coaching draft, audit, report, nightly review
  -> ops-agent queue if enabled, API fallback if delayed/failed
```

The ops-agent should never be called inline from a request/response route. It
should consume a durable queue and write back a result row. The app can render or
email that result later.

Recommended job envelope:

```json
{
  "jobId": "call-grade:WYNN:127941:2026-06-23T18:22:00Z",
  "taskType": "call.grade.internal",
  "riskClass": "internal_advisory",
  "inputRef": {
    "collection": "call_logs",
    "id": "..."
  },
  "redaction": {
    "sendTranscript": true,
    "sendPhone": false,
    "sendSsn": false
  },
  "outputMode": "draft_json",
  "deadlineMs": 900000,
  "fallbackTask": "api.liveCoach.callGrade"
}
```

### Candidate Matrix

| Task | Move to Max/Codex ops-agent? | Notes |
| --- | --- | --- |
| Live coach guide/reaction/ask | **No** | Hot path, agent is waiting, latency matters. Keep API. |
| Live coach STT/transcription | **No** | Modality/API service, latency and accuracy matter. Optimize gating, not Max. |
| Voicemail / answering-service deterministic routing | **No model** | Keep deterministic. No Max/API needed. |
| End-of-call grader | **Yes, with gates** | Good candidate if queued after call, internal only, non-blocking, with API fallback for very high/low urgent alerts if needed. |
| Agent coaching email | **Yes, as draft/result** | Ops-agent writes grade JSON/body. Mailer sends only if deterministic evidence gates pass. |
| Daily/weekly agent performance digest | **Yes** | Strong candidate. Batch, internal, no live dependency. |
| Call summary for internal profile panel | **Yes, if sparse** | Good if it writes advisory summary only. Do not let it mutate contactability directly. |
| Logics activity review | **Maybe** | Internal review is okay; compliance/stop-contact decisions stay deterministic/API and fail closed. |
| SMS classifier/autoresponder | **No** | Compliance and customer-facing. Keep API/deterministic. |
| Resolution/upsellerator pitch on click | **Usually no** | User is waiting. Keep API unless it becomes overnight precomputed strategy. |
| Blogger drafts | **Yes** | Batch content generation can go ops-agent, with human/site deploy review. |
| Blogger images | **Yes, with a wrapper** | Codex CLI imagegen can create subscription-backed PNGs for small/background blog assets. The runner must harvest the real `CODEX_HOME/generated_images/**/ig_*.png` artifact; use API image generation only as an explicit fallback or larger-batch path. |
| Case/client notice digest | **Yes** | Internal report/draft. Keep exact data pull deterministic; agent only writes the narrative. |
| Metrics anomaly explanation | **Yes** | Great fit: agent reads prepared JSON and writes a human explanation. |
| Patch notes / log reviews / deployment summaries | **Yes** | Already the ideal lane. |

### 2. Add A Separate `ops-agent` Lane

If we run a Max/Codex-backed agent on Linux, make it a separate process and queue:

```text
ops task queue
  -> codex-agent daemon
  -> read-only workspace / explicit allowed scripts
  -> Markdown/report/JSON draft
  -> app stores result
  -> optional human approval or deterministic send gate
```

Rules:

- separate `CODEX_HOME`
- no `OPENAI_API_KEY` in child env
- read-only by default
- no live customer PII unless redacted
- no app hot path
- no automatic customer emails/texts/service mutations
- internal emails allowed only after deterministic evidence gates and with a fallback path
- log prompt hash, task id, elapsed time, result path, and operator approval

This can reduce API spend for "thinking around the app" and for internal
background coaching/reporting. It should not become "the app thinking for
customers."

### 2a. Background Grader Shape

The call grader is the cleanest first real background candidate.

Current desired flow:

```text
call ends
  -> deterministic evidence gate
       duration >= threshold
       transcript chars >= threshold
       has substantive tax/sales content
  -> enqueue call.grade.internal
  -> ops-agent writes grade JSON + email body draft
  -> validator checks required fields and confidence
  -> internal mailer sends to agent; manager only on high/low outlier
  -> if ops-agent misses deadline, fallback to API or skip with logged reason
```

Important: the agent should not be deciding whether a call is eligible to grade.
That gate stays deterministic so we avoid the "empty transcript but emailed a
grade" failure.

Minimum output schema:

```json
{
  "score": 0,
  "confidence": "low|medium|high",
  "verdict": "",
  "phaseReached": "",
  "outcome": "",
  "discussed": [],
  "whatWorked": [],
  "missedOpportunities": [],
  "coachingNotes": [],
  "managerAlert": false,
  "skipReason": null
}
```

If schema validation fails, do not send. Either retry once or fall back to the API.

### 3. Use Local Open-Weight Models For Real Automated Savings

For automated production-ish work where API spend is the problem, the better Linux-box path is a local model provider adapter. OpenAI's `gpt-oss` models are open-weight and can be run on our own infrastructure under Apache 2.0, with local compute/storage costs instead of per-token API costs:

- https://help.openai.com/en/articles/11870455-openai-open-weight-models-gpt-oss
- https://developers.openai.com/api/docs/models/gpt-oss-20b

Potential local-model jobs:

- simple JSON classification
- "is this substantive enough to grade?"
- call-summary first pass
- objection/fact extraction from transcript snippets
- blog outline drafts
- activity triage
- low-risk internal summaries

Jobs to keep on paid frontier/API until quality is proven:

- live coach final guidance
- compliance-sensitive SMS decisions
- DNC/STOP classification final action
- any task where a bad answer causes customer or compliance harm

## Where Spend Probably Drops Fastest

1. **STT/transcription:** keep tracking actual audio minutes and model used. This is likely the largest unavoidable live-coach cost. Optimize by not transcribing dead air/voicemail/short junk, not by routing through Max.
2. **Live coach composer/judge:** dedupe, rate cap, cache static prompts, cap context, and skip non-substantive releases.
3. **Grader/summary emails:** evidence gates first. No transcript/no substance should not call a model or send an email.
4. **Images/TTS/blogger:** keep TTS/API modalities explicit; blogger images can use Codex imagegen for small background runs, with API image fallback armed intentionally and no accidental daily high-quality generation.
5. **Batch reviews:** move to named AI tasks with concurrency and daily spend ceilings.

## Recommended First Implementation

Do not wire the Max/Codex agent into the live app request path.

Build two things instead:

1. **Production path:** finish the AI bus task registry and telemetry so every real model call is labeled and cacheable.
2. **Ops path:** promote `scripts/codex-agent` into a separate `ops-agent` daemon for internal background tasks.

Minimal Linux ops-agent shape:

```text
systemd service: tag-codex-ops-agent
working dir: /opt/tagcontactbridge-parallel
env:
  CODEX_HOME=/opt/tagcontactbridge-parallel/runtime/codex-agent-home
  CODEX_AGENT_MODEL=<chosen Codex model>
  OPENAI_API_KEY unset
permissions:
  read-only workspace by default
input:
  Mongo/job queue or local JSON task file
output:
  docs/reports/*.md or runtime/ops-agent/results/*.json
```

Use it for:

- "read these logs and produce an opinion"
- "summarize yesterday's AI spend and anomalies"
- "review this diff for risky areas"
- "write patch notes"
- "grade this completed call and draft internal coaching feedback"
- "summarize these calls into a manager digest"

Do not use it for:

- `runAiTask(...)`
- live coach
- STT
- SMS
- customer-facing automation

### First Build Slice

1. Add `OpsAiJob` collection.
   - `jobId`
   - `taskType`
   - `status`: `queued|running|completed|failed|expired`
   - `riskClass`
   - `inputRef`
   - `inputDigest`
   - `result`
   - `error`
   - `deadlineAt`
   - `createdAt/updatedAt`
2. Add a deterministic grader enqueue function.
   - Only enqueue if duration/transcript/substance gates pass.
   - Store references and a compact digest, not broad raw app state.
3. Add the Linux `tag-codex-ops-agent` worker.
   - Reads one queued job.
   - Runs `scripts/codex-agent`.
   - Writes strict JSON result.
   - Never sends email itself.
4. Add a result processor.
   - Validates schema.
   - Sends internal email only if gates still pass.
   - Uses API fallback only if the job is urgent or configured to require completion.
5. Add telemetry.
   - counts queued/completed/failed/expired
   - elapsed time
   - task type
   - fallback count
   - approximate API dollars avoided when fallback is not used

## Linux Bring-Up Path

The clean path is to make the Linux box run Codex as a separate service identity
and consume a queue. Do not embed the logged-in Codex account into `5001`,
`7000`, or any request/response route.

### Phase 0 - Decide Auth Mode

Preferred, if available:

- Use a Codex access token from ChatGPT Business/Enterprise workspace settings.
- Store it as a server secret.
- Either export it only for the worker process or run:

```bash
printf '%s' "$CODEX_ACCESS_TOKEN" | codex login --with-access-token
```

Fallback for a Max/Pro-style account if access tokens are not available:

- Create a dedicated Codex auth home on a browser-capable machine.
- Configure file credential storage so the auth cache is portable.
- Run `codex login`.
- Copy only that dedicated `auth.json` to the Linux box.

Treat `auth.json` like a password.

### Phase 1 - Install Codex CLI On Ubuntu

Official install path:

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh
codex --version
```

Alternative:

```bash
npm install -g @openai/codex
codex --version
```

Use one install method and stick with it. Mixing standalone and npm-managed
installs makes updates confusing.

### Phase 2 - Create A Dedicated Runtime Home

Use a separate home from any interactive operator account:

```bash
sudo mkdir -p /opt/tagcontactbridge-parallel/runtime/codex-agent-home
sudo chown -R parallel:parallel /opt/tagcontactbridge-parallel/runtime/codex-agent-home
sudo chmod 700 /opt/tagcontactbridge-parallel/runtime/codex-agent-home
```

Recommended config:

```toml
# /opt/tagcontactbridge-parallel/runtime/codex-agent-home/config.toml
cli_auth_credentials_store = "file"
model = "gpt-5.4-mini"

[profiles.ops-readonly]
sandbox = "read-only"
approval_policy = "never"
```

For copied credentials:

```bash
scp auth.json parallel@LIVE_HOST:/opt/tagcontactbridge-parallel/runtime/codex-agent-home/auth.json
ssh parallel@LIVE_HOST 'chmod 600 /opt/tagcontactbridge-parallel/runtime/codex-agent-home/auth.json'
```

### Phase 3 - Smoke Test Without Spending

The repo already has a no-model handshake probe:

```bash
cd /opt/tagcontactbridge-parallel
CODEX_HOME=/opt/tagcontactbridge-parallel/runtime/codex-agent-home \
  node scripts/codex-agent/smoke-codex.js --probe
```

Expected:

- connects to `codex mcp-server`
- lists tools
- no model call

Then run one tiny real call:

```bash
CODEX_HOME=/opt/tagcontactbridge-parallel/runtime/codex-agent-home \
  node scripts/codex-agent/smoke-codex.js --ask "Reply with exactly READY"
```

If that fails, do not build the worker yet. Fix auth/Codex install first.

### Phase 4 - Start With `codex exec`, Not The Warm MCP Daemon

For the first working version, prefer `codex exec` because it is the documented
non-interactive path and it supports structured output:

```bash
CODEX_HOME=/opt/tagcontactbridge-parallel/runtime/codex-agent-home \
codex exec \
  --sandbox read-only \
  --ask-for-approval never \
  --output-schema ./scripts/codex-agent/schemas/call-grade.schema.json \
  -o ./runtime/ops-agent/results/job-123.json \
  "Grade this completed call using the attached job JSON. Return JSON only." \
  < ./runtime/ops-agent/jobs/job-123.json
```

This is slower than a warm daemon, but safer to debug. Cold-start is acceptable
for graders/digests because nobody is waiting live.

### Phase 5 - Then Graduate To Warm MCP

Once `codex exec` is stable, use the existing warm client:

- `scripts/codex-agent/codexMcpClient.js`

Reason to use it:

- one long-lived `codex mcp-server`
- lower cold-start overhead
- better fit for a queue worker

Reason not to use it first:

- `codex mcp-server` is experimental
- parser/protocol details can drift between Codex versions
- harder to debug than `codex exec`

The worker should expose no HTTP route. It should poll Mongo/local queue:

```text
OpsAiJob queued
  -> claim one job
  -> build redacted input JSON
  -> run Codex
  -> validate JSON
  -> write result
  -> mark completed/failed/expired
```

### Phase 6 - Systemd Shape

Example service:

```ini
[Unit]
Description=TAG Codex Ops Agent
After=network.target

[Service]
Type=simple
User=parallel
WorkingDirectory=/opt/tagcontactbridge-parallel
Environment=NODE_ENV=production
Environment=CODEX_HOME=/opt/tagcontactbridge-parallel/runtime/codex-agent-home
Environment=CODEX_AGENT_MODEL=gpt-5.4-mini
EnvironmentFile=-/opt/tagcontactbridge-parallel/.env
ExecStart=/usr/bin/node scripts/codex-agent/run-ops-worker.js
Restart=on-failure
RestartSec=10
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Important:

- remove `OPENAI_API_KEY` from the child process that spawns Codex
- keep `.env` access only if the worker needs Mongo/email settings
- default worker tasks to read-only
- never give this service broad shell mutation power for grading/reporting jobs

### Phase 7 - First Production Candidate

First move only:

- completed call grader
- internal coaching email draft
- manager outlier alert draft

Do not move:

- live coach
- STT/transcription
- SMS/DNC
- resolution pitch on click
- customer emails/texts

Acceptance checks:

- can enqueue a fake `call.grade.internal`
- worker claims exactly one job
- Codex returns schema-valid JSON
- result processor refuses invalid JSON
- no email sends for insufficient evidence
- API fallback works if job expires
- all prompts/results are logged by job id, not raw secrets
- `auth.json` is not world-readable
- worker restart resumes queued jobs without duplicating completed jobs

## Bottom Line

The Max/Codex account can save API spend on internal offline work: graders,
digests, reports, patch notes, and log reviews. It should not be a live
inference backend. The clean version is a queued worker with deterministic gates,
strict JSON outputs, and API fallback, while `7000` remains the governor for live
and customer-impacting AI.
