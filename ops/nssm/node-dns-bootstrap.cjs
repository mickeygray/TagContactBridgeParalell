"use strict";

const dns = require("node:dns");

const current = dns.getServers();
const hasUsableServer = current.some((value) => {
  const server = String(value || "").trim().toLowerCase();
  return server
    && server !== "127.0.0.1"
    && server !== "::1"
    && server !== "0.0.0.0"
    && server !== "::";
});

if (!hasUsableServer) {
  dns.setServers(["192.168.1.1", "1.1.1.1"]);
}
