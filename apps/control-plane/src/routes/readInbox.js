"use strict";

const express = require("express");
const { buildInboxWorkspace } = require("../../../../packages/shared-services/src");
const {
  conversationMessageRepository,
  conversationWorkflowRepository,
} = require("../../../../packages/shared-repositories/src");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");

function createReadInboxRouter(auth) {
  const router = express.Router();

  router.get("/:domain", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const truthy = (value) =>
        ["true", "1", "yes", "on"].includes(
          String(value || "").trim().toLowerCase(),
        );
      const result = await buildInboxWorkspace(req.params.domain, {
        status: req.query.status,
        channel: req.query.channel,
        search: req.query.search,
        workflow: req.query.workflow,
        family: req.query.family,
        limit: req.query.limit,
        // Default inbox view hides auto-responded threads + opted-out
        // threads + suppressed/closed threads so reps see only live
        // work. The three flags let admin / audit views opt back in.
        //   ?includeAutoResponded=true  → show auto-handled threads
        //   ?includeOptedOut=true       → show opted-out threads
        //   ?includeTerminated=true     → show suppressed + closed
        //   ?optOutDetected=true        → JUST the opted-out list
        includeAutoResponded: truthy(req.query.includeAutoResponded),
        includeOptedOut: truthy(req.query.includeOptedOut),
        includeTerminated: truthy(req.query.includeTerminated),
        optOutDetected:
          req.query.optOutDetected != null
            ? truthy(req.query.optOutDetected)
            : undefined,
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  // Full per-turn message history for one conversation. The summary
  // list endpoint only carries `latestInboundText` + draft; this one
  // returns every inbound + outbound turn with provider status and
  // per-message disposition so the UI can render a real bubble thread.
  router.get(
    "/:domain/threads/:workflowId/messages",
    auth.requireAuth,
    auth.requireAdmin,
    async (req, res) => {
      try {
        const workflow = await conversationWorkflowRepository.findConversationWorkflowById(
          req.params.workflowId,
        );
        if (!workflow) {
          return res.status(404).json({ ok: false, error: "Thread not found" });
        }
        // Domain scoping: an admin for TAG shouldn't be able to read
        // Wynn threads via a crafted URL. `decorateAccountRecord` plus
        // `requireAdmin` already restrict access, but cross-tenant
        // leakage is worth blocking even for admins unless explicit.
        const expectedDomain = String(req.params.domain || "").toUpperCase();
        if (
          expectedDomain &&
          String(workflow.domain || "").toUpperCase() !== expectedDomain
        ) {
          return res
            .status(404)
            .json({ ok: false, error: "Thread not in this domain" });
        }
        const limit = Math.min(Number(req.query.limit) || 200, 500);
        const messages = await conversationMessageRepository.listMessagesForWorkflow(
          req.params.workflowId,
          { limit },
        );
        return res.json({
          ok: true,
          result: {
            workflow: {
              id: String(workflow._id),
              domain: workflow.domain,
              phone: workflow.phone,
              channel: workflow.channel,
              status: workflow.status,
              caseId: workflow.caseId,
              optOutDetected: Boolean(workflow.optOutDetected),
              aiRecommendedAction: workflow.aiRecommendedAction,
              aiDraftReply: workflow.aiDraftReply,
              aiConfidence: workflow.aiConfidence,
              aiSummary: workflow.aiSummary,
              aiFlags: workflow.aiFlags || [],
              latestInboundAt: workflow.latestInboundAt,
              metadata: workflow.metadata,
            },
            messages,
          },
        });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  return router;
}

module.exports = {
  createReadInboxRouter,
};
