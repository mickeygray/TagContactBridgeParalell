"use strict";

// THE NIGHT PASS — one callable, used by both the CLI (scripts/run-night.js)
// and the scheduled runtime (apps/control-plane/src/services/nightBoardRuntime).
// One implementation, so the thing that runs automatically is byte-identical
// to the thing that was proven by hand.
//
// Pipeline contract Parts I + II:
//   activity pull → typed events → money loop (Billing-confirmed) →
//   attribution seed → redline join → recordings → board → email
//
// Diagnostics (`review`) are returned for the LOG, not for the reader.
// Mickey 2026-07-27: "this is an email for people who dont care to read
// emails from me" — the board carries numbers, not engineering notes.

const { createLogicsClient } = require("../../shared-integrations/src");
const { parseReportRows, insertActivityEvents, classifyRow } = require("./activityEventService");
const { runMoneyLoop, persistPaymentTruths, unwrapLogics, mapLimit } = require("./paymentTruthService");
const { foldCasePhones } = require("./casePhoneFoldService");
const { listInboundCallsForPhone, lookupInboundCall } = require("./callrailLookupService");
const { buildNightReport, renderNightReportText, buildNightEmailData } = require("./nightReportService");
const { caseProfileRepository } = require("../../shared-repositories/src");

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const money = (n) => `$${(Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function pacificDateKey(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

/** Logics 400s on a non-zero-padded date. */
function fmtLogicsDate(dateKey) {
  const [y, m, d] = String(dateKey).split("-");
  return `${m}/${d}/${y}`;
}

async function runNightPass({
  dateKey = pacificDateKey(),
  domains = ["TAG", "WYNN", "AMITY"],
  apply = false,
  attach = false,
  logger = null,
  concurrency = 3,
  // PERSIST-ONLY: run every write and stop before the reporting body.
  //
  // The board itself is now a saved ReportDefinition (preset `board`), but the
  // per-domain loop above it is the ONLY code in the repo that writes
  // officerAtSale/sourceAtSale — a fact a live re-pull cannot reconstruct,
  // because Logics returns who owns the case TODAY, not who closed it. So the
  // persistence half stays here and is reused verbatim rather than
  // reimplemented: same stamp, same order, same idempotent upserts.
  //
  // Everything skipped below this flag is pure reporting: redline join,
  // recordings, queue reads, and the rendered board.
  persistOnly = false,
} = {}) {
  const log = (msg) => { logger?.info?.(msg); };
  const started = Date.now();

  const night = {
    dateKey, domains, startedAt: new Date().toISOString(),
    counters: {
      rows: 0, systemRows: 0, staffRows: 0, staffCases: 0, resurfaced: 0,
      events: {}, moneyLoopCases: 0, paymentsSeen: 0, confirmedToday: 0,
      confirmedAmountToday: 0, declinesToday: 0, chargebacksToday: 0,
      verifyMismatches: 0, unconfirmedCases: [], paymentsPersisted: 0,
      eventsPersisted: 0,
    },
    // Populated only in persistOnly dry mode, so a caller can persist EXACTLY
    // what it planned rather than re-deriving it in a second pass.
    pending: { events: [], truths: [] },
    lanes: {
      deals: [], redlines: [], statusChanges: { dnc: 0, postdate: 0, suspended: 0, other: 0, list: [] },
      documents: { uploads: 0, sent: 0 }, intake: {}, officerCollections: {}, conversions: [],
    },
    review: [],
  };

  // ── STAGE 1: pull + parse ───────────────────────────────────────────────
  const perDomain = [];
  const officerByCase = new Map();
  const redlineByCase = new Map();

  for (const domain of domains) {
    const client = createLogicsClient(domain);
    let rows = [];
    try {
      const res = await client.requestActivityReport({
        StartDate: fmtLogicsDate(dateKey), EndDate: fmtLogicsDate(dateKey),
        ReportName: "ActivityReport",
        Email: process.env.LOGICS_REPORT_EMAIL || "mgray@taxadvocategroup.com",
      });
      const d = unwrapLogics(res);
      rows = Array.isArray(d) ? d : (Array.isArray(d?.Data) ? d.Data : []);
    } catch (error) {
      night.review.push(`${domain}: activity pull failed — ${String(error.message).slice(0, 120)}`);
      logger?.warn?.("night_pass.activity_pull_failed", { domain, error: String(error.message).slice(0, 160) });
      continue;
    }

    const parsed = parseReportRows(rows, { domain, dateKey });
    log(`[${domain}] ${parsed.stats.rows} rows → ${parsed.stats.staffRows} staff · ${parsed.moneyCases.size} money-loop cases`);

    night.counters.rows += parsed.stats.rows;
    night.counters.systemRows += parsed.stats.systemRows;
    night.counters.staffRows += parsed.stats.staffRows;
    night.counters.staffCases += parsed.staffCases.size;
    for (const [k, c] of Object.entries(parsed.stats.byKind)) {
      night.counters.events[k] = (night.counters.events[k] || 0) + c;
    }

    if (apply) {
      const ins = await insertActivityEvents(parsed.events).catch((e) => {
        night.review.push(`${domain}: event persist failed — ${e.message}`);
        return { resurfaced: 0, inserted: 0 };
      });
      night.counters.resurfaced += ins.resurfaced || 0;
      // The only operator-facing signal that ActivityEvent persistence
      // actually happened. It was discarded, so the runtime reported
      // "events: 0" forever — the failure nobody notices for weeks.
      night.counters.eventsPersisted += ins.inserted || 0;
    }
    // In persist-only mode the caller may hold the assembled writes so it can
    // persist EXACTLY what it planned, instead of re-deriving them in a
    // second pass that could resolve attribution differently.
    if (persistOnly && !apply) night.pending.events.push(...parsed.events);

    for (const e of parsed.events) {
      if (e.kind === "intake" && e.payload?.source) {
        night.lanes.intake[e.payload.source] = (night.lanes.intake[e.payload.source] || 0) + 1;
      }
      if (e.kind === "doc-upload") night.lanes.documents.uploads += 1;
      if (e.kind === "doc-sent") night.lanes.documents.sent += 1;
      if (e.kind === "conversion") night.lanes.conversions.push({ domain, caseId: e.caseId, stage: e.payload?.stage, by: e.createdBy });
      // CaseInfo carries NO officer field — the assignment ACTIVITY is the
      // only Logics-side source, so officer is a fold, not a per-case pull.
      if (e.kind === "assignment" && e.payload?.role === "Set. Officer") {
        officerByCase.set(`${domain}:${e.caseId}`, e.payload.assignee);
      }
      if (e.kind === "status-change" && !e.payload?.selfTransition) {
        const cls = e.payload?.safetyClass;
        if (cls === "dnc") night.lanes.statusChanges.dnc += 1;
        else if (cls === "postdate") night.lanes.statusChanges.postdate += 1;
        else if (cls === "suspended") night.lanes.statusChanges.suspended += 1;
        else night.lanes.statusChanges.other += 1;
        night.lanes.statusChanges.list.push({ domain, caseId: e.caseId, to: e.payload?.toStatus, cls: cls || "-" });
      }
    }
    perDomain.push({ domain, client, parsed });
  }

  // ── STAGE 2–3: the money loop ───────────────────────────────────────────
  for (const { domain, client, parsed } of perDomain) {
    const loop = await runMoneyLoop({ domain, caseIds: parsed.moneyCases, client, dateKey, concurrency });
    night.counters.moneyLoopCases += loop.stats.cases;
    night.counters.paymentsSeen += loop.truths.length;
    night.counters.verifyMismatches += loop.stats.mismatches;
    night.counters.unconfirmedCases.push(...loop.unconfirmed.map((u) => ({ domain, ...u })));

    const todays = loop.truths.filter((t) => t.paymentDateKey === dateKey);
    const confirmed = todays.filter((t) => t.transactionStatus === "SUCCESS" && !t.isChargeback);
    const declines = todays.filter((t) => t.transactionStatus === "DECLINED");
    const chargebacks = todays.filter((t) => t.isChargeback);

    night.counters.confirmedToday += confirmed.length;
    night.counters.confirmedAmountToday = round2(night.counters.confirmedAmountToday + confirmed.reduce((s, t) => s + t.amount, 0));
    night.counters.declinesToday += declines.length;
    night.counters.chargebacksToday += chargebacks.length;

    // One redline per CASE — a card failing twice is one redline, two attempts.
    for (const t of [...declines, ...chargebacks]) {
      const key = `${domain}:${t.caseId}`;
      const r = redlineByCase.get(key) || {
        domain, caseId: t.caseId, attempts: [], declinedTotal: 0, chargebackTotal: 0, statusChange: null,
      };
      r.attempts.push({ casePaymentId: t.casePaymentId, amount: t.amount, kind: t.isChargeback ? "chargeback" : "declined", method: t.method?.name || null });
      if (t.isChargeback) r.chargebackTotal = round2(r.chargebackTotal + Math.abs(t.amount));
      else r.declinedTotal = round2(r.declinedTotal + t.amount);
      redlineByCase.set(key, r);
    }

    for (const t of loop.truths) {
      if (!t.needsReview) continue;
      night.review.push(`${domain} case ${t.caseId} payment ${t.casePaymentId}: ${
        t.verification.reconciles === false
          ? `Σ ours ${money(t.verification.ledgerSumForCase)} ≠ Logics ${money(t.verification.logicsPaidAmount)}`
          : `type rules disagree (first-date=${t.metricsTreatment.paymentType}, tag=${t.metricsTreatment.tagRuleSays})`}`);
    }

    // ── STAGE 2.5: attribution seed for the day's deals ──────────────────
    const deals = confirmed.filter((t) => t.paymentType === "initial");
    log(`[${domain}] ${loop.stats.cases} cases · ${confirmed.length} confirmed · ${deals.length} deal(s)`);

    await mapLimit(deals, 2, async (deal) => {
      const entry = {
        domain, caseId: deal.caseId, amount: deal.amount, tag: deal.tag?.name,
        officer: null, source: null, sourceVia: null, name: null,
      };
      try {
        const info = unwrapLogics(await client.getCaseInfo(deal.caseId));
        entry.name = `${info?.FirstName || ""} ${info?.LastName || ""}`.trim() || null;
        entry.status = info?.StatusName || null;
        entry.officer = officerByCase.get(`${domain}:${deal.caseId}`) || null;
        entry.sourceCampaignId = info?.SourceCampaignID ?? null;
        entry.source = info?.SourceName || info?.Source || null;
        if (entry.source) entry.sourceVia = "logics";

        const profile = await caseProfileRepository.findCaseProfile(domain, deal.caseId);
        if (!entry.officer && profile?.activityState?.officer?.name) entry.officer = profile.activityState.officer.name;

        // The officer fold above only sees THIS day's activities, so a deal
        // whose case was assigned earlier resolves to no officer at all —
        // measured on 2026-07-24, both deals were assigned (7/20 and 7/23)
        // and both stamped null. Logics CaseInfo carries no officer field, so
        // the case's own activity history is the only place left to look.
        // Bounded by DEALS (a handful a day), not by cases.
        if (!entry.officer) {
          try {
            const history = unwrapLogics(await client.getActivities(deal.caseId));
            const rows = Array.isArray(history) ? history : [];
            let best = null;
            for (const row of rows) {
              // Same parser the daily fold uses — one definition of what an
              // assignment line means.
              // getActivities returns Subject/ActivityType; classifyRow reads the
              // ActivityReport shape (ActivitySubject/Type). Passing the raw row
              // classified as "unclassified" and the fallback found nothing.
              const cls = classifyRow({
                ActivitySubject: row.Subject, Type: row.ActivityType,
              });
              if (cls?.kind !== "assignment" || cls.payload?.role !== "Set. Officer") continue;
              const day = String(row.CreatedDate || "").slice(0, 10);
              // Attribution AT SALE: the officer who held it when it closed,
              // never one assigned afterwards.
              if (day && day > dateKey) continue;
              if (!best || day >= best.day) best = { day, assignee: cls.payload.assignee };
            }
            if (best?.assignee) {
              entry.officer = best.assignee;
              entry.officerVia = `history:${best.day}`;
            }
          } catch { /* history is a fallback; never fail the night over it */ }
        }
        if (!entry.source && profile?.sourceName) { entry.source = profile.sourceName; entry.sourceVia = "profile"; }

        if (!entry.source) {
          // The attribution rule (Mickey 2026-07-28): "longest call on the
          // day the deal closed" — not the most recent, not the first. Pool
          // every number on the case, then pick once.
          const phones = foldCasePhones(info || {});
          const pool = [];
          for (const phone of phones.normalizedPhones) {
            const calls = await listInboundCallsForPhone(domain, phone).catch(() => []);
            for (const call of calls) {
              if (call?.sourceName) pool.push({ ...call, _phone: phone });
            }
          }
          const { pickAttributionCall } = require("./reportOpsService");
          const picked = pickAttributionCall(
            pool.map((call) => ({ ...call, startedAt: call.startTime, durationSec: call.durationSeconds, source: call.sourceName })),
            dateKey,
          );
          const chosen = picked.call || pool[0] || null;
          if (chosen?.sourceName || chosen?.source) {
            entry.source = chosen.sourceName || chosen.source;
            entry.sourceVia = `callrail:${chosen._phone}:${picked.basis || "most-recent-fallback"}`;
            if (/\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/.test(entry.source)) {
              night.review.push(`${domain} case ${deal.caseId}: source "${entry.source}" is a raw tracker label`);
            }
          }
        }
      } catch (error) {
        entry.sourceVia = `error:${String(error.message).slice(0, 60)}`;
      }
      if (!entry.source) night.review.push(`${domain} case ${deal.caseId}: DEAL WITH NO SOURCE (${money(deal.amount)})`);
      const off = entry.officer || "(unassigned)";
      night.lanes.officerCollections[off] = round2((night.lanes.officerCollections[off] || 0) + deal.amount);
      night.lanes.deals.push(entry);

      // Stamp the snapshot onto EVERY payment row for this case in this
      // run, so range reports can group by officer/source without a join
      // and without re-deriving attribution that may have moved since.
      for (const t of loop.truths) {
        if (t.caseId !== deal.caseId) continue;
        t.clientName = entry.name || t.clientName || null;
        // NEVER null over non-null. persistPaymentTruths does `$set: {...t}`,
        // so assigning null here would overwrite a GOOD snapshot on a re-run
        // whose CaseInfo/CallRail lookups happened to fail (that block catches
        // its own errors and leaves entry.source null). Attribution can only
        // ever be filled in or corrected — never erased by a bad night.
        if (entry.officer) t.officerAtSale = entry.officer;
        else if (t.officerAtSale === undefined) t.officerAtSale = null;
        if (entry.source) t.sourceAtSale = entry.source;
        else if (t.sourceAtSale === undefined) t.sourceAtSale = null;
        if (entry.sourceVia) t.sourceVia = entry.sourceVia;
        else if (t.sourceVia === undefined) t.sourceVia = null;
      }
    });

    if (apply && loop.truths.length) {
      const res = await persistPaymentTruths(loop.truths).catch((e) => {
        night.review.push(`${domain}: payment persist failed — ${e.message}`);
        return { upserted: 0 };
      });
      night.counters.paymentsPersisted += res.upserted || 0;
    }
    if (persistOnly && !apply && loop.truths.length) night.pending.truths.push(...loop.truths);
  }

  if (persistOnly) {
    // Everything with a side effect has now run. Return the same counters the
    // full pass reports so the caller can log real numbers.
    night.finishedAt = new Date().toISOString();
    night.durationMs = Date.now() - started;
    night.persistOnly = true;
    // Shapes the full path also produces, so a consumer reading either mode
    // never hits an undefined it did not expect.
    night.recordings = night.recordings || null;
    night.streams = night.streams || { streams: {}, ldByAgent: {} };
    return { night, board: null, emailData: null, text: null, attachments: [] };
  }

  // ── REDLINE JOIN: one entry per case, tied to its status change ─────────
  for (const sc of night.lanes.statusChanges.list.filter((x) => x.cls === "suspended")) {
    const key = `${sc.domain}:${sc.caseId}`;
    const existing = redlineByCase.get(key);
    if (existing) existing.statusChange = sc.to;
    else redlineByCase.set(key, { domain: sc.domain, caseId: sc.caseId, attempts: [], declinedTotal: 0, chargebackTotal: 0, statusChange: sc.to });
  }
  night.lanes.redlines = [...redlineByCase.values()]
    .map((r) => ({
      ...r,
      classification: r.attempts.length && r.statusChange ? "confirmed"
        : r.attempts.length ? "unactioned" : "status-only",
    }))
    .sort((a, b) => (b.declinedTotal + b.chargebackTotal) - (a.declinedTotal + a.chargebackTotal));
  for (const r of night.lanes.redlines) {
    if (r.classification === "unactioned") {
      night.review.push(`${r.domain} case ${r.caseId}: ${money(r.declinedTotal || r.chargebackTotal)} failed with NO status change`);
    }
  }

  // ── RECORDINGS (allow-list: callrail + phoneburner; EX never) ───────────
  const recordings = { callrail: [], phoneburner: [], notable: [], dealCalls: [], attachments: [], skipped: [] };
  try {
    const {
      listPhoneBurnerLongDials, listNotableCalls, downloadRecordings,
    } = require("./nightRecordingsService");

    // POST-DATE cases need a phone before they can be matched to a call —
    // same fold the deals use. Only today's post-date movers, so this is a
    // handful of CaseInfo pulls, not a sweep.
    const postDateCases = [];
    for (const sc of night.lanes.statusChanges.list.filter((x) => x.cls === "postdate")) {
      try {
        const client = createLogicsClient(sc.domain);
        const info = unwrapLogics(await client.getCaseInfo(sc.caseId));
        const phones = foldCasePhones(info || {});
        for (const phone of phones.normalizedPhones) {
          postDateCases.push({
            caseId: sc.caseId, domain: sc.domain, phone,
            name: `${info?.FirstName || ""} ${info?.LastName || ""}`.trim() || null,
            officer: officerByCase.get(`${sc.domain}:${sc.caseId}`) || null,
          });
        }
      } catch { /* a missing case must not cost the night */ }
    }

    // Coaching set: DEALS, POST DATES, and anything over ten minutes —
    // across CallRail AND PhoneBurner (recordings are per-agent feedback).
    let phoneBurnerClient = null;
    try {
      const { createPhoneBurnerClient, createPhoneBurnerDurableCredentialStore } = require("../../shared-integrations/src");
      const { userAccountRepository } = require("../../shared-repositories/src");
      phoneBurnerClient = createPhoneBurnerClient({
        credentialStore: createPhoneBurnerDurableCredentialStore({
          serviceEmail: String(process.env.PARALLEL_SERVICE_EMAIL || "service@taxadvocategroup.com").trim().toLowerCase(),
          credentialRepository: userAccountRepository,
        }),
        logger,
      });
    } catch { /* PhoneBurner is optional; CallRail still carries the set */ }

    recordings.notable = await listNotableCalls({
      domain: "TAG", dateKey, deals: night.lanes.deals, postDateCases,
      phoneBurnerClient, logger,
    });
    recordings.phoneburner = await listPhoneBurnerLongDials({ dateKey, limit: 5 });
    recordings.callrail = [];
    recordings.dealCalls = recordings.notable.filter((c) => c.reasons?.includes("DEAL"));
    if (attach) {
      // Attach deal calls, smallest-first so as many fit as possible; a
      // 70-minute call is ~33MB and would eat the whole message budget.
      const dl = await downloadRecordings(recordings.dealCalls, { max: 3 });
      recordings.attachments = dl.attachments;
      recordings.skipped = dl.skipped;
    }
  } catch (error) {
    night.review.push(`recordings unavailable — ${String(error.message).slice(0, 100)}`);
  }
  night.recordings = recordings;

  // ── CALL ACTIVITY BY AGENT (for the officer table) ─────────────────────
  // MAILER + BCD from the EX queues (one bounded RingCentral trickle), LD
  // from PhoneBurner's own dial records. Degrades to nothing if either is
  // unavailable — the board must not depend on the phones.
  night.streams = { streams: {}, ldByAgent: {} };
  try {
    const { readStreamConnections } = require("./mailerQueueService");
    const q = await readStreamConnections({ dateKey, maxPages: 6, logger });
    night.streams.streams = q.streams || {};
    if (q.truncated || q.rateLimited) {
      night.review.push(`queue read partial (pages=${q.pagesFetched}${q.rateLimited ? ", RATE LIMITED" : ""})`);
    }
  } catch (error) {
    night.review.push(`queue connections unavailable — ${String(error.message).slice(0, 90)}`);
  }
  try {
    const { readLdDials } = require("./nightReportService");
    const { normalizePhoneBurnerAgent } = require("./mailerQueueService");
    const ld = await readLdDials(dateKey);
    for (const [id, n] of Object.entries(ld.byAgent || {})) {
      const name = normalizePhoneBurnerAgent(id);
      night.streams.ldByAgent[name] = (night.streams.ldByAgent[name] || 0) + n;
    }
  } catch { /* LD dial detail is a nicety, not a dependency */ }

  // ── THE BOARD ───────────────────────────────────────────────────────────
  const board = await buildNightReport({ dateKey, night, apply });
  const text = renderNightReportText(board);
  const emailData = buildNightEmailData(board);
  night.durationMs = Date.now() - started;

  return { night, board, text, emailData, attachments: recordings.attachments };
}

module.exports = { fmtLogicsDate, pacificDateKey, runNightPass };
