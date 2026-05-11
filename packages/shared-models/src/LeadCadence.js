"use strict";

const mongoose = require("mongoose");

const scheduledActionSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    type: { type: String, required: true },
    channel: { type: String, default: "sms" },
    templateKey: { type: String, default: null },
    contingentOnActionKey: { type: String, default: null },
    contingencyMode: {
      type: String,
      enum: [null, "wait-for-attempt", "skip-if-connected"],
      default: null,
    },
    scheduledFor: { type: Date, required: true },
    status: {
      type: String,
      enum: ["pending", "requested", "completed", "cancelled", "failed"],
      default: "pending",
    },
    // Async provider-disposition tracking. Used today only by Drop.co
    // RVM (whose initial /delivery/ POST returns 1038 "API Post
    // Accepted" but the actual disposition surfaces later via a
    // status-polling endpoint). Other channels write null here.
    //
    // Shape:
    //   {
    //     provider: "drop",
    //     activityToken: "uuid",
    //     statusUrl: "https://...",
    //     postedAt: Date,
    //     lastPolledAt: Date | null,
    //     pollAttempts: Number,
    //     disposition: null | {
    //       terminal: Boolean,
    //       disposition: "delivered" | "rejected" | "unknown",
    //       permanent: Boolean,         // for rejected: don't retry
    //       reason: String | null,      // e.g. "dnc-or-blocked"
    //       statusCode: Number | null,
    //       statusMessage: String | null,
    //       checkedAt: Date,
    //       raw: Object,
    //     }
    //   }
    providerDelivery: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

const leadCadenceSchema = new mongoose.Schema(
  {
    domain: { type: String, required: true, index: true },
    caseId: { type: Number, required: true },
    externalLeadId: { type: String, default: null, index: true },
    intakeRoute: { type: String, default: null, index: true },
    intakeSource: { type: String, default: null, index: true },
    partnerSource: { type: String, default: null },
    firstName: { type: String, default: null },
    lastName: { type: String, default: null },
    name: { type: String, default: null },
    email: { type: String, default: null },
    emailHash: { type: String, default: null, index: true },
    primaryPhone: { type: String, default: null },
    normalizedPhone: { type: String, default: null, index: true },
    city: { type: String, default: null },
    state: { type: String, default: null },
    sourceName: { type: String, default: null },
    sourceChannel: { type: String, default: null },
    routeCampaignKey: { type: String, default: null, index: true },
    routeCampaignName: { type: String, default: null },
    vendorSourceName: { type: String, default: null },
    statusId: { type: Number, default: null },
    active: { type: Boolean, default: true, index: true },
    currentStage: { type: String, default: "new" },
    cadenceMode: {
      type: String,
      enum: ["scheduled-actions", "legacy-time-count"],
      default: "scheduled-actions",
      index: true,
    },
    cadenceCounters: {
      sms: { type: Number, default: 0 },
      email: { type: Number, default: 0 },
      rvm: { type: Number, default: 0 },
      cx: { type: Number, default: 0 },
    },
    lastTouched: {
      sms: { type: Date, default: null },
      email: { type: Date, default: null },
      rvm: { type: Date, default: null },
      cx: { type: Date, default: null },
    },
    counterCadence: {
      locks: { type: mongoose.Schema.Types.Mixed, default: {} },
      deferUntil: { type: mongoose.Schema.Types.Mixed, default: {} },
      lastDailyBatchKey: { type: mongoose.Schema.Types.Mixed, default: {} },
      lastDispatchAt: { type: Date, default: null },
      lastFailureAt: { type: Date, default: null },
      lastResult: { type: mongoose.Schema.Types.Mixed, default: {} },
      rvmDeliveries: { type: [mongoose.Schema.Types.Mixed], default: [] },
    },
    firstContactRequestedAt: { type: Date, default: null },
    firstContactEventId: { type: String, default: null },
    schedule: {
      planVersion: { type: String, default: "v1" },
      timezone: { type: String, default: "America/Los_Angeles" },
      nextActionType: { type: String, default: null },
      nextActionAt: { type: Date, default: null, index: true },
      actions: { type: [scheduledActionSchema], default: [] },
    },
    cadenceState: {
      caps: { type: mongoose.Schema.Types.Mixed, default: {} },
      completedByChannel: { type: mongoose.Schema.Types.Mixed, default: {} },
      failedByChannel: { type: mongoose.Schema.Types.Mixed, default: {} },
      pendingByChannel: { type: mongoose.Schema.Types.Mixed, default: {} },
      exhaustedChannels: { type: [String], default: [] },
      engagementChannelsExhausted: { type: Boolean, default: false },
      nextChannel: { type: String, default: null },
      lastCompletedAtByChannel: { type: mongoose.Schema.Types.Mixed, default: {} },
      lastEvaluatedAt: { type: Date, default: null },
      // Per-channel "stop trying" flags. Set when a permanent failure
      // arrives from the provider for a specific channel (e.g.
      // CallRail returns "opted out" → channelDnc.sms blocked). Lead
      // remains `active: true` — only the offending channel is
      // disabled. Other channels can still fire. Distinct from the
      // lead-level `stopCaseContact` flow which deactivates everything.
      // Shape: { sms: { blocked, reason, at }, email: {...}, rvm: {...}, cx: {...} }
      channelDnc: { type: mongoose.Schema.Types.Mixed, default: {} },
      // Federal-DNC recheck schedule. The 30-day TrustedForm grace
      // window covers initial intake, but on every "1st of month" or
      // "first Monday after the 15th" boundary in PT, we re-check the
      // phone via RealValidation's cheap DNCLookup endpoint and — if
      // it's now on DNC AND the lead is past 30 days from creation —
      // mark the cx/rvm channels DNC via the standard channelDnc
      // path. Lead stays active; text + email continue.
      // Shape:
      //   {
      //     initialResult: { onDnc, source, checkedAt },  // captured at intake
      //     lastCheckedAt: Date | null,
      //     lastResult: { onDnc, source, listsHit, checkedAt },
      //     nextCheckAt: Date,        // computed at intake (createdAt + 30d)
      //                                // and after each recheck (next boundary)
      //   }
      dncCheck: { type: mongoose.Schema.Types.Mixed, default: null },
    },
    validationContext: { type: mongoose.Schema.Types.Mixed, default: {} },
    attributionContext: { type: mongoose.Schema.Types.Mixed, default: {} },
    payloadSnapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

leadCadenceSchema.index({ domain: 1, caseId: 1 }, { unique: true });
leadCadenceSchema.index({ domain: 1, active: 1, "schedule.nextActionAt": 1 });
leadCadenceSchema.index({ domain: 1, active: 1, cadenceMode: 1, createdAt: 1 });

module.exports =
  mongoose.models.ControlPlaneLeadCadence ||
  mongoose.model("ControlPlaneLeadCadence", leadCadenceSchema);
