"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { parseArgs } = require("../../scripts/cx-morning-prep");

const DAY = 24 * 60 * 60 * 1000;

test("defaults: dry run, queue off, ~4-day recency, concurrency 1", () => {
  const o = parseArgs([]);
  assert.equal(o.apply, false);
  assert.equal(o.queue, false);
  assert.equal(o.recentlyActiveWithinMs, 4 * DAY);
  assert.equal(o.concurrency, 1);
  assert.equal(o.maxAgents, null);
  assert.equal(o.email, null);
  assert.equal(o.companies, null);
});

test("--apply and --queue are boolean switches", () => {
  const o = parseArgs(["--apply", "--queue"]);
  assert.equal(o.apply, true);
  assert.equal(o.queue, true);
});

test("--all disables the recency filter (null window)", () => {
  assert.equal(parseArgs(["--all"]).recentlyActiveWithinMs, null);
});

test("--recent-days N converts to ms", () => {
  assert.equal(parseArgs(["--recent-days", "7"]).recentlyActiveWithinMs, 7 * DAY);
  assert.equal(parseArgs(["--recent-days=2"]).recentlyActiveWithinMs, 2 * DAY);
});

test("value flags accept both '--flag value' and '--flag=value'", () => {
  assert.equal(parseArgs(["--max", "5"]).maxAgents, 5);
  assert.equal(parseArgs(["--max=9"]).maxAgents, 9);
  assert.equal(parseArgs(["--concurrency", "3"]).concurrency, 3);
  assert.equal(parseArgs(["--concurrency=4"]).concurrency, 4);
});

test("--companies is split, trimmed, and upper-cased into an array", () => {
  assert.deepEqual(parseArgs(["--companies", "tag, wynn"]).companies, ["TAG", "WYNN"]);
  assert.deepEqual(parseArgs(["--companies=tag"]).companies, ["TAG"]);
});

test("--email is lower-cased and trimmed", () => {
  assert.equal(parseArgs(["--email", "  MGray@Example.com "]).email, "mgray@example.com");
});

test("-h / --help set the help flag", () => {
  assert.equal(parseArgs(["-h"]).help, true);
  assert.equal(parseArgs(["--help"]).help, true);
});

test("a consumed value is not mis-parsed as a flag", () => {
  // '--source' consumes 'cx-test'; '--apply' that follows must still register
  const o = parseArgs(["--source", "cx-test", "--apply"]);
  assert.equal(o.source, "cx-test");
  assert.equal(o.apply, true);
});
