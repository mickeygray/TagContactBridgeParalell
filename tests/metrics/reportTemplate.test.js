"use strict";

// Report mail renders through the app's HBS template so it reads as part of
// the same family as every other email the system sends. Handlebars is
// deliberately dumb: every formatting decision is made in toTemplateData, so
// the rules live in ONE language rather than split across JS and template.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");

const { toTemplateData } = require("../../packages/shared-services/src/reportComposerService");

const block = (id, label, columns, rows, terms) => ({
  id, label, block: { terms, csv: () => ({ rows, columns }) },
});

test("numeric cells are marked so the template can align them", () => {
  const d = toTemplateData({
    from: "2026-07-28", to: "2026-07-28", domain: "ALL", notes: [], filters: [],
    sections: [block("m", "Money in",
      [{ header: "source", get: (r) => r.source }, { header: "cash", get: (r) => r.cash }],
      [{ source: "mail", cash: 1234.5 }], "money received")],
  });
  const [s] = d.sections;
  assert.equal(s.columns[0].numeric, false, "a source name is not a number");
  assert.equal(s.columns[1].numeric, true);
  assert.equal(s.rows[0][1].text, "$1,234.50", "a money column is formatted as money");
  assert.equal(s.rows[0][1].numeric, true);
});

test("negatives are flagged so a loss reads as a loss", () => {
  const d = toTemplateData({
    from: "a", to: "a", domain: "ALL", notes: [], filters: [],
    sections: [block("n", "Net", [{ header: "net", get: (r) => r.net }], [{ net: -630 }])],
  });
  assert.equal(d.sections[0].rows[0][0].negative, true);
  assert.equal(d.sections[0].rows[0][0].text, "$-630.00");
});

test("absent is an em dash and muted — never a zero", () => {
  const d = toTemplateData({
    from: "a", to: "a", domain: "ALL", notes: [], filters: [],
    sections: [block("x", "X", [{ header: "roi", get: (r) => r.roi }], [{ roi: null }])],
  });
  const cell = d.sections[0].rows[0][0];
  assert.equal(cell.text, "—");
  assert.equal(cell.muted, true);
  assert.ok(!("negative" in cell) || cell.negative !== true);
});

test("a recording URL becomes a link, not a wall of text", () => {
  const d = toTemplateData({
    from: "a", to: "a", domain: "ALL", notes: [], filters: [],
    sections: [block("r", "Calls", [{ header: "listen", get: (r) => r.url }],
      [{ url: "https://app.callrail.com/calls/X/recording" }])],
  });
  assert.equal(d.sections[0].rows[0][0].link, "https://app.callrail.com/calls/X/recording");
  const plain = toTemplateData({
    from: "a", to: "a", domain: "ALL", notes: [], filters: [],
    sections: [block("r", "Calls", [{ header: "name", get: (r) => r.name }], [{ name: "not a url" }])],
  });
  assert.equal(plain.sections[0].rows[0][0].text, "not a url");
});

test("terms travel into the template", () => {
  const d = toTemplateData({
    from: "a", to: "a", domain: "ALL", notes: [], filters: [],
    sections: [block("s", "By source", [{ header: "x", get: () => 1 }], [{}], "ROAS = initial / spend")],
  });
  assert.equal(d.sections[0].terms, "ROAS = initial / spend");
});

test("a block that cannot tabulate degrades to a message, not a crash", () => {
  const d = toTemplateData({
    from: "a", to: "a", domain: "ALL", notes: [], filters: [],
    sections: [{ id: "b", label: "Broken", block: { csv: () => { throw new Error("nope"); } } }],
  });
  assert.match(d.sections[0].error, /could not be tabulated/);
  assert.deepEqual(d.sections[0].rows, []);
});

test("an applied filter is surfaced in the notes", () => {
  const d = toTemplateData({
    from: "a", to: "a", domain: "ALL", notes: ["something"], sections: [],
    filters: [{ key: "officer", op: "=", value: "Bruce" }],
  });
  assert.equal(d.notes[0], "filtered: officer=Bruce");
});

test("the template file exists and leaves no unrendered tags", () => {
  const tpl = fs.readFileSync(
    require.resolve("../../packages/shared-templates/src/templates/reports/report.hbs"), "utf8",
  );
  assert.ok(tpl.includes("{{#each sections}}"), "sections must be iterated");
  assert.ok(tpl.includes("{{#if this.terms}}"), "terms must be rendered");
  // Every opened block helper must be closed.
  for (const [open, close] of [["{{#each", "{{/each}}"], ["{{#if", "{{/if}}"]]) {
    const opens = (tpl.match(new RegExp(open.replace(/[{#]/g, "\$&"), "g")) || []).length;
    const closes = (tpl.match(new RegExp(close.replace(/[{/}]/g, "\$&"), "g")) || []).length;
    assert.equal(opens, closes, `${open} / ${close} are unbalanced`);
  }
});
