"use strict";

const crypto = require("crypto");

const { CxDialQueue } = require("../../shared-models/src");
const { createRingcxVoiceClient } = require("../../shared-integrations/src");
const {
  caseProfileRepository,
  cxBulkLoadSessionRepository,
  cxDialQueueRepository,
  cxTerminalOutboxRepository,
  queueItemRepository,
  userAccountRepository,
} = require("../../shared-repositories/src");
const { createCxBoringDialer, RELEASE_GRACE_MS } = require("./cxBoringDialerService");
const { loadActiveCallsSnapshot } = require("./cxBulkLoadActiveCallWatcher");
const {
  buildExternSessionToken,
  isQueueRowContactable,
} = require("./cxBulkLoadLeadSourceService");
const { publishBatchToRingcx } = require("./cxBulkLoadRingcxPublisher");
const {
  createCxBulkLoadOutcomeAdapter,
  makeOutcomeIdemKey,
} = require("./cxBulkLoadOutcomeAdapter");

const RUNTIME = "boring";
const FAMILIES = Object.freeze(["fresh-day1", "fresh-day2to10", "fresh-day16to30", "aged"]);
const TERMINAL_STATES = Object.freeze(["COMPLETE", "CANCELLED", "INTERCEPT"]);
const DAILY_BLOCKING_OUTCOMES = new Set(["answered", "dnc", "bad_number"]);
const CADENCE_OUTCOMES = new Set(["voicemail", "did_not_connect"]);
const CALL_DAY_TIME_ZONE = "America/Los_Angeles";
const RINGCX_LOW_WATER = 5;
const RINGCX_REFILL_BATCH = 30;

function str(value) {
  return String(value == null ? "" : value).trim();
}

function normalizeEmail(value) {
  return str(value).toLowerCase();
}

function normalizeDomain(value) {
  return str(value).toUpperCase() || "TAG";
}

function normalizeId(value) {
  return str(value) || null;
}

