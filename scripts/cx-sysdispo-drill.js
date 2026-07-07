"use strict";

// SYS-DISPO SPLIT DRILL (Mickey's ask, 2026-07-07): synthetically prove that the LIVE
// drain + call-wrap lane handle the system disposition — zero live calls, zero RingCX,
// zero Logics. Three crafted outbox rows against pre-completed drill queue rows:
//
//   A ANSWER lane   — outcome "answered" + systemDisposition "ANSWER"
//                     → drains full; row stamped lastTerminalSystemDisposition=ANSWER;
//                       wrap flag ON: a card mints carrying ANSWER (idemKey-inherited).
//   B MACHINE lane  — outcome "did_not_connect" + systemDisposition "MACHINE"
//                     → drains full; row stamped MACHINE; NO card ever (not answered).
//   C NO-LABEL lane — outcome "answered", no systemDisposition
//                     → drains full; NO label invented on the row;
//                       wrap flag ON: card mints with systemDisposition null (honest).
//
// SAFETY: queue rows are synthetic (caseIds 9999xx, state "completed" → the drain's
// terminal-state lane = metadata stamps only; no cadence reschedule, no RingCX). The
// payloads carry NO wrap material (no coachSessionId/summary), so the flag-OFF legacy
// wrap lane returns {skipped:"no-call-wrap-material"} — no Logics write is possible.
// The wrap-card checks auto-detect the flag by behavior: cards found → graded; none
// found → reported as PENDING CEREMONY (re-run this drill after the flag+restart).
//
// Usage:
//   node scripts/cx-sysdispo-drill.js --arm             -> inject + watch + grade
//   node scripts/cx-sysdispo-drill.js                   -> dry run
//   node scripts/cx-sysdispo-drill.js --cleanup <tag>   -> remove a run's artifacts

const mongoose = require("mongoose");
const { getSharedConfig } = require("../packages/shared-config/src");
const { CxDialQueue, CxTerminalOutbox, CxCallWrapCard } = require("../packages/shared-models/src");

const args = { arm: false, cleanup: null };
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (key === "--arm") args.arm = true;
  else if (key === "--cleanup") args.cleanup = process.argv[++i] || "missing-tag";
}

const WATCH_INTERVAL_MS = 10_000;
const WATCH_TIMEOUT_MS = 3 * 60 * 1000; // all three lanes drain on the first pass

function line(msg) { console.log(msg); }

async function cleanup(tag) {
  const outbox = await CxTerminalOutbox.deleteMany({ idemKey: new RegExp(`^sysdispo:${tag}:`) });
  const rows = await CxDialQueue.deleteMany({ "metadata.sysDispoDrillTag": tag });
  const cards = await CxCallWrapCard.deleteMany({ idemKey: new RegExp(`^sysdispo:${tag}:`) });
  line(`cleanup tag=${tag}: outbox=${outbox.deletedCount}, queue rows=${rows.deletedCount}, wrap cards=${cards.deletedCount}`);
}

