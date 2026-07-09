"use strict";

// SEAN FIRST-TOUCH DRIP (Mickey's patch shape, 2026-07-08). The fresh-touch test for
// the one-agent pilot: 4001 intake keeps minting fresh-day1 rows exactly as today; this
// worker occasionally picks ONE still-unassigned fresh mint, assigns it to Sean, and
// publishes it IMMEDIATE into his First Touch campaign through the existing publish
// primitive. The floor loses nothing it ever saw (only unassigned rows are eligible),
// and the row keeps full legacy semantics — family, cadence counters, legacy extern —
// so every downstream behaves exactly like the floor's own fresh leads.
//
// Placement note: this runs on the DEV box's control plane, NOT on live. The shared
// Atlas Mongo means rows minted by live's 4001 are visible here instantly — zero live
// patches, zero 4001 touches, zero live restarts.
//
// Why publishBatchToRingcx and not publishQueueItemToRingcx: the queue-item publisher
// resolves the per-agent env route FIRST (slucas -> campaign 2344, his bulk/live lane)
// and row-level stamps cannot override it. The batch publisher takes an explicit
// campaignId — the same way the lane dispatchers hit their campaigns (proven live in
// the 07-08 interrupt test).
//
// Flags (all default-off/safe):
//   CX_SEAN_FIRST_TOUCH_TEST_ENABLED   master switch (default false)
//   CX_SEAN_FIRST_TOUCH_DRY_RUN        select+log only, zero writes (default false)
//   CX_SEAN_FIRST_TOUCH_EXTENSION_ID   default 63756126004
//   CX_SEAN_FIRST_TOUCH_AGENT_EMAIL    default slucas@taxadvocategroup.com
//   CX_SEAN_FIRST_TOUCH_AGENT_NAME     default "Sean Lucas"
//   CX_SEAN_FIRST_TOUCH_CAMPAIGN_ID    default 2831 (Sean First Touch, DG 1011)
//   CX_SEAN_FIRST_TOUCH_MAX_PER_TICK   default 1
//   CX_SEAN_FIRST_TOUCH_MIN_GAP_MINUTES default 10 ("occasional", crash-safe via Mongo)
//   CX_SEAN_FIRST_TOUCH_WINDOW_MINUTES default 30 (only genuinely NEW mints)
//   CX_SEAN_FIRST_TOUCH_DOMAIN         default WYNN

const { CxDialQueue } = require("../../shared-models/src");
const { publishBatchToRingcx } = require("./cxBulkLoadRingcxPublisher");
const { logCxAlpha } = require("./cxAlphaTraceService");

const CLAIM_HOURS = 8; // hold the claim through the pilot day; end-of-day cleanup releases

function envStr(name, fallback) {
  const v = process.env[name];
  return v === undefined || String(v).trim() === "" ? fallback : String(v).trim();
}
function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}
function envBool(name, fallback = false) {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return String(v).trim().toLowerCase() === "true";
}
function maskPhone(phone) {
  const s = String(phone || "");
  return s.length > 4 ? `***${s.slice(-4)}` : "-";
}
function maskName(name) {
  const parts = String(name || "").trim().split(/\s+/);
  if (!parts[0]) return "-";
  const last = parts.length > 1 ? ` ${parts[parts.length - 1][0]}.` : "";
  return `${parts[0]}${last}`;
}

function readConfig() {
  return {
    enabled: envBool("CX_SEAN_FIRST_TOUCH_TEST_ENABLED", false),
    dryRun: envBool("CX_SEAN_FIRST_TOUCH_DRY_RUN", false),
    extensionId: envStr("CX_SEAN_FIRST_TOUCH_EXTENSION_ID", "63756126004"),
    agentEmail: envStr("CX_SEAN_FIRST_TOUCH_AGENT_EMAIL", "slucas@taxadvocategroup.com").toLowerCase(),
    agentName: envStr("CX_SEAN_FIRST_TOUCH_AGENT_NAME", "Sean Lucas"),
    campaignId: envStr("CX_SEAN_FIRST_TOUCH_CAMPAIGN_ID", "2831"),
    maxPerTick: envInt("CX_SEAN_FIRST_TOUCH_MAX_PER_TICK", 1),
    minGapMinutes: envInt("CX_SEAN_FIRST_TOUCH_MIN_GAP_MINUTES", 10),
    windowMinutes: envInt("CX_SEAN_FIRST_TOUCH_WINDOW_MINUTES", 30),
    domain: envStr("CX_SEAN_FIRST_TOUCH_DOMAIN", "WYNN").toUpperCase(),
  };
}

