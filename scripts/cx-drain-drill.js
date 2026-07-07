"use strict";

// DRAIN DRILL (Mickey's ask, 2026-07-06 late): synthetically prove the drain's three
// resolution lanes with ZERO live calls — inject three crafted outbox rows and let the
// REAL running drain worker (ParallelControlPlane, ~15s ticks) eat them:
//
//   A "bad one, no event"   — malformed row (payload has no queueItemId; no button press
//                             behind it) → drains IMMEDIATELY, resolution "malformed",
//                             zero retries, zero writes.
//   B "bad one WITH event"  — well-formed row whose queueItemId can never resolve (not a
//                             castable id → the handler throws every replay) → 3 backoff
//                             retries (~15s/60s/135s) → MINIMAL resolution → drained
//                             "minimal". Takes ~4-6 minutes BY DESIGN (the backoff ladder).
//   C "good one"            — real (synthetic, drill-tagged) queue row in state completed
//                             → full replay succeeds via the terminal-state lane → drained,
//                             resolution null (full) — AND the sys-label store is proven
//                             live: the row must carry metadata.lastTerminalSystemDisposition
//                             = "DRILL" afterwards.
//
// SAFETY: none of the three lanes touches RingCX (A never replays; B never succeeds; C's
// pre-completed row takes the metadata-stamp ignore branch — no reschedule, no publish, no
// cancel). Synthetic caseIds 9999xx, everything tagged "drill".
//
// Usage:
//   node scripts/cx-drain-drill.js --arm          -> inject + watch + grade (the normal run)
//   node scripts/cx-drain-drill.js                -> dry run (prints what would be injected)
//   node scripts/cx-drain-drill.js --cleanup <tag> -> remove a run's drill artifacts
//
// Prereqs: ParallelControlPlane RESTARTED on the current tree (minimal-resolution code),
// drain enabled (CX_TERMINAL_OUTBOX_DRAIN_ENABLED not false). Watch stdout for
// cx.alpha.drain.row.skipped / row.failed / row.minimal_resolved / row.replayed.

const mongoose = require("mongoose");
const { getSharedConfig } = require("../packages/shared-config/src");
const { CxDialQueue, CxTerminalOutbox } = require("../packages/shared-models/src");

const args = { arm: false, cleanup: null };
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (key === "--arm") args.arm = true;
  else if (key === "--cleanup") args.cleanup = process.argv[++i] || "missing-tag";
}

const WATCH_INTERVAL_MS = 10_000;
const WATCH_TIMEOUT_MS = 10 * 60 * 1000; // B's backoff ladder needs ~4-6 min

function line(msg) { console.log(msg); }

async function cleanup(tag) {
  const outbox = await CxTerminalOutbox.deleteMany({ idemKey: new RegExp(`^drill:${tag}:`) });
  const rows = await CxDialQueue.deleteMany({ "metadata.drainDrillTag": tag });
  line(`cleanup tag=${tag}: outbox rows removed=${outbox.deletedCount}, queue rows removed=${rows.deletedCount}`);
}

