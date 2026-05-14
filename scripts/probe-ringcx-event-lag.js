"use strict";

// RingCX event-lag probe (test #5 in the characterization suite).
//
// Purpose: measure how quickly our app "notices" RC state transitions
// for a real call — call placed, agent connected, customer connected,
// hangup, no-answer, voicemail. The output tells us whether our
// auto-cycle logic can rely on RC's state stream or needs timer-based
// fallbacks.
//
// Methodology:
//   1. Operator confirms readiness for each scenario.
//   2. Script POSTs createManualAgentCall (placeManualCall) from a
//      designated agent's seat to a designated test phone.
//   3. Script then polls listActiveCalls at 2 rps (well below the
//      rate-limit ceiling) and timestamps every state observed for
//      this UII.
//   4. Each scenario asks the operator to drive the call in a specific
//      way — answer + hang up, ringout, etc.
//   5. After all scenarios, print + write a timeline JSONL showing
//      observed-state-arrival-times relative to t_dial.
//
// Scope:
//   - PLACES REAL CALLS. Each scenario = 1 real outbound call from
//     the agent's seat. The agent's softphone will ring. The
//     destination's phone will ring (or not, depending on scenario).
//     This is intentional and disclosed to the operator before each
//     scenario.
//   - Operator must be logged in as the agent in RingCX and set to
//     AVAILABLE. Operator must also have access to the destination
//     phone to drive the scenario behavior.
//   - The destination phone should be the operator's own line. Do
//     NOT point this at a customer number.
//
// Usage:
//   node scripts/probe-ringcx-event-lag.js \
//     [--destination 13106665997]                  # operator's test phone
//     [--agent-email mgray@taxadvocategroup.com]   # whose seat places the call
//     [--caller-id 8183345087]                     # outbound CID (optional)
//     [--scenarios 1,2,3,4,5]                      # which scenarios to run
//     [--poll-rps 2]                               # polling rate (default 2)
//     [--per-call-timeout 90]                      # max seconds per scenario
//     [--dry-run]                                  # confirm wiring; no real calls

const path = require("path");
const fs = require("fs");
const readline = require("readline");

require("dotenv").config({
  path: path.resolve(__dirname, "..", ".env"),
});

const {
  createRingcxVoiceClient,
  normalizeRingcxPhone,
} = require("../packages/shared-integrations/src/ringcxVoiceClient");

// ── Hard caps ───────────────────────────────────────────────────
const HARD_MAX_CALLS = 8; // safety: never place more than 8 calls in one run
const HARD_MAX_PER_CALL_TIMEOUT_MS = 5 * 60 * 1000; // 5 min per scenario

// ── Scenarios ───────────────────────────────────────────────────
//
// Each scenario instructs the operator how to drive the call. The
// "expectedEnd" hint is just for operator clarity; the script doesn't
// enforce it.
const SCENARIOS = {
  1: {
    name: "answer-then-hangup",
    instructions: [
      "1. Your softphone (agent seat) will ring.",
      "2. Answer it.",
      "3. Your CELL (310-666-5997) will then ring.",
      "4. Answer the cell.",
      "5. Wait 5 seconds, then hang up.",
    ].join("\n      "),
    expectedEnd: "completed",
  },
  2: {
    name: "ringout-no-answer",
    instructions: [
      "1. Your softphone will ring.",
      "2. Answer it.",
      "3. Your CELL will ring — DO NOT answer.",
      "4. Let it ring out completely (until RC gives up).",
    ].join("\n      "),
    expectedEnd: "no-answer",
  },
  3: {
    name: "voicemail",
    instructions: [
      "1. Your softphone will ring.",
      "2. Answer it.",
      "3. Your CELL will ring — let it ring 4+ times, then it'll go to VM.",
      "4. After VM greeting starts, just wait — let it record briefly, then hang up.",
    ].join("\n      "),
    expectedEnd: "voicemail",
  },
  4: {
    name: "agent-noanswer",
    instructions: [
      "1. Your softphone will ring.",
      "2. DO NOT answer the softphone — let it ring out.",
      "3. Cell will not ring (call never bridged out).",
    ].join("\n      "),
    expectedEnd: "agent-no-answer",
  },
  5: {
    name: "customer-quick-hangup",
    instructions: [
      "1. Your softphone will ring.",
      "2. Answer it.",
      "3. Your CELL will ring.",
      "4. Answer the cell.",
      "5. Hang up the CELL immediately (within 1 sec).",
    ].join("\n      "),
    expectedEnd: "completed",
  },
};