// legacy extern convention — the row must look exactly like a floor-published lead
function buildLegacyExternId(row) {
  return `parallel:${String(row.domain).toUpperCase()}:${row.caseId}:${String(row._id)}`;
}

function zeroTouchCondition() {
  return { $in: [0, null] };
}

function buildFreshCandidateQuery(cfg, now) {
  return {
    domain: cfg.domain,
    state: "ready",
    queueFamily: "fresh-day1",
    placedCalls: zeroTouchCondition(),
    "assignment.extensionId": null,
    "metadata.requestedBy": "intake-first-contact",
    "metadata.seanFirstTouchTest": { $exists: false },
    "metadata.firstTouchPending": { $ne: true },
    "metadata.appointmentPending": { $in: [null, false] },
    createdAt: { $gte: new Date(now.getTime() - cfg.windowMinutes * 60 * 1000) },
  };
}

function buildRecentSelectionQuery(cfg, now) {
  return {
    domain: cfg.domain,
    "metadata.seanFirstTouchTest.selectedAt": {
      $gte: new Date(now.getTime() - cfg.minGapMinutes * 60 * 1000),
    },
  };
}

function buildClaimFilter(row, cfg) {
  return {
    _id: row._id,
    domain: cfg.domain,
    state: "ready",
    queueFamily: "fresh-day1",
    placedCalls: zeroTouchCondition(),
    "assignment.extensionId": null,
    "metadata.requestedBy": "intake-first-contact",
    "metadata.seanFirstTouchTest": { $exists: false },
    "metadata.firstTouchPending": { $ne: true },
    "metadata.appointmentPending": { $in: [null, false] },
  };
}

function buildClaimPatch(cfg, now) {
  return {
    $set: {
      state: "claimed",
      lastClaimedAt: now,
      claimUntil: new Date(now.getTime() + CLAIM_HOURS * 60 * 60 * 1000),
      "assignment.extensionId": cfg.extensionId,
      "assignment.agentName": cfg.agentName,
      "assignment.assignedAt": now,
      "assignment.queueFamilySnapshot": "fresh-day1",
      "metadata.seanFirstTouchTest": {
        selectedAt: now.toISOString(),
        agentEmail: cfg.agentEmail,
        campaignId: cfg.campaignId,
      },
    },
  };
}

function buildReleaseFilter(queueItemId, cfg) {
  return {
    _id: queueItemId,
    state: "claimed",
    placedCalls: zeroTouchCondition(),
    "assignment.extensionId": cfg.extensionId,
    "metadata.seanFirstTouchTest.agentEmail": cfg.agentEmail,
  };
}

function buildReleasePatch(now = new Date()) {
  return {
    $set: {
      state: "ready",
      claimUntil: null,
      "assignment.extensionId": null,
      "assignment.agentName": null,
      "assignment.assignedAt": null,
      "metadata.seanFirstTouchTest.releasedAt": now.toISOString(),
    },
  };
}

function defaultDeps() {
  return {
    listCandidates: (cfg, now) =>
      CxDialQueue.find(buildFreshCandidateQuery(cfg, now))
        .sort({ createdAt: 1 })
        .limit(cfg.maxPerTick)
        .lean(),
    countRecentSelections: (cfg, now) =>
      CxDialQueue.countDocuments(buildRecentSelectionQuery(cfg, now)),
    claimRow: async (row, cfg, now) => {
      const result = await CxDialQueue.updateOne(
        buildClaimFilter(row, cfg),
        buildClaimPatch(cfg, now),
      );
      return (result.modifiedCount ?? result.nModified ?? 0) > 0;
    },
    publishBatch: publishBatchToRingcx,
    stampPublished: (queueItemId, fields) =>
      CxDialQueue.updateOne({ _id: queueItemId }, { $set: fields }),
    releaseRow: (queueItemId, cfg, now = new Date()) =>
      CxDialQueue.updateOne(
        buildReleaseFilter(queueItemId, cfg),
        buildReleasePatch(now),
      ),
  };
}

