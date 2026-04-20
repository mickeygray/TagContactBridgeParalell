"use strict";

const { buildHealthPayload } = require("../../shared-utils/src");
const { listServiceTopology } = require("../../shared-services/src/serviceCatalog");

function buildServiceHealth(config, mongo) {
  return buildHealthPayload({
    service: config.serviceName,
    port: config.port,
    mongo,
  });
}

function buildTopologyHealth(config) {
  return {
    ok: true,
    services: listServiceTopology(config),
  };
}

module.exports = {
  buildServiceHealth,
  buildTopologyHealth,
};
