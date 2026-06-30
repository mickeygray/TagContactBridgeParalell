"use strict";

const crypto = require("crypto");
const path = require("path");
const express = require("express");
const cors = require("cors");
const {
  getCorsOriginResolver,
  getFbPageToken,
  resolveCompanyFromFbPageId,
  getSharedConfig,
  PORTS,
  SERVICE_NAMES,
} = require("../../../packages/shared-config/src");
const {
  buildHealthAccessMiddleware,
  buildPublicHealthPayload,
  isDetailedHealthRequest,
  safeSecretEquals,
} = require("../../../packages/shared-utils/src");
const { prePingRepository } = require("../../../packages/shared-repositories/src");
const { publishDemoEvent } = require("../../../packages/shared-services/src/demoEventService");
const {
  intakeAffiliateLead,
  intakeFacebookLead,
  intakeInstagramLead,
  intakeLdLead,
  intakeLdPrePing,
  intakeLexisBatch,
  notifyAffiliatePostback,
  intakeOrganicLandingLead,
  intakeTikTokLead,
  intakeVfLandingLead,
  intakeWebsiteLead,
  getMetaWebhookVerifyToken,
  processMetaSocialWebhook,
  validateLeadWebhook,
} = require("../../../packages/shared-services/src");
const { initializeServiceRuntime } = require("../../../packages/shared-runtime/src");
const { buildServiceHealth } = require("../../../packages/shared-observability/src");
const { toErrorResponse } = require("../../../packages/shared-errors/src");
const { createRateLimiter } = require("../../control-plane/src/middleware/rateLimit");

function captureRawBody(req, _res, buf) {
  if (buf?.length) {
    req.rawBody = Buffer.from(buf);
  }
}

function getRawBodyBuffer(req) {
  if (Buffer.isBuffer(req.rawBody)) {
    return req.rawBody;
  }
  if (Buffer.isBuffer(req.body)) {
    return req.body;
  }
  if (typeof req.body === "string") {
    return Buffer.from(req.body);
  }
  return Buffer.from(JSON.stringify(req.body || {}));
}

