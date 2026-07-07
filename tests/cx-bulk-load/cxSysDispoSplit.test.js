"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// THE SYSTEM-DISPOSITION SPLIT, SYNTHESIZED END-TO-END (Mickey, 2026-07-07: "carry system
// dispo from the end of the call and split at drain and call wrap").
//
// This file chains the REAL production modules — no paraphrases:
//
//   end of call        real cxAccountActiveCallWatcherService (classifier flag ON)
//        │              direct-extern leadSearch reads RingCX's verdict
//        ▼
//   terminal write     real createCxBulkLoadOutcomeAdapter → cadence event
//        │              (systemDisposition + idemKey stamped)
//        ▼
//   outbox row         the runtime's production row build, mirrored verbatim
//        │              (cxBulkLoadRuntime.js recordCadenceEvent: payload = the whole event)
//        ▼
//   THE SPLIT          real createCxTerminalOutboxDrain
//        ├── drain lane:  recordCadenceEvent receives outcome + systemDisposition (both lanes)
//        └── wrap lane:   real createCxCallWrapCardService.createFromDrain
//                          ANSWER → card minted, carrying the label
//                          anything else → skipped, no-answer only
//
// The only fakes are the edges production also injects: the RingCX client, Mongo repos.

const { runCxAccountActiveCallWatchOnce } = require("../../packages/shared-services/src/cxAccountActiveCallWatcherService");
const { createCxBulkLoadOutcomeAdapter } = require("../../packages/shared-services/src/cxBulkLoadOutcomeAdapter");
const { createCxTerminalOutboxDrain } = require("../../packages/shared-services/src/cxTerminalOutboxDrain");
const { createCxCallWrapCardService } = require("../../packages/shared-services/src/cxCallWrapCardService");

const quiet = { log() {}, info() {}, warn() {}, error() {} };

function session(id, accountId, current) {
  return {
    sessionId: id,
    status: "running",
    phase: "active",
    agentEmail: `${id}@example.test`,
    agentExtensionId: id,
    domain: "TAG",
    ringcx: { accountId, campaignId: 2306 },
    current,
    acceptedBuffer: [],
    completed: [],
    stats: {},
    prevActiveExternIds: [current.externId],
    trace: { prevActiveCalls: [{ externId: current.externId, uii: "u1" }] },
  };
}

function candidate(queueItemId, externId) {
  return {
    queueItemId,
    caseId: Number(queueItemId.replace(/\D/g, "")) || 1,
    domain: "TAG",
    name: `Lead ${queueItemId}`,
    externId,
    ringcx: { externId },
    phone: "8185550101", // payload parity: a deferred write must carry what an immediate one does
    durationSec: 42,
  };
}

