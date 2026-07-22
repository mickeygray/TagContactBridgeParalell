"use strict";

// Exact-window, four-agent launch for the 2026-07-13 PhoneBurner cutover.
// Dry by default. Apply is allowed only while ParallelControlPlane is stopped.

const { execFileSync } = require("child_process");
const path = require("path");
const {
  bootstrapRuntime,
  loadCheckedInConfiguration,
} = require("./phoneburner-july-preload");

const APPLY_ACK = "SEED-TODAY-TO-FOUR-PHONEBURNER-AGENTS";
const RECEIVED_FROM = new Date("2026-07-13T07:00:00.000Z");
const AGENT_IDS = Object.freeze(["brad_hansen", "chris_bolt", "phil_olson", "sean_lucas"]);

function parseArgs(argv, now = new Date()) {
  const options = { apply: false, ack: null, snapshot: null, maxContacts: 5000 };
  for (const arg of argv) {
    if (arg === "--apply") options.apply = true;
    else if (arg.startsWith("--ack=")) options.ack = arg.slice(6);
    else if (arg.startsWith("--snapshot=")) options.snapshot = new Date(arg.slice(11));
    else if (arg.startsWith("--limit=")) options.maxContacts = Number(arg.slice(8));
    else throw new Error("unknown-option");
  }
  if (!options.snapshot) options.snapshot = new Date(now);
  if (Number.isNaN(options.snapshot.getTime()) || options.snapshot <= RECEIVED_FROM) throw new Error("invalid-snapshot");
  if (!Number.isSafeInteger(options.maxContacts) || options.maxContacts < 1 || options.maxContacts > 5000) throw new Error("invalid-limit");
  if (options.apply && options.ack !== APPLY_ACK) throw new Error("apply-ack-required");
  if (options.apply && !argv.some((arg) => arg.startsWith("--snapshot="))) throw new Error("apply-snapshot-required");
  return options;
}

function assertControlPlaneStopped() {
  const output = execFileSync("sc.exe", ["query", "ParallelControlPlane"], { encoding: "utf8", windowsHide: true });
  if (!/STATE\s*:\s*1\s+STOPPED/i.test(output)) throw new Error("control-plane-not-stopped");
}

async function run(options) {
  if (options.apply) assertControlPlaneStopped();
  const configuration = loadCheckedInConfiguration();
  const enabled = Object.entries(configuration.agents || {}).filter(([, agent]) => agent.enabled === true)
    .map(([agentId]) => String(agentId || "").trim().toLowerCase()).sort();
  if (JSON.stringify(enabled) !== JSON.stringify([...AGENT_IDS].sort())) throw new Error("enabled-agent-set-mismatch");
  const context = await bootstrapRuntime({ configuration, options: { dryRun: !options.apply }, env: process.env });
  try {
    return await context.runtime.preloadWindow({
      receivedFrom: RECEIVED_FROM,
      receivedBefore: options.snapshot,
      agentIds: [...AGENT_IDS],
      maxContacts: options.maxContacts,
      dryRun: !options.apply,
      ...(options.apply ? { checkpointKey: `phoneburner-today-four-${options.snapshot.toISOString().toLowerCase()}` } : {}),
    });
  } finally {
    await context.close();
  }
}

function safeSummary(result) {
  return {
    ok: ["preview", "completed"].includes(String(result?.status || "")),
    status: String(result?.status || "unknown"),
    dryRun: result?.dryRun === true,
    scanned: Number(result?.scanned || 0),
    eligible: Number(result?.eligible || 0),
    selected: Number(result?.selected || 0),
    assigned: Number(result?.assigned || 0),
    accepted: Number(result?.accepted || 0),
    pending: Number(result?.pending || 0),
    failed: Number(result?.failed || 0),
    countsByAgent: Object.fromEntries(AGENT_IDS.map((id) => [id, Number(result?.countsByAgent?.[id] || 0)])),
    fairnessSpread: Number(result?.fairnessSpread || 0),
    backpressure: result?.backpressure === true,
    conflictCount: Number(result?.conflictCount || 0),
  };
}

async function main() {
  require("dotenv").config({ path: path.resolve(__dirname, "..", ".env"), quiet: true });
  try {
    const summary = safeSummary(await run(parseArgs(process.argv.slice(2))));
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    process.exitCode = summary.ok ? 0 : 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, status: "error", reason: String(error?.message || "launch-failed").slice(0, 80) })}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) void main();

module.exports = { AGENT_IDS, APPLY_ACK, RECEIVED_FROM, assertControlPlaneStopped, parseArgs, run, safeSummary };
