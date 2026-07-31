"use strict";

// Long-call recordings for the nightly board (Mickey 2026-07-27: "try to
// get downloads of stuff from callrail and phone burner and just attach a
// few").
//
// ── THE HARD RULE ───────────────────────────────────────────────────────
// ALLOW-LIST ONLY. `callrail` and `phoneburner` are the two platforms that
// may ever surface a recording. EX recordings must NEVER appear — and this
// is written as an allow-list precisely so that a NEW platform is excluded
// by default rather than needing to be remembered and denied.
//
// Ops trackers (client contact, review requests, transcript lines) are not
// marketing calls and are excluded from the board separately.

const { createCallrailClient } = require("../../shared-integrations/src");

const ALLOWED_PLATFORMS = Object.freeze(["callrail", "phoneburner"]);

// Same exclusions the metrics read uses — operations traffic, never a
// marketing response.
const OPS_TRACKER_PATTERNS = [
  /client contact/i, /review request/i, /transcripts/i,
  /f\/u text/i, /yellow line text/i, /prospect text message/i,
];

function isOpsTracker(sourceName) {
  const s = String(sourceName || "");
  return OPS_TRACKER_PATTERNS.some((re) => re.test(s));
}

function assertAllowedPlatform(platform) {
  const p = String(platform || "").toLowerCase();
  if (!ALLOWED_PLATFORMS.includes(p)) {
    throw new Error(`recording platform "${platform}" is not on the allow-list`);
  }
  return p;
}

/**
 * CallRail long calls for the day, with pre-authenticated listen URLs.
 * `getCallRecording` returns a redirect URL that needs no further auth —
 * good as a link AND as a download source.
 */
async function listCallrailLongCalls({
  domain = "TAG", dateKey, minDurationSec = 300, maxDurationSec = null,
  limit = 8, includeOps = false, order = "desc",
} = {}) {
  const client = createCallrailClient(domain);
  const res = await client.listInboundCallsForRange({ startDate: dateKey, endDate: dateKey });
  const calls = res?.calls || [];
  const eligible = calls
    .filter((c) => Number(c.duration) >= minDurationSec)
    .filter((c) => maxDurationSec == null || Number(c.duration) <= maxDurationSec)
    .filter((c) => includeOps || !isOpsTracker(c.source_name))
    .sort((a, b) => (order === "asc"
      ? Number(a.duration) - Number(b.duration)
      : Number(b.duration) - Number(a.duration)))
    .slice(0, limit);

  const out = [];
  for (const c of eligible) {
    let listenUrl = null;
    try {
      const rec = await client.getCallRecording(c.id);
      listenUrl = rec?.url || null;
    } catch { /* a missing recording must not fail the night */ }
    out.push({
      platform: "callrail",
      callId: c.id,
      source: c.source_name || null,
      caller: c.customer_name || c.customer_phone_number || null,
      phone: c.customer_phone_number || null,
      startedAt: c.start_time || null,
      durationSec: Number(c.duration) || 0,
      minutes: Math.round((Number(c.duration) || 0) / 6) / 10,
      listenUrl,
      answered: c.answered !== false,
    });
  }
  return out;
}

/**
 * PhoneBurner long dials for the day, straight off DailyDial attempts.
 *
 * The recording now rides in on the call callback (2026-07-31) instead of
 * needing a dialSession lookup, so these carry a listen link like the CallRail
 * side does. The lookup route was never viable anyway: the service account
 * 404s on getDialSession for the agents' own sessions, because they dial on
 * their own seats.
 *
 * The link is taken from the LONGEST attempt on the case — the same attempt
 * whose agent and duration are already reported here, so the three always
 * describe one call rather than three different ones.
 */