// Run one call end-to-end: the call vanishes with RingCX holding `leadFields` on the lead
// (the exact raw shape Mickey's one-dial probe captured), then the outbox drains.
// opts.latched = the call reached CONNECTED 30s before the vanish (the guard alone would
// say answered). opts.tickPlan = [{offsetMs, lead}] runs MULTIPLE watcher ticks (the small
// retry queue works across ticks); lead is the raw lead fields for that tick's searches,
// or the string "throw" for an RC API failure. Default = one tick with `leadFields`.
async function runEndToEnd(leadFields, opts = {}) {
  // ---- stage 1+2: end of call → real watcher → real adapter → production outbox row ----
  const outboxRows = [];
  const outcomeAdapter = createCxBulkLoadOutcomeAdapter({
    recordCadenceEvent: async (event) => {
      // Mirrors cxBulkLoadRuntime.js recordCadenceEvent verbatim: insert-once row,
      // the whole cadence event riding as `payload`.
      outboxRows.push({
        idemKey: event.idemKey,
        sessionId: event.sessionId || null,
        rail: "bulk_load",
        domain: event.domain || null,
        queueItemId: event.queueItemId || null,
        uii: event.uii || null,
        caseId: event.caseId != null ? Number(event.caseId) : null,
        agentEmail: event.agentEmail || null,
        outcome: event.outcome || null,
        source: event.source || null,
        payload: event,
        status: "pending",
        attempts: 0,
        createdAt: new Date("2026-07-07T12:00:00.000Z"),
      });
      return { written: true, idemKey: event.idemKey };
    },
  });

  const current = {
    ...candidate("q101617", "cxbl-split-1"),
    // default: never latched → the guard alone says did_not_connect.
    // latched: the call CONNECTED (30s of conversation) and the agent walked away from
    // the wrap — 31 minutes on, THIS tick's janitor sweeps it and the guard says answered.
    // (A latched release holds for human wrap-up by design; the janitor is how a
    // guard-answered terminal reaches the adapter without a click.)
    ...(opts.latched
      ? {
          uii: "u1",
          connectedAt: "2026-07-07T11:28:30.000Z",
          wrap: { at: "2026-07-07T11:29:00.000Z", reason: "ringcx-current-released" },
        }
      : {}),
  };
  const s1 = session("s1", "acct-a", current);
  if (opts.latched) {
    // the call itself is long gone — only the abandoned wrap remains
    s1.prevActiveExternIds = [];
    s1.trace = { prevActiveCalls: [] };
  }
  const baseMs = new Date("2026-07-07T12:00:00.000Z").getTime();
  const tickPlan = opts.tickPlan || [{ offsetMs: 0, lead: leadFields }];
  let tickLead = null;
  const client = {
    async listActiveCalls() { return []; },
    async searchLeads(payload = {}) {
      if (tickLead === "throw") throw new Error("RC 503 — leadSearch unavailable");
      const fields = tickLead || {};
      // Honest RingCX: a disposition-filtered probe only matches a lead that HAS one
      // of those dispositions; the direct extern search always finds the lead.
      if (Array.isArray(payload.systemDispositions)) {
        const token = String(fields.systemDisposition || fields.lastPassDispo || "").toUpperCase();
        if (!payload.systemDispositions.includes(token)) return { leads: [] };
      }
      return { leads: [{ externId: "cxbl-split-1", ...fields }] };
    },
  };
  const sessionRepository = {
    async listActiveBulkLoadSessions() { return [s1]; },
    // Patches APPLY (production is a $set) — the retry stash must survive between ticks.
    async updateBulkLoadSession(sessionId, patch) { Object.assign(s1, patch); return s1; },
  };
  for (const tick of tickPlan) {
    tickLead = tick.lead;
    await runCxAccountActiveCallWatchOnce({
      sessionRepository,
      client,
      outcomeAdapter,
      sysDispoClassifierEnabled: true,
      now: new Date(baseMs + (tick.offsetMs || 0)),
    });
  }

  // ---- stage 3: THE SPLIT — real drain + real wrap card service, server.js wiring ----
  const drainForwarded = [];
  const cards = [];
  const wrapCards = createCxCallWrapCardService({
    cardRepository: {
      async insertOnce(card) {
        if (cards.some((c) => c.idemKey === card.idemKey)) return null;
        cards.push(card);
        return card;
      },
    },
    logger: quiet,
  });
  const drain = createCxTerminalOutboxDrain({
    outboxRepository: {
      async listPendingForDrain() { return outboxRows.filter((r) => r.status === "pending"); },
      async markDrained(idemKey, resolution) {
        const row = outboxRows.find((r) => r.idemKey === idemKey && r.status !== "drained");
        if (!row) return null;
        row.status = "drained";
        row.resolution = resolution || "replayed";
        return row;
      },
      async markFailed(idemKey) {
        const row = outboxRows.find((r) => r.idemKey === idemKey);
        if (row) row.status = "failed";
        return row || null;
      },
    },
    recordCadenceEvent: async (event) => { drainForwarded.push(event); return { ok: true }; },
    enqueueCallWrap: (packet) => wrapCards.createFromDrain(packet),
    logger: quiet,
  });
  const drainResult = await drain.drainOnce();

  return { outboxRows, drainForwarded, cards, drainResult, session: s1 };
}

