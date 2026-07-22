"use strict";

// Caller-ID rotation service — the REGISTERED-pool version (2026-07-09).
//
// Rotates each agent's presented caller ID through their registered pool (config/
// cx-caller-id-rotation-pools.json), across ALL of that agent's active campaigns, once
// per tick. Intended cadence: every ~2h during business hours. Stateless round-robin:
// next = pool[(indexOf(current)+1) % len]; a current number not in the pool starts at
// pool[0]. Reuses the proven per-campaign GET -> set callerId/callerIdE164 -> PUT ->
// read-back verify (see scripts/rcx-shift-caller-ids.js).
//
// Guardrails (keep this on the legitimate side of the FCC "snowshoeing" line — see
// docs/CX_CALLER_ID_REPUTATION_RUNBOOK_2026-07-09.md): pool is REGISTERED numbers only,
// business-hours gated, write-then-verify, fail-soft per agent. This module NEVER
// schedules itself and NEVER writes unless rotateOnce is called with dryRun:false — the
// worker owns enable + arm (both default off).

const path = require("path");
const fs = require("fs");

function digits(value) {
  return String(value || "").replace(/\D/g, "").replace(/^1(\d{10})$/, "$1");
}
function toE164(value) {
  const d = digits(value);
  return d.length === 10 ? `+1${d}` : d ? `+${String(value).replace(/\D/g, "")}` : "";
}

// PURE. Next pool number after `current` (stateless round-robin). Returns null for a
// pool with fewer than 2 valid 10-digit numbers. A `current` not in the pool -> pool[0].
function pickNextCallerId(pool = [], current = "") {
  const list = (Array.isArray(pool) ? pool : []).map(digits).filter((d) => d.length === 10);
  if (list.length < 2) return null;
  const idx = list.indexOf(digits(current));
  return list[(idx + 1) % list.length];
}

// PURE. Build the per-agent rotation plan.
// campaignRows: [{ groupId, campaignId, campaignName, active, callerId }]
// -> [{ dialGroupId, agentName, agentEmail, pool, campaigns, current, next, skip? }]
function buildRotationPlan({ pools = {}, agentOrder = [], campaignRows = [] } = {}) {
  const activeByGroup = new Map();
  for (const row of Array.isArray(campaignRows) ? campaignRows : []) {
    if (!row || row.active !== true) continue;
    const g = String(row.groupId);
    if (!activeByGroup.has(g)) activeByGroup.set(g, []);
    activeByGroup.get(g).push(row);
  }
  const plan = [];
  for (const agent of Array.isArray(agentOrder) ? agentOrder : []) {
    const groupId = String(agent.dialGroupId || "");
    const pool = (pools[groupId] || []).map(digits).filter((d) => d.length === 10);
    const campaigns = activeByGroup.get(groupId) || [];
    const base = { dialGroupId: groupId, agentName: agent.name || "", agentEmail: agent.email || "", pool, campaigns };
    if (!campaigns.length) { plan.push({ ...base, skip: "no-active-campaigns" }); continue; }
    if (pool.length < 2) { plan.push({ ...base, skip: `pool-too-small(${pool.length})` }); continue; }
    const presented = [...new Set(campaigns.map((c) => digits(c.callerId)).filter((d) => d.length === 10))];
    const current = presented.find((n) => pool.includes(n)) || presented[0] || "";
    const next = pickNextCallerId(pool, current);
    if (!next) { plan.push({ ...base, current, skip: "no-next" }); continue; }
    if (next === current) { plan.push({ ...base, current, next, skip: "already-on-next" }); continue; }
    plan.push({ ...base, current, next });
  }
  return plan;
}

// Business-hours guard (Pacific). Default Mon-Fri 08:00-18:00. Pure given `now`.
function withinBusinessHours(now = new Date(), { startHour = 8, endHour = 18, timeZone = "America/Los_Angeles" } = {}) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value;
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  const isWeekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(weekday);
  return isWeekday && Number.isFinite(hour) && hour >= startHour && hour < endHour;
}

const DEFAULT_CONFIG_PATH = path.resolve(__dirname, "..", "..", "..", "config", "cx-caller-id-rotation-pools.json");

function loadRotationConfig(configPath = DEFAULT_CONFIG_PATH) {
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const pools = {};
  for (const [key, value] of Object.entries(raw)) {
    if (String(key).startsWith("_")) continue;
    pools[String(key)] = (Array.isArray(value) ? value : []).map(digits).filter((d) => d.length === 10);
  }
  const agentOrder = (Array.isArray(raw._agentOrder) ? raw._agentOrder : [])
    .map((e) => ({
      order: Number(e.order || 0) || 0,
      name: String(e.name || "").trim(),
      email: String(e.email || "").trim().toLowerCase(),
      dialGroupId: String(e.dialGroupId || "").trim(),
      extensionId: String(e.extensionId || "").trim(),
    }))
    .filter((e) => e.dialGroupId)
    .sort((a, b) => a.order - b.order || a.dialGroupId.localeCompare(b.dialGroupId));
  return { pools, agentOrder };
}

