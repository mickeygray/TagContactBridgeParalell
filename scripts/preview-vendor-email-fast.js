"use strict";

// Faster preview: skips the slow hygiene + payment reconcile parts of
// the close pass and only runs the new source-backfill + the email
// assembly. Use this to sanity-check the LD Posting family flows
// through end-to-end without waiting for full hygiene.

require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
const mongoose = require("mongoose");

const {
  runVendorNightlyEmail,
} = require("../packages/shared-services/src/vendorNightlyEmailService");
const {
  backfillCallLogSourceFromLeadCadence,
} = require("../packages/shared-services/src/callLogSourceBackfillService");

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(uri, { dbName });
  console.log(`connected: ${mongoose.connection.name}`);

  const dk = process.argv[2] || null;

  for (const domain of ["TAG", "WYNN"]) {
    console.log(`\n${"=".repeat(60)}\n${domain} preview\n${"=".repeat(60)}`);

    const backfill = await backfillCallLogSourceFromLeadCadence({
      domain,
      date: dk || new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Los_Angeles",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date()),
    });
    console.log("backfill:", JSON.stringify(backfill, null, 2));

    const report = await runVendorNightlyEmail(domain, {
      date: dk || undefined,
      sendEmail: false,
      performClosePass: false, // skip hygiene + payment reconcile
    });
    console.log("\nbody:");
    console.log(report.body);
    console.log("\nattachmentMeta:", JSON.stringify(report.attachmentMeta, null, 2));
    if (report.summary?.trackedFamilies?.length) {
      console.log("\ntrackedFamilies:");
      for (const fam of report.summary.trackedFamilies) {
        console.log(`  ${fam.familyLabel}: leads=${fam.leads} calls=${fam.calls} callsOver2=${fam.callsOver2}`);
      }
    } else {
      console.log("\n(no tracked families)");
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
