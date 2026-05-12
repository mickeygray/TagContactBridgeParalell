"use strict";

// Dry-run the vendor nightly email for today — runs the close pass
// (including the new source backfill) and assembles the report body +
// attachment row counts but does NOT send. Use this to verify the
// "LD Posting" family flows through end-to-end.
//
// Usage: node scripts/preview-vendor-email.js [YYYY-MM-DD]

require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
const mongoose = require("mongoose");

const {
  runVendorNightlyEmail,
} = require("../packages/shared-services/src/vendorNightlyEmailService");

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(uri, { dbName });

  const dk = process.argv[2] || null;
  for (const domain of ["TAG", "WYNN"]) {
    console.log(`\n${"=".repeat(60)}\n=== ${domain} ${dk || "today"} preview ===\n${"=".repeat(60)}`);
    const report = await runVendorNightlyEmail(domain, {
      date: dk || undefined,
      sendEmail: false,
      performClosePass: true,
    });
    console.log("\nclosePass:", JSON.stringify({
      callLogHygiene: report.closePass?.callLogHygiene && {
        mirrored: report.closePass.callLogHygiene.counts?.mirrored,
        ledgerSynced: report.closePass.callLogHygiene.counts?.ledgerSynced,
      },
      sourceBackfill: report.closePass?.sourceBackfill && {
        rowsScanned: report.closePass.sourceBackfill.rowsScanned,
        rowsStamped: report.closePass.sourceBackfill.rowsStamped,
        rowsSkippedNoCadence: report.closePass.sourceBackfill.rowsSkippedNoCadence,
      },
      errors: report.closePass?.errors,
    }, null, 2));
    console.log("\nbody:");
    console.log(report.body);
    console.log("\nattachmentMeta:", JSON.stringify(report.attachmentMeta, null, 2));
    if (report.summary?.trackedFamilies?.length) {
      console.log("\ntrackedFamilies (full):");
      for (const fam of report.summary.trackedFamilies) {
        console.log(`  ${fam.familyLabel}: leads=${fam.leads} calls=${fam.calls} callsOver2=${fam.callsOver2}`);
      }
    }
    if (report.summary?.rows?.length) {
      console.log("\nsource rows (top 10):");
      for (const r of report.summary.rows.slice(0, 10)) {
        console.log(`  ${r.familyLabel} | ${r.source}: leads=${r.leads} calls=${r.calls}`);
      }
    }
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
