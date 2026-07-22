"use strict";

// READ-ONLY diagnostic (2026-07-09). For every number in our caller-ID pools AND every number
// currently PRESENTED as an active campaign caller ID, read its RingCentral account phone-number
// record and report paymentType (External => a number added as an external caller ID, the classic
// cause of B-level STIR/SHAKEN attestation; Local/TollFree => RC-hosted, eligible for A), usageType,
// status, and extension assignment. This answers the "hosted vs external caller ID" half of the
// attestation question from our side, before the RC support ticket comes back. Writes NOTHING.

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
const fs = require("fs");
const { createRingCentralClient } = require("../packages/shared-integrations/src/ringcentralClient");
const { createRingcxVoiceClient } = require("../packages/shared-integrations/src/ringcxVoiceClient");

const digits = (v) => String(v || "").replace(/\D/g, "").replace(/^1(\d{10})$/, "$1");

function loadPools() {
  const raw = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "config", "rcx-caller-id-pools.json"), "utf8"));
  const nums = new Set();
  const groupIds = new Set();
  for (const entry of raw._agentOrder || []) if (entry.dialGroupId) groupIds.add(String(entry.dialGroupId));
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith("_")) continue;
    for (const n of Array.isArray(v) ? v : []) {
      const d = digits(n);
      if (d.length === 10) nums.add(d);
    }
  }
  return { nums, groupIds };
}

async function loadAccountRecords(rc) {
  const byNumber = new Map();
  const add = (payload) => {
    for (const r of Array.isArray(payload?.records) ? payload.records : []) {
      const d = digits(r?.phoneNumber);
      if (d.length !== 10) continue;
      const existing = byNumber.get(d);
      if (!existing) {
        byNumber.set(d, { ...r });
        continue;
      }
      // backfill informative fields — the v1 list carries paymentType that the v2 list omits
      for (const key of ["paymentType", "usageType", "status", "type", "extension"]) {
        if ((existing[key] == null || existing[key] === "") && r[key] != null) existing[key] = r[key];
      }
    }
  };
  add(await rc.listAccountPhoneNumbersV2({ allPages: true }).catch(() => null));
  add(await rc.listAccountPhoneNumbersV2({ allPages: true, usageType: "Inventory" }).catch(() => null));
  add(await rc.listAccountPhoneNumbers({ allPages: true }).catch(() => null));
  return byNumber;
}

async function presentedCallerIds(rcx, groupIds) {
  const present = new Map();
  const groups = await rcx.listDialGroups().catch(() => []);
  for (const g of Array.isArray(groups) ? groups : []) {
    const gid = String(g.dialGroupId || g.id);
    if (groupIds.size && !groupIds.has(gid)) continue;
    const camps = await rcx.listCampaigns(gid).catch(() => []);
    for (const c of Array.isArray(camps) ? camps : []) {
      const active = c.isActive === 1 || c.isActive === true || c.active === true;
      if (!active) continue;
      let cid = c.callerId;
      if (!cid) cid = (await rcx.getCampaign(String(c.campaignId || c.id), gid).catch(() => null))?.callerId;
      const d = digits(cid);
      if (d.length === 10) present.set(d, (present.get(d) || 0) + 1);
    }
  }
  return present;
}

(async () => {
  const { nums: pool, groupIds } = loadPools();
  const rc = createRingCentralClient();
  const rcx = createRingcxVoiceClient();
  const byNumber = await loadAccountRecords(rc);
  const present = await presentedCallerIds(rcx, groupIds);

  const all = [...new Set([...pool, ...present.keys()])].sort();
  console.log("CALLER-ID HOSTED-vs-EXTERNAL / ATTESTATION READINESS (read-only)\n");
  console.log("number      paymentType  usageType          status     onAccount  extId          live  pool");
  let hosted = 0, external = 0, missing = 0;
  for (const n of all) {
    const r = byNumber.get(n);
    const pay = r?.paymentType || (r ? "?" : "-");
    const isExternal = String(pay).toLowerCase() === "external";
    if (!r) missing++;
    else if (isExternal) external++;
    else hosted++;
    console.log(
      [
        n,
        String(pay).padEnd(11),
        String(r?.usageType || "-").padEnd(17),
        String(r?.status || "-").padEnd(9),
        (r ? "yes" : "NO").padEnd(9),
        String(r?.extension?.id || "-").padEnd(13),
        present.has(n) ? "LIVE" : "-",
        pool.has(n) ? "pool" : "-",
      ].join("  "),
    );
  }
  console.log(`\nSUMMARY: ${hosted} hosted (Local/TollFree) · ${external} EXTERNAL (B-attestation risk) · ${missing} NOT on account`);
  if (external > 0) {
    console.log("=> EXTERNAL caller-ID numbers found. An external/unverified CID is the classic cause of B attestation — likely the smoking gun. Confirm with the RC ticket.");
  } else if (missing > 0) {
    console.log("=> Some presented/pool numbers are NOT in the RC account inventory — RC can't A-attest a number it doesn't originate.");
  } else {
    console.log("=> All are account-hosted (Local/TollFree). If still flagged, this points to reputation (entity/pattern), not attestation — a paid-vendor path, not a numbers one.");
  }
})().catch((e) => {
  console.error(`attestation check failed: ${e.message}`);
  process.exit(1);
});
