"use strict";

// CALLER-ID SHIFTER (carrier-block incident, 2026-07-08). The carrier is scoring/
// blocking our outbound ANIs upstream of RingCX; the escape lever is per-CAMPAIGN
// caller ID (campaign.callerId + callerIdE164), settable via the proven full-object
// GET -> PUT (the dial-order sauce pattern).
//
//   node scripts/rcx-shift-caller-ids.js list
//       Read-only: every dial group -> campaign -> current callerId. The burn map —
//       shows which numbers are presented where and which campaigns share an ANI.
//
//   node scripts/rcx-shift-caller-ids.js shift --to 8185551234 --campaigns 2344,2457 [--arm]
//   node scripts/rcx-shift-caller-ids.js shift --to 8185551234 --group 1011 [--arm]
//
//   node scripts/rcx-shift-caller-ids.js rotate [--group 1011] [--arm]
//       THE HOURLY ROTATION (Mickey's design, 2026-07-08): each agent's campaigns swap
//       caller ID to the NEXT number in that dial group's POOL — every pool number is
//       a tenant DID that routes callbacks to that same agent's phone. Pools live in
//       config/cx-caller-id-rotation-pools.json ({ "<dialGroupId>": ["<10d>", ...] }). The
//       rotation is STATELESS: next = pool[(indexOf(current) + 1) % len]; a current
//       number not in the pool starts at pool[0]. Unmapped groups are never touched;
//       pools with fewer than 2 numbers are skipped loudly. Schedule (after ONE
//       validated manual --arm run):
//         schtasks /Create /SC HOURLY /TN RcxCallerIdRotate /TR "node C:/code/TagContactBridgeParalell/scripts/rcx-shift-caller-ids.js rotate --arm"

//       Set the caller ID on the named campaigns (or every ACTIVE campaign in a dial
//       group). Dry-run default: prints old -> new and writes NOTHING without --arm.
//       Only callerId/callerIdE164 change; all other campaign fields ride unchanged.
//       Read-back GET verifies every armed write.
//
// RULES: the target number MUST be a DID owned/provisioned on this RingCentral tenant
// (a non-owned number is spoofing and craters attestation). Do NOT use the VM-drop
// monitor DIDs (they are drop caller IDs with answerer machinery on the other end).
// Mickey picks the rested number; this tool just moves it.

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const { createRingcxVoiceClient } = require("../packages/shared-integrations/src/ringcxVoiceClient");
const { createRingCentralClient } = require("../packages/shared-integrations/src/ringcentralClient");

const argv = process.argv.slice(2);
const cmd = argv[0];
const ARM = argv.includes("--arm");
const WITH_EXTENSIONS = argv.includes("--with-extensions");
function readFlag(name, fallback = null) {
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1 && !argv[idx + 1].startsWith("--")) return argv[idx + 1];
  return fallback;
}

function digits(value) {
  return String(value || "").replace(/\D/g, "").replace(/^1(\d{10})$/, "$1");
}
function toE164(value) {
  const d = digits(value);
  return d.length === 10 ? `+1${d}` : d ? `+${String(value).replace(/\D/g, "")}` : "";
}

function nextPoolNumber(pool = [], currentValue = "") {
  const current = digits(currentValue);
  const idx = pool.indexOf(current);
  return pool[(idx + 1) % pool.length]; // idx -1 -> pool[0]
}

async function listAll(client) {
  const groups = await client.listDialGroups();
  const rows = [];
  for (const group of Array.isArray(groups) ? groups : []) {
    const groupId = group.dialGroupId || group.id;
    const campaigns = await client.listCampaigns(groupId).catch(() => []);
    for (const campaign of Array.isArray(campaigns) ? campaigns : []) {
      const campaignId = String(campaign.campaignId || campaign.id);
      // the list endpoint is slim — callerId only rides the full campaign object
      let callerId = campaign.callerId || null;
      if (!callerId) {
        const full = await client.getCampaign(campaignId, groupId).catch(() => null);
        callerId = full?.callerId || null;
      }
      rows.push({
        groupId: String(groupId),
        groupName: group.dialGroupName || group.name || "",
        campaignId,
        campaignName: campaign.campaignName || campaign.name || "",
        active: campaign.isActive === 1 || campaign.isActive === true || campaign.active === true,
        callerId,
      });
    }
  }
  return rows;
}