async function listPhoneBurnerLongDials({ dateKey, minDurationSec = 300, limit = 5 } = {}) {
  const DailyDial = require("../../shared-models/src/DailyDial");
  const rows = await DailyDial.find({ dateKey, durationSeconds: { $gte: minDurationSec } })
    .select("caseId domain durationSeconds lastOutcome attempts recordingUrl")
    .sort({ durationSeconds: -1 }).limit(limit).lean();
  return rows.map((r) => {
    const longest = (r.attempts || [])
      .slice()
      .sort((a, b) => Number(b.durationSeconds || 0) - Number(a.durationSeconds || 0))[0] || null;
    return {
      platform: "phoneburner",
      caseId: r.caseId,
      domain: String(r.domain || "").toUpperCase(),
      agent: longest?.agentId || null,
      providerCallId: longest?.providerCallId || null,
      outcome: r.lastOutcome || null,
      durationSec: Number(r.durationSeconds) || 0,
      minutes: Math.round((Number(r.durationSeconds) || 0) / 6) / 10,
      // WIRED 2026-07-31. The recording arrives on the call callback now, so
      // it is already on the attempt; no session lookup, which was never
      // going to work — the service account 404s on the agents' sessions.
      // Attempt first, then the doc-level field the projection also writes.
      listenUrl: longest?.recordingUrl || r.recordingUrl || null,
      listenNote: (longest?.recordingUrl || r.recordingUrl)
        ? null
        : "no recording on this attempt yet — it arrives after the call ends",
    };
  });
}

/**
 * Download a few recordings for attachment. Bounded hard: recordings are
 * large and this rides an email.
 *
 * ATTACHMENTS ARE OPTIONAL AND OFF BY DEFAULT. Verified live 2026-07-28:
 * the CallRail recording URL is genuinely pre-authenticated — Mickey
 * downloaded a 10-minute call from the email with no CallRail login and no
 * auth loop. So a LINK delivers the same audio at zero bytes, works on a
 * phone, and covers EVERY call in the board rather than the two or three
 * that would fit inside a message.
 *
 * Attaching is therefore a preference, not a mechanism: a 40-minute deal
 * call is ~20MB and would bounce off Gmail/Outlook limits anyway. When
 * enabled this stays smallest-first under a hard message budget, and any
 * skip is recorded with a reason — the link is already in the board either
 * way, so nothing is ever silently lost.
 *
 * UNKNOWN: whether the access_key in those URLs expires. If old emails ever
 * go dead, the fix is recordingArchiveService (Drive archive +
 * driveWebViewLink), which already backs CX recordings.
 */
async function downloadRecordings(calls = [], {
  max = 3,
  maxBytes = 15 * 1024 * 1024,
  totalBudgetBytes = 20 * 1024 * 1024,
} = {}) {
  const attachments = [];
  const skipped = [];
  let spent = 0;
  const candidates = [...calls].sort((a, b) => (a.durationSec || 0) - (b.durationSec || 0));
  for (const call of candidates) {
    if (attachments.length >= max || spent >= totalBudgetBytes) break;
    assertAllowedPlatform(call.platform);
    if (!call.listenUrl) { skipped.push({ call: call.callId, reason: "no recording url" }); continue; }
    try {
      const res = await fetch(call.listenUrl, { redirect: "follow" });
      if (!res.ok) { skipped.push({ call: call.callId, reason: `http ${res.status}` }); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes || spent + buf.length > totalBudgetBytes) {
        skipped.push({
          call: call.callId,
          reason: `${Math.round(buf.length / 1024 / 1024)}MB — over ${buf.length > maxBytes ? "per-file" : "message"} budget (listen link in board)`,
        });
        continue;
      }
      spent += buf.length;
      const safeSource = String(call.source || "call").replace(/[^a-z0-9]+/gi, "-").slice(0, 40);
      attachments.push({
        filename: `${call.minutes}min-${safeSource}-${String(call.callId).slice(-8)}.mp3`,
        content: buf,
        contentType: res.headers.get("content-type") || "audio/mpeg",
      });
    } catch (error) {
      skipped.push({ call: call.callId, reason: String(error.message).slice(0, 80) });
    }
  }
  return { attachments, skipped, bytes: spent };
}

/**
 * The calls worth hearing: the ones that BECAME DEALS today.
 *
 * A random 5-minute call is noise (Mickey 2026-07-27: "you sent me 3 5
 * minute calls those arent particularly useful"). The inbound call from a
 * customer who then paid is the one with something to learn in it — how the
 * pitch landed, what the objection was, who closed it.
 *
 * Matches today's CallRail calls against the phone numbers of cases that
 * took an initial payment, newest-longest first.
 */
