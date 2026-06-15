"use strict";

const crypto = require("crypto");
const express = require("express");
const {
  executeCxLogicsCreateCase,
  executeCxSaveCaseProfileFromLogics,
  enqueueCxSmokeLead,
  executeCxLogicsFindMatch,
  simulateCxIncomingCall,
  executeCxLogicsActivity,
  executeCxInterviewSnapshot,
  executeCxLogicsAmortization,
  executeCxLogicsInvoice,
  executeCxLogicsNotes,
  executeCxLogicsTask,
  executeCxLogicsUpdateCase,
  createCxAppointment,
  fireCxAppointmentNow,
  releaseCxAppointment,
  requestCxAssignCaseToMe,
  requestCxDial,
  requestCxEndCall,
  requestCxDisposition,
  requestCxVoicemailDrop,
  listVmDropThemes,
  vmDropMode,
  requestCxEmail,
  requestCxLeadStatusUpdate,
  releaseCxPostDateHold,
  requestCxReminder,
  requestCxStatusChange,
  requestCxTask,
  requestCxText,
} = require("../../../../packages/shared-services/src");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");

function createCommandsCxRouter(auth, options = {}) {
  const router = express.Router();
  const logger = options.logger || console;

  function maskEmail(value) {
    const raw = String(value || "").trim();
    if (!raw) return null;
    const [name, domain] = raw.split("@");
    if (!domain) return raw.length <= 3 ? "***" : `${raw.slice(0, 3)}***`;
    return `${name.slice(0, 3)}***@${domain}`;
  }

  function phoneLast4(value) {
    const digits = String(value || "").replace(/\D/g, "");
    return digits ? digits.slice(-4) : null;
  }

  function summarizeProviderBody(body) {
    if (!body || typeof body !== "object") return body ? String(body).slice(0, 300) : null;
    const errors = Array.isArray(body.errors)
      ? body.errors.slice(0, 3).map((entry) => ({
          errorCode: entry?.errorCode || null,
          message: entry?.message || entry?.generalMessage || null,
        }))
      : undefined;
    return {
      errorCode: body.errorCode || null,
      generalMessage: body.generalMessage || null,
      message: body.message || null,
      requestUri: body.requestUri || null,
      timestamp: body.timestamp || null,
      errors,
    };
  }

  function summarizeError(error) {
    const details = error?.details || {};
    return {
      name: error?.name || null,
      message: error?.message || "Unknown error",
      code: error?.code || null,
      status: error?.status || details.responseStatus || 500,
      retryable: Boolean(error?.retryable),
      service: error?.service || details.service || null,
      method: details.method || null,
      path: details.path || null,
      responseStatus: details.responseStatus || null,
      retryAfter: details.retryAfter || details.retryAfterSeconds || null,
      rateLimitedCircuitOpen: Boolean(details.rateLimitedCircuitOpen),
      rateLimitedCircuitOpened: Boolean(details.rateLimitedCircuitOpened),
      scope: details.scope || null,
      usageGroup: details.usageGroup || details.rateLimitHeaders?.group || null,
      nextApiAttemptAt: details.nextApiAttemptAt || null,
      rateLimitHeaders: details.rateLimitHeaders
        ? {
            group: details.rateLimitHeaders.group || null,
            limit: details.rateLimitHeaders.limit || null,
            remaining: details.rateLimitHeaders.remaining || null,
            window: details.rateLimitHeaders.window || null,
            retryAfter: details.rateLimitHeaders.retryAfter || null,
          }
        : null,
      responseBody: summarizeProviderBody(details.responseBody),
    };
  }

  async function requireDialingWindow(req, res, next) {
    try {
      if (req.user?.role === "admin") return next();
      const { getPacingConfig } = require("../../../../packages/shared-services/src");
      const { isOperatingNow } =
        require("../../../../packages/shared-services/src/businessHoursGuard");
      const pacing = await getPacingConfig();
      if (isOperatingNow(pacing)) return next();
      return res.status(403).json({
        ok: false,
        error: "CX dialing is closed outside business hours",
        code: "outside-business-hours",
        businessHours: {
          timezone: pacing.businessHoursTimezone || "America/Los_Angeles",
          startHour: pacing.businessHoursStart,
          endHour: pacing.businessHoursEnd,
          days: pacing.businessDays || [],
        },
      });
    } catch (error) {
      return next(error);
    }
  }

  async function handleSmokeQueue(req, res) {
    try {
      const input = req.method === "GET" ? req.query || {} : req.body || {};
      const result = await enqueueCxSmokeLead(req.params.domain, req.user, input);
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  }

  router.post(
    "/:domain/set-status",
    auth.requireAuth,
    auth.requireUser,
    auth.requirePermission("agents.toggle-availability"),
    auth.requireCxOAuth,
    async (req, res) => {
      try {
        const result = await requestCxStatusChange(req.params.domain, req.user, req.body || {});
        return res.json({ ok: true, result });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  router.post(
    "/:domain/disposition",
    auth.requireAuth,
    auth.requireUser,
    auth.requirePermission("queue.dispose"),
    auth.requireCxOAuth,
    async (req, res) => {
      try {
        const result = await requestCxDisposition(req.params.domain, req.user, req.body || {});
        return res.json({ ok: true, result });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  router.post(
    "/:domain/voicemail-drop",
    auth.requireAuth,
    auth.requireUser,
    auth.requirePermission("queue.dispose"),
    auth.requireCxOAuth,
    async (req, res) => {
      const requestId = crypto.randomUUID();
      const startedAt = Date.now();
      const body = req.body || {};
      logger.info?.("cx.voicemail_drop.request", {
        requestId,
        domain: req.params.domain,
        userEmail: maskEmail(req.user?.email),
        userRole: req.user?.role || null,
        action: body.action || body.mode || "play",
        caseId: body.caseId || null,
        queueItemId: body.queueItemId || null,
        phoneLast4: phoneLast4(body.phone || body.prospectPhone || body.leadPhone),
      });
      try {
        const result = await requestCxVoicemailDrop(req.params.domain, req.user, body, {
          logger,
          requestId,
        });
        logger.info?.("cx.voicemail_drop.completed", {
          requestId,
          domain: req.params.domain,
          userEmail: maskEmail(req.user?.email),
          elapsedMs: Date.now() - startedAt,
          mode: result?.mode || null,
          disposition: result?.drop?.disposition || result?.theme?.disposition || null,
          uii: result?.uii || null,
          matchedBy: result?.matchedBy || null,
          skipped: Boolean(result?.skipped),
        });
        return res.json({ ok: true, result });
      } catch (error) {
        logger.warn?.("cx.voicemail_drop.failed", {
          requestId,
          domain: req.params.domain,
          userEmail: maskEmail(req.user?.email),
          elapsedMs: Date.now() - startedAt,
          error: summarizeError(error),
        });
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  // Themed VM-drop menu for the client select (disposition mode). Static
  // config read — no CX OAuth needed, any authed agent may read it.
  router.get(
    "/:domain/voicemail-drop/themes",
    auth.requireAuth,
    auth.requireUser,
    async (req, res) => {
      try {
        return res.json({
          ok: true,
          mode: vmDropMode(),
          themes: listVmDropThemes().map(({ key, label, urgency }) => ({ key, label, urgency: urgency || null })),
        });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  router.post("/:domain/create-task", auth.requireAuth, auth.requireUser, async (req, res) => {
    try {
      const result = await requestCxTask(req.params.domain, req.user, req.body || {});
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/:domain/create-reminder", auth.requireAuth, auth.requireUser, async (req, res) => {
    try {
      const result = await requestCxReminder(req.params.domain, req.user, req.body || {});
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/:domain/text", auth.requireAuth, auth.requireUser, async (req, res) => {
    try {
      const result = await requestCxText(req.params.domain, req.user, req.body || {});
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/:domain/email", auth.requireAuth, auth.requireUser, async (req, res) => {
    try {
      const result = await requestCxEmail(req.params.domain, req.user, req.body || {});
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post(
    "/:domain/assign-case-to-me",
    auth.requireAuth,
    auth.requireUser,
    auth.requirePermission("queue.dispose"),
    async (req, res) => {
      try {
        const result = await requestCxAssignCaseToMe(req.params.domain, req.user, req.body || {});
        return res.json({ ok: true, result });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  router.post(
    "/:domain/dial",
    auth.requireAuth,
    auth.requireUser,
    auth.requirePermission("queue.dial"),
    requireDialingWindow,
    auth.requireCxOAuth,
    async (req, res) => {
      try {
        const result = await requestCxDial(req.params.domain, req.user, req.body || {});
        return res.json({ ok: true, result });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  router.post(
    "/:domain/end-call",
    auth.requireAuth,
    auth.requireUser,
    auth.requirePermission("queue.dispose"),
    auth.requireCxOAuth,
    async (req, res) => {
      try {
        const result = await requestCxEndCall(req.params.domain, req.user, req.body || {});
        return res.json({ ok: true, result });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  router.get("/:domain/smoke-queue", auth.requireAuth, auth.requireUser, requireDialingWindow, handleSmokeQueue);
  router.post("/:domain/smoke-queue", auth.requireAuth, auth.requireUser, requireDialingWindow, handleSmokeQueue);

  router.post("/:domain/logics/create-case", auth.requireAuth, auth.requireUser, async (req, res) => {
    try {
      const result = await executeCxLogicsCreateCase(req.params.domain, req.user, req.body || {});
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  // Dev/QA: pretend an inbound RC call is connecting to this agent.
  // POST { phone, direction? = "inbound", fromName? } and the agent's
  // state row gets a synthetic currentCall — the CX workspace's
  // auto-scramble chain (currentCallPhone → useCxLeadLookup) fires on
  // the next workspace refresh. POST with no phone clears the call.
  router.post("/:domain/simulate-call", auth.requireAuth, auth.requireUser, async (req, res) => {
    try {
      const result = await simulateCxIncomingCall(req.params.domain, req.user, req.body || {});
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/:domain/save-case-profile", auth.requireAuth, auth.requireUser, async (req, res) => {
    try {
      const result = await executeCxSaveCaseProfileFromLogics(req.params.domain, req.user, req.body || {});
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/:domain/logics/find-match", auth.requireAuth, auth.requireUser, async (req, res) => {
    try {
      const result = await executeCxLogicsFindMatch(req.params.domain, req.user, req.body || {});
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/:domain/logics/update-status", auth.requireAuth, auth.requireUser, async (req, res) => {
    try {
      const result = await requestCxLeadStatusUpdate(req.params.domain, req.user, req.body || {});
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post(
    "/:domain/postdates/release",
    auth.requireAuth,
    auth.requireAdmin,
    async (req, res) => {
      try {
        const result = await releaseCxPostDateHold(req.params.domain, req.user, req.body || {});
        return res.json({ ok: true, result });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  router.post(
    "/:domain/appointments",
    auth.requireAuth,
    auth.requireUser,
    auth.requirePermission("queue.dispose"),
    async (req, res) => {
      try {
        const result = await createCxAppointment(req.params.domain, req.user, req.body || {});
        return res.json({ ok: true, result });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  router.post(
    "/:domain/appointments/release",
    auth.requireAuth,
    auth.requireUser,
    auth.requirePermission("queue.dispose"),
    async (req, res) => {
      try {
        const result = await releaseCxAppointment(req.params.domain, req.user, req.body || {});
        return res.json({ ok: true, result });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  router.post(
    "/:domain/appointments/call-now",
    auth.requireAuth,
    auth.requireUser,
    auth.requirePermission("queue.dial"),
    requireDialingWindow,
    auth.requireCxOAuth,
    async (req, res) => {
      try {
        const fireResult = await fireCxAppointmentNow(req.params.domain, req.user, {
          ...(req.body || {}),
          requirePhone: true,
        });
        const appointment = fireResult?.result?.appointment || null;
        const queueItem = fireResult?.result?.queueItem || null;

        if (fireResult?.result?.deferred) {
          return res.json({
            ok: true,
            result: {
              ok: true,
              deferred: true,
              fireResult,
              dialResult: null,
            },
          });
        }

        if (!fireResult?.result?.ok) {
          return res.status(409).json({
            ok: false,
            error: fireResult?.result?.reason || fireResult?.result?.error || "Appointment could not be queued",
            code: "appointment-call-now-blocked",
            fireResult,
          });
        }

        const queueItemId = String(queueItem?._id || appointment.cxQueueRecordId || "").trim();
        const dialResult = await requestCxDial(req.params.domain, req.user, {
          phone: appointment.phone,
          caseId: appointment.caseId,
          queueItemId,
          queueTicketId: queueItemId,
          queueActionKey: appointment.queueActionKey || queueItem?.metadata?.actionKey || undefined,
          assignedExtensionId: appointment.agentExtensionId || undefined,
          priority: "appointment-now",
          ringcxDialPriority: "IMMEDIATE",
          notes: "appointment-call-now",
        });

        return res.json({
          ok: true,
          result: {
            ok: true,
            deferred: false,
            fireResult,
            dialResult,
          },
        });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  router.post("/:domain/logics/task", auth.requireAuth, auth.requireUser, async (req, res) => {
    try {
      const result = await executeCxLogicsTask(req.params.domain, req.user, req.body || {});
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/:domain/logics/activity", auth.requireAuth, auth.requireUser, async (req, res) => {
    try {
      const result = await executeCxLogicsActivity(req.params.domain, req.user, req.body || {});
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/:domain/interview-snapshot", auth.requireAuth, auth.requireUser, async (req, res) => {
    try {
      const result = await executeCxInterviewSnapshot(req.params.domain, req.user, req.body || {});
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/:domain/logics/update-case", auth.requireAuth, auth.requireUser, async (req, res) => {
    try {
      const result = await executeCxLogicsUpdateCase(req.params.domain, req.user, req.body || {});
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  // Notes-only update — separate from update-case so it can be permissioned
  // independently and audited as a distinct subtype. Body: { caseId, notes }
  // (notes is required; pass empty string to clear).
  router.post("/:domain/logics/notes", auth.requireAuth, auth.requireUser, async (req, res) => {
    try {
      const result = await executeCxLogicsNotes(req.params.domain, req.user, req.body || {});
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/:domain/logics/invoice", auth.requireAuth, auth.requireUser, async (req, res) => {
    try {
      const result = await executeCxLogicsInvoice(req.params.domain, req.user, req.body || {});
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/:domain/logics/amortization", auth.requireAuth, auth.requireUser, async (req, res) => {
    try {
      const result = await executeCxLogicsAmortization(req.params.domain, req.user, req.body || {});
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  return router;
}

module.exports = {
  createCommandsCxRouter,
};
