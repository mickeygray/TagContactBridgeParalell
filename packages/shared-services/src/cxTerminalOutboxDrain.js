"use strict";

// M11 gate 2 — pure-core drain for the durable terminal outbox.
//
// Replays pending terminal rows into the cadence/Logics writer OUTSIDE the live call loop, so a
// process that died after the outbox insert but before the cadence write still counts the call on
// the next drain. All I/O is injected, so it unit-tests with fakes and no Mongo.

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
      logger.warn?.("cxTerminalOutboxDrain scan failed", { err: err?.message });
      return { scanned: 0, drained: 0, failed: 0, scanError: true };
    }
    const pending = Array.isArray(rawPending) ? rawPending : [];
    if (!Array.isArray(rawPending)) {
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
      if (!row || !row.payload) {
        // No replayable payload — mark drained so it can't wedge the queue; the queue-item
        // terminal transition is the backstop count for this edge.
        await outboxRepository.markDrained(row && row.idemKey).catch(() => null);
        continue;
      }
      try {
        const packet = enrichTerminalPacket
          ? await enrichTerminalPacket({ row, payload: row.payload })
          : { row, payload: row.payload };
        const terminalResult = await recordCadenceEvent(packet.payload);
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
          } catch (err) {
            callNotesFailed += 1;
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
          } catch (err) {
            callWrapFailed += 1;
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
    return result;
  }

  return { drainOnce };
}

module.exports = { createCxTerminalOutboxDrain };
