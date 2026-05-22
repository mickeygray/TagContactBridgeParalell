#!/usr/bin/env node
"use strict";

// RingCX Call Streaming profile probe.
//
// This is for the older WSS "Call Streaming" product profile path, not the
// Workflow Studio gRPC Start Streaming node.
//
// Safe read-only probe:
//   node scripts/ringcx-wss-stream-profile-test.js --get
//
// Attach/update the test campaign streaming profile:
//   node scripts/ringcx-wss-stream-profile-test.js --apply --streaming-url wss://tag-webhook.ngrok.app/ringcx-stream
//   node scripts/ringcx-wss-stream-profile-test.js --apply --auth-mode x-auth-token
//
// Remove the profile again:
//   node scripts/ringcx-wss-stream-profile-test.js --delete

const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.resolve(".env") });

const { createRingcxVoiceClient } = require("../packages/shared-integrations/src/ringcxVoiceClient");

function readFlag(argv, name, fallback = "") {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1) return argv[idx + 1];
  return fallback;
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function uniq(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value).replace(/\/$/, "")))];
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = /authorization|token|secret|password|key/i.test(key)
      ? "[redacted]"
      : redact(child);
  }
  return out;
}

function buildAuthHeaders({ token, authMode, xAuthToken }) {
  if (authMode === "x-auth-token") {
    if (!xAuthToken) throw new Error("auth-mode x-auth-token requires RINGCX_STREAMING_X_AUTH_TOKEN or --x-auth-token");
    return { "X-Auth-Token": xAuthToken };
  }
  return { Authorization: `${token.tokenType || "Bearer"} ${token.accessToken}` };
}

async function fetchJson(url, { method = "GET", token, authMode, xAuthToken, body } = {}) {
  const headers = {
    ...buildAuthHeaders({ token, authMode, xAuthToken }),
    Accept: "application/json",
    "User-Agent": "tagcontactbridge-parallel/0.1 (ringcx-wss-stream-profile-test)",
  };
  const init = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(url, init);
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return {
    ok: response.ok,
    status: response.status,
    contentType: response.headers.get("content-type") || "",
    json: parsed,
    text: parsed ? "" : text.slice(0, 1000),
  };
}

function buildCandidates({ explicitBase, explicitResource }) {
  const baseCandidates = explicitBase
    ? [explicitBase]
    : uniq([
        process.env.RINGCX_STREAMING_PLATFORM_BASE_URL,
        process.env.RINGCX_CALL_STREAMING_PLATFORM_BASE_URL,
        process.env.RINGCX_VOICE_BASE_URL
          ? `${process.env.RINGCX_VOICE_BASE_URL.replace(/\/$/, "")}/platform/api`
          : "",
        "https://ringcx.ringcentral.com/platform/api",
        "https://ringcx.ringcentral.com/api",
        "https://engage.ringcentral.com/platform/api",
        "https://engage.ringcentral.com/api",
        "https://portal.vacd.biz/platform/api",
        "https://portal.virtualacd.biz/platform/api",
      ]);

  const resourceCandidates = explicitResource
    ? [explicitResource.replace(/^\/+/, "").replace(/\/$/, "")]
    : [
        // API reference currently shows this path.
        "media/product",
        // Developer guide text still mentions this older path.
        "media-distributor/product",
      ];

  const out = [];
  for (const base of baseCandidates) {
    for (const resource of resourceCandidates) {
      out.push({ base, resource });
    }
  }
  return out;
}

function summarizeResponse(response) {
  return {
    status: response.status,
    ok: response.ok,
    apiOk: response.apiOk,
    contentType: response.contentType,
    body: redact(response.json || response.text),
  };
}

function isApiResponse(response) {
  if (!response.ok) return false;
  if (response.json && typeof response.json === "object") return true;
  return /json/i.test(response.contentType || "");
}

