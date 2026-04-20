"use strict";

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", "..", ".env") });
const { env } = require("./env");

const DEFAULT_COMPANY = "WYNN";

const COMPANY_DEFINITIONS = Object.freeze({
  WYNN: {
    key: "WYNN",
    nameEnv: "COMPANY_WYNN_NAME",
    workspaceEnv: "COMPANY_WYNN_WORKSPACE",
    logicsDomainEnv: "COMPANY_WYNN_LOGICS_DOMAIN",
    companySlugEnv: "COMPANY_WYNN_SLUG",
    clientContactPhoneEnv: "WYNN_CLIENT_CONTACT_PHONE",
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
    ttAdvertiserIdEnv: "WYNN_TT_ADVERTISER_ID",
    callrailAccountIdEnv: "WYNN_CALL_RAIL_ACCOUNT_ID",
    callrailCompanyIdEnv: "WYNN_CALLRAIL_COMPANY_ID",
    callrailKeyEnv: "CALL_RAIL_KEY",
    dropApiKeyEnv: "DROP_API_KEY",
    dropCampaignTokenEnv: "WYNN_DROP_CAMPAIGN_TOKEN",
    dropTransferNumberEnv: "WYNN_DROP_TRANSFER_NUMBER",
    templateDirEnv: "COMPANY_WYNN_TEMPLATE_DIR",
  },
  TAG: {
    key: "TAG",
    nameEnv: "COMPANY_TAG_NAME",
    workspaceEnv: "COMPANY_TAG_WORKSPACE",
    logicsDomainEnv: "COMPANY_TAG_LOGICS_DOMAIN",
    companySlugEnv: "COMPANY_TAG_SLUG",
    clientContactPhoneEnv: "TAG_CLIENT_CONTACT_PHONE",
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
    ttAdvertiserIdEnv: "TAG_TT_ADVERTISER_ID",
    callrailAccountIdEnv: "TAG_CALL_RAIL_ACCOUNT_ID",
    callrailCompanyIdEnv: "TAG_CALLRAIL_COMPANY_ID",
    callrailKeyEnv: "TAG_CALL_RAIL_KEY",
    dropApiKeyEnv: "DROP_API_KEY",
    dropCampaignTokenEnv: "TAG_DROP_CAMPAIGN_TOKEN",
    dropTransferNumberEnv: "TAG_DROP_TRANSFER_NUMBER",
    templateDirEnv: "COMPANY_TAG_TEMPLATE_DIR",
  },
});

function envValue(name, fallback = "") {
  return process.env[name] || fallback;
}

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

  return {
    key: definition.key,
    name: env(definition.nameEnv, definition.key),
    workspace: env(definition.workspaceEnv, "ringcentral-cx"),
    logicsDomain,
    companySlug: env(definition.companySlugEnv, definition.key.toLowerCase()),
    clientContactPhone: envValue(definition.clientContactPhoneEnv),
    alertEmail: envValue(definition.alertEmailEnv, env(definition.defaultAlertEmailEnv, "")),
    fromEmail: envValue(definition.fromEmailEnv, env(definition.defaultFromEmailEnv, "")),
    toEmail: envValue(definition.toEmailEnv, env(definition.defaultToEmailEnv, "")),
    templateDir: env(definition.templateDirEnv, path.join(definition.key, "ProspectWelcome")),
    integrations: {
      sendgrid: {
        apiKey: envValue(definition.sendgridApiKeyEnv),
      },
      logics: {
        apiUrl: normalizeLogicsApiUrl(envValue(definition.logicsApiUrlEnv)),
        apiKey: envValue(definition.logicsApiKeyEnv, envValue("LOGICS_API_KEY")),
        secret: envValue(definition.logicsSecretEnv),
        domain: logicsDomain,
      },
      facebook: {
        pageId: envValue(definition.fbPageIdEnv),
        pageToken: envValue(definition.fbPageTokenEnv),
      },
      tiktok: {
        advertiserId: envValue(definition.ttAdvertiserIdEnv),
      },
      callrail: {
        accountId: envValue(definition.callrailAccountIdEnv),
        companyId: envValue(definition.callrailCompanyIdEnv),
        apiKey: envValue(definition.callrailKeyEnv, envValue("CALL_RAIL_KEY")),
      },
      drop: {
        apiKey: envValue(definition.dropApiKeyEnv, envValue("DROP_API_KEY")),
        campaignToken: envValue(definition.dropCampaignTokenEnv, envValue("DROP_CAMPAIGN_TOKEN")),
        transferNumber: envValue(definition.dropTransferNumberEnv, envValue("DROP_TRANSFER_NUMBER")),
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

module.exports = {
  COMPANY_DEFINITIONS,
  DEFAULT_COMPANY,
  getCompanyConfig,
  getCompanyKeys,
  normalizeLogicsApiUrl,
  resolveCompanyFromPayload,
};
