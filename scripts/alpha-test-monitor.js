#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const net = require("net");

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

function cleanInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function compactEvent(event) {
  const out = {
    type: event.type || null,
    kind: event.kind || null,
    streamId: event.streamId || null,
    sessionId: event.sessionId || null,
    at: event.at || event.startedAt || event.endedAt || null,
  };
  if (event.dialog?.attributes?.uii) out.uii = String(event.dialog.attributes.uii);
  if (event.dialogIdentity?.uii) out.uii = String(event.dialogIdentity.uii);
  if (event.product?.id) out.campaignId = String(event.product.id);
  if (event.role) out.role = event.role;
  if (event.mediaBytes != null) out.mediaBytes = event.mediaBytes;
  if (event.error) out.error = String(event.error);
  if (event.reason) out.reason = String(event.reason);
  return out;
}

async function probePort(port, timeoutMs = 800) {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const done = (ok, error = null) => {
      socket.destroy();
      resolve({ port, ok, error });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false, "timeout"));
    socket.once("error", (error) => done(false, error.code || error.message));
  });
}

async function probeUrl(name, url, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(url, { signal: controller.signal });
    return {
      name,
      url,
      ok: response.ok,
      status: response.status,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      name,
      url,
      ok: false,
      status: null,
      elapsedMs: Date.now() - startedAt,
      error: error.name === "AbortError" ? "timeout" : error.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readNgrokTunnels() {
  const apis = ["http://127.0.0.1:4040/api/tunnels", "http://127.0.0.1:4041/api/tunnels"];
  const rows = [];
  for (const api of apis) {
    try {
      const response = await fetch(api);
      const body = await response.json();
      for (const tunnel of body.tunnels || []) {
        rows.push({
          api,
          publicUrl: tunnel.public_url || null,
          proto: tunnel.proto || null,
          addr: tunnel.config?.addr || null,
        });
      }
    } catch (error) {
      rows.push({ api, error: error.message });
    }
  }
  return rows;
}

function makeGrpcTailer(filePath, includeExisting) {
  let offset = 0;
  let partial = "";
  try {
    const stat = fs.statSync(filePath);
    offset = includeExisting ? 0 : stat.size;
  } catch {
    offset = 0;
  }

  return function readNewEvents() {
    const summary = {
      readBytes: 0,
      parsed: 0,
      counts: {},
      recent: [],
      errors: [],
    };

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (error) {
      summary.errors.push(`event log unavailable: ${error.message}`);
      return summary;
    }

    if (stat.size < offset) {
      summary.errors.push("event log shrank; resetting tail offset");
      offset = 0;
      partial = "";
    }

    if (stat.size === offset) return summary;

    const fd = fs.openSync(filePath, "r");
    try {
      const length = stat.size - offset;
      const buffer = Buffer.allocUnsafe(length);
      fs.readSync(fd, buffer, 0, length, offset);
      offset = stat.size;
      summary.readBytes = length;
      const text = partial + buffer.toString("utf8");
      const lines = text.split(/\r?\n/);
      partial = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          const key = event.kind || event.type || "unknown";
          summary.counts[key] = (summary.counts[key] || 0) + 1;
          summary.parsed += 1;
          const compact = compactEvent(event);
          if (
            compact.type === "stream.start" ||
            compact.type === "stream.end" ||
            compact.type === "coach.kill_switch.active" ||
            compact.type === "stt.realtime.error" ||
            compact.type === "stt.realtime.connect_error" ||
            compact.kind === "dialogInit" ||
            compact.kind === "segmentStart"
          ) {
            summary.recent.push(compact);
          }
        } catch (error) {
          summary.errors.push(`parse failed: ${error.message}`);
        }
      }
      summary.recent = summary.recent.slice(-12);
    } finally {
      fs.closeSync(fd);
    }

    return summary;
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const intervalMs = cleanInt(readFlag(argv, "--interval-ms", process.env.ALPHA_TEST_MONITOR_INTERVAL_MS || "5000"), 5000);
  const outDir = path.resolve(readFlag(argv, "--out-dir", path.join("runtime", "alpha-test-monitor")));
  const eventLog = path.resolve(readFlag(argv, "--grpc-events", path.join("runtime", "live-coach-grpc-bridge", "events.ndjson")));
  const includeExisting = hasFlag(argv, "--include-existing");
  const ports = readFlag(argv, "--ports", "3001,4001,5001,6101,7000,3344,3345,4040,4041")
    .split(",")
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value));

  ensureDir(outDir);
  const outputPath = path.join(outDir, `alpha-test-monitor-${stamp()}.jsonl`);
  const readGrpcEvents = makeGrpcTailer(eventLog, includeExisting);
  let tick = 0;

  console.log(`[alpha-monitor] writing ${outputPath}`);
  console.log(`[alpha-monitor] interval=${intervalMs}ms grpcEvents=${eventLog}`);

  async function sample() {
    tick += 1;
    const at = new Date().toISOString();
    const [portRows, urlRows, tunnels] = await Promise.all([
      Promise.all(ports.map((port) => probePort(port))),
      Promise.all([
        probeUrl("web-login", "http://127.0.0.1:5001/login"),
        probeUrl("web-runtime", "http://127.0.0.1:5001/api/client/runtime"),
        probeUrl("ai-bus-health", "http://127.0.0.1:7000/health"),
        probeUrl("inbound-health", "http://127.0.0.1:4001/health"),
        probeUrl("ringcx-health", "http://127.0.0.1:6101/health"),
      ]),
      readNgrokTunnels(),
    ]);
    const grpc = readGrpcEvents();
    const row = { at, tick, ports: portRows, urls: urlRows, tunnels, grpc };
    fs.appendFileSync(outputPath, `${JSON.stringify(row)}\n`);

    const downPorts = portRows.filter((entry) => !entry.ok).map((entry) => `${entry.port}:${entry.error || "down"}`);
    const badUrls = urlRows.filter((entry) => !entry.ok).map((entry) => `${entry.name}:${entry.status || entry.error}`);
    const streamCount = grpc.counts["stream.start"] || 0;
    const endCount = grpc.counts["stream.end"] || 0;
    const sttErrors = (grpc.counts["stt.realtime.error"] || 0) + (grpc.counts["stt.realtime.connect_error"] || 0);
    console.log(`[alpha-monitor] ${at} tick=${tick} downPorts=${downPorts.join("|") || "-"} badUrls=${badUrls.join("|") || "-"} grpc new start/end=${streamCount}/${endCount} sttErrors=${sttErrors}`);
  }

  await sample();
  const timer = setInterval(() => {
    sample().catch((error) => {
      const row = { at: new Date().toISOString(), tick: tick + 1, fatal: error.message };
      fs.appendFileSync(outputPath, `${JSON.stringify(row)}\n`);
      console.error(`[alpha-monitor] sample failed: ${error.stack || error.message}`);
    });
  }, intervalMs);

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      clearInterval(timer);
      console.log(`[alpha-monitor] stopped ${signal}`);
      process.exit(0);
    });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
