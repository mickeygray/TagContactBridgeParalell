"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { buildTimezoneDateWindow } = require("../packages/shared-services/src/timezoneDateWindowService");

const DEFAULT_DB =
  process.env.PARALLEL_DB_NAME ||
  process.env.MONGO_DB_NAME ||
  "tagcontactbridge_parallel";
const DEFAULT_TIMEZONE = "America/Los_Angeles";
const REPORT_COLLECTION = "controlplanemetriccallreconciliations";

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value === undefined ? fallback : value;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function todayKey(timeZone = DEFAULT_TIMEZONE) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function monthStartKey(dateKey) {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(dateKey || ""));
  if (!match) throw new Error("date must be YYYY-MM-DD");
  return `${match[1]}-${match[2]}-01`;
}

function assertDateKey(value, label) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new Error(`${label} must be YYYY-MM-DD`);
  }
  return text;
}

function buildDateRange(fromKey, toKey, timeZone = DEFAULT_TIMEZONE) {
  const fromWindow = buildTimezoneDateWindow(fromKey, timeZone);
  const toWindow = buildTimezoneDateWindow(toKey, timeZone);
  return {
    fromKey,
    toKey,
    from: fromWindow.start,
    toExclusive: new Date(toWindow.end.getTime() + 1),
    timeZone,
  };
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D+/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.length >= 10 ? digits.slice(-10) : digits || null;
}

function secondsKey(value) {
  return value ? Math.floor(new Date(value).getTime() / 1000) : 0;
}

function softCallKey(call) {
  return [
    call.platform || "",
    call.direction || "",
    call.domain || "",
    call.caseId || "",
    normalizePhone(
      call.normalizedPhone ||
        call.phone ||
        call.callerPhone ||
        call.contactPhone,
    ) || "",
    secondsKey(call.callStartTime || call.createdAt || call.updatedAt),
  ].join("|");
}

function normalizeSource(value) {
  return String(value || "").trim();
}

function resolveSource(row, canonicalById, fallback = null) {
  const canonical = row?.sourceCanonicalId
    ? canonicalById.get(String(row.sourceCanonicalId))
    : null;
  const payload = row?.payloadSnapshot && typeof row.payloadSnapshot === "object"
    ? row.payloadSnapshot
    : {};
  const raw = row?.raw && typeof row.raw === "object" ? row.raw : {};
  const canonicalName =
    normalizeSource(canonical?.internalName) ||
    normalizeSource(canonical?.displayName) ||
    normalizeSource(canonical?.canonicalKey);
  if (canonicalName) {
    return {
      source: canonicalName,
      channel: canonical?.channel || normalizeSource(row?.sourceChannel) || null,
      sourceCanonicalId: String(canonical?._id || row?.sourceCanonicalId || ""),
      matchedBy: "canonical",
    };
  }
  const namedSource =
    normalizeSource(row?.sourceName) ||
    normalizeSource(row?.mailPieceKey) ||
    normalizeSource(payload.sourceName) ||
    normalizeSource(payload.vendor) ||
    normalizeSource(raw.sourceName);
  if (namedSource) {
    return {
      source: namedSource,
      channel:
        normalizeSource(row?.sourceChannel) ||
        normalizeSource(payload.sourceChannel) ||
        normalizeSource(raw.sourceChannel) ||
        null,
      sourceCanonicalId: row?.sourceCanonicalId ? String(row.sourceCanonicalId) : null,
      matchedBy: "source-name",
    };
  }
  if (fallback) return fallback;
  return {
    source: "Unknown",
    channel: null,
    sourceCanonicalId: null,
    matchedBy: "unknown",
  };
}

function sourceLabel(row, canonicalById) {
  return resolveSource(row, canonicalById).source;
}

function newSourceBucket(source) {
  return {
    source,
    leadsGeneratedActive: 0,
    generatedLeadsDialed: 0,
    cxAttempts: 0,
    cxOver2: 0,
    cxOver5: 0,
    cxDurationSec: 0,
    cxLongestSec: 0,
    uniquePhones: new Set(),
    uniqueCases: new Set(),
  };
}

function getSourceBucket(map, source) {
  if (!map.has(source)) map.set(source, newSourceBucket(source));
  return map.get(source);
}

