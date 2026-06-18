"use strict";

// Probe realistic request shapes against the AI bus and measure what comes back.
//
// The probes intentionally mirror caller-facing shapes:
//   - coach: current dedicated live-coach fixture route
//   - blogger: ai.write primitive with the blog draft schema
//   - sms: named sms.classify bus task
//   - resolution: current dedicated resolution pitch route
//   - client-check: named activity.contactSafetyReview bus task
//
// Usage:
//   node scripts/ai-bus-shape-probes.js
//   node scripts/ai-bus-shape-probes.js --only coach,sms
//   node scripts/ai-bus-shape-probes.js --dry
//
// Notes:
//   - Generic /api/ai/tasks probes require the matching AI_TASK_*_ENABLED flags.
//   - Dedicated coach/resolution routes do not support dry-run; --dry skips them.
//   - Secrets are read for auth but never printed.

const fs = require("fs");
const path = require("path");

const schemas = require("../packages/shared-services/src/aiSandbox/schemas");

const BASE = String(process.env.AI_BUS_URL || "http://127.0.0.1:7000").replace(/\/+$/, "");
const ARGS = new Set(process.argv.slice(2));
const DRY = ARGS.has("--dry");
const ONLY = (() => {
  const i = process.argv.indexOf("--only");
  if (i < 0 || !process.argv[i + 1]) return null;
  return new Set(
    String(process.argv[i + 1])
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
})();

function readDotEnv() {
  const envPath = path.join(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return {};
  const out = {};
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    value = value.replace(/^['"]|['"]$/g, "");
    out[key] = value;
  }
  return out;
}

const dotenv = readDotEnv();
const SECRET =
  process.env.INTERNAL_SERVICE_SECRET ||
  process.env.AI_BUS_SERVICE_SECRET ||
  process.env.CONTROL_PLANE_SECRET ||
  dotenv.INTERNAL_SERVICE_SECRET ||
  dotenv.AI_BUS_SERVICE_SECRET ||
  dotenv.CONTROL_PLANE_SECRET ||
  "";

function headers() {
  return {
    "content-type": "application/json",
    ...(SECRET ? { "x-service-secret": String(SECRET) } : {}),
  };
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function preview(value, limit = 900) {
  if (value === undefined) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return text;
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function pickResult(body) {
  if (!body || typeof body !== "object") return body;
  if (body.result !== undefined) return body.result;
  if (body.text !== undefined) return body.text;
  if (body.strategy !== undefined) return body.strategy;
  if (body.session?.latest) return body.session.latest;
  return body;
}

function summarize(name, pathOrTask, elapsedMs, status, body) {
  return {
    name,
    target: pathOrTask,
    httpStatus: status,
    elapsedMs,
    ok: Boolean(body?.ok),
    code: body?.code || body?.error || null,
    provider: body?.provider || null,
    model: body?.model || null,
    taskTiming: body?.timing || null,
    serviceElapsedMs: body?.elapsedMs || null,
    usage: body?.usage || null,
    preview: preview(pickResult(body)),
  };
}

async function postJson(pathname, body) {
  const started = Date.now();
  const res = await fetch(`${BASE}${pathname}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { ok: false, raw: text };
  }
  return { status: res.status, elapsedMs: Date.now() - started, body: parsed };
}

async function getJson(pathname) {
  const res = await fetch(`${BASE}${pathname}`, { headers: headers() });
  const text = await res.text();
  try {
    return { status: res.status, body: text ? JSON.parse(text) : null };
  } catch {
    return { status: res.status, body: { raw: text } };
  }
}

async function runTask(name, taskId, payload, options = {}) {
  const body = {
    payload,
    options: {
      label: `${name}.shape_probe`,
      timeoutMs: options.timeoutMs || 45000,
      ...(DRY ? { dryRun: true } : {}),
      ...options,
    },
  };
  const r = await postJson(`/api/ai/tasks/${encodeURIComponent(taskId)}/run`, body);
  return summarize(name, taskId, r.elapsedMs, r.status, r.body);
}

async function runRoute(name, pathname, body) {
  if (DRY) {
    return {
      name,
      target: pathname,
      skipped: true,
      reason: "direct routes do not support dry-run",
    };
  }
  const r = await postJson(pathname, body);
  return summarize(name, pathname, r.elapsedMs, r.status, r.body);
}

async function runCoachProbe() {
  if (DRY) {
    return {
      name: "coach",
      target: "/api/ai/live-coach/fixture",
      skipped: true,
      reason: "direct routes do not support dry-run",
    };
  }

  const started = Date.now();
  const initial = await postJson("/api/ai/live-coach/fixture", {
    agentName: "Chris Bolt",
    agentEmail: "cbolt@local",
    firmName: "Wynn Tax Solutions",
    uii: `shape-probe-${Date.now()}`,
    role: "prospect",
    text: sampleCoachText,
  });
  const sessionId = initial.body?.session?.id || initial.body?.sessionId || "";
  let sessionBody = initial.body?.session || null;
  let settled = Boolean(sessionBody?.latest?.dialog?.status === "ready" || sessionBody?.latest?.dialog?.status === "rejected");

  for (let i = 0; sessionId && !settled && i < 40; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const poll = await getJson(`/api/ai/live-coach/grpc/sessions/${encodeURIComponent(sessionId)}`);
    sessionBody = poll.body?.session || sessionBody;
    settled = Boolean(
      sessionBody?.latest?.dialog?.status === "ready" ||
        sessionBody?.latest?.dialog?.status === "rejected",
    );
  }

  const latest = sessionBody?.latest || {};
  const timings = latest.turnTimings || {};
  const sinceVad = (stamp) => {
    if (!timings.vadFinalAt || !stamp) return null;
    const a = Date.parse(timings.vadFinalAt);
    const b = Date.parse(stamp);
    return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, b - a) : null;
  };

  return {
    name: "coach",
    target: "/api/ai/live-coach/fixture",
    httpStatus: initial.status,
    elapsedMs: Date.now() - started,
    initialAckMs: initial.elapsedMs,
    ok: Boolean(initial.body?.ok),
    settled,
    sessionId: sessionId || null,
    miniMs: timings.miniMs || null,
    firstDeltaFromVadMs: sinceVad(timings.firstDeltaAt),
    settledFromVadMs: sinceVad(timings.settledAt),
    contextModel: latest.context?.miniJudgement?.model || null,
    composer: latest.dialog?.composer || null,
    model: latest.dialog?.model || null,
    usage: {
      mini: latest.context?.miniJudgement?.usage || null,
      composer: latest.dialog?.usage || null,
    },
    preview: preview({
      transcript: latest.transcript?.text || null,
      contextBrief: latest.context?.miniJudgement?.transcriptMeaning || latest.context?.actionReason || null,
      selectedKeys: latest.context?.miniJudgement?.selectedKeys || latest.context?.matches?.map((m) => m.key) || [],
      dialog: latest.dialog?.say || null,
    }),
  };
}

const sampleCoachText =
  "I owe the IRS around forty thousand dollars and I just got a CP504. " +
  "I am scared they are going to levy my paycheck, but I need to know what this will cost before I talk to anyone.";

const probes = [
  {
    name: "coach",
    run: runCoachProbe,
  },
  {
    name: "blogger",
    run: () =>
      runTask(
        "blogger",
        "ai.write",
        {
          system: [
            "You write structured tax blog drafts for Wynn Tax Solutions.",
            "Return JSON only. Keep the draft useful, plain-English, and compliant.",
            "No legal advice, no guarantees, no invented current facts.",
          ].join("\n"),
          input: [
            "Topic: 1099-K from Venmo, PayPal, Etsy: what the lower threshold actually means for you.",
            "Audience: self-employed people, side-hustle sellers, and taxpayers who got surprised by payment app reporting.",
            "Write a short practical draft with a disclaimer first and a bottom-line paragraph last.",
          ].join("\n"),
          schema: schemas.SUBMIT_BLOG_DRAFT.input_schema,
          maxTokens: 1800,
          temperature: 0.2,
        },
        { forceProvider: "anthropic", kind: "json", timeoutMs: 45000 },
      ),
  },
  {
    name: "sms",
    run: () =>
      runTask(
        "sms",
        "sms.classify",
        {
          input:
            "I got a CP504 and I am worried they will take my check. How much does your service cost and can someone call me today?",
        },
        { timeoutMs: 30000 },
      ),
  },
  {
    name: "resolution",
    run: () =>
      runRoute("resolution", "/api/ai/resolution/pitch", {
        dossier: {
          domain: "WYNN",
          caseNumber: "shape-probe-101260",
          name: "Sample Client",
          currentStatus: "active client",
          payments: { lastPaymentStatus: "delinquent", lastPaymentAmount: 500, daysLate: 18 },
          noticesReceived: ["CP504"],
          liabilities: [{ agency: "IRS", years: "2019-2021", balance: 48200 }],
          profile: {
            employment: "W2",
            incomeMonthly: 6200,
            filingStatus: "single",
            temperature: "worried but reachable",
          },
        },
        thread: [
          { role: "user", content: "Client says the IRS notice scared them but they are worried about adding another monthly payment." },
        ],
        ask: "What is the best upsell/resolution angle, and what should the rep avoid saying?",
      }),
  },
  {
    name: "client-check",
    run: () =>
      runTask(
        "client-check",
        "activity.contactSafetyReview",
        {
          domain: "TAG",
          caseId: "shape-probe-778412",
          activities: [
            {
              ActivityType: "Note",
              Subject: "Inbound",
              Comment: "Client called about a CP504 notice and wants help understanding levy risk.",
              CreatedDate: "2026-06-16",
            },
            {
              ActivityType: "Note",
              Subject: "Attorney letter",
              Comment: "Received cease and desist; client says they are represented by counsel and not to contact directly.",
              CreatedDate: "2026-06-17",
            },
          ],
        },
        { timeoutMs: 30000 },
      ),
  },
];

(async () => {
  console.log(`AI bus: ${BASE} ${SECRET ? "(secret loaded)" : "(no secret loaded)"}`);
  const taskList = await getJson("/api/ai/tasks");
  if (taskList.status === 401) {
    console.log("GET /api/ai/tasks -> 401. Set INTERNAL_SERVICE_SECRET or match the local .env secret.");
    process.exit(1);
  }
  if (taskList.body?.tasks) {
    const enabled = taskList.body.tasks.filter((t) => t.enabled).map((t) => t.id);
    console.log(`tasks: ${taskList.body.tasks.length} total, ${enabled.length} enabled${enabled.length ? ` (${enabled.join(", ")})` : ""}`);
  }

  const selected = ONLY ? probes.filter((p) => ONLY.has(p.name)) : probes;
  if (!selected.length) {
    console.log(`No matching probes. Available: ${probes.map((p) => p.name).join(", ")}`);
    process.exit(1);
  }

  const results = [];
  for (const probe of selected) {
    console.log(`\n== ${probe.name} ==`);
    try {
      const result = await probe.run();
      results.push(result);
      console.log(JSON.stringify(result, null, 2));
      if (result.code === "disabled") {
        const target = result.target || "";
        const flag = `AI_TASK_${String(target).toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_ENABLED`;
        console.log(`enable flag: ${flag}=true`);
      }
    } catch (error) {
      const result = { name: probe.name, ok: false, error: error.message };
      results.push(result);
      console.log(JSON.stringify(result, null, 2));
    }
  }

  const outDir = path.join(process.cwd(), "runtime", "ai-bus-probes");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${nowStamp()}-shape-probes.json`);
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        base: BASE,
        dryRun: DRY,
        results,
      },
      null,
      2,
    ),
  );
  console.log(`\nsaved: ${outPath}`);
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
