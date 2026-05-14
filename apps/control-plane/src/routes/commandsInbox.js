"use strict";

const express = require("express");
const {
  approveInboxWorkflow,
  cancelInboxWorkflow,
  dncInboxWorkflow,
  editSendInboxWorkflow,
  regenerateInboxWorkflow,
  sleepInboxWorkflow,
  wakeInboxWorkflow,
} = require("../../../../packages/shared-services/src");
const {
  conversationMessageRepository,
} = require("../../../../packages/shared-repositories/src");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");

const DISPOSITION_LABELS = new Set([
  "approve",
  "send_as_is",
  "regenerate",
  "dnc_hard",
  "dnc_soft",
  "hostile",
  "spam",
  "already_client",
  "wrong_number",
]);

function createCommandsInboxRouter(auth) {
  const router = express.Router();

  // ── Rep-accessible reply actions ────────────────────────────────────
  // Approve / Edit-send / Regenerate are mounted with requireUser
  // (admin-or-user audience) BEFORE the admin gate so reps in the CX
  // shell can reply to hot-routed leads. The soft-lock check inside
  // each service (assertSmsLockAvailable) keeps two reps from racing.
  // Admins still pass through requireUser via its admin-superset
  // shortcut, so admin behaviour is unchanged.
  router.post(
    "/:domain/:workflowId/approve",
    auth.requireAuth,
    auth.requireUser,
    async (req, res) => {
      try {
        const result = await approveInboxWorkflow(req.params.domain, req.params.workflowId, req.user, req.body || {});
        return res.json({ ok: true, result });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  router.post(
    "/:domain/:workflowId/edit-send",
    auth.requireAuth,
    auth.requireUser,
    async (req, res) => {
      try {
        const result = await editSendInboxWorkflow(req.params.domain, req.params.workflowId, req.user, req.body || {});
        return res.json({ ok: true, result });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  router.post(
    "/:domain/:workflowId/regenerate",
    auth.requireAuth,
    auth.requireUser,
    async (req, res) => {
      try {
        const result = await regenerateInboxWorkflow(req.params.domain, req.params.workflowId, req.user, req.body || {});
        return res.json({ ok: true, result });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  // ── Admin-only policy actions ───────────────────────────────────────
  // Cancel / DNC / Sleep / Wake have lead-suppression / status-flip
  // side effects that should stay behind the admin gate. Reps escalate
  // these via review-queue items.
  router.use(auth.requireAuth, auth.requireAdmin);

  router.post("/:domain/:workflowId/cancel", async (req, res) => {
    try {
      const result = await cancelInboxWorkflow(req.params.domain, req.params.workflowId, req.user, req.body || {});
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/:domain/:workflowId/sleep", async (req, res) => {
    try {
      const result = await sleepInboxWorkflow(req.params.domain, req.params.workflowId, req.user, req.body || {});
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/:domain/:workflowId/wake", async (req, res) => {
    try {
      const result = await wakeInboxWorkflow(req.params.domain, req.params.workflowId, req.user, req.body || {});
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/:domain/:workflowId/dnc", async (req, res) => {
    try {
      const result = await dncInboxWorkflow(req.params.domain, req.params.workflowId, req.user, req.body || {});
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  // Per-message disposition. Independent of workflow-level status so
  // operators can tag a specific turn as "hostile" or "spam" without
  // flipping the whole thread. Workflow status stays operator-driven
  // via the other /:workflowId/* commands.
  router.post("/messages/:messageId/disposition", async (req, res) => {
    try {
      const label = String(req.body?.label || "").trim();
      if (!DISPOSITION_LABELS.has(label)) {
        return res.status(400).json({
          ok: false,
          error: `Unknown disposition label "${label}". Allowed: ${Array.from(DISPOSITION_LABELS).join(", ")}`,
        });
      }
      const message = await conversationMessageRepository.setDisposition(
        req.params.messageId,
        {
          label,
          setByEmail: req.user?.email || null,
          note: req.body?.note || null,
        },
      );
      if (!message) {
        return res.status(404).json({ ok: false, error: "Message not found" });
      }
      return res.json({ ok: true, result: message });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  return router;
}

module.exports = {
  createCommandsInboxRouter,
};
