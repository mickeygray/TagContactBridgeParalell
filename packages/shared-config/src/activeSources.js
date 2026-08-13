"use strict";

// WHICH MARKETING SOURCES ARE ACTUALLY RUNNING.
//
// Mickey 2026-07-28: "i promise you didnt write 6850 in new bcd deals this
// month so even if you made 6850 from bcd residuals or i guess that one
// upsell from the guy who was technically a phoneburner aged lead can make
// that look wonky. so sure thats a case for aged if the marketing source
// isnt active kinda rule."
//
// ── why this exists ─────────────────────────────────────────────────────
// ROAS and ROI only mean something for a campaign that is RUNNING. Money
// arriving from a source that no longer runs — residuals from old clients,
// an upsell to someone who came in years ago on a list that is long dead —
// is real revenue, but it is not a return on this month's advertising.
// Booking it against a live piece produces numbers like BCD's 23,125% on
// $8.00 of spend: technically arithmetic, practically nonsense.
//
// So revenue from a non-active source rolls into AGED: counted as money,
// never used as the numerator of a ratio.
//
// ── declared, not inferred ──────────────────────────────────────────────
// "Active" is a business fact, not a data one. Inferring it from spend would
// mean a piece whose spend sheet is late silently becomes Aged, and a piece
// with one stray $8 charge stays live. Mickey says what runs; the code obeys,
// and env overrides let that change without a deploy.

