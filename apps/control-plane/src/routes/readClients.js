"use strict";

const express = require("express");
const {
  buildClientDetail,
  buildClientWorkspaceList,
  listActiveSourceCanonicals,
  searchClientWorkspace,
} = require("../../../../packages/shared-services/src");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");

function createReadClientsRouter(auth) {
  const router = express.Router();

  router.get("/list/:domain", auth.requireAuth, auth.requireUser, async (req, res) => {
    try {
      const result = await buildClientWorkspaceList(req.params.domain, {
        search: req.query.search,
        status: req.query.status,
        statusCategory: req.query.statusCategory,
        sortBy: req.query.sortBy,
        sortDir: req.query.sortDir,
        activeCadence: req.query.activeCadence,
        hasPayments: req.query.hasPayments,
        aiStatus: req.query.aiStatus,
        limit: req.query.limit,
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/search/:domain", auth.requireAuth, auth.requireUser, async (req, res) => {
    try {
      const result = await searchClientWorkspace(req.params.domain, {
        search: req.query.search,
        limit: req.query.limit,
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/case/:domain/:caseId", auth.requireAuth, auth.requireUser, async (req, res) => {
    try {
      const result = await buildClientDetail(req.params.domain, req.params.caseId, {
        viewer: req.user?.email || null,
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/sources/:domain", auth.requireAuth, auth.requireUser, async (req, res) => {
    try {
      const result = await listActiveSourceCanonicals(req.params.domain);
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  return router;
}

module.exports = {
  createReadClientsRouter,
};
