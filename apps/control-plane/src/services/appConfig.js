"use strict";

const {
  getSharedConfig,
  PORTS,
  SERVICE_NAMES,
} = require("../../../../packages/shared-config/src");

function getControlPlaneConfig() {
  return {
    ...getSharedConfig(),
    serviceName: SERVICE_NAMES.controlPlane,
    port: PORTS.controlPlane,
  };
}

module.exports = {
  getControlPlaneConfig,
};
