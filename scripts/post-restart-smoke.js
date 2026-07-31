"use strict";

// Post-restart smoke — proves the metrics loop actually came up.
//
// READ-ONLY. No writes, no emails, no live mutations. Safe to run any time.
// Run it BEFORE the restart (expect the index + activity checks to fail) and
// AFTER (expect all PASS). Exits non-zero if any hard check fails.
//
//   node scripts/post-restart-smoke.js
//   node scripts/post-restart-smoke.js --date 2026-07-27
//
// Build-up work order F0.2.

const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const mongoose = require("mongoose");
const { getSharedConfig, ROOT_DIR } = require(path.join(ROOT, "packages/shared-config/src"));
const { connectMongo } = require(path.join(ROOT, "packages/event-core/src"));

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

const results = [];
function record(level, label, detail = "") {
  results.push({ level, label, detail });
  const tag = level === "pass" ? "PASS" : level === "warn" ? "WARN" : "FAIL";
  console.log(`  [${tag}] ${label}${detail ? ` — ${detail}` : ""}`);
}
async function check(label, fn, { soft = false } = {}) {
  try {
    const detail = await fn();
    record("pass", label, detail || "");
  } catch (error) {
    record(soft ? "warn" : "fail", label, String(error.message).slice(0, 160));
  }
}

function todayPacific() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

(async () => {
  const dateKey = String(arg("date", todayPacific()));
  console.log(`\n══ POST-RESTART SMOKE · ${dateKey} ══\n`);

  // 1 — the service barrel loads at all
  let services = null;
  await check("services index loads", () => {
    services = require(path.join(ROOT, "packages/shared-services/src"));
    return `${Object.keys(services).length} exports`;
  });
  if (!services) {
    console.log("\nAborting: the service index did not load.\n");
    process.exit(1);
  }

  await connectMongo(getSharedConfig());
  const db = mongoose.connection.db;

  // 2 — the phone index exists (proves syncIndexes ran on restart)
  await check("CaseProfile has {domain, normalizedPhones} index", async () => {
    const idx = await db.collection("controlplanecaseprofiles").indexes();
    const hit = idx.find((i) => i.key
      && i.key.domain === 1
      && Object.prototype.hasOwnProperty.call(i.key, "normalizedPhones"));
    if (!hit) throw new Error("index absent — syncIndexes has not run since the schema change");
    return hit.name;
  });

  // 3 — the gate answers, and NEVER holds safety work
  await check("payments-sheet gate evaluates", async () => {
    const { evaluatePaymentsSheetGate } = require(
      path.join(ROOT, "packages/shared-services/src/paymentsSheetGateService"),
    );
    const gate = await evaluatePaymentsSheetGate({ dateKey });
    if (typeof gate.holdMoney !== "boolean") throw new Error("gate returned no holdMoney");
    if (gate.holdSafetyWork !== false) {
      throw new Error("holdSafetyWork is not false — a finance control must never gate DNC work");
    }
    return `holdMoney=${gate.holdMoney} ready=${gate.ready} missing=[${(gate.missing || []).join(",")}]`;
  });

  // 4 — the one read returns the shapes everything downstream depends on
  const read = require(path.join(ROOT, "packages/shared-services/src/simpleMarketingReadService"));
  await check("summary read returns cash + vintage breakdown", async () => {
    const s = await read.buildSimpleMarketingSummary({ domain: "ALL", from: dateKey, to: dateKey });
    if (typeof s.totals.cashCollected !== "number") throw new Error("totals.cashCollected missing");
    if (!s.totals.cashBreakdown) throw new Error("totals.cashBreakdown missing");
    const b = s.totals.cashBreakdown;
    return `deals=${s.totals.deals} cash=$${s.totals.cashCollected.toFixed(2)} `
      + `(new $${b.initial.toFixed(2)} / thisMo $${b.recurringFromThisMonth.toFixed(2)} / back $${b.recurringFromOlderMonths.toFixed(2)})`;
  });

  // 5 — the two body-only lists resolve
  await check("listFailedPayments returns an array", async () => {
    const rows = await read.listFailedPayments({ from: dateKey, to: dateKey });
    if (!Array.isArray(rows)) throw new Error("not an array");
    return `${rows.length} failed payment(s)`;
  });
  await check("listLongCalls returns an array", async () => {
    const rows = await read.listLongCalls({ dateKey });
    if (!Array.isArray(rows)) throw new Error("not an array");
    return `${rows.length} long call(s), ${rows.filter((r) => r.listenUrl).length} with listen links`;
  });

  // 6 — the EX ruling, enforced at runtime not just in tests
  await check("NO EX recording can surface (ruling 6.1)", async () => {
    const rows = await read.listLongCalls({ dateKey, limit: 50 });
    const leaked = rows.filter((r) => String(r.platform || "").toLowerCase() === "ex");
    if (leaked.length) throw new Error(`${leaked.length} EX row(s) surfaced — allow-list breached`);
    const allowed = [...read.LONG_CALL_RECORDING_PLATFORMS].join("/");
    return `allow-list = ${allowed}`;
  });

  // 7 — the activity day file the narrative reads (soft: 20:00 may not have run)
  await check("activity day JSON with statusChangeCounts", async () => {
    const file = path.join(ROOT_DIR, "runtime", "logics-activity-review",
      `logics-activity-review-ALL-${dateKey}.json`);
    if (!fs.existsSync(file)) throw new Error(`not written yet: ${path.basename(file)}`);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const counts = parsed?.processed?.statusChangeCounts;
    if (!counts || counts.error) throw new Error("statusChangeCounts missing or errored");
    return `dnc=${counts.dnc} postdate=${counts.postdate} casesChanged=${counts.casesChanged}`;
  }, { soft: true });

  // 8 — the nightly metrics email would render (build only, sends nothing).
  // This is the 20:00 report scheduler now; the old simple nightly email and
  // its builders were deleted 2026-07-31.
  await check("nightly metrics email builds (no send)", async () => {
    const { composeReport, toTemplateData } = require(
      path.join(ROOT, "packages/shared-services/src/reportComposerService"));
    const report = await composeReport({
      selection: ["rollup"], from: dateKey, to: dateKey, domain: null, live: true,
    });
    const data = toTemplateData(report, { title: "smoke", eyebrow: "Report" });
    if (!Array.isArray(data.sections) || data.sections.length !== 5) {
      throw new Error(`expected 5 sections, built ${data.sections?.length}`);
    }
    // A gather that quietly failed is the exact thing this smoke test exists
    // to surface, so say so rather than reporting a clean build.
    const bad = (report.failures || []).length;
    return `${data.sections.length} sections${bad ? `, ${bad} source(s) DID NOT ANSWER` : ", every source answered"}`;
  });

  await mongoose.disconnect();

  const failed = results.filter((r) => r.level === "fail");
  const warned = results.filter((r) => r.level === "warn");
  console.log(`\n── ${results.length - failed.length - warned.length} pass · ${warned.length} warn · ${failed.length} fail ──\n`);
  if (failed.length) {
    console.log("FAILED CHECKS:");
    for (const f of failed) console.log(`  · ${f.label}: ${f.detail}`);
    console.log();
    process.exit(1);
  }
  process.exit(0);
})().catch((error) => {
  console.error("smoke run crashed:", error.stack || error.message);
  process.exit(1);
});
