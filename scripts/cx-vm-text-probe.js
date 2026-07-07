"use strict";

require("dotenv").config();

// VM-TEXT PILOT PROBE (S4, 2026-07-06): prove "text from the agent's own caller-ID number"
// with ONE agent (you), ONE JWT, ONE message - before any ceremony or wiring.
//
//   node scripts/cx-vm-text-probe.js                     -> DRY: auth, show who I am +
//                                                           which of my numbers can text
//   node scripts/cx-vm-text-probe.js --send --to +1602XXXXXXX
//                                                        -> send ONE test text to that
//                                                           number (use your own cell)
//   node scripts/cx-vm-text-probe.js --auth platform      -> use RINGCX_PLATFORM_* creds
//
// Env (name-only checks, values never printed):
//   RING_CENTRAL_CLIENT_ID / RING_CENTRAL_CLIENT_SECRET  - the EXISTING app (the app must
//     have the SMS permission added in the Dev Console, or the send returns 403)
//   RC_SMS_PROBE_JWT   - the agent's JWT (falls back to RING_CENTRAL_JWT_TOKEN so you can
//     first test with the main identity if it owns an SMS number)
//   RC_SMS_PROBE_FROM  - optional; otherwise the first SMS-capable number is used
//   RC_SMS_PROBE_EXTENSION_ID - optional; target extension to test "act as" behavior
//   RC_SMS_PROBE_AUTH - optional: default/ex (RingEX) or platform/cx (RingCX platform lane)
//
// Deliberately standalone (no shared ringcentralClient): that client is a singleton with
// module-level auth state - mixing a second JWT into it would pollute live auth. This
// probe is ~an auth call + two GETs + one POST, nothing shared.

const SERVER = process.env.RING_CENTRAL_SERVER_URL || process.env.RC_SERVER_URL || "https://platform.ringcentral.com";

const args = { send: false, to: null, extensionId: null, from: null, auth: null, jwtEnv: null };
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] === "--send") args.send = true;
  else if (process.argv[i] === "--to") args.to = process.argv[++i] || null;
  else if (process.argv[i] === "--extension" || process.argv[i] === "--extension-id") args.extensionId = process.argv[++i] || null;
  else if (process.argv[i] === "--from") args.from = process.argv[++i] || null;
  else if (process.argv[i] === "--auth" || process.argv[i] === "--auth-profile") args.auth = process.argv[++i] || null;
  else if (process.argv[i] === "--jwt-env") args.jwtEnv = process.argv[++i] || null;
}

function mask(phone) {
  const s = String(phone || "");
  return s.length > 4 ? `***${s.slice(-4)}` : s;
}

function normalizePhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return digits ? `+${digits}` : "";
}

function requireEnv(names) {
  const missing = names.filter((n) => !String(process.env[n] || "").trim());
  if (missing.length) {
    console.error(`Missing env (names only): ${missing.join(", ")}`);
    process.exit(1);
  }
}

function firstEnv(names) {
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (value) return { name, value };
  }
  return { name: names[0], value: "" };
}

function resolveAuthProfile() {
  const profile = String(args.auth || process.env.RC_SMS_PROBE_AUTH || "default").trim().toLowerCase();
  if (profile === "platform" || profile === "cx" || profile === "ringcx") {
    return {
      label: "platform",
      clientId: firstEnv(["RINGCX_PLATFORM_CLIENT_ID", "RING_CENTRAL_CLIENT_ID2"]),
      clientSecret: firstEnv(["RINGCX_PLATFORM_CLIENT_SECRET", "RING_CENTRAL_CLIENT_SECRET2"]),
      jwt: firstEnv([args.jwtEnv, "RINGCX_PLATFORM_JWT_TOKEN", "RING_CENTRAL_JWT_TOKEN2"].filter(Boolean)),
    };
  }
  if (profile === "default" || profile === "ex" || profile === "ringex") {
    return {
      label: "default",
      clientId: firstEnv(["RING_CENTRAL_CLIENT_ID", "RC_CLIENT_ID"]),
      clientSecret: firstEnv(["RING_CENTRAL_CLIENT_SECRET", "RC_CLIENT_SECRET"]),
      jwt: firstEnv([args.jwtEnv, "RC_SMS_PROBE_JWT", "RING_CENTRAL_JWT_TOKEN", "RC_JWT_TOKEN"].filter(Boolean)),
    };
  }
  return {
    label: profile || "custom",
    clientId: firstEnv(["RING_CENTRAL_CLIENT_ID", "RC_CLIENT_ID"]),
    clientSecret: firstEnv(["RING_CENTRAL_CLIENT_SECRET", "RC_CLIENT_SECRET"]),
    jwt: firstEnv([args.jwtEnv, profile].filter(Boolean)),
  };
}

async function checkOutboundSmsPermission(headers, targetExtensionId = null) {
  const url = new URL(`${SERVER}/restapi/v1.0/account/~/extension/~/authz-profile/check`);
  url.searchParams.set("permissionId", "OutboundSMS");
  if (targetExtensionId && targetExtensionId !== "~") url.searchParams.set("targetExtensionId", targetExtensionId);
  const res = await fetch(url, { headers });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, body };
}

function formatPermissionCheck(result) {
  if (!result?.ok) return `check failed (${result?.status || "?"})`;
  const successful = result.body?.successful === true ? "yes" : "no";
  const scopes = Array.isArray(result.body?.details?.scopes) ? result.body.details.scopes.join("|") : "-";
  return `successful=${successful} scopes=${scopes}`;
}

