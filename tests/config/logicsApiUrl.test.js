"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { normalizeLogicsApiUrl } = require("../../packages/shared-config/src/companyConfig");

test("normalizeLogicsApiUrl rewrites legacy irslogics host to logiqsapi", () => {
  assert.equal(
    normalizeLogicsApiUrl("https://taxag.irslogics.com/publicapi/V4"),
    "https://taxag.logiqsapi.com/publicapi/V4/",
  );
});

test("normalizeLogicsApiUrl preserves existing logiqsapi host", () => {
  assert.equal(
    normalizeLogicsApiUrl("https://wynntax.logiqsapi.com/publicapi/V4/"),
    "https://wynntax.logiqsapi.com/publicapi/V4/",
  );
});
