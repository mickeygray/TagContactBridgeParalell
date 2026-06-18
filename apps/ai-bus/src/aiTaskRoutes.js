"use strict";

// AI task routes — the destination on 7000. The bus exposes the generic task
// surface here. Handlers are PURE ({status, json}) so they're testable without a
// server and can be driven by express OR raw http; mountAiTaskRoutes wires them
// onto the express app server.js already has.
//
// The run handler stamps `busMs` (time spent inside runAiTask: model + failover +
// validation) into the envelope so the client can derive transport overhead.

// Options arriving over the wire are UNTRUSTED. Strip server-only privileged
// flags before they reach the runner: `ignoreEnabled` would bypass the default-off
// gate (run a disabled task / leak spend), and `validate` could inject a broken
// validator that fails every attempt. In-process callers (tests, local synthetic
// bus, server code) call runner.runAiTask directly and keep full control.
const PRIVILEGED_OPTION_KEYS = ["ignoreEnabled", "validate"];
function sanitizeClientOptions(options) {
  if (!options || typeof options !== "object") return {};
  const safe = {};
  for (const [k, v] of Object.entries(options)) {
    if (!PRIVILEGED_OPTION_KEYS.includes(k)) safe[k] = v;
  }
  return safe;
}

function runTask(runner, taskId, reqBody = {}, now = () => Date.now(), { signal } = {}) {
  const t0 = now();
  // Server-derived abort signal (request closed) is added AFTER sanitizing, so a
  // client can't inject one but a real caller-disconnect still bounds spend.
  const options = sanitizeClientOptions(reqBody.options);
  if (signal) options.signal = signal;
  return Promise.resolve(runner.runAiTask(taskId, reqBody.payload || {}, options)).then((out) => {
    const busMs = now() - t0;
    return { status: 200, json: { ...out, timing: { ...(out.timing || {}), busMs } } };
  });
}

function listTasks(registry) {
  const tasks = registry.listTasks().map((t) => registry.describeTask(t));
  return { status: 200, json: { ok: true, tasks } };
}

function getTaskInfo(registry, taskId) {
  const t = registry.getTask(taskId);
  if (!t) return { status: 404, json: { ok: false, error: "unknown_task" } };
  return { status: 200, json: { ok: true, task: registry.describeTask(t) } };
}

// Mount on an express-style app. `auth` is the internal-access middleware
// (requireInternalAccess); defaults to a no-op for local/test use.
function mountAiTaskRoutes(app, { runner, registry, auth, allowUnauthenticated = false, now } = {}) {
  // Fail safe: refuse to expose unauthenticated AI task routes unless the caller
  // EXPLICITLY opts in (local/test). In production always pass requireInternalAccess.
  if (typeof auth !== "function" && !allowUnauthenticated) {
    throw new Error("mountAiTaskRoutes: an `auth` middleware is required (or pass allowUnauthenticated:true for local/test)");
  }
  const guard = typeof auth === "function" ? auth : (req, res, next) => next();

  app.get("/api/ai/tasks", guard, (req, res) => {
    const r = listTasks(registry);
    res.status(r.status).json(r.json);
  });

  app.get("/api/ai/tasks/:taskId", guard, (req, res) => {
    const r = getTaskInfo(registry, req.params.taskId);
    res.status(r.status).json(r.json);
  });

  app.post("/api/ai/tasks/:taskId/run", guard, async (req, res, next) => {
    // Propagate caller-disconnect into the runner so it won't START another
    // provider attempt after the client (e.g. 5001) has already timed out and
    // given up — bounding wasted token spend to the in-flight attempt.
    const controller = new AbortController();
    const onClose = () => controller.abort();
    req.on("close", onClose);
    try {
      const r = await runTask(runner, req.params.taskId, req.body || {}, now, { signal: controller.signal });
      if (!res.writableEnded) res.status(r.status).json(r.json);
    } catch (err) {
      next(err);
    } finally {
      req.off?.("close", onClose);
    }
  });
}

module.exports = { mountAiTaskRoutes, runTask, listTasks, getTaskInfo };
