"use strict";

// PhoneBurner-era transmission + bifurcation test for the RingEX headless monitor.
//
// Test topology (the "list of me's" test):
//   - The agent leg is YOUR RingCentral line dialed into a PhoneBurner dial session
//     (PhoneBurner then dials your own numbers as the "prospects").
//   - The monitor is one of the OLD VOICEMAIL extensions (free now that voicemail
//     drops are native PhoneBurner) registered as a headless supervisor softphone.
//
// Questions this answers, with machine verdicts (no listen-by-ear):
//   TRANSMISSION  - does EX supervision of your line actually carry the PhoneBurner
//                   call audio? (packets flow AND speech-band energy present)
//   BIFURCATION   - does per-party supervise (/parties/{id}/supervise) deliver
//                   DIFFERENT audio per leg, or the same mixed stream twice?
//
// Modes:
//   DUAL (two supervisor extensions/devices; the conclusive test)
//     node scripts/rc-ex-pb-leg-test.js --agent-ext 101 --sup-ext-a 3201 --sup-ext-b 3202 --timeout-sec 90
//       leg A = party "agent"  supervise on sup-ext-a's device
//       leg B = party "remote" supervise on sup-ext-b's device
//     Verdict compares the two captures: near-identical energy envelopes => MIXED
//     (party supervise is in name only); decorrelated envelopes with speech on
//     both => SPLIT (real per-leg audio - the gen-3 unlock).
//
//   SINGLE (one supervisor extension; transmission + best-effort party probe)
//     node scripts/rc-ex-pb-leg-test.js --agent-ext 101 --sup-ext-a 3201 --party remote --timeout-sec 90
//     While it runs, talk ONLY on your dialed-in line for the first half of the
//     call, then ONLY on the prospect cell for the second half. The energy
//     timeline printed at the end shows which halves carried audio - if the
//     first half (agent-only speech) is loud on a party=remote capture, the
//     stream is mixed.
//
//   SELF-TEST (no telephony; verifies the analyzer's verdict logic)
//     node scripts/rc-ex-pb-leg-test.js --self-test
//
// This wrapper spawns the PROVEN capture script (rc-ex-softphone-monitor-capture.js)
// per leg - attach/auth/SIP behavior is byte-identical to what already worked.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const CAPTURE_SCRIPT = path.resolve(__dirname, "rc-ex-softphone-monitor-capture.js");

// Per-agent monitor JWTs live in .env as <NAME>_RING_CENTRAL_MONITOR_JWT_TOKEN.
// The prefixed CLIENT_ID/SECRET pairs point at a dead app - the JWTs are valid
// for the CURRENT app, so pair each monitor JWT with the current client creds.
// This makes the supervise API caller BE the monitor user that owns the
// supervisor device (fixes TAS-120 "Can't find registered deviceId").
function monitorEnvFor(prefix) {
  if (!prefix) return {};
  const jwt = process.env[`${String(prefix).toUpperCase()}_RING_CENTRAL_MONITOR_JWT_TOKEN`];
  if (!jwt) throw new Error(`no ${String(prefix).toUpperCase()}_RING_CENTRAL_MONITOR_JWT_TOKEN in .env`);
  return {
    RING_CENTRAL_MONITOR_JWT_TOKEN: jwt,
    RING_CENTRAL_MONITOR_CLIENT_ID: process.env.RING_CENTRAL_CLIENT_ID,
    RING_CENTRAL_MONITOR_CLIENT_SECRET: process.env.RING_CENTRAL_CLIENT_SECRET,
  };
}

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

function timestampForDir() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// ── u-law codec (decode mirrors the capture script; encode is for --self-test) ──

function ulawToLinearSample(value) {
  let sample = (~value) & 0xff;
  const sign = sample & 0x80;
  const exponent = (sample >> 4) & 0x07;
  const mantissa = sample & 0x0f;
  sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}

function linearToUlawSample(sample) {
  const BIAS = 0x84;
  const CLIP = 32635;
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent -= 1, mask >>= 1);
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

// ── energy analysis ──────────────────────────────────────────────────────────