// Boring owns only the agents it actively supplies. Keep the registered master
// pool editable in one file, then select the owned dial groups at the runtime edge.
function filterRotationConfig(config = {}, allowedDialGroupIds = []) {
  const allowed = new Set((Array.isArray(allowedDialGroupIds) ? allowedDialGroupIds : [])
    .map((value) => String(value || "").trim()).filter(Boolean));
  if (!allowed.size) return { pools: { ...(config.pools || {}) }, agentOrder: [...(config.agentOrder || [])] };
  return {
    pools: Object.fromEntries(Object.entries(config.pools || {}).filter(([groupId]) => allowed.has(String(groupId)))),
    agentOrder: (config.agentOrder || []).filter((agent) => allowed.has(String(agent.dialGroupId))),
  };
}

// I/O. Dial group -> active campaigns -> callerId (full GET when the slim list omits it).
async function listActiveCampaignRows(client, allowedDialGroupIds = []) {
  const allowed = new Set((Array.isArray(allowedDialGroupIds) ? allowedDialGroupIds : [])
    .map((value) => String(value || "").trim()).filter(Boolean));
  const groups = await client.listDialGroups();
  const rows = [];
  for (const group of Array.isArray(groups) ? groups : []) {
    const groupId = String(group.dialGroupId || group.id);
    if (allowed.size && !allowed.has(groupId)) continue;
    const campaigns = await client.listCampaigns(groupId).catch(() => []);
    for (const c of Array.isArray(campaigns) ? campaigns : []) {
      const campaignId = String(c.campaignId || c.id);
      const active = c.isActive === 1 || c.isActive === true || c.active === true;
      let callerId = c.callerId || null;
      if (!callerId && active) {
        callerId = (await client.getCampaign(campaignId, groupId).catch(() => null))?.callerId || null;
      }
      rows.push({
        groupId,
        groupName: group.dialGroupName || group.name || "",
        campaignId,
        campaignName: c.campaignName || c.name || "",
        active,
        callerId,
      });
    }
  }
  return rows;
}

// The service. `client` = a RingCX voice client (createRingcxVoiceClient()). rotateOnce
// defaults to dryRun: it computes + logs the plan and writes NOTHING.
function createCxCallerIdRotationService({ client, config = null, logger = console, now = () => new Date() } = {}) {
  if (!client || typeof client.getCampaign !== "function" || typeof client.updateCampaign !== "function"
    || typeof client.listDialGroups !== "function" || typeof client.listCampaigns !== "function") {
    throw new Error("createCxCallerIdRotationService requires a RingCX client with listDialGroups/listCampaigns/getCampaign/updateCampaign");
  }
  const log = (level, event, data) => { if (logger && typeof logger[level] === "function") logger[level](event, data); };

  async function rotateOnce({ dryRun = true, enforceBusinessHours = true } = {}) {
    if (enforceBusinessHours && !withinBusinessHours(now())) {
      return { ok: true, skipped: true, reason: "outside-business-hours", moves: [] };
    }
    const cfg = config || loadRotationConfig();
    const campaignRows = await listActiveCampaignRows(client, Object.keys(cfg.pools || {}));
    const plan = buildRotationPlan({ pools: cfg.pools, agentOrder: cfg.agentOrder, campaignRows });
    for (const p of plan) {
      if (p.skip) log("info", "cx.caller_id_rotation.skip", { dialGroupId: p.dialGroupId, agent: p.agentName, reason: p.skip });
    }
    const moves = plan.filter((p) => !p.skip && p.next && p.next !== p.current);

    if (dryRun) {
      for (const m of moves) {
        log("info", "cx.caller_id_rotation.plan", { dialGroupId: m.dialGroupId, agent: m.agentName, current: m.current || null, next: m.next, campaigns: m.campaigns.length });
      }
      return {
        ok: true,
        dryRun: true,
        moves: moves.map((m) => ({ dialGroupId: m.dialGroupId, agent: m.agentName, current: m.current || null, next: m.next, campaignCount: m.campaigns.length })),
      };
    }

    let failed = 0;
    const results = [];
    for (const m of moves) {
      let agentOk = true;
      for (const c of m.campaigns) {
        try {
          const full = await client.getCampaign(c.campaignId, c.groupId);
          full.callerId = m.next;
          full.callerIdE164 = toE164(m.next);
          await client.updateCampaign(c.campaignId, full, c.groupId);
          const verify = await client.getCampaign(c.campaignId, c.groupId);
          const ok = digits(verify?.callerId) === m.next;
          if (!ok) { agentOk = false; failed += 1; }
          log("info", "cx.caller_id_rotation.write", { dialGroupId: m.dialGroupId, agent: m.agentName, campaignId: c.campaignId, to: m.next, ok });
        } catch (error) {
          agentOk = false; failed += 1;
          log("error", "cx.caller_id_rotation.write_failed", { dialGroupId: m.dialGroupId, campaignId: c.campaignId, error: error?.message || String(error) });
        }
      }
      results.push({ dialGroupId: m.dialGroupId, agent: m.agentName, next: m.next, ok: agentOk, campaignCount: m.campaigns.length });
    }
    return { ok: failed === 0, dryRun: false, failed, moves: results };
  }

  return { rotateOnce };
}

module.exports = {
  createCxCallerIdRotationService,
  buildRotationPlan,
  pickNextCallerId,
  withinBusinessHours,
  loadRotationConfig,
  filterRotationConfig,
  listActiveCampaignRows,
};
