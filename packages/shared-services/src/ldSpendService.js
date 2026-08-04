"use strict";

// LD SPEND — new leads x the per-lead rate.
//
// Mickey 2026-08-03: "the whole point is the email scrape is the spend data."
// "and then LD is new leads * 3." "and bcd is bcd calls * 4."
//
// That completes the retirement of the hand-kept spend sheet. All three
// channels now have a live source and none of them is a person typing:
//
//   mail  the vendor's invoice, scraped out of the mailbox  (MailSpendDay)
//   LD    new leads x $3                                    (here)
//   BCD   bcd calls x $4                                    (nightReportService)
//
// ── WHERE "NEW LEADS" COMES FROM, AND WHY NOT CADENCE ROWS ─────────────────
//
// Distinct `payload.caseId` on EventRecord `inbound.lead.received` — the
// immutable receipt the add loop already writes per lead. NEVER cadence rows.
//
// This is a settled question with a measured answer: in July 2026 (WYNN) 4,585
// leads genuinely arrived but only 4,112 cadence rows still existed — 473 gone,
// 10.3%, and still moving. That undercount is what produced a phantom "$987
// vendor overbill"; the vendor had actually billed 4,437, i.e. 148 FEWER than
// we received. Counting the queue counts what SURVIVED the queue, and the
// queue churns.
//
// Counting DISTINCT caseId rather than events matters too: a vendor retry
// posts twice (1 duplicate across 4,586 July posts). Leads rejected before
// Logics emit a different subtype and are deliberately not counted — we did
// not receive them, so we are not billed for them.
//
// This reads an EVENT log we already keep rather than a parallel stats table,
// which is what the faceplate doctrine actually forbids.

const DEFAULT_LD_COST_PER_LEAD = 3;

/**
 * Dollars per lead. Env-overridable, exactly like BCD_COST_PER_CALL, so the
 * two derived-cost channels are configured the same way and neither becomes a
 * magic number buried in a report.
 */
function ldCostPerLead() {
  const parsed = Number(process.env.LD_COST_PER_LEAD);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LD_COST_PER_LEAD;
}

const addDays = (dateKey, n) =>
  new Date(Date.parse(`${dateKey}T00:00:00.000Z`) + n * 86400000).toISOString().slice(0, 10);

const PACIFIC = "America/Los_Angeles";

// The LD COST day runs 20:00 -> 20:00 Pacific, matching the hour the board is
// published. See countLdLeads for why, and for the vendor-invoice trade-off it
// accepts. Env-overridable so the boundary and the report hour can be moved
// together rather than drifting apart silently.
const COST_DAY_CUTOVER_HOUR = (() => {
  const parsed = Number(process.env.LD_COST_DAY_CUTOVER_HOUR);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 23 ? parsed : 20;
})();

/**
 * Count new leads received in [from..to], inclusive. PACIFIC days.
 *
 * ── WHY PACIFIC, PROVEN NOT ASSUMED ────────────────────────────────────────
 *
 * The first version grouped by UTC day, on the reasoning that the composer's
 * other materials do and one block on a different clock would disagree with
 * the rest of the page. That reasoning was sound and the conclusion was wrong.
 *
 * The retired materializer left four days of receipts in SpendEntry, and those
 * rows are a recording of which boundary the VENDOR bills on:
 *
 *     day        UTC    PT    billed
 *     07-25       81    86        86
 *     07-26      106   111       111
 *     07-27      103   105       105
 *     07-28      120   101       101
 *
 * Pacific matches all four. UTC matches none, and 07-28 is off by 19 leads —
 * $57 on a day that was reconciled with the vendor at 101. A lead arriving
 * 6pm PT is billed to that business day, and UTC has already rolled over.
 *
 * So the window is widened in UTC to cover the boundary and the DAY KEY is
 * computed in Pacific, which is also DST-safe — no fixed -7/-8 offset appears
 * anywhere.
 */
