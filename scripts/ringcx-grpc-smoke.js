#!/usr/bin/env node
"use strict";

// gRPC smoke test for the RingCX Workflow Studio Start-Streaming probe.
//
// Sends a real gRPC frame (length-prefixed body, content-type: application/grpc,
// te: trailers) to one or more targets and verifies that grpc-status: 0
// trailer comes back. If this passes for the ngrok target, the entire
// network path — DNS + TLS + ngrok + h2 + your probe — is gRPC-clean.
// Any failure with RingCX after this is on the RingCX/Workflow Studio
// side, not the transport.
//
// Usage:
//   node scripts/ringcx-grpc-smoke.js
//     → runs both local + ngrok tests with defaults
//
//   node scripts/ringcx-grpc-smoke.js --url grpc://bethel-twee-agonisedly.ngrok-free.dev/ringcx/stream
//     → custom target
//
//   node scripts/ringcx-grpc-smoke.js --payload "hello probe"
//   node scripts/ringcx-grpc-smoke.js --skip-local
//   node scripts/ringcx-grpc-smoke.js --skip-ngrok
//
// Exit code 0 if everything tested passes, 1 if any test fails.

const http2 = require("http2");
const { URL } = require("url");

const DEFAULT_LOCAL = "grpc://localhost:3334/ringcx/stream";
const DEFAULT_NGROK = "grpc://bethel-twee-agonisedly.ngrok-free.dev/ringcx/stream";

function readFlag(name, fallback = null) {
  const argv = process.argv.slice(2);
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1) return argv[idx + 1];
  return fallback;
}

function hasFlag(name) {
  return process.argv.slice(2).includes(name);
}

function buildGrpcFrame(payload) {
  const body = Buffer.from(payload, "utf8");
  // Frame: 1 byte compressed flag (0) + 4 bytes big-endian length + payload
  const header = Buffer.alloc(5);
  header.writeUInt8(0, 0); // not compressed
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

function normalizeTransportUrl(target) {
  const value = String(target || "").trim();
  if (/^grpcs:\/\//i.test(value)) {
    return new URL(value.replace(/^grpcs:\/\//i, "https://"));
  }
  if (/^grpc:\/\//i.test(value)) {
    const probe = new URL(value.replace(/^grpc:\/\//i, "http://"));
    const host = probe.hostname.toLowerCase();
    const cleartext = host === "localhost" || host === "127.0.0.1" || host === "::1";
    return new URL(value.replace(/^grpc:\/\//i, cleartext ? "http://" : "https://"));
  }
  return new URL(value);
}

async function runOne({ label, target, payload }) {
  const url = normalizeTransportUrl(target);
  const authority = `${url.protocol}//${url.host}`;
  // http2.connect with allowHTTP1 false. For https we go through TLS, which
  // includes ALPN-negotiated h2. For http (local h2c) we explicitly tell
  // http2.connect to use cleartext h2.
  const session = http2.connect(authority, {
    // RingCX probably presents a valid cert chain via ngrok; allow self-signed
    // dev certs by NOT setting rejectUnauthorized=false here (let TLS verify).
    // If you ever need to test against a localhost TLS cert, add an env knob.
  });

  return new Promise((resolve) => {
    const result = {
      label,
      target,
      ok: false,
      status: null,
      grpcStatus: null,
      grpcMessage: null,
      contentType: null,
      bodySize: 0,
      elapsedMs: null,
      error: null,
      headers: null,
      trailers: null,
    };
    const startedAt = Date.now();

    session.on("error", (err) => {
      result.error = `session error: ${err.message}`;
      try { session.close(); } catch {}
      resolve(result);
    });

    const frame = buildGrpcFrame(payload);

    const req = session.request({
      ":method": "POST",
      ":path": url.pathname + (url.search || ""),
      ":scheme": url.protocol.replace(":", ""),
      ":authority": url.host,
      "content-type": "application/grpc",
      "te": "trailers",
      "user-agent": "ringcx-grpc-smoke/1.0",
      "grpc-encoding": "identity",
      "grpc-accept-encoding": "identity",
      "content-length": String(frame.length),
    });

    req.on("response", (headers) => {
      result.status = headers[":status"] || null;
      result.contentType = headers["content-type"] || null;
      result.headers = headers;
    });

    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));

    req.on("trailers", (trailers) => {
      result.trailers = trailers;
      result.grpcStatus = trailers["grpc-status"] != null
        ? String(trailers["grpc-status"])
        : null;
      result.grpcMessage = trailers["grpc-message"] || null;
    });

    req.on("end", () => {
      result.bodySize = Buffer.concat(chunks).length;
      result.elapsedMs = Date.now() - startedAt;
      result.ok = result.status === 200 && result.grpcStatus === "0";
      try { session.close(); } catch {}
      resolve(result);
    });

    req.on("error", (err) => {
      result.error = `request error: ${err.message}`;
      result.elapsedMs = Date.now() - startedAt;
      try { session.close(); } catch {}
      resolve(result);
    });

    req.write(frame);
    req.end();
  });
}

function logResult(r) {
  const passLabel = r.ok ? "PASS" : "FAIL";
  console.log(`\n[${passLabel}] ${r.label}`);
  console.log(`  target:        ${r.target}`);
  console.log(`  status:        ${r.status ?? "(none)"}`);
  console.log(`  content-type:  ${r.contentType ?? "(none)"}`);
  console.log(`  grpc-status:   ${r.grpcStatus ?? "(no trailer)"}`);
  if (r.grpcMessage) console.log(`  grpc-message:  ${r.grpcMessage}`);
  console.log(`  body size:     ${r.bodySize} bytes`);
  console.log(`  elapsed:       ${r.elapsedMs} ms`);
  if (r.error) console.log(`  error:         ${r.error}`);
}

(async () => {
  const payload = readFlag("--payload", "smoke");
  const customUrl = readFlag("--url", null);

  const targets = [];
  if (customUrl) {
    targets.push({ label: "custom", target: customUrl });
  } else {
    if (!hasFlag("--skip-local")) targets.push({ label: "local (h2c → :3334)", target: DEFAULT_LOCAL });
    if (!hasFlag("--skip-ngrok")) targets.push({ label: "ngrok (h2 over TLS)",  target: DEFAULT_NGROK });
  }

  if (targets.length === 0) {
    console.error("Nothing to test. Pass --url <target> or remove --skip-* flags.");
    process.exit(2);
  }

  console.log(`Payload: "${payload}" (${Buffer.from(payload, "utf8").length} bytes)`);
  const results = [];
  for (const { label, target } of targets) {
    const r = await runOne({ label, target, payload });
    logResult(r);
    results.push(r);
  }

  const allOk = results.every((r) => r.ok);
  console.log(`\n${"=".repeat(40)}`);
  console.log(allOk ? "ALL TESTS PASSED ✓" : "SOME TESTS FAILED ✗");
  console.log(`${"=".repeat(40)}\n`);
  process.exit(allOk ? 0 : 1);
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
