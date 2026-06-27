"use strict";

const mongoose = require("mongoose");

/**
 * CallLog — Parallel-native attribution engine output.
 *
 * One document per telephony session. Written whenever the call resolver
 * runs (live on call-end, or by the hourly retry sweep). Status drives
 * whether later sweeps revisit the row.
 *
 * This collection is the authoritative source for phone-originated
 * attribution. Prospect intake sources (LD / affiliate / web / social)
 * stay on MasterProspectIndex; CallLog is for everything that comes in
 * via RingCentral or CallRail, where attribution has to be derived from
 * the session rather than captured at form submission.
 *
 * Key chain position:
 *   MasterProspectIndex → CallLog (attribution) → CaseProfile (authoritative)
 *   ↑ intake                                     ↑ metrics + payments loop
 *
 * Why every call writes even when unresolved: the `status: "pending-retry"`
 * rows are how the hourly sweeper finds what to re-run, and the audit chain
 * of every touch (including unattributed ones) is how we recover missed
 * payments — which was the failure mode on the old metrics system.
 */
const callLogSchema = new mongoose.Schema(
  {
    domain: { type: String, required: true, index: true },
    telephonySessionId: { type: String, required: true, index: true },
    callSessionId: { type: String, default: null },

    // Timing
    callStartTime: { type: Date, default: null, index: true },
    callEndTime: { type: Date, default: null },
    durationSec: { type: Number, default: null },
    missed: { type: Boolean, default: false },

    // Participants
    direction: {
      type: String,
      enum: ["inbound", "outbound", "unknown"],
      default: "unknown",
      index: true,
    },
    phone: { type: String, default: null, index: true },
    normalizedPhone: { type: String, default: null, index: true },
    contactName: { type: String, default: null },
    extensionId: { type: String, default: null, index: true },
    agentName: { type: String, default: null },

    // Telephony platform the call rode on:
    //   "ex" — RC EX desk app (the agent's normal RC extension)
    //   "cx" — RingCX queue / dialer
    // Forward-looking field — historical rows from before this stamp
    // landed are null. Stamped at write time:
    //   - CX disposition path (cxWorkspaceService) writes "cx" via $set
    //     so it always wins on CX-routed calls.
    //   - EX writers (attribution resolver, native RC sweep) write "ex"
    //     via $setOnInsert so they don't overwrite a prior CX stamp.
    // Powers the per-agent call-stats breakdown in the Users drawer.
    platform: {
      type: String,
      enum: ["ex", "cx", null],
      default: null,
      index: true,
    },

    // Case binding — nullable until resolver finds a case
    caseId: { type: Number, default: null, index: true },
    caseDomain: { type: String, default: null, index: true },
    caseProfileId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ControlPlaneCaseProfile",
      default: null,
      index: true,
    },

    // Attribution result
    sourceCanonicalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ControlPlaneSourceCanonical",
      default: null,
      index: true,
    },
    sourceName: { type: String, default: null },
    sourceChannel: { type: String, default: null },
    // canonicalKey of the specific piece (when legs[0] matched). This is
    // the "which specific mailer" granularity — not tenant-level "mail".
    mailPieceKey: { type: String, default: null, index: true },

    // LD route-campaign split. Mirrors LeadCadence.routeCampaignKey so
    // vendor rollups (specifically the "Vendor families — today" table)
    // can split LD into ld-custom vs ld-general without joining to the
    // case on the read side. Stamped by callLogSourceBackfillService
    // from the lead's LeadCadence row right before the nightly vendor
    // summary builds. Older rows are null and fall back to the legacy
    // "ld-posting" family classification.
    routeCampaignKey: { type: String, default: null, index: true },
    routeCampaignName: { type: String, default: null },

    // Aged-data override flag. True when: direction=outbound AND the
    // case's createdDate is more than `AGED_DATA_THRESHOLD_DAYS` (default
    // 30) before this call's start. Set at resolver time as a signal
    // for the aged-data reconciler — a future step flips the source to
    // the "aged data" canonical instead of whatever the CaseProfile
    // originally attributed. See notes in callAttributionResolverService.
    outboundBufferAged: { type: Boolean, default: false, index: true },
    caseCreatedDateAtResolve: { type: Date, default: null },

    // Resolver provenance
    strategy: {
      type: String,
      enum: [
        "caseprofile",       // existing CaseProfile carried attribution forward
        "prospect-intake",   // form-based MasterProspect intake source
        "prior-calllog",     // earlier CallLog for the same phone
        "logics-intake",     // legacy short-circuit tag (phased out)
        "callrail",
        "legs[0]",
        "did",
        "legacy",            // from RB_ContactActivity
        "none",
      ],
      default: "none",
      index: true,
    },
    confidence: {
      type: String,
      enum: ["high", "medium", "low", "none"],
      default: "none",
      index: true,
    },
    status: {
      type: String,
      enum: ["resolved", "pending-retry", "unresolvable", "skipped"],
      default: "pending-retry",
      index: true,
    },
    retryAttempts: { type: Number, default: 0 },
    lastRetryAt: { type: Date, default: null },

    resolvedAt: { type: Date, default: null, index: true },
    resolverActor: {
      type: String,
      enum: ["live", "reconcile", "import", "manual"],
      default: "live",
    },

    // Diagnostic payload — what each step tried and what it returned. Kept
    // so we can audit why a specific call ended up with a specific answer
    // (or didn't). Never consumed by reads; pure debugging.
    attempts: { type: mongoose.Schema.Types.Mixed, default: null },
    // Snapshot of RC call-log record's `legs[]` — captured once so later
    // retries don't have to re-fetch if the record already populated.
    legsSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },

    // ── Transcription (Whisper) ────────────────────────────────────────
    // Populated by the async transcription pipeline that runs after the
    // call ends. Usually only for Outbound agent dials (vendor-lead
    // quality review), but the schema doesn't enforce that.
    transcription: {
      status: {
        type: String,
        enum: [
          "pending",
          "processing",
          "completed",
          "no_recording",
          "no_transcript",
          "skipped",
          "transcription_failed",
          "download_failed",
          "retrying",
          "abandoned",
          "error",
        ],
        default: "pending",
        index: true,
      },
      text: { type: String, default: null },
      recordingUri: { type: String, default: null },
      recordingDuration: { type: Number, default: null },
      transcribedAt: { type: Date, default: null },
      error: { type: String, default: null },
      source: { type: String, default: null },
      attempts: { type: Number, default: 0 },
    },

    // ── AI scoring (Claude) ────────────────────────────────────────────
    // Populated after transcription completes. Dimensions mirror the old
    // app's vendor-lead quality rubric so legacy reporting still lines up.
    callScore: {
      overall: { type: Number, default: null },
      dimensions: {
        contactability: { score: Number, note: String },
        legitimacy: { score: Number, note: String },
        tax_issue_present: { score: Number, note: String },
        interest_level: { score: Number, note: String },
        qualification: { score: Number, note: String },
      },
      lead_verdict: { type: String, default: null },
      summary: { type: String, default: null },
      red_flags: [{ type: String }],
      key_details: {
        answered: { type: Boolean, default: null },
        voicemail: { type: Boolean, default: null },
        tax_type: { type: String, default: null },
        tax_amount_mentioned: { type: String, default: null },
        employed: { type: String, default: null },
        willing_to_proceed: { type: String, default: null },
      },
      scoredAt: { type: Date, default: null },
      scoreError: { type: String, default: null },
    },

    // Human-listening archive pipeline. Separate from transcription so we
    // can keep vendor-QC audio handling independent from "download every
    // long call for ops review" without overloading the same state field.
    recordingArchive: {
      status: {
        type: String,
        enum: [
          "not_queued",
          "pending",
          "processing",
          "completed",
          "too_early",
          "no_recording",
          "download_failed",
          "upload_failed",
          "no_group_match",
          "skipped",
          "retrying",
          "abandoned",
          "error",
        ],
        default: "not_queued",
        index: true,
      },
      provider: { type: String, default: null },
      sourceUri: { type: String, default: null },
      mimeType: { type: String, default: null },
      fileName: { type: String, default: null },
      uploadedAt: { type: Date, default: null },
      driveFileId: { type: String, default: null },
      driveFolderId: { type: String, default: null },
      driveWebViewLink: { type: String, default: null },
      driveWebContentLink: { type: String, default: null },
      terminalAgentName: { type: String, default: null },
      terminalExtensionId: { type: String, default: null },
      terminalExtensionNumber: { type: String, default: null },
      terminalLegIndex: { type: Number, default: null },
      agentGroupKey: { type: String, default: null },
      agentGroupLabel: { type: String, default: null },
      error: { type: String, default: null },
      attempts: { type: Number, default: 0 },
    },

    // RingCX-specific identifiers captured at call-placed time for the
    // CX platform. These power the spot-download path in the call
    // review dashboard: agentId narrows the `interaction-metadata`
    // POST so the response stays tiny (typically 1-2 rows for a 2-min
    // window scoped by agent). agentGroupId is a backup filter.
    // campaignId / dialGroupId are diagnostic. externId is the
    // `parallel:DOMAIN:caseId:queueItemId` string we attach at publish
    // time so RingCX active-calls carry our forensic id through.
    //
    // All optional — rows for non-CX platforms (`platform: "ex"`) leave
    // these null. Stamped by `handleCxCallPlaced` in cxCadenceService
    // from `queueItem.metadata.rcxVisibility*` (set at publish time by
    // ringcxLeadServingService).
    ringcx: {
      agentId: { type: String, default: null, index: true },
      agentGroupId: { type: String, default: null },
      agentUsername: { type: String, default: null },
      campaignId: { type: String, default: null, index: true },
      dialGroupId: { type: String, default: null },
      accountId: { type: String, default: null },
      externId: { type: String, default: null, index: true },
      queueItemId: { type: String, default: null, index: true },
      agentEmail: { type: String, default: null },
      actionKey: { type: String, default: null },
      terminalSource: { type: String, default: null },
      // Populated by the bulk archive / spot-download path once the
      // interaction-metadata POST returns. Allows direct GET of
      // recordings/dialogs/{dialogId}/segments/{segmentId} without a
      // second metadata round-trip.
      dialogId: { type: String, default: null },
      segmentIds: { type: [String], default: undefined },
    },
  },
  { timestamps: true },
);

