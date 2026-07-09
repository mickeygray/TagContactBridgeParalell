"use strict";

const { getSharedConfig } = require("../../shared-config/src");
const { isAllowListGatedStatus } = require("../../shared-config/src/statusMap");
const {
  caseProfileRepository,
  cxDialQueueRepository,
  leadCadenceRepository,
} = require("../../shared-repositories/src");
const { recordWorkflowStage } = require("./workflowStateService");
const { createLogicsFacade } = require("./logicsFacadeService");

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function includesAny(haystack, phrases = []) {
  const normalized = normalizeText(haystack);
  if (!normalized) return false;
  return phrases.some((phrase) => normalized.includes(normalizeText(phrase)));
}

function getAllowedProspectStatusSet(config = {}) {
  const configured = Array.isArray(config.logicsProspectStatusIds)
    ? config.logicsProspectStatusIds
    : [];
  const values = configured.length > 0 ? configured : [1, 2];
  return new Set(
    values
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value)),
  );
}

function buildBlockedReason(caseProfile, leadCadence, config = {}, now = new Date(), options = {}) {
  const statusIds = [
    Number(caseProfile?.statusId),
    Number(leadCadence?.statusId),
  ].filter(Number.isFinite);
  const allowedProspectStatusSet = getAllowedProspectStatusSet(config);
  const liveStatusId = (
    options.liveStatusId !== undefined
      && options.liveStatusId !== null
      && Number.isFinite(Number(options.liveStatusId))
  )
    ? Number(options.liveStatusId)
    : null;
  const requireFreshLogicsStatus = Boolean(options.requireFreshLogicsStatus);

  if (liveStatusId != null && !allowedProspectStatusSet.has(liveStatusId)) {
    return {
      reason: "logics-nonprospect-status",
      detail: `Live Logics status ${liveStatusId} is not contactable (allowed: ${[...allowedProspectStatusSet].join(", ")})`,
    };
  }

  if (liveStatusId == null && statusIds.length > 0 && !statusIds.some((value) => allowedProspectStatusSet.has(value))) {
    return {
      reason: "logics-nonprospect-status",
      detail: `Stored Logics status is not contactable (${statusIds.join(", ")})`,
    };
  }

  const dncStatusSet = new Set((config.logicsDncStatusIds || []).map((value) => Number(value)));
  if (statusIds.some((value) => dncStatusSet.has(value))) {
    return {
      reason: "logics-dnc-status",
      detail: `Case is in blocked Logics status (${statusIds.find((value) => dncStatusSet.has(value))})`,
    };
  }

  if (leadCadence && leadCadence.active === false) {
    return {
      reason: "cadence-inactive",
      detail: "Lead cadence is inactive",
    };
  }

  if (Boolean(caseProfile?.conversationAi?.optOutDetected)) {
    return {
      reason: "opt-out-detected",
      detail: "Conversation AI marked this case as opted out",
    };
  }

  const aiActivityStatus = normalizeText(caseProfile?.aiActivityReview?.status);
  if (["pause_contact", "stop_contact"].includes(aiActivityStatus)) {
    return {
      reason: aiActivityStatus === "stop_contact" ? "ai-stop-contact" : "ai-pause-contact",
      detail: `AI activity review status is ${aiActivityStatus}`,
    };
  }

  if (caseProfile?.aiCaseReview?.nextEligibleAt && new Date(caseProfile.aiCaseReview.nextEligibleAt) > now) {
    return {
      reason: "case-review-hold",
      detail: "Case review hold is still active",
    };
  }

  if (
    Boolean(caseProfile?.convertedAt) ||
    Boolean(caseProfile?.firstPaymentDate) ||
    Number(caseProfile?.paymentsCount || 0) > 0 ||
    Number(caseProfile?.totalPaid || 0) > 0
  ) {
    return {
      reason: "payment-or-converted",
      detail: "Case has payment or conversion activity and should not receive prospect cadence",
    };
  }

  // H4 (write audit, 2026-07-07): the per-channel DNC flag was invisible to every
  // dial-time gate — only queue BUILD read it, so a lead flagged AFTER its rows were
  // minted (the federal-DNC recheck, and soon the wrap-click DNC) still dialed. Every
  // dial path funnels through this function; this one check closes all gates at once.
  // Blast radius measured before landing: 16 WYNN leads carried the flag.
  const cxDnc = leadCadence?.cadenceState?.channelDnc?.cx;
  if (cxDnc && cxDnc.blocked) {
    return {
      reason: "channel-dnc-cx",
      detail: `CX channel is DNC-blocked${cxDnc.reason ? ` (${cxDnc.reason})` : ""}`,
    };
  }

  const stageSignals = [
    leadCadence?.currentStage,
    caseProfile?.scrubSummary?.status,
    caseProfile?.statusCategory,
  ].filter(Boolean).join(" | ");
  if (includesAny(stageSignals, [
    "bad inactive",
    "bad-inactive",
    "changed mind",
    "default payment",
    "do not contact",
    "dnc",
    "opt out",
    "retained",
    "closed",
    "pause",
    "stop",
  ])) {
    return {
      reason: "blocked-stage",
      detail: "Case is in a blocked lifecycle stage",
    };
  }

  if (requireFreshLogicsStatus && liveStatusId == null) {
    return {
      reason: "logics-status-check-failed",
      detail: options.liveStatusError || "Unable to verify live Logics status before contact",
      transient: true,
      destructive: false,
    };
  }

  return null;
}

