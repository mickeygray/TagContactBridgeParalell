"use strict";

// The lean marketing read — the ONLY read path for the spartan metrics
// workspace and the (future) nightly report.
//
// Doctrine (2026-07-24): no noise. The board shows ACTIVE sources only.
//   - Active mail pieces render as their own rows (exact tracker names).
//   - Every other marketing tracker that catches a stray call rolls up
//     into ONE "Aged" row.
//   - Operations trackers (client contact, review requests, transcripts,
//     follow-up texts) are not marketing — excluded entirely.
//   - Responses = firstTimeCallers (CallRail originations). Repeat calls
//     are activity, not response.
// Declared inputs: DailyCallStat (fed solely by callrailDailyStatSyncService),
// SpendEntry (mail sheet), PaymentLedger (signed payments grouped by case),
// and CaseProfile (canonical case attribution). Nothing else. No roulette,
// no legacy fallback.

const mongoose = require("mongoose");
const DailyCallStat = require("../../shared-models/src/DailyCallStat");
const SpendEntry = require("../../shared-models/src/SpendEntry");
const {
  attributePaymentsToSaleWindow,
  casePaymentKey,
  groupSuccessfulPaymentsByCase,
  isInitialPayment,
  isMissingDealSource,
  isSuccessfulPayment,
  rawCsvDealSource,
  resolveDealSource,
  rollupCasePaymentGroups,
} = require("./simpleDealMathService");
const { buildTimezoneDateWindow } = require("./timezoneDateWindowService");
const { isBranchedDataLeadSource } = require("./leadSourceBranchService");

const SIMPLE_MARKETING_SCOPE = "ALL";
const PACIFIC_TIME_ZONE = "America/Los_Angeles";

// ACTIVE = the mail sheet decides (doctrine: "mail is the mail sheet").
// A piece is active when it has sheet spend within the window; stop
// dropping it and it ages out automatically ~5 weeks later; a new piece
// on the sheet self-registers. Nobody edits code when campaigns rotate.
const ACTIVE_SPEND_WINDOW_DAYS = 35;
const ACTIVE_CACHE_TTL_MS = 10 * 60 * 1000;

function simpleBadRequest(message, code) {
  const error = new Error(message);
  error.status = 400;
  error.code = code;
  return error;
}

function normalizeSimpleMarketingDomain(domain) {
  const normalized = String(domain || "").trim().toUpperCase();
  if (normalized !== SIMPLE_MARKETING_SCOPE) {
    throw simpleBadRequest(
      "Simple marketing metrics currently require the explicit ALL scope",
      "SIMPLE_MARKETING_SCOPE_REQUIRED",
    );
  }
  return normalized;
}

function normalizeStrictDateKey(value, name) {
  const dateKey = String(value || "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) throw simpleBadRequest(`${name} must use YYYY-MM-DD`, "INVALID_METRICS_DATE");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    throw simpleBadRequest(`${name} is not a calendar date`, "INVALID_METRICS_DATE");
  }
  return dateKey;
}

function activeMigrationFilter() {
  return { active: { $ne: false } };
}

function buildPacificDateRange({ from, to } = {}) {
  const first = normalizeStrictDateKey(from, "from");
  const last = normalizeStrictDateKey(to, "to");
  if (first > last) {
    throw simpleBadRequest("from must not be after to", "INVALID_METRICS_RANGE");
  }
  const startWindow = buildTimezoneDateWindow(first, PACIFIC_TIME_ZONE);
  const endWindow = buildTimezoneDateWindow(last, PACIFIC_TIME_ZONE);
  return {
    start: startWindow.start,
    endExclusive: new Date(endWindow.end.getTime() + 1),
  };
}

