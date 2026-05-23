"use strict";

const crypto = require("crypto");
const { createEvent } = require("../../event-core/src");
const { safeSecretEquals } = require("../../shared-utils/src");
const {
  createLogicsClient,
  createNeverBounceClient,
  createRealPhoneValidationClient,
  resolveCompanyByTrackingNumber,
  createTrustedFormClient,
} = require("../../shared-integrations/src");
const { env, getCompanyConfig, getInternalFromEmail, resolveCompanyFromPayload } = require("../../shared-config/src");
const {
  consentRecordRepository,
  leadCadenceRepository,
  masterProspectRepository,
  prePingRepository,
} = require("../../shared-repositories/src");
const { CONTROL_PLANE_EVENT_TYPES, createControlPlaneEvent } = require("./controlPlaneEventService");
const { recordWorkflowStage } = require("./workflowStateService");
const { createLegacyCadenceSchedule } = require("./cadencePlanService");
const { emitHourlyJobEvent } = require("./hourlyJobEventService");
const { extractCaseId, parseLogicsPayload } = require("./ncoaUploadService");
const { sendPlainEmail } = require("./sendgridMailService");

function toUpperDomain(value) {
  return String(value || "").trim().toUpperCase();
}

function cleanString(value) {
  const next = String(value || "").trim();
  return next || null;
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

function displayPhone(value) {
  const digits = normalizePhone(value);
  if (!digits || digits.length !== 10) return cleanString(value) || "N/A";
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function extractFirstValue(...values) {
  for (const value of values) {
    const next = cleanString(value);
    if (next) return next;
  }
  return null;
}

function extractLeadEmail(payload = {}) {
  return extractFirstValue(
    payload.email,
    payload.Email,
    payload.emailAddress,
    payload.email_address,
    payload.em,
  );
}

function extractLeadPhone(payload = {}) {
  return normalizePhone(
    payload.phone ||
      payload.primaryPhone ||
      payload.cellPhone ||
      payload.mobile ||
      payload.tel ||
      payload.phoneNumber ||
      payload.phone_number ||
      payload.ph,
  );
}

function extractLeadCity(payload = {}) {
  return extractFirstValue(payload.city, payload.City, payload.ct);
}

function extractLeadState(payload = {}) {
  return extractFirstValue(payload.state, payload.State, payload.st);
}

function extractLeadZip(payload = {}) {
  return extractFirstValue(
    payload.zip,
    payload.Zip,
    payload.zipCode,
    payload.zip_code,
    payload.postalCode,
    payload.postal_code,
    payload.zi,
  );
}

function extractLeadAddress(payload = {}) {
  return extractFirstValue(
    payload.address,
    payload.address1,
    payload.street,
    payload.streetAddress,
    payload.street_address,
    payload.addr,
    payload.ad,
  );
}

function extractTrustedFormCertUrl(payload = {}) {
  return extractFirstValue(
    payload.trustedFormCertUrl,
    payload.trustedform_cert_url,
    payload.trusted_form_cert_url,
    payload.xxTrustedFormCertUrl,
    payload.xxTrustedFormCertURL,
    payload.tcpa_cert_url,
    payload.trustedFormUrl,
    payload.tf,
  );
}

function extractJornayaLeadId(payload = {}) {
  return extractFirstValue(
    payload.jornayaLeadId,
    payload.jornaya_lead_id,
    payload.leadid_token,
    payload.leadIdToken,
    payload.jornayaId,
    payload.jl,
  );
}

function extractClientIp(headers = {}) {
  const forwarded = String(
    headers["x-forwarded-for"] ||
      headers["cf-connecting-ip"] ||
      headers["x-real-ip"] ||
      "",
  ).trim();

  if (!forwarded) return null;
  return cleanString(forwarded.split(",")[0]);
}

function extractAffiliatePostbackUrl(payload = {}) {
  return extractFirstValue(
    payload.postback_url,
    payload.postbackUrl,
    payload.callback_url,
    payload.callbackUrl,
    payload.return_url,
    payload.returnUrl,
    payload.result_url,
    payload.resultUrl,
    payload.ping_url,
  );
}

function extractPayloadTrackingNumber(payload = {}) {
  return normalizePhone(
    payload.trackingNumber ||
      payload.tracking_number ||
      payload.destination_number ||
      payload.destinationNumber ||
      payload.callrailTrackingNumber ||
      payload.callrail_tracking_number,
  );
}

function resolveCompanyFromTrackingOrPayload(payload = {}, headers = {}) {
  const trackingNumber = extractPayloadTrackingNumber(payload);
  const resolvedByTracking =
    trackingNumber && trackingNumber.length === 10
      ? resolveCompanyByTrackingNumber(trackingNumber)
      : null;
  return toUpperDomain(resolvedByTracking || resolveCompanyFromPayload(payload, headers));
}

function resolveLeadTrackingNumber(normalized = {}, companyConfig = null) {
  const payload = normalized.payloadSnapshot || {};
  const companyTracking = normalizePhone(
    companyConfig?.integrations?.callrail?.trackingNumber ||
      companyConfig?.callrailTrackingNumber,
  );
  if (normalized.lockContactDomain && companyTracking && companyTracking.length === 10) {
    return companyTracking;
  }

  const explicit = extractPayloadTrackingNumber(payload);
  if (explicit && explicit.length === 10) return explicit;

  if (companyTracking && companyTracking.length === 10) return companyTracking;
  return null;
}

const ROUTE_CAMPAIGNS = Object.freeze({
  ld: {
    key: "ld",
    name: "LD Lead",
    sourceChannel: "lead-distribution",
    logicsSourceName: "LD Posting",
  },
  "ld-posting": {
    key: "ld",
    name: "LD Posting Lead",
    sourceChannel: "lead-distribution",
    logicsSourceName: "LD Posting",
  },
  // LD queue split: vendor posts include either `ldcustom` or
  // `ldgeneral` to indicate which sub-bucket the lead belongs to.
  // We surface the split as a distinct routeCampaignKey so queue
  // filtering can fan out without re-parsing the snapshot.
  "ld-custom": {
    key: "ld-custom",
    name: "LD CUSTOM",
    sourceChannel: "lead-distribution",
    logicsSourceName: "LD CUSTOM",
    logicsCampaignName: "LD CUSTOM",
  },
  "ld-general": {
    key: "ld-general",
    name: "LD GENERAL",
    sourceChannel: "lead-distribution",
    logicsSourceName: "LD GENERAL",
    logicsCampaignName: "LD GENERAL",
  },
  affiliate: {
    key: "affiliate",
    name: "Affiliate Lead",
    sourceChannel: "affiliate",
    logicsSourceName: "Affiliate - OEV4LL6O",
  },
});

// NOTE(ld-queue-split): producer side of the LD queue split.
// Consumer side is in cxWorkspaceService.js (materializeQueueSupplyForAgent
// + maybeRefillCxQueueForAgent) and cxQueuePolicyService.js
// (resolveAccountQueuePolicy). Grep `TODO(ld-queue-split)` for the
// implementation breadcrumbs.
//
// LD queue-split detection by VALUE, not by field name.
//
// Each LD sub-bucket has a fixed opaque tracking code that the vendor
// drops into the payload. The field name varies (we've seen `"source ID"`
// with a space in production samples, but it could just as easily be
// `pubid` / `subid` / `partnerId` depending on the partner's posting
// template). The CODE is stable; the carrier field is not.
//
// Bucket mapping (vendor-supplied):
//   GS03RB7W → LD CUSTOM   queue
//   JM8K5B7Y → LD GENERAL  queue
//
// Both can be overridden via env (LD_CUSTOM_CODE / LD_GENERAL_CODE)
// if the vendor ever rotates the codes — no code change needed.
function canonicalLdBucketValue(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function addLdBucketMatchers(map, values, match) {
  for (const value of values) {
    const canonical = canonicalLdBucketValue(value);
    if (canonical) map.set(canonical, match);
  }
}

function parseLdBucketAliases(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getLdBucketCodeMap() {
  const customCode = String(process.env.LD_CUSTOM_CODE || "GS03RB7W").trim();
  const generalCode = String(process.env.LD_GENERAL_CODE || "JM8K5B7Y").trim();
  const map = new Map();
  const customMatch = {
    kind: "custom",
    campaignKey: "ld-custom",
    label: "LD CUSTOM",
    code: customCode || null,
  };
  const generalMatch = {
    kind: "general",
    campaignKey: "ld-general",
    label: "LD GENERAL",
    code: generalCode || null,
  };
  if (customCode) {
    addLdBucketMatchers(map, [customCode], customMatch);
  }
  if (generalCode) {
    addLdBucketMatchers(map, [generalCode], generalMatch);
  }
  addLdBucketMatchers(
    map,
    [
      "ldcustom",
      "ld custom",
      "LD Custom",
      "Wynn Tax Custom",
      "Wynn Custom",
      ...parseLdBucketAliases(process.env.LD_CUSTOM_ALIASES),
    ],
    customMatch,
  );
  addLdBucketMatchers(
    map,
    [
      "ldgeneral",
      "ld general",
      "LD General",
      "Wynn Tax General",
      "Wynn General",
      ...parseLdBucketAliases(process.env.LD_GENERAL_ALIASES),
    ],
    generalMatch,
  );
  return map;
}

function extractLdSubsource(payload = {}) {
  if (!payload || typeof payload !== "object") return null;
  const bucketByCode = getLdBucketCodeMap();
  if (bucketByCode.size === 0) return null;

  // Scan top-level payload values for a bucket code match. We only
  // walk one level deep — these codes always arrive at the top of the
  // POST body / query string, never buried inside nested objects.
  // Case-insensitive compare so a casing typo doesn't blackhole a lead.
  for (const [fieldName, rawValue] of Object.entries(payload)) {
    if (rawValue == null) continue;
    if (typeof rawValue !== "string" && typeof rawValue !== "number") continue;
    const value = String(rawValue).trim();
    if (!value) continue;
    const match = bucketByCode.get(canonicalLdBucketValue(value));
    if (match) {
      return {
        kind: match.kind,
        campaignKey: match.campaignKey,
        label: match.label,
        value,                              // "GS03RB7W"
        sourceFieldName: fieldName,         // "source ID"
      };
    }
  }
  return null;
}

function extractVendorSourceName(payload = {}) {
  return extractFirstValue(
    payload.vendorSourceName,
    payload.sourceName,
    payload.partner,
    payload.vendor,
    payload.affiliate,
    payload.source,
    payload.trafficSource,
    payload.utm_source,
    payload.pubid,
    payload.campid,
    payload.compid,
    payload.affid,
    payload.subid,
    payload.url,
  );
}

function extractPartnerSourceName(payload = {}) {
  return extractFirstValue(
    payload.partner,
    payload.vendor,
    payload.affiliate,
    payload.source,
    payload.trafficSource,
    payload.utm_source,
    payload.sourceName,
    payload.pubid,
    payload.campid,
    payload.compid,
    payload.affid,
    payload.subid,
    payload.url,
  );
}

function routeCampaignFor(intakeSource) {
  return ROUTE_CAMPAIGNS[String(intakeSource || "").trim().toLowerCase()] || null;
}

function resolveLogicsSourceName(normalized = {}) {
  const explicit = cleanString(normalized.logicsSourceName);
  if (explicit) return explicit;

  const campaign = routeCampaignFor(normalized.intakeSource);
  if (
    campaign &&
    normalized.routeCampaignKey === campaign.key &&
    normalized.routeCampaignName === campaign.name
  ) {
    return campaign.logicsSourceName || campaign.name;
  }

  return normalized.sourceName || normalized.intakeSource;
}

function resolveLogicsCampaignName(normalized = {}) {
  const explicit = cleanString(normalized.logicsCampaignName);
  if (explicit) return explicit;
  return null;
}

function describeLeadSource(normalized = {}, companyConfig = null) {
  const brandName = cleanString(companyConfig?.name) || normalized.domain || "Unknown Brand";
  const sourceName = cleanString(normalized.sourceName);
  const intakeSource = cleanString(normalized.intakeSource);

  const map = {
    facebook: { emoji: "BLUE CIRCLE", label: "Facebook Ad" },
    instagram: { emoji: "CAMERA", label: "Instagram Ad" },
    tiktok: { emoji: "MUSICAL NOTE", label: "TikTok Ad" },
    ld: { emoji: "TELEPHONE RECEIVER", label: "LD Lead" },
    "ld-posting": { emoji: "TELEPHONE RECEIVER", label: "LD Posting" },
    affiliate: { emoji: "HANDSHAKE", label: "Lead Form Affiliate" },
    vf: { emoji: "GLOBE WITH MERIDIANS", label: `${brandName} Landing Page` },
    website: { emoji: "GLOBE WITH MERIDIANS", label: `${brandName} Website Lead` },
    organic: { emoji: "LEAF FLUTTERING IN WIND", label: `${brandName} Organic Lead` },
    lexis: { emoji: "OPEN MAILBOX WITH RAISED FLAG", label: "Lexis Mailer Lead" },
    "lexis-sftp": { emoji: "OPEN MAILBOX WITH RAISED FLAG", label: "Lexis Mailer Lead" },
  };

  const entry = map[intakeSource] || null;
  return {
    emoji: entry?.emoji || "CLIPBOARD",
    label: sourceName || entry?.label || intakeSource || "Unknown Source",
  };
}

function buildLeadAlertText(normalized = {}, caseId, validation = {}, companyConfig = null) {
  // Lean alert body: name / email / phone / case / DNC status. Subject
  // already carries vendor + brand + case id; the body is the
  // operator-glance summary. Verbose route/source/tracking/payload
  // details have been moved to the workflow record + observability
  // panels where they belong — the email is for human triage, not
  // structured data dump.
  const dncStatus = (() => {
    const flags = [];
    if (validation?.phone?.isLitigator) flags.push("Litigator");
    if (validation?.phone?.onNationalDNC) flags.push("National DNC");
    if (validation?.phone?.onStateDNC) flags.push("State DNC");
    if (flags.length === 0) return "Clear";
    return flags.join(" + ");
  })();

  return [
    `Name:   ${cleanString(normalized.name) || [normalized.firstName, normalized.lastName].filter(Boolean).join(" ") || "N/A"}`,
    `Email:  ${cleanString(normalized.email) || "N/A"}`,
    `Phone:  ${displayPhone(normalized.primaryPhone)}`,
    `Case:   ${caseId || "Not created"}`,
    `DNC:    ${dncStatus}`,
  ].join("\n");
}

async function sendInboundLeadAlertEmail(normalized = {}, caseId, validation = {}, options = {}) {
  const companyConfig = options.companyConfig || getCompanyConfig(normalized.domain);
  const toEmail = cleanString(companyConfig?.toEmail) || cleanString(companyConfig?.alertEmail);
  if (!toEmail) {
    return { ok: false, skipped: true, reason: "missing-alert-address" };
  }
  const mailerCompany =
    cleanString(options.mailerCompany) ||
    cleanString(env("INBOUND_LEAD_ALERT_EMAIL_COMPANY", "TAG")) ||
    "TAG";
  // Internal new-lead alert (channel: "lead-alert") — replies should
  // route to a human inbox, not a branded `team@` shared box. Send
  // from the Parallel-internal sender; brand still appears in the
  // "$NAME Leads" display name + the [DOMAIN] subject tag.
  const fromEmail = getInternalFromEmail();

  const source = describeLeadSource(normalized, companyConfig);
  const subject =
    `[${normalized.domain}] ${source.label} - ${cleanString(normalized.name) || "Unknown"} ` +
    `${caseId ? `| Case #${caseId}` : "| No Case ID"}`;
  const text = buildLeadAlertText(normalized, caseId, validation, companyConfig);

  await sendPlainEmail(mailerCompany, {
    personalizations: [
      {
        to: [{ email: toEmail }],
        custom_args: {
          company: normalized.domain,
          mailerCompany,
          channel: "lead-alert",
          intakeSource: cleanString(normalized.intakeSource) || "unknown",
          intakeRoute: cleanString(normalized.intakeRoute) || "unknown",
          caseId: caseId != null ? String(caseId) : "",
        },
      },
    ],
    from: {
      email: fromEmail,
      name: `${cleanString(companyConfig?.name) || normalized.domain} Leads`,
    },
    reply_to: {
      email: fromEmail,
      name: `${cleanString(companyConfig?.name) || normalized.domain} Leads`,
    },
    subject,
    content: [
      {
        type: "text/plain",
        value: text,
      },
    ],
  });

  return { ok: true, toEmail, subject, mailerCompany };
}

async function sendAffiliatePostback(postbackUrl, body, options = {}) {
  const url = cleanString(postbackUrl);
  if (!url) {
    return { ok: false, skipped: true, reason: "missing-postback-url" };
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "parallel-affiliate-postback/1.0",
      ...(options.secret
        ? { "x-webhook-secret": options.secret }
        : {}),
    },
    body: JSON.stringify(body || {}),
  });

  let responseBody = null;
  try {
    responseBody = await response.text();
  } catch {
    responseBody = null;
  }

  if (!response.ok) {
    throw new Error(
      `Affiliate postback failed (${response.status})${responseBody ? `: ${String(responseBody).slice(0, 300)}` : ""}`,
    );
  }

  return {
    ok: true,
    status: response.status,
    body: responseBody,
  };
}

async function notifyAffiliatePostback(payload = {}, result = {}, options = {}) {
  const postbackUrl = extractAffiliatePostbackUrl(payload);
  if (!postbackUrl) {
    return { ok: false, skipped: true, reason: "missing-postback-url" };
  }

  const derivedName = deriveNameFields(payload);
  const normalizedPhone = normalizePhone(
    payload.phone || payload.primaryPhone || payload.cellPhone || payload.mobile || payload.tel,
  );
  const normalizedEmail = cleanString(payload.email);
  const normalizedCity = cleanString(payload.city);
  const normalizedState = cleanString(payload.state);
  const normalizedSource = cleanString(payload.source || payload.trafficSource || "lead-form-affiliate");
  const normalizedCompany =
    result?.domain || resolveCompanyFromTrackingOrPayload(payload, options.headers || {});
  const normalizedAffiliatePartner = cleanString(
    payload.affiliatePartner || payload.partner || payload.vendor || payload.affiliate,
  );
  const normalizedAffiliateNid = cleanString(payload.affiliateNid);
  const normalizedAffiliateClickId = cleanString(payload.affiliateClickId);
  const normalizedAffiliateReferer = cleanString(payload.affiliateReferer);
  const normalizedAffiliateSub1 = cleanString(payload.affiliateSub1);
  const normalizedAffiliateSub2 = cleanString(payload.affiliateSub2);
  const normalizedTrustedFormCertUrl = extractTrustedFormCertUrl(payload);
  const normalizedJornayaLeadId = extractJornayaLeadId(payload);

  const body = {
    ok: Boolean(result?.accepted),
    accepted: Boolean(result?.accepted),
    domain: normalizedCompany,
    company: normalizedCompany,
    caseId: result?.caseId != null ? Number(result.caseId) : null,
    leadCadenceId: result?.leadCadenceId || null,
    intakeSource: "affiliate",
    intakeRoute: "affiliate-lead",
    externalLeadId:
      cleanString(payload.externalLeadId || payload.lead_id || payload.leadId || payload.id || payload.contactId) ||
      null,
    firstName: derivedName.firstName,
    lastName: derivedName.lastName,
    name: derivedName.name,
    phone: normalizedPhone,
    email: normalizedEmail,
    city: normalizedCity,
    state: normalizedState,
    message: cleanString(payload.message),
    source: normalizedSource,
    trafficSource: cleanString(payload.trafficSource),
    sourceName: cleanString(payload.sourceName || payload.partner || payload.vendor || payload.affiliate || payload.source),
    partnerSource: cleanString(payload.partner || payload.vendor || payload.source || payload.affiliate),
    affiliatePartner: normalizedAffiliatePartner,
    affiliateNid: normalizedAffiliateNid,
    affiliateClickId: normalizedAffiliateClickId,
    affiliateReferer: normalizedAffiliateReferer,
    affiliateHasClickId: Boolean(normalizedAffiliateClickId),
    affiliateSub1: normalizedAffiliateSub1,
    affiliateSub2: normalizedAffiliateSub2,
    trustedFormCertUrl: normalizedTrustedFormCertUrl,
    jornayaLeadId: normalizedJornayaLeadId,
    statusCode: result?.statusCode || null,
    error: result?.error || null,
    code: result?.code || null,
    happenedAt: new Date().toISOString(),
  };

  return sendAffiliatePostback(postbackUrl, body, {
    secret: options.postbackSecret || null,
  });
}

function calculateAge(dob) {
  const next = String(dob || "").trim();
  if (!next) return null;

  const birthDate = new Date(next);
  if (Number.isNaN(birthDate.getTime())) return null;

  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();
  if (
    monthDiff < 0 ||
    (monthDiff === 0 && today.getDate() < birthDate.getDate())
  ) {
    age -= 1;
  }
  return age;
}

function normalizeState(state) {
  const next = cleanString(state);
  return next ? next.toUpperCase().slice(0, 2) : null;
}

function normalizeNamePart(value, fallback = null) {
  const compact = String(value || "")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact || compact.includes("@") || /\d/.test(compact)) return fallback;

  const normalizeToken = (token) => {
    const lower = String(token || "").toLowerCase();
    if (!lower) return "";
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  };

  const normalized = compact
    .split(" ")
    .map((word) =>
      word
        .split("-")
        .map((piece) =>
          piece
            .split("'")
            .map(normalizeToken)
            .filter(Boolean)
            .join("'"),
        )
        .filter(Boolean)
        .join("-"),
    )
    .filter(Boolean)
    .join(" ");

  return normalized || fallback;
}

function normalizeFullName(value) {
  const compact = String(value || "")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) return null;
  return compact
    .split(" ")
    .map((part) => normalizeNamePart(part))
    .filter(Boolean)
    .join(" ") || null;
}

