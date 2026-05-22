"use strict";

// Probe the RingCX API for the "Call Recording Delivery" feature.
// Tries several likely endpoint paths with our existing auth. Status
// codes tell us:
//   200 / 204   → feature is exposed; we can list/configure
//   401 / 403   → endpoint exists but our token lacks perms (still
//                 means the feature is at least known to RC's API
//                 layer for this account tier)
//   404         → endpoint doesn't exist on this account / not
//                 enabled for our tier
//   429         → rate-limited, try again
//
// Doesn't change any state — pure read.

require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
const { createRingcxVoiceClient } = require("../packages/shared-integrations/src");

async function tryPath(client, label, method, pathTemplate, body) {
  const accountId =
    client.config?.accountId ||
    process.env.RINGCX_RECORDING_RC_ACCOUNT_ID ||
    process.env.RINGCX_VOICE_ACCOUNT_ID;
  const subAccountId =
    client.config?.subAccountId ||
    process.env.RINGCX_VOICE_SUBACCOUNT_ID ||
    "50810001";
  const path = pathTemplate
    .replace("{accountId}", accountId || "")
    .replace("{subAccountId}", subAccountId || "");

  const t0 = Date.now();
  try {
    const result = await client.request(method, path, body ? { body } : {});
    const ms = Date.now() - t0;
    const sample = JSON.stringify(result).slice(0, 200);
    console.log(`  ✓ ${method.padEnd(4)} ${path}`);
    console.log(`      ${ms}ms — feature appears EXPOSED, response: ${sample}`);
    return { ok: true, path, response: result };
  } catch (error) {
    const ms = Date.now() - t0;
    const status = error?.details?.responseStatus || "?";
    const code = error?.code || "";
    const body = String(error?.details?.responseBody || "").slice(0, 120);
    const sym = status === 404 ? "✗" : status === 403 || status === 401 ? "⚠" : "?";
    console.log(`  ${sym} ${method.padEnd(4)} ${path}`);
    console.log(`      ${ms}ms — HTTP ${status} ${code} ${body}`);
    return { ok: false, path, status, error: error.message };
  }
}

(async () => {
  const client = createRingcxVoiceClient();
  const accountId = client.config?.accountId || process.env.RINGCX_RECORDING_RC_ACCOUNT_ID;
  console.log("");
  console.log("RingCX Call Recording Delivery probe");
  console.log(`  account: ${accountId}`);
  console.log(`  base   : ${client.config?.baseUrl || "(default)"}`);
  console.log("");
  console.log("Trying candidate endpoints (404 = not present, 200/403 = present):");
  console.log("");

  // Candidate paths for the "list delivery destinations / tasks" endpoints.
  // RingCX's docs aren't fully indexed for this feature, so we try a few
  // shapes. The accountId-scoped admin path is most likely.
  const candidates = [
    ["GET", "/voice/api/v1/admin/accounts/{accountId}/recordingDeliveryDestinations"],
    ["GET", "/voice/api/v1/admin/accounts/{accountId}/recordingDeliveryTasks"],
    ["GET", "/voice/api/v1/admin/accounts/{accountId}/recordings/delivery/destinations"],
    ["GET", "/voice/api/v1/admin/accounts/{accountId}/recordings/delivery/tasks"],
    ["GET", "/voice/api/v1/admin/accounts/{accountId}/callRecordings/deliveryDestinations"],
    ["GET", "/voice/api/v1/admin/accounts/{accountId}/callRecordings/deliveryTasks"],
    ["GET", "/voice/api/cx/integration/v1/accounts/{accountId}/sub-accounts/{subAccountId}/recordings/delivery/destinations"],
    ["GET", "/voice/api/cx/integration/v1/accounts/{accountId}/sub-accounts/{subAccountId}/recordings/delivery/tasks"],
    ["GET", "/voice/api/cx/integration/v1/accounts/{accountId}/sub-accounts/{subAccountId}/recording-delivery/destinations"],
    ["GET", "/voice/api/cx/integration/v1/accounts/{accountId}/sub-accounts/{subAccountId}/recording-delivery/tasks"],
    // Some older docs reference plain `recordings/destinations`:
    ["GET", "/voice/api/v1/admin/accounts/{accountId}/recordings/destinations"],
  ];

  const results = [];
  for (const [method, path] of candidates) {
    const r = await tryPath(client, "", method, path);
    results.push(r);
    // small delay so we don't trip any per-second rate limit
    await new Promise((r) => setTimeout(r, 250));
  }

  console.log("");
  console.log("─── Summary ───");
  const found = results.filter((r) => r.ok || r.status === 401 || r.status === 403);
  const missing = results.filter((r) => r.status === 404);
  const other = results.filter((r) => !r.ok && r.status !== 404 && r.status !== 401 && r.status !== 403);

  if (found.length > 0) {
    console.log(`\n  Feature APPEARS PRESENT — ${found.length} endpoint(s) responded with non-404:`);
    for (const r of found) console.log(`    ${r.path}`);
    console.log(`\n  Even if the response was 403, the path exists in RC's routing layer,`);
    console.log(`  which means the feature is at least available on this account tier.`);
    console.log(`  Next: try saving a destination in the RingCX admin UI.`);
  } else if (missing.length === candidates.length) {
    console.log(`\n  Every candidate returned 404. Feature likely NOT enabled on this account.`);
    console.log(`  Next: file the RC support ticket to activate "Call recording transfer to`);
    console.log(`  customer-hosted SFTP" on subaccount 50810001.`);
  } else {
    console.log(`\n  Mixed results. ${missing.length} 404s, ${found.length} possibly-present, ${other.length} other errors.`);
    console.log(`  Best next step is still the RingCX admin UI test.`);
  }
  console.log("");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
