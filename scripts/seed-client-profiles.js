"use strict";

// Seed the resolution case bank (clientProfiles) from the case-master
// workbook — the activity pipeline's work product (credit scores, lender
// outcomes, payments, touches, temperature, pursuit scoring).
//
// Idempotent: upserts by DOMAIN:caseNumber, so re-running with a refreshed
// workbook updates in place. Reads the MASTER sheet (1 row per case, scored).
//
// Usage:
//   node scripts/seed-client-profiles.js --file "C:/path/case-master-workbook.xlsx" --domain TAG --dry
//   node scripts/seed-client-profiles.js --file "C:/path/case-master-workbook.xlsx" --domain WYNN
//
// NOTE: xlsx is installed --no-save (seeding is an operator action, not a
// service path). The workbook FILE is not retained by this script.

require("dotenv").config();
const mongoose = require("mongoose");
const { upsertClientProfile, summarizeBank } = require("../packages/shared-repositories/src/clientProfileRepository");

function argValue(flag, fallback = null) {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

function normalizeDomain(value) {
  return String(value || "TAG").trim().toUpperCase() || "TAG";
}

function toBool(value) {
  const s = String(value ?? "").trim().toLowerCase();
  return s === "true" || s === "yes" || s === "1" || s === "x";
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(String(value).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function splitList(value) {
  return String(value || "")
    .split(/[;|]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 25);
}

function rowToProfile(row, seededFrom, defaultDomain) {
  return {
    caseNumber: String(row.caseNumber || "").trim(),
    domain: normalizeDomain(row.domain || row.Domain || defaultDomain),
    credit: {
      score: toNumber(row.creditScore),
      bureau: String(row.bureau || "").trim() || null,
      pullCount: toNumber(row.softPullCount) || 0,
      minScore: toNumber(row.minScore),
      maxScore: toNumber(row.maxScore),
    },
    funding: {
      funded: toBool(row.loanFunded),
      lastLoanDate: toDate(row.lastLoanDate),
      lastLoanTotal: toNumber(row.lastLoanTotal),
      lastLoanLender: String(row.lastLoanLender || "").trim() || null,
      lastLoanAcct: String(row.lastLoanAcct || "").trim() || null,
      rejected: toBool(row.loanRejected),
      lastRejectionDate: toDate(row.lastRejectionDate),
      lastRejectionAmount: toNumber(row.lastRejectionAmount),
      lastRejectionLender: String(row.lastRejectionLender || "").trim() || null,
      denialLenders: splitList(row.denialLendersDetected),
      denialDates: splitList(row.denialDatesAll),
      approvalLenders: splitList(row.approvalLendersDetected),
    },
    payments: {
      lastDate: toDate(row.lastPaymentDate),
      lastAmount: toNumber(row.lastPaymentAmount),
      lastType: String(row.lastPaymentType || "").trim() || null,
      count: toNumber(row.paymentCount) || 0,
      totalPaid: toNumber(row.totalPaid) || 0,
    },
    touches: {
      work: {
        lastDate: toDate(row.lastWorkTouchDate),
        lastBy: String(row.lastWorkTouchBy || "").trim() || null,
        product: String(row.workProduct || "").trim() || null,
        noteCount: toNumber(row.workNotes) || 0,
      },
      sales: {
        lastDate: toDate(row.lastAsTouchDate),
        lastBy: String(row.lastAsTouchBy || "").trim() || null,
        servicesPitched: String(row.servicesPitched || "").trim() || null,
        lastPitched: String(row.lastThingPitched || "").trim() || null,
        noteCount: toNumber(row.asNotes) || 0,
      },
    },
    temperature: {
      label: String(row.clientTemperature || "unknown").trim().toLowerCase() || "unknown",
      signals: String(row.temperamentSignals || "").trim() || null,
    },
    pursuit: {
      score: toNumber(row.pursuitScore) || 0,
      tier: String(row.pursuitTier || "D").trim().toUpperCase() || "D",
      reasons: String(row.pursuitReasons || "").trim() || null,
      components: {
        credit: toNumber(row.scoreCredit) || 0,
        recency: toNumber(row.scoreRecency) || 0,
        approvedLowPaid: toNumber(row.scoreApprovedLowPaid) || 0,
        retry: toNumber(row.scoreRetry) || 0,
        client: toNumber(row.scoreClient) || 0,
        work: toNumber(row.scoreWork) || 0,
        daysSinceLastAttempt: toNumber(row.daysSinceLastAttempt),
      },
      computedAt: new Date(),
    },
    lifecycle: {
      status: "active",
      seededFrom,
    },
  };
}

(async () => {
  const dry = process.argv.includes("--dry");
  const file = argValue("--file");
  const domain = normalizeDomain(argValue("--domain", "TAG"));
  if (!file) throw new Error("--file <path to case-master-workbook.xlsx> required");

  const XLSX = require("xlsx");
  const wb = XLSX.readFile(file);
  const sheetName = wb.SheetNames.includes("Master") ? "Master" : wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: "" });
  const seededFrom = `case-master-workbook ${new Date().toISOString().slice(0, 10)} (${sheetName})`;

  console.log(`workbook: ${rows.length} rows from "${sheetName}"`);

  let upserts = 0;
  let skipped = 0;
  const tierCounts = {};

  if (!dry) {
    await mongoose.connect(process.env.MONGO_URI, {
      dbName: process.env.MONGO_DB_NAME || "tagcontactbridge_parallel",
    });
  }

  for (const row of rows) {
    const profile = rowToProfile(row, seededFrom, domain);
    if (!profile.caseNumber) {
      skipped += 1;
      continue;
    }
    tierCounts[profile.pursuit.tier] = (tierCounts[profile.pursuit.tier] || 0) + 1;
    if (dry) {
      upserts += 1;
      continue;
    }
    await upsertClientProfile(profile);
    upserts += 1;
    if (upserts % 250 === 0) console.log(`  ...${upserts}`);
  }

  console.log(`${dry ? "DRY: would upsert" : "upserted"} ${upserts}, skipped (no caseNumber) ${skipped}`);
  console.log("tiers:", JSON.stringify(tierCounts));

  if (!dry) {
    console.log("bank summary:", JSON.stringify(await summarizeBank()));
    await mongoose.disconnect();
  }
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