// One row per telephony session per tenant. Session IDs are globally unique
// in RC, but we scope by domain for per-tenant cleanups.
callLogSchema.index({ domain: 1, telephonySessionId: 1 }, { unique: true });

// Hourly retry sweeper lookup.
callLogSchema.index({ status: 1, retryAttempts: 1, createdAt: 1 });

// "Has this phone called before, and was it resolved?" — powers the
// prior-CallLog step in the resolver priority chain.
callLogSchema.index({ domain: 1, normalizedPhone: 1, status: 1, callStartTime: -1 });

// "Show me this case's call history" — powers CaseProfile contact history
// joins + metrics attribution recomputation.
callLogSchema.index({ domain: 1, caseId: 1, callStartTime: -1 });

// Transcription pipeline queue lookup ("give me Outbound calls pending
// transcription within the last N hours"). The pipeline scans this index
// to pick up new work.
callLogSchema.index({ "transcription.status": 1, createdAt: 1 });

// Recording archive retry queue lookup.
callLogSchema.index({ "recordingArchive.status": 1, createdAt: 1 });

// CX Call Tracker `/today` endpoint + per-tenant recent-calls reads.
// Atlas was flagging "high docs-examined : docs-returned" without this —
// Mongo was falling back to {domain,caseId,callStartTime} and scanning
// the whole tenant. With this index, `{ domain: $in, platform: "cx",
// callStartTime: $gte }` becomes a bounded range scan.
callLogSchema.index({ domain: 1, platform: 1, callStartTime: -1 });

// Hourly CX recording archive sweep — queries on callEndTime + platform
// + non-terminal archive status. Same shape as the Tracker index above
// but on callEndTime (which differs by call duration; Mongo can't share
// the index across both fields).
callLogSchema.index({ domain: 1, platform: 1, callEndTime: -1 });

// CX terminal rectification: find a real CX call by its owning queue row
// without relying on unstructured audit blobs.
callLogSchema.index({
  domain: 1,
  platform: 1,
  "ringcx.queueItemId": 1,
  telephonySessionId: 1,
});

module.exports =
  mongoose.models.ControlPlaneCallLog ||
  mongoose.model("ControlPlaneCallLog", callLogSchema);
