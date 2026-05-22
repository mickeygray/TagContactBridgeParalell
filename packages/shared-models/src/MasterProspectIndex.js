"use strict";

const mongoose = require("mongoose");

const masterProspectIndexSchema = new mongoose.Schema(
  {
    domain: { type: String, required: true, index: true },
    caseId: { type: Number, required: true },
    statusId: { type: Number, default: null, index: true },
    statusLabelRaw: { type: String, default: null },
    statusCategory: { type: String, default: "prospect", index: true },
    sourceId: { type: Number, default: null, index: true },
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
    cellPhone: { type: String, default: null },
    homePhone: { type: String, default: null },
    workPhone: { type: String, default: null },
    normalizedPhones: [{ type: String, index: true }],
    // Mailing-address fields. DEPRECATED for new writes — mail-intake
    // leads (NCOA, Lexis, mail-house returns) now live in the
    // ControlPlaneMailImport collection (`shared-models/src/MailImport.js`)
    // because MPI is scoped to the monthly filler-pool and gets
    // aggressively GC'd. The fields stay here for backward compat with
    // pre-strip orphan rows that haven't been cleaned up; new writes
    // should go to MailImport instead.
    address: { type: String, default: null },
    city: { type: String, default: null },
    state: { type: String, default: null },
    zip: { type: String, default: null },
    // How this prospect entered the system. Drives downstream UI
    // hints (e.g. mail-intake → show address card prominently) and
    // the partnerSource attribution path.
    intakeRoute: { type: String, default: null, index: true },
    partnerSource: { type: String, default: null, index: true },
    // DEPRECATED for new writes — see ControlPlaneMailImport
    // (`shared-models/src/MailImport.js`). NCOA / Lexis spreadsheet
    // specifics now live there. ncoaUploadService writes to
    // MailImport; cxLeadLookupService reads from MailImport via
    // (domain, caseId) join when surfacing lien/address context.
    // Schema kept for backward compat with pre-strip orphan rows.
    mailIntake: {
      lienType: { type: String, default: null },
      plaintiff: { type: String, default: null },
      amount: { type: String, default: null },
      filingDate: { type: String, default: null },
      mailDate: { type: String, default: null },
      importBatch: { type: String, default: null, index: true },
    },
    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
    lastStatusCheckAt: { type: Date, default: null },
    lastSourceCheckAt: { type: Date, default: null },
    lastMatchedActivityAt: { type: Date, default: null },
    needsStatusRefresh: { type: Boolean, default: true, index: true },
    needsSourceRefresh: { type: Boolean, default: true, index: true },
    convertedAt: { type: Date, default: null, index: true },
    caseProfileId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ControlPlaneCaseProfile",
      default: null,
      index: true,
    },
    metadata: {
      intakeSource: { type: String, default: null },
      sourceName: { type: String, default: null },
      sourceChannel: { type: String, default: null },
      routeCampaignKey: { type: String, default: null },
      routeCampaignName: { type: String, default: null },
      vendorSourceName: { type: String, default: null },
      lastImportBatch: { type: String, default: null },
      notes: [{ type: String }],
      validation: { type: mongoose.Schema.Types.Mixed, default: null },
    },
    // RingCentral telephonySessionIds observed for this prospect's phone.
    // Multi-valued because a prospect may call in multiple times; used by the
    // call log + attribution audit to link back to specific calls.
    telephonySessionIds: [{ type: String }],
    // Monthly filler pool membership.
    //
    // The 1st-of-month filler-build job pulls eligible prospects from
    // Logics (WYNN: opened + digital sources; TAG: opened + 4-month
    // createDate window), DNC-scrubs them, and tags survivors with
    // `pool.tag = "filler-YYYY-MM"`. The CX queue render falls back to
    // this pool when the cadence-driven queue runs sparse.
    //
    // Distinct from MPI's older role as the universal prospect index —
    // mail intake no longer writes here, and we phase down to ~10k
    // monthly filler records vs. the old 99k all-time index.
    pool: {
      tag: { type: String, default: null, index: true },
      source: { type: String, default: null }, // wynn-digital-opened | tag-4mo-opened
      builtAt: { type: Date, default: null },
      dncScrubbedAt: { type: Date, default: null },
    },
    filler: {
      // For round-robin rotation through the pool. CX queue sorts asc
      // so least-recently-attempted fills first.
      lastDialAttempt: { type: Date, default: null },
      attemptCount: { type: Number, default: 0 },
      lastAttemptResult: { type: String, default: null },
      lastDialedByExtensionId: { type: String, default: null },
      lastDialedByAgentName: { type: String, default: null },
      dailyDateKey: { type: String, default: null },
      dailyAttempts: { type: Number, default: 0 },
      monthlyMonthKey: { type: String, default: null },
      monthlyAttempts: { type: Number, default: 0 },
    },
    // Cached DNC lookup result. Populated by the monthly filler build —
    // both clean and rejected rows persist this so we don't re-pay
    // RealValidation per row each month. Reuse threshold is read at
    // build time (default: skip lookup if `checkedAt` < 90 days old).
    //
    // A row with `dnc.onNationalDnc: true` (or litigator / non-cell)
    // stays in MPI without a `pool.tag` — invisible to the dialer queue
    // but cached so the next build's skip-if-fresh optimization kicks in.
    dnc: {
      onNationalDnc: { type: Boolean, default: null },
      onStateDnc: { type: Boolean, default: null },
      onDma: { type: Boolean, default: null },
      isLitigator: { type: Boolean, default: null },
      isCell: { type: Boolean, default: null },
      checkedAt: { type: Date, default: null },
      source: { type: String, default: null }, // "dnc-lookup" | "dnc-plus" | "manual" | etc.
      nextCheckAt: { type: Date, default: null },
    },
    // Append-only audit trail of every attribution decision made for this
    // prospect. The current `sourceCanonicalId` / `metadata.intakeSource` on
    // the doc are the authoritative values; this array explains how we got
    // there. Each entry captures strategy + confidence + which telephony
    // session (if any) drove the write and whether it propagated to Logics.
    attributionLineage: [
      {
        resolvedAt: { type: Date, default: Date.now },
        strategy: { type: String },
        confidence: { type: String, default: null },
        telephonySessionId: { type: String, default: null },
        sourceCanonicalId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "ControlPlaneSourceCanonical",
          default: null,
        },
        sourceId: { type: Number, default: null },
        canonicalKey: { type: String, default: null },
        actor: {
          type: String,
          enum: ["live", "reconcile", "import", "manual"],
          default: "live",
        },
        writtenToLogics: { type: Boolean, default: false },
        logicsError: { type: String, default: null },
        phone: { type: String, default: null },
      },
    ],
  },
  { timestamps: true },
);

