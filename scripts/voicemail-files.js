#!/usr/bin/env node
"use strict";

// Canonical home + pipeline for per-agent voicemail-drop recordings.
//
// LAYOUT (under repo runtime/audio/voicemails/):
//   source/<slug>.wav    <- the original recorded WAV you hand me (kept for re-convert)
//   <extensionNumber>.raw <- the telephony file the resolver actually plays
//                            (PCMU/8000 mu-law, peak-normalized). voicemailServingService
//                            looks here by extensionNumber, falling back to drop-message.raw.
//   manifest.json         <- agent -> {ext, monitor, sourceWav, rawFile, hasRaw}
//
// USAGE:
//   node scripts/voicemail-files.js map                         # build dirs + manifest, show status
//   node scripts/voicemail-files.js import <extOrEmail> <wav>   # convert+place one agent's recording
//
// import does the same hot-but-clean normalization we landed on for the test drop:
// peak-normalize to ~-1 dBFS (no compression/limiter), 8 kHz mono mu-law.

const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
const mongoose = require("mongoose");

const REPO = path.resolve(__dirname, "..");
const VM_DIR = path.join(REPO, "runtime", "audio", "voicemails");
const SRC_DIR = path.join(VM_DIR, "source");
const MANIFEST = path.join(VM_DIR, "manifest.json");
const FALLBACK = path.join(REPO, "runtime", "audio", "drop-message.raw");
// ONE shared voicemail for everyone (current design). This is what the resolver
// (voicemailServingService DEFAULT_SHARED) plays for every agent.
const SHARED_RAW = path.join(REPO, "runtime", "audio", "voicemail-shared.raw");
const SHARED_SRC = path.join(SRC_DIR, "voicemail-shared.wav");
const FFMPEG = path.join(REPO, "node_modules", "ffmpeg-static", "ffmpeg.exe");

