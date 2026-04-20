"use strict";

const { connectMongo, getMongoState } = require("../../event-core/src");
const { createLogger } = require("../../shared-observability/src");

async function initializeServiceRuntime(config) {
  await connectMongo(config);

  return {
    config,
    logger: createLogger(config.serviceName),
    getMongoState,
  };
}

module.exports = {
  initializeServiceRuntime,
};
