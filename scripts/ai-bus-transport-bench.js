"use strict";

// AI bus TRANSPORT benchmark — "time it reading somewhere else."
//
// Boots a minimal in-process bus (the real runTask route handler over a runner
// with INSTANT fake providers) and hammers it through the real aiTaskClient on
// loopback. Because we use dryRun (no model) the round-trip IS the pure delivery
// overhead: serialization + loopback + the other process. Run:
//
//   node scripts/ai-bus-transport-bench.js
//
// Measures: pure transport (small vs large payload), transport+trivial-bus, and
// keep-alive vs new-connection — so we can plan efficiency in info delivery.

const http = require("http");
const { createAiTaskRunner } = require("../packages/shared-services/src/aiTaskRunner");
const registry = require("../packages/shared-services/src/aiTaskRegistry");
const { runTask } = require("../apps/ai-bus/src/aiTaskRoutes");
const { createAiTaskClient } = require("../packages/shared-services/src/aiTaskClient");

const hrNow = () => Number(process.hrtime.bigint()) / 1e6; // ms float
const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
const f = (n) => n.toFixed(3);

const N = Number(process.env.BENCH_N || 300);
const WARMUP = Number(process.env.BENCH_WARMUP || 50);

function instantAdapter() {
  return { id: "instant", supports: () => true, run: async () => ({ json: { ok: true }, text: "ok", model: "instant" }) };
}

async function main() {
  const runner = createAiTaskRunner({ providers: { anthropic: instantAdapter(), openai: instantAdapter() }, registry, env: {} });

  const server = http.createServer((req, res) => {
    const m = req.url.match(/^\/api\/ai\/tasks\/(.+)\/run$/);
    if (req.method === "POST" && m) {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", async () => {
        let parsed = {};
        try {
          parsed = JSON.parse(b || "{}");
        } catch {
          /* */
        }
        const r = await runTask(runner, decodeURIComponent(m[1]), parsed, hrNow);
        const out = JSON.stringify(r.json);
        res.writeHead(r.status, { "content-type": "application/json", "content-length": Buffer.byteLength(out) });
        res.end(out);
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const client = createAiTaskClient({ baseUrl: `http://127.0.0.1:${port}`, secret: "", now: hrNow });

  const small = { input: "I got a CP504, can you help?" };
  const large = { input: "x".repeat(50_000) }; // ~50 KB of "info"

  async function measureClient(label, payload, options) {
    for (let k = 0; k < WARMUP; k++) await client.runAiTask("ai.read", payload, options);
    const rt = [];
    const tp = [];
    for (let k = 0; k < N; k++) {
      const r = await client.runAiTask("ai.read", payload, options);
      rt.push(r.timing.roundTripMs);
      tp.push(r.timing.transportMs);
    }
    return { label, rt, tp };
  }

  function rawPost(agent, payload) {
    const data = JSON.stringify({ payload, options: { dryRun: true } });
    return new Promise((resolve, reject) => {
      const t0 = process.hrtime.bigint();
      const req = http.request(
        { host: "127.0.0.1", port, method: "POST", path: "/api/ai/tasks/ai.read/run", agent, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } },
        (res) => {
          let buf = "";
          res.on("data", (c) => (buf += c));
          res.on("end", () => resolve(Number(process.hrtime.bigint() - t0) / 1e6));
        },
      );
      req.on("error", reject);
      req.write(data);
      req.end();
    });
  }
  async function measureRaw(label, agent) {
    for (let k = 0; k < WARMUP; k++) await rawPost(agent, small);
    const rt = [];
    for (let k = 0; k < N; k++) rt.push(await rawPost(agent, small));
    return { label, rt };
  }

  const results = [];
  results.push(await measureClient("client dryRun small (pure transport)", small, { dryRun: true }));
  results.push(await measureClient("client dryRun LARGE ~50KB (transport + big info)", large, { dryRun: true }));
  results.push(await measureClient("client instant task (transport + trivial bus)", small, {}));

  const keepAlive = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const rawKeepAlive = await measureRaw("raw http keep-alive (reused conn)", keepAlive);
  const rawNewConn = await measureRaw("raw http NEW connection each call", false);
  keepAlive.destroy();

  console.log(`\nAI bus transport benchmark  (loopback, N=${N}, warmup=${WARMUP}, dryRun=no model)\n`);
  console.log("client round-trip + isolated transport (ms):");
  console.log("  " + "scenario".padEnd(48), "rt_p50  rt_p95  rt_mean | tp_p50  tp_p95");
  for (const r of results) {
    console.log(
      "  " + r.label.padEnd(48),
      `${f(pct(r.rt, 50))}   ${f(pct(r.rt, 95))}   ${f(mean(r.rt))}  | ${f(pct(r.tp, 50))}   ${f(pct(r.tp, 95))}`,
    );
  }
  console.log("\nconnection-reuse lever (raw http POST, ms):");
  for (const r of [rawKeepAlive, rawNewConn]) {
    console.log("  " + r.label.padEnd(48), `p50 ${f(pct(r.rt, 50))}   p95 ${f(pct(r.rt, 95))}   mean ${f(mean(r.rt))}`);
  }

  const baseline = pct(results[0].tp, 50);
  const largeT = pct(results[1].tp, 50);
  const reuseDelta = mean(rawNewConn.rt) - mean(rawKeepAlive.rt);
  console.log(
    `\nread: a cross-process AI call costs ~${f(baseline)}ms transport at the median on loopback;` +
      ` a ~50KB payload adds ~${f(largeT - baseline)}ms; reusing the connection saves ~${f(reuseDelta)}ms/call vs a fresh connect.`,
  );

  await new Promise((r) => server.close(r));
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
