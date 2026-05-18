"use strict";

const { Readable } = require("node:stream");
const express = require("express");
const {
  buildCxCallQueue,
  buildCxCommLog,
  buildCxWorkspace,
  listCxLogicsTasks,
  listCxPostDateHolds,
  listCxTasks,
  lookupCxLead,
  findCxLeadCandidates,
  lookupCxLogicsMatch,
  searchCxCases,
} = require("../../../../packages/shared-services/src");
const {
  callLogRepository,
} = require("../../../../packages/shared-repositories/src");
const { CaseProfile } = require("../../../../packages/shared-models/src");
const { getSharedConfig } = require("../../../../packages/shared-config/src");
const { createGoogleDriveClient } = require("../../../../packages/shared-integrations/src");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");

function unwrapLogicsPayload(payload) {
  if (!payload) return null;
  const raw =
    payload.data !== undefined && payload.data !== null
      ? payload.data
      : payload.Data !== undefined && payload.Data !== null
        ? payload.Data
        : payload;
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function wrapLogicsPayloadWithData(payload, data) {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    if (payload.data !== undefined || payload.Data === undefined) {
      return { ...payload, data };
    }
    return { ...payload, Data: data };
  }
  return { data };
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number(code);
      return Number.isFinite(n) ? String.fromCharCode(n) : _;
    });
}

