"use strict";

// APPOINTMENT CLOCK DISPATCHER (the serving half of the cxapt lane, 2026-07-07).
// Mickey's ruling: "a Lead Cadence is marked appointment-scheduled, which generates a
// CxApt key consumed by the appointment queue, SENT AT THE MOMENT OF THE CALL."
//
// This is ADDITIVE to the existing app-side fire flow (fireOneDueAppointment still
// ensures the queue row + agent-list serving): at dispatch time the lead is ALSO
// published to the owning agent's RingCX appointment campaign — extern = the CxApt key
// (cxapt-<appointmentId>) — so the DIALER makes the call at the moment, IMMEDIATE.
//
// Exactly-once: a CAS claim on the appointment doc (rcxDispatch stamped only when null)
// BEFORE the publish; a rejected publish releases the claim for the next tick. The
// appointment STATUS is untouched — the existing worker owns that field (ownership law).
// Due = max(appointmentAt - LEAD_TIME, legalDialAt) — never dial before the legal window.
// Flags: CX_APPT_LANE_ENABLED (default off) + CX_APPT_QUEUE_MAP + CX_APPT_DISPATCH_LEAD_MS.

const { CxAppointment } = require("../../shared-models/src");
const { publishBatchToRingcx } = require("./cxBulkLoadRingcxPublisher");
const { buildLaneExternId, parseAgentQueueMap } = require("./cxLaneRegistry");
const { logCxAlpha } = require("./cxAlphaTraceService");

// PURE. When does this appointment become dispatchable to the dialer?
function deriveAppointmentDispatchDue(appointment = {}, { leadMs = 0 } = {}) {
  const at = appointment.appointmentAt ? new Date(appointment.appointmentAt).getTime() : NaN;
  if (!Number.isFinite(at)) return null;
  const legal = appointment.legalDialAt ? new Date(appointment.legalDialAt).getTime() : -Infinity;
  return new Date(Math.max(at - Math.max(Number(leadMs) || 0, 0), legal));
}

function defaultDeps() {
  return {
    isEnabled: () =>
      String(process.env.CX_APPT_LANE_ENABLED || "false").trim().toLowerCase() === "true",
    resolveQueueMap: () => parseAgentQueueMap(process.env.CX_APPT_QUEUE_MAP),
    resolveLeadMs: () => Math.max(Number(process.env.CX_APPT_DISPATCH_LEAD_MS) || 0, 0),
    listDispatchable: (now, limit) =>
      CxAppointment.find({
        status: { $in: ["scheduled", "due"] },
        rcxDispatch: null,
        appointmentAt: { $lte: new Date(now.getTime() + 24 * 60 * 60 * 1000) }, // day window; due math below
      })
        .sort({ appointmentAt: 1 })
        .limit(limit)
        .lean(),
    claimAppointment: async (appointmentId, claim) => {
      const result = await CxAppointment.updateOne(
        { appointmentId, status: { $in: ["scheduled", "due"] }, rcxDispatch: null },
        { $set: { rcxDispatch: claim } },
      );
      return (result.modifiedCount ?? result.nModified ?? 0) > 0;
    },
    stampAppointment: (appointmentId, fields) =>
      CxAppointment.updateOne({ appointmentId }, { $set: fields }),
    releaseClaim: (appointmentId) =>
      CxAppointment.updateOne({ appointmentId }, { $set: { rcxDispatch: null } }),
    publishBatch: publishBatchToRingcx,
  };
}

function createCxAppointmentDispatcher(input = {}) {
  const deps = { ...defaultDeps(), ...input };
  const { client, logger = console } = input;

  async function tickOnce({ now = new Date(), limit = 25 } = {}) {
    if (!deps.isEnabled()) return { skipped: true, reason: "flag-off" };
    const agents = deps.resolveQueueMap();
    if (!agents.length) {
      logCxAlpha("cx.alpha.appt.dispatch.skipped", { reason: "empty-queue-map" }, { logger });
      return { skipped: true, reason: "empty-queue-map" };
    }
    const byEmail = new Map(agents.map((a) => [a.agentEmail, a]));
    const leadMs = deps.resolveLeadMs();
    const candidates = await deps.listDispatchable(now, limit);

    let dispatched = 0;
    let failed = 0;
    let waiting = 0;
    for (const appointment of candidates) {
      const due = deriveAppointmentDispatchDue(appointment, { leadMs });
      if (!due || due.getTime() > now.getTime()) {
        waiting += 1;
        continue; // not the moment yet
      }
      const agent = byEmail.get(String(appointment.agentEmail || "").toLowerCase());
      if (!agent) {
        // never borrow a queue — loud skip, the panel/app-side lane still has it
        logCxAlpha("cx.alpha.appt.dispatch.unmapped_agent", {
          appointmentId: appointment.appointmentId,
          agentEmail: appointment.agentEmail || null,
          caseId: appointment.caseId,
        }, { logger });
        continue;
      }
      const externId = buildLaneExternId("appointment", { appointmentId: appointment.appointmentId });
      const claim = {
        claimedAt: now.toISOString(),
        agentEmail: agent.agentEmail,
        campaignId: agent.campaignId,
        externId,
      };
      const won = await deps.claimAppointment(appointment.appointmentId, claim).catch(() => false);
      if (!won) continue;

      try {
        const publish = await deps.publishBatch(client, {
          campaignId: agent.campaignId,
          dialPriority: "IMMEDIATE",
          candidates: [{
            externId,
            phone: appointment.phone || null,
            name: appointment.prospectName || null,
            domain: appointment.domain,
            caseId: appointment.caseId,
            queueItemId: appointment.cxQueueRecordId ? String(appointment.cxQueueRecordId) : null,
          }],
        });
        const accepted = Array.isArray(publish?.accepted) && publish.accepted.length > 0;
        if (!accepted) throw new Error(publish?.rejected?.[0]?.reason || "publish-rejected");
        await deps.stampAppointment(appointment.appointmentId, {
          rcxDispatch: { ...claim, dispatchedAt: new Date().toISOString() },
        });
        dispatched += 1;
        logCxAlpha("cx.alpha.appt.dispatched", {
          appointmentId: appointment.appointmentId,
          caseId: appointment.caseId,
          agentEmail: agent.agentEmail,
          campaignId: agent.campaignId,
          externId,
          appointmentAt: appointment.appointmentAt,
        }, { logger });
      } catch (error) {
        failed += 1;
        await deps.releaseClaim(appointment.appointmentId).catch(() => null);
        logCxAlpha("cx.alpha.appt.dispatch.failed", {
          appointmentId: appointment.appointmentId,
          agentEmail: agent.agentEmail,
          error: error?.message,
        }, { logger });
      }
    }
    return { dispatched, failed, waiting };
  }

  return { tickOnce };
}

module.exports = {
  createCxAppointmentDispatcher,
  deriveAppointmentDispatchDue, // exported for pins; pure
};
