"use strict";

// Resolution intelligence — auth + routing skeleton.
//
// The secondary-sales panel: case bank, dossiers, gem detection, and the
// Opus resolution agent. Access is PER-USER GRANT, not role-default — a
// handful of people carry resolution.* in their permissions[] (admins
// inherit implicitly). Everything in this router sits behind
// resolution.read at minimum; mutating routes add resolution.write and
// agent runs add resolution.agent.
//
// DOCUMENT DOCTRINE (no storage): uploaded documents are NEVER persisted.
// The pipeline is parse → persist the scraped object (structured fields,
// bounded provenance snippets, masked identifiers, content hash) → DELETE
// the document. Deletion happens ONLY after a successful parse + persist;
// a failed parse rejects loudly so the uploader re-uploads — never a
// silent loss. The content hash dedupes re-uploads and proves "this
// document was seen on date X" without retaining it.

const express = require("express");
const { PORTS } = require("../../../../packages/shared-config/src");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");

function normalizeDomain(value) {
  return String(value || "TAG").trim().toUpperCase() || "TAG";
}

function requestDomain(req) {
  return normalizeDomain(req.body?.domain || req.query?.domain || "TAG");
}

function requestProfileKey(req) {
  return `${requestDomain(req)}:${String(req.params.caseNumber || req.body?.caseNumber || "").trim()}`;
}