function computeEmailHash(email) {
  const normalizedEmail = cleanString(email);
  if (!normalizedEmail) return null;

  return crypto
    .createHash("md5")
    .update(normalizedEmail.toLowerCase())
    .digest("hex");
}

function normalizeEmailHash(candidateHash, fallbackEmail) {
  for (const value of [candidateHash, fallbackEmail]) {
    const candidate = cleanString(value);
    if (candidate && /^[a-f0-9]{32}$/i.test(candidate)) {
      return candidate.toLowerCase();
    }
  }

  return computeEmailHash(fallbackEmail || candidateHash);
}

function splitName(fullName) {
  const raw = normalizeFullName(fullName);
  if (!raw) {
    return { firstName: null, lastName: null, name: null };
  }

  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return {
      firstName: normalizeNamePart(parts[0]),
      lastName: "Prospect",
      name: normalizeNamePart(parts[0]),
    };
  }

  return {
    firstName: normalizeNamePart(parts[0]),
    lastName: normalizeNamePart(parts.slice(1).join(" "), "Prospect"),
    name: raw,
  };
}

function deriveNameFields(payload = {}) {
  const firstName = normalizeNamePart(
    extractFirstValue(
      payload.firstName,
      payload.first_name,
      payload.firstname,
      payload.givenName,
      payload.given_name,
      payload.fname,
      payload.fn,
    ),
  );
  const lastName = normalizeNamePart(
    extractFirstValue(
      payload.lastName,
      payload.last_name,
      payload.lastname,
      payload.surname,
      payload.lname,
      payload.ln,
    ),
  );
  const fullName = normalizeFullName(
    extractFirstValue(payload.name, payload.fullName, payload.full_name, payload.nm),
  );

  if (firstName || lastName) {
    const resolvedLastName = lastName || "Prospect";
    return {
      firstName: firstName || null,
      lastName: resolvedLastName,
      name: fullName || [firstName, resolvedLastName].filter(Boolean).join(" ") || null,
    };
  }

  return splitName(fullName);
}

