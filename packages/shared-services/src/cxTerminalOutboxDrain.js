"use strict";

// M11 gate 2 — pure-core drain for the durable terminal outbox.
//
// Replays pending terminal rows into the cadence/Logics writer OUTSIDE the live call loop, so a
// process that died after the outbox insert but before the cadence write still counts the call on
// the next drain. All I/O is injected, so it unit-tests with fakes and no Mongo.

const { logCxAlpha } = require("./cxAlphaTraceService");

function summarizeDrainRow(row = {}) {
  const payload = row && row.payload && typeof row.payload === "object" ? row.payload : {};
  return {
    idemKey: row?.idemKey || null,
    domain: payload.domain || row?.domain || null,
    agentEmail: payload.agentEmail || row?.agentEmail || null,
    agentExtensionId: payload.agentExtensionId || row?.agentExtensionId || null,
    queueItemId: payload.queueItemId || row?.queueItemId || null,
    caseId: payload.caseId || row?.caseId || null,
    uii: payload.uii || row?.uii || null,
    outcome: payload.outcome || row?.outcome || null,
    source: payload.source || row?.source || null,
    systemDisposition: payload.systemDisposition || row?.systemDisposition || null,
  };
}

function createCxTerminalOutboxDrain({
  outboxRepository,
  recordCadenceEvent,
  writeCallNote = null,
  enqueueCallWrap = null,
  enrichTerminalPacket = null,
  logger = console,
} = {}) {
  if (!outboxRepository || typeof outboxRepository.listPendingForDrain !== "function") {
    throw new Error("createCxTerminalOutboxDrain requires outboxRepository.listPendingForDrain");
  }
  if (typeof recordCadenceEvent !== "function") {
    throw new Error("createCxTerminalOutboxDrain requires recordCadenceEvent");
  }
  if (enqueueCallWrap != null && typeof enqueueCallWrap !== "function") {
    throw new Error("createCxTerminalOutboxDrain enqueueCallWrap must be a function");
  }
  if (writeCallNote != null && typeof writeCallNote !== "function") {
    throw new Error("createCxTerminalOutboxDrain writeCallNote must be a function");
  }
  if (enrichTerminalPacket != null && typeof enrichTerminalPacket !== "function") {
    throw new Error("createCxTerminalOutboxDrain enrichTerminalPacket must be a function");
  }

  // Process one batch of pending rows. Each row is independent: a replay failure marks THAT row
  // failed (for the next drain to retry) and never aborts the rest of the batch.
  async function drainOnce({ limit = 50 } = {}) {
    let rawPending;
    try {
      rawPending = await outboxRepository.listPendingForDrain(limit);
    } catch (err) {
      logCxAlpha("cx.alpha.drain.scan.failed", { limit, error: err?.message }, { logger });
      logger.warn?.("cxTerminalOutboxDrain scan failed", { err: err?.message });
      return { scanned: 0, drained: 0, failed: 0, scanError: true };
    }
    const pending = Array.isArray(rawPending) ? rawPending : [];
    logCxAlpha("cx.alpha.drain.tick.started", { limit, pendingCount: pending.length }, { logger });
    if (!Array.isArray(rawPending)) {
      logCxAlpha("cx.alpha.drain.scan.non_array", {
        scannedType: rawPending ? typeof rawPending : "null",
      }, { logger });
      logger.warn?.("cxTerminalOutboxDrain listPendingForDrain returned non-array", {
        scannedType: rawPending ? typeof rawPending : "null",
      });
    }
    let drained = 0;
    let failed = 0;
    let callNotesWritten = 0;
    let callNotesSkipped = 0;
    let callNotesFailed = 0;
    let callWrapQueued = 0;
    let callWrapSkipped = 0;
    let callWrapFailed = 0;
    for (const row of pending) {
      logCxAlpha("cx.alpha.drain.row.started", summarizeDrainRow(row), { logger });
      if (!row || !row.payload) {
        // No replayable payload — mark drained so it can't wedge the queue; the queue-item
        // terminal transition is the backstop count for this edge.
        await outboxRepository.markDrained(row && row.idemKey).catch(() => null);
        logCxAlpha("cx.alpha.drain.row.skipped", {
          ...summarizeDrainRow(row),
          reason: "missing-payload",
        }, { logger });
        continue;
      }
      try {
        const packet = enrichTerminalPacket
          ? await enrichTerminalPacket({ row, payload: row.payload })
          : { row, payload: row.payload };
        const terminalResult = await recordCadenceEvent(packet.payload);
        logCxAlpha("cx.alpha.drain.row.replayed", {
          ...summarizeDrainRow(packet.row || row),
          terminalResultOk: terminalResult?.ok !== false,
          terminalSkipped: Boolean(terminalResult?.skipped),
          terminalReason: terminalResult?.reason || null,
        }, { logger });
        if (writeCallNote) {
          try {
            const noteResult = await writeCallNote({
              row: packet.row || row,
              payload: packet.payload,
              terminalResult,
              coachSummary: packet.coachSummary || null,
            });
            if (noteResult?.skipped) callNotesSkipped += 1;
            else callNotesWritten += 1;
            logCxAlpha("cx.alpha.drain.call_note.finished", {
              ...summarizeDrainRow(packet.row || row),
              skipped: Boolean(noteResult?.skipped),
              reason: noteResult?.reason || null,
            }, { logger });
          } catch (err) {
            callNotesFailed += 1;
            logCxAlpha("cx.alpha.drain.call_note.failed", {
              ...summarizeDrainRow(packet.row || row),
              error: err?.message,
            }, { logger });
            logger.warn?.("cxTerminalOutboxDrain call note write failed", {
              idemKey: row.idemKey,
              err: err?.message,
            });
          }
        }
        await outboxRepository.markDrained(row.idemKey);
        drained += 1;
        if (enqueueCallWrap) {
          try {
            const wrapResult = await enqueueCallWrap({
              row: packet.row || row,
              payload: packet.payload,
              terminalResult,
              coachSummary: packet.coachSummary || null,
            });
            if (wrapResult?.skipped) callWrapSkipped += 1;
            else callWrapQueued += 1;
            logCxAlpha("cx.alpha.drain.call_wrap.finished", {
              ...summarizeDrainRow(packet.row || row),
              skipped: Boolean(wrapResult?.skipped),
              reason: wrapResult?.reason || null,
            }, { logger });
          } catch (err) {
            callWrapFailed += 1;
            logCxAlpha("cx.alpha.drain.call_wrap.failed", {
              ...summarizeDrainRow(packet.row || row),
              error: err?.message,
            }, { logger });
            logger.warn?.("cxTerminalOutboxDrain call wrap enqueue failed", {
              idemKey: row.idemKey,
              err: err?.message,
            });
          }
        }
      } catch (err) {
        await outboxRepository
          .markFailed(row.idemKey, err && err.message ? err.message : String(err))
          .catch(() => null);
        logCxAlpha("cx.alpha.drain.row.failed", {
          ...summarizeDrainRow(row),
          error: err?.message || String(err),
        }, { logger });
        logger.warn?.("cxTerminalOutboxDrain replay failed", { idemKey: row.idemKey, err: err?.message });
        failed += 1;
      }
    }
    const result = { scanned: Array.isArray(pending) ? pending.length : 0, drained, failed };
    if (writeCallNote) {
      result.callNotesWritten = callNotesWritten;
      result.callNotesSkipped = callNotesSkipped;
      result.callNotesFailed = callNotesFailed;
    }
    if (enqueueCallWrap) {
      result.callWrapQueued = callWrapQueued;
      result.callWrapSkipped = callWrapSkipped;
      result.callWrapFailed = callWrapFailed;
    }
    logCxAlpha("cx.alpha.drain.tick.finished", result, { logger });
    return result;
  }

  return { drainOnce };
}

module.exports = { createCxTerminalOutboxDrain };
