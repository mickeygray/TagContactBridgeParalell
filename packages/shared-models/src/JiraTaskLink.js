"use strict";

const mongoose = require("mongoose");

/**
 * JiraTaskLink — the durable record of which Jira issues became Logics tasks.
 *
 * This exists because of one property of the destination: Logics tasks are
 * CREATE-ONLY. There is no update route and no delete route in V4, so a task
 * written twice cannot be merged and a task written wrongly cannot be withdrawn —
 * somebody has to open the back office and remove it by hand.
 *
 * That makes the webhook's real hazard duplication rather than failure. Jira retries
 * a webhook it considers unacknowledged, a person can edit an issue and re-fire the
 * event, and the same issue can arrive twice from two rules. Every one of those paths
 * has to converge on "already done", which is what the unique index on jiraKey buys:
 * the second insert loses, deterministically, at the database rather than in
 * application logic that might race with itself.
 *
 * `outcome` records the misses too. An issue we deliberately skipped — no subject,
 * no assignee, already covered by an existing Logics task — is a fact worth keeping;
 * otherwise the next retry re-derives the same decision, and nobody can answer why a
 * ticket never produced a task.
 */
const jiraTaskLinkSchema = new mongoose.Schema(
  {
    // The Jira issue key, e.g. "ASSIGNMENT-2040". One link per issue, forever.
    _id: { type: String, required: true, trim: true },

    outcome: {
      type: String,
      required: true,
      enum: [
        "created",        // a Logics task now exists because of this issue
        "skipped",        // deliberately not created; `reason` says why
        "failed",         // Logics rejected it; safe to retry
      ],
      index: true,
    },

    tenant: { type: String, enum: ["TAG", "WYNN", "AMITY", null], default: null },
    caseId: { type: Number, default: null },

    // Null on anything but `created`. This is the only handle back to the task.
    logicsTaskId: { type: Number, default: null },

    subject: { type: String, default: null, trim: true },
    // Who it went to. Stored as ids AND names because ids are per-tenant and
    // meaningless on their own — TAG 20 and WYNN 20 are different people.
    userIds: { type: [Number], default: () => [] },
    userNames: { type: [String], default: () => [] },

    jiraProject: { type: String, default: null, trim: true },
    jiraStatus: { type: String, default: null, trim: true },
    jiraAssignee: { type: String, default: null, trim: true },

    /** Why it was skipped or how it failed. Free text, for humans. */
    reason: { type: String, default: null, trim: true },

    /** Which webhook event produced this — issue_created, issue_updated, manual. */
    trigger: { type: String, default: null, trim: true },

    attempts: { type: Number, default: 1, min: 0 },
    lastAttemptAt: { type: Date, default: Date.now },
  },
  { timestamps: true, collection: "jiratasklinks" },
);

// Answers "what did the bridge do lately", which is the first question when
// somebody says a ticket did not come through.
jiraTaskLinkSchema.index({ createdAt: -1 });
jiraTaskLinkSchema.index({ tenant: 1, caseId: 1 });

module.exports = mongoose.models.JiraTaskLink
  || mongoose.model("JiraTaskLink", jiraTaskLinkSchema);