test("SPLIT, wrap lane: RingCX says ANSWER → the label rides end-of-call → outbox → drain, and the wrap card mints carrying it", async () => {
  const { outboxRows, drainForwarded, cards, drainResult } = await runEndToEnd({
    lastPassDispo: "ANSWER",
    lastPassDisposition: "ANSWER : Auto Dispo", // the probe-proven composite
  });

  // end of call: the guard alone would have said did_not_connect; the classifier upgraded.
  assert.equal(outboxRows.length, 1, "exactly one terminal row");
  assert.equal(outboxRows[0].payload.outcome, "answered", "classifier verdict rides the row");
  assert.equal(outboxRows[0].payload.systemDisposition, "ANSWER", "the label rides the payload");

  // drain lane: the business replay received BOTH the outcome and the label.
  assert.equal(drainForwarded.length, 1);
  assert.equal(drainForwarded[0].outcome, "answered");
  assert.equal(drainForwarded[0].systemDisposition, "ANSWER");

  // wrap lane: the card exists, inherits the row's idemKey, and carries the whole dossier.
  assert.equal(cards.length, 1, "an answered call mints exactly one wrap card");
  assert.equal(cards[0].idemKey, outboxRows[0].idemKey, "exactly-once key inherited from the outbox row");
  assert.equal(cards[0].systemDisposition, "ANSWER");
  assert.equal(cards[0].outcome, "answered");
  assert.equal(cards[0].agentEmail, "s1@example.test");
  assert.equal(cards[0].payload.systemDisposition, "ANSWER", "the frozen payload keeps the label too");

  assert.equal(drainResult.drained, 1);
  assert.equal(drainResult.callWrapQueued, 1);
  assert.equal(outboxRows[0].status, "drained", "the row still drains — the card is additive");
});

test("SPLIT, drain-only lane: any non-ANSWER verdict (MACHINE) → no-answer to the drain, label carried, NO wrap card", async () => {
  const { outboxRows, drainForwarded, cards, drainResult } = await runEndToEnd({
    lastPassDispo: "MACHINE",
  });

  assert.equal(outboxRows.length, 1);
  assert.equal(outboxRows[0].payload.outcome, "did_not_connect", "the binary rule: not ANSWER = no answer");
  assert.equal(outboxRows[0].payload.systemDisposition, "MACHINE");

  // the drain lane still gets the label — forensics and metrics keep RingCX's own verdict.
  assert.equal(drainForwarded.length, 1);
  assert.equal(drainForwarded[0].outcome, "did_not_connect");
  assert.equal(drainForwarded[0].systemDisposition, "MACHINE");

  // and the wrap lane stays empty: nobody spoke to a human, nobody gets a card.
  assert.equal(cards.length, 0, "no card for a machine");
  assert.equal(drainResult.drained, 1, "the no-answer lane completes fully");
  assert.equal(drainResult.callWrapSkipped, 1, "the split explicitly declined the card");
  assert.equal(outboxRows[0].status, "drained");
});

test("SPLIT, gamut lane: clean silence IS the no-answer verdict — one retry, then Mickey's default", async () => {
  // Mickey's rule, final form (2026-07-07): "retry once and then default to did not
  // answer." The call connected for 30s (guard says answered) but RingCX is clean and
  // silent. Tick 1 DEFERS (an unstamped pass isn't 'something' yet); the single ~5s
  // re-read stays silent; done — not ANSWER = no answer.
  const { outboxRows, drainForwarded, cards, drainResult, session } = await runEndToEnd(null, {
    latched: true,
    tickPlan: [
      { offsetMs: 0, lead: {} },     // sweep + first read: clean, no label → defer
      { offsetMs: 6000, lead: {} },  // the one retry: still silent → did_not_connect
    ],
  });

  assert.equal(outboxRows.length, 1, "the terminal write waited for the retries, then landed exactly once");
  assert.equal(outboxRows[0].payload.outcome, "did_not_connect", "clean silence joins the gamut: not ANSWER = no answer");
  assert.equal(outboxRows[0].payload.systemDisposition ?? null, null, "no label is invented that RingCX never said");

  assert.equal(drainForwarded.length, 1);
  assert.equal(drainForwarded[0].outcome, "did_not_connect");
  assert.equal(cards.length, 0, "no ANSWER, no card");
  assert.equal(drainResult.drained, 1);
  assert.equal(session.sysDispoRetries ?? null, null, "the retry stash cleared itself");
});

