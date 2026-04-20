"use strict";

const { createRingCentralClient } = require("../../shared-integrations/src");
const {
  classifyActivityForAttribution,
  parseSuccessfulPayments,
  summarizeSuccessfulPayments,
} = require("./attributionEnrichmentService");
const { listLastMonthInboundCalls, lookupInboundCall } = require("./callrailLookupService");
const { createLogicsFacade } = require("./logicsFacadeService");
const { resolveCanonicalSource } = require("./sourceCanonicalService");

function summarizeActivities(activities = []) {
  const sample = activities.slice(0, 5).map((activity) => ({
    activityId: activity.ActivityID || null,
    subject: activity.Subject || "",
    activityType: activity.ActivityType || "",
    createdDate: activity.CreatedDate || null,
  }));

  return {
    total: activities.length,
    sample,
  };
}

function summarizeInvoices(invoices = []) {
  const totalAmount = invoices.reduce((sum, invoice) => {
    const unitPrice = parseFloat(invoice.UnitPrice) || 0;
    const quantity = parseFloat(invoice.Quantity) || 0;
    return sum + unitPrice * (quantity || 1);
  }, 0);

  return {
    total: invoices.length,
    totalAmount,
    sample: invoices.slice(0, 5).map((invoice) => ({
      caseInvoiceId: invoice.CaseInvoiceID || null,
      invoiceTypeId: invoice.InvoiceTypeID || null,
      description: invoice.Description || "",
      date: invoice.Date || null,
      unitPrice: parseFloat(invoice.UnitPrice) || 0,
      quantity: parseFloat(invoice.Quantity) || 0,
    })),
  };
}

function summarizeBillingSummary(summary) {
  if (!summary || typeof summary !== "object") return null;
  return {
    totalFees: parseFloat(summary.TotalFees) || 0,
    paidAmount: parseFloat(summary.PaidAmount) || 0,
    balance: parseFloat(summary.Balance) || 0,
    amountDue: parseFloat(summary.AmountDue) || 0,
    dueDate: summary.DueDate || null,
    pastDue: parseFloat(summary.PastDue) || 0,
  };
}

async function resolveCaseContext(domain, { caseId, phone }) {
  const facade = createLogicsFacade(domain);
  if (caseId) {
    return {
      caseId: Number(caseId),
      phone: phone ? String(phone) : null,
      facade,
      phoneLookup: null,
    };
  }

  if (!phone) {
    throw new Error("caseId or phone is required for hygiene smoke");
  }

  const phoneLookup = await facade.findCaseByPhone(phone);
  const firstMatch = phoneLookup.matches?.[0] || null;
  if (!firstMatch?.caseId) {
    return {
      caseId: null,
      phone: String(phone),
      facade,
      phoneLookup,
    };
  }

  return {
    caseId: Number(firstMatch.caseId),
    phone: String(phone),
    facade,
    phoneLookup,
  };
}

async function buildDataHygieneOverview() {
  return {
    stages: [
      {
        key: "boot-hygiene",
        purpose: "fast Mongo-only cleanup and one-time migrations",
        originalSources: ["config/dbHealth.js"],
      },
      {
        key: "lead-cadence-read",
        purpose: "read shallow lead facts from intake before promotion",
        originalSources: ["webhook.js processLead", "LeadCadence"],
      },
      {
        key: "source-resolution",
        purpose: "canonicalize mailer, vendor, dialer, tracking, and RC extension inputs",
        originalSources: ["ringBridge/services/sourceCanonicalService.js"],
      },
      {
        key: "attribution-enrichment",
        purpose: "classify inbound activities and payment timing into current/closing attribution",
        originalSources: ["ringBridge/services/attributionService.js"],
      },
      {
        key: "hourly-financial-refresh",
        purpose: "refresh payments, invoices, activities, billing, and gap-fill cases",
        originalSources: ["ringBridge/services/hourlySyncService.js"],
      },
      {
        key: "callrail-redundancy",
        purpose: "lookup direct calls, sync monthly calls, and discover missed deals",
        originalSources: [
          "ringBridge/services/callRailService.js",
          "ringBridge/services/callRailStatsService.js",
          "ringBridge/services/callRailDealDiscovery.js",
        ],
      },
      {
        key: "nightly-health",
        purpose: "vendor health rollups, stale cleanup, and redline backfill candidates",
        originalSources: [
          "ringBridge/services/nightlyCaseHealthService.js",
          "ringBridge/services/dailyReportService.js",
          "ringBridge/services/spendSyncService.js",
          "ringBridge/services/healthService.js",
        ],
      },
    ],
  };
}

