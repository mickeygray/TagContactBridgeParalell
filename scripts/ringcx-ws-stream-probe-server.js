#!/usr/bin/env node
"use strict";

// Minimal no-dependency WebSocket receiver for RingCX Call Streaming tests.
//
// Expose through nginx/ngrok as:
//   wss://tagcontactbridge.ngrok.app/ringcx-stream
//
// Logs:
//   runtime/ringcx-ws-stream-probe/events.ndjson
//   runtime/ringcx-ws-stream-probe/<connection>.media.mulaw

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

function readFlag(argv, name, fallback = "") {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1) return argv[idx + 1];
  return fallback;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sanitizeHeaders(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = /authorization|token|secret|credential|password|key/i.test(key)
      ? "[redacted]"
      : String(value || "").slice(0, 500);
  }
  return out;
}

function parseBasicAuth(header) {
  const value = String(header || "").trim();
  const match = value.match(/^Basic\s+(.+)$/i);
  if (!match) {
    return {
      present: Boolean(value),
      scheme: value ? value.split(/\s+/, 1)[0] || "unknown" : null,
      username: null,
      passwordPresent: false,
    };
  }
  try {
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    return {
      present: true,
      scheme: "Basic",
      username: idx >= 0 ? decoded.slice(0, idx) : decoded,
      passwordPresent: idx >= 0 && decoded.slice(idx + 1).length > 0,
      password: idx >= 0 ? decoded.slice(idx + 1) : "",
    };
  } catch {
    return {
      present: true,
      scheme: "Basic",
      username: null,
      passwordPresent: false,
      malformed: true,
    };
  }
}

function summarizeAuth(header, expectedUser, expectedPassword) {
  const parsed = parseBasicAuth(header);
  const expectedConfigured = Boolean(expectedUser || expectedPassword);
  const basicMatches = expectedConfigured
    ? parsed.scheme === "Basic"
      && parsed.username === expectedUser
      && parsed.password === expectedPassword
    : null;
  return {
    present: parsed.present,
    scheme: parsed.scheme,
    basicUsername: parsed.username,
    basicPasswordPresent: parsed.passwordPresent,
    basicMalformed: Boolean(parsed.malformed),
    expectedConfigured,
    basicMatches,
  };
}

function writeJsonLine(file, event) {
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
}

function sendFrame(socket, opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const header = [];
  header.push(0x80 | opcode);
  if (body.length < 126) {
    header.push(body.length);
  } else if (body.length <= 0xffff) {
    header.push(126, (body.length >> 8) & 0xff, body.length & 0xff);
  } else {
    header.push(127, 0, 0, 0, 0);
    header.push((body.length / 0x1000000) & 0xff, (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff);
  }
  socket.write(Buffer.concat([Buffer.from(header), body]));
}

function parseFrames(state, chunk, onFrame) {
  state.buffer = Buffer.concat([state.buffer, chunk]);
  while (state.buffer.length >= 2) {
    const first = state.buffer[0];
    const second = state.buffer[1];
    const fin = Boolean(first & 0x80);
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (state.buffer.length < offset + 2) return;
      length = state.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (state.buffer.length < offset + 8) return;
      const high = state.buffer.readUInt32BE(offset);
      const low = state.buffer.readUInt32BE(offset + 4);
      length = high * 2 ** 32 + low;
      offset += 8;
    }
    let mask = null;
    if (masked) {
      if (state.buffer.length < offset + 4) return;
      mask = state.buffer.subarray(offset, offset + 4);
      offset += 4;
    }
    if (state.buffer.length < offset + length) return;
    let payload = Buffer.from(state.buffer.subarray(offset, offset + length));
    state.buffer = state.buffer.subarray(offset + length);
    if (mask) {
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    }
    onFrame({ fin, opcode, payload });
  }
}

function maybeDecodeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function findBase64Audio(value, hits = [], depth = 0) {
  if (depth > 6 || value == null) return hits;
  if (typeof value === "string") {
    const compact = value.trim();
    if (compact.length > 40 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
      hits.push(compact);
    }
    return hits;
  }
  if (Array.isArray(value)) {
    for (const item of value) findBase64Audio(item, hits, depth + 1);
    return hits;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (/audio|media|payload|content|data/i.test(key)) findBase64Audio(child, hits, depth + 1);
      else if (typeof child === "object") findBase64Audio(child, hits, depth + 1);
    }
  }
  return hits;
}

function summarizeMessage(json, text, payload) {
  if (json && typeof json === "object") {
    return {
      event: json.event || json.type || json.messageType || null,
      perspective: json.perspective || json.media?.perspective || null,
      metadata: json.metadata || null,
      keys: Object.keys(json).slice(0, 80),
      textPreview: text.slice(0, 1200),
    };
  }
  return {
    event: null,
    keys: [],
    textPreview: payload.length <= 1200 ? text : `${text.slice(0, 1200)}...[${payload.length} bytes]`,
  };
}

