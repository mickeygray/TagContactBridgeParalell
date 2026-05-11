"use strict";

// Quick lookup: find any "Ping Li" in MasterProspectIndex and report
// how many prospects were inserted after that record (by createdAt).
// Throwaway — delete after the question is answered.

const path = require("path");
const mongoose = require("mongoose");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const { LeadCadence, MasterProspectIndex } = require("../packages/shared-models/src");

(async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  // Match loosely on name fields. "Ping Li" could be:
  //   - name = "Ping Li" / "PING LI" / "Li, Ping"
  //   - firstName = "Ping", lastName = "Li"
  //   - firstName = "Li", lastName = "Ping" (some imports flip)
  //   - lastName containing "li" with firstName "ping" anywhere
  const matches = await MasterProspectIndex.find({
    $or: [
      { name: /ping/i, lastName: /li/i },
      { name: /li.*ping|ping.*li/i },
      { firstName: /^\s*ping\s*$/i, lastName: /^\s*li\s*$/i },
      { firstName: /^\s*li\s*$/i, lastName: /^\s*ping\s*$/i },
    ],
  })
    .select({
      _id: 1,
      domain: 1,
      caseId: 1,
      firstName: 1,
      lastName: 1,
      name: 1,
      cellPhone: 1,
      city: 1,
      state: 1,
      createdAt: 1,
      updatedAt: 1,
      "metadata.lastImportBatch": 1,
      "metadata.intakeSource": 1,
    })
    .sort({ createdAt: 1 })
    .lean();

  // Cadence-side loose lookup as a backstop — useful if the row
  // never made it into MasterProspectIndex (older intakes, or rows
  // we promoted without re-mirroring into the prospect index).
  const cadenceMatches = await LeadCadence.find({
    $or: [
      { name: /ping/i },
      { firstName: /^\s*ping\s*$/i, lastName: /^\s*li\s*$/i },
      { firstName: /^\s*li\s*$/i, lastName: /^\s*ping\s*$/i },
    ],
  })
    .select({ _id: 1, domain: 1, caseId: 1, firstName: 1, lastName: 1, name: 1, primaryPhone: 1, createdAt: 1 })
    .sort({ createdAt: 1 })
    .lean();

  if (matches.length === 0) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      foundInProspectIndex: 0,
      foundInLeadCadence: cadenceMatches.length,
      cadenceMatches: cadenceMatches.slice(0, 10),
      message: "No Ping Li in MasterProspectIndex" + (cadenceMatches.length ? "; see cadenceMatches" : ""),
    }, null, 2));
    await mongoose.disconnect();
    return;
  }

  // For each match, count the records that came after (strictly newer
  // by createdAt) within the same domain. Most useful when there's
  // exactly one match — multiple report each on its own line.
  const reports = [];
  for (const match of matches) {
    const afterCount = await MasterProspectIndex.countDocuments({
      domain: match.domain,
      createdAt: { $gt: match.createdAt },
    });
    const afterCountAllDomains = await MasterProspectIndex.countDocuments({
      createdAt: { $gt: match.createdAt },
    });
    reports.push({
      _id: String(match._id),
      domain: match.domain,
      caseId: match.caseId,
      name: match.name || [match.firstName, match.lastName].filter(Boolean).join(" "),
      cellPhone: match.cellPhone,
      city: match.city,
      state: match.state,
      createdAt: match.createdAt,
      updatedAt: match.updatedAt,
      lastImportBatch: match.metadata?.lastImportBatch || null,
      intakeSource: match.metadata?.intakeSource || null,
      afterInThisDomain: afterCount,
      afterAllDomains: afterCountAllDomains,
    });
  }

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ found: matches.length, matches: reports }, null, 2));

  await mongoose.disconnect();
})().catch(async (error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  try { await mongoose.disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
