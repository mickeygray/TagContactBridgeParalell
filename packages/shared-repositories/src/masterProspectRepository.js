"use strict";

const { MasterProspectIndex } = require("../../shared-models/src");

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildSearchQuery(search) {
  const value = String(search || "").trim();
  if (!value) return null;

  const regex = new RegExp(escapeRegex(value), "i");
  const digits = value.replace(/\D/g, "");
  const numericCaseId = Number(value);
  const orConditions = [
    { name: regex },
    { firstName: regex },
    { lastName: regex },
    { email: regex },
    { cellPhone: regex },
    { homePhone: regex },
    { workPhone: regex },
  ];

  if (digits) {
    orConditions.push({ normalizedPhones: digits });
  }

  if (Number.isFinite(numericCaseId) && value === String(numericCaseId)) {
    orConditions.push({ caseId: numericCaseId });
  }

  return { $or: orConditions };
}

async function findMasterProspect(domain, caseId) {
  return MasterProspectIndex.findOne({
    domain: String(domain || "").toUpperCase(),
    caseId: Number(caseId),
  });
}

/**
 * Look up the prospect by any of its phone fields using the normalized
 * 10-digit representation. Used by the call attribution resolver to find
 * the case for an inbound caller number.
 */
async function findMasterProspectByNormalizedPhone(domain, phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return null;
  const tenDigit = digits.length === 11 && digits.startsWith("1")
    ? digits.slice(1)
    : digits.slice(-10);
  if (tenDigit.length !== 10) return null;

  // Smoke-tests + intake retries can produce multiple prospect rows for
  // the same phone. Prefer the freshest one (latest createdAt) so the
  // CX scramble lands on the most recent intake rather than a stale
  // first-touch row from weeks ago.
  return MasterProspectIndex.findOne({
    domain: String(domain || "").toUpperCase(),
    $or: [
      { normalizedPhones: tenDigit },
      { cellPhone: new RegExp(tenDigit + "$") },
      { homePhone: new RegExp(tenDigit + "$") },
      { workPhone: new RegExp(tenDigit + "$") },
    ],
  })
    .sort({ createdAt: -1, updatedAt: -1, _id: -1 })
    .lean();
}

/**
 * Atomically append a telephonySessionId to the prospect's history.
 * No-op if already present. Uses `$addToSet` so we don't duplicate.
 */
async function pushTelephonySessionId(domain, caseId, telephonySessionId) {
  const normalizedId = String(telephonySessionId || "").trim();
  if (!normalizedId) return null;

  return MasterProspectIndex.findOneAndUpdate(
    {
      domain: String(domain || "").toUpperCase(),
      caseId: Number(caseId),
    },
    { $addToSet: { telephonySessionIds: normalizedId } },
    { new: true },
  );
}

/**
 * Upsert a MasterProspectIndex row. Top-level scalar fields (statusId,
 * firstName, etc.) get $set normally. Three reserved keys are handled
 * specially to prevent re-imports / re-observations from clobbering
 * prior data:
 *
 *   - `firstSeenAt`         → moved to $setOnInsert (never overwritten
 *                             on a re-upsert).
 *   - `metadata: {...}`     → flattened to dotted-path $sets so prior
 *                             metadata fields survive a partial update
 *                             (e.g. an NCOA re-upload doesn't blow
 *                             away an earlier validation block).
 *   - `mailIntake: {...}`   → same flatten treatment.
 *
 * `normalizedPhones` is left wholesale because callers that touch it
 * already pass the merged set; we'd need a $addToSet pipeline to do
 * better. Future hardening if dup phone-loss becomes a real issue.
 *
 * Unknown fields (anything not in the schema) get silently dropped by
 * mongoose strict mode — that's expected behavior, but the caller can
 * pass `{ logUnknownFields: true }` in the future if we want to flag
 * them in dev. (Today we just count on schema review.)
 */
