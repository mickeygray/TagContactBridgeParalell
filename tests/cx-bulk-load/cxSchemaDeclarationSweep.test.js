"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// THE SCHEMA-DECLARATION SWEEP (2026-07-08, generalizing the dead-replay-guard lesson):
// mongoose strict mode SILENTLY strips undeclared paths from their own $set — the write
// "succeeds" and stores nothing. That killed the June replay guard for three weeks.
// This pin reads the SOURCE of every LeadCadence-writing service, collects every quoted
// dotted path under LeadCadence's known roots, and asserts each one is either declared
// in the schema or sits under a Mixed ancestor. A new write to an undeclared path fails
// THIS test instead of silently no-oping in production.

const { LeadCadence } = require("../../packages/shared-models/src");

const SOURCES = [
  "../../packages/shared-services/src/cxCadenceService.js",
  "../../packages/shared-repositories/src/leadCadenceRepository.js",
  "../../packages/shared-services/src/cxAppointmentService.js",
  "../../packages/shared-services/src/inboundIntakeService.js",
];

// dotted-path roots that live on LeadCadence (CxDialQueue's metadata.* is Mixed-by-design
// and audited elsewhere)
const LEAD_CADENCE_ROOTS = [
  "counterCadence.",
  "cadenceState.",
  "payloadSnapshot.",
  "cadenceCounters.",
  "lastTouched.",
  "dncCheckpoints.",
  "metricsLdSpend.",
];

function ancestorIsMixed(schema, dottedPath) {
  const parts = dottedPath.split(".");
  for (let i = parts.length - 1; i >= 1; i -= 1) {
    const ancestor = parts.slice(0, i).join(".");
    const p = schema.path(ancestor);
    if (p && p.instance === "Mixed") return true;
  }
  return false;
}

test("SCHEMA SWEEP: every dotted LeadCadence path written anywhere is declared or under a Mixed parent", () => {
  const seen = new Set();
  for (const rel of SOURCES) {
    const src = fs.readFileSync(path.join(__dirname, rel), "utf-8");
    for (const root of LEAD_CADENCE_ROOTS) {
      const re = new RegExp('"(' + root.split(".").join("\.") + '[A-Za-z0-9_.]+)"', "g");
      for (let m; (m = re.exec(src)); ) seen.add(m[1]);
    }
  }
  assert.ok(seen.size > 5, "the sweep still finds dotted LeadCadence writes");

  const schema = LeadCadence.schema;
  const stripped = [];
  for (const dotted of seen) {
    const declared = Boolean(schema.path(dotted));
    if (!declared && !ancestorIsMixed(schema, dotted)) stripped.push(dotted);
  }
  assert.deepEqual(
    stripped.sort(),
    [],
    "these dotted LeadCadence writes would be SILENTLY STRIPPED by strict mode: " + stripped.join(", "),
  );
});
