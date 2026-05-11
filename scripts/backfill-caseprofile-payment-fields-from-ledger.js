"use strict";

// Recompute CaseProfile payment fields from PaymentLedger.
//
// Why: `applyPaymentToCaseProfile` historically set `firstPaymentDate`
// only on first-payment-encountered, not first-payment-by-date. When
// a CaseProfile was created late (e.g. via logics-source-rescue) and
// the first ledger row processed happened to be a recent monthly
// payment, firstPaymentDate landed on that date — making old paying
// cases look like fresh "this month" deals in metrics.
//
// The bug was patched in caseProfileRepository.applyPaymentToCaseProfile
// (now compares incoming paidAt to current firstPaymentDate and walks
// it back when older). This script fixes the existing data drift.
//
// Strategy:
//   1. Find candidate CaseProfiles (rescue-tagged or all, configurable).
//   2. For each, read all SUCCESS PaymentLedger rows.
//   3. Compute correct firstPaymentDate, initialPayment, lastPaymentDate,
//      lastPaymentAmount, totalPaid, paymentsCount from the ledger.
//   4. Compare to current CP values. If mismatch, update.
//
// Idempotent: re-running on already-correct rows is a no-op.
//
// Usage:
//   node scripts/backfill-caseprofile-payment-fields-from-ledger.js                        # DRY, only rescue-tagged
//   node scripts/backfill-caseprofile-payment-fields-from-ledger.js --commit
//   node scripts/backfill-caseprofile-payment-fields-from-ledger.js --commit --all         # all CPs, not just rescue-tagged
//   node scripts/backfill-caseprofile-payment-fields-from-ledger.js --commit --caseIds 315235
//   node scripts/backfill-caseprofile-payment-fields-from-ledger.js --commit --domain TAG

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const {
  CaseProfile,
  PaymentLedger,
} = require("../packages/shared-models/src");

function readFlag(argv, name) {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1) return argv[idx + 1];
  return null;
}
function hasFlag(argv, name) {
  return argv.includes(name);
}

function ts(d) {
  return d ? new Date(d).getTime() : null;
}
function sameDay(a, b) {
  if (!a || !b) return false;
  return new Date(a).toISOString().slice(0, 10) === new Date(b).toISOString().slice(0, 10);
}