function buildExternalLeadId(prefix, payload = {}) {
  const explicit = cleanString(
    payload.externalLeadId ||
      payload.external_id ||
      payload.lead_id ||
      payload.leadId ||
      payload.id ||
      payload.contactId ||
      payload.contact_id ||
      payload.subid ||
      payload.clickId ||
      payload.clickid,
  );

  if (explicit) return explicit;

  const digest = crypto
    .createHash("sha1")
    .update(JSON.stringify(payload))
    .digest("hex")
    .slice(0, 16);

  return `${prefix}-${digest}`;
}

function normalizeWebsiteLeadPayload(payload = {}, headers = {}) {
  const domain = resolveCompanyFromTrackingOrPayload(payload, headers);
  const nameFields = deriveNameFields(payload);
  const phone = extractLeadPhone(payload);
  const email = extractLeadEmail(payload);
  const city = extractLeadCity(payload);
  const state = extractLeadState(payload);

  return {
    domain,
    intakeRoute: "website-post",
    intakeSource: "website",
    partnerSource:
      extractPartnerSourceName(payload) || cleanString(payload.website || "website"),
    sourceChannel: "website",
    sourceName: cleanString(
      payload.sourceName ||
        payload.source ||
        payload.form_name ||
        payload.campid ||
        payload.pubid ||
        "Website Lead",
    ),
    logicsSourceName: cleanString(payload.logicsSourceName || payload.SourceName),
    logicsCampaignName: cleanString(
      payload.logicsCampaignName ||
      payload.CampaignName ||
      payload.campaignName ||
      payload.routeCampaignName ||
      payload.campaign,
    ),
    sourceId: Number.isFinite(Number(payload.sourceId)) ? Number(payload.sourceId) : null,
    routeCampaignKey: cleanString(payload.routeCampaignKey || payload.campaignKey),
    routeCampaignName: cleanString(
      payload.routeCampaignName || payload.campaignName || payload.campaign || payload.campid,
    ),
    vendorSourceName: extractVendorSourceName(payload),
    externalLeadId: buildExternalLeadId("website", payload),
    firstName: nameFields.firstName,
    lastName: nameFields.lastName,
    name: nameFields.name,
    email,
    primaryPhone: phone,
    city,
    state,
    address: extractLeadAddress(payload),
    zip: extractLeadZip(payload),
    dateOfBirth: extractFirstValue(payload.dateOfBirth, payload.date_of_birth, payload.dob, payload.DOB),
    gender: extractFirstValue(payload.gender, payload.gn),
    sourceUrl: extractFirstValue(payload.sourceUrl, payload.source_url, payload.url, payload.referer),
    vendorCampaignId: extractFirstValue(payload.vendorCampaignId, payload.campaignId, payload.campid),
    vendorPublisherId: extractFirstValue(payload.vendorPublisherId, payload.publisherId, payload.pubid),
    vendorCompanyId: extractFirstValue(payload.vendorCompanyId, payload.companyId, payload.compid),
    trustedFormCertUrl: extractTrustedFormCertUrl(payload),
    jornayaLeadId: extractJornayaLeadId(payload),
    receivedIp: extractClientIp(headers),
    receivedUserAgent: cleanString(headers["user-agent"]),
    caseId: payload.caseId != null ? Number(payload.caseId) : null,
    payloadSnapshot: payload,
  };
}

function applyLeadOverrides(normalized, overrides = {}) {
  return {
    ...normalized,
    domain: overrides.domain || normalized.domain,
    contactDomain: overrides.contactDomain || normalized.contactDomain || null,
    lockContactDomain:
      overrides.lockContactDomain !== undefined
        ? Boolean(overrides.lockContactDomain)
        : Boolean(normalized.lockContactDomain),
    intakeRoute: overrides.intakeRoute || normalized.intakeRoute,
    intakeSource: overrides.intakeSource || normalized.intakeSource,
    partnerSource: overrides.partnerSource || normalized.partnerSource,
    sourceChannel: overrides.sourceChannel || normalized.sourceChannel,
    sourceName: overrides.sourceName || normalized.sourceName,
    logicsSourceName: overrides.logicsSourceName || normalized.logicsSourceName || null,
    logicsCampaignName: overrides.logicsCampaignName || normalized.logicsCampaignName || null,
    routeCampaignKey: overrides.routeCampaignKey || normalized.routeCampaignKey || null,
    routeCampaignName: overrides.routeCampaignName || normalized.routeCampaignName || null,
    vendorSourceName: overrides.vendorSourceName || normalized.vendorSourceName || null,
    payloadSnapshot: overrides.payloadSnapshot || normalized.payloadSnapshot,
  };
}

function forceWynnContactDomain(normalized = {}) {
  return {
    ...normalized,
    domain: "WYNN",
    contactDomain: "WYNN",
    lockContactDomain: true,
    payloadSnapshot: {
      ...(normalized.payloadSnapshot || {}),
      contactDomain: "WYNN",
      lockContactDomain: true,
    },
  };
}

// Lock contactDomain to whatever resolveCompanyFromPayload already
// picked off the request body / referer / tracking number. Used by the
// website-form intake path, where TAG and WYNN sales pages both POST
// through the same /lead-contact route but stamp `company: "TAG"` /
// `company: "WYNN"` into the payload. Previously this path always
// forced WYNN (legacy artifact from when TAG had no public form), which
// caused TAG sales-page leads to land in the Wynn tenant.
function lockResolvedContactDomain(normalized = {}) {
  const resolved = normalized.domain || "WYNN";
  return {
    ...normalized,
    domain: resolved,
    contactDomain: resolved,
    lockContactDomain: true,
    payloadSnapshot: {
      ...(normalized.payloadSnapshot || {}),
      contactDomain: resolved,
      lockContactDomain: true,
    },
  };
}

