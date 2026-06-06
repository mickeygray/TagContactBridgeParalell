#!/usr/bin/env node
"use strict";

// Offline smoke for the voicemail-drop serving resolver. No DB, no fs.
//   node scripts/voicemail-serving.smoke.js

const path = require("path");
const { resolveAgentVoicemailPlan } = require("../packages/shared-services/src/voicemailServingService");

const AUDIO_DIR = "/audio/voicemails";
const FALLBACK = "/audio/drop-message.raw";

// Fake roster keyed like Mongo $or matching (id/number/cxAgentId/email).
const AGENTS = [
  { name: "Phil Olson", email: "polson@taxadvocategroup.com", extensionId: "63704036004", extensionNumber: "319", cxAgentId: "20844", metadata: { barge: { monitorExtension: "987" } } },
  { name: "Sean Lucas", email: "slucas@taxadvocategroup.com", extensionId: "63756126004", extensionNumber: "445", cxAgentId: "20845", metadata: { barge: { monitorExtension: "1101", voicemail: "sean-custom.raw" } } },
  { name: "No Monitor", email: "nomon@taxadvocategroup.com", extensionId: "999", extensionNumber: "200", cxAgentId: "30000", metadata: {} },
];

function findAgent(id) {
  const v = String(id).trim().toLowerCase();
  return (
    AGENTS.find(
      (a) =>
        String(a.extensionId) === id ||
        String(a.extensionNumber) === id ||
        String(a.cxAgentId) === id ||
        String(a.email).toLowerCase() === v,
    ) || null
  );
}

// Pretend these files exist on disk.
const EXISTING = new Set([
  path.join(AUDIO_DIR, "319.raw"), // Phil by convention
  path.join(AUDIO_DIR, "sean-custom.raw"), // Sean by explicit override
  FALLBACK,
]);
const fileExists = (p) => EXISTING.has(p);

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass += 1; console.log(`ok   ${label}`); }
  else { fail += 1; console.log(`FAIL ${label}${detail ? `  -- ${detail}` : ""}`); }
}

const SHARED = "/audio/voicemails/voicemail-shared.raw";

(async () => {
  const opts = { findAgent, audioDir: AUDIO_DIR, sharedPath: SHARED, fallbackPath: FALLBACK, fileExists };

  // 1) Resolve by INTERNAL extensionId (what the frontend actually sends) -> dialable number.
  const phil = await resolveAgentVoicemailPlan("63704036004", opts);
  check("phil ok", phil.ok, JSON.stringify(phil.problems));
  check("phil target is NUMBER 319 (not the id)", phil.targetExtensionNumber === "319", phil.targetExtensionNumber);
  check("phil monitor 987", phil.monitorExtension === "987", phil.monitorExtension);
  check("phil voicemail by convention", phil.voicemailPath === path.join(AUDIO_DIR, "319.raw"), phil.voicemailPath);
  check("phil not shared (has per-agent file)", phil.usingSharedVoicemail === false);

  // 2) Resolve by extensionNumber, explicit voicemail override.
  const sean = await resolveAgentVoicemailPlan("445", opts);
  check("sean ok", sean.ok);
  check("sean explicit override file", sean.voicemailPath === path.join(AUDIO_DIR, "sean-custom.raw"), sean.voicemailPath);
  check("sean monitor 1101", sean.monitorExtension === "1101");

  // 3) Resolve by email.
  const byEmail = await resolveAgentVoicemailPlan("POLSON@taxadvocategroup.com", opts);
  check("email resolves to phil", byEmail.targetExtensionNumber === "319");

  // 4) No per-agent file, no shared recorded yet -> legacy fallback clip, flagged not-set.
  const nomon = await resolveAgentVoicemailPlan("200", opts);
  check("nomon falls to legacy clip", nomon.voicemailPath === FALLBACK, nomon.voicemailPath);
  check("nomon usingShared=true", nomon.usingSharedVoicemail === true);
  check("nomon usingLegacyFallback=true", nomon.usingLegacyFallback === true);
  check("nomon flags shared-recording-not-set", nomon.problems.includes("shared-recording-not-set"));
  check("nomon flags missing-monitor", nomon.problems.includes("missing-monitorExtension"));
  check("nomon ok=true (has target+playable)", nomon.ok === true);

  // 4b) Shared recording present -> everyone-without-a-file uses it, NOT flagged a problem.
  const withShared = await resolveAgentVoicemailPlan("200", {
    ...opts,
    fileExists: (p) => p === SHARED || EXISTING.has(p),
  });
  check("withShared uses shared file", withShared.voicemailPath === SHARED, withShared.voicemailPath);
  check("withShared usingShared=true", withShared.usingSharedVoicemail === true);
  check("withShared NOT legacy fallback", withShared.usingLegacyFallback === false);
  check("withShared no shared-not-set problem", !withShared.problems.includes("shared-recording-not-set"));

  // 5) Unknown agent.
  const missing = await resolveAgentVoicemailPlan("does-not-exist", opts);
  check("unknown agent not ok", missing.ok === false && missing.reason === "agent-not-found");

  // 6) Empty identifier.
  const empty = await resolveAgentVoicemailPlan("", opts);
  check("empty identifier not ok", empty.ok === false && empty.reason === "no-identifier");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
