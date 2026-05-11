"use strict";

const { RcOAuthState } = require("../../shared-models/src");

async function createState(payload) {
  const doc = new RcOAuthState({
    createdAt: new Date(),
    ...payload,
  });
  return doc.save();
}

function findByState(state) {
  return RcOAuthState.findOne({ state }).lean();
}

async function consumeByState(state, { error = null } = {}) {
  const update = {
    $set: {
      consumed: true,
      consumedAt: new Date(),
      ...(error ? { consumeError: error } : {}),
    },
  };
  return RcOAuthState.findOneAndUpdate(
    { state, consumed: false, expiresAt: { $gt: new Date() } },
    update,
    { new: true, lean: true },
  );
}

function listRecent({ limit = 50 } = {}) {
  return RcOAuthState.find({}).sort({ createdAt: -1 }).limit(limit).lean();
}

async function purgeExpired() {
  // Mongo TTL handles this automatically; this is the manual fallback.
  const result = await RcOAuthState.deleteMany({
    expiresAt: { $lte: new Date() },
  });
  return { deletedCount: result.deletedCount };
}

module.exports = {
  createState,
  findByState,
  consumeByState,
  listRecent,
  purgeExpired,
};
