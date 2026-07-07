"use strict";

const express = require("express");

function createCxSimpleLoopRouter(auth) {
  const router = express.Router();

  router.use(auth.requireAuth, auth.requireUser, (_req, res) => {
    return res.status(410).json({
      ok: false,
      error: {
        code: "cx-simple-loop-retired",
        message: "CX simple-loop is retired. Use the CX bulk workspace.",
      },
    });
  });

  return router;
}

module.exports = {
  createCxSimpleLoopRouter,
};
