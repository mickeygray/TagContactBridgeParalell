"use strict";

const path = require("path");

require("dotenv").config({
  path: path.resolve(__dirname, "..", ".env"),
});

const AGENT_API_BASE = String(process.env.NGROK_AGENT_API_URL || "http://127.0.0.1:4040")
  .trim()
  .replace(/\/+$/, "");
const DOMAIN = String(process.env.NGROK_DOMAIN || "tagcontactbridge.ngrok.app").trim();
const TARGET_PORT = String(process.env.NGROK_PARALLEL_FORWARD_PORT || "81").trim();
const TUNNEL_NAME = String(process.env.NGROK_PARALLEL_TUNNEL_NAME || "parallel-nginx").trim();
const TARGET_ADDR = `http://localhost:${TARGET_PORT}`;

async function safeJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

async function getTunnel(name) {
  const response = await fetch(`${AGENT_API_BASE}/api/tunnels/${encodeURIComponent(name)}`, {
    method: "GET",
  });
  if (response.status === 404) return null;
  const body = await safeJson(response);
  if (!response.ok) {
    throw new Error(`ngrok agent GET tunnel failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function createTunnel() {
  const response = await fetch(`${AGENT_API_BASE}/api/tunnels`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: TUNNEL_NAME,
      addr: TARGET_ADDR,
      proto: "http",
      hostname: DOMAIN,
      inspect: true,
    }),
  });
  const body = await safeJson(response);
  if (!response.ok) {
    throw new Error(`ngrok agent CREATE tunnel failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

function tunnelMatches(tunnel) {
  if (!tunnel || typeof tunnel !== "object") return false;
  const publicUrl = String(tunnel.public_url || "").trim().toLowerCase();
  const addr = String(tunnel.config?.addr || "").trim().toLowerCase();
  return publicUrl === `https://${DOMAIN}`.toLowerCase() && addr === TARGET_ADDR.toLowerCase();
}

async function main() {
  const existing = await getTunnel(TUNNEL_NAME);
  if (tunnelMatches(existing)) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          changed: false,
          message: "parallel ngrok tunnel already present",
          tunnel: {
            name: existing.name,
            public_url: existing.public_url,
            addr: existing.config?.addr || null,
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  const created = await createTunnel();
  console.log(
    JSON.stringify(
      {
        ok: true,
        changed: true,
        message: "parallel ngrok tunnel created",
        tunnel: {
          name: created.name,
          public_url: created.public_url,
          addr: created.config?.addr || null,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        message: error.message,
        agentApiBase: AGENT_API_BASE,
        domain: DOMAIN,
        targetAddr: TARGET_ADDR,
        tunnelName: TUNNEL_NAME,
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