async function countLdLeads({ from, to = from, domain = null, EventRecord = null } = {}) {
  const Model = EventRecord || require("../../event-core/src/models/EventRecord");
  const match = {
    eventType: "inbound.lead.received",
    // ±1 day of slack so a Pacific day's tail is never clipped by a UTC bound.
    // The grouped day key does the real filtering below.
    createdAt: {
      $gte: new Date(`${addDays(from, -1)}T00:00:00.000Z`),
      $lt: new Date(`${addDays(to, 2)}T00:00:00.000Z`),
    },
  };
  if (domain) match["payload.domain"] = String(domain).toUpperCase();

  const raw = await Model.aggregate([
    { $match: match },
    // Distinct (domain, day, caseId) first, THEN count — a vendor retry that
    // posts the same lead twice must bill once.
    //
    // ── THE COST DAY RUNS 20:00 -> 20:00 ────────────────────────────────
    //
    // Mickey 2026-08-04: "i guess we take what it says at 8 pm and go from 8pm
    // to 8pm for ld costs goign forward."
    //
    // A midnight day can never be complete at 8pm — leads keep arriving for
    // four more hours. On 2026-08-03 the board said 107 leads / $321 at
    // 16:56 and the finished day was 141 / $423, so the same day reported two
    // different costs depending on when it ran. Shifting the boundary to the
    // reporting hour makes the number FINAL at the moment it is published.
    //
    // Implemented by subtracting the cutover before taking the day key: a lead
    // at 21:00 on the 3rd shifts to 01:00 on the 4th and lands on the 4th's
    // cost day, which is the day whose 8pm board first reports it.
    //
    // TRADE-OFF, stated because it was proven the other way: Pacific-MIDNIGHT
    // days are what reproduce the vendor's billed counts (86/111/105/101 for
    // 07-25..28). An 8pm day will NOT match their per-day invoice — it
    // reconciles over a month, not a night. That is a deliberate choice of a
    // complete daily number over a per-day tie-out.
    { $group: { _id: {
      d: "$payload.domain",
      c: "$payload.caseId",
      // ADD the remainder of the day, do not subtract the cutover. Cost day D
      // is [D-1 20:00, D 20:00), so shifting FORWARD by 24-20 = 4h maps that
      // window onto calendar day D:
      //   D-1 20:00 + 4h = D 00:00   -> D   (first moment of the cost day)
      //   D   19:59 + 4h = D 23:59   -> D   (last moment)
      //   D   20:00 + 4h = D+1 00:00 -> D+1 (rolls to tomorrow, correctly)
      // Subtracting 20h instead pushed a 10am lead back onto the PREVIOUS day
      // and reported 08-03 as 17 leads.
      day: { $dateToString: {
        date: { $add: ["$createdAt", (24 - COST_DAY_CUTOVER_HOUR) * 3600000] },
        format: "%Y-%m-%d",
        timezone: PACIFIC,
      } },
    } } },
    { $group: { _id: { d: "$_id.d", day: "$_id.day" }, n: { $sum: 1 } } },
  ]);
  // Trim the slack back off: only the days actually asked for.
  const grouped = raw.filter((g) => g._id.day >= from && g._id.day <= to);

  const byDomain = {};
  const byDay = {};
  let leads = 0;
  for (const g of grouped) {
    const d = String(g._id.d || "").toUpperCase() || "-";
    byDomain[d] = (byDomain[d] || 0) + g.n;
    byDay[g._id.day] = (byDay[g._id.day] || 0) + g.n;
    leads += g.n;
  }
  return { leads, byDomain, byDay };
}

/**
 * LD spend for a range: leads x rate.
 *
 * `unavailable` is set when the count could not be read at all. A zero that
 * means "no leads arrived" and a zero that means "we could not ask" must not
 * render identically — that is the whole failure this reporting stack keeps
 * being bitten by.
 */
async function readLdSpend({ from, to = from, domain = null, EventRecord = null } = {}) {
  const rate = ldCostPerLead();
  try {
    const { leads, byDomain, byDay } = await countLdLeads({ from, to, domain, EventRecord });
    const spendByDay = {};
    for (const [day, n] of Object.entries(byDay)) spendByDay[day] = Math.round(n * rate * 100) / 100;
    return {
      leads,
      rate,
      spend: Math.round(leads * rate * 100) / 100,
      byDomain,
      byDay,
      spendByDay,
      unavailable: null,
    };
  } catch (error) {
    return {
      leads: null, rate, spend: 0, byDomain: {}, byDay: {}, spendByDay: {},
      unavailable: String(error.message).slice(0, 160),
    };
  }
}

