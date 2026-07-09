"use strict";

// PILOT QUEUE TOOL (Sean's one-agent pilot, 2026-07-08). Builds and feeds the
// ISOLATED "pilot" queue family — the batch the floor can never touch:
//
//   * floor claim queries enumerate only the four floor families -> pilot rows are
//     invisible to the cadence assigner / refills / morning builder on BOTH boxes;
//   * a bulk session reserves the pilot family ONLY when this box's .env sets
//     CX_BULK_RESERVE_PILOT_FAMILY=pilot (cxReserveModeService pilot mode);
//   * rows are route-stamped to the pilot agent's own campaign/dial group, so the
//     reservation route-lock keeps every other bulk session out too.
//
// Subcommands (DRY-RUN by default — nothing writes without --arm):
//
//   build    select ~N safe-pool leads (active, un-queued, cold, not DNC) and mint
//            pilot rows.   --count 300 --domain WYNN --cooldown-days 30
//   build-mix select a sequestered pilot refill pool by source family/color, then
//            interleave ranks so refills approximate the target mix.
//            --count 300 --mix 60/30/5/5  (green/blue/yellow/red)
//   refresh  THE NEW-STUFF TEE: move up to N brand-new, still-unassigned fresh-day1
//            first-contact rows into the pilot family (the rest of intake keeps
//            flowing to the floor untouched).   --max 5 --since-minutes 120
//   status   count pilot rows by state (read-only).
//   noshow-release  release a no-show pilot agent's undialed rows to an active
//            receiver. The receiver route is re-stamped from --to because bulk
//            reservation route-locks require exact account/campaign/dial-group.
//   cleanup  cancel this batch's UNSERVED pilot rows (ready/claimed, never placed).
//   undo     restore refreshed (moved) rows back to fresh-day1.
//
// Every write stamps metadata.pilotBatch=<tag> so cleanup/undo touch ONLY what this
// tool created/moved. Default agent: slucas@ (route 50810001 / campaign 2344 / DG 1011
// read from env like the runtime does). PII: phones print last-4 only.
//
//   node scripts/cx-pilot-queue.js build --count 300            # dry-run preview
//   node scripts/cx-pilot-queue.js build --count 300 --arm      # write
//   node scripts/cx-pilot-queue.js refresh --max 5 --arm        # tee new leads
//   node scripts/cx-pilot-queue.js cleanup --tag pilot-slucas-20260708 --arm

const path = require("path");

const mongoose = require("mongoose");
const { getSharedConfig } = require("../packages/shared-config/src");
const { CxBulkLoadSession, CxDialQueue, LeadCadence } = require("../packages/shared-models/src");
const { deriveQueueFamilyFromLeadCreatedAt } = require("../packages/shared-services/src/cxQueuePolicyService");

const PILOT_FAMILY = "pilot";
const ACTIVE_STATES = ["queued", "ready", "claimed", "serving", "paused"];
const RELEASE_STATES = ["ready", "claimed"];
const NO_SHOW_SESSION_STATUSES = ["running", "killed"];
const PILOT_TIME_ZONE = "America/Los_Angeles";
const PILOT_MIX_FAMILIES = Object.freeze(["fresh-day1", "fresh-day2to10", "fresh-day16to30", "aged"]);
const PILOT_MIX_COLORS = Object.freeze({
  green: "fresh-day1",
  blue: "fresh-day2to10",
  yellow: "fresh-day16to30",
  red: "aged",
});
const PILOT_MIX_LABELS = Object.freeze({
  "fresh-day1": "green",
  "fresh-day2to10": "blue",
  "fresh-day16to30": "yellow",
  aged: "red",
});
// mirror of cxWorkspaceService.isCxBlockedLeadCadence (module-local there)
const NON_DIALABLE_STAGE_PATTERN = /\b(dnc|do not call|post\s*date|post-date|sold|deal|bad inactive|inactive)\b/i;

const argv = process.argv.slice(2);
const cmd = argv[0];
function readFlag(name, fallback = null) {
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1 && !argv[idx + 1].startsWith("--")) return argv[idx + 1];
  return fallback;
}
const ARM = argv.includes("--arm");
const agentEmail = String(readFlag("--agent", "slucas@taxadvocategroup.com")).toLowerCase();
const domain = String(readFlag("--domain", "WYNN")).toUpperCase();