async function main() {
  const auth = resolveAuthProfile();
  const clientId = auth.clientId.value;
  const clientSecret = auth.clientSecret.value;
  const jwt = auth.jwt.value;
  const missing = [];
  if (!clientId) missing.push(auth.clientId.name);
  if (!clientSecret) missing.push(auth.clientSecret.name);
  if (!jwt) missing.push(auth.jwt.name);
  if (missing.length) {
    console.error(`Missing env (names only): ${missing.join(", ")}`);
    process.exit(1);
  }
  console.log(`probe auth profile: ${auth.label}`);
  console.log(`probe client id source: ${auth.clientId.name}`);
  console.log(`probe identity JWT source: ${auth.jwt.name}`);

  // 1) JWT-bearer auth
  const tokenRes = await fetch(`${SERVER}/restapi/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const token = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok) {
    console.error(`AUTH FAILED (${tokenRes.status}): ${token.error_description || token.message || "?"}`);
    console.error("Likely: JWT not for this app / expired / app auth type not JWT.");
    process.exit(1);
  }
  const headers = { Authorization: `Bearer ${token.access_token}` };
  const targetExtensionId = String(args.extensionId || process.env.RC_SMS_PROBE_EXTENSION_ID || "~").trim() || "~";

  // 2) Who am I?
  const me = await (await fetch(`${SERVER}/restapi/v1.0/account/~/extension/~`, { headers })).json();
  console.log(`authenticated as: ${me?.name || "?"} (ext ${me?.extensionNumber || "?"})`);
  console.log(`target SMS extension: ${targetExtensionId}`);

  const selfPermission = await checkOutboundSmsPermission(headers);
  console.log(`OutboundSMS permission for self: ${formatPermissionCheck(selfPermission)}`);
  if (targetExtensionId !== "~" && targetExtensionId !== String(me?.id || "")) {
    const targetPermission = await checkOutboundSmsPermission(headers, targetExtensionId);
    console.log(`OutboundSMS permission for target: ${formatPermissionCheck(targetPermission)}`);
    if (targetPermission.ok && targetPermission.body?.successful === false) {
      console.log("  note: this JWT cannot send SMS on behalf of that target extension.");
    }
  }

  // 3) Which target-extension numbers can send SMS?
  const numsRes = await fetch(
    `${SERVER}/restapi/v1.0/account/~/extension/${encodeURIComponent(targetExtensionId)}/phone-number?perPage=100`,
    { headers },
  );
  const nums = await numsRes.json().catch(() => ({}));
  if (!numsRes.ok) {
    console.error(`TARGET EXTENSION READ FAILED (${numsRes.status}): ${nums.message || nums.error_description || "?"}`);
    console.error("This JWT may not be allowed to act on/read that extension.");
    process.exit(1);
  }
  const records = Array.isArray(nums?.records) ? nums.records : [];
  const smsCapable = records.filter((r) => (r.features || []).includes("SmsSender"));
  console.log(`numbers on target extension: ${records.length}, SMS-capable: ${smsCapable.length}`);
  for (const r of records) {
    console.log(`  ${mask(r.phoneNumber)}  usage=${r.usageType || "-"}  features=${(r.features || []).join("|") || "-"}${(r.features || []).includes("SmsSender") ? "   <-- can text" : ""}`);
  }
  if (!smsCapable.length) {
    console.error("NO SMS-capable number on this identity - check the number's SMS feature + TCR campaign attachment.");
    process.exit(1);
  }

  const requestedFrom = args.from || process.env.RC_SMS_PROBE_FROM || null;
  const from = requestedFrom || smsCapable[0].phoneNumber;
  const smsCapableFrom = smsCapable.find((r) => normalizePhone(r.phoneNumber) === normalizePhone(from));
  if (!smsCapableFrom) {
    console.error(`Requested from ${mask(from)} is not SMS-capable on this authenticated extension.`);
    console.error("Run the dry probe without RC_SMS_PROBE_FROM to see the SMS-capable choices, or mint a JWT for the extension that owns this number.");
    process.exit(1);
  }
  if (!args.send) {
    console.log(`\nDRY RUN complete. Would send from ${mask(from)}.`);
    console.log("To send one real test: node scripts/cx-vm-text-probe.js --send --to +1YOURCELL");
    return;
  }
  if (!args.to) {
    console.error("--send requires --to +1XXXXXXXXXX (use your own cell)");
    process.exit(1);
  }

  // 4) The one test text - the vm-text template, opt-out line included.
  const agentFirstName = String(me?.name || "your agent").split(/\s+/)[0];
  const text = `Hi, this is ${agentFirstName} with Tax Advocate Group - I just left you a voicemail about your case. Call or text me back at this number. Reply STOP to opt out.`;
  const smsRes = await fetch(`${SERVER}/restapi/v1.0/account/~/extension/${encodeURIComponent(targetExtensionId)}/sms`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: { phoneNumber: from },
      to: [{ phoneNumber: args.to }],
      text,
    }),
  });
  const sms = await smsRes.json().catch(() => ({}));
  if (!smsRes.ok) {
    console.error(`SEND FAILED (${smsRes.status}): ${sms.message || sms.error_description || "?"}`);
    if (smsRes.status === 403) console.error("Likely: app/user SMS scope mismatch, or the JWT only has Self scope and cannot send for the target extension.");
    if (String(sms.errorCode || "").startsWith("MSG")) console.error("Likely: number not SMS-enabled for this user, or not attached to the TCR campaign.");
    process.exit(1);
  }
  console.log(`SENT: id=${sms.id} status=${sms.messageStatus || "?"} from=${mask(from)} to=${mask(args.to)}`);
  console.log("If it doesn't arrive in ~1 min: check TCR campaign attachment for this number (carrier filtering is silent).");
}

main().catch((err) => { console.error(err.message); process.exit(1); });
