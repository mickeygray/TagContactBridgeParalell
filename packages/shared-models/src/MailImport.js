"use strict";

const mongoose = require("mongoose");

// Mail-intake import record. The authoritative store of "this case
// came in via NCOA / mail-house return / Lexis SFTP" with the source-
// specific metadata (lien type, plaintiff, amount, filing date, mail
// date) attached. One row per (domain, caseId).
//
// Why a separate collection from MasterProspectIndex:
// MPI is now scoped to the monthly filler-pool — it gets aggressively
// GC'd by the filler refresh service (rows whose case isn't in Logics
// status=2 are deleted). Mail-intake leads aren't filler-pool members
// — they're a distinct intake stream with their own audit trail
// (mail-house attribution, lien-type-driven outreach scripts, etc.).
// Putting them in MPI was conflating two separate concerns; this
// collection separates them cleanly:
//
//   - MPI                 = filler-pool dialable rows (rebuilt monthly)
//   - LeadCadence         = active cadence per lead
//   - CaseProfile         = engaged cases (refined list)
//   - MailImport (this)   = mail-intake source attribution + metadata
//
// Read paths that need this data:
//   - cxLeadLookupService — surfaces address + lien info to operators
//     when they're matching an unknown caller against a name/address
//   - ncoaUploadService.buildResumeSkipSet — dedup keys for resume-
//     after-crash semantics on partial uploads
//
// Schema is intentionally similar to the prior `MasterProspectIndex`
// shape for the mailIntake fields, so callers that previously read
// `mp.raw.mailIntake / mp.raw.address` can switch to MailImport with
// minimal payload-shape changes.
const mailImportSchema = new mongoose.Schema(
  {
    domain: { type: String, required: true, index: true },
    caseId: { type: Number, required: true, index: true },
    importBatch: { type: String, required: true, index: true },

    // Identity (operator-visible, also used as resume-skip dedup key)
    firstName: { type: String, default: null },
    lastName: { type: String, default: null },
    cellPhone: { type: String, default: null, index: true },

    // Mail-house address — the "no phone match → look up by name+
    // address" CX matching path uses this. State is uppercased on
    // ingest; zip is the 5-digit base (zip+4 stripped at intake time).
    address: { type: String, default: null },
    city: { type: String, default: null },
    state: { type: String, default: null },
    zip: { type: String, default: null },

    // Source attribution — name surfaced by Logics on the case (e.g.
    // "ABC" for the standard NCOA partner). Kept here AND on the
    // Logics case Notes for redundancy.
    sourceName: { type: String, default: null },
    intakeRoute: { type: String, default: "ncoa-upload" },
    partnerSource: { type: String, default: "mail-house-return" },

    // Lien-type / amount metadata. Surfaced in CX UI tooltips so the
    // operator can disambiguate same-name prospects by what kind of
    // case the mail piece was about ("you got our letter about your
    // 2024 federal tax lien?").
    mailIntake: {
      lienType: { type: String, default: null },
      plaintiff: { type: String, default: null },
      amount: { type: String, default: null },
      filingDate: { type: String, default: null },
      mailDate: { type: String, default: null },
      csvSourceName: { type: String, default: null },
    },

    // Full CSV row for audit / re-attribution. Operators occasionally
    // need to see the raw vendor payload to debug "why was this case
    // associated with that mail-house batch?". Kept as Mixed because
    // each vendor ships slightly different column shapes.
    raw: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

// One row per (domain, caseId). Subsequent NCOA uploads of the same
// case (rare; usually the Logics dedup catches it first) update in
// place rather than fanning out duplicates.
mailImportSchema.index({ domain: 1, caseId: 1 }, { unique: true });

// Resume-skip lookup: ncoaUploadService.buildResumeSkipSet reads
// (domain, importBatch) to figure out which rows from a re-uploaded
// CSV have already been processed.
mailImportSchema.index({ domain: 1, importBatch: 1 });

// CX name+address fallback — when an inbound caller doesn't match by
// phone, the operator searches by lastName / address.
mailImportSchema.index({ domain: 1, lastName: 1 });
mailImportSchema.index({ domain: 1, address: 1 });

module.exports =
  mongoose.models.ControlPlaneMailImport ||
  mongoose.model("ControlPlaneMailImport", mailImportSchema);