const SAMPLE_RATE = 8000;
const ACTIVE_MEAN_ABS = 300; // speech-band threshold on mean |sample| per second

// .pcmu bytes -> per-second mean-abs energy envelope.
function energyEnvelope(pcmuBuffer) {
  const seconds = Math.floor(pcmuBuffer.length / SAMPLE_RATE);
  const envelope = [];
  for (let s = 0; s < seconds; s += 1) {
    let totalAbs = 0;
    const base = s * SAMPLE_RATE;
    for (let i = 0; i < SAMPLE_RATE; i += 1) {
      totalAbs += Math.abs(ulawToLinearSample(pcmuBuffer[base + i]));
    }
    envelope.push(Math.round(totalAbs / SAMPLE_RATE));
  }
  return envelope;
}

function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  let sumA = 0; let sumB = 0;
  for (let i = 0; i < n; i += 1) { sumA += a[i]; sumB += b[i]; }
  const meanA = sumA / n;
  const meanB = sumB / n;
  let cov = 0; let varA = 0; let varB = 0;
  for (let i = 0; i < n; i += 1) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA === 0 || varB === 0) return null;
  return cov / Math.sqrt(varA * varB);
}

function activeSeconds(envelope) {
  return envelope.filter((value) => value >= ACTIVE_MEAN_ABS).length;
}

// Fraction of "someone is talking" seconds where exactly ONE stream is active.
// Mixed streams re-hear each other, so exclusivity stays near 0; split legs
// during alternating speech push it up.
function exclusiveActiveFraction(a, b) {
  const n = Math.min(a.length, b.length);
  let anyActive = 0;
  let exclusive = 0;
  for (let i = 0; i < n; i += 1) {
    const aOn = a[i] >= ACTIVE_MEAN_ABS;
    const bOn = b[i] >= ACTIVE_MEAN_ABS;
    if (aOn || bOn) {
      anyActive += 1;
      if (aOn !== bOn) exclusive += 1;
    }
  }
  return anyActive ? exclusive / anyActive : null;
}

function envelopeBar(envelope, bucketSec = 5) {
  const glyphs = " .:-=+*#";
  const out = [];
  for (let i = 0; i < envelope.length; i += bucketSec) {
    const bucket = envelope.slice(i, i + bucketSec);
    const mean = bucket.reduce((sum, v) => sum + v, 0) / bucket.length;
    const level = Math.min(glyphs.length - 1, Math.floor((mean / 2000) * (glyphs.length - 1)));
    out.push(glyphs[level]);
  }
  return out.join("");
}

function verdictTransmission(pcmuBuffer) {
  const envelope = energyEnvelope(pcmuBuffer);
  const active = activeSeconds(envelope);
  const pass = envelope.length >= 5 && active >= 2;
  return { pass, seconds: envelope.length, activeSeconds: active, envelope };
}

function verdictBifurcation(envelopeA, envelopeB) {
  const corr = pearson(envelopeA, envelopeB);
  const exclusive = exclusiveActiveFraction(envelopeA, envelopeB);
  const bothHaveSpeech = activeSeconds(envelopeA) >= 2 && activeSeconds(envelopeB) >= 2;
  if (corr == null || exclusive == null || !bothHaveSpeech) {
    return { verdict: "INCONCLUSIVE", corr, exclusive, reason: "not enough speech on both captures" };
  }
  if (corr >= 0.9 && exclusive <= 0.2) {
    return { verdict: "MIXED", corr, exclusive, reason: "captures carry the same audio - party supervise did not split legs" };
  }
  if (corr <= 0.5 && exclusive >= 0.4) {
    return { verdict: "SPLIT", corr, exclusive, reason: "captures are decorrelated with exclusive speech - per-leg audio is real" };
  }
  return { verdict: "INCONCLUSIVE", corr, exclusive, reason: "middle zone - rerun with cleaner alternating speech (one side at a time)" };
}

// ── capture leg orchestration ────────────────────────────────────────────────

