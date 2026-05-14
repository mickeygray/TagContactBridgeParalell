"use strict";

// RingCX recording-feature state diagnostic.
//
// Read-only. Hits every surface we can think of where the recording-
// feature flag might be exposed:
//
//   1. Token exchange whoami — does the bearer carry any scope hints?
//   2. listAccounts                — top-level account record
//   3. listDialGroups + getDialGroup — dial groups can carry recording flags
//   4. listAgentGroups            — agent groups sometimes carry permission hints
//   5. listAgents (small page)    — per-user permission visibility
//   6. interaction-metadata POST  — current 403 vs not (the actual gate)
//   7. recordings/dialogs/...     — direct GET probe (variants)
//
// Writes a structured report to runtime/ringcx-probe/recording-state-<ts>.json
// with every response or error, so we have evidence to send back to RC
// rather than re-debugging from screen scraping.

const path = require("path");
const fs = require("fs");

require("dotenv").config({
  path: path.resolve(__dirname, "..", ".env"),
});

const {
  createRingcxVoiceClient,
} = require("../packages/shared-integrations/src/ringcxVoiceClient");

const OUT_DIR = path.resolve(__dirname, "..", "runtime", "ringcx-probe");
fs.mkdirSync(OUT_DIR, { recursive: true });

function nowIso() {
  return new Date().toISOString();
}

function stamp() {
  return new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
}

// Helpers that recursively look for recording-related fields in a
// response object — used so we don't have to memorize the exact RC
// schema (which is undocumented in places). If we find any path whose
// key matches /record/i, surface it. Same for "enabled" siblings.
function findRecordingFields(obj, basePath = "") {
  const hits = [];
  if (obj === null || obj === undefined) return hits;
  if (Array.isArray(obj)) {
    obj.slice(0, 8).forEach((item, idx) => {
      hits.push(...findRecordingFields(item, `${basePath}[${idx}]`));
    });
    return hits;
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      const p = basePath ? `${basePath}.${k}` : k;
      if (/record/i.test(k) || /allow.*record/i.test(k)) {
        hits.push({ path: p, key: k, value: v });
      }
      if (typeof v === "object" && v !== null) {
        hits.push(...findRecordingFields(v, p));
      }
    }
  }
  return hits;
}

async function safe(label, fn) {
  const start = Date.now();
  try {
    const value = await fn();
    return {
      label,
      ok: true,
      elapsedMs: Date.now() - start,
      value,
    };
  } catch (err) {
    return {
      label,
      ok: false,
      elapsedMs: Date.now() - start,
      status: err?.status || err?.details?.responseStatus || null,
      errorCode: err?.details?.responseBody
        ? safeJsonField(err.details.responseBody, "errorCode")
        : null,
      message: err?.message || String(err),
      details: err?.details || null,
    };
  }
}

function safeJsonField(text, field) {
  try {
    const obj = JSON.parse(String(text || ""));
    return obj?.[field] || null;
  } catch {
    return null;
  }
}

// Raw direct-fetch helper for paths the client doesn't expose. Reuses
// the bearer via the client.auth.ensureToken() call.
async function rawGet(client, base, path) {
  const bearer = await client.auth.ensureToken();
  const url = `${base}${path}`;
  const r = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `${bearer.tokenType} ${bearer.accessToken}`,
      Accept: "application/json",
    },
  });
  const text = await r.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: r.status, ok: r.ok, body };
}