function loadPoolConfig() {
  const fs = require("fs");
  // One source of truth: the backend Boring worker and this manual tool both
  // consume the registered-pool config. rcx-caller-id-pools.json is legacy.
  const poolPath = path.resolve(__dirname, "..", "config", "cx-caller-id-rotation-pools.json");
  if (!fs.existsSync(poolPath)) {
    console.error(`no pool file at ${poolPath} — create { "<dialGroupId>": ["<10-digit>", ...] }`);
    process.exit(2);
  }
  const raw = JSON.parse(fs.readFileSync(poolPath, "utf8"));
  const pools = {};
  for (const [groupId, numbers] of Object.entries(raw)) {
    if (String(groupId).startsWith("_")) continue;
    pools[String(groupId)] = (Array.isArray(numbers) ? numbers : []).map(digits).filter((d) => d.length === 10);
  }
  const agentOrder = (Array.isArray(raw._agentOrder) ? raw._agentOrder : [])
    .map((entry) => ({
      order: Number(entry.order || 0) || 0,
      name: String(entry.name || "").trim(),
      email: String(entry.email || "").trim().toLowerCase(),
      dialGroupId: String(entry.dialGroupId || "").trim(),
      extensionId: String(entry.extensionId || "").trim(),
      extensionNumber: String(entry.extensionNumber || "").trim(),
    }))
    .filter((entry) => entry.dialGroupId && entry.extensionId)
    .sort((a, b) => a.order - b.order || a.dialGroupId.localeCompare(b.dialGroupId));
  return { pools, agentOrder };
}

function callerIdPhoneDigits(payload = {}) {
  const items = [
    ...(Array.isArray(payload.byDevice) ? payload.byDevice : []),
    ...(Array.isArray(payload.byFeature) ? payload.byFeature : []),
  ];
  return items
    .map((item) => digits(item?.callerId?.phoneInfo?.phoneNumber))
    .filter((value) => value.length === 10);
}

function chooseCurrentCallerId(payload = {}, pool = []) {
  const currentNumbers = callerIdPhoneDigits(payload);
  return currentNumbers.find((value) => pool.includes(value)) || currentNumbers[0] || "";
}

function buildAccountPhoneNumberMap(payload = {}) {
  const map = new Map();
  for (const record of Array.isArray(payload.records) ? payload.records : []) {
    const number = digits(record?.phoneNumber);
    const id = String(record?.id || "").trim();
    if (number.length === 10 && id) map.set(number, id);
  }
  return map;
}

function mergePhoneNumberMap(target, payload = {}) {
  for (const [number, id] of buildAccountPhoneNumberMap(payload)) {
    if (!target.has(number)) target.set(number, id);
  }
  return target;
}

function callerIdTargetCount(payload = {}) {
  const items = [
    ...(Array.isArray(payload.byDevice) ? payload.byDevice : []),
    ...(Array.isArray(payload.byFeature) ? payload.byFeature : []),
  ];
  return items.filter((item) => item?.callerId).length;
}

function slimDevice(device = {}) {
  const id = String(device?.id || "").trim();
  return id ? { id } : device;
}

function slimCallerId(callerId = {}, phoneNumberId) {
  return {
    type: callerId.type || "PhoneNumber",
    phoneInfo: { id: String(phoneNumberId) },
  };
}

function buildExtensionCallerIdPatch(payload = {}, phoneNumberId) {
  const patch = {};
  if (Array.isArray(payload.byDevice)) {
    patch.byDevice = payload.byDevice.map((item) => ({
      device: slimDevice(item.device),
      callerId: item.callerId ? slimCallerId(item.callerId, phoneNumberId) : item.callerId,
    }));
  }
  if (Array.isArray(payload.byFeature)) {
    patch.byFeature = payload.byFeature.map((item) => ({
      feature: item.feature,
      callerId: item.callerId ? slimCallerId(item.callerId, phoneNumberId) : item.callerId,
    }));
  }
  if (Object.prototype.hasOwnProperty.call(payload, "extensionNameForOutboundCalls")) {
    patch.extensionNameForOutboundCalls = Boolean(payload.extensionNameForOutboundCalls);
  }
  if (Object.prototype.hasOwnProperty.call(payload, "extensionNumberForInternalCalls")) {
    patch.extensionNumberForInternalCalls = Boolean(payload.extensionNumberForInternalCalls);
  }
  return patch;
}

