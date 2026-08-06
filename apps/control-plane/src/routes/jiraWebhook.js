"use strict";

const crypto = require("crypto");
const express = require("express");

const {
  bridgeJiraIssue,
} = require("../../../../packages/shared-services/src/jiraTaskBridgeService");
const { createLogicsClient } = require("../../../../packages/shared-integrations/src");
const { createLogicsFacade } = require("../../../../packages/shared-services/src/logicsFacadeService");
const JiraTaskLink = require("../../../../packages/shared-models/src/JiraTaskLink");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");

/**
 * Jira -> Logics task bridge.
 *
 * ── WHY IT ACKNOWLEDGES BEFORE IT WORKS ─────────────────────────────────────
 *
 * Jira retries any webhook it does not get a prompt 2xx for. The destination is
 * create-only — no update, no delete — so a retry that arrives while the first
 * attempt is still talking to Logics would create the task twice, and neither copy
 * could be withdrawn.
 *
 * So the handler answers 200 the moment the payload is validated and does the work
 * afterwards. The response means "received", never "created". The durable record of
 * what actually happened is JiraTaskLink, whose unique key is the Jira issue key —
 * so even two genuinely concurrent deliveries converge on one task at the database
 * rather than in application logic that could race with itself.
 */

const unwrap = (res) => {
  const d = res?.data ?? res;
  return Array.isArray(d) ? d[0] : d;
};

const dayStr = (ms) => new Date(ms).toISOString().slice(0, 10);

function timingSafeEqual(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  if (x.length !== y.length || !x.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/**
 * Jira Cloud signs the raw body with the secret configured on the webhook and sends
 * it as `X-Hub-Signature: sha256=<hex>`. A shared-secret header is accepted too, for
 * the automation-rule path which cannot sign.
 *
 * With no secret configured this REFUSES rather than waving traffic through. An
 * unauthenticated endpoint that writes permanent records into a production case
 * management system is not something to leave open by default.
 */
function buildVerifier(logger) {
  const secret = String(process.env.JIRA_WEBHOOK_SECRET || "").trim();
  return (req, res, next) => {
    if (!secret) {
      logger?.error?.("jira.webhook.rejected", { reason: "JIRA_WEBHOOK_SECRET not set" });
      return res.status(503).json({ ok: false, error: "Jira webhook is not configured" });
    }

    const header = String(req.get("X-Hub-Signature") || "").trim();
    if (header) {
      const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
      const expected = `sha256=${crypto.createHmac("sha256", secret).update(raw).digest("hex")}`;
      if (timingSafeEqual(header, expected)) return next();
      logger?.warn?.("jira.webhook.rejected", { reason: "signature_mismatch" });
      return res.status(401).json({ ok: false, error: "Invalid signature" });
    }

    const token = String(req.headers["x-jira-webhook-secret"] || req.headers["x-webhook-secret"] || "").trim();
    if (token && timingSafeEqual(token, secret)) return next();

    logger?.warn?.("jira.webhook.rejected", { reason: "no signature or token" });
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  };
}

/**
 * Real Logics wiring. Kept here rather than in the service so the service stays
 * testable without a network.
 */
function buildDeps({ logger } = {}) {
  const facades = new Map();
  const clients = new Map();
  const facade = (t) => {
    if (!facades.has(t)) facades.set(t, createLogicsFacade(t));
    return facades.get(t);
  };
  const client = (t) => {
    if (!clients.has(t)) clients.set(t, createLogicsClient(t));
    return clients.get(t);
  };

  return {
    fetchCase: async (tenant, caseId) => unwrap(await facade(tenant).fetchCaseInfo(caseId)),

    /**
     * Open tasks on a case. The route filters on DUE DATE, so the window reaches
     * FORWARD as well as back — an outstanding task is typically due in the future,
     * and a backwards-only window cannot see the live queue at all. StatusID 0 is
     * open; a completed task is not a reason to withhold new work.
     */
    listOpenTasks: async (tenant, caseId) => {
      const now = Date.now();
      const out = [];
      for (const [from, to] of [[-240, -60], [-60, 60], [60, 240]]) {
        let res;
        try {
          res = await client(tenant).getTasksByDateRange(
            dayStr(now + from * 86400000), dayStr(now + to * 86400000),
          );
        } catch (error) {
          logger?.warn?.("jira.webhook.open_tasks_window_failed", {
            tenant, error: String(error.message).slice(0, 120),
          });
          continue;
        }
        const rows = res?.Data ?? res?.data ?? res;
        if (!Array.isArray(rows)) continue;
        for (const r of rows) {
          if (r.Deleted || Number(r.StatusID) !== 0) continue;
          if (Number(r.CaseID) !== Number(caseId)) continue;
          out.push({
            taskId: r.TaskID,
            subject: String(r.Subject || ""),
            // Needed to tell whether tax prep already holds this case.
            users: (r.Users || []).map((u) => u.FullName).filter(Boolean),
          });
        }
      }
      return out;
    },

    createTask: (tenant, payload) => client(tenant).createTask(payload),

    /**
     * Comment back on the Jira issue. This is the "alert them" half — when the case is
     * already held in Logics we do not create a task, so without a comment the person
     * who raised the ticket would simply never hear anything and would assume it was
     * lost.
     *
     * Jira, unlike Logics, is safely writable: a comment can be edited or deleted.
     */
    commentOnIssue: async (jiraKey, text) => {
      const token = String(process.env.JIRA_API_TOKEN || "").trim();
      const email = String(process.env.JIRA_USER_EMAIL || "mgray@taxadvocategroup.com").trim();
      const base = String(process.env.JIRA_BASE_URL || "https://taxadvocategroup.atlassian.net").trim();
      if (!token) throw new Error("JIRA_API_TOKEN is not set");
      const res = await fetch(`${base}/rest/api/3/issue/${encodeURIComponent(jiraKey)}/comment`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          body: {
            type: "doc",
            version: 1,
            // Each line becomes its own paragraph. Atlassian document format has no
            // newline character inside a text node, so a "\n" in the string would
            // simply vanish and the comment would render as one run-on line.
            content: String(text).split("\n").map((line) => ({
              type: "paragraph",
              content: line ? [{ type: "text", text: line }] : [],
            })),
          },
        }),
      });
      if (!res.ok) throw new Error(`Jira comment failed ${res.status}`);
      return true;
    },

    findLink: (jiraKey) => JiraTaskLink.findById(jiraKey).lean(),

    recordLink: async (link) => {
      const { jiraKey, payload, ...rest } = link;
      await JiraTaskLink.findByIdAndUpdate(
        jiraKey,
        { $set: { ...rest, lastAttemptAt: new Date() }, $inc: { attempts: 1 } },
        { upsert: true, setDefaultsOnInsert: true },
      );
    },
  };
}

