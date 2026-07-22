"use strict";

// Guarded floor-day RingCX SUSPECT recovery.
//
// Read-only by default. With --arm, a poisoned agent session is logged out only when:
//   - the account active-call read succeeded;
//   - that exact agent has no active call;
//   - RingCX reports the agent as SUSPECT;
//   - a second login read still reports SUSPECT;
//   - a second active-call read still proves the agent idle; and
//   - the per-agent cooldown and attempt cap allow it.
//
// The process exits at --end-hour Pacific (18 by default). It never changes
// campaigns, leads, caller IDs, dispositions, or agent provisioning.

const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const { createRingcxVoiceClient } = require("../packages/shared-integrations/src");

const FLOOR_AGENTS = Object.freeze([
  { name: "Sean", agentId: "20845", agentGroupId: "2156" },
  { name: "Chris", agentId: "21810", agentGroupId: "2187" },
  { name: "Brad", agentId: "21812", agentGroupId: "2187" },
]);

function readNumberFlag(argv, name, fallback, minimum = 0) {
  const index = argv.indexOf(name);
  if (index < 0 || index >= argv.length - 1) return fallback;
  const value = Number(argv[index + 1]);
  return Number.isFinite(value) ? Math.max(Math.trunc(value), minimum) : fallback;
}

function activeCallRows(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ["records", "activeCalls", "calls", "content", "data", "result"]) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

function callMatchesAgent(row = {}, agentId) {
  const wanted = String(agentId || "").trim();
  if (!wanted) return false;
  const values = [
    row.agentId,
    row.agentID,
    row.agent?.agentId,
    row.agent?.id,
    row.userId,
  ].map((value) => String(value || "").trim()).filter(Boolean);
  return values.includes(wanted);
}

function isSoftphoneLogin(login = {}) {
  login = login || {};
  const phone = String(login.agentPhone || login.agent_phone || "").toUpperCase();
  return phone.includes("@RC_SOFTPHONE") || phone.includes("SIP:");
}

function offhookCount(login = {}) {
  login = login || {};
  const sessions = login.agentOffhookSessions || login.offhookSessions;
  return Array.isArray(sessions) ? sessions.filter((row) => !row?.endDts).length : 0;
}

function loginState(login = {}) {
  login = login || {};
  return String(login.agentState || login.agentAuxState || login.state || "").trim().toUpperCase();
}

function decideRecovery({
  state,
  activeCallReadOk,
  hasActiveCall,
  nowMs,
  nextEligibleAtMs,
  attempts,
  maxAttempts,
} = {}) {
  if (!activeCallReadOk) return { action: "skip", reason: "active-call-read-failed" };
  if (hasActiveCall) return { action: "skip", reason: "agent-has-active-call" };
  if (String(state || "").toUpperCase() !== "SUSPECT") return { action: "skip", reason: "not-suspect" };
  if (Number(attempts || 0) >= Number(maxAttempts || 0)) {
    return { action: "skip", reason: "attempt-cap-reached" };
  }
  if (Number(nextEligibleAtMs || 0) > Number(nowMs || 0)) {
    return { action: "skip", reason: "cooldown" };
  }
  return { action: "logout-agent", reason: "confirmed-suspect-session" };
}

function pacificHour(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  return Number(parts.find((part) => part.type === "hour")?.value);
}

