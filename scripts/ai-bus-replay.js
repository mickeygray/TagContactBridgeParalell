"use strict";

// Replays the realistic request packets through a RUNNING bus over HTTP — the
// real route -> runner -> providers path. Against the synthetic local bus
// (npm run ai:bus:local) it proves plumbing with no spend; against the real bus
// (npm run ai:bus) with keys it shows real model output.
//
//   node scripts/ai-bus-replay.js                 # all fixtures vs http://localhost:7000
//   node scripts/ai-bus-replay.js --dry           # dry-run (resolved provider/model + request, no spend)
//   node scripts/ai-bus-replay.js --task ai.read  # one task
//   AI_BUS_URL=http://localhost:7000 INTERNAL_SERVICE_SECRET=... node scripts/ai-bus-replay.js
//
// NOTE: the HTTP route strips ignoreEnabled, so a default-OFF task returns
// {code:"disabled"} — enable it with AI_TASK_<ID>_ENABLED=true (or use the
// synthetic local bus, which enables tasks explicitly). The internal auth fails
// CLOSED without a secret unless the bus was booted with AI_BUS_ALLOW_INSECURE_LOCAL=true.

const fixtures = require("../tests/ai-bus/fixtures/realRequests");

const BASE = (process.env.AI_BUS_URL || "http://localhost:7000").replace(/\/$/, "");
const SECRET = String(process.env.INTERNAL_SERVICE_SECRET || "").trim();
const DRY = process.argv.includes("--dry");
const taskArgIdx = process.argv.indexOf("--task");
const ONLY = taskArgIdx >= 0 ? process.argv[taskArgIdx + 1] : null;

function headers() {
  const h = { "content-type": "application/json" };
  if (SECRET) h["x-service-secret"] = SECRET;
  return h;
}
function preview(value, n = 400) {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s && s.length > n ? `${s.slice(0, n)}…` : s;
}

async function getTasks() {
  try {
    const res = await fetch(`${BASE}/api/ai/tasks`, { headers: headers() });
    if (res.status === 401) return { authFailed: true };
    const body = await res.json();
    return { tasks: body.tasks || [] };
  } catch (e) {
    return { error: e.message };
  }
}

async function runOne(fx) {
  const options = { ...(fx.options || {}), ...(DRY ? { dryRun: true } : {}) };
  const t0 = Date.now();
  let res, body;
  try {
    res = await fetch(`${BASE}/api/ai/tasks/${encodeURIComponent(fx.taskId)}/run`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ payload: fx.payload, options }),
    });
    body = await res.json();
  } catch (e) {
    console.log(`\n=== ${fx.taskId} ===\n  TRANSPORT ERROR: ${e.message} (is the bus up at ${BASE}?)`);
    return;
  }
  const ms = Date.now() - t0;
  console.log(`\n=== ${fx.taskId} ===  [${res.status}, ${ms}ms]`);
  console.log(`  note: ${fx.note}`);
  console.log(`  IN  : ${preview(fx.payload, 200)}`);
  if (body.code === "disabled") {
    const flag = `AI_TASK_${fx.taskId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_ENABLED`;
    console.log(`  OUT : disabled — enable with ${flag}=true (or run the synthetic local bus).`);
    return;
  }
  if (body.dryRun) {
    console.log(`  RESOLVED: provider=${body.provider} model=${body.model}`);
    console.log(`  REQUEST : system=${preview(body.request && body.request.system, 160)}`);
    console.log(`            user=${preview((body.request && (body.request.user ?? body.request.input ?? body.request.prompt)) || "", 200)}`);
    return;
  }
  console.log(`  OUT : ok=${body.ok} provider=${body.provider} model=${body.model} busMs=${body.timing && body.timing.busMs}`);
  if (body.ok) console.log(`  result: ${preview(body.result)}`);
  else console.log(`  code=${body.code} safeFallback=${preview(body.safeFallback, 160)} attempts=${preview(body.attempts, 200)}`);
}

(async () => {
  console.log(`bus: ${BASE}  ${SECRET ? "(secret set)" : "(no secret — needs AI_BUS_ALLOW_INSECURE_LOCAL=true on the bus)"}  ${DRY ? "[DRY RUN]" : ""}`);
  const info = await getTasks();
  if (info.authFailed) {
    console.log("GET /api/ai/tasks -> 401. Set INTERNAL_SERVICE_SECRET (and match the bus), or boot the bus with AI_BUS_ALLOW_INSECURE_LOCAL=true.");
    process.exit(1);
  }
  if (info.error) {
    console.log(`Could not reach the bus: ${info.error}. Start it with: AI_BUS_ALLOW_INSECURE_LOCAL=true npm run ai:bus`);
    process.exit(1);
  }
  if (info.tasks) {
    const enabled = info.tasks.filter((t) => t.enabled).map((t) => t.id);
    console.log(`tasks: ${info.tasks.length} total, ${enabled.length} enabled${enabled.length ? ` (${enabled.join(", ")})` : ""}`);
  }
  const list = ONLY ? fixtures.filter((f) => f.taskId === ONLY) : fixtures;
  if (!list.length) {
    console.log(`No fixture for task "${ONLY}". Available: ${fixtures.map((f) => f.taskId).join(", ")}`);
    process.exit(1);
  }
  for (const fx of list) await runOne(fx);
  console.log("\ndone.");
})();
