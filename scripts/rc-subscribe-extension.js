"use strict";

// One-shot: create a per-extension presence webhook subscription on
// the RC tenant. Matches the shape of the existing 5 subs created by
// the v2 monolith's webhookManager.subscribeAgent — same address,
// same eventFilter pattern, same verificationToken default.
//
// Usage:
//   node scripts/rc-subscribe-extension.js --ext 63730035004
//   node scripts/rc-subscribe-extension.js --ext 63730035004 --address https://tag-webhook.ngrok.app/webhook/ex
//   node scripts/rc-subscribe-extension.js --ext 63730035004 --secret ringbridge-verify-token
//
// Defaults:
//   --address: https://tag-webhook.ngrok.app/webhook/ex (matches existing subs)
//   --secret:  RINGBRIDGE_WEBHOOK_SECRET env, falling back to "ringbridge-verify-token"
//              (matches v2's default, which is what the existing 5 subs use)
//   --expires: 630720000 (~20yr, matches v2)

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const RC_BASE = (process.env.RING_CENTRAL_SERVER_URL || "https://platform.ringcentral.com").replace(/\/$/, "");

function readFlag(argv, name, fallback = null) {
  const inline = argv.find((a) => a.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1) return argv[idx + 1];
  return fallback;
}

async function token() {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: process.env.RING_CENTRAL_JWT_TOKEN,
  });
  const basic = Buffer.from(
    `${process.env.RING_CENTRAL_CLIENT_ID}:${process.env.RING_CENTRAL_CLIENT_SECRET}`,
  ).toString("base64");
  const r = await fetch(`${RC_BASE}/restapi/oauth/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j));
  return j.access_token;
}

(async () => {
  const argv = process.argv.slice(2);
  const ext = readFlag(argv, "--ext");
  if (!ext) throw new Error("--ext <extensionId> required");
  const address = readFlag(argv, "--address", "https://tag-webhook.ngrok.app/webhook/ex");
  const secret = readFlag(
    argv,
    "--secret",
    process.env.RINGBRIDGE_WEBHOOK_SECRET || "ringbridge-verify-token",
  );
  const expiresIn = Number(readFlag(argv, "--expires", "630720000"));

  console.log("creating presence subscription:");
  console.log("  extension:  ", ext);
  console.log("  address:    ", address);
  console.log("  secret:     ", secret);
  console.log("  expiresIn:  ", expiresIn, "sec");

  const tok = await token();
  const r = await fetch(`${RC_BASE}/restapi/v1.0/subscription`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      eventFilters: [
        `/restapi/v1.0/account/~/extension/${ext}/presence?detailedTelephonyState=true&sipData=true`,
      ],
      deliveryMode: {
        transportType: "WebHook",
        address,
        verificationToken: secret,
      },
      expiresIn,
    }),
  });
  const j = await r.json();
  if (!r.ok) {
    console.error("FAILED:", r.status, JSON.stringify(j, null, 2));
    process.exit(1);
  }
  console.log("\nâœ“ subscribed:");
  console.log("  id:        ", j.id);
  console.log("  status:    ", j.status);
  console.log("  expires:   ", j.expirationTime);
  console.log("  filters:");
  for (const f of (j.eventFilters || [])) console.log("    Â·", f);
})().catch((e) => { console.error("fatal:", e); process.exit(1); });
