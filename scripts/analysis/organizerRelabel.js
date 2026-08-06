"use strict";
/**
 * organizerRelabel — decide which notes are "Follow Up On Tax Organizer".
 *
 * Mickey 2026-08-05: waiting on docs means the client has not returned their tax
 * organizer, and that is its own job rather than a blocked prep. "Follow Up On Tax
 * Organizer" covers it whether the organizer was already sent or never went out.
 *
 * The trap is that "docs" appears in 112 of 809 notes and most of them are NOT
 * waiting. "Please prep return. docs are in logics." says the documents ARRIVED —
 * relabelling that as a follow-up would send someone to chase paperwork already
 * sitting on the case. So the note has to say it is WAITING, not merely mention docs.
 */

/** Waiting language must be present — mentioning docs is not enough. */
const WAITING = /\bwaiting\b|\bwait(s|ed|ing)? (on|for)\b|\bneed(s|ed)? (the )?(docs?|t\.?o\.?)|\bmissing (docs?|paperwork)|\bhave n[o']?t (received|gotten)|\bchas(e|ing)\b|\bfollow(ing)? up\b/i;

/**
 * The thing being waited on has to be the organizer or the client's paperwork.
 *
 * The abbreviation needs care: a case-insensitive /\bt\.?\s?o\.?\b/ also matches the
 * ordinary English word "to", which is in almost every sentence. That pulled in
 * "waiting for s/o to verify client's info" — a POA name-mismatch ticket with no
 * organizer involved at all. So the abbreviation is only recognised when it is
 * punctuated ("T.O.") or capitalised ("TO"), which is how it is actually written here.
 *
 * Case sensitivity has to be split, not applied wholesale. These notes are often
 * shouted — "2025 - WAITING ON DOCS" — so the document words must be matched
 * case-INsensitively. Only the bare two-letter abbreviation needs case sensitivity,
 * to keep "TO" (the organizer) apart from "to" (the preposition).
 */
const ORGANIZER_ANY_CASE = /t\.\s?o\.?|tax organizer|\borganizer\b|\bdocs?\b|\bdocument(s|ation)?\b|\bpaperwork\b/i;
const ORGANIZER_UPPER = /\bTO\b/;
const ORGANIZER = {
  test: (s) => ORGANIZER_ANY_CASE.test(s) || ORGANIZER_UPPER.test(s),
};

/** Explicit statements that the documents are already in hand — never a follow-up. */
const ALREADY_HAVE = /docs? (are|is)? ?in logics|docs? received|received (the )?docs?|has sent back|sent back a t\.?o\.?|docs? uploaded|uploaded/i;

/** Waiting on something that is NOT the client's paperwork. */
const OTHER_BLOCKER = /waiting (on|for) (a )?poa\b|waiting (on|for) ths\b|waiting (on|for) transcript/i;

function isOrganizerFollowUp(note) {
  const t = String(note || "").trim();
  if (!t) return { hit: false, why: "empty note" };
  if (ALREADY_HAVE.test(t)) return { hit: false, why: "note says the documents are already in hand" };
  if (!ORGANIZER.test(t)) return { hit: false, why: "no mention of organizer or documents" };
  if (!WAITING.test(t)) return { hit: false, why: "mentions documents but does not say it is waiting" };
  // A note waiting on BOTH a POA and docs is primarily a POA block — the POA team
  // has to move first, and chasing the client will not unblock it.
  if (OTHER_BLOCKER.test(t) && !/waiting (on|for) (additional )?(docs?|t\.?o\.?)/i.test(t)) {
    return { hit: false, why: "waiting on a POA or transcripts, not on the client's paperwork" };
  }
  return { hit: true, why: "waiting on the client's organizer or documents" };
}

module.exports = { isOrganizerFollowUp };

if (require.main === module) {
  const fs = require("fs");
  let rows = [];
  for (let i = 0; i < 14; i++) rows = rows.concat(JSON.parse(fs.readFileSync(`scripts/analysis/notes-batch-${i}.json`, "utf8")));
  const hits = rows.filter((r) => isOrganizerFollowUp(r.note).hit);
  const near = rows.filter((r) => !isOrganizerFollowUp(r.note).hit && ORGANIZER.test(r.note));
  console.log(`  ${hits.length} of ${rows.length} notes -> Follow Up On Tax Organizer\n`);
  const f = {};
  for (const r of hits) { const k = r.note.toLowerCase().replace(/\d{2,4}/g, "YYYY").replace(/[^a-z\s.]/g, " ").replace(/\s+/g, " ").trim().slice(0, 46); f[k] = (f[k] || 0) + 1; }
  for (const [k, n] of Object.entries(f).sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`    ${String(n).padStart(3)}  "${k}"`);
  console.log(`\n  EXCLUDED but mention docs (${near.length}) — check these are right to exclude:`);
  const g = {};
  for (const r of near) { const w = isOrganizerFollowUp(r.note).why; g[w] = (g[w] || 0) + 1; }
  for (const [k, n] of Object.entries(g).sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(3)}  ${k}`);
  console.log(`\n  sample exclusions:`);
  for (const r of near.slice(0, 8)) console.log(`    "${r.note.slice(0, 62)}"\n        -> ${isOrganizerFollowUp(r.note).why}`);
}

