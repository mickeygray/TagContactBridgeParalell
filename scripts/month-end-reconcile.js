"use strict";

// Month-end reconcile runner (phase 7) — "we can do a big reconcile on the
// entire month when we have everything i want in place" (Mickey, 2026-07-27).
//
// One command, one report: fingerprints the export, truth-ups the ledger
// (payments + failed payments), reconciles case/client profiles, and shows
// the month's board numbers before/after — cash AND sale-attributed, per
// company. DRY-RUN BY DEFAULT; nothing writes without --apply.
//
//   node scripts/month-end-reconcile.js --domain TAG --file <export.csv>
//   node scripts/month-end-reconcile.js --domain TAG --file <export.csv> --apply
//   optional: --from 2026-07-01 --to 2026-07-31   (defaults to the month
//   of the file's latest PaidDate)

const fs = require("fs");
const path = require("path");

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : true;
}

const money = (v) => `${v < 0 ? "-" : ""}$${Math.abs(Number(v) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

(async () => {
  const domain = String(arg("domain", "") || "").toUpperCase();
  const file = arg("file");
  const apply = process.argv.includes("--apply");
  if (!domain || !file) {
    console.error("usage: node scripts/month-end-reconcile.js --domain TAG --file <export.csv> [--from YYYY-MM-DD --to YYYY-MM-DD] [--apply]");
    process.exit(1);
  }
  const buffer = fs.readFileSync(path.resolve(file));

  const { getSharedConfig } = require("../packages/shared-config/src");
  const { connectMongo } = require("../packages/event-core/src");
  const mongoose = require("mongoose");
  const { importLogicsPaymentsCsv } = require("../packages/shared-services/src/logicsPaymentsCsvImportService");
  const { reconcileSheetCases } = require("../packages/shared-services/src/paymentsSheetReconcileService");
  const {
    describePaymentsCsv,
    hashBuffer,
    recordPaymentsSheetImport,
    verifyPaymentsCsvDomain,
  } = require("../packages/shared-services/src/paymentsSheetGateService");
  const { buildSimpleMarketingSummary } = require("../packages/shared-services/src/simpleMarketingReadService");

  await connectMongo(getSharedConfig());

  const shape = describePaymentsCsv(buffer);
  const monthOf = String(shape.coversThrough || "").slice(0, 7);
  const from = String(arg("from", monthOf ? `${monthOf}-01` : null) || "");
  const to = String(arg("to", monthOf ? `${monthOf}-31` : null) || "");
  if (!from || !to) throw new Error("could not derive a window — pass --from/--to");

  console.log(`\n══════ MONTH-END RECONCILE · ${domain} · ${from} .. ${to} · ${apply ? "APPLY" : "DRY RUN"} ══════`);
  console.log(`file: ${path.basename(String(file))}  rows=${shape.rowCount}  covers ${shape.coversFrom} .. ${shape.coversThrough}`);
  console.log(`sha256: ${hashBuffer(buffer).slice(0, 16)}…`);

  // 1. Never write a whole company's payments under the wrong domain.
  const fingerprint = await verifyPaymentsCsvDomain({ domain, caseIds: shape.caseIds });
  if (!fingerprint.ok) {
    console.error(`\nREFUSED: this export reads as ${fingerprint.detected}, not ${domain} `
      + `(${fingerprint.matched}/${fingerprint.total} case ids, confidence ${fingerprint.confidence}).`);
    process.exit(2);
  }
  console.log(`fingerprint: ${fingerprint.detected ?? "(no signal)"} confidence=${fingerprint.confidence} — ok`);

  // 2. The month as the board sees it BEFORE.
  const before = await buildSimpleMarketingSummary({ domain: "ALL", from, to });

  // 3. Ledger truth-up (successes + failed payments).
  const imported = await importLogicsPaymentsCsv({ domain, buffer, dryRun: !apply });
  console.log(`\nLEDGER  parsed=${imported.parsed}  alreadyCorrect=${imported.matchedAlreadyCorrect}  `
    + `updated=${imported.matchedUpdated}  inserted=${imported.inserted}  `
    + `failedMatched=${imported.failedMatched}  failedInserted=${imported.failedInserted}  `
    + `csvSuccessTotal=${money(imported.totalAmount)}`);
  for (const action of imported.actions.filter((a) => a.action === "insert").slice(0, 20)) {
    console.log(`   + ${action.caseId}  ${action.client}  ${money(action.amount)}  ${action.type}  ${action.date}`);
  }
  if (imported.inserted > 20) console.log(`   … and ${imported.inserted - 20} more inserts`);

  // 4. Profiles / sources / rollups from the same sheet.
  const reconcile = await reconcileSheetCases({ domain, rows: shape.rows, dryRun: !apply });
  console.log(`\nPROFILES  cases=${reconcile.cases}  created=${reconcile.profilesCreated}  `
    + `namesFilled=${reconcile.namesFilled}  sourcesFilled=${reconcile.sourcesFilled}  `
    + `rollupsCorrected=${reconcile.rollupsCorrected}${apply ? "" : " (rollups skipped in dry run)"}`);
  for (const conflict of reconcile.sourceConflicts) {
    console.log(`   ? conflict ${conflict.kind} case ${conflict.caseId}: `
      + `${conflict.profile ?? ""}${conflict.profile ? " vs " : ""}${JSON.stringify(conflict.sheet)}`);
  }

  // 5. The month AFTER (apply only — a dry run changes nothing to re-read).
  const report = (label, summary) => {
    const t = summary.totals;
    console.log(`\n${label}`);
    console.log(`   deals=${t.deals}  initials=${money(t.initialsNet)}  `
      + `cash=${money(t.cashCollected)}  attributed=${money(t.totalCollected)}`);
    for (const row of (summary.byDomain || []).sort((a, b) => b.cashCollected - a.cashCollected)) {
      console.log(`   ${String(row.domain).padEnd(6)} clients=${String(row.deals).padStart(3)}  `
        + `initials=${money(row.initialsNet).padStart(12)}  cash=${money(row.cashCollected).padStart(13)}`);
    }
    const restatement = summary.chargebackRestatement || { pulledIn: [], pushedOut: [] };
    for (const p of restatement.pulledIn) console.log(`   ↩ ${p.domain}:${p.caseId} ${money(p.amount)} ${p.kind} paid ${p.paidOn} (sold ${p.soldOn})`);
    for (const p of restatement.pushedOut) console.log(`   ↪ ${p.domain}:${p.caseId} ${money(p.amount)} ${p.kind} paid ${p.paidOn} -> belongs to ${p.soldOn}`);
  };
  report(`BOARD BEFORE (${from} .. ${to})`, before);
  if (apply) {
    report(`BOARD AFTER (${from} .. ${to})`, await buildSimpleMarketingSummary({ domain: "ALL", from, to }));
    const receipt = await recordPaymentsSheetImport({
      domain,
      dateKey: shape.coversThrough,
      summary: imported,
      coversFrom: shape.coversFrom,
      coversThrough: shape.coversThrough,
      fileName: path.basename(String(file)),
      fileHash: hashBuffer(buffer),
      importedBy: "month-end-reconcile-script",
    });
    console.log(`\nreceipt recorded for ${domain} @ ${shape.coversThrough}: ${receipt.recorded === true}`);
  } else {
    console.log("\nDRY RUN — nothing written. Re-run with --apply to commit.");
  }

  await mongoose.disconnect();
})().catch((error) => {
  console.error("month-end-reconcile failed:", error.stack || error.message);
  process.exit(1);
});
