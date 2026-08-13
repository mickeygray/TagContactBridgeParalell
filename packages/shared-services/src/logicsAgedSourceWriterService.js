"use strict";

// Write the nightly report's EXACT Aged decisions back to Logics.
//
// This service does not re-age cases and does not run another report gather.
// The source block attaches a non-enumerable list of the deal cases it placed
// on the Aged row; this consumer validates that the Logics source has not
// changed since the gather, then moves the case to the confirmed Aged source.

const { createLogicsClient } = require("../../shared-integrations/src/logicsClient");
const {
  AGED_CASE_REFS,
  AGED_LABEL,
} = require("../../shared-config/src/activeSources");
const {
  CANONICAL_NIGHTLY_REPORT_NAMES,
} = require("../../shared-config/src/dailyReportContract");
const {
  SOURCE_CAMPAIGN_LABELS,
  resolveLogicsSourceId,
  writeLogicsCaseSourceId,
} = require("./logicsSourceWriterService");

const AGED_SOURCE_NAME = "Aged Data";
// Confirmed read-only against existing Logics cases and their activity
// histories on 2026-08-11. Source IDs are tenant-local; WYNN remains absent
// until its own Aged source is independently confirmed.
const AGED_SOURCE_IDS = Object.freeze({ TAG: 72 });
const CANONICAL_DEFINITION = CANONICAL_NIGHTLY_REPORT_NAMES.FINANCIAL;
const MAX_CASES_PER_RUN = 200;
const MAX_RUN_MS = 3 * 60 * 1000;

function unwrap(value) {
  let out = value?.Data ?? value?.data ?? value;
  if (typeof out === "string") {
    try { out = JSON.parse(out); } catch { return {}; }
  }
  if (Array.isArray(out)) out = out[0] || {};
  return out && typeof out === "object" ? out : {};
}

function sourceIdForLabel(domain, label) {
  const dom = String(domain || "").trim().toUpperCase();
  const raw = String(label || "").trim();
  if (!dom || !raw) return null;
  const writable = resolveLogicsSourceId(dom, raw);
  if (writable) return Number(writable);
  const table = SOURCE_CAMPAIGN_LABELS[dom] || {};
  const found = Object.entries(table).find(([, entry]) => (
    String(entry?.label || "").trim().toLowerCase() === raw.toLowerCase()
  ));
  return found ? Number(found[0]) : null;
}

function agedRefsFromReport(report) {
  const section = (report?.sections || []).find((row) => row?.id === "source" && !row.error);
  const refs = section?.data?.[AGED_CASE_REFS];
  if (!Array.isArray(refs)) return [];
  const unique = new Map();
  for (const ref of refs.slice(0, MAX_CASES_PER_RUN)) {
    const domain = String(ref?.domain || "").trim().toUpperCase();
    const caseId = Number(ref?.caseId);
    if (!domain || !Number.isFinite(caseId) || caseId <= 0) continue;
    unique.set(`${domain}:${caseId}`, {
      domain,
      caseId,
      expectedSource: String(ref?.expectedSource || "").trim() || null,
      expectedSourceId: Number.isFinite(Number(ref?.expectedSourceId))
        ? Number(ref.expectedSourceId)
        : null,
    });
  }
  return [...unique.values()];
}

function eligibleReport({ def, range, report } = {}) {
  if (String(def?.name || "").trim().toLowerCase() !== CANONICAL_DEFINITION) {
    return { eligible: false, reason: "not-canonical-definition" };
  }
  if (!range?.from || range.from !== range.to) return { eligible: false, reason: "not-one-day" };
  if (def?.domain || (def?.filters || []).filter(Boolean).length) {
    return { eligible: false, reason: "scoped-definition" };
  }
  if (report?.source === "record") return { eligible: false, reason: "record-has-no-write-evidence" };
  return { eligible: true, reason: null };
}

async function syncAgedLogicsSourcesFromReport({
  def,
  range,
  report,
  logger = null,
  clientFactory = createLogicsClient,
  writer = writeLogicsCaseSourceId,
  maxRunMs = MAX_RUN_MS,
  clock = Date.now,
} = {}) {
  const verdict = eligibleReport({ def, range, report });
  if (!verdict.eligible) return { status: "skipped", reason: verdict.reason };
  if (String(process.env.LOGICS_SOURCE_WRITER_ENABLED || "false").toLowerCase() !== "true") {
    return { status: "skipped", reason: "writer-disabled" };
  }

  const refs = agedRefsFromReport(report);
  const counts = {
    candidates: refs.length,
    planned: 0,
    written: 0,
    alreadyAged: 0,
    unsupportedTenant: 0,
    unverifiableSource: 0,
    sourceChanged: 0,
    unreadable: 0,
    failed: 0,
    deferred: 0,
  };
  const budgetMs = Math.max(1000, Math.min(MAX_RUN_MS, Number(maxRunMs) || MAX_RUN_MS));
  const deadline = clock() + budgetMs;

  for (let index = 0; index < refs.length; index += 1) {
    // This runs only after the report email is accepted, but it still shares
    // the nightly cursor. Bound the best-effort Logics work so a slow tenant
    // cannot hold the close open indefinitely. Deferred cases are reconsidered
    // from fresh report evidence on a later night; no stale plan is persisted.
    if (clock() >= deadline) {
      counts.deferred = refs.length - index;
      break;
    }
    const ref = refs[index];
    const agedSourceId = AGED_SOURCE_IDS[ref.domain] || null;
    if (!agedSourceId) { counts.unsupportedTenant += 1; continue; }
    const expectedSourceId = ref.expectedSourceId || sourceIdForLabel(ref.domain, ref.expectedSource);
    if (!expectedSourceId) { counts.unverifiableSource += 1; continue; }

    let currentSourceId = null;
    try {
      const body = unwrap(await clientFactory(ref.domain).getCaseInfo(ref.caseId));
      currentSourceId = Number(body.SourceCampaignID ?? body.SourceID ?? body.sourceId);
    } catch {
      counts.unreadable += 1;
      continue;
    }
    if (currentSourceId === agedSourceId) { counts.alreadyAged += 1; continue; }
    // The report gathered a source and then classified it. If Logics changed
    // before this hook ran, stop: a stale report must never overwrite a newer
    // human correction.
    if (!Number.isFinite(currentSourceId) || currentSourceId !== expectedSourceId) {
      counts.sourceChanged += 1;
      continue;
    }

    counts.planned += 1;
    try {
      const result = await writer({
        domain: ref.domain,
        caseId: ref.caseId,
        sourceId: agedSourceId,
        sourceName: AGED_SOURCE_NAME,
        sourceChannel: "aged",
        logger,
      });
      if (result?.written) counts.written += 1;
      else if (result?.alreadyOk) counts.alreadyAged += 1;
      else counts.failed += 1;
    } catch {
      counts.failed += 1;
    }
  }

  logger?.info?.("logics.aged_source_writer.completed", counts);
  return { status: counts.failed || counts.deferred ? "partial" : "completed", ...counts };
}

module.exports = {
  AGED_SOURCE_IDS,
  AGED_SOURCE_NAME,
  MAX_CASES_PER_RUN,
  MAX_RUN_MS,
  agedRefsFromReport,
  eligibleReport,
  sourceIdForLabel,
  syncAgedLogicsSourcesFromReport,
};
