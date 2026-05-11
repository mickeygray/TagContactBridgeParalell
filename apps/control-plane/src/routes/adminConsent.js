"use strict";

const express = require("express");
const { consentRecordRepository } = require("../../../../packages/shared-repositories/src");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");

function createAdminConsentRouter(auth) {
  const router = express.Router();

  router.get("/consent-records", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const filters = {
        domain: req.query.domain,
        company: req.query.company,
        email: req.query.email,
        phone: req.query.phone,
        caseId: req.query.caseId,
        source: req.query.source,
        from: req.query.from,
        to: req.query.to,
        limit: req.query.limit,
      };

      const [records, total] = await Promise.all([
        consentRecordRepository.listConsentRecords(filters),
        consentRecordRepository.countConsentRecords(filters),
      ]);

      return res.json({ ok: true, total, records });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/consent-records/:id", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const record = await consentRecordRepository.findConsentRecordById(req.params.id);
      if (!record) {
        return res.status(404).json({ ok: false, error: "Consent record not found" });
      }
      return res.json({ ok: true, record });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/consent-stats", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const stats = await consentRecordRepository.getConsentStats({
        domain: req.query.domain,
        company: req.query.company,
        email: req.query.email,
        phone: req.query.phone,
        caseId: req.query.caseId,
        source: req.query.source,
        from: req.query.from,
        to: req.query.to,
      });
      return res.json({ ok: true, stats });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  return router;
}

module.exports = {
  createAdminConsentRouter,
};
