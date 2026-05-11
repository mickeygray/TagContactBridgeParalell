"use strict";

const path = require("path");
for (const [key, value] of Object.entries(process.env)) {
  if (value === "") delete process.env[key];
}
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", "..", ".env") });
const { env } = require("./env");

const DEFAULT_COMPANY = "WYNN";

const COMPANY_DEFINITIONS = Object.freeze({
  WYNN: {
    key: "WYNN",
    nameEnv: "COMPANY_WYNN_NAME",
    defaultName: "Wynn Tax Solutions",
    workspaceEnv: "COMPANY_WYNN_WORKSPACE",
    logicsDomainEnv: "COMPANY_WYNN_LOGICS_DOMAIN",
    companySlugEnv: "COMPANY_WYNN_SLUG",
    clientContactPhoneEnv: "WYNN_CLIENT_CONTACT_PHONE",
    fallbackPhoneEnv: "WYNN_PHONE",
    scheduleUrlEnv: "WYNN_SCHEDULE_URL",
    calendarScheduleUrlEnv: "WYNN_CALENDAR_SCHEDULE_URL",
    defaultScheduleUrl: "https://www.wynntaxsolutions.com/schedule",
    alertEmailEnv: "WYNN_ALERT_EMAIL",
    defaultAlertEmailEnv: "COMPANY_WYNN_DEFAULT_ALERT_EMAIL",
    fromEmailEnv: "WYNN_FROM_EMAIL",
    defaultFromEmailEnv: "COMPANY_WYNN_DEFAULT_FROM_EMAIL",
    toEmailEnv: "WYNN_TO_EMAIL",
    defaultToEmailEnv: "COMPANY_WYNN_DEFAULT_TO_EMAIL",
    sendgridApiKeyEnv: "WYNN_API_KEY",
    logicsApiUrlEnv: "WYNN_LOGICS_API_URL",
    logicsApiKeyEnv: "WYNN_LOGICS_API_KEY",
    logicsSecretEnv: "WYNN_LOGICS_SECRET",
    fbPageIdEnv: "WYNN_FB_PAGE_ID",
    fbPageTokenEnv: "WYNN_FB_PAGE_TOKEN",
    igPageIdEnv: "WYNN_IG_PAGE_ID",
    igPageTokenEnv: "WYNN_IG_PAGE_TOKEN",
    ttAdvertiserIdEnv: "WYNN_TT_ADVERTISER_ID",
    callrailAccountIdEnv: "WYNN_CALL_RAIL_ACCOUNT_ID",
    callrailCompanyIdEnv: "WYNN_CALLRAIL_COMPANY_ID",
    callrailKeyEnv: "CALL_RAIL_KEY",
    callrailTrackingNumberEnv: "WYNN_CALL_RAIL_TRACKING_NUMBER",
    dropApiKeyEnv: "DROP_API_KEY",
    dropCampaignTokenEnv: "WYNN_DROP_CAMPAIGN_TOKEN",
    dropTransferNumberEnv: "WYNN_DROP_TRANSFER_NUMBER",
    templateDirEnv: "COMPANY_WYNN_TEMPLATE_DIR",
  },
  TAG: {
    key: "TAG",
    nameEnv: "COMPANY_TAG_NAME",
    defaultName: "Tax Advocate Group",
    workspaceEnv: "COMPANY_TAG_WORKSPACE",
    logicsDomainEnv: "COMPANY_TAG_LOGICS_DOMAIN",
    companySlugEnv: "COMPANY_TAG_SLUG",
    clientContactPhoneEnv: "TAG_CLIENT_CONTACT_PHONE",
    fallbackPhoneEnv: "TAG_PHONE",
    scheduleUrlEnv: "TAG_SCHEDULE_URL",
    calendarScheduleUrlEnv: "TAG_CALENDAR_SCHEDULE_URL",
    defaultScheduleUrl: "https://www.taxadvocategroup.com/schedule",
    alertEmailEnv: "TAG_ALERT_EMAIL",
    defaultAlertEmailEnv: "COMPANY_TAG_DEFAULT_ALERT_EMAIL",
    fromEmailEnv: "TAG_FROM_EMAIL",
    defaultFromEmailEnv: "COMPANY_TAG_DEFAULT_FROM_EMAIL",
    toEmailEnv: "TAG_TO_EMAIL",
    defaultToEmailEnv: "COMPANY_TAG_DEFAULT_TO_EMAIL",
    sendgridApiKeyEnv: "TAG_API_KEY",
    logicsApiUrlEnv: "TAG_LOGICS_API_URL",
    logicsApiKeyEnv: "TAG_LOGICS_API_KEY",
    logicsSecretEnv: "TAG_LOGICS_SECRET",
    fbPageIdEnv: "TAG_FB_PAGE_ID",
    fbPageTokenEnv: "TAG_FB_PAGE_TOKEN",
    igPageIdEnv: "TAG_IG_PAGE_ID",
    igPageTokenEnv: "TAG_IG_PAGE_TOKEN",
    ttAdvertiserIdEnv: "TAG_TT_ADVERTISER_ID",
    callrailAccountIdEnv: "TAG_CALL_RAIL_ACCOUNT_ID",
    callrailCompanyIdEnv: "TAG_CALLRAIL_COMPANY_ID",
    callrailKeyEnv: "TAG_CALL_RAIL_KEY",
    callrailTrackingNumberEnv: "TAG_CALL_RAIL_TRACKING_NUMBER",
    dropApiKeyEnv: "DROP_API_KEY",
    dropCampaignTokenEnv: "TAG_DROP_CAMPAIGN_TOKEN",
    dropTransferNumberEnv: "TAG_DROP_TRANSFER_NUMBER",
    templateDirEnv: "COMPANY_TAG_TEMPLATE_DIR",
  },
});

function normalizeLogicsApiUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/\/publicapi\/v4\/?$/i.test(raw)) {
    return raw.endsWith("/") ? raw : `${raw}/`;
  }
  if (/\/publicapi\/v3\/?$/i.test(raw)) {
    return raw.replace(/\/publicapi\/v3\/?$/i, "/publicapi/V4/");
  }
  return raw.endsWith("/") ? raw : `${raw}/`;
}

function getCompanyConfig(companyKey = DEFAULT_COMPANY) {
  const key = String(companyKey || DEFAULT_COMPANY).toUpperCase();
  const definition = COMPANY_DEFINITIONS[key] || COMPANY_DEFINITIONS[DEFAULT_COMPANY];
  const logicsDomain = env(definition.logicsDomainEnv, definition.key);
  const legacyFbPageId =
    key === "TAG" ? env("TAG_FB_PAGE_ID", env("FB_PAGE_ID", "")) : env("WYNN_FB_PAGE_ID", env("FB_PAGE_ID", ""));
  const legacyFbPageToken =
    key === "TAG"
      ? env("TAG_FB_PAGE_TOKEN", env("FB_PAGE_TOKEN", env("FB_LEADS_ID", "")))
      : env("WYNN_FB_PAGE_TOKEN", env("FB_PAGE_TOKEN", env("FB_LEADS_ID", "")));
  const legacyIgPageId =
    key === "TAG"
      ? env("TAG_IG_PAGE_ID", env("TAG_IG_BUSINESS_ACCOUNT_ID", ""))
      : env("WYNN_IG_PAGE_ID", env("WYNN_IG_BUSINESS_ACCOUNT_ID", ""));
  const legacyIgPageToken =
    key === "TAG"
      ? env("TAG_IG_PAGE_TOKEN", env("TAG_FB_PAGE_TOKEN", env("FB_PAGE_TOKEN", "")))
      : env("WYNN_IG_PAGE_TOKEN", env("WYNN_FB_PAGE_TOKEN", env("FB_PAGE_TOKEN", "")));

  return {
    key: definition.key,
    name: env(definition.nameEnv, definition.defaultName || definition.key),
    workspace: env(definition.workspaceEnv, "ringcentral-cx"),
    logicsDomain,
    companySlug: env(definition.companySlugEnv, definition.key.toLowerCase()),
    allowedStates: ["OH", "IN", "KS", "NE", "MO", "IA", "ND", "SD", "OK", "CA"],
    minAge: 45,
    clientContactPhone: env(
      definition.clientContactPhoneEnv,
      env(definition.fallbackPhoneEnv, ""),
    ),
    scheduleUrl: env(
      definition.scheduleUrlEnv,
      env(definition.calendarScheduleUrlEnv, definition.defaultScheduleUrl || ""),
    ),
    alertEmail: env(definition.alertEmailEnv, env(definition.defaultAlertEmailEnv, "")),
    fromEmail: env(definition.fromEmailEnv, env(definition.defaultFromEmailEnv, "")),
    toEmail: env(definition.toEmailEnv, env(definition.defaultToEmailEnv, "")),
    templateDir: env(definition.templateDirEnv, path.join(definition.key, "ProspectWelcome")),
    cadence: {
      timezone: env(`COMPANY_${definition.key}_CADENCE_TIMEZONE`, "America/Los_Angeles"),
      firstContactDelayMinutes: Number(env(`COMPANY_${definition.key}_FIRST_CONTACT_DELAY_MINUTES`, "0")),
      followUpDelayMinutes: Number(env(`COMPANY_${definition.key}_FOLLOW_UP_DELAY_MINUTES`, "25")),
      contactStartHour: Number(env(`COMPANY_${definition.key}_CONTACT_START_HOUR`, "8")),
      contactEndHour: Number(env(`COMPANY_${definition.key}_CONTACT_END_HOUR`, "18")),
      activeWeekdays: env(`COMPANY_${definition.key}_CONTACT_WEEKDAYS`, "0,1,2,3,4,5,6"),
    },
    integrations: {
      sendgrid: {
        apiKey: env(definition.sendgridApiKeyEnv, ""),
      },
      logics: {
        apiUrl: normalizeLogicsApiUrl(env(definition.logicsApiUrlEnv, "")),
        apiKey: env(definition.logicsApiKeyEnv, env("LOGICS_API_KEY", "")),
        secret: env(definition.logicsSecretEnv, ""),
        domain: logicsDomain,
      },
      facebook: {
        pageId: env(definition.fbPageIdEnv, legacyFbPageId),
        pageToken: env(definition.fbPageTokenEnv, legacyFbPageToken),
      },
      instagram: {
        pageId: env(definition.igPageIdEnv, legacyIgPageId),
        pageToken: env(definition.igPageTokenEnv, legacyIgPageToken),
      },
      tiktok: {
        advertiserId: env(definition.ttAdvertiserIdEnv, ""),
      },
      callrail: {
        accountId: env(definition.callrailAccountIdEnv, ""),
        companyId: env(definition.callrailCompanyIdEnv, ""),
        apiKey: env(definition.callrailKeyEnv, env("CALL_RAIL_KEY", "")),
        trackingNumber: env(
          definition.callrailTrackingNumberEnv,
          env("CALL_RAIL_TRACKING_NUMBER", ""),
        ),
      },
      drop: {
        apiKey: env(definition.dropApiKeyEnv, env("DROP_API_KEY", "")),
        campaignToken: env(definition.dropCampaignTokenEnv, env("DROP_CAMPAIGN_TOKEN", "")),
        transferNumber: env(definition.dropTransferNumberEnv, env("DROP_TRANSFER_NUMBER", "")),
      },
    },
  };
}

