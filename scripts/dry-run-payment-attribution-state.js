"use strict";

// Dry-run smoke test for the air-tight payment attribution pipeline.
//
// Reports the per-case state across the three coupled tables that
// metrics depend on:
//   - CaseProfile (the canonical source/sourceCanonicalId + the
//     payment-derived counters)
//   - PaymentLedger (the truth set for $ and dates)
//   - SourceCanonical (the canonical attribution lookup target)
//
// Columns:
//   caseId | name | CP source old | CP canonical | ledger row count |
//   ledger canonical breakdown | ledger needs reassign | firstPmt drift |
//   initial drift | total drift | wouldUpdate
//
// Pulls the candidate cohort exactly the way the hourly sweep does
// (4-signal candidate query inside runPaymentFieldsSync) so the report
// reflects what the next on-tick run would touch — nothing simulated.
//
// Usage:
//   node scripts/dry-run-payment-attribution-state.js                   # default (TAG, 6h lookback, all candidates)
//   node scripts/dry-run-payment-attribution-state.js --domain WYNN
//   node scripts/dry-run-payment-attribution-state.js --lookbackHours 24
//   node scripts/dry-run-payment-attribution-state.js --maxCases 100
//   node scripts/dry-run-payment-attribution-state.js --caseIds 315235,318910
//   node scripts/dry-run-payment-attribution-state.js --json            # machine-readable
//
// This script writes nothing. Pair with the existing
// `backfill-caseprofile-payment-fields-from-ledger.js --commit` if you
// want to actually correct what shows up here.

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const {
  CaseProfile,
  PaymentLedger,
  SourceCanonical,
} = require("../packages/shared-models/src");
const {
  computeDesiredFields,
  detectDrift,
  listCandidateCaseIds,
  runPaymentFieldsSync,
  sumAmountDriftDollars,
} = require("../packages/shared-services/src/caseProfilePaymentSyncService");

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

function fmtDate(value) {
  if (!value) return "(null)";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "(invalid)";
  return d.toISOString().slice(0, 10);
}

function fmtMoney(value) {
  return `$${(Number(value) || 0).toFixed(2)}`;
}