// Peak-normalize a wav to -1 dBFS (clean, no compression) and convert to PCMU/8000
// mu-law at destRaw. Returns { bytes, gainDb, maxDb }.
function convertToRaw(wavPath, destRaw) {
  if (!fs.existsSync(FFMPEG)) throw new Error(`ffmpeg-static not found at ${FFMPEG}`);
  const det = execFileSync(FFMPEG, ["-i", wavPath, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const m = /max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/.exec(det);
  const maxDb = m ? Number(m[1]) : -3;
  const gainDb = Math.max(0, -1 - maxDb).toFixed(1);
  execFileSync(FFMPEG, ["-y", "-i", wavPath, "-af", `volume=${gainDb}dB`, "-ar", "8000", "-ac", "1", "-f", "mulaw", destRaw], { stdio: ["ignore", "ignore", "pipe"] });
  return { bytes: fs.statSync(destRaw).size, gainDb, maxDb };
}

// Import the single shared voicemail (one for everyone).
function importShared(wavPath) {
  if (!wavPath) throw new Error("usage: shared <wavPath>");
  if (!fs.existsSync(wavPath)) throw new Error(`source wav not found: ${wavPath}`);
  ensureDirs();
  fs.copyFileSync(wavPath, SHARED_SRC);
  const r = convertToRaw(wavPath, SHARED_RAW);
  console.log(`shared voicemail imported -> ${path.relative(REPO, SHARED_RAW)}`);
  console.log(`  ${r.bytes} bytes (~${(r.bytes / 8000).toFixed(1)}s, +${r.gainDb}dB from peak ${r.maxDb}dB); source kept at source/voicemail-shared.wav`);
  console.log("  every agent now plays this; no restart needed (resolved per drop).");
}

function ensureDirs() {
  fs.mkdirSync(SRC_DIR, { recursive: true });
}
function slug(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

async function loadAgents() {
  await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel" });
  const col = mongoose.connection.db.collection("useraccounts");
  // Agents who have a barge monitor configured = agents who can do voicemail drops.
  const docs = await col.find(
    { "metadata.barge.monitorExtension": { $exists: true, $ne: null } },
    { projection: { name: 1, email: 1, extensionNumber: 1, "metadata.barge": 1 } },
  ).toArray();
  await mongoose.disconnect();
  return docs.sort((a, b) => Number(a.extensionNumber) - Number(b.extensionNumber));
}

function agentToEntry(a) {
  const ext = String(a.extensionNumber || "").trim();
  const sourceWav = `${slug(a.name) || slug((a.email || "").split("@")[0])}.wav`;
  const rawFile = `${ext}.raw`;
  return {
    name: a.name || null,
    email: a.email || null,
    extensionNumber: ext,
    monitorExtension: a.metadata?.barge?.monitorExtension || null,
    sourceWav,                         // expected in source/
    rawFile,                           // what the resolver plays
    rawPath: path.join("runtime", "audio", "voicemails", rawFile),
    hasRaw: fs.existsSync(path.join(VM_DIR, rawFile)),
  };
}

async function map() {
  ensureDirs();
  const agents = await loadAgents();
  const entries = agents.map(agentToEntry);
  const manifest = {
    layout: {
      dir: "runtime/audio/voicemails",
      source: "runtime/audio/voicemails/source",
      rawNaming: "<extensionNumber>.raw (PCMU/8000 mu-law)",
      fallback: "runtime/audio/drop-message.raw",
    },
    agents: entries,
  };
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
  console.log(`voicemails dir: ${VM_DIR}`);
  console.log(`manifest:       ${MANIFEST}\n`);

  // ONE voicemail for everyone: the shared file is the primary. Per-agent files are
  // an optional override that normally won't exist.
  const sharedHave = fs.existsSync(SHARED_RAW);
  const legacyHave = fs.existsSync(FALLBACK);
  console.log(`SHARED voicemail (everyone): ${sharedHave ? "[have] " + path.relative(REPO, SHARED_RAW) : "[MISS] " + path.relative(REPO, SHARED_RAW)}`);
  if (!sharedHave) console.log(`  -> until recorded, everyone plays the legacy clip ${legacyHave ? "" : "(MISSING!) "}${path.relative(REPO, FALLBACK)}`);
  console.log(`  import it with:  node scripts/voicemail-files.js shared <recording.wav>\n`);

  console.log("per-agent overrides (optional; normally none):");
  for (const e of entries) {
    console.log(`  ${e.hasRaw ? "[have]" : "[none]"} ${e.name} ext=${e.extensionNumber} mon=${e.monitorExtension}  override=${e.rawFile}`);
  }
}

async function importWav(extOrEmail, wavPath) {
  if (!extOrEmail || !wavPath) throw new Error("usage: import <extOrEmail> <wavPath>");
  if (!fs.existsSync(wavPath)) throw new Error(`source wav not found: ${wavPath}`);
  if (!fs.existsSync(FFMPEG)) throw new Error(`ffmpeg-static not found at ${FFMPEG}`);
  ensureDirs();
  const agents = await loadAgents();
  const key = String(extOrEmail).trim().toLowerCase();
  const agent = agents.find((a) => String(a.extensionNumber) === extOrEmail || String(a.email).toLowerCase() === key);
  if (!agent) throw new Error(`no monitor-configured agent matches "${extOrEmail}"`);
  const entry = agentToEntry(agent);

  // Keep the original.
  const srcDest = path.join(SRC_DIR, entry.sourceWav);
  fs.copyFileSync(wavPath, srcDest);

  // Measure peak, then apply exact gain to -1 dBFS (clean, no compression), 8k mono mu-law.
  const det = execFileSync(FFMPEG, ["-i", wavPath, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const m = /max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/.exec(det);
  const maxDb = m ? Number(m[1]) : -3;
  const gainDb = Math.max(0, (-1 - maxDb)).toFixed(1); // never attenuate; lift peak to -1 dBFS
  const rawDest = path.join(VM_DIR, entry.rawFile);
  execFileSync(FFMPEG, ["-y", "-i", wavPath, "-af", `volume=${gainDb}dB`, "-ar", "8000", "-ac", "1", "-f", "mulaw", rawDest], { stdio: ["ignore", "ignore", "pipe"] });

  const bytes = fs.statSync(rawDest).size;
  console.log(`imported ${agent.name} (ext ${entry.extensionNumber}):`);
  console.log(`  source kept: source/${entry.sourceWav}`);
  console.log(`  raw written: ${entry.rawFile}  (${bytes} bytes, ~${(bytes / 8000).toFixed(1)}s, +${gainDb}dB from peak ${maxDb}dB)`);
  await map();
}

(async () => {
  const cmd = (process.argv[2] || "map").trim();
  if (cmd === "map") await map();
  else if (cmd === "shared") importShared(process.argv[3]);          // the one-for-everyone recording
  else if (cmd === "import") await importWav(process.argv[3], process.argv[4]); // optional per-agent override
  else console.log("usage: voicemail-files.js map | shared <wavPath> | import <extOrEmail> <wavPath>");
})().catch((e) => { console.error("failed:", e.message); process.exit(1); });