async function listDealCalls({ domain = "TAG", dateKey, deals = [], minDurationSec = 60 } = {}) {
  const phones = new Map();   // normalized phone → deal
  for (const d of deals) {
    const via = String(d.sourceVia || "");
    const m = via.match(/callrail:(\d{10,})/);
    if (m) phones.set(m[1], d);
  }
  if (!phones.size) return [];

  const client = createCallrailClient(domain);
  const res = await client.listInboundCallsForRange({ startDate: dateKey, endDate: dateKey });
  const digits = (v) => String(v || "").replace(/\D/g, "").slice(-10);

  const out = [];
  for (const c of res?.calls || []) {
    const deal = phones.get(digits(c.customer_phone_number));
    if (!deal || Number(c.duration) < minDurationSec) continue;
    let listenUrl = null;
    try {
      const rec = await client.getCallRecording(c.id);
      listenUrl = rec?.url || null;
    } catch { /* a missing recording must not fail the night */ }
    out.push({
      platform: "callrail",
      callId: c.id,
      source: c.source_name || null,
      caller: c.customer_name || c.customer_phone_number || null,
      dealCaseId: deal.caseId,
      dealName: deal.name || null,
      dealAmount: deal.amount,
      officer: deal.officer || null,
      durationSec: Number(c.duration) || 0,
      minutes: Math.round((Number(c.duration) || 0) / 6) / 10,
      listenUrl,
      isDealCall: true,
    });
  }
  return out.sort((a, b) => b.durationSec - a.durationSec);
}


// ── NOTABLE CALLS ───────────────────────────────────────────────────────
// Mickey 2026-07-28: "we need to be grabbing links and then look for post
// dates, deals and anything over 10 minutes and include those links in the
// report."
//
// Recordings are a COACHING tool, not a marketing one — the point is
// specific feedback to settlement officers on their attempts. So the
// selector is about what is worth a human's ten minutes:
//   DEAL      the call became an initial payment
//   POSTDATE  the case moved to POST DATE (a promise, not yet money)
//   LONG      over ten minutes — something happened in there
const LONG_CALL_SECONDS = 600;

/** PhoneBurner recordings for a day, straight off the dial sessions.
 * recording_url is a PUBLIC mp3 — same link-not-attach treatment as
 * CallRail. Bounded and sequential; PhoneBurner is not a bulk API. */
async function listPhoneBurnerRecordings({
  dateKey, client, minDurationSec = 0, maxSessions = 12, logger = null,
} = {}) {
  if (!client) return [];
  const out = [];
  try {
    const list = await client.listDialSessions({
      dateStart: dateKey, dateEnd: dateKey, pageSize: maxSessions,
    });
    if (!list?.ok) return [];
    for (const session of (list.sessions || []).slice(0, maxSessions)) {
      const detail = await client.getDialSession(session.dialSessionId, { includeRecording: true });
      if (!detail?.ok) continue;
      for (const call of detail.session?.calls || []) {
        if (!call.recordingUrl) continue;
        const started = Date.parse(String(call.startedAt || "").replace(" ", "T") + "Z");
        const ended = Date.parse(String(call.endedAt || "").replace(" ", "T") + "Z");
        const durationSec = Number.isFinite(started) && Number.isFinite(ended)
          ? Math.max(0, Math.round((ended - started) / 1000)) : 0;
        if (durationSec < minDurationSec) continue;
        out.push({
          platform: "phoneburner",
          callId: call.callId,
          agentUserId: call.userId,
          phone: call.phone,
          durationSec,
          minutes: Math.round(durationSec / 6) / 10,
          connected: call.connected,
          disposition: call.disposition || null,
          listenUrl: call.recordingUrl,
          hasTranscript: Boolean(call.transcript || call.transcriptId),
        });
      }
    }
  } catch (error) {
    logger?.warn?.("phoneburner_recordings.failed", { dateKey, error: String(error.message).slice(0, 140) });
  }
  return out;
}

/** Digits-only last-10 for phone matching across platforms. */
function last10(v) { return String(v || "").replace(/[^0-9]/g, "").slice(-10); }

/**
 * The calls worth putting in front of a human, tagged with WHY.
 *
 * `deals` and `postDateCases` carry a phone (from the attribution seed /
 * case fold); anything over LONG_CALL_SECONDS qualifies on length alone.
 */