function newLeadBucket({ domain, caseId, source, leadCreatedAt, phone }) {
  return {
    domain: domain || null,
    caseId: Number.isFinite(Number(caseId)) ? Number(caseId) : null,
    source,
    leadCreatedAt: leadCreatedAt ? new Date(leadCreatedAt).toISOString() : null,
    phone: normalizePhone(phone),
    cxAttempts: 0,
    cxOver2: 0,
    cxOver5: 0,
    cxDurationSec: 0,
    cxLongestSec: 0,
    firstCallAt: null,
    lastCallAt: null,
  };
}

function bumpLeadCall(bucket, call) {
  const duration = Number(call.durationSec || 0);
  const happenedAt = call.callStartTime || call.createdAt || call.updatedAt || null;
  bucket.cxAttempts += 1;
  bucket.cxOver2 += duration >= 120 ? 1 : 0;
  bucket.cxOver5 += duration >= 300 ? 1 : 0;
  bucket.cxDurationSec += duration;
  bucket.cxLongestSec = Math.max(bucket.cxLongestSec, duration);
  if (happenedAt) {
    const iso = new Date(happenedAt).toISOString();
    if (!bucket.firstCallAt || iso < bucket.firstCallAt) bucket.firstCallAt = iso;
    if (!bucket.lastCallAt || iso > bucket.lastCallAt) bucket.lastCallAt = iso;
  }
}

function serializeSourceBucket(bucket) {
  return {
    source: bucket.source,
    leadsGeneratedActive: bucket.leadsGeneratedActive,
    generatedLeadsDialed: bucket.generatedLeadsDialed,
    cxAttempts: bucket.cxAttempts,
    cxOver2: bucket.cxOver2,
    cxOver5: bucket.cxOver5,
    cxDurationSec: bucket.cxDurationSec,
    cxLongestSec: bucket.cxLongestSec,
    uniquePhones: bucket.uniquePhones.size,
    uniqueCases: bucket.uniqueCases.size,
  };
}

function newDealBucket(source) {
  return {
    source,
    deals: 0,
    initials: 0,
    paid: 0,
    paymentCount: 0,
    recurringCount: 0,
    recurringPaid: 0,
    uniqueCases: new Set(),
    examples: [],
  };
}

function getDealBucket(map, source) {
  if (!map.has(source)) map.set(source, newDealBucket(source));
  return map.get(source);
}

function serializeDealBucket(bucket) {
  return {
    source: bucket.source,
    deals: bucket.deals,
    initials: Math.round(bucket.initials * 100) / 100,
    paid: Math.round(bucket.paid * 100) / 100,
    paymentCount: bucket.paymentCount,
    recurringCount: bucket.recurringCount,
    recurringPaid: Math.round(bucket.recurringPaid * 100) / 100,
    uniqueCases: bucket.uniqueCases.size,
    examples: bucket.examples,
  };
}

function sumRows(rows, key) {
  return rows.reduce((total, row) => total + Number(row[key] || 0), 0);
}

