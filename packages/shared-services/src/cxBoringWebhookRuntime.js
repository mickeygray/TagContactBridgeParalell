"use strict";

const defaultRepository = require("../../shared-repositories/src/cxBoringWebhookRepository");

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function resolveEmail(input = {}, options = {}) {
  return normalizeEmail(input.agentEmail || options.user?.email);
}

function projectCurrent(row = null) {
  if (!row) return null;
  return {
    queueItemId: row.queueItemId || row.externId || null,
    domain: row.domain || null,
    caseId: row.caseId || null,
    name: row.name || null,
    phone: row.phone || null,
    phoneLast4: row.phone ? String(row.phone).slice(-4) : null,
    phase: row.leadState || row.status || null,
    status: row.status || null,
    outcome: row.outcome || null,
    uii: row.uii || row._id || null,
    activeAt: row.observedAt || row.firstObservedAt || null,
    activeCallSummary: {
      callStart: row.callStart || null,
      durationSec: Number.isFinite(Number(row.durationSec)) ? Number(row.durationSec) : null,
      agentDisposition: row.agentDisposition || null,
      passDisposition: row.passDisposition || null,
    },
    externId: row.externId || null,
    ringcx: {
      campaignId: row.campaignId || null,
      agentId: row.agentId || null,
      agentDisposition: row.agentDisposition || null,
      passDisposition: row.passDisposition || null,
    },
  };
}

function createCxBoringWebhookRuntime({ repository = defaultRepository } = {}) {
  async function getSession(input = {}, options = {}) {
    const agentEmail = resolveEmail(input, options);
    if (!agentEmail) {
      const error = new Error("Authenticated agent email is required");
      error.status = 401;
      throw error;
    }
    const now = new Date();
    const [current, completedCount] = await Promise.all([
      repository.getCurrentForAgent(agentEmail),
      repository.countCompletedForAgentToday(agentEmail, now),
    ]);
    return {
      sessionId: `cx-boring-webhook:${agentEmail}`,
      runtime: "boring_webhook",
      status: "running",
      phase: current ? "active" : "idle",
      agentEmail,
      current: projectCurrent(current),
      completed: [],
      lastOutcome: null,
      completedCount,
      stats: { completedToday: completedCount, source: "ringcx-webhook" },
      controls: {
        outcomes: false,
        queue: false,
        appointmentFallback: true,
      },
    };
  }

  async function getLeads(input = {}, options = {}) {
    const session = await getSession(input, options);
    return {
      ...session,
      refillResult: { ok: true, skipped: true, reason: "direct-ringcx-feeder-owned" },
    };
  }

  async function availabilityNoop(input = {}, options = {}) {
    return getSession(input, options);
  }

  return {
    availabilityNoop,
    getLeads,
    getSession,
    start: getSession,
    sync: getSession,
    kill: getSession,
  };
}

const defaultRuntime = createCxBoringWebhookRuntime();

module.exports = {
  createCxBoringWebhookRuntime,
  getCxBoringWebhookSession: defaultRuntime.getSession,
  startCxBoringWebhookSession: defaultRuntime.start,
  syncCxBoringWebhookActiveCall: defaultRuntime.sync,
  startCxBoringWebhookGetLeads: defaultRuntime.getLeads,
  killCxBoringWebhookSession: defaultRuntime.kill,
  boringWebhookAvailabilityNoop: defaultRuntime.availabilityNoop,
  projectCurrent,
};
