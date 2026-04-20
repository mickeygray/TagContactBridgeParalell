"use strict";

const { reviewQueueRepository } = require("../../shared-repositories/src");

function buildHourlyHygienePlan() {
  return {
    cadence: "hourly",
    groups: [
      {
        key: "contact-suppression",
        purpose: "catch opt-out and leave-alone signals from texts, calls, and activity notes",
        sources: ["LeadCadence", "SMS outcomes", "call transcriptions", "Logics activities"],
        outcomes: [
          "pause or stop future contact",
          "mark lead for DNC/manual review",
          "push review item to client feed",
        ],
      },
      {
        key: "shallow-attribution",
        purpose: "resolve source and queue context on fresh intake and call activity",
        sources: ["CallRail", "RingCentral", "source canonical", "LeadCadence"],
        outcomes: [
          "attach source/channel candidates",
          "flag unresolved attribution",
          "push notable attribution exceptions to client feed",
        ],
      },
      {
        key: "new-client-financial-check",
        purpose: "check payments, invoices, and billing summary for recently converted cases",
        sources: ["Logics payments", "Logics invoices", "Logics billing summary"],
        outcomes: [
          "surface new payment events",
          "flag billing drift or payment failures",
          "push meaningful client/payment updates to client feed",
        ],
      },
      {
        key: "lead-cadence-read",
        purpose: "scan cadence outcomes that should trigger enrichment or suppression",
        sources: ["LeadCadence", "message outcomes", "processLead intake fields"],
        outcomes: [
          "identify cases needing AI review",
          "identify messages needing human review",
          "push notable cadence outcomes to client feed",
        ],
      },
      {
        key: "front-facing-review-feed",
        purpose: "package hourly notable outcomes for human operators in the frontend",
        sources: ["all hourly groups"],
        outcomes: [
          "one flat review queue for the client",
          "severity and workflow labels",
          "payload for drill-down",
        ],
      },
    ],
  };
}

async function pushHourlyReviewItem(input = {}) {
  const payload = {
    domain: String(input.domain || "").toUpperCase(),
    caseId: input.caseId != null ? Number(input.caseId) : null,
    sourceService: input.sourceService || "control-plane",
    workflow: input.workflow || "hourly-hygiene",
    category: input.category || "general",
    severity: input.severity || "info",
    title: input.title || "Hourly hygiene event",
    summary: input.summary || null,
    customerName: input.customerName || null,
    primaryPhone: input.primaryPhone || null,
    sourceName: input.sourceName || null,
    sourceChannel: input.sourceChannel || null,
    happenedAt: input.happenedAt ? new Date(input.happenedAt) : new Date(),
    payload: input.payload || null,
    tags: Array.isArray(input.tags) ? input.tags : [],
  };

  return reviewQueueRepository.createReviewQueueItem(payload);
}

async function listHourlyReviewFeed(domain, filters = {}) {
  return reviewQueueRepository.listReviewQueueItems(domain, filters);
}

module.exports = {
  buildHourlyHygienePlan,
  listHourlyReviewFeed,
  pushHourlyReviewItem,
};
