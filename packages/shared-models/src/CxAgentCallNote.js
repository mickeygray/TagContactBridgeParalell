"use strict";

const mongoose = require("mongoose");

// Durable per-call corpus for nightly agent grading.
//
// This is intentionally separate from:
// - CxTerminalOutbox: transport/replay state for terminal outcomes.
// - CaseProfile.communications: per-case/customer timeline.
// - LeadCadence.liveCoachCloseout: per-lead latest coach memory.
//
// Nightly grading needs an agent/date/read model that is stable after the live
// call loop ends. Writers upsert by noteKey so terminal drain facts and coach
// closeout summaries can arrive in either order without duplicating a call.
const cxAgentCallNoteSchema = new mongoose.Schema(
  {
    noteKey: { type: String, required: true, unique: true, index: true },
    idemKey: { type: String, default: null, index: true },
    uii: { type: String, default: null, index: true },
    coachSessionId: { type: String, default: null, index: true },
    sessionId: { type: String, default: null, index: true },
    queueItemId: { type: String, default: null, index: true },

    rail: { type: String, default: null },
    source: { type: String, default: null, index: true },
    domain: { type: String, default: null, index: true },
    caseId: { type: Number, default: null, index: true },
    externId: { type: String, default: null },
    phoneLast4: { type: String, default: null },
    prospectName: { type: String, default: null },

    agentEmail: { type: String, default: null, index: true },
    agentName: { type: String, default: null },
    agentExtensionId: { type: String, default: null, index: true },

    happenedAt: { type: Date, default: null, index: true },
    durationSec: { type: Number, default: null },
    outcome: { type: String, default: null, index: true },
    terminalOutcome: { type: String, default: null },

    summary: { type: String, default: null },
    transcriptSummary: { type: String, default: null },
    nextStep: { type: String, default: null },
    transcriptArtifactPath: { type: String, default: null },
    contextKeys: { type: [String], default: [] },
    facts: { type: [mongoose.Schema.Types.Mixed], default: [] },
    coachSuggestions: { type: [String], default: [] },

    metrics: { type: mongoose.Schema.Types.Mixed, default: {} },
    grade: { type: mongoose.Schema.Types.Mixed, default: null },
    gradeCandidate: { type: Boolean, default: false, index: true },
    gradeStatus: {
      type: String,
      enum: ["pending", "queued", "graded", "skipped", "failed"],
      default: "pending",
      index: true,
    },
    gradeSkippedReason: { type: String, default: null },
    gradedAt: { type: Date, default: null },

    terminalResult: { type: mongoose.Schema.Types.Mixed, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    lastNoteSource: { type: String, default: null },
  },
  {
    collection: "cx_agent_call_notes",
    timestamps: true,
  },
);

cxAgentCallNoteSchema.index({ agentEmail: 1, happenedAt: 1 });
cxAgentCallNoteSchema.index({ gradeCandidate: 1, gradeStatus: 1, happenedAt: 1 });
cxAgentCallNoteSchema.index({ domain: 1, caseId: 1, happenedAt: -1 });

module.exports =
  mongoose.models.ControlPlaneCxAgentCallNote ||
  mongoose.model("ControlPlaneCxAgentCallNote", cxAgentCallNoteSchema);
