"use strict";

// THE COMPOSER — tick blocks, pick a range, get an output.
//
// Everything expensive happens here ONCE. The blocks declare what raw
// material they need; the composer takes the union and gathers only that.
// Tick five blocks that all read payments and you pay for one gather.
//
// Live by default (faceplate thesis): the material comes from the
// authoritative services. Spend / call stats / dials come from Mongo
// because that is where those facts ORIGINATE — the mail-sheet sync,
// CallRail's daily sync, PhoneBurner callback capture — not because we
// keep a copy of somebody else's numbers.

const { resolveSelection, neededSources } = require("./reportBlocksService");

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Merge the two sources of mail spend WITHOUT double-counting.
 *
 * Mail cost can come from the hand-kept spend sheet or from MailSpendDay rows
 * derived from the vendor's invoice. Summing both doubles the day's mail cost
 * and halves ROAS, so they are merged as a SET PARTITION: for any day an
 * invoice covers, the sheet's mail rows are removed and the invoice's rows
 * stand in their place. Everything else on that day is untouched.
 *
 * Whole-day, not per-source, and that is deliberate. A per-source merge needs
 * both sides to agree on source naming, and any disagreement leaks a PARTIAL
 * double-count — which sums to something plausible and so goes unnoticed. "Is
 * this day invoiced?" is a question with an answer.
 *
 * Extracted from gatherMaterial so the no-double-count invariant is testable
 * without a database. It is pure on purpose.
 */