function getCompanyKeys() {
  return Object.keys(COMPANY_DEFINITIONS);
}

function resolveCompanyFromPayload(body = {}, headers = {}) {
  const explicit = body.company || body.Company;
  if (explicit) {
    const key = String(explicit).toUpperCase();
    if (COMPANY_DEFINITIONS[key]) return key;
  }

  const referer = String(headers.referer || headers.origin || "").toLowerCase();
  if (referer.includes("wynntaxsolutions")) return "WYNN";
  if (referer.includes("taxadvocategroup")) return "TAG";

  const source = String(body.source || body.Source || "").toLowerCase();
  if (source.includes("wynn")) return "WYNN";
  if (source.includes("tag")) return "TAG";

  return DEFAULT_COMPANY;
}

function resolveCompanyFromFbPageId(pageId) {
  const needle = String(pageId || "").trim();
  if (!needle) return DEFAULT_COMPANY;

  for (const key of getCompanyKeys()) {
    const config = getCompanyConfig(key);
    const candidates = [
      config.integrations?.facebook?.pageId,
      config.integrations?.instagram?.pageId,
    ]
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    if (candidates.includes(needle)) {
      return key;
    }
  }

  return DEFAULT_COMPANY;
}

function getFbPageToken(companyKey = DEFAULT_COMPANY) {
  return getCompanyConfig(companyKey).integrations?.facebook?.pageToken || "";
}

function getIgPageToken(companyKey = DEFAULT_COMPANY) {
  return getCompanyConfig(companyKey).integrations?.instagram?.pageToken || "";
}

module.exports = {
  COMPANY_DEFINITIONS,
  DEFAULT_COMPANY,
  getCompanyConfig,
  getFbPageToken,
  getCompanyKeys,
  getIgPageToken,
  normalizeLogicsApiUrl,
  resolveCompanyFromFbPageId,
  resolveCompanyFromPayload,
};
