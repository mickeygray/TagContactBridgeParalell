"use strict";

const { CxTerminalOutbox } = require("../../shared-models/src");

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D+/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.length === 10 ? digits : null;
}

function normalizeCaseId(value) {
  if (value == null || String(value).trim() === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

// M11 gate 2 — durable terminal-outbox repository. Thin Mongo I/O; the once-semantics live in
// the unique idemKey index, the drain logic lives in cxTerminalOutboxDrain (pure).

function isDuplicateKeyError(error) {
  return Number(error?.code) === 11000 || String(error?.codeName || "") === "DuplicateKey";
}

// SEPARATE CONCERNS, SEPARATE ROUTES (Mickey, 2026-07-07): the drain keeps its safe
// heartbeat for ledger work, but latency-sensitive consumers (the wrap card — the
// human's queue) subscribe HERE and run as soon as the terminal data is gathered.
// In-process only; listeners are fail-soft and never block or fail the insert.
const enqueueListeners = new Set();
function onCxTerminalRowEnqueued(listener) {
  if (typeof listener === "function") enqueueListeners.add(listener);
  return () => enqueueListeners.delete(listener);
}
function notifyEnqueued(row) {
  for (const listener of enqueueListeners) {
    setImmediate(() => {
      try {
        listener(row);
      } catch {
        /* listener errors never touch the write path */
      }
    });
  }
}

// Insert the terminal record exactly once. Returns the created row on the FIRST write, or null if
// a row with this idemKey already exists — the durable dedup that survives a process restart (an
// in-memory Set cannot). The caller treats null as "already counted; do not re-dispatch".
async function insertOnce(row = {}) {
  const idemKey = String(row.idemKey || "").trim();
  if (!idemKey) throw new Error("cxTerminalOutboxRepository.insertOnce requires an idemKey");
  try {
    const doc = await CxTerminalOutbox.create({
      ...row,
      idemKey,
      normalizedPhone: normalizePhone(row.normalizedPhone || row.phone),
      status: "pending",
      attempts: 0,
    });
    const created = doc ? doc.toObject() : null;
    if (created) notifyEnqueued(created); // first write only — duplicates stay silent
    return created;
  } catch (error) {
    if (isDuplicateKeyError(error)) return null;
    throw error;
  }
}

// One batched daily made-call lookup. Case identity is canonical; phone participates
// only for candidates (and historical terminal rows) that genuinely have no case id.
async function listLatestTodayForLeads(input = {}) {
  const domain = String(input.domain || "").trim().toUpperCase();
  if (!domain) return [];
  const caseIds = [...new Set((Array.isArray(input.caseIds) ? input.caseIds : [])
    .map(normalizeCaseId).filter((value) => value != null))];
  const phones = [...new Set((Array.isArray(input.phones) ? input.phones : [])
    .map(normalizePhone).filter(Boolean))];
  const identities = [];
  if (caseIds.length) identities.push({ caseId: { $in: caseIds } });
  if (phones.length) {
    const caseLess = { $or: [{ caseId: null }, { caseId: { $exists: false } }] };
    identities.push({
      $and: [
        caseLess,
        { $or: [{ normalizedPhone: { $in: phones } }, { phone: { $in: phones } }] },
      ],
    });
    // Bounded same-day compatibility for rows written before normalizedPhone existed.
    // The requested-key filter below still admits only the caller's exact phone set.
    identities.push({
      $and: [
        caseLess,
        { $or: [{ normalizedPhone: null }, { normalizedPhone: { $exists: false } }] },
      ],
    });
  }
  if (!identities.length) return [];
  const now = input.now instanceof Date ? input.now : new Date(input.now || Date.now());
  const start = input.startAt instanceof Date ? input.startAt : new Date(input.startAt || now);
  if (!input.startAt) start.setUTCHours(0, 0, 0, 0);
  const rows = await CxTerminalOutbox.find({
    domain,
    createdAt: { $gte: start, $lte: now },
    $or: identities,
  }).sort({ createdAt: -1, _id: -1 }).lean();

  const latest = [];
  const seen = new Set();
  const requested = new Set([
    ...caseIds.map((caseId) => `${domain}:case:${caseId}`),
    ...phones.map((phone) => `${domain}:phone:${phone}`),
  ]);
  for (const row of Array.isArray(rows) ? rows : []) {
    const caseId = normalizeCaseId(row?.caseId);
    const phone = normalizePhone(row?.normalizedPhone || row?.phone);
    const key = caseId != null
      ? `${domain}:case:${caseId}`
      : (phone ? `${domain}:phone:${phone}` : null);
    if (!key || !requested.has(key) || seen.has(key)) continue;
    seen.add(key);
    latest.push(row);
  }
  return latest;
}

// DRAIN HARDENING (2026-07-06, simplified per Mickey's ruling: "we don't need to try 24
// times on something that's never going to work"): failed rows back off between retries so
// a poison row can't churn every ~15s tick; after a FEW attempts the DRAIN resolves the
// lead minimally and clears the row (see cxTerminalOutboxDrain) — nothing parks, nothing
// retries forever, and replay drift is bounded at the attempt cap by construction.
const BACKOFF_BASE_MS = 15_000;
const BACKOFF_CAP_MS = 30 * 60 * 1000;

function computeDrainBackoffMs(attempts = 0) {
  const n = Math.max(Number(attempts) || 0, 1);
  return Math.min(n * n * BACKOFF_BASE_MS, BACKOFF_CAP_MS);
}

// Oldest eligible pending/failed rows for the drain to replay. A failed row waits out its
// backoff window; dead rows never return here.
async function listPendingForDrain(limit = 50) {
  const cap = Math.max(Number(limit) || 0, 1);
  const now = new Date();
  const rows = await CxTerminalOutbox.find({
    $or: [
      { status: "pending" },
      { status: "failed", nextAttemptAt: { $not: { $gt: now } } }, // null OR <= now
    ],
  })
    .sort({ createdAt: 1 })
    .limit(cap)
    .lean();
  return Array.isArray(rows) ? rows : [];
}

async function findByIdemKeys(idemKeys = []) {
  const keys = [...new Set(
    (Array.isArray(idemKeys) ? idemKeys : [])
      .map((key) => String(key || "").trim())
      .filter(Boolean),
  )];
  if (!keys.length) return [];
  const rows = await CxTerminalOutbox.find(
    { idemKey: { $in: keys } },
    {
      idemKey: 1,
      status: 1,
      queueItemId: 1,
      uii: 1,
      outcome: 1,
      source: 1,
    },
  ).lean();
  return Array.isArray(rows) ? rows : [];
}

// Most-recent outbox row for an identity in ANY status. Read-only context lookup for the DNC
// rectification lane (#4): the review path copies the original terminal row's payload shape into a
// NEW correction row rather than mutating the in-flight terminal row. Works even after the original
// drained (status is unfiltered), so a post-drain DNC correction still gets full case context.
async function findByIdentity(input = {}) {
  const sessionId = String(input.sessionId || "").trim();
  const queueItemId = String(input.queueItemId || "").trim();
  const uii = String(input.uii || "").trim();
  if (!sessionId || !queueItemId || !uii) return null;
  return CxTerminalOutbox.findOne({ sessionId, queueItemId, uii })
    .sort({ createdAt: -1 })
    .lean();
}

// Universal retired-call lookup: once an agent/UII pair has a terminal fact in any
// outbox state, that RingCX call identity can never become current again.
async function findByAgentUii(input = {}) {
  const agentId = String(input.agentId || "").trim();
  const uii = String(input.uii || "").trim();
  if (!agentId || !uii) return null;
  return CxTerminalOutbox.findOne({ agentId, uii })
    .sort({ createdAt: -1 })
    .lean();
}

// DEPRECATED for the bulk review path (#4): mutating the in-flight terminal row races the drain and
// can silently lose a DNC correction. The bulk rail now inserts a separate rectification row instead
// (see submitCxBulkLoadReviewOutcome). Left in place for any other caller / rollback.
async function updatePendingOutcomeByIdentity(input = {}) {
  const sessionId = String(input.sessionId || "").trim();
  const queueItemId = String(input.queueItemId || "").trim();
  const uii = String(input.uii || "").trim();
  const outcome = String(input.outcome || "").trim();
  if (!sessionId || !queueItemId || !uii || !outcome) {
    throw new Error("cxTerminalOutboxRepository.updatePendingOutcomeByIdentity requires sessionId, queueItemId, uii, and outcome");
  }
  const reviewedAt = input.reviewedAt instanceof Date ? input.reviewedAt : new Date();
  const source = String(input.source || "agent-auto-review").trim();
  return CxTerminalOutbox.findOneAndUpdate(
    {
      sessionId,
      queueItemId,
      uii,
      status: { $in: ["pending", "failed"] },
    },
    {
      $set: {
        outcome,
        source,
        "payload.outcome": outcome,
        "payload.source": source,
        "payload.reviewedAt": reviewedAt.toISOString(),
        "payload.reviewSource": source,
        lastError: null,
      },
    },
    { new: true },
  ).lean();
}

// CAS: only an in-flight (pending/failed) row can be marked drained. A null return means a
// concurrent drainer already marked it — evidence for the drain layer to log, and the
// double-mark can no longer silently overwrite drainedAt/lastError. `resolution` records
// HOW the row left: "full" effects (default), "minimal", or "malformed".
async function markDrained(idemKey, resolution = null) {
  const key = String(idemKey || "").trim();
  if (!key) return null;
  return CxTerminalOutbox.findOneAndUpdate(
    { idemKey: key, status: { $in: ["pending", "failed"] } },
    {
      $set: {
        status: "drained",
        drainedAt: new Date(),
        ...(resolution ? { resolution } : {}),
        ...(resolution === "minimal" || resolution === "malformed" ? {} : { lastError: null }),
      },
    },
    { new: true },
  ).lean();
}

// Failure path: increment attempts and schedule the backoff. The drain layer decides when
// enough is enough (minimal-resolve + drain) — this function never parks anything.
async function markFailed(idemKey, error) {
  const key = String(idemKey || "").trim();
  if (!key) return null;
  const row = await CxTerminalOutbox.findOneAndUpdate(
    { idemKey: key },
    {
      $set: { status: "failed", lastError: String(error || "drain-failed").slice(0, 500) },
      $inc: { attempts: 1 },
    },
    { new: true },
  ).lean();
  if (!row) return null;
  await CxTerminalOutbox.updateOne(
    { idemKey: key, status: "failed" },
    { $set: { nextAttemptAt: new Date(Date.now() + computeDrainBackoffMs(row.attempts)) } },
  ).catch(() => null);
  return row;
}

module.exports = {
  computeDrainBackoffMs, // exported for pins; pure
  findByAgentUii,
  findByIdemKeys,
  findByIdentity,
  insertOnce,
  listLatestTodayForLeads,
  onCxTerminalRowEnqueued,
  listPendingForDrain,
  markDrained,
  markFailed,
  updatePendingOutcomeByIdentity,
};
