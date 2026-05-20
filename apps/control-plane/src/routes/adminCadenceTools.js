"use strict";

// Admin-only utility endpoints for surgical adjustments to specific
// LeadCadence rows. Used by the smoke harness and ops dry-runs to flip
// per-lead flags without modifying global policy.
//
// Mounted at /api/admin/cadence.

const express = require("express");
const { LeadCadence } = require("../../../../packages/shared-models/src");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

function createAdminCadenceToolsRouter(auth) {
  const router = express.Router();

  /**
   * POST /:domain/:caseId/bypass-channel-timing
   *
   * Sets cadenceState.bypassChannelTiming on a LeadCadence row so the
   * outbound dispatcher skips the contact-timing gate (quiet hours,
   * weekday, holidays, TCPA windows) for the listed channels on this
   * SPECIFIC lead. Global policy is unchanged — only this row.
   *
   * Body: { channels: ["sms", "email"] }   OR   { all: true }
   *
   * Returns: { ok: true, caseId, domain, bypassChannelTiming: {...} }
   *
   * Intended for the smoke harness to fire a single SMS/email to an
   * operator-controlled contact after-hours. Don't use this on real
   * customer leads.
   */
  router.post(
    "/:domain/:caseId/bypass-channel-timing",
    auth.requireAuth,
    auth.requireAdmin,
    async (req, res) => {
      try {
        const domain = normalizeDomain(req.params.domain);
        const caseId = Number(req.params.caseId);
        if (!domain || !Number.isFinite(caseId) || caseId <= 0) {
          return res
            .status(400)
            .json({ ok: false, error: "domain + caseId are required" });
        }

        const body = req.body && typeof req.body === "object" ? req.body : {};
        const channels = Array.isArray(body.channels)
          ? body.channels
              .map((c) => String(c || "").trim().toLowerCase())
              .filter(Boolean)
          : [];
        const allFlag = body.all === true;
        if (!allFlag && channels.length === 0) {
          return res.status(400).json({
            ok: false,
            error: "channels: [...] or all: true required",
          });
        }

        const patch = allFlag
          ? { "cadenceState.bypassChannelTiming": { all: true } }
          : {
              "cadenceState.bypassChannelTiming": channels.reduce(
                (acc, channel) => ({ ...acc, [channel]: true }),
                {},
              ),
            };

        const updated = await LeadCadence.findOneAndUpdate(
          { domain, caseId },
          { $set: patch },
          { new: true, projection: { domain: 1, caseId: 1, cadenceState: 1 } },
        ).lean();

        if (!updated) {
          return res.status(404).json({
            ok: false,
            error: `No LeadCadence row found for ${domain}/${caseId}`,
          });
        }

        return res.json({
          ok: true,
          domain: updated.domain,
          caseId: updated.caseId,
          bypassChannelTiming:
            updated.cadenceState?.bypassChannelTiming || {},
        });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  return router;
}

module.exports = { createAdminCadenceToolsRouter };
