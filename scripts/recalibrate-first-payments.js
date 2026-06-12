"use strict";

// One-off recalibrator: re-derive first-payment truth from Logics for every
// case that touched the window, and correct BOTH stores — the Parallel
// ledger + counters, and the legacy rb_caseprofiles counters the panel's
// dual-read path still consults.
//
// WHY: the June probe showed the two stores disagree with each other AND
// with Logics ($28.4k ledger vs $23.5k profile counters for the same
// window). Drift sources: Logics edits after sync (ledger updates, counters
// don't), profiles created late (initial never applied), out-of-order
// arrivals, and the one-payment-per-case "initial" crowning shifting when
// missing rows backfill.
//
// METHOD (per case, same code the hourly runs — no parallel logic):
//   1. getCasePayments from Logics → normalizePaymentRows() — the
//      production classifier crowns exactly one SUCCESS payment "initial".
//   2. Diff vs PaymentLedger: insert missing rows, correct amount/status/
//      type/dateKey drift. Ledger rows Logics no longer has are REPORTED,
//      never deleted.
//   3. Recompute CaseProfile counters wholesale from the authoritative
//      list (firstPaymentDate, initialPayment, totalPaid, paymentsCount,
//      lastPaymentDate/Amount) AND sync paymentIds to the SUCCESS ledger
//      ids — applyPaymentToCaseProfile guards on that set, so leaving it
//      stale would let the next hourly re-apply payments and recreate the
//      drift we just fixed.
//   4. Mirror the same counters onto the legacy rb_caseprofiles doc (the
//      panel's summarizeInitialPaymentsBySource legacy branch reads
//      initialPayment + firstPaymentDate from there).
//
// DRY BY DEFAULT. Paced + jittered Logics GETs, circuit breaker at 5
// consecutive failures.
//
// GHOST CASES (--csv): cases sold straight in Logics with no caseProfile are
// invisible to BOTH stores — the hourly reconcile only visits profile-holders,
// so their payments never sync and no profile ever gets created (June: 5
// payments, $5,803). Neither DB can discover them; the CRM PaymentsReport
// export can. Pass it with --csv and its Case IDs join the candidates; in
// write mode the production reconcilePaymentsForCase creates their profiles
// + ledger rows through the same code the hourly runs.
//
// Usage:
//   node scripts/recalibrate-first-payments.js                              (June, dry)
//   node scripts/recalibrate-first-payments.js --csv "C:/.../PaymentsReport.csv" --write
//   node scripts/recalibrate-first-payments.js --domain TAG --case 364750 --write

require("dotenv").config();
const fs = require("fs");
const mongoose = require("mongoose");
require("../packages/shared-models/src");
const { createLogicsClient } = require("../packages/shared-integrations/src");
const {
  normalizePaymentRows,
  reconcilePaymentsForCase,
} = require("../packages/shared-services/src/paymentReconcileService");
const { legacyReadDb } = require("../packages/shared-repositories/src/legacyReadDb");

// CRM PaymentsReport exports are UTF-16 LE; comments are multiline quoted
// blobs full of transaction/account digits — only trust a quoted number at
// the START of a record line as a Case ID.
function parseCrmReportCaseIds(filePath) {
  const buffer = fs.readFileSync(filePath);
  // CRM exports are UTF-16 LE and may OMIT the BOM — detect by the NUL
  // high byte on the first ASCII character instead of trusting ff fe.
  const utf16 = (buffer[0] === 0xff && buffer[1] === 0xfe)
    || (buffer.length >= 2 && buffer[0] !== 0x00 && buffer[1] === 0x00);
  const text = utf16 ? buffer.toString("utf16le") : buffer.toString("utf8");
  const ids = new Set();
  for (const match of text.matchAll(/(?:^|\r?\n)\s*"(\d{4,8})"\s*,/g)) {
    ids.add(Number(match[1]));
  }
  return [...ids];
}