function loadDotenv() {
  require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function agentRouteFromEnv(email) {
  const normalized = normalizeEmail(email);
  const token = normalized.toUpperCase().replace(/@/g, "_AT_").replace(/[^A-Z0-9]/g, "_");
  const campaignId = process.env[`RINGCX_AGENT_ROUTE_${token}_CAMPAIGN_ID`];
  const dialGroupId = process.env[`RINGCX_AGENT_ROUTE_${token}_DIAL_GROUP_ID`];
  const accountId = process.env.RINGCX_ACCOUNT_ID || "50810001";
  if (!campaignId || !dialGroupId) {
    throw new Error(`no RINGCX_AGENT_ROUTE_* campaign/dial-group entries for ${normalized}`);
  }
  return { accountId: String(accountId), campaignId: String(campaignId), dialGroupId: String(dialGroupId) };
}

function mask(phone) {
  const s = String(phone || "");
  return s.length > 4 ? `***${s.slice(-4)}` : s || "-";
}
function dateKey(d = new Date()) {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}
const defaultTag = `pilot-${agentEmail.split("@")[0]}-${dateKey()}`;
const tag = readFlag("--tag", defaultTag);

function blockedCadence(doc) {
  if (!doc.active) return true;
  const stage = String(doc.currentStage || "").trim();
  if (stage && NON_DIALABLE_STAGE_PATTERN.test(stage)) return true;
  const cxDnc = doc.cadenceState?.channelDnc?.cx;
  return Boolean(cxDnc?.blocked || doc.dncCheckpoints?.hit);
}

function bumpCounter(counter, key = "unknown") {
  const clean = String(key || "unknown").trim() || "unknown";
  counter[clean] = (counter[clean] || 0) + 1;
}

async function resolvePilotBuildRuntimeEligibility(queryDomain, caseId, now = new Date()) {
  const { resolveCaseContactEligibility } = require("../packages/shared-services/src/contactEligibilityService");
  const eligibility = await resolveCaseContactEligibility(queryDomain, caseId, {
    now,
    enforceStop: false,
    sourceService: "cx-pilot-queue-build",
  });
  return eligibility && eligibility.ok
    ? { ok: true }
    : {
        ok: false,
        reason: eligibility?.reason || "contact-eligibility-failed",
        detail: eligibility?.detail || null,
      };
}

async function cancelNoShowPublishedRows(rows = [], options = {}) {
  const published = rows.filter((row) => (
    row?.metadata?.rcxVisibilityExternId
    || row?.metadata?.lastRingcxPublishedExternId
  ));
  const summary = { checked: rows.length, published: published.length, cancelled: 0, skipped: 0, failed: 0 };
  if (!published.length) return summary;
  if (!options.arm) {
    summary.skipped = published.length;
    return summary;
  }

  const cancelFn = options.cancelFn || require("../packages/shared-services/src/ringcxLeadServingService").cancelPublishedQueueItemInRingcx;
  for (const row of published) {
    const result = await cancelFn(row, {
      reason: options.reason || "noshow-release",
    });
    const event = {
      queueItemId: String(row._id),
      caseId: row.caseId,
      campaignId: result.campaignId || row.metadata?.rcxVisibilityCampaignId || null,
      externId: result.externId || row.metadata?.rcxVisibilityExternId || null,
      ok: result.ok !== false,
      cancelled: result.cancelled === true,
      skipped: result.skipped === true,
      reason: result.reason || result.error || null,
    };
    console.log(`cx.alpha.noshow.rcx_cancelled ${JSON.stringify(event)}`);
    if (result.ok === false) summary.failed += 1;
    else if (result.cancelled) summary.cancelled += 1;
    else summary.skipped += 1;
  }
  return summary;
}

function normalizePilotMixFamily(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (PILOT_MIX_COLORS[raw]) return PILOT_MIX_COLORS[raw];
  if (PILOT_MIX_FAMILIES.includes(raw)) return raw;
  return null;
}

function parsePilotMixSpec(value = "60/30/5/5") {
  const raw = String(value || "60/30/5/5").trim();
  const named = {};
  if (raw.includes("=") || raw.includes(":")) {
    for (const part of raw.split(/[,/ ]+/).filter(Boolean)) {
      const match = /^([^=:]+)[=:](\d+(?:\.\d+)?)$/.exec(part);
      if (!match) throw new Error(`invalid --mix part "${part}"`);
      const family = normalizePilotMixFamily(match[1]);
      if (!family) throw new Error(`unknown --mix family/color "${match[1]}"`);
      named[family] = Number(match[2]);
    }
    return PILOT_MIX_FAMILIES.map((family) => Math.max(Number(named[family] || 0), 0));
  }
  const values = raw.split(/[,/ ]+/).filter(Boolean).map(Number);
  if (values.length !== 4 || values.some((n) => !Number.isFinite(n) || n < 0)) {
    throw new Error("--mix must be four non-negative numbers for green/blue/yellow/red, e.g. 60/30/5/5");
  }
  return values;
}

function computePilotMixTargets(totalCount, mixSpec = "60/30/5/5") {
  const count = Math.max(Number(totalCount) || 0, 0);
  const weights = parsePilotMixSpec(mixSpec);
  const totalWeight = weights.reduce((sum, n) => sum + n, 0);
  if (!count || totalWeight <= 0) return Object.fromEntries(PILOT_MIX_FAMILIES.map((family) => [family, 0]));
  const raw = weights.map((weight) => (count * weight) / totalWeight);
  const floors = raw.map(Math.floor);
  let remaining = count - floors.reduce((sum, n) => sum + n, 0);
  const order = raw
    .map((value, index) => ({ index, fraction: value - floors[index] }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let i = 0; i < order.length && remaining > 0; i += 1) {
    floors[order[i].index] += 1;
    remaining -= 1;
  }
  return Object.fromEntries(PILOT_MIX_FAMILIES.map((family, index) => [family, floors[index]]));
}

function buildPilotInterleavedFamilies(targets = {}) {
  const remaining = Object.fromEntries(PILOT_MIX_FAMILIES.map((family) => [family, Math.max(Number(targets[family]) || 0, 0)]));
  const total = Object.values(remaining).reduce((sum, n) => sum + n, 0);
  const placed = Object.fromEntries(PILOT_MIX_FAMILIES.map((family) => [family, 0]));
  const order = [];
  for (let slot = 1; slot <= total; slot += 1) {
    let best = null;
    for (const family of PILOT_MIX_FAMILIES) {
      if (remaining[family] <= 0) continue;
      const target = Math.max(Number(targets[family]) || 0, 1);
      const desired = (slot * target) / total;
      const pressure = desired - placed[family];
      if (!best || pressure > best.pressure || (pressure === best.pressure && target > best.target)) {
        best = { family, pressure, target };
      }
    }
    if (!best) break;
    order.push(best.family);
    remaining[best.family] -= 1;
    placed[best.family] += 1;
  }
  return order;
}

function docPilotSourceFamily(doc, now = new Date()) {
  return deriveQueueFamilyFromLeadCreatedAt(doc.createdAt, now, {
    ageDays: doc.ageDays ?? doc.businessAgeDays ?? doc.payloadSnapshot?.ageDays,
    rolloverHour: doc.rolloverHour,
    graceEndHour: doc.graceEndHour,
    rolloverMinute: doc.rolloverMinute,
  });
}

function buildPilotMixUpsertFilter(queryDomain, caseId) {
  return {
    domain: String(queryDomain || "").toUpperCase(),
    caseId: Number(caseId),
    state: { $in: ACTIVE_STATES },
  };
}

function getZonedParts(date = new Date(), timeZone = PILOT_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(date));
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
    hour: Number(lookup.hour),
    minute: Number(lookup.minute),
    second: Number(lookup.second),
  };
}

