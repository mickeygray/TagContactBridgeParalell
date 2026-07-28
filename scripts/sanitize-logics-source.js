"use strict";

// CLI over logicsSourceSanitizerService — see that file for the design.
//
//   node scripts/sanitize-logics-source.js                 # dry, last 7 days
//   node scripts/sanitize-logics-source.js --days 30
//   node scripts/sanitize-logics-source.js --from 2026-07-01 --to 2026-07-28
//   node scripts/sanitize-logics-source.js --commit        # writes to Logics
//
// DRY by default. --commit additionally requires LOGICS_SOURCE_WRITER_ENABLED=true;
// this script will not arm the writer for you.

require("dotenv").config();

const { connectMongo } = require("../packages/event-core/src");
const { getSharedConfig } = require("../packages/shared-config/src");
const {
  applySourceSanitization, planSourceSanitization,
} = require("../packages/shared-services/src/logicsSourceSanitizerService");

const NEWLINE = String.fromCharCode(10);
const has = (f) => process.argv.includes(`--${f}`);
function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

async function main() {
  await connectMongo(getSharedConfig());

  const commit = has("commit");
  const armed = String(process.env.LOGICS_SOURCE_WRITER_ENABLED || "false").toLowerCase() === "true";
  const domain = String(arg("domain", "TAG")).toUpperCase();

  if (commit && !armed) {
    console.error(`${NEWLINE}refusing: --commit needs LOGICS_SOURCE_WRITER_ENABLED=true in the environment.`);
    console.error("this script will not arm the writer for you.");
    process.exitCode = 1;
    return;
  }

  const { plan, stats, inactivePieces, window, skipped } = await planSourceSanitization({
    domain,
    from: arg("from", null) === true ? null : arg("from", null),
    to: arg("to", null) === true ? null : arg("to", null),
    days: Number(arg("days", 7)) || 7,
    logger: { warn: (m, d) => console.log(`  ${m} ${JSON.stringify(d || {})}`) },
  });

  console.log(`${NEWLINE}SOURCE SANITIZER · ${window.domain} · ${window.from} → ${window.to}`);
  console.log(`  mode: ${commit ? "COMMIT — writing to Logics" : "DRY RUN"}`);
  if (skipped) { console.log(`  ${skipped}`); return; }
  console.log(`  ${stats.calls} inbound call(s) · ${stats.callers} distinct caller(s) on an active piece`);

  console.log(`${NEWLINE}${plan.length} case(s) would move off the catch-all:${NEWLINE}`);
  console.log("    CASE  FROM  →  ID  CALLED      PIECE");
  console.log("-".repeat(78));
  for (const p of plan) {
    console.log(`${String(p.caseId).padStart(8)}  ${String(p.fromSourceId ?? "—").padStart(4)}  → ${String(p.sourceId).padStart(3)}  ${p.calledAt}  ${p.piece}`);
  }

  let applied = null;
  if (commit) {
    console.log(`${NEWLINE}writing…`);
    applied = await applySourceSanitization(plan, { logger: console });
  }

  console.log(`${NEWLINE}SUMMARY`);
  console.log(`  caller is not a Logics case (404)             : ${stats.noCase}`);
  console.log(`  already on this exact piece                   : ${stats.alreadyTarget}`);
  console.log(`  already on another specific piece (left alone): ${stats.alreadyOtherSpecific}`);
  console.log(`  unreadable in Logics                          : ${stats.unreadable}`);
  console.log(`  ${commit ? "WRITTEN" : "would write"}                                   : ${commit ? applied.written : stats.planned}`);
  if (commit) {
    console.log(`  already correct per Logics                    : ${applied.alreadyOk}`);
    console.log(`  skipped by the writer                         : ${applied.skipped}`);
    console.log(`  failed                                        : ${applied.failed}`);
    for (const e of applied.errors) console.log(`    case ${e.caseId}: ${e.error}`);
  }

  if (inactivePieces.length) {
    console.log(`${NEWLINE}  busiest INACTIVE pieces (left on ABC by design — register only if they go active):`);
    for (const { piece, calls } of inactivePieces.slice(0, 10)) {
      console.log(`    ${String(calls).padStart(4)}  ${JSON.stringify(piece)}`);
    }
  }
  if (!commit) console.log(`${NEWLINE}NOTHING WAS WRITTEN. Re-run with --commit (and LOGICS_SOURCE_WRITER_ENABLED=true) to apply.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error("sanitize-logics-source failed:", e.stack || e.message); process.exit(1); });
