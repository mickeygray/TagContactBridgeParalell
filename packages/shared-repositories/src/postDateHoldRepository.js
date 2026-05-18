"use strict";

const mongoose = require("mongoose");
const { PostDateHold } = require("../../shared-models/src");

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

function asDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function buildDateKeyQuery(field, filters = {}) {
  const query = {};
  if (filters.date) {
    query[field] = String(filters.date);
    return query;
  }
  const range = {};
  if (filters.from) range.$gte = String(filters.from);
  if (filters.to) range.$lte = String(filters.to);
  if (Object.keys(range).length > 0) query[field] = range;
  return query;
}

async function upsertActivePostDateHold(domain, caseId, patch = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const numericCaseId = Number(caseId);
  if (!normalizedDomain || !Number.isFinite(numericCaseId)) {
    throw new Error("domain and numeric caseId are required for PostDateHold");
  }

  const historyEntry = patch.historyEntry || {
    type: "postdate-recorded",
    actorEmail: patch.postDatedByEmail || null,
    note: "Post-date status recorded from Logics update.",
  };
  const { historyEntry: _historyEntry, ...rest } = patch;
  const postDatedAt = asDate(rest.postDatedAt) || new Date();
  const update = {
    $set: {
      ...rest,
      domain: normalizedDomain,
      caseId: numericCaseId,
      status: "active",
      postDatedAt,
      postDatedDateKey:
        rest.postDatedDateKey || postDatedAt.toISOString().slice(0, 10),
    },
    $push: {
      history: {
        at: new Date(),
        ...historyEntry,
      },
    },
  };

  return PostDateHold.findOneAndUpdate(
    {
      domain: normalizedDomain,
      caseId: numericCaseId,
      status: "active",
    },
    update,
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
}

async function listPostDateHolds(domain, filters = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const query = {};
  if (normalizedDomain && normalizedDomain !== "ALL") query.domain = normalizedDomain;
  if (filters.status && String(filters.status).toLowerCase() !== "all") {
    query.status = String(filters.status).toLowerCase();
  }
  if (filters.caseId != null && filters.caseId !== "") {
    query.caseId = Number(filters.caseId);
  }
  Object.assign(query, buildDateKeyQuery("postDatedDateKey", filters));
  if (filters.firstPaymentDueOnOrBefore) {
    query.firstPaymentDateKey = { $lte: String(filters.firstPaymentDueOnOrBefore) };
  }
  if (filters.firstPaymentDueFrom || filters.firstPaymentDueTo) {
    query.firstPaymentDateKey = {
      ...(query.firstPaymentDateKey || {}),
      ...(filters.firstPaymentDueFrom ? { $gte: String(filters.firstPaymentDueFrom) } : {}),
      ...(filters.firstPaymentDueTo ? { $lte: String(filters.firstPaymentDueTo) } : {}),
    };
  }

  const limit = Math.min(Number(filters.limit) || 100, 500);
  return PostDateHold.find(query)
    .sort({ status: 1, firstPaymentDateKey: 1, postDatedAt: -1, caseId: -1 })
    .limit(limit)
    .lean();
}

async function findPostDateHold(domain, idOrCaseId) {
  const normalizedDomain = normalizeDomain(domain);
  const raw = String(idOrCaseId || "").trim();
  const query = { domain: normalizedDomain };
  if (mongoose.Types.ObjectId.isValid(raw)) {
    query._id = raw;
  } else {
    const caseId = Number(raw);
    if (!Number.isFinite(caseId)) return null;
    query.caseId = caseId;
    query.status = "active";
  }
  return PostDateHold.findOne(query).lean();
}

async function updatePostDateHold(id, patch = {}, historyEntry = null) {
  const update = { $set: patch };
  if (historyEntry) {
    update.$push = {
      history: {
        at: new Date(),
        ...historyEntry,
      },
    };
  }
  return PostDateHold.findByIdAndUpdate(id, update, { new: true }).lean();
}

async function markPostDateHoldPaymentVerified(id, patch = {}) {
  return updatePostDateHold(
    id,
    {
      ...patch,
      status: "payment_verified",
      "paymentCheck.lastCheckedAt": patch.checkedAt || new Date(),
      "paymentCheck.lastResult": "success",
    },
    {
      type: "payment-verified",
      note: "First payment was successful; post-date hold closed.",
      payload: patch,
    },
  );
}

async function markPostDateHoldReleased(id, patch = {}) {
  const releasedAt = asDate(patch.releasedAt) || new Date();
  return updatePostDateHold(
    id,
    {
      ...patch,
      status: "released",
      releasedAt,
    },
    {
      type: "postdate-released",
      actorEmail: patch.releasedByEmail || null,
      note: patch.releaseReason || "Post-date released back to open.",
      payload: patch,
    },
  );
}

async function markPostDateHoldReview(id, patch = {}) {
  return updatePostDateHold(
    id,
    {
      ...patch,
      status: "review",
      "paymentCheck.lastCheckedAt": patch.checkedAt || new Date(),
      "paymentCheck.lastResult": patch.reviewReason || "review",
    },
    {
      type: "postdate-review",
      note: patch.reviewReason || "Post-date hold requires review.",
      payload: patch,
    },
  );
}

async function markPostDateHoldReleaseFailed(id, patch = {}) {
  return updatePostDateHold(
    id,
    {
      ...patch,
      status: "release_failed",
      "paymentCheck.lastCheckedAt": patch.checkedAt || new Date(),
      "paymentCheck.lastResult": "release_failed",
    },
    {
      type: "postdate-release-failed",
      actorEmail: patch.releasedByEmail || null,
      note: patch.error || "Post-date release failed.",
      payload: patch,
    },
  );
}

module.exports = {
  findPostDateHold,
  listPostDateHolds,
  markPostDateHoldPaymentVerified,
  markPostDateHoldReleased,
  markPostDateHoldReleaseFailed,
  markPostDateHoldReview,
  updatePostDateHold,
  upsertActivePostDateHold,
};
