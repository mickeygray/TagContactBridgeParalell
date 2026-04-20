"use strict";

const crypto = require("crypto");
const { createEvent } = require("../../event-core/src");
const { createLogicsClient } = require("../../shared-integrations/src");
const { resolveCompanyFromPayload } = require("../../shared-config/src");
const {
  leadCadenceRepository,
  masterProspectRepository,
} = require("../../shared-repositories/src");
const { CONTROL_PLANE_EVENT_TYPES, createControlPlaneEvent } = require("./controlPlaneEventService");

const FIRST_CONTACT_DELAY_MINUTES = 25;

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

function splitName(fullName) {
  const raw = String(fullName || "").trim();
  if (!raw) {
    return { firstName: null, lastName: null, name: null };
  }

  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: "Prospect", name: raw };
  }

  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
    name: raw,
  };
}

function deriveNameFields(payload = {}) {
  const firstName = cleanString(payload.firstName || payload.first_name || payload.firstname);
  const lastName = cleanString(payload.lastName || payload.last_name || payload.lastname);
  const fullName = cleanString(payload.name || payload.fullName || payload.full_name);

  if (firstName || lastName) {
    return {
      firstName: firstName || null,
      lastName: lastName || "Prospect",
      name: fullName || [firstName, lastName].filter(Boolean).join(" ") || null,
    };
  }

  return splitName(fullName);
}

function buildLeadSchedule(now = new Date(), timezone = "America/Los_Angeles") {
  const followUpAt = new Date(now.getTime() + FIRST_CONTACT_DELAY_MINUTES * 60 * 1000);

  return {
    planVersion: "v1",
    timezone,
    nextActionType: "sms:first-contact",
    nextActionAt: now,
    actions: [
      {
        key: "first-contact",
        type: "first-contact",
        channel: "sms",
        templateKey: "prospect-first-contact",
        scheduledFor: now,
        status: "requested",
      },
      {
        key: "follow-up-1",
        type: "follow-up",
        channel: "sms",
        templateKey: "prospect-follow-up-1",
        scheduledFor: followUpAt,
        status: "pending",
      },
    ],
  };
}

function buildExternalLeadId(prefix, payload = {}) {
  const explicit = cleanString(
    payload.externalLeadId || payload.lead_id || payload.leadId || payload.id || payload.contactId,
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
  const domain = toUpperDomain(resolveCompanyFromPayload(payload, headers));
  const nameFields = deriveNameFields(payload);
  const phone = normalizePhone(
    payload.phone || payload.primaryPhone || payload.cellPhone || payload.mobile || payload.tel,
  );

  return {
    domain,
    intakeRoute: "website-post",
    intakeSource: "website",
    partnerSource: cleanString(payload.source || payload.utm_source || payload.website || "website"),
    sourceChannel: "website",
    sourceName: cleanString(payload.sourceName || payload.source || payload.form_name || "Website Lead"),
    externalLeadId: buildExternalLeadId("website", payload),
    firstName: nameFields.firstName,
    lastName: nameFields.lastName,
    name: nameFields.name,
    email: cleanString(payload.email),
    primaryPhone: phone,
    city: cleanString(payload.city),
    state: cleanString(payload.state),
    caseId: payload.caseId != null ? Number(payload.caseId) : null,
    payloadSnapshot: payload,
  };
}

function applyLeadOverrides(normalized, overrides = {}) {
  return {
    ...normalized,
    intakeRoute: overrides.intakeRoute || normalized.intakeRoute,
    intakeSource: overrides.intakeSource || normalized.intakeSource,
    partnerSource: overrides.partnerSource || normalized.partnerSource,
    sourceChannel: overrides.sourceChannel || normalized.sourceChannel,
    sourceName: overrides.sourceName || normalized.sourceName,
    payloadSnapshot: overrides.payloadSnapshot || normalized.payloadSnapshot,
  };
}

function normalizeFacebookLeadPayload(payload = {}, headers = {}) {
  const domain = toUpperDomain(resolveCompanyFromPayload(payload, headers));
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
  const domain = toUpperDomain(resolveCompanyFromPayload(payload, headers));
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
    caseId: payload.caseId != null ? Number(payload.caseId) : null,
    payloadSnapshot: payload,
  };
}