function normalizeLdLeadPayload(payload = {}, headers = {}, options = {}) {
  const normalized = normalizeWebsiteLeadPayload(payload, headers);
  const prePing = options.prePing || null;
  const intakeSource = prePing ? "ld-posting" : "ld";
  const baseCampaign = routeCampaignFor(intakeSource);

  // Detect the LD queue-split signal. When `ldcustom` or `ldgeneral`
  // is present on the payload, route to the matching sub-campaign
  // (`ld-custom` / `ld-general`) and stamp the human-readable bucket
  // label (`LD CUSTOM` / `LD GENERAL`) onto partnerSource + vendorSourceName
  // so the cadence row is self-describing. The raw vendor tracking
  // code (e.g. GS03RB7W) is preserved in payloadSnapshot for audits.
  // When absent we fall back to the plain `ld` campaign — existing
  // intake behavior unchanged.
  const ldSub = extractLdSubsource(payload);
  const campaign = ldSub
    ? routeCampaignFor(ldSub.campaignKey) || baseCampaign
    : baseCampaign;

  const partnerSource = ldSub?.label
    || extractPartnerSourceName(payload)
    || "ld";
  const vendorSourceName = ldSub?.label
    || extractVendorSourceName(payload)
    || "ld";
  const logicsSourceName = campaign.logicsSourceName || campaign.name;
  const logicsCampaignName = campaign.logicsCampaignName || null;

  return applyLeadOverrides(normalized, {
    domain: "WYNN",
    contactDomain: "WYNN",
    lockContactDomain: true,
    intakeRoute: prePing ? "ld-posting-lead" : "ld-lead",
    intakeSource,
    partnerSource,
    sourceChannel: campaign.sourceChannel,
    sourceName: logicsSourceName,
    logicsSourceName,
    logicsCampaignName,
    routeCampaignKey: campaign.key,
    routeCampaignName: campaign.name,
    vendorSourceName,
    payloadSnapshot: {
      ...normalized.payloadSnapshot,
      routeCampaignKey: campaign.key,
      routeCampaignName: campaign.name,
      vendorSourceName,
      logicsSourceName,
      logicsCampaignName,
      SourceName: logicsSourceName,
      CampaignName: logicsCampaignName,
      contactDomain: "WYNN",
      lockContactDomain: true,
      prePingCallbackUrl: prePing?.callbackUrl || null,
      // Preserve the raw subsource value + the bucket label so future
      // tooling can re-derive the split without having to re-parse
      // the original webhook body.
      ldSubsourceKind: ldSub?.kind || null,         // "custom" | "general" | null
      ldSubsourceLabel: ldSub?.label || null,       // "LD CUSTOM" | "LD GENERAL"
      ldSubsourceValue: ldSub?.value || null,       // "GS03RB7W"
      ldSubsourceField: ldSub?.sourceFieldName || null,
    },
  });
}

function normalizeAffiliateLeadPayload(payload = {}, headers = {}) {
  const normalized = normalizeWebsiteLeadPayload(payload, headers);
  const campaign = routeCampaignFor("affiliate");
  const partnerSource = extractPartnerSourceName(payload) || "affiliate";
  const vendorSourceName = extractVendorSourceName(payload) || "affiliate";

  return applyLeadOverrides(normalized, {
    domain: "WYNN",
    contactDomain: "WYNN",
    lockContactDomain: true,
    intakeRoute: "affiliate-lead",
    intakeSource: "affiliate",
    partnerSource,
    sourceChannel: campaign.sourceChannel,
    sourceName: campaign.logicsSourceName || campaign.name,
    logicsSourceName: campaign.logicsSourceName || campaign.name,
    routeCampaignKey: campaign.key,
    routeCampaignName: campaign.name,
    vendorSourceName,
    payloadSnapshot: {
      ...normalized.payloadSnapshot,
      routeCampaignKey: campaign.key,
      routeCampaignName: campaign.name,
      vendorSourceName,
      contactDomain: "WYNN",
      lockContactDomain: true,
    },
  });
}

function normalizeFacebookLeadPayload(payload = {}, headers = {}) {
  const domain = resolveCompanyFromTrackingOrPayload(payload, headers);
  const nameFields = deriveNameFields(payload);
  const fieldData = Array.isArray(payload.field_data) ? payload.field_data : [];
  const mapped = Object.fromEntries(
    fieldData.map((entry) => [String(entry.name || "").toLowerCase(), Array.isArray(entry.values) ? entry.values[0] : entry.values]),
  );
  const phone = normalizePhone(mapped.phone_number || mapped.phone || payload.phone_number || payload.phone);

  return {
    domain,
    intakeRoute: "facebook-lead",
    intakeSource: "facebook",
    partnerSource: cleanString(payload.platform || "facebook"),
    sourceChannel: "social",
    sourceName: cleanString(payload.ad_name || payload.campaign_name || "Facebook Lead"),
    externalLeadId: buildExternalLeadId("facebook", payload),
    firstName: nameFields.firstName || cleanString(mapped.first_name),
    lastName: nameFields.lastName || cleanString(mapped.last_name) || "Prospect",
    name: nameFields.name || cleanString(mapped.full_name),
    email: cleanString(mapped.email || payload.email),
    primaryPhone: phone,
    city: cleanString(mapped.city),
    state: cleanString(mapped.state),
    trustedFormCertUrl: extractTrustedFormCertUrl(payload),
    jornayaLeadId: extractJornayaLeadId(payload),
    receivedIp: extractClientIp(headers),
    receivedUserAgent: cleanString(headers["user-agent"]),
    caseId: payload.caseId != null ? Number(payload.caseId) : null,
    payloadSnapshot: payload,
  };
}

function normalizeInstagramLeadPayload(payload = {}, headers = {}) {
  const normalized = normalizeFacebookLeadPayload(payload, headers);
  return {
    ...normalized,
    intakeRoute: "instagram-lead",
    intakeSource: "instagram",
    partnerSource: cleanString(payload.platform || "instagram"),
    sourceName: cleanString(payload.ad_name || payload.campaign_name || "Instagram Lead"),
  };
}

function normalizeTikTokLeadPayload(payload = {}, headers = {}) {
  const domain = resolveCompanyFromTrackingOrPayload(payload, headers);
  const nameFields = deriveNameFields(payload);
  const phone = normalizePhone(
    payload.phone_number || payload.phone || payload.cellPhone || payload.mobile,
  );

  return {
    domain,
    intakeRoute: "tiktok-lead",
    intakeSource: "tiktok",
    partnerSource: cleanString(payload.channel || payload.source || "tiktok"),
    sourceChannel: "social",
    sourceName: cleanString(payload.campaign_name || payload.adgroup_name || "TikTok Lead"),
    externalLeadId: buildExternalLeadId("tiktok", payload),
    firstName: nameFields.firstName,
    lastName: nameFields.lastName,
    name: nameFields.name,
    email: cleanString(payload.email),
    primaryPhone: phone,
    city: cleanString(payload.city),
    state: cleanString(payload.state),
    trustedFormCertUrl: extractTrustedFormCertUrl(payload),
    jornayaLeadId: extractJornayaLeadId(payload),
    receivedIp: extractClientIp(headers),
    receivedUserAgent: cleanString(headers["user-agent"]),
    caseId: payload.caseId != null ? Number(payload.caseId) : null,
    payloadSnapshot: payload,
  };
}

async function writeConsentRecord(normalized, caseId, options = {}) {
  const hasIdentity = Boolean(normalized.email || normalized.primaryPhone || caseId);
  const hasConsentArtifact = Boolean(normalized.trustedFormCertUrl || normalized.jornayaLeadId);

  if (!hasIdentity && !hasConsentArtifact) {
    return null;
  }

  return consentRecordRepository.createConsentRecord({
    domain: normalized.domain,
    company: normalized.domain,
    source: normalized.partnerSource || normalized.sourceName || normalized.intakeSource,
    caseId: caseId != null ? Number(caseId) : null,
    email: normalized.email,
    phone: normalized.primaryPhone,
    trustedFormCertUrl: normalized.trustedFormCertUrl,
    jornayaLeadId: normalized.jornayaLeadId,
    receivedAt: options.now || new Date(),
    ip: normalized.receivedIp || null,
    userAgent: normalized.receivedUserAgent || null,
    intakeRoute: normalized.intakeRoute,
    intakeSource: normalized.intakeSource,
    payloadSnapshot: normalized.payloadSnapshot,
  });
}

async function checkInTrustedFormCertificate(normalized, options = {}) {
  if (!normalized.trustedFormCertUrl) {
    return { ok: false, skipped: true, reason: "missing-cert-url" };
  }

  const trustedFormClient = createTrustedFormClient();

  try {
    return await trustedFormClient.checkInCertificate(normalized.trustedFormCertUrl);
  } catch (error) {
    if (options.logger && typeof options.logger.warn === "function") {
      options.logger.warn("trustedform.checkin.failed", {
        error: error.message,
        domain: normalized.domain,
        intakeRoute: normalized.intakeRoute,
        caseId: options.caseId != null ? Number(options.caseId) : null,
      });
    }

    return {
      ok: false,
      skipped: false,
      reason: "check-in-failed",
      error: error.message,
    };
  }
}

function buildValidationFallback(normalized = {}) {
  const hasPhone = Boolean(normalized.primaryPhone);
  const hasEmail = Boolean(normalized.email);

  return {
    phone: hasPhone
      ? {
          status: "validation-error",
          isConnected: true,
          isCell: true,
          onNationalDNC: false,
          onStateDNC: false,
          onDMA: false,
          isLitigator: false,
          isValid: true,
          canText: true,
          canCall: true,
          error: null,
        }
      : null,
    email: hasEmail
      ? {
          result: "validation-error",
          isValid: true,
          canSend: true,
          flags: [],
          error: null,
        }
      : null,
    phoneValid: hasPhone,
    phoneIsCell: hasPhone,
    phoneCanCall: hasPhone,
    phoneCanText: hasPhone,
    emailValid: hasEmail,
    emailCanSend: hasEmail,
    emailResult: hasEmail ? "validation-error" : null,
    fallback: true,
  };
}

async function validateLeadChannels(normalized = {}, options = {}) {
  const fallback = buildValidationFallback(normalized);
  const phoneClient = createRealPhoneValidationClient();
  const emailClient = createNeverBounceClient();

  const [phoneResult, emailResult] = await Promise.allSettled([
    normalized.primaryPhone
      ? phoneClient.validatePhone(normalized.primaryPhone)
      : Promise.resolve(null),
    normalized.email ? emailClient.validateEmail(normalized.email) : Promise.resolve(null),
  ]);

  const resolvedPhone =
    phoneResult.status === "fulfilled" ? phoneResult.value : fallback.phone;
  const resolvedEmail =
    emailResult.status === "fulfilled" ? emailResult.value : fallback.email;

  if (phoneResult.status === "rejected" && options.logger?.warn) {
    options.logger.warn("lead.validation.phone.failed", {
      domain: normalized.domain,
      intakeRoute: normalized.intakeRoute,
      error: phoneResult.reason?.message || String(phoneResult.reason || ""),
    });
  }

  if (emailResult.status === "rejected" && options.logger?.warn) {
    options.logger.warn("lead.validation.email.failed", {
      domain: normalized.domain,
      intakeRoute: normalized.intakeRoute,
      error: emailResult.reason?.message || String(emailResult.reason || ""),
    });
  }

  return {
    phone: resolvedPhone,
    email: resolvedEmail,
    phoneValid: Boolean(resolvedPhone?.isConnected),
    phoneIsCell: Boolean(resolvedPhone?.isCell),
    phoneCanCall: Boolean(resolvedPhone?.canCall),
    phoneCanText: Boolean(resolvedPhone?.canText),
    emailValid: Boolean(resolvedEmail?.isValid),
    emailCanSend: Boolean(resolvedEmail?.canSend),
    emailResult: resolvedEmail?.result || null,
    fallbackUsed:
      phoneResult.status === "rejected" || emailResult.status === "rejected",
  };
}

