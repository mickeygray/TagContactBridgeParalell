"use strict";

// BACKFILL THE CALL-LINK BANK — recording URLs for a range of days.
//
// Mickey 2026-07-30: "we can ... make a bank of july calls we have access to."
//
// Why a bank at all: CallRail hands out recording URLs ONE CALL AT A TIME, so a
// report that wants listen links pays a round-trip per call every time it runs.
// A finished call's URL never changes, so capturing it once turns that into a
// Mongo read — and it means a July report is not silently capped by the
// on-demand fetch limit (REPORT_RECORDING_FETCH_MAX, default 25).
//
// MARKETING lines only. Servicing calls ("Client Contact - TAG") are real calls
// but not marketing, and letting them into the bank makes a client ringing
// support look like a fresh response.
//
//   node scripts/backfill-call-links.js --from 2026-07-01 --to 2026-07-31
//   node scripts/backfill-call-links.js --from ... --to ... --apply
//
// DRY RUN by default: it reads CallRail and reports what it WOULD store.
// Writes go to ONE collection — MarketingCallLink — and are upserts keyed on
// (domain, callId), so re-running is free and the whole thing is reversible by
// dropping the rows for that date range.

require("dotenv").config();

const { connectMongo } = require("../packages/event-core/src");
const { getSharedConfig } = require("../packages/shared-config/src");
const { captureCallLinks } = require("../packages/shared-services/src/marketingCallLinkService");

const NEWLINE = String.fromCharCode(10);
const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  const v = process.argv[i + 1];
  return i > -1 && v && !v.startsWith("--") ? v : fallback;
};
const has = (name) => process.argv.includes(`--${name}`);

function dayRange(from, to) {
  const days = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86400000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

async function main() {
  const from = arg("from");
  const to = arg("to");
  if (!from || !to) {
    console.error("need --from YYYY-MM-DD --to YYYY-MM-DD");
    process.exit(1);
  }
  // CallRail is a single TAG tenant — asking per tenant would be the same
  // account answered three times.
  const domain = String(arg("domain", "TAG")).toUpperCase();
  const apply = has("apply");
  const days = dayRange(from, to);

  console.log(`${NEWLINE}CALL-LINK BANK · ${from} → ${to} · ${domain} · ${apply ? "APPLY" : "DRY RUN"}`);
  console.log("=".repeat(70));

  await connectMongo(getSharedConfig());

  const totals = {
    calls: 0, marketing: 0, servicing: 0,
    withRecording: 0, noRecording: 0, alreadyHad: 0, written: 0, failed: 0,
  };
  const problems = [];

  for (const dateKey of days) {
    const r = await captureCallLinks({ dateKey, domain, apply, logger: null });
    if (r.error) {
      problems.push(`${dateKey}: ${r.error}`);
      console.log(`  ${dateKey}  UNAVAILABLE — ${r.error}`);
      continue;
    }
    for (const k of Object.keys(totals)) totals[k] += Number(r[k]) || 0;
    console.log(
      `  ${dateKey}  ${String(r.calls).padStart(4)} calls · `
      + `${String(r.marketing).padStart(3)} mktg · ${String(r.withRecording).padStart(3)} w/ rec · `
      + `${String(r.alreadyHad).padStart(3)} pooled · ${apply ? `${r.written} written` : `${r.withRecording - r.alreadyHad} to write`}`
      + (r.failed ? `  (${r.failed} failed)` : ""),
    );
  }

  console.log(`${NEWLINE}${"=".repeat(70)}`);
  console.log(`  calls seen        ${totals.calls}`);
  console.log(`  marketing         ${totals.marketing}   (servicing excluded: ${totals.servicing})`);
  console.log(`  with a recording  ${totals.withRecording}   (no recording: ${totals.noRecording})`);
  console.log(`  already pooled    ${totals.alreadyHad}`);
  console.log(`  ${apply ? "WRITTEN" : "would write"}       ${apply ? totals.written : totals.withRecording - totals.alreadyHad}`);
  if (totals.failed) console.log(`  failed            ${totals.failed}`);
  if (problems.length) {
    // A day CallRail could not answer is a hole in the bank, not a zero.
    console.log(`${NEWLINE}  ${problems.length} day(s) unavailable — re-run those before trusting a range that covers them:`);
    for (const p of problems.slice(0, 10)) console.log(`    ${p}`);
  }
  if (!apply) console.log(`${NEWLINE}  DRY RUN — nothing written. Re-run with --apply to fill the bank.`);
  process.exit(0);
}

main().catch((e) => { console.error("backfill failed:", e.stack || e.message); process.exit(1); });
