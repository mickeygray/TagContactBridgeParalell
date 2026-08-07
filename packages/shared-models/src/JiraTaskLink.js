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
        "pending",        // CLAIMED: a delivery holds this issue and the create
                          //   may be in flight. The insert of this row is the
                          //   arbiter — the unique _id makes the second
                          //   concurrent delivery lose at the database, which
                          //   is the only place a race can be lost safely when
                          //   the destination is create-only.
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

    /**
     * THE FENCING TOKEN — who currently owns this issue.
     *
     * Minted fresh by every successful claim or takeover. Every later write
     * CASes on it, so a writer that lost ownership loses its write too.
     *
     * Without it the claim was a lease with no fence: the takeover CAS proved
     * only that the previous holder had not WRITTEN recently, not that it was
     * dead. A live-but-stalled holder could resume after the drain took over
     * and both would proceed — and against a create-only destination that is a
     * second Logics task nobody can delete. It also let the loser's catch block
     * stamp terminal `failed` over the winner's in-flight claim.
     */
    claimToken: { type: String, default: null },

    /**
     * The DRAIN's own attempt budget, separate from `attempts`.
     *
     * `attempts` counts every write to the row, including successful skip
     * cycles from ordinary issue edits — so a much-edited issue exhausted the
     * crash-recovery budget without the drain ever having run once. This
     * counts only re-drives, which is what the budget is actually for.
     */
    drainAttempts: { type: Number, default: 0, min: 0 },

    /**
     * Is this terminal state worth another go?
     *
     * A `failed` from a transient Logics timeout or an unreadable dedupe window
     * is retryable; a `failed` because the drain gave up is not. Without the
     * distinction the drain could only select `pending`, so every webhook-path
     * failure parked forever with nothing to re-drive it — despite the model's
     * own comment calling `failed` safe to retry.
     */
    retryable: { type: Boolean, default: false },

    // The webhook's issue payload, stored AT CLAIM TIME. Without it a pending
    // claim was a tombstone: the crash the claim exists to survive also lost
    // the only copy of the work, so "pending" could never become anything —
    // durable ownership of a job nobody could ever run. The drain re-drives
    // stale pending claims from this snapshot. Mixed because the shape is
    // Jira's, not ours, and this schema is strict — an undeclared field would
    // be dropped in silence, which is the exact bug class this branch has now
    // hit three times.
    issueSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true, collection: "jiratasklinks" },
);

// Answers "what did the bridge do lately", which is the first question when
// somebody says a ticket did not come through.
jiraTaskLinkSchema.index({ createdAt: -1 });
jiraTaskLinkSchema.index({ tenant: 1, caseId: 1 });

module.exports = mongoose.models.JiraTaskLink
  || mongoose.model("JiraTaskLink", jiraTaskLinkSchema);
