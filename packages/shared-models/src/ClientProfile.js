"use strict";

const mongoose = require("mongoose");

function normalizeDomain(value) {
  return String(value || "TAG").trim().toUpperCase() || "TAG";
}

function buildProfileKey(domain, caseNumber) {
  const key = String(caseNumber || "").trim();
  return key ? `${normalizeDomain(domain)}:${key}` : "";
}

// ClientProfile — the resolution-intelligence entity: ONE ROW PER CLIENT,
// elevated above caseProfiles (per-case, operational). The case bank is a
// bank of clientProfiles: seeded from the case-master workbook (the activity
// pipeline's work product), then maintained by the Logics per-case poller,
// the caseProfiles→clientProfiles elevation mechanic, and document scrapes.
//
// Shorthand is the scrapers' compact tracked state (provenance + as-of per
// field); opportunities are the gem scan's output. Documents are NEVER
// stored — only scraped objects and content hashes (see resolution doctrine).

const clientProfileSchema = new mongoose.Schema(
  {
    // Identity. caseNumber = Logics CaseID. This bank is case-scoped; private
    // person/contact identity stays in Logics until an explicit lookup needs it.
    profileKey: { type: String, required: true, unique: true, index: true },
    caseNumber: { type: String, required: true, index: true },
    clientKey: { type: String, default: null, index: true, select: false },
    // Deprecated/non-selected: this bank stores case identity, not private
    // contact identity. Contact details are fetched from Logics only when
    // an explicit contact action needs them.
    clientName: { type: String, default: "", select: false },
    domain: { type: String, default: "TAG", index: true },

    // Means: iSoftPull credit picture.
    credit: {
      score: { type: Number, default: null },
      bureau: { type: String, default: null },
      pullCount: { type: Number, default: 0 },
      minScore: { type: Number, default: null },
      maxScore: { type: Number, default: null },
      lastPullDate: { type: Date, default: null },
    },

    // Funding history: lender outcomes from activity mining.
    funding: {
      funded: { type: Boolean, default: false },
      lastLoanDate: { type: Date, default: null },
      lastLoanTotal: { type: Number, default: null },
      lastLoanLender: { type: String, default: null },
      lastLoanAcct: { type: String, default: null },
      rejected: { type: Boolean, default: false },
      lastRejectionDate: { type: Date, default: null },
      lastRejectionAmount: { type: Number, default: null },
      lastRejectionLender: { type: String, default: null },
      denialLenders: [{ type: String }],
      denialDates: [{ type: String }],
      approvalLenders: [{ type: String }],
    },

    // Payment behavior (refunds/charge-backs excluded upstream).
    payments: {
      lastDate: { type: Date, default: null },
      lastAmount: { type: Number, default: null },
      lastType: { type: String, default: null },
      count: { type: Number, default: 0 },
      totalPaid: { type: Number, default: 0 },
    },

    // Touch tracking: resolution work team vs additional-services team.
    touches: {
      work: {
        lastDate: { type: Date, default: null },
        lastBy: { type: String, default: null },
        product: { type: String, default: null },
        noteCount: { type: Number, default: 0 },
      },
      sales: {
        lastDate: { type: Date, default: null },
        lastBy: { type: String, default: null },
        servicesPitched: { type: String, default: null },
        lastPitched: { type: String, default: null },
        noteCount: { type: Number, default: 0 },
      },
    },

    // LLM-read client temperature + the client's own wording.
    temperature: {
      label: { type: String, default: "unknown", index: true },
      signals: { type: String, default: null },
    },

    // Pursuit model (v0 = the workbook's 6-component sum; recomputed as data
    // changes; components kept for explainability).
    pursuit: {
      score: { type: Number, default: 0, index: true },
      tier: { type: String, default: "D", index: true },
      reasons: { type: String, default: null },
      components: { type: mongoose.Schema.Types.Mixed, default: null },
      computedAt: { type: Date, default: null },
    },

    // Scrapers' shorthand ledger (P1+): { field: { value, asOf, source, snippet } }
    shorthand: { type: mongoose.Schema.Types.Mixed, default: null },

    // Gem scan output (P2): [{ play, basis, clock, strategy, status, ... }]
    opportunities: { type: [mongoose.Schema.Types.Mixed], default: [] },

    // Pitch designer state (P2): one active thread per case with the Opus
    // agent — { thread: [{role, content, at, by}], verdict, updatedAt }.
    // Thread is capped at write time; verdict is the latest parsed fence.
    pitch: { type: mongoose.Schema.Types.Mixed, default: null },

    // Document memory WITHOUT documents: content hashes of parsed uploads.
    documentHashes: [
      {
        hash: { type: String },
        docType: { type: String },
        parsedAt: { type: Date },
        label: { type: String },
      },
    ],

    lifecycle: {
      status: { type: String, enum: ["active", "retired"], default: "active", index: true },
      seededFrom: { type: String, default: null },
      retiredAt: { type: Date, default: null },
      retiredReason: { type: String, default: null },
      // Stamped by EVERY upsert (seed, document ingest, elevation).
      lastRefreshedAt: { type: Date, default: null },
      // Stamped ONLY by the Logics appendage refresh — the nightly sweep's
      // dueness clock (lastRefreshedAt made never-polled rows look current).
      lastLogicsRefreshAt: { type: Date, default: null },
      // Stamped on FAILED refresh attempts too. Dueness sorts on the later
      // of refresh/attempt — without this, permanently-failing cases
      // (cancelled in Logics) lead the stalest-first queue every night and
      // five of them trip the circuit breaker before any real work happens.
      lastLogicsAttemptAt: { type: Date, default: null },
    },

    // Upsell-suggestion curation. When the bank surfaces a client as a
    // "look into this" upsell candidate, an operator can dismiss it ("not now"),
    // which snoozes re-suggestion until checkAgainOn (default +30d, config
    // RESOLUTION_UPSELL_SNOOZE_DAYS). suggestedAt/lastBatchKey let "today's
    // suggestions" dedupe; signalLabel records why it surfaced. Deliberately
    // UNINDEXED — additive on a large live collection, so a deploy triggers no
    // background index build.
    upsell: {
      suggestedAt: { type: Date, default: null },
      lastBatchKey: { type: String, default: null },
      signalLabel: { type: String, default: null },
      checkAgainOn: { type: Date, default: null },
      dismissedAt: { type: Date, default: null },
      dismissedBy: { type: String, default: null },
      dismissReason: { type: String, default: null },
    },
  },
  { timestamps: true },
);

clientProfileSchema.pre("validate", function ensureProfileKey(next) {
  this.domain = normalizeDomain(this.domain);
  if (this.caseNumber) this.profileKey = buildProfileKey(this.domain, this.caseNumber);
  next();
});

clientProfileSchema.index({ domain: 1, caseNumber: 1 }, { unique: true });
clientProfileSchema.index({ "pursuit.tier": 1, "pursuit.score": -1 });
clientProfileSchema.index({ "lifecycle.status": 1, "pursuit.score": -1 });

module.exports = mongoose.models.ClientProfile
  || mongoose.model("ClientProfile", clientProfileSchema);
