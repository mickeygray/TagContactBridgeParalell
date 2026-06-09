"use strict";

function toDate(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function cleanStr(value, max = 200) {
  return String(value == null ? "" : value).trim().slice(0, max);
}

// Compact, PII-light summary of a PRIOR coaching call for cross-call memory:
// which context keys came up, the last coach line, the last prospect line, outcome.
function summarizePriorCall(doc = {}) {
  const memory = doc.memory || {};
  const keys = [];
  for (const row of (Array.isArray(memory.contexts) ? memory.contexts : [])) {
    for (const m of (Array.isArray(row.matches) ? row.matches : [])) {
      const k = cleanStr(m.key, 60);
      if (k && !keys.includes(k)) keys.push(k);
    }
  }
  const coachRows = Array.isArray(memory.coachingSuggestions) ? memory.coachingSuggestions : [];
  const lastCoachLine = coachRows.length ? cleanStr(coachRows[coachRows.length - 1].say, 180) : "";
  const prospectRows = (Array.isArray(memory.transcripts) ? memory.transcripts : [])
    .filter((r) => cleanStr(r.role, 40) === "prospect");
  const lastProspectLine = prospectRows.length ? cleanStr(prospectRows[prospectRows.length - 1].text, 180) : "";
  return {
    sessionId: cleanStr(doc.sessionId || doc._id, 120),
    at: doc.sessionUpdatedAt || doc.lastPersistedAt || null,
    status: cleanStr(doc.status, 40),
    issues: keys.slice(0, 6),
    lastCoachLine,
    lastProspectLine,
  };
}

function createLiveCoachMongoPersistence({ LiveCoachSession, logger } = {}) {
  if (!LiveCoachSession) throw new Error("LiveCoachSession model is required");

  async function saveSessionSnapshot(snapshot = {}, input = {}) {
    const sessionId = String(snapshot.id || snapshot.sessionId || "").trim();
    if (!sessionId) return { ok: false, error: "sessionId is required" };
    const reason = String(input.reason || "event").trim().slice(0, 120) || "event";
    const now = new Date();
    const update = {
      sessionId,
      status: snapshot.status || "listening",
      metadata: snapshot.metadata || {},
      binding: snapshot.binding || null,
      counters: snapshot.counters || {},
      latest: snapshot.latest || {},
      memory: snapshot.memory || {},
      lastEventAt: toDate(snapshot.lastEventAt),
      sessionCreatedAt: toDate(snapshot.createdAt),
      sessionUpdatedAt: toDate(snapshot.updatedAt),
      lastPersistedReason: reason,
      lastPersistedAt: now,
    };
    await LiveCoachSession.updateOne(
      { _id: sessionId },
      { $set: update },
      { upsert: true },
    );
    logger?.debug?.("live_coach.persistence.saved", { sessionId, reason });
    return { ok: true, sessionId, reason };
  }

  // Cross-call coach memory: pull recent PRIOR coaching sessions for the same prospect
  // (by caseId or phone), most-recent first, as compact summaries. Never throws.
  async function loadPriorCallSummaries({ caseId, phone, excludeSessionId, limit = 2 } = {}) {
    const cid = cleanStr(caseId, 120);
    const ph = cleanStr(phone, 40).replace(/\D/g, "");
    const ors = [];
    if (cid) ors.push({ "metadata.caseId": cid });
    if (ph) ors.push({ "metadata.phone": ph }, { "metadata.contactPhone": ph });
    if (!ors.length) return [];
    const query = { $or: ors };
    if (excludeSessionId) query._id = { $ne: String(excludeSessionId) };
    try {
      const rows = await LiveCoachSession.find(query)
        .sort({ lastPersistedAt: -1 })
        .limit(Math.max(1, Math.min(5, Number(limit) || 2)))
        .lean()
        .exec();
      return (rows || [])
        .map(summarizePriorCall)
        .filter((s) => s.issues.length || s.lastCoachLine || s.lastProspectLine);
    } catch (error) {
      logger?.warn?.("live_coach.persistence.prior_call_load_failed", { error: error.message });
      return [];
    }
  }

  return {
    saveSessionSnapshot,
    loadPriorCallSummaries,
  };
}

module.exports = {
  createLiveCoachMongoPersistence,
};