// ── Helpers ─────────────────────────────────────────────────────
function readArg(name, fallback) {
  const argv = process.argv.slice(2);
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1];
  return fallback;
}
function hasFlag(name) {
  return process.argv.slice(2).includes(name);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function appendJsonl(file, record) {
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
}

async function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// Snapshot a call from listActiveCalls. RingCX schema can vary;
// surface whatever we can plausibly identify.
function findUiiInActiveCalls(payload, uii) {
  const target = String(uii || "").trim();
  if (!target) return null;
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.records)
      ? payload.records
      : Array.isArray(payload?.activeCalls)
        ? payload.activeCalls
        : Array.isArray(payload?.data)
          ? payload.data
          : [];
  for (const row of rows) {
    const candidate = String(
      row?.uii ||
        row?.UII ||
        row?.interactionId ||
        row?.callId ||
        "",
    ).trim();
    if (candidate === target) return row;
  }
  return null;
}

function summarizeCallState(row) {
  if (!row) return { present: false };
  // Pull whatever state fields RC happens to surface. Conservative —
  // we log the raw row in audit too, so missing fields don't lose data.
  return {
    present: true,
    state:
      row?.state ||
      row?.callState ||
      row?.status ||
      row?.dialState ||
      null,
    agentState: row?.agentState || row?.agent?.state || null,
    leadState: row?.leadState || row?.customer?.state || null,
    duration: Number(row?.duration || row?.callDuration || 0) || 0,
  };
}