function spawnCaptureLeg({ agentExt, supervisorExt, deviceId, party, timeoutSec, outDir, label, monitorPrefix }) {
  const args = [
    CAPTURE_SCRIPT,
    "--agent-ext", agentExt,
    "--supervisor-ext", supervisorExt,
    "--party", party,
    // agent-live: newest session that has a LIVE party for the agent extension.
    // Plain "newest" can grab an unrelated inbound ring-group call (PB dialing an
    // RC number rings many extensions and lists on the agent's active-calls).
    "--call", "agent-live",
    "--timeout-sec", String(timeoutSec),
    "--out-dir", outDir,
    "--supervise",
  ];
  if (deviceId) args.push("--supervisor-device-id", deviceId);
  fs.mkdirSync(outDir, { recursive: true });
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...monitorEnvFor(monitorPrefix) },
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      process.stdout.write(String(chunk).replace(/^/gm, `[${label}] `));
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(String(chunk).replace(/^/gm, `[${label}] `));
    });
    child.on("close", (code) => {
      const files = fs.existsSync(outDir)
        ? fs.readdirSync(outDir).filter((name) => name.endsWith(".pcmu")).map((name) => path.join(outDir, name))
        : [];
      // Newest capture in this leg's private dir is this leg's capture.
      const capture = files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
      resolve({ label, code, capture, stdout });
    });
  });
}

function analyzeLeg(leg) {
  if (!leg.capture) {
    return { ...leg, transmission: { pass: false, seconds: 0, activeSeconds: 0, envelope: [] }, note: "no capture file - supervise attach likely failed (see log above)" };
  }
  const buffer = fs.readFileSync(leg.capture);
  return { ...leg, transmission: verdictTransmission(buffer) };
}

// ── self-test (failable check for the analyzer itself) ───────────────────────

function synthPcmu(pattern, secondsPerBlock = 5) {
  // pattern: string of '1'/'0' blocks; '1' = speech-like noise, '0' = silence
  const bytes = [];
  for (const block of pattern) {
    for (let i = 0; i < secondsPerBlock * SAMPLE_RATE; i += 1) {
      const sample = block === "1" ? Math.round((Math.random() * 2 - 1) * 8000) : 0;
      bytes.push(linearToUlawSample(sample));
    }
  }
  return Buffer.from(bytes);
}

