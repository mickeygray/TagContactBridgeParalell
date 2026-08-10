"use strict";

// REPORT BLOCKS — the tickable calculations.
//
// Mickey 2026-07-28: "this is the kind of thing where its like i want to
// click a box and include this calculation in the email / csv is the idea."
//
// So a report is not a fixed thing you pick from a menu. It is a SELECTION
// of calculations, a date range, and an output. Tick "money", "by source"
// and "client since", get those three in an email; tick one and get one.
//
// ── WHY BLOCKS DECLARE `needs` ──────────────────────────────────────────
// Every block says which raw material it requires. The composer takes the
// union across the selection and gathers ONCE — so picking five blocks that
// all read payments costs exactly one gather, not five. Without that, a
// picker quietly multiplies API cost by the number of boxes ticked.
//
// Live by default, per the faceplate thesis: blocks read from the
// authoritative services, not from a stats table.

const { groupCaseIds } = require("./caseListFormatter");
const {
  REPORT_SECTION_IDS,
  ROLLUP_SECTION_IDS,
} = require("./dailyReportContract");

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const money = (n) => `$${(Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (n) => (n == null ? "—" : `${n}%`);

// ── the catalog ─────────────────────────────────────────────────────────
// id · label · needs · compute · renderText · csv
const NEWLINE = String.fromCharCode(10);

// ── WHO APPEARS ON A PER-PERSON TABLE ─────────────────────────────────────
//
// Mickey 2026-08-03: "dont do by calls do by name" — then the roster: "just
// bruce allen, brad hansen, chris bolt, sean lucas, phil olson".
//
// Declared, not inferred. The first version dropped rows under a call
// threshold, which is a proxy for the real question and it drifts both ways: a
// settlement officer having a quiet day vanishes from his own board, while
// anyone who touches three calls appears on it. Who settles cases is a fact
// about the team.
//
// TWO tables use this — "By settlement officer" and "Calls by agent". The
// first pass put it on only one, and the names went out again on the other, so
// it lives here once rather than as two copies that drift.
//
// EMAIL ONLY. Callers apply it to `emailRows`, never `rows`, so the CSV keeps
// every person — including anyone newly hired and not yet on the list.
const DEFAULT_SETTLEMENT_OFFICERS = [
  "Bruce Allen", "Brad Hansen", "Chris Bolt", "Sean Lucas", "Phil Olson",
];

function settlementOfficerSet() {
  const fromEnv = String(process.env.SETTLEMENT_OFFICERS || "")
    .split(",").map((x) => x.trim()).filter(Boolean);
  return new Set((fromEnv.length ? fromEnv : DEFAULT_SETTLEMENT_OFFICERS)
    .map((x) => x.toLowerCase()));
}

function settlementOfficersOnly(rows = [], nameOf = (x) => x.officer) {
  const roster = settlementOfficerSet();
  return rows.filter((r) => roster.has(String(nameOf(r) || "").trim().toLowerCase()));
}

// Above this revenue-to-spend multiple, believe the SPEND is wrong before
// believing the campaign is. 50x return = 4,900% ROI.
const SPEND_SUSPECT_RATIO = Number(process.env.SPEND_SUSPECT_RATIO) || 50;

const LAG_REASON = Object.freeze({
  "no-phone-on-file": "(no phone on file)",
  "no-callrail-match": "(CallRail didn't see it)",
  "callrail-is-tag-only": "(not a CallRail tenant)",
});

const BLOCKS = [
  {
    // THE TOP LINE — Mickey 2026-07-30: "so its top line / per source break
    // down / per agent break down / call links."
    //
    // What the whole day was, in the fewest numbers that can carry it: money
    // in, what it cost, what that leaves, and the volume behind it. Everything
    // below this block explains one of these numbers.
    //
    // ROI is deliberately ABSENT here. Mickey, same message: "roi can only
    // apply by source." A blended return across mail and LD averages a piece
    // that pays for itself with one that does not, and the average is a number
    // nobody can act on.
    id: REPORT_SECTION_IDS.TOPLINE,
    label: "Top line",
    hint: "Money in, spend, net, and the volume behind them",
    termsShort: "Money received vs spend booked, same range. No blended ROI — that only means anything per source.",
    terms: "Money RECEIVED inside the range against spend BOOKED inside the range, with the volume that produced it. LD leads are what the cadence RECEIVED, not what the vendor invoiced. Deliberately carries no blended ROI: a single return across mail and LD hides which piece is paying.",
    needs: ["payments", "spend", "dials", "calls", "ldLeads", "caseContacts", "activity"],
    compute({
      payments = [], spend = null, dials = [], callsBySource = {}, ldLeads = null,
      domain = null, events = [],
    }) {
      // Mickey 2026-07-30: "vendor is ld only for the ld vendor."
      // Mail is a TAG-tenant channel; CallRail is one TAG account. So a report
      // scoped to any other tenant must not carry mail spend, mail calls or
      // pieces mailed — a WYNN vendor board was showing $3,019 of OUR mail
      // spend against $250 of their revenue and calling it net -$2,773.
      const MAIL_TENANT = "TAG";
      const scoped = domain ? String(domain).toUpperCase() : null;
      const mailApplies = !scoped || scoped === MAIL_TENANT;
      const live = payments.filter((p) => !p.isChargeback);
      const dealCases = new Set();
      let newCash = 0; let recurring = 0;
      for (const p of live) {
        if (p.paymentType === "initial") {
          dealCases.add(`${p.domain}:${p.caseId}`);
          newCash = round2(newCash + p.amount);
        } else recurring = round2(recurring + p.amount);
      }
      // ── A VENDOR BOARD CARRIES NO RECURRING ──────────────────────────────
      //
      // Mickey 2026-08-03: "we dont need total recurring on the vendor".
      //
      // A vendor board answers one question: what did the leads WE BOUGHT FROM
      // YOU produce against what we paid you. Recurring is instalments from
      // cases sold in earlier periods — last quarter's business arriving on
      // today's page. Including it flatters the vendor for work their current
      // leads did not do, and it moves with our collections cadence rather
      // than with their lead quality.
      //
      // Keyed on the SAME signal the tenant rule already uses: a board scoped
      // to a tenant that is not the mail tenant is somebody else's board.
      //
      // NET moves with it, deliberately. The alternative — showing new money
      // on the top line while NET quietly still nets recurring — is the
      // "hiding a row hides money" failure this file has a whole test file
      // about. The board must be explicable from the numbers on it.
      const vendorBoard = Boolean(scoped) && !mailApplies;
      const cash = vendorBoard ? newCash : round2(newCash + recurring);
      const mailSpend = mailApplies ? (Number(spend?.mail) || 0) : 0;
      const ldSpend = Number(spend?.ld) || 0;
      // Rebuild the total from the parts that APPLY rather than trusting the
      // sheet's grand total, which is cross-tenant.
      const spendTotal = mailApplies ? (Number(spend?.total) || 0) : round2(ldSpend);
      let ldDials = 0;
      for (const d of dials) ldDials += Array.isArray(d.attempts) ? d.attempts.length : 0;
      let mailCalls = 0; let responses = 0;
      if (mailApplies) {
        for (const v of Object.values(callsBySource || {})) {
          mailCalls += Number(v.calls) || 0;
          responses += Number(v.responses) || 0;
        }
      }
      return {
        deals: dealCases.size,
        cash,
        newCash,
        // On a vendor board this is REPORTED but not counted — the renderer
        // omits it and cash/net exclude it. Kept on the data so the CSV can
        // still show what was set aside rather than losing it silently.
        recurring,
        vendorBoard,
        recurringExcluded: vendorBoard ? recurring : 0,
        spend: spendTotal,
        mailApplies,
        mailSpend,
        ldSpend,
        net: round2(cash - spendTotal),
        mailCalls,
        responses,
        ldDials,
        // Received, not invoiced. Falls back to the sheet only when the
        // cadence could not be read, and says so rather than blending.
        ldLeads: ldLeads ? ldLeads.total : null,
        // ldSheetLeads, NOT ldLeads: the composer overwrites spend.ldLeads with
        // the RECEIVED count once the receipt log is read, so reading it here
        // printed "75 received / 75 billed" on a day the sheet billed nothing.
        // The sheet's own figure is preserved separately for exactly this.
        ldLeadsBilled: Number(spend?.ldSheetLeads) || 0,
        mailPieces: mailApplies ? (Number(spend?.mailPieces) || 0) : 0,
        // Mickey 2026-07-30: "top line is money in money spent (then you can do
        // the status count deals, dnc, reds)." The counts ride with the money
        // so the first thing in the mail answers both questions at once.
        // Same lane rules as the status block, one row per case per lane.
        // Mickey 2026-07-30: "we only need dnc/post-date/suspend/deal no other
        // no to chase." An "other" bucket counts changes nobody acts on, and
        // "to chase" restated a number the list underneath already shows.
        ...(() => {
          const c = { dnc: 0, postdate: 0, suspended: 0 };
          for (const e of events) {
            if (e.kind !== "status-change" || e.payload?.selfTransition) continue;
            const k = e.payload?.safetyClass;
            if (k in c) c[k] += 1;
          }
          return c;
        })(),
      };
    },
    renderText(d) {
      const L = [];
      // A vendor board shows NEW money only — no recurring clause, because
      // recurring is not counted there. Saying "0 recurring" would be a lie
      // (it exists, it is just not theirs to be credited with) and printing
      // the real figure would credit them for it.
      L.push(d.vendorBoard
        ? `MONEY IN        ${money(d.cash)}   (${d.deals} deal${d.deals === 1 ? "" : "s"}, new business only)`
        : `MONEY IN        ${money(d.cash)}   (${d.deals} deal${d.deals === 1 ? "" : "s"}, ${money(d.newCash)} new · ${money(d.recurring)} recurring)`);
      L.push(`SPEND           ${money(d.spend)}${d.mailApplies ? `   (mail ${money(d.mailSpend)} · LD ${money(d.ldSpend)})` : "   (LD only)"}`);
      L.push(`NET             ${money(d.net)}`);
      const leads = d.ldLeads == null
        ? `${d.ldLeadsBilled} billed (cadence unavailable)`
        : `${d.ldLeads} received${d.ldLeadsBilled && d.ldLeadsBilled !== d.ldLeads ? ` (${d.ldLeadsBilled} billed)` : ""}`;
      const mailPart = d.mailApplies ? `${d.responses} mail response(s) of ${d.mailCalls} call(s) · ` : "";
      L.push(`VOLUME          ${mailPart}${d.ldDials} LD dial(s) · ${leads} LD lead(s)`);
      if (d.mailPieces) L.push(`                ${d.mailPieces.toLocaleString("en-US")} piece(s) mailed`);
      return L.join(NEWLINE);
    },
    csv(d) {
      const usd0 = (n) => "$" + Math.round(Number(n) || 0).toLocaleString("en-US");
      return {
        // One row of thirteen columns is a table only in the technical sense.
        // The headline carries the four numbers Mickey actually opens the mail
        // for; the columns stay for the CSV attachment and the detail reader.
        summary: `${usd0(d.cash)} in · ${usd0(d.spend)} spent · ${usd0(d.net)} net`
          + ` · ${d.deals} deal${d.deals === 1 ? "" : "s"}`
          + ` · ${d.dnc} DNC · ${d.postdate} post-date · ${d.suspended} suspended`,
        // Headline only. Thirteen columns of breakdown belong in the CSV.
        emailColumns: [],
        rows: [d],
        columns: [
        { header: "deals", get: (x) => x.deals },
        { header: "cash", get: (x) => x.cash },
        { header: "new_cash", get: (x) => x.newCash },
        // "recurring_cash", not "recurring": toTemplateData decides money
        // formatting by matching the HEADER against /cash|spend|net|.../, so a
        // bare "recurring" rendered as 11,925 next to $300.00 in the same row.
        { header: "recurring_cash", get: (x) => x.recurring },
        { header: "spend", get: (x) => x.spend },
        { header: "mail_spend", get: (x) => x.mailSpend },
        { header: "ld_spend", get: (x) => x.ldSpend },
        { header: "net", get: (x) => x.net },
        { header: "mail_calls", get: (x) => x.mailCalls },
        { header: "mail_responses", get: (x) => x.responses },
        { header: "ld_dials", get: (x) => x.ldDials },
        { header: "ld_leads_received", get: (x) => x.ldLeads },
        { header: "ld_leads_billed", get: (x) => x.ldLeadsBilled },
        ],
      };
    },
  },
  {
    // LD CALL QUALITY — Mickey 2026-07-30: "vendor is call quality" and
    // "vendor is ld only for the ld vendor."
    //
    // longcalls is CallRail, which is ONE TAG tenant carrying inbound MAIL
    // response calls. Putting it in an LD vendor board showed the vendor our
    // mail calls and labelled it their call quality. LD calls are OUTBOUND
    // PhoneBurner dials, so they come from DailyDial attempts instead.
    //
    // LISTEN LINKS, AS OF 2026-07-31. Recordings now ride in on the call
    // callback and land on the attempt, so this block lists the calls worth
    // hearing with the agent, the case and the link — the same three facts the
    // CallRail side carries.
    //
    // It took three wrong explanations to get here, all recorded so nobody
    // re-runs them: it was NOT that PhoneBurner sessions cannot be enumerated
    // for past days, NOT that we never asked (include_recording=1 was always
    // sent), and NOT a 15-minute generation delay. The lookup route is simply
    // closed — the service account 404s on getDialSession for the agents' own
    // sessions, because they dial on their own seats. Whatever arrives on the
    // callback is all there will ever be, which is why the callback capture is
    // the thing that had to be fixed.
    //
    // A call with no link yet is still listed, marked pending. The recording
    // lands after the call ends, so "not yet" is normal and hiding the row
    // would understate the day.
    // ONE PLACE FOR CALLS BY AGENT. Mickey 2026-07-30: "lets just make ld call
    // quality agent report in one place you can do inbound, dials, connected,
    // talk time (callrail + phone burner), deals, cash so one place for calls
    // by agent." `worked` and this block were two tables of the same people
    // built from two sources; a reader had to reconcile them by eye.
    id: REPORT_SECTION_IDS.BY_AGENT,
    label: "Calls by agent",
    hint: "Inbound taken, dials placed, new leads worked, and what it cost",
    termsShort: "Per agent, in range: inbound, dials, new LD leads first-touched, and cost — mail ALLOCATED by share of calls offered; BCD and LD per unit.",
    terms: "Per agent, inside the range: INBOUND is calls connected to that agent from the queue; DIALS are outbound PhoneBurner attempts. NEW LD is new lead inventory (leadAgeDays 0) on which that agent placed the EARLIEST attempt — first toucher wins, so one lead is credited to exactly one person. ATTRIBUTED SPEND is what those calls cost. MAIL is an ALLOCATION and not a price: the range's mail spend shared out by each agent's share of the calls the mail queue OFFERED. BCD and LD are PER UNIT — BCD calls x the pay-per-call rate, new leads x the per-lead rate. Cost no agent can be charged with (calls offered and never answered, leads nobody touched) is reported as UNATTRIBUTED rather than spread, so the components sum back to the spend they came from. DEALS are distinct cases whose first payment landed in range, and CASH is what those cases paid.",
    // "spend" is declared, not gathered twice: the top line already asks for it
    // in both scheduled presets, and gatherMaterial takes the UNION of needs —
    // so a call carrying its cost costs nothing extra to gather.
    needs: ["dials", "queue", "payments", "caseContacts", "spend"],
    compute({
      dials = [], queueByAgent = {}, payments = [],
      // DEFAULTS ON EVERY KEY. reportBlocksContract calls compute() with a
      // near-empty material to prove a block renders with nothing to report;
      // a bare `spend` or `queueStreams` destructure throws there instead.
      spend = {}, queueStreams = {}, domain = null,
      // "0 dials" and "we could not read the dials" are the same number and
      // opposite facts. Carried onto the data so csv() can say which one it is
      // — the `worked` block has done this for a while, but `worked` is in
      // neither scheduled preset, so the nightly board never inherited it.
      dialsUnavailable = null, queueUnavailable = null,
    }) {
      const LONG_SEC = Math.max(60, Number(process.env.LD_LONG_CALL_SECONDS) || 300);
      const { canonicalStaffName, isNotAPerson } = require("../../shared-config/src/staffRoster");
      const INBOUND_STREAMS = new Set(["MAILER", "BCD"]);
      let attempts = 0; let attemptsKnown = 0; let connected = 0; let talkSec = 0; let longCalls = 0;
      const byOutcome = {}; const byAgent = new Map(); const cases = new Set();
      const worthHearing = [];
      const row = (name) => {
        if (!byAgent.has(name)) {
          byAgent.set(name, {
            // mailerIn and bcdIn are kept APART because they are priced apart:
            // mail is an allocation of a bulk drop, BCD is bought per call.
            // `inbound` stays their sum so the column already on the board is
            // unchanged by the split.
            agent: name, inbound: 0, mailerIn: 0, bcdIn: 0, newLeads: 0,
            dials: 0, connected: 0, talkSec: 0,
            deals: 0, dealCases: new Set(), cash: 0,
          });
        }
        return byAgent.get(name);
      };
      // A lead age that is absent, null or unparseable is UNKNOWN. Number(null)
      // is 0, so a plain `Number(x) === 0` would read every null as brand-new
      // inventory and charge the whole LD bill to whoever dialled it.
      const leadAge = (v) => {
        if (v === null || v === undefined || v === "") return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };
      // NEW INVENTORY, and who got to it first.
      let newInventory = 0; let newInventoryUntouched = 0;
      for (const d of dials) {
        cases.add(`${d.domain}:${d.caseId}`);
        for (const a of Array.isArray(d.attempts) ? d.attempts : []) {
          attempts += 1;
          const sec = Number(a.durationSeconds) || 0;
          // `connected` is an explicit field on the attempt — trust ONLY that.
          // Inferring it from durationSeconds > 0 counts RING TIME as a
          // conversation: 399 of 400 sampled attempts have a duration, but only
          // 48 connected. That inference reported a 99.9% connect rate on a
          // board headed for the vendor.
          //
          // But `connected` is ABSENT on a quarter of attempts (July 2026:
          // 4,570 of 18,505, 24.7%) and is not even declared in
          // DailyDial's attempt schema — nothing in shared-services writes it,
          // so it arrives from outside the model and can vanish silently.
          // Treating absent as false understates the rate (8.6% vs 11.4% over
          // attempts that actually carry the flag). Unknown is its own bucket:
          // it is excluded from the denominator and reported, never guessed.
          // `outcome` cannot stand in — it only ever holds "review"/"dnc",
          // which is lead state, not call disposition.
          const known = typeof a.connected === "boolean";
          if (known) attemptsKnown += 1;
          const isConnected = a.connected === true;
          if (isConnected) { connected += 1; talkSec += sec; }
          if (sec >= LONG_SEC) longCalls += 1;
          const oc = String(a.outcome || d.lastOutcome || "unknown");
          byOutcome[oc] = (byOutcome[oc] || 0) + 1;
          // canonicalStaffName so "brad_hansen" from PhoneBurner, "Brad Hansen"
          // from the queue and the officer on a payment are ONE row. Two
          // spellings of the same person is how this became two tables.
          const who = a.agentId ? canonicalStaffName(a.agentId) : "(unknown)";
          row(who).dials += 1;
          if (isConnected) { row(who).connected += 1; row(who).talkSec += sec; }

          // WHO TOOK IT, THE CASE, AND THE LINK. Only calls long enough to be
          // worth hearing; a link with no conversation behind it is noise.
          if (sec >= LONG_SEC) {
            worthHearing.push({
              agent: who,
              domain: d.domain ? String(d.domain).toUpperCase() : null,
              caseId: d.caseId ?? null,
              dateKey: d.dateKey || null,
              minutes: Math.round(sec / 6) / 10,
              outcome: oc,
              // Attempt first, then the doc-level field the call-log
              // projection writes. Pending is a real state, not a gap.
              listenUrl: a.persistedRecordingUrl || null,
            });
          }
        }

        // ── LD COST GOES TO THE FIRST TOUCHER ─────────────────────────────
        //
        // We buy new leads, so the cost belongs to whoever WORKED a new lead —
        // and exactly one person can be charged for one lead, or the board
        // spends money we never spent. Measured on 2026-07-31: 16 of 32 new
        // leads were dialled by two or more agents, so crediting every toucher
        // summed to 52 leads / $156 against a real 32 / $96.
        //
        // Three alternatives were tried and are recorded so nobody re-runs
        // them. Distinct-cases-DIALLED charges the whole back catalogue and
        // summed to $4,005 on a day that cost $318. `lastAgentId` is exclusive
        // but wrong: it erased Sean Lucas, who first-touched 9 leads and was
        // last on none. `originPool` names the feed, not a person.
        //
        // Earliest callEndedAt on the doc, resolved ONCE per lead.
        if (leadAge(d.leadAgeDays) === 0) {
          newInventory += 1;
          let firstKey = null; let firstAgent = null;
          for (const a of Array.isArray(d.attempts) ? d.attempts : []) {
            if (!a.agentId) continue;
            const t = a.callEndedAt ? Date.parse(a.callEndedAt) : NaN;
            // An attempt with no clock cannot WIN the race, but it can still be
            // the only runner — otherwise a lead somebody plainly worked falls
            // into unattributed for want of a timestamp.
            const key = Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
            if (firstKey === null || key < firstKey) { firstKey = key; firstAgent = a.agentId; }
          }
          if (firstAgent) row(canonicalStaffName(firstAgent)).newLeads += 1;
          else newInventoryUntouched += 1;
        }
      }
      worthHearing.sort((x, y) => y.minutes - x.minutes);

      // INBOUND — calls the queue connected to a person. A queue answering is
      // not a person working, so pseudo-agents are dropped rather than ranked.
      //
      // MAILER and BCD land in their OWN counters as well as the shared
      // `inbound` total. They are two different purchases — a bulk mail drop
      // and a pay-per-call feed — so one number cannot price both.
      for (const [agent, streams] of Object.entries(queueByAgent)) {
        if (isNotAPerson(agent)) continue;
        const r = row(canonicalStaffName(agent));
        for (const [key, n] of Object.entries(streams || {})) {
          if (!INBOUND_STREAMS.has(key)) continue;
          const calls = Number(n) || 0;
          if (key === "MAILER") r.mailerIn += calls;
          else if (key === "BCD") r.bcdIn += calls;
          r.inbound += calls;
        }
      }

      // DEALS AND CASH — distinct cases whose first payment landed in range.
      for (const p of payments.filter((x) => !x.isChargeback && x.paymentType === "initial")) {
        const r = row(p.officerAtSale
          || (p.attributionSnapshot === "missing" ? "(no snapshot)" : "(unassigned)"));
        r.dealCases.add(`${p.domain}:${p.caseId}`);
        r.deals = r.dealCases.size;
        r.cash = round2(r.cash + p.amount);
      }

      // ── ATTRIBUTED SPEND ─────────────────────────────────────────────────
      //
      // Mickey 2026-08-03: "derive a spend per agent basically how many calls
      // they took of mail, BCD and LD sorta blended together ... read mailer
      // queue divide by spend multiply total agent calls by that avg cost /
      // same with bcd queue by agent / for LD you need to sorta track new lead
      // case ids and see who called them and attribute that way."
      //
      // Three channels, three unit costs, one column. Each component is built
      // so that the agents plus what nobody can be charged with add back up to
      // the spend they were divided out of — a per-agent cost that does not
      // reconcile is a number that can be argued with rather than acted on.
      //
      // ── A ZERO AND AN UNKNOWN ARE NOT THE SAME NUMBER ────────────────────
      //
      // This is the property that matters most here, and the one this stack
      // keeps being bitten by. "$0.00" is an ANSWER: it says the agent worked
      // nothing we paid for. A component we could not read must render as a
      // dash instead, or a RingCentral outage prints as a floor that did no
      // marketing work — and that reads as a fact about people.
      const MAIL_TENANT = "TAG";
      const scoped = domain ? String(domain).toUpperCase() : null;
      // A vendor board carries no mail and no BCD BY RULE (see THE TENANT RULE
      // in the composer, which zeroes queueByAgent for a non-mail tenant). That
      // is "does not apply", not "unknown" — so those components are null, but
      // they are not a hole in the total the way an outage is.
      const mailApplies = !scoped || scoped === MAIL_TENANT;

      const finite = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
      // `spend: {}` is what a block gets when spend was never gathered. Its
      // dollars are unknown, not zero.
      const spendKnown = !!spend && finite(spend.total) !== null;
      const mailSpend = spendKnown ? (Number(spend.mail) || 0) : 0;
      const bcdSpend = spendKnown ? (Number(spend.bcd) || 0) : 0;
      const ldSpend = spendKnown ? (Number(spend.ld) || 0) : 0;
      const ldRate = spendKnown ? finite(spend.ldRate) : null;
      const ldLeadsBought = spendKnown ? finite(spend.ldLeads) : null;

      // OFFERED, NOT CONNECTED. The mail spend bought every call that RANG,
      // including the ones nobody picked up — pricing off connects alone would
      // divide the same dollars over a smaller denominator and quietly inflate
      // every agent's cost per call (43 offered vs 40 connected is a 7.5%
      // overstatement, and it grows with the miss rate).
      const mailOffered = Number(queueStreams?.MAILER?.calls) || 0;
      const bcdOffered = Number(queueStreams?.BCD?.calls) || 0;
      const mailMissed = Number(queueStreams?.MAILER?.missed) || 0;
      const bcdMissed = Number(queueStreams?.BCD?.missed) || 0;

      const mailReadable = mailApplies && spendKnown && !queueUnavailable;
      const bcdReadable = mailApplies && spendKnown && !queueUnavailable;
      // leadAgeDays is what marks NEW inventory. Dropped from the projection it
      // is `undefined` on every row, no lead looks new, and the LD component
      // reads $0.00 for the whole floor — the exact zero-that-means-unknown
      // this block exists to refuse.
      const ldAgeReadable = !dials.length || dials.some((x) => leadAge(x.leadAgeDays) !== null);
      const newLeadsKnown = !dialsUnavailable && ldAgeReadable;
      const ldReadable = newLeadsKnown && spendKnown && !spend.ldUnavailable && ldRate !== null;

      const mailRate = mailReadable && mailOffered ? mailSpend / mailOffered : null;
      const bcdRate = bcdReadable && bcdOffered ? bcdSpend / bcdOffered : null;

      const attributed = [...byAgent.values()]
        .map(({ dealCases, ...r }) => ({ ...r, talkMinutes: Math.round(r.talkSec / 6) / 10 }))
        .map((r) => {
          const mail = mailReadable ? round2((r.mailerIn || 0) * (mailRate || 0)) : null;
          const bcd = bcdReadable ? round2((r.bcdIn || 0) * (bcdRate || 0)) : null;
          const ld = ldReadable ? round2((r.newLeads || 0) * ldRate) : null;
          // "NEEDED" is the operative word. On a vendor board mail and BCD are
          // absent by rule, so their nulls do not blank the total; on a mail
          // board an unreadable queue does.
          const missing = (mailApplies && (mail === null || bcd === null)) || ld === null;
          return {
            ...r,
            attributedMail: mail, attributedBcd: bcd, attributedLd: ld,
            attributedSpend: missing ? null : round2((mail || 0) + (bcd || 0) + (ld || 0)),
          };
        });

      const sumOf = (key) => round2(attributed.reduce((s, r) => s + (Number(r[key]) || 0), 0));
      const agentsMail = mailReadable ? sumOf("attributedMail") : null;
      const agentsBcd = bcdReadable ? sumOf("attributedBcd") : null;
      const agentsLd = ldReadable ? sumOf("attributedLd") : null;
      const newLeadsTouched = attributed.reduce((s, r) => s + (Number(r.newLeads) || 0), 0);

      // WHAT NOBODY CAN BE CHARGED WITH. Taken as the RESIDUAL rather than
      // recomputed from missed calls, so rounding cents land here instead of
      // opening a gap in the total. On well-formed queue data the two agree:
      // missed x rate is the same money, and it is reported beside it.
      const failures = [];
      const leftOver = (label, spendPart, agentsPart) => {
        if (agentsPart === null) return null;
        const rest = round2(spendPart - agentsPart);
        if (rest < -0.005) {
          // Agents were credited with more than we spent. Clamped so the column
          // cannot show money that does not exist, and SAID so — a silent clamp
          // is how a broken denominator survives a year.
          failures.push(`${label}: agents credited ${money(agentsPart)} against ${money(spendPart)} of ${label} spend`);
          return 0;
        }
        return rest < 0 ? 0 : rest;
      };
      const unattributed = {
        mail: leftOver("mail", mailSpend, agentsMail),
        bcd: leftOver("BCD", bcdSpend, agentsBcd),
        ld: leftOver("LD", ldSpend, agentsLd),
      };
      if (ldReadable && ldLeadsBought !== null && newLeadsTouched > ldLeadsBought) {
        failures.push(`LD: ${newLeadsTouched} new lead(s) first-touched against ${ldLeadsBought} received`);
      }

      // Spend that could land on this board at all. Rebuilt from the parts that
      // APPLY rather than trusting a cross-tenant grand total — the same
      // reasoning the top line uses.
      const applicableSpend = round2((mailApplies ? mailSpend + bcdSpend : 0) + ldSpend);
      const allKnown = spendKnown && ldReadable && (!mailApplies || (mailReadable && bcdReadable));
      const attributedTotal = allKnown
        ? round2((agentsMail || 0) + (agentsBcd || 0) + (agentsLd || 0)) : null;
      const unattributedTotal = allKnown
        ? round2((unattributed.mail || 0) + (unattributed.bcd || 0) + (unattributed.ld || 0)) : null;
      const drift = allKnown ? round2(attributedTotal + unattributedTotal - applicableSpend) : null;

      return {
        dialsUnavailable, queueUnavailable,
        cases: cases.size, attempts, connected, longCalls,
        attemptsKnown, attemptsUnknown: attempts - attemptsKnown,
        talkMinutes: Math.round(talkSec / 6) / 10,
        // Denominator is attempts that CARRY the flag, not all attempts.
        connectRate: attemptsKnown ? Math.round((connected / attemptsKnown) * 1000) / 10 : null,
        avgTalkMinutes: connected ? Math.round((talkSec / connected) / 6) / 10 : null,
        byOutcome,
        // NEW INVENTORY, and how much of it anybody actually reached.
        newInventory, newInventoryUntouched, newLeadsTouched, newLeadsKnown,
        attribution: {
          mailApplies,
          readable: { mail: mailReadable, bcd: bcdReadable, ld: ldReadable },
          mailOffered, mailMissed, bcdOffered, bcdMissed,
          // Rounded for display only — the arithmetic above runs at full
          // precision and the residual absorbs the cents.
          mailRate: mailRate === null ? null : Math.round(mailRate * 10000) / 10000,
          bcdRate: bcdRate === null ? null : Math.round(bcdRate * 10000) / 10000,
          ldRate: ldReadable ? ldRate : null,
          ldLeadsBought,
          spend: { mail: mailSpend, bcd: bcdSpend, ld: ldSpend, applicable: applicableSpend },
          unattributed: { ...unattributed, total: unattributedTotal },
          // What the missed-call arithmetic says the unattributed mail/BCD
          // should be. Reported alongside the residual so a divergence between
          // "calls nobody answered" and "spend nobody was charged" is visible
          // rather than absorbed.
          unattributedByMissed: {
            mail: mailRate === null ? null : round2(mailMissed * mailRate),
            bcd: bcdRate === null ? null : round2(bcdMissed * bcdRate),
          },
          reconciliation: {
            // null, not false: an unreadable component means the invariant was
            // not TESTED, which is a different claim from "it failed".
            ok: allKnown ? (Math.abs(drift) < 0.005 && failures.length === 0) : null,
            expected: applicableSpend,
            attributed: attributedTotal,
            unattributed: unattributedTotal,
            drift,
            failures,
          },
        },
        agents: attributed
          // Someone with deals and no dials still belongs here, and so does
          // someone with dials and no deals. Union, never intersect.
          .filter((r) => r.inbound || r.dials || r.deals || r.newLeads)
          .sort((a, b) => b.cash - a.cash || b.dials - a.dials),
        longThresholdMinutes: Math.round(LONG_SEC / 60),
        worthHearing,
        worthHearingWithLink: worthHearing.filter((c) => c.listenUrl).length,
      };
    },
    renderText(d) {
      if (!d.attempts) return "LD call quality     (no dials recorded in this range)";
      const rate = d.connectRate === null
        ? "no connect data"
        : `${d.connectRate}% of ${d.attemptsKnown} measured`;
      const L = [
        `LD call quality     ${d.attempts} dial(s) on ${d.cases} case(s) · ${d.connected} connected (${rate})`,
        `                    ${d.talkMinutes} min talk · avg ${d.avgTalkMinutes} min · ${d.longCalls} over ${d.longThresholdMinutes} min`,
      ];
      // Never let the unknown bucket disappear into the rate.
      if (d.attemptsUnknown > 0) {
        L.push(`                    ${d.attemptsUnknown} dial(s) carry no connect flag — excluded from the rate`);
      }
      const outcomes = Object.entries(d.byOutcome).sort((a, b) => b[1] - a[1]).slice(0, 6);
      if (outcomes.length) L.push(`                    ${outcomes.map(([k, n]) => `${n} ${k}`).join(" · ")}`);
      // The cost line, and whether it adds up. A per-agent cost that does not
      // reconcile is worse than no per-agent cost, so the check prints beside
      // the number rather than hiding in a log.
      const rec = d.attribution?.reconciliation;
      if (rec && rec.attributed !== null && rec.attributed !== undefined) {
        L.push(`                    ${money(rec.attributed)} attributed to agents · ${money(rec.unattributed)} unattributed · ${money(rec.expected)} spent`);
        if (rec.ok === false) {
          L.push(`                    ATTRIBUTION DOES NOT RECONCILE — ${(rec.failures || []).join("; ") || `off by ${money(rec.drift)}`}`);
        }
      } else if (d.attribution) {
        L.push("                    attributed spend unavailable — a cost source could not be read");
      }
      return L.join(NEWLINE);
    },
    csv(d) {
      // Without a summary the email showed a bare per-agent table and dropped
      // the section's actual headline — dials, connect rate and talk time.
      const rate = d.connectRate === null ? "no connect data" : `${d.connectRate}% connected`;
      // A DIAL GATHER THAT FAILED MUST NOT READ AS A DAY WITH NO DIALS. Without
      // this the summary is the literal string "0 dials · no connect data · 0
      // min talk", which is exactly what a genuinely idle Saturday looks like.
      const rec = d.attribution?.reconciliation;
      // CONNECTED AND TALK TIME LEAVE THE EMAIL TABLE, NOT THE REPORT. Mickey
      // 2026-08-03: "you can sorta get rid of connected and talk minutes and do
      // like attributed spend." They stay in this headline and in the CSV, so
      // the connect rate is still one glance away — the email table is simply
      // not where seven columns of it belong.
      const cost = !rec || rec.attributed === null || rec.attributed === undefined
        ? ""
        : ` · ${money(rec.attributed)} attributed of ${money(rec.expected)} spent`
          + (rec.ok === false
            ? ` — DOES NOT RECONCILE (${(rec.failures || []).join("; ") || `off by ${money(rec.drift)}`})`
            : "");
      const summary = d.dialsUnavailable
        ? `DIAL DATA UNAVAILABLE — ${d.dialsUnavailable}. Deals and cash below are complete; call counts are not.`
        : `${d.attempts.toLocaleString()} dial${d.attempts === 1 ? "" : "s"} · ${rate} · ${d.talkMinutes} min talk`
          + (d.attemptsUnknown ? ` · ${d.attemptsUnknown} without a connect flag` : "")
          + cost;
      // INBOUND comes from the TAG phone queue, which a vendor board does not
      // carry (see THE TENANT RULE in the composer). Rather than mail a column
      // of zeros — which reads as "your leads produced no inbound calls"
      // instead of "this board has no inbound to show" — drop the column when
      // no row has one. The CSV keeps it either way.
      //
      // But an UNREADABLE queue is not an absent one: keep the column and print
      // a dash, so nobody reads a RingCentral outage as a quiet phone.
      const anyInbound = d.queueUnavailable || d.agents.some((a) => (Number(a.inbound) || 0) > 0);
      const inboundCell = (x) => (d.queueUnavailable ? "—" : x.inbound);
      // Dials/connected/talk all come from the same gather, so if it failed
      // they are all unmeasured. Deals and cash come from payments and stay
      // real — which is why the summary says so rather than blanking the row.
      const dialCell = (get) => (x) => (d.dialsUnavailable ? "—" : get(x));
      // NEW LD is a dial fact twice over: it needs the dials AND the lead-age
      // field on them. Either missing and the count is unknown, not zero.
      const ldKnown = !d.dialsUnavailable && d.newLeadsKnown !== false;
      // The header "attributed_spend" matches toTemplateData's money regex, so
      // it formats as dollars for free — and a null renders as an em-dash by
      // the same path every other unreadable cell uses.
      const moneyCell = (get) => (x) => {
        const v = get(x);
        return v === null || v === undefined ? "—" : v;
      };
      // new_ld is WITHHELD FROM THE EMAIL — see NEW_LD_EMAIL_HIDDEN below.
      const columns = [
        { header: "agent", get: (x) => x.agent },
        { header: "inbound", get: inboundCell },
        { header: "dials", get: dialCell((x) => x.dials) },
        { header: "new_ld", get: (x) => (ldKnown ? (Number(x.newLeads) || 0) : "—") },
        { header: "attributed_spend", get: moneyCell((x) => x.attributedSpend) },
        { header: "deals", get: (x) => x.deals },
        { header: "cash", get: (x) => x.cash },
      ];

      // ── new_ld IS HIDDEN FROM THE EMAIL, ON PURPOSE, TEMPORARILY ─────────
      //
      // Mickey 2026-08-03: "kinda need you to take out the first touch problem
      // cause that will get me hella chewed out so lets hide that column for
      // now while i put the fix in."
      //
      // What the column exposes: on 2026-07-31 Brad Hansen was first agent on
      // 29 of the 32 fresh LD leads, Chris Bolt 3, and the other three ZERO.
      // That reads as a damning performance table, but it is not one — three
      // of the five stop dialling by ~13:40 and prefer inbound mailer calls,
      // so whoever is still on the phones sweeps the fresh queue. It is a
      // distribution/behaviour problem being fixed separately (see
      // LEAD_DISTRIBUTION_INVESTIGATION_GUIDE_2026-08-03.md), and publishing
      // it nightly in the meantime would put people on the wrong end of a
      // number that describes the queue rather than their effort.
      //
      // The COST column stays. attributed_spend blends mail + BCD + LD, and it
      // does not expose the same story — on 07-31 it ranks Phil $446.50, Sean
      // $434.50, Bruce $208.90, Brad $91.00, Chris $25.00, because the mail
      // allocation dominates. Brad's LD concentration is invisible in it.
      //
      // NOT A DELETION. The column, the per-component split and the underlying
      // counts all remain in the CSV, so the fix can be measured. See the note
      // on that below — the CSV is attached to this email.
      //
      // REMOVE THIS BLOCK once distribution is fixed. It is a presentation
      // hold, not a decision about what is true.
      const NEW_LD_EMAIL_HIDDEN = true;
      return {
        summary,
        rows: d.agents,
        // Same roster as By settlement officer. Mickey 2026-08-03: "no jonathan
        // pineda no matthew anderson no andrew wells no michael gray no
        // alexander banks ... just bruce allen, brad hansen, chris bolt, sean
        // lucas, phil olson".
        //
        // This table is where he actually saw them — the first pass put the
        // filter on the OFFICER block, and these rows come from `ldcalls`, so
        // they went out again unchanged. One shared list now, because two
        // copies of a roster is how they drift apart.
        emailRows: settlementOfficersOnly(d.agents, (x) => x.agent),
        emailColumns: columns.filter((c) => {
          if (NEW_LD_EMAIL_HIDDEN && c.header === "new_ld") return false;
          return anyInbound || c.header !== "inbound";
        }),
        // The CSV keeps the raw numbers — a dash is a reading aid for a person,
        // not a value a spreadsheet should have to parse. It also keeps
        // connected and talk_minutes, which left the EMAIL table and not the
        // report, and it breaks attributed spend into its three components so
        // the total can be checked against the queue and the receipts.
        columns: [
          { header: "agent", get: (x) => x.agent },
          { header: "inbound", get: (x) => x.inbound },
          { header: "dials", get: (x) => x.dials },
          { header: "connected", get: (x) => x.connected },
          { header: "talk_minutes", get: (x) => x.talkMinutes },
          // NULL, not 0, when the dials could not be read. The email shows an
          // em-dash; a spreadsheet should get an empty cell rather than a
          // number, because a confident 0 here reads as "this agent worked no
          // new leads" when the truth is "we could not look".
          { header: "new_ld", get: (x) => (ldKnown ? (Number(x.newLeads) || 0) : null) },
          // A null stays null here: an empty cell is a spreadsheet's own way of
          // saying "not known", and writing 0 would make it arguable.
          { header: "attributed_spend", get: (x) => x.attributedSpend },
          { header: "attributed_mail", get: (x) => x.attributedMail },
          { header: "attributed_bcd", get: (x) => x.attributedBcd },
          { header: "attributed_ld", get: (x) => x.attributedLd },
          { header: "deals", get: (x) => x.deals },
          { header: "cash", get: (x) => x.cash },
        ],
      };
    },
  },
  {
    id: "money",
    label: "Money in",
    hint: "Cash collected, split new vs recurring, with deal count",
    termsShort: "Money received in range, successful payments only.",
    terms: "Money RECEIVED inside the range, SUCCESS only. Declines and chargebacks excluded. New business = first invoice; a first invoice split across instalments is ONE sale.",
    needs: ["payments"],
    compute({ payments }) {
      const { netChargebacks } = require("./reportMoneyGuards");
      const ok = payments.filter((p) => !p.isChargeback);
      const initial = ok.filter((p) => p.paymentType === "initial");
      const cb = payments.filter((p) => p.isChargeback);

      // CASH IS NET OF CHARGEBACKS. Filtering the reversals away reported
      // money we gave back as money we kept — July 2026 held $11,956 of it.
      // The reversal is applied PER CASE and to recurring first, because a
      // chargeback can only undo money that case actually took; netting the
      // month's reversals against initials invented a $9,197 hole in new
      // business. Deals are NOT netted: the sale still happened.
      const byCase = new Map();
      for (const p of payments) {
        const k = `${p.domain}:${p.caseId}`;
        if (!byCase.has(k)) byCase.set(k, { initial: 0, recurring: 0, chargeback: 0 });
        const x = byCase.get(k);
        const amt = Number(p.amount) || 0;
        if (p.isChargeback) x.chargeback = round2(x.chargeback + Math.abs(amt));
        else if (p.paymentType === "initial") x.initial = round2(x.initial + amt);
        else x.recurring = round2(x.recurring + amt);
      }
      let newCash = 0; let recurringCash = 0; let unapplied = 0;
      for (const row of byCase.values()) {
        const n = netChargebacks(row);
        newCash = round2(newCash + n.initialNet);
        recurringCash = round2(recurringCash + n.recurringNet);
        unapplied = round2(unapplied + n.unapplied);
      }
      return {
        cash: round2(newCash + recurringCash),
        grossCash: round2(ok.reduce((s, p) => s + p.amount, 0)),
        payments: ok.length,
        // A SALE, not a payment row. Case 394513 took its first invoice as two
        // $500 installments on the same day; counting rows called that two
        // deals. Doctrine: deals count SALES.
        deals: new Set(initial.map((p) => `${p.domain}:${p.caseId}`)).size,
        newCash,
        recurringCash,
        chargebacks: cb.length,
        chargebackAmount: round2(cb.reduce((s, p) => s + Math.abs(p.amount), 0)),
        // A reversal larger than anything the case paid inside the range: the
        // original landed in an earlier month. Reported, never swallowed.
        chargebackUnapplied: unapplied,
      };
    },
    renderText(d) {
      return [
        `Money in            ${money(d.cash)}  (${d.payments} payments)`,
        `  new business      ${money(d.newCash)}  · ${d.deals} deal(s)`,
        `  recurring         ${money(d.recurringCash)}`,
        d.chargebacks ? `  chargebacks       ${d.chargebacks} · ${money(d.chargebackAmount)}` : null,
      ].filter(Boolean).join("\n");
    },
    csv(d) {
      return {
        rows: [d],
        columns: [
          { header: "cash", get: (x) => x.cash },
          { header: "payments", get: (x) => x.payments },
          { header: "deals", get: (x) => x.deals },
          { header: "new_cash", get: (x) => x.newCash },
          { header: "recurring_cash", get: (x) => x.recurringCash },
          { header: "chargebacks", get: (x) => x.chargebacks },
          { header: "chargeback_amount", get: (x) => x.chargebackAmount },
        ],
      };
    },
  },

  {
    id: "spend",
    label: "Spend",
    hint: "LD, mail and BCD cost for the window",
    termsShort: "Spend booked in range (mail sheet, LD per lead, BCD per call).",
    terms: "Spend BOOKED inside the range: mail from the spend sheet, LD per lead, BCD derived from recorded call count x rate.",
    needs: ["spend"],
    compute({ spend }) { return spend; },
    renderText(d) {
      return [
        `Spend               ${money(d.total)}`,
        `  LD                ${money(d.ld)}  · ${d.ldLeads} lead(s)`,
        `  mail              ${money(d.mail)}  · ${d.mailPieces} piece(s)`,
        d.bcdCalls ? `  BCD               ${money(d.bcd)}  · ${d.bcdCalls} call(s) x ${money(d.bcdRate)}` : null,
      ].filter(Boolean).join("\n");
    },
    csv(d) {
      return {
        rows: [d],
        columns: [
          { header: "total_spend", get: (x) => x.total },
          { header: "ld_spend", get: (x) => x.ld },
          { header: "ld_leads", get: (x) => x.ldLeads },
          { header: "mail_spend", get: (x) => x.mail },
          { header: "mail_pieces", get: (x) => x.mailPieces },
          { header: "bcd_spend", get: (x) => x.bcd },
          { header: "bcd_calls", get: (x) => x.bcdCalls },
        ],
      };
    },
  },

  {
    id: "net",
    label: "Net / ROI",
    hint: "Cash minus spend, and return on spend",
    termsShort: "Money received minus spend booked, same range.",
    terms: "Money received in the range MINUS spend booked in the range. No cohort carry-forward.",
    needs: ["payments", "spend"],
    compute({ payments, spend }) {
      const cash = round2(payments.filter((p) => !p.isChargeback).reduce((s, p) => s + p.amount, 0));
      const total = spend.total || 0;
      return { cash, spend: total, net: round2(cash - total), roi: total > 0 ? round2(((cash - total) / total) * 100) : null };
    },
    renderText(d) {
      return `Net                 ${money(d.net)}   (${money(d.cash)} in − ${money(d.spend)} spend${d.roi != null ? ` · ${pct(d.roi)} ROI` : ""})`;
    },
    csv(d) {
      return { rows: [d], columns: [
        { header: "cash", get: (x) => x.cash }, { header: "spend", get: (x) => x.spend },
        { header: "net", get: (x) => x.net }, { header: "roi_pct", get: (x) => x.roi },
      ] };
    },
  },

  {
    id: REPORT_SECTION_IDS.BY_SOURCE,
    label: "By source",
    hint: "Deals, cash, spend and cost-per for each active source",
    termsShort: "ROAS = initials ÷ spend, both inside the range. Attributable call beats lead age; aged money carries no ratio.",
    terms: "Self-contained month: spend booked in the range against money from cases SOLD in the range. A case counts when its FIRST payment lands inside the window, so an initial and its follow-on payments in the same month are all valid total; a case sold earlier is residual and is Aged. Within that, the ATTRIBUTABLE CALL is primary - a marketing-line call to the source inside the window keeps the money whatever the lead age, because mail is bulk-loaded and lags. Lead age decides only when no call can be found, so an aged lead that closes with no marketing response is Aged. Aged money is counted but carries no ratio and never reaches a channel total. ROAS = initial payments / spend. ROI = (all money - spend) / spend.",
    // caseContacts is what reads SourceCampaignID off the Logics case. Without
    // it this block only sees stored snapshots and reports attributed deals as
    // "(unsourced)" — 34 of 39 over July 2026.
    // callsRange carries the actual inbound calls (45-day lookback), which is
    // what the aged rule keys on — the create date is only the fallback.
    // KNOWN GAP, deliberately not patched here (2026-07-31). The aged rule
    // keys on an attributable CALL, and CallRail only ever sees INBOUND mail
    // responses — an LD lead is dialled outbound and never rings the mail
    // line, so it can never produce one and ages out after AGED_AFTER_DAYS.
    //
    // An attempt to stand the PhoneBurner dial in as LD's equivalent was
    // reverted: the case that prompted it, WYNN 130897, has ZERO DailyDial
    // rows — it was never dialled at all — so the change fixed nothing and
    // was shipping unverified attribution onto a live board. That case is
    // genuinely Aged: bought on LD CUSTOM in June, closed in July, so the
    // money is real but is not a return on THIS window's spend.
    //
    // If it is picked up again the test is a case with a dial INSIDE the
    // lookback, and it needs the same 45-day reach the inbound calls get —
    // the window alone cannot see the dial that worked an old lead.
    needs: ["payments", "spend", "calls", "caseContacts", "callsRange"],
    compute({ payments, spendBySource, callsBySource, callsRange = [], from = null, to = null }) {
      const { canonicalSourceName, isCatchAllName } = require("./logicsSourceWriterService");
      const {
        AGED_LABEL, isActiveSource, sourceBucket, sourceChannel,
      } = require("../../shared-config/src/activeSources");
      const { applyFunctions, pickAttributionCall, resolveSourceRow, attributionDateResolver, attributionSourceResolver, foldSourceKey } = require("./reportOpsService");

      // Index the window's inbound calls by number so each payment can find
      // the call that sourced it — same rule the snapshot writer uses, so the
      // board and the stored attribution can never disagree.
      const last10 = (x) => {
        const d = String(x || "").replace(/\D/g, "");
        return d.length >= 10 ? d.slice(-10) : null;
      };
      // One attribution rule, shared with scripts/ask.js — see
      // reportOpsService.attributionDateResolver. A caller that skips it
      // reports a different set of deals for the same range.
      const attributionDateFor = attributionDateResolver(callsRange);
      // Same call, picked the same way — its PIECE rather than its date. Fills
      // the source for a deal Logics only knows as a catch-all.
      const attributionSourceFor = attributionSourceResolver(callsRange);

      const by = new Map();
      const row = (k) => {
        if (!by.has(k)) by.set(k, { source: k, deals: 0, dealCases: new Set(), newCash: 0, recurringCash: 0, spend: 0, responses: 0, leads: 0 });
        return by.get(k);
      };
      for (const p of payments.filter((x) => !x.isChargeback)) {
        // ONE resolver, shared with scripts/ask.js — see
        // reportOpsService.resolveSourceRow. It folds aliases, routes the
        // mail-house placeholder to the catch-all, and applies the aged
        // rule. Two copies of this logic is exactly how the same question
        // came to have two different answers.
        const r = row(resolveSourceRow(p, {
          rangeStart: from,
          rangeEnd: to,
          attributionCallDate: attributionDateFor(p),
          // The PIECE the attributable call rang in on. Only consulted when
          // Logics holds a catch-all or nothing — see resolveSourceRow. Before
          // this, a deal on the ABC bucket was reported as unattributed even
          // though CallRail knew exactly which mailer produced it.
          attributionCallSource: attributionSourceFor(p),
        }));
        if (p.paymentType === "initial") {
          r.dealCases.add(`${p.domain}:${p.caseId}`);
          r.deals = r.dealCases.size;                     // sales, not payment rows
          r.newCash = round2(r.newCash + p.amount);
        }
        else r.recurringCash = round2(r.recurringCash + p.amount);
      }
      // Spend and CallRail responses arrive under their own spellings of the
      // same piece; fold them onto the same row or the money and the calls
      // never meet and every cost-per reads as "—".
      // BOTH SIDES MUST FOLD THE SAME WAY. The payment side resolves through
      // sourceBucket, which now rolls every LD feed variant onto one "LD" row.
      // If the spend side does not, LD's money and LD's cost land on DIFFERENT
      // rows — the money row shows spend $0 and no ratio, and a phantom
      // "LD CUSTOM" row shows pure cost at -100%. That is exactly the split
      // seen on 2026-07-31, where LD CUSTOM carried $315 and Aged $321 against
      // 106 leads that only ever cost $318 in total.
      const { canonicalSourceLabel } = require("../../shared-config/src/activeSources");
      const bucketFor = (src) => canonicalSourceLabel(foldSourceKey(src));
      for (const [src, v] of Object.entries(spendBySource || {})) {
        const r = row(bucketFor(src));
        r.spend = round2(r.spend + v.spend); r.leads += v.leads || 0;
      }
      for (const [src, v] of Object.entries(callsBySource || {})) {
        const r = row(bucketFor(src));
        r.responses += v.responses || 0;
      }

      const out = [...by.values()].map(({ dealCases, ...r }) => {
        const totalCash = round2(r.newCash + r.recurringCash);
        const denom = r.responses || r.leads || 0;
        // ROAS vs ROI — Mickey 2026-07-28: "roas = the initial payments
        // recouped for the ad running and roi the total amount of money made
        // for a piece in the month. we arent giving urgent third its deals
        // from last month etc."
        //
        // THE MONTH IS SELF-CONTAINED. Spend in the range is set against
        // money received in the range. No cohort carry-forward, no lifetime
        // value: a piece is not credited for deals it produced in an earlier
        // month, so running the same report twice can never inflate it.
        //
        //   ROAS — did this ad pay for itself with NEW business?
        //   ROI  — what did this piece put in the bank this month, all in?
        //
        // Both are null when spend is 0: revenue with no spend behind it has
        // no return to measure, and dividing by zero would print Infinity as
        // if it were a triumph.
        return {
          ...r,
          totalCash,
          costPer: denom > 0 && r.spend > 0 ? round2(r.spend / denom) : null,
          net: round2(totalCash - r.spend),
          // Mickey 2026-07-28, exactly: "roas is just sum initials / sum costs,
          // roi is sum totals - sum costs / sum costs".
          //   ROAS — what the ad recouped in NEW business, gross.
          //   ROI  — what the piece RETURNED over its cost, net.
          // ROI is net, so it sits 100 points below the gross multiple; 0%
          // means the piece exactly paid for itself.
          // Aged is not a campaign, so it has no return to compute. Printing
          // one would re-create exactly the number this rule exists to stop.
          // One implementation of every ratio, shared with the P/L and officer
          // blocks — a second copy is how ROI came to mean two things.
          ...(r.source === AGED_LABEL
            ? { roas: null, roi: null, costPerAcquisition: null, profitMargin: null }
            : applyFunctions(
              { cost: r.spend, initial: r.newCash, total: totalCash, deals: r.deals, calls: r.responses, leads: r.leads },
              ["roas", "roi", "costPerAcquisition", "profitMargin"],
            )),
          // BCD showed 23,125% on $8.00 of spend — BCD cost is derived from
          // recorded call counts and July had 2 on record. That is a hole in
          // the spend feed, not a spectacular campaign, and a four-digit
          // percentage printed plainly reads as the latter.
          spendSuspect: r.spend > 0 && totalCash > 0 && (totalCash / r.spend) > SPEND_SUSPECT_RATIO,
        };
      })
        // A row that is zero in EVERY column is noise, not a finding. Spend
        // with no deals is kept — that is a source failing to convert, which
        // is exactly what the board is for.
        .filter((r) => r.deals || r.totalCash || r.spend || r.responses || r.leads)
        .sort((a, b) => b.newCash - a.newCash || b.spend - a.spend);

      // CHANNEL TOTALS. A stopped piece has no ratio of its own but its
      // in-month money is still mail revenue against mail spend, so the
      // channel is where "did mail work this month" actually gets answered.
      // Aged money is excluded: it is not this month's advertising at all.
      const channels = new Map();
      for (const r of out) {
        if (r.source === AGED_LABEL) continue;
        const ch = sourceChannel(r.source, (spendBySource || {})[r.source]?.channel);
        if (ch === "other") continue;
        if (!channels.has(ch)) channels.set(ch, { channel: ch, deals: 0, newCash: 0, totalCash: 0, spend: 0, responses: 0 });
        const t = channels.get(ch);
        t.deals += r.deals; t.newCash = round2(t.newCash + r.newCash);
        t.totalCash = round2(t.totalCash + r.totalCash); t.spend = round2(t.spend + r.spend);
        t.responses += r.responses || 0;
      }
      out.channels = [...channels.values()].map((t) => ({
        ...t,
        // Same registry as the per-source rows: a channel total that computed
        // its own ratio could disagree with the rows it is summing.
        ...applyFunctions(
          { cost: t.spend, initial: t.newCash, total: t.totalCash, deals: t.deals, calls: t.responses },
          ["roas", "roi", "costPerAcquisition", "profitMargin"],
        ),
      })).sort((x, y) => y.spend - x.spend);
      return out;
    },
    renderText(rows) {
      // TOTAL $ as well as NEW $: a source carrying only recurring money was
      // rendering as an empty row, which reads as "this piece made nothing"
      // when it is really "this piece made nothing NEW". "what money made and
      // where from" means all of it.
      // Mickey 2026-07-30: "we can smush spend and net roi into one column as
      // a per source break down." Spend and its return are ONE fact — what the
      // piece cost and what came back — and reading them across four columns
      // made the eye do the join. "$17,802 → 321.5%" is the sentence.
      const spendReturn = (r) => {
        if (!r.spend) return r.totalCash > 0 ? "no spend" : "—";
        const roi = r.roi != null ? `${r.roi}%${r.spendSuspect ? "?" : ""}` : "—";
        return `${money(r.spend)} → ${roi}`;
      };
      const L = ["By source".padEnd(30) + "DEALS".padStart(6) + "NEW $".padStart(12) + "TOTAL $".padStart(12)
        + "SPEND → ROI".padStart(24) + "ROAS".padStart(8) + "RESP".padStart(6) + "COST EA".padStart(9)];
      L.push("-".repeat(105));
      for (const r of rows) {
        L.push(String(r.source).slice(0, 29).padEnd(30) + String(r.deals).padStart(6)
          + money(r.newCash).padStart(12) + money(r.totalCash).padStart(12)
          + spendReturn(r).padStart(24)
          + (r.roas != null ? `${r.roas}%${r.spendSuspect ? "?" : ""}` : "—").padStart(8)
          + String(r.responses || 0).padStart(6)
          + (r.costPer != null ? money(r.costPer) : "—").padStart(9));
      }
      if (rows.channels?.length) {
        L.push("", "BY CHANNEL".padEnd(30) + "DEALS".padStart(6) + "NEW $".padStart(12) + "TOTAL $".padStart(12)
          + "SPEND".padStart(11) + "ROAS".padStart(8) + "ROI".padStart(8));
        L.push("-".repeat(87));
        for (const t of rows.channels) {
          L.push(String(t.channel.toUpperCase()).padEnd(30) + String(t.deals).padStart(6)
            + money(t.newCash).padStart(12) + money(t.totalCash).padStart(12) + money(t.spend).padStart(11)
            + (t.roas != null ? `${t.roas}%` : "—").padStart(8)
            + (t.roi != null ? `${t.roi}%` : "—").padStart(8));
        }
      }
      const suspect = rows.filter((r) => r.spendSuspect);
      if (suspect.length) {
        L.push("", `? = spend looks incomplete (over ${SPEND_SUSPECT_RATIO}x return): `
          + suspect.map((r) => `${r.source} on ${money(r.spend)}`).join(" · ")
          + " — check the spend feed before quoting these.");
      }
      return L.join("\n");
    },
    csv(rows) {
      // These columns ARE the HTML email — toTemplateData tabulates csv(), it
      // does not use renderText. roas_pct/roi_pct were listed twice, so the
      // emailed table carried 15 columns with two duplicated pairs. Order runs
      // left-to-right the way the row is read aloud: who, how many, how much
      // in, how much out, and only then the ratios and the per-unit costs.
      return {
        // Mickey 2026-07-30: "very simple by named source only no catch all no
        // unsourced no aged inactive source. this is just active roi pieces."
        // A bucket is not a piece you can spend more or less on, so it cannot
        // have a return — four rows of "—" taught the reader to skip the
        // table. The buckets stay in the CSV, where reconciliation happens.
        // AGED_LABEL is destructured inside compute(), not here — reading it
        // in csv() threw a ReferenceError that the template caught and turned
        // into a silently empty section.
        // BUT THE MONEY STILL HAS TO ADD UP. Dropping the buckets outright made
        // the email contradict itself: on 2026-07-31 the top line read
        // "$4,836 in · 1 deal" while every row of this table read zero, because
        // all of it — including a real WYNN deal — sat on Aged and the
        // catch-alls. Hiding a row must never hide money.
        //
        // So they collapse into ONE residual line instead of vanishing. The
        // table stays about active pieces; the section still reconciles to the
        // top line; and a large residual is itself the finding — it means the
        // day's money is not attributed to anything you can buy more of.
        emailRows: (() => {
          const { AGED_LABEL: AGED } = require("../../shared-config/src/activeSources");
          const isPiece = (r) => {
            const s = String(r.source || "");
            return s !== AGED && !s.startsWith("(") && !s.endsWith("(catch-all)");
          };
          const pieces = rows.filter(isPiece);
          const rest = rows.filter((r) => !isPiece(r));
          if (!rest.length) return pieces;
          const sum = (k) => round2(rest.reduce((s, r) => s + (Number(r[k]) || 0), 0));
          const count = (k) => rest.reduce((s, r) => s + (Number(r[k]) || 0), 0);
          return [...pieces, {
            // Mickey 2026-08-03: "you can change attributed to no source to
            // recurring total of all 3 databases."
            //
            // "Not attributed to a piece" described the row by what it LACKS,
            // which reads like a data-quality defect to be chased. On
            // 2026-07-31 it was genuinely the back book: $14,396.50 + $750.00
            // + $685.95 = $15,832.45, to the penny the "recurring" figure the
            // top line already states.
            //
            // BUT "Recurring" IS NOT A SAFE CONSTANT. This bucket also catches
            // the Logics catch-alls, and those hold NEW DEALS whose source has
            // not been resolved yet. On 2026-08-03 it swallowed 3 deals worth
            // $2,062.50 — ABC (catch-all) 2 and (Logics catch-all) 1 — and
            // labelled them recurring, which is simply false and hid work that
            // needs doing (scripts/sanitize-logics-source.js resolves them).
            //
            // So the row is named for what it actually holds. Deals present
            // means it is not merely recurring, and the count makes the
            // backlog visible instead of burying it.
            source: rest.reduce((s, r) => s + (Number(r.deals) || 0), 0) > 0
              ? `Unattributed — ${rest.reduce((s, r) => s + (Number(r.deals) || 0), 0)} deal(s) need a source`
              : "Recurring (all databases)",
            deals: count("deals"),
            newCash: sum("newCash"),
            recurringCash: sum("recurringCash"),
            totalCash: sum("totalCash"),
            spend: sum("spend"),
            responses: count("responses"),
            leads: count("leads"),
            // No ratio: aged and catch-all money has no campaign behind it, so
            // a return would be meaningless — the rule Aged already follows.
            roi: null,
            roas: null,
            costPer: null,
            net: round2(sum("totalCash") - sum("spend")),
            residual: true,
          }];
        })(),
        // Six columns in the mail: who, how many, what the DEALS were worth,
        // what came in all told, what it cost, and the return.
        //
        // new_cash is not a nicety. Without it the row reads
        // "Not attributed (4) | 1 | $4,836" and a reader joins those two into
        // a $4,836 deal — it is a $700 deal on WYNN 130897 plus $4,136 of
        // recurring from other clients entirely. Deals and total cash next to
        // each other, with nothing between them, is an invitation to misread.
        //
        // THE EMAILED RATIO IS ROAS, NOT ROI. Mickey 2026-07-31: "what they
        // wanna see is roas anyway roi is a month based thing. so initial
        // payments and spend for that percentage on the daily email."
        //
        // ROI = (all money - spend) / spend, and "all money" on any single day
        // is mostly RECURRING from cases sold months ago against TODAY's
        // spend. The two have nothing to do with each other, so a daily ROI
        // swings on when the recurring batch happens to land. ROAS = initials
        // / spend compares the money a piece made today to what it cost today.
        // ROI still ships in the CSV, where a month-long range makes it mean
        // something.
        emailColumns: [
          { header: "source", get: (x) => x.source },
          { header: "deals", get: (x) => x.deals },
          { header: "new_cash", get: (x) => x.newCash },
          { header: "total_cash", get: (x) => x.totalCash },
          { header: "spend", get: (x) => x.spend },
          { header: "roas_pct", get: (x) => x.roas },
        ],
        rows,
        columns: [
        { header: "source", get: (x) => x.source },
        { header: "deals", get: (x) => x.deals },
        { header: "new_cash", get: (x) => x.newCash },
        { header: "recurring_cash", get: (x) => x.recurringCash },
        { header: "total_cash", get: (x) => x.totalCash },
        { header: "spend", get: (x) => x.spend },
        { header: "net", get: (x) => x.net },
        { header: "roi_pct", get: (x) => x.roi },
        { header: "roas_pct", get: (x) => x.roas },
        { header: "responses", get: (x) => x.responses },
        { header: "leads", get: (x) => x.leads },
        { header: "cost_per", get: (x) => x.costPer },
        { header: "spend_suspect", get: (x) => Boolean(x.spendSuspect) },
        ],
      };
    },
  },

  {
    id: "officer",
    label: "By settlement officer",
    hint: "Deals and cash closed, alongside calls handled",
    termsShort: "Credited to the officer who held the case at sale.",
    terms: "Deals credited to the officer who held the case AT SALE, from the stored snapshot - not whoever holds it today.",
    needs: ["payments", "queue", "caseContacts"],
    compute({ payments, queueByAgent }) {
      // The roster resolves name variants and keeps queues off the people
      // list — the same rules the work log uses, so the two boards agree.
      const {
        canonicalStaffName, isNotAPerson,
      } = require("../../shared-config/src/staffRoster");
      const by = new Map();
      const row = (k) => {
        if (!by.has(k)) by.set(k, { officer: k, deals: 0, dealCases: new Set(), cash: 0, mailCalls: 0, ldDials: 0, bcdCalls: 0 });
        return by.get(k);
      };
      for (const p of payments.filter((x) => !x.isChargeback)) {
        const r = row(p.officerAtSale
          ? canonicalStaffName(p.officerAtSale)
          : (p.attributionSnapshot === "missing" ? "(no snapshot)" : "(unassigned)"));
        r.cash = round2(r.cash + p.amount);
        if (p.paymentType === "initial") {
          r.dealCases.add(`${p.domain}:${p.caseId}`);
          r.deals = r.dealCases.size;                     // sales, not payment rows
        }
      }
      for (const [agent, v] of Object.entries(queueByAgent || {})) {
        if (isNotAPerson(agent)) continue;          // a queue is not an officer
        const r = row(canonicalStaffName(agent));
        r.mailCalls += v.MAILER || 0; r.bcdCalls += v.BCD || 0; r.ldDials += v.LD || 0;
      }
      // Officer performance is the same three parts as everything else:
      // substrate (their cash and deals), factor (the officer), functions.
      return [...by.values()]
        .map(({ dealCases, ...r }) => ({
          ...r,
          cashPerDeal: r.deals > 0 ? round2(r.cash / r.deals) : null,
        }))
        .sort((a, b) => b.cash - a.cash || (b.mailCalls + b.ldDials) - (a.mailCalls + a.ldDials));
    },
    renderText(rows) {
      const L = ["By settlement officer".padEnd(24) + "DEALS".padStart(6) + "COLLECTED".padStart(13) + "MAIL".padStart(7) + "LD".padStart(8)];
      L.push("-".repeat(58));
      for (const r of rows) {
        L.push(String(r.officer).slice(0, 23).padEnd(24) + String(r.deals).padStart(6)
          + money(r.cash).padStart(13) + String(r.mailCalls || "—").padStart(7) + String(r.ldDials || "—").padStart(8));
      }
      return L.join("\n");
    },
    csv(rows) {
      // Roster-filtered, shared with "Calls by agent" — see
      // settlementOfficersOnly at the top of this file. Email only; the CSV
      // below keeps every officer.
      const emailRows = settlementOfficersOnly(rows);
      return { rows, emailRows, columns: [
        { header: "officer", get: (x) => x.officer }, { header: "deals", get: (x) => x.deals },
        { header: "collected", get: (x) => x.cash }, { header: "mail_calls", get: (x) => x.mailCalls },
        { header: "bcd_calls", get: (x) => x.bcdCalls }, { header: "ld_dials", get: (x) => x.ldDials },
      ] };
    },
  },

  {
    id: "cohort",
    label: "Client since (vintage)",
    hint: "What share of revenue comes from each signing year",
    termsShort: "Grouped by the year the client first paid.",
    terms: "Grouped by the year the client FIRST paid, from the attribution snapshot. Never inferred from the payment date.",
    needs: ["payments"],
    compute({ payments }) {
      const by = new Map();
      for (const p of payments.filter((x) => !x.isChargeback)) {
        // Same rule as reportOps.dimensionValue: no snapshot means we do NOT
        // know the signing year, and guessing it from the payment date books
        // a long-standing client as a new one.
        const first = p.metricsTreatment?.firstPaidDateKey;
        const year = first ? String(first).slice(0, 4) : "(unattributed)";
        if (!by.has(year)) by.set(year, { cohort: year, cash: 0, newCash: 0, recurringCash: 0, cases: new Set() });
        const b = by.get(year);
        b.cash = round2(b.cash + p.amount);
        b.cases.add(`${p.domain}:${p.caseId}`);
        if (p.paymentType === "initial") b.newCash = round2(b.newCash + p.amount);
        else b.recurringCash = round2(b.recurringCash + p.amount);
      }
      const total = round2([...by.values()].reduce((s, b) => s + b.cash, 0));
      return [...by.values()]
        .map((b) => ({ ...b, cases: b.cases.size, pctOfRevenue: total > 0 ? Math.round((b.cash / total) * 1000) / 10 : null }))
        .sort((a, b) => String(b.cohort).localeCompare(String(a.cohort)));
    },
    renderText(rows) {
      const L = ["Client since".padEnd(16) + "CASES".padStart(7) + "NEW $".padStart(13) + "RECURRING $".padStart(14) + "TOTAL $".padStart(13) + "% REV".padStart(8)];
      L.push("-".repeat(71));
      for (const r of rows) {
        L.push(String(r.cohort).padEnd(16) + String(r.cases).padStart(7) + money(r.newCash).padStart(13)
          + money(r.recurringCash).padStart(14) + money(r.cash).padStart(13) + pct(r.pctOfRevenue).padStart(8));
      }
      return L.join("\n");
    },
    csv(rows) {
      return { rows, columns: [
        { header: "client_since", get: (x) => x.cohort }, { header: "cases", get: (x) => x.cases },
        { header: "new_cash", get: (x) => x.newCash }, { header: "recurring_cash", get: (x) => x.recurringCash },
        { header: "total_cash", get: (x) => x.cash }, { header: "pct_of_revenue", get: (x) => x.pctOfRevenue },
      ] };
    },
  },

  {
    id: REPORT_SECTION_IDS.STATUS,
    label: "Status movement",
    hint: "DNC, post-dates, suspensions and conversions",
    termsShort: "Status changes inside the range, not current status.",
    terms: "Status CHANGES that happened inside the range - not the status a case holds now.",
    needs: ["activity"],
    compute({ events }) {
      const c = { dnc: 0, postdate: 0, suspended: 0, conversions: 0, other: 0, keyChanges: [] };
      // Mickey 2026-07-30: "redlines to chase can be status changes broadly and
      // then key status changes." The counts say what moved; the list says who
      // to call. A count alone is a fact nobody can act on tomorrow morning.
      const KEY = new Set(["dnc", "postdate", "suspended"]);
      const seen = new Set();
      for (const e of events) {
        if (e.kind === "conversion") { c.conversions += 1; continue; }
        if (e.kind !== "status-change" || e.payload?.selfTransition) continue;
        const k = e.payload?.safetyClass;
        if (k === "dnc") c.dnc += 1;
        else if (k === "postdate") c.postdate += 1;
        else if (k === "suspended") c.suspended += 1;
        else c.other += 1;
        if (!KEY.has(k)) continue;
        // One row per case per lane — a case re-saved twice is not two chases.
        const key = `${e.domain}:${e.caseId}:${k}`;
        if (seen.has(key)) continue;
        seen.add(key);
        c.keyChanges.push({
          domain: e.domain,
          caseId: e.caseId,
          lane: k,
          toStatus: e.payload?.toStatus || null,
          by: e.createdBy || null,
          at: e.createdAt ? String(e.createdAt).slice(0, 10) : null,
        });
      }
      const ORDER = { suspended: 0, postdate: 1, dnc: 2 };
      c.keyChanges.sort((a, b) => (ORDER[a.lane] - ORDER[b.lane])
        || String(a.caseId).localeCompare(String(b.caseId)));
      return c;
    },
    renderText(d) {
      const L = [`Status              ${d.dnc} DNC · ${d.postdate} post-date · ${d.suspended} suspended · ${d.conversions} converted`];
      const key = d.keyChanges || [];
      if (key.length) {
        // Money first: a payment default costs more to ignore than a DNC.
        const LANE = { suspended: "SUSPENDED", postdate: "POST-DATE", dnc: "DNC" };
        L.push("", `REDLINES TO CHASE (${key.length})`);
        for (const r of key.slice(0, 30)) {
          L.push(`  ${LANE[r.lane].padEnd(10)} ${r.domain} ${String(r.caseId).padEnd(8)}`
            + `${r.toStatus ? ` → ${r.toStatus}` : ""}${r.by ? `  — ${r.by}` : ""}`);
        }
        if (key.length > 30) L.push(`  … and ${key.length - 30} more`);
      }
      return L.join(NEWLINE);
    },
    csv(d) {
      // THE EMAIL IS BUILT FROM csv(), NOT renderText. This returned only the
      // five counts, so "REDLINES TO CHASE" — the only actionable part of the
      // section, and half of Mickey's ruling ("status changes broadly and then
      // key status changes") — existed solely in a plain-text body nobody
      // reads. The counts move to `summary`; the rows become the chase list.
      const LANE = { suspended: "SUSPENDED", postdate: "POST-DATE", dnc: "DNC" };
      const key = d.keyChanges || [];

      // Mickey 2026-08-03: "lets see what doing like a 3 column status movement
      // one for suspend, one for post date one for dnc save a little space."
      //
      // The list was one row per case with the lane repeated beside it, so 19
      // changes cost 19 rows and the word SUSPENDED seven times. Pivoting the
      // lane into the COLUMN spends the width we already have and costs only
      // as many rows as the busiest single lane — 19 rows becomes 7 here.
      //
      // Column order is money-first, matching the sort: a payment default
      // costs more to ignore than a DNC.
      // Mickey 2026-08-05: "instead of one row per thing it's a list sorted by
      // database — tag: 1234, 5678 / wynn: 3456 — so instead of a thing that's
      // 50 lines long you can fit maybe 10 keys per row."
      //
      // The three-column pivot above already turned 19 rows into 7, and that is
      // enough for ONE day. It stops being enough the moment this block renders
      // a range: a month of redlines is hundreds deep, and one case per cell
      // makes a wall nobody reads. Packing ten ids per row costs the same width
      // and turns a month into a handful of lines.
      //
      // De-duplicated per lane, because a case that flipped twice in a range is
      // still one case to chase — printing it twice implies two.
      const LANES = [["suspended", "SUSPENDED"], ["postdate", "POST-DATE"], ["dnc", "DNC"]];
      const PER_ROW = 10;
      const laneRows = [];
      for (const [lane, laneLabel] of LANES) {
        const grouped = groupCaseIds(key.filter((r) => r.lane === lane));
        for (const [domain, ids] of Object.entries(grouped)) {
          for (let i = 0; i < ids.length; i += PER_ROW) {
            laneRows.push({
              // Lane and database label the FIRST row of their run only, so the
              // eye follows one list rather than re-reading the same word.
              lane: i === 0 ? laneLabel : "",
              db: i === 0 ? domain.toLowerCase() : "",
              cases: ids.slice(i, i + PER_ROW).join(", "),
            });
          }
        }
      }

      return {
        // No summary. Mickey 2026-07-30: the counts live "only at the top" —
        // repeating them over the list is the same fact twice on one screen.
        summary: d.rangeSummary
          ? `${d.dnc || 0} DNC · ${d.postdate || 0} post-date · ${d.suspended || 0} suspended · ${d.conversions || 0} converted · ${d.other || 0} other`
          : undefined,
        rows: key.slice(0, 30),
        // Mickey 2026-07-30: "dont need moved by or date just case and lane
        // really." Who moved it and when are lookups, not decisions.
        emailRows: laneRows,
        emailColumns: [
          { header: "", get: (x) => x.lane },
          { header: "", get: (x) => x.db },
          { header: "cases", get: (x) => x.cases },
        ],
        columns: [
          { header: "lane", get: (x) => LANE[x.lane] || x.lane },
          { header: "case", get: (x) => `${x.domain} ${x.caseId}` },
          { header: "moved_to", get: (x) => x.toStatus || null },
          { header: "moved_by", get: (x) => x.by || null },
          { header: "on", get: (x) => x.at || null },
        ],
      };
    },
  },

  {
    id: "recordings",
    label: "Calls to review",
    hint: "Deals, post dates and 10 min+ calls, with listen links",
    termsShort: "Deals, post-dates and 10 min+ calls inside the range.",
    terms: "Calls inside the range worth hearing: deals, post-dates and 10 min+. SOURCE marks the call the attribution came from.",
    // PAYMENTS is required, not optional: a call is only knowable as a DEAL
    // call by matching it to a sale. Declaring only "recordings" meant
    // picking this block alone gathered no payments, so every deal call was
    // silently tagged LONG and landed in an outcome=no-deal filter — the
    // exact opposite of the truth.
    needs: ["recordings", "payments"],
    compute({ recordings }) { return recordings || []; },
    renderText(rows) {
      if (!rows.length) return "Calls to review     (none)";
      const L = ["Calls to review"];
      for (const c of rows.slice(0, 15)) {
        // SOURCE marks the call the attribution actually came from — the
        // longest on the close day. Without it a three-call deal shows three
        // DEAL rows and the reader cannot tell which one earned the source.
        // An outbound dial has no caller — name the AGENT and the case instead
        // of printing "?", which read as missing data rather than "this is an
        // outbound call".
        const who = c.caller || c.phone
          || (c.agent ? `${c.agent}${c.caseId ? ` → case ${c.caseId}` : ""}` : null)
          || "?";
        L.push(`  [${(c.reasons || []).join("·")}] ${c.minutes}m ${who}${c.officer ? ` → ${c.officer}` : ""}`
          + (c.isAttributionCall && c.source ? `  (source: ${c.source})` : ""));
        L.push(`      ${c.listenUrl || "(no link)"}`);
      }
      return L.join("\n");
    },
    csv(rows) {
      // WHO the row is about differs by platform, and forcing one column to
      // mean both was producing `undefined` cells. A CallRail row is an
      // INBOUND call, so the identity is the caller. A PhoneBurner row is an
      // OUTBOUND dial — there is no caller; the identity is the agent who
      // placed it and the case they dialled.
      //
      // Every getter returns null rather than undefined: undefined reaches the
      // template as a hole and can render the literal word, while null is a
      // blank cell in both the mail and the CSV.
      return { rows, columns: [
        { header: "reasons", get: (x) => (x.reasons || []).join("|") },
        { header: "minutes", get: (x) => x.minutes ?? null },
        { header: "platform", get: (x) => x.platform ?? null },
        { header: "caller", get: (x) => x.caller || x.phone || null },
        { header: "agent", get: (x) => x.agent || x.agentUserId || null },
        { header: "case_id", get: (x) => x.caseId ?? null },
        { header: "officer", get: (x) => x.officer || null },
        { header: "listen_url", get: (x) => x.listenUrl || null },
      ] };
    },
  },
  {
    id: "offhourscalls",
    label: "Called while nobody was here",
    hint: "New prospects who rang outside working hours — a call-back list",
    termsShort: "First-time inbound callers whose call landed outside working hours.",
    terms: "FIRST-TIME inbound CallRail callers whose call landed outside working hours (after 17:00, before 08:00, or at a weekend). Only calls INSIDE the reported range count - the call feed reaches back 45 days so call-to-close lag is not clipped, and that lookback is excluded here or a call-back sheet would carry a month of stale callers. The day and hour are the PACIFIC ones the call happened at, not the day it was fetched. Repeat callers are excluded - they are already in somebody's follow-up. Ordered oldest first, because the coldest lead is the one most likely to go away.",
    needs: ["callsRange"],
    compute({ callsRange = [], callsRangeUnavailable = null, from = null, to = null }) {
      // ── WHY THIS EXISTS ─────────────────────────────────────────────────
      //
      // Mickey 2026-08-04: a morning email to settlement officers "about where
      // to clean up some money including red lines and overnight calls".
      //
      // Measured over 2026-08-01..02: 31 inbound calls, 19 of them FIRST-TIME
      // callers, every one carrying a callback number — and no board reported
      // any of it, because none runs at a weekend. Those 19 raised their hand
      // and then sat through Monday untouched.
      //
      // FIRST-TIME ONLY. A repeat caller is already in someone's follow-up, so
      // listing them turns a call-back sheet into a call log nobody actions.
      // CallRail's own `firstCall` is authoritative here: it counts calls we
      // never matched to a case, which anything we rebuilt would miss.
      const OPEN_HOUR = Number(process.env.OFF_HOURS_OPEN || 8);
      const CLOSE_HOUR = Number(process.env.OFF_HOURS_CLOSE || 17);
      const PACIFIC = "America/Los_Angeles";

      // The DATE must come from the same clock as the hour. `dateKey` is the
      // day the sync FETCHED, which is not always the Pacific day the call
      // happened on: a call at 2026-08-03T04:00Z is Sunday 2026-08-02 21:00
      // Pacific, and pairing dateKey with the Pacific weekday printed
      // "2026-08-03 Sun" — a date and a day-name that contradict each other on
      // a sheet somebody is meant to work from.
      const partsOf = (iso) => {
        const at = Date.parse(iso);
        if (!Number.isFinite(at)) return null;
        const f = new Intl.DateTimeFormat("en-CA", {
          timeZone: PACIFIC, weekday: "short", hour: "2-digit", hour12: false,
          year: "numeric", month: "2-digit", day: "2-digit",
        }).formatToParts(new Date(at));
        const get = (t) => f.find((x) => x.type === t)?.value;
        return {
          weekday: get("weekday"),
          hour: Number(get("hour")) % 24,
          dateKey: `${get("year")}-${get("month")}-${get("day")}`,
        };
      };

      const rows = [];
      for (const c of callsRange) {
        // Only calls INSIDE the reported range. callsRange deliberately reaches
        // back 45 days so call-to-close lag is not clipped, and that lookback
        // must not leak a month of old callers into a call-back sheet.
        if (from && String(c.dateKey || "") < from) continue;
        if (to && String(c.dateKey || "") > to) continue;
        if (c.firstCall !== true) continue;
        const p = partsOf(c.startedAt);
        if (!p) continue;
        const weekend = p.weekday === "Sat" || p.weekday === "Sun";
        const offHours = weekend || p.hour < OPEN_HOUR || p.hour >= CLOSE_HOUR;
        if (!offHours) continue;
        rows.push({
          // The PACIFIC day the call happened, not the day it was fetched.
          dateKey: p.dateKey,
          fetchedUnder: c.dateKey,
          when: `${p.weekday} ${String(p.hour).padStart(2, "0")}:00`,
          source: c.source || "(unknown)",
          phone: c.phone || null,
          durationSec: Number(c.durationSec) || 0,
          minutes: Math.round((Number(c.durationSec) || 0) / 6) / 10,
          // A call nobody picked up is the most urgent row on the page.
          answered: c.answered,
          weekend,
        });
      }
      // Oldest first — the coldest lead goes stale soonest.
      rows.sort((a, b) => String(a.dateKey).localeCompare(String(b.dateKey)) || a.when.localeCompare(b.when));
      rows.unavailable = callsRangeUnavailable || null;
      return rows;
    },
    renderText(rows) {
      if (rows.unavailable) return `Called while nobody was here   FEED INCOMPLETE — ${rows.unavailable}`;
      if (!rows.length) return "Called while nobody was here   (none)";
      const L = [`Called while nobody was here (${rows.length})`];
      for (const r of rows.slice(0, 40)) {
        L.push(`  ${r.dateKey} ${r.when}  ${String(r.source).slice(0, 30).padEnd(31)}`
          + `${r.phone || "(no number)"}  ${r.minutes}m${r.answered === false ? "  MISSED" : ""}`);
      }
      if (rows.length > 40) L.push(`  … and ${rows.length - 40} more`);
      return L.join(NEWLINE);
    },
    csv(rows) {
      const missed = rows.filter((r) => r.answered === false).length;
      return {
        // An unreadable feed is NOT a quiet weekend. Say which.
        summary: rows.unavailable
          ? `CALL FEED INCOMPLETE — ${rows.unavailable}`
          : (rows.length
            ? `${rows.length} first-time caller(s) rang outside working hours`
              + (missed ? ` · ${missed} went unanswered` : "")
            : undefined),
        rows,
        // The phone IS the deliverable — this is a call-back sheet, not a
        // report. Everything else is context for deciding who to ring first.
        emailColumns: [
          { header: "when", get: (x) => `${x.dateKey} ${x.when}` },
          { header: "piece", get: (x) => x.source },
          { header: "call back", get: (x) => x.phone || null },
          { header: "mins", get: (x) => x.minutes },
        ],
        columns: [
          { header: "date", get: (x) => x.dateKey },
          { header: "when", get: (x) => x.when },
          { header: "weekend", get: (x) => (x.weekend ? "yes" : "no") },
          { header: "piece", get: (x) => x.source },
          { header: "phone", get: (x) => x.phone || null },
          { header: "minutes", get: (x) => x.minutes },
          { header: "answered", get: (x) => (x.answered === null ? null : Boolean(x.answered)) },
        ],
      };
    },
  },
  {
    id: "postdates",
    label: "Post-dates: kept or lost",
    hint: "Cases promised for a later date, and whether the money actually arrived",
    termsShort: "Promised for a later date, checked against money that actually arrived.",
    terms: "Cases promised for a later date inside the range, then checked against Billing for money arriving AFTER that date.",
    needs: ["activity", "postdateBilling"],
    compute({ postdateBilling = [] }) {
      return [...postdateBilling]
        .map((c) => ({
          ...c,
          outcome: c.error ? "unknown"
            : c.paidAfter ? "converted"
              : c.noBillingRecord ? "no-billing-record"
                : c.declinedCount > 0 ? "declined"
                  : "not-yet",
        }))
        .sort((a, b) => String(a.postdatedOn).localeCompare(String(b.postdatedOn)));
    },
    renderText(rows) {
      const n = rows.length;
      const won = rows.filter((r) => r.outcome === "converted");
      const rate = n > 0 ? Math.round((won.length / n) * 1000) / 10 : null;
      const L = [`${n} post-dated · ${won.length} converted (${pct(rate)}) · ${money(won.reduce((s2, r) => s2 + r.amountAfter, 0))} collected`, ""];
      L.push("DOMAIN".padEnd(7) + "CASE".padStart(9) + "  POSTDATED  " + "OUTCOME".padEnd(18) + "COLLECTED".padStart(12));
      L.push("-".repeat(62));
      for (const r of rows) {
        L.push(String(r.domain).padEnd(7) + String(r.caseId).padStart(9) + "  " + String(r.postdatedOn).padEnd(11)
          + String(r.outcome).padEnd(18) + money(r.amountAfter).padStart(12));
      }
      // "declined" and "no-billing-record" are different failures: one tried
      // and the card bounced, the other never got entered. Do not merge them.
      const by = {};
      for (const r of rows) by[r.outcome] = (by[r.outcome] || 0) + 1;
      L.push("", Object.entries(by).map(([k, v]) => `${k}: ${v}`).join(" · "));
      return L.join("\n");
    },
    csv(rows) {
      return { rows, columns: [
        { header: "domain", get: (x) => x.domain }, { header: "case_id", get: (x) => x.caseId },
        { header: "postdated_on", get: (x) => x.postdatedOn }, { header: "to_status", get: (x) => x.toStatus },
        { header: "outcome", get: (x) => x.outcome }, { header: "collected_after", get: (x) => x.amountAfter },
        { header: "declined_count", get: (x) => x.declinedCount }, { header: "declined_amount", get: (x) => x.declinedAmount },
      ] };
    },
  },
  {
    id: "declines",
    label: "Declines to chase",
    hint: "Money that was attempted and bounced — recoverable if worked today",
    termsShort: "Failed payment attempts, not netted against successes.",
    terms: "Payment attempts that failed inside the range, grouped by case. Not netted against successful payments.",
    needs: ["payments", "caseContacts"],
    compute({ declines = [] }) {
      const by = new Map();
      for (const d of declines) {
        const key = `${d.domain}:${d.caseId}`;
        if (!by.has(key)) {
          by.set(key, {
            domain: d.domain, caseId: d.caseId, name: d.name || null,
            officer: d.officerAtSale || null, phone: d.phone || null,
            attempts: 0, amount: 0, lastTried: null,
          });
        }
        const b = by.get(key);
        b.attempts += 1;
        b.amount = round2(b.amount + Math.abs(Number(d.amount) || 0));
        const when = d.paymentDateKey || null;
        if (when && (!b.lastTried || when > b.lastTried)) b.lastTried = when;
      }
      return [...by.values()].sort((a, b) => b.amount - a.amount);
    },
    renderText(rows) {
      const total = round2(rows.reduce((s2, r) => s2 + r.amount, 0));
      const L = [`${rows.length} case(s) with declined attempts · ${money(total)} attempted and not captured`, ""];
      L.push("DOMAIN".padEnd(7) + "CASE".padStart(9) + "  " + "CLIENT".padEnd(22) + "TRIES".padStart(6) + "AMOUNT".padStart(12) + "  LAST");
      L.push("-".repeat(74));
      for (const r of rows) {
        L.push(String(r.domain).padEnd(7) + String(r.caseId).padStart(9) + "  " + String(r.name || "—").slice(0, 21).padEnd(22)
          + String(r.attempts).padStart(6) + money(r.amount).padStart(12) + "  " + String(r.lastTried || "—"));
      }
      return L.join("\n");
    },
    csv(rows) {
      return { rows, columns: [
        { header: "domain", get: (x) => x.domain }, { header: "case_id", get: (x) => x.caseId },
        { header: "client", get: (x) => x.name }, { header: "phone", get: (x) => x.phone },
        { header: "officer", get: (x) => x.officer }, { header: "attempts", get: (x) => x.attempts },
        { header: "amount_attempted", get: (x) => x.amount }, { header: "last_tried", get: (x) => x.lastTried },
      ] };
    },
  },
  {
    id: "effort",
    label: "Effort to close",
    hint: "How much contact it took before a case paid — inbound for TAG, dials for WYNN",
    termsShort: "Contact up to the close day: inbound for TAG, dials for WYNN.",
    terms: "Contact events up to and including the close day. Inbound touches for TAG, outbound dials for WYNN - never averaged together.",
    // Two lanes, never one median. A WYNN outbound dial attempt and a TAG
    // inbound call are different units with OPPOSITE agency; averaging them
    // is a category error. Routing is by PAYMENT domain, never by dial domain.
    needs: ["payments", "dials", "callsRange", "caseContacts"],
    compute({ payments = [], dials = [], callsRange = [] }) {
      const ops = require("./reportOpsService");
      const deals = payments.filter((p) => p.paymentType === "initial" && !p.isChargeback);

      // ── Inbound lane. CallRail is one shared account: mail is bought for
      //    TAG only, but BCD runs for several tenants, so a WYNN deal can
      //    legitimately arrive on a BCD call. Eligibility is decided per call
      //    by sourceFitsDomain, not by excluding whole tenants.
      const tagDeals = deals.filter((d) => {
        const dom = String(d.domain).toUpperCase();
        return dom === "TAG" || dom === "WYNN";
      });
      const byPhone = new Map();
      for (const c of callsRange) {
        const k = ops.last10 ? ops.last10(c.phone) : String(c.phone || "").replace(/\D/g, "").slice(-10);
        if (!k) continue;
        if (!byPhone.has(k)) byPhone.set(k, []);
        byPhone.get(k).push(c);
      }
      const inbound = tagDeals.map((d) => {
        const keys = [...new Set([d.phone, ...(d.phones || [])]
          .map((x) => String(x || "").replace(/\D/g, "").slice(-10)).filter((x) => x.length === 10))];
        const calls = keys.flatMap((k) => byPhone.get(k) || [])
          .filter((c) => ops.sourceFitsDomain(c.source, d.domain));
        const paid = d.paymentDateKey || null;
        const before = calls.filter((c) => String(c.dateKey) < String(paid)).length;
        const sameDay = calls.filter((c) => String(c.dateKey) === String(paid)).length;
        // CallRail counts prior calls itself, including ones we never joined
        // to a case — prefer its number and say which we used.
        const priors = calls.map((c) => c.priorCalls).filter((n) => Number.isFinite(n));
        return {
          domain: d.domain, caseId: d.caseId, basis: "inbound-callrail",
          covered: calls.length > 0,
          touchesBeforeClose: before, sameDayTouches: sameDay, touchesToClose: before + sameDay,
          providerPriorCalls: priors.length ? Math.max(...priors) : null,
          firstCallClose: calls.length === 1 && sameDay === 1,
          closedOn: paid,
          reason: calls.length ? null : (keys.length ? "no-callrail-match" : "no-phone-on-file"),
        };
      });

      // ── WYNN: outbound dial attempts.
      // WYNN also has an outbound lane; a WYNN deal can appear in both, which
      // is correct — they are different questions, never summed.
      const wynnDeals = deals.filter((d) => String(d.domain).toUpperCase() === "WYNN");
      const outbound = ops.joinAttempts(wynnDeals, dials).map((r) => ({
        ...r, basis: "outbound-dials", covered: r.hadDialRecord,
        touchesBeforeClose: r.attemptsBeforeClose, sameDayTouches: r.sameDayAttempts,
        touchesToClose: r.attemptsToClose,
        reason: r.hadDialRecord ? null : "no-dial-record",
      }));

      // AMITY has neither source. Say so; do not leave it out and let the
      // reader assume it was zero-effort.
      const other = deals
        .filter((d) => !["TAG", "WYNN"].includes(String(d.domain).toUpperCase()))
        .map((d) => ({
          domain: d.domain, caseId: d.caseId, basis: "none", covered: false,
          touchesBeforeClose: null, sameDayTouches: null, touchesToClose: null,
          closedOn: d.paymentDateKey || null, reason: "no-contact-source-for-domain",
        }));

      const dist = (rows) => ops.distribution(rows.filter((r) => r.covered).map((r) => r.touchesToClose));
      return {
        rows: [...inbound, ...outbound, ...other],
        lanes: [
          { basis: "inbound-callrail", label: "Inbound calls before close (TAG mail + BCD)", rows: inbound, dist: dist(inbound) },
          { basis: "outbound-dials", label: "Outbound dial attempts before close (WYNN)", rows: outbound, dist: dist(outbound) },
        ].filter((l) => l.rows.length),
        unmeasurable: other,
      };
    },
    renderText(data) {
      const L = [];
      for (const lane of data.lanes) {
        const cov = lane.rows.filter((r) => r.covered).length;
        L.push(`${lane.label} — ${lane.rows.length} deal(s) · ${cov} with contact history · ${lane.rows.length - cov} without`);
        if (lane.dist.n > 0) {
          L.push(`  touches to close: median ${lane.dist.median} · p90 ${lane.dist.p90} · max ${lane.dist.max}`);
          if (lane.basis === "inbound-callrail") {
            const first = lane.rows.filter((r) => r.firstCallClose).length;
            L.push(`  closed on the FIRST inbound call: ${first} of ${cov} (${pct(cov ? Math.round((first / cov) * 1000) / 10 : null)})`);
          }
        }
        L.push("");
        L.push("DOMAIN".padEnd(7) + "CASE".padStart(9) + "BEFORE".padStart(8) + "SAME DAY".padStart(10) + "TOTAL".padStart(7) + "  CLOSED      WHY NOT");
        L.push("-".repeat(78));
        for (const r of lane.rows.slice(0, 30)) {
          L.push(String(r.domain).padEnd(7) + String(r.caseId).padStart(9)
            + (r.covered ? String(r.touchesBeforeClose).padStart(8) : "—".padStart(8))
            + (r.covered ? String(r.sameDayTouches).padStart(10) : "—".padStart(10))
            + (r.covered ? String(r.touchesToClose).padStart(7) : "—".padStart(7))
            + "  " + String(r.closedOn || "").padEnd(12) + (r.reason || ""));
        }
        L.push("");
      }
      if (data.unmeasurable.length) {
        L.push(`${data.unmeasurable.length} deal(s) have no contact source for their domain (${[...new Set(data.unmeasurable.map((r) => r.domain))].join(", ")}) — not counted as zero effort.`);
      }
      // The two medians are never combined: different units, opposite agency.
      return L.join(NEWLINE);
    },
    csv(data) {
      return { rows: data.rows, columns: [
        { header: "domain", get: (x) => x.domain }, { header: "case_id", get: (x) => x.caseId },
        { header: "measurement_basis", get: (x) => x.basis },
        { header: "has_contact_history", get: (x) => x.covered },
        { header: "touches_before_close", get: (x) => x.touchesBeforeClose },
        { header: "same_day_touches", get: (x) => x.sameDayTouches },
        { header: "touches_to_close", get: (x) => x.touchesToClose },
        { header: "callrail_prior_calls", get: (x) => x.providerPriorCalls ?? null },
        { header: "first_call_close", get: (x) => x.firstCallClose ?? null },
        { header: "closed_on", get: (x) => x.closedOn },
        { header: "why_not_covered", get: (x) => x.reason },
      ] };
    },
  },
  {
    id: "lag",
    // Each reason is a DIFFERENT fact and none of them means "nobody called".
    // CallRail sees tracking numbers only, so an unmatched TAG deal may still
    // have had a long inbound call on the main DID.
    label: "Call to close lag",
    hint: "Days from first inbound call to the first payment",
    termsShort: "Days from first inbound call to first payment.",
    terms: "Days from the FIRST inbound call to the first payment. Source follows the attribution rule: longest call on the close day.",
    needs: ["payments", "callsRange", "caseContacts"],
    compute({ payments = [], callsRange = [] }) {
      const ops = require("./reportOpsService");
      const deals = payments.filter((p) => p.paymentType === "initial" && !p.isChargeback);
      const rows = ops.lag(deals, callsRange);
      const matched = rows.filter((r) => r.coverage === "matched");
      return { rows, dist: ops.distribution(matched.map((r) => r.days)), matched: matched.length };
    },
    renderText(data) {
      const { rows, dist, matched } = data;
      const offTenant = rows.filter((r) => r.reason === "callrail-is-tag-only").length;
      const L = [`${rows.length} deal(s) · ${matched} matched to a CallRail call · ${rows.length - matched} unmatched`
        + (offTenant ? ` (${offTenant} not a CallRail tenant)` : "")];
      if (dist.n > 0) L.push(`days to close — median ${dist.median} · p90 ${dist.p90} · max ${dist.max}`);
      L.push("");
      L.push("DOMAIN".padEnd(7) + "CASE".padStart(9) + "DAYS".padStart(7) + "  " + "SOURCE".padEnd(26) + "AMOUNT".padStart(11));
      L.push("-".repeat(63));
      for (const r of rows.slice(0, 40)) {
        L.push(String(r.domain).padEnd(7) + String(r.caseId).padStart(9)
          + (r.days === null ? "—".padStart(7) : String(r.days).padStart(7))
          + "  " + String(r.source || LAG_REASON[r.reason] || "—").slice(0, 25).padEnd(26)
          + money(r.amount).padStart(11));
      }
      return L.join("\n");
    },
    csv(data) {
      return { rows: data.rows, columns: [
        { header: "domain", get: (x) => x.domain }, { header: "case_id", get: (x) => x.caseId },
        { header: "coverage", get: (x) => x.coverage }, { header: "reason", get: (x) => x.reason },
        { header: "days_to_close", get: (x) => x.days }, { header: "inbound_calls", get: (x) => x.calls },
        { header: "first_call_at", get: (x) => x.firstCallAt }, { header: "source", get: (x) => x.source },
        { header: "amount", get: (x) => x.amount },
      ] };
    },
  },
  {
    id: "streams",
    label: "Queue performance by stream",
    hint: "Connected calls per paid stream, and who took them",
    termsShort: "Per-stream queue totals: offered, connected, missed.",
    terms: "Per-stream queue totals inside the range: offered, connected, missed.",
    needs: ["queue"],
    compute({ queueStreams = {}, queueByAgent = {} }) {
      const streams = Object.entries(queueStreams).map(([key, v]) => ({
        stream: key, calls: v.calls || 0, connected: v.connected || 0, missed: v.missed || 0,
        connectRate: v.calls > 0 ? Math.round((v.connected / v.calls) * 1000) / 10 : null,
      })).sort((a, b) => b.connected - a.connected);
      const agents = Object.entries(queueByAgent).map(([agent, byStream]) => ({
        agent, ...byStream, total: Object.values(byStream).reduce((s2, n) => s2 + n, 0),
      })).sort((a, b) => b.total - a.total);
      return { streams, agents };
    },
    renderText(data) {
      const L = ["STREAM".padEnd(22) + "CALLS".padStart(8) + "CONNECTED".padStart(11) + "MISSED".padStart(9) + "CONNECT %".padStart(11)];
      L.push("-".repeat(61));
      for (const r of data.streams) {
        L.push(String(r.stream).padEnd(22) + String(r.calls).padStart(8) + String(r.connected).padStart(11)
          + String(r.missed).padStart(9) + pct(r.connectRate).padStart(11));
      }
      if (data.agents.length) {
        L.push("", "AGENT".padEnd(24) + "CONNECTED");
        L.push("-".repeat(36));
        for (const a of data.agents) L.push(String(a.agent).slice(0, 23).padEnd(24) + String(a.total).padStart(9));
      }
      return L.join("\n");
    },
    csv(data) {
      return { rows: data.streams, columns: [
        { header: "stream", get: (x) => x.stream }, { header: "calls", get: (x) => x.calls },
        { header: "connected", get: (x) => x.connected }, { header: "missed", get: (x) => x.missed },
        { header: "connect_rate", get: (x) => x.connectRate },
      ] };
    },
  },
  {
    id: "worked",
    label: "Work today",
    hint: "Calls received, taken and made, and deals written, per person",
    termsShort: "Calls connected (inbound) and dials placed (outbound).",
    terms: "Calls CONNECTED to an agent (inbound) and dials placed (outbound), inside the range. Missed calls belong to the queue, not a person.",
    // queue carries BOTH sides: MAILER/BCD are inbound calls CONNECTED to an
    // agent, LD is PhoneBurner OUTBOUND dials. Deliberately NOT declaring
    // "dials" as well — readLdDials reads the same DailyDial rows the LD
    // counts come from (verified 2026-07-27: chris_bolt 528, phil_olson 79,
    // bruce_allen 26 identical in both), so using both would double every
    // outbound number.
    // caseContacts is what resolves the officer LIVE for deals whose snapshot
    // has not been written yet. Without it a midday board shows every
    // salesperson on zero deals while "(no snapshot)" holds all of them.
    needs: ["queue", "payments", "caseContacts"],
    compute({ queueByAgent = {}, queueStreams = {}, payments = [], queueUnavailable = null }) {
      const {
        ROLES, canonicalStaffName, isNotAPerson, staffRole,
      } = require("../../shared-config/src/staffRoster");
      const INBOUND = new Set(["MAILER", "BCD"]);
      const by = new Map();
      const row = (name) => {
        if (!by.has(name)) by.set(name, { agent: name, taken: 0, made: 0, deals: 0, dealCases: new Set(), cash: 0 });
        return by.get(name);
      };

      for (const [agent, streams] of Object.entries(queueByAgent)) {
        // A queue answering a call is not a person doing work.
        if (isNotAPerson(agent)) continue;
        const r = row(canonicalStaffName(agent));
        for (const [key, n] of Object.entries(streams || {})) {
          if (INBOUND.has(key)) r.taken += n || 0;
          else r.made += n || 0;
        }
      }

      for (const p of payments.filter((x) => !x.isChargeback && x.paymentType === "initial")) {
        // Someone with deals but no queue activity still belongs on the board;
        // so does someone with calls and no deals. Union, never intersect.
        const r = row(p.officerAtSale
          || (p.attributionSnapshot === "missing" ? "(no snapshot)" : "(unassigned)"));
        r.dealCases.add(`${p.domain}:${p.caseId}`);
        r.deals = r.dealCases.size;                       // sales, not payment rows
        r.cash = round2(r.cash + p.amount);
      }

      // Received vs taken is a QUEUE fact, not a per-agent one: a missed call
      // never reached an agent, so it can only be reported in the total.
      const totals = { received: 0, taken: 0, missed: 0 };
      for (const s of Object.values(queueStreams || {})) {
        totals.received += s.calls || 0;
        totals.taken += s.connected || 0;
        totals.missed += s.missed || 0;
      }

      const all = [...by.values()]
        .map(({ dealCases, ...r }) => ({ ...r, touches: r.taken + r.made, role: staffRole(r.agent) }))
        .filter((r) => r.taken || r.made || r.deals);

      // The sales board ranks the SALES FLOOR only. Ranking the owner or a
      // customer-service rep at zero deals reads as underperformance for work
      // they were never doing - and lands in the owner's inbox saying it.
      const rows = all
        .filter((r) => r.role === ROLES.SALES || r.agent.startsWith("("))
        .sort((a, b) => b.deals - a.deals || b.touches - a.touches);

      // Answering the phone is real work; it is just not selling. Credited by
      // name, never ranked, and never shown with a deals column.
      const alsoAnswering = all
        .filter((r) => r.role === ROLES.CSERV)
        .sort((a, b) => b.touches - a.touches);

      // Owner and management are not staff being measured. Their calls still
      // belong in the queue totals — those are facts about the queue, not
      // about a person — but they are not named in a report telling people
      // their work is seen.
      const offBoard = all.filter((r) => r.role === ROLES.OWNER || r.role === ROLES.MGMT);

      return { rows, alsoAnswering, offBoard, totals, queueUnavailable };
    },
    renderText(data) {
      const { rows, alsoAnswering = [], offBoard = [], totals, queueUnavailable = null } = data;
      // Lead with the gap. A reader who sees the table first has already
      // drawn a conclusion by the time a footnote corrects them.
      const L = queueUnavailable
        ? [`Work — CALL DATA UNAVAILABLE for this range (${queueUnavailable}).`,
          "Deals below are complete; call counts are not measured and show as —.", ""]
        : [`Work today · ${totals.received} call(s) received · ${totals.taken} taken · ${totals.missed} missed`];
      if (!rows.length && !alsoAnswering.length) return L[0] + NEWLINE + "  (nothing recorded yet)";
      L.push("");
      L.push("PERSON".padEnd(20) + "TAKEN".padStart(7) + "MADE".padStart(8) + "DEALS".padStart(7) + "CASH".padStart(13));
      L.push("-".repeat(55));
      const num = (n) => (queueUnavailable ? "—" : String(n));
      for (const r of rows) {
        L.push(String(r.agent).slice(0, 19).padEnd(20) + num(r.taken).padStart(7)
          + num(r.made).padStart(8) + String(r.deals).padStart(7) + money(r.cash).padStart(13));
      }
      const sum = rows.reduce((a, r) => ({
        taken: a.taken + r.taken, made: a.made + r.made, deals: a.deals + r.deals, cash: round2(a.cash + r.cash),
      }), { taken: 0, made: 0, deals: 0, cash: 0 });
      L.push("-".repeat(55));
      L.push("TOTAL".padEnd(20) + num(sum.taken).padStart(7) + num(sum.made).padStart(8)
        + String(sum.deals).padStart(7) + money(sum.cash).padStart(13));
      if (alsoAnswering.length) {
        L.push("", "Also answering (customer service — not on the sales board):");
        for (const r of alsoAnswering) {
          L.push(`  ${r.agent} — ${r.taken} taken${r.made ? `, ${r.made} made` : ""}`);
        }
      }
      if (queueUnavailable) return L.join(NEWLINE);
      if (totals.missed) {
        // Missed calls have no agent, so they belong to the queue, not a person.
        L.push("", `${totals.missed} call(s) rang and were not answered — queue-wide, not attributable to a person.`);
      }
      // Keep the arithmetic honest: if named rows do not account for every
      // connected call, say where the rest went rather than letting the
      // header and the table quietly disagree.
      const named = [...rows, ...alsoAnswering].reduce((a, r) => a + r.taken, 0);
      const unnamed = totals.taken - named;
      if (unnamed > 0) {
        L.push(`${unnamed} taken by ${offBoard.length ? "someone off the sales board" : "an unidentified extension"}`
          + " — counted in the header, not in the table.");
      }
      return L.join(NEWLINE);
    },
    csv(data) {
      const unk = data.queueUnavailable;
      return { rows: data.rows, columns: [
        { header: "person", get: (x) => x.agent },
        // null, not 0 — a spreadsheet will happily sum a zero it was never told
        // to distrust.
        { header: "calls_taken", get: (x) => (unk ? null : x.taken) },
        { header: "calls_made", get: (x) => (unk ? null : x.made) },
        { header: "deals_written", get: (x) => x.deals },
        { header: "cash", get: (x) => x.cash },
      ] };
    },
  },
  {
    id: "pl",
    label: "Profit and loss over time",
    hint: "Cost, money in, net and margin per period",
    termsShort: "Money received per period vs spend booked in that period.",
    terms: "Money RECEIVED in each period against spend BOOKED in that period. Periods are days for a range up to about two months, months beyond that. Margin is (total money x the configured rate) minus cost, in dollars - not a rate of return. A period with no spend shows no ratio rather than an infinite one.",
    needs: ["payments", "spend"],
    compute({ payments = [], spendByDay = {}, from = null, to = null }) {
      const { applyFunctions } = require("./reportOpsService");
      const span = from && to
        ? Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1
        : 1;
      // Days read well up to about two months; past that a daily table is
      // noise and the shape people actually want is monthly.
      const byMonth = span > 62;
      const period = (key) => (byMonth ? String(key).slice(0, 7) : String(key).slice(0, 10));

      const rows = new Map();
      const row = (k) => {
        if (!rows.has(k)) rows.set(k, { period: k, cost: 0, initial: 0, total: 0, deals: 0, cases: new Set() });
        return rows.get(k);
      };
      for (const [day, v] of Object.entries(spendByDay)) {
        row(period(day)).cost = round2(row(period(day)).cost + (v.spend || 0));
      }
      for (const p of payments.filter((x) => !x.isChargeback)) {
        const r = row(period(p.paymentDateKey));
        r.total = round2(r.total + p.amount);
        if (p.paymentType === "initial") {
          r.initial = round2(r.initial + p.amount);
          r.cases.add(`${p.domain}:${p.caseId}`);
          r.deals = r.cases.size;
        }
      }
      return [...rows.values()]
        .map(({ cases, ...r }) => ({
          ...r,
          net: round2(r.total - r.cost),
          ...applyFunctions(r, ["roi", "roas", "costPerAcquisition", "profitMargin"]),
        }))
        .sort((x, y) => String(x.period).localeCompare(String(y.period)));
    },
    renderText(rows) {
      if (!rows.length) return "Profit and loss     (nothing in this range)";
      const { formatFunction } = require("./reportOpsService");
      const L = ["PERIOD".padEnd(12) + "COST".padStart(12) + "NEW $".padStart(12) + "TOTAL $".padStart(13)
        + "NET".padStart(13) + "MARGIN".padStart(13) + "ROI".padStart(9)];
      L.push("-".repeat(84));
      for (const r of rows) {
        L.push(String(r.period).padEnd(12) + money(r.cost).padStart(12) + money(r.initial).padStart(12)
          + money(r.total).padStart(13) + money(r.net).padStart(13)
          + formatFunction("profitMargin", r.profitMargin).padStart(13)
          + formatFunction("roi", r.roi).padStart(9));
      }
      const t = rows.reduce((a, r) => ({
        cost: round2(a.cost + r.cost), initial: round2(a.initial + r.initial),
        total: round2(a.total + r.total), deals: a.deals + r.deals,
      }), { cost: 0, initial: 0, total: 0, deals: 0 });
      const totals = { ...t, net: round2(t.total - t.cost) };
      const fns = require("./reportOpsService").applyFunctions(totals, ["roi", "profitMargin"]);
      L.push("-".repeat(84));
      L.push("TOTAL".padEnd(12) + money(totals.cost).padStart(12) + money(totals.initial).padStart(12)
        + money(totals.total).padStart(13) + money(totals.net).padStart(13)
        + formatFunction("profitMargin", fns.profitMargin).padStart(13)
        + formatFunction("roi", fns.roi).padStart(9));
      return L.join(NEWLINE);
    },
    csv(rows) {
      return { rows, columns: [
        { header: "period", get: (x) => x.period },
        { header: "cost", get: (x) => x.cost },
        { header: "new_cash", get: (x) => x.initial },
        { header: "total_cash", get: (x) => x.total },
        { header: "net", get: (x) => x.net },
        { header: "profit_margin", get: (x) => x.profitMargin },
        { header: "deals", get: (x) => x.deals },
        { header: "roi_pct", get: (x) => x.roi },
        { header: "roas_pct", get: (x) => x.roas },
        { header: "cost_per_acquisition", get: (x) => x.costPerAcquisition },
      ] };
    },
  },
  {
    id: "casework",
    label: "What happened with the cases",
    hint: "Post-dates, DNCs, payment failures and documents received — as case lists",
    termsShort: "Case events inside the range, listed rather than counted.",
    terms: "Case EVENTS that happened inside the range, listed rather than counted. A status change is only counted when the status actually moved - a case re-saved on the same status is not news. Documents are inbound uploads only.",
    // Status movement is the counts; this is the same material as a worklist.
    needs: ["activity", "payments"],
    compute({ events = [], declines = [] }) {
      const lane = () => new Map();
      const lanes = {
        postdate: lane(), dnc: lane(), suspended: lane(), docs: lane(), other: lane(),
      };

      const put = (map, e, extra = {}) => {
        const key = `${e.domain}:${e.caseId}`;
        if (!map.has(key)) {
          map.set(key, {
            domain: e.domain, caseId: e.caseId, count: 0,
            at: e.createdAt ? String(e.createdAt).slice(0, 10) : null,
            by: e.createdBy || null, ...extra,
          });
        }
        const row = map.get(key);
        row.count += 1;
        // Keep the LAST thing that happened — a case moved twice should read
        // as where it ended up, not where it passed through.
        if (extra.to) row.to = extra.to;
        if (e.createdBy) row.by = e.createdBy;
        return row;
      };

      for (const e of events) {
        if (e.kind === "doc-upload") { put(lanes.docs, e); continue; }
        if (e.kind !== "status-change") continue;
        // A case re-saved on the same status is not news.
        if (e.payload?.selfTransition) continue;
        const cls = e.payload?.safetyClass;
        const extra = { to: e.payload?.toStatus || e.payload?.to || null };
        if (cls === "postdate") put(lanes.postdate, e, extra);
        else if (cls === "dnc") put(lanes.dnc, e, extra);
        else if (cls === "suspended") put(lanes.suspended, e, extra);
        else put(lanes.other, e, extra);
      }

      // Failed payments are money events, not status events — a card can
      // bounce without anyone touching the case. Carried here because the
      // question is "what happened to my cases today", not "what did staff do".
      const failed = new Map();
      for (const d of declines) {
        const key = `${d.domain}:${d.caseId}`;
        if (!failed.has(key)) {
          failed.set(key, {
            domain: d.domain, caseId: d.caseId, name: d.name || null,
            count: 0, amount: 0, at: d.paymentDateKey || null,
          });
        }
        const row = failed.get(key);
        row.count += 1;
        row.amount = round2(row.amount + Math.abs(Number(d.amount) || 0));
      }

      const list = (m) => [...m.values()].sort((a, b) => String(a.caseId).localeCompare(String(b.caseId)));
      return {
        postdate: list(lanes.postdate),
        dnc: list(lanes.dnc),
        suspended: list(lanes.suspended),
        failed: [...failed.values()].sort((a, b) => b.amount - a.amount),
        docs: list(lanes.docs),
        other: list(lanes.other),
      };
    },
    renderText(d) {
      const L = [];
      const section = (title, rows, render) => {
        if (!rows.length) return;
        L.push(`${title} (${rows.length})`);
        for (const r of rows.slice(0, 40)) L.push(`  ${render(r)}`);
        if (rows.length > 40) L.push(`  … and ${rows.length - 40} more`);
        L.push("");
      };
      const who = (r) => (r.by ? ` — ${r.by}` : "");
      section("POST-DATED", d.postdate, (r) => `${r.domain} ${r.caseId}${r.to ? `  → ${r.to}` : ""}${who(r)}`);
      section("DO NOT CALL", d.dnc, (r) => `${r.domain} ${r.caseId}${r.to ? `  → ${r.to}` : ""}${who(r)}`);
      section("SUSPENDED / PAYMENT DEFAULT", d.suspended, (r) => `${r.domain} ${r.caseId}${r.to ? `  → ${r.to}` : ""}${who(r)}`);
      section("PAYMENTS THAT FAILED", d.failed,
        (r) => `${r.domain} ${r.caseId}  ${money(r.amount)}  ${r.count} attempt(s)${r.name ? `  ${r.name}` : ""}`);
      section("DOCUMENTS RECEIVED", d.docs, (r) => `${r.domain} ${r.caseId}  ${r.count} file(s)`);
      section("OTHER STATUS MOVES", d.other, (r) => `${r.domain} ${r.caseId}${r.to ? `  → ${r.to}` : ""}${who(r)}`);
      if (!L.length) return "What happened with the cases     (nothing moved in this range)";
      return L.join(NEWLINE).trimEnd();
    },
    csv(d) {
      const rows = [
        ...d.postdate.map((r) => ({ ...r, what: "post-date" })),
        ...d.dnc.map((r) => ({ ...r, what: "dnc" })),
        ...d.suspended.map((r) => ({ ...r, what: "suspended" })),
        ...d.failed.map((r) => ({ ...r, what: "payment failed" })),
        ...d.docs.map((r) => ({ ...r, what: "documents received" })),
        ...d.other.map((r) => ({ ...r, what: "other status move" })),
      ];
      return { rows, columns: [
        { header: "what", get: (x) => x.what },
        { header: "domain", get: (x) => x.domain },
        { header: "case_id", get: (x) => x.caseId },
        { header: "client", get: (x) => x.name ?? null },
        { header: "moved_to", get: (x) => x.to ?? null },
        { header: "amount", get: (x) => x.amount ?? null },
        { header: "count", get: (x) => x.count },
        { header: "by", get: (x) => x.by ?? null },
        { header: "on", get: (x) => x.at },
      ] };
    },
  },
  {
    id: REPORT_SECTION_IDS.LONG_CALLS,
    label: "Calls worth hearing",
    hint: "Every call over 10 minutes, with what came of it",
    termsShort: "Calls at or over the length threshold, inbound and outbound, with what came of them.",
    terms: "Long conversations inside the range, both INBOUND CallRail calls and OUTBOUND PhoneBurner dials on bought leads, with where the case stands now. A call with no outcome is shown as such - it is a long conversation that has not closed, which is the point of listing it.",
    // Mickey 2026-07-31: "the ld calls to hear get mixed into calls to hear.
    // its the same email one just only prints LD related stuff." One section,
    // both directions. A separate LD list made two places to look for the same
    // question — which call do I play next.
    needs: [
      "callsRange", "payments", "caseContacts", "callRecordings", "callContext",
      "dials", "activity", "ldCaseStatus",
    ],
    compute({
      callsRange = [], payments = [], from = null, to = null, callRecordings = {},
      domain = null, callContext = {}, dials = [], events = [], ldCaseStatus = {},
      ldCaseSource = {},
      // Set when CallRail could not be read for part of the lookback. Without
      // it an outage renders as the template's "Nothing in this range." — the
      // single most reassuring sentence the email can print about a broken day.
      callsRangeUnavailable = null,
    }) {
      // THE FILTER IS ON THE INBOUND HALF ONLY. CallRail is ONE TAG tenant of
      // inbound mail-response calls, so a WYNN board must not carry them —
      // measured, it once handed the lead vendor five recordings of OUR mail
      // callers. LD dials are per-case and per-domain, so they travel: on a
      // WYNN board this section is the LD calls and nothing else, which is
      // exactly "the same email, one just only prints LD related stuff".
      const inboundApplies = !domain || String(domain).toUpperCase() === "TAG";
      const MIN_SEC = Math.max(60, Number(process.env.LONG_CALL_SECONDS) || 600);
      // callsRange deliberately reaches BACK 45 days so call-to-close lag is
      // not clipped. THIS report is about the range itself, so the lookback
      // tail must be dropped — otherwise a one-day report lists six weeks of
      // calls (measured: 319 calls back to 2026-06-15 for a single day).
      const inRange = (c) => {
        const d = String(c.dateKey || "").slice(0, 10);
        if (from && d < String(from).slice(0, 10)) return false;
        if (to && d > String(to).slice(0, 10)) return false;
        return true;
      };
      const last10 = (x) => {
        const dd = String(x || "").replace(/\D/g, "");
        return dd.length >= 10 ? dd.slice(-10) : null;
      };

      // Phone -> what became of that person, from payments in the range.
      const outcomeByPhone = new Map();
      for (const p of payments.filter((x) => !x.isChargeback)) {
        for (const ph of [p.phone, ...(p.phones || [])]) {
          const k = last10(ph);
          if (!k) continue;
          const prior = outcomeByPhone.get(k);
          // An initial payment outranks a recurring one: "became a deal" is
          // the more useful answer than "paid something".
          if (!prior || (p.paymentType === "initial" && prior.type !== "initial")) {
            outcomeByPhone.set(k, {
              type: p.paymentType, amount: p.amount, caseId: p.caseId,
              officer: p.officerAtSale || null, on: p.paymentDateKey,
            });
          }
        }
      }

      // ── OUTBOUND HALF: long LD dials, joined to their case ──────────────
      // The case id on the dial is the join. The activity sweep gives the
      // settlement officer, and ldCaseStatus gives where the case stands now,
      // so an outbound row carries the same three facts an inbound one does.
      const LD_SEC = Math.max(60, Number(process.env.LD_LONG_CALL_SECONDS) || 300);
      const { canonicalStaffName } = require("../../shared-config/src/staffRoster");
      const officerOf = new Map();
      for (const e of events) {
        if (!e?.caseId || e.kind !== "assignment") continue;
        const m = String(e.subject || "").match(/^Assigned to\s+Set\.?\s*Officer\s*:\s*(.+)$/i);
        const name = m ? m[1].trim() : null;
        if (name && !/^--\s*Unassigned\s*--$/i.test(name)) {
          officerOf.set(`${String(e.domain || "").toUpperCase()}:${e.caseId}`, name);
        }
      }
      const outbound = [];
      for (const d of dials) {
        for (const a of Array.isArray(d.attempts) ? d.attempts : []) {
          const sec = Number(a.durationSeconds) || 0;
          if (sec < LD_SEC) continue;
          const key = `${String(d.domain || "").toUpperCase()}:${d.caseId}`;
          const seat = a.agentId ? canonicalStaffName(a.agentId) : null;
          outbound.push({
            direction: "outbound",
            dateKey: d.dateKey,
            minutes: Math.round(sec / 6) / 10,
            // The LD campaign the lead was bought on — LD CUSTOM, LD GENERAL,
            // LD Posting. Mickey 2026-07-31: "for the call name you can just
            // say LD Custom ... or the source i suppose." A flat "LD" made
            // every outbound row look identical while inbound rows named their
            // mail piece; both directions now answer "where did this come
            // from". Falls back to "LD" when the campaign is unresolvable, so
            // a row never loses its direction.
            source: ldCaseSource[key] || "LD",
            phone: null,
            outcome: ldCaseStatus[key]
              || (/^dnc$/i.test(String(a.outcome || d.lastOutcome || "")) ? "DNC" : null),
            amount: null,
            caseId: d.caseId ?? null,
            caseDomain: d.domain ? String(d.domain).toUpperCase() : null,
            officer: officerOf.get(key) || seat || null,
            listenUrl: a.persistedRecordingUrl || null,
            priorCalls: null,
          });
        }
      }

      const inbound = !inboundApplies ? [] : callsRange
        .filter(inRange)
        .filter((c) => (Number(c.durationSec) || 0) >= MIN_SEC)
        .map((c) => {
          const hit = outcomeByPhone.get(last10(c.phone));
          // Mickey 2026-07-30: "officer is a ring central leg look up" and
          // "outcome is current logics status."
          //
          // Payments answer neither for an OPEN call, which is most of this
          // list — a conversation that has not closed is exactly the one worth
          // hearing. The RC leg says who answered regardless of outcome, and
          // Logics says where the case actually stands now. Payment data stays
          // as the fallback so a closed call never loses its officer.
          const leg = callContext.byPhone?.[last10(c.phone)] || null;
          const caseId = leg?.caseId || (hit ? hit.caseId : null);
          const caseDomain = leg?.caseDomain || null;
          const status = caseId
            ? callContext.statusByCase?.[`${caseDomain || "TAG"}:${caseId}`] || null
            : null;
          return {
            direction: "inbound",
            dateKey: c.dateKey,
            minutes: Math.round((Number(c.durationSec) || 0) / 6) / 10,
            source: c.source || null,
            phone: c.phone || null,
            caseDomain,
            // Current status first; a payment in-range is still worth saying.
            outcome: status
              || (hit ? (hit.type === "initial" ? "DEAL" : "payment") : "no outcome yet"),
            amount: hit ? hit.amount : null,
            caseId,
            // Settlement officer off the case's assignment activity first —
            // that is who owns it now. The RC leg says who happened to answer,
            // and the payment says who closed it; both are fallbacks.
            officer: (caseId ? callContext.officerByCase?.[`${caseDomain || "TAG"}:${caseId}`] : null)
              || leg?.agent || (hit ? hit.officer : null),
            listenUrl: c.listenUrl || callRecordings[c.callId] || null,
            priorCalls: c.priorCalls ?? null,
          };
        });

      // ONE LIST, longest first. Direction is a column, not a section: the
      // question a reader has is "which call do I play next", and that does
      // not care whether we rang them or they rang us.
      const out = [...inbound, ...outbound].sort((a, b) => b.minutes - a.minutes);
      // compute() owes the composer ROWS, so there is nowhere else to hang a
      // flag — it rides on the array. Only when the inbound half is actually
      // in play: on a vendor board CallRail is excluded by design, and saying
      // "incomplete" there would be false.
      if (inboundApplies && callsRangeUnavailable) out.unavailable = callsRangeUnavailable;
      return out;
    },
    renderText(rows) {
      if (!rows.length && rows.rangeSummary) {
        return `${rows.totalObserved || 0} long call(s) observed Â· ${rows.over30Minutes || 0} at least 30 minutes`
          + ` Â· ${rows.withRecording || 0} with recording evidence Â· no retained review rows`;
      }
      if (!rows.length) return "Calls worth hearing     (none over the threshold)";
      const deals = rows.filter((r) => r.outcome === "DEAL").length;
      const L = [rows.rangeSummary
        ? `${rows.totalObserved || 0} long call(s) observed · ${rows.over30Minutes || 0} at least 30 minutes · showing up to ${rows.topPerAgent || 5} longest recording(s) per agent`
        : `${rows.length} call(s) over 10 minutes · ${deals} became a deal`, ""];
      L.push("WHEN".padEnd(12) + "MINS".padStart(6) + "  " + "SOURCE".padEnd(30) + "OUTCOME".padEnd(16) + "AMOUNT".padStart(11));
      L.push("-".repeat(77));
      for (const r of rows.slice(0, 40)) {
        L.push(String(r.dateKey).padEnd(12) + String(r.minutes).padStart(6) + "  "
          + String(r.source || "—").slice(0, 29).padEnd(30)
          + String(r.outcome).padEnd(16)
          + (r.amount != null ? money(r.amount) : "—").padStart(11));
        if (r.listenUrl) L.push(`      ${r.listenUrl}`);
      }
      if (rows.length > 40) L.push(`… and ${rows.length - 40} more`);
      return L.join(NEWLINE);
    },
    csv(rows) {
      // ── A LISTEN LIST YOU CANNOT LISTEN TO IS NOT A LIST ────────────────
      //
      // Mickey 2026-08-03: "i kinda wanna do a filter if we dont have a url
      // dont include in calls to listen to."
      //
      // The section exists to press play. A row with no link costs a line and
      // offers nothing to do, and right now most rows are linkless: recording
      // capture only began 2026-08-03T20:57:45Z, so every earlier call has
      // none and never will.
      //
      // BUT THE COUNT IS NOT DISCARDED. Silently dropping them would make a
      // day where recordings failed look identical to a quiet day — the exact
      // confusion the rest of this stack keeps being bitten by. The excluded
      // count is reported, and every row still reaches the CSV.
      const listenable = (Array.isArray(rows) ? rows : []).filter((r) => r.listenUrl);
      const withoutLink = (Array.isArray(rows) ? rows.length : 0) - listenable.length;

      return {
        // Normally no summary — but an unreadable CallRail has to say so, or
        // the template prints "Nothing in this range." over a hole.
        summary: rows.rangeSummary
          ? `${rows.totalObserved || 0} long call(s) observed · ${rows.over30Minutes || 0} at least 30 minutes · ${rows.withRecording || 0} with recordings · showing up to ${rows.topPerAgent || 5} longest per agent`
          : rows.unavailable
          ? `INBOUND CALLS INCOMPLETE — ${rows.unavailable}. Outbound LD calls below are complete.`
          : (withoutLink
            ? `${withoutLink} long call${withoutLink === 1 ? "" : "s"} not listed — no recording (capture began 2026-08-03)`
            : undefined),
        emailRows: listenable,
        // No summary: the section label already says "Calls worth hearing",
        // and a line under it repeating the count is filler.
        // The point of this section is to press play. Minutes, who, and the
        // link — everything else is CSV.
        // Mickey 2026-07-30: "get rid of length ... you can put the settlement
        // officer ... then just call agent link outcome." Length was the one
        // column that never changed a decision.
        // `call` identifies WHERE the call came from, one rule for both
        // directions: the mail piece someone rang in on, or the LD campaign
        // the lead was bought on. Mickey 2026-07-31: "you can just say LD
        // Custom ... or the source i suppose." The case id was tried here
        // first and read as noise — every LD campaign name already begins
        // with LD, so direction survives without spelling it out, and the
        // case id is still a column in the CSV.
        emailColumns: [
          { header: "call", get: (x) => x.source },
          { header: "agent", get: (x) => x.officer },
          { header: "outcome", get: (x) => x.outcome },
          { header: "listen", get: (x) => x.listenUrl },
        ],
        rows,
        columns: [
          { header: "on", get: (x) => x.dateKey },
          { header: "minutes", get: (x) => x.minutes },
          { header: "source", get: (x) => x.source },
          { header: "outcome", get: (x) => x.outcome },
          { header: "amount", get: (x) => x.amount },
          { header: "case_id", get: (x) => x.caseId },
          { header: "officer", get: (x) => x.officer },
          { header: "prior_calls", get: (x) => x.priorCalls },
          { header: "listen", get: (x) => x.listenUrl },
        ],
      };
    },
  },
];

// Every source name a block may declare. gatherMaterial keys its gathers on
// exactly these strings, so a typo here is not a typo — it means the gather
// never runs and the block renders a confident, EMPTY table. That has now
// happened three times (recordings needing payments; "money" as both a block
// and a preset; "events" instead of "activity"), so it fails at load instead.
const SOURCES = Object.freeze([
  "payments", "activity", "spend", "calls", "queue",
  "recordings", "dials", "postdateBilling", "callsRange", "caseContacts",
  // LD leads as the cadence RECEIVED them, not as the vendor invoiced them.
  "ldLeads",
  // Who answered a long call (RingCentral leg, from our CallLog mirror) and
  // where that case stands NOW (Logics, pulled live — status is state).
  "callContext",
  // Current Logics status for cases with a long OUTBOUND dial. The LD mirror
  // of callContext: a dial already carries its case id, so no phone hop.
  //
  // This gather also fills `ldCaseSource` (the LD campaign per case) off the
  // SAME getCaseInfo response. It is deliberately NOT a source of its own —
  // declaring it would key a second gather on it and pay for the case pull
  // twice. Ask for `ldCaseStatus` and both maps arrive.
  "ldCaseStatus",
  // Recording links for the calls a report actually lists. CallRail hands
  // these out ONE CALL AT A TIME, so this is a separate, bounded gather rather
  // than a field on callsRange — which is why every long-call row shipped with
  // no listen link at all.
  "callRecordings",
]);

for (const b of BLOCKS) {
  const bad = (b.needs || []).filter((n) => !SOURCES.includes(n));
  if (bad.length) {
    throw new Error(
      `report block "${b.id}" declares unknown source(s) ${bad.join(", ")} — `
      + `valid sources: ${SOURCES.join(", ")}`,
    );
  }
}

const BY_ID = new Map(BLOCKS.map((b) => [b.id, b]));

/** Presets — a named tick-set, so common asks stay one word. */
// Preset names must never collide with a block id — "money" as both meant
// ticking one box silently expanded to three.
const PRESETS = Object.freeze({
  // THE NIGHT BOARD. Mickey 2026-07-28: "the night board can be very basic
  // unless we add to it. so how much spent what money made and where from.
  // and then you can add stuff to it." Four blocks answer exactly that, and
  // adding to it is now editing a saved definition rather than editing code.
  board: ["spend", "money", "net", "source"],
  // THE NIGHTLY SHAPE — Mickey 2026-07-30, in order:
  // "so its top line / per source break down / per agent break down / call links"
  // Status movement rides in BOTH nightly emails — Mickey 2026-07-30: "we also
  // need status changes in both emails dnc, etc." DNC and post-dates are what
  // the floor has to act on tomorrow morning.
  // Mickey 2026-07-30: "its the same 4 sections for both email just one is
  // filtered." Top line carries the money AND the status counts; by source is
  // named active pieces only; call quality is LD; status movement is the chase
  // list; then the calls. `worked` is gone — it and LD call quality were
  // reporting the same dials twice.
  rollup: [...ROLLUP_SECTION_IDS],
  // The 1pm nudge and the same lines again in the EOD roll-up.
  worklog: ["worked"],
  daily: ["money", "spend", "net", "source", "officer", "status", "recordings"],
  financials: ["money", "spend", "net", "declines"],
  marketing: ["source", "spend", "net"],
  people: ["officer", "effort", "streams"],
  health: ["cohort", "money"],
  pipeline: ["postdates", "declines", "lag"],
  // The three Mickey named on 2026-07-29.
  "roi-by-source": ["source"],
  "officer-performance": ["officer", "worked"],
  "profit-loss": ["pl", "money", "spend"],
  // What the lead VENDOR sees: their sources and what those produced. No mail
  // spend, no officer detail, no company P/L. Pair with --where source=LD.
  // Mickey 2026-07-30: "vendor is call quality, and top line." What the LEAD
  // VENDOR sees about the leads they sold us — how those calls actually went,
  // what moved, and the day-level totals. Deliberately no per-source ROI table
  // and no officer breakdown: that is our P/L, not theirs.
  "vendor-ld": [...ROLLUP_SECTION_IDS],
  // "heres every call over 10 minutes and its outcome"
  "long-calls": [REPORT_SECTION_IDS.LONG_CALLS],
});

function resolveSelection(selection) {
  const raw = Array.isArray(selection) ? selection : String(selection || "daily").split(",");
  const ids = [];
  for (const item of raw.map((x) => String(x).trim()).filter(Boolean)) {
    // A block id ALWAYS wins over a preset of the same name — the specific
    // thing you ticked must not silently become a bundle.
    if (BY_ID.has(item)) ids.push(item);
    else if (PRESETS[item]) ids.push(...PRESETS[item]);
    else ids.push(item);
  }
  const seen = new Set();
  const blocks = [];
  const unknown = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (BY_ID.has(id)) blocks.push(BY_ID.get(id));
    else unknown.push(id);
  }
  return { blocks, unknown };
}

/** The union of raw material the ticked blocks require. */
function neededSources(blocks) {
  const needs = new Set();
  for (const b of blocks) for (const n of b.needs) needs.add(n);
  return [...needs];
}

module.exports = { BLOCKS, BY_ID, PRESETS, SOURCES, neededSources, resolveSelection };
