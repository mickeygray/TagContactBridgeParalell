"use strict";

// Logics source-writer — pillar 2 of the tight loop (2026-07-24).
//
// "Update Logics cases so we don't have to do phone juggling or fight
// drift": when a mail case's true piece is known (attribution review
// resolves it, or a future auto-attributor), write the piece's Logics
// SourceID onto the case via UpdateCase. From then on every payment
// report, export, and reconcile reads the RIGHT source straight off the
// Logics record — attribution drift becomes structurally impossible.
//
// LD cases arrive pre-sourced and never need this. Old/untied cases are
// "Aged Data" (Logics source id pending — extend the registry when known).
//
// Write mechanism precedent: scripts/backfill-logics-ld-source-ids.js
// (client.updateCase({ CaseID, SourceID }) against the WYNN tenant).

const { createLogicsClient } = require("../../shared-integrations/src/logicsClient");
const { caseProfileRepository } = require("../../shared-repositories/src");

// Logics source registry (per tenant). Keys are the CANONICAL piece labels
// used across the metrics board, plus known sheet-name aliases. IDs from
// Mickey, 2026-07-24 (TAG tenant).
// Keys are CallRail source names, matched EXACTLY.
//
// Exact on purpose. The live source library contains several near-misses that
// are genuinely DIFFERENT pieces — "URGENT THIRD PINK DAY 1" (24 calls),
// "8006435890 Federal Urgent 3rd 3 Day Pink" (11), "Affordability Pink State"
// (4) — so any normalizing or fuzzy match would silently write the wrong
// SourceID onto a live client case. An unmapped piece must stay unmapped and
// be reported (see UNMAPPED_SEEN below), never guessed.
//
// 2026-07-28: the pink key carried a " 800-921-9263" suffix that was edited
// out of the CallRail source library on 2026-07-27. Because the lookup is
// exact, the highest-volume piece (389 calls in 45 days) silently resolved to
// "unmapped-piece" — the rename broke attribution with no error anywhere.
const LOGICS_SOURCE_REGISTRY = {
  TAG: {
    "Urgent Third State": 73, // Logics: "Urgent Third White" — 446 calls/45d
    "3rd Day (Pink) Urgent Third State": 74, // Logics: "Urgent Third Pink" — 389 calls/45d
    "3rd Day (Pink) Urgent Third State 800-921-9263": 74, // pre-2026-07-27 name, kept for historical rows
    "Urgent Third Pink State": 74, // mail-sheet alias for the pink piece
    "Affordability Federal": 75, // 194 calls/45d
  },
};

// The name to SHOW for a SourceID. The registry holds several aliases per id
// (mail-sheet spellings, the pre-rename CallRail name); reports need exactly
// one label per piece, so the first alias listed for an id wins.
const CANONICAL_PIECE_BY_ID = Object.freeze(Object.entries(LOGICS_SOURCE_REGISTRY)
  .reduce((acc, [domain, table]) => {
    const byId = {};
    for (const [name, id] of Object.entries(table)) if (!(id in byId)) byId[id] = name;
    acc[domain] = Object.freeze(byId);
    return acc;
  }, {}));

/**
 * Fold any registered alias of a piece onto one label.
 *
 * The same piece reaches reports under several spellings — the CallRail
 * source name, the mail-sheet alias, the pre-rename name, and now the
 * canonical name read back off Logics. Left alone they render as separate
 * rows and one mail piece looks like three underperforming ones.
 *
 * Unregistered names pass through TRIMMED but otherwise untouched: the live
 * library contains genuinely different pieces with similar names, so this
 * folds aliases, never guesses.
 */
function canonicalSourceName(domain, name) {
  const raw = String(name == null ? "" : name).trim();
  if (!raw) return null;
  const id = resolveLogicsSourceId(domain, raw);
  if (!id) return raw;
  return pieceForSourceId(domain, id) || raw;
}

// READ-ONLY identification of every SourceCampaignID we have confirmed, per
// tenant (57/64 are TAG ids, 45-49 are WYNN ids — separate id spaces).
// Identified 2026-07-28 from the cases' own intake lines ("Case received from
// ABC" / "... from LD CUSTOM" / "Source updated to BCD - OG") and confirmed
// by Mickey. NOT write targets — the write registry above stays the three
// active pieces. Labels here match the spend-sheet keys EXACTLY so an LD deal
// and LD spend land on the same report row.
//
// catchAll ids are buckets, not sources: money on them stays visibly
// unresolved instead of being attributed to "ABC" as if that named a piece.
const SOURCE_CAMPAIGN_LABELS = Object.freeze({
  TAG: Object.freeze({
    57: Object.freeze({ label: "ABC", catchAll: true }),
    64: Object.freeze({ label: "BCD", catchAll: false }),
  }),
  WYNN: Object.freeze({
    45: Object.freeze({ label: "LD CUSTOM", catchAll: false }),
    46: Object.freeze({ label: "LD GENERAL", catchAll: false }),
    47: Object.freeze({ label: "LD CUSTOM 2", catchAll: false }),
    48: Object.freeze({ label: "LD CUSTOM 3", catchAll: false }),
    49: Object.freeze({ label: "ABC", catchAll: true }),
  }),
});

