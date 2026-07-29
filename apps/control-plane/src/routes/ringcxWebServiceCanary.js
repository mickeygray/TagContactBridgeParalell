"use strict";

const crypto = require("crypto");
const express = require("express");
const mongoose = require("mongoose");
const { safeSecretEquals } = require("../../../../packages/shared-utils/src");

const PARALLEL_TEST_CAMPAIGN_ID = "2306";

function parseAllowedCampaignIds(value) {
  const ids = String(value || PARALLEL_TEST_CAMPAIGN_ID)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return new Set(ids.length ? ids : [PARALLEL_TEST_CAMPAIGN_ID]);
}
const SAFE_FIELDS = Object.freeze([
  "campaignId", "campaign_id", "campaignName", "campaign_name",
  "externId", "extern_id", "externalId", "external_id",
  "uii", "callId", "call_id", "sessionId", "session_id",
  "disposition", "agentDisposition", "agent_disposition",
  "systemDisposition", "system_disposition", "passDisposition", "pass_disposition",
  "leadState", "lead_state", "leadPasses", "lead_passes",
  "agentId", "agent_id", "agentUsername", "agent_username",
  "callStart", "call_start", "duration", "durationSec", "duration_sec",
  "appointmentAt", "appointment_at", "appointmentDate", "appointment_date",
  "appointmentTime", "appointment_time", "appointmentTimezone", "appointment_timezone",
]);

function scalar(value) {
  return value == null || ["string", "number", "boolean"].includes(typeof value)
    ? value
    : null;
}

function safeEnvelope(body = {}) {
  const source = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const fields = {};
  for (const key of SAFE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const value = scalar(source[key]);
    if (value !== null && value !== "") fields[key] = value;
  }
  return { keys: Object.keys(source).sort(), fields };
}

function requestHash(req) {
  const raw = Buffer.isBuffer(req.rawBody)
    ? req.rawBody
    : Buffer.from(JSON.stringify(req.body || {}));
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function createRingcxWebServiceCanaryRouter(options = {}) {
  const router = express.Router();
  const collection = options.collection || (() => mongoose.connection.db.collection("cx_ringcx_web_service_canary_events"));
  const expectedSecret = options.expectedSecret || process.env.LEAD_WEBHOOK_SECRET;
  const processor = options.processor || null;
  const processingEnabled = options.processingEnabled === true;
  const logger = options.logger || console;
  const allowedCampaignIds = options.allowedCampaignIds instanceof Set
    ? options.allowedCampaignIds
    : parseAllowedCampaignIds(options.allowedCampaignIds || process.env.CX_BORING_WEBHOOK_CAMPAIGN_IDS);

  router.post("/", async (req, res, next) => {
    try {
      if (!expectedSecret) return res.status(503).json({ ok: false, error: "webhook-secret-not-configured" });
      const providedSecret = String(req.get("x-webhook-key") || "").trim();
      if (!safeSecretEquals(providedSecret, expectedSecret)) {
        return res.status(401).json({ ok: false, error: "invalid-webhook-key" });
      }
      const campaignId = String(req.query.campaignId || "").trim();
      if (!allowedCampaignIds.has(campaignId)) {
        return res.status(403).json({ ok: false, error: "campaign-not-allowed" });
      }
      const envelope = safeEnvelope(req.body);
      const hash = requestHash(req);
      const now = new Date();
      const result = await collection().updateOne(
        { hash },
        {
          $setOnInsert: {
            hash,
            campaignId,
            receivedAt: now,
            contentType: String(req.get("content-type") || "").slice(0, 120),
            keys: envelope.keys,
            fields: envelope.fields,
            source: "ringcx-web-service-canary",
          },
          $set: { lastReceivedAt: now },
          $inc: { deliveries: 1 },
        },
        { upsert: true },
      );
      let processing = { enabled: processingEnabled, accepted: false };
      if (processingEnabled && processor && typeof processor.ingest === "function") {
        try {
          const processed = await processor.ingest(req.body, { receivedAt: now });
          processing = {
            enabled: true,
            accepted: processed?.accepted !== false,
            remembered: Boolean(processed?.remembered),
            actionQueued: Boolean(processed?.actionQueued),
            duplicate: Boolean(processed?.duplicate),
            reason: processed?.reason || null,
          };
        } catch (error) {
          // The raw capture above is durable. Always ACK RingCX so a Mongo/business
          // replay problem cannot freeze the agent session; the capture is replayable.
          processing = { enabled: true, accepted: false, reason: "processor-failed-captured-for-replay" };
          logger.warn?.("cx.boring_webhook.ingest_failed", { error: error?.message || String(error) });
        }
      }
      return res.status(200).json({
        ok: true,
        campaignId,
        accepted: true,
        duplicate: (result.upsertedCount || 0) === 0,
        capturedFieldCount: Object.keys(envelope.fields).length,
        processing,
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = {
  PARALLEL_TEST_CAMPAIGN_ID,
  SAFE_FIELDS,
  createRingcxWebServiceCanaryRouter,
  requestHash,
  safeEnvelope,
  parseAllowedCampaignIds,
};
