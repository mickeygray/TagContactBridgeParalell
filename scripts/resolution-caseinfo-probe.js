"use strict";

// READ-ONLY probe: dump the field surface of Logics Case/CaseInfo (and the
// shapes of the per-case billing/activity endpoints) for the clientProfile
// freshness mapping. One case, a handful of GETs.
//
// Usage: node scripts/resolution-caseinfo-probe.js <company> <caseId>

require("dotenv").config();
const { createLogicsClient } = require("../packages/shared-integrations/src");
const { parseLogicsData } = require("../packages/shared-services/src/logicsFacadeService");

function unwrap(payload) {
  try {
    const parsed = parseLogicsData(payload);
    return parsed;
  } catch {
    const data = payload && payload.Data !== undefined ? payload.Data : payload;
    if (typeof data === "string") {
      try { return JSON.parse(data); } catch { return data; }
    }
    return data;
  }
}

function describe(label, value, maxKeys = 40) {
  const v = Array.isArray(value) ? value[0] : value;
  if (!v || typeof v !== "object") {
    console.log(`${label}: (${typeof v})`, String(v).slice(0, 120));
    return;
  }
  console.log(`${label}: ${Array.isArray(value) ? `array[${value.length}], first row keys` : "object keys"}:`);
  console.log("  " + Object.keys(v).slice(0, maxKeys).join(", "));
}

(async () => {
  const company = process.argv[2] || "TAG";
  const caseId = process.argv[3] || "364750";
  const client = createLogicsClient(company);

  const info = unwrap(await client.getCase(caseId));
  describe("CaseInfo", info);
  const row = Array.isArray(info) ? info[0] : info;
  if (row && typeof row === "object") {
    for (const k of Object.keys(row)) {
      const val = row[k];
      if (val !== null && val !== "" && typeof val !== "object") {
        console.log(`  ${k} = ${String(val).slice(0, 60)}`);
      }
    }
  }

  describe("CasePayments", unwrap(await client.getCasePayments(caseId)));
  describe("CaseInvoices", unwrap(await client.getCaseInvoices(caseId)));
  describe("BillingSummary", unwrap(await client.getCaseBillingSummary(caseId)));
  const acts = unwrap(await client.getActivities(caseId));
  describe("Activities", acts);
  if (Array.isArray(acts) && acts.length) {
    console.log(`  total activities: ${acts.length}`);
  }
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