function partitionMailSpend({ sheetRows = [], derivedMail = [] } = {}) {
  const invoiceDays = new Set(derivedMail.map((r) => r.serviceDate));
  // Lower-cased: the sheet is hand-typed, and a row spelled "Mailer" on an
  // invoiced day must still be displaced or it double-counts.
  const isMailer = (r) => String(r.channel || "").toLowerCase() === "mailer";
  const onInvoiceDay = (r) => isMailer(r) && invoiceDays.has(String(r.date || "").slice(0, 10));

  return {
    supersededSheetRows: sheetRows.filter(onInvoiceDay),
    rows: [
      ...sheetRows.filter((r) => !onInvoiceDay(r)),
      ...derivedMail.map((r) => ({
        date: r.serviceDate,
        channel: "mailer",
        source: r.source,
        spend: r.spend,
        pieces: r.pieces,
        // `cost` is what the night board sums into its POSTAGE sub-total.
        // Without it, an invoiced day would report the right total over a $0
        // postage line — a discrepancy that reads as a parsing failure.
        cost: r.postage ?? 0,
        leadsReported: 0,
      })),
    ],
  };
}
// Module-level so gather-time notes can quote money the same way the renderers
// do — a note reading "1234.5" next to a table reading "$1,234.50" invites the
// reader to wonder whether they are the same number.
const usd = (n) => `$${Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Day-scoped gathers (queue, recordings, callsRange) must LOOP or REJECT
// over a range — never silently report the last day as if it were the whole
// window, which is what the composer did before.
const RANGE_DAY_LOOP_MAX = Math.max(1, Number(process.env.RANGE_DAY_LOOP_MAX) || 31);

// The queue gather is RingCentral-backed and PAGED, so a day-loop is
// days x pages of requests. Mickey 2026-07-27: "absolutely do not re auth
// every time for rc thats a great way to get 100000 429s in 30 seconds...
// ring central is always a fall back or targeted slow trickle." Hence a
// much lower day cap than the CallRail/Mongo gathers, plus a pause between
// days. Refuse the range rather than trickle for a month.
const QUEUE_DAY_LOOP_MAX = Math.max(1, Number(process.env.QUEUE_DAY_LOOP_MAX) || 7);
const QUEUE_DAY_PAUSE_MS = Math.max(0, Number(process.env.QUEUE_DAY_PAUSE_MS) || 300);
// One Logics call per case without a stored phone. Bounded by DEALS, not by
// days, so a month is ~33. Refuse rather than grind if a filter is missing.
const CASE_CONTACT_MAX = Math.max(1, Number(process.env.CASE_CONTACT_MAX) || 400);
const CALLS_LOOKBACK_DAYS = Math.max(0, Number(process.env.CALLS_LOOKBACK_DAYS) || 45);
// Live case-status lookups for long LD dials, one Logics call each. A day holds
// a handful; a wide range can hold hundreds, and a report is not worth a
// thousand API calls. Over the cap the section says so rather than truncating.
const LD_STATUS_MAX = Math.max(0, Number(process.env.LD_STATUS_MAX) || 120);
const CALLS_DAY_MAX = Math.max(1, Number(process.env.CALLS_DAY_MAX) || 120);

function addDaysKey(key, delta) {
  return new Date(Date.parse(`${key}T00:00:00Z`) + delta * 86400000).toISOString().slice(0, 10);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dayRange(from, to) {
  const days = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86400000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

// ── FILTERS ─────────────────────────────────────────────────────────────
// Mickey 2026-07-28: "how much money did we make from cases generated in
// 2024 in march of 2026. how many 10 minute plus calls didnt turn into
// deals from LD leads."
//
// Both are the same shape: SLICE the material, then measure it. So filters
// are orthogonal to blocks — they narrow what every ticked calculation sees,
// rather than each block growing its own options.
//
//   cohort=2024      cases that became clients that year (first payment)
//   source=LD        source at sale (prefix match, so LD covers LD CUSTOM*)
//   officer="X"      officer at sale
//   domain=TAG       tenant
//   minutes>10       call length (recordings)
//   outcome=no-deal  call did NOT become a deal (recordings)
const FILTER_KEYS = [
  // Mickey 2026-07-29: "i wanna know about this agent, i wanna know about
  // this extension, i wanna know about this lead source". An extension is a
  // property of a PERSON, so it resolves to that person before filtering.
  "extension","cohort", "source", "officer", "domain", "minutes", "outcome"];

function parseFilters(input) {
  // Accepts { cohort: "2024" } or ["cohort=2024", "minutes>10"].
  const out = [];
  const push = (key, op, value) => {
    const k = String(key || "").trim().toLowerCase();
    if (!FILTER_KEYS.includes(k)) return { unknown: k };
    out.push({ key: k, op, value: String(value).trim() });
    return null;
  };
  const unknown = [];
  const items = Array.isArray(input) ? input
    : input && typeof input === "object" ? Object.entries(input).map(([k, v]) => `${k}=${v}`)
      : String(input || "").split(",").filter(Boolean);
  for (const raw of items) {
    const m = String(raw).match(/^\s*([a-z]+)\s*(>=|<=|!=|>|<|=)\s*(.+?)\s*$/i);
    if (!m) { unknown.push(String(raw)); continue; }
    const bad = push(m[1], m[2], m[3]);
    if (bad) unknown.push(bad.unknown);
  }
  return { filters: out, unknown };
}

const cohortOf = (p) => String(p.metricsTreatment?.firstPaidDateKey || p.paymentDateKey || "").slice(0, 4);

function matchOne(value, op, target) {
  const v = value == null ? "" : String(value);
  const t = String(target);
  const numeric = Number(v);
  const numTarget = Number(t);
  const bothNumeric = Number.isFinite(numeric) && Number.isFinite(numTarget);
  switch (op) {
    case ">": return bothNumeric && numeric > numTarget;
    case "<": return bothNumeric && numeric < numTarget;
    case ">=": return bothNumeric && numeric >= numTarget;
    case "<=": return bothNumeric && numeric <= numTarget;
    case "!=": return v.toLowerCase() !== t.toLowerCase();
    default:
      // Prefix match so `source=LD` catches LD CUSTOM / LD CUSTOM 2 without
      // the caller having to know the feed names.
      return v.toLowerCase() === t.toLowerCase() || v.toLowerCase().startsWith(t.toLowerCase());
  }
}

function filterPayments(payments = [], filters = []) {
  const applicable = filters.filter((f) => ["cohort", "source", "officer", "domain"].includes(f.key));
  if (!applicable.length) return payments;
  return payments.filter((p) => applicable.every((f) => {
    if (f.key === "cohort") return matchOne(cohortOf(p), f.op, f.value);
    if (f.key === "source") return matchOne(p.sourceAtSale, f.op, f.value);
    if (f.key === "officer") return matchOne(p.officerAtSale, f.op, f.value);
    return matchOne(p.domain, f.op, f.value);
  }));
}

/**
 * An officer filter has to reach the QUEUE too.
 *
 * Filtering payments alone produced a report headed "officer=Bruce" that
 * showed Bruce's three deals beside every other officer's call counts — the
 * slice looked applied and was not. A filter must cut the whole material or
 * it is lying about its own scope.
 */
function filterQueueByAgent(queueByAgent = {}, filters = []) {
  const applicable = filters.filter((f) => f.key === "officer");
  if (!applicable.length) return queueByAgent;
  const { canonicalStaffName } = require("../../shared-config/src/staffRoster");
  const out = {};
  for (const [agent, streams] of Object.entries(queueByAgent)) {
    const name = canonicalStaffName(agent);
    if (applicable.every((f) => matchOne(name, f.op, f.value))) out[agent] = streams;
  }
  return out;
}

function filterRecordings(recordings = [], filters = []) {
  const applicable = filters.filter((f) => ["minutes", "outcome", "source", "officer"].includes(f.key));
  if (!applicable.length) return recordings;
  return recordings.filter((c) => applicable.every((f) => {
    if (f.key === "minutes") return matchOne(c.minutes, f.op, f.value);
    if (f.key === "outcome") {
      const converted = Boolean(c.reasons?.includes("DEAL"));
      const want = String(f.value).toLowerCase();
      const isDeal = want === "deal" || want === "converted";
      return f.op === "!=" ? converted !== isDeal : converted === isDeal;
    }
    if (f.key === "source") return matchOne(c.source, f.op, f.value);
    return matchOne(c.officer, f.op, f.value);
  }));
}

/** Gather exactly the raw material the ticked blocks asked for. */
async function gatherMaterial({
  needs, from, to, domain = null, live = true, logger = null, session = null,
}) {
  const want = new Set(needs);
  // `domain` travels WITH the material so a block can scope itself. Without it
  // a tenant-scoped report still rendered cross-tenant channel figures — a WYNN
  // vendor board carried TAG's mail spend against WYNN's revenue.
  const material = { from, to, domain: domain ? String(domain).toUpperCase() : null };
  const notes = [];

  // ── A FAILURE IS NOT A NOTE ──────────────────────────────────────────────
  //
  // This distinction is the whole reason a nightly email went out for weeks
  // with nothing in it. Every degraded gather already pushed a `note`, and the
  // ruling that notes are operator telemetry — snapshot coverage, feed syncs,
  // catch-all counts — and do not belong in the mail was CORRECT. But the same
  // array also carried "the response feed did not refresh", and that is not
  // telemetry: it means a number below is MISSING rather than zero. Dropping
  // notes from the email dropped both, so a total outage rendered as a quiet
  // day and looked perfectly normal.
  //
  // So there are two channels. `notes` is everything, for the CLI and the CSV.
  // `failures` is only "a source did not answer" — it reaches the email as a
  // banner above the numbers. Push to failures ONLY when a reader would draw a
  // wrong conclusion from what is printed below it.
  //
  // Deliberately NOT failures: a cap we chose to stop at, a tenant-scoping
  // omission, or a count of rows that legitimately had no snapshot. Those are
  // us working as designed. A banner that cries every night is a banner nobody
  // reads, and then this whole mechanism is back to where it started.
  // TWO KINDS OF "the numbers below are not what they look like".
  //
  // `failures` is PLUMBING: a service we call did not answer. It is abnormal,
  // it is ours to fix, and it marks the subject line [DEGRADED].
  //
  // `advisories` is A LIMIT WE CHOSE — a cap that stopped us fetching, so some
  // rows below are missing a FIELD (a listen link, a case status) while the row
  // itself is sound. The reader needs to know why a column is blank; nothing is
  // broken and nobody needs paging.
  //
  // The line between them is "would I want to be told at 8pm on a Friday". An
  // empty spend sheet is a failure and not an advisory, because Mickey fills it
  // in by 20:00 — so at 20:00 it means something did not happen, and ROAS is
  // the headline number of the whole board computed against it.
  //
  // Both reach the reader. Only failures are an alarm, and only failures put
  // [DEGRADED] on the subject line — a word that appears every night is a word
  // that stops being read, which is exactly how the original silent-zero
  // incident stayed invisible for weeks.
  const failures = [];
  const advisories = [];
  const fail = (message) => { notes.push(message); failures.push(message); return message; };
  const advise = (message) => { notes.push(message); advisories.push(message); return message; };

  // ── THE TENANT RULE, ONCE ────────────────────────────────────────────────
  //
  // Mickey 2026-07-31: "i mean this for the entire email basically gotta solve
  // that issue." Three of our channels are single-tenant and live under TAG:
  // the mail pieces (and BCD, which is bought against them), the CallRail
  // account, and the RingCentral inbound queue. A report scoped to any other
  // tenant must not carry any of them.
  //
  // That rule already existed — inside the `topline` block — and stopped
  // there, which is precisely how the leak survived: the top line of a WYNN
  // vendor board correctly read "$507 spent (LD only)" while the By source
  // table underneath it listed $2,255 of OUR mail spend, and Calls by agent
  // credited WYNN's board with TAG's inbound calls. A per-block rule gets
  // copied into two blocks out of four.
  //
  // So it lives HERE, on the gather, and every block inherits it for free:
  // there is no version of a WYNN board where the mail spend is merely hidden
  // but still summed somewhere. The material simply does not contain it.
  const MAIL_TENANT = "TAG";
  const scopedTenant = domain ? String(domain).toUpperCase() : null;
  const mailApplies = !scopedTenant || scopedTenant === MAIL_TENANT;
  // Channels the mail tenant owns. LD is deliberately absent — leads are
  // bought per case and per domain, so LD spend belongs to whichever board.
  const MAIL_TENANT_CHANNELS = new Set(["mailer", "bcd"]);
  // ONE session for the whole report: activity pulled for payments is the
  // same activity the recordings / postdate / lag steps want, and without
  // this they each paid for it separately.
  const gatherSession = session || (() => {
    const { createGatherSession } = require("./gatherSessionService");
    return createGatherSession({ logger });
  })();
  material.session = gatherSession;

  // ── payments + activity: ONE live gather serves both ──
  if (want.has("payments") || want.has("activity")) {
    if (live) {
      const { gatherRange } = require("./liveGatherService");
      const domains = domain ? [String(domain).toUpperCase()] : ["TAG", "WYNN", "AMITY"];
      const g = await gatherRange({ from, to, domains, logger, session: gatherSession });
      // SUCCESS-ONLY, matching the cached branch exactly. The live gather
      // returns every history row INCLUDING declines; letting those through
      // inflated live cash while the cached path filtered them out, so the
      // same question answered two different ways. Declines are not
      // discarded — they become their own material key for the redline
      // blocks that actually want them.
      material.payments = g.payments.filter((p) => p.transactionStatus === "SUCCESS");
      material.declines = g.payments.filter((p) => p.transactionStatus === "DECLINED");
      // Attribution is the ONE fact a live re-pull cannot reconstruct: Logics
      // returns who owns the case TODAY, not who closed it. reportingService
      // already solved this for the officer report; the builder must use the
      // same snapshot or it prints "(unassigned)" over attributed money.
      try {
        const { enrichAttribution } = require("./reportingService");
        material.payments = await enrichAttribution(material.payments);
        material.declines = await enrichAttribution(material.declines);
        const missing = material.payments.filter((x) => x.attributionSnapshot === "missing").length;
        if (missing) notes.push(`${missing} payment(s) have no attribution snapshot yet — shown as (no snapshot), not (unassigned)`);
      } catch (error) {
        fail(`attribution snapshots unavailable — ${String(error.message).slice(0, 70)}`);
      }
      material.events = g.activity.events;
      material.gathered = {
        activityRows: g.activity.rows, casesConfirmed: g.totals.casesConfirmed,
        durationMs: g.durationMs, unconfirmed: g.unconfirmed.length,
      };
      // A per-domain gather error means the money numbers below are
      // INCOMPLETE, not low. This is the one that has to reach the reader.
      for (const e of g.errors) fail(String(e));
      // (Attribution enrichment happens once, above, immediately after the
      // SUCCESS split — it covers declines too and records why a row has no
      // snapshot. A second pass here re-queried PaymentTruth for the same
      // ids and threw the answer away.)
    } else {
      const { PaymentTruth, ActivityEvent } = require("../../shared-models/src");
      const f = { paymentDateKey: { $gte: from, $lte: to }, transactionStatus: "SUCCESS", supersededAt: null };
    const declineFilter = { ...f, transactionStatus: "DECLINED" };
      if (domain) f.domain = String(domain).toUpperCase();
      material.payments = await PaymentTruth.find(f).lean();
      // The cache stores declines too; expose them the same way so a block
      // sees an identical material shape in both modes.
      material.declines = await PaymentTruth.find(declineFilter).lean().catch(() => []);
      material.events = await ActivityEvent.find({ dateKey: { $gte: from, $lte: to } }).lean();
      material.gathered = { cached: true };
    }
  }

  // ── spend: originates with us (mail-sheet sync + BCD pay-per-call) ──
  if (want.has("spend") || want.has("source")) {
    const SpendEntry = require("../../shared-models/src/SpendEntry");
    const DailyCallStat = require("../../shared-models/src/DailyCallStat");
    const MailSpendDay = require("../../shared-models/src/MailSpendDay");
    const allRows = await SpendEntry.find({ date: { $gte: from, $lte: to }, active: { $ne: false } })
      .select("date channel source spend cost pieces leadsReported").lean();
    // Drop the mail tenant's channels on a board that is not its own. Dropped
    // here rather than at render so nothing downstream can re-sum them into a
    // total — see THE TENANT RULE above.
    const sheetRows = mailApplies
      ? allRows
      : allRows.filter((r) => !MAIL_TENANT_CHANNELS.has(String(r.channel || "").toLowerCase()));
    if (!mailApplies && sheetRows.length !== allRows.length) {
      notes.push(`${allRows.length - sheetRows.length} mail/BCD spend row(s) omitted — they belong to ${MAIL_TENANT}, not ${scopedTenant}`);
    }

    // ── THE SHEET, READ LIVE, WHEN SpendEntry HAS NO MAIL ────────────────
    //
    // Mickey 2026-08-03: "just read the csv if we have no email at 7:50".
    //
    // The vendor does one or the other on a given day — invoice OR sheet, not
    // reliably both. SpendEntry is the sheet's PERSISTED form, written by the
    // nightly spend sync.
    //
    // CORRECTED 2026-08-04: this comment previously said that sync was
    // Manual+Stopped and had written nothing since 07-30. WRONG — it wrote
    // 08-03 rows at 19:45:27 that night. Do NOT treat spendSyncService or
    // SpendEntry as dead on the strength of it.
    //
    // Reading the CSV here still matters because the sync runs at NIGHT: a
    // board built before it has run, or on a day it half-finished, would
    // otherwise report a blank or partial day.
    //
    // Only when SpendEntry has nothing — a live row is already the same sheet,
    // and reading both would duplicate the day. The INVOICE still wins any day
    // it covers; partitionMailSpend below decides that, not this.
    // PER DAY, not per range. The first version skipped the CSV entirely when
    // ANY mailer row existed anywhere in the range — so a week containing one
    // persisted day silently dropped every CSV-only day after it. Measured on
    // 2026-07-30..08-03: the range reported $3,694.52 and omitted 08-03's
    // $1,584.48, which would understate every weekly and monthly mail figure.
    if (mailApplies) {
      const persistedMailDays = new Set(
        sheetRows
          .filter((r) => String(r.channel || "").toLowerCase() === "mailer")
          .map((r) => String(r.date || "").slice(0, 10))
          .filter(Boolean),
      );
      try {
        const { readMailSheetCsv } = require("./mailSheetCsvService");
        const csv = await readMailSheetCsv({ from, to });
        if (csv.unavailable) {
          // ALWAYS say it. The previous test — "no CSV days AND something is
          // persisted" — degenerated when the sheet was unreachable, because
          // csv.days is then always empty: any range containing ONE persisted
          // day silenced the warning entirely. Measured with the sheet 401ing
          // over 07-27..08-03: mail reported $12,628.89 against a true
          // $14,213.37, with no note, no advisory and no failure. The warning
          // vanished precisely when it mattered most.
          advise(`mail sheet not read — ${csv.unavailable}`);
        } else {
          // THE CSV IS THE SHEET, READ NOW. SpendEntry is a CACHED COPY of the
          // same sheet, written by the nightly sync — so where the two differ
          // the live read is the newer of two views of one source, and a day
          // the sync has not reached yet (or only half-finished) must not be
          // frozen blank or partial. Where both are present they AGREE: 08-03
          // read $1,584.48 from each.
          //
          // Gating on "does this day have ANY persisted row" did exactly that:
          // with one of 08-03's three jobs persisted, the day reported $537.46
          // instead of $1,584.48 and said nothing. That is live-reachable
          // right now, because the sync stopped mid-flight.
          //
          // So a day the CSV covers is taken FROM the CSV, and its persisted
          // rows are dropped rather than merged. Invoices still outrank both —
          // partitionMailSpend displaces whatever the sheet said on any day an
          // invoice covers.
          const csvDays = new Set(csv.rows.map((r) => r.date));
          const displaced = [];
          for (let i = sheetRows.length - 1; i >= 0; i -= 1) {
            const r = sheetRows[i];
            if (String(r.channel || "").toLowerCase() !== "mailer") continue;
            if (!csvDays.has(String(r.date || "").slice(0, 10))) continue;
            displaced.push(sheetRows[i]);
            sheetRows.splice(i, 1);
          }
          if (csv.rows.length) {
            sheetRows.push(...csv.rows);
            const days = [...csvDays].sort();
            notes.push(displaced.length
              ? `mail spend read live from the sheet for ${days.join(", ")} — ${displaced.length} persisted row(s) superseded by the live read`
              : `mail spend read live from the sheet for ${days.join(", ")}`);
          }
          // A day with persisted rows the live sheet no longer shows is a
          // finding, not a tidy-up: the vendor removed or moved a drop.
          const orphanDays = [...persistedMailDays].filter((d) => !csvDays.has(d) && d >= from && d <= to);
          if (orphanDays.length && csv.rows.length) {
            notes.push(`${orphanDays.length} day(s) have persisted mail rows the live sheet no longer lists: ${orphanDays.sort().join(", ")}`);
          }
        }
      } catch (error) {
        advise(`mail sheet not read — ${String(error.message).slice(0, 110)}`);
      }
    }

    // ── MAIL SPEND: THE INVOICE WINS THE WHOLE DAY ────────────────────────
    //
    // Mail cost can now come from two places: the hand-kept spend sheet, and
    // MailSpendDay rows derived from the vendor's own invoice. Summing both
    // would DOUBLE the day's mail cost and halve ROAS, so they are merged as a
    // SET PARTITION rather than added: for any day an invoice covers, the
    // sheet's mail rows are removed and the invoice's rows stand in their
    // place. Every other row on that day — LD, anything else — is untouched.
    //
    // Whole-day, not per-source, and that is the point. A per-source merge
    // would need the two sides to agree on source naming, and any disagreement
    // would leak a partial double-count that sums to something plausible. A
    // day is either invoiced or it is not, which is a question with an answer.
    //
    // The invoice wins because it is what the vendor actually billed; the sheet
    // is someone typing that number in later. When both exist they should
    // agree, and where they do not, saying so is more useful than averaging —
    // hence the drift note below rather than a silent correction.
    const derivedMail = !mailApplies ? [] : await MailSpendDay.find({
      domain: MAIL_TENANT, serviceDate: { $gte: from, $lte: to }, active: true,
    }).select("serviceDate source spend pieces postage invoiceNumber invoiceGrandTotal").lean();

    const { rows, supersededSheetRows } = partitionMailSpend({ sheetRows, derivedMail });

    if (supersededSheetRows.length) {
      const sheetTotal = round2(supersededSheetRows.reduce((s, r) => s + Number(r.spend || 0), 0));
      // Compare LIKE FOR LIKE: only the invoice money for the days whose sheet
      // rows were actually set aside. `invoiceDays` lives inside
      // partitionMailSpend and was referenced here after that extraction — a
      // ReferenceError that killed the WHOLE gather, and with it the 8pm
      // email, on any day carrying both an invoice and sheet rows. It never
      // fired only because the single invoice we hold (07-31) landed on the
      // one business day the sheet skipped.
      const supersededDays = new Set(
        supersededSheetRows.map((r) => String(r.date || "").slice(0, 10)).filter(Boolean),
      );
      const invoiceTotal = round2(derivedMail
        .filter((r) => supersededDays.has(String(r.serviceDate || "").slice(0, 10)))
        .reduce((s, r) => s + Number(r.spend || 0), 0));
      material.mailSheetSpend = sheetTotal;
      if (Math.abs(sheetTotal - invoiceTotal) >= 0.01) {
        // Both sources spoke and disagreed. The invoice is used; the gap is
        // named rather than averaged away, because a persistent gap means the
        // sheet is being typed from something other than the invoice.
        advise(`mail spend: the INVOICE ($${invoiceTotal}) is being used and the spend sheet ($${sheetTotal}) was set aside for the same day(s) — they disagree by $${round2(Math.abs(sheetTotal - invoiceTotal))}`);
      } else {
        notes.push(`mail spend taken from the invoice ($${invoiceTotal}); the sheet agreed and was set aside`);
      }
    }
    // BCD — calls x $4, any version of the piece. `channel: "bcd"` alone found
    // only the LEGACY row, so the board read 0 once the vendor moved to
    // "BCD V3". See bcdCallsService: it also handles the changeover days where
    // both rows exist and a naive match would double-count.
    const { readBcdCalls } = require("./bcdCallsService");
    const bcdRead = !mailApplies
      ? { calls: 0, rate: Number(process.env.BCD_COST_PER_CALL) > 0 ? Number(process.env.BCD_COST_PER_CALL) : 4, unavailable: null }
      : await readBcdCalls({ from, to, DailyCallStat });
    if (bcdRead.unavailable) fail(`BCD CALLS UNAVAILABLE for ${from}..${to} — ${bcdRead.unavailable} — BCD spend below reads as $0.00`);
    const bcdRate = bcdRead.rate;
    const bcdCalls = bcdRead.calls;
    const spendBySource = {};
    // Spend keyed by DAY as well as by source: a profit-and-loss over time
    // needs cost per period, and the aggregate totals cannot be un-summed.
    const spendByDay = {};
    let ld = 0; let mail = 0; let ldLeads = 0; let mailPieces = 0;
    // WHICH DAYS THE SHEET ACTUALLY COVERS. SpendEntry is hand-maintained and
    // lags: on 2026-07-30 it held rows through 07-28 only. Comparing a full
    // range of lead receipts against a short sheet invents a discrepancy —
    // it made July look 148 leads under-recorded when the like-for-like gap
    // was 12. Only days with a real lead-data row count as covered.
    const ldSheetDays = new Set();
    for (const r of rows) {
      const amt = Number(r.spend || 0);
      const day = String(r.date || "").slice(0, 10);
      if (day) {
        spendByDay[day] = spendByDay[day] || { spend: 0, mail: 0, ld: 0, bcd: 0 };
        spendByDay[day].spend = round2(spendByDay[day].spend + amt);
        if (r.channel === "mailer") spendByDay[day].mail = round2(spendByDay[day].mail + amt);
        else if (r.channel === "lead-data") spendByDay[day].ld = round2(spendByDay[day].ld + amt);
      }
      // Carry the sheet's own channel: it is the system of record for what
      // was bought, and beats any guess made from the source name.
      spendBySource[r.source] = spendBySource[r.source] || { spend: 0, leads: 0, channel: r.channel || null };
      if (!spendBySource[r.source].channel && r.channel) spendBySource[r.source].channel = r.channel;
      spendBySource[r.source].spend = round2(spendBySource[r.source].spend + amt);
      spendBySource[r.source].leads += Number(r.leadsReported || 0);
      if (r.channel === "lead-data") {
        // The sheet's lead-data DOLLARS are retired — LD spend is derived
        // below. The row is still walked so its source name survives in the
        // By-source table, but its amount is deliberately not added, or a
        // stale sheet row would double LD.
        if (day && Number(r.leadsReported || 0) > 0) ldSheetDays.add(day);
      }
      else if (r.channel === "mailer") { mail = round2(mail + amt); mailPieces += Number(r.pieces || 0); }
    }

    // ── LD: new leads x rate, off our own receipts ────────────────────────
    //
    // Mickey 2026-08-03: "we arent using that sheet at all" / "LD is new leads
    // * 3" / "bcd is bcd calls * 4".
    //
    // That retires the spend sheet completely. All three channels are now
    // live-sourced and none of them waits on a person typing:
    //
    //   mail  the vendor's invoice, scraped from the mailbox
    //   LD    new leads x $3   (here)
    //   BCD   bcd calls x $4   (below, already derived)
    //
    // This is the SECOND place it had to go. nightReportService has the same
    // wiring, but the night board runtime was deleted on 2026-07-31, so that
    // path only runs by hand — THIS is the composer behind the 8pm email, and
    // fixing only the other one would have left the emailed board unchanged.
    const { readLdSpend } = require("./ldSpendService");
    // SCOPED. Mickey 2026-08-03: "amity is just adding to the total payments no
    // marketing spend."
    //
    // Unscoped, every domain board claimed the whole day's LD cost — an AMITY
    // board read $318 of LD spend against zero LD leads, because all 106 were
    // WYNN. The ldLeads material below scopes correctly and overwrites this,
    // but ONLY when a report asks for that material; a report needing "spend"
    // alone kept the unscoped figure. Passing the domain here makes the number
    // right regardless of which blocks were selected.
    const ldDerived = await readLdSpend({ from, to, domain });
    if (ldDerived.unavailable) {
      // Never render "we could not ask" as "$0.00 spent".
      fail(`LD SPEND UNAVAILABLE for ${from}..${to} — ${ldDerived.unavailable} — LD ROAS below has no denominator`);
    } else {
      ld = ldDerived.spend;
      ldLeads = ldDerived.leads;
      for (const [day, amt] of Object.entries(ldDerived.spendByDay)) {
        spendByDay[day] = spendByDay[day] || { spend: 0, mail: 0, ld: 0, bcd: 0 };
        spendByDay[day].spend = round2(spendByDay[day].spend + amt);
        spendByDay[day].ld = round2(spendByDay[day].ld + amt);
      }
      // NO spendBySource row is written here, deliberately. The ldLeads
      // material below already pushes the derived cost down per receipt
      // sourceName ("LD CUSTOM", "LD GENERAL", ...), and those now fold onto
      // the single "LD" row. Writing an "LD" row here as well meant the same
      // $318 was added twice — once as one lump and once as its parts — which
      // is what put $315 on LD and $321 on Aged against 106 leads that only
      // ever cost $318. Spend is counted ONCE, at the source that produced it.
    }

    const bcd = round2(bcdCalls * bcdRate);
    if (bcdCalls) spendBySource.BCD = { spend: bcd, leads: 0, channel: "bcd" };
    material.spend = {
      ld, mail, bcd, bcdCalls, bcdRate, ldLeads, mailPieces,
      ldRate: ldDerived.rate,
      ldUnavailable: ldDerived.unavailable,
      ldSheetDays: [...ldSheetDays].sort(),
      total: round2(ld + mail + bcd),
    };
    material.spendBySource = spendBySource;
    material.spendByDay = spendByDay;
    // The spend SHEET is retired, so its emptiness is no longer news. What
    // matters is whether the three live sources produced anything.
    if (!ld && !mail && !bcd) {
      fail(`NO SPEND for ${from}..${to} from ANY source (mail invoice, LD receipts, BCD calls) — ROAS below has no denominator and every cost-per reads as free`);
    }

    // ── did the vendor's mail invoice arrive? ──────────────────────────────
    //
    // Mickey 2026-07-31: "the invoice check can run once at the 8 pm thing."
    //
    // The INGEST runs at 19:50 in nightly hygiene; this is the CHECK, and it
    // belongs here because the board is the only 8pm surface an operator reads.
    // hygiene's describe() goes to the log, and a log nobody opens is not a
    // check.
    //
    // It deliberately does NOT add a second red line when the spend sheet is
    // already missing entirely — that is one root cause, and two reds for one
    // cause is the cry-wolf the failure/advisory split exists to stop. It
    // speaks only when it knows something the spend line does not: the sheet
    // has rows but mail is absent from them, and here is whether the invoice
    // that should have supplied it exists.
    // `!mail && !mailPieces`, not `!mailPieces` alone: a mail row that carries
    // a Total but a blank Pieces cell yields mailPieces === 0 while mail spend
    // is real, and testing pieces alone prints "NO MAIL SPEND" directly above
    // the mail spend it is denying.
    // NOT gated on `rows.length` any more. That condition was written while
    // the spend SHEET was still the mail source, so it meant "the sheet has
    // rows but mail is missing from them". The sheet is retired, so rows is
    // routinely empty and this whole check stopped running — on 2026-08-03 the
    // board reported mail $0.00 with ZERO failures, advisories or notes, and
    // Mickey had to ask whether something was broken. Nothing was: the vendor
    // had not sent an invoice. That is exactly what the board should have said
    // for itself.
    //
    // A missing day is now always explained, whatever the sheet holds.
    if (mailApplies && !mail && !mailPieces) {
      try {
        const { MailInvoice } = require("../../shared-models/src");
        const invoices = await MailInvoice.find({
          serviceDate: { $gte: from, $lte: to },
          state: { $ne: "superseded" },
        }).select({ invoiceNumber: 1, serviceDate: 1, grandTotal: 1, state: 1, reviewReasons: 1 }).lean();

        if (!invoices.length) {
          fail(`NO MAIL SPEND for ${from}..${to} and NO INVOICE was ingested for it — either the vendor did not send one or the mailbox read failed, so mail ROAS has no denominator`);
        } else {
          const stuck = invoices.filter((i) => i.state === "review");
          if (stuck.length) {
            fail(`MAIL INVOICE NEEDS REVIEW — ${stuck
              .map((i) => `#${i.invoiceNumber} ${i.serviceDate} $${i.grandTotal} (${(i.reviewReasons || []).join("; ") || "no reason recorded"})`)
              .join(", ")} — its cost is NOT in the spend below`);
          } else {
            // Parsed clean, reconciled, and STILL not in the spend below.
            //
            // This was a quiet note while nothing derived spend from invoices,
            // because back then it described every correctly-ingested invoice
            // and a permanent amber band is just cry-wolf in another colour.
            // mailSpendDeriveService changed that: an invoice in this state has
            // passed every gate the deriver checks and should have produced
            // MailSpendDay rows. It did not, so either the deriver is disarmed
            // or it is failing silently — both worth a band.
            advise(`mail invoice #${invoices.map((i) => i.invoiceNumber).join(", #")} parsed and reconciled ($${round2(invoices.reduce((s, i) => s + Number(i.grandTotal || 0), 0))}) but produced NO derived spend — mail cost is missing from ROAS below`);
          }
        }
      } catch (error) {
        fail(`COULD NOT CHECK the mail invoice for ${from}..${to} — ${String(error.message).slice(0, 120)}`);
      }
    }
  }

  // ── calls: CallRail daily stats (the declared response feed) ──
  //
  // Mickey 2026-07-29: "combine activity read with all of those sweeps in a
  // way that runs it at the time of report generation because we arent doing
  // a live metrics panel at the moment."
  //
  // The feed used to be filled ONLY by the hourly sweeper
  // (hourlySweeperService.js:1120). With no live panel there is nothing to
  // keep a store warm FOR, and the coupling bit: the sweeper stopped with the
  // services on 2026-07-27, so the 28th reported "0 responses" while CallRail
  // held 38 first-time callers. A board that says a live mail piece produced
  // nothing is worse than one that says it does not know.
  //
  // So the report fills its own input. The sync is range-native (one API call
  // for the whole window), validates completeness BEFORE writing, and upserts
  // — so running it per report is cheap and idempotent. The rows are cached
  // immutable provider facts, which is a storage class the doctrine allows.
  // CallRail is a single TAG account, so there is no such thing as a WYNN
  // response — see THE TENANT RULE above. The whole gather is skipped, not
  // just filtered: the sync inside it is a live API call whose entire output
  // would be discarded.
  if ((want.has("calls") || want.has("source")) && !mailApplies) {
    material.callsBySource = {};
    notes.push(`CallRail responses omitted — one ${MAIL_TENANT} account, nothing of it belongs to ${scopedTenant}`);
  } else if (want.has("calls") || want.has("source")) {
    const DailyCallStat = require("../../shared-models/src/DailyCallStat");
    let feedStale = null;
    if (live) {
      try {
        const { syncCallrailDailyStats } = require("./callrailDailyStatSyncService");
        // CallRail is ONE TAG tenant — never loop tenants here.
        const r = await gatherSession.fetch("callrail-sync", { from, to },
          async () => syncCallrailDailyStats({ from, to, companyKey: "TAG" }));
        notes.push(`response feed synced from CallRail for ${from}..${to}`
          + (r && r.written ? ` (${r.written} row(s))` : ""));
      } catch (error) {
        // NEVER fall through to a silent 0. Say the feed is stale and let the
        // renderers print UNKNOWN — a confident zero is the failure mode this
        // whole path exists to stop.
        feedStale = String(error.message).slice(0, 120);
        fail(`RESPONSE FEED NOT REFRESHED — ${feedStale}; response counts below may be incomplete`);
      }
    }
    const rows = await DailyCallStat.find({
      date: { $gte: from, $lte: to }, syncSource: "callrail-direct", active: { $ne: false },
    }).select("piece totalCalls firstTimeCallers").lean();
    const callsBySource = {};
    // BCD rides the SAME callrail-direct feed as the mail pieces, so without
    // this it is counted as a mail response — inflating mail's response count
    // and deflating every mail cost-per-response computed from it, while BCD's
    // own line reads zero. It is a bought channel with its own cost basis, not
    // a mail piece, and it gets its own row further up.
    const { isBcdPiece } = require("./bcdCallsService");
    for (const r of rows) {
      if (isBcdPiece(r.piece)) continue;
      callsBySource[r.piece] = callsBySource[r.piece] || { calls: 0, responses: 0 };
      callsBySource[r.piece].calls += Number(r.totalCalls || 0);
      callsBySource[r.piece].responses += Number(r.firstTimeCallers || 0);
    }
    material.callsBySource = callsBySource;
    material.callsFeedStale = feedStale;
    // An empty feed over a range that HAS days in it is itself a finding —
    // it means nothing has ever filled it, not that nobody called.
    if (!rows.length && !feedStale) {
      fail(`response feed is EMPTY for ${from}..${to} — mail responses will read 0`);
    }
  }

  // ── queue connections: who took the calls (bounded RC trickle + PB) ──
  // The RingCentral inbound queue is the mail tenant's phone system — the
  // calls it counts are people answering TAG mail. Crediting them to a vendor
  // board put 27 inbound calls next to an agent's WYNN dial count and read as
  // though the vendor's leads had produced them. See THE TENANT RULE above.
  if (want.has("queue") && !mailApplies) {
    material.queueByAgent = {};
    material.queueStreams = {};
    notes.push(`inbound queue omitted — the ${MAIL_TENANT} phone queue answers ${MAIL_TENANT} mail, not ${scopedTenant} leads`);
  } else if (want.has("queue")) {
    const byAgent = {};
    const streamTotals = {};
    const days = dayRange(from, to);
    if (days.length > QUEUE_DAY_LOOP_MAX) {
      // Too many days to ask RingCentral — read the nightly rollups instead.
      // This is the whole reason they are stored.
      try {
        const { readQueueRange } = require("./queueRollupService");
        const stored = await readQueueRange({ from, to });
        material.queueByAgent = stored.queueByAgent;
        material.queueStreams = stored.queueStreams;
        material.queueCoverage = stored.coverage;
        const { isFactComplete } = require("./dailyReportFactService");
        // Computed, not the stored flag: a day captured under an older
        // required-section list must not serve as a cache hit for a report
        // that now needs a section it never had. See isFactComplete.
        if (isFactComplete(stored)) {
          notes.push(`queue counts from ${stored.coverage.daysStored} stored nightly rollup(s) — RingCentral not called`);
        } else if (stored.coverage.daysStored > 0) {
          // PARTIAL is not COMPLETE. Summing the days that happen to exist and
          // presenting them as the range is the exact failure this store was
          // built to end.
          const miss = stored.coverage.missing.length;
          material.queueUnavailable = `only ${stored.coverage.daysStored} of ${stored.coverage.daysRequested} day(s) captured`
            + (miss ? ` — missing ${stored.coverage.missing.slice(0, 5).join(", ")}${miss > 5 ? ` +${miss - 5} more` : ""}` : "")
            + (stored.coverage.partialDays.length ? ` — partial: ${stored.coverage.partialDays.join(", ")}` : "");
          // ADVISORY, not a failure. The capture that fills this store is
          // disarmed in code (LEGACY_QUEUE_ROLLUP_WRITES_ENABLED), superseded by
          // DailyReportFact — so incomplete coverage is now the expected steady
          // state, not a fault, and failing on it marked every monthly report
          // [DEGRADED] for a condition nobody intends to fix. The number is still
          // withheld and still said out loud; it just no longer condemns the report.
          advise(`queue counts INCOMPLETE — ${material.queueUnavailable}`);
        } else {
          material.queueUnavailable = `${days.length} days exceeds QUEUE_DAY_LOOP_MAX (${QUEUE_DAY_LOOP_MAX})`
            + " and no nightly rollups are stored for this range yet";
          // Same reasoning as the partial case above: no stored rollups at all is
          // now the expected state for a long range, not a fault.
          advise(`queue counts unavailable — ${material.queueUnavailable}`);
        }
      } catch (error) {
        material.queueByAgent = {};
        material.queueStreams = {};
        material.queueUnavailable = `rollup store unreadable — ${String(error.message).slice(0, 70)}`;
        fail(`queue counts unavailable — ${material.queueUnavailable}`);
      }
    } else {
      try {
        const { readStreamConnections, normalizePhoneBurnerAgent } = require("./mailerQueueService");
        const { readLdDials } = require("./nightReportService");
        let first = true;
        for (const day of days) {
          if (!first) await sleep(QUEUE_DAY_PAUSE_MS);
          first = false;
          const q = await readStreamConnections({ dateKey: day, maxPages: 6, logger });
          for (const [key, stream] of Object.entries(q.streams || {})) {
            streamTotals[key] = streamTotals[key] || { calls: 0, connected: 0, missed: 0 };
            streamTotals[key].calls += stream.calls || 0;
            streamTotals[key].connected += stream.connected || 0;
            streamTotals[key].missed += stream.missed || 0;
            for (const [agent, n] of Object.entries(stream.byAgent || {})) {
              byAgent[agent] = byAgent[agent] || {};
              byAgent[agent][key] = (byAgent[agent][key] || 0) + n;
            }
          }
          if (q.rateLimited) {
            material.queueUnavailable = `RingCentral rate-limited on ${day} — only part of the range was read`;
            fail(`queue counts PARTIAL — RingCentral rate-limited on ${day}`);
            break;
          }
          const ld = await readLdDials(day);
          for (const [id, n] of Object.entries(ld.byAgent || {})) {
            const name = normalizePhoneBurnerAgent(id);
            byAgent[name] = byAgent[name] || {};
            byAgent[name].LD = (byAgent[name].LD || 0) + n;
          }
        }
      } catch (error) {
        material.queueUnavailable = String(error.message).slice(0, 90);
        fail(`queue connections unavailable — ${String(error.message).slice(0, 90)}`);
      }
      material.queueByAgent = byAgent;
      material.queueStreams = streamTotals;
    }
  }

  // ── recordings: notable calls with listen links ──
  if (want.has("recordings")) {
    try {
      const { listNotableCalls } = require("./nightRecordingsService");
      const { foldCasePhones } = require("./casePhoneFoldService");
      const { createLogicsClient } = require("../../shared-integrations/src");
      const { unwrapLogics } = require("./paymentTruthService");

      // A call can only be matched to a sale by PHONE, and a live gather
      // does not resolve phones — so deal calls were landing in the
      // "no-deal" bucket, which is exactly backwards for coaching. Fold
      // phones for the deal cases only (a handful), so outcome=deal /
      // no-deal means what it says.
      const dealRows = (material.payments || [])
        .filter((p) => p.paymentType === "initial" && !p.isChargeback);
      const deals = [];
      for (const p of dealRows) {
        let sourceVia = p.sourceVia || null;
        if (!sourceVia) {
          try {
            const info = unwrapLogics(await createLogicsClient(p.domain).getCaseInfo(p.caseId));
            const phone = foldCasePhones(info || {}).normalizedPhones[0];
            if (phone) sourceVia = `callrail:${phone}`;
          } catch { /* an unmatched deal is a missing tag, not a failed report */ }
        }
        deals.push({
          caseId: p.caseId, name: p.clientName, amount: p.amount,
          officer: p.officerAtSale, sourceVia,
        });
      }
      if (dealRows.length && !deals.some((d) => d.sourceVia)) {
        notes.push("no deal phone resolved — outcome= filters may under-report deals");
      }
      const days = dayRange(from, to);
      if (days.length > RANGE_DAY_LOOP_MAX) {
        material.recordings = [];
        advise(`recordings skipped — ${days.length} days exceeds RANGE_DAY_LOOP_MAX (${RANGE_DAY_LOOP_MAX})`);
      } else {
        const collected = [];
        for (const day of days) {
          const dayCalls = await listNotableCalls({ domain: "TAG", dateKey: day, deals, logger });
          collected.push(...dayCalls);
        }
        material.recordings = collected;
      }
    } catch (error) {
      material.recordings = [];
      fail(`recordings unavailable — ${String(error.message).slice(0, 90)}`);
    }
  }

  // ── case contacts: phone + name for the cases already in play ──
  // The lag and declines blocks need a phone to join on, and payment truth
  // does not carry one. This is a single indexed read over cases we already
  // gathered, not a new sweep.
  if (want.has("caseContacts") && (material.payments || material.declines)) {
    const rows = [...(material.payments || []), ...(material.declines || [])];
    const ids = [...new Set(rows.map((r) => Number(r.caseId)).filter(Boolean))];
    if (ids.length) {
      try {
        const CaseProfile = require("../../shared-models/src/CaseProfile");
        // sourceName is the LEAD source — how the case entered, e.g.
        // "ld-posting". It is the third answer to "where did this deal come
        // from", after the stored source and the attributable call, and it is
        // the ONLY one an LD deal has: an outbound-dialled lead never rings a
        // marketing line, so CallRail can never name it. Free here; we are
        // already reading this document.
        const profiles = await CaseProfile.find({ caseId: { $in: ids } })
          .select("domain caseId name firstName lastName primaryPhone homePhone sourceName").lean();
        const byCase = new Map();
        for (const pr of profiles) byCase.set(`${String(pr.domain).toUpperCase()}:${pr.caseId}`, pr);
        const attach = (list) => (list || []).map((r) => {
          const pr = byCase.get(`${String(r.domain).toUpperCase()}:${Number(r.caseId)}`);
          if (!pr) return r;
          return {
            ...r,
            phone: r.phone || pr.primaryPhone || pr.homePhone || null,
            name: r.name || r.clientName || pr.name
              || [pr.firstName, pr.lastName].filter(Boolean).join(" ") || null,
            // How the case ENTERED. Never overrides a stored source or a call;
            // it is the last resort, and for LD deals the only one available.
            leadSourceName: r.leadSourceName || pr.sourceName || null,
          };
        });
        material.payments = attach(material.payments);
        material.declines = attach(material.declines);
      } catch (error) {
        fail(`case contacts unavailable — ${String(error.message).slice(0, 70)}`);
      }

      // Our CaseProfile mirror carried a phone for 1 of 8 recent deals, so
      // the mirror alone leaves every call join empty. Logics is the
      // authority; fold ALL its numbers (cell/home/work/spouse) because a
      // client rarely calls in on the one field we picked as "primary".
      // Fetch the Logics case when we need a PHONE to join on, or when the row
      // is a DEAL — because the same call also carries SourceCampaignID, which
      // is where the mail piece lives once the sanitizer has written it back.
      // Attribution then becomes a READ instead of a reconstruction.
      const needLookup = [...(material.payments || []), ...(material.declines || [])]
        .filter((r) => !r.phone || (r.paymentType === "initial" && !r.isChargeback));
      const wanted = [...new Map(needLookup.map((r) => [`${r.domain}:${Number(r.caseId)}`, r])).values()];
      if (wanted.length) {
        if (wanted.length > CASE_CONTACT_MAX) {
          advise(`case phone lookup skipped — ${wanted.length} cases exceeds CASE_CONTACT_MAX (${CASE_CONTACT_MAX})`);
        } else {
          try {
            const { createLogicsClient } = require("../../shared-integrations/src");
            const { foldCasePhones } = require("./casePhoneFoldService");
            const { unwrapLogics, mapLimit } = require("./paymentTruthService");
            const { labelForSourceId, pieceForSourceId } = require("./logicsSourceWriterService");
            const clients = new Map();
            const folded = new Map();
            let failed = 0;
            let fromLogics = 0;
            let onCatchAll = 0;
            await mapLimit(wanted, 3, async (r) => {
              const dom = String(r.domain).toUpperCase();
              if (!clients.has(dom)) clients.set(dom, createLogicsClient(dom));
              try {
                const info = unwrapLogics(await clients.get(dom).getCaseInfo(r.caseId));
                const campaignId = info?.SourceCampaignID ?? null;
                folded.set(`${dom}:${Number(r.caseId)}`, {
                  phones: foldCasePhones(info || {}),
                  campaignId,
                  // Mickey 2026-07-28: "the easiest way to think about it is
                  // whats the case create date whats the last active call
                  // from that source date." The create date is what separates
                  // a return on THIS month's advertising from an upsell to
                  // someone who came in years ago on a list that is now dead.
                  caseCreatedDate: String(info?.CreatedDate || "").slice(0, 10) || null,
                  // Registered mail piece first; else any CONFIRMED id label
                  // (LD CUSTOM, BCD, ...) — those are real attribution too,
                  // and their names match the spend keys exactly.
                  piece: pieceForSourceId(dom, campaignId)
                    || (labelForSourceId(dom, campaignId)?.catchAll === false
                      ? labelForSourceId(dom, campaignId).label : null),
                  catchAllLabel: labelForSourceId(dom, campaignId)?.catchAll
                    ? labelForSourceId(dom, campaignId).label : null,
                });
              } catch { failed += 1; }
            });
            const attachPhones = (list) => (list || []).map((r) => {
              const hit = folded.get(`${String(r.domain).toUpperCase()}:${Number(r.caseId)}`);
              if (!hit) return r;
              const f = hit.phones;
              const out = {
                ...r,
                phone: r.phone || f.primaryPhone || f.normalizedPhones?.[0] || null,
                phones: f.normalizedPhones || [],
                sourceCampaignId: hit.campaignId,
                caseCreatedDate: hit.caseCreatedDate || null,
              };
              // The stored snapshot still wins: it records who/what the case was
              // at the moment of sale, and Logics can be edited afterwards.
              if (!out.sourceAtSale && hit.piece) {
                out.sourceAtSale = hit.piece;
                out.sourceOrigin = "logics";
                fromLogics += 1;
              } else if (!out.sourceAtSale && hit.campaignId != null) {
                // Known id, no real source behind it — the catch-all. Say so
                // rather than printing "(unsourced)", which reads as no data.
                out.sourceAtSale = null;
                out.sourceOrigin = "catch-all";
                out.catchAllLabel = hit.catchAllLabel || null;
                onCatchAll += 1;
              } else if (out.sourceAtSale && !out.sourceOrigin) {
                out.sourceOrigin = "snapshot";
              }
              return out;
            });
            material.payments = attachPhones(material.payments);
            material.declines = attachPhones(material.declines);

            // ── A VENDOR BOARD CARRIES ONLY ITS OWN CHANNEL'S MONEY ───────
            //
            // THE TENANT RULE dropped mail/BCD SPEND on a non-mail tenant's
            // board but never touched MONEY. The moment BCD money appeared
            // under WYNN — 2026-08-04, case 138819, $166.67 — the LD vendor's
            // board read "MONEY IN $166.67 (1 deal)" while its own spend line
            // said "(LD only)". That is not merely a disclosure of a channel
            // that is not theirs: it CREDITS THEM WITH A SALE THEY DID NOT
            // MAKE, on an email that leaves the company.
            //
            // Mickey 2026-08-04: "bcd money will be in wynn under the source
            // bcd ... it will potentially be in both but probably mostly
            // wynn." So this is now a live condition, not a hypothetical.
            //
            // Done HERE, after the source is enriched and before any block
            // sees the rows, so the topline, By source and By officer cannot
            // disagree about which money exists. Dropping it in each block
            // would be three chances to drift.
            //
            // The ALL-COMPANY board is untouched: it is unscoped, so
            // scopedTenant is null and every channel's money still counts.
            if (scopedTenant && !mailApplies) {
              const { isLdSource } = require("../../shared-config/src/activeSources");
              const isOurs = (p) => {
                const names = [p.sourceAtSale, p.leadSourceName, p.catchAllLabel];
                // Unresolvable money STAYS. A blank source is not proof it
                // belongs to another channel, and silently dropping it would
                // understate the vendor rather than overstate them — still
                // wrong, just in the flattering direction.
                if (!names.some(Boolean)) return true;
                return names.filter(Boolean).some((n) => isLdSource(n));
              };
              const before = material.payments.length;
              material.payments = material.payments.filter(isOurs);
              material.declines = (material.declines || []).filter(isOurs);
              const dropped = before - material.payments.length;
              if (dropped) {
                notes.push(`${dropped} payment(s) omitted — they belong to another channel, not ${scopedTenant}'s`);
              }
            }

            // A MIDDAY report cannot wait for tonight's snapshot. The night
            // pass stamps officerAtSale at 19:50, so before then every deal
            // reads "(no snapshot)" and the whole sales floor shows zero
            // deals — the exact opposite of what a productivity board is for.
            // Resolve it live from the case's own assignment history, using
            // the same parser the night pass uses so the two can never
            // disagree. Bounded by DEALS, a handful a day.
            const needOfficer = (material.payments || []).filter(
              (r) => r.paymentType === "initial" && !r.isChargeback && !r.officerAtSale,
            );
            if (needOfficer.length && needOfficer.length <= CASE_CONTACT_MAX) {
              try {
                const { classifyRow } = require("./activityEventService");
                const resolved = new Map();
                await mapLimit(needOfficer, 3, async (r) => {
                  const dom = String(r.domain).toUpperCase();
                  if (!clients.has(dom)) clients.set(dom, createLogicsClient(dom));
                  try {
                    const history = unwrapLogics(await clients.get(dom).getActivities(r.caseId));
                    let best = null;
                    for (const row of Array.isArray(history) ? history : []) {
                      const cls = classifyRow({ ActivitySubject: row.Subject, Type: row.ActivityType });
                      if (cls?.kind !== "assignment" || cls.payload?.role !== "Set. Officer") continue;
                      const day = String(row.CreatedDate || "").slice(0, 10);
                      // Whoever held it AT SALE — never someone assigned after.
                      if (day && r.paymentDateKey && day > r.paymentDateKey) continue;
                      if (!best || day >= best.day) best = { day, assignee: cls.payload.assignee };
                    }
                    if (best?.assignee) resolved.set(`${dom}:${Number(r.caseId)}`, best.assignee);
                  } catch { /* one unreadable case must not cost the report */ }
                });
                if (resolved.size) {
                  material.payments = material.payments.map((r) => {
                    const hit = resolved.get(`${String(r.domain).toUpperCase()}:${Number(r.caseId)}`);
                    return hit && !r.officerAtSale
                      ? { ...r, officerAtSale: hit, attributionSnapshot: "live" }
                      : r;
                  });
                  notes.push(`${resolved.size} deal(s) had no snapshot yet — officer resolved live from the case history`);
                }
              } catch (error) {
                fail(`live officer resolution unavailable — ${String(error.message).slice(0, 70)}`);
              }
            }
            if (fromLogics) notes.push(`${fromLogics} payment(s) took their source straight off the Logics case`);
            if (onCatchAll) notes.push(`${onCatchAll} payment(s) sit on the Logics catch-all — run scripts/sanitize-logics-source.js to resolve the piece`);
            if (failed) notes.push(`${failed} case(s) had no reachable Logics contact record`);
          } catch (error) {
            fail(`case phone lookup unavailable — ${String(error.message).slice(0, 70)}`);
          }
        }
      }
    }
  }

  // ── dials: DailyDial per-case rows (ours, range-native, cheap) ──
  if (want.has("dials")) {
    try {
      const DailyDial = require("../../shared-models/src/DailyDial");
      const q = { dateKey: { $gte: from, $lte: to } };
      if (domain) q.domain = String(domain).toLowerCase();
      // DailyDial supplies the range-native attempt facts. Media authority is
      // joined below from the persisted CallLog projection only.
      material.dials = await DailyDial.find(q)
        // leadAgeDays is what identifies NEW inventory (=== 0), which is the
        // basis for attributing LD cost to the agent who first worked a lead.
        // Left out of the projection it is `undefined` on every row, and the
        // LD half of attributed spend silently reads $0 for everyone.
        .select("domain caseId dateKey attempts originPool durationSeconds lastOutcome leadAgeDays")
        .lean();
      // CallLog is the durable analytical projection and the only report
      // authority for PhoneBurner media. DailyDial still supplies attempt
      // timing/counts, but its callback locator is never surfaced directly.
      const callIds = [...new Set(material.dials.flatMap((row) => (
        (Array.isArray(row.attempts) ? row.attempts : [])
          .map((attempt) => String(attempt.providerCallId || "").trim())
          .filter(Boolean)
      )))];
      // ── PHONEBURNER RECORDINGS COME FROM THE DIAL, NOT FROM CallLog ──────
      //
      // Mickey 2026-08-03: "let call log be the recording for ring central and
      // daily dial for phone burner instead of trying to blend them."
      //
      // This used to look the recording up in CallLog. Measured 2026-08-03,
      // CallLog holds 21,038 `platform: "phoneburner"` rows and **ZERO**
      // carrying a `recordingArchive.sourceUri`, all time — so
      // persistedRecordingUrl was null on every attempt ever, and "Calls worth
      // hearing" could never print an LD listen link no matter what arrived.
      // Today's 403 recording-carrying calls had no CallLog row at all.
      //
      // Two sources now, in strength order, both on the PhoneBurner side of
      // the fence:
      //   1. attempt.recordingUrl — the validated form, written by the ledger.
      //      Null today because that validator accepts HTTPS only and
      //      PhoneBurner sends HTTP.
      //   2. safePayload.recordingReference on the delivery event — the
      //      retained capture, joined on providerCallId, used AS CAPTURED.
      //      The capture side is closed and a delivered link was proved to
      //      work; this must not fetch, rewrite or re-parse it.
      const persistedByAttempt = new Map();
      if (callIds.length) {
        try {
          const { LeadDeliveryEvent } = require("../../shared-models/src");
          const events = await LeadDeliveryEvent.find({
            providerCallId: { $in: callIds },
            "safePayload.recordingReference": { $type: "string", $ne: "" },
          }).select("providerCallId safePayload.recordingReference").lean();
          for (const event of events) {
            const key = String(event.providerCallId || "").trim();
            // First one wins — a provider retry posts the same call twice.
            if (!key || persistedByAttempt.has(key)) continue;
            persistedByAttempt.set(key, event.safePayload.recordingReference);
          }
        } catch (error) {
          // Say it. A silent catch here is why this read as "no long calls had
          // recordings" for weeks rather than "we could not look".
          fail(`dial recordings unavailable - ${String(error.message).slice(0, 70)}`);
        }
      }
      material.dials = material.dials.map((row) => ({
        ...row,
        attempts: (Array.isArray(row.attempts) ? row.attempts : []).map((attempt) => ({
          ...attempt,
          // Keyed on providerCallId ALONE, not domain:providerCallId. The
          // delivery event does not carry the report's domain, and the old
          // composite key would have missed every match even once a link
          // existed.
          persistedRecordingUrl: attempt.recordingUrl
            || persistedByAttempt.get(String(attempt.providerCallId || "").trim())
            || null,
        })),
      }));
    } catch (error) {
      material.dials = [];
      material.dialsUnavailable = String(error.message).slice(0, 90);
      fail(`dials unavailable — ${String(error.message).slice(0, 90)}`);
    }
  }

  // ── postdateBilling: per-case FULL history for post-dated cases ──
  // Cost scales with post-dated cases (~51/month), not with days. A 404 is
  // "no billing record", which is the finding, not a failure to look.
  if (want.has("postdateBilling")) {
    const events = material.events || [];
    const postdated = new Map();
    for (const e of events) {
      if (e.kind !== "status-change" || e.payload?.safetyClass !== "postdate") continue;
      if (e.payload?.selfTransition) continue;
      const key = `${e.domain}:${e.caseId}`;
      const at = e.createdAt ? new Date(e.createdAt).toISOString().slice(0, 10) : from;
      const prev = postdated.get(key);
      if (!prev || at < prev.postdatedOn) {
        postdated.set(key, { domain: e.domain, caseId: e.caseId, postdatedOn: at, toStatus: e.payload?.toStatus || null, times: (prev?.times || 0) + 1 });
      } else if (prev) prev.times += 1;
    }
    const { createLogicsClient } = require("../../shared-integrations/src");
    const { unwrapLogics, mapLimit } = require("./paymentTruthService");
    const clients = new Map();
    material.postdateBilling = await mapLimit([...postdated.values()], 3, async (c) => {
      if (!clients.has(c.domain)) clients.set(c.domain, createLogicsClient(c.domain));
      try {
        const rows = unwrapLogics(await clients.get(c.domain).getCasePayments(c.caseId)) || [];
        const list = Array.isArray(rows) ? rows : [];
        const paid = list.filter((x) => String(x.TransactionStatus).toUpperCase() === "SUCCESS" && Number(x.Amount) > 0);
        const declined = list.filter((x) => String(x.TransactionStatus).toUpperCase() === "DECLINED");
        const after = paid.filter((x) => String(x.PaidDate).slice(0, 10) >= c.postdatedOn);
        return {
          ...c, everPaid: paid.length > 0, paidAfter: after.length > 0,
          amountAfter: Math.round(after.reduce((sum, x) => sum + Number(x.Amount), 0) * 100) / 100,
          declinedCount: declined.length,
          declinedAmount: Math.round(declined.reduce((sum, x) => sum + Math.abs(Number(x.Amount)), 0) * 100) / 100,
          noBillingRecord: false,
        };
      } catch (error) {
        if (error?.details?.responseStatus === 404 || /: 404$/.test(String(error.message))) {
          return { ...c, everPaid: false, paidAfter: false, amountAfter: 0, declinedCount: 0, declinedAmount: 0, noBillingRecord: true };
        }
        return { ...c, error: String(error.message).slice(0, 80) };
      }
    });
  }

  // ── callsRange: CallRail per day, under the day cap ──
  // The call that produced a deal usually landed BEFORE the reporting window.
  // Gathering only [from,to] made every lag measure 0 days — an artifact of
  // the window, not a fact about the funnel. So reach back before `from`.
  // CallRail tolerates this: it is the robust API, one cheap call per day.
  // ── ldCaseStatus: where each long-dialled case stands NOW ────────────────
  //
  // Mickey 2026-07-31: "there should be a case status in every one of those
  // calls like you have for mailer." The inbound side pulls the case live and
  // shows its current standing; LD was reading status-change ACTIVITY instead,
  // which only answers for cases that happened to move inside the window — 8
  // of 66 in July. The other 58 showed nothing, and a blank reads as a gap.
  //
  // Cheaper here than on the mail side: a dial already carries its case id, so
  // there is no findCaseByPhone hop. Bounded by the long-call threshold, which
  // is a handful a day. Status is STATE, so it is always pulled fresh and
  // never read from a mirror.
  //
  // The same fetch also carries the CAMPAIGN. Mickey 2026-07-31: "for the call
  // name you can just say LD Custom in calls worth hearing or the source i
  // suppose" — a flat "LD" made every outbound row look alike while the inbound
  // rows named their mail piece. `SourceCampaignID` is the only place the
  // campaign lives (findCaseByPhone does not return it), and getCaseInfo is
  // already in hand here, so the name costs nothing extra.
  //
  // The RAW canonical name is what lands on the row, NOT foldSourceKey's — the
  // fold is a money-table rule that collapses dead campaigns onto Aged, and
  // "Aged / inactive source" answers the wrong question for someone deciding
  // which recording to play. LD Posting reads as LD Posting.
  if (want.has("ldCaseStatus")) {
    const LONG_SEC = Math.max(60, Number(process.env.LD_LONG_CALL_SECONDS) || 300);
    const statuses = {};
    const sources = {};
    try {
      const DailyDial = require("../../shared-models/src/DailyDial");
      const q = { dateKey: { $gte: from, $lte: to }, caseId: { $ne: null } };
      if (domain) q.domain = String(domain).toLowerCase();
      const rows = await DailyDial.find(q).select("domain caseId attempts").lean();
      const cases = new Map();
      for (const r of rows) {
        const longest = (r.attempts || []).some((a) => (Number(a.durationSeconds) || 0) >= LONG_SEC);
        if (!longest) continue;
        cases.set(`${String(r.domain || "").toUpperCase()}:${r.caseId}`,
          { domain: String(r.domain || "TAG").toUpperCase(), caseId: r.caseId });
      }
      const list = [...cases.values()];
      if (list.length && list.length <= LD_STATUS_MAX && live) {
        const { mapLimit, unwrapLogics } = require("./paymentTruthService");
        const { createLogicsClient } = require("../../shared-integrations/src");
        const { resolveCanonicalSource } = require("./sourceCanonicalService");
        // The registry is small and the same handful of campaign ids repeat
        // across every case, so resolve each id once.
        const campaignCache = new Map();
        const campaignName = async (dom, id) => {
          if (!id) return null;
          const key = `${dom}:${id}`;
          if (!campaignCache.has(key)) {
            const hit = await resolveCanonicalSource({ domain: dom.toLowerCase(), sourceId: Number(id) })
              .catch(() => null);
            campaignCache.set(key, hit?.internalName || hit?.displayName || null);
          }
          return campaignCache.get(key);
        };
        await mapLimit(list, 3, async (c) => {
          try {
            const info = unwrapLogics(await createLogicsClient(c.domain).getCaseInfo(c.caseId));
            const key = `${c.domain}:${c.caseId}`;
            if (info?.StatusName) statuses[key] = info.StatusName;
            const name = await campaignName(c.domain, info?.SourceCampaignID || info?.CampaignSourceID);
            if (name) sources[key] = name;
          } catch { /* one unreadable case must not cost the section */ }
        });
      } else if (list.length > LD_STATUS_MAX) {
        // Never silently truncate: a status nobody fetched must read as absent
        // rather than as a case that has not moved.
        advise(`LD case status skipped — ${list.length} long-dialled case(s) exceeds LD_STATUS_MAX (${LD_STATUS_MAX})`);
      }
    } catch (error) {
      fail(`LD case status unavailable — ${String(error.message).slice(0, 80)}`);
    }
    material.ldCaseStatus = statuses;
    material.ldCaseSource = sources;
  }

  if (want.has("callsRange")) {
    const callsFrom = addDaysKey(from, -CALLS_LOOKBACK_DAYS);
    const days = dayRange(callsFrom, to);
    if (days.length > CALLS_DAY_MAX) {
      material.callsRange = [];
      advise(`call detail skipped — ${days.length} days exceeds CALLS_DAY_MAX (${CALLS_DAY_MAX})`);
    } else {
      material.callsLookbackFrom = callsFrom;
      notes.push(`inbound calls gathered from ${callsFrom} (${CALLS_LOOKBACK_DAYS}-day lookback) so call-to-close lag is not clipped to the window`);
      const { createCallrailClient } = require("../../shared-integrations/src");
      const cr = createCallrailClient("TAG");
      const all = [];
      const badDays = [];
      let lastCallsError = null;
      for (const day of days) {
        try {
          const rows = await gatherSession.fetch("callrail", { domain: "TAG", from: day, to: day },
            async () => {
              const res = await cr.listInboundCallsForRange({ startDate: day, endDate: day });
              return res?.calls || [];
            });
          for (const c of rows) {
            all.push({
              callId: c.id, phone: c.customer_phone_number, source: c.source_name || null,
              startedAt: c.start_time, durationSec: Number(c.duration) || 0, dateKey: day,
              // CallRail's own caller history — authoritative over anything we
              // could rebuild, because it counts calls we never match to a case.
              firstCall: c.first_call === undefined ? null : Boolean(c.first_call),
              priorCalls: c.prior_calls === undefined ? null : Number(c.prior_calls),
              totalCalls: c.total_calls === undefined ? null : Number(c.total_calls),
              answered: c.answered === undefined ? null : Boolean(c.answered),
            });
          }
        } catch (error) {
          // ONE entry for the whole loop, not one per day. This reaches back 45
          // days, so a CallRail outage on a single-day board would otherwise
          // push 46 identical lines and bury every other failure under itself.
          badDays.push(day);
          lastCallsError = String(error.message).slice(0, 60);
        }
      }
      if (badDays.length) {
        material.callsRangeUnavailable = `CallRail unreachable for ${badDays.length} of ${days.length} day(s) — ${lastCallsError}`;
        fail(`inbound calls INCOMPLETE — ${badDays.length} of ${days.length} day(s) unreadable (${badDays[0]}${badDays.length > 1 ? ` … ${badDays[badDays.length - 1]}` : ""}) — ${lastCallsError}`);
      }
      material.callsRange = all;
      // CallRail is a single TAG tenant — say so once, here, rather than
      // letting a WYNN-heavy report look like it had no calls.
      notes.push("call detail is CallRail (TAG tenant) only");
    }
  }

  // ── ldLeads: how many LD leads actually ARRIVED ─────────────────────────
  //
  // COUNT THE RECEIPT, NOT THE QUEUE. Mickey 2026-07-30: "ld needs to store
  // summaries per day to do aggregations because cadence is constantly
  // changing", then "logics never deletes".
  //
  // This block used to count rows in LeadDeliveryItem. That is a WORK QUEUE:
  // items terminate, recycle and drop out, so asking it what arrived last
  // month is asking a to-do list what you did in July. Measured 2026-07-30 for
  // July 2026 (WYNN): 4,585 leads genuinely arrived, but only 4,112 cadence
  // rows still existed — 473 gone, 10.3%, and still moving. That undercount is
  // what produced a phantom "$987 vendor overbill"; the vendor had in fact
  // billed 4,437, i.e. 148 FEWER than we received.
  //
  // The add loop already writes an immutable receipt per lead:
  // inbound.lead.received in EventRecord (inboundIntakeService.js:2124). It
  // carries payload.caseId — the Logics case the lead became — so it is both
  // our own append-only log AND the join key to Logics, which never deletes.
  // No TTL index and no pruner exists on EventRecord; receipts go back to
  // 2026-04-20. So no daily summary table is needed: this is an EVENT log we
  // already keep, not a parallel stats DB, which is what the faceplate
  // doctrine actually forbids.
  //
  // Count DISTINCT caseId, not events: a vendor retry posts twice (1 duplicate
  // across 4,586 July posts). Leads rejected before Logics emit a different
  // subtype and are deliberately not counted here — we did not receive them.
  if (want.has("ldLeads")) {
    try {
      const EventRecord = require("../../event-core/src/models/EventRecord");
      const q = {
        eventType: "inbound.lead.received",
        // Same UTC day bounds every other material in this composer uses. The
        // business runs PT, so this window is shifted; that is a composer-wide
        // issue and is NOT silently corrected here, because one material on a
        // different clock would disagree with every other block on the page.
        // Widened by a day each side: the DAY KEY below is Pacific, so a
        // Pacific day straddles two UTC days and a tight UTC window clips it.
        createdAt: {
          $gte: new Date(`${addDaysKey(from, -1)}T00:00:00.000Z`),
          $lt: new Date(`${addDaysKey(to, 2)}T00:00:00.000Z`),
        },
      };
      if (domain) q["payload.domain"] = String(domain).toUpperCase();
      const grouped = await EventRecord.aggregate([
        { $match: q },
        { $group: {
          _id: {
            d: "$payload.domain",
            s: "$payload.sourceName",
            c: "$payload.caseId",
            // Same UTC day key the spend rows are compared against below.
            // PACIFIC, proven against the vendor bill: for 07-25..07-28 the
            // Pacific counts (86/111/105/101) reproduce what was billed
            // exactly; UTC (81/106/103/120) matches none, and 07-28 is off by
            // 19 leads / $57. A lead arriving 6pm PT belongs to that business
            // day; UTC has already rolled over.
            day: { $dateToString: { date: "$createdAt", format: "%Y-%m-%d", timezone: "America/Los_Angeles" } },
          },
        } },
        { $group: { _id: { d: "$_id.d", s: "$_id.s", day: "$_id.day" }, n: { $sum: 1 } } },
      ]);
      const byDomain = {};
      const byDay = {};
      const bySource = {};
      let received = 0;
      for (const g of grouped) {
        // Drop the slack days the widened window pulled in.
        if (g._id.day < from || g._id.day > to) continue;
        const d = String(g._id.d || "").toUpperCase() || "-";
        byDomain[d] = (byDomain[d] || 0) + g.n;
        byDay[g._id.day] = (byDay[g._id.day] || 0) + g.n;
        if (g._id.s) bySource[g._id.s] = (bySource[g._id.s] || 0) + g.n;
        received += g.n;
      }
      const rows = { length: received };
      // LD SPEND IS DERIVED, NOT READ. Mickey 2026-07-30: "spend is cadence
      // lead count X 3" — the rule is volume x rate; only the volume source
      // changed, from the queue to the receipt. Same posture as BCD, which has
      // never had a sheet row. The invoiced count stays visible in the note
      // below so a divergence in either direction is legible.
      const rate = Number(process.env.LD_COST_PER_LEAD) > 0
        ? Number(process.env.LD_COST_PER_LEAD) : 3;
      const derived = round2(rows.length * rate);
      material.ldLeads = { total: rows.length, byDomain, rate, derivedSpend: derived };

      if (material.spend) {
        const billedSpend = Number(material.spend.ld) || 0;
        const billedLeads = Number(material.spend.ldLeads) || 0;
        material.spend.ldSheetSpend = billedSpend;
        material.spend.ldSheetLeads = billedLeads;
        material.spend.ldRate = rate;
        material.spend.ld = derived;
        material.spend.ldLeads = rows.length;
        material.spend.total = round2(
          (Number(material.spend.mail) || 0) + derived + (Number(material.spend.bcd) || 0),
        );

        // PUSH THE DERIVED COST DOWN TO THE SOURCE ROWS TOO. spendBySource is
        // built purely from sheet rows, so overriding only the topline left the
        // by-source and by-channel tables reading "no spend" / $0.00 for LD
        // while the top of the same email said $222 — the report contradicted
        // itself on one page. Mickey 2026-07-30: "roi can only apply by
        // source", so a source row with real leads and no cost is not a
        // cosmetic issue: it is an ROI that cannot be computed.
        //
        // Receipts carry payload.sourceName ("LD CUSTOM", "LD CUSTOM 2", ...),
        // the same names the sheet uses, so cost lands on the piece that
        // actually produced the leads instead of one lump.
        if (material.spendBySource) {
          // EVERY one of these receipts is an LD lead — they are all
          // inbound.lead.received — so the whole derived cost belongs on the
          // LD row regardless of which feed variant the vendor stamped on it.
          // Keyed per variant, a receipt carrying a name that is not
          // LD-prefixed leaked its cost onto another row: on 2026-07-31 that
          // was one lead putting $3 on "Aged", so the LD row read $315 against
          // a $318 headline. Mickey 2026-08-03: "LD is LD."
          const { LD_LABEL } = require("../../shared-config/src/activeSources");
          const totalLeads = Object.values(bySource).reduce((s, n) => s + n, 0);
          if (totalLeads > 0) {
            const prior = material.spendBySource[LD_LABEL] || { channel: "lead-data" };
            material.spendBySource[LD_LABEL] = {
              ...prior,
              channel: prior.channel || "lead-data",
              spend: round2(totalLeads * rate),
              leads: totalLeads,
            };
          }
        }
        // LIKE-FOR-LIKE ONLY. Compare the sheet against receipts on the days
        // the sheet actually covers, never against the whole report range.
        // SpendEntry is legacy hand-maintained marketing data on its way out;
        // while it still exists, a lagging sheet must read as "behind", not as
        // a vendor discrepancy. Both numbers stay visible and the difference is
        // SIGNED — it runs both ways, and a one-directional "overbill" phrasing
        // is what pointed the finger at the vendor in the first place.
        const sheetDays = Array.isArray(material.spend.ldSheetDays) ? material.spend.ldSheetDays : [];
        const covered = sheetDays.length
          ? sheetDays.reduce((s, day) => s + (byDay[day] || 0), 0)
          : rows.length;
        const uncovered = Object.keys(byDay).filter((day) => !sheetDays.includes(day)).sort();
        if (billedLeads && billedLeads !== covered) {
          const delta = billedLeads - covered;
          notes.push(
            `LD — received ${rows.length} lead(s) = ${usd(derived)} at ${usd(rate)}/lead; `
            + `spend sheet recorded ${billedLeads} = ${usd(billedSpend)}. `
            + `Over the ${sheetDays.length || "0"} day(s) the sheet covers we received ${covered} `
            + `(sheet ${delta > 0 ? `${delta} MORE` : `${-delta} FEWER`})`,
          );
        }
        if (sheetDays.length && uncovered.length) {
          notes.push(
            `LD — spend sheet has no rows for ${uncovered.length} day(s) in range `
            + `(${uncovered.slice(0, 3).join(", ")}${uncovered.length > 3 ? ", …" : ""}); `
            + `those ${uncovered.reduce((s, day) => s + (byDay[day] || 0), 0)} lead(s) are counted `
            + `from receipts but carry no sheet cost — the sheet is behind, not the vendor`,
          );
        }
      }
    } catch (error) {
      material.ldLeads = null;
      fail(`LD receipt log unavailable — ${String(error.message).slice(0, 70)}`);
    }
  }

  // ── callRecordings: listen links for the calls a report will actually list ──
  //
  // CallRail returns recordings ONE CALL AT A TIME, so this is deliberately not
  // a field on callsRange — fetching a URL for every call in a 45-day lookback
  // would be hundreds of round-trips to print four links.
  //
  // Pool first: the nightly capture stores links in MarketingCallLink, so a
  // populated pool costs one Mongo read. Only the calls long enough to be
  // listed and still missing a link are fetched, and that fetch is capped.
  // A report with no links is the failure this closes — every long-call row
  // shipped without one because nothing ever resolved them.
  if (want.has("callRecordings")) {
    const MIN_SEC = Math.max(60, Number(process.env.LONG_CALL_SECONDS) || 600);
    const MAX_FETCH = Math.max(0, Number(process.env.REPORT_RECORDING_FETCH_MAX) || 25);
    // callsRange deliberately reaches BACK 45 days so call-to-close lag is not
    // clipped. The listing only ever shows calls inside the report window, so
    // resolving links for the lookback burned the fetch cap on calls nobody
    // would see — and left the ones on screen blank.
    const wanted = (material.callsRange || [])
      .filter((c) => (Number(c.durationSec) || 0) >= MIN_SEC && c.callId)
      .filter((c) => !c.dateKey || (c.dateKey >= from && c.dateKey <= to))
      .map((c) => String(c.callId));
    const byCallId = {};
    if (wanted.length) {
      try {
        const MarketingCallLink = require("../../shared-models/src/MarketingCallLink");
        const pooled = await MarketingCallLink.find({ callId: { $in: wanted } })
          .select("callId listenUrl").lean();
        for (const row of pooled) {
          if (row.listenUrl) byCallId[String(row.callId)] = row.listenUrl;
        }
      } catch (error) {
        fail(`call-link pool unavailable — ${String(error.message).slice(0, 70)}`);
      }
      const missing = wanted.filter((id) => !byCallId[id]);
      if (missing.length && live) {
        const take = missing.slice(0, MAX_FETCH);
        try {
          const { createCallrailClient } = require("../../shared-integrations/src");
          const cr = createCallrailClient("TAG");
          for (const callId of take) {
            try {
              const rec = await cr.getCallRecording(callId);
              const url = rec?.url || rec?.recording || rec?.player || null;
              if (url) byCallId[callId] = url;
            } catch { /* one bad id must not cost the whole section */ }
          }
        } catch (error) {
          fail(`recording lookup unavailable — ${String(error.message).slice(0, 70)}`);
        }
        if (missing.length > MAX_FETCH) {
          // Never silently truncate: a missing link should read as missing.
          advise(`${missing.length - MAX_FETCH} long call(s) left without a listen link (fetch cap ${MAX_FETCH})`);
        }
      }
    }
    material.callRecordings = byCallId;
    const resolved = Object.keys(byCallId).length;
    if (wanted.length) {
      notes.push(`listen links resolved for ${resolved} of ${wanted.length} long call(s)`);
    }
  }

  // ── callContext: who took the call, and where the case stands NOW ────────
  //
  // Mickey 2026-07-30: "officer is a ring central leg look up" and "outcome is
  // current logics status."
  //
  // The long-call list previously took both from PAYMENTS, so a call only had
  // an officer if it had already produced money — every open conversation, the
  // ones actually worth listening to, showed a blank agent and "no outcome
  // yet". The RC leg knows who answered whether or not it closed.
  //
  // Two different kinds of fact, deliberately sourced differently:
  //   · AGENT is an EVENT (this extension answered this call) — read from our
  //     own CallLog mirror, no RingCentral round-trip. Re-authing RC per call
  //     is how you earn 100,000 429s in thirty seconds.
  //   · STATUS is STATE, so it is never read from a mirror. It is pulled live
  //     from Logics at send time, for the handful of cases on screen only.
  if (want.has("callContext")) {
    const MIN_SEC = Math.max(60, Number(process.env.LONG_CALL_SECONDS) || 600);
    const shown = (material.callsRange || [])
      .filter((c) => (Number(c.durationSec) || 0) >= MIN_SEC)
      .filter((c) => !c.dateKey || (c.dateKey >= from && c.dateKey <= to));
    // CallLog.normalizedPhone is the last ten digits; CallRail hands back E.164.
    const last10 = (p) => {
      const d = String(p || "").replace(/\D/g, "");
      return d.length >= 10 ? d.slice(-10) : null;
    };
    const phones = [...new Set(shown.map((c) => last10(c.phone)).filter(Boolean))];
    const byPhone = {};
    if (phones.length) {
      try {
        const CallLog = require("../../shared-models/src/CallLog");
        const legs = await CallLog.find({
          normalizedPhone: { $in: phones },
          direction: "inbound",
          callStartTime: {
            $gte: new Date(`${from}T00:00:00.000Z`),
            $lt: new Date(`${addDaysKey(to, 1)}T00:00:00.000Z`),
          },
        }).select("normalizedPhone callStartTime agentName extensionId caseId caseDomain durationSec").lean();
        // RESOLVE THE AGENT BY EXTENSION, NOT BY NAME. callLogService already
        // solved this: it builds an extensionId -> AgentState map and reads the
        // agent off that. CallLog.agentName is the call's PARTY name, and on an
        // inbound leg that party is the CALLER, so it carries caller-ID CNAM —
        // it rendered "YONKERS NY" as the person who took the call. The
        // extension is the only field that identifies our side of the call.
        const { canonicalStaffName, isUnknownStaff } = require("../../shared-config/src/staffRoster");
        const { AgentState } = require("../../shared-models/src");
        const roster = new Map(
          (await AgentState.find({}).select("extensionId name company").lean())
            .map((a) => [String(a.extensionId || ""), a.name]),
        );
        const staffOnly = (name) => {
          if (!name) return null;
          const c = canonicalStaffName(name);
          return c && !isUnknownStaff(c) ? c : null;
        };
        // Extension first, party name only as a fallback and only if the roster
        // recognises it. A single call leaves several legs — queue, ring,
        // answered — and only the answered one carries our extension.
        const legAgent = (l) => staffOnly(roster.get(String(l.extensionId || ""))) || staffOnly(l.agentName);
        // Match by phone, take the LATEST leg that actually names somebody.
        // Ranking legs by duration was over-thinking it and picked the leg
        // carrying the caller's name instead of ours.
        const byPhoneLegs = new Map();
        for (const leg of legs) {
          const k = String(leg.normalizedPhone);
          if (!byPhoneLegs.has(k)) byPhoneLegs.set(k, []);
          byPhoneLegs.get(k).push(leg);
        }
        for (const [k, group] of byPhoneLegs) {
          group.sort((a, b) => new Date(b.callStartTime || 0) - new Date(a.callStartTime || 0));
          const named = group.find((l) => legAgent(l));
          const cased = group.find((l) => l.caseId);
          byPhone[k] = {
            agent: named ? legAgent(named) : null,
            caseId: cased?.caseId || null,
            caseDomain: cased?.caseDomain || null,
            durationSec: group[0]?.durationSec || 0,
          };
        }
      } catch (error) {
        notes.push(`call leg lookup unavailable — ${String(error.message).slice(0, 70)}`);
      }
    }
    // THE PHONE IS THE CASE. Mickey 2026-07-30: "you have the phone number so
    // you have the case id so you can get the outcome." A leg only carries a
    // caseId when something upstream already resolved it — 17 of 25 inbound
    // legs today had none — but our CaseProfile mirror folds every Logics
    // number into normalizedPhones, which is the same lookup that recovered
    // the spouse-number deals in July. Logics stays the authority for the
    // STATUS; this only answers "whose case is this?".
    const unresolved = phones.filter((p) => !byPhone[p]?.caseId);
    if (unresolved.length && live) {
      try {
        const { createLogicsClient } = require("../../shared-integrations/src");
        const { mapLimit } = require("./paymentTruthService");
        const { caseIdsFrom, isNotFound } = require("./logicsSourceSanitizerService");
        const CaseProfile = require("../../shared-models/src/CaseProfile");
        const dom = (domain && String(domain).toUpperCase() !== "ALL") ? String(domain).toUpperCase() : "TAG";
        await mapLimit(unresolved, 3, async (p) => {
          let ids = [];
          try {
            ids = caseIdsFrom(await createLogicsClient(dom).findCaseByPhone(p));
          } catch (error) {
            // A 404 is a FINDING, not an error: most people who answer a mail
            // piece are strangers and have no case at all. Measured 2026-07-30:
            // 2 of 3 long-call numbers 404, and the third resolved to case
            // 430083, "[Active Prospect]-Opened".
            if (!isNotFound(error)) throw error;
          }
          if (!ids.length) {
            // Logics only matches the number in the case's PRIMARY slot, so a
            // spouse or second line dead-ends. Our mirror folds every number on
            // the case into normalizedPhones — same trick that recovered the
            // July spouse-number deals.
            try {
              const owner = await CaseProfile.findOne({
                domain: dom,
                normalizedPhones: p,
              }).select("caseId domain").lean();
              if (owner?.caseId) ids = [Number(owner.caseId)];
            } catch { /* mirror unavailable — leave unresolved rather than guess */ }
          }
          if (ids.length) {
            byPhone[p] = { ...(byPhone[p] || {}), caseId: ids[0], caseDomain: byPhone[p]?.caseDomain || dom };
          }
        });
      } catch (error) {
        notes.push(`case lookup by phone unavailable — ${String(error.message).slice(0, 70)}`);
      }
    }

    const withAgent = Object.values(byPhone).filter((v) => v.agent).length;
    if (phones.length && withAgent < phones.length) {
      notes.push(`${phones.length - withAgent} long call(s) have no answered RingCentral leg — agent unresolved`);
    }

    // Current Logics status, live, for the cases those calls belong to.
    const cases = [...new Map(Object.values(byPhone)
      .filter((v) => v.caseId)
      .map((v) => [`${v.caseDomain || domain || "TAG"}:${v.caseId}`, v])).values()];
    const statusByCase = {};
    const officerByCase = {};
    const nameByCase = {};
    if (cases.length && live) {
      try {
        const { createLogicsClient } = require("../../shared-integrations/src");
        const { unwrapLogics, mapLimit } = require("./paymentTruthService");
        await mapLimit(cases, 3, async (c) => {
          const key = `${c.caseDomain || "TAG"}:${c.caseId}`;
          const client = createLogicsClient(c.caseDomain || "TAG");
          try {
            const info = unwrapLogics(await client.getCaseInfo(c.caseId));
            if (info?.StatusName) statusByCase[key] = info.StatusName;
            const firstName = String(info?.FirstName || info?.firstName || "").trim() || null;
            const lastName = String(info?.LastName || info?.lastName || "").trim() || null;
            if (firstName || lastName) {
              nameByCase[key] = {
                firstName,
                lastName,
                displayName: [firstName, lastName].filter(Boolean).join(" "),
              };
            }
          } catch { /* one unreadable case must not cost the section */ }

          // SETTLEMENT OFFICER LIVES IN THE ACTIVITIES, NOT ON THE CASE.
          // Mickey 2026-07-30: "settlement officer" ... "activities". Measured:
          // getCaseInfo returns 54 fields and not one of them names an officer.
          // The assignment is an activity whose subject reads
          // "Assigned to Set. Officer: <name>", the same shape
          // trainingCallReviewSourceService parses. Latest assignment wins.
          try {
            const acts = unwrapLogics(await client.getActivities(c.caseId));
            const rows = Array.isArray(acts) ? acts : [];
            const assignments = rows
              .map((a) => ({
                subject: String(a?.Subject || a?.ActivitySubject || ""),
                at: a?.ActivityDate || a?.CreatedDate || a?.Date || null,
              }))
              .filter((a) => /^Assigned to\s+Set\.?\s*Officer\s*:/i.test(a.subject))
              .sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
            const name = assignments[0]?.subject.split(":").slice(1).join(":").trim();
            // "-- Unassigned --" is a real answer meaning nobody owns it, and
            // must not be printed as if it were a person's name.
            if (name && !/^--\s*Unassigned\s*--$/i.test(name)) officerByCase[key] = name;
          } catch { /* activities unreadable — leave the officer blank */ }
        });
      } catch (error) {
        notes.push(`Logics status lookup unavailable — ${String(error.message).slice(0, 70)}`);
      }
    }
    material.callContext = { byPhone, statusByCase, officerByCase, nameByCase };
  }

  material.notes = notes;
  material.failures = failures;
  material.advisories = advisories;
  material.gatherStats = gatherSession.stats();
  return material;
}

