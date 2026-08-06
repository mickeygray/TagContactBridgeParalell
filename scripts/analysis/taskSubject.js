"use strict";

/**
 * taskSubject — turn a Jira issue into an instruction a person can act on.
 *
 * Mickey 2026-08-05: "use some logic and Biz POA would be File POA For business:
 * then everything else."
 *
 * A subject is assembled from three parts, in this order:
 *
 *     ACTION          what to do          FILE POA / RUN THS / PREP RETURN / AMEND RETURN
 *     QUALIFIER       which return        FOR BUSINESS
 *     YEARS           which years         2025, 2020-2025, "2015, 17, 18, 19"
 *
 * so "2020-2025 Biz POA in logics, will need biz prac..." becomes
 * "FILE POA FOR BUSINESS 2020-2025" rather than the useless "To Do" it carries now.
 *
 * ── WHY THE YEARS ARE READ ONLY FROM THE FRONT ──────────────────────────────
 *
 * Years are taken from a LEADING year expression and nowhere else. An earlier
 * version scanned the whole description for year-shaped tokens and took the
 * min-max, which invented work: "balances were just assessed in June of 2026"
 * pushed a span to 2026, and "he's up to date with filing" produced "2003-2024"
 * out of the stray tokens "03" and "24". A span also silently fills gaps, turning
 * "2019 & 2021 PREP 2022-2024" into 2019-2024 and quietly adding 2020.
 *
 * The convention in this data is that the years lead and the prose follows —
 * "2020-2025 Biz POA in logics", "2021 - 2025 WAITING ON POA", "23-25". So the
 * leading expression is read verbatim and anything mid-sentence is ignored. When
 * a description does not start with years, the subject carries no years at all and
 * the note carries the detail. A subject with no years is a mild loss; a subject
 * with the WRONG years gets the wrong returns prepared.
 */

/** A leading run of digits and separators — "2020-2025 ", "23-25 ", "2015, 17, 18, 19 ". */
const LEADING_YEARS = /^\s*((?:\d{2,4})(?:\s*(?:[,&/–—-]|and|\+)\s*\d{2,4})*)\s*(?=$|[^\d])/i;

/** Business-entity work. "prac" is excluded — it appears in both contexts here. */
const BUSINESS = /\bbiz\b|\bbusiness\b|\bcorp\b|\bllc\b|\bs-?corp\b|partnership|\b1120\b|\b1065\b|sole prop|entity/i;

