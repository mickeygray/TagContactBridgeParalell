#!/usr/bin/env node
"use strict";

// One-off RingCX Workflow Studio Start Streaming receiver.
//
// This implements the proto/service RingCX expects:
//   ringcentral.ringcx.streaming.v1beta2.Streaming/Stream
//
// Run locally behind ngrok HTTP/2:
//   node scripts/ringcx-grpc-stream-receiver.js --port 3334
//   ngrok http --app-protocol=http2 3334
//
// Workflow Studio URL:
//   grpc://<ngrok-domain>:443

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");

function readFlag(argv, name, fallback = "") {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1) return argv[idx + 1];
  return fallback;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function writeJsonLine(file, event) {
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
}

function safeString(value, max = 500) {
  const raw = String(value ?? "");
  return raw.length > max ? `${raw.slice(0, max)}...[${raw.length} chars]` : raw;
}

function sanitizeMetadata(metadata = {}) {
  const out = {};
  for (const [key, value] of Object.entries(metadata)) {
    out[key] = /authorization|token|secret|credential|password|key/i.test(key)
      ? "[redacted]"
      : Array.isArray(value)
        ? value.map((item) => safeString(item))
        : safeString(value);
  }
  return out;
}

function timingSafeEqualText(left, right) {
  const a = Buffer.from(String(left ?? ""), "utf8");
  const b = Buffer.from(String(right ?? ""), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function requireBasicAuth(call) {
  const expectedUser = String(process.env.RINGCX_GRPC_USER || "").trim();
  const expectedPass = String(process.env.RINGCX_GRPC_PASS || "");
  if (!expectedUser && !expectedPass) {
    return { enabled: false, user: "" };
  }

  const auth = String(call.metadata?.get?.("authorization")?.[0] || "");
  const prefix = "Basic ";
  if (!auth.startsWith(prefix)) {
    const error = new Error("Missing Basic auth");
    error.code = grpc.status.UNAUTHENTICATED;
    throw error;
  }

  let decoded = "";
  try {
    decoded = Buffer.from(auth.slice(prefix.length), "base64").toString("utf8");
  } catch {
    const error = new Error("Invalid Basic auth encoding");
    error.code = grpc.status.UNAUTHENTICATED;
    throw error;
  }

  const separator = decoded.indexOf(":");
  const user = separator >= 0 ? decoded.slice(0, separator) : decoded;
  const pass = separator >= 0 ? decoded.slice(separator + 1) : "";
  if (!timingSafeEqualText(user, expectedUser) || !timingSafeEqualText(pass, expectedPass)) {
    const error = new Error("Invalid Basic auth");
    error.code = grpc.status.UNAUTHENTICATED;
    throw error;
  }

  return { enabled: true, user };
}

function enumName(map, value, fallback = "UNKNOWN") {
  for (const [key, candidate] of Object.entries(map || {})) {
    if (candidate === value) return key;
  }
  return `${fallback}_${value}`;
}

const Codec = {
  CODEC_UNSPECIFIED: 0,
  OPUS: 1,
  PCMA: 2,
  PCMU: 3,
  L16: 4,
  FLAC: 5,
};

const ParticipantType = {
  PARTICIPANT_TYPE_UNSPECIFIED: 0,
  CONTACT: 1,
  AGENT: 2,
  BOT: 5,
};

const DialogType = {
  DIALOG_TYPE_UNSPECIFIED: 0,
  INBOUND: 1,
  OUTBOUND: 2,
};

const ProductType = {
  PRODUCT_TYPE_UNSPECIFIED: 0,
  QUEUE: 1,
  CAMPAIGN: 2,
  IVR: 3,
};

function eventKind(event = {}) {
  if (event.dialogInit) return "dialogInit";
  if (event.segmentStart) return "segmentStart";
  if (event.segmentMedia) return "segmentMedia";
  if (event.segmentInfo) return "segmentInfo";
  if (event.segmentStop) return "segmentStop";
  return "unknown";
}

function decodeEvent(event = {}) {
  const kind = eventKind(event);
  if (kind === "dialogInit") {
    const dialog = event.dialogInit.dialog || {};
    return {
      kind,
      account: event.dialogInit.account || null,
      dialog: {
        id: dialog.id || "",
        type: enumName(DialogType, dialog.type, "DIALOG_TYPE"),
        ani: dialog.ani || "",
        dnis: dialog.dnis || "",
        language: dialog.language || "",
        attributes: dialog.attributes || {},
      },
    };
  }
  if (kind === "segmentStart") {
    const start = event.segmentStart;
    const participant = start.participant || {};
    const format = start.audioFormat || {};
    const product = start.product || {};
    return {
      kind,
      segmentId: start.segmentId || "",
      product: product.id
        ? { id: product.id, type: enumName(ProductType, product.type, "PRODUCT_TYPE") }
        : null,
      participant: {
        id: participant.id || "",
        type: enumName(ParticipantType, participant.type, "PARTICIPANT_TYPE"),
        name: participant.name || "",
      },
      audioFormat: format.codec
        ? {
          codec: enumName(Codec, format.codec, "CODEC"),
          rate: Number(format.rate || 0),
          ptime: Number(format.ptime || 0),
        }
        : null,
    };
  }
  if (kind === "segmentMedia") {
    const media = event.segmentMedia;
    const audio = media.audioContent || {};
    return {
      kind,
      segmentId: media.segmentId || "",
      seq: Number(audio.seq || 0),
      duration: Number(audio.duration || 0),
      payloadBytes: audio.payload ? audio.payload.length : 0,
    };
  }
  if (kind === "segmentInfo") {
    const info = event.segmentInfo;
    return {
      kind,
      segmentId: info.segmentId || "",
      event: info.event || "",
      data: info.data || "",
    };
  }
  if (kind === "segmentStop") {
    return {
      kind,
      segmentId: event.segmentStop.segmentId || "",
    };
  }
  return { kind, keys: Object.keys(event || {}) };
}

function ulawDecode(sample) {
  let ulaw = ~sample & 0xff;
  const sign = ulaw & 0x80;
  const exponent = (ulaw >> 4) & 0x07;
  const mantissa = ulaw & 0x0f;
  let value = ((mantissa << 3) + 0x84) << exponent;
  value -= 0x84;
  return sign ? -value : value;
}

function alawDecode(sample) {
  let alaw = sample ^ 0x55;
  const sign = alaw & 0x80;
  const exponent = (alaw & 0x70) >> 4;
  const mantissa = alaw & 0x0f;
  let value = exponent === 0
    ? (mantissa << 4) + 8
    : ((mantissa << 4) + 0x108) << (exponent - 1);
  return sign ? value : -value;
}

function pcm16FromPayload(payload, codec) {
  const codecName = String(codec || "").toUpperCase();
  if (codecName === "L16") return Buffer.from(payload);
  if (codecName !== "PCMU" && codecName !== "PCMA") return null;

  const out = Buffer.alloc(payload.length * 2);
  for (let i = 0; i < payload.length; i += 1) {
    const sample = codecName === "PCMU" ? ulawDecode(payload[i]) : alawDecode(payload[i]);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
  }
  return out;
}

function wavHeader({ dataBytes, sampleRate = 8000, channels = 1, bitsPerSample = 16 }) {
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

function writeWav(file, pcmBuffers, sampleRate) {
  const dataBytes = pcmBuffers.reduce((sum, item) => sum + item.length, 0);
  fs.writeFileSync(file, Buffer.concat([wavHeader({ dataBytes, sampleRate }), ...pcmBuffers]));
}

function loadProto(protoPath) {
  const packageDefinition = protoLoader.loadSync(protoPath, {
    keepCase: false,
    longs: String,
    enums: Number,
    defaults: true,
    oneofs: true,
  });
  const loaded = grpc.loadPackageDefinition(packageDefinition);
  return loaded.ringcentral.ringcx.streaming.v1beta2;
}

function createStreamingService({ outDir, eventLog }) {
  return {
    Stream(call, callback) {
      const streamId = `${stamp()}-${Math.random().toString(16).slice(2, 10)}`;
      const startedAt = new Date();
      const metadata = sanitizeMetadata(call.metadata?.getMap?.() || {});
      let auth = null;
      try {
        auth = requireBasicAuth(call);
      } catch (error) {
        console.error(`[grpc] auth rejected ${streamId}: ${error.message}`);
        writeJsonLine(eventLog, {
          type: "stream.auth_rejected",
          streamId,
          startedAt: startedAt.toISOString(),
          metadata,
          message: error.message,
          code: error.code || null,
        });
        callback(error);
        return;
      }
      const segments = new Map();
      let eventCount = 0;
      let mediaCount = 0;
      let mediaBytes = 0;

      console.log(`[grpc] stream start ${streamId}`);
      writeJsonLine(eventLog, {
        type: "stream.start",
        streamId,
        startedAt: startedAt.toISOString(),
        metadata,
        auth: auth?.enabled ? { enabled: true, user: auth.user } : { enabled: false },
      });

      call.on("data", (event) => {
        eventCount += 1;
        const sessionId = event.sessionId || "";
        const decoded = decodeEvent(event);
        const base = {
          type: "stream.event",
          streamId,
          eventCount,
          sessionId,
          at: new Date().toISOString(),
          ...decoded,
        };

        if (decoded.kind === "segmentStart") {
          const segmentDir = path.join(outDir, "segments", safeString(`${sessionId || "no-session"}-${decoded.segmentId || "no-segment"}`, 120));
          ensureDir(segmentDir);
          segments.set(decoded.segmentId, {
            sessionId,
            segmentId: decoded.segmentId,
            codec: decoded.audioFormat?.codec || "",
            rate: Number(decoded.audioFormat?.rate || 8000) || 8000,
            ptime: Number(decoded.audioFormat?.ptime || 0) || 0,
            participant: decoded.participant || null,
            rawPath: path.join(segmentDir, "audio.raw"),
            wavPath: path.join(segmentDir, "audio.wav"),
            jsonPath: path.join(segmentDir, "events.ndjson"),
            pcmBuffers: [],
            rawBytes: 0,
          });
          writeJsonLine(segments.get(decoded.segmentId).jsonPath, base);
        } else if (decoded.kind === "segmentMedia") {
          mediaCount += 1;
          mediaBytes += decoded.payloadBytes;
          const media = event.segmentMedia;
          const audio = media.audioContent || {};
          const payload = audio.payload ? Buffer.from(audio.payload) : Buffer.alloc(0);
          const segment = segments.get(media.segmentId);
          if (segment && payload.length) {
            fs.appendFileSync(segment.rawPath, payload);
            segment.rawBytes += payload.length;
            const pcm = pcm16FromPayload(payload, segment.codec);
            if (pcm) segment.pcmBuffers.push(pcm);
            if (mediaCount <= 5 || mediaCount % 50 === 0) {
              writeJsonLine(segment.jsonPath, base);
            }
          }
          if (mediaCount <= 5 || mediaCount % 50 === 0) {
            console.log(`[grpc] media stream=${streamId} session=${sessionId || "-"} segment=${decoded.segmentId || "-"} seq=${decoded.seq} bytes=${decoded.payloadBytes}`);
            writeJsonLine(eventLog, base);
          }
          return;
        } else if (decoded.kind === "segmentStop") {
          const segment = segments.get(decoded.segmentId);
          if (segment) {
            writeJsonLine(segment.jsonPath, base);
            if (segment.pcmBuffers.length) {
              writeWav(segment.wavPath, segment.pcmBuffers, segment.rate || 8000);
              base.wavPath = segment.wavPath;
              base.rawPath = segment.rawPath;
              base.rawBytes = segment.rawBytes;
            }
          }
        }

        console.log(`[grpc] ${decoded.kind} stream=${streamId} session=${sessionId || "-"}`);
        writeJsonLine(eventLog, base);
      });

      call.on("end", () => {
        for (const segment of segments.values()) {
          if (segment.pcmBuffers.length && !fs.existsSync(segment.wavPath)) {
            writeWav(segment.wavPath, segment.pcmBuffers, segment.rate || 8000);
          }
        }
        const endedAt = new Date();
        const summary = {
          type: "stream.end",
          streamId,
          startedAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          elapsedMs: endedAt.getTime() - startedAt.getTime(),
          eventCount,
          mediaCount,
          mediaBytes,
          segments: Array.from(segments.values()).map((segment) => ({
            sessionId: segment.sessionId,
            segmentId: segment.segmentId,
            codec: segment.codec,
            rate: segment.rate,
            ptime: segment.ptime,
            participant: segment.participant,
            rawBytes: segment.rawBytes,
            rawPath: segment.rawPath,
            wavPath: fs.existsSync(segment.wavPath) ? segment.wavPath : "",
          })),
        };
        console.log(`[grpc] stream end ${streamId} events=${eventCount} media=${mediaCount} bytes=${mediaBytes}`);
        writeJsonLine(eventLog, summary);
        callback(null, {});
      });

      call.on("error", (error) => {
        console.error(`[grpc] stream error ${streamId}: ${error.message}`);
        writeJsonLine(eventLog, {
          type: "stream.error",
          streamId,
          at: new Date().toISOString(),
          message: error.message,
          code: error.code || null,
        });
      });
    },
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const port = Number(readFlag(argv, "--port", process.env.RINGCX_GRPC_RECEIVER_PORT || "3334")) || 3334;
  const outDir = path.resolve(readFlag(argv, "--out-dir", path.join("runtime", "ringcx-grpc-stream")));
  const protoPath = path.resolve(readFlag(argv, "--proto", path.join("scripts", "proto", "ringcx_streaming.proto")));
  ensureDir(outDir);
  ensureDir(path.join(outDir, "segments"));
  const eventLog = path.join(outDir, "events.ndjson");

  const ringcx = loadProto(protoPath);
  const server = new grpc.Server();
  server.addService(ringcx.Streaming.service, createStreamingService({ outDir, eventLog }));
  const bindAddress = `0.0.0.0:${port}`;

  server.bindAsync(bindAddress, grpc.ServerCredentials.createInsecure(), (error, boundPort) => {
    if (error) {
      console.error(error.stack || error.message);
      process.exit(1);
    }
    server.start();
    console.log("RingCX gRPC stream receiver ready");
    console.log(`  address:   ${bindAddress}`);
    console.log(`  boundPort: ${boundPort}`);
    console.log(`  service:   ringcentral.ringcx.streaming.v1beta2.Streaming/Stream`);
    console.log(`  proto:     ${protoPath}`);
    console.log(`  outDir:    ${outDir}`);
    console.log(`  eventLog:  ${eventLog}`);
  });

  const shutdown = () => {
    console.log("\n[grpc] shutting down");
    server.tryShutdown(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
