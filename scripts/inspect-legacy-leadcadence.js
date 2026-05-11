"use strict";

// Diagnostic: peek at the legacy leadcadences collection to see what
// timestamp fields exist + how many rows match common filter shapes.
// Also calls Logics GetCasesByStatus(2) and reports the intersection
// with cadence to validate the WYNN+callfire funnel surprise.
// Throwaway — delete after the audit lands.

const path = require("path");
const mongoose = require("mongoose");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const { createLogicsFacade } = require("../packages/shared-services/src/logicsFacadeService");

const DOMAIN = String(process.argv[2] || "WYNN").toUpperCase();
const STATUS = Number(process.argv[3] || 2);

(async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const dbName = process.env.LEGACY_APP_DB_NAME || "test";
  const db = mongoose.connection.useDb(dbName, { useCache: true });
  const coll = db.collection("leadcadences");

  const total = await coll.countDocuments({ company: DOMAIN });
  const active = await coll.countDocuments({ company: DOMAIN, active: true });

  const sample = await coll
    .find({ company: DOMAIN })
    .sort({ updatedAt: -1, _id: -1 })
    .limit(5)
    .project({
      _id: 1,
      company: 1,
      caseId: 1,
      active: 1,
      createdAt: 1,
      updatedAt: 1,
      created_at: 1,
      createdDate: 1,
      addedAt: 1,
      __v: 1,
      // dump every key on these 5 docs so we can eyeball any
      // alternative timestamp field name we missed.
    })
    .toArray();

  // Field-presence sweep — for each candidate timestamp field, how
  // many rows in this domain have it populated?
  const candidateFields = [
    "createdAt",
    "created_at",
    "createdDate",
    "addedAt",
    "addedOn",
    "insertedAt",
    "intakeDate",
    "firstContactRequestedAt",
    "updatedAt",
  ];
  const fieldCounts = {};
  for (const field of candidateFields) {
    fieldCounts[field] = await coll.countDocuments({
      company: DOMAIN,
      [field]: { $exists: true, $ne: null },
    });
  }

  // Sample 1 doc's full shape so we can see every key it has.
  const fullSample = await coll.findOne({ company: DOMAIN });

  // Funnel breakdown — WYNN+callfire requires statusId=2 + active +
  // primaryPhone, so count each successive narrowing to find where
  // the audience size collapses.
  const funnel = {
    total: total,
    active: active,
    activeWithStatus2: await coll.countDocuments({
      company: DOMAIN,
      active: true,
      $or: [{ statusId: 2 }, { StatusID: 2 }],
    }),
    activeWithPhone: await coll.countDocuments({
      company: DOMAIN,
      active: true,
      $or: [
        { phone: { $exists: true, $nin: [null, ""] } },
        { primaryPhone: { $exists: true, $nin: [null, ""] } },
        { cellPhone: { $exists: true, $nin: [null, ""] } },
      ],
    }),
    activeStatus2WithPhone: await coll.countDocuments({
      company: DOMAIN,
      active: true,
      $or: [{ statusId: 2 }, { StatusID: 2 }],
      $and: [{
        $or: [
          { phone: { $exists: true, $nin: [null, ""] } },
          { primaryPhone: { $exists: true, $nin: [null, ""] } },
          { cellPhone: { $exists: true, $nin: [null, ""] } },
        ],
      }],
    }),
  };

  // Date-range slices: how many active rows were created in each
  // common window? Helpful to sanity-check what the operator sees in
  // the UI when they pick a window.
  const now = new Date();
  const ranges = [
    ["last 24h",  new Date(now.getTime() - 24 * 60 * 60 * 1000)],
    ["last 7d",   new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)],
    ["last 30d",  new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)],
    ["last 90d",  new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)],
  ];
  const dateRangeBreakdown = {};
  for (const [label, since] of ranges) {
    dateRangeBreakdown[label] = await coll.countDocuments({
      company: DOMAIN,
      active: true,
      createdAt: { $gte: since },
    });
  }

  // What active WYNN status IDs even exist? Top distribution to see
  // whether status 2 is the bulk or a tiny slice.
  const statusBuckets = await coll
    .aggregate([
      { $match: { company: DOMAIN, active: true } },
      { $group: { _id: "$statusId", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ])
    .toArray();

  // Live Logics: pull every case currently at the target status.
  // Compare its size to the cadence size and report the intersection
  // counts so we can see exactly where the funnel collapses.
  let logicsProbe = {
    status: STATUS,
    callError: null,
    rawSize: 0,
    rawSample: [],
    asNumberCount: 0,
    asStringCount: 0,
    intersectionByNumber: 0,
    intersectionByString: 0,
    cadenceCaseIdSampleString: [],
    cadenceCaseIdSampleNumber: [],
  };
  try {
    const facade = createLogicsFacade(DOMAIN);
    const ids = await facade.getCasesByStatus(STATUS, { limit: 20000 });
    logicsProbe.rawSize = Array.isArray(ids) ? ids.length : 0;
    logicsProbe.rawSample = (ids || []).slice(0, 5);

    const numberSet = new Set(
      (ids || [])
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value)),
    );
    const stringSet = new Set(
      (ids || []).map((value) => String(value).trim()).filter(Boolean),
    );
    logicsProbe.asNumberCount = numberSet.size;
    logicsProbe.asStringCount = stringSet.size;

    // Walk the active WYNN cadence rows and count how many match by
    // numeric vs string equality. If both are 0 but Logics returned
    // many ids, we likely have an ID-shape mismatch.
    const cadenceCursor = coll.find(
      { company: DOMAIN, active: true },
      { projection: { caseId: 1 } },
    );
    let intersectByNum = 0;
    let intersectByStr = 0;
    let stringSamples = [];
    let numberSamples = [];
    while (await cadenceCursor.hasNext()) {
      const doc = await cadenceCursor.next();
      const raw = doc.caseId;
      const asNum = Number(raw);
      const asStr = String(raw).trim();
      if (Number.isFinite(asNum) && numberSet.has(asNum)) intersectByNum += 1;
      if (asStr && stringSet.has(asStr)) intersectByStr += 1;
      if (stringSamples.length < 5) stringSamples.push(asStr);
      if (numberSamples.length < 5 && Number.isFinite(asNum)) numberSamples.push(asNum);
    }
    logicsProbe.intersectionByNumber = intersectByNum;
    logicsProbe.intersectionByString = intersectByStr;
    logicsProbe.cadenceCaseIdSampleString = stringSamples;
    logicsProbe.cadenceCaseIdSampleNumber = numberSamples;
  } catch (error) {
    logicsProbe.callError = String(error && error.message ? error.message : error);
  }

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    dbName,
    collection: "leadcadences",
    domain: DOMAIN,
    total,
    active,
    fieldCounts,
    sampleHeads: sample.map((row) => ({
      _id: String(row._id),
      caseId: row.caseId,
      active: row.active,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      created_at: row.created_at,
      createdDate: row.createdDate,
      addedAt: row.addedAt,
    })),
    fullDocKeys: fullSample ? Object.keys(fullSample).sort() : null,
    funnel,
    dateRangeBreakdown,
    statusBuckets,
    logicsProbe,
  }, null, 2));

  await mongoose.disconnect();
})().catch(async (error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  try { await mongoose.disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