async function upsertMasterProspect(domain, caseId, update = {}) {
  const normalizedDomain = String(domain || "").toUpperCase();
  const normalizedCaseId = Number(caseId);

  const $set = {};
  const $setOnInsert = {};

  for (const [key, value] of Object.entries(update || {})) {
    if (value === undefined) continue;
    if (key === "firstSeenAt") {
      // Insert-only — preserve the original observation timestamp on
      // every subsequent upsert. Caller can still override by passing
      // `firstSeenAt` explicitly with `_force: true` (not implemented;
      // hold the line until a real use case appears).
      $setOnInsert.firstSeenAt = value;
      continue;
    }
    if (key === "metadata" && value && typeof value === "object" && !Array.isArray(value)) {
      // Flatten so partial updates merge instead of replacing the
      // whole metadata sub-document.
      for (const [metaKey, metaValue] of Object.entries(value)) {
        if (metaValue === undefined) continue;
        $set[`metadata.${metaKey}`] = metaValue;
      }
      continue;
    }
    if (key === "mailIntake" && value && typeof value === "object" && !Array.isArray(value)) {
      for (const [miKey, miValue] of Object.entries(value)) {
        if (miValue === undefined) continue;
        $set[`mailIntake.${miKey}`] = miValue;
      }
      continue;
    }
    $set[key] = value;
  }

  // `lastSeenAt` is conceptually the inverse of firstSeenAt — always
  // bump on every observation. If the caller didn't pass one, stamp now.
  if ($set.lastSeenAt === undefined) {
    $set.lastSeenAt = new Date();
  }
  if ($setOnInsert.firstSeenAt === undefined) {
    $setOnInsert.firstSeenAt = $set.lastSeenAt;
  }

  const updateDoc = { $set };
  if (Object.keys($setOnInsert).length > 0) {
    updateDoc.$setOnInsert = $setOnInsert;
  }

  return MasterProspectIndex.findOneAndUpdate(
    { domain: normalizedDomain, caseId: normalizedCaseId },
    updateDoc,
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
}

async function updateMasterProspect(domain, caseId, update = {}) {
  return MasterProspectIndex.findOneAndUpdate(
    {
      domain: String(domain || "").toUpperCase(),
      caseId: Number(caseId),
    },
    { $set: update },
    { new: true },
  );
}

async function listProspectsNeedingStatusRefresh(limit = 1000) {
  return MasterProspectIndex.find({
    needsStatusRefresh: true,
    convertedAt: null,
  })
    .sort({ lastStatusCheckAt: 1, createdAt: 1 })
    .limit(limit)
    .lean();
}

async function deleteMasterProspect(domain, caseId) {
  return MasterProspectIndex.deleteOne({
    domain: String(domain || "").toUpperCase(),
    caseId: Number(caseId),
  });
}

/**
 * Streams MasterProspect rows for a domain in pages of `batchSize`, filtering
 * by the given predicate. Used by the nightly cleaner so we don't load every
 * prospect into memory at once on large domains.
 */
async function* iterateMasterProspects(domain, filters = {}, batchSize = 200) {
  const query = {
    domain: String(domain || "").toUpperCase(),
  };
  if (filters.statusId != null) query.statusId = Number(filters.statusId);
  if (filters.missingContact === true) {
    query.$or = [
      { cellPhone: { $in: [null, ""] } },
      { email: { $in: [null, ""] } },
    ];
  }

  const cursor = MasterProspectIndex.find(query)
    .sort({ _id: 1 })
    .batchSize(batchSize)
    .lean();
  // eslint-disable-next-line no-restricted-syntax
  for await (const doc of cursor) {
    yield doc;
  }
}

async function listProspectsByStatusIds(domain, statusIds = []) {
  return MasterProspectIndex.find({
    domain: String(domain || "").toUpperCase(),
    statusId: { $in: statusIds.map((value) => Number(value)) },
    convertedAt: null,
  })
    .select("domain caseId statusId statusCategory sourceId sourceCanonicalId")
    .lean();
}

async function bulkUpsertMasterProspects(rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };

  const operations = rows.map((row) => ({
    updateOne: {
      filter: {
        domain: String(row.domain || "").toUpperCase(),
        caseId: Number(row.caseId),
      },
      update: {
        $set: row.update || {},
        $setOnInsert: {
          domain: String(row.domain || "").toUpperCase(),
          caseId: Number(row.caseId),
          firstSeenAt: row.firstSeenAt || new Date(),
        },
      },
      upsert: true,
    },
  }));

  return MasterProspectIndex.bulkWrite(operations, { ordered: false });
}

/**
 * Name + address search for the CX "no phone match — search by other
 * stuff" path. Mail-intake leads (NCOA, Lexis, mail-house) often land
 * in MasterProspectIndex without a phone, so when an inbound caller
 * doesn't match by phone, the operator can ask for first name / last
 * name / address / city / state and find the matching prospect this
 * way — then tie the inbound phone to that Logics case.
 *
 * All filters are optional; whatever is provided gets ANDed together.
 * Empty filters returns []. Sorted by latest createdAt so the freshest
 * mail-intake row wins when an address has multiple drops.
 */
