"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const caseProfileRepository = require("../packages/shared-repositories/src/caseProfileRepository");
const paymentLedgerRepository = require("../packages/shared-repositories/src/paymentLedgerRepository");
const { getLdRates, materializeLdSpendForDate } = require("../packages/shared-services/src/ldSpendService");

const DEFAULT_DB = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
const DEFAULT_MONTH = "2026-06";
const DEFAULT_RESTORE_CANDIDATE_LIMIT = 500;

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value === undefined ? fallback : value;
}

function normalizeDomain(domain) {
  return domain ? String(domain).trim().toUpperCase() : null;
}

function monthWindow(month) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(month || ""));
  if (!match) throw new Error("--month must be YYYY-MM");
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  // Pacific month boundary for June 2026; keeps report aligned with floor reporting.
  const start = new Date(Date.UTC(year, monthIndex, 1, 7, 0, 0, 0));
  const end = new Date(Date.UTC(monthIndex === 11 ? year + 1 : year, (monthIndex + 1) % 12, 1, 7, 0, 0, 0));
  return { start, end };
}

function monthDateKeys(month) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(month || ""));
  if (!match) throw new Error("--month must be YYYY-MM");
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  const days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return Array.from({ length: days }, (_, index) => `${match[1]}-${match[2]}-${String(index + 1).padStart(2, "0")}`);
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function sum(rows, key) {
  return roundMoney((rows || []).reduce((total, row) => total + Number(row?.[key] || 0), 0));
}

function count(rows, key) {
  return (rows || []).reduce((total, row) => total + Number(row?.[key] || 0), 0);
}

function compact(value) {
  if (Array.isArray(value)) return value.map(compact);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value.toHexString === "function") return value.toHexString();
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, child]) => [key, compact(child)])
      .filter(([, child]) => {
        if (child === null || child === undefined || child === "") return false;
        if (Array.isArray(child) && child.length === 0) return false;
        if (typeof child === "object" && Object.keys(child).length === 0) return false;
        return true;
      }),
  );
}

function firstValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return null;
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.length === 10 ? digits : null;
}

function textParts(...values) {
  return values
    .flatMap((value) => {
      if (Array.isArray(value)) return value;
      if (value && typeof value === "object") return Object.values(value);
      return [value];
    })
    .filter((value) => value !== undefined && value !== null && String(value).trim() !== "")
    .map((value) => String(value).trim());
}

function sourceSignalFromRow(row = {}) {
  const payload = row.payload && typeof row.payload === "object" ? row.payload : {};
  const result = row.result && typeof row.result === "object" ? row.result : {};
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  const raw = row.raw && typeof row.raw === "object" ? row.raw : {};
  const payloadSnapshot = row.payloadSnapshot && typeof row.payloadSnapshot === "object" ? row.payloadSnapshot : {};
  const signalText = textParts(
    row.sourceName,
    row.sourceChannel,
    row.routeCampaignKey,
    row.routeCampaignName,
    row.vendor,
    row.partnerSource,
    row.intakeRoute,
    row.source,
    row.channel,
    row.campaign,
    row.family,
    row.subtype,
    row.title,
    row.summary,
    row.sourceService,
    payload.sourceName,
    payload.routeCampaignKey,
    payload.routeCampaignName,
    payload.importBatch,
    payload.vendor,
    payload.partnerSource,
    payload.intakeRoute,
    payload.family,
    payload.subtype,
    metadata.sourceName,
    metadata.routeCampaignKey,
    metadata.routeCampaignName,
    metadata.logicsSourceName,
    metadata.intakeSource,
    raw.familyKey,
    payloadSnapshot.vendor,
    payloadSnapshot.sourceName,
    payloadSnapshot.routeCampaignKey,
    payloadSnapshot.routeCampaignName,
  );

  return {
    domain: normalizeDomain(firstValue(row.domain, payload.domain, result.domain, metadata.domain)),
    caseId: firstValue(row.caseId, result.caseId, payload.caseId, row.aggregateId, payload.CaseID, payload.caseID),
    phone: normalizePhone(firstValue(row.phone, payload.phone, payload.Phone, payload.phoneTo, payload.PhoneTo, metadata.phone)),
    sourceName: firstValue(row.sourceName, payload.sourceName, metadata.sourceName, metadata.logicsSourceName),
    sourceChannel: firstValue(row.sourceChannel, payload.sourceChannel, row.channel),
    routeCampaignKey: firstValue(row.routeCampaignKey, payload.routeCampaignKey, metadata.routeCampaignKey),
    routeCampaignName: firstValue(row.routeCampaignName, payload.routeCampaignName, metadata.routeCampaignName),
    vendor: firstValue(row.vendor, payload.vendor, payloadSnapshot.vendor, row.partnerSource, payload.partnerSource),
    importBatch: firstValue(payload.importBatch, row.importBatch, metadata.importBatch, row.lastImportBatch),
    text: signalText.join(" | "),
  };
}