async function buildReport({ fromKey, toKey, timeZone }) {
  const range = buildDateRange(fromKey, toKey, timeZone);
  const db = mongoose.connection.db;

  const [canonicals, activeLeads, cxCalls, mailerRows, payments] = await Promise.all([
    db.collection("controlplanesourcecanonicals")
      .find({})
      .project({
        internalName: 1,
        displayName: 1,
        canonicalKey: 1,
        channel: 1,
      })
      .toArray(),
    db.collection("controlplaneleadcadences")
      .find({
        createdAt: { $gte: range.from, $lt: range.toExclusive },
        active: { $ne: false },
      })
      .project({
        domain: 1,
        caseId: 1,
        sourceName: 1,
        sourceChannel: 1,
        sourceCanonicalId: 1,
        mailPieceKey: 1,
        payloadSnapshot: 1,
        createdAt: 1,
        phone: 1,
        normalizedPhone: 1,
      })
      .toArray(),
    db.collection("controlplanecalllogs")
      .find({
        platform: "cx",
        direction: "outbound",
        $or: [
          { callStartTime: { $gte: range.from, $lt: range.toExclusive } },
          { createdAt: { $gte: range.from, $lt: range.toExclusive } },
        ],
      })
      .project({
        domain: 1,
        caseId: 1,
        normalizedPhone: 1,
        phone: 1,
        callerPhone: 1,
        callStartTime: 1,
        createdAt: 1,
        updatedAt: 1,
        durationSec: 1,
        telephonySessionId: 1,
        callSessionId: 1,
        status: 1,
      })
      .toArray(),
    db.collection("controlplanedailycallstats")
      .aggregate([
        {
          $match: {
            date: { $gte: fromKey, $lte: toKey },
            channel: { $in: ["mail", "mailer"] },
          },
        },
        {
          $group: {
            _id: { piece: "$piece", channel: "$channel" },
            calls: { $sum: "$totalCalls" },
            over2: { $sum: "$callsOver2" },
            over5: { $sum: "$callsOver5" },
            durationSec: { $sum: "$totalDuration" },
            uniqueCallers: { $sum: "$uniqueCallers" },
            days: { $sum: 1 },
          },
        },
        { $sort: { calls: -1, "_id.piece": 1 } },
      ])
      .toArray(),
    db.collection("controlplanepaymentledgers")
      .find({
        paymentDate: { $gte: range.from, $lt: range.toExclusive },
        transactionStatus: "SUCCESS",
      })
      .project({
        domain: 1,
        caseId: 1,
        casePaymentId: 1,
        paymentDate: 1,
        paymentDateKey: 1,
        amount: 1,
        paymentType: 1,
        transactionStatus: 1,
        sourceCanonicalId: 1,
        needsSourceReview: 1,
        reviewReason: 1,
        raw: 1,
      })
      .toArray(),
  ]);

  const canonicalById = new Map(canonicals.map((row) => [String(row._id), row]));
  const paymentCaseIds = [...new Set(
    payments.map((payment) => Number(payment.caseId)).filter(Number.isFinite),
  )];
  const paymentProfiles = paymentCaseIds.length > 0
    ? await db.collection("controlplanecaseprofiles")
      .find({ caseId: { $in: paymentCaseIds } })
      .project({
        domain: 1,
        caseId: 1,
        name: 1,
        firstName: 1,
        lastName: 1,
        primaryPhone: 1,
        normalizedPhones: 1,
        sourceName: 1,
        sourceChannel: 1,
        sourceCanonicalId: 1,
        firstPaymentDate: 1,
        initialPayment: 1,
        totalPaid: 1,
        attribution: 1,
      })
      .toArray()
    : [];
  const profileByDomainCase = new Map();
  const profileByCase = new Map();
  for (const profile of paymentProfiles) {
    const domainCaseKey = `${profile.domain || ""}:${Number(profile.caseId)}`;
    profileByDomainCase.set(domainCaseKey, profile);
    if (!profileByCase.has(Number(profile.caseId))) {
      profileByCase.set(Number(profile.caseId), profile);
    }
  }
  const leadsByCase = new Map();
  const sourceBuckets = new Map();
  const leadBuckets = new Map();

  for (const lead of activeLeads) {
    const caseKey = `${lead.domain || ""}:${Number(lead.caseId)}`;
    const source = sourceLabel(lead, canonicalById);
    leadsByCase.set(caseKey, { ...lead, source });
    const sourceBucket = getSourceBucket(sourceBuckets, source);
    sourceBucket.leadsGeneratedActive += 1;
    leadBuckets.set(
      caseKey,
      newLeadBucket({
        domain: lead.domain,
        caseId: lead.caseId,
        source,
        leadCreatedAt: lead.createdAt,
        phone: lead.normalizedPhone || lead.phone,
      }),
    );
  }

  const seenCalls = new Set();
  const dialedCasesBySource = new Map();
  const uniqueSessionIds = new Set();
  let softDedupedCxAttempts = 0;
  let attemptsAgainstActiveGeneratedLeads = 0;
  let attemptsAgainstOlderInactiveOrUnmatched = 0;

  for (const call of cxCalls) {
    if (call.telephonySessionId || call.callSessionId) {
      uniqueSessionIds.add(String(call.telephonySessionId || call.callSessionId));
    }
    const callKey = softCallKey(call);
    if (seenCalls.has(callKey)) continue;
    seenCalls.add(callKey);
    softDedupedCxAttempts += 1;

    const caseKey = `${call.domain || ""}:${Number(call.caseId)}`;
    const lead = leadsByCase.get(caseKey);
    if (!lead) {
      attemptsAgainstOlderInactiveOrUnmatched += 1;
      continue;
    }

    attemptsAgainstActiveGeneratedLeads += 1;
    const duration = Number(call.durationSec || 0);
    const sourceBucket = getSourceBucket(sourceBuckets, lead.source);
    sourceBucket.cxAttempts += 1;
    sourceBucket.cxOver2 += duration >= 120 ? 1 : 0;
    sourceBucket.cxOver5 += duration >= 300 ? 1 : 0;
    sourceBucket.cxDurationSec += duration;
    sourceBucket.cxLongestSec = Math.max(sourceBucket.cxLongestSec, duration);
    sourceBucket.uniqueCases.add(caseKey);
    const phone = normalizePhone(
      call.normalizedPhone ||
        call.phone ||
        call.callerPhone ||
        lead.normalizedPhone ||
        lead.phone,
    );
    if (phone) sourceBucket.uniquePhones.add(phone);

    if (!dialedCasesBySource.has(lead.source)) {
      dialedCasesBySource.set(lead.source, new Set());
    }
    dialedCasesBySource.get(lead.source).add(caseKey);

    const leadBucket = leadBuckets.get(caseKey);
    if (leadBucket) bumpLeadCall(leadBucket, call);
  }

  for (const [source, dialedCases] of dialedCasesBySource.entries()) {
    getSourceBucket(sourceBuckets, source).generatedLeadsDialed = dialedCases.size;
  }

  const cxBySource = [...sourceBuckets.values()]
    .map(serializeSourceBucket)
    .sort(
      (a, b) =>
        b.cxAttempts - a.cxAttempts ||
        b.leadsGeneratedActive - a.leadsGeneratedActive ||
        a.source.localeCompare(b.source),
    );

  const perLeadCx = [...leadBuckets.values()]
    .filter((row) => row.cxAttempts > 0)
    .sort(
      (a, b) =>
        b.cxAttempts - a.cxAttempts ||
        b.cxDurationSec - a.cxDurationSec ||
        String(a.source).localeCompare(String(b.source)),
    );

  const mailerResponseRows = mailerRows.map((row) => ({
    piece: row._id.piece,
    channel: row._id.channel,
    calls: Number(row.calls || 0),
    over2: Number(row.over2 || 0),
    over5: Number(row.over5 || 0),
    durationSec: Number(row.durationSec || 0),
    uniqueCallers: Number(row.uniqueCallers || 0),
    days: Number(row.days || 0),
  }));

  const genericRows = mailerResponseRows.filter((row) =>
    ["unknown", "abc"].includes(String(row.piece || "").trim().toLowerCase()),
  );

  const dealBuckets = new Map();
  const dealRows = [];
  const sourceReviewRows = [];
  for (const payment of payments) {
    const domainCaseKey = `${payment.domain || ""}:${Number(payment.caseId)}`;
    const profile =
      profileByDomainCase.get(domainCaseKey) ||
      profileByCase.get(Number(payment.caseId)) ||
      null;
    const paymentSource = resolveSource(payment, canonicalById);
    const profileSource = resolveSource(profile, canonicalById);
    const selected =
      paymentSource.matchedBy !== "unknown"
        ? { ...paymentSource, selectedFrom: "payment-ledger" }
        : { ...profileSource, selectedFrom: "case-profile" };
    const source = selected.source || "Unknown";
    const amount = Number(payment.amount || 0);
    const paymentType = String(payment.paymentType || "unknown").toLowerCase();
    const bucket = getDealBucket(dealBuckets, source);
    bucket.paymentCount += 1;
    bucket.paid += amount;
    bucket.uniqueCases.add(domainCaseKey);
    if (paymentType === "initial") {
      bucket.deals += 1;
      bucket.initials += amount;
    } else if (paymentType === "recurring") {
      bucket.recurringCount += 1;
      bucket.recurringPaid += amount;
    }
    if (bucket.examples.length < 5) {
      bucket.examples.push({
        domain: payment.domain || null,
        caseId: Number(payment.caseId),
        casePaymentId: Number(payment.casePaymentId),
        amount,
        paymentType,
        paymentDateKey: payment.paymentDateKey || null,
      });
    }
    if (paymentType === "initial") {
      const name =
        profile?.name ||
        [profile?.firstName, profile?.lastName].filter(Boolean).join(" ").trim() ||
        null;
      dealRows.push({
        domain: payment.domain || null,
        caseId: Number(payment.caseId),
        casePaymentId: Number(payment.casePaymentId),
        name,
        phone:
          normalizePhone(profile?.primaryPhone) ||
          normalizePhone(Array.isArray(profile?.normalizedPhones) ? profile.normalizedPhones[0] : null),
        amount,
        paymentDateKey: payment.paymentDateKey || null,
        source,
        sourceChannel: selected.channel || null,
        selectedFrom: selected.selectedFrom,
        matchedBy: selected.matchedBy,
        needsSourceReview: Boolean(payment.needsSourceReview),
        reviewReason: payment.reviewReason || profile?.attribution?.reviewReason || null,
      });
    }
    if (
      selected.matchedBy === "unknown" ||
      ["unknown", "abc"].includes(String(source || "").trim().toLowerCase()) ||
      payment.needsSourceReview
    ) {
      sourceReviewRows.push({
        domain: payment.domain || null,
        caseId: Number(payment.caseId),
        casePaymentId: Number(payment.casePaymentId),
        paymentType,
        amount,
        source,
        selectedFrom: selected.selectedFrom,
        matchedBy: selected.matchedBy,
        needsSourceReview: Boolean(payment.needsSourceReview),
        reviewReason: payment.reviewReason || profile?.attribution?.reviewReason || null,
      });
    }
  }

  const dealSourceRows = [...dealBuckets.values()]
    .map(serializeDealBucket)
    .sort(
      (a, b) =>
        b.initials - a.initials ||
        b.deals - a.deals ||
        b.paid - a.paid ||
        a.source.localeCompare(b.source),
    );
  const initialDealRows = dealRows.sort(
    (a, b) =>
      b.amount - a.amount ||
      String(a.source).localeCompare(String(b.source)) ||
      Number(a.caseId || 0) - Number(b.caseId || 0),
  );

  return {
    kind: "monthly-call-honesty",
    version: 1,
    generatedAt: new Date().toISOString(),
    range: {
      fromKey,
      toKey,
      fromTs: range.from.toISOString(),
      toExclusiveTs: range.toExclusive.toISOString(),
      timeZone,
    },
    notes: [
      "CX call counts are soft-deduped outbound attempts from controlplanecalllogs.",
      "Generated-lead CX counts are limited to active LeadCadence rows created inside the report window.",
      "Mailer response calls remain separate and come from controlplanedailycallstats.",
      "This report does not mutate dashboard metrics, DailyCallStat, lead cadences, spend, or payment ledgers.",
    ],
    cxOutbound: {
      rawRows: cxCalls.length,
      uniqueSessionRows: uniqueSessionIds.size,
      softDedupedAttempts: softDedupedCxAttempts,
      attemptsAgainstActiveGeneratedLeads,
      attemptsAgainstOlderInactiveOrUnmatched,
      bySource: cxBySource,
      perLeadTouched: perLeadCx,
      totalsAgainstActiveGeneratedLeads: {
        leadsGeneratedActive: sumRows(cxBySource, "leadsGeneratedActive"),
        generatedLeadsDialed: sumRows(cxBySource, "generatedLeadsDialed"),
        cxAttempts: sumRows(cxBySource, "cxAttempts"),
        cxOver2: sumRows(cxBySource, "cxOver2"),
        cxOver5: sumRows(cxBySource, "cxOver5"),
        cxDurationSec: sumRows(cxBySource, "cxDurationSec"),
      },
    },
    mailerResponses: {
      totals: {
        calls: sumRows(mailerResponseRows, "calls"),
        over2: sumRows(mailerResponseRows, "over2"),
        over5: sumRows(mailerResponseRows, "over5"),
        durationSec: sumRows(mailerResponseRows, "durationSec"),
        uniqueCallers: sumRows(mailerResponseRows, "uniqueCallers"),
      },
      byPiece: mailerResponseRows,
      genericBuckets: genericRows,
    },
    deals: {
      successfulPaymentCount: payments.length,
      initialDealCount: initialDealRows.length,
      initialAmount: Math.round(sumRows(dealSourceRows, "initials") * 100) / 100,
      totalCollected: Math.round(sumRows(dealSourceRows, "paid") * 100) / 100,
      bySource: dealSourceRows,
      initialDeals: initialDealRows,
      sourceReview: sourceReviewRows,
      genericBuckets: dealSourceRows.filter((row) =>
        ["unknown", "abc"].includes(String(row.source || "").trim().toLowerCase()),
      ),
    },
  };
}

