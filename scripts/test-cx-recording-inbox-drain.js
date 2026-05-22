"use strict";

// Manual exerciser for the CX recording inbox drain.
//
// Three modes:
//   1. `node scripts/test-cx-recording-inbox-drain.js`
//        Runs one drain tick against whatever's in the configured
//        inbox right now. Reports per-file outcome.
//
//   2. `node scripts/test-cx-recording-inbox-drain.js --simulate-uii <UII>`
//        Writes a tiny placeholder .wav into the inbox with a filename
//        that embeds the supplied telephonySessionId, then runs the
//        drain. Useful for testing the full lookup + Drive upload +
//        CallLog stamp path without involving RC. Pair with a UII
//        that exists in CallLog (e.g. from the CX Call Tracker).
//
//   3. `node scripts/test-cx-recording-inbox-drain.js --dry-run`
//        Lists what would be processed without uploading or moving.

require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const {
  runCxRecordingInboxDrainTick,
  getConfig,
  parseFilename,
} = require("../packages/shared-services/src/cxRecordingInboxDrainService");

function parseArgs(argv) {
  const args = { dryRun: false, simulateUii: null, sourceFile: null };
  for (let i = 0; i < argv.length; i += 1) {
    const v = argv[i];
    if (v === "--dry-run") args.dryRun = true;
    else if (v === "--simulate-uii") {
      args.simulateUii = String(argv[i + 1] || "").trim();
      i += 1;
    } else if (v === "--source") {
      args.sourceFile = String(argv[i + 1] || "").trim();
      i += 1;
    }
  }
  return args;
}

// Minimal valid WAV header (44 bytes) + a few ms of silence so the
// file looks like an audio file to anything that sniffs it. Drive
// doesn't validate the contents, but Whisper / playback might
// complain on a truly empty payload. ~1 second of silence at 8kHz
// mono 16-bit PCM.
function makePlaceholderWav() {
  const sampleRate = 8000;
  const seconds = 1;
  const numSamples = sampleRate * seconds;
  const byteRate = sampleRate * 2; // mono, 16-bit
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16); // subchunk1Size
  buf.writeUInt16LE(1, 20);  // PCM
  buf.writeUInt16LE(1, 22);  // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(2, 32);  // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  // remainder is zeros — silence
  return buf;
}

async function ensureDir(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
}

async function simulateDrop(inboxDir, uii, sourcePath) {
  if (!/^\d{30}$/.test(uii)) {
    throw new Error(`--simulate-uii must be exactly 30 digits, got "${uii}"`);
  }
  await ensureDir(inboxDir);
  // RC's actual filename convention varies; the parser only requires
  // a 30-digit UII somewhere in the name. Use a plausible format.
  const name = `rcx_${uii}_test-drop.wav`;
  const dest = path.join(inboxDir, name);
  if (sourcePath) {
    await fs.promises.copyFile(sourcePath, dest);
  } else {
    await fs.promises.writeFile(dest, makePlaceholderWav());
  }
  console.log(`Dropped ${dest} (${fs.statSync(dest).size} bytes)`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = getConfig();
  console.log("");
  console.log("CX Recording Inbox Drain — test exerciser");
  console.log(`  inbox    : ${cfg.inboxDir}`);
  console.log(`  processed: ${cfg.processedDir}`);
  console.log(`  unknown  : ${cfg.unknownDir}`);
  console.log(`  enabled  : ${cfg.enabled}`);
  console.log(`  dryRun   : ${args.dryRun}`);
  console.log("");

  if (args.simulateUii) {
    await simulateDrop(cfg.inboxDir, args.simulateUii, args.sourceFile);
  }

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(uri, { dbName });

  const summary = await runCxRecordingInboxDrainTick({
    logger: { info: (...a) => console.log("[info]", ...a), warn: (...a) => console.warn("[warn]", ...a) },
    dryRun: args.dryRun,
  });

  console.log("");
  console.log("Result summary:");
  console.log(JSON.stringify({
    ...summary,
    items: undefined,
  }, null, 2));
  console.log("");
  console.log(`Per-file (${summary.items.length} item${summary.items.length === 1 ? "" : "s"}):`);
  for (const item of summary.items) {
    console.log("  -", JSON.stringify(item));
  }

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
