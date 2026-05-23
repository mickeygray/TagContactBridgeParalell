"use strict";

// Verifies the newly-rotated RC EX app credentials work through the
// actual app code path (not a standalone fetch).
//
// Loads .env, builds the real ringCentralClient, runs read smoke tests.
// Run: node scripts/smoke-rc-new-app.js

require("dotenv").config();

const { getRingCentralConfig } = require("../packages/shared-config/src/ringCentralConfig");
const { createRingCentralClient } = require("../packages/shared-integrations/src/ringcentralClient");

function mask(v) {
  if (!v) return "(unset)";
  if (v.length < 12) return "(short)";
  return `${v.slice(0, 6)}…${v.slice(-4)}`;
}

(async () => {
  const cfg = getRingCentralConfig();
  console.log("=== Config sanity ===");
  console.log("serverUrl:    ", cfg.serverUrl);
  console.log("clientId:     ", mask(cfg.clientId));
  console.log("clientSecret: ", mask(cfg.clientSecret));
  console.log("jwtToken:     ", mask(cfg.jwtToken));
  console.log("");

  if (!cfg.clientId || !cfg.clientSecret || !cfg.jwtToken) {
    console.error("Missing required RC env vars. Stopping.");
    process.exit(1);
  }

  const rc = createRingCentralClient();

  // 1. Auth
  try {
    const token = await rc.authenticate(true);
    const status = rc.getAuthStatus();
    console.log("[PASS] authenticate — token=" + mask(token));
    console.log("       expiresAt:", status.expiresAt);
  } catch (e) {
    console.error("[FAIL] authenticate —", e.message);
    if (e.details) console.error("       details:", JSON.stringify(e.details, null, 2));
    process.exit(2);
  }
  console.log("");

  let firstExtId = null;

  // 2. List extensions
  try {
    const r = await rc.listExtensions({ perPage: 5, page: 1, allPages: false });
    firstExtId = r?.records?.[0]?.id || null;
    console.log(
      `[PASS] listExtensions — got ${r?.records?.length ?? 0} (total=${r?.paging?.totalElements ?? "?"})`,
    );
  } catch (e) {
    console.error("[FAIL] listExtensions —", e.message);
  }

  // 3. Presence
  try {
    const extId = firstExtId || "~";
    const r = await rc.getPresence(extId);
    console.log(`[PASS] getPresence(${extId}) — presenceStatus=${r?.presenceStatus}`);
  } catch (e) {
    console.error("[FAIL] getPresence —", e.message);
  }

  // 4. Account call log
  try {
    const dateFrom = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const r = await rc.getAccountCallLog({ dateFrom, perPage: 5 });
    console.log(`[PASS] getAccountCallLog — got ${r?.records?.length ?? 0} records (last 24h)`);
  } catch (e) {
    console.error("[FAIL] getAccountCallLog —", e.message);
  }

  // 5. List subscriptions
  try {
    const r = await rc.listSubscriptions();
    console.log(`[PASS] listSubscriptions — got ${r?.records?.length ?? 0}`);
  } catch (e) {
    console.error("[FAIL] listSubscriptions —", e.message);
  }

  // 6. Extension phone numbers (if we got an ext)
  if (firstExtId) {
    try {
      const r = await rc.listExtensionPhoneNumbers(firstExtId);
      console.log(`[PASS] listExtensionPhoneNumbers(${firstExtId}) — got ${r?.records?.length ?? 0}`);
    } catch (e) {
      console.error("[FAIL] listExtensionPhoneNumbers —", e.message);
    }
  }

  // Stop the warmup timer if one was registered so the process exits cleanly.
  rc.stopWarmupTimer();
  process.exit(0);
})().catch((e) => {
  console.error("Unhandled:", e);
  process.exit(1);
});