test("SPLIT, outage lane: RingCX unreachable through the retry → Mickey's default — did not answer, no card, nothing invented", async () => {
  // His ruling, final form: "retry once and then default to did not answer." Even a
  // latched (guard-answered) call lands as no-answer when RingCX never says ANSWER —
  // one rule, one outcome, no guard resurrection. The queue row completes cleanly
  // either way; a wrongly-downgraded conversation costs a card, not a lead.
  const { outboxRows, drainForwarded, cards, drainResult, session } = await runEndToEnd(null, {
    latched: true,
    tickPlan: [
      { offsetMs: 0, lead: "throw" },     // 429/503 → defer
      { offsetMs: 6000, lead: "throw" },  // the one retry fails too → did_not_connect
    ],
  });

  assert.equal(outboxRows.length, 1);
  assert.equal(outboxRows[0].payload.outcome, "did_not_connect", "no ANSWER by the retry = did not answer");
  assert.equal(outboxRows[0].payload.systemDisposition ?? null, null, "no invented label");

  assert.equal(drainForwarded.length, 1);
  assert.equal(drainForwarded[0].outcome, "did_not_connect");
  assert.equal(cards.length, 0, "no ANSWER, no card");
  assert.equal(drainResult.drained, 1, "the row still completes — the default costs a card, never a lead");
  assert.equal(session.sysDispoRetries ?? null, null, "the retry stash cleared itself");
});

test("SPLIT, recovery lane: a 429 on the first read, ANSWER on the retry — the short real conversation still gets its card (Mickey's own scenario)", async () => {
  // The retry queue's whole reason to exist: the guard downgraded a short real pickup
  // (never latched), RingCX 429'd the first read, and the label was there 5 seconds
  // later. Without the queue this call would have drained as no-answer forever.
  const { outboxRows, drainForwarded, cards, drainResult, session } = await runEndToEnd(null, {
    tickPlan: [
      { offsetMs: 0, lead: "throw" }, // release + first read 429s → defer
      { offsetMs: 6000, lead: { lastPassDispo: "ANSWER", lastPassDisposition: "ANSWER : Auto Dispo" } },
    ],
  });

  assert.equal(outboxRows.length, 1, "one terminal write, landed by the retry");
  assert.equal(outboxRows[0].payload.outcome, "answered", "the late ANSWER upgraded the guard's no-answer");
  assert.equal(outboxRows[0].payload.systemDisposition, "ANSWER", "the label rides the deferred write");

  assert.equal(drainForwarded.length, 1);
  assert.equal(drainForwarded[0].outcome, "answered");
  assert.equal(cards.length, 1, "the wrap card mints off the retry-landed write");
  assert.equal(cards[0].systemDisposition, "ANSWER");
  assert.equal(cards[0].idemKey, outboxRows[0].idemKey, "exactly-once key intact through the deferral");
  assert.equal(drainResult.callWrapQueued, 1);
  assert.equal(session.sysDispoRetries ?? null, null, "the retry stash cleared itself");
  // PAYLOAD PARITY (adversarial find): the deferred write must be byte-equivalent to an
  // immediate one — phone/duration carried, and `at` frozen at the hang-up tick, not the
  // retry tick (the wrap card's 2h clock must not drift with the backoff).
  assert.equal(outboxRows[0].payload.phone, "8185550101");
  assert.equal(outboxRows[0].payload.durationSec, 42);
  assert.equal(outboxRows[0].payload.at, "2026-07-07T12:00:00.000Z", "at = when the call ended");
});
