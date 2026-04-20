"use strict";

const { listEvents } = require("../../event-core/src");
const { reviewQueueRepository } = require("../../shared-repositories/src");
const {
  createCallrailClient,
  createDropClient,
  createLogicsClient,
  createRingCentralClient,
  createSendgridClient,
} = require("../../shared-integrations/src");
const { getCompanyConfig, getCompanyKeys } = require("../../shared-config/src");

function summarizeEventBacklog(events = []) {
  return events.reduce(
    (acc, event) => {
      acc.total += 1;
      acc.byStatus[event.status] = (acc.byStatus[event.status] || 0) + 1;
      return acc;
    },
    { total: 0, byStatus: {} },
  );
}

function buildConfigStatus(companyKey) {
  const company = getCompanyConfig(companyKey);
  return {
    company: company.key,
    logics: {
      hasApiUrl: Boolean(company.integrations.logics.apiUrl),
      hasApiKey: Boolean(company.integrations.logics.apiKey),
      hasSecret: Boolean(company.integrations.logics.secret),
    },
    callrail: {
      hasAccountId: Boolean(company.integrations.callrail.accountId),
      hasCompanyId: Boolean(company.integrations.callrail.companyId),
      hasApiKey: Boolean(company.integrations.callrail.apiKey),
    },
    sendgrid: {
      hasApiKey: Boolean(company.integrations.sendgrid.apiKey),
    },
    drop: {
      hasApiKey: Boolean(company.integrations.drop?.apiKey),
      hasCampaignToken: Boolean(company.integrations.drop?.campaignToken),
      hasTransferNumber: Boolean(company.integrations.drop?.transferNumber),
    },
  };
}

async function buildProviderHealth(domain) {
  const normalizedDomain = String(domain || "").toUpperCase();
  const configStatus = buildConfigStatus(normalizedDomain);
  const ringcentral = createRingCentralClient();

  return {
    domain: normalizedDomain,
    configStatus,
    runtimeStatus: {
      ringcentral: ringcentral.getAuthStatus(),
      logicsClientReady: Boolean(createLogicsClient(normalizedDomain)),
      callrailClientReady: Boolean(createCallrailClient(normalizedDomain)),
      sendgridClientReady: Boolean(createSendgridClient(normalizedDomain)),
      dropClientReady: Boolean(createDropClient(normalizedDomain)),
    },
  };
}

async function buildControlPlaneHealthReport() {
  const [pendingFailedEvents, deadLetters, openServiceAlerts] = await Promise.all([
    listEvents({ limit: 200 }),
    listEvents({ status: "dead-letter", limit: 50 }),
    reviewQueueRepository.countReviewQueueItems(null, {
      workflow: "service-health",
      status: "open",
    }),
  ]);

  return {
    ok: true,
    companies: getCompanyKeys().map(buildConfigStatus),
    eventBacklog: summarizeEventBacklog(pendingFailedEvents),
    deadLetters: deadLetters.slice(0, 10).map((event) => ({
      id: String(event._id),
      eventType: event.eventType,
      sourceService: event.sourceService,
      lastError: event.lastError,
      createdAt: event.createdAt,
    })),
    openServiceAlerts,
  };
}

async function recordServiceAlert(input = {}) {
  return reviewQueueRepository.createReviewQueueItem({
    domain: String(input.domain || "TAG").toUpperCase(),
    sourceService: input.sourceService || "control-plane",
    workflow: "service-health",
    category: input.category || "service-alert",
    severity: input.severity || "warning",
    title: input.title || "Service alert",
    summary: input.summary || null,
    happenedAt: input.happenedAt ? new Date(input.happenedAt) : new Date(),
    payload: input.payload || null,
    tags: Array.isArray(input.tags) ? input.tags : [],
  });
}

module.exports = {
  buildControlPlaneHealthReport,
  buildProviderHealth,
  recordServiceAlert,
};