function argValue(flag, fallback = null) {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n) => `$${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const sameMoney = (a, b) => Math.abs(Number(a || 0) - Number(b || 0)) < 0.005;
const sameDate = (a, b) => {
  const ta = a ? new Date(a).getTime() : null;
  const tb = b ? new Date(b).getTime() : null;
  return ta === tb;
};

(async () => {
  const write = process.argv.includes("--write");
  const from = argValue("--from", "2026-06-01");
  const to = argValue("--to", "2026-06-30");
  const domains = String(argValue("--domain", "TAG,WYNN")).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const onlyCase = argValue("--case");
  const paceMs = Math.max(100, Number(argValue("--pace", 300)) || 300);
  const csvPath = argValue("--csv");
  const csvCaseIds = csvPath ? parseCrmReportCaseIds(csvPath) : [];
  if (csvPath) console.log(`CRM report: ${csvCaseIds.length} case IDs parsed from ${csvPath}`);

  await mongoose.connect(process.env.MONGO_URI, {
    dbName: process.env.MONGO_DB_NAME || "tagcontactbridge_parallel",
  });
  const PaymentLedger = mongoose.model("ControlPlanePaymentLedger");
  const CaseProfile = mongoose.model("ControlPlaneCaseProfile");
  const legacyProfiles = legacyReadDb(mongoose).collection("rb_caseprofiles");

  console.log(`recalibrate first payments ${from}..${to}  domains ${domains.join(",")}  mode ${write ? "WRITE" : "DRY"}\n`);

  const totals = {
    cases: 0, logicsFailures: 0,
    ledgerInserted: 0, ledgerUpdated: 0, ledgerOrphans: 0, typeFlips: 0,
    parallelCountersFixed: 0, legacyCountersFixed: 0, legacyMissing: 0,
    ghostCasesAdopted: 0,
    initialDeltaByDomain: {},
  };

  for (const domain of domains) {
    // Candidates: any case that touched the window in ANY store's view.
    const windowStart = new Date(`${from}T00:00:00-07:00`);
    const windowEnd = new Date(`${to}T23:59:59-07:00`);
    const [ledgerCases, parallelCases, legacyCases] = await Promise.all([
      PaymentLedger.distinct("caseId", { domain, paymentDateKey: { $gte: from, $lte: to } }),
      CaseProfile.distinct("caseId", { domain, firstPaymentDate: { $gte: windowStart, $lte: windowEnd } }),
      legacyProfiles.distinct("caseId", { domain, firstPaymentDate: { $gte: windowStart, $lte: windowEnd } }).catch(() => []),
    ]);
    const caseIds = onlyCase
      ? [Number(onlyCase)]
      : [...new Set([...ledgerCases, ...parallelCases, ...legacyCases, ...csvCaseIds].map(Number).filter(Number.isFinite))];
    console.log(`=== ${domain}: ${caseIds.length} candidate cases (ledger ${ledgerCases.length}, parallel ${parallelCases.length}, legacy ${legacyCases.length}, crm-csv ${csvCaseIds.length}) ===`);

    const client = createLogicsClient(domain);
    let consecutiveFailures = 0;
    let initialBefore = 0;
    let initialAfter = 0;

    for (const caseId of caseIds) {
      totals.cases += 1;
      let truth;
      try {
        truth = normalizePaymentRows(await client.getCasePayments(caseId), domain);
        consecutiveFailures = 0;
      } catch (error) {
        totals.logicsFailures += 1;
        consecutiveFailures += 1;
        console.log(`  ${caseId}: LOGICS FAILED (${error.message.slice(0, 80)})`);
        if (consecutiveFailures >= 5) {
          console.log("  !! 5 consecutive Logics failures — circuit open, stopping this domain");
          break;
        }
        await sleep(paceMs);
        continue;
      }

      const caseChanges = [];

      // -- GHOST-CASE ADOPTION (must run BEFORE ledger inserts) ---------------
      // reconcilePaymentsForCase only creates the missing caseProfile when it
      // sees NEW ledger rows; if we pre-insert them below, every row reads
      // alreadyPresent and the profile never materializes. So: profile check
      // first, production reconcile first, then the diff pass below sees a
      // normal case and fine-tunes.
      const hasSuccess = truth.some((r) => String(r.transactionStatus || "").toUpperCase() === "SUCCESS");
      const preProfile = await CaseProfile.exists({ domain, caseId });
      if (!preProfile && hasSuccess) {
        caseChanges.push(`GHOST CASE — no caseProfile; ${write ? "ran" : "would run"} reconcilePaymentsForCase (creates profile + ledger via production path)`);
        totals.ghostCasesAdopted += 1;
        if (write) {
          await reconcilePaymentsForCase({ domain, caseId, lane: "nightly" });
        }
      }

      const ledgerRows = await PaymentLedger.find({ domain, caseId }).lean();
      const ledgerById = new Map(ledgerRows.map((r) => [Number(r.casePaymentId), r]));
      const truthById = new Map(truth.map((r) => [r.casePaymentId, r]));

      // -- Ledger corrections ------------------------------------------------
      for (const row of truth) {
        const existing = ledgerById.get(row.casePaymentId);
        if (!existing) {
          caseChanges.push(`ledger INSERT ${row.casePaymentId} ${row.paymentType} ${fmt(row.amount)} ${row.paymentDateKey} ${row.transactionStatus}`);
          totals.ledgerInserted += 1;
          if (write) {
            await PaymentLedger.findOneAndUpdate(
              { casePaymentId: row.casePaymentId },
              { $set: row },
              { upsert: true, setDefaultsOnInsert: true },
            );
          }
          continue;
        }
        const diffs = [];
        if (!sameMoney(existing.amount, row.amount)) diffs.push(`amount ${fmt(existing.amount)}→${fmt(row.amount)}`);
        if (String(existing.transactionStatus || "") !== String(row.transactionStatus || "")) diffs.push(`status ${existing.transactionStatus}→${row.transactionStatus}`);
        if (String(existing.paymentType || "") !== String(row.paymentType || "")) {
          diffs.push(`type ${existing.paymentType}→${row.paymentType}`);
          totals.typeFlips += 1;
        }
        if (String(existing.paymentDateKey || "") !== String(row.paymentDateKey || "")) diffs.push(`dateKey ${existing.paymentDateKey}→${row.paymentDateKey}`);
        if (diffs.length) {
          caseChanges.push(`ledger UPDATE ${row.casePaymentId}: ${diffs.join(", ")}`);
          totals.ledgerUpdated += 1;
          if (write) {
            await PaymentLedger.updateOne(
              { casePaymentId: row.casePaymentId },
              { $set: { amount: row.amount, transactionStatus: row.transactionStatus, paymentType: row.paymentType, paymentDate: row.paymentDate, paymentDateKey: row.paymentDateKey, raw: row.raw } },
            );
          }
        }
      }
      for (const row of ledgerRows) {
        if (!truthById.has(Number(row.casePaymentId))) {
          caseChanges.push(`ledger ORPHAN ${row.casePaymentId} ${fmt(row.amount)} ${row.paymentDateKey} (in ledger, not in Logics — left untouched)`);
          totals.ledgerOrphans += 1;
        }
      }

      // -- Counter recompute (whole-history, from Logics truth) ---------------
      const success = truth
        .filter((r) => String(r.transactionStatus || "").toUpperCase() === "SUCCESS")
        .sort((a, b) => a.paymentDate - b.paymentDate || a.casePaymentId - b.casePaymentId);
      const first = success[0] || null;
      const last = success[success.length - 1] || null;
      const counters = {
        firstPaymentDate: first?.paymentDate || null,
        initialPayment: first?.amount || 0,
        lastPaymentDate: last?.paymentDate || null,
        lastPaymentAmount: last?.amount || 0,
        totalPaid: Math.round(success.reduce((sum, r) => sum + r.amount, 0) * 100) / 100,
        paymentsCount: success.length,
      };

      // Window-scoped initials delta (the number the user is reconciling).
      const inWindow = (d) => d && new Date(d) >= windowStart && new Date(d) <= windowEnd;
      const profile = await CaseProfile.findOne({ domain, caseId })
        .select({ initialPayment: 1, firstPaymentDate: 1, totalPaid: 1, paymentsCount: 1, lastPaymentDate: 1, lastPaymentAmount: 1, paymentIds: 1, name: 1 })
        .lean();
      if (inWindow(profile?.firstPaymentDate)) initialBefore += Number(profile?.initialPayment || 0);
      if (inWindow(counters.firstPaymentDate)) initialAfter += Number(counters.initialPayment || 0);

      if (profile) {
        const profDiffs = [];
        if (!sameMoney(profile.initialPayment, counters.initialPayment)) profDiffs.push(`initialPayment ${fmt(profile.initialPayment)}→${fmt(counters.initialPayment)}`);
        if (!sameDate(profile.firstPaymentDate, counters.firstPaymentDate)) {
          // Same calendar day but different time = show full timestamps so
          // the diff doesn't read as a no-op.
          const a = profile.firstPaymentDate ? new Date(profile.firstPaymentDate).toISOString() : "-";
          const b = counters.firstPaymentDate ? counters.firstPaymentDate.toISOString() : "-";
          const sameDay = a.slice(0, 10) === b.slice(0, 10);
          profDiffs.push(`firstPaymentDate ${sameDay ? a : a.slice(0, 10)}→${sameDay ? b : b.slice(0, 10)}`);
        }
        if (!sameMoney(profile.totalPaid, counters.totalPaid)) profDiffs.push(`totalPaid ${fmt(profile.totalPaid)}→${fmt(counters.totalPaid)}`);
        if (Number(profile.paymentsCount || 0) !== counters.paymentsCount) profDiffs.push(`paymentsCount ${profile.paymentsCount || 0}→${counters.paymentsCount}`);
        if (profDiffs.length) {
          caseChanges.push(`parallel COUNTERS: ${profDiffs.join(", ")}`);
          totals.parallelCountersFixed += 1;
          if (write) {
            // paymentIds must mirror the SUCCESS ledger ids or the next
            // hourly's applyPaymentToCaseProfile guard re-applies rows.
            const successLedgerIds = await PaymentLedger.find({
              domain, caseId,
              casePaymentId: { $in: success.map((r) => r.casePaymentId) },
            }).distinct("_id");
            await CaseProfile.updateOne(
              { domain, caseId },
              { $set: { ...counters, paymentIds: successLedgerIds } },
            );
          }
        }
      } else if (success.length) {
        // Still no profile after adoption (dry run, or Logics CaseInfo
        // failed during creation) — surfaced, nothing silently dropped.
        caseChanges.push(`parallel PROFILE MISSING (${success.length} payments, ${fmt(counters.totalPaid)}) — counters live nowhere${write ? "; adoption did not complete, check logs" : ""}`);
      }

      // -- Legacy mirror -------------------------------------------------------
      const legacyDoc = await legacyProfiles.findOne(
        { domain, caseId },
        { projection: { initialPayment: 1, firstPaymentDate: 1, totalPaid: 1, paymentsCount: 1 } },
      ).catch(() => null);
      if (legacyDoc) {
        const legDiffs = [];
        if (!sameMoney(legacyDoc.initialPayment, counters.initialPayment)) legDiffs.push(`initialPayment ${fmt(legacyDoc.initialPayment)}→${fmt(counters.initialPayment)}`);
        if (!sameDate(legacyDoc.firstPaymentDate, counters.firstPaymentDate)) legDiffs.push(`firstPaymentDate ${legacyDoc.firstPaymentDate ? new Date(legacyDoc.firstPaymentDate).toISOString().slice(0, 10) : "-"}→${counters.firstPaymentDate?.toISOString?.().slice(0, 10) || "-"}`);
        if (!sameMoney(legacyDoc.totalPaid, counters.totalPaid)) legDiffs.push(`totalPaid ${fmt(legacyDoc.totalPaid)}→${fmt(counters.totalPaid)}`);
        if (legDiffs.length) {
          caseChanges.push(`legacy COUNTERS: ${legDiffs.join(", ")}`);
          totals.legacyCountersFixed += 1;
          if (write) {
            await legacyProfiles.updateOne(
              { domain, caseId },
              { $set: { initialPayment: counters.initialPayment, firstPaymentDate: counters.firstPaymentDate, totalPaid: counters.totalPaid, paymentsCount: counters.paymentsCount, lastPaymentDate: counters.lastPaymentDate, lastPaymentAmount: counters.lastPaymentAmount } },
            );
          }
        }
      } else {
        totals.legacyMissing += 1;
      }

      if (caseChanges.length) {
        console.log(`  ${caseId} ${profile?.name || ""}`.trimEnd());
        for (const change of caseChanges) console.log(`     ${change}`);
      }
      await sleep(paceMs + Math.floor(Math.random() * 150));
    }

    totals.initialDeltaByDomain[domain] = { before: initialBefore, after: initialAfter };
    console.log(`--- ${domain} window initials (profile-counter view): ${fmt(initialBefore)} → ${fmt(initialAfter)} (${fmt(initialAfter - initialBefore)})\n`);
  }

  console.log("=== summary ===");
  console.log(JSON.stringify(totals, null, 2));
  if (!write) console.log("\nDRY RUN — re-run with --write to apply.");
  await mongoose.disconnect();
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
