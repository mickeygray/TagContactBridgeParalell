"use strict";

// logicsWitSsnService — pull a case's SSN out of its Logics activity feed by
// finding the uploaded Wage & Income transcript (WIT) document. Logics names
// those documents with the SSN glued into the filename:
//   WIT_2023_608827503.html      (9 contiguous digits)
//   WIT_2024_608-82-7503.html    (dashed)
//   WIT_2024_608 82 7503.html    (spaced)
// (Format confirmed in resolutionDocumentService — "<TYPE>_<year>_<ssn>".)
//
// The transcript backfill takes a CSV of (Database, CaseId), calls this per case
// to recover the SSN, and builds the (CaseId, SSN) manifest that feeds the THS
// batch. SHAPE-AGNOSTIC: it deep-walks the CaseActivity/Activity response and
// matches the WIT filename wherever it sits, so it doesn't depend on the exact
// Logics JSON field names.

// "WIT" then a tax year then the SSN — the SSN is whatever number follows the
// year, so an EIN/tracking number elsewhere in the string can't be mistaken for
// it. Separators between parts may be _, space, or -.
const WIT_FILENAME_RE = /WIT[_\s-]+(?:19|20)\d{2}[_\s-]+(\d{3}[-\s]?\d{2}[-\s]?\d{4})/i;
// Looser fallback: a "WIT"-tagged string that carries an SSN-shaped number close by.
const WIT_NEAR_RE = /wit[\s\S]{0,40}?(\d{3}[-\s]?\d{2}[-\s]?\d{4})/i;

function normalizeSsn(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  if (d.length !== 9) return null;
  return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
}

// Deep-collect every string leaf of the activities response (bounded depth).
function collectStrings(node, out, depth = 0) {
  if (node == null || depth > 8) return;
  if (typeof node === "string") { out.push(node); return; }
  if (Array.isArray(node)) { for (const v of node) collectStrings(v, out, depth + 1); return; }
  if (typeof node === "object" && !(node instanceof Date)) {
    for (const v of Object.values(node)) collectStrings(v, out, depth + 1);
  }
}

// Pure extractor. Returns { ssn, confidence, source, allSsns } or null.
// allSsns = every DISTINCT SSN found in a WIT filename (a joint case can carry a
// spouse's W&I under a different SSN); ssn is the first high-confidence hit.
function extractWitSsn(activities) {
  const strings = [];
  collectStrings(activities, strings);

  const found = []; // { ssn, confidence, source }
  // 1) exact WIT filename (WIT_<year>_<ssn>) — highest confidence
  for (const s of strings) {
    const m = WIT_FILENAME_RE.exec(s);
    if (!m) continue;
    const ssn = normalizeSsn(m[1]);
    if (ssn) found.push({ ssn, confidence: "high", source: s.slice(0, 100) });
  }
  // 2) WIT mentioned near an SSN-shaped number (only if nothing exact matched)
  if (!found.length) {
    for (const s of strings) {
      if (!/wit/i.test(s)) continue;
      const m = WIT_NEAR_RE.exec(s);
      if (!m) continue;
      const ssn = normalizeSsn(m[1]);
      if (ssn) found.push({ ssn, confidence: "medium", source: s.slice(0, 100) });
    }
  }
  if (!found.length) return null;
  const allSsns = Array.from(new Set(found.map((f) => f.ssn)));
  return { ...found[0], allSsns };
}

// Generalized SSN extraction across the transcript document types Logics names
// "<TYPE>_<year>_<ssn>": WIT (Wage & Income), RT-R (Record of Account / Return),
// Tax_Analysis (THS Tax Analysis). Tried in priority order; the SSN is the number
// after the type (year optional). Returns { ssn, docType, source } or null.
const DOC_TYPE_PATTERNS = [
  ["WIT", "WIT"],
  ["RT-R", "RT[-_\\s]?R"],
  ["Tax_Analysis", "Tax[_\\s-]?Analysis"],
];
function extractTranscriptSsn(activities, patterns = DOC_TYPE_PATTERNS) {
  const strings = [];
  collectStrings(activities, strings);
  for (const [name, typeSrc] of patterns) {
    // Bounded arbitrary gap between the type token and the SSN: WIT/RT-R put a
    // year there ("WIT_2023_<ssn>"), Tax_Analysis puts the CLIENT NAME there
    // ("Tax_Analysis_VERNELL_MORGAN_<ssn>.pdf"). Non-greedy + 80-char cap grabs
    // the first SSN after the type without bleeding into another document.
    const re = new RegExp(`${typeSrc}[\\s\\S]{0,80}?(\\d{3}[-\\s]?\\d{2}[-\\s]?\\d{4})`, "i");
    for (const s of strings) {
      const m = re.exec(s);
      if (m) {
        const ssn = normalizeSsn(m[1]);
        if (ssn) return { ssn, docType: name, source: s.slice(0, 100) };
      }
    }
  }
  return null;
}

// "Does this case even have a WIT (Wage & Income) document?" — looser than SSN
// extraction (no SSN needed), for coverage counts: how many cases have a WIT at all.
// No \b anchors: Logics glues the year to "_" (a word char), so \b after the
// year never matches ("WIT_2023_..." — the resolutionDocumentService gotcha).
const WIT_DOC_RE = /WIT[_\s-]?(?:19|20)\d{2}|wage\s*(?:&|and)?\s*income/i;
function hasWitDocument(activities) {
  const strings = [];
  collectStrings(activities, strings);
  return strings.some((s) => WIT_DOC_RE.test(s));
}

// Live wrapper: fetch the case's activities from Logics, report whether it has a
// WIT, and extract the SSN. `client` exposes getActivities(caseId). Never throws
// on a miss — returns ssn:null so callers can log+skip and keep going.
async function resolveCaseSsnFromLogics({ caseId, client }) {
  if (!client || typeof client.getActivities !== "function") {
    throw new Error("resolveCaseSsnFromLogics: a Logics client with getActivities(caseId) is required");
  }
  let activities;
  try {
    activities = await client.getActivities(caseId);
  } catch (err) {
    return { caseId, hasWit: false, ssn: null, confidence: "error", source: null, error: err.message };
  }
  const hasWit = hasWitDocument(activities);
  const hit = extractWitSsn(activities);
  return hit ? { caseId, hasWit, ...hit } : { caseId, hasWit, ssn: null, confidence: "none", source: null };
}

module.exports = { extractWitSsn, hasWitDocument, extractTranscriptSsn, resolveCaseSsnFromLogics, normalizeSsn };
