"use strict";

// The nightly board (pipeline contract Part II) — Mickey's ten asks,
// 2026-07-27, assembled from the night's pass plus the two non-Logics
// ingests, then organised BY SOURCE and BY SETTLEMENT OFFICER.
//
//   1 LD spend            SpendEntry channel="lead-data"
//   2 mail spend          SpendEntry channel="mailer"
//   3 LD calls made       DailyDial attempts (provider=phoneburner)
//   4 mail calls received DailyCallStat, callrail-direct rows ONLY
//   5 status changes      the pass (DNC / redline / post-date / converted)
//   6 initial-payment source (TAG)  CallRail lookup on folded phones
//   7 total money         PaymentTruth rows confirmed today
//   8 long-call links     allow-list phoneburner/callrail — EX NEVER
//   9 by source          10 by settlement officer
//
// Every section degrades to a labelled gap rather than failing the night.

const mongoose = require("mongoose");

const SpendEntry = require("../../shared-models/src/SpendEntry");
const DailyCallStat = require("../../shared-models/src/DailyCallStat");
const DailyDial = require("../../shared-models/src/DailyDial");
const { SOURCE_ALIASES } = require("./simpleMarketingReadService");

// The mail sheet, CallRail and Logics each name the same piece differently
// ("3rd Notice Pink" / "3rd Day (Pink) Urgent Third State" / "Urgent Third
// Pink State"). Canonicalise before joining, or spend lands under one label
// and the deals it bought under another.
function canonicalSource(name) {
  const raw = String(name || "").trim();
  if (!raw) return raw;
  return SOURCE_ALIASES[raw] || raw;
}

// ── THE ROI ROSTER ──────────────────────────────────────────────────────
// Mickey 2026-07-27: "the structured roi i dont want to see anything but LD
// and the 3 mail pieces." Active-sources-only, per the standing doctrine.
// Everything else (ops trackers, website pool, WYNN social, one-off
// citations) is noise on a board about what we BUY.
//
// Money from outside the roster is NOT hidden — it still lands in MONEY IN
// and in the per-deal detail. It just does not get an ROI row, because
// there is no spend to compute a return against.
const LD_LABEL = "LD";
const BCD_LABEL = "BCD";
const ROI_ROSTER = Object.freeze([
  LD_LABEL,
  BCD_LABEL,
  "Urgent Third State",
  "3rd Day (Pink) Urgent Third State",
  "Affordability Federal",
]);

// BCD is PAY-PER-CALL — there is no spend sheet row for it. Cost is derived:
// calls x rate (Mickey 2026-07-28: "adding back bcd today which is
// approximately the number of calls *4"). Rate is the same
// BCD_COST_PER_CALL the hourly financial preview already uses, so the two
// surfaces can never quote different numbers.
const DEFAULT_BCD_COST_PER_CALL = 4;
function bcdCostPerCall() {
  const parsed = Number(process.env.BCD_COST_PER_CALL);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BCD_COST_PER_CALL;
}

// Every LD feed variant is one line: the doctrine is a lead COUNT row, not
// a per-list breakdown.
function rosterLabel(name) {
  const c = canonicalSource(name);
  if (/^ld($|[^a-z])/i.test(String(c))) return LD_LABEL;
  return c;
}

function inRoster(label) {
  return ROI_ROSTER.includes(label);
}