function main() {
  const argv = process.argv.slice(2);
  const port = Number(readFlag(argv, "--port", "3336")) || 3336;
  const outDir = path.resolve(readFlag(argv, "--out-dir", path.join("runtime", "ringcx-ws-stream-probe")));
  const expectedBasicUser =
    readFlag(argv, "--basic-user", process.env.RINGCX_STREAM_BASIC_USERNAME || "");
  const expectedBasicPassword =
    readFlag(argv, "--basic-password", process.env.RINGCX_STREAM_BASIC_PASSWORD || "");
  const enforceBasic =
    expectedBasicUser || expectedBasicPassword
      ? !process.argv.includes("--no-enforce-basic")
      : false;
  ensureDir(outDir);
  const eventLog = path.join(outDir, "events.ndjson");

  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "ringcx-ws-stream-probe" }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not-found" }));
  });

  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    const connectionId = `${stamp()}-${Math.random().toString(16).slice(2, 10)}`;
    const mediaPath = path.join(outDir, `${connectionId}.media.mulaw`);
    const auth = summarizeAuth(req.headers.authorization, expectedBasicUser, expectedBasicPassword);
    if (enforceBasic && auth.basicMatches !== true) {
      socket.write([
        "HTTP/1.1 401 Unauthorized",
        "Connection: close",
        'WWW-Authenticate: Basic realm="ringcx-stream"',
        "Content-Length: 0",
        "\r\n",
      ].join("\r\n"));
      socket.destroy();
      writeJsonLine(eventLog, {
        type: "ws.auth_rejected",
        connectionId,
        remoteAddress: req.socket.remoteAddress,
        path: req.url,
        auth,
        at: new Date().toISOString(),
      });
      return;
    }
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = crypto
      .createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n",
    ].join("\r\n"));

    const state = { buffer: Buffer.alloc(0), messages: 0, mediaBytes: 0, connectedAt: new Date().toISOString() };
    const base = {
      connectionId,
      remoteAddress: req.socket.remoteAddress,
      path: req.url,
      headers: sanitizeHeaders(req.headers),
      auth,
      connectedAt: state.connectedAt,
      mediaPath,
    };
    console.log(`[ws] connected ${connectionId} ${req.url} auth=${auth.scheme || "none"} user=${auth.basicUsername || ""}`);
    writeJsonLine(eventLog, { type: "ws.connected", ...base });

    socket.on("data", (chunk) => {
      parseFrames(state, chunk, ({ opcode, payload }) => {
        if (opcode === 0x8) {
          sendFrame(socket, 0x8, payload);
          socket.end();
          return;
        }
        if (opcode === 0x9) {
          sendFrame(socket, 0xA, payload);
          return;
        }
        if (opcode !== 0x1 && opcode !== 0x2) return;

        state.messages += 1;
        const text = opcode === 0x1 ? payload.toString("utf8") : "";
        const json = opcode === 0x1 ? maybeDecodeJson(text) : null;
        const audioHits = json ? findBase64Audio(json).slice(0, 4) : [];
        let audioBytes = 0;
        for (const item of audioHits) {
          try {
            const audio = Buffer.from(item, "base64");
            if (audio.length) {
              fs.appendFileSync(mediaPath, audio);
              audioBytes += audio.length;
            }
          } catch {
            // Ignore non-audio-looking base64.
          }
        }
        state.mediaBytes += audioBytes;
        const summary = summarizeMessage(json, text, payload);
        const event = {
          type: "ws.message",
          ...base,
          messageNumber: state.messages,
          opcode,
          payloadBytes: payload.length,
          audioBytes,
          totalAudioBytes: state.mediaBytes,
          ...summary,
        };
        writeJsonLine(eventLog, event);
        if (state.messages <= 10 || audioBytes || state.messages % 100 === 0) {
          console.log(`[ws] msg ${connectionId} #${state.messages} event=${event.event || "(raw)"} perspective=${event.perspective || ""} payload=${payload.length} audio=${audioBytes}`);
        }
      });
    });

    socket.on("close", () => {
      console.log(`[ws] closed ${connectionId} messages=${state.messages} mediaBytes=${state.mediaBytes}`);
      writeJsonLine(eventLog, {
        type: "ws.closed",
        ...base,
        closedAt: new Date().toISOString(),
        messages: state.messages,
        mediaBytes: state.mediaBytes,
      });
    });
    socket.on("error", (error) => {
      writeJsonLine(eventLog, { type: "ws.error", ...base, message: error.message });
    });
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`RingCX WSS probe listening on ws://0.0.0.0:${port}/ringcx-stream`);
    console.log(`event log: ${eventLog}`);
    console.log(`basic auth: ${expectedBasicUser || expectedBasicPassword ? "configured" : "not configured"}${enforceBasic ? " (enforced)" : " (observe-only)"}`);
  });
}

main();
