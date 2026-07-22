"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  runCxActiveCallOwnersOnce,
} = require("../../apps/control-plane/src/server");

// THE WIRE AUDIT (2026-07-07): twice now a live route has crashed on a ReferenceError
// because server.js CALLED a shared-services helper it never imported (June:
// summarizeRingcxLoginPayload; July: createCxAppointment — Mickey's first wrap-card
// appointment click 500'd mid-protocol). node --check can't catch it and unit tests
// inject fakes past it. This pin reads server.js as TEXT and asserts every Cx-flavored
// helper it calls is either defined in-file or named on an import-destructure line.

const AUDITED_SERVERS = [
  "../../apps/control-plane/src/server.js",
  "../../apps/ringcentral-cx/src/server.js", // the class's ORIGINAL victim (June)
  "../../apps/inbound-gateway/src/server.js",
  "../../apps/outbound-gateway/src/server.js",
];

for (const serverPath of AUDITED_SERVERS) {
test(`WIRE AUDIT: every Cx helper ${serverPath.split("/").slice(-3).join("/")} calls is imported or defined in-file`, () => {
  const src = fs.readFileSync(
    path.join(__dirname, serverPath),
    "utf-8",
  );
  const callPattern = /\b((?:create|build|request|enqueue|write|handle|run)Cx[A-Z]\w*)\s*\(/g;
  const called = new Set();
  for (let m; (m = callPattern.exec(src)); ) called.add(m[1]);
  // The control plane must match plenty (pattern-drift canary); the gateways may
  // legitimately have zero Cx-verb calls — a zero-match file audits vacuously clean.
  if (serverPath.includes("control-plane")) {
    assert.ok(called.size > 5, "the pattern still matches the control plane's style");
  }

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
  assert.deepEqual(missing, [], serverPath + " calls these without importing/defining them: " + missing.join(", "));
});
}

test("boring mode invokes only the replacement active-call owner", async () => {
  const calls = [];
  const result = await runCxActiveCallOwnersOnce({
    boringEnabled: true,
    input: { sessionId: "session-1" },
    legacyWatcher: async (input) => {
      calls.push(["legacy", input]);
      return { summary: { sessionCount: 0 }, applied: {} };
    },
    boringWatcher: async (input) => {
      calls.push(["boring", input]);
      return { summary: { sessionCount: 1, refreshedCount: 1 } };
    },
  });

  assert.deepEqual(calls, [["boring", { sessionId: "session-1" }]]);
  assert.equal(result.summary.sessionCount, 0);
  assert.equal(result.boring.summary.refreshedCount, 1);
});

test("legacy mode invokes only the retired active-call owner", async () => {
  const calls = [];
  const result = await runCxActiveCallOwnersOnce({
    boringEnabled: false,
    input: { sessionId: "session-1" },
    legacyWatcher: async (input) => {
      calls.push(["legacy", input]);
      return { summary: { sessionCount: 1 }, applied: {} };
    },
    boringWatcher: async (input) => {
      calls.push(["boring", input]);
      return { summary: { sessionCount: 0 } };
    },
  });

  assert.deepEqual(calls, [["legacy", { sessionId: "session-1" }]]);
  assert.equal(result.summary.sessionCount, 1);
  assert.equal(result.boring, null);
});

test("caller-ID rotation is owned by Boring and single-owner by interval", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "../../apps/control-plane/src/server.js"),
    "utf-8",
  );
  assert.match(src, /boringWebhookProcessingEnabled\s*&&\s*callerIdRotationEnabled/);
  assert.match(src, /CX_BORING_CALLER_ID_DIAL_GROUP_IDS\s*\|\|\s*"1011,1067,1068"/);
  assert.match(src, /acquireRunLock\(\s*"cx-boring-caller-id-rotation"/);
  assert.match(src, /CX_CALLER_ID_ROTATION_ARM\s*\|\|\s*"false"/);
});
