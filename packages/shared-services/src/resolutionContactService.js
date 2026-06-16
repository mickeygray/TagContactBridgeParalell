"use strict";

// resolutionContactService — the /resolution upsell send backbone (single + bulk).
//
// DIRECT sender. Upsell goes to PAID clients, so it must NOT ride the prospect
// dispatch path: outboundDispatchService.dispatchForLead runs the prospect
// eligibility gate (resolveCaseContactEligibility, enforceStop) that BLOCKS
// payment-or-converted cases and cancels their action, and it validates
// primaryPhone/normalizedPhone. Instead we send through the transports directly
// (outboundTextService / outboundEmailService) behind the UPSELL-specific gate:
// resolveUpsellContactEligibility (fail-closed allow-list for tier-5/reso-only)
// + DNC (status category) + opt-out (conversationAi.optOutDetected). Heavy deps
// are lazy-required + injectable so the orchestration is fully unit-testable.

const UPSELL_CHANNELS = new Set(["sms", "email"]);

function resolveDeps(deps = {}) {
  const caseRepo = () => require("../../shared-repositories/src/caseProfileRepository");
  return {
    findCaseProfile: deps.findCaseProfile || ((domain, caseId) => caseRepo().findCaseProfile(domain, caseId)),
    appendCommunicationEntry: deps.appendCommunicationEntry || ((...a) => caseRepo().appendCommunicationEntry(...a)),
    sendText: deps.sendText || ((args) => require("./outboundTextService").sendOutboundText(args)),
    sendEmail: deps.sendEmail || ((args) => require("./outboundEmailService").sendOutboundEmail(args)),
    resolveUpsellContactEligibility: deps.resolveUpsellContactEligibility
      || require("./contactEligibilityService").resolveUpsellContactEligibility,
    resolveStatus: deps.resolveStatus || require("../../shared-config/src/statusMap").resolveStatus,
  };
}

function pickPhone(caseProfile = {}) {
  return caseProfile.primaryPhone
    || (Array.isArray(caseProfile.normalizedPhones) ? caseProfile.normalizedPhones[0] : null)
    || null;
}

function caseDisplayName(caseProfile = {}) {
  return caseProfile.name
    || [caseProfile.firstName, caseProfile.lastName].filter(Boolean).join(" ")
    || null;
}

function firstNameOf(caseProfile = {}) {
  if (caseProfile.firstName) return String(caseProfile.firstName);
  const name = caseDisplayName(caseProfile);
  return name ? String(name).trim().split(/\s+/)[0] : "";
}

// Narrow merge-field rendering for operator-written upsell messages. Keep the
// supported set explicit so unknown tokens stay visible instead of becoming blank.
function renderUpsellTemplate(content, caseProfile = {}, { domain = null, caseId = null } = {}) {
  const values = {
    firstName: firstNameOf(caseProfile),
    lastName: caseProfile.lastName ? String(caseProfile.lastName) : "",
    name: caseDisplayName(caseProfile) || "",
    caseId: caseId != null ? String(caseId) : "",
    domain: domain ? String(domain).toUpperCase() : "",
  };
  return String(content || "").replace(/\{(firstName|lastName|name|caseId|domain)\}/gi, (token, key) => {
    const canonical = String(key || "").replace(/^[A-Z]/, (c) => c.toLowerCase());
    return Object.prototype.hasOwnProperty.call(values, canonical) ? values[canonical] : token;
  });
}

// Idempotency window: don't re-send an identical upsell (same channel + body) to
// the same case within this window. Guards double-clicks / re-submits / a case
// selected in two overlapping bulk runs.
const DEDUPE_WINDOW_MS = Math.max(0, Number(process.env.RESOLUTION_UPSELL_DEDUPE_WINDOW_MS) || 6 * 60 * 60 * 1000);

// Has an identical upsell already been recorded for this case in the window? Reads
// the case's own communications (already fetched by findCaseProfile) — pure, no
// extra query. windowMs<=0 disables the check.
function isRecentDuplicate(caseProfile, { channel, content, now = new Date(), windowMs = DEDUPE_WINDOW_MS } = {}) {
  if (windowMs <= 0) return false;
  const body = String(content || "").trim();
  if (!body) return false;
  const comms = Array.isArray(caseProfile && caseProfile.communications) ? caseProfile.communications : [];
  const cutoff = (now instanceof Date ? now.getTime() : new Date(now).getTime()) - windowMs;
  return comms.some((c) =>
    c && c.source === "resolution-upsell"
    && String(c.channel || "") === channel
    && String(c.body || "").trim() === body
    && c.happenedAt && new Date(c.happenedAt).getTime() >= cutoff,
  );
}

