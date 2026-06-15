"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { extractActivityNotes } = require("../../packages/shared-services/src/resolutionBankService");

test("empty / non-array input => []", () => {
  assert.deepEqual(extractActivityNotes([]), []);
  assert.deepEqual(extractActivityNotes(null), []);
  assert.deepEqual(extractActivityNotes(undefined), []);
});

test("extracts id, date, by, and joined text from the Logics activity fields", () => {
  const out = extractActivityNotes([
    {
      ActivityID: 1001,
      CreatedDate: "2026-06-10T15:00:00Z",
      CreatedByName: "Jane Rep",
      Subject: "Left voicemail",
      Comment: "Discussed CP504 timeline",
    },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].activityId, 1001);
  assert.equal(out[0].at, "2026-06-10T15:00:00.000Z");
  assert.equal(out[0].by, "Jane Rep");
  assert.equal(out[0].text, "Left voicemail — Discussed CP504 timeline");
});

test("drops activities that have no text in any text field", () => {
  const out = extractActivityNotes([
    { ActivityID: 1, CreatedDate: "2026-06-01T00:00:00Z" }, // no Subject/Comment/Notes/etc.
    { ActivityID: 2, CreatedDate: "2026-06-02T00:00:00Z", Notes: "real note" },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].activityId, 2);
});

test("orders newest-first by date, then by activityId", () => {
  const out = extractActivityNotes([
    { ActivityID: 1, CreatedDate: "2026-06-01T00:00:00Z", Subject: "old" },
    { ActivityID: 3, CreatedDate: "2026-06-03T00:00:00Z", Subject: "new" },
    { ActivityID: 2, CreatedDate: "2026-06-02T00:00:00Z", Subject: "mid" },
  ]);
  assert.deepEqual(out.map((n) => n.text), ["new", "mid", "old"]);
});

test("caps at the requested limit (newest kept)", () => {
  const acts = Array.from({ length: 40 }, (_, i) => ({
    ActivityID: i + 1,
    CreatedDate: `2026-06-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
    Subject: `note ${i + 1}`,
  }));
  assert.equal(extractActivityNotes(acts, { limit: 25 }).length, 25);
  assert.equal(extractActivityNotes(acts, { limit: 5 }).length, 5);
});

test("collapses whitespace and truncates long text to maxTextLen", () => {
  const long = "word ".repeat(200); // ~1000 chars with spaces
  const out = extractActivityNotes([{ ActivityID: 1, Subject: `a\n\t  b   c ${long}` }], { maxTextLen: 50 });
  assert.equal(out[0].text.length, 50);
  assert.ok(!/\s{2,}/.test(out[0].text), "no runs of whitespace");
  assert.ok(out[0].text.startsWith("a b c"));
});

test("tolerates missing id/date/by (nulls, not crashes)", () => {
  const out = extractActivityNotes([{ Comment: "just a comment" }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].activityId, null);
  assert.equal(out[0].at, null);
  assert.equal(out[0].by, null);
  assert.equal(out[0].text, "just a comment");
});

test("falls back across alternate field names (ActivityId, ModifiedDate, CreatedBy, Description)", () => {
  const out = extractActivityNotes([
    { ActivityId: 77, ModifiedDate: "2026-05-09T12:00:00Z", CreatedBy: "sys", Description: "from alt fields" },
  ]);
  assert.equal(out[0].activityId, 77);
  assert.equal(out[0].at, "2026-05-09T12:00:00.000Z");
  assert.equal(out[0].by, "sys");
  assert.equal(out[0].text, "from alt fields");
});