function getZoneOffsetMs(date = new Date(), timeZone = PILOT_TIME_ZONE) {
  const parts = getZonedParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - new Date(date).getTime();
}

function makeZonedDate(year, month, day, hour = 0, minute = 0, second = 0, timeZone = PILOT_TIME_ZONE) {
  let utcMs = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  for (let i = 0; i < 3; i += 1) {
    utcMs = Date.UTC(year, month - 1, day, hour, minute, second, 0) - getZoneOffsetMs(new Date(utcMs), timeZone);
  }
  return new Date(utcMs);
}

function getPilotDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: PILOT_TIME_ZONE }).format(new Date(date));
}

function parseNoShowSince(value = "06:00", now = new Date()) {
  const raw = String(value || "06:00").trim();
  const absolute = new Date(raw);
  if (raw.includes("-") && !Number.isNaN(absolute.getTime())) return absolute;
  const match = raw.match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!match) throw new Error(`invalid --since value "${raw}" (use HH:mm or an ISO timestamp)`);
  const hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`invalid --since clock "${raw}"`);
  }
  const parts = getZonedParts(now);
  return makeZonedDate(parts.year, parts.month, parts.day, hour, minute, 0);
}

function buildNoShowSessionQuery(email, sinceAt) {
  return {
    agentEmail: normalizeEmail(email),
    status: { $in: NO_SHOW_SESSION_STATUSES },
    createdAt: { $gte: sinceAt },
  };
}

function buildNoShowDialedPilotRowsQuery(email, queryDomain, todayKey, sinceAt) {
  return {
    domain: String(queryDomain || "").toUpperCase(),
    queueFamily: PILOT_FAMILY,
    "metadata.pilotAgentEmail": normalizeEmail(email),
    placedCalls: { $gt: 0 },
    $or: [
      { dailyPlacedDateKey: todayKey },
      { "metadata.dailyPlacedDateKey": todayKey },
      { lastPlacedAt: { $gte: sinceAt } },
      { "metadata.lastQueueAttemptAt": { $gte: sinceAt } },
    ],
  };
}

function buildNoShowReleaseFilter(email, queryDomain) {
  return {
    domain: String(queryDomain || "").toUpperCase(),
    queueFamily: PILOT_FAMILY,
    "metadata.pilotAgentEmail": normalizeEmail(email),
    state: { $in: RELEASE_STATES },
    placedCalls: 0,
  };
}

function buildNoShowReleasePatch({ fromAgent, toAgent, route, now = new Date() }) {
  const source = normalizeEmail(fromAgent);
  const receiver = normalizeEmail(toAgent);
  const at = now.toISOString();
  return {
    $set: {
      state: "ready",
      priorityScore: 100,
      releaseAt: now,
      claimUntil: null,
      lastClaimedAt: null,
      rcxAccountId: String(route.accountId),
      rcxCampaignId: String(route.campaignId),
      rcxDialGroupId: String(route.dialGroupId),
      "assignment.extensionId": null,
      "assignment.agentName": null,
      "assignment.assignedAt": null,
      "assignment.queueFamilySnapshot": null,
      "metadata.pilotAgentEmail": receiver,
      "metadata.noShowRelease": {
        fromAgent: source,
        toAgent: receiver,
        at,
        releasedBy: "noshow-release",
      },
    },
    $unset: {
      "metadata.reservationSessionId": "",
      "metadata.bulkLoadSessionId": "",
      "metadata.reservationRail": "",
      "metadata.acceptedBuffer": "",
      "metadata.rcxVisibilityStatus": "",
      "metadata.rcxVisibilityReason": "",
      "metadata.rcxVisibilitySyncedAt": "",
      "metadata.rcxVisibilityCampaignId": "",
      "metadata.rcxVisibilityDialGroupId": "",
      "metadata.rcxVisibilityAccountId": "",
      "metadata.rcxVisibilityAssignedExtensionId": "",
      "metadata.rcxVisibilityAgentUsername": "",
      "metadata.rcxVisibilityAgentId": "",
      "metadata.rcxVisibilityAgentGroupId": "",
      "metadata.rcxVisibilityExternId": "",
      "metadata.rcxVisibilityLoadSummary": "",
      "metadata.rcxVisibilityLastError": "",
      "metadata.rcxVisibilityReservation": "",
      "metadata.lastRingcxPublishedAt": "",
      "metadata.lastRingcxPublishedCampaignId": "",
      "metadata.lastRingcxPublishedDialGroupId": "",
      "metadata.lastRingcxPublishedAccountId": "",
      "metadata.lastRingcxPublishedExternId": "",
      "metadata.lastRingcxPublishedRoute": "",
    },
  };
}