function isTransientContactEligibilityBlock(result = {}) {
  if (!result || typeof result !== "object") return false;
  if (result.transient === true || result.destructive === false) return true;
  return [
    "logics-status-check-failed",
    "contact-eligibility-check-failed",
  ].includes(String(result.reason || "").trim().toLowerCase());
}

async function stopCaseContact(domain, caseId, options = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const normalizedCaseId = Number(caseId);
  const reason = options.reason || "contact-blocked";
  const detail = options.detail || null;

  const [leadCadence, cxQueue] = await Promise.all([
    leadCadenceRepository.cancelPendingActions(normalizedDomain, normalizedCaseId, {
      currentStage: options.currentStage || "contact-blocked",
    }),
    cxDialQueueRepository.cancelActiveQueueItems(normalizedDomain, normalizedCaseId, reason),
  ]);

  await recordWorkflowStage({
    domain: normalizedDomain,
    family: "outbound",
    subtype: "contact-guard",
    stage: "cancelled",
    aggregateType: "case",
    aggregateId: String(normalizedCaseId),
    caseId: normalizedCaseId,
    sourceService: options.sourceService || "contact-eligibility",
    summary: detail || `Future contact cancelled: ${reason}`,
    payload: {
      reason,
      detail,
      queueCancelledCount: Number(cxQueue?.modifiedCount || 0),
      cadenceActive: Boolean(leadCadence?.active),
    },
  });

  return {
    reason,
    detail,
    queueCancelledCount: Number(cxQueue?.modifiedCount || 0),
    leadCadence,
  };
}

