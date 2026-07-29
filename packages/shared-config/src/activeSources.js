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
  "LD CUSTOM",
  "LD CUSTOM 2",
  "LD CUSTOM 3",
  "LD GENERAL",
  "BCD",
];

const AGED_LABEL = "Aged / inactive source";

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

// Mickey 2026-07-28: "more than a month old its aged."
//
// One month, measured back from the start of the reporting window — so a July
// report counts cases created from roughly June onward and treats anything
// older as residual. Tight on purpose: an ROI report is this month's money,
// and a case that has been on the books for a year is not this month's
// advertising working.
const AGED_AFTER_DAYS = Math.max(1, Number(process.env.AGED_AFTER_DAYS) || 30);

/**
 * Is a case young enough for its money to count as campaign return?
 *
 * Unknown create date returns null — UNKNOWN, not young and not old. The
 * caller decides, and must not silently treat "we did not look" as "recent".
 */
function isCaseRecent(caseCreatedDate, rangeStart) {
  if (!caseCreatedDate || !rangeStart) return null;
  const created = Date.parse(`${String(caseCreatedDate).slice(0, 10)}T00:00:00Z`);
  const start = Date.parse(`${String(rangeStart).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(created) || !Number.isFinite(start)) return null;
  return created >= start - AGED_AFTER_DAYS * 86400000;
}

/**
 * The row a source's money belongs on.
 *
 * Mickey 2026-07-28, in order of precedence:
 *
 *   "attributable call to the source = attributed to the source if its in the
 *    month its sold regardless of the create date"
 *   "create date in month = sold this month if you cant find call evidence
 *    but you should be able to find it"
 *   "sourced call older than a month, create date older than a month aged"
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
  // 1. SOLD IN RANGE is the gate. A case whose first payment landed in an
  //    earlier month is residual: every payment it makes now is last month's
  //    business arriving late, however fresh its calls look.
  const sold = isSoldInRange(firstPaidDateKey, rangeStart, rangeEnd);
  if (sold === false) return AGED_LABEL;

  // 2. THE ATTRIBUTABLE CALL is primary. Mickey 2026-07-28: "lead age is
  //    secondary to attributable call." A marketing-line call to the source
  //    inside the window IS the response, whatever the lead's age — case
  //    368274 was created 2026-05-29 and called the mail line for 27 minutes
  //    on the day it sold.
  const callRecent = isCaseRecent(attributionCallDate, rangeStart);
  if (callRecent === true) return String(name);

  // 3. LEAD AGE decides only when no call can be found. Case 275341 was a
  //    January BCD lead with ZERO calls in the window that closed in July —
  //    real revenue, but not a return on this month's advertising.
  const createRecent = isCaseRecent(caseCreatedDate, rangeStart);
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
};