function shorten(value, max = 24) {
  const text = String(value || "");
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function pad(value, width) {
  const text = String(value ?? "");
  if (text.length >= width) return text;
  return text + " ".repeat(width - text.length);
}

async function loadCanonicalsByIds(idList) {
  const distinctIds = [...new Set(idList.map((id) => String(id || "")).filter(Boolean))];
  if (distinctIds.length === 0) return new Map();
  const docs = await SourceCanonical.find({ _id: { $in: distinctIds } })
    .select({ _id: 1, internalName: 1, channel: 1, canonicalKey: 1 })
    .lean();
  const map = new Map();
  for (const doc of docs) {
    map.set(String(doc._id), doc);
  }
  return map;
}

async function buildPerCaseRow({ normalizedDomain, caseId, canonicalCache }) {
  const profile = await CaseProfile.findOne({
    domain: normalizedDomain,
    caseId,
  }).lean();
  if (!profile) {
    return {
      caseId,
      missing: true,
    };
  }

  const ledger = await PaymentLedger.find({
    domain: normalizedDomain,
    caseId,
  })
    .sort({ paymentDate: 1, casePaymentId: 1 })
    .lean();

  const desired = computeDesiredFields(ledger);
  const drifts = detectDrift(profile, desired);
  const totalDriftDollars = sumAmountDriftDollars(drifts);

  // Ledger canonical breakdown — counts each unique sourceCanonicalId
  // present on the case's ledger rows. If this disagrees with the CP's
  // sourceCanonicalId, the ledger needs a follow-up sync (the
  // syncPaymentLedgerSourceForCase repository helper will fix it).
  const ledgerByCanonical = new Map();
  for (const row of ledger) {
    const key = row.sourceCanonicalId
      ? String(row.sourceCanonicalId)
      : "(none)";
    ledgerByCanonical.set(key, (ledgerByCanonical.get(key) || 0) + 1);
  }
  const cpCanonicalKey = profile.sourceCanonicalId
    ? String(profile.sourceCanonicalId)
    : "(none)";
  const ledgerNeedsReassign =
    [...ledgerByCanonical.keys()].some((key) => key !== cpCanonicalKey) ||
    (ledger.length > 0 && cpCanonicalKey === "(none)");

  // Decorate canonical name for human-readable output.
  for (const key of ledgerByCanonical.keys()) {
    if (key !== "(none)") {
      const cached = canonicalCache.get(key);
      if (!cached) canonicalCache.set(key, null); // defer batch lookup
    }
  }
  if (cpCanonicalKey !== "(none)" && !canonicalCache.has(cpCanonicalKey)) {
    canonicalCache.set(cpCanonicalKey, null);
  }

  const driftFields = new Set(drifts.map((d) => d.field));

  return {
    missing: false,
    caseId,
    name:
      profile.name ||
      [profile.firstName, profile.lastName].filter(Boolean).join(" ") ||
      "(unnamed)",
    cpSourceName: profile.sourceName || null,
    cpCanonicalId: cpCanonicalKey,
    ledgerRowCount: ledger.length,
    ledgerByCanonical,
    ledgerNeedsReassign,
    firstPmtDrift: driftFields.has("firstPaymentDate"),
    initialDrift: driftFields.has("initialPayment"),
    totalDrift: driftFields.has("totalPaid"),
    paymentsCountDrift: driftFields.has("paymentsCount"),
    lastPmtDrift: driftFields.has("lastPaymentDate"),
    lastAmountDrift: driftFields.has("lastPaymentAmount"),
    totalDriftDollars,
    drifts,
    desired,
    profile,
    wouldUpdate: drifts.length > 0,
  };
}

function renderTextReport({ rows, summary }) {
  const HEADER = [
    "caseId",
    "name",
    "CP source",
    "CP canonical",
    "ledger #",
    "ledger by canonical",
    "needs reassign",
    "firstPmt Δ",
    "initial Δ",
    "total Δ",
    "wouldUpdate",
  ];
  const widths = [9, 24, 24, 26, 8, 28, 14, 11, 10, 10, 11];
  console.log(HEADER.map((h, i) => pad(h, widths[i])).join(" "));
  console.log(widths.map((w) => "-".repeat(w)).join(" "));

  for (const row of rows) {
    if (row.missing) {
      console.log(
        pad(row.caseId, widths[0]) +
          " " +
          pad("(no CaseProfile)", widths[1]),
      );
      continue;
    }
    const ledgerByCanonicalText = [...row.ledgerByCanonical.entries()]
      .map(
        ([key, count]) =>
          `${row.canonicalLookup?.get(key) || (key === "(none)" ? "(none)" : "(unknown)")}×${count}`,
      )
      .join(", ");
    const cpCanonicalText =
      row.cpCanonicalId === "(none)"
        ? "(none)"
        : row.canonicalLookup?.get(row.cpCanonicalId) ||
          `_id:${row.cpCanonicalId.slice(-6)}`;
    console.log(
      [
        pad(row.caseId, widths[0]),
        pad(shorten(row.name, widths[1] - 1), widths[1]),
        pad(shorten(row.cpSourceName || "(null)", widths[2] - 1), widths[2]),
        pad(shorten(cpCanonicalText, widths[3] - 1), widths[3]),
        pad(row.ledgerRowCount, widths[4]),
        pad(shorten(ledgerByCanonicalText, widths[5] - 1), widths[5]),
        pad(row.ledgerNeedsReassign ? "YES" : "no", widths[6]),
        pad(row.firstPmtDrift ? "YES" : "no", widths[7]),
        pad(row.initialDrift ? "YES" : "no", widths[8]),
        pad(row.totalDrift ? "YES" : "no", widths[9]),
        pad(row.wouldUpdate ? "YES" : "no", widths[10]),
      ].join(" "),
    );
  }

  console.log("");
  console.log("══ summary ══");
  console.log(`  candidates scanned:   ${summary.casesScanned}`);
  console.log(`  cases drifted:        ${summary.casesWithDrift}`);
  console.log(`  - firstPmt shifts:    ${summary.firstPmtShifts}`);
  console.log(`  - initial mismatches: ${summary.initialMismatches}`);
  console.log(`  - total mismatches:   ${summary.totalMismatches}`);
  console.log(`  - count mismatches:   ${summary.paymentsCountMismatches}`);
  console.log(`  ledger reassign rows: ${summary.ledgerReassignCount}`);
  console.log(`  fallback initial:     ${summary.fallbackUsed}`);
  console.log(`  Σ |drift $|:          ${fmtMoney(summary.totalDriftDollars)}`);
  console.log("");
  console.log(
    `  This is a DRY RUN — no writes performed. To correct fields, set\n  PAYMENT_FIELD_SYNC_ENABLED=true and the next hourly tick will reconcile.\n  Or run scripts/backfill-caseprofile-payment-fields-from-ledger.js --commit.`,
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const domain = (readFlag(argv, "--domain") || "TAG").toUpperCase();
  const lookbackHours = Number(readFlag(argv, "--lookbackHours")) || 6;
  const staleCheckHours = Number(readFlag(argv, "--staleCheckHours")) || 24;
  const maxCases = Number(readFlag(argv, "--maxCases")) || 500;
  const caseIdsRaw = readFlag(argv, "--caseIds");
  const asJson = hasFlag(argv, "--json");

  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(process.env.MONGO_URI, { dbName });

  if (!asJson) {
    console.log("══ Payment-attribution dry-run ══");
    console.log(`  domain:         ${domain}`);
    console.log(`  lookbackHours:  ${lookbackHours}`);
    console.log(`  staleCheckHrs:  ${staleCheckHours}`);
    console.log(`  maxCases:       ${maxCases}`);
    if (caseIdsRaw) console.log(`  caseIds (override): ${caseIdsRaw}`);
    console.log("");
  }

  let candidateIds;
  if (caseIdsRaw) {
    candidateIds = caseIdsRaw
      .split(",")
      .map((s) => Number(String(s).trim()))
      .filter((n) => Number.isFinite(n));
  } else {
    candidateIds = await listCandidateCaseIds(domain, {
      lookbackHours,
      staleCheckMs: staleCheckHours * 60 * 60 * 1000,
    });
  }
  const limited = candidateIds.slice(0, maxCases);

  const canonicalCache = new Map();
  const rows = [];
  for (const caseId of limited) {
    const row = await buildPerCaseRow({
      normalizedDomain: domain,
      caseId,
      canonicalCache,
    });
    rows.push(row);
  }

  // Resolve all canonical names in a single batch — saves N+1 queries.
  const canonicalIds = [...canonicalCache.keys()].filter((k) => k !== "(none)");
  const canonicalById = await loadCanonicalsByIds(canonicalIds);
  for (const row of rows) {
    if (row.missing) continue;
    row.canonicalLookup = new Map();
    for (const id of [
      row.cpCanonicalId,
      ...row.ledgerByCanonical.keys(),
    ]) {
      if (id === "(none)") continue;
      const canonical = canonicalById.get(String(id));
      row.canonicalLookup.set(
        String(id),
        canonical?.internalName || `_id:${String(id).slice(-6)}`,
      );
    }
  }

  // Roll up summary numbers — separate from the per-row report so the
  // operator can scan the totals without scrolling 500 rows.
  const summary = rows.reduce(
    (acc, row) => {
      if (row.missing) {
        acc.missingCaseProfiles += 1;
        return acc;
      }
      acc.casesScanned += 1;
      if (row.wouldUpdate) acc.casesWithDrift += 1;
      if (row.firstPmtDrift) acc.firstPmtShifts += 1;
      if (row.initialDrift) acc.initialMismatches += 1;
      if (row.totalDrift) acc.totalMismatches += 1;
      if (row.paymentsCountDrift) acc.paymentsCountMismatches += 1;
      if (row.ledgerNeedsReassign) acc.ledgerReassignCount += 1;
      if (row.desired?.initialFallbackUsed) acc.fallbackUsed += 1;
      acc.totalDriftDollars += Number(row.totalDriftDollars || 0);
      return acc;
    },
    {
      missingCaseProfiles: 0,
      casesScanned: 0,
      casesWithDrift: 0,
      firstPmtShifts: 0,
      initialMismatches: 0,
      totalMismatches: 0,
      paymentsCountMismatches: 0,
      ledgerReassignCount: 0,
      fallbackUsed: 0,
      totalDriftDollars: 0,
    },
  );
  summary.totalDriftDollars = Number(summary.totalDriftDollars.toFixed(2));

  // Cross-check by also calling runPaymentFieldsSync({ dryRun:true }) —
  // confirms the service produces the same drift count this script
  // computed independently. If they disagree, the operator gets a
  // visible warning.
  const sweepResult = await runPaymentFieldsSync({
    domain,
    lookbackHours,
    staleCheckMs: staleCheckHours * 60 * 60 * 1000,
    maxCases,
    dryRun: true,
    lockedBy: "dry-run-smoke",
  });

  if (asJson) {
    const json = {
      domain,
      lookbackHours,
      staleCheckHours,
      maxCases,
      summary,
      sweepResult,
      rows: rows.map((row) => {
        if (row.missing) return { caseId: row.caseId, missing: true };
        return {
          caseId: row.caseId,
          name: row.name,
          cpSourceName: row.cpSourceName,
          cpCanonicalId: row.cpCanonicalId,
          cpCanonicalName:
            row.canonicalLookup?.get(row.cpCanonicalId) || null,
          ledgerRowCount: row.ledgerRowCount,
          ledgerByCanonical: [...row.ledgerByCanonical.entries()].map(
            ([key, count]) => ({
              canonicalId: key,
              canonicalName: row.canonicalLookup?.get(key) || null,
              count,
            }),
          ),
          ledgerNeedsReassign: row.ledgerNeedsReassign,
          drifts: row.drifts,
          desired: row.desired,
          totalDriftDollars: Number(row.totalDriftDollars.toFixed(2)),
          wouldUpdate: row.wouldUpdate,
        };
      }),
    };
    console.log(JSON.stringify(json, null, 2));
  } else {
    renderTextReport({ rows, summary });
    console.log("");
    console.log("══ runPaymentFieldsSync({ dryRun: true }) cross-check ══");
    console.log(
      `  service-side casesScanned:   ${sweepResult.casesScanned} (script: ${summary.casesScanned})`,
    );
    console.log(
      `  service-side casesWithDrift: ${sweepResult.casesWithDrift} (script: ${summary.casesWithDrift})`,
    );
    console.log(
      `  service-side wouldUpdate:    ${sweepResult.wouldUpdate}`,
    );
    console.log(
      `  service-side fallbackUsed:   ${sweepResult.fallbackUsed} (script: ${summary.fallbackUsed})`,
    );
    if (sweepResult.skipped) {
      console.log(`  ⚠ service skipped: reason=${sweepResult.reason}`);
    }
    if (
      sweepResult.casesWithDrift !== summary.casesWithDrift ||
      sweepResult.casesScanned !== summary.casesScanned
    ) {
      console.log(
        `  ⚠ DIVERGENCE: service drift count differs from script — ` +
          `inspect runPaymentFieldsSync() vs buildPerCaseRow() candidate ordering.`,
      );
    }
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("FATAL:", err.stack || err.message);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});
