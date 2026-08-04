"use strict";

/**
 * daily-snapshot-dry-run — compose the canonical rollup for one day and show
 * EXACTLY what the snapshot would store. Writes nothing.
 *
 * The whole point is to see the day's entry before it becomes a stored fact:
 * whether the costs-by-source section is populated, whether coverage is
 * complete, and whether anything failed to gather. A snapshot that stores
 * silence as zero is the failure mode this is looking for.
 *
 *   node scripts/daily-snapshot-dry-run.js [YYYY-MM-DD]
 */

require("dotenv").config({ quiet: true });
if (process.env.DNS_SERVERS) {
  require("dns").setServers(String(process.env.DNS_SERVERS).split(",").map((s) => s.trim()));
}

const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
const { getSharedConfig } = require("../packages/shared-config/src");
const { writeDailySnapshot } = require("../packages/shared-services/src/dailySnapshotService");
const { CANONICAL_DEFINITION_NAME } = require("../packages/shared-services/src/dailyReportFactService");
const ReportDefinition = require("../packages/shared-models/src/ReportDefinition");

const pacificYesterday = () => {
  const d = new Date(Date.now() - 86400000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
};

const show = (label, value) => console.log("  " + String(label).padEnd(22) + value);

async function main() {
  const dateKey = process.argv[2] || pacificYesterday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw new Error(`bad date ${dateKey}`);

  await connectMongo(getSharedConfig());

  const def = await ReportDefinition.findOne({ name: CANONICAL_DEFINITION_NAME }).lean();
  if (!def) {
    console.log(`No definition named "${CANONICAL_DEFINITION_NAME}".`);
    await disconnectMongo();
    return;
  }

  console.log(`\nDRY RUN — ${CANONICAL_DEFINITION_NAME} for ${dateKey}\n`);
  show("definition range", `${def.range} (resolved here to ${dateKey})`);
  show("preset", def.preset || "(explicit selection)");
  show("sendEmail", String(Boolean(def.sendEmail)));

  const started = Date.now();
  let captured = null;
  const result = await writeDailySnapshot({
    def,
    range: { from: dateKey, to: dateKey },
    // No report supplied: this exercises the compose fallback on purpose, which
    // is the path a backfill would take.
    writer: async (fact) => { captured = fact; return { revision: "(dry run — not written)" }; },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  console.log(`\n  gathered in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
  show("status", result.status + (result.reason ? ` — ${result.reason}` : ""));

  if (!captured) {
    console.log("\nNothing would be stored.\n");
    await disconnectMongo();
    return;
  }

  console.log("\n--- COSTS BY SOURCE (facts.spend) ---");
  const s = captured.facts.spend;
  if (!s) {
    console.log("  NULL — the day would store revenue with no denominator.");
  } else {
    show("total", `$${Number(s.total || 0).toFixed(2)}`);
    show("LD", `$${Number(s.ld || 0).toFixed(2)}  ·  ${s.ldLeads} lead(s)`);
    show("mail", `$${Number(s.mail || 0).toFixed(2)}  ·  ${s.mailPieces} piece(s)`);
    show("BCD", `$${Number(s.bcd || 0).toFixed(2)}  ·  ${s.bcdCalls} call(s)`);
  }

  console.log("\n--- OTHER SECTIONS ---");
  for (const [k, v] of Object.entries(captured.facts)) {
    if (k === "spend") continue;
    const desc = v === null ? "NULL"
      : Array.isArray(v) ? `${v.length} row(s)`
        : typeof v === "object" ? `${Object.keys(v).length} key(s)` : String(v);
    show(k, desc);
  }

  console.log("\n--- COVERAGE ---");
  const c = captured.coverage;
  show("complete", String(c.complete));
  show("coreComplete", String(c.coreComplete));
  show("callProjection", c.callProjection);
  show("captured sections", (c.capturedSections || []).join(", ") || "(none)");
  if ((c.missingSections || []).length) show("MISSING", c.missingSections.join(", "));
  if ((c.sectionErrors || []).length) show("SECTION ERRORS", c.sectionErrors.join(" | "));
  show("reportDegraded", String(c.reportDegraded));

  console.log("\nNothing was written.\n");
  await disconnectMongo();
}

main().catch((e) => { console.error("FAILED " + e.message); process.exitCode = 1; });
