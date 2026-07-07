"use strict";

const express = require("express");

function createCxSlowSingleRouter(auth) {
  const router = express.Router();

  router.use(auth.requireAuth, auth.requireUser, (_req, res) => {
    return res.status(410).json({
      ok: false,
      error: {
        code: "cx-slow-single-retired",
        message: "CX slow-single is retired. Use the CX bulk workspace.",
      },
    });
  });

  return router;
}

module.exports = {
  createCxSlowSingleRouter,
};