async function buildExtensionMoves({ pools, agentOrder, onlyGroup } = {}) {
  const moves = [];
  const skipped = [];
  const candidates = [];

  for (const agent of agentOrder) {
    if (onlyGroup && String(agent.dialGroupId) !== String(onlyGroup)) continue;
    const pool = pools[agent.dialGroupId];
    if (!pool) continue;
    if (pool.length < 2) {
      skipped.push({ agent, reason: `pool has ${pool.length} number(s)` });
      continue;
    }
    candidates.push({ agent, pool });
  }

  if (!candidates.length) return { rcClient: null, moves, skipped };

  const rcClient = createRingCentralClient();
  const phoneNumberIds = new Map();
  const accountNumbers = await rcClient.listAccountPhoneNumbers({ allPages: true });
  mergePhoneNumberMap(phoneNumberIds, accountNumbers);
  if (typeof rcClient.listAccountPhoneNumbersV2 === "function") {
    const allV2 = await rcClient.listAccountPhoneNumbersV2({ allPages: true }).catch(() => null);
    mergePhoneNumberMap(phoneNumberIds, allV2 || {});
    const inventoryV2 = await rcClient.listAccountPhoneNumbersV2({ allPages: true, usageType: "Inventory" }).catch(() => null);
    mergePhoneNumberMap(phoneNumberIds, inventoryV2 || {});
  }

  for (const { agent, pool } of candidates) {
    const currentPayload = await rcClient.getExtensionCallerId(agent.extensionId);
    const current = chooseCurrentCallerId(currentPayload, pool);
    const next = nextPoolNumber(pool, current);
    if (next === current) continue;
    const phoneNumberId = phoneNumberIds.get(next) || "";
    const targetCount = callerIdTargetCount(currentPayload);
    moves.push({
      agent,
      current,
      next,
      phoneNumberId,
      targetCount,
      patch: phoneNumberId ? buildExtensionCallerIdPatch(currentPayload, phoneNumberId) : null,
    });
  }

  return { rcClient, moves, skipped };
}

async function loadPhoneNumberRecords(rcClient) {
  const byNumber = new Map();
  const addRecords = (payload = {}) => {
    for (const record of Array.isArray(payload.records) ? payload.records : []) {
      const number = digits(record?.phoneNumber);
      if (number.length === 10 && !byNumber.has(number)) byNumber.set(number, record);
    }
  };
  addRecords(await rcClient.listAccountPhoneNumbersV2({ allPages: true }).catch(() => null));
  addRecords(await rcClient.listAccountPhoneNumbersV2({ allPages: true, usageType: "Inventory" }).catch(() => null));
  addRecords(await rcClient.listAccountPhoneNumbers({ allPages: true }).catch(() => null));
  return byNumber;
}

