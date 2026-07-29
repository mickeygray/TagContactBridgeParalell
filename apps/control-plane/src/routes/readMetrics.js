"use strict";

const express = require("express");
const {
  buildSimpleMarketingSummary,
  listMetricsAttributionReviewItems,
} = require("../../../../packages/shared-services/src");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");

function createReadMetricsRouter(auth) {
  const router = express.Router();

  // The lean read: active mail pieces + one Aged rollup, from the four
  // declared inputs only (DailyCallStat + SpendEntry + PaymentLedger +
  // CaseProfile). Sub-second by construction — never touches the legacy
  // aggregation layers.
  router.get("/simple-sources/:domain", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const result = await buildSimpleMarketingSummary({
        domain: req.params.domain,
        from: req.query.from,
        to: req.query.to,
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/attribution-review/:domain", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const result = await listMetricsAttributionReviewItems(req.params.domain, {
        status: req.query.status,
        date: req.query.date,
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
  createReadMetricsRouter,
};
