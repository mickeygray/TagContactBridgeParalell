#!/usr/bin/env node
"use strict";

// Local tag-webhook front door.
//
// ngrok can only point a reserved domain at one local port. During coach
// tests we need tag-webhook.ngrok.app to serve both browser/app requests and
// RingCX HTTP/2 gRPC streaming. This tiny h2c proxy keeps gRPC on the bridge
// port and sends ordinary browser/API traffic to the control-plane port.

const http = require("http");
const http2 = require("http2");
const net = require("net");
const path = require("path");

require("dotenv").config({
  path: path.resolve(__dirname, "..", ".env"),
});

function readFlag(argv, name, fallback = "") {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1) return argv[idx + 1];
  return fallback;
}

function cleanInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

const argv = process.argv.slice(2);
const PORT = cleanInt(readFlag(argv, "--port", process.env.TAG_WEBHOOK_PROXY_PORT || "3345"), 3345);
const GRPC_TARGET_PORT = cleanInt(
  readFlag(argv, "--grpc-port", process.env.TAG_WEBHOOK_GRPC_TARGET_PORT || "3344"),
  3344,
);
const WEB_TARGET_PORT = cleanInt(
  readFlag(argv, "--web-port", process.env.TAG_WEBHOOK_WEB_TARGET_PORT || "5001"),
  5001,
);
const GRPC_TARGET = `http://127.0.0.1:${GRPC_TARGET_PORT}`;

function headerValue(headers, name) {
  const value = headers[name] || headers[String(name).toLowerCase()];
  return Array.isArray(value) ? String(value[0] || "") : String(value || "");
}

function isGrpcRequest(headers) {
  const contentType = headerValue(headers, "content-type").toLowerCase();
  const pathName = String(headers[":path"] || "");
  return (
    contentType.includes("application/grpc") ||
    pathName.includes("/ringcentral.ringcx.streaming.") ||
    pathName.includes("/Streaming/Stream")
  );
}

function filterResponseHeaders(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === ":status") continue;
    if (lower === "connection" || lower === "upgrade" || lower === "keep-alive") continue;
    if (lower === "transfer-encoding" || lower === "te") continue;
    if (lower === "content-length" && value === undefined) continue;
    out[lower] = value;
  }
  return out;
}

function respondJson(stream, status, body) {
  stream.respond({
    ":status": status,
    "content-type": "application/json; charset=utf-8",
  });
  stream.end(JSON.stringify(body));
}

function proxyGrpc(stream, headers) {
  const client = http2.connect(GRPC_TARGET);
  let responded = false;
  let closed = false;

  const closeClient = () => {
    if (closed) return;
    closed = true;
    client.close();
  };

  client.on("error", (error) => {
    if (!responded && !stream.destroyed) {
      respondJson(stream, 502, { ok: false, error: `gRPC bridge unavailable: ${error.message}` });
    }
    closeClient();
  });

  const proxyHeaders = { ...headers };
  delete proxyHeaders[":authority"];
  const upstream = client.request(proxyHeaders);

  upstream.on("response", (responseHeaders) => {
    responded = true;
    if (!stream.destroyed) {
      stream.respond(responseHeaders);
    }
  });

  upstream.on("trailers", (trailers) => {
    if (!stream.destroyed && typeof stream.sendTrailers === "function") {
      try {
        stream.sendTrailers(trailers);
      } catch {
        // Some browser/non-gRPC probes cannot receive trailers. The data path
        // already carried the useful response, so this is safe to ignore.
      }
    }
  });

  upstream.on("error", (error) => {
    if (!responded && !stream.destroyed) {
      respondJson(stream, 502, { ok: false, error: `gRPC upstream failed: ${error.message}` });
    }
    closeClient();
  });

  upstream.on("end", closeClient);
  upstream.on("close", closeClient);
  stream.on("close", closeClient);
  stream.pipe(upstream);
  upstream.pipe(stream);
}

function proxyWeb(stream, headers) {
  const method = String(headers[":method"] || "GET").toUpperCase();
  const targetPath = String(headers[":path"] || "/");
  const requestHeaders = {};

  for (const [key, value] of Object.entries(headers || {})) {
    if (key.startsWith(":")) continue;
    const lower = key.toLowerCase();
    if (lower === "connection" || lower === "upgrade" || lower === "keep-alive") continue;
    if (lower === "te") continue;
    requestHeaders[lower] = value;
  }
  requestHeaders.host = `127.0.0.1:${WEB_TARGET_PORT}`;

  const request = http.request({
    hostname: "127.0.0.1",
    port: WEB_TARGET_PORT,
    method,
    path: targetPath,
    headers: requestHeaders,
  }, (response) => {
    stream.respond({
      ":status": response.statusCode || 502,
      ...filterResponseHeaders(response.headers),
    });
    response.pipe(stream);
  });

  request.on("error", (error) => {
    if (!stream.destroyed) {
      respondJson(stream, 502, {
        ok: false,
        error: `Web app unavailable on ${WEB_TARGET_PORT}: ${error.message}`,
      });
    }
  });

  stream.on("close", () => request.destroy());
  stream.pipe(request);
}

function proxyWebHttp1(req, res) {
  const requestHeaders = { ...(req.headers || {}) };
  delete requestHeaders.connection;
  delete requestHeaders.upgrade;
  delete requestHeaders["keep-alive"];
  requestHeaders.host = `127.0.0.1:${WEB_TARGET_PORT}`;

  const request = http.request({
    hostname: "127.0.0.1",
    port: WEB_TARGET_PORT,
    method: req.method || "GET",
    path: req.url || "/",
    headers: requestHeaders,
  }, (response) => {
    res.writeHead(response.statusCode || 502, filterResponseHeaders(response.headers));
    response.pipe(res);
  });

  request.on("error", (error) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    }
    res.end(JSON.stringify({
      ok: false,
      error: `Web app unavailable on ${WEB_TARGET_PORT}: ${error.message}`,
    }));
  });

  res.on("close", () => {
    if (!res.writableEnded) request.destroy();
  });
  req.pipe(request);
}

const h2Server = http2.createServer();
const h1Server = http.createServer(proxyWebHttp1);

h2Server.on("stream", (stream, headers) => {
  if (isGrpcRequest(headers)) {
    proxyGrpc(stream, headers);
    return;
  }
  proxyWeb(stream, headers);
});

h2Server.on("sessionError", (error) => {
  // eslint-disable-next-line no-console
  console.warn("[tag-webhook-front] session error:", error.message);
});

h1Server.on("clientError", (error, socket) => {
  if (!socket.destroyed) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  // eslint-disable-next-line no-console
  console.warn("[tag-webhook-front] http/1 client error:", error.message);
});

const server = net.createServer((socket) => {
  socket.once("data", (chunk) => {
    socket.unshift(chunk);
    const prefix = chunk.subarray(0, 3).toString("ascii");
    if (prefix === "PRI") {
      h2Server.emit("connection", socket);
    } else {
      h1Server.emit("connection", socket);
    }
  });
});

server.on("error", (error) => {
  // eslint-disable-next-line no-console
  console.error("[tag-webhook-front] server error:", error.message);
});

server.listen(PORT, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.log(`[tag-webhook-front] h1+h2c :${PORT} | grpc -> :${GRPC_TARGET_PORT} | web -> :${WEB_TARGET_PORT}`);
});
