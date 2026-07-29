"use strict";

// Phone fold (work order §3.5a/b): every Logics phone — including the
// SPOUSE's — folded into one searchable, indexed set.
//
// Fixtures are the REAL shapes pulled from Logics on 2026-07-27:
//   415022 DONALD DAVIS — spouse BARBARA, cell (302)898-1247, no home,
//          work (915)791-4000 on the primary. Her number already sat in
//          our call logs unattributed; Logics' own FindCaseByPhone 404s
//          on it. This is the attribution hole the fold closes.
//   394513 STEVEN NEVEL SR. — spouse JESSICA with BOTH cell and work.
//   336405 KYE BROOKS — no spouse at all (must stay null, not an
//          empty object that overwrites something).

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildCaseProfilePhonePatch,
  foldCasePhones,
  normalizePhone,
} = require("../../packages/shared-services/src/casePhoneFoldService");

const DAVIS_415022 = {
  FirstName: "DONALD", LastName: "DAVIS",
  CellPhone: "(302)345-2034", HomePhone: "", WorkPhone: "(915)791-4000",
  SpouseFirstName: "BARBARA", SpouseLastName: "DAVIS",
  SpouseCellPhone: "(302)898-1247", SpouseHomePhone: "", SpouseWorkPhone: "",
  SpouseEmail: "",
};
const NEVEL_394513 = {
  FirstName: "STEVEN", LastName: "NEVEL SR.",
  CellPhone: "(724)967-2320", HomePhone: "", WorkPhone: "(937)704-9900",
  SpouseFirstName: "JESSICA", SpouseLastName: "BOYERS",
  SpouseCellPhone: "(724)967-4387", SpouseWorkPhone: "(724)283-7633",
  SpouseHomePhone: "", SpouseEmail: "JNEVEL1122@GMAIL.COM",
};
const BROOKS_336405 = {
  FirstName: "KYE", LastName: "BROOKS",
  CellPhone: "(702)793-7472", HomePhone: "", WorkPhone: "",
  SpouseFirstName: "", SpouseLastName: "", SpouseCellPhone: "",
  SpouseHomePhone: "", SpouseWorkPhone: "", SpouseEmail: "",
};

test("normalizePhone handles the formats Logics actually emits", () => {
  assert.equal(normalizePhone("(302)898-1247"), "3028981247");
  assert.equal(normalizePhone("1-724-967-4387"), "7249674387");
  assert.equal(normalizePhone("7249674387"), "7249674387");
  assert.equal(normalizePhone("302 898 1247"), "3028981247");
  // Not usable → null, never a partial match key.
  assert.equal(normalizePhone(""), null);
  assert.equal(normalizePhone("555-1234"), null);
  assert.equal(normalizePhone(null), null);
  assert.equal(normalizePhone("+44 20 7946 0958"), null);
});

test("THE POINT: the spouse's number lands in normalizedPhones", () => {
  const folded = foldCasePhones(DAVIS_415022);
  assert.ok(
    folded.normalizedPhones.includes("3028981247"),
    "Barbara's cell must be searchable — this is the attribution rescue",
  );
  assert.deepEqual(folded.spousePhones, ["3028981247"]);
});

test("all six fields fold, primary first, deduped", () => {
  const folded = foldCasePhones(NEVEL_394513);
  assert.deepEqual(folded.normalizedPhones, [
    "7249672320", // CellPhone (primary, first)
    "9377049900", // WorkPhone
    "7249674387", // SpouseCellPhone
    "7242837633", // SpouseWorkPhone
  ]);
  assert.equal(folded.primaryPhone, "(724)967-2320", "raw Logics format kept for display");
  assert.equal(folded.spouse.workPhone, "(724)283-7633", "the field we had no slot for");
});

test("a shared household number is stored once", () => {
  const folded = foldCasePhones({
    CellPhone: "(302)555-0100",
    SpouseHomePhone: "302-555-0100",
    SpouseCellPhone: "(302)555-0199",
  });
  assert.deepEqual(folded.normalizedPhones, ["3025550100", "3025550199"]);
});

test("no spouse → spouse stays NULL, never an empty object", () => {
  const folded = foldCasePhones(BROOKS_336405);
  assert.equal(folded.spouse, null, "an empty spouse block must not overwrite existing data");
  assert.deepEqual(folded.spousePhones, []);
  assert.deepEqual(folded.normalizedPhones, ["7027937472"]);
});

test("the patch omits keys it has nothing to say about", () => {
  // Fold must never blank a field another writer stamped.
  assert.deepEqual(buildCaseProfilePhonePatch({}), {});
  const patch = buildCaseProfilePhonePatch(BROOKS_336405);
  assert.deepEqual(Object.keys(patch).sort(), ["normalizedPhones", "primaryPhone"]);
  assert.ok(!("spouse" in patch), "no spouse key when Logics reports none");
});

test("the patch is upsert-ready for case 415022", () => {
  const patch = buildCaseProfilePhonePatch(DAVIS_415022);
  assert.equal(patch.primaryPhone, "(302)345-2034");
  assert.deepEqual(patch.normalizedPhones, ["3023452034", "9157914000", "3028981247"]);
  assert.equal(patch.spouse.firstName, "BARBARA");
  assert.equal(patch.spouse.cellPhone, "(302)898-1247");
  assert.equal(patch.spouse.homePhone, null);
});

test("garbage in does not throw", () => {
  for (const input of [null, undefined, {}, { CellPhone: 12345 }, { SpouseCellPhone: {} }]) {
    const folded = foldCasePhones(input);
    assert.ok(Array.isArray(folded.normalizedPhones));
  }
});