// ── Per-scenario runner ─────────────────────────────────────────
async function runScenario({
  client,
  scenarioId,
  scenario,
  destination,
  callerId,
  agentEmail,
  pollRps,
  perCallTimeoutMs,
  logFile,
  dryRun,
}) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`SCENARIO ${scenarioId}: ${scenario.name}`);
  console.log("=".repeat(60));
  console.log(`Expected end state: ${scenario.expectedEnd}`);
  console.log("\nWhat to do:");
  console.log(`      ${scenario.instructions}`);
  console.log("");
  await prompt("Press ENTER when ready (or Ctrl+C to abort)...");

  const t_request = Date.now();
  console.log(`[scenario ${scenarioId}] firing placeManualCall at ${nowIso()}`);

  let placeResult;
  let uii;
  if (dryRun) {
    console.log("[dry-run] would have placed call — using synthetic UII");
    uii = `dryrun-uii-${t_request}`;
    placeResult = { dryRun: true, uii };
  } else {
    try {
      placeResult = await client.placeManualCall({
        agentEmail,
        destination,
        callerId,
        ringDuration: 5,
      });
    } catch (err) {
      console.error(`[scenario ${scenarioId}] placeManualCall FAILED:`, err.message);
      appendJsonl(logFile, {
        type: "scenario-failed",
        at: nowIso(),
        scenarioId,
        scenario: scenario.name,
        error: err.message,
        details: err.details || null,
      });
      return null;
    }
    uii = String(
      placeResult?.uii ||
        placeResult?.UII ||
        placeResult?.interactionId ||
        placeResult?.callId ||
        "",
    );
  }

  const t_placed_ack = Date.now();
  console.log(
    `[scenario ${scenarioId}] placeManualCall ACK in ${t_placed_ack - t_request}ms, UII=${uii || "(none)"}`,
  );
  appendJsonl(logFile, {
    type: "scenario-start",
    at: new Date(t_request).toISOString(),
    scenarioId,
    scenario: scenario.name,
    placeAckMs: t_placed_ack - t_request,
    uii: uii || null,
    placeResult,
  });

  if (!uii) {
    console.warn(
      `[scenario ${scenarioId}] no UII returned — can't track this call. Skipping observation phase.`,
    );
    return { scenarioId, scenario: scenario.name, uii: null };
  }

  if (dryRun) {
    console.log("[dry-run] skipping poll phase");
    return { scenarioId, scenario: scenario.name, uii, dryRun: true };
  }

  // ── Polling phase ────────────────────────────────────────────
  const pollIntervalMs = Math.max(Math.round(1000 / pollRps), 250);
  const endsAt = t_placed_ack + perCallTimeoutMs;
  const states = [];
  let firstSeenAt = null;
  let lastSeenAt = null;
  let lastSummary = null;
  let consecutiveAbsent = 0;
  let seen = false;

  console.log(
    `[scenario ${scenarioId}] polling listActiveCalls @ ${pollRps} rps, max ${perCallTimeoutMs / 1000}s`,
  );

  while (Date.now() < endsAt) {
    const t_poll = Date.now();
    let payload;
    try {
      payload = await client.listActiveCalls();
    } catch (err) {
      appendJsonl(logFile, {
        type: "poll-error",
        at: nowIso(),
        scenarioId,
        uii,
        status: err?.status || err?.details?.responseStatus || null,
        message: err.message,
      });
      await sleep(pollIntervalMs);
      continue;
    }
    const row = findUiiInActiveCalls(payload, uii);
    const summary = summarizeCallState(row);
    const t_observed = Date.now();

    if (summary.present) {
      consecutiveAbsent = 0;
      if (!firstSeenAt) {
        firstSeenAt = t_observed;
        console.log(
          `[scenario ${scenarioId}] FIRST observed at t+${t_observed - t_request}ms — state=${summary.state || "?"}`,
        );
      }
      lastSeenAt = t_observed;
      // Only log state-change events to keep the JSONL tidy
      if (
        !lastSummary ||
        lastSummary.state !== summary.state ||
        lastSummary.agentState !== summary.agentState ||
        lastSummary.leadState !== summary.leadState
      ) {
        states.push({
          t_observed,
          elapsedMs: t_observed - t_request,
          ...summary,
          rawRow: row,
        });
        appendJsonl(logFile, {
          type: "state-change",
          at: new Date(t_observed).toISOString(),
          scenarioId,
          uii,
          elapsedMs: t_observed - t_request,
          summary,
          rawRow: row,
        });
        console.log(
          `  t+${(t_observed - t_request).toString().padStart(5)}ms  state=${summary.state || "?"} agent=${summary.agentState || "?"} lead=${summary.leadState || "?"}`,
        );
        lastSummary = summary;
      }
      seen = true;
    } else {
      // Call not in active list
      if (seen) {
        consecutiveAbsent += 1;
        // After 3 consecutive polls where the call has disappeared,
        // call it done.
        if (consecutiveAbsent >= 3) {
          console.log(
            `[scenario ${scenarioId}] call disappeared from active list at t+${t_observed - t_request}ms`,
          );
          break;
        }
      }
    }
    // Pace the next poll
    const sinceLast = Date.now() - t_poll;
    const wait = Math.max(pollIntervalMs - sinceLast, 0);
    if (wait > 0) await sleep(wait);
  }

  const t_end = Date.now();
  const result = {
    type: "scenario-summary",
    scenarioId,
    scenario: scenario.name,
    uii,
    t_request: new Date(t_request).toISOString(),
    t_placed_ack: new Date(t_placed_ack).toISOString(),
    t_end: new Date(t_end).toISOString(),
    placeAckMs: t_placed_ack - t_request,
    firstSeenAfterMs: firstSeenAt ? firstSeenAt - t_request : null,
    lastSeenAfterMs: lastSeenAt ? lastSeenAt - t_request : null,
    disappearedAfterMs: seen && consecutiveAbsent >= 3 ? t_end - t_request : null,
    totalDurationMs: t_end - t_request,
    stateChanges: states.length,
    states: states.map((s) => ({
      elapsedMs: s.elapsedMs,
      state: s.state,
      agentState: s.agentState,
      leadState: s.leadState,
    })),
    timedOut: t_end >= endsAt,
  };
  appendJsonl(logFile, { type: "scenario-end", at: nowIso(), summary: result });

  console.log(`\n[scenario ${scenarioId}] complete`);
  console.log(`  placeAckMs:           ${result.placeAckMs}ms`);
  console.log(`  firstSeenAfterMs:     ${result.firstSeenAfterMs ?? "n/a"}ms`);
  console.log(`  disappearedAfterMs:   ${result.disappearedAfterMs ?? "n/a (timed out or still present)"}ms`);
  console.log(`  stateChanges:         ${result.stateChanges}`);
  console.log("");

  return result;
}

