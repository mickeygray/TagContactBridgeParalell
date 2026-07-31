#!/usr/bin/env node
"use strict";

// PII-safe analyzer for a Chrome HAR exported with preserved RingCX WebSocket
// frames. It prints protocol shapes and lifecycle aggregates only: never raw
// URLs, headers, SIP identities, SDP, frame data, phones, tokens, or IDs.

const fs = require("fs");
const crypto = require("crypto");

function str(value) {
  return String(value == null ? "" : value).trim();
}

function aliasFactory(prefix) {
  const values = new Map();
  return (raw) => {
    const value = str(raw);
    if (!value) return null;
    if (!values.has(value)) values.set(value, `${prefix}${values.size + 1}`);
    return values.get(value);
  };
}

function parseSipHeaders(data) {
  const lines = str(data).split(/\r?\n/);
  const headers = {};
  for (const line of lines.slice(1)) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim().toLowerCase();
    if (!headers[key]) headers[key] = line.slice(index + 1).trim();
  }
  return { firstLine: lines[0] || "", headers };
}

function sipMethod(firstLine, headers) {
  if (/^SIP\/2\.0\s+\d{3}/i.test(firstLine)) {
    return str(headers.cseq).split(/\s+/)[1]?.toUpperCase() || "RESPONSE";
  }
  return firstLine.split(/\s+/)[0]?.toUpperCase() || "UNKNOWN";
}

function sipStatus(firstLine) {
  const match = firstLine.match(/^SIP\/2\.0\s+(\d{3})/i);
  return match ? Number(match[1]) : null;
}

function safeAlphaValue(value) {
  const text = str(value);
  if (!text || text.length > 48) return null;
  if (!/^[a-z][a-z _.-]*$/i.test(text)) return null;
  return text.toUpperCase();
}

function walkJson(value, visit, depth = 0) {
  if (depth > 12 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) walkJson(item, visit, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    visit(key, child);
    walkJson(child, visit, depth + 1);
  }
}

function increment(map, key, amount = 1) {
  map.set(key, (map.get(key) || 0) + amount);
}

function isoFromFrameTime(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return new Date(numeric * 1000).toISOString();
}

function parseJsonDocuments(text) {
  const documents = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char !== "}") continue;
    depth -= 1;
    if (depth === 0 && start >= 0) {
      documents.push(JSON.parse(text.slice(start, index + 1)));
      start = -1;
    }
  }
  if (depth !== 0 || inString) throw new Error("HAR JSON document is truncated");
  if (!documents.length) throw new Error("no HAR JSON documents found");
  return documents;
}

function summarizeSip(messages) {
  const callAlias = aliasFactory("call-");
  const counts = new Map();
  const calls = new Map();
  const timeline = [];
  let normalRegisterChallenges = 0;

  for (const message of messages) {
    const data = str(message?.data);
    if (!data || (!data.startsWith("SIP/2.0") && !/^[A-Z]+\s+sips?:/i.test(data))) {
      continue;
    }
    const { firstLine, headers } = parseSipHeaders(data);
    const method = sipMethod(firstLine, headers);
    const status = sipStatus(firstLine);
    const direction = message.type === "send" ? "client-to-server" : "server-to-client";
    const callId = headers["call-id"] || headers["callid"] || null;
    const call = callAlias(callId);
    const at = isoFromFrameTime(message.time);
    const key = status ? `${direction}:${method}:${status}` : `${direction}:${method}`;
    increment(counts, key);

    if (method === "REGISTER" && status === 401) normalRegisterChallenges += 1;

    if (call) {
      if (!calls.has(call)) {
        calls.set(call, {
          call,
          firstAt: at,
          lastAt: at,
          methods: new Set(),
          statuses: new Set(),
          inviteFromServer: false,
          ackFromServer: false,
          byeFromServer: false,
          byeFromClient: false,
          cancelFromServer: false,
          cancelFromClient: false,
          offhookMode: false,
          autoAnswer: false,
        });
      }
      const record = calls.get(call);
      record.lastAt = at || record.lastAt;
      record.methods.add(method);
      if (status) record.statuses.add(status);
      if (method === "INVITE" && !status && direction === "server-to-client") {
        record.inviteFromServer = true;
      }
      if (method === "ACK" && !status && direction === "server-to-client") {
        record.ackFromServer = true;
      }
      if (method === "BYE" && !status && direction === "server-to-client") {
        record.byeFromServer = true;
      }
      if (method === "BYE" && !status && direction === "client-to-server") {
        record.byeFromClient = true;
      }
      if (method === "CANCEL" && !status && direction === "server-to-client") {
        record.cancelFromServer = true;
      }
      if (method === "CANCEL" && !status && direction === "client-to-server") {
        record.cancelFromClient = true;
      }
      if (/offhook/i.test(headers["p-rc-rcx-agent-mode"] || "")) record.offhookMode = true;
      if (/auto\s*answer/i.test(headers["alert-info"] || "")) record.autoAnswer = true;
    }

    const isLifecycle = ["INVITE", "ACK", "BYE", "CANCEL", "REGISTER"].includes(method);
    const isFailure = status != null && status >= 400
      && !(method === "REGISTER" && status === 401);
    if (isLifecycle || isFailure) {
      timeline.push({
        at,
        direction,
        call,
        method,
        status,
        offhookMode: /offhook/i.test(headers["p-rc-rcx-agent-mode"] || ""),
        autoAnswer: /auto\s*answer/i.test(headers["alert-info"] || ""),
      });
    }
  }

  return {
    frameCounts: Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b))),
    normalRegisterChallenges,
    calls: [...calls.values()].map((record) => ({
      ...record,
      methods: [...record.methods].sort(),
      statuses: [...record.statuses].sort((a, b) => a - b),
      elapsedMs: record.firstAt && record.lastAt
        ? new Date(record.lastAt).getTime() - new Date(record.firstAt).getTime()
        : null,
    })),
    timeline,
  };
}

