"use strict";

// CX voicemail-drop serving (the "actual app" path).
//
// The CX workspace "Voicemail" button calls this. We resolve, server-side from
// the AUTHED agent (not trusting the client), which monitor barges, which agent
// extension is the target, and which recorded voicemail to play -- then call the
// headless barge service to do the *82 drop. The frontend handles the queue
// advance (disposition) after we confirm the drop released.

const { UserAccount } = require("../../shared-models/src");
const {
  resolveAgentVoicemailPlan,
  makeMongoAgentFinder,
} = require("./voicemailServingService");

function bargeServiceUrl() {
  return String(process.env.EX_BARGE_SERVICE_URL || "http://127.0.0.1:7335").replace(/\/$/, "");
}

function timeoutMsForAction(action) {
  const envName = action === "play"
    ? "CX_VOICEMAIL_DROP_PLAY_TIMEOUT_MS"
    : "CX_VOICEMAIL_DROP_CONTROL_TIMEOUT_MS";
  const fallback = action === "play" ? 135_000 : 12_000;
  return Math.max(3000, Number(process.env[envName] || fallback) || fallback);
}

async function postBargeJson(url, payload, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const json = await res.json().catch(() => null);
    return { res, json };
  } catch (err) {
    if (err?.name === "AbortError" || controller.signal.aborted) {
      throw new Error(`barge service timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// Prefer the authed user's own identity; allow an explicit override in the body
// for admin/testing (e.g. dropping on a specific agent extension).
function pickIdentifier(user, body) {
  const override = body && (body.agentIdentifier || body.agentExtensionId || body.agentExt);
  // SECURITY: only an admin may target a DIFFERENT agent's extension (supervisor/testing).
  // Regular agents always resolve to their own authed identity -- a client-supplied target is
  // ignored -- so an agent can never trigger a barge/drop onto another agent's live call.
  if (override && user?.role === "admin") return String(override).trim();
  return String(
    user?.extensionId || user?.extensionNumber || user?.cxAgentId || user?.email || "",
  ).trim();
}

function httpError(message, status, code, details) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  if (details) e.details = details;
  return e;
}

function pickDropAction(body = {}) {
  const raw = String(body.action || body.mode || "").trim().toLowerCase();
  if (raw === "arm" || raw === "prearm" || raw === "pre-arm") return "arm";
  if (raw === "release" || raw === "stop" || raw === "cleanup") return "release";
  return "play";
}

async function requestCxVoicemailDrop(domain, user, body = {}) {
  const identifier = pickIdentifier(user, body);
  if (!identifier) {
    throw httpError("No agent identifier to resolve voicemail drop", 400, "no-agent-identifier");
  }

  const plan = await resolveAgentVoicemailPlan(identifier, {
    findAgent: makeMongoAgentFinder(UserAccount),
  });

  if (!plan.ok) {
    throw httpError(
      `Cannot serve voicemail for agent (${(plan.problems || [plan.reason]).join(", ")})`,
      400,
      "voicemail-plan-unresolved",
      plan,
    );
  }
  if (!plan.monitorExtension) {
    throw httpError(
      "Agent has no assigned barge monitor (metadata.barge.monitorExtension)",
      409,
      "no-monitor-extension",
      plan,
    );
  }

  const action = pickDropAction(body);
  const endpoint = action === "arm" ? "arm" : action === "release" ? "release" : "play";
  const url = `${bargeServiceUrl()}/${endpoint}`;
  const timeoutMs = timeoutMsForAction(action);
  const payload = {
    monitorExt: plan.monitorExtension,
    agentExt: plan.targetExtensionNumber,
    code: "*82",
    wav: plan.voicemailPath,
    trigger: "silence",
    waitForRelease: true,
    reason: body.reason || undefined,
  };

  let res;
  let json;
  try {
    ({ res, json } = await postBargeJson(url, payload, timeoutMs));
  } catch (err) {
    throw httpError(`Barge service unreachable at ${url}: ${err.message}`, 502, "barge-service-unreachable");
  }

  if (!res.ok || !json || json.ok === false) {
    throw httpError(String(json?.error || `Barge service failed (${res.status})`), 502, "barge-failed", json);
  }
  if (action === "arm") {
    return {
      ok: true,
      armed: Boolean(json.armed),
      reused: Boolean(json.reused),
      usingFallbackVoicemail: Boolean(plan.usingFallbackVoicemail),
      plan: {
        agentName: plan.agentName,
        targetExtensionNumber: plan.targetExtensionNumber,
        monitorExtension: plan.monitorExtension,
        voicemailPath: plan.voicemailPath,
        problems: plan.problems,
      },
      barge: {
        key: json.arm?.key || json.key || null,
        sessionId: json.arm?.sessionId || null,
        dial: json.arm?.dial || null,
      },
    };
  }
  if (action === "release") {
    return {
      ok: true,
      released: Boolean(json.released),
      reason: json.reason || body.reason || "release",
      usingFallbackVoicemail: Boolean(plan.usingFallbackVoicemail),
      plan: {
        agentName: plan.agentName,
        targetExtensionNumber: plan.targetExtensionNumber,
        monitorExtension: plan.monitorExtension,
        voicemailPath: plan.voicemailPath,
        problems: plan.problems,
      },
      barge: { key: json.key || null, sessionId: json.arm?.sessionId || null, dial: json.arm?.dial || null },
    };
  }
  if (!json.played || !json.released) {
    throw httpError("Barge service did not confirm playback + release", 502, "barge-not-confirmed", json);
  }

  return {
    ok: true,
    played: Boolean(json.played),
    released: Boolean(json.released),
    usingFallbackVoicemail: Boolean(plan.usingFallbackVoicemail),
    plan: {
      agentName: plan.agentName,
      targetExtensionNumber: plan.targetExtensionNumber,
      monitorExtension: plan.monitorExtension,
      voicemailPath: plan.voicemailPath,
      problems: plan.problems,
    },
    barge: { key: json.key || null, sessionId: json.sessionId || null, dial: json.dial || null },
  };
}

// Pre-register a monitor softphone at agent login (no dial, no beep) so the first
// barge press skips registration latency. Fire-and-forget friendly: returns a
// result object and never throws (callers in the auth path must not be blocked).
async function warmAgentMonitor(monitorExtension, { logger = null } = {}) {
  const monitorExt = String(monitorExtension || "").trim();
  if (!monitorExt) return { ok: false, error: "no-monitor-extension" };
  const url = `${bargeServiceUrl()}/warm`;
  try {
    const { res, json } = await postBargeJson(url, { monitorExt }, timeoutMsForAction("arm"));
    if (!res.ok || !json || json.ok === false) {
      logger?.warn?.("voicemail.warm.failed", { monitorExt, status: res.status, error: json?.error });
      return { ok: false, monitorExt, error: json?.error || `warm failed (${res.status})` };
    }
    return { ok: true, monitorExt, registered: Boolean(json.registered) };
  } catch (err) {
    logger?.warn?.("voicemail.warm.unreachable", { monitorExt, error: err.message });
    return { ok: false, monitorExt, error: `barge service unreachable: ${err.message}` };
  }
}

// Convenience for the OAuth callback: warm the monitor for a resolved account,
// only if one is configured. Never throws.
async function warmMonitorForAccount(account, { logger = null } = {}) {
  const monitorExt = account?.metadata?.barge?.monitorExtension;
  if (!monitorExt) return { ok: false, skipped: true, reason: "no-monitor-configured" };
  return warmAgentMonitor(monitorExt, { logger });
}

module.exports = { requestCxVoicemailDrop, warmAgentMonitor, warmMonitorForAccount };