function classifySourceFamilyFromSignal(signal = {}) {
  const text = textParts(signal).join(" ").toLowerCase();
  const ldFamily = classifyLdFamily({
    sourceName: signal.sourceName,
    sourceChannel: signal.sourceChannel,
    routeCampaignKey: signal.routeCampaignKey,
    routeCampaignName: signal.routeCampaignName,
    vendor: signal.vendor,
    partnerSource: signal.vendor,
    source: signal.text,
    channel: signal.sourceChannel,
  });
  if (ldFamily) return ldFamily;
  if (/(^|[^a-z])(mailer|mail[-_\s]?intake|ncoa|lexis|lien|regional|urgent third|affordability|abc)([^a-z]|$)/i.test(text)) {
    return "mailer";
  }
  return null;
}

async function maybeCollection(db, name) {
  const exists = await db.listCollections({ name }, { nameOnly: true }).hasNext();
  return exists ? db.collection(name) : null;
}

async function groupBy(collection, match, field, limit = 20) {
  if (!collection) return [];
  return collection
    .aggregate([
      { $match: match },
      { $group: { _id: `$${field}`, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: limit },
    ])
    .toArray();
}

async function caseProfileInitials({ caseProfiles, domain, start, end }) {
  if (!caseProfiles) return { count: 0, rows: [], bySource: [] };
  const match = {
    firstPaymentDate: { $gte: start, $lt: end },
    initialPayment: { $gt: 0 },
  };
  if (domain) match.domain = domain;
  const rows = await caseProfiles
    .find(match, {
      projection: {
        domain: 1,
        caseId: 1,
        customerName: 1,
        statusLabelRaw: 1,
        initialPayment: 1,
        firstPaymentDate: 1,
        sourceCanonicalId: 1,
        sourceName: 1,
        sourceChannel: 1,
        sourceId: 1,
        "source.attribution": 1,
        "metadata.sourceName": 1,
        "metadata.logicsSourceName": 1,
        "metadata.routeCampaignKey": 1,
        "metadata.routeCampaignName": 1,
      },
    })
    .sort({ firstPaymentDate: 1, caseId: 1 })
    .toArray();

  const bySource = await caseProfiles
    .aggregate([
      { $match: match },
      {
        $group: {
          _id: {
            sourceName: { $ifNull: ["$sourceName", "$metadata.sourceName"] },
            routeCampaignKey: "$metadata.routeCampaignKey",
            sourceChannel: "$sourceChannel",
          },
          count: { $sum: 1 },
          initialPayments: { $sum: "$initialPayment" },
        },
      },
      { $sort: { count: -1, initialPayments: -1 } },
    ])
    .toArray();

  return { count: rows.length, rows: rows.map(compact), bySource };
}

async function paymentLedgerInitials({ paymentLedgers, domain, start, end }) {
  if (!paymentLedgers) return { count: 0, rows: [], bySource: [] };
  const match = {
    paymentDate: { $gte: start, $lt: end },
    paymentType: "initial",
    transactionStatus: "SUCCESS",
  };
  if (domain) match.domain = domain;
  const rows = await paymentLedgers
    .find(match, {
      projection: {
        domain: 1,
        caseId: 1,
        casePaymentId: 1,
        amount: 1,
        paymentDate: 1,
        sourceCanonicalId: 1,
        sourceName: 1,
        sourceChannel: 1,
        transactionStatus: 1,
      },
    })
    .sort({ paymentDate: 1, caseId: 1 })
    .toArray();

  const bySource = await paymentLedgers
    .aggregate([
      { $match: match },
      {
        $group: {
          _id: {
            sourceName: "$sourceName",
            sourceChannel: "$sourceChannel",
            transactionStatus: "$transactionStatus",
          },
          count: { $sum: 1 },
          amount: { $sum: "$amount" },
        },
      },
      { $sort: { count: -1, amount: -1 } },
    ])
    .toArray();

  return { count: rows.length, rows: rows.map(compact), bySource };
}

async function tagInitialReconciliation({ domain, start, end }) {
  const to = new Date(end.getTime() - 1).toISOString().slice(0, 10);
  const from = start.toISOString().slice(0, 10);
  const [caseProfileSummary, paymentLedgerSummary] = await Promise.all([
    caseProfileRepository.summarizeInitialPaymentsBySource(domain, { from, to }),
    paymentLedgerRepository.summarizeSuccessfulPaymentsBySource(domain, { from, to }),
  ]);

  const caseProfileTotal = {
    count: count(caseProfileSummary, "initialPaymentCount"),
    amount: sum(caseProfileSummary, "initialPayments"),
  };
  const paymentLedgerTotal = {
    count: count(paymentLedgerSummary, "initialPaymentCount"),
    amount: sum(paymentLedgerSummary, "initialPayments"),
    totalCollected: sum(paymentLedgerSummary, "payments"),
  };

  return {
    meaning: "TAG payment/deal reconciliation. These totals use the same repository summarizers as the metrics path.",
    caseProfileTotal,
    paymentLedgerTotal,
    delta: {
      count: paymentLedgerTotal.count - caseProfileTotal.count,
      amount: roundMoney(paymentLedgerTotal.amount - caseProfileTotal.amount),
    },
    caseProfileBySource: caseProfileSummary.map(compact),
    paymentLedgerBySource: paymentLedgerSummary.map(compact),
  };
}

const LD_REGEX = /(^|[^a-z0-9])(ld|ldcustom|ldcustom2|ldcustom3|ldgeneral|ld-posting|lead[\s_-]*data)([^a-z0-9]|$)/i;
const MAILER_REGEX =
  /(^|[^a-z])(mailer|mail[-_\s]?intake|ncoa|lexis|lien|regional|urgent third|affordability|abc)([^a-z]|$)/i;

function ldHaystack(row = {}) {
  return [
    row.source,
    row.sourceName,
    row.sourceChannel,
    row.channel,
    row.campaign,
    row.routeCampaignKey,
    row.routeCampaignName,
    row.vendor,
    row.partnerSource,
    row.intakeRoute,
    row.family,
    row.subtype,
    row.title,
    row.summary,
    row?.metadata?.sourceName,
    row?.metadata?.routeCampaignKey,
    row?.metadata?.routeCampaignName,
    row?.payloadSnapshot?.vendor,
    row?.payload?.vendor,
    row?.payload?.sourceName,
    row?.payload?.routeCampaignKey,
    row?.payload?.routeCampaignName,
    row?.raw?.familyKey,
  ]
    .filter(Boolean)
    .map((part) => String(part).toLowerCase())
    .join(" ");
}

function classifyLdFamily(row = {}) {
  const text = ldHaystack(row);
  if (/ld[\s_-]*custom[\s_-]*3|ldcustom3|custom[\s_-]*3|sourceid[\s_-]*48/.test(text)) return "ld-custom-3";
  if (/ld[\s_-]*custom[\s_-]*2|ldcustom2|custom[\s_-]*2|sourceid[\s_-]*47/.test(text)) return "ld-custom-2";
  if (/ld[\s_-]*custom|ldcustom|sourceid[\s_-]*45/.test(text)) return "ld-custom";
  if (/ld[\s_-]*general|ldgeneral|general/.test(text)) return "ld-general";
  if (/ld[\s_-]*posting|ldposting/.test(text)) return "ld-posting";
  if (/lead[\s_-]*data|(^|[^a-z])ld([^a-z]|$)/.test(text)) return "ld-unknown";
  return null;
}

function createLdBucket(family, rates = {}) {
  const rate = Number(rates[family] || 0);
  return {
    family,
    rows: 0,
    active: 0,
    inactive: 0,
    leadsReported: 0,
    spend: 0,
    expectedSpendFromRows: 0,
    rate,
    samples: [],
  };
}

function addLdRollup(map, family, patch = {}, sample = null, rates = {}) {
  const key = family || "ld-unknown";
  if (!map.has(key)) map.set(key, createLdBucket(key, rates));
  const bucket = map.get(key);
  bucket.rows += Number(patch.rows || 0);
  bucket.active += Number(patch.active || 0);
  bucket.inactive += Number(patch.inactive || 0);
  bucket.leadsReported += Number(patch.leadsReported || 0);
  bucket.spend = roundMoney(bucket.spend + Number(patch.spend || 0));
  bucket.expectedSpendFromRows = roundMoney(bucket.expectedSpendFromRows + Number(patch.expectedSpendFromRows || 0));
  if (sample && bucket.samples.length < 5) bucket.samples.push(compact(sample));
}

function finalizeLdRollup(map) {
  return [...map.values()]
    .map((bucket) => ({
      ...bucket,
      spend: roundMoney(bucket.spend),
      expectedSpendFromRows: roundMoney(bucket.expectedSpendFromRows),
      actualCostPerReportedLead:
        bucket.leadsReported > 0 ? roundMoney(bucket.spend / bucket.leadsReported) : null,
    }))
    .sort((left, right) => right.rows - left.rows || right.leadsReported - left.leadsReported || left.family.localeCompare(right.family));
}

async function aggregateLdEvidenceFromCollection({ collection, match, projection, rates }) {
  if (!collection) return [];
  const rows = await collection
    .find(match, { projection })
    .limit(20000)
    .toArray();
  const rollup = new Map();
  for (const row of rows) {
    const family = classifyLdFamily(row);
    if (!family) continue;
    const active = row.active === true || row.status === "active" ? 1 : 0;
    const inactive = row.active === false || (row.status && row.status !== "active") ? 1 : 0;
    const rate = Number(rates[family] || 0);
    addLdRollup(rollup, family, {
      rows: 1,
      active,
      inactive,
      expectedSpendFromRows: rate,
    }, row, rates);
  }
  return finalizeLdRollup(rollup);
}

async function wynnLdCountCostReconciliation({ db, domain, start, end, month, includeMaterializer }) {
  const leadCadences = await maybeCollection(db, "controlplaneleadcadences");
  const masterProspects = await maybeCollection(db, "controlplanemasterprospectindexes");
  const workflowRecords = await maybeCollection(db, "controlplaneworkflowrecords");
  const spendEntries = await maybeCollection(db, "controlplanespendentries");
  const rates = getLdRates();
  const dateKeys = monthDateKeys(month);
  const firstDate = dateKeys[0];
  const lastDate = dateKeys[dateKeys.length - 1];
  const domainMatch = domain ? { domain } : {};

  const ldFieldMatch = {
    $or: [
      { sourceName: LD_REGEX },
      { sourceChannel: LD_REGEX },
      { routeCampaignKey: LD_REGEX },
      { routeCampaignName: LD_REGEX },
      { intakeRoute: LD_REGEX },
      { partnerSource: LD_REGEX },
      { vendor: LD_REGEX },
      { "metadata.sourceName": LD_REGEX },
      { "metadata.routeCampaignKey": LD_REGEX },
      { "metadata.routeCampaignName": LD_REGEX },
      { "payloadSnapshot.vendor": LD_REGEX },
      { "payload.vendor": LD_REGEX },
      { "payload.sourceName": LD_REGEX },
      { "payload.routeCampaignKey": LD_REGEX },
      { "payload.routeCampaignName": LD_REGEX },
      { campaign: LD_REGEX },
      { source: LD_REGEX },
      { channel: "lead-data" },
    ],
  };

  const [cadenceRollup, masterRollup] = await Promise.all([
    aggregateLdEvidenceFromCollection({
      collection: leadCadences,
      match: { ...domainMatch, createdAt: { $gte: start, $lt: end }, ...ldFieldMatch },
      projection: {
        sourceName: 1,
        sourceChannel: 1,
        routeCampaignKey: 1,
        routeCampaignName: 1,
        status: 1,
        active: 1,
        createdAt: 1,
        caseId: 1,
        phone: 1,
        "metadata.sourceName": 1,
        "metadata.routeCampaignKey": 1,
        "metadata.routeCampaignName": 1,
        "payloadSnapshot.vendor": 1,
      },
      rates,
    }),
    aggregateLdEvidenceFromCollection({
      collection: masterProspects,
      match: { ...domainMatch, updatedAt: { $gte: start, $lt: end }, ...ldFieldMatch },
      projection: {
        sourceName: 1,
        sourceChannel: 1,
        intakeRoute: 1,
        partnerSource: 1,
        routeCampaignKey: 1,
        routeCampaignName: 1,
        updatedAt: 1,
        caseId: 1,
        phone: 1,
        "metadata.sourceName": 1,
        "metadata.routeCampaignKey": 1,
        "metadata.routeCampaignName": 1,
        "payloadSnapshot.vendor": 1,
      },
      rates,
    }),
  ]);

  const spendRows = spendEntries
    ? await spendEntries
        .find(
          {
            ...domainMatch,
            date: { $gte: firstDate, $lte: lastDate },
            $or: [
              { channel: "lead-data" },
              { source: LD_REGEX },
              { campaign: LD_REGEX },
              { "raw.familyKey": LD_REGEX },
            ],
          },
          {
            projection: {
              date: 1,
              source: 1,
              channel: 1,
              campaign: 1,
              spend: 1,
              leadsReported: 1,
              costPerLead: 1,
              raw: 1,
            },
          },
        )
        .sort({ date: 1, campaign: 1, source: 1 })
        .toArray()
    : [];

  const spendRollup = new Map();
  for (const row of spendRows) {
    const family = classifyLdFamily(row);
    if (!family) continue;
    addLdRollup(spendRollup, family, {
      leadsReported: Number(row.leadsReported || 0),
      spend: Number(row.spend || 0),
    }, row, rates);
  }

  const workflowSignals = workflowRecords
    ? await workflowRecords
        .aggregate([
          {
            $match: {
              ...domainMatch,
              happenedAt: { $gte: start, $lt: end },
              $or: [
                { family: LD_REGEX },
                { subtype: LD_REGEX },
                { title: LD_REGEX },
                { summary: LD_REGEX },
                { "payload.sourceName": LD_REGEX },
                { "payload.routeCampaignKey": LD_REGEX },
                { "payload.routeCampaignName": LD_REGEX },
              ],
            },
          },
          {
            $group: {
              _id: {
                family: "$family",
                subtype: "$subtype",
                stage: "$stage",
              },
              rows: { $sum: 1 },
              uniqueCases: { $addToSet: { $ifNull: ["$caseId", "$result.caseId"] } },
            },
          },
          {
            $project: {
              rows: 1,
              uniqueCaseCount: { $size: "$uniqueCases" },
            },
          },
          { $sort: { rows: -1 } },
          { $limit: 30 },
        ])
        .toArray()
    : [];

  const materializerDryRun = [];
  if (includeMaterializer) {
    for (const dateKey of dateKeys) {
      const result = await materializeLdSpendForDate({ domain, dateKey, dryRun: true });
      materializerDryRun.push({
        date: dateKey,
        rows: result.rows,
        totalExpectedSpend: roundMoney((result.rows || []).reduce((total, row) => total + Number(row.spend || 0), 0)),
        collisions: result.collisions,
      });
    }
  }

  return {
    meaning: "WYNN LD count/cost reconciliation. Count evidence is intake-side; cost evidence is SpendEntry lead-data rows.",
    rates,
    leadCadenceCreatedInMonth: cadenceRollup,
    masterProspectUpdatedInMonth: masterRollup,
    spendRows: spendRows.map(compact),
    spendRollup: finalizeLdRollup(spendRollup),
    workflowSignals: workflowSignals.map(compact),
    materializerDryRun: includeMaterializer ? materializerDryRun : "not-run; pass --ld-materializer to dry-run the exact LD spend materializer for each day",
  };
}

async function mailerEvidence({ db, domain, start, end }) {
  const collections = {
    mailImports: await maybeCollection(db, "controlplanemailimports"),
    leadCadences: await maybeCollection(db, "controlplaneleadcadences"),
    masterProspects: await maybeCollection(db, "controlplanemasterprospectindexes"),
    workflowRecords: await maybeCollection(db, "controlplaneworkflowrecords"),
    eventRecords: await maybeCollection(db, "eventrecords"),
  };

  const domainMatch = domain ? { domain } : {};

  const [mailImports, leadCadences, masterProspects, workflowSignals, eventSignals] =
    await Promise.all([
      collections.mailImports
        ? collections.mailImports.countDocuments({ ...domainMatch, updatedAt: { $gte: start, $lt: end } })
        : 0,
      collections.leadCadences
        ? collections.leadCadences.countDocuments({
            ...domainMatch,
            createdAt: { $gte: start, $lt: end },
            $or: [
              { sourceName: MAILER_REGEX },
              { sourceChannel: MAILER_REGEX },
              { "metadata.sourceName": MAILER_REGEX },
              { "metadata.routeCampaignName": MAILER_REGEX },
              { "metadata.routeCampaignKey": MAILER_REGEX },
              { "payloadSnapshot.vendor": MAILER_REGEX },
            ],
          })
        : 0,
      collections.masterProspects
        ? collections.masterProspects.countDocuments({
            ...domainMatch,
            updatedAt: { $gte: start, $lt: end },
            $or: [
              { intakeRoute: MAILER_REGEX },
              { partnerSource: MAILER_REGEX },
              { "metadata.intakeSource": MAILER_REGEX },
              { "metadata.sourceName": MAILER_REGEX },
              { "metadata.routeCampaignName": MAILER_REGEX },
              { "metadata.routeCampaignKey": MAILER_REGEX },
              { "mailIntake.importBatch": { $type: "string", $ne: "" } },
            ],
          })
        : 0,
      collections.workflowRecords
        ? collections.workflowRecords
            .find(
              {
                ...domainMatch,
                happenedAt: { $gte: start, $lt: end },
                $or: [
                  { family: MAILER_REGEX },
                  { subtype: MAILER_REGEX },
                  { sourceService: MAILER_REGEX },
                  { title: MAILER_REGEX },
                  { summary: MAILER_REGEX },
                  { "payload.sourceName": MAILER_REGEX },
                  { "payload.routeCampaignName": MAILER_REGEX },
                  { "payload.importBatch": MAILER_REGEX },
                ],
              },
              {
                projection: {
                  domain: 1,
                  family: 1,
                  subtype: 1,
                  stage: 1,
                  caseId: 1,
                  title: 1,
                  sourceService: 1,
                  happenedAt: 1,
                  aggregateId: 1,
                  "payload.sourceName": 1,
                  "payload.routeCampaignName": 1,
                  "payload.importBatch": 1,
                  "result.caseId": 1,
                },
              },
            )
            .sort({ happenedAt: -1 })
            .limit(200)
            .toArray()
        : [],
      collections.eventRecords
        ? collections.eventRecords
            .find(
              {
                ...domainMatch,
                createdAt: { $gte: start, $lt: end },
                $or: [
                  { eventType: MAILER_REGEX },
                  { sourceService: MAILER_REGEX },
                  { "payload.sourceName": MAILER_REGEX },
                  { "payload.routeCampaignName": MAILER_REGEX },
                  { "payload.importBatch": MAILER_REGEX },
                ],
              },
              {
                projection: {
                  eventType: 1,
                  sourceService: 1,
                  aggregateType: 1,
                  aggregateId: 1,
                  status: 1,
                  createdAt: 1,
                  "payload.caseId": 1,
                  "payload.sourceName": 1,
                  "payload.routeCampaignName": 1,
                  "payload.importBatch": 1,
                },
              },
            )
            .sort({ createdAt: -1 })
            .limit(200)
            .toArray()
        : [],
    ]);

  return {
    counts: {
      mailImports,
      leadCadences,
      masterProspects,
      workflowSignals: workflowSignals.length,
      eventSignals: eventSignals.length,
    },
    workflowSignals: workflowSignals.map(compact),
    eventSignals: eventSignals.map(compact),
  };
}

async function missingSourceCandidates({ caseProfiles, paymentLedgers, domain, start, end }) {
  if (!caseProfiles) return [];
  const match = {
    firstPaymentDate: { $gte: start, $lt: end },
    initialPayment: { $gt: 0 },
    $and: [
      {
        $or: [
          { sourceCanonicalId: null },
          { sourceCanonicalId: { $exists: false } },
          { sourceName: null },
          { sourceName: { $exists: false } },
          { sourceName: /^unknown$/i },
        ],
      },
    ],
  };
  if (domain) match.domain = domain;
  const rows = await caseProfiles
    .find(match, {
      projection: {
        domain: 1,
        caseId: 1,
        customerName: 1,
        initialPayment: 1,
        firstPaymentDate: 1,
        sourceName: 1,
        sourceId: 1,
        sourceCanonicalId: 1,
        "metadata.sourceName": 1,
        "metadata.logicsSourceName": 1,
        "metadata.routeCampaignKey": 1,
        "metadata.routeCampaignName": 1,
      },
    })
    .sort({ firstPaymentDate: 1 })
    .limit(100)
    .toArray();

  if (!paymentLedgers || rows.length === 0) return rows.map(compact);
  const keys = rows.map((row) => ({ domain: row.domain, caseId: row.caseId }));
  const ledgers = await paymentLedgers
    .find(
      { $or: keys, paymentDate: { $gte: start, $lt: end }, paymentType: "initial" },
      { projection: { domain: 1, caseId: 1, amount: 1, paymentDate: 1, sourceName: 1, sourceChannel: 1 } },
    )
    .toArray();
  const ledgerByKey = new Map(ledgers.map((row) => [`${row.domain}:${row.caseId}`, compact(row)]));
  return rows.map((row) => compact({ ...row, paymentLedger: ledgerByKey.get(`${row.domain}:${row.caseId}`) || null }));
}

function sourceSignalMatch() {
  return {
    $or: [
      { sourceName: { $in: [LD_REGEX, MAILER_REGEX] } },
      { sourceChannel: { $in: [LD_REGEX, MAILER_REGEX] } },
      { routeCampaignKey: { $in: [LD_REGEX, MAILER_REGEX] } },
      { routeCampaignName: { $in: [LD_REGEX, MAILER_REGEX] } },
      { vendor: { $in: [LD_REGEX, MAILER_REGEX] } },
      { partnerSource: { $in: [LD_REGEX, MAILER_REGEX] } },
      { intakeRoute: { $in: [LD_REGEX, MAILER_REGEX] } },
      { source: { $in: [LD_REGEX, MAILER_REGEX] } },
      { channel: { $in: [LD_REGEX, MAILER_REGEX] } },
      { campaign: { $in: [LD_REGEX, MAILER_REGEX] } },
      { family: { $in: [LD_REGEX, MAILER_REGEX] } },
      { subtype: { $in: [LD_REGEX, MAILER_REGEX] } },
      { title: { $in: [LD_REGEX, MAILER_REGEX] } },
      { summary: { $in: [LD_REGEX, MAILER_REGEX] } },
      { sourceService: { $in: [LD_REGEX, MAILER_REGEX] } },
      { eventType: { $in: [LD_REGEX, MAILER_REGEX] } },
      { "payload.sourceName": { $in: [LD_REGEX, MAILER_REGEX] } },
      { "payload.routeCampaignKey": { $in: [LD_REGEX, MAILER_REGEX] } },
      { "payload.routeCampaignName": { $in: [LD_REGEX, MAILER_REGEX] } },
      { "payload.importBatch": { $in: [LD_REGEX, MAILER_REGEX] } },
      { "payload.vendor": { $in: [LD_REGEX, MAILER_REGEX] } },
      { "payload.partnerSource": { $in: [LD_REGEX, MAILER_REGEX] } },
      { "metadata.sourceName": { $in: [LD_REGEX, MAILER_REGEX] } },
      { "metadata.routeCampaignKey": { $in: [LD_REGEX, MAILER_REGEX] } },
      { "metadata.routeCampaignName": { $in: [LD_REGEX, MAILER_REGEX] } },
      { "metadata.logicsSourceName": { $in: [LD_REGEX, MAILER_REGEX] } },
      { "metadata.intakeSource": { $in: [LD_REGEX, MAILER_REGEX] } },
      { "payloadSnapshot.vendor": { $in: [LD_REGEX, MAILER_REGEX] } },
      { "payloadSnapshot.sourceName": { $in: [LD_REGEX, MAILER_REGEX] } },
      { "payloadSnapshot.routeCampaignKey": { $in: [LD_REGEX, MAILER_REGEX] } },
      { "payloadSnapshot.routeCampaignName": { $in: [LD_REGEX, MAILER_REGEX] } },
      { "raw.familyKey": { $in: [LD_REGEX, MAILER_REGEX] } },
    ],
  };
}

async function fetchRestoreSignalRows({ collection, sourceCollection, domain, start, end, dateField, limit }) {
  if (!collection) return [];
  const domainMatch = domain ? { domain } : {};
  const rows = await collection
    .find(
      {
        ...domainMatch,
        [dateField]: { $gte: start, $lt: end },
        ...sourceSignalMatch(),
      },
      {
        projection: {
          domain: 1,
          caseId: 1,
          phone: 1,
          sourceName: 1,
          sourceChannel: 1,
          routeCampaignKey: 1,
          routeCampaignName: 1,
          vendor: 1,
          partnerSource: 1,
          intakeRoute: 1,
          source: 1,
          channel: 1,
          campaign: 1,
          family: 1,
          subtype: 1,
          stage: 1,
          title: 1,
          summary: 1,
          sourceService: 1,
          eventType: 1,
          aggregateId: 1,
          aggregateType: 1,
          status: 1,
          createdAt: 1,
          happenedAt: 1,
          updatedAt: 1,
          payload: 1,
          result: 1,
          metadata: 1,
          payloadSnapshot: 1,
          raw: 1,
        },
      },
    )
    .sort({ [dateField]: -1, _id: -1 })
    .limit(limit)
    .toArray();

  return rows
    .map((row) => {
      const signal = sourceSignalFromRow(row);
      const family = classifySourceFamilyFromSignal(signal);
      if (!family) return null;
      return {
        sourceCollection,
        sourceId: row._id,
        date: row[dateField],
        family,
        signal,
        rawHint: {
          eventType: row.eventType,
          family: row.family,
          subtype: row.subtype,
          stage: row.stage,
          status: row.status,
          aggregateType: row.aggregateType,
          aggregateId: row.aggregateId,
          title: row.title,
          summary: row.summary,
          sourceService: row.sourceService,
        },
      };
    })
    .filter(Boolean)
    .map(compact);
}

function hasKnownSource(row = {}) {
  return Boolean(firstValue(row.sourceCanonicalId, row.sourceName, row.sourceChannel, row.routeCampaignKey, row.routeCampaignName));
}

function initialInWindow(row = {}, start, end) {
  const amount = Number(row.initialPayment || row.amount || 0);
  const dateValue = row.firstPaymentDate || row.paymentDate;
  const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
  return amount > 0 && !Number.isNaN(date.getTime()) && date >= start && date < end;
}

async function metricRestoreCandidates({ db, caseProfiles, paymentLedgers, domain, start, end, limit }) {
  const collections = {
    workflowRecords: await maybeCollection(db, "controlplaneworkflowrecords"),
    eventRecords: await maybeCollection(db, "eventrecords"),
  };

  const halfLimit = Math.max(50, Math.ceil(limit / 2));
  const sourceSignals = [
    ...(await fetchRestoreSignalRows({
      collection: collections.workflowRecords,
      sourceCollection: "controlplaneworkflowrecords",
      domain,
      start,
      end,
      dateField: "happenedAt",
      limit: halfLimit,
    })),
    ...(await fetchRestoreSignalRows({
      collection: collections.eventRecords,
      sourceCollection: "eventrecords",
      domain,
      start,
      end,
      dateField: "createdAt",
      limit: halfLimit,
    })),
  ];

  const caseKeys = [...new Set(sourceSignals.map((row) => `${row.signal.domain || ""}:${row.signal.caseId || ""}`).filter((key) => !key.endsWith(":")))];
  const caseMatches = caseKeys.map((key) => {
    const [rowDomain, caseId] = key.split(":");
    const match = { caseId };
    if (rowDomain) match.domain = rowDomain;
    return match;
  });

  const [profiles, ledgers] = await Promise.all([
    caseProfiles && caseMatches.length
      ? caseProfiles
          .find(
            { $or: caseMatches },
            {
              projection: {
                domain: 1,
                caseId: 1,
                customerName: 1,
                initialPayment: 1,
                firstPaymentDate: 1,
                sourceCanonicalId: 1,
                sourceName: 1,
                sourceChannel: 1,
                routeCampaignKey: 1,
                routeCampaignName: 1,
                "metadata.sourceName": 1,
                "metadata.routeCampaignKey": 1,
                "metadata.routeCampaignName": 1,
              },
            },
          )
          .toArray()
      : [],
    paymentLedgers && caseMatches.length
      ? paymentLedgers
          .find(
            {
              $or: caseMatches,
              paymentDate: { $gte: start, $lt: end },
              paymentType: "initial",
              transactionStatus: "SUCCESS",
            },
            {
              projection: {
                domain: 1,
                caseId: 1,
                amount: 1,
                paymentDate: 1,
                paymentType: 1,
                transactionStatus: 1,
                sourceName: 1,
                sourceChannel: 1,
                sourceCanonicalId: 1,
              },
            },
          )
          .toArray()
      : [],
  ]);

  const profileByKey = new Map(profiles.map((row) => [`${row.domain}:${row.caseId}`, row]));
  const ledgersByKey = new Map();
  for (const row of ledgers) {
    const key = `${row.domain}:${row.caseId}`;
    if (!ledgersByKey.has(key)) ledgersByKey.set(key, []);
    ledgersByKey.get(key).push(row);
  }

  const candidates = [];
  const seen = new Set();
  for (const row of sourceSignals) {
    const rowDomain = row.signal.domain || domain || null;
    const caseId = row.signal.caseId || null;
    const key = `${row.sourceCollection}:${row.sourceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const profile = rowDomain && caseId ? profileByKey.get(`${rowDomain}:${caseId}`) : null;
    const ledgerRows = rowDomain && caseId ? ledgersByKey.get(`${rowDomain}:${caseId}`) || [] : [];
    const profileHasJuneInitial = initialInWindow(profile || {}, start, end);
    const ledgerHasJuneInitial = ledgerRows.some((ledger) => initialInWindow(ledger, start, end));
    const sourceKnown = hasKnownSource(profile || {}) || ledgerRows.some(hasKnownSource);
    const reasons = [];

    if (!caseId) reasons.push("source-log-without-case-id");
    if (row.family === "mailer" && (!domain || rowDomain === "TAG")) {
      reasons.push(profileHasJuneInitial || ledgerHasJuneInitial
        ? "tag-mailer-source-evidence-for-existing-june-initial"
        : "tag-mailer-log-evidence-without-june-initial-record");
    }
    if (String(row.family).startsWith("ld") && (!domain || rowDomain === "WYNN")) {
      reasons.push("wynn-ld-log-evidence-for-count-or-cost-review");
    }
    if ((profileHasJuneInitial || ledgerHasJuneInitial) && !sourceKnown) {
      reasons.push("initial-payment-source-missing-but-log-has-source-evidence");
    }
    if (ledgerHasJuneInitial && !profileHasJuneInitial) {
      reasons.push("payment-ledger-initial-not-reflected-on-case-profile");
    }
    if (reasons.length === 0) reasons.push("source-log-evidence-review-only");

    candidates.push(compact({
      reasons: [...new Set(reasons)],
      domain: rowDomain,
      caseId,
      family: row.family,
      sourceCollection: row.sourceCollection,
      sourceId: row.sourceId,
      date: row.date,
      signal: row.signal,
      profile: profile
        ? {
            customerName: profile.customerName,
            initialPayment: profile.initialPayment,
            firstPaymentDate: profile.firstPaymentDate,
            sourceCanonicalId: profile.sourceCanonicalId,
            sourceName: firstValue(profile.sourceName, profile.metadata?.sourceName),
            sourceChannel: profile.sourceChannel,
            routeCampaignKey: firstValue(profile.routeCampaignKey, profile.metadata?.routeCampaignKey),
            routeCampaignName: firstValue(profile.routeCampaignName, profile.metadata?.routeCampaignName),
          }
        : null,
      paymentLedgers: ledgerRows.map((ledger) => ({
        amount: ledger.amount,
        paymentDate: ledger.paymentDate,
        sourceName: ledger.sourceName,
        sourceChannel: ledger.sourceChannel,
        sourceCanonicalId: ledger.sourceCanonicalId,
      })),
      rawHint: row.rawHint,
    }));
  }

  const byReason = new Map();
  const byFamily = new Map();
  for (const candidate of candidates) {
    byFamily.set(candidate.family || "unknown", (byFamily.get(candidate.family || "unknown") || 0) + 1);
    for (const reason of candidate.reasons || []) {
      byReason.set(reason, (byReason.get(reason) || 0) + 1);
    }
  }

  return {
    meaning:
      "Read-only June log evidence that may help reconcile metrics later. This script does not mutate metrics, case profiles, ledgers, spend entries, or logs.",
    limit,
    sourceSignalsScanned: sourceSignals.length,
    candidateCount: candidates.length,
    byFamily: Object.fromEntries([...byFamily.entries()].sort((a, b) => b[1] - a[1])),
    byReason: Object.fromEntries([...byReason.entries()].sort((a, b) => b[1] - a[1])),
    candidates: candidates.slice(0, limit),
  };
}

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.MONGO_URL;
  const month = argValue("--month", DEFAULT_MONTH);
  const domain = normalizeDomain(argValue("--domain", ""));
  const outPath = argValue("--out", "");
  const includeLdMaterializer = process.argv.includes("--ld-materializer");
  const restoreCandidateLimit = Number(argValue("--restore-candidate-limit", DEFAULT_RESTORE_CANDIDATE_LIMIT));
  if (!uri) throw new Error("MONGO_URI is required");
  if (!Number.isFinite(restoreCandidateLimit) || restoreCandidateLimit < 1) {
    throw new Error("--restore-candidate-limit must be a positive number");
  }
  const { start, end } = monthWindow(month);

  await mongoose.connect(uri, { dbName: DEFAULT_DB });
  const db = mongoose.connection.db;
  const caseProfiles = await maybeCollection(db, "controlplanecaseprofiles");
  const paymentLedgers = await maybeCollection(db, "controlplanepaymentledgers");

  const businessReconciliation = {};
  if (!domain || domain === "TAG") {
    businessReconciliation.tagInitials = await tagInitialReconciliation({
      domain: "TAG",
      start,
      end,
    });
  }
  if (!domain || domain === "WYNN") {
    businessReconciliation.wynnLdCountCost = await wynnLdCountCostReconciliation({
      db,
      domain: "WYNN",
      start,
      end,
      month,
      includeMaterializer: includeLdMaterializer,
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    db: mongoose.connection.name,
    month,
    domain: domain || "ALL",
    window: { start: start.toISOString(), end: end.toISOString() },
    businessReconciliation,
    caseProfileInitials: await caseProfileInitials({ caseProfiles, domain, start, end }),
    paymentLedgerInitials: await paymentLedgerInitials({ paymentLedgers, domain, start, end }),
    missingSourceInitialCandidates: await missingSourceCandidates({ caseProfiles, paymentLedgers, domain, start, end }),
    mailerEvidence: await mailerEvidence({ db, domain, start, end }),
    metricRestoreCandidates: await metricRestoreCandidates({
      db,
      caseProfiles,
      paymentLedgers,
      domain,
      start,
      end,
      limit: restoreCandidateLimit,
    }),
  };

  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (outPath) {
    const resolved = path.resolve(outPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, output);
    console.log(`Wrote ${resolved}`);
  }
  console.log(output);
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error.stack || error.message || error);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore disconnect errors
  }
  process.exit(1);
});