function summarizeJsonFrames(messages) {
  const keyCounts = new Map();
  const safeStateValues = new Map();
  const parseErrors = { count: 0 };
  let parsedFrames = 0;
  let successfulTrue = 0;
  let successfulFalse = 0;
  let suspectTextFrames = 0;
  let failureTextFrames = 0;

  for (const message of messages) {
    const data = str(message?.data);
    if (!data) continue;
    if (/suspect/i.test(data)) suspectTextFrames += 1;
    if (/\b(fail|failed|failure|error|disconnect|terminated)\b/i.test(data)) {
      failureTextFrames += 1;
    }
    if (!(data.startsWith("{") || data.startsWith("["))) continue;
    try {
      const value = JSON.parse(data);
      parsedFrames += 1;
      walkJson(value, (key, child) => {
        increment(keyCounts, key);
        if (/^successful$/i.test(key) && child === true) successfulTrue += 1;
        if (/^successful$/i.test(key) && child === false) successfulFalse += 1;
        if (!/(^|_)(state|status|reason|result|action|event|type)$/i.test(key)) return;
        const safeValue = safeAlphaValue(child);
        if (safeValue) increment(safeStateValues, `${key}=${safeValue}`);
      });
    } catch {
      parseErrors.count += 1;
    }
  }

  return {
    parsedFrames,
    parseErrors: parseErrors.count,
    successfulTrue,
    successfulFalse,
    suspectTextFrames,
    failureTextFrames,
    topKeys: Object.fromEntries(
      [...keyCounts]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 40),
    ),
    safeStateValues: Object.fromEntries(
      [...safeStateValues]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 40),
    ),
  };
}

function main() {
  const input = process.argv[2];
  if (!input) throw new Error("usage: node scripts/analyze-ringcx-websocket-har.js <har-file>");
  const contents = fs.readFileSync(input, "utf8");
  const documents = parseJsonDocuments(contents);
  const entries = documents.flatMap((har) => (
    Array.isArray(har?.log?.entries) ? har.log.entries : []
  ));
  const websocketEntries = entries.filter((entry) => {
    const type = str(entry?._resourceType).toLowerCase();
    const scheme = (() => {
      try {
        return new URL(entry?.request?.url).protocol;
      } catch {
        return "";
      }
    })();
    return type === "websocket" || scheme === "ws:" || scheme === "wss:";
  });

  const output = {
    fileFingerprint: crypto
      .createHash("sha256")
      .update(contents)
      .digest("hex")
      .slice(0, 12),
    captures: documents.length,
    totalEntries: entries.length,
    websocketEntries: websocketEntries.length,
    sockets: [],
  };

  for (const entry of websocketEntries) {
    const url = new URL(entry.request.url);
    const messages = Array.isArray(entry._webSocketMessages)
      ? entry._webSocketMessages
      : [];
    const isSip = messages.some((message) => {
      const data = str(message?.data);
      return data.startsWith("SIP/2.0") || /^[A-Z]+\s+sips?:/i.test(data);
    });
    output.sockets.push({
      host: url.hostname,
      startedAt: entry.startedDateTime || null,
      durationMs: Math.round(Number(entry.time) || 0),
      messages: messages.length,
      sent: messages.filter((message) => message.type === "send").length,
      received: messages.filter((message) => message.type === "receive").length,
      protocol: isSip ? "sip" : "json",
      summary: isSip ? summarizeSip(messages) : summarizeJsonFrames(messages),
    });
  }

  console.log(JSON.stringify(output, null, 2));
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({
    error: str(error?.message || error).replace(/\b\d{7,}\b/g, "[masked]").slice(0, 200),
  }));
  process.exitCode = 1;
}