/** {label, catchAll} for a confirmed SourceCampaignID, else null. */
function labelForSourceId(domain, sourceId) {
  const table = SOURCE_CAMPAIGN_LABELS[String(domain || "").toUpperCase()];
  if (!table) return null;
  return table[Number(sourceId)] || null;
}

/** Canonical piece name for a Logics SourceID, or null if unregistered. */
function pieceForSourceId(domain, sourceId) {
  const table = CANONICAL_PIECE_BY_ID[String(domain || "").toUpperCase()];
  if (!table) return null;
  return table[Number(sourceId)] || null;
}

// Piece names seen that no registry entry covers, with counts. Read this to
// find out what the registry is missing instead of discovering it in a report.
const UNMAPPED_SEEN = new Map();

function resolveLogicsSourceId(domain, piece) {
  const registry = LOGICS_SOURCE_REGISTRY[String(domain || "").toUpperCase()];
  if (!registry) return null;
  return registry[String(piece || "").trim()] || null;
}

/**
 * Write a piece's Logics SourceID onto a case. Returns
 *   { written: true }                      — UpdateCase accepted
 *   { written: false, alreadyOk: true }    — Logics already had this source
 *   { written: false, skipped: <reason> }  — unmapped piece/tenant
 * Throws on real Logics errors (caller decides best-effort vs fail).
 */
async function writeLogicsCaseSource({ domain, caseId, piece, logger = null } = {}) {
  const normalizedDomain = String(domain || "").trim().toUpperCase();
  if (String(process.env.LOGICS_SOURCE_WRITER_ENABLED || "false").toLowerCase() !== "true") {
    return { written: false, skipped: "disabled", domain: normalizedDomain };
  }
  const id = Number(caseId);
  if (!Number.isFinite(id) || id <= 0) throw new Error("caseId is required");
  const sourceId = resolveLogicsSourceId(normalizedDomain, piece);
  if (!sourceId) {
    // Surface it. A silent skip is how a one-word rename in CallRail took the
    // biggest mail piece out of attribution for a day without a single error.
    UNMAPPED_SEEN.set(`${normalizedDomain}:${piece}`, (UNMAPPED_SEEN.get(`${normalizedDomain}:${piece}`) || 0) + 1);
    logger?.warn?.("logics.source_writer.unmapped_piece", {
      domain: normalizedDomain, piece, hint: "add this exact CallRail source name to LOGICS_SOURCE_REGISTRY",
    });
    return { written: false, skipped: "unmapped-piece", domain: normalizedDomain, piece };
  }

  const client = createLogicsClient(normalizedDomain);
  let result;
  try {
    result = await client.updateCase({ CaseID: id, SourceID: sourceId });
  } catch (error) {
    const message = String(error?.details?.responseBody?.Message || error.message || "");
    // Logics answers "no updates passed" when the case already carries the
    // value (or the field is on its ignore list) — treat as already-ok.
    if (/no updates passed|ignore list/i.test(message)) {
      logger?.info?.("logics.source_writer.already_ok", { domain: normalizedDomain, caseId: id, sourceId });
      await mirrorCaseProfileSource(normalizedDomain, id, piece).catch(() => null);
      return { written: false, alreadyOk: true, sourceId };
    }
    throw error;
  }

  logger?.info?.("logics.source_writer.written", {
    domain: normalizedDomain,
    caseId: id,
    piece,
    sourceId,
    message: result?.Message || null,
  });
  await mirrorCaseProfileSource(normalizedDomain, id, piece).catch(() => null);
  return { written: true, sourceId };
}

// Keep our CaseProfile mirror in step so local reads agree with Logics
// without waiting for the next case refresh.
async function mirrorCaseProfileSource(domain, caseId, piece) {
  const profile = await caseProfileRepository.findCaseProfileByCaseId?.(domain, caseId);
  const { CaseProfile } = require("../../shared-models/src");
  await CaseProfile.updateOne(
    { domain, caseId: Number(caseId) },
    { $set: { sourceName: String(piece || "").trim(), sourceChannel: "mail" } },
  );
  return profile;
}

module.exports = {
  CANONICAL_PIECE_BY_ID,
  SOURCE_CAMPAIGN_LABELS,
  labelForSourceId,
  canonicalSourceName,
  LOGICS_SOURCE_REGISTRY,
  pieceForSourceId,
  UNMAPPED_SEEN,
  resolveLogicsSourceId,
  LOGICS_SOURCE_REGISTRY,
  resolveLogicsSourceId,
  writeLogicsCaseSource,
};
