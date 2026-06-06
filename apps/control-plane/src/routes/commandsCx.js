"use strict";

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
  requestCxEmail,
  requestCxLeadStatusUpdate,
  releaseCxPostDateHold,
  requestCxReminder,
  requestCxStatusChange,
  requestCxTask,
  requestCxText,
} = require("../../../../packages/shared-services/src");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");

function createCommandsCxRouter(auth) {
  const router = express.Router();

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
      try {
        const result = await requestCxVoicemailDrop(req.params.domain, req.user, req.body || {});
        return res.json({ ok: true, result });
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