function validateLeadWebhook(req) {
  const configured = String(process.env.LEAD_WEBHOOK_SECRET || "").trim();
  if (!configured) return true;

  const provided = String(
    req.headers["x-webhook-secret"] ||
      req.headers["x-inbound-secret"] ||
      req.headers.authorization?.replace(/^Bearer\s+/i, "") ||
      "",
  ).trim();

  return Boolean(provided) && provided === configured;
}

function buildLogicsCreatePayload(normalized) {
  return {
    FirstName: normalized.firstName || "Prospect",
    LastName: normalized.lastName || "Prospect",
    Email: normalized.email || undefined,
    CellPhone: normalized.primaryPhone ? `(${normalized.primaryPhone.slice(0, 3)})${normalized.primaryPhone.slice(3, 6)}-${normalized.primaryPhone.slice(6, 10)}` : undefined,
    City: normalized.city || undefined,
    State: normalized.state || undefined,
    SourceName: normalized.sourceName || normalized.intakeSource,
  };
}

async function ensureCaseId(normalized, options = {}) {
  if (normalized.caseId) return Number(normalized.caseId);
  if (options.skipLogicsCreate) {
    throw new Error("Cannot intake lead without caseId when skipLogicsCreate is enabled");
  }

  const logicsClient = createLogicsClient(normalized.domain);
  const response = await logicsClient.createCase(buildLogicsCreatePayload(normalized));
  const caseId = Number(response?.data?.CaseID || response?.data?.caseId || response?.CaseID);
  if (!caseId) {
    throw new Error(`Logics did not return a case id for ${normalized.intakeRoute}`);
  }

  return caseId;
}

async function writeProspectAndCadence(normalized, options = {}) {
  const now = options.now || new Date();
  const timezone = options.timezone || "America/Los_Angeles";
  const caseId = await ensureCaseId(normalized, options);
  const schedule = buildLeadSchedule(now, timezone);

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
      lastImportBatch: normalized.importBatch || null,
      notes: [normalized.intakeRoute, normalized.partnerSource].filter(Boolean),
    },
  });

  const firstContactEvent = await createEvent({
    eventType: "outbound.first-contact.requested",
    sourceService: options.sourceService || "inbound-gateway",
    aggregateType: "case",
    aggregateId: String(caseId),
    dedupeKey: `${normalized.domain}:${caseId}:first-contact`,
    payload: {
      domain: normalized.domain,
      caseId,
      intakeRoute: normalized.intakeRoute,
      intakeSource: normalized.intakeSource,
      sourceName: normalized.sourceName,
      sourceChannel: normalized.sourceChannel,
      firstName: normalized.firstName,
      lastName: normalized.lastName,
      name: normalized.name,
      email: normalized.email,
      primaryPhone: normalized.primaryPhone,
      schedule,
    },
  });

  const leadCadence = await leadCadenceRepository.upsertLeadCadence(normalized.domain, caseId, {
    externalLeadId: normalized.externalLeadId,
    intakeRoute: normalized.intakeRoute,
    intakeSource: normalized.intakeSource,
    partnerSource: normalized.partnerSource,
    firstName: normalized.firstName,
    lastName: normalized.lastName,
    name: normalized.name,
    email: normalized.email,
    primaryPhone: normalized.primaryPhone,
    normalizedPhone: normalized.primaryPhone,
    city: normalized.city,
    state: normalized.state,
    sourceName: normalized.sourceName,
    sourceChannel: normalized.sourceChannel,
    statusId: normalized.statusId != null ? Number(normalized.statusId) : 2,
    active: true,
    currentStage: "pending-first-contact",
    firstContactRequestedAt: now,
    firstContactEventId: String(firstContactEvent._id),
    schedule,
    attributionContext: {
      intakeRoute: normalized.intakeRoute,
      intakeSource: normalized.intakeSource,
      partnerSource: normalized.partnerSource,
      sourceName: normalized.sourceName,
      sourceChannel: normalized.sourceChannel,
      receivedAt: now,
    },
    payloadSnapshot: normalized.payloadSnapshot,
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
      primaryPhone: normalized.primaryPhone,
      email: normalized.email,
      payloadSnapshot: normalized.payloadSnapshot,
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
      importBatch: normalized.importBatch || null,
      notes: [normalized.intakeRoute, normalized.partnerSource].filter(Boolean),
      needsStatusRefresh: true,
      needsSourceRefresh: true,
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
      sourceKey: normalized.intakeSource || "unknown",
      amount: 1,
      title: `${normalized.intakeSource || "lead"} lead received`,
      happenedAt: now.toISOString(),
    },
  });

  return {
    accepted: true,
    domain: normalized.domain,
    caseId,
    leadCadenceId: String(leadCadence._id),
    inboundEventId: String(inboundEvent.event?._id || inboundEvent._id || ""),
    firstContactEventId: String(firstContactEvent.event?._id || firstContactEvent._id || ""),
  };
}