const ACTIONS = [
  { key: "AMEND", re: /\bamm?end(ed|ment)?\b|\b1040-?x\b/i, action: "AMEND RETURN" },
  { key: "POA", re: /\bpoa\b|power of attorney/i, action: "FILE POA" },
  { key: "MISSING_YEARS", re: /missing (tax )?years?|all missing years|midding tax years/i, action: "FILE POA" },
  { key: "THS", re: /\bths\b|transcript/i, action: "RUN THS" },
  { key: "RETURN", re: /\brtns?\b|\breturns?\b|\bprep\b|\bsfr\b|\bfile \d{4}|\btr'?s?\b/i, action: "PREP RETURN" },
];

/** Things that are waiting on somebody outside the building, not an instruction. */
const EXTERNAL = [
  { key: "DOCS", re: /\bdocs?\b|document|w-?2\b|1099|paperwork/i },
  { key: "SIGNATURE", re: /signature|\bsign\b|8879/i },
  { key: "PAYMENT", re: /\bpaid\b|payment|invoice|balance due/i },
  { key: "CLIENT", re: /\bclient\b|customer|taxpayer|\bwife\b|\bhusband\b|spouse/i },
];

/** Acronyms that must not be title-cased into nonsense ("A/s", "Poa", "Ths"). */
const ACRONYMS = new Set(["A/S", "POA", "THS", "IRS", "SFR", "ID", "TR", "TRS", "T.O.", "CNC", "CDP"]);

function titleCase(s) {
  return String(s || "").split(/\s+/).map((w) => {
    const bare = w.replace(/[^A-Za-z/.']/g, "");
    if (ACRONYMS.has(bare.toUpperCase())) return bare.toUpperCase();
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(" ");
}

/**
 * Compose the final subject: the action, then a colon, then what it applies to.
 *
 *     Hold For A/S: 2025 Return
 *     Hold For A/S: 23-25 Returns
 *     File POA For Business: 2020-2025
 *     Prep Return: 2025
 *
 * The noun is only added for a workflow STATUS, which says where the work has got
 * to but not what the work is. An action lead already contains its own noun —
 * "Prep Return: 2025 Return" would be silly.
 */
function compose(lead, scope, years, addNoun) {
  const head = [titleCase(lead), scope ? titleCase(scope) : ""].filter(Boolean).join(" ");
  if (!years) return head;
  // Plural when the expression names more than one year: "23-25", "2024 & 2025".
  const noun = addNoun ? (/[-–—,&]|and/i.test(years) ? " Returns" : " Return") : "";
  return `${head}: ${years}${noun}`;
}

/**
 * When the work does not reduce to a clean action, show the note itself.
 *
 * Mickey 2026-08-05: "basically the subject can be almost the entire thing... for
 * things that are not exactly as grounded in a task."
 *
 * These are the ones where no verb, no years and no recognisable blocker could be
 * found — or where two jobs were written into one issue. Inventing a tidy label for
 * those would be worse than useless, because a confident-looking subject implies
 * somebody decided what the work was. Nobody did. Showing the description means the
 * person opening it reads exactly what their colleague wrote, and can judge it.
 *
 * Only reached for the state-y statuses, since a meaningful status returns earlier.
 */
function describeSubject(text) {
  const t = String(text || "").trim().replace(/\s+/g, " ");
  if (t.length <= 150) return t;
  // Cut on a word boundary so the subject does not end mid-word.
  const cut = t.slice(0, 150);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 100 ? cut.lastIndexOf(" ") : 150)}…`;
}

function leadingYears(text) {
  const m = String(text || "").match(LEADING_YEARS);
  if (!m) return "";
  const expr = m[1].trim()
    .replace(/\s*([,&/–—-])\s*/g, "$1")
    .replace(/,(\S)/g, ", $1")
    .replace(/&/g, " & ")
    .replace(/\s+/g, " ");
  // Reject a bare 2-digit number that is not plausibly a year ("5 returns").
  const nums = expr.match(/\d{2,4}/g) || [];
  const plausible = nums.every((n) => {
    const v = n.length === 2 ? 2000 + Number(n) : Number(n);
    return v >= 2000 && v <= 2026;
  });
  return plausible && nums.length ? expr : "";
}

/**
 * @returns {{subject: string|null, action: string|null, business: boolean,
 *            years: string, waitingOn: string|null, reason: string}}
 */
function deriveSubject(description, jiraStatus) {
  const text = String(description || "").trim().replace(/\s+/g, " ");
  if (!text) {
    return { subject: null, action: null, business: false, years: "", waitingOn: "EMPTY",
      reason: "No description — nothing to build an instruction from." };
  }

  const years = leadingYears(text);
  const business = BUSINESS.test(text);
  const personal = /\bpersonal\b|\b1040\b(?!-?x)/i.test(text);
  const scope = business && personal ? "FOR BUSINESS AND PERSONAL" : business ? "FOR BUSINESS" : "";

  // A status that is ALREADY an instruction wins over anything read out of the
  // description. HOLD FOR A/S, SENT FOR SIGNATURES and READY TO FILE say where the
  // work has got to; the description under them is usually just the years. Deriving
  // from the description instead would retitle a job that is halfway through the
  // workflow as though it were about to start — "PREP RETURN 23-25" for a return
  // that is already prepared and sitting with the A/S team.
  //
  // The state-y statuses are the opposite case: they say nothing, which is exactly
  // why this function exists, so for those the description is the better source.
  const STATE_Y = /^(to do|to do'?s|roadblock|state|irs)$/i;
  const statusIsInstruction = jiraStatus && !STATE_Y.test(String(jiraStatus).trim());
  if (statusIsInstruction) {
    // addNoun: the status says where the work is, not what it is, so name the thing.
    return { subject: compose(jiraStatus, scope, years, true),
      action: String(jiraStatus).trim(), business, years, waitingOn: null,
      reason: `status is already an instruction${years ? " + leading years" : ""}` };
  }

  // The instruction is in the FIRST sentence; everything after it is background.
  //
  // "2020-2025 Biz POA in logics, will need biz prac for income reported. Client has
  // provided a T.O. Current IRS balances in cnc, IRS sending letters requesting TR's."
  // is a POA job. Reading the whole string also matches "TR's" in that last clause
  // and makes it look like a return job too — but nobody is being asked to prepare a
  // return there, it is explaining why the POA matters. Matching against the opening
  // clause keeps the ask and drops the commentary.
  const opening = text.split(/(?<=[.;])\s+/)[0] || text;

  // Every action the OPENING matches, not just the first one in priority order. Two
  // genuinely DIFFERENT actions in one opening means two jobs were written into one
  // issue — "2019 & 2021 PREP 2022-2024 AMEND" is a prep job and an amend job with
  // different years. Picking the higher-priority verb would attach the wrong years to
  // the wrong work, so those go to a human rather than get a confidently wrong subject.
  let matched = ACTIONS.filter((a) => a.re.test(opening));
  // Nothing in the opening — the ask may genuinely be later ("Please file 2021 tax
  // return. IRS is in the process of..."), so fall back to the whole description.
  if (!matched.length) matched = ACTIONS.filter((a) => a.re.test(text));
  const distinct = [...new Set(matched.map((a) => a.action))];

  if (distinct.length > 1) {
    return { subject: describeSubject(text, jiraStatus), action: null, business, years,
      waitingOn: "AMBIGUOUS",
      reason: `two different jobs in one description: ${distinct.join(" + ")}` };
  }

  const hit = matched[0];
  if (hit) {
    // "AMMEND 2025" puts the verb first and the years second, so nothing leads. Once
    // the verb is removed the remainder is years-only and just as unambiguous — this
    // recovers those without reopening the door to years scraped out of prose, since
    // the leftover still has to be NOTHING BUT years to qualify.
    const afterVerb = years ? years : leadingYears(text.replace(hit.re, " ").trim());
    const subject = compose(hit.action, scope, afterVerb, false);
    return { subject, action: hit.action, business, years: afterVerb, waitingOn: null,
      reason: `matched ${hit.key}${scope ? ` + ${scope.toLowerCase()}` : ""}${years ? " + leading years" : ""}` };
  }

  // No verb, but the description is nothing but years — the commonest shape in
  // this data, and it means prepare those returns.
  if (years && text.replace(LEADING_YEARS, "").trim() === "") {
    const subject = compose("PREP RETURN", scope, years, false);
    return { subject, action: "PREP RETURN", business, years, waitingOn: null,
      reason: "description is only years" };
  }

  const ext = EXTERNAL.find((e) => e.re.test(text));
  if (ext) {
    return { subject: describeSubject(text, jiraStatus), action: null, business, years,
      waitingOn: ext.key, reason: `waiting on ${ext.key} — not a clean instruction` };
  }

  return { subject: describeSubject(text, jiraStatus), action: null, business, years,
    waitingOn: "UNCLEAR", reason: "no verb, no years, no recognisable blocker" };
}

module.exports = { deriveSubject, leadingYears, BUSINESS, ACTIONS };
