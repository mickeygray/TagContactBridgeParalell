"use strict";

require("dotenv").config();

const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
const { getSharedConfig } = require("../packages/shared-config/src");
const {
  caseProfileRepository,
  masterProspectRepository,
  leadCadenceRepository,
} = require("../packages/shared-repositories/src");

const caseId = Number(process.argv[2]);
if (!Number.isFinite(caseId)) {
  console.error("usage: node scripts/diagnose-case.js <caseId>");
  process.exit(1);
}

async function main() {
  await connectMongo(getSharedConfig());

  for (const domain of ["TAG", "WYNN", "AMITY"]) {
    console.log(`\n=== domain=${domain} caseId=${caseId} ===`);

    const cp = await caseProfileRepository.findCaseProfile(domain, caseId);
    if (cp) {
      const plain = cp.toObject ? cp.toObject() : cp;
      console.log("CaseProfile FOUND:");
      console.log({
        domain: plain.domain,
        caseId: plain.caseId,
        firstName: plain.firstName,
        lastName: plain.lastName,
        name: plain.name,
        email: plain.email,
        primaryPhone: plain.primaryPhone,
        normalizedPhones: plain.normalizedPhones,
        statusId: plain.statusId,
        statusCategory: plain.statusCategory,
        sourceName: plain.sourceName,
        notes: plain.notes,
        updatedAt: plain.updatedAt,
      });
    } else {
      console.log("CaseProfile: not found");
    }

    const mp = await masterProspectRepository.findMasterProspect(domain, caseId);
    if (mp) {
      const plain = mp.toObject ? mp.toObject() : mp;
      console.log("MasterProspect FOUND:", {
        firstName: plain.firstName,
        lastName: plain.lastName,
        cellPhone: plain.cellPhone,
        email: plain.email,
        statusCategory: plain.statusCategory,
      });
    } else {
      console.log("MasterProspect: not found");
    }

    const lc = await leadCadenceRepository.findLeadCadence(domain, caseId);
    console.log("LeadCadence:", lc ? "found" : "not found");
  }

  // Legacy clients (the old `clients` collection in LEGACY_APP_DB_NAME).
  const mongoose = require("mongoose");
  const legacyDbName = process.env.LEGACY_APP_DB_NAME || "test";
  const legacyDb = mongoose.connection.useDb(legacyDbName, { useCache: true });
  console.log(`\n=== legacy db=${legacyDbName} collection=clients ===`);
  for (const domain of ["TAG", "WYNN", "AMITY"]) {
    const row = await legacyDb
      .collection("clients")
      .findOne({ domain, caseNumber: caseId });
    if (row) {
      console.log(`legacy clients FOUND in domain=${domain}:`, {
        caseNumber: row.caseNumber,
        name: row.name,
        email: row.email,
        cell: row.cell,
        status: row.status,
        stage: row.stage,
        lastContactDate: row.lastContactDate,
      });
    }
    const stringMatch = await legacyDb
      .collection("clients")
      .findOne({ domain, caseNumber: String(caseId) });
    if (stringMatch && !row) {
      console.log(`legacy clients FOUND (string caseNumber) in domain=${domain}:`, {
        caseNumber: stringMatch.caseNumber,
        name: stringMatch.name,
        email: stringMatch.email,
        cell: stringMatch.cell,
        status: stringMatch.status,
      });
    }
    if (!row && !stringMatch) {
      console.log(`legacy clients domain=${domain}: not found`);
    }
  }

  // Open search across legacy `clients` — try without domain filter, and
  // sample one row to see what shape the collection uses.
  console.log("\n=== legacy clients open search (no domain filter) ===");
  const openMatches = await legacyDb
    .collection("clients")
    .find({ $or: [{ caseNumber: caseId }, { caseNumber: String(caseId) }] })
    .limit(5)
    .toArray();
  console.log(`open caseNumber matches: ${openMatches.length}`);
  for (const m of openMatches) {
    console.log({
      _id: m._id,
      domain: m.domain,
      caseNumber: m.caseNumber,
      name: m.name,
      email: m.email,
      cell: m.cell,
    });
  }

  // Sample one legacy doc to confirm shape
  const sample = await legacyDb.collection("clients").findOne({});
  console.log("\nlegacy clients sample doc keys:", sample ? Object.keys(sample) : "(empty collection)");

  // PaymentLedger direct check — was this case actually reconciled?
  console.log("\n=== PaymentLedger entries for caseId=310930 (any domain) ===");
  const ledgerRows = await mongoose.connection.db
    .collection("controlplanepaymentledgers")
    .find({ caseId: caseId })
    .limit(10)
    .toArray()
    .catch((err) => {
      console.log("ledger query error:", err.message);
      return [];
    });
  console.log(`PaymentLedger rows: ${ledgerRows.length}`);
  for (const row of ledgerRows) {
    console.log("  ", {
      domain: row.domain,
      caseId: row.caseId,
      paymentDate: row.paymentDate,
      amount: row.amount,
      status: row.status,
      transactionId: row.transactionId,
      createdAt: row.createdAt,
    });
  }

  // CallLog direct check — maybe an inbound call surfaced this caseId
  console.log("\n=== CallLog entries for caseId=310930 (any domain) ===");
  const callLogRows = await mongoose.connection.db
    .collection("controlplanecalllogs")
    .find({ caseId: caseId })
    .limit(5)
    .toArray()
    .catch(() => []);
  console.log(`CallLog rows by caseId: ${callLogRows.length}`);
  for (const row of callLogRows) {
    console.log("  ", {
      domain: row.domain,
      caseId: row.caseId,
      direction: row.direction,
      startTime: row.startTime,
      from: row.fromNumber,
      to: row.toNumber,
    });
  }
  // Also try by Joseph's phone (we got it from Logics: (216)299-4926)
  const josephDigits = "2162994926";
  const callLogByPhone = await mongoose.connection.db
    .collection("controlplanecalllogs")
    .find({
      $or: [
        { fromNumber: { $regex: josephDigits } },
        { toNumber: { $regex: josephDigits } },
        { normalizedFrom: josephDigits },
        { normalizedTo: josephDigits },
      ],
    })
    .limit(5)
    .toArray()
    .catch(() => []);
  console.log(`CallLog rows by Joseph's phone (${josephDigits}): ${callLogByPhone.length}`);
  for (const row of callLogByPhone) {
    console.log("  ", {
      domain: row.domain,
      caseId: row.caseId,
      direction: row.direction,
      startTime: row.startTime,
    });
  }

  // Raw collection scan — bypass the repository, hit Mongo directly to
  // catch any domain casing / collection-name surprises.
  console.log("\n=== raw scan: every collection in active db for caseId=310930 ===");
  const activeDb = mongoose.connection.db;
  const allCollections = await activeDb.listCollections().toArray();
  for (const c of allCollections) {
    const collName = c.name;
    const matches = await activeDb
      .collection(collName)
      .find({
        $or: [
          { caseId: caseId },
          { caseId: String(caseId) },
          { caseNumber: caseId },
          { caseNumber: String(caseId) },
          { CaseID: caseId },
        ],
      })
      .limit(3)
      .toArray()
      .catch(() => []);
    if (matches.length > 0) {
      console.log(`HIT in collection "${collName}" (${matches.length} rows):`);
      for (const m of matches) {
        console.log("  ", {
          _id: m._id,
          domain: m.domain,
          caseId: m.caseId,
          caseNumber: m.caseNumber,
          name: m.name,
          firstName: m.firstName,
          lastName: m.lastName,
          primaryPhone: m.primaryPhone,
          normalizedPhones: m.normalizedPhones,
          email: m.email,
        });
      }
    }
  }

  // List collections in BOTH dbs and look for any collection containing
  // a row referencing 310930 (under any plausible field name).
  for (const [label, db] of [["parallel", mongoose.connection.db], ["legacy", legacyDb.db]]) {
    console.log(`\n=== ${label} db = ${db.databaseName}: collection scan ===`);
    const cols = await db.listCollections().toArray();
    for (const c of cols) {
      const matches = await db
        .collection(c.name)
        .find({
          $or: [
            { caseId: caseId },
            { caseId: String(caseId) },
            { caseNumber: caseId },
            { caseNumber: String(caseId) },
            { CaseID: caseId },
            { case_id: caseId },
            { case_id: String(caseId) },
          ],
        })
        .limit(3)
        .toArray()
        .catch(() => []);
      if (matches.length > 0) {
        console.log(`  HIT in "${c.name}" (${matches.length} rows)`);
        for (const m of matches) {
          const keys = Object.keys(m).slice(0, 12).join(",");
          console.log(`    _id=${m._id} domain=${m.domain || "?"} keys=[${keys}...]`);
        }
      }
    }
  }

  // Tier 4 simulation — try Logics directly for both tenants.
  const { createLogicsClient } = require("../packages/shared-integrations/src");
  for (const domain of ["TAG", "WYNN"]) {
    console.log(`\n=== Logics getCaseInfo(${caseId}) on ${domain} ===`);
    try {
      const client = createLogicsClient(domain);
      const payload = await client.getCaseInfo(caseId);
      const data = payload?.data ?? payload?.Data ?? payload;
      const record = Array.isArray(data) ? data[0] : data;
      if (record && typeof record === "object") {
        console.log("Logics MATCH:", {
          CaseID: record.CaseID,
          FirstName: record.FirstName,
          LastName: record.LastName,
          CellPhone: record.CellPhone,
          Email: record.Email,
          StatusID: record.StatusID,
          StatusLabel: record.StatusLabel,
        });
      } else {
        console.log("Logics: empty payload");
      }
    } catch (err) {
      console.log(
        `Logics ERROR: ${err.message} (status=${err?.details?.responseStatus ?? "?"})`,
      );
    }
  }

  // Full searchCxCases end-to-end (what the UI actually calls).
  const { searchCxCases } = require("../packages/shared-services/src/cxWorkspaceService");
  for (const domain of ["TAG", "WYNN"]) {
    console.log(`\n=== searchCxCases(${domain}, "${caseId}") ===`);
    try {
      const result = await searchCxCases(
        domain,
        { email: "diagnostic@local", name: "diag", company: domain },
        { search: String(caseId), limit: 20, scope: "all" },
      );
      console.log(`merged.length = ${result.merged.length}`);
      for (const row of result.merged) {
        console.log(" -", {
          caseId: row.caseId,
          name: row.name,
          source: row.source,
        });
      }
    } catch (err) {
      console.log(`searchCxCases ERROR: ${err.message}`);
    }
  }

  console.log(
    `\nactive parallel db = ${mongoose.connection.name}, host = ${mongoose.connection.host}`,
  );
  console.log(`legacy db name (LEGACY_APP_DB_NAME) = ${legacyDbName}`);

  await disconnectMongo();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