function printResult(label, candidate, response) {
  const body = response.json || response.text;
  const preview = typeof body === "string"
    ? body.replace(/\s+/g, " ").slice(0, 220)
    : JSON.stringify(redact(body));
  const status = response.apiOk ? "OK" : "FAIL";
  const note = response.ok && !response.apiOk ? " non-json" : "";
  console.log(`${label} ${candidate.base}/${candidate.resource} -> ${response.status} ${status}${note} ${preview}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const action = hasFlag(argv, "--apply")
    ? "apply"
    : hasFlag(argv, "--delete")
      ? "delete"
      : "get";

  const productType = String(readFlag(argv, "--product-type", process.env.RINGCX_STREAMING_PRODUCT_TYPE || "CAMPAIGN")).toUpperCase();
  const productId = readFlag(
    argv,
    "--product-id",
    process.env.RINGCX_STREAMING_PRODUCT_ID
      || process.env.RINGCX_VOICE_DEFAULT_CAMPAIGN_ID
      || "2306",
  );
  const subAccountId = readFlag(argv, "--sub-account-id", process.env.RINGCX_VOICE_ACCOUNT_ID || "50810001");
  const mainAccountId = readFlag(argv, "--main-account-id", process.env.RINGCX_VOICE_MAIN_ACCOUNT_ID || "50810000");
  const rcAccountId = readFlag(argv, "--rc-account-id", process.env.RINGCX_RECORDING_RC_ACCOUNT_ID || "");
  const streamingUrl = readFlag(
    argv,
    "--streaming-url",
    process.env.RINGCX_STREAMING_URL || "wss://tag-webhook.ngrok.app/ringcx-stream",
  );
  const secret = readFlag(argv, "--secret", process.env.RINGCX_CALL_STREAMING_SECRET || "");
  const explicitBase = readFlag(argv, "--platform-base", "");
  const explicitResource = readFlag(argv, "--resource", "");
  const authMode = String(readFlag(argv, "--auth-mode", process.env.RINGCX_STREAMING_AUTH_MODE || "bearer")).trim().toLowerCase();
  const xAuthToken = readFlag(argv, "--x-auth-token", process.env.RINGCX_STREAMING_X_AUTH_TOKEN || "");
  const firstSuccessOnly = !hasFlag(argv, "--try-all");
  const outDir = path.resolve(readFlag(argv, "--out-dir", path.join("runtime", "ringcx-wss-stream-profile")));
  const auditFile = path.join(outDir, `${stamp()}-${action}.json`);

  if (!productId) throw new Error("Missing product id.");
  if (action === "apply" && !streamingUrl.startsWith("wss://")) {
    throw new Error(`streamingUrl must start with wss:// for RingCX Call Streaming; got ${streamingUrl}`);
  }
  if (action === "apply" && !rcAccountId) {
    throw new Error("Missing rcAccountId. Set RINGCX_RECORDING_RC_ACCOUNT_ID or pass --rc-account-id.");
  }

  ensureDir(outDir);

  const client = createRingcxVoiceClient();
  const token = await client.auth.ensureToken();
  const payload = {
    productType,
    productId: Number(productId) || productId,
    subAccountId,
    mainAccountId,
    rcAccountId,
    streamingUrl,
    ...(secret ? { secret } : {}),
  };
  const candidates = buildCandidates({ explicitBase, explicitResource });
  const audit = {
    at: new Date().toISOString(),
    action,
    target: redact(payload),
    candidates,
    results: [],
  };

  console.log("RingCX WSS streaming profile test");
  console.log(`  action:       ${action}`);
  console.log(`  product:      ${productType} ${productId}`);
  console.log(`  subAccountId: ${subAccountId}`);
  console.log(`  mainAccountId:${mainAccountId}`);
  console.log(`  rcAccountId:  ${rcAccountId || "(missing)"}`);
  console.log(`  streamingUrl: ${streamingUrl}`);
  console.log(`  auth mode:    ${authMode}`);
  console.log(`  audit:        ${auditFile}`);

  let successful = null;
  for (const candidate of candidates) {
    const profileUrl = `${candidate.base}/${candidate.resource}/account/${encodeURIComponent(subAccountId)}/type/${encodeURIComponent(productType)}/id/${encodeURIComponent(productId)}`;
    const collectionUrl = `${candidate.base}/${candidate.resource}`;

    if (action === "get") {
      const response = await fetchJson(profileUrl, { token, authMode, xAuthToken });
      response.apiOk = isApiResponse(response);
      printResult("GET", candidate, response);
      audit.results.push({ candidate, request: { method: "GET", url: profileUrl }, response: summarizeResponse(response) });
      if (response.apiOk && !successful) successful = { candidate, response };
      if (response.apiOk && firstSuccessOnly) break;
      continue;
    }

    if (action === "delete") {
      const response = await fetchJson(profileUrl, { method: "DELETE", token, authMode, xAuthToken });
      response.apiOk = isApiResponse(response);
      printResult("DELETE", candidate, response);
      audit.results.push({ candidate, request: { method: "DELETE", url: profileUrl }, response: summarizeResponse(response) });
      if (response.apiOk && !successful) successful = { candidate, response };
      if (response.apiOk && firstSuccessOnly) break;
      continue;
    }

    const existing = await fetchJson(profileUrl, { token, authMode, xAuthToken });
    existing.apiOk = isApiResponse(existing);
    printResult("GET", candidate, existing);
    audit.results.push({ candidate, request: { method: "GET", url: profileUrl }, response: summarizeResponse(existing) });

    const method = existing.apiOk ? "PUT" : "POST";
    const response = await fetchJson(collectionUrl, { method, token, authMode, xAuthToken, body: payload });
    response.apiOk = isApiResponse(response);
    printResult(method, candidate, response);
    audit.results.push({
      candidate,
      request: { method, url: collectionUrl, body: redact(payload) },
      response: summarizeResponse(response),
    });
    if (response.apiOk && !successful) successful = { candidate, response };
    if (response.apiOk && firstSuccessOnly) break;
  }

  fs.writeFileSync(auditFile, JSON.stringify(audit, null, 2));
  if (!successful) {
    console.log("\nNo streaming profile endpoint succeeded. See audit file for exact statuses.");
    process.exitCode = 2;
    return;
  }

  console.log(`\nSuccess via ${successful.candidate.base}/${successful.candidate.resource}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