function safeTimingCompare(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function getMetaAppSecret(company = "") {
  const companyKey = String(company || "").trim().toUpperCase();
  if (companyKey) {
    const companySecret = String(process.env[`${companyKey}_FB_APP_SECRET`] || "").trim();
    if (companySecret) return companySecret;
  }

  return String(
    process.env.FB_APP_SECRET ||
      process.env.META_APP_SECRET ||
      "",
  ).trim();
}

function getTikTokSigningSecret() {
  return String(
    process.env.TIKTOK_SIGNING_KEY ||
      process.env.TIKTOK_CLIENT_SECRET ||
      process.env.TT_CLIENT_SECRET ||
      process.env.TIKTOK_APP_SECRET ||
      "",
  ).trim();
}

function verifyMetaWebhookSignature(req) {
  const body = req.body || {};
  const entryPageId = body?.entry?.[0]?.id || body?.entry?.[0]?.page_id || null;
  const company = entryPageId ? resolveCompanyFromFbPageId(entryPageId) : "";
  const secret = getMetaAppSecret(company);
  if (!secret) {
    return { ok: true };
  }

  const provided = String(req.get("x-hub-signature-256") || "").trim();
  if (!provided || !provided.startsWith("sha256=")) {
    return { ok: false, reason: "missing_signature" };
  }

  const expected = `sha256=${crypto
    .createHmac("sha256", secret)
    .update(getRawBodyBuffer(req))
    .digest("hex")}`;

  if (!safeTimingCompare(provided, expected)) {
    return { ok: false, reason: "signature_mismatch" };
  }

  return { ok: true };
}

function parseTikTokSignature(headerValue) {
  const pairs = {};
  for (const entry of String(headerValue || "").split(",")) {
    const [key, value] = entry.split("=");
    if (!key || value === undefined) continue;
    pairs[String(key).trim().toLowerCase()] = String(value).trim();
  }
  return pairs;
}

function verifyTikTokWebhookSignature(req, nowMs = Date.now()) {
  const secret = getTikTokSigningSecret();
  if (!secret) {
    return { ok: true };
  }

  const parsed = parseTikTokSignature(req.get("TikTok-Signature"));
  const timestamp = String(parsed.t || "").trim();
  const provided = String(parsed.s || "").trim().toLowerCase();
  if (!timestamp || !provided) {
    return { ok: false, reason: "missing_signature" };
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${getRawBodyBuffer(req).toString("utf8")}`)
    .digest("hex")
    .toLowerCase();

  if (!safeTimingCompare(provided, expected)) {
    return { ok: false, reason: "signature_mismatch" };
  }

  const ageMs = Math.abs(nowMs - Number(timestamp) * 1000);
  if (Number.isFinite(ageMs) && ageMs > 5 * 60 * 1000) {
    return { ok: false, reason: "stale_signature" };
  }

  return { ok: true };
}

function buildWebhookSignatureMiddleware(runtime, verifier, label) {
  return (req, res, next) => {
    const result = verifier(req);
    if (result.ok) {
      return next();
    }

    runtime.logger.warn(`${label}.rejected`, {
      reason: result.reason || "invalid_signature",
      path: req.path,
    });
    return res.status(401).json({ ok: false, error: "invalid_webhook_signature" });
  };
}

function validateLegacyLeadWebhook(req) {
  if (validateLeadWebhook(req)) {
    return true;
  }

  const configured = String(process.env.LEAD_WEBHOOK_SECRET || "").trim();
  if (!configured) {
    return true;
  }

  const provided = String(req.headers["x-webhook-key"] || "").trim();
  return safeSecretEquals(provided, configured);
}

function requestLeadPayload(req) {
  const query =
    req.query && typeof req.query === "object" && !Array.isArray(req.query) ? req.query : {};
  const body =
    req.body &&
    typeof req.body === "object" &&
    !Buffer.isBuffer(req.body) &&
    !Array.isArray(req.body)
      ? req.body
      : {};
  return { ...query, ...body };
}

function configuredLdPostingQuerySecrets() {
  return [
    process.env.LD_POSTING_AUTH,
    process.env.OPTA_LD_POSTING_AUTH,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function payloadFirstValue(payload = {}, keys = []) {
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) {
      const arrayValue = value.map((item) => String(item || "").trim()).find(Boolean);
      if (arrayValue) return arrayValue;
      continue;
    }
    const next = String(value || "").trim();
    if (next) return next;
  }
  return "";
}

function validateLdPostingWebhook(req, payload = requestLeadPayload(req)) {
  if (validateLegacyLeadWebhook(req)) {
    return true;
  }

  const configured = configuredLdPostingQuerySecrets();
  if (!configured.length) {
    return false;
  }

  const provided = payloadFirstValue(payload, [
    "ldPostingAuth",
    "ld_posting_auth",
    "posting_auth",
    "webhook_secret",
    "auth",
  ]);
  if (!provided) {
    return false;
  }

  return configured.some((expected) => safeSecretEquals(provided, expected));
}

function scrubLdPostingSecrets(payload = {}) {
  const configured = configuredLdPostingQuerySecrets();
  if (!configured.length) {
    return payload;
  }

  const next = { ...payload };
  for (const key of ["ldPostingAuth", "ld_posting_auth", "posting_auth", "webhook_secret", "auth"]) {
    const value = next[key];
    if (!value) continue;
    const provided = Array.isArray(value)
      ? value.map((item) => String(item || "").trim()).find(Boolean)
      : String(value || "").trim();
    if (provided && configured.some((expected) => safeSecretEquals(provided, expected))) {
      delete next[key];
    }
  }
  return next;
}

function resolveSkipLogicsCreate(req) {
  const requested = String(req.query.doCase || "").trim().toLowerCase() === "false";
  if (!requested) {
    return { ok: true, skip: false };
  }

  if (String(process.env.NODE_ENV || "").trim().toLowerCase() !== "production") {
    return { ok: true, skip: true };
  }

  const expected = String(process.env.INTERNAL_SERVICE_SECRET || "").trim();
  const provided = String(
    req.headers["x-service-secret"] ||
      req.headers["x-internal-service-secret"] ||
      "",
  ).trim();
  if (expected && provided && safeTimingCompare(provided, expected)) {
    return { ok: true, skip: true };
  }

  return {
    ok: false,
    skip: false,
    error: "logics_case_bypass_requires_internal_secret",
  };
}

function requireInternalServiceSecret(req, res, next) {
  const expected = String(process.env.INTERNAL_SERVICE_SECRET || "").trim();
  const provided = String(
    req.headers["x-service-secret"] ||
      req.headers["x-internal-service-secret"] ||
      "",
  ).trim();
  if (expected && provided && safeTimingCompare(provided, expected)) {
    return next();
  }
  return res.status(401).json({ ok: false, error: "invalid_service_secret" });
}

function getTikTokWebhookVerifyToken() {
  return String(
    process.env.TIKTOK_WEBHOOK_VERIFY_TOKEN ||
      process.env.TT_VERIFY_TOKEN ||
      process.env.TIKTOK_VERIFY_TOKEN ||
      "",
  ).trim();
}

function flattenLegacyTikTokEntries(body = {}) {
  const entries = Array.isArray(body.entry) ? body.entry : [];
  const rows = [];

  for (const entry of entries) {
    const flattened = {
      lead_id: entry?.id || null,
      form_id: entry?.page_id || null,
      adgroup_id: entry?.adgroup_id || null,
      advertiser_id: entry?.page_id || entry?.id || null,
    };

    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const key = String(change?.field || "")
        .toLowerCase()
        .replace(/\s+/g, "_")
        .replace(/[?]/g, "");
      if (!key) continue;
      flattened[key] = change?.value || "";
    }

    rows.push(flattened);
  }

  return rows;
}

async function fetchFacebookLeadgenPayload(leadgenId, company) {
  const token = String(getFbPageToken(company) || "").trim();
  if (!token || !leadgenId) {
    return null;
  }

  const url = new URL(`https://graph.facebook.com/v21.0/${leadgenId}`);
  url.searchParams.set("access_token", token);

  const response = await fetch(url, { method: "GET" });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Meta leadgen fetch failed (${response.status})${body ? `: ${body.slice(0, 300)}` : ""}`,
    );
  }

  return response.json();
}

async function processFacebookLeadgenWebhook(body, reqHeaders, config) {
  let accepted = 0;

  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      if (change?.field !== "leadgen") continue;

      const leadgenId = change?.value?.leadgen_id;
      if (!leadgenId) continue;

      const company = resolveCompanyFromFbPageId(entry.id);
      const leadPayload = await fetchFacebookLeadgenPayload(leadgenId, company);
      if (!leadPayload) continue;

      await intakeFacebookLead(
        {
          ...leadPayload,
          leadgen_id: change?.value?.leadgen_id || null,
          form_id: change?.value?.form_id || null,
          adgroup_id: change?.value?.adgroup_id || null,
          created_time: change?.value?.created_time || null,
          page_id: entry.id || null,
          platform: "facebook",
        },
        {
          headers: reqHeaders || {},
          sourceService: config.serviceName,
        },
      );
      accepted += 1;
    }
  }

  return { accepted };
}

function pickLegacyLeadHandler(body = {}) {
  const source = String(
    body.source ||
      body.trafficSource ||
      body.partner ||
      body.vendor ||
      body.utm_source ||
      "",
  )
    .trim()
    .toLowerCase();

  if (/(affiliate|nid|revshare)/.test(source)) return intakeAffiliateLead;
  if (/(vf|validation)/.test(source)) return intakeVfLandingLead;
  if (/(instagram|^ig$)/.test(source)) return intakeInstagramLead;
  if (/(facebook|meta)/.test(source)) return intakeFacebookLead;
  if (/(tiktok|^tt$)/.test(source)) return intakeTikTokLead;
  if (/(^ld$|lead.?dist|posting)/.test(source)) return intakeLdLead;
  return intakeWebsiteLead;
}

// "Did this request originate from the legacy-monolith → parallel
// forwarder?" The forwarder stamps every relayed request with
// `x-forwarded-by: TagContactBridge-old-monolith`. Since the forwarder
// is purpose-built for LD vendor traffic only (FB/TT/etc. webhooks
// have their own routes), the presence of this header is sufficient
// to treat the request as LD even without a matching pre-ping in the
// PrePing collection (a pre-ping may have aged out at TTL=300s, the
// vendor may have skipped it, or hash matching may have drifted).
//
// Without this signal, /lead-contact's `pickLegacyLeadHandler`
// fallback would infer from body fields and often land on
// intakeWebsiteLead — diverging the write path between forwarded and
// direct-posted LD leads.
function isFromLegacyForwarder(req) {
  const value = String(req.headers["x-forwarded-by"] || "").toLowerCase();
  return value.includes("tagcontactbridge");
}

function computeEmailHash(email) {
  const value = String(email || "").trim().toLowerCase();
  if (!value) return null;
  return require("crypto").createHash("md5").update(value).digest("hex");
}

async function startServer() {
  const config = {
    ...getSharedConfig(),
    port: PORTS.inboundGateway,
    serviceName: SERVICE_NAMES.inboundGateway,
  };

  const runtime = await initializeServiceRuntime(config);
  runtime.installSignalHandlers();
  const requireHealthAccess = buildHealthAccessMiddleware(config);
  const requireMetaWebhookSignature = buildWebhookSignatureMiddleware(
    runtime,
    verifyMetaWebhookSignature,
    "meta.webhook.signature",
  );
  const requireTikTokWebhookSignature = buildWebhookSignatureMiddleware(
    runtime,
    verifyTikTokWebhookSignature,
    "tiktok.webhook.signature",
  );
  const formRateLimit = createRateLimiter({
    windowMs: 60_000,
    max: 60,
    message: "Too many lead submissions",
  });
  const vendorRateLimit = createRateLimiter({
    windowMs: 60_000,
    max: 180,
    message: "Too many vendor intake requests",
  });
  const socialWebhookRateLimit = createRateLimiter({
    windowMs: 60_000,
    max: 300,
    message: "Too many webhook requests",
  });

  const app = express();
  app.set("trust proxy", "loopback");
  app.use(cors({ origin: getCorsOriginResolver(), credentials: true }));

  // ── RVM audio static-serve ──────────────────────────────────────
  // drop.co fetches the audio file at delivery time via the URL
  // baked into each RVM payload (RVM_AUDIO_BASE_URL + /<DOMAIN>/<file>).
  // Files live in `runtime/audio/<DOMAIN>/*.wav` at the repo root and
  // are NOT in source control — drop them in via deploy / scp / file
  // copy from the legacy `TagContactBridge/audio/` tree.
  //
  // Mounted BEFORE the JSON / signature middleware so binary fetches
  // don't hit the Logics-skip / webhook-key gates.
  const audioDir = path.resolve(__dirname, "..", "..", "..", "runtime", "audio");
  app.use(
    "/audio",
    express.static(audioDir, {
      fallthrough: false,
      maxAge: "1h",
      index: false,
    }),
  );

  app.use(express.json({ limit: "1mb", verify: captureRawBody }));
  app.use(express.urlencoded({ extended: true, limit: "1mb", verify: captureRawBody }));
  app.use((req, res, next) => {
    const decision = resolveSkipLogicsCreate(req);
    if (!decision.ok) {
      runtime.logger.warn("inbound.logics_case_bypass.rejected", {
        path: req.path,
        method: req.method,
      });
      return res.status(403).json({ ok: false, error: decision.error });
    }
    req.skipLogicsCreate = decision.skip;
    return next();
  });

  app.get("/health", requireHealthAccess, (req, res) => {
    if (!isDetailedHealthRequest(req)) {
      return res.json(buildPublicHealthPayload(config, runtime.getMongoState()));
    }
    res.json(buildServiceHealth(config, runtime.getMongoState()));
  });

  app.post("/api/inbound/demo", async (req, res) => {
    try {
      const payload = {
        leadId: req.body?.leadId || "demo-lead",
        source: req.body?.source || "demo",
        ...(req.body || {}),
      };
      const result = await publishDemoEvent("inbound", config.serviceName, payload);

      res.status(202).json({
        ok: true,
        accepted: true,
        deduped: result.deduped,
        eventId: String(result.event._id),
      });
    } catch (error) {
      runtime.logger.error("inbound demo publish failed", { message: error.message });
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/inbound/cx-first-contact-forward", requireInternalServiceSecret, async (req, res) => {
    const payload = req.body && typeof req.body === "object" ? req.body : {};
    const event = String(payload.event || "").trim() || "unknown";
    const dedupeKey = String(payload.dedupeKey || req.headers["x-forward-id"] || "").trim() || null;
    const domain = String(payload.domain || "").trim().toUpperCase() || null;
    const caseId = payload.caseId == null ? null : String(payload.caseId).trim();

    runtime.logger.info("inbound.cx_first_contact_forward.received", {
      event,
      domain,
      caseId,
      leadCadenceId: payload.leadCadenceId || null,
      queueItemId: payload.queueItemId || null,
      queueFamily: payload.queueFamily || null,
      state: payload.state || null,
      dedupeKey,
      sourceService: payload.sourceService || null,
    });

    return res.status(202).json({
      ok: true,
      accepted: true,
      event,
      dedupeKey,
    });
  });

  app.get("/fb/webhook", async (req, res) => {
    const mode = String(req.query["hub.mode"] || "").trim();
    const token = String(req.query["hub.verify_token"] || "").trim();
    const challenge = String(req.query["hub.challenge"] || "").trim();
    const expectedToken = getMetaWebhookVerifyToken();

    if (mode === "subscribe" && expectedToken && token === expectedToken) {
      runtime.logger.info("meta.webhook.verified", { mode: "subscribe" });
      return res.status(200).send(challenge);
    }

    runtime.logger.warn("meta.webhook.verify_failed", {
      mode: mode || null,
      provided: Boolean(token),
      configured: Boolean(expectedToken),
    });
    return res.sendStatus(403);
  });

  app.post("/fb/webhook", socialWebhookRateLimit, requireMetaWebhookSignature, async (req, res) => {
    res.sendStatus(200);

    try {
      const body = req.body || {};
      const leadgenResult =
        String(body.object || "").toLowerCase() === "page"
          ? await processFacebookLeadgenWebhook(body, req.headers, config)
          : { accepted: 0 };
      const result = await processMetaSocialWebhook(req.body || {}, runtime);
      runtime.logger.info("meta.social.webhook.accepted", {
        ...result,
        leadgenAccepted: leadgenResult.accepted,
      });
    } catch (error) {
      runtime.logger.error("meta.social.webhook.failed", {
        message: error.message,
      });
    }
  });

  app.get("/tt/webhook", async (req, res) => {
    const token = String(req.query.verify_token || "").trim();
    const challenge = String(req.query.challenge || "").trim();
    const expectedToken = getTikTokWebhookVerifyToken();

    if (expectedToken && token === expectedToken) {
      runtime.logger.info("tiktok.webhook.verified");
      return res.status(200).send(challenge);
    }

    runtime.logger.warn("tiktok.webhook.verify_failed", {
      provided: Boolean(token),
      configured: Boolean(expectedToken),
    });
    return res.sendStatus(403);
  });

  app.post("/tt/webhook", socialWebhookRateLimit, requireTikTokWebhookSignature, async (req, res) => {
    res.sendStatus(200);

    try {
      const rows = flattenLegacyTikTokEntries(req.body || {});
      for (const row of rows) {
        await intakeTikTokLead(row, {
          headers: req.headers,
          sourceService: config.serviceName,
        });
      }
      runtime.logger.info("tiktok.legacy.webhook.accepted", {
        rowsReceived: rows.length,
      });
    } catch (error) {
      runtime.logger.error("tiktok.legacy.webhook.failed", {
        message: error.message,
      });
    }
  });

  app.post("/api/inbound/website/lead", formRateLimit, async (req, res) => {
    if (!validateLeadWebhook(req)) {
      return res.status(401).json({ ok: false, error: "invalid_webhook_secret" });
    }

    try {
      const result = await intakeWebsiteLead(req.body || {}, {
        headers: req.headers,
        sourceService: config.serviceName,
        skipLogicsCreate: req.skipLogicsCreate === true,
      });
      return res.status(result.statusCode || 202).json({ ok: true, ...result });
    } catch (error) {
      runtime.logger.error("website lead intake failed", {
        message: error.message,
      });
      return res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/lead-contact", vendorRateLimit, async (req, res) => {
    if (!validateLegacyLeadWebhook(req)) {
      return res.status(401).json({ ok: false, error: "invalid_webhook_secret" });
    }

    try {
      const domain = String(
        req.body?.company || req.body?.domain || req.headers["x-company"] || "WYNN",
      ).trim().toUpperCase();
      const prePing = await prePingRepository.findPrePing(
        domain,
        computeEmailHash(req.body?.email),
      );
      // Route to LD intake when:
      //   - we found a matching pre-ping (the canonical signal), OR
      //   - the request was relayed via the legacy → parallel forwarder
      //     (the forwarder only forwards LD vendor traffic, so its
      //     header is a sufficient signal even when the pre-ping has
      //     aged out / wasn't sent).
      // This keeps the write path consistent: forwarded-LD and direct-
      // posted-with-pre-ping both land in intakeLdLead and produce the
      // same intakeRoute / intakeSource / attribution shape.
      const handler =
        prePing || isFromLegacyForwarder(req)
          ? intakeLdLead
          : pickLegacyLeadHandler(req.body || {});
      const result = await handler(req.body || {}, {
        headers: req.headers,
        sourceService: config.serviceName,
        skipLogicsCreate: req.skipLogicsCreate === true,
      });
      return res.status(result.statusCode || 202).json({ ok: true, legacyRoute: true, ...result });
    } catch (error) {
      runtime.logger.error("legacy lead-contact intake failed", {
        message: error.message,
      });
      return res.status(500).json({ ok: false, error: error.message });
    }
  });

  const handleLdLead = async (req, res) => {
    const rawPayload = requestLeadPayload(req);
    if (!validateLdPostingWebhook(req, rawPayload)) {
      return res.status(401).json({ ok: false, error: "invalid_webhook_secret" });
    }

    try {
      const result = await intakeLdLead(scrubLdPostingSecrets(rawPayload), {
        headers: req.headers,
        sourceService: config.serviceName,
        skipLogicsCreate: req.skipLogicsCreate === true,
      });
      return res.status(result.statusCode || 202).json({ ok: true, ...result });
    } catch (error) {
      runtime.logger.error("ld lead intake failed", { message: error.message });
      return res.status(500).json({ ok: false, error: error.message });
    }
  };

  app.get("/api/inbound/ld/lead", vendorRateLimit, handleLdLead);
  app.post("/api/inbound/ld/lead", vendorRateLimit, handleLdLead);

  app.post("/api/inbound/ld/pre-ping", vendorRateLimit, async (req, res) => {
    if (!validateLeadWebhook(req)) {
      return res.status(401).json({ ok: false, error: "invalid_webhook_secret" });
    }

    try {
      const result = await intakeLdPrePing(req.body || {}, {
        headers: req.headers,
        sourceService: config.serviceName,
      });
      return res.status(result.statusCode || 200).json(result);
    } catch (error) {
      runtime.logger.error("ld pre-ping failed", { message: error.message });
      return res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/lead-contact/pre-ping", vendorRateLimit, async (req, res) => {
    if (!validateLegacyLeadWebhook(req)) {
      return res.status(401).json({ ok: false, error: "invalid_webhook_secret" });
    }

    try {
      const result = await intakeLdPrePing(req.body || {}, {
        headers: req.headers,
        sourceService: config.serviceName,
      });
      return res.status(result.statusCode || 200).json({
        ...result,
        legacyRoute: true,
      });
    } catch (error) {
      runtime.logger.error("legacy ld pre-ping failed", { message: error.message });
      return res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/inbound/affiliate/lead", vendorRateLimit, async (req, res) => {
    if (!validateLeadWebhook(req)) {
      await notifyAffiliatePostback(req.body || {}, {
        accepted: false,
        statusCode: 401,
        error: "invalid_webhook_secret",
        code: "INVALID_WEBHOOK_SECRET",
      }, {
        headers: req.headers,
      }).catch(() => null);
      return res.status(401).json({ ok: false, error: "invalid_webhook_secret" });
    }

    try {
      const result = await intakeAffiliateLead(req.body || {}, {
        headers: req.headers,
        sourceService: config.serviceName,
        skipLogicsCreate: req.skipLogicsCreate === true,
      });
      return res.status(result.statusCode || 202).json({ ok: true, ...result });
    } catch (error) {
      runtime.logger.error("affiliate lead intake failed", { message: error.message });
      await notifyAffiliatePostback(req.body || {}, {
        accepted: false,
        statusCode: 500,
        error: error.message,
        code: "AFFILIATE_INTAKE_FAILED",
      }, {
        headers: req.headers,
      }).catch(() => null);
      return res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/inbound/vf/landing-page", formRateLimit, async (req, res) => {
    if (!validateLeadWebhook(req)) {
      return res.status(401).json({ ok: false, error: "invalid_webhook_secret" });
    }

    try {
      const result = await intakeVfLandingLead(req.body || {}, {
        headers: req.headers,
        sourceService: config.serviceName,
        skipLogicsCreate: req.skipLogicsCreate === true,
      });
      return res.status(result.statusCode || 202).json({ ok: true, ...result });
    } catch (error) {
      runtime.logger.error("vf landing intake failed", { message: error.message });
      return res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/inbound/organic/:domain/landing-page", formRateLimit, async (req, res) => {
    if (!validateLeadWebhook(req)) {
      return res.status(401).json({ ok: false, error: "invalid_webhook_secret" });
    }

    try {
      const result = await intakeOrganicLandingLead(req.body || {}, {
        headers: req.headers,
        sourceService: config.serviceName,
        skipLogicsCreate: req.skipLogicsCreate === true,
        organicDomain: req.params.domain,
      });
      return res.status(result.statusCode || 202).json({ ok: true, ...result });
    } catch (error) {
      runtime.logger.error("organic landing intake failed", { message: error.message });
      return res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/inbound/facebook/lead", formRateLimit, async (req, res) => {
    if (!validateLeadWebhook(req)) {
      return res.status(401).json({ ok: false, error: "invalid_webhook_secret" });
    }

    try {
      const result = await intakeFacebookLead(req.body || {}, {
        headers: req.headers,
        sourceService: config.serviceName,
        skipLogicsCreate: req.skipLogicsCreate === true,
      });
      return res.status(result.statusCode || 202).json({ ok: true, ...result });
    } catch (error) {
      runtime.logger.error("facebook lead intake failed", { message: error.message });
      return res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/inbound/instagram/lead", formRateLimit, async (req, res) => {
    if (!validateLeadWebhook(req)) {
      return res.status(401).json({ ok: false, error: "invalid_webhook_secret" });
    }

    try {
      const result = await intakeInstagramLead(req.body || {}, {
        headers: req.headers,
        sourceService: config.serviceName,
        skipLogicsCreate: req.skipLogicsCreate === true,
      });
      return res.status(result.statusCode || 202).json({ ok: true, ...result });
    } catch (error) {
      runtime.logger.error("instagram lead intake failed", { message: error.message });
      return res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/inbound/tiktok/lead", formRateLimit, async (req, res) => {
    if (!validateLeadWebhook(req)) {
      return res.status(401).json({ ok: false, error: "invalid_webhook_secret" });
    }

    try {
      const result = await intakeTikTokLead(req.body || {}, {
        headers: req.headers,
        sourceService: config.serviceName,
        skipLogicsCreate: req.skipLogicsCreate === true,
      });
      return res.status(result.statusCode || 202).json({ ok: true, ...result });
    } catch (error) {
      runtime.logger.error("tiktok lead intake failed", { message: error.message });
      return res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/inbound/lexis/mailer", vendorRateLimit, async (req, res) => {
    if (!validateLeadWebhook(req)) {
      return res.status(401).json({ ok: false, error: "invalid_webhook_secret" });
    }

    try {
      const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
      const result = await intakeLexisBatch(rows, {
        headers: req.headers,
        sourceService: config.serviceName,
        skipLogicsCreate: req.skipLogicsCreate === true,
        importBatch: req.body?.importBatch || null,
      });
      return res.status(result.statusCode || 202).json({ ok: true, ...result });
    } catch (error) {
      runtime.logger.error("lexis batch intake failed", { message: error.message });
      return res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/test-lead", formRateLimit, async (req, res) => {
    if (!validateLegacyLeadWebhook(req)) {
      return res.status(401).json({ ok: false, error: "invalid_webhook_secret" });
    }

    try {
      const handler = pickLegacyLeadHandler({
        ...(req.body || {}),
        source: req.query.source || req.body?.source || "test",
      });
      const result = await handler(req.body || {}, {
        headers: req.headers,
        sourceService: config.serviceName,
        skipLogicsCreate: req.skipLogicsCreate === true,
      });
      return res.status(202).json({
        ok: true,
        legacyRoute: true,
        queued: false,
        ...result,
      });
    } catch (error) {
      runtime.logger.error("legacy test lead intake failed", {
        message: error.message,
      });
      return res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get("/status", requireHealthAccess, (req, res) => {
    if (!isDetailedHealthRequest(req)) {
      return res.json({
        ...buildPublicHealthPayload(config, runtime.getMongoState()),
        legacyRoute: true,
      });
    }
    res.json({
      ok: true,
      service: config.serviceName,
      legacyRoute: true,
      ...buildServiceHealth(config, runtime.getMongoState()),
    });
  });

  app.use((error, _req, res, _next) => {
    runtime.logger.error("inbound.request.failed", {
      error: error.message,
      status: error.status || 500,
    });
    res.status(error.status || 500).json(toErrorResponse(error));
  });

  const server = app.listen(config.port, config.bindHost, () => {
    runtime.logger.info("listening", { host: config.bindHost, port: config.port });
  });

  runtime.registerCleanup("inbound-server", () => new Promise((resolve) => server.close(() => resolve())));

  return server;
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error("[inbound-gateway] failed to start", error);
    process.exit(1);
  });
}

module.exports = {
  startServer,
};