/**
 * Compose a report from a block selection.
 * `selection` accepts block ids, preset names, or a mix.
 */
async function composeReport({
  selection = "daily", from, to, domain = null, live = true, logger = null, where = null,
} = {}) {
  const range = { from: String(from || "").slice(0, 10), to: String(to || from || "").slice(0, 10) };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(range.from) || !/^\d{4}-\d{2}-\d{2}$/.test(range.to)) {
    throw new Error("composeReport requires from/to as YYYY-MM-DD");
  }
  const { blocks, unknown } = resolveSelection(selection);
  if (!blocks.length) throw new Error(`no known blocks in "${selection}"`);

  const { filters, unknown: badFilters } = parseFilters(where);
  const needs = neededSources(blocks);
  const material = await gatherMaterial({ needs, ...range, domain, live, logger });

  // Slice BEFORE the blocks compute, so every ticked calculation describes
  // the same population.
  const beforeCounts = { payments: (material.payments || []).length, recordings: (material.recordings || []).length };
  if (filters.length) {
    // An extension identifies a PERSON. Resolve it to that person's name so
    // it filters exactly like officer= — no payment carries an extension, so
    // filtering on it directly would drop every row.
    const extFilters = filters.filter((f) => f.key === "extension");
    if (extFilters.length) {
      try {
        const UserAccount = require("../../shared-models/src/UserAccount");
        const users = await UserAccount.find({
          $or: extFilters.flatMap((f) => ([
            { extensionNumber: String(f.value) },
            { extensionId: String(f.value) },
          ])),
        }).select("name extensionNumber extensionId").lean();
        if (users.length) {
          for (const u of users) filters.push({ key: "officer", op: "=", value: u.name });
          material.notes = [...(material.notes || []), `extension ${extFilters.map((f) => f.value).join(", ")} → ${users.map((u) => u.name).join(", ")}`];
        } else {
          material.notes = [...(material.notes || []), `no user owns extension ${extFilters.map((f) => f.value).join(", ")} — filter had no effect`];
        }
      } catch (error) {
        material.notes = [...(material.notes || []), `extension lookup unavailable — ${String(error.message).slice(0, 70)}`];
      }
    }
    if (material.payments) material.payments = filterPayments(material.payments, filters);
    if (material.declines) material.declines = filterPayments(material.declines, filters);
    if (material.recordings) material.recordings = filterRecordings(material.recordings, filters);
    if (material.queueByAgent) material.queueByAgent = filterQueueByAgent(material.queueByAgent, filters);
  }

  const sections = [];
  for (const block of blocks) {
    try {
      sections.push({ id: block.id, label: block.label, data: block.compute(material), block });
    } catch (error) {
      sections.push({ id: block.id, label: block.label, error: String(error.message).slice(0, 140), block });
    }
  }

  return {
    ...range,
    domain: domain || "ALL",
    selection: blocks.map((b) => b.id),
    filters,
    filtered: filters.length
      ? { before: beforeCounts, after: { payments: (material.payments || []).length, recordings: (material.recordings || []).length } }
      : null,
    unknown: [...unknown, ...badFilters],
    source: live ? "live" : "cached",
    gathered: material.gathered || null,
    gatherStats: material.gatherStats || null,
    notes: material.notes || [],
    // Sources that did not answer. A caller deciding whether to trust this
    // report reads THIS, not notes — see "A FAILURE IS NOT A NOTE" above.
    failures: material.failures || [],
    // Not a fault — data a person has not entered yet. Shown, never alarmed on.
    advisories: material.advisories || [],
    // ALL COSTS BY SOURCE, carried as DATA rather than as a rendered section.
    //
    // The nightly snapshot needs the day's cost denominator (total, LD + lead
    // count, mail + pieces, BCD + call count). The `spend` BLOCK computes
    // exactly that, but it is not in the rollup preset — the email shows spend
    // folded into `topline` instead. Adding the block to the preset to reach the
    // number would have changed what the email looks like, and the email is the
    // one thing that must not move. So the material rides along here and the
    // renderer never sees it.
    spend: material.spend || null,
    sections,
  };
}

