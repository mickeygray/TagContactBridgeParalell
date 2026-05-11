"use strict";

// One-shot: list all RC webhook subscriptions for the account so we
// can see filters, addresses, and which extensions are subscribed.

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const RC_BASE = (process.env.RING_CENTRAL_SERVER_URL || "https://platform.ringcentral.com").replace(/\/$/, "");

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
  const tok = await token();
  const r = await fetch(`${RC_BASE}/restapi/v1.0/subscription`, {
    headers: { Authorization: `Bearer ${tok}` },
  });
  const j = await r.json();
  const subs = j.records || j.subscriptions || [];
  console.log(`Found ${subs.length} subscription(s):\n`);
  for (const s of subs) {
    console.log("──", s.id, "──");
    console.log("  status:    ", s.status);
    console.log("  expires:   ", s.expirationTime);
    console.log("  address:   ", s.deliveryMode?.address);
    console.log("  filters:");
    for (const f of (s.eventFilters || [])) console.log("    ·", f);
    console.log("");
  }
})().catch((e) => { console.error("fatal:", e); process.exit(1); });