function writeRuntimeDump(report) {
  const outputDir = path.join(process.cwd(), "runtime", "metrics-reconcile");
  fs.mkdirSync(outputDir, { recursive: true });
  const fileName = `${report.kind}-${report.range.fromKey}_to_${report.range.toKey}.json`;
  const filePath = path.join(outputDir, fileName);
  fs.writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return filePath;
}

async function saveReport(report) {
  const db = mongoose.connection.db;
  const collection = db.collection(REPORT_COLLECTION);
  await collection.createIndex(
    { kind: 1, "range.fromKey": 1, "range.toKey": 1 },
    { unique: true, name: "metric_call_reconciliation_range" },
  );
  const saved = await collection.findOneAndUpdate(
    {
      kind: report.kind,
      "range.fromKey": report.range.fromKey,
      "range.toKey": report.range.toKey,
    },
    {
      $set: {
        ...report,
        updatedAt: new Date(),
      },
      $setOnInsert: {
        createdAt: new Date(),
      },
    },
    { upsert: true, returnDocument: "after" },
  );
  return saved?.value || saved;
}

async function main() {
  const nowKey = todayKey();
  const fromKey = assertDateKey(argValue("--from", monthStartKey(nowKey)), "--from");
  const toKey = assertDateKey(argValue("--to", nowKey), "--to");
  const timeZone = argValue("--timezone", DEFAULT_TIMEZONE);
  const apply = hasFlag("--apply");

  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");
  await mongoose.connect(process.env.MONGO_URI, { dbName: DEFAULT_DB });
  const report = await buildReport({ fromKey, toKey, timeZone });
  const dumpPath = writeRuntimeDump(report);

  let saved = null;
  if (apply) {
    saved = await saveReport(report);
  }

  console.log(JSON.stringify({
    ok: true,
    applied: apply,
    db: mongoose.connection.name,
    collection: apply ? REPORT_COLLECTION : null,
    dumpPath,
    range: report.range,
    cxOutbound: {
      rawRows: report.cxOutbound.rawRows,
      uniqueSessionRows: report.cxOutbound.uniqueSessionRows,
      softDedupedAttempts: report.cxOutbound.softDedupedAttempts,
      attemptsAgainstActiveGeneratedLeads:
        report.cxOutbound.attemptsAgainstActiveGeneratedLeads,
      attemptsAgainstOlderInactiveOrUnmatched:
        report.cxOutbound.attemptsAgainstOlderInactiveOrUnmatched,
      totalsAgainstActiveGeneratedLeads:
        report.cxOutbound.totalsAgainstActiveGeneratedLeads,
      topSources: report.cxOutbound.bySource.slice(0, 10),
    },
    mailerResponses: {
      totals: report.mailerResponses.totals,
      genericBuckets: report.mailerResponses.genericBuckets,
      topPieces: report.mailerResponses.byPiece.slice(0, 10),
    },
    deals: {
      successfulPaymentCount: report.deals.successfulPaymentCount,
      initialDealCount: report.deals.initialDealCount,
      initialAmount: report.deals.initialAmount,
      totalCollected: report.deals.totalCollected,
      genericBuckets: report.deals.genericBuckets,
      sourceReviewCount: report.deals.sourceReview.length,
      topSources: report.deals.bySource.slice(0, 10),
    },
    savedId: saved?._id || null,
  }, null, 2));

  await mongoose.disconnect();
}

// Exported so the nightly close can run the SAME proven computation against the
// already-open mongoose connection (buildReport/saveReport never manage the
// connection themselves — only main() connects/disconnects for CLI use). The
// CLI path stays guarded so requiring this module has no side effects.
module.exports = {
  buildReport,
  saveReport,
  REPORT_COLLECTION,
  DEFAULT_TIMEZONE,
  monthStartKey,
  todayKey,
};

if (require.main === module) {
  main().catch(async (error) => {
    console.error(error && error.stack ? error.stack : error);
    try {
      await mongoose.disconnect();
    } catch (_) {
      // Ignore disconnect failures while exiting.
    }
    process.exit(1);
  });
}