async function assignPoolsToExtensions() {
  const { pools, agentOrder } = loadPoolConfig();
  const onlyGroup = readFlag("--group");
  const allowReassign = argv.includes("--allow-reassign");
  const rcClient = createRingCentralClient();
  const byNumber = await loadPhoneNumberRecords(rcClient);
  const assignments = [];
  const skipped = [];

  for (const agent of agentOrder) {
    if (onlyGroup && String(agent.dialGroupId) !== String(onlyGroup)) continue;
    const pool = pools[agent.dialGroupId] || [];
    for (const number of pool) {
      const record = byNumber.get(number);
      if (!record) {
        skipped.push({ agent, number, reason: "not found in account/inventory" });
        continue;
      }
      const currentExtensionId = String(record?.extension?.id || "").trim();
      const usageType = String(record?.usageType || "").trim();
      if (currentExtensionId === agent.extensionId) {
        skipped.push({ agent, number, reason: "already assigned to this extension" });
        continue;
      }
      if (currentExtensionId && !allowReassign) {
        skipped.push({ agent, number, reason: `assigned to another extension (${currentExtensionId}); use --allow-reassign` });
        continue;
      }
      assignments.push({
        agent,
        number,
        phoneNumberId: String(record.id || "").trim(),
        usageType,
        currentExtensionId,
      });
    }
  }

  console.log(`ASSIGN POOLS ${ARM ? "(ARMED)" : "(dry-run)"} - ${assignments.length} number(s) to extension pools`);
  for (const item of skipped) {
    console.log(`  SKIP [${item.agent.dialGroupId}] ${item.agent.name} ${item.number}: ${item.reason}`);
  }
  for (const item of assignments) {
    console.log(`  [${item.agent.dialGroupId}] ${item.agent.name} ext ${item.agent.extensionNumber}: ${item.number} (${item.usageType || "unknown"}) -> extension ${item.agent.extensionId}`);
  }
  if (!ARM) {
    console.log("dry-run: nothing written. Re-run with --arm.");
    return;
  }

  let failed = 0;
  for (const item of assignments) {
    try {
      await rcClient.assignPhoneNumberV2(item.phoneNumberId, {
        usageType: "DirectNumber",
        extension: { id: item.agent.extensionId },
      });
      console.log(`  OK [${item.agent.dialGroupId}] ${item.agent.name}: ${item.number}`);
    } catch (error) {
      failed += 1;
      const detail = error?.details?.responseBody?.message || error.message;
      console.log(`  FAILED [${item.agent.dialGroupId}] ${item.agent.name}: ${item.number} - ${detail}`);
    }
  }
  if (failed) process.exitCode = 1;
}

async function rotate(client) {
  const { pools, agentOrder } = loadPoolConfig();
  const onlyGroup = readFlag("--group");
  const rows = await listAll(client);
  const moves = [];
  const seenGroups = new Set();
  for (const r of rows) {
    if (!r.active) continue;
    if (onlyGroup && String(r.groupId) !== String(onlyGroup)) continue;
    const pool = pools[r.groupId];
    if (!pool) continue; // unmapped group: never touched
    seenGroups.add(r.groupId);
    if (pool.length < 2) {
      console.log(`  SKIP [${r.groupId}] pool has ${pool.length} number(s) — rotation needs >= 2`);
      continue;
    }
    const current = digits(r.callerId);
    const next = nextPoolNumber(pool, current);
    if (next === current) continue;
    moves.push({ ...r, next });
  }
  console.log(`ROTATE ${ARM ? "(ARMED)" : "(dry-run)"} — ${moves.length} campaign(s) across ${seenGroups.size} mapped group(s)`);
  for (const m of moves) {
    console.log(`  [${m.groupId}] ${m.campaignId} ${m.campaignName}: ${m.callerId || "(none)"} -> ${m.next}`);
  }
  if (!ARM) {
    console.log("dry-run: nothing written. Re-run with --arm.");
    return;
  }
  let failed = 0;
  for (const m of moves) {
    const full = await client.getCampaign(m.campaignId, m.groupId);
    full.callerId = m.next;
    full.callerIdE164 = toE164(m.next);
    await client.updateCampaign(m.campaignId, full, m.groupId);
    const verify = await client.getCampaign(m.campaignId, m.groupId);
    const ok = digits(verify.callerId) === m.next;
    if (!ok) failed += 1;
    console.log(`  ${ok ? "OK " : "FAILED-VERIFY"} [${m.groupId}] ${m.campaignId}: -> ${verify.callerId}`);
  }
  if (failed) process.exitCode = 1;
}