/**
 * Every section as its own CSV.
 *
 * ONE CSV PER BLOCK, never one combined sheet: a block IS a table, and stacking
 * unrelated tables into one file is what makes a CSV useless to open.
 *
 * This is the other half of the email being deliberately short. `emailColumns`
 * trims each table to what someone acts on — the source table drops to six
 * columns, the call list to four — and everything trimmed off lives here:
 * recurring_cash, roi_pct, the spend-suspect flag, case ids, phone numbers,
 * prior-call counts. The mail answers "what should I look at"; the CSV answers
 * "show me your work".
 *
 * Returns buffers, not paths — the scheduler attaches these to an email and has
 * no business writing to disk.
 */
function renderCsvs(report) {
  const NL = String.fromCharCode(10);
  const QUOTE = String.fromCharCode(34);
  const cell = (v) => {
    if (v == null) return "";
    const s = String(v);
    return s.includes(",") || s.includes(QUOTE) || s.includes(NL)
      ? QUOTE + s.split(QUOTE).join(QUOTE + QUOTE) + QUOTE
      : s;
  };
  const out = [];
  for (const s of report.sections || []) {
    if (s.error || typeof s.block?.csv !== "function") continue;
    let table;
    try { table = s.block.csv(s.data); } catch { continue; }
    const { rows, columns } = table || {};
    if (!rows?.length || !columns?.length) continue;
    const head = columns.map((c) => cell(c.header)).join(",");
    const body = rows.map((r) => columns.map((c) => cell(c.get(r))).join(",")).join(NL);
    out.push({
      id: s.id,
      filename: `${s.id}-${report.from}${report.to !== report.from ? `_${report.to}` : ""}.csv`,
      content: `${head}${NL}${body}${NL}`,
      rows: rows.length,
    });
  }
  return out;
}

