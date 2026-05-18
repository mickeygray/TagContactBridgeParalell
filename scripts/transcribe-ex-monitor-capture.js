"use strict";

// One-shot transcription for RingEX monitor captures.
//
// The monitor capture script writes raw PCMU/G.711 u-law at 8000 Hz.
// This script decodes that to a PCM16 WAV file and sends it to OpenAI's
// audio transcription endpoint.
//
// Usage:
//   node scripts/transcribe-ex-monitor-capture.js --latest
//   node scripts/transcribe-ex-monitor-capture.js --file runtime/ex-monitor-captures/foo.pcmu

const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

function readFlag(argv, name, fallback = "") {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1) return argv[idx + 1];
  return fallback;
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function findLatestCapture(dir) {
  const files = fs.readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith(".pcmu"))
    .map((name) => {
      const fullPath = path.join(dir, name);
      const stat = fs.statSync(fullPath);
      return { fullPath, mtimeMs: stat.mtimeMs, size: stat.size };
    })
    .filter((entry) => entry.size > 0)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files[0]?.fullPath || "";
}

function ulawByteToPcm16(byte) {
  const value = (~byte) & 0xff;
  const sign = value & 0x80;
  const exponent = (value >> 4) & 0x07;
  const mantissa = value & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}

function buildPcm16WavFromPcmu(pcmuBuffer, sampleRate = 8000) {
  const dataSize = pcmuBuffer.length * 2;
  const wav = Buffer.alloc(44 + dataSize);

  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < pcmuBuffer.length; i += 1) {
    wav.writeInt16LE(ulawByteToPcm16(pcmuBuffer[i]), 44 + i * 2);
  }
  return wav;
}

async function transcribeWav({ wavPath, model, language }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is missing");

  const buffer = fs.readFileSync(wavPath);
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: "audio/wav" }), path.basename(wavPath));
  form.append("model", model);
  form.append("response_format", "json");
  if (language) form.append("language", language);
  form.append("temperature", "0");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) {
    throw new Error(`OpenAI transcription failed: ${response.status} ${text.slice(0, 500)}`);
  }
  return json || { text };
}

async function main() {
  const argv = process.argv.slice(2);
  const captureDir = path.resolve(readFlag(argv, "--dir", path.join("runtime", "ex-monitor-captures")));
  const explicitFile = readFlag(argv, "--file", "");
  const inputPath = explicitFile
    ? path.resolve(explicitFile)
    : hasFlag(argv, "--latest")
      ? findLatestCapture(captureDir)
      : "";
  const model = readFlag(
    argv,
    "--model",
    process.env.EX_MONITOR_STT_MODEL
      || process.env.SALES_TRAINER_STT_MODEL
      || process.env.WHISPER_MODEL
      || "gpt-4o-mini-transcribe",
  );
  const language = readFlag(argv, "--language", "en");

  if (!inputPath) throw new Error("Pass --file <capture.pcmu> or --latest");
  if (!fs.existsSync(inputPath)) throw new Error(`Capture file not found: ${inputPath}`);

  const pcmu = fs.readFileSync(inputPath);
  if (pcmu.length === 0) throw new Error(`Capture file is empty: ${inputPath}`);

  const wavPath = inputPath.replace(/\.pcmu$/i, ".wav");
  fs.writeFileSync(wavPath, buildPcm16WavFromPcmu(pcmu));

  const started = Date.now();
  const result = await transcribeWav({ wavPath, model, language });
  const elapsedMs = Date.now() - started;

  console.log(JSON.stringify({
    ok: true,
    model,
    inputPath,
    wavPath,
    inputBytes: pcmu.length,
    elapsedMs,
    text: String(result.text || "").trim(),
    raw: result,
  }, null, 2));
}

main().catch((error) => {
  console.error(`fatal: ${error.message}`);
  process.exit(1);
});