async function resolveCaseContactEligibility(domain, caseId, options = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const normalizedCaseId = Number(caseId);
  const config = getSharedConfig(normalizedDomain);
  const [caseProfile, leadCadence] = await Promise.all([
    caseProfileRepository.findCaseProfile(normalizedDomain, normalizedCaseId),
    leadCadenceRepository.findLeadCadence(normalizedDomain, normalizedCaseId),
  ]);

  let liveLogicsStatus = null;
  let liveLogicsStatusError = null;
  if (options.requireFreshLogicsStatus) {
    try {
      const facade = createLogicsFacade(normalizedDomain);
      const liveCase = await facade.fetchCaseInfo(normalizedCaseId);
      if (liveCase.ok) {
        const parsed = Number(liveCase.status);
        liveLogicsStatus = Number.isFinite(parsed) ? parsed : null;
      } else {
        liveLogicsStatusError = liveCase.error || liveCase.reason || "Logics status lookup failed";
      }
    } catch (error) {
      liveLogicsStatusError = error?.message || String(error);
    }
  }

  const block = buildBlockedReason(caseProfile, leadCadence, config, options.now || new Date(), {
    liveStatusId: liveLogicsStatus,
    requireFreshLogicsStatus: options.requireFreshLogicsStatus,
    liveStatusError: liveLogicsStatusError,
  });
  if (!block) {
    return {
      ok: true,
      caseProfile,
      leadCadence,
      liveLogicsStatus,
    };
  }

  const transient = isTransientContactEligibilityBlock(block);
  const enforcement = options.enforceStop && !transient
    ? await stopCaseContact(normalizedDomain, normalizedCaseId, {
        ...block,
        currentStage: options.currentStage || "contact-blocked",
        sourceService: options.sourceService || "contact-eligibility",
      })
    : null;

  return {
    ok: false,
    skipped: true,
    reason: block.reason,
    detail: block.detail,
    transient,
    destructive: block.destructive !== false,
    caseProfile,
    leadCadence,
    liveLogicsStatus,
    liveLogicsStatusError,
    enforcement,
  };
}

// ── Upsell-contact gate (the /resolution send path ONLY) ─────────────────────
//
// Deliberately SEPARATE from buildBlockedReason: that gate blocks every paid
// client (payment-or-converted), but upsell INTENTIONALLY targets paid clients.
// This gate only ever runs on the /resolution send path, so a misconfigured
// allow-list can never block CX cadence/dialing. Fail-closed: tier-5 + reso-only
// statuses are blocked unless the case is explicitly allow-listed.

// Allow-list of caseIds permitted to receive upsell contact despite a gated
// (tier-5 / reso-only) status. Pending the operator's list — default EMPTY, so
// every gated status is blocked until explicitly allow-listed.
// Config: UPSELL_CONTACT_ALLOWLIST = JSON e.g. {"TAG":[12345,...],"WYNN":[...]}
function getUpsellContactAllowList(domain) {
  const raw = process.env.UPSELL_CONTACT_ALLOWLIST;
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // Malformed config is a DEPLOY error, not "no allow-list" — make it loud so the
    // operator doesn't chase phantom missing case-IDs. Still fail-closed (empty list).
    console.warn(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "warn",
      scope: "contact-eligibility",
      message: "upsell_allowlist.malformed_json",
      error: error.message,
    }));
    return [];
  }
  const list = parsed && parsed[normalizeDomain(domain)];
  return Array.isArray(list) ? list.map(Number).filter(Number.isFinite) : [];
}

// Eligibility for an upsell text/email/call from /resolution. dnc/optOut always
// block; tier-5 + reso-only statuses require the caseId to be allow-listed.
// allowList is injectable for tests; otherwise read from config (fail-closed).
function resolveUpsellContactEligibility({
  domain,
  statusId,
  caseId,
  optOut = false,
  dnc = false,
  allowList = null,
} = {}) {
  const normalizedDomain = normalizeDomain(domain);
  if (dnc) return { ok: false, reason: "dnc", detail: "Case is DNC" };
  if (optOut) return { ok: false, reason: "opt-out", detail: "Case opted out of contact" };

  if (isAllowListGatedStatus(normalizedDomain, statusId)) {
    const list = Array.isArray(allowList) ? allowList : getUpsellContactAllowList(normalizedDomain);
    const allowed = new Set(list.map(Number).filter(Number.isFinite));
    if (!allowed.has(Number(caseId))) {
      return {
        ok: false,
        reason: "allowlist-required",
        detail: `Status ${statusId} (tier-5/reso-only) requires allow-listing before upsell contact`,
      };
    }
  }
  return { ok: true };
}

module.exports = {
  buildBlockedReason, // exported for pins; pure
  isTransientContactEligibilityBlock,
  resolveCaseContactEligibility,
  stopCaseContact,
  getUpsellContactAllowList,
  resolveUpsellContactEligibility,
};
