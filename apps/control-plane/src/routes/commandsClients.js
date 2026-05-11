"use strict";

const express = require("express");
const {
  executeCxLogicsUpdateCase,
  listActiveSourceCanonicals,
  recordWorkflowStage,
  requestCxDial,
  requestCxEmail,
  requestCxLeadStatusUpdate,
  requestCxText,
  runClientCaseScrub,
} = require("../../../../packages/shared-services/src");
const {
  caseProfileRepository,
  masterProspectRepository,
  sourceCanonicalRepository,
} = require("../../../../packages/shared-repositories/src");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");

function createCommandsClientsRouter(auth) {
  const router = express.Router();

  router.post("/:domain/:caseId/text", auth.requireAuth, auth.requireUser, async (req, res) => {
    try {
      const body = { ...(req.body || {}), caseId: Number(req.params.caseId) };
      const result = await requestCxText(req.params.domain, req.user, body);
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/:domain/:caseId/email", auth.requireAuth, auth.requireUser, async (req, res) => {
    try {
      const body = { ...(req.body || {}), caseId: Number(req.params.caseId) };
      const result = await requestCxEmail(req.params.domain, req.user, body);
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/:domain/:caseId/dial", auth.requireAuth, auth.requireUser, async (req, res) => {
    try {
      const body = { ...(req.body || {}), caseId: Number(req.params.caseId) };
      const result = await requestCxDial(req.params.domain, req.user, body);
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/:domain/:caseId/update-status", auth.requireAuth, auth.requireUser, async (req, res) => {
    try {
      const body = { ...(req.body || {}), caseId: Number(req.params.caseId) };
      const hasExecutableStatus =
        body.statusId != null || body.StatusID != null || body.statusId === 0 || body.StatusID === 0;

      const result = hasExecutableStatus
        ? await executeCxLogicsUpdateCase(req.params.domain, req.user, {
            CaseID: Number(req.params.caseId),
            StatusID: body.statusId != null ? Number(body.statusId) : Number(body.StatusID),
            SearchPhone: body.searchPhone || null,
            Notes: body.notes || null,
          })
        : await requestCxLeadStatusUpdate(req.params.domain, req.user, body);

      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/:domain/:caseId/dnc", auth.requireAuth, auth.requireUser, async (req, res) => {
    try {
      const body = { ...(req.body || {}), caseId: Number(req.params.caseId) };
      const result =
        body.statusId != null || body.statusId === 0
          ? await executeCxLogicsUpdateCase(req.params.domain, req.user, {
              CaseID: Number(req.params.caseId),
              StatusID: Number(body.statusId),
              SearchPhone: body.searchPhone || null,
              Notes: body.notes || "DNC requested from client workspace",
            })
          : await requestCxLeadStatusUpdate(req.params.domain, req.user, {
              caseId: Number(req.params.caseId),
              status: body.status || "DNC",
              logicsStatusId: body.logicsStatusId || null,
              notes: body.notes || "DNC requested from client workspace",
              statusFamily: "suppression",
            });

      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/:domain/:caseId/set-source", auth.requireAuth, auth.requireUser, async (req, res) => {
    try {
      const domain = String(req.params.domain || "").toUpperCase();
      const caseId = Number(req.params.caseId);
      const body = req.body || {};

      let canonical = null;
      if (body.sourceCanonicalId) {
        canonical = await sourceCanonicalRepository.findSourceCanonicalById(body.sourceCanonicalId);
      } else if (body.sourceKey) {
        canonical = await sourceCanonicalRepository.findSourceCanonicalByKey(body.sourceKey);
      }

      if (!canonical && body.sourceName) {
        const rows = await listActiveSourceCanonicals(domain);
        canonical =
          rows.find((row) => {
            const sourceName = String(body.sourceName || "").toLowerCase();
            return (
              String(row.internalName || "").toLowerCase() === sourceName ||
              String(row.canonicalKey || "").toLowerCase() === sourceName
            );
          }) || null;
      }

      if (!canonical) {
        return res.status(404).json({ ok: false, error: "Source canonical not found" });
      }

      const note = String(body.note || body.reason || "Manual source override").trim();
      const matchedBy = String(body.matchedBy || "manual").trim() || "manual";

      const [caseProfile, prospect] = await Promise.all([
        caseProfileRepository.updateCaseProfile(domain, caseId, {
          sourceCanonicalId: canonical._id,
          attribution: {
            matchedBy,
            confidence: "manual",
            lockedManual: true,
            needsReview: false,
            reviewReason: null,
            lastResolvedAt: new Date(),
          },
        }),
        masterProspectRepository.updateMasterProspect(domain, caseId, {
          sourceCanonicalId: canonical._id,
          needsSourceRefresh: false,
          "metadata.manualSourceOverride": true,
          "metadata.manualSourceNote": note,
          "metadata.manualSourceSetBy": req.user?.email || null,
        }),
      ]);

      const workflow = await recordWorkflowStage({
        domain,
        family: "client",
        subtype: "manual-source",
        stage: "completed",
        aggregateType: "case-profile",
        aggregateId: String(caseId),
        caseId,
        sourceService: "control-plane",
        title: "Manual source updated",
        summary: `Source set to ${canonical.internalName || canonical.canonicalKey}`,
        payload: {
          sourceCanonicalId: String(canonical._id),
          canonicalKey: canonical.canonicalKey,
          internalName: canonical.internalName,
          note,
          actorEmail: req.user?.email || null,
        },
      });

      return res.json({
        ok: true,
        result: {
          domain,
          caseId,
          sourceCanonicalId: String(canonical._id),
          canonicalKey: canonical.canonicalKey,
          internalName: canonical.internalName,
          workflowId: String(workflow._id),
          caseProfileUpdated: Boolean(caseProfile),
          prospectUpdated: Boolean(prospect),
        },
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/:domain/:caseId/run-scrub", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const result = await runClientCaseScrub(req.params.domain, req.params.caseId, req.user, req.body || {});
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  return router;
}

module.exports = {
  createCommandsClientsRouter,
};