async function main() {
  const argv = process.argv.slice(2);
  const commit = hasFlag(argv, "--commit");
  const all = hasFlag(argv, "--all");
  const domain = readFlag(argv, "--domain") || null;
  const caseIdsRaw = readFlag(argv, "--caseIds");
  const concurrency = Number(readFlag(argv, "--concurrency")) || 10;

  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(process.env.MONGO_URI, { dbName });

  // Default targeting: only the rescue-tagged cohort, since that's where
  // the bug manifested. Use --all to widen to every CaseProfile.
  const query = {};
  if (domain) query.domain = String(domain).toUpperCase();
  if (caseIdsRaw) {
    const ids = caseIdsRaw
      .split(",")
      .map((s) => Number(String(s).trim()))
      .filter((n) => Number.isFinite(n));
    query.caseId = { $in: ids };
  } else if (!all) {
    query["attribution.matchedBy"] = {
      $in: [
        "logics-source-rescue",
        "logics-discovery-rescue",
        "abc-callrail-rescue",
        "abc-rc-legs-rescue",
        "abc-tracking-number-rescue",
      ],
    };
  }

  const total = await CaseProfile.countDocuments(query);
  console.log("══ CaseProfile payment-fields backfill ══");
  console.log(`  mode:        ${commit ? "COMMIT" : "DRY"}`);
  console.log(`  scope:       ${all ? "all CaseProfiles" : caseIdsRaw ? `caseIds=${caseIdsRaw}` : "rescue-tagged only"}`);
  if (domain) console.log(`  domain:      ${domain}`);
  console.log(`  candidates:  ${total}`);
  console.log(`  concurrency: ${concurrency}\n`);

  if (total === 0) {
    console.log("  Nothing to backfill.");
    await mongoose.disconnect();
    return;
  }

  const cps = await CaseProfile.find(query)
    .select({
      _id: 1,
      domain: 1,
      caseId: 1,
      firstPaymentDate: 1,
      initialPayment: 1,
      lastPaymentDate: 1,
      lastPaymentAmount: 1,
      totalPaid: 1,
      paymentsCount: 1,
    })
    .lean();

  let scanned = 0;
  let drifted = 0;
  let firstDateMoved = 0;
  let lastDateMoved = 0;
  let totalsAdjusted = 0;
  let noLedgerRows = 0;
  const updates = [];

  for (const cp of cps) {
    scanned += 1;
    const ledger = await PaymentLedger.find({
      domain: cp.domain,
      caseId: cp.caseId,
      transactionStatus: "SUCCESS",
    })
      .select({ amount: 1, paymentDate: 1, paymentId: 1 })
      .sort({ paymentDate: 1 })
      .lean();

    if (ledger.length === 0) {
      noLedgerRows += 1;
      continue;
    }

    const earliest = ledger[0];
    const latest = ledger[ledger.length - 1];
    const computedTotal = ledger.reduce((s, p) => s + Number(p.amount || 0), 0);
    const computedCount = ledger.length;

    const wantsFirstUpdate =
      !sameDay(cp.firstPaymentDate, earliest.paymentDate) ||
      Number(cp.initialPayment || 0) !== Number(earliest.amount || 0);
    const wantsLastUpdate =
      !sameDay(cp.lastPaymentDate, latest.paymentDate) ||
      Number(cp.lastPaymentAmount || 0) !== Number(latest.amount || 0);
    const wantsTotalUpdate =
      Math.abs(Number(cp.totalPaid || 0) - computedTotal) > 0.005 ||
      Number(cp.paymentsCount || 0) !== computedCount;

    if (!wantsFirstUpdate && !wantsLastUpdate && !wantsTotalUpdate) continue;

    drifted += 1;
    if (wantsFirstUpdate) firstDateMoved += 1;
    if (wantsLastUpdate) lastDateMoved += 1;
    if (wantsTotalUpdate) totalsAdjusted += 1;

    updates.push({
      filter: { _id: cp._id },
      set: {
        firstPaymentDate: earliest.paymentDate,
        initialPayment: Number(earliest.amount || 0),
        lastPaymentDate: latest.paymentDate,
        lastPaymentAmount: Number(latest.amount || 0),
        totalPaid: computedTotal,
        paymentsCount: computedCount,
      },
      cp,
    });
  }

  console.log(`  scanned:           ${scanned}`);
  console.log(`  drifted:           ${drifted}`);
  console.log(`  - firstDateMoved:  ${firstDateMoved}`);
  console.log(`  - lastDateMoved:   ${lastDateMoved}`);
  console.log(`  - totalsAdjusted:  ${totalsAdjusted}`);
  console.log(`  no-ledger-rows:    ${noLedgerRows}`);

  // Show top-10 most-egregious first-payment-date shifts so the operator
  // can sanity-check what's about to be rewritten.
  const firstShifts = updates
    .filter((u) => !sameDay(u.cp.firstPaymentDate, u.set.firstPaymentDate))
    .map((u) => ({
      caseId: `${u.cp.domain}/${u.cp.caseId}`,
      from: u.cp.firstPaymentDate?.toISOString?.()?.slice(0, 10) || "(null)",
      to: new Date(u.set.firstPaymentDate).toISOString().slice(0, 10),
      shiftDays: Math.round(
        (ts(u.cp.firstPaymentDate) || ts(u.set.firstPaymentDate)) -
          ts(u.set.firstPaymentDate),
      ) / (24 * 3600 * 1000),
      initialFrom: u.cp.initialPayment,
      initialTo: u.set.initialPayment,
    }))
    .sort((a, b) => Math.abs(b.shiftDays) - Math.abs(a.shiftDays))
    .slice(0, 10);
  if (firstShifts.length > 0) {
    console.log(`\n  top firstPaymentDate shifts (most-egregious 10):`);
    for (const s of firstShifts) {
      console.log(
        `    ${s.caseId.padEnd(12)} ${s.from} → ${s.to}  (Δ ${Math.round(s.shiftDays)}d)  initial $${s.initialFrom} → $${s.initialTo}`,
      );
    }
  }

  if (!commit) {
    console.log(`\n  Re-run with --commit to write ${updates.length} updates.`);
    await mongoose.disconnect();
    return;
  }

  if (updates.length === 0) {
    console.log("\n  Nothing to commit.");
    await mongoose.disconnect();
    return;
  }

  console.log(`\n  writing ${updates.length} CaseProfile updates...`);
  const ops = updates.map((u) => ({
    updateOne: {
      filter: u.filter,
      update: { $set: u.set },
    },
  }));
  const chunkSize = 500;
  let modified = 0;
  for (let i = 0; i < ops.length; i += chunkSize) {
    const r = await CaseProfile.bulkWrite(ops.slice(i, i + chunkSize), { ordered: false });
    modified += r.modifiedCount || 0;
  }
  console.log(`  modified: ${modified}`);

  await mongoose.disconnect();
  console.log(`\n[done]`);
}

main().catch((err) => {
  console.error("FATAL:", err.stack || err.message);
  process.exit(1);
});