async function listNotableCalls({
  domain = "TAG", dateKey, deals = [], postDateCases = [],
  phoneBurnerClient = null, longCallSeconds = LONG_CALL_SECONDS, logger = null,
} = {}) {
  const reasonByPhone = new Map();
  const tag = (phone, reason, meta) => {
    const key = last10(phone);
    if (!key) return;
    if (!reasonByPhone.has(key)) reasonByPhone.set(key, { reasons: new Set(), meta: {} });
    const entry = reasonByPhone.get(key);
    entry.reasons.add(reason);
    Object.assign(entry.meta, meta || {});
  };
  for (const d of deals) {
    const m = String(d.sourceVia || "").match(/callrail:([0-9]{10,})/);
    if (m) tag(m[1], "DEAL", { caseId: d.caseId, name: d.name, amount: d.amount, officer: d.officer });
  }
  for (const p of postDateCases) tag(p.phone, "POSTDATE", { caseId: p.caseId, name: p.name, officer: p.officer });

  const notable = [];

  // ── CallRail side ──
  try {
    const cr = createCallrailClient(domain);
    const res = await cr.listInboundCallsForRange({ startDate: dateKey, endDate: dateKey });
    for (const c of res?.calls || []) {
      const dur = Number(c.duration) || 0;
      const hit = reasonByPhone.get(last10(c.customer_phone_number));
      const reasons = new Set(hit ? [...hit.reasons] : []);
      if (dur >= longCallSeconds) reasons.add("LONG");
      if (!reasons.size) continue;
      if (isOpsTracker(c.source_name) && !hit) continue;   // ops noise unless it's a real case
      let listenUrl = null;
      try { listenUrl = (await cr.getCallRecording(c.id))?.url || null; } catch { /* keep going */ }
      notable.push({
        platform: "callrail", callId: c.id,
        reasons: [...reasons],
        source: c.source_name || null,
        caller: c.customer_name || c.customer_phone_number || null,
        phone: c.customer_phone_number || null,
        durationSec: dur, minutes: Math.round(dur / 6) / 10,
        startedAt: c.start_time || null,
        listenUrl,
        ...(hit?.meta || {}),
      });
    }
  } catch (error) {
    logger?.warn?.("notable_calls.callrail_failed", { dateKey, error: String(error.message).slice(0, 140) });
  }

  // ── PhoneBurner side (coaching: agent attempts) ──
  const pb = await listPhoneBurnerRecordings({ dateKey, client: phoneBurnerClient, logger });
  for (const call of pb) {
    const hit = reasonByPhone.get(last10(call.phone));
    const reasons = new Set(hit ? [...hit.reasons] : []);
    if (call.durationSec >= longCallSeconds) reasons.add("LONG");
    if (!reasons.size) continue;
    notable.push({ ...call, reasons: [...reasons], ...(hit?.meta || {}) });
  }

  const rank = (r) => (r.includes("DEAL") ? 0 : r.includes("POSTDATE") ? 1 : 2);
  // Mark WHICH call earned the attribution. Every call from a deal's number
  // gets tagged DEAL, so a case with three calls shows three DEAL rows and
  // the reader cannot tell which one the source came from. The attribution
  // rule (Mickey: "longest call on the day the deal closed") picks exactly
  // one — surface it, using the SAME function the snapshot writer uses so the
  // board and the stored sourceAtSale can never disagree.
  try {
    const { pickAttributionCall } = require("./reportOpsService");
    const byCase = new Map();
    for (const c of notable) {
      if (!c.caseId || !(c.reasons || []).includes("DEAL")) continue;
      const key = String(c.caseId);
      if (!byCase.has(key)) byCase.set(key, []);
      byCase.get(key).push(c);
    }
    for (const calls of byCase.values()) {
      const { call } = pickAttributionCall(calls, dateKey);
      if (call) {
        call.isAttributionCall = true;
        call.reasons = [...new Set([...(call.reasons || []), "SOURCE"])];
      }
    }
  } catch (error) {
    logger?.warn?.("notable_calls.attribution_tag_failed", { error: String(error.message).slice(0, 120) });
  }

  return notable.sort((a, b) => rank(a.reasons) - rank(b.reasons) || b.durationSec - a.durationSec);
}

module.exports = {
  ALLOWED_PLATFORMS,
  LONG_CALL_SECONDS,
  listNotableCalls,
  listPhoneBurnerRecordings,
  listDealCalls,
  assertAllowedPlatform,
  downloadRecordings,
  isOpsTracker,
  listCallrailLongCalls,
  listPhoneBurnerLongDials,
};