/** Only these events produce work. Everything else is acknowledged and ignored. */
const HANDLED = new Set(["jira:issue_created", "jira:issue_updated"]);

function createJiraWebhookRouter(auth, runtime = {}) {
  const router = express.Router();
  const logger = runtime.logger;
  const verify = buildVerifier(logger);
  const deps = buildDeps({ logger });

  const enabled = () => String(process.env.JIRA_TASK_BRIDGE_ENABLED || "").toLowerCase() === "true";

  router.post("/webhook", verify, async (req, res) => {
    const event = String(req.body?.webhookEvent || "");
    const issue = req.body?.issue;

    // Acknowledge FIRST. Jira retries anything it does not get a 2xx for, and a
    // retry against a create-only destination is a duplicate that cannot be undone.
    res.json({ ok: true, received: event, key: issue?.key || null });

    if (!HANDLED.has(event) || !issue?.key) return;

    try {
      const decision = await bridgeJiraIssue({
        issue,
        deps,
        // The flag is the safety catch: wired up and receiving, but writing nothing
        // until somebody turns it on deliberately.
        apply: enabled(),
        trigger: event,
      });
      await deps.recordLink(decision);
      logger?.info?.("jira.webhook.bridged", {
        key: issue.key, outcome: decision.outcome, tenant: decision.tenant || null,
        subject: decision.subject || null, taskId: decision.logicsTaskId || null,
        reason: decision.reason || null,
      });

      // The case is already held in Logics, so no task was created. Say so on the
      // Jira issue — otherwise the person who raised it hears nothing and reasonably
      // concludes the bridge dropped it. Failing to comment must not fail the run:
      // the task decision is already made and recorded.
      if (decision.notify) {
        const n = decision.notify;
        // Addressed to the person who already holds the task, and says the one thing
        // they need to do. The Logics task id is deliberately absent — they will find
        // it on the case, and naming it invites correcting the wrong one.
        const text = [
          `A new Task in Jira was posted in your name, for ${n.notes || n.wouldHaveBeen}`,
          "",
          `Please Update ${decision.caseId} in ${decision.tenant} with ${n.wouldHaveBeen}`,
        ].join("\n");
        try {
          if (enabled()) await deps.commentOnIssue(issue.key, text);
          logger?.info?.("jira.webhook.notified", { key: issue.key, taskId: n.taskId, owner: n.owner || null });
        } catch (error) {
          logger?.warn?.("jira.webhook.notify_failed", {
            key: issue.key, error: String(error.message).slice(0, 160),
          });
        }
      }
    } catch (error) {
      logger?.error?.("jira.webhook.failed", {
        key: issue.key, error: String(error.message).slice(0, 200),
      });
      try {
        await deps.recordLink({
          jiraKey: issue.key, outcome: "failed",
          reason: String(error.message).slice(0, 200), trigger: event,
        });
      } catch { /* the log above is the record of last resort */ }
    }
  });

  /** What the bridge has been doing. First stop when a ticket did not come through. */
  router.get("/links", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 500);
      const where = {};
      if (req.query.outcome) where.outcome = String(req.query.outcome);
      if (req.query.key) where._id = String(req.query.key);
      const rows = await JiraTaskLink.find(where).sort({ createdAt: -1 }).limit(limit).lean();
      return res.json({ ok: true, enabled: enabled(), count: rows.length, links: rows });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  /** Replay one issue by key — for a ticket that was fixed after being skipped. */
  router.post("/replay/:key", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const issue = req.body?.issue;
      if (!issue?.key) {
        return res.status(400).json({ ok: false, error: "an issue payload is required" });
      }
      const decision = await bridgeJiraIssue({
        issue, deps, apply: req.query.apply === "true" && enabled(), trigger: "replay",
      });
      await deps.recordLink(decision);
      return res.json({ ok: true, decision });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  return router;
}

module.exports = { createJiraWebhookRouter, buildDeps, buildVerifier };
