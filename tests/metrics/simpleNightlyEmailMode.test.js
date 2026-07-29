"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  resolveNightlyEmailMode,
} = require("../../packages/shared-services/src/simpleNightlyEmailService");

test("nightly report mode is singular and conflicts fail closed", () => {
  assert.deepEqual(resolveNightlyEmailMode({ legacyEnabled: false, simpleEnabled: false }), {
    mode: "off",
    conflict: false,
  });
  assert.deepEqual(resolveNightlyEmailMode({ legacyEnabled: true, simpleEnabled: false }), {
    mode: "legacy",
    conflict: false,
  });
  assert.deepEqual(resolveNightlyEmailMode({ legacyEnabled: false, simpleEnabled: true }), {
    mode: "simple",
    conflict: false,
  });
  assert.deepEqual(resolveNightlyEmailMode({ legacyEnabled: true, simpleEnabled: true }), {
    mode: "off",
    conflict: true,
  });
  assert.deepEqual(resolveNightlyEmailMode({
    legacyEnabled: true,
    simpleEnabled: true,
    explicitlyDisabled: true,
  }), {
    mode: "off",
    conflict: false,
  });
});

test("runtime sends only the selected mode and simple uses the grouped report date", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../../apps/control-plane/src/services/nightlyCloseRuntime.js"),
    "utf8",
  );
  assert.match(source, /sendEmail: emailMode\.mode === "legacy"/);
  assert.match(source, /if \(emailMode\.mode === "simple"\)/);
  assert.match(source, /dateKey: groupedResult\.date/);
  const simpleBlock = source.slice(
    source.indexOf("// Exactly one report mode may send"),
    source.indexOf("state.lastCompletedAt"),
  );
  assert.doesNotMatch(simpleBlock, /Intl\.DateTimeFormat|new Date\(/);
});