const money = (n) => `$${(Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** 1 + 2 — spend, split by the two channels that actually exist. */
async function readSpend(dateKey) {
  const sheetRows = await SpendEntry.find({ date: dateKey, active: { $ne: false } })
    .select("date channel source spend cost pieces leadsReported").lean();

  // ── THE SAME LIVE-SHEET FALLBACK THE COMPOSER USES ───────────────────────
  //
  // Without this the two paths DISAGREE ON MONEY for the same day: on
  // 2026-08-03 this board reported mail $0.00 with "last recorded 2026-07-30,
  // 4 days stale" while the composer reported $1,584.48. Two reporting paths
  // quoting different numbers is worse than either being wrong alone, because
  // neither can then be trusted and nothing on the page says which is right.
  //
  // Same precedence as the composer: the live CSV is the sheet read NOW, so it
  // replaces the cached SpendEntry rows for any day it covers. The invoice
  // still outranks both, in partitionMailSpend below.
  try {
    const { readMailSheetCsv } = require("./mailSheetCsvService");
    const csv = await readMailSheetCsv({ from: dateKey, to: dateKey });
    if (!csv.unavailable && csv.rows.length) {
      const csvDays = new Set(csv.rows.map((r) => r.date));
      for (let i = sheetRows.length - 1; i >= 0; i -= 1) {
        const r = sheetRows[i];
        if (String(r.channel || "").toLowerCase() !== "mailer") continue;
        if (csvDays.has(String(r.date || "").slice(0, 10))) sheetRows.splice(i, 1);
      }
      sheetRows.push(...csv.rows);
    }
  } catch { /* a hand-run board must not die on an unreachable sheet */ }

  // ── THE SAME MAIL MERGE THE COMPOSER DOES ────────────────────────────────
  //
  // This is the SECOND reporting path. reportComposerService merges the
  // vendor's invoice over the spend sheet; if this one did not, the two boards
  // would report different mail costs for the same day — which is worse than
  // either being wrong alone, because it makes both untrustworthy and there is
  // no way to tell from the emails which is right.
  //
  // Shared helper, deliberately, rather than a second copy of the rule. This
  // repo has twice paid for a duplicated rule drifting; the merge is exactly
  // the kind of thing that drifts, because the copy that is not being edited
  // looks fine.
  const MailSpendDay = require("../../shared-models/src/MailSpendDay");
  const { partitionMailSpend } = require("./reportComposerService");
  const derivedMail = await MailSpendDay.find({
    domain: "TAG", serviceDate: dateKey, active: true,
  }).select("serviceDate source spend pieces postage").lean();
  const { rows, supersededSheetRows } = partitionMailSpend({ sheetRows, derivedMail });

  // ── LD: new leads x $3, NOT the sheet ────────────────────────────────────
  //
  // Mickey 2026-08-03: "we arent using that sheet at all" / "LD is new leads
  // * 3". The sheet's lead-data rows are dead, which is why this board read
  // LD $0.00 for 7-31 — it was reporting the absence of a person's typing as
  // a fact about spend.
  //
  // Counted off EventRecord receipts, never cadence rows — see ldSpendService
  // for the 10.3% churn that makes the queue the wrong thing to count.
  const { readLdSpend } = require("./ldSpendService");
  const ld = await readLdSpend({ from: dateKey, to: dateKey });

  const out = {
    ldRate: ld.rate,
    ldUnavailable: ld.unavailable,
    mailFromInvoice: derivedMail.length > 0,
    mailSheetSpendSuperseded: supersededSheetRows.length
      ? round2(supersededSheetRows.reduce((s, r) => s + Number(r.spend || 0), 0))
      : null,
    ld: { total: ld.spend, leads: ld.leads, rate: ld.rate, bySource: {} },
    mail: { total: 0, postage: 0, pieces: 0, bySource: {}, lastRecordedDate: null, staleDays: null },
    missing: rows.length === 0,
    corruptDates: [],
  };
  for (const r of rows) {
    const spend = Number(r.spend || 0);
    if (r.channel === "lead-data") {
      // The sheet's lead-data rows are RETIRED as a spend source — LD spend is
      // computed above. Any surviving row is kept only so its source name
      // still appears in the By-source table; its dollars are deliberately
      // dropped rather than added, or a stale sheet row would double LD.
      out.ld.bySource[r.source] = out.ld.bySource[r.source] || 0;
    } else if (r.channel === "mailer") {
      out.mail.total = round2(out.mail.total + spend);
      out.mail.postage = round2(out.mail.postage + Number(r.cost || 0));
      out.mail.pieces += Number(r.pieces || 0);
      out.mail.bySource[r.source] = round2((out.mail.bySource[r.source] || 0) + spend);
    }
  }
  // Mail spend arrives on its own cadence (sheet upload), so "no mailer rows
  // today" is usually a not-yet, not a zero. Say which, rather than printing
  // a $0.00 that reads like a fact.
  if (!Object.keys(out.mail.bySource).length) {
    const last = await SpendEntry.find({ channel: "mailer", date: { $lte: dateKey } })
      .sort({ date: -1 }).limit(1).select("date").lean();
    out.mail.lastRecordedDate = last[0]?.date || null;
    if (out.mail.lastRecordedDate) {
      const days = Math.round((Date.parse(`${dateKey}T00:00:00Z`) - Date.parse(`${out.mail.lastRecordedDate}T00:00:00Z`)) / 86400000);
      out.mail.staleDays = Number.isFinite(days) ? days : null;
    }
  }

  // A typo'd year silently removes real spend from every window (found live:
  // $3,273.46 filed under 5026-05-05). Cheap to detect, invisible otherwise.
  const bogus = await SpendEntry.aggregate([
    { $match: { $or: [{ date: { $gt: "2100-01-01" } }, { date: { $lt: "2015-01-01" } }] } },
    { $group: { _id: { date: "$date", channel: "$channel" }, spend: { $sum: "$spend" }, n: { $sum: 1 } } },
    { $sort: { spend: -1 } }, { $limit: 5 },
  ]).catch(() => []);
  out.corruptDates = bogus.map((b) => ({ date: b._id.date, channel: b._id.channel, spend: round2(b.spend), rows: b.n }));

  return out;
}

/** 3 — LD calls MADE. DailyDial holds one doc per case per day with an
 * attempts[] array; each attempt is a real PhoneBurner dial. */
async function readLdDials(dateKey) {
  const rows = await DailyDial.find({ dateKey })
    .select("domain attempts contactedToday originPool durationSeconds lastOutcome").lean();
  const out = { cases: rows.length, dials: 0, connected: 0, byAgent: {}, byPool: {}, byDomain: {}, missing: rows.length === 0 };
  for (const r of rows) {
    const attempts = Array.isArray(r.attempts) ? r.attempts : [];
    out.dials += attempts.length;
    out.byPool[r.originPool || "-"] = (out.byPool[r.originPool || "-"] || 0) + 1;
    const dom = String(r.domain || "").toUpperCase() || "-";
    out.byDomain[dom] = (out.byDomain[dom] || 0) + attempts.length;
    for (const a of attempts) {
      if (a?.connected) out.connected += 1;
      const agent = a?.agentId || "(unknown)";
      out.byAgent[agent] = (out.byAgent[agent] || 0) + 1;
    }
  }
  return out;
}

/** 4 — mail calls RECEIVED. Doctrine: only callrail-direct rows count; a
 * repeat caller is not a response, so firstTimeCallers is the response
 * number. Calls can never be split by domain (one CallRail tenant). */
async function readMailCalls(dateKey, { apply = false } = {}) {
  // Fill our own input. Mickey 2026-07-29: "combine activity read with all of
  // those sweeps in a way that runs it at the time of report generation
  // because we arent doing a live metrics panel at the moment."
  //
  // This feed used to be written ONLY by the hourly sweeper. When the services
  // stopped on 2026-07-27 the board reported 0 responses for the 28th while
  // CallRail held 38 first-time callers — a live mail piece reading as dead.
  // The sync is one range-native API call, validates completeness before
  // writing, and upserts, so doing it here is cheap and idempotent.
  // `apply` is threaded so a DRY RUN stays dry: the sync still fetches and
  // proves the CallRail image, but persists nothing. The report reads the
  // returned image either way, so a preview and the real send show the same
  // numbers — the only difference is whether the cache is updated.
  let syncError = null;
  let fresh = null;
  try {
    const { syncCallrailDailyStats } = require("./callrailDailyStatSyncService");
    fresh = await syncCallrailDailyStats({
      from: dateKey, to: dateKey, companyKey: "TAG", dryRun: !apply,
    });
  } catch (error) {
    syncError = String(error.message).slice(0, 140);
  }
  const rows = fresh?.byDatePiece?.length
    ? fresh.byDatePiece
    : await DailyCallStat.find({ date: dateKey, syncSource: "callrail-direct", active: { $ne: false } })
      .select("piece channel totalCalls firstTimeCallers uniqueCallers").lean();
  const out = {
    totalCalls: 0, responses: 0, bySource: {},
    missing: rows.length === 0, syncError, excludedNonCallrail: 0, bcdCallsExcluded: 0,
  };
  // BCD rides the SAME callrail-direct feed as the mail pieces. Counted here
  // it inflates mail responses and deflates every mail cost-per-response, all
  // while BCD's own line reads zero — it is a separately-bought channel with
  // its own cost basis, and it gets its own row.
  const { isBcdPiece } = require("./bcdCallsService");
  for (const r of rows) {
    if (isBcdPiece(r.piece)) {
      out.bcdCallsExcluded += Number(r.totalCalls || 0);
      continue;
    }
    out.totalCalls += Number(r.totalCalls || 0);
    out.responses += Number(r.firstTimeCallers || 0);
    out.bySource[r.piece] = {
      calls: Number(r.totalCalls || 0),
      responses: Number(r.firstTimeCallers || 0),
    };
  }
  // Count what we deliberately ignored, so a silent feed change is visible.
  out.excludedNonCallrail = await DailyCallStat.countDocuments({
    date: dateKey, syncSource: { $ne: "callrail-direct" },
  });
  return out;
}

/** BCD — pay-per-call vendor. Calls come in on their own channel, and the
 * cost is derived from them rather than read off a spend sheet. */
async function readBcd(dateKey) {
  // Shared with the composer — see bcdCallsService for why an exact /^bcd$/i
  // missed "BCD V3" entirely, and why loosening it naively double-counts on
  // the changeover days.
  const { readBcdCalls } = require("./bcdCallsService");
  return readBcdCalls({ from: dateKey, to: dateKey, DailyCallStat });
}

/** 8 — long calls. ALLOW-LIST ONLY (phoneburner/callrail). EX recordings
 * must never surface; this is an allow-list by construction, never a
 * deny-list, so a new platform is excluded until explicitly admitted. */
const LONG_CALL_PLATFORMS = Object.freeze(["phoneburner", "callrail"]);

async function readLongCalls(dateKey, { minDurationSec = 300, limit = 15 } = {}) {
  const start = new Date(`${dateKey}T00:00:00-07:00`);
  const end = new Date(`${dateKey}T23:59:59-07:00`);
  const rows = await mongoose.connection.db.collection("controlplanecalllogs")
    .find({
      callStartTime: { $gte: start, $lte: end },
      platform: { $in: [...LONG_CALL_PLATFORMS] },
      durationSec: { $gte: minDurationSec },
    })
    .project({
      agentName: 1, durationSec: 1, platform: 1, contactName: 1, caseId: 1,
      domain: 1, "recordingArchive.driveWebViewLink": 1,
    })
    .sort({ durationSec: -1 }).limit(limit).toArray();
  return rows
    .filter((r) => LONG_CALL_PLATFORMS.includes(String(r.platform || "").toLowerCase()))
    .map((r) => ({
      caseId: r.caseId ?? null, domain: r.domain || null, agent: r.agentName || null,
      contact: r.contactName || null, platform: r.platform,
      minutes: Math.round((Number(r.durationSec) || 0) / 6) / 10,
      listenUrl: r.recordingArchive?.driveWebViewLink || null,
    }));
}

/** Assemble every section. `night` is the run-night pass output. */
async function buildNightReport({ dateKey, night, apply = false }) {
  const [spend, ldDials, mailCalls, longCalls, bcd] = await Promise.all([
    readSpend(dateKey).catch((e) => ({ error: e.message })),
    readLdDials(dateKey).catch((e) => ({ error: e.message })),
    readMailCalls(dateKey, { apply }).catch((e) => ({ error: e.message })),
    // Legacy CallLog-based long calls. The board now renders the NOTABLE set
    // (deals / post dates / 10min+, both platforms) — kept only so an older
    // caller does not break.
    readLongCalls(dateKey).catch(() => []),
    readBcd(dateKey).catch(() => ({ calls: 0, rate: bcdCostPerCall(), spend: 0, rows: 0 })),
  ]);

  // 9 — BY SOURCE. Deals/money from the pass; spend + calls joined by the
  // same source label (mail sheet and CallRail already share piece names).
  const bySource = {};
  const row = (s) => (bySource[s] = bySource[s] || {
    source: s, deals: 0, dealAmount: 0, spend: 0, responses: 0, calls: 0, ldLeads: 0,
  });
  for (const d of night.lanes.deals) {
    const r = row(rosterLabel(d.source) || "(UNSOURCED)");
    r.deals += 1; r.dealAmount = round2(r.dealAmount + d.amount);
  }
  for (const [src, amt] of Object.entries(spend.mail?.bySource || {})) {
    const r = row(rosterLabel(src)); r.spend = round2(r.spend + amt);
  }
  // LD is ONE row by doctrine ("every LD feed variant is one line"), and its
  // cost is now derived — leads x rate — rather than summed from per-source
  // sheet rows. So the total lands on the LD label directly; iterating
  // ld.bySource would add nothing, because those rows no longer carry dollars.
  if (spend.ld?.total || spend.ld?.leads) {
    row(LD_LABEL).spend = round2(row(LD_LABEL).spend + (spend.ld.total || 0));
  }
  for (const [src, v] of Object.entries(mailCalls.bySource || {})) {
    const r = row(rosterLabel(src));
    r.responses += v.responses; r.calls += v.calls;
  }
  // LD leads are a COUNT, not a call response (doctrine: the LD row never
  // borrows CallRail's response number).
  if (bySource[LD_LABEL]) bySource[LD_LABEL].ldLeads = spend.ld?.leads || 0;
  // BCD: calls are the volume AND the cost basis.
  if (bcd.calls || bcd.spend) {
    const r = row(BCD_LABEL);
    r.spend = round2(r.spend + bcd.spend);
    r.responses += bcd.calls;
    r.calls += bcd.calls;
  }
  // Cost per response, now that spend and responses share a label. LD is
  // costed per LEAD (it has no inbound responses by definition).
  for (const r of Object.values(bySource)) {
    const denom = r.source === LD_LABEL ? r.ldLeads : r.responses;
    r.cpr = denom > 0 && r.spend > 0 ? round2(r.spend / denom) : null;
    r.roi = r.spend > 0 ? round2(r.dealAmount - r.spend) : null;
  }

  // Roster-only, in a fixed order so the table reads the same every night.
  const roiRows = ROI_ROSTER
    .map((label) => bySource[label] || {
      source: label, deals: 0, dealAmount: 0, spend: 0, responses: 0, calls: 0, ldLeads: 0, cpr: null, roi: null,
    });
  const offRoster = Object.values(bySource).filter((r) => !inRoster(r.source) && r.deals > 0);

  // 10 — BY SETTLEMENT OFFICER. The approved roll-up shape puts CALL
  // ACTIVITY next to money on one line: deals + collected + mail calls
  // taken + LD dials made. Two people closing similar money off very
  // different call volume is the thing worth seeing, and it only shows
  // when the columns sit together.
  const byOfficer = {};
  // Queue labels arrive on the same channel as agent names — "Origination
  // Call Queu" sat on this board as a settlement officer with 1 mail call.
  // The report blocks already gate on isNotAPerson; this board did not, which
  // is the same one-rule-two-implementations bug in a different place.
  // Returns null for a non-person so callers skip it entirely.
  const { canonicalStaffName, isNotAPerson } = require("../../shared-config/src/staffRoster");
  const officerRow = (name) => {
    if (name && isNotAPerson(name)) return null;
    const o = (name && canonicalStaffName(name)) || name || "(unassigned)";
    byOfficer[o] = byOfficer[o] || { officer: o, deals: 0, amount: 0, cases: [], mailCalls: 0, ldDials: 0, bcdCalls: 0 };
    return byOfficer[o];
  };
  // Queue connections (MAILER/BCD from the EX queues) and PhoneBurner dials
  // both key on agent name — fold them onto the same rows as the money.
  for (const [key, stream] of Object.entries(night.streams?.streams || {})) {
    for (const [agent, n] of Object.entries(stream.byAgent || {})) {
      const row = officerRow(agent);
      if (!row) continue;                        // a queue is not an officer
      if (key === "MAILER") row.mailCalls += n;
      else if (key === "BCD") row.bcdCalls += n;
      else if (key === "LD") row.ldDials += n;
    }
  }
  for (const [agent, n] of Object.entries(night.streams?.ldByAgent || {})) {
    const row = officerRow(agent);
    if (row) row.ldDials += n;
  }
  for (const d of night.lanes.deals) {
    // Money is never dropped: if the closer is somehow a non-person label the
    // deal still has to land somewhere, so it falls to (unassigned) rather
    // than vanishing from the board.
    const row = officerRow(d.officer) || officerRow(null);
    row.deals += 1;
    row.amount = round2(row.amount + d.amount);
    row.cases.push(`${d.domain} ${d.caseId}`);
  }

  // ONE source for both renders: the notable set when the pass produced it,
  // the legacy CallLog read only as a fallback. The text and HTML bodies
  // must never disagree about which calls the night surfaced.
  const notable = (night.recordings?.notable || []).map((c) => ({
    ...c,
    isDealCall: c.reasons?.includes("DEAL") || false,
    isPostDate: c.reasons?.includes("POSTDATE") || false,
  }));
  const reviewCalls = notable.length ? notable.slice(0, 15) : longCalls;
  return { dateKey, spend, ldDials, mailCalls, longCalls: reviewCalls, bcd, bySource, roiRows, offRoster, byOfficer, night };
}

/** Plain-text render — the email body. Numbers only from the report object. */
function renderNightReportText(r) {
  const n = r.night;
  const c = n.counters;
  const L = [];

  L.push(`DAILY BOARD — ${r.dateKey}`);
  L.push("=".repeat(58));
  L.push("");
  L.push(`MONEY IN TODAY      ${money(c.confirmedAmountToday)}  (${c.confirmedToday} payments)`);
  L.push(`DEALS               ${n.lanes.deals.length}`);
  if (r.bcd?.calls) L.push(`BCD                 ${r.bcd.calls} call(s) x ${money(r.bcd.rate)} = ${money(r.bcd.spend)}`);
  const mailNote = r.spend.mail?.lastRecordedDate
    ? `mail NOT RECORDED (last ${r.spend.mail.lastRecordedDate}, ${r.spend.mail.staleDays}d ago)`
    : `mail ${money(r.spend.mail?.total)}${r.spend.mail?.postage ? ` (+${money(r.spend.mail.postage)} postage)` : ""}`;
  L.push(`SPEND               LD ${money(r.spend.ld?.total)} · ${mailNote}`);
  const totalSpend = round2((r.spend.ld?.total || 0) + (r.spend.mail?.total || 0));
  L.push(`NET (vs recorded)   ${money(round2(c.confirmedAmountToday - totalSpend))}${r.spend.mail?.lastRecordedDate ? "   ← mail spend missing, so this is overstated" : ""}`);
  L.push("");
  L.push(`LD calls made       ${r.ldDials.dials ?? "—"}${r.ldDials.cases ? ` across ${r.ldDials.cases} cases · ${r.ldDials.connected} connected` : ""}`);
  // A feed that did not answer is UNKNOWN, never 0. "0 responses" against a
  // live mail piece reads as "the mail is dead" and is the most expensive
  // wrong number this board can print.
  if (r.mailCalls.missing) {
    L.push(`Mail calls received UNKNOWN — response feed empty for this day`
      + `${r.mailCalls.syncError ? ` (refresh failed: ${r.mailCalls.syncError})` : ""}`);
  } else {
    L.push(`Mail calls received ${r.mailCalls.totalCalls ?? "—"}${r.mailCalls.responses != null ? ` · ${r.mailCalls.responses} first-time (responses)` : ""}`);
  }
  L.push(`LD leads bought     ${r.spend.ld?.leads ?? "—"}   ·  mail pieces ${r.spend.mail?.pieces ?? "—"}`);
  L.push("");
  L.push(`Status changes      ${n.lanes.statusChanges.dnc} DNC · ${n.lanes.statusChanges.postdate} post-date · ${n.lanes.statusChanges.suspended} redline/suspended · ${n.lanes.conversions.length} converted to client`);
  L.push(`Declines            ${c.declinesToday}${c.chargebacksToday ? ` · ${c.chargebacksToday} chargeback(s)` : ""}`);
  L.push("");

  L.push("BY SOURCE".padEnd(30) + "deals    money      spend  resp     CPR");
  L.push("-".repeat(66));
  const srcRows = r.roiRows;
  for (const s of srcRows) {
    L.push(
      String(s.source).slice(0, 29).padEnd(30)
      + String(s.deals).padStart(5)
      + money(s.dealAmount).padStart(11)
      + money(s.spend).padStart(11)
      + String(s.responses || 0).padStart(6)
      + (s.cpr != null ? money(s.cpr).padStart(8) : "—".padStart(8)),
    );
  }
  L.push("");

  L.push("BY SETTLEMENT OFFICER — money closed alongside calls handled");
  L.push("-".repeat(58));
  const offRows = Object.values(r.byOfficer)
    .sort((a, b) => b.amount - a.amount || (b.mailCalls + b.ldDials) - (a.mailCalls + a.ldDials));
  if (!offRows.length) L.push("  (no activity today)");
  else L.push(`  ${"OFFICER".padEnd(22)}${"DEALS".padStart(6)}${"COLLECTED".padStart(13)}${"MAIL".padStart(7)}${"LD".padStart(8)}`);
  for (const o of offRows) {
    L.push(`  ${o.officer.slice(0, 21).padEnd(22)}${String(o.deals || 0).padStart(6)}${money(o.amount).padStart(13)}${String(o.mailCalls || "—").padStart(7)}${String(o.ldDials || "—").padStart(8)}`);
  }
  L.push("");

  L.push("INITIAL PAYMENTS — SOURCE (TAG, via CallRail where Logics was blank)");
  L.push("-".repeat(58));
  if (!n.lanes.deals.length) L.push("  (none today)");
  for (const d of n.lanes.deals) {
    L.push(`  ${d.domain} ${d.caseId}  ${String(d.name || "").slice(0, 22).padEnd(22)} ${money(d.amount).padStart(11)}`);
    L.push(`      source: ${d.source || "UNSOURCED"}   [${d.sourceVia || "-"}]   officer: ${d.officer || "?"}`);
  }
  L.push("");

  L.push("CALLS TO REVIEW (deals · post dates · 10 min+)");
  L.push("-".repeat(58));
  if (!r.longCalls.length) {
    L.push("  (none — note: EX-platform calls are never listed by policy)");
  } else {
    for (const lc of r.longCalls) {
      const why = (lc.reasons || []).join("·");
      L.push(`  [${why}] ${lc.minutes}m  ${lc.caller || lc.phone || "?"}${lc.officer ? ` → ${lc.officer}` : ""}${lc.caseId ? ` · case ${lc.caseId}` : ""} (${lc.platform})`);
      L.push(`      ${lc.listenUrl || "(no recording link)"}`);
    }
  }
  L.push("");

  if (n.lanes.redlines.length) {
    L.push("REDLINES");
    L.push("-".repeat(58));
    for (const rl of n.lanes.redlines) L.push(`  ${rl.domain} ${rl.caseId}  ${money(rl.amount)}  ${rl.method || ""}`);
    L.push("");
  }

  const gaps = [];
  if (r.spend.missing) gaps.push("no spend rows for this date — LD/mail spend omitted");
  if (r.spend.mail?.lastRecordedDate) {
    gaps.push(`mail spend not recorded since ${r.spend.mail.lastRecordedDate} (${r.spend.mail.staleDays} days) — CPR and NET understate cost`);
  }
  for (const cd of r.spend.corruptDates || []) {
    gaps.push(`CORRUPT SPEND DATE "${cd.date}" holds ${money(cd.spend)} of ${cd.channel} spend across ${cd.rows} row(s) — invisible to every report window`);
  }
  if (r.mailCalls.missing) gaps.push("no callrail-direct call stats — mail calls omitted");
  if (r.mailCalls.excludedNonCallrail) gaps.push(`${r.mailCalls.excludedNonCallrail} non-callrail call-stat row(s) ignored by doctrine`);
  if (r.ldDials.missing) gaps.push("no LD dial rows for this date");
  const review = [...(n.review || []), ...gaps];
  if (review.length) {
    L.push(`REVIEW (${review.length})`);
    L.push("-".repeat(58));
    for (const x of review.slice(0, 30)) L.push(`  · ${x}`);
    if (review.length > 30) L.push(`  … +${review.length - 30} more`);
  } else {
    L.push("REVIEW: nothing needs you.");
  }
  L.push("");
  L.push(`pass: ${c.rows} rows · ${c.staffRows} staff · ${c.moneyLoopCases} cases loop-confirmed · ${c.verifyMismatches} verify mismatch(es)`);

  return L.join("\n");
}

/** Flatten the report into the HBS template's data contract. */
function buildNightEmailData(r) {
  const n = r.night;
  const c = n.counters;
  const totalSpend = round2((r.spend.ld?.total || 0) + (r.spend.mail?.total || 0));
  // The coaching set: DEALS first, then POST DATES, then long calls.
  const longCalls = (r.longCalls || []).map((c) => ({
    ...c, reasonLabel: (c.reasons || []).join(" · "),
  }));

  const review = [...(n.review || [])];
  if (r.spend.mail?.lastRecordedDate) {
    review.push(`mail spend not recorded since ${r.spend.mail.lastRecordedDate} (${r.spend.mail.staleDays}d) — NET overstated`);
  }
  for (const cd of r.spend.corruptDates || []) {
    review.push(`CORRUPT SPEND DATE "${cd.date}" holds ${money(cd.spend)} of ${cd.channel} spend — invisible to every report window`);
  }

  return {
    dateKey: r.dateKey,
    domains: (n.domains || []).join(" + "),
    totals: {
      confirmedAmount: c.confirmedAmountToday,
      confirmedCount: c.confirmedToday,
      deals: n.lanes.deals.length,
      spend: totalSpend,
      ldSpend: r.spend.ld?.total || 0,
      mailSpend: r.spend.mail?.total || 0,
      bcdSpend: r.bcd?.spend || 0,
      bcdCalls: r.bcd?.calls || 0,
      bcdRate: r.bcd?.rate || 0,
      net: round2(c.confirmedAmountToday - totalSpend),
      mailStale: r.spend.mail?.lastRecordedDate || null,
    },
    calls: {
      ldDials: r.ldDials?.dials || 0,
      ldCases: r.ldDials?.cases || 0,
      ldConnected: r.ldDials?.connected || 0,
      mailCalls: r.mailCalls?.totalCalls || 0,
      responses: r.mailCalls?.responses || 0,
      ldLeads: r.spend.ld?.leads || 0,
      mailPieces: r.spend.mail?.pieces || 0,
    },
    status: {
      dnc: n.lanes.statusChanges.dnc,
      postdate: n.lanes.statusChanges.postdate,
      suspended: n.lanes.statusChanges.suspended,
      converted: n.lanes.conversions.length,
    },
    bySource: r.roiRows,
    offRoster: r.offRoster,
    byOfficer: Object.values(r.byOfficer)
      .sort((a, b) => b.amount - a.amount || (b.mailCalls + b.ldDials) - (a.mailCalls + a.ldDials)),
    deals: n.lanes.deals,
    redlines: (n.lanes.redlines || []).map((x) => ({ ...x, attemptCount: (x.attempts || []).length })),
    longCalls,
    review,
    pass: {
      rows: c.rows, staffRows: c.staffRows,
      moneyLoopCases: c.moneyLoopCases, verifyMismatches: c.verifyMismatches,
    },
  };
}

module.exports = {
  LONG_CALL_PLATFORMS,
  buildNightEmailData,
  buildNightReport,
  readBcd,
  readLdDials,
  readLongCalls,
  readMailCalls,
  readSpend,
  renderNightReportText,
};