async function rotateOrdered(client) {
  const { pools, agentOrder } = loadPoolConfig();
  const onlyGroup = readFlag("--group");
  const rows = await listAll(client);
  const campaignMoves = [];
  const seenGroups = new Set();
  for (const row of rows) {
    if (!row.active) continue;
    if (onlyGroup && String(row.groupId) !== String(onlyGroup)) continue;
    const pool = pools[row.groupId];
    if (!pool) continue;
    seenGroups.add(row.groupId);
    if (pool.length < 2) {
      console.log(`  SKIP [${row.groupId}] pool has ${pool.length} number(s) - rotation needs >= 2`);
      continue;
    }
    const current = digits(row.callerId);
    const next = nextPoolNumber(pool, current);
    if (next === current) continue;
    campaignMoves.push({ ...row, next });
  }

  const extensionPlan = WITH_EXTENSIONS
    ? await buildExtensionMoves({ pools, agentOrder, onlyGroup })
    : { rcClient: null, moves: [], skipped: [] };

  console.log(`ROTATE ${ARM ? "(ARMED)" : "(dry-run)"} - ${campaignMoves.length} campaign(s) across ${seenGroups.size} mapped group(s)`);
  for (const move of campaignMoves) {
    console.log(`  [${move.groupId}] ${move.campaignId} ${move.campaignName}: ${move.callerId || "(none)"} -> ${move.next}`);
  }
  if (WITH_EXTENSIONS) {
    console.log(`EXTENSION LOCKSTEP ${ARM ? "(ARMED)" : "(dry-run)"} - ${extensionPlan.moves.length} extension(s) in configured order`);
    for (const item of extensionPlan.skipped) {
      console.log(`  EXT SKIP [${item.agent.dialGroupId}] ${item.agent.name}: ${item.reason}`);
    }
    for (const move of extensionPlan.moves) {
      const idStatus = move.phoneNumberId ? `phoneNumberId=${move.phoneNumberId}` : "missing phoneNumberId";
      console.log(`  EXT [${move.agent.dialGroupId}] ${move.agent.name} ext ${move.agent.extensionNumber}: ${move.current || "(none)"} -> ${move.next} (${idStatus}, targets=${move.targetCount})`);
    }
  }

  if (!ARM) {
    console.log("dry-run: nothing written. Re-run with --arm.");
    return;
  }

  let failed = 0;
  for (const move of campaignMoves) {
    const full = await client.getCampaign(move.campaignId, move.groupId);
    full.callerId = move.next;
    full.callerIdE164 = toE164(move.next);
    await client.updateCampaign(move.campaignId, full, move.groupId);
    const verify = await client.getCampaign(move.campaignId, move.groupId);
    const ok = digits(verify.callerId) === move.next;
    if (!ok) failed += 1;
    console.log(`  ${ok ? "OK " : "FAILED-VERIFY"} [${move.groupId}] ${move.campaignId}: -> ${verify.callerId}`);
  }
  for (const move of extensionPlan.moves) {
    if (!move.phoneNumberId || !move.targetCount || !move.patch) {
      failed += 1;
      console.log(`  FAILED-VERIFY EXT [${move.agent.dialGroupId}] ${move.agent.name}: cannot update (${move.phoneNumberId ? "no targets" : "missing phoneNumberId"})`);
      continue;
    }
    await extensionPlan.rcClient.updateExtensionCallerId(move.agent.extensionId, move.patch);
    const verify = await extensionPlan.rcClient.getExtensionCallerId(move.agent.extensionId);
    const numbers = callerIdPhoneDigits(verify);
    const ok = numbers.length > 0 && numbers.every((number) => number === move.next);
    if (!ok) failed += 1;
    console.log(`  ${ok ? "OK " : "FAILED-VERIFY"} EXT [${move.agent.dialGroupId}] ${move.agent.name}: -> ${move.next}`);
  }
  if (failed) process.exitCode = 1;
}

// ── rotate-daily (Mickey, 2026-07-08 — DESIGN/SCRIPT stage, not app-wired) ─────────────
// Read each agent's EXTENSION pool (the DIDs assigned to their ext — self-maintaining: rest
// or add a DID on the extension and the pool follows), track today's used numbers, and
// REPLACE the current campaign caller-ID with one that has NOT been used today. A replaced
// number is recorded as used and won't come back until TOMORROW (a new Pacific date wipes the
// state). This is the one stateful bit — a small per-day file — the deliberate departure from
// the stateless `rotate`. Dry-run default: computes + prints the plan, writes NOTHING and
// records NOTHING without --arm. Intended cadence is every 2h via schedule (one run per slot);
// each armed run advances one number, so a 5-number ext pool supports ~4 rotations/day.
const USED_TODAY_PATH = path.resolve(__dirname, "..", "config", "rcx-caller-id-used-today.json");

