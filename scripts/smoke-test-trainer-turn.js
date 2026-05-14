"use strict";

// Quick smoke test for POST /api/sales-trainer/turn.
//
// Usage:
//   node scripts/smoke-test-trainer-turn.js <audioPath> [--text "fallback text"] [--session SID]
//
// What it does:
//   1. Starts a fresh session via /session/start (or uses --session)
//   2. POSTs the audio file (or --text fallback) to /turn
//   3. Prints latency at each stage + saves the prospect's audio
//      reply to /tmp/prospect-reply.<format> so you can listen.
//
// Required env:
//   SALES_TRAINER_TRAINER_TOKEN — a valid trainer JWT (issue via
//     /api/sales-trainer/auth/verify-code or pull from the UI's
//     localStorage)
//   SALES_TRAINER_BASE_URL      — e.g. http://localhost:3001 (default)
//
// This script exists to prove the backend works end-to-end when the UI
// can't. If this succeeds and the UI doesn't, the failure is in the UI
// layer (mic capture, button binding, or fetch wiring) — not the API.

const fs = require("fs");
const path = require("path");
const os = require("os");

const BASE_URL = process.env.SALES_TRAINER_BASE_URL || "http://localhost:3001";
const TOKEN = process.env.SALES_TRAINER_TRAINER_TOKEN || "";

function fail(message, details = null) {
  console.error(`\n❌ ${message}`);
  if (details) console.error(details);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { audioPath: null, text: null, sessionId: null, mode: "inbound" };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--text") args.text = argv[++i];
    else if (arg === "--session") args.sessionId = argv[++i];
    else if (arg === "--mode") args.mode = argv[++i];
    else if (!args.audioPath) args.audioPath = arg;
  }
  return args;
}

async function startSession(mode) {
  const t = Date.now();
  const res = await fetch(`${BASE_URL}/api/sales-trainer/session/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ mode, difficulty: "easy", includeAudio: true }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) {
    fail(`/session/start failed: ${res.status}`, JSON.stringify(body, null, 2));
  }
  console.log(`  /session/start ............. ${Date.now() - t}ms`);
  return body.result;
}

async function postTurn({ audioPath, text, session, mode }) {
  const form = new FormData();
  const payload = {
    sessionId: session.sessionId,
    turnNumber: 1,
    profile: session.profile,
    messages: [],
    mode,
  };
  form.append("payload", JSON.stringify(payload));
  if (audioPath) {
    const buf = fs.readFileSync(audioPath);
    const mimeType = audioPath.endsWith(".webm")
      ? "audio/webm"
      : audioPath.endsWith(".m4a")
        ? "audio/mp4"
        : audioPath.endsWith(".wav")
          ? "audio/wav"
          : "audio/ogg";
    form.append("audio", new Blob([buf], { type: mimeType }), path.basename(audioPath));
  } else {
    form.append("textInput", text);
  }

  const t = Date.now();
  const res = await fetch(`${BASE_URL}/api/sales-trainer/turn`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: form,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) {
    fail(`/turn failed: ${res.status}`, JSON.stringify(body, null, 2));
  }
  console.log(`  /turn (server elapsed) ..... ${body.result.elapsedMs}ms`);
  console.log(`  /turn (wall clock) ......... ${Date.now() - t}ms`);
  return body.result;
}

async function main() {
  if (!TOKEN) fail("Set SALES_TRAINER_TRAINER_TOKEN in env");
  const args = parseArgs(process.argv);
  if (!args.audioPath && !args.text) {
    fail(
      "Pass an audio file path as the first arg, or --text 'hello'.\n" +
        "  node scripts/smoke-test-trainer-turn.js my-clip.webm\n" +
        "  node scripts/smoke-test-trainer-turn.js --text 'Hi, this is John from Tax Group'",
    );
  }

  console.log(`\nSmoke-testing ${BASE_URL}`);
  console.log("─".repeat(60));

  const session = await startSession(args.mode);
  console.log(`  caller profile: ${session.profile?.callerFirstName} ${session.profile?.callerLastName}, ${session.profile?.age}, ${session.profile?.mood}`);
  console.log(`  opening line:   "${session.profile?.openingLine}"`);
  if (session.openingPlayback?.audioBase64) {
    const openingPath = path.join(os.tmpdir(), `prospect-opening.${session.openingPlayback.format || "mp3"}`);
    fs.writeFileSync(openingPath, Buffer.from(session.openingPlayback.audioBase64, "base64"));
    console.log(`  opening audio:  saved to ${openingPath}`);
  }
  console.log("");

  const turn = await postTurn({ audioPath: args.audioPath, text: args.text, session, mode: args.mode });
  console.log("");
  console.log(`  transcript:     "${turn.transcript?.text || "(text fallback)"}"`);
  console.log(`  response:       "${(turn.response?.text || "").slice(0, 200)}${(turn.response?.text || "").length > 200 ? "..." : ""}"`);
  console.log(`  provider/model: ${turn.response?.provider} / ${turn.response?.model}`);
  if (turn.playback?.audioBase64) {
    const replyPath = path.join(os.tmpdir(), `prospect-reply.${turn.playback.format || "mp3"}`);
    fs.writeFileSync(replyPath, Buffer.from(turn.playback.audioBase64, "base64"));
    console.log(`  reply audio:    saved to ${replyPath}`);
  } else {
    console.log("  reply audio:    (none — TTS skipped or failed)");
  }

  console.log("\n✅ Backend round-trip succeeded. If the UI is silent, it's a client-side problem.\n");
}

main().catch((err) => {
  console.error("\n❌ Unhandled error:");
  console.error(err);
  process.exit(1);
});