// ── Main ────────────────────────────────────────────────────────
async function main() {
  const destination = normalizeRingcxPhone(
    readArg("--destination", "13106665997"),
  );
  if (!destination) throw new Error("--destination is required");

  const agentEmail = readArg(
    "--agent-email",
    process.env.RINGCX_VOICE_RC_USER_EMAIL || "mgray@taxadvocategroup.com",
  );

  const callerId = readArg("--caller-id", process.env.RINGCX_VOICE_RC_USER_ID || "");
  const pollRps = Math.max(
    1,
    Math.min(4, Number(readArg("--poll-rps", "2")) || 2),
  );
  const perCallTimeoutMs = Math.min(
    HARD_MAX_PER_CALL_TIMEOUT_MS,
    Number(readArg("--per-call-timeout", "90")) * 1000,
  );

  const requestedScenarios = readArg("--scenarios", "1,2,3,4,5")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && SCENARIOS[n]);
  if (requestedScenarios.length === 0) {
    throw new Error(
      `No valid scenarios. Available: ${Object.keys(SCENARIOS).join(", ")}`,
    );
  }
  if (requestedScenarios.length > HARD_MAX_CALLS) {
    throw new Error(
      `Too many scenarios requested. Hard cap: ${HARD_MAX_CALLS}`,
    );
  }

  const dryRun = hasFlag("--dry-run");

  const outDir = path.resolve(__dirname, "..", "runtime", "ringcx-probe");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
  const logFile = path.join(outDir, `event-lag-${stamp}.jsonl`);

  console.log("=".repeat(60));
  console.log("RingCX EVENT-LAG PROBE");
  console.log("=".repeat(60));
  console.log(`Destination:        ${destination}`);
  console.log(`Agent (placer):     ${agentEmail}`);
  console.log(`Caller ID:          ${callerId || "(default)"}`);
  console.log(`Scenarios:          ${requestedScenarios.join(", ")}`);
  console.log(`Poll rps:           ${pollRps}`);
  console.log(`Per-call timeout:   ${perCallTimeoutMs / 1000}s`);
  console.log(`Dry run:            ${dryRun}`);
  console.log(`Audit log:          ${logFile}`);
  console.log("");
  console.log("BEFORE STARTING:");
  console.log("  1. Log in to RingCX as " + agentEmail);
  console.log("  2. Set agent state to AVAILABLE");
  console.log(`  3. Have ${destination} in hand`);
  console.log("");

  appendJsonl(logFile, {
    type: "config",
    at: nowIso(),
    destination,
    agentEmail,
    callerId,
    pollRps,
    perCallTimeoutMs,
    scenarios: requestedScenarios.map((id) => ({
      id,
      name: SCENARIOS[id].name,
    })),
    dryRun,
  });

  const client = createRingcxVoiceClient();
  if (!dryRun) {
    const whoami = await client.auth.whoami();
    appendJsonl(logFile, { type: "auth-ok", at: nowIso(), whoami });
    console.log(`auth ok — bearer for ${whoami.rcUser?.email || "?"}`);
  }

  const proceed = await prompt(
    "Ready to begin? Type 'go' to proceed, anything else to abort: ",
  );
  if (proceed.toLowerCase() !== "go") {
    console.log("Aborted.");
    return;
  }

  const results = [];
  for (const id of requestedScenarios) {
    const result = await runScenario({
      client,
      scenarioId: id,
      scenario: SCENARIOS[id],
      destination,
      callerId,
      agentEmail,
      pollRps,
      perCallTimeoutMs,
      logFile,
      dryRun,
    });
    if (result) results.push(result);
    if (id !== requestedScenarios[requestedScenarios.length - 1]) {
      await prompt("Press ENTER when you're ready for the next scenario...");
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("FINAL SUMMARY");
  console.log("=".repeat(60));
  for (const r of results) {
    console.log(
      `  ${r.scenarioId} ${r.scenario.padEnd(28)}  ack=${r.placeAckMs ?? "?"}ms  firstSeen=${r.firstSeenAfterMs ?? "n/a"}ms  disappeared=${r.disappearedAfterMs ?? "n/a"}ms  states=${r.stateChanges}`,
    );
  }
  appendJsonl(logFile, { type: "final-summary", at: nowIso(), results });
  console.log(`\nFull JSONL audit: ${logFile}`);
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  if (err.details) console.error(JSON.stringify(err.details, null, 2));
  process.exit(1);
});
