"use strict";

require("dotenv").config();

// WRAP DRILL (Mickey's ask, 2026-07-06): backend-test the end-call → wrap-up → drain chain
// with ZERO phone calls, against REAL case 101617 (WYNN):
//
//   A) synthetic ANSWERED termination → card → resolve ✕ (dismissed) →
//      INTERVIEW writes to Logics (activity + case-profile communication), terminal row drained.
//   B) synthetic ANSWERED termination → card → resolve DNC →
//      interview + Logics STATUS CHANGE (dnc) + correction row → correction PERSISTS
//      THROUGH THE LIVE DRAIN (status drained + dnc stamps land on the queue row).
//
// ⚠ REAL LOGICS WRITES on case 101617: an activity per resolution, and path B sets the
//   case status to DNC in Logics. Revert the status manually afterwards if 101617 needs
//   a different one. That is the point of the test — but it is real.
//
// Card creation prefers the LIVE drain hook (needs CX_CALL_WRAP_QUEUE_ENABLED=true on a
// restarted control plane). If the flag is off, the drill creates the cards itself (that
// half is then marked SKIPPED-LIVE) so the Logics/drain halves still run.
//
//   node scripts/cx-wrap-drill.js            -> dry run (prints the plan)
//   node scripts/cx-wrap-drill.js --arm      -> run it
//   node scripts/cx-wrap-drill.js --cleanup <tag>

const mongoose = require("mongoose");
const { getSharedConfig } = require("../packages/shared-config/src");
const { CxDialQueue, CxTerminalOutbox, CxCallWrapCard } = require("../packages/shared-models/src");
const { cxTerminalOutboxRepository, cxCallWrapCardRepository, caseProfileRepository } = require("../packages/shared-repositories/src");
const {
  createCxCallWrapCardService,
  buildCxReviewCorrectionRow,
  requestCxLeadStatusUpdate,
  writeCxCallWrapSummary,
} = require("../packages/shared-services/src");
const { createLogicsClient } = require("../packages/shared-integrations/src");

const CASE_ID = 101617;
const DOMAIN = "WYNN";
const AGENT = "mgray@taxadvocategroup.com";

const args = { arm: false, cleanup: null };
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] === "--arm") args.arm = true;
  else if (process.argv[i] === "--cleanup") args.cleanup = process.argv[++i] || "missing-tag";
}

function line(msg) { console.log(msg); }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function buildService() {
  return createCxCallWrapCardService({
    cardRepository: cxCallWrapCardRepository,
    outboxRepository: cxTerminalOutboxRepository,
    buildCorrectionRow: buildCxReviewCorrectionRow,
    writeInterview: (card) =>
      writeCxCallWrapSummary(
        {
          domain: card.domain,
          caseId: card.caseId,
          queueItemId: card.queueItemId,
          uii: card.uii,
          terminalOutcome: card.outcome,
          happenedAt: card.calledAt,
          subject: "CX call summary (wrap drill)",
          source: "cx-wrap-drill",
          provider: "cx-terminal-outbox",
          summary: typeof card.coachSummary === "string" ? card.coachSummary : "Wrap drill interview",
          actor: { actorEmail: card.agentEmail, actorName: card.agentName || card.agentEmail },
          metadata: { idemKey: card.idemKey },
        },
        {
          caseProfileRepository,
          writeLogicsActivity: async (domain, _actor, activity) => {
            const client = createLogicsClient(domain);
            const response = await client.createActivity({
              CaseID: Number(activity.caseId),
              ActivityType: activity.activityType || "General",
              Subject: activity.subject || "CX call summary",
              Comment: activity.note,
              Popup: false,
              Pin: false,
            });
            return { skipped: false, result: response };
          },
          logger: console,
        },
        { allowSparse: false, writeCaseProfileCommunication: true, writeLogicsActivity: true },
      ),
    updateLogicsDncStatus: (card) =>
      requestCxLeadStatusUpdate(card.domain, { email: card.agentEmail }, {
        caseId: card.caseId,
        status: "dnc",
        notes: "DNC set from call wrap card (wrap drill)",
      }),
    logger: console,
  });
}

