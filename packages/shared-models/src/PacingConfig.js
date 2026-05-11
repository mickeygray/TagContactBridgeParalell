"use strict";

const mongoose = require("mongoose");

// PacingConfig — admin-tunable singleton driving the queue + assignment
// behavior. Two primary numbers (perAgentSliceSize, teamHourlyTarget)
// shape everything; the rest are timers and operating-window controls.
//
// Identified by `singletonKey: "global"`. Read by every queue service
// at the top of each operation; cached in-process for ~30s to avoid
// re-reading on every tick (override via touchedAt bump in admin updates).
//
// `channelOperatingHours` encodes per-channel business-hours rules.
// voice/sms/rvm respect business hours; email is unrestricted.

const channelHoursSubdoc = new mongoose.Schema(
  {
    respectsBusinessHours: { type: Boolean, default: true },
    // Optional per-channel overrides; null = inherit top-level businessHours
    startHour: { type: Number, default: null },
    endHour: { type: Number, default: null },
    days: { type: [Number], default: null },
  },
  { _id: false },
);

const auditEntrySubdoc = new mongoose.Schema(
  {
    field: String,
    previousValue: mongoose.Schema.Types.Mixed,
    newValue: mongoose.Schema.Types.Mixed,
    updatedBy: String,
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const pacingConfigSchema = new mongoose.Schema(
  {
    singletonKey: { type: String, required: true, unique: true, default: "global" },

    // The two primary numbers
    perAgentSliceSize: { type: Number, default: 10 },
    teamHourlyTarget: { type: Number, default: 100 },

    // Fresh-lead behavior
    freshLeadTimerSeconds: { type: Number, default: 90 },

    // Idle reaper
    unavailReaperMinutes: { type: Number, default: 10 },

    // Top-level business hours (used by all channels with respectsBusinessHours: true)
    businessHoursStart: { type: Number, default: 8 },        // 24h
    businessHoursEnd: { type: Number, default: 18 },         // 24h, exclusive
    businessHoursTimezone: { type: String, default: "America/Los_Angeles" },
    businessDays: { type: [Number], default: [1, 2, 3, 4, 5] }, // 0=Sun..6=Sat
    holidays: { type: [String], default: [] },               // "YYYY-MM-DD"

    // Agent login window — non-admin users can only obtain a session
    // when current time falls inside [start, end) on a valid day.
    // JWT expiry is also clamped to today's window-end so agents are
    // automatically logged out at end-of-window.
    // Wider than businessHours so agents can prep before / wrap up after.
    agentLoginStartHour: { type: Number, default: 7 },       // 24h, inclusive
    agentLoginEndHour: { type: Number, default: 18 },        // 24h, exclusive
    agentLoginDays: { type: [Number], default: [1, 2, 3, 4, 5] },
    agentLoginTimezone: { type: String, default: "America/Los_Angeles" },

    // Per-channel operating-hours rules
    channelOperatingHours: {
      voice: { type: channelHoursSubdoc, default: () => ({ respectsBusinessHours: true }) },
      sms: { type: channelHoursSubdoc, default: () => ({ respectsBusinessHours: true }) },
      rvm: { type: channelHoursSubdoc, default: () => ({ respectsBusinessHours: true }) },
      email: { type: channelHoursSubdoc, default: () => ({ respectsBusinessHours: false }) },
    },

    // Master kill switch — if false, all queue/assignment workers no-op.
    // Layered above env flag PACING_QUEUE_ENABLED (env wins on startup).
    enabled: { type: Boolean, default: true },

    // Audit trail
    history: { type: [auditEntrySubdoc], default: [] },

    lastUpdatedBy: { type: String, default: null },
  },
  {
    timestamps: true,
    collection: "pacingconfigs",
  },
);

module.exports = mongoose.models.ControlPlanePacingConfig
  || mongoose.model("ControlPlanePacingConfig", pacingConfigSchema);
