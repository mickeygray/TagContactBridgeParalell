"use strict";

const mongoose = require("mongoose");

// IDENTIFIER SCOPE: `extensionId` is globally unique because every company
// (TAG / WYNN / AMITY) shares a single RingCentral account configured via one
// set of credentials (`RING_CENTRAL_CLIENT_ID`, `RING_CENTRAL_JWT_TOKEN`).
// Extension IDs within that RC account are unique by design.
//
// If a future company is onboarded under a SEPARATE RC account, this unique
// constraint must become `{ company: 1, extensionId: 1 }` instead.

const agentStateSchema = new mongoose.Schema(
  {
    extensionId: { type: String, required: true, unique: true, index: true },
    cxAgentId: { type: String, default: null, index: true },
    cxProfileId: { type: String, default: null },
    name: { type: String, required: true },
    company: { type: String, enum: ["TAG", "WYNN"], default: "TAG" },
    pin: { type: String, default: null },
    status: {
      type: String,
      enum: ["available", "onCall", "ringing", "disposition", "away", "offline"],
      default: "offline",
    },
    exTelephonyStatus: { type: String, default: "NoCall" },
    exPresenceStatus: { type: String, default: "Offline" },
    currentCall: {
      sessionId: String,
      telephonySessionId: String,
      direction: String,
      from: String,
      fromName: String,
      to: String,
      // "ex" = call landed on the agent's RC desk app (TAG-first
      // lookup ladder fallback). "cx" = call routed via the CX queue
      // / cadence dialer (WYNN-first). Drives the lookup ladder's
      // domain fallback order on auto-scramble.
      channel: { type: String, enum: ["ex", "cx"], default: null },
      startTime: Date,
    },
    lastCallOutcome: { type: String, default: null },
    lastCallEndedAt: { type: Date, default: null },
    lastCallDirection: { type: String, default: null },
    lastMissedCallAt: { type: Date, default: null },
    lastMissedCallFrom: { type: String, default: null },
    lastMissedCallTo: { type: String, default: null },
    activePlatform: { type: String, enum: ["EX", "CX", "none"], default: "none" },
    // activityState: derived from telephony + dispatch state. Distinct
    // from `status` (which is more user-facing). Drives queue-eligibility
    // checks: only `idle` and `dispositioning` (briefly) get slice issuance.
    //   idle           - eligible for new slice / fresh assignment
    //   dialing        - we placed a click-to-dial; awaiting connect
    //   onCall         - in CallConnected (EX or CX)
    //   dispositioning - call ended, agent must record outcome
    //   wrapup         - synonym/alias for dispositioning (kept distinct in UI)
    //   unavailable    - explicit toggle by agent
    //   offline        - no presence
    activityState: {
      type: String,
      enum: ["idle", "dialing", "onCall", "dispositioning", "wrapup", "unavailable", "offline"],
      default: "offline",
    },
    // Updated on every meaningful action: claim, dispose, presence change,
    // unavail toggle. Used by idleReaperService to detect stale slices.
    lastActivityAt: { type: Date, default: null },
    lastStatusChange: { type: Date, default: Date.now },
    lastEventReceived: { type: Date, default: null },
    lastPresencePollAt: { type: Date, default: null },
    lastPresencePollError: { type: String, default: null },
    dailyStats: {
      date: String,
      hot: Number,
      day1: Number,
      day10: Number,
      aged: Number,
      totalCalls: Number,
      goodCalls: Number,
      badCalls: Number,
    },

    // Forward-looking per-agent call rollups (today/week/month/lifetime).
    // Lazy-computed: the GET /api/admin/accounts/:id/call-stats route
    // recomputes from CallLog (aggregating by extensionId +
    // metadata.additionalExtensionIds) when this snapshot is older than
    // 5 minutes or when the operator hits a refresh button, and stamps
    // the result here. Drawer reads from this field directly.
    //
    // Each bucket: { totalCalls, outboundCalls, inboundCalls,
    //                cxCalls, exCalls, longestCallSec, lastCallAt }
    // — CX/EX counts only populate from rows written after the
    // CallLog.platform stamp landed; historical rows count toward
    // totals but not toward the platform split.
    callStatsSnapshot: {
      today: { type: mongoose.Schema.Types.Mixed, default: null },
      week: { type: mongoose.Schema.Types.Mixed, default: null },
      month: { type: mongoose.Schema.Types.Mixed, default: null },
      lifetime: { type: mongoose.Schema.Types.Mixed, default: null },
      computedAt: { type: Date, default: null },
    },
    cxRouting: {
      enabled: { type: Boolean, default: false },
      desiredAvailability: {
        type: String,
        enum: ["available", "unavailable"],
        default: "available",
      },
      reason: { type: String, default: "not-synced" },
      syncedAt: { type: Date, default: null },
      lastSource: { type: String, default: null },
      assignmentStats: {
        date: { type: String, default: null },
        totalAssigned: { type: Number, default: 0 },
        freshDay1Assigned: { type: Number, default: 0 },
        freshDay2to10Assigned: { type: Number, default: 0 },
        agedAssigned: { type: Number, default: 0 },
        openAssignments: { type: Number, default: 0 },
        lastAssignedAt: { type: Date, default: null },
        lastAssignedQueueFamily: { type: String, default: null },
      },
    },
    appPresence: {
      cxWorkspaceActive: { type: Boolean, default: false },
      lastSeenAt: { type: Date, default: null },
      source: { type: String, default: null },
      userEmail: { type: String, default: null },
      sessionId: { type: String, default: null },
      updatedAt: { type: Date, default: null },
    },
    upstream: {
      source: { type: String, default: "ringbridge" },
      mirroredAt: { type: Date, default: Date.now },
    },
  },
  {
    timestamps: true,
    collection: "agentstates",
  },
);

module.exports = mongoose.models.ControlPlaneAgentState
  || mongoose.model("ControlPlaneAgentState", agentStateSchema);