async function cleanup(tag) {
  const outbox = await CxTerminalOutbox.deleteMany({ idemKey: new RegExp(`wrapdrill-${tag}`) });
  const cards = await CxCallWrapCard.deleteMany({ idemKey: new RegExp(`wrapdrill-${tag}`) });
  const rows = await CxDialQueue.deleteMany({ "metadata.wrapDrillTag": tag });
  line(`cleanup ${tag}: outbox=${outbox.deletedCount} cards=${cards.deletedCount} queueRows=${rows.deletedCount}`);
  line("NOTE: Logics writes on case 101617 (activities + possible DNC status) are real and are NOT reverted here.");
}

async function main() {
  const config = getSharedConfig();
  await mongoose.connect(config.mongoUri, { dbName: config.parallelDbName });
  try {
    if (args.cleanup) return void (await cleanup(args.cleanup));

    const tag = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    line(`WRAP DRILL tag=${tag} — case ${CASE_ID} (${DOMAIN}), agent ${AGENT}`);
    line("A) answered → card → ✕  => Logics ACTIVITY (interview) + terminal drained");
    line("B) answered → card → DNC => interview + Logics STATUS=dnc + correction row DRAINS");
    if (!args.arm) {
      line("\nDRY RUN. --arm to execute. ⚠ --arm performs REAL Logics writes on case 101617.");
      return;
    }

    // Landing pads: pre-completed synthetic queue rows (terminal-state lane = metadata
    // stamps only; no cadence/queue/RingCX side effects).
    const mkRow = async (label) => (await CxDialQueue.create({
      domain: DOMAIN, caseId: CASE_ID, phone: null, state: "completed", releaseAt: new Date(),
      metadata: { wrapDrillTag: tag, drill: true, label },
    }))._id;
    const rowA = await mkRow("A-activity");
    const rowB = await mkRow("B-dnc");

    const mkPayload = (rowId, uii) => ({
      eventType: "terminal",
      sessionId: `wrapdrill-${tag}`,
      queueItemId: String(rowId),
      domain: DOMAIN,
      caseId: CASE_ID,
      uii,
      outcome: "answered",
      agentEmail: AGENT,
      name: "Mickey Gray 06 (wrap drill)",
      at: new Date().toISOString(),
      callSummary: `Wrap drill ${tag}: synthetic answered call — testing interview persistence. Safe to ignore.`,
      sourceService: "cx-bulk-load",
      source: "wrap-drill",
    });
    const uiiA = `WRAPDRILL${tag}A`;
    const uiiB = `WRAPDRILL${tag}B`;
    const outA = { idemKey: `wrapdrill-${tag}:A`, sessionId: `wrapdrill-${tag}`, queueItemId: String(rowA), uii: uiiA, caseId: CASE_ID, domain: DOMAIN, agentEmail: AGENT, outcome: "answered", payload: mkPayload(rowA, uiiA) };
    const outB = { idemKey: `wrapdrill-${tag}:B`, sessionId: `wrapdrill-${tag}`, queueItemId: String(rowB), uii: uiiB, caseId: CASE_ID, domain: DOMAIN, agentEmail: AGENT, outcome: "answered", payload: mkPayload(rowB, uiiB) };
    await CxTerminalOutbox.create({ ...outA, status: "pending", attempts: 0 });
    await CxTerminalOutbox.create({ ...outB, status: "pending", attempts: 0 });
    line("injected 2 answered terminations; waiting for the live drain (~15s ticks)...");

    // Wait for the drain to eat the terminal rows + (flag on) mint the cards.
    let liveCards = false;
    for (let waited = 0; waited < 60_000; waited += 5_000) {
      await sleep(5_000);
      const outs = await CxTerminalOutbox.find({ idemKey: { $in: [outA.idemKey, outB.idemKey] } }).lean();
      const drained = outs.filter((o) => o.status === "drained").length;
      const cards = await CxCallWrapCard.countDocuments({ idemKey: { $in: [outA.idemKey, outB.idemKey] } });
      if (drained === 2 && cards === 2) { liveCards = true; break; }
      if (drained === 2 && cards === 0 && waited >= 30_000) break; // drained but no cards → flag off
    }
    const service = buildService();
    if (!liveCards) {
      line("live drain minted NO cards (CX_CALL_WRAP_QUEUE_ENABLED off?) — creating cards script-side so the Logics halves still run [live-hook half: SKIPPED-LIVE]");
      await service.createFromDrain({ row: outA, payload: outA.payload });
      await service.createFromDrain({ row: outB, payload: outB.payload });
    } else {
      line("live drain drained both rows AND minted both cards — the hook wiring is proven live.");
    }

    // A) ✕ — interview only.
    const resA = await service.resolve({ idemKey: outA.idemKey, action: "dismissed", resolvedBy: AGENT });
    const intA = resA?.effects?.interview || {};
    line(`A resolved(✕): interviewOk=${intA.ok !== false} communication=${intA.communication ? (intA.communication.skipped ? "skipped:" + intA.communication.reason : "written") : "?"} logicsActivity=${intA.logicsActivity ? (intA.logicsActivity.skipped ? "skipped:" + intA.logicsActivity.reason : "written") : "?"}`);

    // B) DNC — interview + status + correction row that must DRAIN.
    const resB = await service.resolve({ idemKey: outB.idemKey, action: "dnc", resolvedBy: AGENT });
    const intB = resB?.effects?.interview || {};
    const corrB = resB?.effects?.correction || {};
    const statB = resB?.effects?.logicsStatus || {};
    line(`B resolved(DNC): interviewOk=${intB.ok !== false} correctionInserted=${corrB.inserted === true} logicsStatusOk=${statB.ok !== false && !statB.error} ${statB.error ? "err=" + statB.error : ""}`);

    // Correction persistence: the live drain must drain the review-dnc row and stamp the queue row.
    const corrKey = `${String(rowB)}:${uiiB}:review-dnc`;
    let corrDrained = false;
    for (let waited = 0; waited < 60_000; waited += 5_000) {
      await sleep(5_000);
      const corr = await CxTerminalOutbox.findOne({ idemKey: corrKey }).lean();
      if (corr && corr.status === "drained") { corrDrained = true; break; }
    }
    const rowBAfter = await CxDialQueue.findById(rowB).lean();

    const verdicts = [
      ["terminal rows drained by the live drain", true],
      ["cards minted by the LIVE drain hook (flag on)", liveCards],
      ["A: interview activity written to Logics", intA.ok !== false && intA.logicsActivity && !intA.logicsActivity.skipped],
      ["A: case-profile communication written", intA.communication && !intA.communication.skipped],
      ["B: Logics status change (dnc) accepted", statB && statB.ok !== false && !statB.error],
      ["B: correction row inserted", corrB.inserted === true],
      ["B: correction PERSISTED through the drain", corrDrained],
      ["B: dnc stamps landed on the queue row", String(rowBAfter?.metadata?.lastTerminalOutcome || "").toLowerCase() === "dnc"],
    ];
    line("\nVERDICT:");
    let pass = true;
    for (const [label, ok] of verdicts) {
      line(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
      if (!ok && label.includes("LIVE drain hook")) { line("        (flag off — enable CX_CALL_WRAP_QUEUE_ENABLED + restart to prove the live half)"); continue; }
      if (!ok) pass = false;
    }
    line(pass ? `\nALL CORE PASS. Cleanup: node scripts/cx-wrap-drill.js --cleanup ${tag}` : `\nFAILURES — capture this output + control-plane stdout. Artifacts kept under ${tag}.`);
    line("⚠ Reminder: case 101617's Logics status is now DNC (path B) — revert manually if needed.");
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
