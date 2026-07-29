"use strict";

const ruleRegistry = require("./ruleRegistry.v1");
const courseManifest = require("./courseManifest.v1");
const scenarioBlueprints = require("./scenarioBlueprints");

module.exports = Object.freeze({
  id: "trainer-published-content",
  version: "1.0.0",
  status: "draft",
  testOnly: false,
  ruleRegistry,
  courseManifest,
  scenarioBlueprints,
});