async function main() {
  const config = getSharedConfig();
  await mongoose.connect(config.mongoUri, { dbName: config.parallelDbName });
  try {
    if (args.cleanup) return void (await cleanup(args.cleanup));

    const tag = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    const now = new Date();
    const drillAgent = "sysdispo-drill@example.test";

    const lanes = [
      { key: "answer", caseId: 999911, outcome: "answered", systemDisposition: "ANSWER",
        expect: "row stamped ANSWER; flag ON → card carrying ANSWER" },
      { key: "machine", caseId: 999912, outcome: "did_not_connect", systemDisposition: "MACHINE",
        expect: "row stamped MACHINE; NO card ever" },
      { key: "nolabel", caseId: 999913, outcome: "answered", systemDisposition: null,
        expect: "no label invented on the row; flag ON → card with systemDisposition null" },
    ];

    line(`SYS-DISPO SPLIT DRILL tag=${tag}`);
    for (const l of lanes) line(`  ${l.key}: outcome=${l.outcome} sys=${l.systemDisposition || "-"} — expect: ${l.expect}`);
    if (!args.arm) {
      line("\nDRY RUN. Re-run with --arm to inject and watch (~30-60s: everything drains first tick).");
      return;
    }

    for (const l of lanes) {
      const row = await CxDialQueue.create({
        domain: "WYNN",
        caseId: l.caseId,
        phone: null,
        state: "completed", // terminal-state lane: metadata stamps ONLY — safe by design
        releaseAt: now,
        metadata: { sysDispoDrillTag: tag, drill: true },
      });
      l.queueItemId = String(row._id);
      l.uii = `SYSDISPO${tag}${l.key.toUpperCase()}`;
      l.idemKey = `sysdispo:${tag}:${l.key}`;
      await CxTerminalOutbox.create({
        idemKey: l.idemKey,
        sessionId: `sysdispo-drill-${tag}`,
        queueItemId: l.queueItemId,
        uii: l.uii,
        agentEmail: drillAgent,
        outcome: l.outcome,
        status: "pending",
        attempts: 0,
        payload: {
          queueItemId: l.queueItemId,
          domain: "WYNN",
          caseId: l.caseId,
          uii: l.uii,
          agentEmail: drillAgent,
          outcome: l.outcome,
          eventType: "terminal",
          ...(l.systemDisposition ? { systemDisposition: l.systemDisposition } : {}),
          sourceService: "cx-bulk-load",
          source: "sysdispo-drill",
          at: now.toISOString(),
          // deliberately NO wrap material — the flag-OFF legacy lane must skip cleanly
        },
      });
      line(`injected ${l.idemKey} -> queue row ${l.queueItemId}`);
    }

    line("\nWATCHING (live drain ticks ~15s; Ctrl+C safe — state is in Mongo)...");
    const startedAt = Date.now();
    const seen = new Map();
    for (;;) {
      const docs = await CxTerminalOutbox.find({ idemKey: new RegExp(`^sysdispo:${tag}:`) }).lean();
      for (const doc of docs) {
        const sig = `${doc.status}/${doc.attempts}/${doc.resolution || "-"}`;
        if (seen.get(doc.idemKey) !== sig) {
          seen.set(doc.idemKey, sig);
          line(`  ${new Date().toISOString()}  ${doc.idemKey} -> status=${doc.status} attempts=${doc.attempts} resolution=${doc.resolution || "-"}`);
        }
      }
      if (docs.length === lanes.length && docs.every((d) => d.status === "drained")) break;
      if (Date.now() - startedAt > WATCH_TIMEOUT_MS) {
        line("TIMEOUT — is ParallelControlPlane running with the drain enabled?");
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, WATCH_INTERVAL_MS));
    }

    // Self-grading (verification never gets done by hand).
    const finals = await CxTerminalOutbox.find({ idemKey: new RegExp(`^sysdispo:${tag}:`) }).lean();
    const byKey = Object.fromEntries(finals.map((d) => [d.idemKey.split(":").pop(), d]));
    const rows = {};
    for (const l of lanes) rows[l.key] = await CxDialQueue.findById(l.queueItemId).lean();
    const cards = await CxCallWrapCard.find({ idemKey: new RegExp(`^sysdispo:${tag}:`) }).lean();
    const cardByKey = Object.fromEntries(cards.map((c) => [c.idemKey.split(":").pop(), c]));
    const wrapFlagLive = cards.length > 0; // behavior IS the flag detector

    const verdicts = [
      ["ANSWER lane drained full (no retries)", byKey.answer?.status === "drained" && !byKey.answer?.resolution && Number(byKey.answer?.attempts) === 0],
      ["ANSWER label stored on the row (lastTerminalSystemDisposition=ANSWER)", rows.answer?.metadata?.lastTerminalSystemDisposition === "ANSWER"],
      ["ANSWER outcome stamped answered", rows.answer?.metadata?.lastTerminalOutcome === "answered"],
      ["MACHINE lane drained full", byKey.machine?.status === "drained" && !byKey.machine?.resolution],
      ["MACHINE label stored on the row", rows.machine?.metadata?.lastTerminalSystemDisposition === "MACHINE"],
      ["MACHINE minted NO wrap card (not answered — never card material)", !cardByKey.machine],
      ["NO-LABEL lane drained full", byKey.nolabel?.status === "drained" && !byKey.nolabel?.resolution],
      ["NO-LABEL: no label invented on the row", !rows.nolabel?.metadata?.lastTerminalSystemDisposition],
    ];
    if (wrapFlagLive) {
      verdicts.push(
        ["WRAP FLAG ON: ANSWER card minted, idemKey-inherited", Boolean(cardByKey.answer)],
        ["WRAP FLAG ON: ANSWER card carries systemDisposition=ANSWER", cardByKey.answer?.systemDisposition === "ANSWER"],
        ["WRAP FLAG ON: NO-LABEL card minted with honest null label", Boolean(cardByKey.nolabel) && (cardByKey.nolabel?.systemDisposition ?? null) === null],
        ["WRAP FLAG ON: cards are pending for the drill agent", [cardByKey.answer, cardByKey.nolabel].every((c) => !c || (c.status === "pending" && c.agentEmail === drillAgent))],
      );
    }

    line("\nVERDICT:");
    let pass = true;
    for (const [label, ok] of verdicts) {
      line(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
      if (!ok) pass = false;
    }
    if (!wrapFlagLive) {
      line("  NOTE  wrap-card lane: NO cards minted — CX_CALL_WRAP_QUEUE_ENABLED is off in the");
      line("        running process (expected pre-ceremony). Re-run this drill AFTER the");
      line("        flag+restart to grade the card half; the drain half is graded above.");
    }
    line(pass
      ? `\nALL GRADED LANES PASS. Cleanup: node scripts/cx-sysdispo-drill.js --cleanup ${tag}`
      : `\nFAILURES — capture stdout (cx.alpha.drain.*) + this output. Artifacts kept under tag ${tag}.`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