function runSelfTest() {
  const results = [];

  // Case 1: identical mixed audio on both legs -> MIXED
  const mixed = synthPcmu("1101101");
  const mixedVerdict = verdictBifurcation(energyEnvelope(mixed), energyEnvelope(mixed));
  results.push({ case: "identical-streams", expect: "MIXED", got: mixedVerdict.verdict, pass: mixedVerdict.verdict === "MIXED" });

  // Case 2: alternating exclusive speech -> SPLIT
  const legA = synthPcmu("1010101");
  const legB = synthPcmu("0101010");
  const splitVerdict = verdictBifurcation(energyEnvelope(legA), energyEnvelope(legB));
  results.push({ case: "alternating-streams", expect: "SPLIT", got: splitVerdict.verdict, pass: splitVerdict.verdict === "SPLIT" });

  // Case 3: silence -> INCONCLUSIVE (never claim a split without speech evidence)
  const quiet = synthPcmu("0000000");
  const quietVerdict = verdictBifurcation(energyEnvelope(quiet), energyEnvelope(quiet));
  results.push({ case: "silence", expect: "INCONCLUSIVE", got: quietVerdict.verdict, pass: quietVerdict.verdict === "INCONCLUSIVE" });

  // Case 4: transmission verdicts
  const speechTx = verdictTransmission(synthPcmu("111000"));
  const silentTx = verdictTransmission(synthPcmu("000000"));
  results.push({ case: "transmission-speech", expect: "pass", got: speechTx.pass ? "pass" : "fail", pass: speechTx.pass === true });
  results.push({ case: "transmission-silence", expect: "fail", got: silentTx.pass ? "pass" : "fail", pass: silentTx.pass === false });

  const allPass = results.every((row) => row.pass);
  console.log(JSON.stringify({ selfTest: allPass ? "PASS" : "FAIL", results }, null, 2));
  process.exit(allPass ? 0 : 1);
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, "--self-test")) return runSelfTest();

  const agentExt = readFlag(argv, "--agent-ext", "101");
  const supExtA = readFlag(argv, "--sup-ext-a", "");
  const supExtB = readFlag(argv, "--sup-ext-b", "");
  const deviceA = readFlag(argv, "--device-id-a", "");
  const deviceB = readFlag(argv, "--device-id-b", "");
  const singleParty = readFlag(argv, "--party", "remote");
  const timeoutSec = Math.max(30, Math.min(600, Number(readFlag(argv, "--timeout-sec", "90")) || 90));
  const runDir = path.resolve("runtime", "ex-pb-leg-test", timestampForDir());

  if (!supExtA) {
    console.error("usage: node scripts/rc-ex-pb-leg-test.js --agent-ext <your ext> --sup-ext-a <vm ext> [--sup-ext-b <vm ext 2>] [--timeout-sec 90]");
    console.error("       (add --sup-ext-b for the conclusive dual-leg bifurcation test; --self-test to verify the analyzer)");
    process.exit(1);
  }

  const dual = Boolean(supExtB);
  console.log("RingEX/PhoneBurner leg test");
  console.log(`  agent line (dialed into PB): ext ${agentExt}`);
  console.log(`  monitor A: ext ${supExtA} party=${dual ? "agent" : singleParty}`);
  if (dual) console.log(`  monitor B: ext ${supExtB} party=remote`);
  console.log(`  window: ${timeoutSec}s  captures: ${runDir}`);
  console.log("");
  console.log("  DO THIS DURING THE WINDOW: start the PhoneBurner call to yourself first, then");
  console.log("  alternate speech - talk ~10s ONLY on your dialed-in line, then ~10s ONLY on the");
  console.log("  prospect cell, and repeat. Exclusive alternation is what makes the verdict sharp.");
  console.log("");

  const monitorA = readFlag(argv, "--monitor-a", "BRUCE");
  const monitorB = readFlag(argv, "--monitor-b", "CHRIS");

  const legs = dual
    ? await Promise.all([
      spawnCaptureLeg({ agentExt, supervisorExt: supExtA, deviceId: deviceA, party: "agent", timeoutSec, outDir: path.join(runDir, "leg-a-agent"), label: "A/agent", monitorPrefix: monitorA }),
      spawnCaptureLeg({ agentExt, supervisorExt: supExtB, deviceId: deviceB, party: "remote", timeoutSec, outDir: path.join(runDir, "leg-b-remote"), label: "B/remote", monitorPrefix: monitorB }),
    ])
    : [await spawnCaptureLeg({ agentExt, supervisorExt: supExtA, deviceId: deviceA, party: singleParty, timeoutSec, outDir: path.join(runDir, "leg-single"), label: `single/${singleParty}`, monitorPrefix: monitorA })];

  const analyzed = legs.map(analyzeLeg);
  const summary = {
    mode: dual ? "dual" : "single",
    legs: analyzed.map((leg) => ({
      label: leg.label,
      capture: leg.capture,
      transmission: leg.transmission.pass ? "PASS" : "FAIL",
      seconds: leg.transmission.seconds,
      activeSeconds: leg.transmission.activeSeconds,
      timeline: envelopeBar(leg.transmission.envelope),
      note: leg.note || null,
    })),
  };

  if (dual) {
    const [a, b] = analyzed;
    summary.bifurcation = verdictBifurcation(a.transmission.envelope, b.transmission.envelope);
  } else {
    summary.hint = "single mode: read the timeline against your alternation - if the party=remote capture is loud during agent-only speech, the stream is mixed. Add --sup-ext-b for the automatic verdict.";
  }

  console.log("");
  console.log(JSON.stringify(summary, null, 2));

  const transmissionOk = analyzed.some((leg) => leg.transmission.pass);
  process.exit(transmissionOk ? 0 : 1);
}

main().catch((error) => {
  console.error(`fatal: ${error.message}`);
  process.exit(1);
});
