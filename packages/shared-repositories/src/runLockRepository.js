"use strict";

const crypto = require("crypto");
const { RunLock } = require("../../shared-models/src");

function normalizeName(name) {
  return String(name || "").trim();
}

function createToken() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString("hex");
}

async function acquireRunLock(name, ttlMs, lockedBy = "process") {
  const lockName = normalizeName(name);
  if (!lockName) {
    throw new Error("run lock name is required");
  }

  const ttl = Math.max(Number(ttlMs) || 0, 1000);
  const now = new Date();
  const token = createToken();
  const lockedUntil = new Date(now.getTime() + ttl);

  try {
    const doc = await RunLock.findOneAndUpdate(
      {
        _id: lockName,
        $or: [
          { lockedUntil: { $exists: false } },
          { lockedUntil: null },
          { lockedUntil: { $lte: now } },
        ],
      },
      {
        $set: {
          token,
          lockedBy: String(lockedBy || "process"),
          lockedAt: now,
          lockedUntil,
        },
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      },
    ).lean();

    if (!doc || doc.token !== token) {
      return null;
    }

    return {
      name: lockName,
      token,
      lockedUntil,
    };
  } catch (err) {
    if (err && err.code === 11000) {
      return null;
    }
    throw err;
  }
}

async function releaseRunLock(name, token) {
  const lockName = normalizeName(name);
  const lockToken = String(token || "").trim();
  if (!lockName || !lockToken) return { deletedCount: 0 };
  return RunLock.deleteOne({
    _id: lockName,
    token: lockToken,
  });
}

async function extendRunLock(name, token, ttlMs) {
  const lockName = normalizeName(name);
  const lockToken = String(token || "").trim();
  if (!lockName || !lockToken) return null;
  const ttl = Math.max(Number(ttlMs) || 0, 1000);
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + ttl);
  const doc = await RunLock.findOneAndUpdate(
    {
      _id: lockName,
      token: lockToken,
      lockedUntil: { $gt: now },
    },
    { $set: { lockedUntil } },
    { new: true },
  ).lean();
  if (!doc) return null;
  return { name: lockName, token: lockToken, lockedUntil };
}

module.exports = {
  acquireRunLock,
  extendRunLock,
  releaseRunLock,
};
