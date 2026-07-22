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
    // Real-time LD-spend idempotency marker: stamped the first time this lead's
    // per-lead $rate is ticked into the day's LD SpendEntry, so a re-ingest of the
    // same lead can't double-count. The nightly materializer remains the reconcile
    // backstop (recomputes leads x rate and SETs the row).
    metricsLdSpend: {
      countedAt: { type: Date, default: null },
      family: { type: String, default: null },
      rate: { type: Number, default: null },
      dateKey: { type: String, default: null },
    },
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
    // Provider-neutral voice-attempt facts. These are dual-written with the
    // CX-era cadence paths during migration so delivery policy never depends
    // on a provider-specific field name.
    totalAttemptCount: { type: Number, default: 0, min: 0 },
    lastContactAt: { type: Date, default: null },
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
      lastCxDialedAt: { type: Date, default: null },
      lastCxDialedByExtensionId: { type: String, default: null },
      lastCxDialedByAgentName: { type: String, default: null },
      lastCxDialedByAgentEmail: { type: String, default: null },
      lastCxQueueFamily: { type: String, default: null },
      lastCxQueueItemId: { type: String, default: null },
      cxAnsweredContacts: { type: Number, default: 0 },
      cxNoAnswerCalls: { type: Number, default: 0 },
      lastCxAnsweredAt: { type: Date, default: null },
      lastCxNoAnswerAt: { type: Date, default: null },
      cxDailyDateKey: { type: String, default: null },
      cxDailyCalls: { type: Number, default: 0 },
      cxMonthlyMonthKey: { type: String, default: null },
      cxMonthlyCalls: { type: Number, default: 0 },
      // THE STRICT-SCHEMA LESSON, third strike (audit 2026-07-07): these paths were
      // written by the drain since 2026-06/07 but never declared — mongoose strict mode
      // silently stripped them from their own $set, which made the June replay-drift
      // guard ($ne CAS on lastCxTerminalCountedUii) DEAD CODE: the field never persisted,
      // the guard always passed, and partial-apply replays could re-increment counters
      // unbounded. Declaring them is the entire fix.
      lastCxTerminalCountedUii: { type: String, default: null },
      lastLeadDeliveryCountedCallId: { type: String, default: null },
      lastLeadDeliveryCountedAttemptKey: { type: String, default: null },
      leadDeliveryCountedAttemptKeys: { type: [String], default: [] },
      lastCxDncAt: { type: Date, default: null },
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
      // Per-lead opt-in to bypass the contact-timing gate
      // (quiet hours / weekday / TCPA windows / holidays) on specific
      // channels. Default empty — every existing lead behaves the way
      // it always has. Smoke tests and ops dry-runs flip this to fire
      // a single SMS/email outside business hours WITHOUT mutating the
      // global timing policy. The dispatcher in outboundDispatchService
      // checks this BEFORE evaluateChannelContactTime — if the channel
      // (or "all") is truthy, the timing gate is skipped and the action
      // dispatches immediately. Logs the bypass with reason="bypass-test-lead".
      // Shape: { sms: true, email: true } or { all: true }.
      bypassChannelTiming: { type: mongoose.Schema.Types.Mixed, default: {} },
    },
    validationContext: { type: mongoose.Schema.Types.Mixed, default: {} },
    attributionContext: { type: mongoose.Schema.Types.Mixed, default: {} },
    payloadSnapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
    interviewSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
    liveCoachCloseout: { type: mongoose.Schema.Types.Mixed, default: null },

    // Rolling aged-pool DNC checkpoints. Distinct from cadenceState.dncCheck
    // (which marks cx/rvm channels DNC) — this governs membership in the
    // red/aged dial pool. Daily 06:00 PT sweep finds leads where
    // dncCheckpoints.nextAt <= now and walks them through the 30 / 60 / 90
    // day checkpoints. After the 90-day pass they're left alone and either
    // live in red until the monthly graduation sweep evicts them at 8+
    // connects, or get hit by a DNC re-check and dropped.
    //
    //   nextAt is set at intake to createdAt + 30d.
    //   After each clean scrub:
    //     count 0→1: nextAt = createdAt + 60d
    //     count 1→2: nextAt = createdAt + 90d
    //     count 2→3: nextAt = null, cleared = true (done forever)
    //   Any dirty scrub:
    //     nextAt = null, hit = true, hitAt = now, reason = "national|state|litigator"
    //
    // Indexed below so the daily query is cheap.
    dncCheckpoints: {
      count: { type: Number, default: 0 },
      lastAt: { type: Date, default: null },
      nextAt: { type: Date, default: null },
      cleared: { type: Boolean, default: false },
      hit: { type: Boolean, default: false },
      hitAt: { type: Date, default: null },
      source: { type: String, default: null },
      reason: { type: String, default: null },
    },
    // Set by runMonthlyGraduationSweep when this lead has had >= 8
    // qualifying CX connects (duration >= 10s) in the trailing 4 months.
    // Permanent stamp — the daily age-in sweep skips graduated leads so
    // they never get re-promoted into red.
    graduatedAt: { type: Date, default: null, index: true },
    graduatedConnects: { type: Number, default: null },
  },
  { timestamps: true },
);

