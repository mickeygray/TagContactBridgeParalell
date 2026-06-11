"use strict";

// Coach-triggered voicemail drop (v2 architecture: "the coach is the ears,
// call control is the hands"). When the deterministic gate rejects a session
// as voicemail, transfer the AGENT leg's peer (the CX bridge) to a
// message-playing extension via RC Call Control — the message lands in the
// prospect's mailbox and the agent is freed at the transfer instant.
//
// SAFETY (low-impact rollout):
//   - default OFF: LIVE_COACH_VM_TRANSFER_ENABLED must be truthy
//   - HARD agent allowlist: LIVE_COACH_VM_TRANSFER_AGENT_ALLOWLIST (comma list
//     matched against session agentEmail/agentExtension/agentName). Empty
//     allowlist => never fires, even when enabled. Rollout: Michael Gray only.
//   - optional phone allowlist: LIVE_COACH_VM_TRANSFER_PHONE_ALLOWLIST — when
//     set, the prospect phone must also match.
//   - fires at most once per session, fire-and-forget (never throws into the
//     coach pipeline), logs every decision.
//
// Delivery modes (LIVE_COACH_VM_TRANSFER_MODE):
//   "rc-transfer"  (default) — RC Call Control blind-transfers the agent
//                  party to the target ext. Instant agent free, but the
//                  transfer consumes the agent's nailed station leg and the
//                  dialer has to ring the station back.
//   "ringcx-barge" — RingCX admin addSessionToCall(BARGEIN) dials the
//                  announcement ext INTO the live UII. The nailed leg never
//                  moves; the announcement plays into the prospect's VM while
//                  the agent stays bridged, then we hangupCall(uii) after
//                  LIVE_COACH_VM_BARGE_HANGUP_AFTER_MS so the dialer tears
//                  down normally (wrap-up/disposition flow intact).
//   "ringcx-disposition" — RingCX admin dispositionCall(uii) sets the
//                  "Voicemail Drop" disposition: the dialer releases the agent
//                  to the next call (their auto-dispo ASAP flow, just earlier)
//                  and the campaign workflow's on-disposition trigger takes the
//                  live VM leg and plays the announcement. Delivery is fully
//                  inside the dialer; nothing here plays audio.
//
// Env:
//   LIVE_COACH_VM_TRANSFER_ENABLED          default false
//   LIVE_COACH_VM_TRANSFER_MODE             "rc-transfer" | "ringcx-barge"
//   LIVE_COACH_VM_TRANSFER_AGENT_ALLOWLIST  e.g. "mgray@taxadvocategroup.com,63730035004,michael gray"
//   LIVE_COACH_VM_TRANSFER_PHONE_ALLOWLIST  optional extra phone gate
//   LIVE_COACH_VM_TRANSFER_TARGET_EXT       default "98765" (announcement ext)
//   LIVE_COACH_VM_TRANSFER_BEEP_DELAY_MS    default 2500 (greeting/beep gap)
//   LIVE_COACH_VM_TRANSFER_AGENT_EXT_ID     fallback RC extension id when the
//                                           session metadata has none (rc-transfer)
//   LIVE_COACH_VM_BARGE_HANGUP_AFTER_MS     default 40000; 0 disables the
//                                           post-announcement hangup (ringcx-barge)
//   LIVE_COACH_VM_DISPOSITION_NAME          default "Voicemail Drop" (ringcx-disposition)

const DEFAULT_BEEP_DELAY_MS = 2500;
const DEFAULT_BARGE_HANGUP_AFTER_MS = 40_000;
const DEFAULT_DISPOSITION_NAME = "Voicemail Drop";

function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
}

function boolEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

// Coach session ids embed the RingCX UII as the trailing digit run:
//   coach-cx-<agentExtId>-<uii>
function extractUii(session) {
  const metadata = session?.metadata || {};
  const binding = session?.binding || {};
  const direct = [metadata.uii, binding.event?.uii, binding.metadata?.uii]
    .map((v) => String(v || "").trim())
    .find(Boolean);
  if (direct) return direct;
  const fromId = String(session?.id || "").match(/-(\d{18,})$/);
  return fromId ? fromId[1] : "";
}