async function intakeNormalizedLead(normalized, options = {}) {
  return writeProspectAndCadence(normalized, options);
}

async function intakeWebsiteLead(payload, options = {}) {
  return intakeNormalizedLead(normalizeWebsiteLeadPayload(payload, options.headers), options);
}

async function intakeLdLead(payload, options = {}) {
  const normalized = normalizeWebsiteLeadPayload(payload, options.headers);
  return intakeNormalizedLead(
    applyLeadOverrides(normalized, {
      intakeRoute: "ld-lead",
      intakeSource: "ld",
      partnerSource: cleanString(payload.partner || payload.vendor || payload.source || "ld"),
      sourceChannel: "lead-distribution",
      sourceName: cleanString(payload.sourceName || payload.partner || payload.vendor || "LD Lead"),
    }),
    options,
  );
}

async function intakeAffiliateLead(payload, options = {}) {
  const normalized = normalizeWebsiteLeadPayload(payload, options.headers);
  return intakeNormalizedLead(
    applyLeadOverrides(normalized, {
      intakeRoute: "affiliate-lead",
      intakeSource: "affiliate",
      partnerSource: cleanString(payload.partner || payload.vendor || payload.source || "affiliate"),
      sourceChannel: "affiliate",
      sourceName: cleanString(
        payload.sourceName || payload.partner || payload.vendor || payload.affiliate || "Affiliate Lead",
      ),
    }),
    options,
  );
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
  return intakeNormalizedLead(normalizeFacebookLeadPayload(payload, options.headers), options);
}

async function intakeInstagramLead(payload, options = {}) {
  return intakeNormalizedLead(normalizeInstagramLeadPayload(payload, options.headers), options);
}

async function intakeTikTokLead(payload, options = {}) {
  return intakeNormalizedLead(normalizeTikTokLeadPayload(payload, options.headers), options);
}

async function intakeLexisBatch(rows = [], options = {}) {
  const now = options.now || new Date();
  const normalizedRows = rows.map((row) => normalizeWebsiteLeadPayload(row, options.headers));

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

  return {
    accepted: true,
    rowsReceived: normalizedRows.length,
    summaryEventId: String(summaryEvent.event?._id || summaryEvent._id || ""),
  };
}

module.exports = {
  intakeAffiliateLead,
  intakeFacebookLead,
  intakeInstagramLead,
  intakeLdLead,
  intakeLexisBatch,
  intakeNormalizedLead,
  intakeOrganicLandingLead,
  intakeTikTokLead,
  intakeVfLandingLead,
  intakeWebsiteLead,
  normalizeFacebookLeadPayload,
  normalizeInstagramLeadPayload,
  normalizeTikTokLeadPayload,
  normalizeWebsiteLeadPayload,
  validateLeadWebhook,
};
