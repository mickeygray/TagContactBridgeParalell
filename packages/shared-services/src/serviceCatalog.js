"use strict";

function listServiceTopology(config) {
  return [
    { name: "control-plane", port: config.ports.controlPlane },
    { name: "inbound-gateway", port: config.ports.inboundGateway },
    { name: "outbound-gateway", port: config.ports.outboundGateway },
    { name: "ringcentral-cx", port: config.ports.ringcentralCx },
    { name: "brand-ssh-gateway", port: config.ports.brandSshGateway },
    { name: "web-client", port: config.ports.webClient },
  ];
}

module.exports = {
  listServiceTopology,
};