function pacificDateKey(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function loadUsedToday(dateKey) {
  const fs = require("fs");
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(USED_TODAY_PATH, "utf8"));
  } catch {
    raw = {};
  }
  return raw && typeof raw[dateKey] === "object" && raw[dateKey] ? raw[dateKey] : {};
}

function saveUsedToday(dateKey, todayMap) {
  const fs = require("fs");
  // prune to today only so the state file never grows across days
  fs.writeFileSync(USED_TODAY_PATH, `${JSON.stringify({ [dateKey]: todayMap }, null, 2)}\n`, "utf8");
}

function extensionPoolFromRecords(byNumber, extensionId) {
  const pool = [];
  for (const [number, record] of byNumber) {
    if (String(record?.extension?.id || "").trim() === String(extensionId) && number.length === 10) {
      pool.push(number);
    }
  }
  return pool;
}

async function rotateDaily(client, rcClient) {
  const { agentOrder } = loadPoolConfig();
  const onlyGroup = readFlag("--group");
  const dateKey = pacificDateKey();
  const usedToday = loadUsedToday(dateKey);

  const byNumber = await loadPhoneNumberRecords(rcClient);
  const rows = await listAll(client);

  const plan = [];
  for (const agent of agentOrder) {
    if (onlyGroup && String(agent.dialGroupId) !== String(onlyGroup)) continue;
    const pool = extensionPoolFromRecords(byNumber, agent.extensionId);
    const campaigns = rows.filter((r) => String(r.groupId) === String(agent.dialGroupId) && r.active);
    if (!campaigns.length) {
      plan.push({ agent, skip: "no active campaigns" });
      continue;
    }
    if (pool.length < 2) {
      plan.push({ agent, skip: `extension pool has ${pool.length} number(s) — need >= 2` });
      continue;
    }
    const currents = [...new Set(campaigns.map((c) => digits(c.callerId)).filter((d) => d.length === 10))];
    // "used today" = anything already recorded today PLUS whatever is presented right now
    const used = new Set([...(usedToday[agent.extensionId] || []), ...currents]);
    const pick = pool.find((n) => !used.has(n)) || null; // first pool number not used today
    plan.push({ agent, pool, campaigns, currents, pick, usedCount: used.size });
  }

  console.log(`ROTATE-DAILY ${ARM ? "(ARMED)" : "(dry-run)"} — ${dateKey} (Pacific) — ${plan.filter((p) => p.pick).length}/${plan.length} agent(s) rotating`);
  for (const p of plan) {
    if (p.skip) {
      console.log(`  SKIP [${p.agent.dialGroupId}] ${p.agent.name}: ${p.skip}`);
      continue;
    }
    if (!p.pick) {
      console.log(`  EXHAUSTED [${p.agent.dialGroupId}] ${p.agent.name}: all ${p.pool.length} ext number(s) used today — HOLDING ${p.currents.join("/") || "(none)"}`);
      continue;
    }
    console.log(`  [${p.agent.dialGroupId}] ${p.agent.name} (${p.campaigns.length} campaign(s)): ${p.currents.join("/") || "(none)"} -> ${p.pick}   [used today ${p.usedCount}/${p.pool.length}]`);
  }
  if (!ARM) {
    console.log("dry-run: nothing written, no state recorded. Re-run with --arm.");
    return;
  }

  let failed = 0;
  const nextUsed = { ...usedToday };
  for (const p of plan) {
    if (!p.pick) continue;
    let agentOk = true;
    for (const c of p.campaigns) {
      const full = await client.getCampaign(c.campaignId, c.groupId);
      full.callerId = p.pick;
      full.callerIdE164 = toE164(p.pick);
      await client.updateCampaign(c.campaignId, full, c.groupId);
      const verify = await client.getCampaign(c.campaignId, c.groupId);
      const ok = digits(verify.callerId) === p.pick;
      if (!ok) {
        failed += 1;
        agentOk = false;
      }
      console.log(`  ${ok ? "OK " : "FAILED-VERIFY"} [${c.groupId}] ${c.campaignId}: -> ${verify.callerId}`);
    }
    // record the replaced current(s) + the new pick so none repeat until tomorrow
    if (agentOk) {
      nextUsed[p.agent.extensionId] = [
        ...new Set([...(nextUsed[p.agent.extensionId] || []), ...p.currents, p.pick]),
      ];
    }
  }
  saveUsedToday(dateKey, nextUsed);
  console.log(`state: today's used numbers recorded -> ${USED_TODAY_PATH}`);
  if (failed) process.exitCode = 1;
}

