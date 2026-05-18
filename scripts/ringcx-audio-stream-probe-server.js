"use strict";

// Generic RingCX Audio Streaming probe.
//
// Workflow Studio says Start Streaming takes a URL + external credentials,
// but the public docs say the node uses gRPC. Until RingCentral sends the
// proto/schema, this intentionally logs raw HTTP/2 request headers and body
// bytes instead of trying to decode protobuf messages.
//
// Usage:
//   node scripts/ringcx-audio-stream-probe-server.js --h2-port 3334 --http-port 3335
//
// Expose the h2c listener through ngrok for gRPC-style probes:
//   ngrok http --upstream-protocol=http2 3334
//
// If the Workflow Studio node is actually plain HTTP, expose --http-port
// instead and it will still log the attempt.

const fs = require("fs");
const http = require("http");
const http2 = require("http2");
const path = require("path");

function readFlag(argv, name, fallback = "") {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1) return argv[idx + 1];
  return fallback;
}

function timestampForFile() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function safeHeaderValue(value) {
  const raw = Array.isArray(value) ? value.join(", ") : String(value ?? "");
  if (!raw) return raw;
  if (/authorization|token|secret|credential|password|key/i.test(raw)) return "[redacted]";
  return raw.length > 240 ? `${raw.slice(0, 120)}...[${raw.length} chars]` : raw;
}

function sanitizeHeaders(headers = {}) {
  const output = {};
  for (const [key, value] of Object.entries(headers)) {
    output[key] = /authorization|token|secret|credential|password|key/i.test(key)
      ? "[redacted]"
      : safeHeaderValue(value);
  }
  return output;
}

function writeJsonLine(file, event) {
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function base64Sample(buffer) {
  return buffer.subarray(0, Math.min(buffer.length, 512)).toString("base64");
}

function makeGrpcFrameParser({ requestId, eventLog, outDir, eventBase }) {
  let buffer = Buffer.alloc(0);
  let frameCount = 0;
  let totalFramePayloadBytes = 0;
  let sampleBytesWritten = 0;
  const framesPath = path.join(outDir, `${requestId}.grpc.frames.ndjson`);
  const payloadSamplePath = path.join(outDir, `${requestId}.grpc.payload.sample.bin`);

  return {
    push(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 5) {
        const compressedFlag = buffer.readUInt8(0);
        const messageLength = buffer.readUInt32BE(1);
        if (buffer.length < 5 + messageLength) break;

        const payload = buffer.subarray(5, 5 + messageLength);
        buffer = buffer.subarray(5 + messageLength);
        frameCount += 1;
        totalFramePayloadBytes += payload.length;

        if (sampleBytesWritten < 1024 * 1024 && payload.length) {
          const remaining = 1024 * 1024 - sampleBytesWritten;
          const sample = payload.subarray(0, Math.min(payload.length, remaining));
          fs.appendFileSync(payloadSamplePath, sample);
          sampleBytesWritten += sample.length;
        }

        const frameEvent = {
          type: "h2.grpc_frame",
          ...eventBase,
          frameCount,
          compressedFlag,
          messageLength,
          payloadSampleBase64: base64Sample(payload),
        };
        writeJsonLine(framesPath, frameEvent);
        if (frameCount <= 10 || frameCount % 100 === 0) {
          writeJsonLine(eventLog, {
            ...frameEvent,
            framesPath,
            payloadSamplePath,
            payloadSampleBase64: frameCount <= 10 ? frameEvent.payloadSampleBase64 : "[omitted]",
          });
          console.log(`[h2] grpc frame ${requestId} #${frameCount} bytes=${messageLength}`);
        }
      }
    },
    finish() {
      return {
        frameCount,
        totalFramePayloadBytes,
        remainingUnparsedBytes: buffer.length,
        framesPath: fs.existsSync(framesPath) ? framesPath : "",
        payloadSamplePath: fs.existsSync(payloadSamplePath) ? payloadSamplePath : "",
      };
    },
  };
}

