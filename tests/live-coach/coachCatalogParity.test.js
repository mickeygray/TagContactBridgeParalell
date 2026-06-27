"use strict";

// The cockpit SCRIPT column overlays the live coach's per-beat status onto STATIC beats BY
// beatId (and binds the section spine by section id). The client keeps its own catalog copy
// (apps/web-client/src/lib/liveCoach/taxGroupSections.ts) because it can't import the server's
// CommonJS module across the Vite build boundary. If the two drift, the overlay silently fails
// (every beat shows "pending", no error). This guard fails the build instead.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { TAX_GROUP_SECTIONS, SCRIPT_SECTION_IDS } = require("../../packages/shared-services/src/taxGroupScript");

const CLIENT_PATH = path.join(__dirname, "../../apps/web-client/src/lib/liveCoach/taxGroupSections.ts");
const clientSrc = fs.readFileSync(CLIENT_PATH, "utf8");

// Section id = `id: "X"` immediately followed by `title:`. Beat id = `{ id: "X", point:`.
function extractClient(src) {
  const sectionIds = [];
  const sectionRe = /id:\s*"([^"]+)",\s*[\r\n]+\s*title:/g;
  const beatIds = [];
  const beatRe = /\{\s*id:\s*"([^"]+)",\s*point:/g;
  let m;
  while ((m = sectionRe.exec(src))) sectionIds.push(m[1]);
  while ((m = beatRe.exec(src))) beatIds.push(m[1]);
  return { sectionIds, beatIds };
}

test("client catalog section ids mirror the server SCRIPT_SECTION_IDS exactly", () => {
  const { sectionIds } = extractClient(clientSrc);
  assert.deepEqual(sectionIds, SCRIPT_SECTION_IDS, "client section ids must match the server (the spine binds by section id)");
});

test("client catalog beat ids mirror the server TAX_GROUP_SECTIONS beat ids exactly", () => {
  const { beatIds } = extractClient(clientSrc);
  const serverBeatIds = TAX_GROUP_SECTIONS.flatMap((s) => s.beats.map((b) => b.id));
  assert.deepEqual(beatIds, serverBeatIds, "drift here makes the cockpit SCRIPT status overlay silently fall back to 'pending'");
});