function shouldReleaseNoShow({ sessionCount = 0, dialedCount = 0 }) {
  return Number(sessionCount || 0) === 0 && Number(dialedCount || 0) === 0;
}

function shouldWriteNoShowRelease({ arm = false, noShow = false, releaseCount = 0 }) {
  return Boolean(arm && noShow && Number(releaseCount || 0) > 0);
}

function toTime(value, fallback = 0) {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.getTime();
}

function noShowReleaseSortTuple(row = {}) {
  return [
    Number(row.queueFamilyRank ?? 0) || 0,
    Number(row.dailyPlacedCalls ?? 0) || 0,
    Number(row.progressiveStageIndex ?? 99) || 99,
    toTime(row.lastPlacedAt, 0),
    -(Number(row.priorityScore ?? 100) || 0),
    toTime(row.releaseAt, 0),
    toTime(row.createdAt, 0),
  ];
}

function compareNoShowSortTuples(left, right) {
  const a = noShowReleaseSortTuple(left);
  const b = noShowReleaseSortTuple(right);
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

// ---- build: safe pool -> pilot rows ----
async function build(route) {
  const count = Math.max(Number(readFlag("--count", 300)) || 300, 1);
  const cooldownDays = Math.max(Number(readFlag("--cooldown-days", 30)) || 30, 1);
  const cutoff = new Date(Date.now() - cooldownDays * 24 * 60 * 60 * 1000);

  console.log(`BUILD ${ARM ? "(ARMED)" : "(dry-run)"} agent=${agentEmail} domain=${domain} tag=${tag}`);
  console.log(`  pool: active leads, no cx dial since ${cutoff.toISOString().slice(0, 10)}, no active queue row, not DNC/staged-out`);

  // cases that already have ANY active queue row are off-limits (one-active-row law:
  // a second row per case invites the findActiveQueueItem cross-wiring fallback)
  const busyCaseIds = await CxDialQueue.distinct("caseId", { domain, state: { $in: ACTIVE_STATES } });
  const busy = new Set(busyCaseIds.map(Number));
  console.log(`  excluded up front: ${busy.size} case(s) with an active queue row`);

  const cursor = LeadCadence.find({
    domain,
    active: true,
    $or: [
      { "counterCadence.lastCxDialedAt": null },
      { "counterCadence.lastCxDialedAt": { $lte: cutoff } },
    ],
    "cadenceState.channelDnc.cx.blocked": { $ne: true },
    "dncCheckpoints.hit": { $ne: true },
  })
    .sort({ createdAt: -1 })
    .limit(count * 6) // headroom for per-doc filters
    .lean()
    .cursor();

  const picks = [];
  const seenCases = new Set();
  const runtimeSkipCounts = {};
  for await (const doc of cursor) {
    if (picks.length >= count) break;
    const caseId = Number(doc.caseId);
    if (!Number.isFinite(caseId) || busy.has(caseId) || seenCases.has(caseId)) continue;
    if (blockedCadence(doc)) continue;
    const phone = String(doc.primaryPhone || doc.normalizedPhone || "").trim();
    const name = String(doc.name || [doc.firstName, doc.lastName].filter(Boolean).join(" ")).trim();
    if (!phone || !name) continue; // publisher drops phoneless/nameless candidates
    const eligibility = await resolvePilotBuildRuntimeEligibility(domain, caseId, new Date());
    if (!eligibility.ok) {
      bumpCounter(runtimeSkipCounts, eligibility.reason);
      continue;
    }
    seenCases.add(caseId);
    picks.push({ caseId, phone, name, leadCadenceId: String(doc._id) });
  }

  console.log(`  selected ${picks.length}/${count}`);
  const runtimeSkips = Object.entries(runtimeSkipCounts);
  if (runtimeSkips.length) {
    console.log(`  runtime eligibility skipped: ${runtimeSkips.map(([reason, n]) => `${reason}=${n}`).join(" ")}`);
  }
  for (const p of picks.slice(0, 8)) console.log(`    ${p.caseId} ${p.name} ${mask(p.phone)}`);
  if (picks.length > 8) console.log(`    ... +${picks.length - 8} more`);
  if (!ARM) return console.log("  dry-run: nothing written. Re-run with --arm.");

  const now = new Date();
  const ops = picks.map((p, i) => ({
    updateOne: {
      filter: { domain, caseId: p.caseId, "metadata.actionKey": `${tag}-${p.caseId}`, state: { $in: ACTIVE_STATES } },
      update: {
        $setOnInsert: {
          domain,
          caseId: p.caseId,
          leadCadenceId: p.leadCadenceId,
          phone: p.phone,
          name: p.name,
          state: "ready",
          queueFamily: PILOT_FAMILY,
          queueFamilyRank: i,
          priorityScore: 100,
          releaseAt: now,
          rcxAccountId: route.accountId,
          rcxCampaignId: route.campaignId,
          rcxDialGroupId: route.dialGroupId,
          metadata: {
            actionKey: `${tag}-${p.caseId}`,
            pilotBatch: tag,
            pilotAgentEmail: agentEmail,
            requestedBy: "pilot-queue-build",
          },
        },
      },
      upsert: true,
    },
  }));
  const res = await CxDialQueue.bulkWrite(ops, { ordered: false });
  console.log(`  WROTE ${res.upsertedCount} pilot row(s) (skipped ${picks.length - res.upsertedCount} pre-existing).`);
  console.log(`  cleanup later: node scripts/cx-pilot-queue.js cleanup --tag ${tag} --arm`);
}

// ---- build-mix: safe pool -> pilot rows, with a source-family/color composition ----
async function buildMix(route) {
  const count = Math.max(Number(readFlag("--count", 300)) || 300, 1);
  const mixSpec = readFlag("--mix", "60/30/5/5");
  const targets = computePilotMixTargets(count, mixSpec);
  const cooldownDays = Math.max(Number(readFlag("--cooldown-days", 30)) || 30, 1);
  const maxScan = Math.max(Number(readFlag("--max-scan", count * 80)) || count * 80, count);
  const cutoff = new Date(Date.now() - cooldownDays * 24 * 60 * 60 * 1000);
  const now = new Date();

  console.log(`BUILD-MIX ${ARM ? "(ARMED)" : "(dry-run)"} agent=${agentEmail} domain=${domain} tag=${tag}`);
  console.log(`  target: ${count} pilot rows, mix=${mixSpec} -> ${PILOT_MIX_FAMILIES.map((f) => `${PILOT_MIX_LABELS[f]}=${targets[f]}`).join(" ")}`);
  console.log(`  pool: active leads, no cx dial since ${cutoff.toISOString().slice(0, 10)}, no active queue row, not DNC/staged-out`);
  console.log("  queue write shape: queueFamily=pilot; source color/family stored in metadata; rank interleaves the mix");

  const busyCaseIds = await CxDialQueue.distinct("caseId", { domain, state: { $in: ACTIVE_STATES } });
  const busy = new Set(busyCaseIds.map(Number));
  console.log(`  excluded up front: ${busy.size} case(s) with an active queue row`);

  const picksByFamily = Object.fromEntries(PILOT_MIX_FAMILIES.map((family) => [family, []]));
  const seenCases = new Set();
  const runtimeSkipCounts = {};
  const needMore = () => PILOT_MIX_FAMILIES.some((family) => picksByFamily[family].length < targets[family]);

  const cursor = LeadCadence.find({
    domain,
    active: true,
    $or: [
      { "counterCadence.lastCxDialedAt": null },
      { "counterCadence.lastCxDialedAt": { $lte: cutoff } },
    ],
    "cadenceState.channelDnc.cx.blocked": { $ne: true },
    "dncCheckpoints.hit": { $ne: true },
  })
    .sort({ createdAt: -1 })
    .limit(maxScan)
    .lean()
    .cursor();

  let scanned = 0;
  for await (const doc of cursor) {
    scanned += 1;
    if (!needMore()) break;
    const sourceFamily = docPilotSourceFamily(doc, now);
    if (!PILOT_MIX_FAMILIES.includes(sourceFamily)) continue;
    if (picksByFamily[sourceFamily].length >= targets[sourceFamily]) continue;
    const caseId = Number(doc.caseId);
    if (!Number.isFinite(caseId) || busy.has(caseId) || seenCases.has(caseId)) continue;
    if (blockedCadence(doc)) continue;
    const phone = String(doc.primaryPhone || doc.normalizedPhone || "").trim();
    const name = String(doc.name || [doc.firstName, doc.lastName].filter(Boolean).join(" ")).trim();
    if (!phone || !name) continue;
    const eligibility = await resolvePilotBuildRuntimeEligibility(domain, caseId, now);
    if (!eligibility.ok) {
      bumpCounter(runtimeSkipCounts, eligibility.reason);
      continue;
    }
    seenCases.add(caseId);
    picksByFamily[sourceFamily].push({
      caseId,
      phone,
      name,
      leadCadenceId: String(doc._id),
      sourceFamily,
      sourceColor: PILOT_MIX_LABELS[sourceFamily],
      createdAt: doc.createdAt || null,
    });
  }

  const actualTargets = Object.fromEntries(PILOT_MIX_FAMILIES.map((family) => [family, picksByFamily[family].length]));
  const order = buildPilotInterleavedFamilies(actualTargets);
  const available = Object.fromEntries(PILOT_MIX_FAMILIES.map((family) => [family, [...picksByFamily[family]]]));
  const rankedPicks = order.map((family) => available[family].shift()).filter(Boolean);

  console.log(`  scanned ${scanned}/${maxScan}; selected ${rankedPicks.length}/${count}`);
  const runtimeSkips = Object.entries(runtimeSkipCounts);
  if (runtimeSkips.length) {
    console.log(`  runtime eligibility skipped: ${runtimeSkips.map(([reason, n]) => `${reason}=${n}`).join(" ")}`);
  }
  for (const family of PILOT_MIX_FAMILIES) {
    const have = picksByFamily[family].length;
    const want = targets[family];
    const label = PILOT_MIX_LABELS[family];
    console.log(`    ${label.padEnd(6)} ${family.padEnd(16)} ${have}/${want}${have < want ? "  SHORT" : ""}`);
  }
  rankedPicks.slice(0, 12).forEach((p, i) => {
    console.log(`    rank ${String(i).padStart(3, "0")} ${p.sourceColor.padEnd(6)} case=${p.caseId} phone=${mask(p.phone)} created=${p.createdAt ? new Date(p.createdAt).toISOString().slice(0, 10) : "-"}`);
  });
  if (rankedPicks.length > 12) console.log(`    ... +${rankedPicks.length - 12} more`);
  if (!rankedPicks.length) return console.log("  no eligible leads found.");
  if (!ARM) return console.log("  dry-run: nothing written. Re-run with --arm.");

  const ops = rankedPicks.map((p, i) => ({
    updateOne: {
      filter: buildPilotMixUpsertFilter(domain, p.caseId),
      update: {
        $setOnInsert: {
          domain,
          caseId: p.caseId,
          leadCadenceId: p.leadCadenceId,
          phone: p.phone,
          name: p.name,
          state: "ready",
          queueFamily: PILOT_FAMILY,
          queueFamilyRank: i,
          priorityScore: 100,
          releaseAt: now,
          rcxAccountId: route.accountId,
          rcxCampaignId: route.campaignId,
          rcxDialGroupId: route.dialGroupId,
          metadata: {
            actionKey: `${tag}-${p.caseId}`,
            pilotBatch: tag,
            pilotAgentEmail: agentEmail,
            pilotSourceFamily: p.sourceFamily,
            pilotSourceColor: p.sourceColor,
            pilotMix: {
              spec: mixSpec,
              targetCount: count,
              targetCounts: targets,
              buildCommand: "build-mix",
            },
            requestedBy: "pilot-queue-build-mix",
          },
        },
      },
      upsert: true,
    },
  }));
  const res = await CxDialQueue.bulkWrite(ops, { ordered: false });
  console.log(`  WROTE ${res.upsertedCount} mixed pilot row(s) (skipped ${rankedPicks.length - res.upsertedCount} pre-existing).`);
  console.log(`  cleanup later: node scripts/cx-pilot-queue.js cleanup --tag ${tag} --arm`);
}

// ---- refresh: the new-stuff tee (move, never copy — one active row per case) ----
async function refresh(route) {
  const max = Math.max(Number(readFlag("--max", 5)) || 5, 1);
  const sinceMinutes = Math.max(Number(readFlag("--since-minutes", 120)) || 120, 1);
  const since = new Date(Date.now() - sinceMinutes * 60 * 1000);

  console.log(`REFRESH ${ARM ? "(ARMED)" : "(dry-run)"} tee up to ${max} new lead(s) minted since ${since.toISOString().slice(11, 16)}Z -> ${PILOT_FAMILY}`);
  const candidates = await CxDialQueue.find({
    domain,
    state: "ready",
    queueFamily: "fresh-day1",
    createdAt: { $gte: since },
    "assignment.extensionId": null, // untouched by the floor: nobody loses a lead
    "metadata.requestedBy": "intake-first-contact",
  })
    .sort({ createdAt: 1 })
    .limit(max)
    .lean();

  if (!candidates.length) return console.log("  no un-assigned fresh intake rows in the window — nothing to tee.");
  for (const c of candidates) console.log(`    ${c.caseId} ${c.name || "?"} ${mask(c.phone)} minted=${String(c.createdAt).slice(11, 19)}`);
  if (!ARM) return console.log("  dry-run: nothing moved. Re-run with --arm.");

  const res = await CxDialQueue.updateMany(
    { _id: { $in: candidates.map((c) => c._id) }, state: "ready", "assignment.extensionId": null },
    {
      $set: {
        queueFamily: PILOT_FAMILY,
        rcxAccountId: route.accountId,
        rcxCampaignId: route.campaignId,
        rcxDialGroupId: route.dialGroupId,
        "metadata.pilotBatch": tag,
        "metadata.pilotAgentEmail": agentEmail,
        "metadata.pilotTeeFromFamily": "fresh-day1",
      },
    },
  );
  console.log(`  MOVED ${res.modifiedCount} row(s) into the pilot family (undo: node scripts/cx-pilot-queue.js undo --tag ${tag} --arm).`);
}

// ---- drip-status / drip-cleanup: the Sean first-touch drip rows (fresh-day1 family,
// metadata.seanFirstTouchTest) live OUTSIDE the pilot family — account for them here ----
async function dripStatus() {
  const rows = await CxDialQueue.find({ domain, "metadata.seanFirstTouchTest": { $exists: true } })
    .sort({ createdAt: 1 })
    .lean();
  console.log(`DRIP ROWS (${domain}): ${rows.length}`);
  for (const r of rows) {
    const meta = r.metadata?.seanFirstTouchTest || {};
    console.log(`  ${r.caseId} ${r.name || "?"} ${mask(r.phone)} state=${r.state} placed=${r.placedCalls || 0} selected=${String(meta.selectedAt || "").slice(11, 19)} published=${meta.publishedAt ? "yes" : "no"} extern=${r.metadata?.rcxVisibilityExternId || "-"}`);
  }
}

async function dripCleanup() {
  // release UNDIALED drip rows back to the floor pool (they are real fresh leads the
  // floor should keep working). The RingCX copy in the First Touch campaign must be
  // cleared in console — this prints exactly what to clear.
  const filter = {
    domain,
    "metadata.seanFirstTouchTest": { $exists: true },
    state: "claimed",
    placedCalls: 0,
  };
  const rows = await CxDialQueue.find(filter).lean();
  console.log(`DRIP CLEANUP ${ARM ? "(ARMED)" : "(dry-run)"}: ${rows.length} undialed drip row(s) -> released to the floor pool`);
  for (const r of rows) {
    console.log(`  ${r.caseId} ${mask(r.phone)} -> clear RingCX copy: campaign ${r.metadata?.rcxVisibilityCampaignId || "?"} extern ${r.metadata?.rcxVisibilityExternId || "?"}`);
  }
  if (!ARM || !rows.length) return;
  const res = await CxDialQueue.updateMany(filter, {
    $set: {
      state: "ready",
      claimUntil: null,
      "assignment.extensionId": null,
      "assignment.agentName": null,
      "assignment.assignedAt": null,
      "metadata.seanFirstTouchTest.cleanedAt": new Date().toISOString(),
    },
  });
  console.log(`  released ${res.modifiedCount} (Mongo side). RingCX copies: clear the externs above in console.`);
}

// ---- noshow-release: hand an unused pilot pile to a receiver route ----
async function noshowRelease() {
  const all = argv.includes("--all");
  const sinceAt = parseNoShowSince(readFlag("--since", "06:00"));
  const todayKey = getPilotDateKey(new Date());
  const toAgent = normalizeEmail(readFlag("--to", ""));

  if (ARM && !toAgent) {
    throw new Error("noshow-release --arm requires --to <email> so released rows get an exact receiver route stamp");
  }

  const agents = all
    ? await CxDialQueue.distinct("metadata.pilotAgentEmail", {
        domain,
        queueFamily: PILOT_FAMILY,
        state: { $in: RELEASE_STATES },
        placedCalls: 0,
      })
    : [agentEmail];
  const sources = Array.from(new Set(agents.map(normalizeEmail).filter(Boolean))).sort();
  const route = toAgent ? agentRouteFromEnv(toAgent) : null;

  console.log(`NO-SHOW RELEASE ${ARM ? "(ARMED)" : "(dry-run)"} domain=${domain} since=${sinceAt.toISOString()} todayKey=${todayKey}`);
  if (toAgent) {
    console.log(`  receiver=${toAgent} route account ${route.accountId} / campaign ${route.campaignId} / dial group ${route.dialGroupId}`);
  } else {
    console.log("  receiver unresolved: add --to <email> before arming so route stamps are exact.");
  }
  if (!sources.length) {
    console.log("  no pilot agents with undialed ready/claimed rows found.");
    return;
  }

  for (const source of sources) {
    const sessionQuery = buildNoShowSessionQuery(source, sinceAt);
    const dialedQuery = buildNoShowDialedPilotRowsQuery(source, domain, todayKey, sinceAt);
    const releaseFilter = buildNoShowReleaseFilter(source, domain);
    const [sessionCount, dialedCount, releaseRows] = await Promise.all([
      CxBulkLoadSession.countDocuments(sessionQuery),
      CxDialQueue.countDocuments(dialedQuery),
      CxDialQueue.find(releaseFilter)
        .sort({
          queueFamilyRank: 1,
          dailyPlacedCalls: 1,
          progressiveStageIndex: 1,
          lastPlacedAt: 1,
          priorityScore: -1,
          releaseAt: 1,
          createdAt: 1,
        })
        .select({
          caseId: 1,
          name: 1,
          phone: 1,
          state: 1,
          placedCalls: 1,
          metadata: 1,
          queueFamilyRank: 1,
          priorityScore: 1,
          releaseAt: 1,
          createdAt: 1,
        })
        .lean(),
    ]);
    const noShow = shouldReleaseNoShow({ sessionCount, dialedCount });
    const releaseCount = releaseRows.length;
    const event = {
      agent: source,
      domain,
      sinceAt: sinceAt.toISOString(),
      todayKey,
      sessionCount,
      dialedCount,
      releaseCandidateCount: releaseCount,
      noShow,
    };
    console.log(`cx.alpha.noshow.checked ${JSON.stringify(event)}`);
    console.log(`  ${source}: sessions=${sessionCount} dialedToday=${dialedCount} releasable=${releaseCount} verdict=${noShow ? "NO-SHOW" : "hold"}`);

    if (!noShow || !releaseCount) continue;

    const published = releaseRows.filter((row) => (
      row.metadata?.rcxVisibilityExternId
      || row.metadata?.lastRingcxPublishedExternId
    ));
    for (const row of releaseRows.slice(0, 5)) {
      console.log(`    case=${row.caseId} phone=${mask(row.phone)} state=${row.state} rank=${row.queueFamilyRank} priority=${row.priorityScore}`);
    }
    if (releaseRows.length > 5) console.log(`    ... +${releaseRows.length - 5} more`);
    if (published.length) {
      console.log(`    RingCX cleanout needed first: ${published.length} row(s) carry old publish stamps.`);
    }
    if (!route) {
      console.log("    dry-run: no receiver route; no write can be made without --to.");
      continue;
    }
    if (!shouldWriteNoShowRelease({ arm: ARM, noShow, releaseCount })) {
      console.log("    dry-run: nothing written. Re-run with --to <email> --arm.");
      continue;
    }

    const now = new Date();
    const cancelSummary = await cancelNoShowPublishedRows(releaseRows, {
      arm: ARM,
      reason: "noshow-release",
    });
    console.log(`    RingCX cleanout summary: published=${cancelSummary.published} cancelled=${cancelSummary.cancelled} skipped=${cancelSummary.skipped} failed=${cancelSummary.failed}`);
    if (cancelSummary.failed > 0) {
      console.log("    ABORTED Mongo release because RingCX cleanout had failures.");
      continue;
    }
    const patch = buildNoShowReleasePatch({ fromAgent: source, toAgent, route, now });
    const res = await CxDialQueue.updateMany(
      { ...releaseFilter, _id: { $in: releaseRows.map((row) => row._id) }, placedCalls: 0 },
      patch,
    );
    const releasedEvent = {
      fromAgent: source,
      toAgent,
      domain,
      modifiedCount: res.modifiedCount,
      route: {
        accountId: route.accountId,
        campaignId: route.campaignId,
        dialGroupId: route.dialGroupId,
      },
      sampleCaseIds: releaseRows.slice(0, 5).map((row) => row.caseId),
    };
    console.log(`cx.alpha.noshow.released ${JSON.stringify(releasedEvent)}`);
    console.log(`    RELEASED ${res.modifiedCount}/${releaseCount} to ${toAgent}`);
  }
}

// ---- status / cleanup / undo ----
async function status() {
  const match = { domain, queueFamily: PILOT_FAMILY };
  if (!argv.includes("--all")) {
    match["metadata.pilotAgentEmail"] = agentEmail;
  }
  const rows = await CxDialQueue.aggregate([
    { $match: match },
    {
      $group: {
        _id: {
          agent: "$metadata.pilotAgentEmail",
          state: "$state",
          batch: "$metadata.pilotBatch",
        },
        n: { $sum: 1 },
      },
    },
    { $sort: { "_id.agent": 1, "_id.batch": 1, "_id.state": 1 } },
  ]);
  console.log(`PILOT ROWS (${domain}${argv.includes("--all") ? ", all agents" : `, ${agentEmail}`})`);
  if (!rows.length) console.log("  none");
  for (const r of rows) {
    const prefix = argv.includes("--all") ? `${r._id.agent || "(unassigned-agent)"}  ` : "";
    console.log(`  ${prefix}${r._id.batch || "(untagged)"}  ${r._id.state}: ${r.n}`);
  }
}

async function cleanup() {
  const filter = {
    domain,
    queueFamily: PILOT_FAMILY,
    "metadata.pilotBatch": tag,
    state: { $in: ["ready", "claimed"] },
    placedCalls: 0, // never cancel a row that already dialed — its ledger is real
  };
  const n = await CxDialQueue.countDocuments(filter);
  console.log(`CLEANUP ${ARM ? "(ARMED)" : "(dry-run)"} tag=${tag}: ${n} unserved pilot row(s) -> cancelled`);
  if (!ARM || !n) return;
  const res = await CxDialQueue.updateMany(filter, {
    $set: { state: "cancelled", cancelledAt: new Date(), "metadata.pilotCleanup": new Date().toISOString() },
  });
  console.log(`  cancelled ${res.modifiedCount}`);
}

async function undo() {
  const filter = {
    domain,
    queueFamily: PILOT_FAMILY,
    "metadata.pilotBatch": tag,
    "metadata.pilotTeeFromFamily": "fresh-day1",
    state: "ready",
    placedCalls: 0,
  };
  const n = await CxDialQueue.countDocuments(filter);
  console.log(`UNDO ${ARM ? "(ARMED)" : "(dry-run)"} tag=${tag}: ${n} teed row(s) -> back to fresh-day1`);
  if (!ARM || !n) return;
  const res = await CxDialQueue.updateMany(filter, {
    $set: { queueFamily: "fresh-day1" },
    $unset: { "metadata.pilotBatch": "", "metadata.pilotAgentEmail": "", "metadata.pilotTeeFromFamily": "" },
  });
  console.log(`  restored ${res.modifiedCount}`);
}

async function main() {
  if (!["build", "build-mix", "refresh", "status", "cleanup", "undo", "drip-status", "drip-cleanup", "noshow-release"].includes(cmd)) {
    console.error("Usage: node scripts/cx-pilot-queue.js <build|build-mix|refresh|status|cleanup|undo|drip-status|drip-cleanup|noshow-release> [--arm] [--agent e|--all] [--to e] [--domain D] [--count N] [--mix 60/30/5/5] [--max N] [--tag T] [--since HH:mm]");
    process.exit(2);
  }
  loadDotenv();
  const config = getSharedConfig();
  await mongoose.connect(config.mongoUri, { dbName: config.parallelDbName });
  const route = cmd === "noshow-release" ? null : agentRouteFromEnv(agentEmail);
  if (route) console.log(`route: account ${route.accountId} / campaign ${route.campaignId} / dial group ${route.dialGroupId}`);
  if (cmd === "build") await build(route);
  else if (cmd === "build-mix") await buildMix(route);
  else if (cmd === "refresh") await refresh(route);
  else if (cmd === "status") await status();
  else if (cmd === "cleanup") await cleanup();
  else if (cmd === "undo") await undo();
  else if (cmd === "drip-status") await dripStatus();
  else if (cmd === "drip-cleanup") await dripCleanup();
  else if (cmd === "noshow-release") await noshowRelease();
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`pilot queue tool failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  PILOT_FAMILY,
  RELEASE_STATES,
  NO_SHOW_SESSION_STATUSES,
  buildNoShowDialedPilotRowsQuery,
  buildPilotInterleavedFamilies,
  buildPilotMixUpsertFilter,
  buildNoShowReleaseFilter,
  buildNoShowReleasePatch,
  buildNoShowSessionQuery,
  cancelNoShowPublishedRows,
  computePilotMixTargets,
  docPilotSourceFamily,
  compareNoShowSortTuples,
  getPilotDateKey,
  normalizePilotMixFamily,
  noShowReleaseSortTuple,
  parsePilotMixSpec,
  parseNoShowSince,
  shouldReleaseNoShow,
  shouldWriteNoShowRelease,
};
