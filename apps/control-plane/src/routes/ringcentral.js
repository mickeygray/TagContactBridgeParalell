"use strict";

const express = require("express");
const { getRingCentralConfig } = require("../../../../packages/shared-config/src");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");
const { createRingCentralClient } = require("../../../../packages/shared-integrations/src");
const { probeTelephonySessionLookup } = require("../../../../packages/shared-services/src");

function createRingCentralRouter(auth) {
  const router = express.Router();

  router.get("/status", auth.requireAuth, auth.requireAdmin, async (_req, res) => {
    try {
      const rc = createRingCentralClient();
      const subscriptions = await rc.listSubscriptions();
      return res.json({
        ok: true,
        auth: rc.getAuthStatus(),
        config: {
          serverUrl: getRingCentralConfig().serverUrl,
          webhookBaseUrl: getRingCentralConfig().webhookBaseUrl,
          hasClientId: Boolean(getRingCentralConfig().clientId),
          hasClientSecret: Boolean(getRingCentralConfig().clientSecret),
          hasJwtToken: Boolean(getRingCentralConfig().jwtToken),
          refreshIntervalMs: getRingCentralConfig().refreshIntervalMs,
        },
        subscriptions: subscriptions.records || subscriptions.records || [],
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/subscriptions/account-telephony", auth.requireAuth, auth.requireAdmin, async (_req, res) => {
    try {
      const rc = createRingCentralClient();
      const config = getRingCentralConfig();
      const subscription = await rc.createAccountTelephonySubscription(
        `${config.webhookBaseUrl}/webhook/ringcentral/session-events`,
        config.webhookSecret,
      );
      return res.json({
        ok: true,
        subscription,
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/subscriptions", auth.requireAuth, auth.requireAdmin, async (_req, res) => {
    try {
      const rc = createRingCentralClient();
      const payload = await rc.listSubscriptions();
      return res.json({
        ok: true,
        subscriptions: payload.records || [],
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.put("/subscriptions/:subscriptionId/renew", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const rc = createRingCentralClient();
      const payload = await rc.renewSubscription(req.params.subscriptionId);
      return res.json({
        ok: true,
        subscription: payload,
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.delete("/subscriptions/:subscriptionId", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const rc = createRingCentralClient();
      await rc.deleteSubscription(req.params.subscriptionId);
      return res.json({
        ok: true,
        deleted: true,
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/reinitialize", auth.requireAuth, auth.requireAdmin, async (_req, res) => {
    try {
      const rc = createRingCentralClient();
      const authState = await rc.reinitializePlatform({
        force: true,
        reason: "manual-admin",
      });
      return res.json({
        ok: true,
        auth: authState,
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/call-log/:extensionId", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const telephonySessionId = String(req.query.telephonySessionId || "").trim();
      const eventTime = String(req.query.eventTime || "").trim();
      if (!telephonySessionId || !eventTime) {
        return res.status(400).json({
          ok: false,
          error: "telephonySessionId and eventTime query parameters are required",
        });
      }

      const result = await probeTelephonySessionLookup(
        req.params.extensionId,
        telephonySessionId,
        eventTime,
      );
      return res.json({
        ok: true,
        result,
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  return router;
}

module.exports = {
  createRingCentralRouter,
};