function evaluateLeadIntakeScrub(normalized = {}, validation = {}) {
  const hasPhone = Boolean(normalized.primaryPhone);
  const hasEmail = Boolean(normalized.email);

  if (!hasPhone && !hasEmail) {
    return {
      reason: "missing-contact",
      code: "MISSING_CONTACT",
      detail: "Lead refused before Logics create because it has no phone or email.",
    };
  }

  if (validation.phone?.isLitigator) {
    return {
      reason: "phone-litigator",
      code: "PHONE_LITIGATOR",
      detail: "Lead refused before Logics create because phone validation flagged a litigator record.",
    };
  }

  const phoneUsable = hasPhone && (validation.phoneCanCall || validation.phoneCanText);
  const emailUsable = hasEmail && validation.emailCanSend;
  if (!phoneUsable && !emailUsable) {
    return {
      reason: "no-deliverable-channel",
      code: "NO_DELIVERABLE_CHANNEL",
      detail:
        "Lead refused before Logics create because validation found no callable/textable phone " +
        "and no sendable email.",
    };
  }

  return null;
}

async function recordIntakeScrubRejection(normalized = {}, rejection = {}, validation = {}, options = {}) {
  await recordWorkflowStage({
    domain: normalized.domain,
    family: "inbound",
    subtype: "intake-rejected-validation",
    stage: "rejected",
    aggregateType: "inbound-lead",
    aggregateId: String(
      normalized.externalLeadId ||
      normalized.primaryPhone ||
      normalized.email ||
      normalized.name ||
      normalized.intakeRoute ||
      "unknown",
    ),
    sourceService: options.sourceService || "inbound-gateway",
    title: "Inbound lead rejected by validation scrub",
    summary: `${normalized.intakeRoute || "lead"} rejected before Logics create: ${rejection.reason}`,
    payload: {
      intakeRoute: normalized.intakeRoute,
      intakeSource: normalized.intakeSource,
      partnerSource: normalized.partnerSource,
      sourceName: normalized.sourceName,
      sourceChannel: normalized.sourceChannel,
      routeCampaignKey: normalized.routeCampaignKey || null,
      routeCampaignName: normalized.routeCampaignName || null,
      vendorSourceName: normalized.vendorSourceName || null,
      primaryPhone: normalized.primaryPhone || null,
      email: normalized.email || null,
      externalLeadId: normalized.externalLeadId || null,
      rejection,
      validation,
    },
  }).catch(() => null);
}

async function checkEmailHashExists(domain, emailHash, options = {}) {
  if (!emailHash) return false;
  const existing = await leadCadenceRepository.findLeadCadenceByEmailHash(domain, emailHash);
  if (existing) return true;

  const email = cleanString(options.email);
  if (!email) return false;
  const fallback = await leadCadenceRepository.findLeadCadenceByEmail(domain, email);
  return Boolean(fallback);
}

async function intakeLdPrePing(payload = {}, options = {}) {
  const domain = "WYNN";
  const companyConfig = options.companyConfig || getCompanyConfig(domain);
  const state = normalizeState(extractLeadState(payload));
  const dob = cleanString(
    payload["Date Of Birth"] ||
      payload["Date  Of  Birth"] ||
      payload.dob ||
      payload.DOB,
  );
  const rawEmail = extractLeadEmail(payload);
  const suppliedHash = cleanString(
    payload.email_hash ||
      payload.emailHash ||
      payload.email_md5 ||
      payload.md5_email ||
      payload.EmailHash,
  );
  const emailHash = normalizeEmailHash(suppliedHash, rawEmail);
  const callbackUrl = cleanString(
    payload.callback_url || payload.callbackUrl || payload.ping_url,
  );

  if (!state) {
    return {
      ok: false,
      accepted: false,
      error: "Missing state",
      code: "MISSING_STATE",
      statusCode: 400,
    };
  }

  const age = calculateAge(dob);
  if (age === null) {
    return {
      ok: false,
      accepted: false,
      error: "Invalid or missing date of birth",
      code: "INVALID_DOB",
      statusCode: 400,
    };
  }

  if (Number(companyConfig.minAge) > 0 && age < Number(companyConfig.minAge)) {
    return {
      ok: false,
      accepted: false,
      error: `Age ${age} below minimum ${companyConfig.minAge}`,
      code: "AGE_TOO_YOUNG",
      minAge: Number(companyConfig.minAge),
      statusCode: 400,
    };
  }

  if (!emailHash) {
    return {
      ok: false,
      accepted: false,
      error: "Missing email hash",
      code: "MISSING_EMAIL_HASH",
      statusCode: 400,
    };
  }

  const existing = await checkEmailHashExists(domain, emailHash, {
    email: rawEmail,
  });
  if (existing) {
    return {
      ok: false,
      accepted: false,
      error: "Duplicate email",
      code: "DUPLICATE_EMAIL",
      statusCode: 400,
    };
  }

  await prePingRepository.upsertPrePing(domain, emailHash, callbackUrl);

  return {
    ok: true,
    accepted: true,
    domain,
    message: "Lead accepted - proceed with full submission to /api/inbound/ld/lead",
    checks: {
      age,
      emailNew: true,
    },
    callbackUrl: callbackUrl || null,
    statusCode: 200,
  };
}

function validateLeadWebhook(req) {
  const configured = String(env("LEAD_WEBHOOK_SECRET", "")).trim();
  if (!configured) return true;

  const provided = String(
    req.headers["x-webhook-secret"] ||
      req.headers["x-inbound-secret"] ||
      req.headers.authorization?.replace(/^Bearer\s+/i, "") ||
      "",
  ).trim();

  return safeSecretEquals(provided, configured);
}

function buildLogicsCreatePayload(normalized) {
  const logicsSourceName = resolveLogicsSourceName(normalized);
  const logicsCampaignName = resolveLogicsCampaignName(normalized);
  const payload = {
    FirstName: normalized.firstName || "Prospect",
    LastName: normalized.lastName || "Prospect",
    Email: normalized.email || undefined,
    CellPhone: normalized.primaryPhone ? `(${normalized.primaryPhone.slice(0, 3)})${normalized.primaryPhone.slice(3, 6)}-${normalized.primaryPhone.slice(6, 10)}` : undefined,
    City: normalized.city || undefined,
    State: normalized.state || undefined,
    SourceName: logicsSourceName,
  };
  if (logicsCampaignName) {
    payload.CampaignName = logicsCampaignName;
  }
  return payload;
}

async function ensureCaseId(normalized, options = {}) {
  if (normalized.caseId) return Number(normalized.caseId);
  if (options.skipLogicsCreate) {
    throw new Error("Cannot intake lead without caseId when skipLogicsCreate is enabled");
  }

  const logicsClient = createLogicsClient(normalized.domain);
  const emitRetryOnFailure = options.emitRetryOnFailure !== false && !options.fromHourlyRetry;
  let response;
  try {
    response = await logicsClient.createCase(buildLogicsCreatePayload(normalized));
  } catch (error) {
    if (emitRetryOnFailure) {
      await emitHourlyJobEvent({
        lane: "hourly",
        domain: normalized.domain,
        eventType: "inbound.logics.create.retry",
        targetService: "inbound-gateway",
        handlerKey: "retryInboundLogicsCreate",
        aggregateType: "inbound-lead",
        aggregateId: String(normalized.externalLeadId || normalized.primaryPhone || normalized.email || normalized.name || normalized.intakeRoute),
        caseId: null,
          payload: {
            intakeRoute: normalized.intakeRoute,
            normalizedLead: normalized,
          },
        resolutionCheckKey: "logics-case-visible",
        resolutionContext: {
          phone: normalized.primaryPhone || null,
          email: normalized.email || null,
        },
        dedupeKey: `${String(normalized.domain || "").toUpperCase()}:inbound-create:${normalized.externalLeadId || normalized.primaryPhone || normalized.email || normalized.name || normalized.intakeRoute}`,
        emittedBy: options.sourceService || "inbound-gateway",
        priority: 70,
        severity: "warning",
        immediateRetryAttempts: 1,
        immediateRetryDelayMs: 1000,
        provideSummary: false,
        firstError: error.message,
        notify: false,
      }).catch(() => null);
    }
    throw error;
  }
  const dataPart = parseLogicsPayload(response);
  const firstNode = Array.isArray(dataPart) ? dataPart[0] : dataPart;
  const caseId =
    extractCaseId(firstNode) ||
    extractCaseId(response?.data) ||
    extractCaseId(response?.Data) ||
    extractCaseId(response);
  if (!caseId) {
    if (emitRetryOnFailure) {
      await emitHourlyJobEvent({
        lane: "hourly",
        domain: normalized.domain,
        eventType: "inbound.logics.create.retry",
        targetService: "inbound-gateway",
        handlerKey: "retryInboundLogicsCreate",
        aggregateType: "inbound-lead",
        aggregateId: String(normalized.externalLeadId || normalized.primaryPhone || normalized.email || normalized.name || normalized.intakeRoute),
        caseId: null,
          payload: {
            intakeRoute: normalized.intakeRoute,
            normalizedLead: normalized,
          },
        resolutionCheckKey: "logics-case-visible",
        resolutionContext: {
          phone: normalized.primaryPhone || null,
          email: normalized.email || null,
        },
        dedupeKey: `${String(normalized.domain || "").toUpperCase()}:inbound-create:${normalized.externalLeadId || normalized.primaryPhone || normalized.email || normalized.name || normalized.intakeRoute}`,
        emittedBy: options.sourceService || "inbound-gateway",
        priority: 70,
        severity: "warning",
        immediateRetryAttempts: 1,
        immediateRetryDelayMs: 1000,
        provideSummary: false,
        firstError: `Logics did not return case id for ${normalized.intakeRoute}`,
        notify: false,
      }).catch(() => null);
    }
    throw new Error(`Logics did not return a case id for ${normalized.intakeRoute}`);
  }

  return caseId;
}

