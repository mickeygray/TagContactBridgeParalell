"use strict";

// Pulls the SSN out of a Logics activity feed by finding the uploaded WIT (Wage &
// Income) document, whose filename embeds the SSN. Shape-agnostic: the filename
// can live in any field; the SSN can be contiguous, dashed, or spaced.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { extractWitSsn, resolveCaseSsnFromLogics, normalizeSsn } = require("../../packages/shared-services/src/logicsWitSsnService");

test("normalizeSsn formats 9 digits and rejects non-SSNs", () => {
  assert.equal(normalizeSsn("608827503"), "608-82-7503");
  assert.equal(normalizeSsn("608-82-7503"), "608-82-7503");
  assert.equal(normalizeSsn("608 82 7503"), "608-82-7503");
  assert.equal(normalizeSsn("12345"), null);
  assert.equal(normalizeSsn(""), null);
});

test("extracts SSN from a WIT filename — contiguous digits (in a Subject field)", () => {
  const activities = { Activities: [{ Subject: "Document Uploaded: WIT_2023_608827503.html" }] };
  const hit = extractWitSsn(activities);
  assert.equal(hit.ssn, "608-82-7503");
  assert.equal(hit.confidence, "high");
});

test("extracts from a dashed and a spaced WIT filename", () => {
  assert.equal(extractWitSsn([{ comment: "WIT_2024_608-82-7503.html" }]).ssn, "608-82-7503");
  assert.equal(extractWitSsn([{ comment: "WIT_2024_608 82 7503.html" }]).ssn, "608-82-7503");
});

test("shape-agnostic: filename nested in a Documents array under a FileName field", () => {
  const activities = {
    Activities: [
      { ActivityType: "Note", Subject: "Called client", Comment: "no answer" },
      { ActivityType: "Document", Documents: [{ FileName: "WIT_2022_608827503.html", uploadedBy: "Jess" }] },
    ],
  };
  const hit = extractWitSsn(activities);
  assert.equal(hit.ssn, "608-82-7503");
});

test("no WIT document => null", () => {
  const activities = { Activities: [{ Subject: "THS_2023_TaxAnalysis.pdf" }, { Subject: "Left voicemail" }] };
  assert.equal(extractWitSsn(activities), null);
});

test("a 9-digit number with no WIT context does NOT false-positive (tracking number / EIN)", () => {
  const activities = { Activities: [{ Comment: "IRS tracking number 481922019 logged" }, { Subject: "EIN 123456789 on file" }] };
  assert.equal(extractWitSsn(activities), null);
});

test("joint case: collects distinct SSNs from taxpayer + spouse WIT docs", () => {
  const activities = [
    { Subject: "WIT_2023_608827503.html" }, // taxpayer
    { Subject: "WIT_2023_412556789.html" }, // spouse
    { Subject: "WIT_2022_608827503.html" }, // taxpayer, prior year (dup SSN)
  ];
  const hit = extractWitSsn(activities);
  assert.equal(hit.ssn, "608-82-7503");
  assert.deepEqual(hit.allSsns, ["608-82-7503", "412-55-6789"]);
});

test("resolveCaseSsnFromLogics fetches activities via the injected client and extracts", async () => {
  const client = { getActivities: async (caseId) => ({ caseId, Activities: [{ Subject: "WIT_2023_608827503.html" }] }) };
  const out = await resolveCaseSsnFromLogics({ caseId: 778412, client });
  assert.equal(out.caseId, 778412);
  assert.equal(out.ssn, "608-82-7503");
  assert.equal(out.confidence, "high");
});

test("resolveCaseSsnFromLogics returns ssn:null (not a throw) when the case has no WIT", async () => {
  const client = { getActivities: async () => ({ Activities: [{ Subject: "Welcome call" }] }) };
  const out = await resolveCaseSsnFromLogics({ caseId: 1, client });
  assert.equal(out.ssn, null);
  assert.equal(out.confidence, "none");
});

test("resolveCaseSsnFromLogics surfaces a fetch error as ssn:null + error (never throws)", async () => {
  const client = { getActivities: async () => { throw new Error("logics 500"); } };
  const out = await resolveCaseSsnFromLogics({ caseId: 1, client });
  assert.equal(out.ssn, null);
  assert.equal(out.confidence, "error");
  assert.match(out.error, /logics 500/);
});
