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

function normalizeDomain(value) {
  return String(value || "").trim().toUpperCase();
}

function allowedInboxDomainsForUser(user = {}) {
  const domains = new Set();
  const add = (value) => {
    const domain = normalizeDomain(value);
    if (domain) domains.add(domain);
  };
  add(user.company);
  for (const shell of Array.isArray(user.exShells) ? user.exShells : []) {
    add(shell?.company);
  }
  if (user.tagLogicsId || user.tagEmail) add("TAG");
  if (user.wynnLogicsId || user.wynnEmail) add("WYNN");
  return domains;
}

function hasInboxDomainAccess(user, domain) {
  if (user?.role === "admin") return true;
  if (!user?.permissions?.includes?.("inbox.action")) return false;
  return allowedInboxDomainsForUser(user).has(normalizeDomain(domain));
}

function requireInboxDomainAccess(req, res, next) {
  const requestedDomain = normalizeDomain(req.params?.domain);
  if (!requestedDomain) {
    return res.status(400).json({ ok: false, error: "domain is required" });
  }
  if (!hasInboxDomainAccess(req.user, requestedDomain)) {
    return res.status(403).json({ ok: false, error: "Inbox domain access denied" });
  }
  return next();
}

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
    requireInboxDomainAccess,
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
    requireInboxDomainAccess,
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
    requireInboxDomainAccess,
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
  // Per-message disposition. Rep-accessible: this is the lightweight
  // training/triage label surface in the agent inbox, not a lead-wide
  // suppression command.
  router.post(
    "/messages/:messageId/disposition",
    auth.requireAuth,
    auth.requireUser,
    async (req, res) => {
      try {
        const label = String(req.body?.label || "").trim();
        if (!DISPOSITION_LABELS.has(label)) {
          return res.status(400).json({
            ok: false,
            error: `Unknown disposition label "${label}". Allowed: ${Array.from(DISPOSITION_LABELS).join(", ")}`,
          });
        }
        const existing = await conversationMessageRepository.findMessageById(req.params.messageId);
        if (!existing) {
          return res.status(404).json({ ok: false, error: "Message not found" });
        }
        if (!hasInboxDomainAccess(req.user, existing.domain)) {
          return res.status(403).json({ ok: false, error: "Inbox domain access denied" });
        }
        const message = await conversationMessageRepository.setDisposition(
          req.params.messageId,
          {
            label,
            setByEmail: req.user?.email || null,
            note: req.body?.note || null,
          },
        );
        return res.json({ ok: true, result: message });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

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

  return router;
}

module.exports = {
  createCommandsInboxRouter,
};