async function writeProspectAndCadence(normalized, options = {}) {
  const now = options.now || new Date();
  const companyConfig = options.companyConfig || getCompanyConfig(normalized.domain);
  const trackingNumber = resolveLeadTrackingNumber(normalized, companyConfig);

  // ── TrustedForm consent gate ─────────────────────────────────────
  // Default policy: lead must carry a TrustedForm certificate URL or
  // a Jornaya lead ID to enter cadence.
  //
  // Routes opt out of the gate via `requireConsent: false` when the
  // lead source structurally does not carry consent tokens:
  //   - LD vendor (`intakeLdLead`)               — vendor never sends
  //                                                 TrustedForm/Jornaya
  //   - Lexis SFTP batch / NCOA / mail intake    — bypass entirely,
  //                                                 they call
  //                                                 masterProspectRepository
  //                                                 directly
  //   - Dev/test                                 — explicit override
  //
  // Vault-only leads (no token, ConsentRecord still written) get the
  // SAME 30-day contact window as token-bearing leads — the vault row
  // (intake timestamp + IP + source attribution) is treated as the
  // baseline consent artifact for the LD-vendor flow. Compliance
  // enforcement for vault-only leads happens at the day-30+ DNC
  // recheck (bimonthly sweep, see
  // LeadCadence.cadenceState.dncCheck schema comment): if the phone
  // is still on federal DNC at that point, the sweep marks cx + rvm
  // via channelDnc. Inside the first 30 days, vault-only leads are
  // fully contactable across all channels regardless of DNC.
  //
  // The gate still runs BEFORE Logics createCase + validation calls
  // for routes that DO require consent, so we don't burn API budget
  // on leads we can't legally contact.
  const requireConsent = options.requireConsent !== false;
  const hasConsentArtifact = Boolean(
    normalized.trustedFormCertUrl || normalized.jornayaLeadId,
  );
  const consentTier = hasConsentArtifact
    ? (normalized.trustedFormCertUrl ? "trustedform" : "jornaya")
    : "vault-only";
  if (requireConsent && !hasConsentArtifact) {
    await recordWorkflowStage({
      domain: normalized.domain,
      family: "inbound",
      subtype: "intake-rejected-no-consent",
      stage: "rejected",
      aggregateType: "inbound-lead",
      aggregateId: String(
        normalized.externalLeadId ||
        normalized.primaryPhone ||
        normalized.email ||
        normalized.name ||
        normalized.intakeRoute ||
        "unknown",
      ),
      sourceService: options.sourceService || "inbound-gateway",
      title: "Inbound lead rejected — no consent artifact",
      summary: `${normalized.intakeRoute} from ${normalized.sourceName || "unknown"} arrived without TrustedForm or Jornaya ID`,
      payload: {
        intakeRoute: normalized.intakeRoute,
        intakeSource: normalized.intakeSource,
        partnerSource: normalized.partnerSource,
        sourceName: normalized.sourceName,
        sourceChannel: normalized.sourceChannel,
        routeCampaignKey: normalized.routeCampaignKey || null,
        routeCampaignName: normalized.routeCampaignName || null,
        vendorSourceName: normalized.vendorSourceName || null,
        primaryPhone: normalized.primaryPhone || null,
        email: normalized.email || null,
        externalLeadId: normalized.externalLeadId || null,
      },
    }).catch(() => null);

    return {
      ok: false,
      accepted: false,
      skipped: true,
      reason: "no-consent-artifact",
      detail:
        "Lead refused — no TrustedForm certificate URL or Jornaya lead ID present. " +
        "Without a consent artifact the 30-day grace window doesn't apply, so the " +
        "lead cannot enter cadence.",
      domain: normalized.domain,
      statusCode: 422,
    };
  }

  const validation = await validateLeadChannels(normalized, options);
  const intakeRejection = evaluateLeadIntakeScrub(normalized, validation);
  if (intakeRejection) {
    await recordIntakeScrubRejection(normalized, intakeRejection, validation, options);
    return {
      ok: false,
      accepted: false,
      skipped: true,
      reason: intakeRejection.reason,
      code: intakeRejection.code,
      detail: intakeRejection.detail,
      domain: normalized.domain,
      validation,
      statusCode: 422,
    };
  }

  const caseId = await ensureCaseId(normalized, options);
  const schedule = createLegacyCadenceSchedule(now, companyConfig.cadence || {}, validation);
  const firstAction = schedule.actions[0] || null;

  await masterProspectRepository.upsertMasterProspect(normalized.domain, caseId, {
    statusId: normalized.statusId != null ? Number(normalized.statusId) : 2,
    statusLabelRaw: normalized.statusLabelRaw || "Opened",
    statusCategory: "prospect",
    sourceId: normalized.sourceId != null ? Number(normalized.sourceId) : null,
    firstName: normalized.firstName,
    lastName: normalized.lastName,
    name: normalized.name,
    email: normalized.email,
    cellPhone: normalized.primaryPhone,
    homePhone: null,
    workPhone: null,
    normalizedPhones: normalized.primaryPhone ? [normalized.primaryPhone] : [],
    firstSeenAt: now,
    lastSeenAt: now,
    needsStatusRefresh: true,
    needsSourceRefresh: true,
    metadata: {
      intakeSource: normalized.intakeSource,
      sourceName: normalized.sourceName,
      sourceChannel: normalized.sourceChannel,
      routeCampaignKey: normalized.routeCampaignKey || null,
      routeCampaignName: normalized.routeCampaignName || null,
      vendorSourceName: normalized.vendorSourceName || null,
      lastImportBatch: normalized.importBatch || null,
      notes: [normalized.intakeRoute, normalized.partnerSource].filter(Boolean),
      validation: {
        phoneValid: validation.phoneValid,
        phoneCanCall: validation.phoneCanCall,
        phoneCanText: validation.phoneCanText,
        phoneIsCell: validation.phoneIsCell,
        emailValid: validation.emailValid,
        emailCanSend: validation.emailCanSend,
        emailResult: validation.emailResult,
      },
    },
  });

  const cadenceHasDeliverableChannel = Boolean(
    validation.phoneCanText ||
    validation.emailCanSend ||
    validation.phoneCanCall,
  );
  const leadCadence = await leadCadenceRepository.upsertLeadCadence(normalized.domain, caseId, {
    externalLeadId: normalized.externalLeadId,
    intakeRoute: normalized.intakeRoute,
    intakeSource: normalized.intakeSource,
    partnerSource: normalized.partnerSource,
    firstName: normalized.firstName,
    lastName: normalized.lastName,
    name: normalized.name,
    email: normalized.email,
    emailHash: computeEmailHash(normalized.email),
    primaryPhone: normalized.primaryPhone,
    normalizedPhone: normalized.primaryPhone,
    city: normalized.city,
    state: normalized.state,
    sourceName: normalized.sourceName,
    sourceChannel: normalized.sourceChannel,
    routeCampaignKey: normalized.routeCampaignKey || null,
    routeCampaignName: normalized.routeCampaignName || null,
    vendorSourceName: normalized.vendorSourceName || null,
    statusId: normalized.statusId != null ? Number(normalized.statusId) : 2,
    active: true,
    cadenceMode: "legacy-time-count",
    cadenceCounters: {
      sms: 0,
      email: 0,
      rvm: 0,
      cx: 0,
    },
    lastTouched: {
      sms: null,
      email: null,
      rvm: null,
      cx: null,
    },
    counterCadence: {
      locks: {},
      deferUntil: {},
      lastDailyBatchKey: {},
      lastDispatchAt: null,
      lastFailureAt: null,
      lastResult: {},
      rvmDeliveries: [],
    },
    currentStage: cadenceHasDeliverableChannel ? "legacy-cadence-active" : "pending-manual-review",
    firstContactRequestedAt: null,
    firstContactEventId: null,
    schedule,
    cadenceState: leadCadenceRepository.buildCadenceStateFromActions(schedule.actions || []),
    validationContext: validation,
    attributionContext: {
      intakeRoute: normalized.intakeRoute,
      intakeSource: normalized.intakeSource,
      partnerSource: normalized.partnerSource,
      sourceName: normalized.sourceName,
      sourceChannel: normalized.sourceChannel,
      routeCampaignKey: normalized.routeCampaignKey || null,
      routeCampaignName: normalized.routeCampaignName || null,
      vendorSourceName: normalized.vendorSourceName || null,
      contactDomain: normalized.contactDomain || normalized.domain,
      lockContactDomain: Boolean(normalized.lockContactDomain),
      trackingNumber,
      receivedAt: now,
    },
    payloadSnapshot: {
      ...(normalized.payloadSnapshot || {}),
      trackingNumber,
      routeCampaignKey: normalized.routeCampaignKey || null,
      routeCampaignName: normalized.routeCampaignName || null,
      vendorSourceName: normalized.vendorSourceName || null,
      contactDomain: normalized.contactDomain || normalized.domain,
      lockContactDomain: Boolean(normalized.lockContactDomain),
      validation,
      // Audit trail: which consent posture this lead entered cadence
      // under. "trustedform" / "jornaya" → third-party-attested token
      // present. "vault-only" → ConsentRecord row exists but no
      // token; lead still gets the 30-day contact window, then the
      // bimonthly DNC sweep enforces channel locks if still listed.
      consentTier,
    },
  });

  // Capture initial federal-DNC status from the validation we just
  // ran. The validation called RealValidation's full DNCPlus.php
  // endpoint which already returns onNationalDNC, onStateDNC, etc. —
  // store those on `cadenceState.dncCheck.initialResult` and schedule
  // the first recheck for +30 days (the TrustedForm grace window).
  // After that the bimonthly sweep takes over rolling forward via
  // 1st-of-month / first-Mon-after-15th boundaries.
  await leadCadenceRepository
    .recordInitialDncCheck(normalized.domain, caseId, {
      result: {
        onDnc: Boolean(validation.phone?.onNationalDNC),
        onStateDnc: Boolean(validation.phone?.onStateDNC),
        isLitigator: Boolean(validation.phone?.isLitigator),
        isCell: Boolean(validation.phone?.isCell),
        source: "real-validation-dnc-plus",
      },
      nextCheckAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
    })
    .catch((error) => {
      options.logger?.warn?.("lead.dnc-check.initial.failed", {
        domain: normalized.domain,
        caseId,
        error: error.message,
      });
    });

  // Note on vault-only compliance posture:
  // Vault-only leads (no TrustedForm/Jornaya token, e.g. LD vendor)
  // enter cadence with all channels open. The 30-day clock starts at
  // intake from the vault-row receipt — same as token-bearing leads.
  // Enforcement happens at the day-30+ DNC recheck (bimonthly sweep,
  // see LeadCadence.cadenceState.dncCheck schema comment): if the
  // phone is still on federal DNC at that point, the sweep marks
  // cx + rvm via channelDnc. Inside the first 30 days the lead is
  // contactable across all channels regardless of DNC.

  const consentRecord = await writeConsentRecord(normalized, caseId, { now });
  const trustedFormCheckIn = await checkInTrustedFormCertificate(normalized, {
    logger: options.logger,
    caseId,
  });

  const inboundEvent = await createEvent({
    eventType: "inbound.lead.received",
    sourceService: options.sourceService || "inbound-gateway",
    aggregateType: "case",
    aggregateId: String(caseId),
    dedupeKey: `${normalized.domain}:${caseId}:${normalized.intakeRoute}:received`,
    payload: {
      domain: normalized.domain,
      caseId,
      intakeRoute: normalized.intakeRoute,
      intakeSource: normalized.intakeSource,
      externalLeadId: normalized.externalLeadId,
      sourceName: normalized.sourceName,
      sourceChannel: normalized.sourceChannel,
      routeCampaignKey: normalized.routeCampaignKey || null,
      routeCampaignName: normalized.routeCampaignName || null,
      vendorSourceName: normalized.vendorSourceName || null,
      primaryPhone: normalized.primaryPhone,
      email: normalized.email,
      validation,
      trustedFormCertUrl: normalized.trustedFormCertUrl,
      jornayaLeadId: normalized.jornayaLeadId,
      payloadSnapshot: normalized.payloadSnapshot,
    },
  });

  await recordWorkflowStage({
    domain: normalized.domain,
    family: "lead",
    subtype: normalized.intakeSource || "lead",
    stage: "observed",
    aggregateType: "case",
    aggregateId: String(caseId),
    caseId,
    sourceService: options.sourceService || "inbound-gateway",
    summary: `${normalized.intakeSource || "Lead"} received`,
    payload: {
      intakeRoute: normalized.intakeRoute,
      intakeSource: normalized.intakeSource,
      sourceName: normalized.sourceName,
      sourceChannel: normalized.sourceChannel,
      routeCampaignKey: normalized.routeCampaignKey || null,
      routeCampaignName: normalized.routeCampaignName || null,
      vendorSourceName: normalized.vendorSourceName || null,
      externalLeadId: normalized.externalLeadId,
      validation,
      trustedFormCertUrl: normalized.trustedFormCertUrl,
      jornayaLeadId: normalized.jornayaLeadId,
    },
  });

  await recordWorkflowStage({
    domain: normalized.domain,
    family: "dispatch",
    subtype: "cadence",
    stage: cadenceHasDeliverableChannel ? "armed" : "blocked",
    aggregateType: "case",
    aggregateId: String(caseId),
    caseId,
    sourceService: options.sourceService || "inbound-gateway",
    summary:
      cadenceHasDeliverableChannel
        ? "Counter cadence armed"
        : "No deliverable cadence channels available",
    payload: {
      nextActionType: schedule.nextActionType || null,
      nextActionAt: schedule.nextActionAt || null,
      channels: [
        validation.phoneCanText ? "sms" : null,
        validation.emailCanSend ? "email" : null,
        validation.phoneCanCall ? "rvm" : null,
        validation.phoneCanCall ? "cx" : null,
      ].filter(Boolean),
      actionCount: schedule.actions.length,
      cadenceMode: "legacy-time-count",
      intakeRoute: normalized.intakeRoute,
      intakeSource: normalized.intakeSource,
      routeCampaignKey: normalized.routeCampaignKey || null,
      routeCampaignName: normalized.routeCampaignName || null,
      planVersion: schedule.planVersion,
      validation,
    },
  });

  await createControlPlaneEvent({
    eventType: CONTROL_PLANE_EVENT_TYPES.LEAD_OBSERVED,
    sourceService: options.sourceService || "inbound-gateway",
    aggregateType: "case",
    aggregateId: String(caseId),
    dedupeKey: `${normalized.domain}:${caseId}:${normalized.intakeRoute}:control-plane`,
    payload: {
      domain: normalized.domain,
      caseId,
      statusId: normalized.statusId != null ? Number(normalized.statusId) : 2,
      statusLabelRaw: normalized.statusLabelRaw || "Opened",
      statusCategory: "prospect",
      firstName: normalized.firstName,
      lastName: normalized.lastName,
      name: normalized.name,
      email: normalized.email,
      cellPhone: normalized.primaryPhone,
      intakeSource: normalized.intakeSource,
      sourceName: normalized.sourceName,
      sourceChannel: normalized.sourceChannel,
      routeCampaignKey: normalized.routeCampaignKey || null,
      routeCampaignName: normalized.routeCampaignName || null,
      vendorSourceName: normalized.vendorSourceName || null,
      importBatch: normalized.importBatch || null,
      notes: [normalized.intakeRoute, normalized.partnerSource].filter(Boolean),
      validation,
      needsStatusRefresh: true,
      needsSourceRefresh: true,
      trustedFormCertUrl: normalized.trustedFormCertUrl,
      jornayaLeadId: normalized.jornayaLeadId,
      trustedFormCheckedIn: trustedFormCheckIn.ok === true,
    },
  });

  await createControlPlaneEvent({
    eventType: CONTROL_PLANE_EVENT_TYPES.METRIC_OBSERVED,
    sourceService: options.sourceService || "inbound-gateway",
    aggregateType: "case",
    aggregateId: String(caseId),
    dedupeKey: `${normalized.domain}:${caseId}:${normalized.intakeRoute}:metrics`,
    payload: {
      domain: normalized.domain,
      caseId,
      metricName: "leads_received",
      sourceKey: normalized.routeCampaignKey || normalized.intakeSource || "unknown",
      amount: 1,
      title: `${normalized.intakeSource || "lead"} lead received`,
      happenedAt: now.toISOString(),
    },
  });

  await sendInboundLeadAlertEmail(normalized, caseId, validation, {
    companyConfig,
  }).catch((error) => {
    if (options.logger?.warn) {
      options.logger.warn("lead.alert_email.failed", {
        domain: normalized.domain,
        caseId,
        intakeRoute: normalized.intakeRoute,
        error: error.message,
      });
      return;
    }
    console.warn("[INBOUND-ALERT] lead.alert_email.failed", {
      domain: normalized.domain,
      caseId,
      intakeRoute: normalized.intakeRoute,
      error: error.message,
    });
  });

  // ── Fire first-contact actions in-process, async ────────────────
  //
  // The cadence schedule arms with welcome-sms / welcome-email /
  // cx-day0-1 at scheduledFor=now. Historically the outbound-gateway
  // poll-sweep would discover and fire these on its next 5s tick, but
  // that's a poll-and-scan we don't need for first contact: we already
  // have the leadCadence in hand, so we can dispatch directly.
  //
  // Pattern: setImmediate so the LD vendor's HTTP response isn't
  // blocked by Twilio/SendGrid latency. If anything throws, the cadence
  // sweep is the safety net — schedule.actions stays status:pending
  // until dispatchForLead atomically flips it.
  setImmediate(() => {
    fireImmediateContact(leadCadence, validation, {
      logger: options.logger,
      sourceService: options.sourceService || "inbound-gateway",
    }).catch((error) => {
      if (options.logger?.warn) {
        options.logger.warn("lead.first-contact.failed", {
          domain: normalized.domain,
          caseId,
          error: error.message,
        });
      } else {
        console.warn("[FIRST-CONTACT] failed", {
          domain: normalized.domain,
          caseId,
          error: error.message,
        });
      }
    });
  });

  return {
    accepted: true,
    domain: normalized.domain,
    caseId,
    leadCadenceId: String(leadCadence._id),
    consentRecordId: consentRecord ? String(consentRecord._id) : null,
    validation,
    trustedFormCheckedIn: trustedFormCheckIn.ok === true,
    inboundEventId: String(inboundEvent.event?._id || inboundEvent._id || ""),
    firstContactEventId: null,
  };
}