const parseList = (raw) => String(raw || "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

const normalize = (name) => String(name || "").trim().toLowerCase();

// The active roster as of 2026-07-28: three mail pieces plus the paid dial
// and broadcast channels. Everything else is Aged.
const DEFAULT_ACTIVE = [
  "3rd Day (Pink) Urgent Third State",
  "Urgent Third State",
  "Affordability Federal",
  // The rolled-up label itself must be active. Every LD variant folds onto
  // "LD", so if the fold target is not on this roster the whole channel's cost
  // buckets to Aged — which is exactly what happened: $318 of LD spend landed
  // on the Aged row while LD read "no spend".
  "LD",
  "LD CUSTOM",
  "LD CUSTOM 2",
  "LD CUSTOM 3",
  "LD GENERAL",
  "BCD",
];

const AGED_LABEL = "Aged / inactive source";
// Private in-memory bridge between the source calculation and the nightly
// Logics writer. A Symbol keeps case references out of JSON, Mongo facts,
// email templates and API responses while allowing the exact calculation
// that produced the Aged row to identify its own write candidates.
const AGED_CASE_REFS = Symbol.for("tagcontactbridge.report.agedCaseRefs");

// ── LD IS ONE ROW ─────────────────────────────────────────────────────────
//
// Mickey 2026-08-03: "maybe its custom 2 or something maybe do a roll up on
// all LD combining general, custom, etc all the stuff thats different names."
//
// The vendor's feed names churn — LD CUSTOM, LD CUSTOM 2, LD CUSTOM 3, LD
// GENERAL, and whatever they add next. They are one purchase, dialled by one
// mechanism, at one rate, so splitting them across rows fragments the deal
// count and makes every per-row ROAS too small to read. It also means a NEW
// variant appearing is a silent split rather than a visible change.
//
// Anchored with a boundary so "LD" and "LD CUSTOM 2" match while a source
// merely beginning with those letters (say "LDR Outreach") does not.
const LD_LABEL = "LD";
const LD_PATTERN = /^ld\b/i;

function isLdSource(name) {
  return LD_PATTERN.test(String(name || "").trim());
}

/**
 * The row label a source's money belongs on, before any ageing logic.
 * Every LD variant folds to "LD"; everything else keeps its own name.
 */
function canonicalSourceLabel(name) {
  return isLdSource(name) ? LD_LABEL : String(name || "").trim();
}

let cached = null;

function activeSet(env = process.env) {
  if (cached) return cached;
  const list = parseList(env.ACTIVE_SOURCES).length
    ? parseList(env.ACTIVE_SOURCES)
    : DEFAULT_ACTIVE;
  const extra = parseList(env.ACTIVE_SOURCES_EXTRA);
  cached = new Set([...list, ...extra].map(normalize));
  return cached;
}

/** Reset the memo — tests change env between cases. */
function resetActiveSources() { cached = null; }

/**
 * Is this source a campaign currently running?
 *
 * Bucket labels ("(unsourced)", "ABC (catch-all)", "Aged / inactive source")
 * are never active: they are the absence of a source, not a source.
 */
function isActiveSource(name) {
  const key = normalize(name);
  if (!key) return false;
  if (key.startsWith("(") || key.includes("catch-all") || key === normalize(AGED_LABEL)) return false;
  return activeSet().has(key);
}

// Compatibility export: the actual boundary is not a rolling N-day window.
// A sale belongs to current marketing when its case began in the sale month
// or in the FINAL 14 calendar days of the prior month. This fixed 14-day tail
// handles mail lag without letting July 17 behave differently on August 1
// versus August 16.
const AGED_AFTER_DAYS = 14;

/**
 * Is the evidence in the sale month or the final 14 days of its prior month?
 *
 * Unknown create date returns null — UNKNOWN, not young and not old. The
 * caller decides, and must not silently treat "we did not look" as "recent".
 */
function isCaseRecent(caseCreatedDate, monthAnchor) {
  if (!caseCreatedDate || !monthAnchor) return null;
  const evidenceKey = String(caseCreatedDate).slice(0, 10);
  const anchorKey = String(monthAnchor).slice(0, 10);
  const evidence = Date.parse(`${evidenceKey}T00:00:00Z`);
  const anchor = Date.parse(`${anchorKey}T00:00:00Z`);
  if (!Number.isFinite(evidence) || !Number.isFinite(anchor)) return null;
  const anchorDate = new Date(anchor);
  const monthStart = Date.UTC(anchorDate.getUTCFullYear(), anchorDate.getUTCMonth(), 1);
  const nextMonth = Date.UTC(anchorDate.getUTCFullYear(), anchorDate.getUTCMonth() + 1, 1);
  const priorTailStart = monthStart - AGED_AFTER_DAYS * 86400000;
  return evidence >= priorTailStart && evidence < nextMonth;
}

/**
 * The row a source's money belongs on.
 *
 * Mickey 2026-07-28, in order of precedence:
 *
 *   "attributable call to the source = attributed to the source if its in the
 *    sale month or the prior month's final fourteen days"
 *   "create date follows the same calendar boundary if there is no call"
 *   "one post-date agreement means they closed, even if payment is 35 days out"
 *
 * CALL EVIDENCE WINS. Mail leads are bulk-loaded into Logics and then sit for
 * about a week, so the create date is a loading artefact, not the moment the
 * prospect responded. The call is when they actually raised their hand.
 *
 * Only when there is no call at all does the create date decide — and Aged
 * requires BOTH signals to be old, so one recent signal is enough to keep the
 * money with its source.
 */
/**
 * Was the case SOLD inside the window? This is the cohort test.
 *
 * Mickey 2026-07-28: "when i say recurring i mean recurring payments from
 * cases generated that month. so the initial and second payment happen in the
 * same month thats the valid total."
 */
function isSoldInRange(firstPaidDateKey, rangeStart, rangeEnd) {
  if (!firstPaidDateKey || !rangeStart) return null;
  const d = String(firstPaidDateKey).slice(0, 10);
  if (d < String(rangeStart).slice(0, 10)) return false;
  if (rangeEnd && d > String(rangeEnd).slice(0, 10)) return false;
  return true;
}

function sourceBucket(name, {
  caseCreatedDate = null, attributionCallDate = null,
  hasPostdateStatus = false,
  firstPaidDateKey = null, rangeStart = null, rangeEnd = null,
} = {}) {
  // NOT active is no longer enough to be Aged. A stopped mail piece still
  // produces in-month responses, and that money belongs in the channel total
  // even though the piece gets no ratio of its own. Only genuinely OLD money
  // leaves the channel.

  // FIRST PAID is the cohort test and it is decisive when known. A case is
  // this month's business if it was SOLD this month — its initial and any
  // follow-on payment landing in the same window is exactly "the valid
  // total". Sold earlier means every payment now is residual, however fresh
  // the calls look.
  //
  // Deliberately NOT the create date: mail leads are bulk-loaded and sit
  // about a week, so case 368274 was created 2026-05-29 and sold 2026-07-08.
  // Judging it by creation would have aged out a live July sale.
  // 0. LD IS NEVER AGED.
  //
  // Mickey 2026-08-03: "read the name of the source on the case in activities.
  // its LD so its LD." / "aged is more of a tag thing LD is LD" / "cause its
  // coming through the same sorta mechanism of hammering with pb until they
  // close."
  //
  // AGED is a MAIL concept. A mail piece stops running, and the money that
  // trickles in afterwards is not this month's advertising working — that is
  // what the bucket is for. LD has no equivalent: the leads are dialled in
  // PhoneBurner until they close, so a lead that converts on day 60 converted
  // through exactly the same mechanism as one that converted on day 2. Its age
  // says nothing about what produced the sale.
  //
  // What this fixes concretely: a POST-DATED LD sale was landing in Aged. The
  // gate below reads the FIRST PAYMENT date, and a post-date by definition
  // puts that outside the window — so a live LD deal aged out and took its
  // $700 off the LD row. That is the "unattributed deal" on the 2026-07-31
  // board.
  //
  // Deliberately scoped to LD. An earlier attempt exempted every ACTIVE
  // source, which also stopped mail pieces from ageing and broke eight
  // standing rules about exactly that.
  if (isLdSource(name)) return LD_LABEL;

  // 1. SOLD IN RANGE is the gate. A case whose first payment landed in an
  //    earlier month is residual: every payment it makes now is last month's
  //    business arriving late, however fresh its calls look.
  const sold = isSoldInRange(firstPaidDateKey, rangeStart, rangeEnd);
  if (sold === false) return AGED_LABEL;

  // A post-date is already a close, not an untouched old lead. The agreement
  // may intentionally put the first charge 35+ days after the one call that
  // converted them; judging it by charge month would erase that conversion.
  if (hasPostdateStatus === true) return String(name);

  // 2. THE ATTRIBUTABLE CALL is primary. The sale month plus the prior
  //    month's final fourteen days is the accepted mail-response tail.
  const monthAnchor = firstPaidDateKey || rangeStart;
  const callRecent = isCaseRecent(attributionCallDate, monthAnchor);
  if (callRecent === true) return String(name);

  // 3. LEAD AGE decides only when no call can be found. Case 275341 was a
  //    January BCD lead with ZERO calls in the window that closed in July —
  //    real revenue, but not a return on this month's advertising.
  const createRecent = isCaseRecent(caseCreatedDate, monthAnchor);
  if (createRecent === true) return String(name);
  if (createRecent === false) return AGED_LABEL;

  // Nothing said "old" — a gap is not evidence, so do not demote.
  return String(name);
}

// Mail pieces that are NO LONGER RUNNING but still produce in-month money.
// Mickey 2026-07-28: "a piece thats not active but can still count if its in
// month to a total mail roi total mail initial roas."
//
// Mail lags: a drop stops and responses keep arriving for weeks. That money
// is not a return on THAT piece any more — it gets no ratio of its own — but
// the mail spend was real and so is the revenue, so it belongs in the channel
// total. Seeded from the live CallRail source library, 2026-07-28.
const INACTIVE_MAIL = [
  "Urgent Third Postcard State",
  "Urgent Third Postcard Federal",
  "URGENT THIRD PINK DAY 1",
  "Affordability Pink State",
  "Urgent Delinquency Federal",
  "Urgent Third Federal",
  "Citation State",
  "Consumer State",
  "Consumer Letter State Test - (800) 518-6426",
  "3rd Day Fed Consumer (800) 849-5358",
  "3rd Day Federal Consumer",
  "Aged Urgent 3rd Federal (800) 518",
  "5 Day Citation (800) 296-8028",
  "8006435890 Federal Urgent 3rd 3 Day Pink",
];

const MAIL_SET = new Set([
  ...DEFAULT_ACTIVE.filter((n) => !/^LD /i.test(n) && !/^BCD$/i.test(n)),
  ...INACTIVE_MAIL,
].map(normalize));

/**
 * Which paid channel a source belongs to: "mail", "ld", "bcd" or "other".
 *
 * The spend sheet's own channel wins when we have it — it is the system of
 * record for what was bought. Otherwise the name decides, and an unrecognised
 * name is "other" rather than being quietly folded into mail.
 */
function sourceChannel(name, spendChannel = null) {
  if (spendChannel === "mailer") return "mail";
  if (spendChannel === "lead-data") return "ld";
  const key = normalize(name);
  if (!key || key.startsWith("(") || key.includes("catch-all")) return "other";
  if (/^ld\b/.test(key)) return "ld";
  if (/(^|[^a-z])bcd([^a-z]|$)/.test(key)) return "bcd";
  return MAIL_SET.has(key) ? "mail" : "other";
}

function listActiveSources() {
  return [...activeSet()];
}

module.exports = {
  AGED_AFTER_DAYS,
  AGED_CASE_REFS,
  isSoldInRange,
  INACTIVE_MAIL,
  sourceChannel,
  AGED_LABEL,
  isCaseRecent,
  DEFAULT_ACTIVE,
  isActiveSource,
  listActiveSources,
  resetActiveSources,
  sourceBucket,
  LD_LABEL,
  isLdSource,
  canonicalSourceLabel,
};
