"use strict";

const express = require("express");
const { sendTestEmail } = require("../../../../packages/shared-services/src");
const { getInternalFromEmail } = require("../../../../packages/shared-config/src");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");

function createSendgridRouter(auth) {
  const router = express.Router();

  router.post("/test/:domain", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const domain = String(req.params.domain || "TAG").toUpperCase();
      const payload = await sendTestEmail(domain, {
        fromEmail: req.body?.fromEmail || getInternalFromEmail(),
        toEmail: req.body?.toEmail || "mgray@taxadvocategroup.com",
        subject: req.body?.subject,
        text: req.body?.text || "test",
      });

      return res.json({
        ok: true,
        payload,
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  /*
  Future: ingest SendGrid event webhook payloads here so opens/clicks can be surfaced
  back into the client timeline. The important design rule is to keep this append-only
  and tie events back with custom_args such as caseId, leadId, company, and workflow.

  router.post("/events", async (req, res) => {
    res.sendStatus(202);
    const events = Array.isArray(req.body) ? req.body : [];
    // Example future flow:
    // 1. Verify webhook signature/header if enabled
    // 2. Persist each event as a durable event record
    // 3. Materialize per-contact email engagement counters
    // 4. Surface "opened at" / "clicked at" on client history views
  });
  */

  return router;
}

module.exports = {
  createSendgridRouter,
};
