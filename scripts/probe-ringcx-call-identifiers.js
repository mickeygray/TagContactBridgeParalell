#!/usr/bin/env node
"use strict";

// Read-only RingCX identifier probe.
//
// Given a known UII / telephonySessionId, this tries the RingCX surfaces
// that appear to accept a unique call identifier and writes a JSON receipt.
// It intentionally does not call mutating endpoints such as hangup,
// disposition, addSessionToCall, or toggleCallRecording.
//
// Usage:
//   node scripts/probe-ringcx-call-identifiers.js --uii 202605191709406470001453117720
//   node scripts/probe-ringcx-call-identifiers.js --uii ... --external-id parallel:WYNN:...
//   node scripts/probe-ringcx-call-identifiers.js --uii ... --try-recording-guesses

const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

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

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function redactText(text = "") {
  return String(text)
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/g, "Bearer [redacted]")
    .replace(/\b\d{10,11}\b/g, (match) => `${"*".repeat(Math.max(match.length - 4, 0))}${match.slice(-4)}`);
}

function containsInterestingHandle(text = "") {
  return {
    hasDialogId: /dialogId|dialog_id|dialog/i.test(text),
    hasSegmentId: /segmentId|segment_id|segment/i.test(text),
    hasRecording: /recording|recordingUrl|contentUri|archive/i.test(text),
    hasTranscript: /transcript|transcription/i.test(text),
    hasUii: /uii|UII|telephonySessionId|sessionId/i.test(text),
  };
}

async function readBody(response, maxBytes = 4000) {
  const contentType = response.headers.get("content-type") || "";
  if (/audio|octet-stream/i.test(contentType)) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      binary: true,
      byteLength: buffer.length,
      preview: `[binary ${buffer.length} bytes]`,
      json: null,
    };
  }
  const text = await response.text();
  let json = null;
  if (/json/i.test(contentType) && Buffer.byteLength(text) <= 250_000) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return {
    binary: false,
    byteLength: Buffer.byteLength(text),
    preview: redactText(text.slice(0, maxBytes)),
    json,
  };
}

async function callEndpoint({ label, method = "GET", url, bearer, body = null, accept = "application/json" }) {
  const startedAt = new Date();
  try {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `${bearer.tokenType} ${bearer.accessToken}`,
        Accept: accept,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await readBody(response);
    return {
      label,
      method,
      url: redactText(url),
      ok: response.ok,
      status: response.status,
      startedAt: startedAt.toISOString(),
      contentType: response.headers.get("content-type") || null,
      retryAfter: response.headers.get("retry-after") || null,
      ...containsInterestingHandle(payload.preview),
      bodyBytes: payload.byteLength,
      bodyPreview: payload.preview,
      bodyJson: payload.json,
    };
  } catch (error) {
    return {
      label,
      method,
      url: redactText(url),
      ok: false,
      startedAt: startedAt.toISOString(),
      error: error.message || String(error),
    };
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const uii = String(readFlag(argv, "--uii") || readFlag(argv, "--session-id") || "").trim();
  const externalId = String(readFlag(argv, "--external-id") || "").trim();
  const caseId = String(readFlag(argv, "--case-id") || "").trim();
  const tryRecordingGuesses = hasFlag(argv, "--try-recording-guesses");
  if (!uii) throw new Error("--uii <RingCX UII / telephonySessionId> is required");

  const outDir = path.resolve(__dirname, "..", "runtime", "ringcx-probe");
  fs.mkdirSync(outDir, { recursive: true });

  const client = createRingcxVoiceClient();
  const bearer = await client.auth.ensureToken();
  const adminBase = (process.env.RINGCX_VOICE_BASE_URL || "https://ringcx.ringcentral.com").replace(/\/$/, "");
  const accountId = client.config.accountId;
  const rcAccountId = process.env.RINGCX_RECORDING_RC_ACCOUNT_ID || bearer.mainAccountId;
  const recordingBase = (process.env.RINGCX_RECORDING_BASE_URL || process.env.RINGCX_VOICE_BASE_URL || "https://ringcx.ringcentral.com").replace(/\/$/, "");
  const recordingPrefix = (process.env.RINGCX_RECORDING_PATH_PREFIX || "/voice/api/cx/integration/v1").replace(/\/$/, "");

  const adminPrefix = `${adminBase}/voice/api/v1/admin/accounts/${accountId}`;
  const urls = [
    ["active-call", `${adminPrefix}/activeCalls/${encodeURIComponent(uii)}`],
    ["active-call-details", `${adminPrefix}/activeCalls/${encodeURIComponent(uii)}/details`],
    ["active-call-sessions", `${adminPrefix}/activeCalls/${encodeURIComponent(uii)}/sessions`],
    ["interaction-by-uii", `${adminPrefix}/interactions/${encodeURIComponent(uii)}`],
    ["call-detail-by-uii", `${adminPrefix}/callDetail/${encodeURIComponent(uii)}`],
    ["call-by-uii", `${adminPrefix}/calls/${encodeURIComponent(uii)}`],
    ["call-history-by-uii", `${adminPrefix}/callHistory/${encodeURIComponent(uii)}`],
    ["session-by-uii", `${adminPrefix}/sessions/${encodeURIComponent(uii)}`],
    ["recordings-by-uii", `${adminPrefix}/recordings/${encodeURIComponent(uii)}`],
  ];

  if (externalId) {
    const qs = new URLSearchParams({ externalId });
    urls.push(["active-calls-list-external-id", `${adminPrefix}/activeCalls/list?${qs}`]);
    urls.push(["calls-search-external-id", `${adminPrefix}/calls?${qs}`]);
  }
  if (caseId) {
    const qs = new URLSearchParams({ caseId });
    urls.push(["calls-search-case-id", `${adminPrefix}/calls?${qs}`]);
  }

  const probes = [];
  for (const [label, url] of urls) {
    probes.push(await callEndpoint({ label, url, bearer }));
  }

  if (tryRecordingGuesses && rcAccountId) {
    const recBase = `${recordingBase}${recordingPrefix}/accounts/${rcAccountId}/sub-accounts/${accountId}`;
    const guesses = [
      ["recording-dialog-uii-segment-uii", `${recBase}/recordings/dialogs/${encodeURIComponent(uii)}/segments/${encodeURIComponent(uii)}`],
      ["recording-dialog-uii-segment-0", `${recBase}/recordings/dialogs/${encodeURIComponent(uii)}/segments/0`],
      ["recording-dialog-uii-segment-1", `${recBase}/recordings/dialogs/${encodeURIComponent(uii)}/segments/1`],
    ];
    for (const [label, url] of guesses) {
      probes.push(await callEndpoint({ label, url, bearer, accept: "audio/wav" }));
    }
  }

  const report = {
    type: "ringcx-call-identifier-probe",
    generatedAt: new Date().toISOString(),
    accountId,
    rcAccountId: rcAccountId || null,
    uii,
    externalId: externalId || null,
    caseId: caseId || null,
    tryRecordingGuesses,
    probes,
    interesting: probes.filter((probe) =>
      probe.ok || probe.hasDialogId || probe.hasSegmentId || probe.hasRecording || probe.hasTranscript),
  };

  const outPath = path.join(outDir, `call-identifier-probe-${stamp()}.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`report: ${outPath}`);
  for (const probe of probes) {
    console.log(`${probe.label.padEnd(32)} ${String(probe.status || "ERR").padEnd(4)} dialog=${probe.hasDialogId ? "yes" : "no"} segment=${probe.hasSegmentId ? "yes" : "no"} recording=${probe.hasRecording ? "yes" : "no"}`);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
