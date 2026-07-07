"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// THE WIRE AUDIT (2026-07-07): twice now a live route has crashed on a ReferenceError
// because server.js CALLED a shared-services helper it never imported (June:
// summarizeRingcxLoginPayload; July: createCxAppointment — Mickey's first wrap-card
// appointment click 500'd mid-protocol). node --check can't catch it and unit tests
// inject fakes past it. This pin reads server.js as TEXT and asserts every Cx-flavored
// helper it calls is either defined in-file or named on an import-destructure line.

test("WIRE AUDIT: every Cx helper server.js calls is imported or defined in-file", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "../../apps/control-plane/src/server.js"),
    "utf-8",
  );
  const callPattern = /\b((?:create|build|request|enqueue|write|handle|run)Cx[A-Z]\w*)\s*\(/g;
  const called = new Set();
  for (let m; (m = callPattern.exec(src)); ) called.add(m[1]);
  assert.ok(called.size > 5, "the pattern still matches server.js's style");

  const lines = src.split(String.fromCharCode(10)).map((l) => l.trim());
  const missing = [];
  for (const name of called) {
    const ok = lines.some(
      (t) =>
        t === name + "," ||                         // multi-line destructure entry
        t.startsWith(name + ",") ||
        (t.startsWith("const {") && (                // single-line destructure require
          t.includes("{ " + name + " }") ||
          t.includes("{ " + name + ",") ||
          t.includes(", " + name + " }") ||
          t.includes(", " + name + ",")
        )) ||
        t.startsWith("function " + name + "(") ||   // defined in-file
        t.startsWith("async function " + name + "(") ||
        t.startsWith("const " + name + " ="),
    );
    if (!ok) missing.push(name);
  }
  assert.deepEqual(missing, [], "server.js calls these without importing/defining them: " + missing.join(", "));
});