// Fallback seeds if the sheet feed is empty/unreachable (also the July
// 2026 roster, kept for tests).
function currentPacificDateKey(now = new Date()) {
  const instant = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(instant.getTime())) {
    throw simpleBadRequest("now must be a valid instant", "INVALID_METRICS_INSTANT");
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: PACIFIC_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

const ACTIVE_MAIL_PIECES = [
  "3rd Day (Pink) Urgent Third State 800-921-9263",
  "Urgent Third State",
  "Affordability Federal",
];

let activeCache = { at: 0, pieces: null, sheetToCanonical: null };

function tokenize(name) {
  return new Set(
    String(name || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 2 && !/^\d+$/.test(token)),
  );
}

function tokenOverlap(a, b) {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (!setA.size || !setB.size) return 0;
  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared += 1;
  // Symmetric containment (creep-pass critical): auto-map ONLY when the
  // token sets are identical — min-normalization scored subset names 1.0
  // and would have merged "Urgent Third Postcard State" into "Urgent
  // Third State". Non-identical variants need an explicit SOURCE_ALIAS.
  return shared === setA.size && shared === setB.size ? 1 : 0;
}

// Resolve the active roster: sheet sources with recent mail spend, each
// mapped to its CallRail tracker name (canonical label) via explicit
// SOURCE_ALIASES first, then exact match, then token overlap against
// trackers seen recently in DailyCallStat.
async function resolveActivePieces() {
  if (activeCache.pieces && Date.now() - activeCache.at < ACTIVE_CACHE_TTL_MS) {
    return activeCache;
  }
  const windowStart = new Date(Date.now() - ACTIVE_SPEND_WINDOW_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const windowEnd = currentPacificDateKey();
  try {
    const [spendSources, recentTrackers] = await Promise.all([
      SpendEntry.distinct("source", {
        ...activeMigrationFilter(),
        date: { $gte: windowStart, $lte: windowEnd },
        channel: { $ne: "lead-data" },
      }),
      DailyCallStat.distinct("piece", {
        syncSource: "callrail-direct",
        ...activeMigrationFilter(),
        date: { $gte: windowStart, $lte: windowEnd },
      }),
    ]);
    const pieces = new Set();
    const sheetToCanonical = new Map();
    for (const sheetName of spendSources) {
      const name = String(sheetName || "").trim();
      if (!name) continue;
      let canonical = SOURCE_ALIASES[name] || null;
      if (!canonical) {
        canonical = recentTrackers.find((tracker) => tracker.toLowerCase() === name.toLowerCase()) || null;
      }
      if (!canonical) {
        let best = null;
        let bestScore = 0;
        for (const tracker of recentTrackers) {
          const score = tokenOverlap(name, tracker);
          if (score > bestScore) { best = tracker; bestScore = score; }
        }
        if (bestScore >= 0.75) canonical = best;
      }
      const label = canonical || name;
      pieces.add(label);
      sheetToCanonical.set(name, label);
    }
    if (pieces.size === 0) for (const seed of ACTIVE_MAIL_PIECES) pieces.add(seed);
    activeCache = { at: Date.now(), pieces, sheetToCanonical };
  } catch {
    activeCache = {
      at: Date.now(),
      pieces: new Set(ACTIVE_MAIL_PIECES),
      sheetToCanonical: new Map(Object.entries(SOURCE_ALIASES)),
    };
  }
  return activeCache;
}

// The mail sheet and CallRail name the same campaign differently — map
// sheet source names onto the canonical (CallRail tracker) piece name.
const SOURCE_ALIASES = {
  // mail-sheet names → CallRail tracker labels.
  //
  // Mickey renamed the pink tracker on 2026-07-27 to drop the embedded
  // 800 number, so the CANONICAL label is now the clean one. The numbered
  // variant stays mapped so historical rows fold into the same piece
  // instead of splitting the by-source rollup across two labels.
  "Urgent Third Pink State": "3rd Day (Pink) Urgent Third State",
  "3rd Day (Pink) Urgent Third State 800-921-9263": "3rd Day (Pink) Urgent Third State",
  // The MAIL SHEET's own job name for that piece (Mickey 2026-07-27:
  // "3rd notice pink") — the sheet says "3rd Notice Pink", the mailer
  // config resolves it to "Urgent Third Pink State", and CallRail calls it
  // "3rd Day (Pink) …". Three names, one piece.
  "3rd Notice Pink": "3rd Day (Pink) Urgent Third State",
  // LOGICS display names → tracker labels (creep-pass critical 2026-07-24:
  // the source-writer stamps SourceID 73/74 in Logics; the payments CSV
  // then carries Logics' own names — without these aliases every
  // correctly-attributed deal would land in Aged on the next import).
  "Urgent Third White": "Urgent Third State",
  "Urgent Third Pink": "3rd Day (Pink) Urgent Third State",
  // Same vendor, tenant-specific display names (Mickey 2026-07-24): the
  // vendor calls origination "OG", and what WYNN's Logics names "BCD" is
  // "BCD - OG" in TAG's. One family, one label.
  "BCD - OG": "BCD",
};

// Non-marketing trackers: operations traffic, never counted anywhere.
const EXCLUDED_PIECE_PATTERNS = [
  /client contact/i,
  /review request/i,
  /transcripts/i,
  /f\/u text/i,
  /yellow line text/i,
  /prospect text message/i,
];

const AGED_LABEL = "Aged";
const LD_LABEL = "LD";

function classifyPiece(piece, channel = null, context = null) {
  const raw = String(piece || "").trim();
  const name = SOURCE_ALIASES[raw] || context?.sheetToCanonical?.get(raw) || raw;
  if (String(channel || "") === "lead-data" || /^LD /.test(name)) {
    return { kind: "ld", label: LD_LABEL };
  }
  // Branched data-lead sources ("ABC ST"/"ABC FD", phase 6 forward-only)
  // are LEAD DATA — never a mailer, never "Aged". Bare "ABC" stays generic
  // (pre-cutover book) by design.
  if (isBranchedDataLeadSource(name)) {
    return { kind: "ld", label: LD_LABEL };
  }
  const activeSet = context?.pieces || new Set(ACTIVE_MAIL_PIECES);
  if (activeSet.has(name)) return { kind: "active", label: name };
  if (EXCLUDED_PIECE_PATTERNS.some((pattern) => pattern.test(name))) {
    return { kind: "excluded", label: name };
  }
  return { kind: "aged", label: AGED_LABEL };
}

function emptyRow(label) {
  return {
    source: label,
    responses: 0,
    calls: 0,
    over5: 0,
    spend: 0,
    pieces: 0,
    deals: 0,
    initialsNet: 0,
    totalCollected: 0,
    activeDays: new Set(),
  };
}

function buildSimpleTotals(rows = []) {
  return rows.reduce(
    (sum, row) => {
      return {
        ...sum,
        responses:
          sum.responses + (row.source === LD_LABEL ? 0 : Number(row.responses || 0)),
        ldLeads:
          sum.ldLeads + (row.source === LD_LABEL ? Number(row.responses || 0) : 0),
        calls: sum.calls + Number(row.calls || 0),
        spend: Math.round((sum.spend + Number(row.spend || 0)) * 100) / 100,
        deals: sum.deals + Number(row.deals || 0),
        initialsNet:
          Math.round((sum.initialsNet + Number(row.initialsNet || 0)) * 100) / 100,
        totalCollected:
          Math.round((sum.totalCollected + Number(row.totalCollected || 0)) * 100) / 100,
      };
    },
    {
      responses: 0,
      calls: 0,
      spend: 0,
      ldLeads: 0,
      deals: 0,
      initialsNet: 0,
      totalCollected: 0,
    },
  );
}
const PAYMENT_ROLLUP_PROJECTION = Object.freeze({
  caseId: 1,
  domain: 1,
  amount: 1,
  paymentType: 1,
  paymentDateKey: 1,
  transactionStatus: 1,
  metricsTreatment: 1,
  raw: 1,
});

// Initial money attributes to the month of the SALE, so a window needs two
// things the plain date range does not give it:
//   - initial rows that landed AFTER the window but belong to a deal sold
//     inside it (a payment-plan installment on the first invoice, or a
//     chargeback), and
//   - the first-initial date of every initial row sitting inside the window,
//     since it may belong to an earlier month's sale.
// Only successful initial rows participate; recurring revenue is untouched
// and stays in the month it was collected.
async function loadSaleMonthAttribution({ ledger, windowRows, to }) {
  const laterInitials = await ledger
    .find({
      paymentDateKey: { $gt: to },
      transactionStatus: "SUCCESS",
      paymentType: "initial",
    })
    .project(PAYMENT_ROLLUP_PROJECTION)
    .toArray();

  const initialRows = [
    ...windowRows.filter((row) => isSuccessfulPayment(row) && isInitialPayment(row)),
    ...laterInitials,
  ];
  // Vintage split (Mickey 2026-07-27): recurring collected this month is
  // reported as "from this month's clients" vs "from older clients" — which
  // needs the first-initial date for RECURRING rows' cases too.
  const recurringCases = windowRows.filter(
    (row) => isSuccessfulPayment(row) && !isInitialPayment(row),
  );
  if (!initialRows.length && !recurringCases.length) {
    return { laterInitials, firstInitialDateByCase: new Map() };
  }

  const initialCasePairs = [
    ...new Map(
      [...initialRows, ...recurringCases].map((row) => [
        casePaymentKey(row.domain, row.caseId),
        { domain: String(row.domain || "").toUpperCase(), caseId: Number(row.caseId) },
      ]),
    ).values(),
  ];
  const firstInitials = await ledger
    .find({
      $or: initialCasePairs,
      transactionStatus: "SUCCESS",
      paymentType: "initial",
      amount: { $gt: 0 },
    })
    .project({ domain: 1, caseId: 1, paymentDateKey: 1 })
    .toArray();

  // Earliest POSITIVE initial per case is when that client was sold.
  const firstInitialDateByCase = new Map();
  for (const row of firstInitials) {
    const key = casePaymentKey(row.domain, row.caseId);
    const current = firstInitialDateByCase.get(key);
    if (!current || String(row.paymentDateKey) < current) {
      firstInitialDateByCase.set(key, String(row.paymentDateKey));
    }
  }
  return { laterInitials, firstInitialDateByCase };
}

async function loadSimplePaymentRollup({ from, to, activeContext }) {
  const ledger = mongoose.connection.db.collection("controlplanepaymentledgers");
  const windowRows = await ledger
    .find({
      paymentDateKey: { $gte: from, $lte: to },
      transactionStatus: "SUCCESS",
    })
    .project(PAYMENT_ROLLUP_PROJECTION)
    .toArray();

  const { laterInitials, firstInitialDateByCase } = await loadSaleMonthAttribution({
    ledger,
    windowRows,
    to,
  });
  const {
    rows: paymentRows,
    pulledIn,
    pushedOut,
  } = attributePaymentsToSaleWindow({
    rows: [...windowRows, ...laterInitials],
    firstInitialDateByCase,
    from,
    to,
  });

  const casePairs = [
    ...new Map(
      paymentRows.map((row) => [
        casePaymentKey(row.domain, row.caseId),
        { domain: String(row.domain || "").toUpperCase(), caseId: Number(row.caseId) },
      ]),
    ).values(),
  ];
  const profiles = casePairs.length
    ? await mongoose.connection.db
        .collection("controlplanecaseprofiles")
        .find({ $or: casePairs })
        .project({
          caseId: 1,
          domain: 1,
          sourceName: 1,
          sourceChannel: 1,
        })
        .toArray()
    : [];
  return {
    ...buildSimpleNightlyPaymentRollup({
      dayPayments: paymentRows,
      cashPayments: windowRows,
      profiles,
      activeContext,
      window: { from, to, firstInitialDateByCase },
    }),
    // What sale-month attribution moved (installments and chargebacks), so
    // the board and the nightly email can say "June restated" instead of
    // silently changing a closed number.
    chargebackRestatement: { pulledIn, pushedOut },
  };
}


async function buildSimpleMarketingSummary({ domain, from, to } = {}) {
  const scope = normalizeSimpleMarketingDomain(domain);
  const { start: rangeStart, endExclusive: rangeEndExclusive } = buildPacificDateRange({ from, to });

  // The mail sheet decides what's active — resolved live (10-min cache).
  const activeContext = await resolveActivePieces();
  const rowsByLabel = new Map();
  for (const label of activeContext.pieces) rowsByLabel.set(label, emptyRow(label));

  // Only rows written by callrailDailyStatSyncService count — the marker
  // keeps legacy roulette-era rows in this collection out of the board.
  const stats = await DailyCallStat.find({
    date: { $gte: from, $lte: to },
    syncSource: "callrail-direct",
    ...activeMigrationFilter(),
  })
    .select("date piece totalCalls firstTimeCallers callsOver5")
    .lean();

  let excludedCalls = 0;
  for (const stat of stats) {
    const { kind, label } = classifyPiece(stat.piece, null, activeContext);
    if (kind === "excluded") {
      excludedCalls += Number(stat.totalCalls || 0);
      continue;
    }
    let row = rowsByLabel.get(label);
    if (!row) {
      row = emptyRow(label);
      rowsByLabel.set(label, row);
    }
    row.responses += Number(stat.firstTimeCallers || 0);
    row.calls += Number(stat.totalCalls || 0);
    row.over5 += Number(stat.callsOver5 || 0);
    row.activeDays.add(stat.date);
  }

  // Mail spend joins by the same active-piece names once SpendEntry rows
  // exist; unmatched spend sources aggregate into their own labels so a
  // live spend feed is immediately visible rather than silently dropped.
  const spendRows = await SpendEntry.find({
    date: { $gte: from, $lte: to },
    ...activeMigrationFilter(),
  })
    .select("source channel spend cost pieces")
    .lean();
  for (const entry of spendRows) {
    const { kind, label } = classifyPiece(entry.source, entry.channel, activeContext);
    // LD spend is NOT taken from SpendEntry (the materializer undercounts
    // via case classification) — the LD row is computed below from the
    // delivery queue directly. Skip lead-data spend rows entirely.
    if (kind === "excluded" || kind === "ld") continue;
    let row = rowsByLabel.get(label);
    if (!row) {
      row = emptyRow(label);
      rowsByLabel.set(label, row);
    }
    row.spend += Number(entry.spend || entry.cost || 0);
    row.pieces += Number(entry.pieces || 0);
  }

  // LD doctrine (2026-07-27): leads = the delivery queue itself —
  // leaddeliveryitems received in range. The LD row's "responses" ARE its
  // leads: units of demand. COST IS NOT COMPUTED HERE — "LD spend can be
  // CPL in Logics, no need to do the multiply by 3" (Mickey). Per-lead
  // cost lives on the Logics source, same as ABC ST/FD.
  const ldLeadCount = await mongoose.connection.db
    .collection("leaddeliveryitems")
    .countDocuments({ receivedAt: { $gte: rangeStart, $lt: rangeEndExclusive } });

  // LD calls = the outbound work on LD leads: every PhoneBurner dial plus
  // the CX-era dials stamped lead-distribution. CX dials WITHOUT that
  // stamp were aged-lead work (the "couple hundred") and count under
  // Aged — a permanent classification rule, not a one-time patch.
  const callLogs = mongoose.connection.db.collection("controlplanecalllogs");
  const outboundInRange = {
    callStartTime: { $gte: rangeStart, $lt: rangeEndExclusive },
    direction: "outbound",
  };
  const [pbCalls, cxLdCalls, cxAgedCalls, pbOver5, cxLdOver5, cxAgedOver5] = await Promise.all([
    callLogs.countDocuments({ ...outboundInRange, platform: "phoneburner" }),
    callLogs.countDocuments({ ...outboundInRange, platform: "cx", sourceChannel: "lead-distribution" }),
    callLogs.countDocuments({ ...outboundInRange, platform: "cx", sourceChannel: { $ne: "lead-distribution" } }),
    callLogs.countDocuments({ ...outboundInRange, platform: "phoneburner", durationSec: { $gte: 300 } }),
    callLogs.countDocuments({ ...outboundInRange, platform: "cx", sourceChannel: "lead-distribution", durationSec: { $gte: 300 } }),
    callLogs.countDocuments({ ...outboundInRange, platform: "cx", sourceChannel: { $ne: "lead-distribution" }, durationSec: { $gte: 300 } }),
  ]);

  if (ldLeadCount > 0 || pbCalls + cxLdCalls > 0) {
    const ldRow = emptyRow(LD_LABEL);
    ldRow.responses = ldLeadCount;
    ldRow.calls = pbCalls + cxLdCalls;
    ldRow.over5 = pbOver5 + cxLdOver5;
    ldRow.spend = 0; // CPL lives in Logics — never estimated here.
    rowsByLabel.set(LD_LABEL, ldRow);
  }
  if (cxAgedCalls > 0) {
    let agedRow = rowsByLabel.get(AGED_LABEL);
    if (!agedRow) {
      agedRow = emptyRow(AGED_LABEL);
      rowsByLabel.set(AGED_LABEL, agedRow);
    }
    agedRow.calls += cxAgedCalls;
    agedRow.over5 += cxAgedOver5;
  }

  const paymentRollup = await loadSimplePaymentRollup({
    from,
    to,
    activeContext,
  });
  for (const [label, bucket] of paymentRollup.initialsBySource) {
    let row = rowsByLabel.get(label);
    if (!row) {
      row = emptyRow(label);
      rowsByLabel.set(label, row);
    }
    row.deals += Number(bucket.count || 0);
    row.initialsNet += Number(bucket.amount || 0);
    row.totalCollected += Number(bucket.totalCollected || 0);
  }

  const rows = [...rowsByLabel.values()]
    .map((row) => ({
      source: row.source,
      responses: row.responses,
      calls: row.calls,
      over5: row.over5,
      spend: Math.round(row.spend * 100) / 100,
      pieces: row.pieces,
      deals: row.deals,
      initialsNet: Math.round(row.initialsNet * 100) / 100,
      totalCollected: Math.round(row.totalCollected * 100) / 100,
      activeDays: row.activeDays.size,
      costPerResponse: row.responses > 0 && row.spend > 0
        ? Math.round((row.spend / row.responses) * 100) / 100
        : null,
    }))
    .filter(
      (row) =>
        row.responses > 0 ||
        row.calls > 0 ||
        row.spend > 0 ||
        row.deals !== 0 ||
        row.totalCollected !== 0,
    )
    .sort((a, b) => {
      // Active mailers (by responses) → LD → Aged last.
      const rank = (row) => (row.source === AGED_LABEL ? 2 : row.source === LD_LABEL ? 1 : 0);
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      return b.responses - a.responses;
    });

  // Headline totals: MAIL responses only — LD leads are a different unit
  // and get their own number instead of polluting the response count.
  const totals = buildSimpleTotals(rows);
  const mailSpend = Math.round((totals.spend - (rowsByLabel.get(LD_LABEL)?.spend || 0)) * 100) / 100;

  // Feed freshness — the loop's self-check. Stale feeds must be VISIBLE
  // on the board, not discovered weeks later (the old system coasted on
  // an April-dead pipeline for three months without anyone knowing).
  const [callrailLatest, spendLatest, phoneBurnerLatest, paymentsLatest] = await Promise.all([
    DailyCallStat.findOne({
      syncSource: "callrail-direct",
      ...activeMigrationFilter(),
      date: { $lte: currentPacificDateKey() },
    })
      .sort({ date: -1, syncedAt: -1 })
      .select("syncedAt date")
      .lean(),
    SpendEntry.findOne({
      ...activeMigrationFilter(),
      date: { $lte: currentPacificDateKey() },
    })
      .sort({ date: -1, syncedAt: -1, updatedAt: -1 })
      .select("syncedAt updatedAt date")
      .lean(),
    callLogs
      .find({ platform: "phoneburner", direction: "outbound" })
      .sort({ callEndTime: -1, callStartTime: -1 })
      .limit(1)
      .project({ callEndTime: 1, callStartTime: 1 })
      .next(),
    mongoose.connection.db
      .collection("controlplanepaymentledgers")
      .find({ authoritativeAt: { $ne: null } })
      .sort({ authoritativeAt: -1 })
      .limit(1)
      .project({ authoritativeAt: 1, authoritativeSource: 1 })
      .next(),
  ]);

  return {
    domain: scope,
    from,
    to,
    rows,
    totals: {
      ...totals,
      paymentsCount: paymentRollup.totals.transactionCount,
      multiplePositiveInitialCases: paymentRollup.totals.multiplePositiveInitialCases,
      // Ties to the bank. totalCollected is sale-attributed and will differ
      // whenever a chargeback or first-invoice installment crosses a month.
      cashCollected: paymentRollup.totals.cashCollected,
      cashBreakdown: paymentRollup.totals.cashBreakdown,
      cashByOfficer: paymentRollup.totals.cashByOfficer,
      costPerResponse: totals.responses > 0 && mailSpend > 0
        ? Math.round((mailSpend / totals.responses) * 100) / 100
        : null,
    },
    excludedCalls,
    paymentAlerts: paymentRollup.alerts,
    // Surfaced so a restated month is visible rather than silent: a closed
    // month's deal count can change when an old sale is charged back later.
    chargebackRestatement: paymentRollup.chargebackRestatement,
    // WYNN sells off lead data, TAG off the mail pieces — a merged board
    // hides that, and the board cannot scope to one domain (CallRail is a
    // single cross-company tenant, so calls/responses have no domain).
    byDomain: paymentRollup.byDomain,
    dealsBySourceByDomain: Object.fromEntries(
      [...paymentRollup.initialsBySourceByDomain.entries()].map(([domainKey, buckets]) => [
        domainKey,
        [...buckets.entries()]
          .map(([source, bucket]) => ({ source, ...bucket }))
          .filter((row) => row.count > 0 || row.amount !== 0)
          .sort((left, right) => right.amount - left.amount),
      ]),
    ),
    activePieces: [...activeContext.pieces],
    feeds: {
      callrail: {
        lastSyncedAt: callrailLatest?.syncedAt || null,
        latestDay: callrailLatest?.date || null,
      },
      spend: {
        lastSyncedAt: spendLatest?.syncedAt || spendLatest?.updatedAt || null,
        latestDay: spendLatest?.date || null,
      },
      phoneburner: {
        lastProjectedCallAt: phoneBurnerLatest?.callEndTime || phoneBurnerLatest?.callStartTime || null,
      },
      payments: {
        lastReconciledAt: paymentsLatest?.authoritativeAt || null,
        lastSource: paymentsLatest?.authoritativeSource || null,
      },
    },
  };
}

/**
 * One day, board-simple — the nightly email's data. Spend / calls /
 * initials / total for the day, with calls AND initials split by source.
 * Deal count is case-based: successful initial transactions on one
 * domain+case net to +1, 0, or -1. Money remains the signed transaction
 * sum.
 */
function buildSimpleNightlyPaymentRollup({
  dayPayments = [],
  // TRUE CASH for the window — the rows whose payment date actually falls
  // inside it, BEFORE sale-month attribution moves anything.
  //
  // Finance needs a number that ties to the bank; marketing needs deals
  // credited to the piece that sold them. Those are different numbers the
  // moment a chargeback or a first-invoice installment crosses a month
  // boundary, so the board must carry BOTH rather than a hybrid that
  // reconciles to neither. Defaults to dayPayments when no separate cash
  // set is supplied (nothing to reconcile).
  cashPayments = null,
  profiles = [],
  activeContext = null,
  // { from, to, firstInitialDateByCase } — enables the recurring vintage
  // split; omit and recurring lands in recurringUnknownVintage.
  window = null,
} = {}) {
  const groups = groupSuccessfulPaymentsByCase(dayPayments);
  const totals = rollupCasePaymentGroups(groups);

  const cashRows = (Array.isArray(cashPayments) ? cashPayments : dayPayments)
    .filter(isSuccessfulPayment);
  let cashCents = 0;
  const cashByDomain = new Map();
  // "what we made, what of it was new, what of it was recurring from this
  // month, what of it was recurring from an older month" (Mickey
  // 2026-07-27) — CASH basis, vintage decided by the case's first initial.
  const breakdown = { initialCents: 0, recurringNewCents: 0, recurringBackCents: 0, recurringUnknownCents: 0 };
  const officerCents = new Map();
  for (const row of cashRows) {
    const cents = Math.round(Number(row.amount || 0) * 100);
    cashCents += cents;
    const domain = String(row.domain || "").trim().toUpperCase();
    cashByDomain.set(domain, (cashByDomain.get(domain) || 0) + cents);

    const officer = String(row.raw?.csv?.officer || "").trim() || "(unattributed)";
    officerCents.set(officer, (officerCents.get(officer) || 0) + cents);

    if (isInitialPayment(row)) {
      breakdown.initialCents += cents;
      continue;
    }
    const soldOn = window?.firstInitialDateByCase?.get?.(casePaymentKey(row.domain, row.caseId)) || null;
    if (!soldOn) breakdown.recurringUnknownCents += cents;
    else if (window?.from && soldOn >= window.from && soldOn <= window.to) breakdown.recurringNewCents += cents;
    else breakdown.recurringBackCents += cents;
  }
  totals.cashCollected = cashCents / 100;
  totals.cashBreakdown = {
    initial: breakdown.initialCents / 100,
    recurringFromThisMonth: breakdown.recurringNewCents / 100,
    recurringFromOlderMonths: breakdown.recurringBackCents / 100,
    recurringUnknownVintage: breakdown.recurringUnknownCents / 100,
  };
  totals.cashByOfficer = [...officerCents.entries()]
    .map(([officer, cents]) => ({ officer, cash: cents / 100 }))
    .sort((left, right) => right.cash - left.cash);

  // Per-domain money. WYNN and TAG are different businesses — TAG sells off
  // the mail pieces, WYNN off lead data — and a merged board hides that.
  const byDomain = new Map();
  const domainRow = (domain) => {
    if (!byDomain.has(domain)) {
      byDomain.set(domain, { domain, deals: 0, initialsNet: 0, cashCollected: 0 });
    }
    return byDomain.get(domain);
  };
  for (const group of groups) {
    const row = domainRow(String(group.domain || "").trim().toUpperCase());
    row.deals += Number(group.initialDealCount || 0);
    row.initialsNet = Math.round((row.initialsNet + Number(group.initialAmount || 0)) * 100) / 100;
  }
  for (const [domain, cents] of cashByDomain) domainRow(domain).cashCollected = cents / 100;
  const profileByCase = new Map();
  for (const profile of profiles) {
    profileByCase.set(casePaymentKey(profile.domain, profile.caseId), profile);
  }

  const treatmentSourceByCase = new Map();
  const paymentSourceByCase = new Map();
  for (const payment of dayPayments) {
    const key = casePaymentKey(payment.domain, payment.caseId);
    const reportingBucket = payment.metricsTreatment?.reportingBucket || null;
    if (!isMissingDealSource(reportingBucket) && !treatmentSourceByCase.has(key)) {
      treatmentSourceByCase.set(key, reportingBucket);
    }
    const sourceName = rawCsvDealSource(payment);
    if (!isMissingDealSource(sourceName) && !paymentSourceByCase.has(key)) {
      paymentSourceByCase.set(key, sourceName);
    }
  }

  const initialsBySource = new Map();
  const initialsBySourceByDomain = new Map();
  const alerts = [];
  for (const group of groups) {

    const profile = profileByCase.get(group.key) || null;
    const source = resolveDealSource({
      manualSource: treatmentSourceByCase.get(group.key) || null,
      profileSource: profile?.sourceName || null,
      paymentSource: paymentSourceByCase.get(group.key) || null,
    });

    let label = "Unattributed";
    if (!source.missing) {
      const sourceChannel = source.attributionPath === "profile"
        ? profile?.sourceChannel || null
        : null;
      const classified = classifyPiece(source.sourceName, sourceChannel, activeContext);
      label = classified.kind === "excluded" ? "Unattributed" : classified.label;
    }

    const bucket = initialsBySource.get(label) || {
      count: 0,
      amount: 0,
      totalCollected: 0,
    };
    bucket.count += group.initialDealCount;
    bucket.amount = Math.round((bucket.amount + group.initialAmount) * 100) / 100;
    bucket.totalCollected =
      Math.round((bucket.totalCollected + group.totalAmount) * 100) / 100;
    initialsBySource.set(label, bucket);

    // Same buckets, per company — the WYNN-only email reads its own slice.
    const groupDomain = String(group.domain || "").trim().toUpperCase();
    if (!initialsBySourceByDomain.has(groupDomain)) {
      initialsBySourceByDomain.set(groupDomain, new Map());
    }
    const domainBuckets = initialsBySourceByDomain.get(groupDomain);
    const domainBucket = domainBuckets.get(label) || { count: 0, amount: 0 };
    domainBucket.count += group.initialDealCount;
    domainBucket.amount = Math.round((domainBucket.amount + group.initialAmount) * 100) / 100;
    domainBuckets.set(label, domainBucket);

    for (const type of group.alerts) {
      alerts.push({ type, domain: group.domain, caseId: group.caseId });
    }
  }

  return {
    initialsBySource,
    initialsBySourceByDomain,
    alerts,
    totals,
    byDomain: [...byDomain.values()],
  };
}

async function buildSimpleNightlySummary({ dateKey, domain = SIMPLE_MARKETING_SCOPE } = {}) {
  if (!dateKey) throw new Error("buildSimpleNightlySummary requires { dateKey }");
  const day = await buildSimpleMarketingSummary({ domain, from: dateKey, to: dateKey });
  // Merge initials into the day's source rows (calls already split there).
  const rows = day.rows.map((row) => ({
    ...row,
    initialsCount: Number(row.deals || 0),
    initialsAmount: Number(row.initialsNet || 0),
  }));

  return {
    dateKey,
    rows,
    totals: {
      spend: day.totals.spend,
      uniqueLeads: day.totals.responses,
      totalCalls: day.totals.calls,
      ldLeads: day.totals.ldLeads,
      initialsCount: day.totals.deals,
      initialsNet: day.totals.initialsNet,
      cashCollected: day.totals.cashCollected,
      cashBreakdown: day.totals.cashBreakdown,
      cashByOfficer: day.totals.cashByOfficer,
      over5: day.rows.reduce((sum, row) => sum + Number(row.over5 || 0), 0),
      totalCollected: day.totals.totalCollected,
      paymentsCount: day.totals.paymentsCount,
      multiplePositiveInitialCases: day.totals.multiplePositiveInitialCases,
    },
    paymentAlerts: day.paymentAlerts,
    // A chargeback landing today against an earlier day's sale is removed
    // from today and restated back to the day that booked it — say so in
    // the email rather than letting today's initials quietly drop.
    chargebackRestatement: day.chargebackRestatement,
    byDomain: day.byDomain,
    dealsBySourceByDomain: day.dealsBySourceByDomain,
    feeds: day.feeds,
  };
}
// The card-chasing list: payments that did NOT process in the window.
//
// Replaces the legacy financial email's "Payments that didn't process
// today" section (retired 2026-07-27). That version merged a Parallel feed
// with a legacy-mirror feed and deduped on (caseId, paymentDate). It needs
// neither now: the daily sheet ingests failed/declined rows straight into
// PaymentLedger, so non-SUCCESS rows in the window ARE the list, from one
// source, already deduped by casePaymentId.
//
// Money doctrine unchanged: these rows never touch a dollar total. They
// live in the email BODY only — CSVs stay SUCCESS-only ROI reports.
async function listFailedPayments({ from, to, limit = 50 } = {}) {
  if (!from || !to) throw new Error("listFailedPayments requires { from, to }");
  const rows = await mongoose.connection.db
    .collection("controlplanepaymentledgers")
    .find({
      paymentDateKey: { $gte: String(from), $lte: String(to) },
      transactionStatus: { $nin: [null, "", "SUCCESS"] },
    })
    .project({
      domain: 1, caseId: 1, amount: 1, paymentDateKey: 1,
      paymentType: 1, transactionStatus: 1, raw: 1,
    })
    .sort({ paymentDateKey: -1, amount: -1 })
    .limit(Math.max(1, Number(limit) || 50))
    .toArray();
  return rows.map((row) => ({
    domain: row.domain,
    caseId: row.caseId,
    client: row.raw?.csv?.client || null,
    officer: row.raw?.csv?.officer || null,
    amount: Number(row.amount || 0),
    dateKey: row.paymentDateKey,
    paymentType: row.paymentType,
    status: row.transactionStatus,
  }));
}

// "When I say packaging the long calls we generate a url to listen to a
// specific call over a specific amount of time" (Mickey, 2026-07-27).
// Listen links come from the recording archive (Drive); calls whose
// archive hasn't completed are listed as pending rather than dropped.
//
// RULING (Mickey, 2026-07-27): "ex is dangerous. so recordings are
// callrail or phoneburner only." EX rows are all-day session legs — their
// recordings capture everything an agent said between calls, and they must
// NEVER be surfaced or linked anywhere. Enforced as an ALLOW-LIST, not a
// deny-list: a new platform stays unsurfaced until it is deliberately
// added here. (Measured 2026-07-20..27: 539 of 575 5m+ rows were EX, 430
// with Drive links — that was the exposure.)
const LONG_CALL_RECORDING_PLATFORMS = Object.freeze(["phoneburner", "callrail"]);

function buildLongCallFilter({ start, endExclusive, minDurationSec = 300 } = {}) {
  return {
    callStartTime: { $gte: start, $lt: endExclusive },
    direction: "outbound",
    platform: { $in: [...LONG_CALL_RECORDING_PLATFORMS] },
    durationSec: { $gte: Math.max(60, Number(minDurationSec) || 300) },
  };
}

async function listLongCalls({ dateKey, minDurationSec = 300, limit = 15 } = {}) {
  if (!dateKey) throw new Error("listLongCalls requires { dateKey }");
  const { start, endExclusive } = buildPacificDateRange({ from: dateKey, to: dateKey });
  const rows = await mongoose.connection.db
    .collection("controlplanecalllogs")
    .find(buildLongCallFilter({ start, endExclusive, minDurationSec }))
    .project({
      agentName: 1,
      durationSec: 1,
      platform: 1,
      contactName: 1,
      caseId: 1,
      domain: 1,
      normalizedPhone: 1,
      "recordingArchive.status": 1,
      "recordingArchive.driveWebViewLink": 1,
      "recordingArchive.sourceUri": 1,
    })
    .sort({ durationSec: -1 })
    .limit(Math.max(1, Number(limit) || 15))
    .toArray();
  return rows.map(buildLongCallRow);
}

function buildLongCallRow(row = {}) {
  return {
    agentName: row.agentName || "(unknown agent)",
    minutes: Math.round(Number(row.durationSec || 0) / 60),
    platform: row.platform || null,
    contactName: row.contactName || null,
    caseId: row.caseId ?? null,
    domain: row.domain || null,
    listenUrl: row.recordingArchive?.driveWebViewLink
      || (row.platform === "phoneburner" ? row.recordingArchive?.sourceUri : null)
      || null,
    recordingStatus: row.recordingArchive?.driveWebViewLink
      || (row.platform === "phoneburner" && row.recordingArchive?.sourceUri)
      ? "available"
      : (row.recordingArchive?.status || "unknown"),
  };
}

module.exports = {
  ACTIVE_MAIL_PIECES,
  SIMPLE_MARKETING_SCOPE,
  // Exported for the payments-sheet reconcile pass, which canonicalizes
  // Logics source names before writing them onto CaseProfiles.
  SOURCE_ALIASES,
  activeMigrationFilter,
  buildPacificDateRange,
  currentPacificDateKey,
  buildSimpleMarketingSummary,
  buildSimpleNightlySummary,
  listFailedPayments,
  LONG_CALL_RECORDING_PLATFORMS,
  buildLongCallFilter,
  buildLongCallRow,
  listLongCalls,
  buildSimpleNightlyPaymentRollup,
  buildSimpleTotals,
  normalizeSimpleMarketingDomain,
};