async function runWatchdog({
  client,
  agents = FLOOR_AGENTS,
  armed = false,
  intervalMs = 15_000,
  cooldownMs = 300_000,
  verifyDelayMs = 2_000,
  maxAttempts = 6,
  endHour = 18,
  now = () => new Date(),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  emit = () => {},
} = {}) {
  const stateByAgent = new Map(agents.map((agent) => [agent.agentId, {
    attempts: 0,
    nextEligibleAtMs: 0,
    lastState: null,
    lastReason: null,
  }]));
  let stopped = false;

  const tick = async () => {
    const tickAt = now();
    if (pacificHour(tickAt) >= endHour) {
      stopped = true;
      emit({ event: "watchdog.stopped", reason: "end-of-pacific-workday", at: tickAt.toISOString() });
      return;
    }

    let callsPayload = null;
    let activeCallReadOk = true;
    try {
      callsPayload = await client.listActiveCalls({
        product: "ACCOUNT",
        productId: process.env.RINGCX_VOICE_ACCOUNT_ID,
      });
    } catch (error) {
      activeCallReadOk = false;
      emit({ event: "watchdog.active_call_read_failed", at: tickAt.toISOString(), error: error?.message || String(error) });
    }
    const calls = activeCallReadOk ? activeCallRows(callsPayload) : [];

    for (const agent of agents) {
      const local = stateByAgent.get(agent.agentId);
      let login;
      try {
        login = await client.getAgentLogin(agent.agentId, agent.agentGroupId);
      } catch (error) {
        emit({ event: "watchdog.agent_login_read_failed", agent: agent.name, agentId: agent.agentId, at: tickAt.toISOString(), error: error?.message || String(error) });
        continue;
      }
      const state = loginState(login);
      const softphone = isSoftphoneLogin(login);
      const liveOffhookCount = offhookCount(login);
      const hasActiveCall = calls.some((row) => callMatchesAgent(row, agent.agentId));
      const decision = decideRecovery({
        state,
        activeCallReadOk,
        hasActiveCall,
        softphone,
        liveOffhookCount,
        nowMs: tickAt.getTime(),
        nextEligibleAtMs: local.nextEligibleAtMs,
        attempts: local.attempts,
        maxAttempts,
      });

      if (state !== local.lastState || decision.reason !== local.lastReason || decision.action === "logout-agent") {
        emit({
          event: "watchdog.observation",
          agent: agent.name,
          agentId: agent.agentId,
          at: tickAt.toISOString(),
          state,
          softphone,
          liveOffhookCount,
          hasActiveCall,
          armed,
          attempts: local.attempts,
          decision,
        });
        local.lastState = state;
        local.lastReason = decision.reason;
      }

      if (decision.action !== "logout-agent") continue;
      local.attempts += 1;
      local.nextEligibleAtMs = tickAt.getTime() + cooldownMs;
      if (!armed) {
        emit({ event: "watchdog.dry_run", agent: agent.name, agentId: agent.agentId, at: tickAt.toISOString(), wouldLogout: true });
        continue;
      }

      try {
        // Reconfirm both facts immediately before the destructive session action.
        await wait(verifyDelayMs);
        const confirmedLogin = await client.getAgentLogin(agent.agentId, agent.agentGroupId);
        if (loginState(confirmedLogin) !== "SUSPECT") {
          emit({ event: "watchdog.logout_cancelled", agent: agent.name, agentId: agent.agentId, at: now().toISOString(), reason: "suspect-cleared-on-confirmation" });
          continue;
        }
        let confirmedCallsPayload;
        try {
          confirmedCallsPayload = await client.listActiveCalls({
            product: "ACCOUNT",
            productId: process.env.RINGCX_VOICE_ACCOUNT_ID,
          });
        } catch (error) {
          emit({ event: "watchdog.logout_cancelled", agent: agent.name, agentId: agent.agentId, at: now().toISOString(), reason: "confirmation-active-call-read-failed", error: error?.message || String(error) });
          continue;
        }
        if (activeCallRows(confirmedCallsPayload).some((row) => callMatchesAgent(row, agent.agentId))) {
          emit({ event: "watchdog.logout_cancelled", agent: agent.name, agentId: agent.agentId, at: now().toISOString(), reason: "agent-became-active" });
          continue;
        }
        await client.request(
          "POST",
          `/voice/api/v1/admin/accounts/${client.config.accountId}/agentGroups/${agent.agentGroupId}/agents/${agent.agentId}/logout`,
        );
        await wait(verifyDelayMs);
        const verifiedLogin = await client.getAgentLogin(agent.agentId, agent.agentGroupId).catch(() => null);
        const loginStillPresent = Boolean(verifiedLogin);
        emit({
          event: loginStillPresent ? "watchdog.logout_unconfirmed" : "watchdog.logged_out",
          agent: agent.name,
          agentId: agent.agentId,
          at: now().toISOString(),
          priorState: "SUSPECT",
          loginStillPresent,
          attempts: local.attempts,
        });
        local.lastState = loginStillPresent ? loginState(verifiedLogin) : "LOGGED_OUT";
      } catch (error) {
        emit({ event: "watchdog.logout_failed", agent: agent.name, agentId: agent.agentId, at: now().toISOString(), error: error?.message || String(error), attempts: local.attempts });
      }
    }
  };

  emit({ event: "watchdog.started", at: now().toISOString(), armed, intervalMs, cooldownMs, maxAttempts, endHour, agentCount: agents.length });
  while (!stopped) {
    await tick();
    if (!stopped) await wait(intervalMs);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const armed = argv.includes("--arm");
  const intervalMs = readNumberFlag(argv, "--interval-sec", 15, 5) * 1000;
  const cooldownMs = readNumberFlag(argv, "--cooldown-sec", 300, 30) * 1000;
  const maxAttempts = readNumberFlag(argv, "--max-attempts", 6, 1);
  const endHour = readNumberFlag(argv, "--end-hour", 18, 0);
  const runtimeDir = path.resolve(__dirname, "..", "runtime", "cx-suspect-watchdog");
  fs.mkdirSync(runtimeDir, { recursive: true });
  const logPath = path.join(runtimeDir, `watchdog-${new Date().toISOString().slice(0, 10)}.jsonl`);
  const pidPath = path.join(runtimeDir, "watchdog.pid");
  fs.writeFileSync(pidPath, `${process.pid}\n`, "utf8");
  process.on("exit", () => {
    try { fs.rmSync(pidPath, { force: true }); } catch (_error) { /* best effort */ }
  });
  const emit = (row) => {
    const line = JSON.stringify(row);
    fs.appendFileSync(logPath, `${line}\n`, "utf8");
    console.log(line);
  };
  const stop = (signal) => {
    emit({ event: "watchdog.signal", signal, at: new Date().toISOString() });
    process.exit(0);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  await runWatchdog({
    client: createRingcxVoiceClient(),
    armed,
    intervalMs,
    cooldownMs,
    maxAttempts,
    endHour,
    emit,
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[cx-suspect-watchdog] ${error?.stack || error}`);
    process.exitCode = 1;
  });
}

module.exports = {
  activeCallRows,
  callMatchesAgent,
  decideRecovery,
  isSoftphoneLogin,
  loginState,
  offhookCount,
  pacificHour,
  runWatchdog,
};