/**
 * Fire the first-contact actions for a freshly-intaken lead, inline
 * (in-process) instead of waiting for the outbound-gateway poll-sweep.
 * Called as fire-and-forget from `writeProspectAndCadence` via
 * setImmediate, so this MUST NOT throw — wrap each channel separately
 * and absorb errors. The cadence sweep poller stays armed as a safety
 * net for anything this misses.
 *
 * Channels fired:
 *   - sms      (welcome text)             via dispatchForLead
 *   - email    (welcome email)            via dispatchForLead
 *   - cx       (queue lead for an agent)  via queueCxDialRequest
 *
 * Each is gated by `validation.<channel>` so we don't try to text a
 * landline or queue an unreachable phone for an agent dial.
 *
 * Why lazy-require: outboundDispatchService and cxCadenceService both
 * indirectly require inboundIntakeService through the package barrel
 * (shared-services/src/index.js). Top-level requires here would create
 * a circular import; lazy requires inside the function defer resolution
 * past the module-init phase and break the cycle.
 */
async function fireImmediateContact(leadCadence, validation = {}, options = {}) {
  if (!leadCadence) return { ok: false, reason: "no-lead-cadence" };
  const lc = leadCadence.toObject ? leadCadence.toObject() : leadCadence;
  const domain = lc.domain;
  const caseId = lc.caseId;
  const logger = options.logger;

  const result = {
    ok: true,
    domain,
    caseId,
    sms: null,
    email: null,
    cx: null,
  };

  // ── SMS + Email: dispatch directly via outboundDispatchService ──
  const {
    getCounterCadenceTemplateKey,
    recordCounterCadenceTouch,
  } = require("./counterCadenceService");
  const { dispatchForLead } = require("./outboundDispatchService");
  if (validation.phoneCanText) {
    try {
      result.sms = await dispatchForLead(lc, {
        channel: "sms",
        actionType: "counter-sms-1",
        templateKey: getCounterCadenceTemplateKey("sms", 1),
        updateCadence: false,
        queueDepth: 1,
      });
      if (result.sms?.ok) {
        await recordCounterCadenceTouch({
          domain,
          caseId,
          channel: "sms",
          templateIndex: 1,
          reason: "receipt-instant",
          result: result.sms.result || result.sms,
        });
      }
    } catch (error) {
      result.sms = { ok: false, error: error.message };
      logger?.warn?.("first-contact.sms.failed", { domain, caseId, error: error.message });
    }
  } else {
    result.sms = { ok: false, skipped: true, reason: "phone-cannot-text" };
  }

  if (validation.emailCanSend) {
    try {
      result.email = await dispatchForLead(lc, {
        channel: "email",
        actionType: "counter-email-1",
        templateKey: getCounterCadenceTemplateKey("email", 1),
        updateCadence: false,
        queueDepth: 1,
      });
      if (result.email?.ok) {
        await recordCounterCadenceTouch({
          domain,
          caseId,
          channel: "email",
          templateIndex: 1,
          reason: "receipt-instant",
          result: result.email.result || result.email,
        });
      }
    } catch (error) {
      result.email = { ok: false, error: error.message };
      logger?.warn?.("first-contact.email.failed", { domain, caseId, error: error.message });
    }
  } else {
    result.email = { ok: false, skipped: true, reason: "email-cannot-send" };
  }

  // ── CX queue: write the dial-queue item so an agent sees it ─────
  // Only enqueue when the phone is callable. The cadence schedule's
  // cx-day0-1 action carries the actionKey + scheduling intent; we
  // pass it through so the queue item is keyed correctly and the
  // cadence sweep's reconciliation later finds the same row.
  if (validation.phoneCanCall) {
    try {
      const { queueCxDialRequest } = require("./cxCadenceService");
      result.cx = await queueCxDialRequest({
        domain,
        caseId,
        leadCadenceId: String(lc._id),
        actionKey: `first-cx:${caseId}`,
        phone: lc.primaryPhone || lc.normalizedPhone || null,
        name: lc.name || null,
        intakeSource: lc.intakeSource || null,
        intakeRoute: lc.intakeRoute || null,
        sourceName: lc.sourceName || null,
        requestedBy: "intake-first-contact",
        executionOwner: "ringcentral-cx",
      });
    } catch (error) {
      result.cx = { ok: false, error: error.message };
      logger?.warn?.("first-contact.cx-queue.failed", { domain, caseId, error: error.message });
    }
  } else {
    result.cx = { ok: false, skipped: true, reason: "phone-cannot-call" };
  }

  logger?.info?.("first-contact.fired", {
    domain,
    caseId,
    sms: result.sms?.ok || result.sms?.skipped ? (result.sms.ok ? "sent" : "skipped") : "failed",
    email: result.email?.ok || result.email?.skipped ? (result.email.ok ? "sent" : "skipped") : "failed",
    cx: result.cx?.queued ? "queued" : result.cx?.skipped ? "skipped" : "failed",
  });

  return result;
}

