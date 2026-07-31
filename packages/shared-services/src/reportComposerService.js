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
        notes.push(`attribution snapshots unavailable — ${String(error.message).slice(0, 70)}`);
      }
      material.events = g.activity.events;
      material.gathered = {
        activityRows: g.activity.rows, casesConfirmed: g.totals.casesConfirmed,
        durationMs: g.durationMs, unconfirmed: g.unconfirmed.length,
      };
      notes.push(...g.errors);
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
    const rows = await SpendEntry.find({ date: { $gte: from, $lte: to }, active: { $ne: false } })
      .select("date channel source spend cost pieces leadsReported").lean();
    const bcdRows = await DailyCallStat.find({
      date: { $gte: from, $lte: to }, channel: "bcd", active: { $ne: false },
    }).select("totalCalls").lean();

    const bcdRate = Number(process.env.BCD_COST_PER_CALL) > 0 ? Number(process.env.BCD_COST_PER_CALL) : 4;
    const bcdCalls = bcdRows.reduce((s, r) => s + (Number(r.totalCalls) || 0), 0);
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
        ld = round2(ld + amt); ldLeads += Number(r.leadsReported || 0);
        // A zero-everything row (e.g. LD GENERAL placeholders) is not coverage.
        if (day && (amt > 0 || Number(r.leadsReported || 0) > 0)) ldSheetDays.add(day);
      }
      else if (r.channel === "mailer") { mail = round2(mail + amt); mailPieces += Number(r.pieces || 0); }
    }
    const bcd = round2(bcdCalls * bcdRate);
    if (bcdCalls) spendBySource.BCD = { spend: bcd, leads: 0, channel: "bcd" };
    material.spend = {
      ld, mail, bcd, bcdCalls, bcdRate, ldLeads, mailPieces,
      ldSheetDays: [...ldSheetDays].sort(),
      total: round2(ld + mail + bcd),
    };
    material.spendBySource = spendBySource;
    material.spendByDay = spendByDay;
    if (!rows.length) notes.push(`no spend rows recorded for ${from}..${to}`);
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
  if (want.has("calls") || want.has("source")) {
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
        notes.push(`RESPONSE FEED NOT REFRESHED — ${feedStale}; response counts below may be incomplete`);
      }
    }
    const rows = await DailyCallStat.find({
      date: { $gte: from, $lte: to }, syncSource: "callrail-direct", active: { $ne: false },
    }).select("piece totalCalls firstTimeCallers").lean();
    const callsBySource = {};
    for (const r of rows) {
      callsBySource[r.piece] = callsBySource[r.piece] || { calls: 0, responses: 0 };
      callsBySource[r.piece].calls += Number(r.totalCalls || 0);
      callsBySource[r.piece].responses += Number(r.firstTimeCallers || 0);
    }
    material.callsBySource = callsBySource;
    material.callsFeedStale = feedStale;
    // An empty feed over a range that HAS days in it is itself a finding —
    // it means nothing has ever filled it, not that nobody called.
    if (!rows.length && !feedStale) {
      notes.push(`response feed is EMPTY for ${from}..${to} — mail responses will read 0`);
    }
  }

  // ── queue connections: who took the calls (bounded RC trickle + PB) ──
  if (want.has("queue")) {
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
        if (stored.coverage.complete) {
          notes.push(`queue counts from ${stored.coverage.daysStored} stored nightly rollup(s) — RingCentral not called`);
        } else if (stored.coverage.daysStored > 0) {
          // PARTIAL is not COMPLETE. Summing the days that happen to exist and
          // presenting them as the range is the exact failure this store was
          // built to end.
          const miss = stored.coverage.missing.length;
          material.queueUnavailable = `only ${stored.coverage.daysStored} of ${stored.coverage.daysRequested} day(s) captured`
            + (miss ? ` — missing ${stored.coverage.missing.slice(0, 5).join(", ")}${miss > 5 ? ` +${miss - 5} more` : ""}` : "")
            + (stored.coverage.partialDays.length ? ` — partial: ${stored.coverage.partialDays.join(", ")}` : "");
          notes.push(`queue counts INCOMPLETE — ${material.queueUnavailable}`);
        } else {
          material.queueUnavailable = `${days.length} days exceeds QUEUE_DAY_LOOP_MAX (${QUEUE_DAY_LOOP_MAX})`
            + " and no nightly rollups are stored for this range yet";
          notes.push(`queue counts unavailable — ${material.queueUnavailable}`);
        }
      } catch (error) {
        material.queueByAgent = {};
        material.queueStreams = {};
        material.queueUnavailable = `rollup store unreadable — ${String(error.message).slice(0, 70)}`;
        notes.push(`queue counts unavailable — ${material.queueUnavailable}`);
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
          if (q.rateLimited) { notes.push(`queue read rate-limited on ${day} — partial`); break; }
          const ld = await readLdDials(day);
          for (const [id, n] of Object.entries(ld.byAgent || {})) {
            const name = normalizePhoneBurnerAgent(id);
            byAgent[name] = byAgent[name] || {};
            byAgent[name].LD = (byAgent[name].LD || 0) + n;
          }
        }
      } catch (error) {
        notes.push(`queue connections unavailable — ${String(error.message).slice(0, 90)}`);
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
        notes.push(`recordings skipped — ${days.length} days exceeds RANGE_DAY_LOOP_MAX (${RANGE_DAY_LOOP_MAX})`);
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
      notes.push(`recordings unavailable — ${String(error.message).slice(0, 90)}`);
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
        const profiles = await CaseProfile.find({ caseId: { $in: ids } })
          .select("domain caseId name firstName lastName primaryPhone homePhone").lean();
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
          };
        });
        material.payments = attach(material.payments);
        material.declines = attach(material.declines);
      } catch (error) {
        notes.push(`case contacts unavailable — ${String(error.message).slice(0, 70)}`);
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
          notes.push(`case phone lookup skipped — ${wanted.length} cases exceeds CASE_CONTACT_MAX (${CASE_CONTACT_MAX})`);
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
                notes.push(`live officer resolution unavailable — ${String(error.message).slice(0, 70)}`);
              }
            }
            if (fromLogics) notes.push(`${fromLogics} payment(s) took their source straight off the Logics case`);
            if (onCatchAll) notes.push(`${onCatchAll} payment(s) sit on the Logics catch-all — run scripts/sanitize-logics-source.js to resolve the piece`);
            if (failed) notes.push(`${failed} case(s) had no reachable Logics contact record`);
          } catch (error) {
            notes.push(`case phone lookup unavailable — ${String(error.message).slice(0, 70)}`);
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
      // recordingUrl is selected at BOTH levels: the callback writes it onto
      // the attempt, and the call-log projection also carries a doc-level one.
      // Omitting it here is why the LD board had no listen links even once the
      // recordings started arriving — the data was in Mongo and not in the read.
      material.dials = await DailyDial.find(q)
        .select("domain caseId dateKey attempts originPool durationSeconds lastOutcome recordingUrl")
        .lean();
    } catch (error) {
      material.dials = [];
      notes.push(`dials unavailable — ${String(error.message).slice(0, 90)}`);
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
  if (want.has("ldCaseStatus")) {
    const LONG_SEC = Math.max(60, Number(process.env.LD_LONG_CALL_SECONDS) || 300);
    const statuses = {};
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
        await mapLimit(list, 3, async (c) => {
          try {
            const info = unwrapLogics(await createLogicsClient(c.domain).getCaseInfo(c.caseId));
            if (info?.StatusName) statuses[`${c.domain}:${c.caseId}`] = info.StatusName;
          } catch { /* one unreadable case must not cost the section */ }
        });
      } else if (list.length > LD_STATUS_MAX) {
        // Never silently truncate: a status nobody fetched must read as absent
        // rather than as a case that has not moved.
        notes.push(`LD case status skipped — ${list.length} long-dialled case(s) exceeds LD_STATUS_MAX (${LD_STATUS_MAX})`);
      }
    } catch (error) {
      notes.push(`LD case status unavailable — ${String(error.message).slice(0, 80)}`);
    }
    material.ldCaseStatus = statuses;
  }

  if (want.has("callsRange")) {
    const callsFrom = addDaysKey(from, -CALLS_LOOKBACK_DAYS);
    const days = dayRange(callsFrom, to);
    if (days.length > CALLS_DAY_MAX) {
      material.callsRange = [];
      notes.push(`call detail skipped — ${days.length} days exceeds CALLS_DAY_MAX (${CALLS_DAY_MAX})`);
    } else {
      material.callsLookbackFrom = callsFrom;
      notes.push(`inbound calls gathered from ${callsFrom} (${CALLS_LOOKBACK_DAYS}-day lookback) so call-to-close lag is not clipped to the window`);
      const { createCallrailClient } = require("../../shared-integrations/src");
      const cr = createCallrailClient("TAG");
      const all = [];
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
          notes.push(`calls ${day} unavailable — ${String(error.message).slice(0, 60)}`);
        }
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
        createdAt: {
          $gte: new Date(`${from}T00:00:00.000Z`),
          $lt: new Date(`${addDaysKey(to, 1)}T00:00:00.000Z`),
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
            day: { $dateToString: { date: "$createdAt", format: "%Y-%m-%d", timezone: "UTC" } },
          },
        } },
        { $group: { _id: { d: "$_id.d", s: "$_id.s", day: "$_id.day" }, n: { $sum: 1 } } },
      ]);
      const byDomain = {};
      const byDay = {};
      const bySource = {};
      let received = 0;
      for (const g of grouped) {
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
          for (const [src, n] of Object.entries(bySource)) {
            const prior = material.spendBySource[src] || { channel: "lead-data" };
            material.spendBySource[src] = {
              ...prior,
              channel: prior.channel || "lead-data",
              spend: round2(n * rate),
              leads: n,
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
      notes.push(`LD receipt log unavailable — ${String(error.message).slice(0, 70)}`);
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
        notes.push(`call-link pool unavailable — ${String(error.message).slice(0, 70)}`);
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
          notes.push(`recording lookup unavailable — ${String(error.message).slice(0, 70)}`);
        }
        if (missing.length > MAX_FETCH) {
          // Never silently truncate: a missing link should read as missing.
          notes.push(`${missing.length - MAX_FETCH} long call(s) left without a listen link (fetch cap ${MAX_FETCH})`);
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
              const owner = await CaseProfile.findOne({ normalizedPhones: p }).select("caseId domain").lean();
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
    material.callContext = { byPhone, statusByCase, officerByCase };
  }

  material.notes = notes;
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
    sections,
  };
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
  gatherMaterial, parseFilters, renderText, toTemplateData,
};
