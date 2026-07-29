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
    agentId: payload.agentId || row?.agentId || null,
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

// After this many failed full replays the drain stops trying the effect chain and resolves
// the lead MINIMALLY (Mickey's ruling, 2026-07-06 late): the injected resolveMinimal stamps
// the bare outcome string back onto the queue row, then the row drains. Err on the side of
// caution — better a lead carrying the truth minus the bookkeeping than a row looping.
const MINIMAL_RESOLVE_AFTER_ATTEMPTS = 3;

function createCxTerminalOutboxDrain({
  outboxRepository,
  recordCadenceEvent,
  writeCallNote = null,
  enqueueCallWrap = null,
  enrichTerminalPacket = null,
  handleBadNumberOutcome = null,
  resolveMinimal = null,
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
  if (handleBadNumberOutcome != null && typeof handleBadNumberOutcome !== "function") {
    throw new Error("createCxTerminalOutboxDrain handleBadNumberOutcome must be a function");
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
      return { scanned: 0, drained: 0, failed: 0, minimalResolved: 0, oldestPendingAgeMs: 0, scanError: true };
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
    let minimalResolved = 0;
    let callNotesWritten = 0;
    let callNotesSkipped = 0;
    let callNotesFailed = 0;
    let callWrapQueued = 0;
    let callWrapSkipped = 0;
    let callWrapFailed = 0;
    let badNumberHandled = 0;
    let badNumberSkipped = 0;
    for (const row of pending) {
      logCxAlpha("cx.alpha.drain.row.started", summarizeDrainRow(row), { logger });
      if (!row || !row.payload || !String(row.payload.queueItemId || "").trim()) {
        // MALFORMED (Mickey: "if there is no button press ie a malformed lead do nothing and
        // just drain it"). No payload, or no queue-item identity to tie anything back to —
        // no retries, no writes, out of the queue.
        await outboxRepository.markDrained(row && row.idemKey, "malformed").catch(() => null);
        logCxAlpha("cx.alpha.drain.row.skipped", {
          ...summarizeDrainRow(row),
          reason: !row || !row.payload ? "missing-payload" : "missing-queue-item",
        }, { logger });
        continue;
      }
      if (Number(row.attempts) >= MINIMAL_RESOLVE_AFTER_ATTEMPTS) {
        // MINIMAL RESOLUTION (Mickey: "we don't need to try 24 times on something that's
        // never going to work"). The full effect chain failed repeatedly — stamp the bare
        // outcome string back onto the lead (fail-soft) and clear the row. Nothing parks.
        const minimal = resolveMinimal
          ? await resolveMinimal({ row, payload: row.payload }).catch((err) => ({ ok: false, error: err?.message }))
          : null;
        await outboxRepository.markDrained(row.idemKey, "minimal").catch(() => null);
        minimalResolved += 1;
        logCxAlpha("cx.alpha.drain.row.minimal_resolved", {
          ...summarizeDrainRow(row),
          attempts: row.attempts ?? null,
          lastError: row.lastError || null,
          minimalOk: minimal ? minimal.ok !== false : null,
        }, { logger });
        logger.warn?.("cxTerminalOutboxDrain row resolved MINIMALLY after repeated failures", {
          idemKey: row.idemKey,
          attempts: row.attempts,
          lastError: row.lastError,
        });
        continue;
      }
      try {
        const packet = enrichTerminalPacket
          ? await enrichTerminalPacket({ row, payload: row.payload })
          : { row, payload: row.payload };
        const nextAction = String(packet.payload?.nextAction || "").trim().toLowerCase();
        const routeToCallWrap = nextAction === "call_wrap";
        const routeToCadence = nextAction === "cadence" || nextAction === "ringcx_vm_drop";
        const routeToBadNumber = nextAction === "logics_dnc";
        const terminalResult = routeToCadence
          ? await recordCadenceEvent(packet.payload)
          : { ok: true, skipped: true, reason: nextAction ? `routed-${nextAction}` : "fact-only-no-click-action" };
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
        if (handleBadNumberOutcome && routeToBadNumber) {
          const badNumberResult = await handleBadNumberOutcome({
            row: packet.row || row,
            payload: packet.payload,
            terminalResult,
          });
          if (badNumberResult?.skipped) badNumberSkipped += 1;
          else badNumberHandled += 1;
          logCxAlpha("cx.alpha.drain.bad_number.finished", {
            ...summarizeDrainRow(packet.row || row),
            skipped: Boolean(badNumberResult?.skipped),
            reason: badNumberResult?.reason || null,
            ok: badNumberResult ? badNumberResult.ok !== false : null,
          }, { logger });
        }
        if (enqueueCallWrap && routeToCallWrap) {
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
        }
        const drainedRow = await outboxRepository.markDrained(row.idemKey);
        if (!drainedRow) {
          // CAS miss: a concurrent drainer (second process / restart race) already marked it.
          // The business effects ran twice — downstream guards absorb it, but it must not
          // happen silently (the singleton-drain assumption just failed).
          logCxAlpha("cx.alpha.drain.row.drained_cas_miss", summarizeDrainRow(row), { logger });
          logger.warn?.("cxTerminalOutboxDrain markDrained CAS miss — concurrent drain?", {
            idemKey: row.idemKey,
          });
        }
        drained += 1;
      } catch (err) {
        const failedRow = await outboxRepository
          .markFailed(row.idemKey, err && err.message ? err.message : String(err))
          .catch(() => null);
        logCxAlpha("cx.alpha.drain.row.failed", {
          ...summarizeDrainRow(row),
          attempts: failedRow?.attempts ?? null,
          error: err?.message || String(err),
        }, { logger });
        logger.warn?.("cxTerminalOutboxDrain replay failed", { idemKey: row.idemKey, err: err?.message });
        failed += 1;
      }
    }
    // Stuck-ness health metric: the age of the oldest row still in the scan set — a growing
    // number here means the exit path is falling behind (the janitor's dashboard number).
    const oldestPendingAgeMs = pending.length && pending[0]?.createdAt
      ? Math.max(Date.now() - new Date(pending[0].createdAt).getTime(), 0)
      : 0;
    const result = {
      scanned: Array.isArray(pending) ? pending.length : 0,
      drained,
      failed,
      minimalResolved,
      oldestPendingAgeMs,
    };
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
    if (handleBadNumberOutcome) {
      result.badNumberHandled = badNumberHandled;
      result.badNumberSkipped = badNumberSkipped;
    }
    logCxAlpha("cx.alpha.drain.tick.finished", result, { logger });
    return result;
  }

  return { drainOnce };
}

module.exports = { createCxTerminalOutboxDrain };
