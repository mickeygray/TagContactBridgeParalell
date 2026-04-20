"use strict";

const MATCH_CONFIDENCE = {
  EXACT: "exact",
  STRONG: "strong",
  PROBABLE: "probable",
  WEAK: "weak",
  UNRESOLVED: "unresolved",
};

const MATCH_METHODS = {
  LOGICS_SOURCE_ID: "logics-source-id",
  SOURCE_CANONICAL_TRACKING: "source-canonical-tracking",
  SOURCE_CANONICAL_PHONE: "source-canonical-phone",
  SOURCE_CANONICAL_ALIAS: "source-canonical-alias",
  LEAD_CADENCE_SOURCE: "lead-cadence-source",
  CALLRAIL_TRACKING: "callrail-tracking",
  RINGCENTRAL_EXT: "ringcentral-ext",
  MANUAL_LOCK: "manual-lock",
  PROFILE_FALLBACK: "profile-fallback",
  UNRESOLVED: "unresolved",
};

const CASE_SYNC_STATES = {
  NEW: "new",
  INDEXED: "indexed",
  MATCHED: "matched",
  ATTRIBUTED: "attributed",
  NEEDS_REVIEW: "needs-review",
  LOCKED_MANUAL: "locked-manual",
};

module.exports = {
  CASE_SYNC_STATES,
  MATCH_CONFIDENCE,
  MATCH_METHODS,
};