function normalizeLogicsComment(value) {
  return decodeHtmlEntities(value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<b>\s*Comment posted by\s+(.+?)\s+on\s+\[(.+?)\]:\s*<\/b>/gi, "$1 - $2")
    .replace(/<[^>]+>/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n-{10,}\n/g, "\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isNoteLikeActivity(row) {
  if (!row || typeof row !== "object") return false;
  const subject = String(row.Subject || row.subject || row.Title || row.title || "").toLowerCase();
  const type = String(row.ActivityType || row.activityType || row.Type || row.type || "").toLowerCase();
  const comment = String(row.Comment || row.comment || row.Notes || row.notes || "").trim();
  if (!comment) return false;
  if (/file upload|document|email|sms|text message|call/i.test(type)) return false;
  if (/note|sales|origination|originator|case review|review notes|tax prep|a\/s review/.test(subject)) {
    return true;
  }
  if (row.Pin === true || row.Pin === "true" || row.pin === true || row.pin === "true") {
    return true;
  }
  return false;
}

function formatActivityNotes(activitiesPayload) {
  const data = unwrapLogicsPayload(activitiesPayload);
  const rows = Array.isArray(data) ? data : data && typeof data === "object" ? [data] : [];
  const noteRows = rows
    .filter(isNoteLikeActivity)
    .slice()
    .sort((left, right) => {
      const leftTime = new Date(left.CreatedDate || left.createdAt || left.Date || 0).getTime();
      const rightTime = new Date(right.CreatedDate || right.createdAt || right.Date || 0).getTime();
      return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
    });

  const blocks = noteRows
    .map((row) => {
      const subject = String(row.Subject || row.subject || row.Title || row.title || "Logics note").trim();
      const createdBy = String(row.CreatedBy || row.createdBy || "").trim();
      const createdAt = String(row.CreatedDate || row.createdAt || row.Date || "").trim();
      const comment = normalizeLogicsComment(row.Comment || row.comment || row.Notes || row.notes || "");
      if (!comment) return "";
      const headerParts = [subject, createdBy, createdAt].filter(Boolean);
      return `${headerParts.join(" | ")}\n${comment}`;
    })
    .filter(Boolean);

  return {
    text: blocks.join("\n\n---\n\n"),
    count: blocks.length,
  };
}

async function buildLogicsInfoWithNotes(domain, caseId, client) {
  const normalizedDomain = String(domain || "").trim().toUpperCase();
  const numericCaseId = Number(caseId);
  const [caseInfoPayload, activitiesPayload, localCaseProfile] = await Promise.all([
    client.getCaseInfo(caseId),
    client.getActivities(caseId).catch((error) => {
      if (error?.details?.responseStatus === 404) return { data: [] };
      throw error;
    }),
    Number.isFinite(numericCaseId)
      ? CaseProfile.findOne({ domain: normalizedDomain, caseId: numericCaseId })
          .select({ notes: 1 })
          .lean()
          .catch(() => null)
      : Promise.resolve(null),
  ]);

  const caseInfo = unwrapLogicsPayload(caseInfoPayload);
  const caseInfoData =
    caseInfo && typeof caseInfo === "object" && !Array.isArray(caseInfo)
      ? { ...caseInfo }
      : {};
  const caseNotes = normalizeLogicsComment(caseInfoData.Notes || caseInfoData.notes || "");
  const localNotes = normalizeLogicsComment(localCaseProfile?.notes || "");
  const activityNotes = formatActivityNotes(activitiesPayload);

  const notes = caseNotes || localNotes || "";
  return {
    payload: wrapLogicsPayloadWithData(caseInfoPayload, {
      ...caseInfoData,
      Notes: notes,
      notes,
      ActivityNotes: activityNotes.text,
      activityNotes: activityNotes.text,
    }),
    metadata: {
      notesSource: caseNotes
        ? activityNotes.count > 0
          ? "case-info+activity"
          : "case-info"
        : localNotes
          ? activityNotes.count > 0
            ? "local-case-profile+activity"
            : "local-case-profile"
          : activityNotes.count > 0
            ? "activity-fallback"
            : "none",
      notesActivityCount: activityNotes.count,
    },
  };
}

function buildDriveMediaUrl(fileId, supportsAllDrives) {
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("alt", "media");
  if (supportsAllDrives) {
    url.searchParams.set("supportsAllDrives", "true");
  }
  return url.toString();
}

async function proxyDriveFile(req, res, fileId) {
  const config = getSharedConfig();
  const driveClient = createGoogleDriveClient(config.recordingArchive?.drive || {});
  if (!driveClient.isConfigured()) {
    const error = new Error("Recording archive playback is not configured");
    error.status = 503;
    throw error;
  }

  const token = await driveClient.getAccessToken();
  const response = await fetch(buildDriveMediaUrl(fileId, config.recordingArchive?.drive?.supportsAllDrives), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(req.headers.range ? { Range: req.headers.range } : {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`Drive playback failed: ${response.status}${text ? ` ${text}` : ""}`);
    error.status = response.status === 404 ? 404 : 502;
    throw error;
  }

  res.status(response.status);
  for (const name of [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
    "cache-control",
  ]) {
    const value = response.headers.get(name);
    if (value) {
      res.setHeader(name, value);
    }
  }
  res.setHeader("content-disposition", "inline");

  if (response.body && typeof Readable.fromWeb === "function") {
    return Readable.fromWeb(response.body).pipe(res);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  return res.end(buffer);
}

function normalizeDomain(value) {
  return String(value || "").trim().toUpperCase();
}

function requireCxDomainAccess(req, res, next) {
  try {
    const requestedDomain = normalizeDomain(req.params?.domain);
    if (!requestedDomain) {
      const error = new Error("domain is required");
      error.status = 400;
      throw error;
    }
    return next();
  } catch (error) {
    return res.status(error.status || 500).json(toErrorResponse(error));
  }
}

function createReadCxRouter(auth) {
  const router = express.Router();

  router.get("/workspace/:domain", auth.requireAuth, auth.requireUser, requireCxDomainAccess, async (req, res) => {
    try {
      const result = await buildCxWorkspace(req.params.domain, req.user);
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/call-queue/:domain", auth.requireAuth, auth.requireUser, requireCxDomainAccess, async (req, res) => {
    try {
      const result = await buildCxCallQueue(req.params.domain, req.user);
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/postdates/:domain", auth.requireAuth, auth.requireAdmin, requireCxDomainAccess, async (req, res) => {
    try {
      const result = await listCxPostDateHolds(req.params.domain, req.user, {
        status: req.query.status || "active",
        date: req.query.date || null,
        from: req.query.from || null,
        to: req.query.to || null,
        firstPaymentDueOnOrBefore: req.query.firstPaymentDueOnOrBefore || null,
        caseId: req.query.caseId || null,
        limit: req.query.limit || null,
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  // Unified lookup across CaseProfile → MasterProspect → LeadCadence
  // → Logics. Used by the CX workspace center panel when a call
  // connects or an operator types a phone, so the case form can
  // auto-populate from whichever tier has the best record.
  router.get("/recordings/play/:fileId", auth.requireAuth, auth.requireUser, async (req, res) => {
    try {
      return await proxyDriveFile(req, res, req.params.fileId);
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get(
    "/recordings/call/:domain/:telephonySessionId",
    auth.requireAuth,
    auth.requireUser,
    requireCxDomainAccess,
    async (req, res) => {
      try {
        const callLog = await callLogRepository.findCallLog(req.params.domain, req.params.telephonySessionId);
        const fileId = String(callLog?.recordingArchive?.driveFileId || "").trim();
        if (!fileId) {
          const error = new Error("Archived recording not found for call");
          error.status = 404;
          throw error;
        }
        return await proxyDriveFile(req, res, fileId);
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  router.get("/lookup/:domain", auth.requireAuth, auth.requireUser, requireCxDomainAccess, async (req, res) => {
    try {
      // Comma-joined list of domains to walk in order ("WYNN,TAG").
      // The frontend uses this on phone-only inbound lookups so we try
      // both tenants before giving up.
      const fallbackParam = req.query.domainFallback
        ? String(req.query.domainFallback)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : null;
      const result = await lookupCxLead({
        domain: req.params.domain,
        domainFallback: fallbackParam && fallbackParam.length > 0 ? fallbackParam : null,
        phone: req.query.phone ? String(req.query.phone) : null,
        caseId: req.query.caseId ? Number(req.query.caseId) : null,
        skipLogics: String(req.query.skipLogics || "").toLowerCase() === "true",
        skipMongoFallback: String(req.query.skipMongoFallback || "").toLowerCase() === "true",
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  // Logics case-level fields (incl. Notes) fetched fresh per call —
  // bypasses our local case-profile cache so the Notes panel always
  // reflects whatever a user just typed in Logics' own UI. Logics does
  // not reliably return a CaseInfo Notes field, so we also fall back to
  // note-like case activities and present them as clean plain text at
  // `result.data.ActivityNotes`. `result.data.Notes` stays reserved for
  // the editable case-level field so saving cannot rewrite activity
  // history.
  router.get(
    "/case/:domain/:caseId/logics-info",
    auth.requireAuth,
    auth.requireUser,
    requireCxDomainAccess,
    async (req, res) => {
      try {
        const {
          createLogicsClient,
        } = require("../../../../packages/shared-integrations/src");
        const client = createLogicsClient(req.params.domain);
        const { payload, metadata } = await buildLogicsInfoWithNotes(
          req.params.domain,
          req.params.caseId,
          client,
        );
        return res.json({ ok: true, result: payload, metadata });
      } catch (error) {
        if (error?.details?.responseStatus === 404) {
          return res.json({ ok: true, result: { data: null } });
        }
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  // Unified communication log for a case (or a phone-only prospect).
  // Fan-out reader: pulls from CaseProfile.communications,
  // ConversationMessage (sms in/out), CallLog, and LeadCadence.schedule.
  // Returns a single chronological list (newest first) with normalized
  // entry shape. See `cxCommLogService.js` for the contract.
  //
  // `:caseId` may be the literal string "phone" to indicate a phone-only
  // lookup; the actual phone is then read from ?phone=…. This keeps the
  // URL shape consistent with the other /case/:domain/:caseId/* reads.
  router.get(
    "/case/:domain/:caseId/comm-log",
    auth.requireAuth,
    auth.requireUser,
    requireCxDomainAccess,
    async (req, res) => {
      try {
        const phone = String(req.query.phone || "").trim() || null;
        const rawCaseId = String(req.params.caseId || "").trim();
        const caseId = /^\d+$/.test(rawCaseId) ? Number(rawCaseId) : null;
        const limit = Number(req.query.limit) || 200;
        if (caseId == null && !phone) {
          return res
            .status(400)
            .json({ ok: false, error: "caseId or phone required" });
        }
        const result = await buildCxCommLog(req.params.domain, {
          caseId,
          phone,
          limit,
        });
        return res.json({ ok: true, result });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  // Logics activities for a case — powers the activities list + the
  // nest-under picker in the center panel. Passthrough of the Logics
  // API response (activities are usually a flat list; any nesting
  // happens via ActivityID parent references on the nested child).
  router.get(
    "/case/:domain/:caseId/activities",
    auth.requireAuth,
    auth.requireUser,
    requireCxDomainAccess,
    async (req, res) => {
      try {
        const {
          createLogicsClient,
        } = require("../../../../packages/shared-integrations/src");
        const client = createLogicsClient(req.params.domain);
        const payload = await client.getActivities(req.params.caseId);
        return res.json({ ok: true, result: payload });
      } catch (error) {
        // 404 from Logics = no activities yet. Normalize to an empty list.
        if (error?.details?.responseStatus === 404) {
          return res.json({ ok: true, result: { data: [] } });
        }
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  router.get(
    "/case/:domain/:caseId/invoices",
    auth.requireAuth,
    auth.requireUser,
    requireCxDomainAccess,
    async (req, res) => {
      try {
        const {
          createLogicsClient,
        } = require("../../../../packages/shared-integrations/src");
        const client = createLogicsClient(req.params.domain);
        const payload = await client.getCaseInvoices(req.params.caseId);
        return res.json({ ok: true, result: payload });
      } catch (error) {
        if (error?.details?.responseStatus === 404) {
          return res.json({ ok: true, result: { data: [] } });
        }
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  // Multi-candidate lookup — returns every phone match across both
  // domains × all tiers so the CX UI can offer "found in N places,
  // pick one" buttons instead of guessing the right case.
  router.get(
    "/lookup-candidates/:domain",
    auth.requireAuth,
    auth.requireUser,
    requireCxDomainAccess,
    async (req, res) => {
      try {
        const fallbackParam = req.query.domainFallback
          ? String(req.query.domainFallback)
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : null;
        // nameSearch fields — only included when at least one is set,
        // so the service can branch on `hasNameSearch` cleanly.
        const ns = {
          firstName: req.query.firstName ? String(req.query.firstName) : null,
          lastName: req.query.lastName ? String(req.query.lastName) : null,
          address: req.query.address ? String(req.query.address) : null,
          city: req.query.city ? String(req.query.city) : null,
          state: req.query.state ? String(req.query.state) : null,
          zip: req.query.zip ? String(req.query.zip) : null,
        };
        const nameSearch =
          Object.values(ns).some((v) => v && String(v).trim().length > 0)
            ? ns
            : null;
        const result = await findCxLeadCandidates({
          domain: req.params.domain,
          domainFallback: fallbackParam && fallbackParam.length > 0 ? fallbackParam : null,
          phone: req.query.phone ? String(req.query.phone) : null,
          caseId: req.query.caseId ? Number(req.query.caseId) : null,
          nameSearch,
          skipLogics: String(req.query.skipLogics || "").toLowerCase() === "true",
          logicsLimit: req.query.logicsLimit ? Number(req.query.logicsLimit) : 50,
        });
        return res.json({ ok: true, result });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  // Per-case Logics tasks. Logics doesn't expose a getTasks(caseId)
  // endpoint, so we pull a 365-day window from getTasksByDateRange and
  // filter server-side by CaseID. Wide window because tasks can be set
  // with future due dates well past the case's recent activity.
  router.get(
    "/case/:domain/:caseId/tasks",
    auth.requireAuth,
    auth.requireUser,
    requireCxDomainAccess,
    async (req, res) => {
      try {
        const {
          createLogicsClient,
        } = require("../../../../packages/shared-integrations/src");
        const client = createLogicsClient(req.params.domain);
        const now = new Date();
        const past = new Date(now);
        past.setDate(past.getDate() - 180);
        const future = new Date(now);
        future.setDate(future.getDate() + 365);
        const fmt = (d) => d.toISOString().slice(0, 10);
        const payload = await client.getTasksByDateRange(fmt(past), fmt(future));
        const data = payload?.data ?? payload?.Data ?? payload;
        const all = Array.isArray(data) ? data : [];
        const target = String(req.params.caseId);
        const filtered = all.filter((row) => {
          const rid = row?.CaseID ?? row?.caseId ?? row?.CaseId;
          return rid != null && String(rid) === target;
        });
        return res.json({ ok: true, result: { data: filtered } });
      } catch (error) {
        if (error?.details?.responseStatus === 404) {
          return res.json({ ok: true, result: { data: [] } });
        }
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  router.get(
    "/case/:domain/:caseId/payments",
    auth.requireAuth,
    auth.requireUser,
    requireCxDomainAccess,
    async (req, res) => {
      try {
        const {
          createLogicsClient,
        } = require("../../../../packages/shared-integrations/src");
        const client = createLogicsClient(req.params.domain);
        const payload = await client.getCasePayments(req.params.caseId);
        return res.json({ ok: true, result: payload });
      } catch (error) {
        if (error?.details?.responseStatus === 404) {
          return res.json({ ok: true, result: { data: [] } });
        }
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  router.get("/tasks/:domain", auth.requireAuth, auth.requireUser, requireCxDomainAccess, async (req, res) => {
    try {
      const result = await listCxTasks(req.params.domain, req.user);
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/search/:domain", auth.requireAuth, auth.requireUser, requireCxDomainAccess, async (req, res) => {
    try {
      const result = await searchCxCases(req.params.domain, req.user, {
        search: req.query.search,
        limit: req.query.limit,
        scope: req.query.scope,
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/logics/match/:domain", auth.requireAuth, auth.requireUser, requireCxDomainAccess, async (req, res) => {
    try {
      const result = await lookupCxLogicsMatch(req.params.domain, req.user, {
        phone: req.query.phone,
        caseId: req.query.caseId,
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/logics/tasks/:domain", auth.requireAuth, auth.requireUser, requireCxDomainAccess, async (req, res) => {
    try {
      const result = await listCxLogicsTasks(req.params.domain, req.user, {
        startDate: req.query.startDate,
        endDate: req.query.endDate,
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  return router;
}

module.exports = {
  createReadCxRouter,
};