/** Plain-text render — every ticked block, in the order ticked. */
function renderText(report) {
  const L = [];
  L.push(`REPORT  ${report.from}${report.to !== report.from ? ` → ${report.to}` : ""}   ${report.domain}`);
  L.push("=".repeat(70));
  L.push("");
  for (const s of report.sections) {
    if (s.error) { L.push(`${s.label}: unavailable — ${s.error}`); L.push(""); continue; }
    L.push(s.block.renderText(s.data));
    L.push("");
  }
  if (report.filters?.length) {
    const f = report.filters.map((x) => `${x.key}${x.op}${x.value}`).join(" · ");
    L.push(`filtered: ${f}   (${report.filtered.after.payments}/${report.filtered.before.payments} payments, ${report.filtered.after.recordings}/${report.filtered.before.recordings} calls)`);
  }
  if (report.unknown?.length) L.push(`ignored: ${report.unknown.join(", ")}`);
  for (const n of report.notes) L.push(`note: ${n}`);
  // TERMS travel with the numbers — two people can read the same ROI and mean
  // different things. But a reader needs the BOUNDARY, not the doctrine: the
  // full `terms` ran to 716 characters for one block and turned the email into
  // paragraphs of explanation. The short line goes to readers; the full text
  // still ships with the CSV and prints on the console.
  const terms = report.sections.filter((s) => s.block?.termsShort || s.block?.terms);
  if (terms.length) {
    L.push("", "TERMS");
    for (const s of terms) L.push(`  ${s.label}: ${s.block.termsShort || s.block.terms}`);
  }
  if (report.gathered?.activityRows) {
    L.push(`\nlive · ${report.gathered.activityRows} activity rows · ${report.gathered.casesConfirmed} case(s) confirmed · ${Math.round((report.gathered.durationMs || 0) / 1000)}s`);
  }
  return L.join("\n");
}

