"use strict";

// Fold every phone a Logics case knows into one searchable set.
//
// WHY (work order §3.5): attribution sometimes hides behind the SPOUSE's
// number. Mail lands in a household, the spouse calls the tracking number,
// the case is created under the primary — so the response call cannot be
// tied to the deal and it reads unsourced until someone hand-fixes it.
//
// Proven on live data 2026-07-27 (case 415022, DONALD DAVIS): Logics
// carries SpouseCellPhone (302)898-1247 for BARBARA DAVIS, Logics'
// own Find/FindCaseByPhone 404s on that number, an unattributed outbound
// to it already sat in our call logs (caseId null) — and our
// CaseProfile.normalizedPhones was EMPTY, not even holding Donald's own
// cell. Same shape on 394513 (Nevel).
//
// So: at every point where we already hold a Logics getCaseInfo payload,
// normalize all six phone fields into `normalizedPhones` and stamp the
// spouse block. Costs zero extra API calls — it rides reads we already make.
//
// PURE — no I/O, no DB. Callers own persistence.

// Logics phone fields, in identity order. Primary first: the first
// non-empty of these three is the case's primaryPhone.
const PRIMARY_PHONE_FIELDS = Object.freeze(["CellPhone", "HomePhone", "WorkPhone"]);
const SPOUSE_PHONE_FIELDS = Object.freeze([
  "SpouseCellPhone",
  "SpouseHomePhone",
  "SpouseWorkPhone",
]);

/**
 * "(724)967-4387" / "1-724-967-4387" / "7249674387" → "7249674387".
 * Returns null for anything that is not a usable 10-digit US number.
 */
function normalizePhone(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.length === 10 ? digits : null;
}

function cleanText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

/**
 * Fold a Logics getCaseInfo payload into the CaseProfile phone shape.
 *
 * @param {object} data - the `Data` object from getCaseInfo
 * @returns {{
 *   primaryPhone: string|null,      // raw Logics formatting, as before
 *   normalizedPhones: string[],     // deduped 10-digit, primary-first
 *   spouse: object|null,            // spouse block, only when something is set
 *   spousePhones: string[],         // the spouse subset (for reporting/rescue)
 * }}
 */
function foldCasePhones(data = {}) {
  const seen = new Set();
  const normalizedPhones = [];
  const push = (raw) => {
    const normalized = normalizePhone(raw);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    normalizedPhones.push(normalized);
  };

  for (const field of PRIMARY_PHONE_FIELDS) push(data?.[field]);
  const spousePhones = [];
  for (const field of SPOUSE_PHONE_FIELDS) {
    const normalized = normalizePhone(data?.[field]);
    if (normalized && !spousePhones.includes(normalized)) spousePhones.push(normalized);
    push(data?.[field]);
  }

  // primaryPhone keeps Logics' own formatting — existing callers and the
  // CX UI read it as a display value, not a match key.
  const primaryPhone = PRIMARY_PHONE_FIELDS
    .map((field) => cleanText(data?.[field]))
    .find(Boolean) || null;

  const spouse = {
    firstName: cleanText(data?.SpouseFirstName),
    lastName: cleanText(data?.SpouseLastName),
    email: cleanText(data?.SpouseEmail),
    cellPhone: cleanText(data?.SpouseCellPhone),
    homePhone: cleanText(data?.SpouseHomePhone),
    workPhone: cleanText(data?.SpouseWorkPhone),
  };
  const hasSpouse = Object.values(spouse).some(Boolean);

  return {
    primaryPhone,
    normalizedPhones,
    spouse: hasSpouse ? spouse : null,
    spousePhones,
  };
}

/**
 * The `$set` fragment for `caseProfileRepository.upsertCaseProfile`.
 *
 * Omits keys entirely when there is nothing to say, so a fold can never
 * blank out data another writer already stamped. `spouse` is only written
 * when Logics actually reports one.
 */
function buildCaseProfilePhonePatch(data = {}) {
  const folded = foldCasePhones(data);
  const patch = {};
  if (folded.primaryPhone) patch.primaryPhone = folded.primaryPhone;
  if (folded.normalizedPhones.length) patch.normalizedPhones = folded.normalizedPhones;
  if (folded.spouse) patch.spouse = folded.spouse;
  return patch;
}

module.exports = {
  PRIMARY_PHONE_FIELDS,
  SPOUSE_PHONE_FIELDS,
  buildCaseProfilePhonePatch,
  foldCasePhones,
  normalizePhone,
};
