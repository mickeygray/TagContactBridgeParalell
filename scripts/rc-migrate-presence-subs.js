"use strict";

// One-shot: migrate all per-extension presence subscriptions from
// /webhook/ex (v2 monolith on 6100) to /webhook/ringcentral/ex
// (Parallel ringcentral-cx on 6101).
//
// Strategy per ext:
//   1. CREATE new sub at the new URL.
//   2. CONFIRM new sub is Active.
//   3. DELETE the old sub.
// (Create-then-delete order — ensures we're never zero-subbed for an
// extension during migration. Brief overlap = both subs deliver, but
// Parallel's processPresenceEnvelope is idempotent on the same body.)
//
// The 1 account-wide telephony sub on /webhook/ex is left ALONE —
// telephony events keep flowing to v2 unchanged.

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const RC_BASE = (process.env.RING_CENTRAL_SERVER_URL || "https://platform.ringcentral.com").replace(/\/$/, "");
const OLD_PATH = "/webhook/ex";
const NEW_PATH = "/webhook/ringcentral/ex";
const SECRET = process.env.RINGBRIDGE_WEBHOOK_SECRET || "ringbridge-verify-token";
const DRY_RUN = process.argv.includes("--dry-run");

function readFlag(name) {
  const inline = process.argv.find((a) => a.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && idx < process.argv.length - 1) return process.argv[idx + 1];
  return null;
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

async function rc(method, p, tok, body) {
  const r = await fetch(`${RC_BASE}${p}`, {
    method,
    headers: {
      Authorization: `Bearer ${tok}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!r.ok && r.status !== 204) {
    const text = await r.text().catch(() => "");
    throw new Error(`${method} ${p} ${r.status} ${text}`);
  }
  if (r.status === 204) return null;
  return r.json();
}

(async () => {
  const tok = await token();

  // Find all subs whose deliveryMode.address ends with OLD_PATH and
  // whose eventFilter is per-extension presence (not account-wide
  // telephony — leave that alone).
  const list = await rc("GET", "/restapi/v1.0/subscription", tok);
  const subs = (list.records || list.subscriptions || []);

  const targets = subs.filter((s) => {
    const addr = s.deliveryMode?.address || "";
    if (!addr.endsWith(OLD_PATH)) return false;
    const filters = s.eventFilters || [];
    return filters.some((f) => /\/extension\/\d+\/presence/.test(f));
  });

  console.log(`Found ${targets.length} per-extension presence sub(s) to migrate (out of ${subs.length} total subs)\n`);

  if (DRY_RUN) {
    console.log("DRY RUN — would migrate these:");
    for (const s of targets) {
      console.log(`  ${s.id}  filter: ${s.eventFilters[0]}`);
    }
    return;
  }

  for (const oldSub of targets) {
    const filter = oldSub.eventFilters[0];
    const newAddress = (oldSub.deliveryMode.address || "").replace(OLD_PATH, NEW_PATH);
    console.log(`── Migrating ${oldSub.id}`);
    console.log(`   filter:    ${filter}`);
    console.log(`   old addr:  ${oldSub.deliveryMode.address}`);
    console.log(`   new addr:  ${newAddress}`);

    // 1. Create new sub at new URL with same filter.
    const created = await rc("POST", "/restapi/v1.0/subscription", tok, {
      eventFilters: oldSub.eventFilters,
      deliveryMode: {
        transportType: "WebHook",
        address: newAddress,
        verificationToken: SECRET,
      },
      expiresIn: 630720000,
    });
    console.log(`   ✓ created new sub: ${created.id} (status=${created.status})`);

    if (created.status !== "Active") {
      console.log(`   ⚠ new sub not Active yet (status=${created.status}); skipping delete of old sub for safety`);
      continue;
    }

    // 2. Delete the old sub.
    await rc("DELETE", `/restapi/v1.0/subscription/${oldSub.id}`, tok);
    console.log(`   ✓ deleted old sub: ${oldSub.id}\n`);

    // Tiny pause to avoid any rate-limit edge.
    await new Promise((r) => setTimeout(r, 250));
  }

  console.log("\nMigration complete. Verifying with fresh subscription list:\n");
  const after = await rc("GET", "/restapi/v1.0/subscription", tok);
  for (const s of (after.records || after.subscriptions || [])) {
    console.log(`  ${s.id}  ${s.deliveryMode?.address}`);
    for (const f of (s.eventFilters || [])) console.log(`    · ${f}`);
  }
})().catch((e) => { console.error("fatal:", e); process.exit(1); });