function createCxSeanFirstTouchDrip(input = {}) {
  const deps = { ...defaultDeps(), ...input };
  const { client, logger = console } = input;

  async function tickOnce({ now = new Date() } = {}) {
    const cfg = readConfig();
    if (!cfg.enabled) return { skipped: true, reason: "flag-off" };

    // "occasional": one selection per gap window, crash-safe (state lives in Mongo)
    const recent = await deps.countRecentSelections(cfg, now);
    if (recent > 0) return { skipped: true, reason: "min-gap", recent };

    const candidates = await deps.listCandidates(cfg, now);
    if (!candidates.length) return { skipped: true, reason: "no-fresh-candidates" };

    let published = 0;
    let failed = 0;
    for (const row of candidates.slice(0, cfg.maxPerTick)) {
      logCxAlpha("cx.alpha.sean_ft.candidate", {
        queueItemId: String(row._id),
        caseId: row.caseId,
        domain: row.domain,
        name: maskName(row.name),
        phone: maskPhone(row.phone),
        mintedAt: row.createdAt || null,
        dryRun: cfg.dryRun,
      }, { logger });

      if (cfg.dryRun) continue; // selection visibility without a single write

      const won = await deps.claimRow(row, cfg, now).catch(() => false);
      if (!won) {
        logCxAlpha("cx.alpha.sean_ft.skipped", {
          queueItemId: String(row._id),
          reason: "claim-lost", // a floor claimer got there first — their lead, by design
        }, { logger });
        continue;
      }

      const externId = buildLegacyExternId(row);
      try {
        const publish = await deps.publishBatch(client, {
          campaignId: cfg.campaignId,
          dialPriority: "IMMEDIATE",
          candidates: [{
            externId,
            phone: row.phone || null,
            name: row.name || null,
            domain: row.domain,
            caseId: row.caseId,
            queueItemId: String(row._id),
          }],
        });
        const accepted = Array.isArray(publish?.accepted) && publish.accepted.length > 0;
        if (!accepted) throw new Error(publish?.rejected?.[0]?.reason || "publish-rejected");

        await deps.stampPublished(row._id, {
          "metadata.rcxVisibilityStatus": "published",
          "metadata.rcxVisibilityCampaignId": cfg.campaignId,
          "metadata.rcxVisibilityExternId": externId,
          "metadata.rcxVisibilitySyncedAt": now,
          "metadata.seanFirstTouchTest.publishedAt": now.toISOString(),
        });
        published += 1;
        logCxAlpha("cx.alpha.sean_ft.published", {
          queueItemId: String(row._id),
          caseId: row.caseId,
          externId,
          campaignId: cfg.campaignId,
          extensionId: cfg.extensionId,
          agentEmail: cfg.agentEmail,
        }, { logger });
      } catch (error) {
        failed += 1;
        await deps.releaseRow(row._id, cfg, now).catch(() => null);
        logCxAlpha("cx.alpha.sean_ft.publish_failed", {
          queueItemId: String(row._id),
          caseId: row.caseId,
          externId,
          error: error?.message,
        }, { logger });
      }
    }
    return { published, failed, dryRun: cfg.dryRun, candidates: candidates.length };
  }

  return { tickOnce };
}

module.exports = {
  buildClaimFilter,
  buildClaimPatch,
  buildFreshCandidateQuery,
  buildLegacyExternId,
  buildRecentSelectionQuery,
  buildReleaseFilter,
  buildReleasePatch,
  createCxSeanFirstTouchDrip,
};