async function searchMasterProspectByNameAddress(domain, filters = {}) {
  const normalizedDomain = String(domain || "").toUpperCase();
  const query = { domain: normalizedDomain };

  const firstName = String(filters.firstName || "").trim();
  const lastName = String(filters.lastName || "").trim();
  const address = String(filters.address || "").trim();
  const city = String(filters.city || "").trim();
  const state = String(filters.state || "").trim();
  const zip = String(filters.zip || "").trim();

  if (!firstName && !lastName && !address && !city && !state && !zip) {
    return [];
  }

  if (firstName) query.firstName = new RegExp(`^${escapeRegex(firstName)}`, "i");
  if (lastName) query.lastName = new RegExp(`^${escapeRegex(lastName)}`, "i");
  if (address) query.address = new RegExp(escapeRegex(address), "i");
  if (city) query.city = new RegExp(`^${escapeRegex(city)}`, "i");
  if (state) query.state = new RegExp(`^${escapeRegex(state)}$`, "i");
  if (zip) query.zip = new RegExp(`^${escapeRegex(zip)}`);

  const limit = Math.min(Number(filters.limit) || 25, 100);
  return MasterProspectIndex.find(query)
    .sort({ createdAt: -1, updatedAt: -1, _id: -1 })
    .limit(limit)
    .lean();
}

async function listMasterProspects(domain, filters = {}) {
  const query = {
    domain: String(domain || "").toUpperCase(),
  };

  if (filters.statusCategory) query.statusCategory = filters.statusCategory;
  if (filters.statusId != null) query.statusId = Number(filters.statusId);
  if (filters.caseId != null) query.caseId = Number(filters.caseId);
  if (filters.converted === true) query.convertedAt = { $ne: null };
  if (filters.converted === false) query.convertedAt = null;
  if (filters.search) Object.assign(query, buildSearchQuery(filters.search));

  const limit = Math.min(Number(filters.limit) || 50, 200);
  return MasterProspectIndex.find(query)
    .sort({ updatedAt: -1, caseId: -1 })
    .limit(limit)
    .lean();
}

/**
 * Summarize MasterProspects created in a date window, grouped by
 * intake source. Used by the daily pulse to compute "leads today" —
 * direct aggregation on the index so we don't miss rows on busy days
 * (the prior list-200-then-filter approach silently undercounted).
 */
async function summarizeProspectsByIntakeSource(domain, { from, to } = {}) {
  const match = {
    domain: String(domain || "").toUpperCase(),
  };
  if (from || to) {
    match.firstSeenAt = {};
    if (from) match.firstSeenAt.$gte = new Date(from);
    if (to) match.firstSeenAt.$lte = new Date(to);
  }
  return MasterProspectIndex.aggregate([
    { $match: match },
    {
      $group: {
        _id: {
          $ifNull: [
            "$metadata.intakeSource",
            { $ifNull: [{ $toString: "$sourceId" }, "Unknown"] },
          ],
        },
        count: { $sum: 1 },
      },
    },
    { $sort: { count: -1, _id: 1 } },
  ]);
}

async function countMasterProspects(domain, filters = {}) {
  const query = {
    domain: String(domain || "").toUpperCase(),
  };

  if (filters.statusCategory) query.statusCategory = filters.statusCategory;
  if (filters.statusId != null) query.statusId = Number(filters.statusId);
  if (filters.caseId != null) query.caseId = Number(filters.caseId);
  if (filters.converted === true) query.convertedAt = { $ne: null };
  if (filters.converted === false) query.convertedAt = null;
  if (filters.search) Object.assign(query, buildSearchQuery(filters.search));

  return MasterProspectIndex.countDocuments(query);
}

module.exports = {
  searchMasterProspectByNameAddress,
  bulkUpsertMasterProspects,
  countMasterProspects,
  deleteMasterProspect,
  findMasterProspect,
  findMasterProspectByNormalizedPhone,
  iterateMasterProspects,
  listMasterProspects,
  listProspectsByStatusIds,
  listProspectsNeedingStatusRefresh,
  pushTelephonySessionId,
  summarizeProspectsByIntakeSource,
  updateMasterProspect,
  upsertMasterProspect,
};