module.exports = {
  countLdLeads,
  readLdSpend,
  ldCostPerLead,
  DEFAULT_LD_COST_PER_LEAD,
};

// ── THE ATTRIBUTION DAY: 5PM TO 5PM, WEEKENDS ROLL INTO MONDAY ────────────
//
// Mickey 2026-08-03: "you sorta have to attribute everything from 5pm to 5pm
// to the day" / "no weekend dialing, roll it all into monday".
//
// Two separate problems, one window.
//
// 1. A LEAD ARRIVING AT 6PM IS DIALLED THE NEXT MORNING. On a midnight
//    boundary its arrival and its first touch fall on different days, so it
//    reads as untouched — on 2026-07-31 that stranded 74 of 106 leads. Moving
//    the boundary to 17:00 puts the arrival and the work in the same window.
//
// 2. NO BOARD RUNS ON A WEEKEND, BUT THE VENDOR STILL DELIVERS — and delivers
//    MORE: 2026-08-01 (Sat) 138 leads / $414 and 2026-08-02 (Sun) 130 / $390,
//    against 106 / $318 on the Friday. The report scheduler skips Pacific
//    weekends, so that $804 appeared on NO board and never would have. Left
//    alone this understates reported LD cost by roughly $3,000 a month and
//    quietly flatters ROAS on every day that does run.
//
// So Monday's window opens FRIDAY at 17:00 and covers the whole weekend. It
// makes Monday's LD cost look like a spike — it is three days of inventory,
// and Monday is genuinely the first day anyone dials it.
//
// NOTE, deliberately unresolved here: this is the ATTRIBUTION window, not the
// BILLING window. Pacific-midnight days are what reconcile to the vendor's
// invoice — proven against four billed days (86/111/105/101 for 07-25..07-28,
// which midnight reproduces exactly and no other boundary does). Keep using
// midnight for what a day COST; use this window for WHO worked it and for
// which board the money lands on.

const ATTRIBUTION_CUTOVER_HOUR = 17;

/**
 * The arrival window whose leads belong to `dateKey`'s board.
 *
 * Returns { fromKey, fromHour, toKey, toHour, spansWeekend } — Pacific wall
 * clock. Saturday and Sunday never open a window of their own: nobody dials,
 * and no board runs to report one.
 */
function ldAttributionWindow(dateKey) {
  const at = Date.parse(`${dateKey}T12:00:00Z`);
  if (!Number.isFinite(at)) throw new TypeError(`ldAttributionWindow: bad dateKey ${dateKey}`);
  const dow = new Date(at).getUTCDay();           // 0 Sun .. 6 Sat
  if (dow === 0 || dow === 6) {
    // A weekend day has no board. Its leads belong to the following Monday,
    // and asking for one is a caller error worth surfacing rather than
    // silently returning an empty window.
    return { fromKey: null, toKey: null, spansWeekend: false, weekendDeferredTo: mondayAfter(dateKey) };
  }
  // Monday reaches back to FRIDAY 17:00 — three days of arrivals, all first
  // dialled on the Monday. Every other weekday reaches back one day.
  const back = dow === 1 ? 3 : 1;
  return {
    fromKey: addDays(dateKey, -back),
    fromHour: ATTRIBUTION_CUTOVER_HOUR,
    toKey: dateKey,
    toHour: ATTRIBUTION_CUTOVER_HOUR,
    spansWeekend: dow === 1,
  };
}

function mondayAfter(dateKey) {
  const at = Date.parse(`${dateKey}T12:00:00Z`);
  const dow = new Date(at).getUTCDay();
  return addDays(dateKey, dow === 6 ? 2 : 1);
}

module.exports.ldAttributionWindow = ldAttributionWindow;
module.exports.ATTRIBUTION_CUTOVER_HOUR = ATTRIBUTION_CUTOVER_HOUR;