// Send ONE upsell text/email from /resolution, DIRECT. Returns a per-case result;
// never throws for an ordinary block (eligibility/missing-channel) — only an
// unexpected dep failure can reject.
async function sendUpsellContact(input = {}, deps = {}) {
  const {
    domain, caseId, channel,
    templateKey = null, content = null, subject = null,
    actor = null, dryRun = false,
  } = input;

  const normalizedChannel = String(channel || "").toLowerCase();
  if (!UPSELL_CHANNELS.has(normalizedChannel)) {
    return { ok: false, caseId, reason: "unsupported-channel", detail: "channel must be sms or email" };
  }

  const d = resolveDeps(deps);
  const caseProfile = await d.findCaseProfile(domain, caseId);
  if (!caseProfile) return { ok: false, caseId, reason: "case-not-found" };

  const statusId = Number(caseProfile.statusId);
  const optOut = Boolean(caseProfile.conversationAi && caseProfile.conversationAi.optOutDetected);
  const dnc = String(d.resolveStatus(domain, statusId).category || "").toLowerCase() === "dnc";

  // Upsell-specific gate (NOT the prospect gate): allow-list for tier-5/reso-only,
  // plus DNC + opt-out which always block.
  const elig = d.resolveUpsellContactEligibility({ domain, statusId, caseId, optOut, dnc });
  if (!elig.ok) {
    return { ok: false, skipped: true, caseId, reason: elig.reason, detail: elig.detail };
  }

  const toPhone = pickPhone(caseProfile);
  const toEmail = caseProfile.email || null;
  if (normalizedChannel === "sms" && !toPhone) return { ok: false, skipped: true, caseId, reason: "no-phone" };
  if (normalizedChannel === "email" && !toEmail) return { ok: false, skipped: true, caseId, reason: "no-email" };
  const renderedContent = renderUpsellTemplate(content, caseProfile, { domain, caseId });
  if (!String(renderedContent || "").trim()) return { ok: false, skipped: true, caseId, reason: "empty-content" };

  if (dryRun) {
    return {
      ok: true, dryRun: true, caseId, channel: normalizedChannel, templateKey,
      to: normalizedChannel === "sms" ? toPhone : toEmail,
      content: renderedContent,
    };
  }

  // Idempotency: skip an identical recent send (double-fire / overlapping bulk).
  if (isRecentDuplicate(caseProfile, { channel: normalizedChannel, content: renderedContent })) {
    return { ok: false, skipped: true, caseId, reason: "duplicate-recent-send" };
  }

  const result = normalizedChannel === "sms"
    ? await d.sendText({ domain, toPhone, content: renderedContent, caseId })
    : await d.sendEmail({ domain, toEmail, subject: subject || "", text: renderedContent, name: caseDisplayName(caseProfile) });

  if (result && result.ok) {
    await d.appendCommunicationEntry(domain, caseId, normalizedChannel, {
      templateKey,
      body: renderedContent,
      subject,
      status: "sent",
      source: "resolution-upsell",
      providerMessageId: result.messageId || result.id || result.providerMessageId || null,
      actorEmail: actor,
      actorName: actor,
    }).catch(() => null);
  }

  return { ok: Boolean(result && result.ok), caseId, channel: normalizedChannel, result };
}

// Bulk cap — a paid-client blast guardrail (see also the route + UI confirmation).
const BULK_MAX = Math.max(1, Number(process.env.RESOLUTION_BULK_MAX || 200) || 200);

// Send to many cases (filter→select→send). Per-case isolation: one failure never
// aborts the batch. Caps the batch; the route adds confirmation + the audit trail
// is the per-case communicationThreads entry written by sendUpsellContact.
async function sendBulkUpsellContact(input = {}, deps = {}) {
  const { domain, caseIds = [], channel, templateKey = null, content = null, subject = null, actor = null, dryRun = false } = input;
  const all = Array.isArray(caseIds) ? caseIds.map(Number).filter((n) => Number.isFinite(n)) : [];
  const unique = [...new Set(all)];
  const ids = unique.slice(0, BULK_MAX);
  const droppedOverCap = Math.max(0, unique.length - ids.length);

  const results = [];
  for (const caseId of ids) {
    try {
      results.push(await sendUpsellContact({ domain, caseId, channel, templateKey, content, subject, actor, dryRun }, deps));
    } catch (error) {
      results.push({ ok: false, caseId, reason: "error", detail: error && error.message });
    }
  }
  return {
    domain,
    channel,
    requested: all.length,
    total: ids.length,
    droppedOverCap,
    cap: BULK_MAX,
    sent: results.filter((r) => r.ok && !r.dryRun).length,
    previewed: results.filter((r) => r.ok && r.dryRun).length,
    blocked: results.filter((r) => r.skipped).length,
    failed: results.filter((r) => !r.ok && !r.skipped).length,
    results,
  };
}

module.exports = {
  UPSELL_CHANNELS,
  BULK_MAX,
  renderUpsellTemplate,
  isRecentDuplicate,
  sendUpsellContact,
  sendBulkUpsellContact,
};