masterProspectIndexSchema.index({ domain: 1, telephonySessionIds: 1 });

masterProspectIndexSchema.index({ domain: 1, caseId: 1 }, { unique: true });
masterProspectIndexSchema.index({ domain: 1, statusId: 1 });
masterProspectIndexSchema.index({ domain: 1, statusCategory: 1 });

// Compound index on (domain, cellPhone) for fast phone-based lookups
// AND as the foundation for the future phone-unique constraint that
// closes the concurrent-dedup race in `logicsClient.createCase`.
//
// Today the create-case dedup is application-layer — it queries
// `findCaseByPhone` before creating — but two simultaneous webhooks
// for the same phone can both pass the find (find returns nothing
// for both before either creates) and both proceed to createCase,
// resulting in a duplicate Logics case.
//
// The mongo-level fix is a partial unique index:
//   { domain: 1, cellPhone: 1 } unique, partialFilterExpression: { cellPhone: { $type: "string" } }
//
// Held off-by-default because:
//   a) production data already contains test-driven duplicates (Mickey's
//      phone has multiple cases from today's smoke runs)
//   b) operator must clean those up before mongo will accept the
//      unique constraint, and that cleanup is a deliberate decision
//      (which case-id to keep, whether to merge, etc.)
//   c) the canary cutover is one tracking number / 24h — race-window
//      volume there is small enough that the application-layer dedup
//      is sufficient for cutover-time
//
// To enforce uniqueness later: clean dupes (see scripts/audit-prospect-phone-dupes.js
// when written), then issue:
//   db.controlplanemasterprospectindexes.createIndex(
//     { domain: 1, cellPhone: 1 },
//     { unique: true, partialFilterExpression: { cellPhone: { $type: "string", $ne: "" } } }
//   )
masterProspectIndexSchema.index({ domain: 1, cellPhone: 1 });
masterProspectIndexSchema.index({
  domain: 1,
  needsStatusRefresh: 1,
  statusCategory: 1,
});
// Name + address search — supports the "no phone match → look up by
// name/address" CX scramble path for mail-intake leads.
masterProspectIndexSchema.index({ domain: 1, lastName: 1, firstName: 1 });
masterProspectIndexSchema.index({ domain: 1, address: 1 });
masterProspectIndexSchema.index({ domain: 1, state: 1, zip: 1 });

// Filler-pool round-robin: pick the least-recently-dialed prospects in
// the current month's pool. Sparse so it doesn't bloat — old MPI rows
// without a pool tag are excluded.
masterProspectIndexSchema.index(
  { "pool.tag": 1, "filler.lastDialAttempt": 1 },
  { sparse: true },
);

// Phone-lookup compound — queries like findOne({ domain, normalizedPhones })
// are common in the attribution + lead-source backfill paths. Without
// this, Mongo uses the lone normalizedPhones[i] index then filters
// domain in-memory across both tenants. Compound is much tighter for
// our typical "is this phone known in WYNN" lookups.
masterProspectIndexSchema.index({ domain: 1, normalizedPhones: 1 });

module.exports =
  mongoose.models.ControlPlaneMasterProspectIndex ||
  mongoose.model("ControlPlaneMasterProspectIndex", masterProspectIndexSchema);