function normalizePhone(value) {
  const digits = str(value).replace(/\D+/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.length === 10 ? digits : null;
}

function normalizeCaseId(value) {
  if (value == null || String(value).trim() === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function timeZoneOffsetMs(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const representedAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return representedAsUtc - Math.floor(date.getTime() / 1000) * 1000;
}

function pacificDayStart(now = new Date()) {
  const instant = now instanceof Date ? now : new Date(now);
  const day = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: CALL_DAY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const wallMidnightUtc = Date.UTC(Number(day.year), Number(day.month) - 1, Number(day.day));
  let result = new Date(wallMidnightUtc);
  result = new Date(wallMidnightUtc - timeZoneOffsetMs(result, CALL_DAY_TIME_ZONE));
  result = new Date(wallMidnightUtc - timeZoneOffsetMs(result, CALL_DAY_TIME_ZONE));
  return result;
}

function leadLedgerKey(row = {}, domain = row.domain) {
  const normalizedDomain = normalizeDomain(domain);
  const caseId = normalizeCaseId(row.caseId);
  if (caseId != null) return `${normalizedDomain}:case:${caseId}`;
  const phone = normalizePhone(row.normalizedPhone || row.phone || row.leadPhone || row.phoneNumber);
  return phone ? `${normalizedDomain}:phone:${phone}` : null;
}

function currentStatusCallable(profile = null, acceptedStatusIds = []) {
  if (!profile) return false;
  if (profile.active === false) return false;
  const category = str(profile.statusCategory).toLowerCase();
  if ([
    "client",
    "dnc",
    "dead",
    "non_prospect",
    "non-prospect",
    "do-not-contact",
    "contact-blocked",
    "stop-contact",
  ].includes(category)) return false;
  const statusId = normalizeCaseId(profile.statusId);
  const accepted = new Set((Array.isArray(acceptedStatusIds) ? acceptedStatusIds : [])
    .map(Number).filter(Number.isFinite));
  return statusId != null && accepted.has(statusId);
}

function dailyTerminalAllows(row = null, options = {}) {
  if (!row) return true;
  const outcome = str(row.outcome || row.payload?.outcome).toLowerCase().replace(/[\s-]+/g, "_");
  if (DAILY_BLOCKING_OUTCOMES.has(outcome)) return false;
  const cadenceWindowMs = Math.max(Number(options.cadenceWindowMinutes) || 90, 1) * 60 * 1000;
  const terminalAt = new Date(row.payload?.at || row.createdAt || 0).getTime();
  const now = options.now instanceof Date ? options.now.getTime() : new Date(options.now || Date.now()).getTime();
  if (!Number.isFinite(terminalAt) || terminalAt <= 0) return false;
  if (CADENCE_OUTCOMES.has(outcome)) return now - terminalAt >= cadenceWindowMs;
  return false;
}

function makeHttpError(message, status = 400, code = null) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function rowsFromResponse(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.leads)) return value.leads;
  if (Array.isArray(value?.records)) return value.records;
  if (Array.isArray(value?.data)) return value.data;
  const error = new Error("RingCX lead search returned an unexpected response");
  error.keys = value && typeof value === "object" ? Object.keys(value).slice(0, 12) : [];
  throw error;
}

// RingCX silently broadens an incomplete lead search to the whole account. Both
// campaignId fields are therefore law, not decoration.
function buildLeadSearchPayload(agent = {}, extra = {}) {
  const campaignId = Number(agent.campaignId || agent.ringcx?.campaignId) || str(agent.campaignId || agent.ringcx?.campaignId);
  if (!campaignId) throw new Error("RingCX lead search requires campaignId");
  return {
    campaignId,
    campaignIds: [campaignId],
    listIds: [],
    agentDispositions: [],
    systemDispositions: [],
    leadStates: [],
    physicalStates: [],
    leadTimezones: [],
    suppressed: "ALL",
    ...extra,
  };
}

function sessionPrefix(agent = {}) {
  const token = buildExternSessionToken(agent.sessionId);
  if (!token) return null;
  return `cxbl-${normalizeDomain(agent.domain).toLowerCase()}-${token}-`;
}

function queueItemIdFromExtern(agent = {}, externId = "") {
  const prefix = sessionPrefix(agent);
  const value = str(externId).toLowerCase();
  return prefix && value.startsWith(prefix) ? value.slice(prefix.length) : null;
}

function isHardEligible(row = {}) {
  const releaseAt = row.releaseAt ? new Date(row.releaseAt) : null;
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  const phone = str(row.phone || row.leadPhone || row.phoneNumber).replace(/\D+/g, "");
  return Boolean(
    row
      && phone
      && isQueueRowContactable(row)
      && (!row.state || row.state === "ready" || row.state === "claimed")
      && (!releaseAt || !Number.isNaN(releaseAt.getTime()) && releaseAt <= new Date())
      && !metadata.appointmentId
      && metadata.firstTouchPending !== true
      && !metadata.appointmentPending,
  );
}

function chooseFamilyTargets(pool = {}) {
  let remaining = RINGCX_REFILL_BATCH;
  const targets = Object.fromEntries(FAMILIES.map((family) => [family, 0]));
  const mix = {
    "fresh-day1": 15,
    "fresh-day2to10": 8,
    "fresh-day16to30": 4,
    aged: 3,
  };
  for (const family of FAMILIES) {
    const available = Array.isArray(pool[family]) ? pool[family].length : 0;
    targets[family] = Math.min(mix[family], available);
    remaining -= targets[family];
  }
  for (const family of FAMILIES) {
    if (remaining <= 0) break;
    const available = Array.isArray(pool[family]) ? pool[family].length : 0;
    const extra = Math.min(remaining, Math.max(0, available - targets[family]));
    targets[family] += extra;
    remaining -= extra;
  }
  return targets;
}

function outcomeFromLead(row = {}) {
  const token = str(
    row.lastPassDispo
      || row.lastPassDisposition
      || row.agentDisposition
      || row.agentDispostion
      || row.outboundDisposition,
  ).toUpperCase();
  if (token.includes("MACHINE") || token.includes("VOICEMAIL") || token.includes("VM DROP")) return "voicemail";
  if (token.includes("DNC")) return "dnc";
  if (token.includes("BAD") || token.includes("WRONG")) return "bad_number";
  if (["NOANSWER", "NO ANSWER", "NO_ANSWER", "BUSY", "CONGESTION", "INTERCEPT", "ABANDON", "DISCONNECT"]
    .some((value) => token.includes(value))) return "did_not_connect";
  if (token.includes("ANSWER") || token.includes("SALE")) return "answered";
  return null;
}

function ringcxDisposition(outcome) {
  return str(outcome).toLowerCase() === "voicemail" ? "VM DROP" : "Auto Dispo";
}

function envToken(value) {
  return str(value)
    .replace(/@/g, "_AT_")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function resolveAgentRoute(agent = {}, input = {}, env = process.env) {
  for (const value of [
    input.agentExtensionId,
    agent.agentExtensionId,
    input.cxAgentId,
    agent.cxAgentId,
    input.agentEmail,
    agent.agentEmail,
    agent.account?.email,
    agent.account?.name,
  ]) {
    const suffix = envToken(value);
    if (!suffix) continue;
    const campaignId = normalizeId(env[`RINGCX_AGENT_ROUTE_${suffix}_CAMPAIGN_ID`]);
    const dialGroupId = normalizeId(env[`RINGCX_AGENT_ROUTE_${suffix}_DIAL_GROUP_ID`]);
    if (campaignId || dialGroupId) return { campaignId, dialGroupId };
  }
  return { campaignId: null, dialGroupId: null };
}

async function resolveAgentContext(input = {}, user = {}, deps = {}) {
  const requesterEmail = normalizeEmail(user.email);
  const targetEmail = normalizeEmail(input.agentEmail || requesterEmail);
  if (!targetEmail) throw makeHttpError("agentEmail is required", 400, "cx-boring-agent-required");
  if (targetEmail !== requesterEmail && str(user.role).toLowerCase() !== "admin") {
    throw makeHttpError("Cannot control another agent's dialer", 403, "cx-boring-agent-forbidden");
  }
  const account = await deps.userAccountRepository.findUserAccountByEmail(targetEmail).catch(() => null);
  return {
    agentEmail: targetEmail,
    agentExtensionId: normalizeId(input.agentExtensionId || account?.extensionId || user.extensionId),
    cxAgentId: normalizeId(input.cxAgentId || account?.cxAgentId || account?.ringcxAgentId || user.cxAgentId || user.ringcxAgentId),
    account,
  };
}

function createRuntimeAdapters(deps) {
  const client = deps.client;

  async function hydrateLeads(agent, rawRows = []) {
    const owned = rawRows
      .map((row) => ({ row, queueItemId: queueItemIdFromExtern(agent, row?.externId || row?.externalId) }))
      .filter((entry) => entry.queueItemId);
    const objectIds = owned.map((entry) => entry.queueItemId).filter((id) => /^[a-f\d]{24}$/i.test(id));
    const localRows = objectIds.length
      ? await deps.CxDialQueue.find({ _id: { $in: objectIds } }).lean()
      : [];
    const byId = new Map(localRows.map((row) => [String(row._id), row]));
    return owned.map(({ row, queueItemId }) => {
      const externId = str(row.externId || row.externalId);
      const local = byId.get(queueItemId) || null;
      const localOwned = Boolean(
        local
          && normalizeDomain(local.domain) === normalizeDomain(agent.domain)
          && str(local.metadata?.reservationSessionId) === str(agent.sessionId)
          && str(local.metadata?.lastRingcxPublishedExternId) === externId,
      );
      return {
        ...(localOwned ? local : {}),
        queueItemId,
        externId,
        localOwned,
        leadState: row.leadState || row.state || null,
        ringcxLeadId: row.leadId || null,
        uii: row.uii || null,
        lastPassDispo: row.lastPassDispo || null,
        lastPassDisposition: row.lastPassDisposition || null,
        agentDisposition: row.agentDisposition || null,
        outboundDisposition: row.outboundDisposition || null,
      };
    });
  }

  async function search(agent, extra = {}) {
    return rowsFromResponse(await client.searchLeads(buildLeadSearchPayload(agent, extra)));
  }

  const inventory = {
    async listOwned(agent = {}) {
      const rows = await deps.CxDialQueue.find({
        domain: normalizeDomain(agent.domain),
        state: { $in: ["claimed", "ready", "serving"] },
        "metadata.reservationSessionId": agent.sessionId,
      }).lean();
      return (Array.isArray(rows) ? rows : []).map((row) => ({
        ...row,
        queueItemId: String(row?._id || row?.queueItemId || ""),
        externId: row?.metadata?.lastRingcxPublishedExternId || row?.externId || null,
      }));
    },

    async listEligible({ agent, acceptedStatusIds = [], cadenceWindowMinutes = 90, now = new Date() } = {}) {
      if (!agent?.agentExtensionId) return [];
      const domain = normalizeDomain(agent.domain);
      const rows = await deps.CxDialQueue.find({
        domain,
        state: "ready",
        releaseAt: { $lte: new Date() },
        "metadata.appointmentId": { $in: [null, ""] },
        "metadata.firstTouchPending": { $ne: true },
        "metadata.appointmentPending": { $in: [null, false] },
        $or: [
          { "assignment.extensionId": agent.agentExtensionId },
          { "assignment.extensionId": { $exists: false } },
          { "assignment.extensionId": null },
          { "assignment.extensionId": "" },
        ],
      })
        .sort({ queueFamilyRank: 1, priorityScore: -1, createdAt: 1, _id: 1 })
        .limit(100)
        .lean();
      const candidates = rows.map((row) => ({ ...row, queueItemId: String(row._id) })).filter(isHardEligible);
      const caseIds = [...new Set(candidates.map((row) => normalizeCaseId(row.caseId)).filter((value) => value != null))];
      const caseLessPhones = candidates
        .filter((row) => normalizeCaseId(row.caseId) == null)
        .map((row) => normalizePhone(row.normalizedPhone || row.phone || row.leadPhone || row.phoneNumber))
        .filter(Boolean);
      const [profiles, phoneProfiles] = await Promise.all([
        typeof deps.caseProfileRepository?.listCaseProfilesByCaseIds === "function"
          ? deps.caseProfileRepository.listCaseProfilesByCaseIds(domain, caseIds, { currentOnly: true })
          : [],
        typeof deps.caseProfileRepository?.listCaseProfilesByPhones === "function"
          ? deps.caseProfileRepository.listCaseProfilesByPhones(domain, caseLessPhones, { currentOnly: true })
          : [],
      ]);
      const profileByCase = new Map((Array.isArray(profiles) ? profiles : [])
        .map((profile) => [`${domain}:case:${normalizeCaseId(profile.caseId)}`, profile]));
      const profilesByPhone = new Map();
      for (const profile of Array.isArray(phoneProfiles) ? phoneProfiles : []) {
        for (const value of [
          ...(Array.isArray(profile.normalizedPhones) ? profile.normalizedPhones : []),
          profile.primaryPhone,
          profile.phone,
        ]) {
          const phone = normalizePhone(value);
          const key = phone ? `${domain}:phone:${phone}` : null;
          if (key) {
            const matches = profilesByPhone.get(key) || [];
            if (!matches.some((candidate) => normalizeCaseId(candidate.caseId) === normalizeCaseId(profile.caseId))) {
              matches.push(profile);
            }
            profilesByPhone.set(key, matches);
          }
        }
      }
      const statusEligible = candidates.map((row) => {
        const key = leadLedgerKey(row, domain);
        const phoneProfilesForLead = key?.includes(":phone:") ? profilesByPhone.get(key) || [] : [];
        const profile = key?.includes(":case:")
          ? profileByCase.get(key) || null
          : (phoneProfilesForLead.length === 1 ? phoneProfilesForLead[0] : null);
        if (!currentStatusCallable(profile, acceptedStatusIds)) return null;
        const canonicalCaseId = normalizeCaseId(row.caseId) ?? normalizeCaseId(profile?.caseId);
        if (canonicalCaseId == null) return null;
        const terminalFallbackPhone = normalizeCaseId(row.caseId) == null
          ? normalizePhone(row.normalizedPhone || row.phone || row.leadPhone || row.phoneNumber)
          : null;
        return { ...row, caseId: canonicalCaseId, terminalFallbackPhone };
      }).filter(Boolean);
      const terminalCaseIds = [...new Set(statusEligible
        .map((row) => normalizeCaseId(row.caseId)).filter((value) => value != null))];
      const terminalPhones = statusEligible
        .map((row) => row.terminalFallbackPhone)
        .filter(Boolean);
      const terminals = typeof deps.cxTerminalOutboxRepository?.listLatestTodayForLeads === "function"
        ? await deps.cxTerminalOutboxRepository.listLatestTodayForLeads({
            domain,
            caseIds: terminalCaseIds,
            phones: terminalPhones,
            now,
            startAt: pacificDayStart(now),
          })
        : [];
      const terminalByLead = new Map((Array.isArray(terminals) ? terminals : [])
        .map((row) => [leadLedgerKey(row, domain), row]).filter(([key]) => key));
      return statusEligible.filter((row) => {
        const caseTerminal = terminalByLead.get(leadLedgerKey(row, domain));
        const phoneTerminal = row.terminalFallbackPhone
          ? terminalByLead.get(`${domain}:phone:${row.terminalFallbackPhone}`)
          : null;
        return dailyTerminalAllows(caseTerminal || phoneTerminal, { cadenceWindowMinutes, now });
      }).map(({ terminalFallbackPhone: _terminalFallbackPhone, ...row }) => row);
    },

    async findByExtern(agent, externId) {
      const queueItemId = queueItemIdFromExtern(agent, externId);
      if (!queueItemId || !/^[a-f\d]{24}$/i.test(queueItemId)) return null;
      const row = await deps.CxDialQueue.findOne({
        _id: queueItemId,
        domain: normalizeDomain(agent.domain),
        "metadata.reservationSessionId": agent.sessionId,
        "metadata.lastRingcxPublishedExternId": externId,
      }).lean();
      return row ? { ...row, queueItemId, externId } : null;
    },

    async claim(rows = [], { agent } = {}) {
      const claimed = [];
      const now = new Date();
      const claimable = (Array.isArray(rows) ? rows : [])
        .map((row) => ({ row, canonicalCaseId: normalizeCaseId(row.caseId) }))
        .filter(({ row, canonicalCaseId }) => /^[a-f\d]{24}$/i.test(str(row.queueItemId)) && canonicalCaseId != null);
      const leadIds = claimable.map(({ canonicalCaseId }) => String(canonicalCaseId));
      if (typeof deps.queueItemRepository.listActiveLeadIds !== "function") {
        throw new Error("queueItemRepository.listActiveLeadIds is required for boring-dialer claims");
      }
      const blockedLeadIds = new Set(await deps.queueItemRepository.listActiveLeadIds(leadIds));
      for (const { row, canonicalCaseId } of claimable) {
        if (blockedLeadIds.has(String(canonicalCaseId))) continue;
        const won = await deps.CxDialQueue.findOneAndUpdate(
          {
            _id: row.queueItemId,
            state: "ready",
            releaseAt: { $lte: now },
            "metadata.appointmentId": { $in: [null, ""] },
            "metadata.firstTouchPending": { $ne: true },
            "metadata.appointmentPending": { $in: [null, false] },
            $or: [
              { "assignment.extensionId": agent.agentExtensionId },
              { "assignment.extensionId": { $exists: false } },
              { "assignment.extensionId": null },
              { "assignment.extensionId": "" },
            ],
          },
          {
            $set: {
              caseId: canonicalCaseId,
              state: "claimed",
              lastClaimedAt: now,
              claimUntil: new Date(now.getTime() + 10 * 60 * 1000),
              "assignment.extensionId": agent.agentExtensionId,
              "assignment.assignedAt": now,
              "assignment.queueFamilySnapshot": row.queueFamily,
              "metadata.reservationSessionId": agent.sessionId,
              "metadata.reservedAt": now,
              "metadata.reservationExpiresAt": new Date(now.getTime() + 10 * 60 * 1000),
              // The implementation is "boring"; the durable queue/outbox rail is still bulk_load.
              "metadata.reservationRail": "bulk_load",
              "metadata.lastRingcxPublishedAt": null,
              "metadata.lastRingcxPublishedExternId": null,
              "metadata.lastRingcxActiveCall": null,
              "metadata.lastDialExecutionUii": null,
            },
          },
          { new: true },
        ).lean();
        if (won) claimed.push({ ...won, queueItemId: String(won._id) });
      }
      return claimed;
    },

    async markPublished(rows = [], { agent } = {}) {
      const now = new Date();
      for (const row of rows) {
        await deps.CxDialQueue.updateOne(
          { _id: row.queueItemId, "metadata.reservationSessionId": agent.sessionId },
          {
            $set: {
              rcxAccountId: normalizeId(agent.accountId || agent.ringcx?.accountId),
              rcxCampaignId: normalizeId(agent.campaignId || agent.ringcx?.campaignId),
              rcxDialGroupId: normalizeId(agent.dialGroupId || agent.ringcx?.dialGroupId),
              "metadata.lastRingcxPublishedAt": now,
              "metadata.lastRingcxPublishedExternId": row.externId,
              "metadata.lastRingcxPublishedCampaignId": normalizeId(agent.campaignId || agent.ringcx?.campaignId),
              "metadata.lastRingcxPublishedDialGroupId": normalizeId(agent.dialGroupId || agent.ringcx?.dialGroupId),
            },
          },
        );
      }
    },

    async release(rows = [], reason = "released") {
      const released = [];
      const failed = [];
      for (const row of rows) {
        const owner = row.metadata?.reservationSessionId || row.sessionId;
        if (!owner || !row.queueItemId) continue;
        const transitioned = await deps.cxDialQueueRepository.transitionQueueItemState(
          row.queueItemId,
          ["claimed", "ready", "serving"],
          {
            state: "ready",
            claimUntil: null,
            assignment: { extensionId: null, agentName: null, assignedAt: null, queueFamilySnapshot: null },
            "metadata.reservationSessionId": null,
            "metadata.reservedAt": null,
            "metadata.reservationExpiresAt": null,
            "metadata.lastReleasedAt": new Date(),
            "metadata.lastReleaseReason": reason,
          },
          { match: { "metadata.reservationSessionId": owner } },
        );
        if (transitioned) {
          released.push(row);
          continue;
        }
        if (typeof deps.CxDialQueue.findOne === "function") {
          const stillOwned = await deps.CxDialQueue.findOne({
            _id: row.queueItemId,
            "metadata.reservationSessionId": owner,
          }).lean();
          if (!stillOwned) {
            released.push(row);
            continue;
          }
        }
        failed.push(row);
      }
      return { ok: failed.length === 0, released, failed };
    },

    async normalizeIncoming(post = {}) {
      return post.lead || null;
    },
    isHardEligible,
  };

  const ringcx = {
    async listCampaignLeads(agent, states = ["READY", "ACTIVE"]) {
      return search(agent, { leadStates: states });
    },
    async listOutstanding(agent) {
      return hydrateLeads(agent, await search(agent, { leadStates: ["PENDING", "READY", "ACTIVE"] }));
    },
    async load(agent, rows) {
      return publishBatchToRingcx(client, {
        campaignId: agent.campaignId || agent.ringcx?.campaignId,
        dialPriority: "NORMAL",
        candidates: rows,
      });
    },
    async listActiveCalls(agent) {
      return loadActiveCallsSnapshot(client, {
        product: "ACCOUNT",
        accountId: agent.accountId || agent.ringcx?.accountId,
      });
    },
    async disposition(_agent, { uii, outcome, candidate }) {
      const response = await client.dispositionCall(uii, {
        disposition: ringcxDisposition(outcome),
        callback: false,
        phone: candidate.phone || undefined,
      });
      return { ok: response !== false, response };
    },
    async listCompleted(agent, options = {}) {
      const rows = await hydrateLeads(agent, await search(agent, { leadStates: [...TERMINAL_STATES, "READY"] }));
      const pending = (Array.isArray(agent.stats?.observedCalls) ? agent.stats.observedCalls : [])
        .filter((row) => row?.externId && row?.uii);
      const activeKeys = new Set((Array.isArray(options.activeCalls) ? options.activeCalls : [])
        .map((call) => ({ externId: str(call?.externId || call?.externalId), uii: str(call?.uii) }))
        .filter((call) => call.externId && call.uii)
        .map((call) => `${call.externId}:${call.uii}`));
      const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
      const requestedGraceMs = Number(options.graceMs);
      const graceMs = Number.isFinite(requestedGraceMs) ? Math.max(requestedGraceMs, 0) : RELEASE_GRACE_MS;
      return rows.flatMap((row) => {
        const dispositionEvidence = str(
          row.lastPassDispo
            || row.lastPassDisposition
            || row.agentDisposition
            || row.outboundDisposition,
        );
        if (str(row.leadState).toUpperCase() === "READY" && !dispositionEvidence) return [];
        const matches = pending.filter((candidate) => candidate.externId === row.externId
          && !activeKeys.has(`${candidate.externId}:${candidate.uii}`)
          && candidate.lastSeenAt
          && Number.isFinite(new Date(candidate.lastSeenAt).getTime())
          && now.getTime() - new Date(candidate.lastSeenAt).getTime() >= graceMs);
        const exactUii = str(row.uii);
        const selected = exactUii
          ? matches.filter((candidate) => str(candidate.uii) === exactUii)
          : (matches.length === 1 ? matches : []);
        return selected.map((prior) => ({
          ...prior,
          ...row,
          queueItemId: prior.queueItemId || row.queueItemId,
          externId: prior.externId,
          uii: prior.uii,
          outcome: outcomeFromLead(row),
          systemDisposition: row.lastPassDispo || row.lastPassDisposition || null,
        }));
      });
    },
    async cancel(agent, externIds = []) {
      if (!externIds.length) return { ok: true, cancelled: 0 };
      const campaignId = agent.campaignId || agent.ringcx?.campaignId;
      const response = await client.leadAction("CANCEL_LEADS", {
        campaignLeadSearchCriteria: { campaignId, campaignIds: [campaignId], externIds },
        leadActionParams: {},
      });
      return { ok: response !== false, cancelled: externIds.length, response };
    },
    async hangup(_agent, uii) {
      const response = await client.hangupCall(uii);
      return { ok: response !== false, response };
    },
  };

  const projection = {
    async replaceOutstanding(agent, rows) {
      const session = await deps.cxBulkLoadSessionRepository.findBulkLoadSessionById(agent.sessionId);
      if (!session || session.runtime !== RUNTIME || session.status !== "running") return null;
      const stats = { ...(session?.stats || {}), lastRingcxReadAt: new Date().toISOString() };
      delete stats.outstandingCount;
      return deps.cxBulkLoadSessionRepository.updateBulkLoadSession(agent.sessionId, {
        phase: session?.current?.uii ? "active" : session?.current ? "dialing" : rows.length ? "ready" : "watching",
        stats,
      }, {
        match: { runtime: RUNTIME, status: "running" },
      });
    },
    async setCurrent(agent, current, options = {}) {
      const session = await deps.cxBulkLoadSessionRepository.findBulkLoadSessionById(agent.sessionId);
      if (!session || session.runtime !== RUNTIME || session.status !== "running") return null;
      const stats = { ...(session.stats || {}) };
      const observed = Array.isArray(stats.observedCalls) ? [...stats.observedCalls] : [];
      const ambiguousCalls = Array.isArray(options.observedCalls) ? options.observedCalls : [];
      const seenAt = new Date().toISOString();
      for (const call of [...ambiguousCalls, current].filter(Boolean)) {
        const externId = str(call.externId || call.externalId);
        const uii = str(call.uii);
        const owned = ambiguousCalls.includes(call)
          ? await inventory.findByExtern(agent, externId)
          : call;
        const queueItemId = str(owned?.queueItemId) || queueItemIdFromExtern(agent, externId);
        if (!externId || !uii || !queueItemId || queueItemIdFromExtern(agent, externId) !== queueItemId) continue;
        const key = `${queueItemId}:${uii}`;
        const existingIndex = observed.findIndex((row) => `${row?.queueItemId || ""}:${row?.uii || ""}` === key);
        if (existingIndex >= 0) {
          observed[existingIndex] = { ...observed[existingIndex], lastSeenAt: seenAt };
        } else {
          observed.push({
            externId,
            queueItemId,
            uii,
            domain: owned?.domain || agent.domain || null,
            caseId: owned?.caseId != null ? owned.caseId : null,
            phone: owned?.phone || owned?.leadPhone || owned?.phoneNumber || null,
            name: owned?.name || owned?.prospectName || owned?.contactName || null,
            lastSeenAt: seenAt,
          });
        }
      }
      stats.observedCalls = observed;
      const match = { runtime: RUNTIME, status: "running" };
      if (options.expectedExternId) match["current.externId"] = String(options.expectedExternId);
      if (options.expectedUii) match["current.uii"] = String(options.expectedUii);
      return deps.cxBulkLoadSessionRepository.updateBulkLoadSession(agent.sessionId, {
        current,
        phase: current?.uii ? "active" : current ? "dialing" : "watching",
        stats,
      }, {
        match,
      });
    },
    async appendCompleted(agent, completed) {
      const session = await deps.cxBulkLoadSessionRepository.findBulkLoadSessionById(agent.sessionId);
      if (!session || session.runtime !== RUNTIME || session.status !== "running") return null;
      const rows = Array.isArray(session?.completed) ? [...session.completed] : [];
      const key = `${completed.queueItemId || ""}:${completed.uii || ""}`;
      const exists = rows.some((row) => `${row.queueItemId || ""}:${row.uii || ""}` === key);
      if (!exists) rows.push(completed);
      const stats = { ...(session.stats || {}) };
      stats.observedCalls = (Array.isArray(stats.observedCalls) ? stats.observedCalls : [])
        .filter((row) => `${row?.queueItemId || ""}:${row?.uii || ""}` !== key);
      return deps.cxBulkLoadSessionRepository.updateBulkLoadSession(agent.sessionId, {
        completed: rows.slice(-200),
        stats,
        lastOutcome: completed,
      }, {
        match: { runtime: RUNTIME, status: "running" },
      });
    },
    async retireObserved(agent, identity) {
      const session = await deps.cxBulkLoadSessionRepository.findBulkLoadSessionById(agent.sessionId);
      if (!session || session.runtime !== RUNTIME || session.status !== "running") return null;
      const key = `${identity?.queueItemId || ""}:${identity?.uii || ""}`;
      if (key === ":") return session;
      const stats = { ...(session.stats || {}) };
      stats.observedCalls = (Array.isArray(stats.observedCalls) ? stats.observedCalls : [])
        .filter((row) => `${row?.queueItemId || ""}:${row?.uii || ""}` !== key);
      const currentKey = `${session.current?.queueItemId || ""}:${session.current?.uii || ""}`;
      const current = currentKey === key ? null : session.current;
      return deps.cxBulkLoadSessionRepository.updateBulkLoadSession(agent.sessionId, {
        current,
        phase: current ? "active" : "watching",
        stats,
      }, {
        match: { runtime: RUNTIME, status: "running" },
      });
    },
    async updateObserved(agent, identity, patch = {}) {
      const session = await deps.cxBulkLoadSessionRepository.findBulkLoadSessionById(agent.sessionId);
      if (!session || session.runtime !== RUNTIME || session.status !== "running") return null;
      const key = `${identity?.queueItemId || ""}:${identity?.uii || ""}`;
      if (key === ":") return session;
      const stats = { ...(session.stats || {}) };
      stats.observedCalls = (Array.isArray(stats.observedCalls) ? stats.observedCalls : [])
        .map((row) => `${row?.queueItemId || ""}:${row?.uii || ""}` === key ? { ...row, ...patch } : row);
      return deps.cxBulkLoadSessionRepository.updateBulkLoadSession(agent.sessionId, { stats }, {
        match: { runtime: RUNTIME, status: "running" },
      });
    },
  };

  const terminalWriter = createCxBulkLoadOutcomeAdapter({
    recordCadenceEvent: async (event) => {
      const idemKey = event.idemKey || makeOutcomeIdemKey({
        sessionId: event.sessionId,
        queueItemId: event.queueItemId,
        uii: event.uii,
        eventType: "terminal",
      });
      return deps.cxTerminalOutboxRepository.insertOnce({
        idemKey,
        sessionId: event.sessionId || null,
        rail: "bulk_load",
        domain: event.domain || null,
        queueItemId: event.queueItemId || null,
        uii: event.uii || null,
        caseId: event.caseId != null ? Number(event.caseId) : null,
        agentId: event.agentId || null,
        agentExtensionId: event.agentExtensionId || null,
        agentEmail: event.agentEmail || null,
        agentName: event.agentName || null,
        externId: event.externId || null,
        phone: event.phone || null,
        phoneLast4: event.phoneLast4 || null,
        outcome: event.outcome || null,
        source: event.source || null,
        payload: event,
      });
    },
  });
  const terminal = {
    ...terminalWriter,
    async hasTerminalOutcome({ session = {}, candidate = {} } = {}) {
      const agentId = str(session.cxAgentId || session.agentId || session.agentExtensionId);
      const uii = str(candidate.uii);
      if (!agentId || !uii) return false;
      return Boolean(await deps.cxTerminalOutboxRepository.findByAgentUii({ agentId, uii }));
    },
  };

  return {
    dialer: createCxBoringDialer({ inventory, ringcx, projection, terminal }),
    inventory,
    projection,
    ringcx,
    terminal,
  };
}

function sanitizeSession(session = null) {
  if (!session) return null;
  return {
    ...session,
    runtime: RUNTIME,
    completedCount: Array.isArray(session.completed) ? session.completed.length : 0,
  };
}

function createSerialTaskRunner() {
  const tasks = new Map();
  return async function run(keyValue, task) {
    const key = String(keyValue || "").trim();
    const previous = tasks.get(key) || Promise.resolve();
    const current = previous.catch(() => null).then(task);
    tasks.set(key, current);
    try {
      return await current;
    } finally {
      if (tasks.get(key) === current) tasks.delete(key);
    }
  };
}

function createCxBoringDialerRuntime(overrides = {}) {
  const deps = {
    CxDialQueue,
    client: createRingcxVoiceClient(),
    caseProfileRepository,
    cxBulkLoadSessionRepository,
    cxDialQueueRepository,
    cxTerminalOutboxRepository,
    queueItemRepository,
    userAccountRepository,
    env: process.env,
    ...overrides,
  };
  const { dialer, projection, ringcx } = createRuntimeAdapters(deps);
  const runSessionTask = createSerialTaskRunner();

  async function ownedSession(input, agent, { requireRunning = false } = {}) {
    const session = input.sessionId
      ? await deps.cxBulkLoadSessionRepository.findBulkLoadSessionById(input.sessionId)
      : await deps.cxBulkLoadSessionRepository.findActiveBulkLoadSessionForAgent({ ...agent, runtime: RUNTIME });
    if (!session) return null;
    if (session.runtime !== RUNTIME) throw makeHttpError("Session belongs to the retired runtime", 409, "cx-boring-runtime-conflict");
    if (normalizeEmail(session.agentEmail) !== normalizeEmail(agent.agentEmail)) {
      throw makeHttpError("Cannot access another agent's dialer session", 403, "cx-boring-session-forbidden");
    }
    if (requireRunning && session.status !== "running") {
      throw makeHttpError("Dialer session is no longer running", 409, "cx-boring-session-ended");
    }
    return session;
  }

  async function withSession(input, options, settings, task) {
    const agent = await resolveAgentContext(input, options.user || {}, deps);
    const found = await ownedSession(input, agent, settings);
    if (!found) return null;
    return runSessionTask(found.sessionId, async () => {
      const latest = await ownedSession({ ...input, sessionId: found.sessionId }, agent, settings);
      if (!latest) return null;
      return task(latest, agent);
    });
  }

  function agentFromSession(session) {
    return {
      ...session,
      accountId: session.ringcx?.accountId,
      campaignId: session.ringcx?.campaignId,
      dialGroupId: session.ringcx?.dialGroupId,
    };
  }

  async function refill(session) {
    const agent = agentFromSession(session);
    const outstanding = await ringcx.listOutstanding(agent);
    if (!Array.isArray(outstanding)) throw new Error("ringcx.listOutstanding must return an array");
    await projection.replaceOutstanding(agent, outstanding);
    if (outstanding.length >= RINGCX_LOW_WATER) {
      return {
        ok: true,
        reason: "ringcx-above-low-water",
        outstanding: outstanding.length,
        lowWater: RINGCX_LOW_WATER,
        batchSize: RINGCX_REFILL_BATCH,
        accepted: [],
        rejected: [],
      };
    }
    const pool = await dialer.buildPool({ agent, acceptedStatusIds: [2], cadenceWindowMinutes: 90 });
    return dialer.refillAgent(agent, pool, {
      refillAt: RINGCX_LOW_WATER - 1,
      familyTargets: chooseFamilyTargets(pool),
      outstanding,
      sendBatch: true,
    });
  }

  async function refillOnLogin(session) {
    try {
      await runSessionTask(session.sessionId, () => refill(session));
    } catch (error) {
      await deps.cxBulkLoadSessionRepository.updateBulkLoadSession(session.sessionId, {
        lastError: error?.message || String(error),
      }, {
        match: { runtime: RUNTIME, status: "running" },
      }).catch(() => null);
    }
    return deps.cxBulkLoadSessionRepository.findBulkLoadSessionById(session.sessionId);
  }

  async function startForAgent(input, agent) {
    const existing = await deps.cxBulkLoadSessionRepository.findActiveBulkLoadSessionForAgent({ ...agent, runtime: RUNTIME });
    if (existing) return sanitizeSession(await refillOnLogin(existing));
    const retired = await deps.cxBulkLoadSessionRepository.findActiveBulkLoadSessionForAgent(agent);

    const route = resolveAgentRoute(agent, input, deps.env);
    const ringcxConfig = {
      accountId: normalizeId(input.accountId || deps.env.RINGCX_VOICE_ACCOUNT_ID),
      campaignId: normalizeId(route.campaignId),
      dialGroupId: normalizeId(route.dialGroupId),
      agentGroupId: normalizeId(input.agentGroupId || deps.env.RINGCX_VOICE_DEFAULT_AGENT_GROUP_ID),
    };
    if (!ringcxConfig.accountId || !ringcxConfig.campaignId || !ringcxConfig.dialGroupId) {
      throw makeHttpError("RingCX route is incomplete", 409, "cx-boring-ringcx-route-incomplete");
    }

    // Live already owns campaign supply. Adopt the agent's running legacy session in place so
    // its RingCX extern ids and Mongo queue reservations keep the same session token. Nothing is
    // cancelled, copied, or republished; the local replacement simply becomes the sole reader.
    if (retired) {
      const retiredCampaignId = normalizeId(retired.ringcx?.campaignId);
      const retiredDialGroupId = normalizeId(retired.ringcx?.dialGroupId);
      if (retiredCampaignId && retiredCampaignId !== ringcxConfig.campaignId) {
        throw makeHttpError("Configured campaign does not match the live session", 409, "cx-boring-campaign-route-mismatch");
      }
      if (retiredDialGroupId && retiredDialGroupId !== ringcxConfig.dialGroupId) {
        throw makeHttpError("Configured dial group does not match the live session", 409, "cx-boring-dial-group-route-mismatch");
      }
      const now = new Date();
      const adopted = await deps.cxBulkLoadSessionRepository.updateBulkLoadSession(retired.sessionId, {
        runtime: RUNTIME,
        phase: "watching",
        ringcx: ringcxConfig,
        current: null,
        acceptedBuffer: [],
        prevActiveExternIds: [],
        lastOutcome: null,
        lastError: null,
        stats: {
          refillBatchSize: RINGCX_REFILL_BATCH,
          lowWater: RINGCX_LOW_WATER,
          startedAt: retired.startedAt || now.toISOString(),
          adoptedAt: now.toISOString(),
          adoptedFrom: "bulk_load",
          observedCalls: [],
        },
      }, {
        match: { runtime: { $ne: RUNTIME }, status: "running" },
      });
      if (!adopted) {
        throw makeHttpError("Live session ownership changed during takeover", 409, "cx-boring-session-adoption-raced");
      }
      return sanitizeSession(await refillOnLogin(adopted));
    }

    const preflightAgent = { ...agent, domain: normalizeDomain(input.domain || "WYNN"), ...ringcxConfig };
    const foreign = await ringcx.listCampaignLeads(preflightAgent, ["PENDING", "READY", "ACTIVE"]);
    if (foreign.length) {
      throw makeHttpError("Target campaign is not empty; replacement will not share ownership", 409, "cx-boring-campaign-not-empty");
    }

    const now = new Date();
    let session;
    try {
      session = await deps.cxBulkLoadSessionRepository.createBulkLoadSession({
        runtime: RUNTIME,
        sessionId: `cxbl-${crypto.randomUUID()}`,
        status: "running",
        phase: "preloading",
        agentEmail: agent.agentEmail,
        agentExtensionId: agent.agentExtensionId,
        cxAgentId: agent.cxAgentId,
        domain: preflightAgent.domain,
        ringcx: ringcxConfig,
        current: null,
        completed: [],
        stats: {
          refillBatchSize: RINGCX_REFILL_BATCH,
          lowWater: RINGCX_LOW_WATER,
          startedAt: now.toISOString(),
        },
        startedAt: now,
      });
    } catch (error) {
      if (Number(error?.code) === 11000) {
        const winner = await deps.cxBulkLoadSessionRepository.findActiveBulkLoadSessionForAgent({ ...agent, runtime: RUNTIME });
        if (winner) return sanitizeSession(winner);
      }
      throw error;
    }

    try {
      await runSessionTask(session.sessionId, async () => {
        const result = await refill(session);
        if (!result.accepted?.length) {
          await deps.cxBulkLoadSessionRepository.updateBulkLoadSession(session.sessionId, {
            status: "failed",
            phase: "failed",
            lastError: result.reason || "no-eligible-real-leads",
          });
        }
      });
    } catch (error) {
      const cleanupUnconfirmed = error?.cleanup?.ok === false;
      await deps.cxBulkLoadSessionRepository.updateBulkLoadSession(session.sessionId, {
        status: cleanupUnconfirmed ? "running" : "failed",
        phase: "failed",
        lastError: error.message || String(error),
      });
      throw error;
    }
    return sanitizeSession(await deps.cxBulkLoadSessionRepository.findBulkLoadSessionById(session.sessionId));
  }

  async function start(input = {}, options = {}) {
    const agent = await resolveAgentContext(input, options.user || {}, deps);
    return runSessionTask(`agent:${agent.agentEmail}`, () => startForAgent(input, agent));
  }

  async function refresh(session) {
    const agent = agentFromSession(session);
    const observation = await dialer.observeAgent(agent);
    if (observation.readOk !== true) {
      const error = new Error(observation.error || observation.reason || "ringcx-read-failed");
      error.code = observation.reason || "ringcx-read-failed";
      throw error;
    }
    const missingOwnedUii = observation.reason === "session-active-call-missing-uii";
    let latest = await deps.cxBulkLoadSessionRepository.findBulkLoadSessionById(session.sessionId);
    if (!missingOwnedUii) {
      const now = new Date();
      await dialer.recordCompleted(agentFromSession(latest), {
        activeCalls: observation.activeCalls || [],
        now,
        graceMs: RELEASE_GRACE_MS,
      });
      latest = await deps.cxBulkLoadSessionRepository.findBulkLoadSessionById(session.sessionId);
      await dialer.recordReleased(agentFromSession(latest), {
        activeCalls: observation.activeCalls || [],
        now,
        graceMs: RELEASE_GRACE_MS,
      });
      latest = await deps.cxBulkLoadSessionRepository.findBulkLoadSessionById(session.sessionId);
    }

    // RingCX exposes the exact session extern while the lead is PENDING, before it
    // exposes a UII on the active-call feed. Display that one proven dialing lead;
    // outcomes remain locked until the same extern arrives with its UII.
    if (observation.status !== "matched") {
      const latestAgent = agentFromSession(latest);
      const outstanding = await ringcx.listOutstanding(latestAgent);
      await projection.replaceOutstanding(latestAgent, outstanding);
      const pending = outstanding.filter((row) =>
        row?.localOwned === true && str(row?.leadState).toUpperCase() === "PENDING");
      const dialing = pending.length === 1
        ? {
            ...pending[0],
            uii: null,
            phase: "dialing",
            status: "dialing",
            activeCallSummary: null,
          }
        : null;
      await projection.setCurrent(latestAgent, dialing);
    }
    return deps.cxBulkLoadSessionRepository.findBulkLoadSessionById(session.sessionId);
  }

  async function get(input = {}, options = {}) {
    return withSession(input, options, {}, async (session) =>
      sanitizeSession(session));
  }

  async function disposition(input = {}, options = {}) {
    return withSession(input, options, { requireRunning: true }, async (session) => {
      const result = await dialer.finishCall(
        agentFromSession(session),
        input.disposition || input.outcome,
        {
          expectedExternId: input.expectedExternId,
          expectedUii: input.expectedUii,
          nextAction: input.nextAction,
        },
      );
      const latest = sanitizeSession(await deps.cxBulkLoadSessionRepository.findBulkLoadSessionById(session.sessionId));
      return { ...latest, dispositionOk: result.ok === true, dispositionResult: result };
    });
  }

  async function getLeads(input = {}, options = {}) {
    return withSession(input, options, { requireRunning: true }, async (session) => {
      const refillResult = await refill(session);
      return {
        ...sanitizeSession(await deps.cxBulkLoadSessionRepository.findBulkLoadSessionById(session.sessionId)),
        refillResult,
      };
    });
  }

  async function kill(input = {}, options = {}) {
    return withSession(input, options, {}, async (session) => {
      if (session.status !== "running") return sanitizeSession(session);
      let reset;
      try {
        reset = await dialer.resetAgent(agentFromSession(session), input.reason || "manual");
      } catch (error) {
        return {
          ...sanitizeSession(await deps.cxBulkLoadSessionRepository.findBulkLoadSessionById(session.sessionId)),
          killOk: false,
          killResult: { ok: false, reason: "cleanup-failed", error: error?.message || String(error) },
        };
      }
      if (reset?.ok !== true) {
        const latest = sanitizeSession(await deps.cxBulkLoadSessionRepository.findBulkLoadSessionById(session.sessionId));
        return { ...latest, killOk: false, killResult: reset };
      }
      const killed = await deps.cxBulkLoadSessionRepository.updateBulkLoadSession(session.sessionId, {
        status: "killed",
        phase: "released",
        killedAt: new Date(),
      }, {
        match: { runtime: RUNTIME, status: "running" },
      });
      if (!killed) {
        return {
          ...sanitizeSession(await deps.cxBulkLoadSessionRepository.findBulkLoadSessionById(session.sessionId)),
          killOk: false,
          killResult: { ok: false, reason: "session-kill-cas-failed" },
        };
      }
      return {
        ...sanitizeSession(killed),
        killOk: true,
        killResult: reset,
      };
    });
  }

  async function watch(input = {}) {
    const checkedAt = new Date().toISOString();
    const sessions = await deps.cxBulkLoadSessionRepository.listActiveBulkLoadSessions({
      runtime: RUNTIME,
      sessionId: input.sessionId,
      agentEmail: input.agentEmail,
      agentExtensionId: input.agentExtensionId,
      domain: input.domain,
      accountId: input.accountId,
    });
    const results = [];
    for (const found of Array.isArray(sessions) ? sessions : []) {
      const result = await runSessionTask(found.sessionId, async () => {
        const latest = await deps.cxBulkLoadSessionRepository.findBulkLoadSessionById(found.sessionId);
        if (!latest || latest.runtime !== RUNTIME || latest.status !== "running") {
          return { sessionId: found.sessionId, ok: true, skipped: true, reason: "session-no-longer-running" };
        }
        try {
          await refresh(latest);
          return { sessionId: found.sessionId, ok: true, skipped: false };
        } catch (error) {
          return { sessionId: found.sessionId, ok: false, skipped: false, error: error?.message || String(error) };
        }
      });
      results.push(result);
    }
    return {
      checkedAt,
      summary: {
        sessionCount: results.length,
        refreshedCount: results.filter((row) => row.ok && !row.skipped).length,
        skippedCount: results.filter((row) => row.skipped).length,
        errorCount: results.filter((row) => !row.ok).length,
      },
      sessions: results,
    };
  }

  return { start, get, sync: get, disposition, getLeads, kill, watch };
}

let singleton = null;
function runtime() {
  if (!singleton) singleton = createCxBoringDialerRuntime();
  return singleton;
}

async function startCxBoringDialerSession(input, options) { return runtime().start(input, options); }
async function getCxBoringDialerSession(input, options) { return runtime().get(input, options); }
async function syncCxBoringDialerActiveCall(input, options) { return runtime().sync(input, options); }
async function watchCxBoringDialerActiveCalls(input) { return runtime().watch(input); }
async function submitCxBoringDialerDisposition(input, options) { return runtime().disposition(input, options); }
async function startCxBoringDialerGetLeads(input, options) { return runtime().getLeads(input, options); }
async function killCxBoringDialerSession(input, options) { return runtime().kill(input, options); }
async function boringDialerAvailabilityNoop() {
  return { ok: true, skipped: true, reason: "availability-control-owns-agent-state" };
}

module.exports = {
  createCxBoringDialerRuntime,
  startCxBoringDialerSession,
  getCxBoringDialerSession,
  syncCxBoringDialerActiveCall,
  watchCxBoringDialerActiveCalls,
  submitCxBoringDialerDisposition,
  startCxBoringDialerGetLeads,
  killCxBoringDialerSession,
  boringDialerAvailabilityNoop,
  _test: {
    buildLeadSearchPayload,
    chooseFamilyTargets,
    createRuntimeAdapters,
    createSerialTaskRunner,
    currentStatusCallable,
    dailyTerminalAllows,
    leadLedgerKey,
    normalizePhone,
    normalizeCaseId,
    pacificDayStart,
    outcomeFromLead,
    queueItemIdFromExtern,
    resolveAgentRoute,
    ringcxDisposition,
    sessionPrefix,
  },
};