async function runDataHygieneSmoke(domain, options = {}) {
  const normalizedDomain = String(domain || "").toUpperCase();
  const context = await resolveCaseContext(normalizedDomain, options);
  const phone = context.phone || String(options.phone || "");
  const result = {
    domain: normalizedDomain,
    requested: {
      caseId: options.caseId ? Number(options.caseId) : null,
      phone: phone || null,
      extensionId: options.extensionId || null,
      sourceName: options.sourceName || null,
      trackingNumber: options.trackingNumber || null,
      sourceId: options.sourceId != null ? Number(options.sourceId) : null,
    },
    context: {
      caseId: context.caseId,
      phoneLookupMatches: context.phoneLookup?.matches?.length || 0,
    },
    providers: {},
  };

  if (context.phoneLookup) {
    result.providers.logicsPhoneLookup = {
      ok: Boolean(context.phoneLookup.ok),
      matches: context.phoneLookup.matches?.slice(0, 3) || [],
    };
  }

  if (context.caseId) {
    const caseInfo = await context.facade.fetchCaseInfo(context.caseId);
    result.providers.logicsCaseInfo = {
      ok: Boolean(caseInfo.ok),
      status: caseInfo.status ?? null,
      data: caseInfo.data
        ? {
            caseId: caseInfo.data.CaseID || context.caseId,
            firstName: caseInfo.data.FirstName || "",
            lastName: caseInfo.data.LastName || "",
            email: caseInfo.data.Email || "",
            cellPhone: caseInfo.data.CellPhone || "",
            homePhone: caseInfo.data.HomePhone || "",
            sourceId: caseInfo.data.SourceID ?? null,
            statusId: caseInfo.data.StatusID ?? caseInfo.data.Status ?? null,
          }
        : null,
      error: caseInfo.ok ? null : caseInfo.error,
    };

    const billingSummary = await context.facade.fetchBillingSummary(context.caseId);
    const activities = await context.facade.fetchActivities(context.caseId);
    const payments = await context.facade.fetchPayments(context.caseId);
    const invoices = await context.facade.fetchInvoices(context.caseId);

    const successfulPayments = parseSuccessfulPayments(payments);
    const paymentSummary = summarizeSuccessfulPayments(successfulPayments);

    result.providers.logicsBillingSummary = {
      ok: true,
      summary: summarizeBillingSummary(billingSummary),
    };
    result.providers.logicsActivities = {
      ok: true,
      ...summarizeActivities(activities),
    };
    result.providers.logicsPayments = {
      ok: true,
      total: Array.isArray(payments) ? payments.length : 0,
      successfulCount: successfulPayments.length,
      summary: paymentSummary,
    };
    result.providers.logicsInvoices = {
      ok: true,
      ...summarizeInvoices(invoices),
    };

    const profile = {
      domain: normalizedDomain,
      caseId: context.caseId,
      sourceName: options.sourceName || null,
    };
    const inboundActivity = activities.find((activity) =>
      String(activity.ActivityType || "").toLowerCase().includes("call"),
    );
    if (inboundActivity) {
      result.providers.activityAttributionPreview = await classifyActivityForAttribution(
        {
          direction: "Inbound",
          contactMethod: inboundActivity.Subject || inboundActivity.ActivityType || "Inbound Call",
          callStartTime: inboundActivity.CreatedDate || null,
          caseMatch: {
            sourceName: options.sourceName || "",
            sourceChannel: options.sourceChannel || "",
          },
        },
        profile,
      );
    }

    const caseInfoData = caseInfo.data || {};
    const canonicalQuery = {
      domain: normalizedDomain,
      sourceId:
        options.sourceId != null
          ? Number(options.sourceId)
          : caseInfoData.SourceID != null
            ? Number(caseInfoData.SourceID)
            : null,
      sourceName: options.sourceName || caseInfoData.SourceName || null,
      rawName: options.sourceName || caseInfoData.SourceName || null,
      trackingNumber: options.trackingNumber || null,
      extensionId: options.extensionId || null,
      phone,
    };

    result.providers.sourceCanonical = await resolveCanonicalSource(canonicalQuery);
  }

  if (phone) {
    result.providers.callrailLookup = {
      ok: true,
      result: await lookupInboundCall(normalizedDomain, phone),
    };
    result.providers.callrailLastMonth = {
      ok: true,
      result: await listLastMonthInboundCalls(normalizedDomain, {
        perPage: 50,
        maxPages: 1,
      }),
    };
  }

  const rc = createRingCentralClient();
  const subscriptions = await rc.listSubscriptions();
  result.providers.ringcentral = {
    ok: true,
    auth: rc.getAuthStatus(),
    subscriptions: {
      total: Array.isArray(subscriptions.records) ? subscriptions.records.length : 0,
    },
  };

  return result;
}

module.exports = {
  buildDataHygieneOverview,
  runDataHygieneSmoke,
};