async function main() {
  const config = getSharedConfig();
  await mongoose.connect(config.mongoUri, { dbName: config.parallelDbName });
  try {
    if (args.cleanup) return void (await cleanup(args.cleanup));

    const tag = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    const drillUii = `DRILL${tag}0000000000`;
    const now = new Date();

    // C's landing pad: a synthetic, pre-completed queue row (terminal-state lane =
    // metadata stamps only; no cadence/queue/RingCX side effects).
    const goodRowSpec = {
      domain: "WYNN",
      caseId: 999901,
      phone: null,
      state: "completed",
      releaseAt: now,
      metadata: { drainDrillTag: tag, drill: true },
    };

    const specs = [
      {
        name: "A bad-no-event (malformed)",
        idemKey: `drill:${tag}:malformed`,
        payload: { outcome: "answered", note: "no queueItemId on purpose — no button press" },
        expect: 'drained IMMEDIATELY, resolution="malformed", attempts=0, no writes anywhere',
      },
      {
        name: "B bad-with-event (poison)",
        idemKey: `drill:${tag}:poison`,
        payload: {
          queueItemId: `drill-poison-${tag}`, // not a castable ObjectId → handler throws every time
          domain: "WYNN",
          caseId: 999902,
          uii: `${drillUii}B`,
          outcome: "did_not_connect",
          sourceService: "cx-bulk-load",
          source: "drain-drill",
          at: now.toISOString(),
        },
        expect: '3 failed replays w/ backoff (~15s/60s/135s) → drained, resolution="minimal", attempts=3 (minimalOk=false is EXPECTED — the poison id is unstampable; the LADDER is what this proves)',
      },
      {
        name: "C good",
        idemKey: `drill:${tag}:good`,
        payloadOf: (queueRowId) => ({
          queueItemId: String(queueRowId),
          domain: "WYNN",
          caseId: 999901,
          uii: `${drillUii}C`,
          outcome: "did_not_connect",
          systemDisposition: "DRILL",
          sourceService: "cx-bulk-load",
          source: "drain-drill",
          at: now.toISOString(),
        }),
        expect: 'drained on the first tick, resolution=null (full), attempts=0, AND the queue row gains metadata.lastTerminalSystemDisposition="DRILL" (label store live)',
      },
    ];

    line(`DRAIN DRILL tag=${tag}`);
    for (const s of specs) line(`  ${s.name}\n    expect: ${s.expect}`);
    if (!args.arm) {
      line("\nDRY RUN. Re-run with --arm to inject and watch. Expect the whole drill to take");
      line("~5-6 minutes (B's backoff ladder is the slow, deliberate part).");
      return;
    }

    const goodRow = await CxDialQueue.create(goodRowSpec);
    line(`injected synthetic queue row ${goodRow._id} (case 999901, state completed, drill-tagged)`);
    const rows = [
      { idemKey: specs[0].idemKey, sessionId: `drill-${tag}`, payload: specs[0].payload },
      { idemKey: specs[1].idemKey, sessionId: `drill-${tag}`, queueItemId: specs[1].payload.queueItemId, uii: specs[1].payload.uii, outcome: "did_not_connect", payload: specs[1].payload },
      { idemKey: specs[2].idemKey, sessionId: `drill-${tag}`, queueItemId: String(goodRow._id), uii: `${drillUii}C`, outcome: "did_not_connect", payload: specs[2].payloadOf(goodRow._id) },
    ];
    for (const row of rows) {
      await CxTerminalOutbox.create({ ...row, status: "pending", attempts: 0 });
      line(`injected outbox ${row.idemKey}`);
    }
    line("\nWATCHING (the live drain ticks every ~15s; Ctrl+C is safe — state is in Mongo)...");

    const startedAt = Date.now();
    const seen = new Map();
    for (;;) {
      const docs = await CxTerminalOutbox.find({ idemKey: new RegExp(`^drill:${tag}:`) }).lean();
      for (const doc of docs) {
        const sig = `${doc.status}/${doc.attempts}/${doc.resolution || "-"}`;
        if (seen.get(doc.idemKey) !== sig) {
          seen.set(doc.idemKey, sig);
          line(`  ${new Date().toISOString()}  ${doc.idemKey} -> status=${doc.status} attempts=${doc.attempts} resolution=${doc.resolution || "-"} lastError=${(doc.lastError || "").slice(0, 60) || "-"}`);
        }
      }
      const allDrained = docs.length === 3 && docs.every((d) => d.status === "drained");
      if (allDrained) break;
      if (Date.now() - startedAt > WATCH_TIMEOUT_MS) {
        line("TIMEOUT — is ParallelControlPlane restarted on the current tree, and the drain enabled?");
        break;
      }
      if (Date.now() - startedAt > 60_000 && seen.size === 0) {
        line("  (60s, no movement — check the control plane is running the NEW code)");
      }
      await new Promise((resolve) => setTimeout(resolve, WATCH_INTERVAL_MS));
    }

    // Self-grading (verification never gets done by hand — the drill grades itself).
    const finals = await CxTerminalOutbox.find({ idemKey: new RegExp(`^drill:${tag}:`) }).lean();
    const byKey = Object.fromEntries(finals.map((d) => [d.idemKey.split(":").pop(), d]));
    const stampedRow = await CxDialQueue.findById(goodRow._id).lean();
    const verdicts = [
      ["A malformed drains instantly, no retries", byKey.malformed?.status === "drained" && byKey.malformed?.resolution === "malformed" && Number(byKey.malformed?.attempts) === 0],
      ["B poison rides the 3-retry ladder then resolves minimally", byKey.poison?.status === "drained" && byKey.poison?.resolution === "minimal" && Number(byKey.poison?.attempts) >= 3],
      ["C good drains fully on the first pass", byKey.good?.status === "drained" && !byKey.good?.resolution && Number(byKey.good?.attempts) === 0],
      ["C label store live: row carries lastTerminalSystemDisposition=DRILL", stampedRow?.metadata?.lastTerminalSystemDisposition === "DRILL"],
      ["C terminal stamps landed on the row", stampedRow?.metadata?.lastTerminalOutcome === "did_not_connect"],
    ];
    line("\nVERDICT:");
    let pass = true;
    for (const [label, ok] of verdicts) {
      line(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
      if (!ok) pass = false;
    }
    line(pass
      ? `\nALL PASS. Cleanup when done: node scripts/cx-drain-drill.js --cleanup ${tag}`
      : `\nFAILURES — capture stdout (cx.alpha.drain.*) + this output. Artifacts kept under tag ${tag}.`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
