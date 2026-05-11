"use strict";

const mongoose = require("mongoose");

// IDENTIFIER SCOPE: `canonicalKey` is intentionally global — canonical
// sources span domains by design. "Google Ads" means the same thing whether
// TAG or WYNN saw the lead. Per-domain attribution is handled via the
// `domains` array and the `{ sourceIds.domain, sourceIds.sourceId }` index.
const sourceCanonicalSchema = new mongoose.Schema(
  {
    canonicalKey: { type: String, required: true, unique: true, index: true },
    internalName: { type: String, required: true, index: true },
    channel: { type: String, default: "unknown", index: true },
    domains: [{ type: String }],
    active: { type: Boolean, default: true, index: true },
    aliases: [{ type: String }],
    trackingNumbers: [{ type: String }],
    phoneNumbers: [{ type: String }],
    sourceIds: [
      {
        domain: { type: String, required: true },
        sourceId: { type: Number, required: true },
      },
    ],
    ringCentralExtensions: [{ type: String }],
    flags: {
      mailer: { type: Boolean, default: false },
      digital: { type: Boolean, default: false },
      needsReview: { type: Boolean, default: false },
      genericMailCatchall: { type: Boolean, default: false },
    },
  },
  { timestamps: true },
);

sourceCanonicalSchema.index({ internalName: 1, active: 1 });
sourceCanonicalSchema.index({ channel: 1, active: 1 });
sourceCanonicalSchema.index({ "flags.genericMailCatchall": 1, active: 1 });
sourceCanonicalSchema.index({ "sourceIds.domain": 1, "sourceIds.sourceId": 1 });

module.exports =
  mongoose.models.ControlPlaneSourceCanonical ||
  mongoose.model("ControlPlaneSourceCanonical", sourceCanonicalSchema);