async function main() {
  if (!["list", "shift", "rotate", "rotate-daily", "assign-pools"].includes(cmd)) {
    console.error("Usage: node scripts/rcx-shift-caller-ids.js <list | shift --to <10d> (--campaigns a,b | --group <id>) | rotate [--group <id>] [--with-extensions] | rotate-daily [--group <id>] | assign-pools [--group <id>] [--allow-reassign]> [--arm]");
    process.exit(2);
  }

  if (cmd === "assign-pools") {
    await assignPoolsToExtensions();
    return;
  }

  const client = createRingcxVoiceClient();
  if (cmd === "rotate") {
    await rotateOrdered(client);
    return;
  }
  if (cmd === "rotate-daily") {
    const rcClient = createRingCentralClient();
    await rotateDaily(client, rcClient);
    return;
  }

  if (cmd === "list") {
    const rows = await listAll(client);
    const byAni = new Map();
    console.log("DIAL GROUP -> CAMPAIGN -> CALLER ID (the burn map)");
    for (const r of rows) {
      console.log(`  [${r.groupId}] ${r.groupName.padEnd(18)} ${r.campaignId} ${r.campaignName.padEnd(24)} ${r.active ? "ACTIVE " : "inactive"} callerId=${r.callerId || "(none)"}`);
      if (r.callerId && r.active) byAni.set(r.callerId, (byAni.get(r.callerId) || 0) + 1);
    }
    console.log("\nACTIVE-CAMPAIGN ANI CONCENTRATION (shared numbers = shared blast radius):");
    for (const [ani, n] of [...byAni.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${ani}  presented by ${n} active campaign(s)`);
    }
    return;
  }

  // shift
  const to = digits(readFlag("--to"));
  if (to.length !== 10) {
    console.error("shift needs --to <10-digit tenant-owned DID>");
    process.exit(2);
  }
  const explicit = String(readFlag("--campaigns", "")).split(",").map((s) => s.trim()).filter(Boolean);
  const groupFilter = readFlag("--group");
  if (!explicit.length && !groupFilter) {
    console.error("shift needs --campaigns a,b,c or --group <dialGroupId>");
    process.exit(2);
  }
  const rows = await listAll(client);
  const targets = rows.filter((r) =>
    explicit.length ? explicit.includes(r.campaignId) : (String(r.groupId) === String(groupFilter) && r.active));
  if (!targets.length) {
    console.error("no matching campaigns");
    process.exit(1);
  }

  console.log(`SHIFT ${ARM ? "(ARMED)" : "(dry-run)"} -> callerId ${to} / ${toE164(to)}`);
  for (const t of targets) {
    console.log(`  [${t.groupId}] ${t.campaignId} ${t.campaignName}: ${t.callerId || "(none)"} -> ${to}`);
  }
  if (!ARM) {
    console.log("dry-run: nothing written. Re-run with --arm.");
    return;
  }

  for (const t of targets) {
    // full-object GET -> mutate ONLY the two caller-id fields -> PUT (the proven pattern)
    const full = await client.getCampaign(t.campaignId, t.groupId);
    const before = full.callerId || null;
    full.callerId = to;
    full.callerIdE164 = toE164(to);
    await client.updateCampaign(t.campaignId, full, t.groupId);
    const verify = await client.getCampaign(t.campaignId, t.groupId);
    const ok = String(verify.callerId) === to;
    console.log(`  ${ok ? "OK " : "FAILED-VERIFY"} [${t.groupId}] ${t.campaignId}: ${before} -> ${verify.callerId}`);
    if (!ok) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`caller-id shifter failed: ${err.message}`);
  process.exit(1);
});
