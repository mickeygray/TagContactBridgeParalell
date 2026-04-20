"use strict";

const express = require("express");
const {
  buildClientDetail,
  searchClientWorkspace,
} = require("../../../../packages/shared-services/src");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");

function createReadClientsRouter(auth) {
  const router = express.Router();

  router.get("/search/:domain", auth.requireAuth, async (req, res) => {
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

  router.get("/case/:domain/:caseId", auth.requireAuth, async (req, res) => {
    try {
      const result = await buildClientDetail(req.params.domain, req.params.caseId);
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