function createResolutionIntelligenceRouter(auth, config = {}) {
  const router = express.Router();

  // Every resolution route requires an authenticated user with at least
  // resolution.read. Route-level middleware adds write/agent where needed.
  router.use(auth.requireAuth, auth.requirePermission("resolution.read"));

  // Access probe: the client guard calls this to learn which resolution
  // capabilities the user holds (read is implied by reaching it at all).
  router.get("/access", (req, res) => {
    try {
      const { hasPermission } = require("../../../../packages/shared-auth/src");
      return res.json({
        ok: true,
        access: {
          read: true,
          write: hasPermission(req.user, "resolution.write"),
          agent: hasPermission(req.user, "resolution.agent"),
        },
        user: {
          id: req.user?.id || null,
          email: req.user?.email || null,
          role: req.user?.role || null,
        },
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  // ── P0: the case bank ──────────────────────────────────────────────────────
  // clientProfiles — per-client elevation above caseProfiles, seeded from the
  // case-master workbook, best-prospect-first via the pursuit model.

  router.get("/bank", async (req, res) => {
    try {
      const {
        listClientProfiles,
      } = require("../../../../packages/shared-repositories/src/clientProfileRepository");
      const result = await listClientProfiles({
        tier: req.query.tier || null,
        temperature: req.query.temperature || null,
        status: req.query.status || "active",
        domain: req.query.domain || null,
        minScore: req.query.minScore != null ? Number(req.query.minScore) : null,
        q: String(req.query.q || "").slice(0, 80) || null,
        limit: req.query.limit != null ? Number(req.query.limit) : 100,
        skip: req.query.skip != null ? Number(req.query.skip) : 0,
      });
      return res.json({ ok: true, ...result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/bank/summary", async (req, res) => {
    try {
      const {
        summarizeBank,
      } = require("../../../../packages/shared-repositories/src/clientProfileRepository");
      return res.json({ ok: true, summary: await summarizeBank({ domain: req.query.domain || null }) });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  // Manual bank entry — the fell-through-the-cracks path. Verifies the case
  // exists in Logics (the appendage refresh must return SOMETHING), creates
  // the clientProfile, and runs the full per-case refresh on the spot.
  router.post(
    "/cases",
    auth.requirePermission("resolution.write"),
    async (req, res) => {
      try {
        const {
          addCaseToBank,
        } = require("../../../../packages/shared-services/src/resolutionBankService");
        const result = await addCaseToBank({
          caseNumber: req.body?.caseNumber,
          domain: requestDomain(req),
          addedBy: req.user?.email || null,
        });
        return res.json({ ok: true, ...result });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  router.get("/cases/:caseNumber", async (req, res) => {
    try {
      const {
        getClientProfileByCaseNumber,
      } = require("../../../../packages/shared-repositories/src/clientProfileRepository");
      const profile = await getClientProfileByCaseNumber(req.params.caseNumber, requestDomain(req));
      if (!profile) return res.status(404).json({ ok: false, error: "Client profile not found" });
      return res.json({ ok: true, profile });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  // ── Upsell suggestions + contact (UPSELLERATOR client tools) ───────────────
  // "Look into these": active clients with an open opportunity, minus anyone
  // snoozed via "not now". Best-prospect-first.
  router.get("/upsell/suggestions", async (req, res) => {
    try {
      const {
        listUpsellSuggestions,
      } = require("../../../../packages/shared-repositories/src/clientProfileRepository");
      const suggestions = await listUpsellSuggestions({
        domain: req.query.domain || null,
        limit: req.query.limit != null ? Number(req.query.limit) : 100,
      });
      return res.json({ ok: true, count: suggestions.length, suggestions });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  // "Not now": snooze a client out of the suggestions list until checkAgainOn.
  router.post(
    "/cases/:caseNumber/upsell/snooze",
    auth.requirePermission("resolution.write"),
    async (req, res) => {
      try {
        const {
          snoozeUpsell,
        } = require("../../../../packages/shared-repositories/src/clientProfileRepository");
        const profile = await snoozeUpsell(req.params.caseNumber, {
          domain: requestDomain(req),
          days: req.body?.days != null ? Number(req.body.days) : null,
          checkAgainOn: req.body?.checkAgainOn || null,
          by: req.user?.email || null,
          reason: req.body?.reason || null,
        });
        if (!profile) return res.status(404).json({ ok: false, error: "Client profile not found" });
        return res.json({ ok: true, profile });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  // Send ONE upsell text/email. Fail-closed allow-list for tier-5/reso-only.
  // The HTTP call succeeds even when the send is blocked/skipped — the per-case
  // outcome (ok / skipped / reason) is in `result` for the card to render.
  router.post(
    "/cases/:caseNumber/upsell/send",
    auth.requirePermission("resolution.write"),
    async (req, res) => {
      try {
        const {
          sendUpsellContact,
        } = require("../../../../packages/shared-services/src/resolutionContactService");
        const result = await sendUpsellContact({
          domain: requestDomain(req),
          caseId: Number(req.params.caseNumber),
          channel: req.body?.channel,
          templateKey: req.body?.templateKey || null,
          content: req.body?.content || null,
          subject: req.body?.subject || null,
          actor: req.user?.email || null,
          dryRun: Boolean(req.body?.dryRun),
        });
        return res.json({ ok: true, result });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  // Bulk send to a filtered selection. Per-case isolation + tallies.
  router.post(
    "/upsell/send-bulk",
    auth.requirePermission("resolution.write"),
    async (req, res) => {
      try {
        const {
          sendBulkUpsellContact,
        } = require("../../../../packages/shared-services/src/resolutionContactService");
        const result = await sendBulkUpsellContact({
          domain: requestDomain(req),
          caseIds: Array.isArray(req.body?.caseIds) ? req.body.caseIds.map(Number) : [],
          channel: req.body?.channel,
          templateKey: req.body?.templateKey || null,
          content: req.body?.content || null,
          subject: req.body?.subject || null,
          actor: req.user?.email || null,
          dryRun: Boolean(req.body?.dryRun),
        });
        return res.json({ ok: true, result });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  // ── P1: documents (parse-and-delete) ──────────────────────────────────────
  // Multipart upload held in MEMORY ONLY (multer memoryStorage — never disk),
  // parsed into shorthand, recorded as a content hash, then released. Main
  // three docTypes: ths | wit | lexis.
  const multer = require("multer");
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  });

  // Multer failures (oversized file, wrong field name) surface as JSON the
  // upload slot can toast — not an HTML 500 from the default handler.
  const uploadSingle = (req, res, next) => {
    upload.single("file")(req, res, (err) => {
      if (!err) return next();
      const tooBig = err.code === "LIMIT_FILE_SIZE";
      return res.status(tooBig ? 413 : 400).json({
        ok: false,
        error: tooBig ? "File exceeds the 25MB limit" : `Upload rejected: ${err.message}`,
      });
    });
  };

  router.post(
    "/cases/:caseNumber/documents",
    auth.requirePermission("resolution.write"),
    uploadSingle,
    async (req, res) => {
      try {
        if (!req.file || !req.file.buffer) {
          return res.status(400).json({ ok: false, error: "No file uploaded (field name: file)" });
        }
        const {
          ingestClientDocument,
        } = require("../../../../packages/shared-services/src/resolutionDocumentService");
        const result = await ingestClientDocument({
          caseNumber: req.params.caseNumber,
          domain: requestDomain(req),
          buffer: req.file.buffer,
          filename: req.file.originalname || "",
          docType: req.body?.docType || "",
          uploadedBy: req.user?.email || null,
          // Re-parse after parser upgrades (the dedupe message advertises
          // this; without the passthrough it was operator-script-only).
          force: req.body?.force === "true" || req.body?.force === true,
        });
        return res.json(result);
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );
  // ── P2: the pitch designer (Opus agent) ────────────────────────────────────
  // One active thread per case, persisted on clientProfile.pitch. Empty/no
  // message = full pitchability assessment (first contact or regenerate);
  // otherwise the message continues the design conversation. The doctrine +
  // verdict contract live in ai-bus (cached prefix); this side owns
  // permissions, dossier assembly, and thread persistence.

  const THREAD_CAP = 40; // stored turns; ai-bus sends the model the last 12

  // One pitch-designer call per case at a time. The thread write is
  // read-merge-write, so two concurrent asks (double-click, two EAs on the
  // same client) would silently drop one reply. Single process — a Map is
  // the whole lock.
  const askInFlight = new Map();

  function buildDossier(profile) {
    // The dossier IS the profile, minus the agent's own thread (no
    // self-reference) and Mongo internals. Shorthand rides with full values —
    // verbose but non-sensitive by construction (scrubbed at parse time).
    const { _id, __v, pitch, createdAt, updatedAt, ...dossier } = profile;
    if (Array.isArray(dossier.documentHashes)) {
      dossier.documentHashes = dossier.documentHashes.map((d) => ({
        docType: d.docType, label: d.label, parsedAt: d.parsedAt,
      }));
    }
    return dossier;
  }

  router.post(
    "/cases/:caseNumber/agent/ask",
    auth.requirePermission("resolution.agent"),
    async (req, res) => {
      const lockKey = requestProfileKey(req);
      if (askInFlight.has(lockKey)) {
        return res.status(409).json({
          ok: false,
          error: "The pitch designer is already working on this case — wait for the current reply",
        });
      }
      askInFlight.set(lockKey, Date.now());
      try {
        const {
          getClientProfileByCaseNumber,
          setPitchState,
        } = require("../../../../packages/shared-repositories/src/clientProfileRepository");
        const {
          parsePitchVerdict,
        } = require("../../../../packages/shared-services/src/resolutionPitchVerdict");

        const profile = await getClientProfileByCaseNumber(req.params.caseNumber, requestDomain(req));
        if (!profile) return res.status(404).json({ ok: false, error: "Client profile not found" });

        const message = String(req.body?.message || "").trim().slice(0, 4000);
        const priorThread = Array.isArray(profile.pitch?.thread) ? profile.pitch.thread : [];

        // Opus with adaptive thinking on a full dossier can run long — give it
        // room (this is a click-and-wait design action, not a hot path).
        const controller = new AbortController();
        const timeoutMs = Math.max(15_000, Number(process.env.RESOLUTION_AGENT_PROXY_TIMEOUT_MS || 90_000) || 90_000);
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        let upstream;
        try {
          upstream = await fetch(`http://127.0.0.1:${PORTS.aiBus}/api/ai/resolution/pitch`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(config.internalServiceSecret
                ? { "x-service-secret": String(config.internalServiceSecret) }
                : {}),
            },
            body: JSON.stringify({
              dossier: buildDossier(profile),
              thread: priorThread.map((m) => ({ role: m.role, content: m.content })),
              ask: message,
            }),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
        }
        const payload = await upstream.json().catch(() => null);
        if (!upstream.ok || !payload?.ok) {
          return res.status(upstream.status === 503 ? 503 : 502).json({
            ok: false,
            error: payload?.error || `Pitch agent unavailable (${upstream.status})`,
          });
        }

        const { reply, verdict } = parsePitchVerdict(payload.text);
        const now = new Date();
        const thread = [
          ...priorThread,
          ...(message ? [{ role: "user", content: message, at: now, by: req.user?.email || null }] : []),
          { role: "assistant", content: reply, at: now },
        ].slice(-THREAD_CAP);
        const pitch = {
          thread,
          // A malformed fence keeps the prior verdict rather than blanking it.
          verdict: verdict || profile.pitch?.verdict || null,
          model: payload.model || null,
          updatedAt: now,
        };
        await setPitchState(profile.caseNumber, pitch, { domain: profile.domain || requestDomain(req) });
        return res.json({ ok: true, reply, verdict: pitch.verdict, thread, model: payload.model });
      } catch (error) {
        if (error?.name === "AbortError") {
          return res.status(504).json({ ok: false, error: "Pitch agent timed out — try again" });
        }
        // ai-bus down (ECONNREFUSED etc.) is an upstream problem, not ours.
        if (error?.cause?.code || /fetch failed/i.test(error?.message || "")) {
          return res.status(502).json({ ok: false, error: "Pitch agent unreachable (ai-bus down?)" });
        }
        return res.status(error.status || 500).json(toErrorResponse(error));
      } finally {
        askInFlight.delete(lockKey);
      }
    },
  );

  // Fresh start on a case: clears the thread AND the verdict (a stale verdict
  // over a reset thread would misrepresent what the agent currently believes).
  router.post(
    "/cases/:caseNumber/agent/reset",
    auth.requirePermission("resolution.agent"),
    async (req, res) => {
      // A reset during an in-flight ask would be silently undone when the
      // ask writes its (stale, pre-reset) thread back. Same lock, same 409.
      if (askInFlight.has(requestProfileKey(req))) {
        return res.status(409).json({
          ok: false,
          error: "The pitch designer is mid-reply on this case — wait, then reset",
        });
      }
      try {
        const {
          setPitchState,
        } = require("../../../../packages/shared-repositories/src/clientProfileRepository");
        const result = await setPitchState(req.params.caseNumber, null, { domain: requestDomain(req) });
        if (!result) return res.status(404).json({ ok: false, error: "Client profile not found" });
        return res.json({ ok: true });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  return router;
}

module.exports = {
  createResolutionIntelligenceRouter,
};