async function main() {
  const client = createRingcxVoiceClient();
  const report = {
    type: "recording-state-report",
    capturedAt: nowIso(),
    env: {
      mainAccountId: process.env.RINGCX_VOICE_MAIN_ACCOUNT_ID,
      subAccountId: process.env.RINGCX_VOICE_ACCOUNT_ID,
      recordingRcAccountId: process.env.RINGCX_RECORDING_RC_ACCOUNT_ID,
      recordingEnabled: process.env.RINGCX_RECORDING_ENABLED,
      rcUserEmail: process.env.RINGCX_VOICE_RC_USER_EMAIL,
    },
    probes: [],
  };

  // ── 1. whoami / bearer ──────────────────────────────────────
  report.probes.push(await safe("whoami", () => client.auth.whoami()));

  // ── 2. listAccounts ─────────────────────────────────────────
  const accountsRes = await safe("listAccounts", () => client.listAccounts());
  report.probes.push(accountsRes);
  if (accountsRes.ok) {
    report.recordingFieldHits = report.recordingFieldHits || [];
    report.recordingFieldHits.push(
      ...findRecordingFields(accountsRes.value, "listAccounts"),
    );
  }

  // ── 3. listDialGroups + getDialGroup for each ───────────────
  const dialGroupsRes = await safe("listDialGroups", () =>
    client.listDialGroups(),
  );
  report.probes.push(dialGroupsRes);
  if (dialGroupsRes.ok && Array.isArray(dialGroupsRes.value)) {
    report.recordingFieldHits = report.recordingFieldHits || [];
    report.recordingFieldHits.push(
      ...findRecordingFields(dialGroupsRes.value, "listDialGroups"),
    );
    // Detail probe each dial group (cheap — usually just 1-2 groups)
    for (const dg of dialGroupsRes.value.slice(0, 4)) {
      const id = dg?.dialGroupId || dg?.id;
      if (!id) continue;
      const detailRes = await safe(`getDialGroup(${id})`, () =>
        client.getDialGroup(id),
      );
      report.probes.push(detailRes);
      if (detailRes.ok) {
        report.recordingFieldHits.push(
          ...findRecordingFields(detailRes.value, `getDialGroup(${id})`),
        );
      }
    }
  }

  // ── 4. listAgentGroups + listAgents ────────────────────────
  const agentGroupsRes = await safe("listAgentGroups", () =>
    client.listAgentGroups(),
  );
  report.probes.push(agentGroupsRes);
  if (agentGroupsRes.ok && Array.isArray(agentGroupsRes.value)) {
    for (const ag of agentGroupsRes.value.slice(0, 3)) {
      const id = ag?.agentGroupId || ag?.id;
      if (!id) continue;
      const agentsRes = await safe(`listAgents(${id})`, () =>
        client.listAgents(id),
      );
      report.probes.push(agentsRes);
      if (agentsRes.ok) {
        report.recordingFieldHits = report.recordingFieldHits || [];
        report.recordingFieldHits.push(
          ...findRecordingFields(agentsRes.value, `listAgents(${id})`),
        );
      }
    }
  }

  // ── 5. interaction-metadata POST (the actual gate) ─────────
  // Re-run the same call our hourly poller makes — gives us the
  // canonical 403 message for the report.
  report.probes.push(
    await safe("interaction-metadata POST", () =>
      client.fetchInteractionMetadata({
        startTime: new Date(Date.now() - 60 * 60 * 1000),
        endTime: new Date(Date.now() - 15 * 60 * 1000),
      }),
    ),
  );

  // ── 6. Direct recordings endpoint GET probes ───────────────
  //
  // Three angles:
  //   a) GET on the collection (without dialog/segment) — does it 404
  //      because the path requires IDs, or 403 because feature is off?
  //   b) GET with a clearly-bogus dialog/segment — what's the error
  //      type? "not found" suggests permission is fine, "denied"
  //      suggests permission is the blocker.
  //   c) Try the alternate v2 path some docs mention (just to see if
  //      it's a different surface).
  const cxBase = (
    process.env.RINGCX_RECORDING_BASE_URL ||
    process.env.RINGCX_VOICE_BASE_URL ||
    "https://ringcx.ringcentral.com"
  ).replace(/\/$/, "");
  const cxPrefix =
    process.env.RINGCX_RECORDING_PATH_PREFIX || "/voice/api/cx/integration/v1";
  const subAcct = process.env.RINGCX_VOICE_ACCOUNT_ID;
  const mainAcct =
    process.env.RINGCX_RECORDING_RC_ACCOUNT_ID ||
    process.env.RINGCX_VOICE_MAIN_ACCOUNT_ID;

  report.probes.push(
    await safe("GET recordings collection (no IDs)", async () =>
      rawGet(
        client,
        cxBase,
        `${cxPrefix}/accounts/${mainAcct}/sub-accounts/${subAcct}/recordings`,
      ),
    ),
  );
  report.probes.push(
    await safe("GET recordings/dialogs/bogus/segments/bogus", async () =>
      rawGet(
        client,
        cxBase,
        `${cxPrefix}/accounts/${mainAcct}/sub-accounts/${subAcct}/recordings/dialogs/bogus-id/segments/bogus-id`,
      ),
    ),
  );

  // Some legacy docs reference v2. Worth checking once.
  report.probes.push(
    await safe("GET v2 /integration/v2/admin/reports/.../interactionMetadata", async () =>
      rawGet(
        client,
        cxBase,
        `/voice/api/integration/v2/admin/reports/accounts/${subAcct}/interactionMetadata`,
      ),
    ),
  );

  // ── 7. Summary inference ───────────────────────────────────
  const interactionResult = report.probes.find(
    (p) => p.label === "interaction-metadata POST",
  );
  const recordingsCollection = report.probes.find(
    (p) => p.label === "GET recordings collection (no IDs)",
  );
  const recordingsBogus = report.probes.find(
    (p) =>
      p.label === "GET recordings/dialogs/bogus/segments/bogus",
  );

  const inference = {
    interactionMetadataStatus: interactionResult?.status || (interactionResult?.ok ? 200 : null),
    interactionMetadataErrorCode: interactionResult?.errorCode,
    recordingsBogusStatus:
      recordingsBogus?.ok === true
        ? recordingsBogus.value?.status
        : recordingsBogus?.status,
    recordingsBogusInfersFeatureOff:
      // If we get access.denied with bogus IDs, the gate is permission,
      // not validation. If we get "not found", permission is OK.
      Boolean(
        (recordingsBogus?.ok === true && recordingsBogus.value?.status === 403) ||
          recordingsBogus?.status === 403,
      ),
  };

  if (inference.interactionMetadataStatus === 200) {
    inference.featureEnabled = true;
    inference.diagnosis =
      "Recording API is callable. If interactionMetadata returns rows for a window with known CX call activity, recording is fully on.";
  } else if (
    inference.interactionMetadataStatus === 403 &&
    inference.interactionMetadataErrorCode === "access.denied.exception"
  ) {
    inference.featureEnabled = false;
    inference.diagnosis =
      "Still 403 access.denied.exception on interaction-metadata. RC has not (yet) flipped the activation flag for this account, OR our user/app lacks the READ on Account permission. Send RC: (a) main rcAccountId, (b) sub-account id, (c) RC user email used by the JWT app, (d) the exact timestamp + requestUri of this 403.";
  } else {
    inference.featureEnabled = false;
    inference.diagnosis = `Unexpected response: status=${inference.interactionMetadataStatus} errorCode=${inference.interactionMetadataErrorCode}. Investigate.`;
  }
  report.inference = inference;

  const outPath = path.join(OUT_DIR, `recording-state-${stamp()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  // ── Console summary ────────────────────────────────────────
  console.log("=".repeat(60));
  console.log("RINGCX RECORDING-STATE REPORT");
  console.log("=".repeat(60));
  console.log(`Captured: ${report.capturedAt}`);
  console.log(`Account:  main=${mainAcct}  sub=${subAcct}`);
  console.log("");
  for (const probe of report.probes) {
    const status = probe.ok
      ? `ok (${probe.elapsedMs}ms)`
      : `FAIL ${probe.status || "?"} ${probe.errorCode || ""}`;
    console.log(`  ${probe.label.padEnd(48)} ${status}`);
  }
  console.log("");
  console.log("Recording-flavored field hits across responses:");
  const hits = report.recordingFieldHits || [];
  if (hits.length === 0) {
    console.log("  (none — no field whose key matches /record/i was found)");
  } else {
    for (const h of hits) {
      const v =
        typeof h.value === "object" ? JSON.stringify(h.value) : String(h.value);
      console.log(`  ${h.path} = ${v}`);
    }
  }
  console.log("");
  console.log("Inference:");
  console.log(`  featureEnabled:        ${report.inference.featureEnabled}`);
  console.log(`  interactionMetadata:   ${report.inference.interactionMetadataStatus} ${report.inference.interactionMetadataErrorCode || ""}`);
  console.log(`  recordings bogus GET:  ${report.inference.recordingsBogusStatus}`);
  console.log(`  diagnosis:             ${report.inference.diagnosis}`);
  console.log("");
  console.log(`Full report: ${outPath}`);
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
