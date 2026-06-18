"use strict";

// LOCAL synthetic AI bus — boots ONLY the task routes, with synthetic providers,
// no Mongo, no API keys, no live-server baggage. Lets us hit the real HTTP +
// runner + validation path and push realistic-shaped data to a client, zero spend.
//
//   node apps/ai-bus/src/localBusServer.js          (defaults to AI_BUS_PORT|7000)
//   AI_BUS_PORT=7010 node apps/ai-bus/src/localBusServer.js
//
// CORS is open so a local web-client can call it directly for a synthetic demo.
// NOT for production serving (every model is faked).

const http = require("http");
const { createAiTaskRunner } = require("../../../packages/shared-services/src/aiTaskRunner");
const { buildBusRegistry } = require("../../../packages/shared-services/src/aiBusRegistry");
const { createSyntheticProviders } = require("../../../packages/shared-services/src/aiSyntheticProvider");
const { runTask, listTasks, getTaskInfo } = require("./aiTaskRoutes");

// The named tasks are default-off in production; for the synthetic demo we turn
// them all on (no spend, synthetic provider).
function enableAllTasks(registry, env) {
  for (const t of registry.listTasks()) if (t.enabledEnv) env[t.enabledEnv] = "true";
  return env;
}

function startLocalBus({ port = Number(process.env.AI_BUS_PORT || 7000), telemetry = null } = {}) {
  const registry = buildBusRegistry();
  const env = enableAllTasks(registry, { ...process.env });
  const runner = createAiTaskRunner({ providers: createSyntheticProviders(), registry, telemetry, env });

  const cors = (res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-service-secret");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  };
  const send = (res, status, body) => {
    cors(res);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
      cors(res);
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "GET" && req.url === "/") {
      return send(res, 200, { ok: true, bus: "local-synthetic", note: "synthetic provider — no spend", tasks: registry.listTasks().length });
    }
    if (req.method === "GET" && req.url === "/api/ai/tasks") {
      const r = listTasks(registry);
      return send(res, r.status, r.json);
    }
    const info = req.method === "GET" && req.url.match(/^\/api\/ai\/tasks\/([^/]+)$/);
    if (info) {
      const r = getTaskInfo(registry, decodeURIComponent(info[1]));
      return send(res, r.status, r.json);
    }
    const run = req.method === "POST" && req.url.match(/^\/api\/ai\/tasks\/(.+)\/run$/);
    if (run) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        let parsed = {};
        try {
          parsed = JSON.parse(body || "{}");
        } catch {
          /* */
        }
        const r = await runTask(runner, decodeURIComponent(run[1]), parsed);
        send(res, r.status, r.json);
      });
      return;
    }
    send(res, 404, { ok: false, error: "not_found" });
  });

  server.listen(port, "127.0.0.1", () => {
    const p = server.address().port;
    // eslint-disable-next-line no-console
    console.log(`[ai-bus:local-synthetic] http://127.0.0.1:${p} — synthetic (no spend), ${registry.listTasks().length} tasks. Try: curl -s 127.0.0.1:${p}/api/ai/tasks`);
  });
  return server;
}

if (require.main === module) startLocalBus();

module.exports = { startLocalBus };
