"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveDiscoveryRow,
  summarizeDiscovery,
} = require("../../packages/shared-services/src/marketingCaseDiscoveryService");
const {
  buildLeadReconciliationCsv,
  buildVendorCsv,
} = require("../../packages/shared-services/src/nightlyCsvBuilders");
const {
  findCanonicalResolution,
} = require("../../packages/shared-services/src/metricsAttributionReviewService");

test("case discovery prefers canonical attribution and retains all observation provenance", () => {
  const canonicalId = "abc123";
  const row = resolveDiscoveryRow({
    caseId: 42,
    observedToday: new Set(["cadence", "prospect", "profile"]),
    cadence: {
      caseId: 42,
      createdAt: new Date("2026-07-17T16:00:00Z"),
      sourceName: "raw campaign label",
      intakeSource: "ld-posting",
      routeCampaignKey: "ld-custom",
      active: true,
    },
    prospect: {
      caseId: 42,
      firstSeenAt: new Date("2026-07-17T16:00:01Z"),
      sourceCanonicalId: canonicalId,
      metadata: {},
    },
    profile: {
      caseId: 42,
      caseCreatedDate: new Date("2026-07-17T15:59:59Z"),
      sourceCanonicalId: canonicalId,
    },
  }, new Map([[canonicalId, { internalName: "LD CUSTOM", channel: "ld" }]]));

  assert.equal(row.sourceName, "LD CUSTOM");
  assert.equal(row.sourceChannel, "ld");
  assert.equal(row.attributionState, "attributed");
  assert.deepEqual(row.observedToday, ["cadence", "profile", "prospect"]);
  assert.equal(row.cadencePresent, true);
});

test("case discovery exposes missing cadence, unattributed cases, conflicts, and truncation", () => {
  const rows = [
    { attributionState: "attributed", observedToday: ["cadence"], cadencePresent: true },
    { attributionState: "unattributed", observedToday: ["prospect"], cadencePresent: false },
    { attributionState: "conflict", observedToday: ["profile"], cadencePresent: false },
  ];
  const coverage = summarizeDiscovery(rows, { cadence: false, prospect: true, profile: false });
  assert.deepEqual(coverage, {
    discovered: 3,
    attributed: 1,
    unattributed: 1,
    conflicts: 1,
    observedInCadence: 1,
    observedInProspectIndex: 1,
    observedInCaseProfile: 1,
    missingCadence: 2,
    truncated: true,
    truncation: { cadence: false, prospect: true, profile: false },
  });
});

test("vendor CSV carries month-to-date economics and lead discovery evidence", () => {
  const vendorCsv = buildVendorCsv({
    domain: "WYNN",
    dateKey: "2026-07-17",
    mtdRows: [{
      source: "LD CUSTOM",
      channel: "ld",
      familyLabel: "LD CUSTOM",
      spend: 30,
      leads: 10,
      deals: 2,
      initials: 500,
      paid: 700,
    }],
  }).content.toString("utf8");
  assert.match(vendorCsv, /\[MONTH TO DATE BY SOURCE\]/);
  assert.match(vendorCsv, /LD CUSTOM,ld,LD CUSTOM,30\.00,10/);

  const leadCsv = buildLeadReconciliationCsv({
    domain: "WYNN",
    dateKey: "2026-07-17",
    leads: [{
      caseId: 42,
      attributionState: "unattributed",
      sourceConflict: "no",
      observedToday: "prospect",
      cadencePresent: "no",
    }],
  }).content.toString("utf8");
  assert.match(leadCsv, /attribution_state,source_conflict,observed_in,cadence_present/);
  assert.match(leadCsv, /unattributed,no,prospect,no/);
});

test("manual attribution resolution requires one exact active canonical source", () => {
  const rows = [
    { _id: "one", internalName: "LD CUSTOM", canonicalKey: "ld-custom", channel: "ld", aliases: ["Custom"] },
    { _id: "two", internalName: "Mail A", canonicalKey: "mail-a", channel: "mailer", aliases: [] },
  ];
  assert.equal(findCanonicalResolution(rows, "custom", "ld")._id, "one");
  assert.equal(findCanonicalResolution(rows, "MAIL-A")._id, "two");
  assert.equal(findCanonicalResolution(rows, "missing"), null);
  assert.equal(findCanonicalResolution([
    { _id: "one", internalName: "Shared", channel: "ld" },
    { _id: "two", internalName: "Shared", channel: "mailer" },
  ], "Shared"), null);
  assert.equal(findCanonicalResolution([
    { _id: "one", internalName: "Shared", channel: "ld" },
    { _id: "two", internalName: "Shared", channel: "mailer" },
  ], "Shared", "mailer")._id, "two");
});
