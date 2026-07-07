"use strict";

const { CxCallWrapCard } = require("../../shared-models/src");

// Thin Mongo I/O for wrap cards. Once-semantics live in the unique idemKey; resolution
// exclusivity lives in the pending→<resolution> CAS. Business rules live in
// cxCallWrapCardService (pure/injected).

function isDuplicateKeyError(error) {
  return Number(error?.code) === 11000 || String(error?.codeName || "") === "DuplicateKey";
}

// Exactly-once card creation (idemKey inherited from the terminal outbox row).
async function insertOnce(card = {}) {
  const idemKey = String(card.idemKey || "").trim();
  if (!idemKey) throw new Error("cxCallWrapCardRepository.insertOnce requires an idemKey");
  try {
    const doc = await CxCallWrapCard.create({ ...card, idemKey, status: "pending" });
    return doc ? doc.toObject() : null;
  } catch (error) {
    if (isDuplicateKeyError(error)) return null;
    throw error;
  }
}

async function findByIdemKey(idemKey) {
  const key = String(idemKey || "").trim();
  if (!key) return null;
  return CxCallWrapCard.findOne({ idemKey: key }).lean();
}

async function listPendingForAgent(agentEmail, { limit = 50 } = {}) {
  const email = String(agentEmail || "").trim().toLowerCase();
  if (!email) return [];
  const rows = await CxCallWrapCard.find({ agentEmail: email, status: "pending" })
    .sort({ calledAt: -1 })
    .limit(Math.min(Math.max(Number(limit) || 50, 1), 200))
    .lean();
  return Array.isArray(rows) ? rows : [];
}

// CAS: only a pending card can resolve, and only once. Null = someone (or the janitor)
// already resolved it — the caller treats that as a no-op, never an error.
async function resolveCard(idemKey, resolution, { resolvedBy = null, detail = null } = {}) {
  const key = String(idemKey || "").trim();
  const status = String(resolution || "").trim();
  if (!key || !["dnc", "appointment", "dismissed", "expired"].includes(status)) return null;
  return CxCallWrapCard.findOneAndUpdate(
    { idemKey: key, status: "pending" },
    {
      $set: {
        status,
        resolvedAt: new Date(),
        resolvedBy: resolvedBy || null,
        resolutionDetail: detail || null,
      },
    },
    { new: true },
  ).lean();
}

// The janitor's scan: pending cards whose 2h clock ran out.
async function listDueForExpiry(now = new Date(), { limit = 100 } = {}) {
  const rows = await CxCallWrapCard.find({ status: "pending", expiresAt: { $lte: now } })
    .sort({ expiresAt: 1 })
    .limit(Math.min(Math.max(Number(limit) || 100, 1), 500))
    .lean();
  return Array.isArray(rows) ? rows : [];
}

module.exports = {
  findByIdemKey,
  insertOnce,
  listDueForExpiry,
  listPendingForAgent,
  resolveCard,
};
