"use strict";

// PHONEBURNER RECORDING BACKFILL — put the listen URL on the dial attempt.
//
// Mickey 2026-07-28: "turns out its unlimited on phone burner for premium so
// as long as we keep the url somewhere we can pull the call at any time. so
// since we are writing that call log anyway that sorta makes sense to be
// something our mongo deals with. but logics stuff call rail stuff rc stuff
// should probably be pulled at the time of generation."
//
// ── WHY THIS ONE THING IS STORED ────────────────────────────────────────
// Everything else re-derives: Logics, CallRail and RingCentral are queried
// live because they answer by date reliably and cheaply. PhoneBurner does
// not — its dial SESSIONS are awkward to enumerate after the fact, while
// the attempt itself is already OUR record (DailyDial, written from callback
// capture). So the URL rides along with a row we were writing anyway.
// Storage here is not a copy of someone else's stats; it is one more field
// on our own call log.
//
// ── WHY IT NEEDS A BACKFILL AT ALL ──────────────────────────────────────
// The recording does not exist at callback time — the call has only just
// ended. `dailyDialLedgerService.recordAttempt` already accepts
// `recordingUrl` and `dailyDialCallLogProjectionService` already projects it
// into CallLog.recordingArchive.sourceUri. The entire pipe was built and
// nothing ever supplied the value: 9,297 recent attempts, zero URLs. This
// closes that one link, after the fact, where the recording now exists.
//
// DELIBERATELY STANDALONE: it reads sessions and patches DailyDial without
// touching the capture path, so a concurrent refactor of the serving queue
// cannot collide with it.

const DailyDial = require("../../shared-models/src/DailyDial");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch a day's dial sessions and index every call that has a recording,
 * keyed by providerCallId — the same id DailyDial attempts already carry.
 */
async function indexRecordingsByCallId({
  dateKey, client, maxSessions = 25, pageDelayMs = 400, logger = null,
} = {}) {
  const byCallId = new Map();
  if (!client) return byCallId;
  try {
    const list = await client.listDialSessions({
      dateStart: dateKey, dateEnd: dateKey, pageSize: Math.min(maxSessions, 100),
    });
    if (!list?.ok) {
      logger?.warn?.("pb_backfill.list_failed", { dateKey, reason: list?.reason });
      return byCallId;
    }
    const sessions = list.sessions || [];
    for (const [i, session] of sessions.slice(0, maxSessions).entries()) {
      const detail = await client.getDialSession(session.dialSessionId, { includeRecording: true });
      if (detail?.ok) {
        for (const call of detail.session?.calls || []) {
          if (call.callId && call.recordingUrl) {
            byCallId.set(String(call.callId), {
              recordingUrl: call.recordingUrl,
              hasTranscript: Boolean(call.transcript || call.transcriptId),
            });
          }
        }
      }
      // PhoneBurner is not a bulk API — trickle, do not hammer.
      if (i < sessions.length - 1) await sleep(pageDelayMs);
    }
  } catch (error) {
    logger?.warn?.("pb_backfill.index_failed", { dateKey, error: String(error.message).slice(0, 140) });
  }
  return byCallId;
}

/**
 * Patch recordingUrl onto the day's attempts. Idempotent: an attempt that
 * already has a URL is left alone, so re-running is free.
 */
async function backfillRecordingUrls({
  dateKey, client, apply = false, maxSessions = 25, logger = null,
} = {}) {
  const index = await indexRecordingsByCallId({ dateKey, client, maxSessions, logger });
  const docs = await DailyDial.find({ dateKey }).select("domain caseId dateKey attempts").lean();

  let attemptsSeen = 0;
  let matched = 0;
  let alreadyHad = 0;
  const updates = [];

  for (const doc of docs) {
    let changed = false;
    const attempts = (doc.attempts || []).map((a) => {
      attemptsSeen += 1;
      if (a.recordingUrl) { alreadyHad += 1; return a; }
      const hit = index.get(String(a.providerCallId));
      if (!hit) return a;
      matched += 1;
      changed = true;
      return { ...a, recordingUrl: hit.recordingUrl };
    });
    if (changed) {
      updates.push({
        updateOne: {
          filter: { domain: doc.domain, caseId: doc.caseId, dateKey: doc.dateKey },
          update: { $set: { attempts } },
        },
      });
    }
  }

  let written = 0;
  if (apply && updates.length) {
    const res = await DailyDial.bulkWrite(updates, { ordered: false });
    written = res.modifiedCount || 0;
  }

  return {
    dateKey,
    sessionsIndexed: index.size,
    attemptsSeen,
    alreadyHad,
    matched,
    docsToUpdate: updates.length,
    written,
    applied: Boolean(apply),
  };
}

/** Read the stored URLs back — what the report layer consumes. */
async function listStoredPhoneBurnerRecordings({ dateKey, minDurationSec = 0 } = {}) {
  const docs = await DailyDial.find({
    dateKey, "attempts.recordingUrl": { $ne: null, $exists: true },
  }).select("domain caseId attempts").lean();

  const out = [];
  for (const doc of docs) {
    for (const a of doc.attempts || []) {
      if (!a.recordingUrl) continue;
      const durationSec = Number(a.durationSeconds) || 0;
      if (durationSec < minDurationSec) continue;
      out.push({
        platform: "phoneburner",
        callId: a.providerCallId,
        caseId: Number(doc.caseId) || doc.caseId,
        domain: String(doc.domain || "").toUpperCase(),
        agent: a.agentId || null,
        outcome: a.outcome || null,
        connected: a.connected,
        durationSec,
        minutes: Math.round(durationSec / 6) / 10,
        listenUrl: a.recordingUrl,
      });
    }
  }
  return out.sort((a, b) => b.durationSec - a.durationSec);
}

module.exports = {
  backfillRecordingUrls,
  indexRecordingsByCallId,
  listStoredPhoneBurnerRecordings,
};