// ── HTML ──────────────────────────────────────────────────────────────────
// Derived from the SAME column declarations the CSV uses, so a block gains an
// HTML table by existing rather than by growing a third renderer that can
// drift from the other two. A block may still define renderHtml() when a
// table is the wrong shape (the recordings list, for one).

const esc = (v) => String(v === null || v === undefined ? "" : v)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const HEADER_LABEL = (h) => String(h).replace(/_/g, " ");
const MONEY_COL = /(cash|amount|spend|collected|revenue|cost|net|profit)/i;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

function cellHtml(value, header) {
  if (value === null || value === undefined || value === "") return '<td class="muted">—</td>';
  if (typeof value === "boolean") return `<td>${value ? "yes" : "no"}</td>`;
  if (isNum(value)) {
    const text = MONEY_COL.test(header)
      ? `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : value.toLocaleString("en-US");
    return `<td class="num">${esc(text)}</td>`;
  }
  const str = String(value);
  if (/^https?:\/\//.test(str)) return `<td><a href="${esc(str)}">recording</a></td>`;
  return `<td>${esc(str)}</td>`;
}

function sectionHtml(section) {
  if (section.error) {
    return `<section><h2>${esc(section.label)}</h2><p class="err">unavailable — ${esc(section.error)}</p></section>`;
  }
  if (typeof section.block.renderHtml === "function") {
    return `<section><h2>${esc(section.label)}</h2>${section.block.renderHtml(section.data)}</section>`;
  }
  let table;
  try {
    table = section.block.csv(section.data);
  } catch (error) {
    return `<section><h2>${esc(section.label)}</h2><pre>${esc(section.block.renderText(section.data))}</pre></section>`;
  }
  const rows = table.rows || [];
  if (!rows.length) {
    return `<section><h2>${esc(section.label)}</h2><p class="muted">nothing in this range.</p></section>`;
  }
  const head = table.columns.map((c) => `<th>${esc(HEADER_LABEL(c.header))}</th>`).join("");
  const body = rows.map((r) => `<tr>${table.columns.map((c) => cellHtml(c.get(r), c.header)).join("")}</tr>`).join("");
  return `<section><h2>${esc(section.label)}</h2>`
    + `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div></section>`;
}

const STYLE = `
  body{font:14px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1a1a1a;background:#fff;margin:0;padding:24px}
  h1{font-size:20px;margin:0 0 4px}
  h2{font-size:15px;margin:28px 0 8px;padding-bottom:6px;border-bottom:2px solid #1a1a1a}
  .range{color:#666;margin:0 0 8px}
  .scroll{overflow-x:auto}
  table{border-collapse:collapse;width:100%;font-size:13px}
  th{text-align:left;font-weight:600;color:#555;border-bottom:1px solid #ccc;padding:6px 10px 6px 0;white-space:nowrap}
  td{padding:5px 10px 5px 0;border-bottom:1px solid #eee;vertical-align:top}
  td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  td.muted,.muted{color:#999}
  .err{color:#b00}
  .notes{margin-top:28px;padding-top:12px;border-top:1px solid #ddd;color:#666;font-size:12px}
  .notes li{margin:2px 0}
  a{color:#0b57d0}
`;

/**
 * The same report, as email-ready HTML.
 *
 * Notes render as a visible list rather than being dropped: a caveat that
 * only exists in the plain-text copy is a caveat nobody reads.
 */
function renderHtml(report) {
  const title = `${report.from}${report.to !== report.from ? ` → ${report.to}` : ""}`;
  const notes = [...(report.notes || [])];
  if (report.filters?.length) {
    notes.unshift(`filtered: ${report.filters.map((x) => `${x.key}${x.op}${x.value}`).join(" · ")}`
      + ` (${report.filtered.after.payments}/${report.filtered.before.payments} payments)`);
  }
  if (report.unknown?.length) notes.push(`ignored: ${report.unknown.join(", ")}`);
  for (const s of report.sections) {
    if (s.block?.terms) notes.push(`${s.label} — ${s.block.terms}`);
  }
  if (report.gathered?.activityRows) {
    notes.push(`live · ${report.gathered.activityRows} activity rows · ${report.gathered.casesConfirmed} case(s) confirmed`
      + ` · ${Math.round((report.gathered.durationMs || 0) / 1000)}s`);
  }
  return `<!doctype html><html><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>Report ${esc(title)}</title><style>${STYLE}</style></head><body>`
    + `<h1>${esc(report.domain === "ALL" ? "Report" : `${report.domain} report`)}</h1>`
    + `<p class="range">${esc(title)}</p>`
    + report.sections.map(sectionHtml).join("")
    + (notes.length ? `<div class="notes"><ul>${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></div>` : "")
    + `</body></html>`;
}


/**
 * Shape a composed report for the Handlebars template.
 *
 * Handlebars is deliberately dumb, so every decision is made here: which cells
 * are numeric (right-aligned, tabular figures), which are negative (red), which
 * are a recording link, and which are absent. The template only places what it
 * is given, which keeps formatting rules in ONE language rather than split
 * between JS and template logic.
 */
function toTemplateData(report, { title = "Report", eyebrow = "Parallel" } = {}) {
  const MONEY_COL = /(cash|amount|spend|collected|revenue|cost|net|margin|profit)/i;
  // Sign OUTSIDE the dollar sign. Number(-1127.75).toLocaleString() yields
  // "-1,127.75", so naive concatenation printed "$-1,127.75" in the net column.
  const money = (n) => {
    const v = Number(n) || 0;
    const body = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${v < 0 ? "-" : ""}$${body}`;
  };

  const sections = report.sections.map((s) => {
    if (s.error) return { label: s.label, error: s.error, terms: s.block?.termsShort || s.block?.terms || null, columns: [], rows: [] };
    let table;
    try {
      table = s.block.csv(s.data);
    } catch {
      return { label: s.label, error: "could not be tabulated", terms: null, columns: [], rows: [] };
    }
    // THE EMAIL IS FOR PEOPLE WHO DO NOT WANT TO READ EMAIL. A block may
    // declare `emailColumns` — a short subset — and an EMPTY array means the
    // headline alone, no table. The full column set still goes to the CSV
    // attachment, so nothing is lost, it is just not in the way.
    const emailCols = Array.isArray(table.emailColumns) ? table.emailColumns : table.columns;
    // A block may also narrow the ROWS the email shows. The CSV keeps all of
    // them; the mail keeps the ones somebody can act on.
    const emailRows = Array.isArray(table.emailRows) ? table.emailRows : (table.rows || []);
    const columns = emailCols.map((col) => ({
      label: String(col.header).replace(/_/g, " "),
      numeric: false,
      header: col.header,
    }));
    const rows = emailCols.length === 0 ? [] : emailRows.map((r) => emailCols.map((col, i) => {
      const v = col.get(r);
      const numeric = typeof v === "number" && Number.isFinite(v);
      if (numeric) columns[i].numeric = true;
      if (v === null || v === undefined || v === "") return { text: "—", muted: true, numeric };
      if (typeof v === "boolean") return { text: v ? "yes" : "no" };
      // startsWith, not a regex: an escaped pattern written through a
      // generator has silently lost its backslashes more than once here.
      if (typeof v === "string" && (v.startsWith("http://") || v.startsWith("https://"))) {
        return { link: v };
      }
      if (numeric) {
        return {
          text: MONEY_COL.test(col.header) ? money(v) : v.toLocaleString("en-US"),
          numeric: true,
          negative: v < 0,
        };
      }
      return { text: String(v) };
    }));
    return {
      // The masthead is gone, so the first section carries the date — otherwise
      // nothing inside the mail says which day it covers. Mickey 2026-07-30:
      // "where topline is write Date Report".
      label: s.id === "topline"
        ? `${report.from === report.to ? report.from : `${report.from} → ${report.to}`} Report`
        : s.label,
      // A block may hand the email a one-line headline alongside its table.
      // Without it, a section like Top line becomes a 1-row / 13-column table
      // that no mail client can render legibly, and a section like Status
      // movement has to choose between its counts and its chase list.
      summary: table.summary ? String(table.summary) : null,
      terms: s.block?.termsShort || s.block?.terms || null,
      error: null,
      columns,
      rows,
    };
  });

  const notes = [...(report.notes || [])];
  if (report.filters?.length) {
    notes.unshift(`filtered: ${report.filters.map((f) => `${f.key}${f.op}${f.value}`).join(" · ")}`);
  }

  return {
    title,
    eyebrow,
    range: report.from === report.to ? report.from : `${report.from} → ${report.to}`,
    domain: report.domain === "ALL" ? null : report.domain,
    sections,
    // THE ONE THING THE EMAIL SAYS ABOUT ITSELF. Notes stay out (settled: they
    // are telemetry). `alerts` is the strict subset meaning "a source did not
    // answer", and it renders as a red band ABOVE the numbers — because the
    // reader has to know before he reads them, not after.
    alerts: [...(report.failures || []), ...(report.advisories || [])],
    // Rendered as two bands: red for a source that did not answer, amber for
    // data nobody has entered yet. Same information, different urgency —
    // colouring a routine spend-sheet lag like an outage is how a warning
    // stops being read.
    failures: [...(report.failures || [])],
    advisories: [...(report.advisories || [])],
    notes,
    // NO DIAGNOSTICS IN THE EMAIL — settled with Mickey. Row counts and
    // gather timings are operator telemetry: they belong in the CLI and the
    // run journal, not under a board someone reads to decide what to chase.
    // What the reader does need is where the numbers came from.
    footer: "Gathered live from the source systems at send time.",
  };
}

module.exports = {
  FILTER_KEYS,
  renderHtml,
  RANGE_DAY_LOOP_MAX,
  dayRange, composeReport, filterPayments, filterQueueByAgent, filterRecordings,
  gatherMaterial, parseFilters, renderText, renderCsvs, toTemplateData,
  partitionMailSpend,
};