function createLiveCoachVmTransferTrigger({
  logger = null,
  fetchImpl = fetch,
  env = process.env,
  ringcxClient = null,
} = {}) {
  const enabled = boolEnv(env.LIVE_COACH_VM_TRANSFER_ENABLED);
  const agentAllowlist = new Set(
    String(env.LIVE_COACH_VM_TRANSFER_AGENT_ALLOWLIST || "")
      .split(",")
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean),
  );
  const phoneAllowlist = new Set(
    String(env.LIVE_COACH_VM_TRANSFER_PHONE_ALLOWLIST || "")
      .split(",")
      .map(digitsOnly)
      .filter(Boolean),
  );
  const targetExt = String(env.LIVE_COACH_VM_TRANSFER_TARGET_EXT || "98765").trim();
  const beepDelayMs = Math.max(0, Number(env.LIVE_COACH_VM_TRANSFER_BEEP_DELAY_MS ?? DEFAULT_BEEP_DELAY_MS) || 0);
  const fallbackAgentExtId = String(env.LIVE_COACH_VM_TRANSFER_AGENT_EXT_ID || "").trim();
  const mode = String(env.LIVE_COACH_VM_TRANSFER_MODE || "rc-transfer").trim().toLowerCase();
  const bargeHangupAfterMs = Math.max(0, Number(env.LIVE_COACH_VM_BARGE_HANGUP_AFTER_MS ?? DEFAULT_BARGE_HANGUP_AFTER_MS) || 0);
  const dispositionName = String(env.LIVE_COACH_VM_DISPOSITION_NAME || DEFAULT_DISPOSITION_NAME).trim();
  const rcBase = String(env.RING_CENTRAL_SERVER_URL || "https://platform.ringcentral.com").replace(/\/$/, "");
  const fired = new Set();
  const tokenCache = { value: null, exp: 0, inflight: null };
  let ringcxClientInstance = ringcxClient;

  if (enabled) {
    logger?.info?.("live_coach.vm_transfer.config", {
      enabled,
      mode,
      agentAllowlist: [...agentAllowlist],
      phoneAllowlist: [...phoneAllowlist],
      targetExt,
      beepDelayMs,
      bargeHangupAfterMs,
      dispositionName,
      fallbackAgentExtId: fallbackAgentExtId || null,
    });
  }

  function ringcx() {
    if (!ringcxClientInstance) {
      // Lazy so rc-transfer deployments never need RingCX voice creds loaded.
      const { createRingcxVoiceClient } = require("../../shared-integrations/src/ringcxVoiceClient");
      ringcxClientInstance = createRingcxVoiceClient();
    }
    return ringcxClientInstance;
  }

  async function token() {
    const now = Date.now();
    if (tokenCache.value && now < tokenCache.exp) return tokenCache.value;
    if (tokenCache.inflight) return tokenCache.inflight;
    tokenCache.inflight = (async () => {
      const basic = Buffer.from(`${env.RING_CENTRAL_CLIENT_ID}:${env.RING_CENTRAL_CLIENT_SECRET}`).toString("base64");
      const body = new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: env.RING_CENTRAL_JWT_TOKEN,
      });
      const r = await fetchImpl(`${rcBase}/restapi/oauth/token`, {
        method: "POST",
        headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: body.toString(),
      });
      const t = await r.text();
      if (!r.ok) throw new Error(`oauth ${r.status}: ${t.slice(0, 160)}`);
      const j = JSON.parse(t);
      tokenCache.value = j.access_token;
      tokenCache.exp = Date.now() + Math.max(60_000, ((Number(j.expires_in) || 3600) - 120) * 1000);
      return tokenCache.value;
    })();
    try {
      return await tokenCache.inflight;
    } finally {
      tokenCache.inflight = null;
    }
  }

  async function rc(method, endpoint, body) {
    const tok = await token();
    const r = await fetchImpl(`${rcBase}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${tok}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const t = await r.text();
    if (!r.ok) {
      const e = new Error(`${method} ${endpoint.split("?")[0]} ${r.status}: ${t.slice(0, 180)}`);
      e.status = r.status;
      throw e;
    }
    return t ? JSON.parse(t) : null;
  }

  // Find the agent extension's connected call and blind-transfer ITS PEER (the
  // CX bridge carrying the prospect/voicemail) to the target extension.
  async function transferAgentPeer(agentExtId) {
    const active = await rc("GET", `/restapi/v1.0/account/~/extension/${agentExtId}/active-calls?view=Detailed&perPage=5`);
    const rec = (active?.records || []).find(
      (row) => (row.telephonyStatus === "CallConnected" || row.result === "In Progress") && (row.telephonySessionId || row.sessionId),
    );
    if (!rec) throw new Error("no connected active-call on agent extension at trigger time");
    const tsId = rec.telephonySessionId || rec.sessionId;
    const session = await rc("GET", `/restapi/v1.0/account/~/telephony/sessions/${tsId}`);
    const parties = Array.isArray(session?.parties) ? session.parties : [];
    const mine = parties.find((p) => String(p.extensionId || "") === String(agentExtId) && p.status?.code === "Answered")
      || parties.find((p) => String(p.extensionId || "") === String(agentExtId));
    if (!mine?.id) throw new Error("agent party not found in telephony session");
    await rc("POST", `/restapi/v1.0/account/~/telephony/sessions/${tsId}/parties/${encodeURIComponent(mine.id)}/transfer`, {
      extensionNumber: targetExt,
    });
    return { telephonySessionId: tsId, partyId: mine.id, targetExt };
  }

  // ringcx-barge: dial the announcement ext INTO the UII as an audible
  // session, then optionally hang the whole call up once the message is done.
  async function bargeAnnouncement(uii) {
    const client = ringcx();
    await client.addSessionToCall(uii, { destination: targetExt, sessionType: "BARGEIN" });
    if (bargeHangupAfterMs > 0) {
      const timer = setTimeout(() => {
        Promise.resolve(client.hangupCall(uii)).then(
          () => logger?.info?.("live_coach.vm_transfer.hangup", { uii }),
          (error) => logger?.warn?.("live_coach.vm_transfer.hangup_failed", { uii, error: error.message }),
        );
      }, bargeHangupAfterMs);
      if (typeof timer.unref === "function") timer.unref();
    }
    return { uii, targetExt, bargeHangupAfterMs };
  }

  // ringcx-disposition: set the VM disposition — the dialer frees the agent
  // and the campaign workflow's on-disposition branch plays the announcement.
  // NOTE: `callback` is a REQUIRED query param on this endpoint; omitting it
  // is a bare 400 invalid.data.
  async function dispositionVoicemail(uii) {
    await ringcx().dispositionCall(uii, { disposition: dispositionName, callback: false });
    return { uii, disposition: dispositionName };
  }

  function agentMatchesAllowlist(metadata = {}) {
    const candidates = [
      metadata.agentEmail,
      metadata.agentExtension,
      metadata.agentExtensionId,
      metadata.agentName,
    ]
      .map((v) => String(v || "").trim().toLowerCase())
      .filter(Boolean);
    return candidates.some((value) => agentAllowlist.has(value));
  }

  function eligibility(session) {
    if (!enabled) return { ok: false, reason: "disabled" };
    // HARD agent gate: empty allowlist means never fire.
    if (!agentAllowlist.size) return { ok: false, reason: "empty-agent-allowlist" };
    const sessionId = String(session?.id || "");
    if (!sessionId) return { ok: false, reason: "no-session-id" };
    if (fired.has(sessionId)) return { ok: false, reason: "already-fired" };
    const metadata = session?.metadata || {};
    if (!agentMatchesAllowlist(metadata)) return { ok: false, reason: "agent-not-allowlisted" };
    const phone = digitsOnly(metadata.phone);
    if (phoneAllowlist.size && (!phone || !phoneAllowlist.has(phone))) {
      return { ok: false, reason: "phone-not-allowlisted", phone: phone || null };
    }
    if (mode === "ringcx-barge" || mode === "ringcx-disposition") {
      const uii = extractUii(session);
      if (!uii) return { ok: false, reason: "no-uii", phone: phone || null };
      return { ok: true, sessionId, phone: phone || null, uii };
    }
    const agentExtId = String(
      metadata.agentExtension || metadata.agentExtensionId || fallbackAgentExtId || "",
    ).trim();
    if (!agentExtId) return { ok: false, reason: "no-agent-extension" };
    return { ok: true, sessionId, phone: phone || null, agentExtId };
  }

  // Fire-and-forget; safe to call from the coach pipeline's voicemail-reject
  // paths. Returns true when a transfer was armed.
  function maybeFire(session, context = {}) {
    let check;
    try {
      check = eligibility(session);
    } catch {
      return false;
    }
    if (!check.ok) {
      if (enabled && check.reason !== "already-fired") {
        logger?.info?.("live_coach.vm_transfer.skipped", {
          sessionId: String(session?.id || "") || null,
          reason: check.reason,
          phone: check.phone || null,
        });
      }
      return false;
    }
    fired.add(check.sessionId);
    logger?.info?.("live_coach.vm_transfer.armed", {
      sessionId: check.sessionId,
      mode,
      phone: check.phone,
      agentExtId: check.agentExtId || null,
      uii: check.uii || null,
      targetExt,
      beepDelayMs,
      match: context.match || null,
      source: context.source || null,
    });
    const act = mode === "ringcx-disposition"
      ? () => dispositionVoicemail(check.uii)
      : mode === "ringcx-barge"
        ? () => bargeAnnouncement(check.uii)
        : () => transferAgentPeer(check.agentExtId);
    const timer = setTimeout(() => {
      act()
        .then((result) => {
          logger?.info?.("live_coach.vm_transfer.sent", { sessionId: check.sessionId, mode, ...result });
        })
        .catch((error) => {
          logger?.warn?.("live_coach.vm_transfer.failed", { sessionId: check.sessionId, mode, error: error.message });
        });
    }, beepDelayMs);
    if (typeof timer.unref === "function") timer.unref();
    return true;
  }

  return { maybeFire, enabled, transferAgentPeer, bargeAnnouncement, dispositionVoicemail };
}

module.exports = { createLiveCoachVmTransferTrigger };
