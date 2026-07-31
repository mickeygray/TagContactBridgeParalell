"use strict";

// CALL RECOVERY — manual runner.
//
//   node scripts/run-call-recovery.js                          (yesterday, dry)
//   node scripts/run-call-recovery.js --date 2026-07-30
//   node scripts/run-call-recovery.js --from 2026-07-20 --to 2026-07-30
//   node scripts/run-call-recovery.js --from 2026-07-20 --to 2026-07-30 --apply
//   node scripts/run-call-recovery.js --inventory
//
// DRY BY DEFAULT: no writes, no provider calls, no email. `--apply` persists
// episodes and nothing else — there is no flag on this script that can place a
// call, because this script cannot reach PhoneBurner at all.
//
// Why a manual runner exists: the nightly task needs the control plane running
// AND NIGHTLY_HYGIENE_ENABLED AND CALL_RECOVERY_DISCOVERY_ENABLED before it
// does anything. That is three gates to trip before you can see a single
// number. This asks the same question with none of them, so the funnel can be
// read on a stopped box.

require("dotenv").config();
if (process.env.DNS_SERVERS) {
  try { require("dns").setServers(process.env.DNS_SERVERS.split(",").map((s) => s.trim()).filter(Boolean)); }
  catch (error) { console.warn(`DNS_SERVERS ignored — ${error.message}`); }
}

const { connectMongo } = require("../packages/event-core/src");
const { getSharedConfig } = require("../packages/shared-config/src");

const NEWLINE = String.fromCharCode(10);

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}
const has = (n) => process.argv.includes(`--${n}`);

const pacific = (offset = 0) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
};

function days(from, to) {
  const out = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

async function showInventory() {
  const { callRecoveryLeadRepository: repo } = require("../packages/shared-repositories/src");
  const counts = await repo.countByState();
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`${NEWLINE}  RECOVERY INVENTORY — ${total} episode(s)${NEWLINE}`);
  for (const [state, n] of Object.entries(counts)) {
    if (n) console.log(`    ${String(n).padStart(5)}  ${state}`);
  }
  if (!total) console.log("    (none — run a day with --apply to build inventory)");

  const due = await repo.listDncCheckpointsDue({ limit: 5 });
  const expiring = await repo.listExpiredEpisodes({ limit: 5 });
  if (due.length) console.log(`${NEWLINE}    ${due.length} DNC checkpoint(s) due`);
  if (expiring.length) console.log(`    ${expiring.length} episode(s) past day 120 awaiting close-out`);
  console.log("");
}

async function main() {
  await connectMongo(getSharedConfig());

  if (has("inventory")) { await showInventory(); process.exit(0); }

  const single = arg("date");
  const from = single && single !== true ? single : (arg("from") || pacific(-1));
  const to = single && single !== true ? single : (arg("to") || from);
  const apply = has("apply");

  // ONE GATHER FOR THE WHOLE RANGE.
  //
  // The first version looped the nightly TASK once per day. That reuse was
  // right in spirit — the manual path and the automatic path must not drift
  // about how a candidate is proved — but wrong in composition: the task is
  // day-shaped, and wrapping it in a 61-iteration loop turned the RANGE-NATIVE
  // Logics ActivityReport into 183 requests where 3 would do, plus a 45-day
  // CallRail re-pull on every iteration. Measured at ~20 minutes for a dry run
  // whose answer does not depend on any of it.
  //
  // The proving logic still comes from the same dep builder. Only the WINDOW
  // moved: build deps once for [from, to], then walk the days inside the single
  // material it gathered.
  const {
    buildCallRecoveryDiscoveryDeps,
  } = require("../apps/control-plane/src/services/nightlyHygieneRuntime");
  const { runCallRecoveryDiscovery } = require("../packages/shared-services/src/callRecoveryDiscoveryService");

  const deps = buildCallRecoveryDiscoveryDeps({ windowFrom: from, windowTo: to });
  if (!deps) { console.error("recovery discovery dependencies unavailable"); process.exit(1); }

  const list = days(from, to);
  console.log(`${NEWLINE}  CALL RECOVERY DISCOVERY — ${from}${to !== from ? ` → ${to}` : ""}`
    + `   ${apply ? "APPLY (writes episodes)" : "DRY RUN (no writes)"}`);
  console.log(`  ${list.length} day(s), ONE metrics gather for the whole window${NEWLINE}`);

  const totals = { factsRead: 0, qualified: 0, inserted: 0, updated: 0, errors: 0 };
  const funnel = {};
  for (const day of list) {
    const r = await runCallRecoveryDiscovery({ dateKey: day, apply, logger: null, deps });
    totals.factsRead += r.factsRead || 0;
    totals.qualified += r.qualified || 0;
    totals.inserted += r.episodesInserted || 0;
    totals.updated += r.episodesUpdated || 0;
    totals.errors += r.errors || 0;
    for (const [k, n] of Object.entries(r.rejectedByReason || {})) {
      if (k === "would-qualify") continue;
      funnel[k] = (funnel[k] || 0) + n;
    }
    if (r.readFailed) {
      console.log(`    ${day}: COULD NOT READ THE DAY — ${r.readFailed}`);
    } else if (r.factsRead || r.qualified) {
      console.log(`    ${day}: ${String(r.factsRead).padStart(3)} call(s) · ${r.qualified} qualify`
        + (apply && r.episodesInserted ? `  → ${r.episodesInserted} new episode(s)` : "")
        + (apply && r.episodesUpdated ? `, ${r.episodesUpdated} updated` : ""));
    }
  }

  console.log(`${NEWLINE}  FUNNEL — why calls did not qualify${NEWLINE}`);
  for (const [reason, n] of Object.entries(funnel).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(5)}  ${reason}`);
  }
  console.log(`${NEWLINE}    ${totals.factsRead} call(s) read · ${totals.qualified} qualified`
    + (apply ? ` · ${totals.inserted} episode(s) created, ${totals.updated} updated` : "")
    + (totals.errors ? ` · ${totals.errors} error(s)` : ""));
  if (!apply && totals.qualified) {
    console.log(`${NEWLINE}    re-run with --apply to persist these as episodes.`);
  }
  console.log("");

  if (apply) await showInventory();
  process.exit(0);
}

main().catch((error) => {
  console.error(`run-call-recovery failed: ${error.message}`);
  process.exit(1);
});