async function intakeNormalizedLead(normalized, options = {}) {
  return writeProspectAndCadence(normalized, options);
}

async function intakeWebsiteLead(payload, options = {}) {
  return intakeNormalizedLead(
    lockResolvedContactDomain(
      normalizeWebsiteLeadPayload(payload, options.headers),
    ),
    options,
  );
}

async function intakeLdLead(payload, options = {}) {
  const normalized = normalizeWebsiteLeadPayload(payload, options.headers);
  const emailHash = computeEmailHash(normalized.email);
  const prePing = emailHash ? await prePingRepository.consumePrePing("WYNN", emailHash) : null;

  return intakeNormalizedLead(
    normalizeLdLeadPayload(payload, options.headers, { prePing }),
    {
      ...options,
      // LD vendor structurally does not send TrustedForm/Jornaya
      // tokens. Bypass the consent gate so vault-only LD leads enter
      // cadence on the same 30-day contact window as token-bearing
      // leads. ConsentRecord (vault row) is still written for every
      // LD lead. Day-30+ DNC enforcement happens via the bimonthly
      // sweep — if the phone is still federally DNC-listed past day
      // 30, the sweep marks cx + rvm via channelDnc.
      requireConsent: false,
    },
  );
}

async function intakeAffiliateLead(payload, options = {}) {
  const normalized = normalizeAffiliateLeadPayload(payload, options.headers);
  const result = await intakeNormalizedLead(
    normalized,
    options,
  );
  await notifyAffiliatePostback(payload, result, options).catch((error) => {
    options.logger?.warn?.("affiliate.postback.failed", {
      domain: result?.domain || normalized.domain,
      message: error.message,
      postbackUrl: extractAffiliatePostbackUrl(payload),
    });
  });
  return result;
}

async function intakeVfLandingLead(payload, options = {}) {
  const normalized = normalizeWebsiteLeadPayload(payload, options.headers);
  return intakeNormalizedLead(
    applyLeadOverrides(normalized, {
      intakeRoute: "vf-landing-page",
      intakeSource: "vf",
      partnerSource: cleanString(payload.partner || payload.vendor || payload.source || "vf"),
      sourceChannel: "landing-page",
      sourceName: cleanString(
        payload.sourceName || payload.landingPage || payload.partner || "VF Landing Page",
      ),
    }),
    options,
  );
}

async function intakeOrganicLandingLead(payload, options = {}) {
  const normalized = normalizeWebsiteLeadPayload(payload, options.headers);
  const organicDomain = cleanString(
    options.organicDomain || payload.organicDomain || payload.domain || payload.host || payload.website,
  );

  return intakeNormalizedLead(
    applyLeadOverrides(normalized, {
      intakeRoute: "organic-landing-page",
      intakeSource: "organic",
      partnerSource: organicDomain || "organic",
      sourceChannel: "organic-web",
      sourceName: cleanString(
        payload.sourceName || (organicDomain ? `${organicDomain} Organic Landing` : "Organic Landing Page"),
      ),
    }),
    options,
  );
}

async function intakeFacebookLead(payload, options = {}) {
  return intakeNormalizedLead(
    forceWynnContactDomain(normalizeFacebookLeadPayload(payload, options.headers)),
    options,
  );
}

async function intakeInstagramLead(payload, options = {}) {
  return intakeNormalizedLead(
    forceWynnContactDomain(normalizeInstagramLeadPayload(payload, options.headers)),
    options,
  );
}

async function intakeTikTokLead(payload, options = {}) {
  return intakeNormalizedLead(
    forceWynnContactDomain(normalizeTikTokLeadPayload(payload, options.headers)),
    options,
  );
}

async function intakeLexisBatch(rows = [], options = {}) {
  const now = options.now || new Date();
  const normalizedRows = rows.map((row) => {
    const sourceRow = row && typeof row === "object" ? row : {};
    return applyLeadOverrides(normalizeWebsiteLeadPayload(sourceRow, options.headers), {
      intakeRoute: "lexis-mailer",
      intakeSource: "lexis-sftp",
      sourceChannel: "mail",
      sourceName: "ABC",
      logicsSourceName: "ABC",
      partnerSource: cleanString(sourceRow.partnerSource || sourceRow.source || "lexis-sftp"),
      payloadSnapshot: {
        ...sourceRow,
        SourceName: "ABC",
      },
    });
  });

  for (const row of normalizedRows) {
    const caseId = await ensureCaseId(row, options);
    await masterProspectRepository.upsertMasterProspect(row.domain, caseId, {
      statusId: row.statusId != null ? Number(row.statusId) : 2,
      statusLabelRaw: row.statusLabelRaw || "Opened",
      statusCategory: "prospect",
      firstName: row.firstName,
      lastName: row.lastName,
      name: row.name,
      email: row.email,
      cellPhone: row.primaryPhone,
      normalizedPhones: row.primaryPhone ? [row.primaryPhone] : [],
      firstSeenAt: now,
      lastSeenAt: now,
      needsStatusRefresh: true,
      needsSourceRefresh: true,
      metadata: {
        intakeSource: "lexis-sftp",
        lastImportBatch: options.importBatch || now.toISOString().slice(0, 10),
        notes: ["lexis-mailer", row.partnerSource].filter(Boolean),
      },
    });
  }

  const summaryEvent = await createEvent({
    eventType: "inbound.lexis.batch.received",
    sourceService: options.sourceService || "inbound-gateway",
    aggregateType: "lexis-batch",
    aggregateId: options.importBatch || now.toISOString().slice(0, 10),
    dedupeKey: `lexis:${options.importBatch || now.toISOString().slice(0, 10)}`,
    payload: {
      domain: normalizedRows[0]?.domain || options.domain || null,
      importBatch: options.importBatch || now.toISOString().slice(0, 10),
      rowsReceived: normalizedRows.length,
      receivedAt: now,
    },
  });

  await recordWorkflowStage({
    domain: normalizedRows[0]?.domain || options.domain || "TAG",
    family: "lead-import",
    subtype: "lexis-mailer",
    stage: "observed",
    aggregateType: "lexis-batch",
    aggregateId: options.importBatch || now.toISOString().slice(0, 10),
    sourceService: options.sourceService || "inbound-gateway",
    summary: `Lexis batch received with ${normalizedRows.length} rows`,
    payload: {
      importBatch: options.importBatch || now.toISOString().slice(0, 10),
      rowsReceived: normalizedRows.length,
    },
  });

  return {
    accepted: true,
    rowsReceived: normalizedRows.length,
    summaryEventId: String(summaryEvent.event?._id || summaryEvent._id || ""),
  };
}

module.exports = {
  fireImmediateContact,
  intakeAffiliateLead,
  intakeFacebookLead,
  intakeInstagramLead,
  intakeLdLead,
  intakeLdPrePing,
  intakeLexisBatch,
  intakeNormalizedLead,
  intakeOrganicLandingLead,
  intakeTikTokLead,
  intakeVfLandingLead,
  intakeWebsiteLead,
  notifyAffiliatePostback,
  normalizeAffiliateLeadPayload,
  normalizeFacebookLeadPayload,
  normalizeInstagramLeadPayload,
  normalizeLdLeadPayload,
  normalizeTikTokLeadPayload,
  normalizeWebsiteLeadPayload,
  buildLogicsCreatePayload,
  validateLeadWebhook,
};
