"use strict";

const express = require("express");
const {
  buildControlPlaneReadOverview,
  listPresentationCaseProfiles,
  listPresentationPayments,
  listPresentationProspects,
} = require("../../../../packages/shared-services/src");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");

function createReadRouter(auth) {
  const router = express.Router();

  router.get("/overview/:domain", auth.requireAuth, async (req, res) => {
    try {
      const result = await buildControlPlaneReadOverview(req.params.domain);
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/prospects/:domain", auth.requireAuth, async (req, res) => {
    try {
      const result = await listPresentationProspects(req.params.domain, {
        caseId: req.query.caseId,
        search: req.query.search,
        statusId: req.query.statusId,
        statusCategory: req.query.statusCategory,
        converted: req.query.converted === undefined ? undefined : req.query.converted === "true",
        limit: req.query.limit,
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/case-profiles/:domain", auth.requireAuth, async (req, res) => {
    try {
      const result = await listPresentationCaseProfiles(req.params.domain, {
        caseId: req.query.caseId,
        search: req.query.search,
        statusCategory: req.query.statusCategory,
        hasPayments: req.query.hasPayments === undefined ? undefined : req.query.hasPayments === "true",
        aiStatus: req.query.aiStatus,
        limit: req.query.limit,
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/payments/:domain", auth.requireAuth, async (req, res) => {
    try {
      const result = await listPresentationPayments(req.params.domain, {
        caseId: req.query.caseId,
        transactionStatus: req.query.transactionStatus,
        limit: req.query.limit,
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  return router;
}

module.exports = {
  createReadRouter,
};
