"use strict";

const { buildContactTarget } = require("./contacts");
const { CONTROL_PLANE_DOMAIN_KEYS } = require("./controlPlane");
const { EVENT_KINDS, EVENT_TYPES } = require("./events");
const { LOGICS_SCAN_PHASES } = require("./logicsScan");
const { CASE_SYNC_STATES, MATCH_CONFIDENCE, MATCH_METHODS } = require("./sourcing");
const { WORKSPACE_TOOLS } = require("./workspace");

module.exports = {
  buildContactTarget,
  CASE_SYNC_STATES,
  CONTROL_PLANE_DOMAIN_KEYS,
  EVENT_KINDS,
  EVENT_TYPES,
  LOGICS_SCAN_PHASES,
  MATCH_CONFIDENCE,
  MATCH_METHODS,
  WORKSPACE_TOOLS,
};
