"use strict";

function toDate(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? new Date(ms) : null;
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

  return {
    saveSessionSnapshot,
  };
}

module.exports = {
  createLiveCoachMongoPersistence,
};