leadCadenceSchema.index({ domain: 1, caseId: 1 }, { unique: true });
leadCadenceSchema.index({ domain: 1, active: 1, "schedule.nextActionAt": 1 });
leadCadenceSchema.index({ domain: 1, active: 1, cadenceMode: 1, createdAt: 1 });
leadCadenceSchema.index({ domain: 1, createdAt: 1 });
// Daily aged-refresh sweep query. Sparse so the bulk of leads (with
// nextAt === null) don't bloat the index.
leadCadenceSchema.index(
  { "dncCheckpoints.nextAt": 1, graduatedAt: 1 },
  { sparse: true },
);

// Audience-build queries — `find({ domain, intakeRoute, active })`
// drives campaign dispatch + segmentation. Previously this hit the
// (domain, active, schedule.nextActionAt) index and filtered on
// intakeRoute in memory across the whole active set per tenant.
leadCadenceSchema.index({ domain: 1, intakeRoute: 1, active: 1 });

// Runtime/inbound snapshot reads. These are small dashboard probes, but
// without indexes each poll scans the full cadence collection for DNC
// counts and recent intake totals, which is enough to trigger Atlas
// query-targeting alerts.
leadCadenceSchema.index({ createdAt: -1 });
leadCadenceSchema.index(
  { "cadenceState.channelDnc.sms.blocked": 1, "cadenceState.channelDnc.sms.at": -1 },
  {
    name: "lead_cadence_channel_dnc_sms_at",
    partialFilterExpression: { "cadenceState.channelDnc.sms.blocked": true },
  },
);
leadCadenceSchema.index(
  { "cadenceState.channelDnc.email.blocked": 1, "cadenceState.channelDnc.email.at": -1 },
  {
    name: "lead_cadence_channel_dnc_email_at",
    partialFilterExpression: { "cadenceState.channelDnc.email.blocked": true },
  },
);
leadCadenceSchema.index(
  { "cadenceState.channelDnc.rvm.blocked": 1, "cadenceState.channelDnc.rvm.at": -1 },
  {
    name: "lead_cadence_channel_dnc_rvm_at",
    partialFilterExpression: { "cadenceState.channelDnc.rvm.blocked": true },
  },
);
leadCadenceSchema.index(
  { "cadenceState.channelDnc.cx.blocked": 1, "cadenceState.channelDnc.cx.at": -1 },
  {
    name: "lead_cadence_channel_dnc_cx_at",
    partialFilterExpression: { "cadenceState.channelDnc.cx.blocked": true },
  },
);
leadCadenceSchema.index(
  { "cadenceState.channelDnc.sms.reason": 1, "cadenceState.channelDnc.sms.at": -1 },
  { name: "lead_cadence_sms_dnc_reason_at" },
);

module.exports =
  mongoose.models.ControlPlaneLeadCadence ||
  mongoose.model("ControlPlaneLeadCadence", leadCadenceSchema);