function startHttp2Probe({ port, outDir, eventLog }) {
  const server = http2.createServer();

  server.on("stream", (stream, headers) => {
    const requestId = `${timestampForFile()}-${Math.random().toString(16).slice(2, 10)}`;
    const rawPath = String(headers[":path"] || "/");
    const rawMethod = String(headers[":method"] || "");
    const rawContentType = String(headers["content-type"] || "");
    const chunks = [];
    let totalBytes = 0;
    const startedAt = Date.now();

    const eventBase = {
      requestId,
      protocol: "h2c",
      method: rawMethod,
      path: rawPath,
      contentType: rawContentType,
      headers: sanitizeHeaders(headers),
      startedAt: new Date().toISOString(),
    };
    console.log(`[h2] start ${requestId} ${rawMethod} ${rawPath} content-type=${rawContentType || "(none)"}`);
    writeJsonLine(eventLog, { type: "h2.start", ...eventBase });

    if (!stream.headersSent) {
      stream.respond({
        ":status": 200,
        "content-type": rawContentType.includes("grpc") ? rawContentType : "application/grpc",
        "grpc-status": "0",
      });
    }

    const grpcParser = rawContentType.includes("grpc")
      ? makeGrpcFrameParser({ requestId, eventLog, outDir, eventBase })
      : null;

    stream.on("data", (chunk) => {
      totalBytes += chunk.length;
      if (chunks.reduce((sum, item) => sum + item.length, 0) < 64 * 1024) {
        chunks.push(Buffer.from(chunk));
      }
      if (grpcParser) {
        grpcParser.push(chunk);
      }
      if (totalBytes === chunk.length || totalBytes % (64 * 1024) < chunk.length) {
        console.log(`[h2] data ${requestId} totalBytes=${totalBytes}`);
      }
    });

    stream.on("end", () => {
      const sample = Buffer.concat(chunks);
      const bodyPath = path.join(outDir, `${requestId}.h2.body.sample.bin`);
      fs.writeFileSync(bodyPath, sample);
      const completed = {
        type: "h2.end",
        ...eventBase,
        endedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        totalBytes,
        bodySamplePath: bodyPath,
        bodySampleBase64: base64Sample(sample),
        grpc: grpcParser ? grpcParser.finish() : null,
      };
      console.log(`[h2] end ${requestId} totalBytes=${totalBytes} sample=${bodyPath}`);
      writeJsonLine(eventLog, completed);

      // gRPC expects a 200 with grpc-status trailers for success. This does
      // not prove we handled the app-level proto, but it keeps probes tidy.
      stream.end();
    });

    stream.on("error", (error) => {
      console.error(`[h2] stream error ${requestId}: ${error.message}`);
      writeJsonLine(eventLog, { type: "h2.error", ...eventBase, message: error.message });
    });
  });

  server.on("sessionError", (error) => {
    console.error(`[h2] session error: ${error.message}`);
    writeJsonLine(eventLog, { type: "h2.session_error", message: error.message, at: new Date().toISOString() });
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`[h2] listening on h2c://0.0.0.0:${port}`);
  });
  return server;
}

function startHttpProbe({ port, outDir, eventLog }) {
  const server = http.createServer((req, res) => {
    const requestId = `${timestampForFile()}-${Math.random().toString(16).slice(2, 10)}`;
    const chunks = [];
    let totalBytes = 0;
    const startedAt = Date.now();
    const eventBase = {
      requestId,
      protocol: "http1",
      method: req.method,
      path: req.url,
      headers: sanitizeHeaders(req.headers),
      startedAt: new Date().toISOString(),
    };
    console.log(`[http] start ${requestId} ${req.method} ${req.url}`);
    writeJsonLine(eventLog, { type: "http.start", ...eventBase });

    req.on("data", (chunk) => {
      totalBytes += chunk.length;
      if (chunks.reduce((sum, item) => sum + item.length, 0) < 64 * 1024) {
        chunks.push(Buffer.from(chunk));
      }
    });
    req.on("end", () => {
      const sample = Buffer.concat(chunks);
      const bodyPath = path.join(outDir, `${requestId}.http.body.sample.bin`);
      fs.writeFileSync(bodyPath, sample);
      writeJsonLine(eventLog, {
        type: "http.end",
        ...eventBase,
        endedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        totalBytes,
        bodySamplePath: bodyPath,
        bodySampleBase64: base64Sample(sample),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, requestId }));
    });
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`[http] listening on http://0.0.0.0:${port}`);
  });
  return server;
}

function main() {
  const argv = process.argv.slice(2);
  const h2Port = Number(readFlag(argv, "--h2-port", "3334")) || 3334;
  const httpPort = Number(readFlag(argv, "--http-port", "3335")) || 3335;
  const outDir = path.resolve(readFlag(argv, "--out-dir", path.join("runtime", "ringcx-stream-probe")));
  ensureDir(outDir);
  const eventLog = path.join(outDir, "events.ndjson");

  console.log("RingCX audio stream probe server");
  console.log(`  h2 port:   ${h2Port}`);
  console.log(`  http port: ${httpPort}`);
  console.log(`  out dir:   ${outDir}`);
  console.log(`  event log: ${eventLog}`);

  startHttp2Probe({ port: h2Port, outDir, eventLog });
  startHttpProbe({ port: httpPort, outDir, eventLog });
}

main();
