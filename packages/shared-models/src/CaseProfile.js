"use strict";

const mongoose = require("mongoose");

const caseProfileSchema = new mongoose.Schema(
  {
    domain: { type: String, required: true, index: true },
    caseId: { type: Number, required: true },
    masterProspectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ControlPlaneMasterProspectIndex",
      default: null,
      index: true,
    },
    sourceCanonicalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ControlPlaneSourceCanonical",
      default: null,
      index: true,
    },
    firstName: { type: String, default: null },
    lastName: { type: String, default: null },
    name: { type: String, default: null },
    email: { type: String, default: null },
    primaryPhone: { type: String, default: null },
    normalizedPhones: [{ type: String }],
    // Mirrored from Logics on sync; also the field the CX form's
    // "Source" input writes to. Lets queues/lists show source attribution
    // without round-tripping to Logics.
    sourceName: { type: String, default: null },
    sourceChannel: { type: String, default: null, index: true },
    // Free-form operator notes — the same Notes column Logics exposes.
    // Mirrored on sync so the UI can show them without an extra fetch.
    notes: { type: String, default: null },
    // ── PII (encrypted at rest) ───────────────────────────────────
    //
    // Stored via packages/shared-auth/src/fieldCrypto encrypt/decrypt
    // (AES-256-GCM, key in FIELD_ENCRYPTION_KEY env). Plaintext only
    // exists in memory during a write or an explicit decrypt call.
    // The CX UI never displays raw SSNs — operators see masked
    // ("XXX-XX-1234") via maskSsn. Only the SSN_for_logics export
    // (format: xxx-xx-xxxx) decrypts before sending to Logics.
    ssnEncrypted: { type: String, default: null },
    homePhone: { type: String, default: null },
    // ── Spouse ────────────────────────────────────────────────────
    //
    // Logics' CreateCase/UpdateCase API has no Spouse* fields, so the
    // values live here for our records and travel to Logics only as
    // a structured "Spouse intake" activity-note appended on save.
    spouse: {
      firstName: { type: String, default: null },
      lastName: { type: String, default: null },
      email: { type: String, default: null },
      cellPhone: { type: String, default: null },
      homePhone: { type: String, default: null },
      ssnEncrypted: { type: String, default: null },
    },
    // ── Mailing address (mirrored from Logics + intake) ───────────
    address: { type: String, default: null },
    city: { type: String, default: null },
    state: { type: String, default: null },
    zip: { type: String, default: null },
    statusId: { type: Number, default: null, index: true },
    lastStatusCheckAt: { type: Date, default: null, index: true },
    statusLastChangedAt: { type: Date, default: null, index: true },
    statusCategory: { type: String, default: "client", index: true },
    previousStatusId: { type: Number, default: null },
    previousStatusCategory: { type: String, default: null },
    convertedAt: { type: Date, default: null, index: true },
    // The case's creation date in Logics — distinct from our own
    // CaseProfile.createdAt (which records when the profile was promoted
    // in Parallel, not when the lead was bought). Used for the aged-data
    // attribution override: outbound calls on a mailer-sourced case
    // >30 days past this date should attribute to "aged data" rather
    // than the original mail piece.
    caseCreatedDate: { type: Date, default: null, index: true },
    firstPaymentDate: { type: Date, default: null },
    initialPayment: { type: Number, default: 0 },
    totalPaid: { type: Number, default: 0 },
    paymentsCount: { type: Number, default: 0 },
    lastPaymentDate: { type: Date, default: null },
    lastPaymentAmount: { type: Number, default: 0 },
    paymentIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "ControlPlanePaymentLedger",
      },
    ],
    contactActivityIds: [{ type: mongoose.Schema.Types.ObjectId }],
    attribution: {
      matchedBy: { type: String, default: null },
      confidence: { type: String, default: null },
      lockedManual: { type: Boolean, default: false },
      needsReview: { type: Boolean, default: false },
      reviewReason: { type: String, default: null },
      lastResolvedAt: { type: Date, default: null },
      refineAttempts: { type: Number, default: 0 },
      lastRefineAttemptAt: { type: Date, default: null },
      lastManualAttributionAlertAt: { type: Date, default: null },
    },
    aiActivityReview: {
      reviewId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "ControlPlaneActivityAiReview",
        default: null,
      },
      status: { type: String, default: null, index: true },
      confidence: { type: String, default: null },
      recommendedAction: { type: String, default: null },
      rationale: { type: String, default: null },
      concerns: [{ type: String }],
      positiveNotes: [{ type: String }],
      riskFlags: [{ type: String }],
      reviewedAt: { type: Date, default: null },
      activityCount: { type: Number, default: 0 },
    },
    // Checkpoint for the hourly payment-reconcile loop. Round-robin
    // prefers cases whose `lastCheckedAt` is oldest (or null for new
    // cases) so nothing starves. `lastResult` = "ok" | "logics-error"
    // | "no-payments" etc., just for debug visibility on stale rows.
    paymentReconcile: {
      lastCheckedAt: { type: Date, default: null, index: true },
      lastDriftedAt: { type: Date, default: null, index: true },
      lastResult: { type: String, default: null },
    },
    paymentHandoff: {
      status: { type: String, default: null, index: true },
      requestedAt: { type: Date, default: null, index: true },
      requestedBy: { type: String, default: null },
      workflowId: { type: String, default: null },
      reviewItemId: { type: String, default: null },
      queueActionKey: { type: String, default: null },
      queueItemId: { type: String, default: null },
      leadName: { type: String, default: null },
      phone: { type: String, default: null },
      notes: { type: String, default: null },
      requiredActions: { type: mongoose.Schema.Types.Mixed, default: null },
      processorAlertStatus: { type: String, default: null },
      caseProfileEnsuredAt: { type: Date, default: null },
      source: { type: String, default: null },
    },
    aiCaseReview: {
      reviewId: { type: mongoose.Schema.Types.ObjectId, default: null },
      status: { type: String, default: null, index: true },
      confidence: { type: String, default: null },
      summary: { type: String, default: null },
      reviewedAt: { type: Date, default: null, index: true },
      nextEligibleAt: { type: Date, default: null, index: true },
    },
    qcSummary: {
      reviewId: { type: mongoose.Schema.Types.ObjectId, ref: "ControlPlaneQualityReview", default: null },
      status: { type: String, default: null, index: true },
      confidence: { type: String, default: null },
      score: { type: Number, default: null },
      summary: { type: String, default: null },
      positives: [{ type: String }],
      concerns: [{ type: String }],
      flags: [{ type: String }],
      reviewedAt: { type: Date, default: null },
      reviewType: { type: String, default: null },
    },
    callHistorySummary: {
      totalCalls: { type: Number, default: 0 },
      inboundCalls: { type: Number, default: 0 },
      outboundCalls: { type: Number, default: 0 },
      missedCalls: { type: Number, default: 0 },
      callsOver2: { type: Number, default: 0 },
      callsOver5: { type: Number, default: 0 },
      uniquePhoneCount: { type: Number, default: 0 },
      lastCallAt: { type: Date, default: null, index: true },
      lastInboundAt: { type: Date, default: null },
      lastOutboundAt: { type: Date, default: null },
      lastAnsweredAt: { type: Date, default: null },
      recentCalls: [
        {
          telephonySessionId: { type: String, default: null },
          callStartTime: { type: Date, default: null },
          callEndTime: { type: Date, default: null },
          direction: { type: String, default: null },
          durationSec: { type: Number, default: null },
          phone: { type: String, default: null },
          normalizedPhone: { type: String, default: null },
          agentName: { type: String, default: null },
          sourceName: { type: String, default: null },
          sourceChannel: { type: String, default: null },
          status: { type: String, default: null },
          confidence: { type: String, default: null },
          transcriptionStatus: { type: String, default: null },
          transcriptAvailable: { type: Boolean, default: false },
          recordingAvailable: { type: Boolean, default: false },
          scoreOverall: { type: Number, default: null },
          scoreVerdict: { type: String, default: null },
          scoreSummary: { type: String, default: null },
        },
      ],
    },
    callScoreSummary: {
      totalScoredCalls: { type: Number, default: 0 },
      totalTranscribedCalls: { type: Number, default: 0 },
      averageScore: { type: Number, default: null },
      scoreCoverage: { type: Number, default: null },
      hotCount: { type: Number, default: 0 },
      warmCount: { type: Number, default: 0 },
      coldCount: { type: Number, default: 0 },
      deadCount: { type: Number, default: 0 },
      fakeCount: { type: Number, default: 0 },
      latestScore: { type: Number, default: null },
      latestVerdict: { type: String, default: null },
      latestSummary: { type: String, default: null },
      latestScoredAt: { type: Date, default: null, index: true },
      lastTranscriptAt: { type: Date, default: null },
    },
    conversationAi: {
      workflowId: { type: mongoose.Schema.Types.ObjectId, ref: "ControlPlaneConversationWorkflow", default: null },
      status: { type: String, default: null, index: true },
      optOutDetected: { type: Boolean, default: false, index: true },
      latestInboundAt: { type: Date, default: null },
      latestInboundText: { type: String, default: null },
      aiRecommendedAction: { type: String, default: null },
      aiConfidence: { type: String, default: null },
      aiFlags: [{ type: String }],
      aiSummary: { type: String, default: null },
    },
    communicationThreads: {
      sms: [
        {
          provider: { type: String, default: null },
          threadKey: { type: String, default: null },
          direction: { type: String, enum: ["inbound", "outbound"], default: "outbound" },
          phone: { type: String, default: null },
          body: { type: String, default: null },
          templateKey: { type: String, default: null },
          status: { type: String, default: null },
          workflowId: { type: mongoose.Schema.Types.ObjectId, ref: "ControlPlaneWorkflowRecord", default: null },
          actorEmail: { type: String, default: null },
          actorName: { type: String, default: null },
          sentAt: { type: Date, default: null },
          metadata: { type: mongoose.Schema.Types.Mixed, default: null },
        },
      ],
      email: [
        {
          provider: { type: String, default: null },
          threadKey: { type: String, default: null },
          direction: { type: String, enum: ["inbound", "outbound"], default: "outbound" },
          email: { type: String, default: null },
          subject: { type: String, default: null },
          body: { type: String, default: null },
          templateKey: { type: String, default: null },
          status: { type: String, default: null },
          workflowId: { type: mongoose.Schema.Types.ObjectId, ref: "ControlPlaneWorkflowRecord", default: null },
          actorEmail: { type: String, default: null },
          actorName: { type: String, default: null },
          sentAt: { type: Date, default: null },
          metadata: { type: mongoose.Schema.Types.Mixed, default: null },
        },
      ],
      lastTouchedAt: { type: Date, default: null, index: true },
    },
    communications: [
      {
        channel: { type: String, enum: ["sms", "email", "call", "rvm"], required: true, index: true },
        direction: {
          type: String,
          enum: ["inbound", "outbound", "scheduled"],
          default: "outbound",
          index: true,
        },
        status: { type: String, default: null },
        provider: { type: String, default: null },
        providerMessageId: { type: String, default: null },
        providerError: { type: String, default: null },
        threadKey: { type: String, default: null },
        phone: { type: String, default: null },
        email: { type: String, default: null },
        subject: { type: String, default: null },
        body: { type: String, default: null },
        templateKey: { type: String, default: null },
        workflowId: { type: String, default: null },
        conversationMessageId: { type: String, default: null },
        actorEmail: { type: String, default: null },
        actorName: { type: String, default: null },
        happenedAt: { type: Date, default: null, index: true },
        sentAt: { type: Date, default: null },
        source: { type: String, default: "case-profile" },
        metadata: { type: mongoose.Schema.Types.Mixed, default: null },
      },
    ],
    scrubSummary: {
      status: { type: String, default: null, index: true },
      reviewedAt: { type: Date, default: null, index: true },
      actorEmail: { type: String, default: null },
      activityReviewStatus: { type: String, default: null },
      activityReviewConfidence: { type: String, default: null },
      activityReviewError: { type: String, default: null },
      providers: {
        activities: { type: mongoose.Schema.Types.Mixed, default: null },
        payments: { type: mongoose.Schema.Types.Mixed, default: null },
        invoices: { type: mongoose.Schema.Types.Mixed, default: null },
        billingSummary: { type: mongoose.Schema.Types.Mixed, default: null },
      },
    },
  },
  { timestamps: true },
);

caseProfileSchema.index({ domain: 1, caseId: 1 }, { unique: true });
caseProfileSchema.index({ domain: 1, sourceCanonicalId: 1, convertedAt: -1 });
caseProfileSchema.index({
  domain: 1,
  sourceCanonicalId: 1,
  "attribution.refineAttempts": 1,
  "attribution.lastRefineAttemptAt": 1,
});

module.exports =
  mongoose.models.ControlPlaneCaseProfile ||
  mongoose.model("ControlPlaneCaseProfile", caseProfileSchema);
