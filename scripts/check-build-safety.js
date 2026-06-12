"use strict";

// Build tripwire: refuse to build if any source file carries a do-not-commit
// marker. Born 2026-06-12, when a local coach-preview harness with
// `LOCAL_DO_NOT_COMMIT_... = true` (fake lead force-seeded into every agent's
// workspace) sat in the tree hours before the nightly patch. The marker
// convention is now LOAD-BEARING: label local-only hacks "DO NOT COMMIT" and
// the build blocks them; prefer env-driven flags (VITE_*) which can't ship
// as code at all.
//
// Runs as part of build:web. Standalone: node scripts/check-build-safety.js

const fs = require("fs");
const path = require("path");

const MARKER = /DO[ _-]?NOT[ _-]?COMMIT/i;
const ROOTS = [
  "apps/web-client/src",
  "apps/control-plane/src",
  "apps/ai-bus/src",
  "packages",
];
const EXTENSIONS = new Set([".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set(["node_modules", "build", "dist", ".git"]);

const hits = [];

function scan(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) scan(path.join(dir, entry.name));
      continue;
    }
    if (!EXTENSIONS.has(path.extname(entry.name))) continue;
    const filePath = path.join(dir, entry.name);
    const lines = fs.readFileSync(filePath, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (MARKER.test(line)) hits.push(`${filePath}:${index + 1}  ${line.trim().slice(0, 120)}`);
    });
  }
}

for (const root of ROOTS) scan(path.resolve(__dirname, "..", root));

if (hits.length) {
  console.error("BUILD BLOCKED — do-not-commit markers found in source:\n");
  for (const hit of hits) console.error(`  ${hit}`);
  console.error("\nStrip the local-only code (or move the toggle to a VITE_* env flag) and rebuild.");
  process.exit(1);
}
console.log("build safety: no do-not-commit markers in source");
