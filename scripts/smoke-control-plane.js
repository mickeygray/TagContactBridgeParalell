#!/usr/bin/env node
"use strict";

// Smoke test for the control-plane HTTP surface. Runs against any
// deployed instance (local, ngrok, Linux box) and reports green / yellow
// / red for each endpoint.
//
// Run it from the Ubuntu box right after starting the control-plane to
// confirm everything is mounted and reachable.
//
// Usage:
//   # Routes-only check — confirms every endpoint is mounted. Protected
//   # routes return 401 (yellow but expected); public routes return 200.
//   # LD intake routes get a real payload and write a marked smoke lead
//   # to Mongo (set SMOKE_WRITE_LD=false to skip those).
//   node scripts/smoke-control-plane.js
//
//   # Authenticated check — protected routes should return 200. Get the
//   # token from a logged-in browser session: DevTools → Application →
//   # Local Storage → look for the JWT.
//   SMOKE_TOKEN="eyJhbG..." node scripts/smoke-control-plane.js
//
//   # Tailor to your environment:
//   SMOKE_BASE_URL=https://tagcontactbridge.ngrok.app \   # control-plane
//   SMOKE_INBOUND_BASE_URL=http://localhost:4001 \        # inbound gateway
//   SMOKE_TOKEN="..." \
//   SMOKE_DOMAIN=WYNN \
//   SMOKE_EXTENSION_ID=63756126004 \
//   SMOKE_CASE_ID=112004 \
//   SMOKE_DRIVE_FILE_ID=1abc... \
//   SMOKE_LEAD_WEBHOOK_SECRET=<matches server LEAD_WEBHOOK_SECRET> \
//   SMOKE_LD_POSTING_AUTH=<matches server LD_POSTING_AUTH if used> \
//   SMOKE_LD_CUSTOM_CODE=GS03RB7W \
//   SMOKE_WRITE_LD=true \
//   SMOKE_BUILD_AGENT_QUEUES=true \
//   SMOKE_QUEUE_AGENT_EXTENSIONS=63756126004,63730035004 \
//   node scripts/smoke-control-plane.js
//
//   # Windows ngrok handoff after a clean smoke. This only talks to the
//   # local ngrok agent API; it does not restart Windows services.
//   SMOKE_ENSURE_NGROK_TUNNEL=true \
//   SMOKE_GO_LIVE_DOMAIN=tagcontactbridge.ngrok.app \
//   node scripts/smoke-control-plane.js
//
// Side effects:
//   - The LD pre-ping + lead checks write to Mongo (a PrePing row + a
//     LeadCadence/MasterProspect/CaseProfile row). Smoke leads are
//     marked "Smoke PrePing <runId>" / "Smoke LD Custom <runId>" and
//     carry synthetic caseIds in the 999_000_000+ range so they're
//     easy to grep and purge later.
//   - The LD payloads use SMOKE_CONTACT_EMAIL + SMOKE_CONTACT_PHONE
//     (default mgray@taxadvocategroup.com / 3106665997) so the
//     resulting LeadCadence row's SMS + email cadence drops actual
//     template content to a real, monitorable target. Override with
//     SMOKE_CONTACT_EMAIL / SMOKE_CONTACT_PHONE env vars before
//     running if you don't want mgray to get the texts.
//   - All other checks are read-only.
//
// Exit code:
//   0 = no RED results (all green or yellow-but-expected)
//   1 = at least one RED (unexpected status or 5xx)
//
// Auto-promote on success (optional):
//   If SMOKE_PROMOTE_TO_LIVE=true and ALL checks come back green or
//   yellow, the script invokes ops/linux/go-live-linux.sh with
//   DOMAIN=tagcontactbridge.ngrok.app (override via
//   SMOKE_GO_LIVE_DOMAIN). That script:
//     1. Writes NGROK_DOMAIN=<domain> into .env
//     2. systemctl restart parallel-ngrok  (swaps from
//        tag-webhook.ngrok.app → tagcontactbridge.ngrok.app)
//     3. Waits for the tunnel to come up + verifies public runtime
//        matches local
//     4. Flips PARALLEL_RC_SUSPENDED=false
//     5. systemctl restart parallel-{control-plane,ringcentral-cx,
//        outbound-gateway,inbound-gateway}
//   Needs sudo. The smoke uses `sudo -n` (non-interactive) so it'll
//   either work (NOPASSWD configured) or fail cleanly with a message
//   telling the operator to run the go-live by hand. Defaults OFF so
//   the smoke can be re-run safely without flipping prod traffic.
//
// Windows cutover note:
//   SMOKE_ENSURE_NGROK_TUNNEL=true can swap the local ngrok agent to a
//   reserved domain if the agent is already running. Restarting NSSM
//   services (ParallelNginx / ParallelNgrok / app workers) still needs
//   an elevated PowerShell, so use SMOKE_POST_SUCCESS_COMMAND only from
//   a shell that has permission to run that command.

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
require("dotenv").config({
  path: path.resolve(__dirname, "..", ".env"),
});

const BASE_URL = String(process.env.SMOKE_BASE_URL || "http://localhost:5001").replace(
  /\/+$/,
  "",
);
// Inbound gateway is a separate service on a separate port (4001 by
// default). LD intake routes live there, NOT on the control-plane. The
// smoke checks them via this URL.
const INBOUND_BASE_URL = String(
  process.env.SMOKE_INBOUND_BASE_URL || "http://localhost:4001",
).replace(/\/+$/, "");
const TOKEN = String(process.env.SMOKE_TOKEN || "").trim();
const DOMAIN = String(process.env.SMOKE_DOMAIN || "WYNN").toUpperCase();
const EXTENSION_ID = String(process.env.SMOKE_EXTENSION_ID || "63756126004");
const CASE_ID = String(process.env.SMOKE_CASE_ID || "112004");
const DRIVE_FILE_ID = String(process.env.SMOKE_DRIVE_FILE_ID || "");
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 15000);
// Auto-promote: if every smoke check passes (no red), run the Linux
// go-live script to swap ngrok from tag-webhook → tagcontactbridge and
// restart all services. Defaults OFF so the smoke is safe to re-run
// without flipping prod traffic. Set SMOKE_PROMOTE_TO_LIVE=true on the
// run that should actually cut over.
const PROMOTE_TO_LIVE = String(process.env.SMOKE_PROMOTE_TO_LIVE || "false").toLowerCase() === "true";
const GO_LIVE_DOMAIN = String(process.env.SMOKE_GO_LIVE_DOMAIN || "tagcontactbridge.ngrok.app").trim();
const GO_LIVE_SCRIPT = String(
  process.env.SMOKE_GO_LIVE_SCRIPT || "ops/linux/go-live-linux.sh",
).trim();
const BUILD_AGENT_QUEUES =
  String(process.env.SMOKE_BUILD_AGENT_QUEUES || "true").toLowerCase() !== "false";
const QUEUE_PREVIEW_ONLY =
  String(process.env.SMOKE_QUEUE_PREVIEW_ONLY || "true").toLowerCase() !== "false";
const ALLOW_MUTATING_QUEUE_BUILD =
  String(process.env.SMOKE_ALLOW_MUTATING_QUEUE_BUILD || "false").toLowerCase() === "true";
const QUEUE_AGENT_EXTENSIONS = Array.from(
  new Set(
    String(process.env.SMOKE_QUEUE_AGENT_EXTENSIONS || EXTENSION_ID)
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ),
);
const QUEUE_MAX_AGENTS = Number(
  process.env.SMOKE_QUEUE_MAX_AGENTS || QUEUE_AGENT_EXTENSIONS.length || 1,
);
const QUEUE_PREVIEW_LIMIT = Number(process.env.SMOKE_QUEUE_PREVIEW_LIMIT || 3);
const QUEUE_MIN_TOTAL = Number(process.env.SMOKE_QUEUE_MIN_TOTAL || 1);
const ENSURE_NGROK_TUNNEL =
  String(process.env.SMOKE_ENSURE_NGROK_TUNNEL || "false").toLowerCase() === "true";
const POST_SUCCESS_COMMAND = String(process.env.SMOKE_POST_SUCCESS_COMMAND || "").trim();
// LD intake secret. If LEAD_WEBHOOK_SECRET is set on the server, the
// smoke must pass the same value here so the LD pre-ping and lead
// routes don't 401. If unset on both sides, the routes are open and
// the smoke still gets 2xx.
const LD_WEBHOOK_SECRET = String(process.env.SMOKE_LEAD_WEBHOOK_SECRET || "").trim();
// LD posting auth — alternative auth path used by some vendors. Only
// needed if you've configured LD_POSTING_AUTH / OPTA_LD_POSTING_AUTH
// on the server side. Sent in the request body as `auth`.
const LD_POSTING_AUTH = String(process.env.SMOKE_LD_POSTING_AUTH || "").trim();
// LD subsource codes — the smoke pre-ping + lead body include "source ID"
// set to the LD CUSTOM code so the intake stamps routeCampaignKey=ld-custom
// and we can verify the new LD split end-to-end.
const LD_CUSTOM_CODE = String(process.env.SMOKE_LD_CUSTOM_CODE || "GS03RB7W").trim();

// The LD lead and pre-ping endpoints WRITE to Mongo. Default true so
// the smoke is end-to-end; set SMOKE_WRITE_LD=false to skip and just
// poke the rest of the surface. Smoke leads are marked with name
// "Smoke LD Custom" + a synthetic caseId starting at 999_000_000 so
// they're easy to grep and purge if needed.
const WRITE_LD = String(process.env.SMOKE_WRITE_LD || "true").toLowerCase() !== "false";
const SMOKE_RUN_ID = Date.now();
const SMOKE_CASE_ID_BASE = 999_000_000;
// Contact fields the smoke LD payloads use. Default to operator
// (mgray) so the resulting LeadCadence row fires SMS + email content
// to a real, monitorable target. The Logics create call will dedupe
// against the existing record for this email — that's expected,
// LeadCadence still lands and the SMS/email channels still fire.
const SMOKE_CONTACT_EMAIL = String(
  process.env.SMOKE_CONTACT_EMAIL || "mgray@taxadvocategroup.com",
).trim();
const SMOKE_CONTACT_PHONE = String(
  process.env.SMOKE_CONTACT_PHONE || "3106665997",
).trim();
const SMOKE_CONTACT_FIRST = String(
  process.env.SMOKE_CONTACT_FIRST || "Mickey",
).trim();
const SMOKE_CONTACT_LAST = String(
  process.env.SMOKE_CONTACT_LAST || "Gray",
).trim();

// Each check is { name, method, path, body?, public? }
// - public: true means no auth needed — expect 200 always.
// - public: false (default) means requires auth — expect 200 with token,
//   401 without.
// - skipIf: function(env) => boolean — skip the check when true (e.g.
//   recording playback needs SMOKE_DRIVE_FILE_ID).
const CHECKS = [
  // ── Public / health ───────────────────────────────────────────────
  { name: "GET /",                                method: "GET",  path: "/",                            publicRoute: true },
  { name: "GET /api/client/runtime",              method: "GET",  path: "/api/client/runtime",          publicRoute: true },

  // ── Admin: accounts ──────────────────────────────────────────────
  { name: "GET /api/admin/accounts",              method: "GET",  path: "/api/admin/accounts" },
  { name: "GET /api/admin/accounts/today-dials",  method: "GET",  path: `/api/admin/accounts/today-dials?domain=${DOMAIN}` },

  // ── Admin: call review (new this session) ────────────────────────
  {
    name: "GET /api/admin/call-review/agent/:ext/today",
    method: "GET",
    path: `/api/admin/call-review/agent/${encodeURIComponent(EXTENSION_ID)}/today?domain=${DOMAIN}`,
  },
  {
    name: "GET /api/admin/call-review/case/:caseId/today",
    method: "GET",
    path: `/api/admin/call-review/case/${encodeURIComponent(CASE_ID)}/today?domain=${DOMAIN}`,
  },

  // ── Admin: runtime + consent ─────────────────────────────────────
  { name: "GET /api/admin/runtime/control-plane", method: "GET",  path: "/api/admin/runtime/control-plane" },
  { name: "GET /api/admin/consent-stats",         method: "GET",  path: "/api/admin/consent-stats" },

  // ── CX reads (user-level auth) ───────────────────────────────────
  { name: "GET /api/read/cx/call-queue/:domain",  method: "GET",  path: `/api/read/cx/call-queue/${DOMAIN}` },

  // ── Recording playback (only if a fileId is supplied) ───────────
  {
    name: "GET /api/read/cx/recordings/play/:fileId",
    method: "GET",
    path: `/api/read/cx/recordings/play/${encodeURIComponent(DRIVE_FILE_ID || "noop")}`,
    skipIf: () => !DRIVE_FILE_ID,
  },

  // ── Sales trainer ────────────────────────────────────────────────
  { name: "GET /api/sales-trainer/session/presets", method: "GET", path: "/api/sales-trainer/session/presets" },

  // ── Inbound LD endpoints — full JSON payloads, expect 200/202 ────
  // These hit the inbound-gateway (port 4001), not the control-plane.
  // The body shape mirrors `ops/tmp-inbound-smoke/tina-ld.json` plus the
  // LD CUSTOM tracking code so the intake stamps routeCampaignKey=ld-custom.
  // x-webhook-secret carries the LEAD_WEBHOOK_SECRET when configured;
  // `auth` in the body carries the LD posting auth when that route is
  // used instead. Both are optional — if neither is configured on the
  // server, the routes are open.
  {
    name: "POST /api/inbound/ld/pre-ping (smoke → mgray contact)",
    method: "POST",
    host: INBOUND_BASE_URL,
    path: "/api/inbound/ld/pre-ping",
    body: {
      name: `Smoke PrePing ${SMOKE_RUN_ID}`,
      firstName: SMOKE_CONTACT_FIRST,
      lastName: `${SMOKE_CONTACT_LAST} (smoke ${SMOKE_RUN_ID})`,
      email: SMOKE_CONTACT_EMAIL,
      phone: SMOKE_CONTACT_PHONE,
      state: "CA",
      caseId: SMOKE_CASE_ID_BASE + 1,
      company: "WYNN",
      domain: "WYNN",
      "source ID": LD_CUSTOM_CODE,
      ...(LD_POSTING_AUTH ? { auth: LD_POSTING_AUTH } : {}),
    },
    headers: LD_WEBHOOK_SECRET ? { "x-webhook-secret": LD_WEBHOOK_SECRET } : {},
    publicRoute: true,                    // no admin token; webhook auth in headers/body
    acceptStatuses: [200, 202],           // route returns 202 by default
    skipIf: () => !WRITE_LD,
  },
  {
    name: "POST /api/inbound/ld/lead (LD CUSTOM -> mgray contact)",
    method: "POST",
    host: INBOUND_BASE_URL,
    path: "/api/inbound/ld/lead",
    body: {
      // Real contact on the smoke payload so the LeadCadence row this
      // creates fires its SMS + email templates against a phone/inbox
      // the operator actually controls.
      //
      // CRITICAL: the synthetic `caseId` below (999_000_002) is what
      // lets this work without Logics. ensureCaseId in the intake
      // short-circuits when a caseId is already on the payload — so
      // the Logics createCase call (the ONLY Logics call in the LD
      // intake path) is never made. That's the difference between
      // "this lands a cadence row" vs. "Logics throws a duplicate and
      // the intake aborts before LeadCadence." Don't strip caseId
      // from this body or the whole pipeline breaks on mgray dups.
      name: `Smoke LD Custom ${SMOKE_RUN_ID}`,
      firstName: SMOKE_CONTACT_FIRST,
      lastName: `${SMOKE_CONTACT_LAST} (smoke ${SMOKE_RUN_ID})`,
      email: SMOKE_CONTACT_EMAIL,
      phone: SMOKE_CONTACT_PHONE,
      state: "CA",
      city: "Los Angeles",
      caseId: SMOKE_CASE_ID_BASE + 2,
      company: "WYNN",
      domain: "WYNN",
      "source ID": LD_CUSTOM_CODE,
      ...(LD_POSTING_AUTH ? { auth: LD_POSTING_AUTH } : {}),
    },
    headers: LD_WEBHOOK_SECRET ? { "x-webhook-secret": LD_WEBHOOK_SECRET } : {},
    publicRoute: true,
    acceptStatuses: [200, 202],
    skipIf: () => !WRITE_LD,
  },

  // ── After-hours bypass for the SMS/email cadence on this lead ────
  // The LD lead just landed and the dispatcher will try to fire SMS +
  // email on its next tick. By default the contact-timing gate
  // (quiet hours / weekday / TCPA windows) will defer the SMS if we're
  // after hours. This call flips a per-lead bypass flag — global
  // policy is unchanged, only this specific row skips the gate. Needs
  // SMOKE_TOKEN with admin scope; without a token we can't reach the
  // endpoint and the lead just defers like any other.
  {
    name: "POST /api/admin/cadence/:domain/:caseId/bypass-channel-timing",
    method: "POST",
    path: `/api/admin/cadence/WYNN/${SMOKE_CASE_ID_BASE + 2}/bypass-channel-timing`,
    body: { channels: ["sms", "email"] },
    acceptStatuses: [200],
    skipIf: () => !WRITE_LD || !TOKEN,
  },
];

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";

function tone(s, color) {
  return process.stdout.isTTY ? `${color}${s}${RESET}` : s;
}

async function callOne(check) {
  const host = check.host || BASE_URL;
  const url = `${host}${check.path}`;
  const headers = { Accept: "application/json" };
  if (TOKEN && !check.publicRoute) headers.Authorization = `Bearer ${TOKEN}`;
  if (check.body) headers["Content-Type"] = "application/json";
  if (check.headers && typeof check.headers === "object") {
    for (const [k, v] of Object.entries(check.headers)) {
      if (v != null && v !== "") headers[k] = String(v);
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      method: check.method,
      headers,
      body: check.body ? JSON.stringify(check.body) : undefined,
      signal: controller.signal,
      redirect: "manual",
    });
    return {
      status: res.status,
      elapsedMs: Date.now() - startedAt,
      ok: true,
    };
  } catch (err) {
    return {
      status: null,
      elapsedMs: Date.now() - startedAt,
      ok: false,
      error: err?.name === "AbortError" ? "timeout" : err?.message || String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function callJson(check) {
  const host = check.host || BASE_URL;
  const url = `${host}${check.path}`;
  const headers = { Accept: "application/json" };
  if (TOKEN && !check.publicRoute) headers.Authorization = `Bearer ${TOKEN}`;
  if (check.body) headers["Content-Type"] = "application/json";
  if (check.headers && typeof check.headers === "object") {
    for (const [k, v] of Object.entries(check.headers)) {
      if (v != null && v !== "") headers[k] = String(v);
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      method: check.method,
      headers,
      body: check.body ? JSON.stringify(check.body) : undefined,
      signal: controller.signal,
      redirect: "manual",
    });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return {
      status: res.status,
      elapsedMs: Date.now() - startedAt,
      ok: true,
      body,
    };
  } catch (err) {
    return {
      status: null,
      elapsedMs: Date.now() - startedAt,
      ok: false,
      error: err?.name === "AbortError" ? "timeout" : err?.message || String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function classify(check, result) {
  if (!result.ok) return { tone: "red", label: "CONN", note: result.error };
  const status = result.status;
  const acceptList = Array.isArray(check.acceptStatuses) ? check.acceptStatuses : [200];

  // 2xx that we accept is green
  if (acceptList.includes(status)) return { tone: "green", label: String(status) };

  // 3xx redirect — for HTML-serving root routes that may redirect to /login
  if (status >= 300 && status < 400 && check.publicRoute) {
    return { tone: "green", label: String(status), note: "redirect" };
  }

  // Auth-protected route + no token + 401 = yellow (mounted, protecting)
  if (status === 401 && !check.publicRoute && !TOKEN) {
    return { tone: "yellow", label: "401", note: "auth required (mounted)" };
  }

  // Auth-protected route + token + 401/403 — token might be wrong
  if ((status === 401 || status === 403) && !check.publicRoute && TOKEN) {
    return { tone: "red", label: String(status), note: "token rejected" };
  }

  // Recording playback with placeholder fileId returns 404 — yellow
  if (status === 404 && check.path.includes("/recordings/play/")) {
    return { tone: "yellow", label: "404", note: "fileId not in archive" };
  }

  // 5xx is always red
  if (status >= 500) return { tone: "red", label: String(status), note: "server error" };

  // Anything else falls through with a note
  return { tone: "yellow", label: String(status), note: "unexpected status" };
}

function colorForTone(verdictTone) {
  const colorMap = { green: GREEN, yellow: YELLOW, red: RED };
  return colorMap[verdictTone] || DIM;
}

function printVerdictLine(name, result, verdict) {
  const colorFn = (s) => tone(s, colorForTone(verdict.tone));
  const elapsed = result.elapsedMs != null ? `${String(result.elapsedMs).padStart(4)}ms` : "    -";
  const note = verdict.note ? tone(`· ${verdict.note}`, DIM) : "";
  console.log(`  ${colorFn(verdict.label.padEnd(5))} ${elapsed}  ${name}  ${note}`);
}

function countQueueShortfalls(queueBuild) {
  const results = Array.isArray(queueBuild?.results) ? queueBuild.results : [];
  return results.filter((entry) => {
    const targetOpen = Number(entry.targetOpen || 0);
    if (targetOpen <= 0) return false;
    const minExpected = Math.min(
      targetOpen,
      Math.max(Number(QUEUE_MIN_TOTAL) || 0, 0),
    );
    return Number(entry.after?.total || 0) < minExpected;
  });
}

function normalizeDomain(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "").slice(-10);
}

function normalizeRouteCampaigns(value) {
  if (value === null || value === undefined || value === "") return [];
  const raw = Array.isArray(value) ? value : String(value || "").split(",");
  return Array.from(new Set(raw.map((entry) => String(entry || "").trim().toLowerCase()).filter(Boolean)));
}

function hasFreshRouteAccess(policy = {}, row = {}) {
  const allowed = normalizeRouteCampaigns(policy.routeCampaigns);
  if (allowed.length === 0) return true;
  const route = String(
    row.routeCampaignKey ||
      row["metadata.routeCampaignKey"] ||
      row.metadata?.routeCampaignKey ||
      "",
  ).trim().toLowerCase();
  return route ? allowed.includes(route) : false;
}

function policyTargets(policy = {}) {
  return {
    "fresh-day1": Number(policy.fresh?.targetOpen || 0),
    "fresh-day2to10": Number(policy.day2to15?.targetOpen || 0),
    "fresh-day16to30": Number(policy.day16to30?.targetOpen || 0),
    aged: Number(policy.aged?.targetOpen || 0),
  };
}

function rankPreviewRow(row = {}) {
  const familyRank = {
    "fresh-day1": 0,
    "fresh-day2to10": 1,
    "fresh-day16to30": 2,
    aged: 3,
  }[row.queueFamily] ?? 9;
  const daily = Number(row.dailyPlacedCalls || row.cadenceCounters?.cx || 0) || 0;
  const stage = Number(row.progressiveStageIndex || 99) || 99;
  const lastTouch = row.lastPlacedAt || row.lastTouched?.cx || row.updatedAt || row.createdAt || null;
  const lastMs = lastTouch ? new Date(lastTouch).getTime() : 0;
  return { familyRank, daily, stage, lastMs };
}

function sortPreviewRows(left = {}, right = {}) {
  const a = rankPreviewRow(left);
  const b = rankPreviewRow(right);
  if (a.familyRank !== b.familyRank) return a.familyRank - b.familyRank;
  if (a.daily !== b.daily) return a.daily - b.daily;
  if (a.stage !== b.stage) return a.stage - b.stage;
  if (a.lastMs !== b.lastMs) return a.lastMs - b.lastMs;
  return String(left.caseId || "").localeCompare(String(right.caseId || ""));
}

async function sampleRowsByFamily({ LeadCadence, CxDialQueue, domain, family, target, policy, extensionId }) {
  const limit = Math.min(Math.max(Number(target || 0) * 4, Number(target || 0), 5), 100);
  const rows = [];

  const queueRows = await CxDialQueue.find({
    domain,
    state: { $in: ["queued", "ready", "claimed", "serving", "paused"] },
    queueFamily: family,
    $or: [
      { "assignment.extensionId": extensionId },
      { "assignment.extensionId": { $exists: false } },
      { "assignment.extensionId": null },
      { "assignment.extensionId": "" },
    ],
  })
    .sort({
      queueFamilyRank: 1,
      dailyPlacedCalls: 1,
      progressiveStageIndex: 1,
      lastPlacedAt: 1,
      releaseAt: 1,
      priorityScore: -1,
      createdAt: 1,
    })
    .limit(limit)
    .lean();

  for (const row of queueRows) {
    if (family === "fresh-day1" && !hasFreshRouteAccess(policy, row)) continue;
    rows.push({
      source: "cx-dial-queue",
      queueTicketId: row._id ? String(row._id) : null,
      caseId: row.caseId != null ? String(row.caseId) : null,
      name: row.name || null,
      phone: normalizePhone(row.phone),
      queueFamily: family,
      state: row.state || null,
      routeCampaignKey: row.metadata?.routeCampaignKey || null,
      assignedExtensionId: row.assignment?.extensionId || null,
      assignedAgentName: row.assignment?.agentName || null,
      dailyPlacedCalls: Number(row.dailyPlacedCalls || 0),
      lastPlacedAt: row.lastPlacedAt || null,
      releaseAt: row.releaseAt || null,
      progressiveStageIndex: row.progressiveStageIndex || null,
    });
  }

  if (rows.length >= target) return rows.slice(0, target);

  const now = new Date();
  const dayMs = 24 * 60 * 60 * 1000;
  const ageWindows = {
    "fresh-day1": { gte: new Date(now.getTime() - 2 * dayMs), lte: now },
    "fresh-day2to10": { gte: new Date(now.getTime() - 16 * dayMs), lte: new Date(now.getTime() - 2 * dayMs) },
    "fresh-day16to30": { gte: new Date(now.getTime() - 31 * dayMs), lte: new Date(now.getTime() - 15 * dayMs) },
    aged: { gte: new Date(now.getTime() - 121 * dayMs), lte: new Date(now.getTime() - 30 * dayMs) },
  };
  const window = ageWindows[family] || ageWindows.aged;
  const cadenceQuery = {
    domain,
    active: true,
    createdAt: { $gte: window.gte, $lte: window.lte },
    $or: [
      { normalizedPhone: { $nin: [null, ""] } },
      { primaryPhone: { $nin: [null, ""] } },
    ],
  };
  const routeCampaigns = normalizeRouteCampaigns(policy.routeCampaigns);
  if (family === "fresh-day1" && routeCampaigns.length > 0) {
    cadenceQuery.routeCampaignKey = { $in: routeCampaigns };
  }
  const cadenceRows = await LeadCadence.find(cadenceQuery)
    .sort({ "lastTouched.cx": 1, createdAt: 1, updatedAt: 1 })
    .limit(limit)
    .lean();

  const seen = new Set(rows.map((row) => `${domain}:${row.caseId}`));
  for (const row of cadenceRows) {
    if (rows.length >= target) break;
    const caseId = row.caseId != null ? String(row.caseId) : null;
    if (!caseId || seen.has(`${domain}:${caseId}`)) continue;
    const phone = normalizePhone(row.normalizedPhone || row.primaryPhone);
    if (!phone) continue;
    rows.push({
      source: "lead-cadence-preview",
      queueTicketId: null,
      caseId,
      name: row.name || [row.firstName, row.lastName].filter(Boolean).join(" ") || null,
      phone,
      queueFamily: family,
      state: "would-materialize",
      routeCampaignKey: row.routeCampaignKey || null,
      assignedExtensionId: extensionId,
      assignedAgentName: null,
      dailyPlacedCalls: Number(row.cadenceCounters?.cx || 0),
      lastPlacedAt: row.lastTouched?.cx || null,
      releaseAt: row.schedule?.nextActionAt || row.createdAt || null,
      progressiveStageIndex: family === "fresh-day1" ? 0 : family === "fresh-day2to10" ? 3 : family === "fresh-day16to30" ? 16 : 99,
    });
    seen.add(`${domain}:${caseId}`);
  }

  return rows.slice().sort(sortPreviewRows).slice(0, target);
}

async function buildQueuePreviewForAgent(extensionId) {
  const { getSharedConfig } = require("../packages/shared-config/src");
  const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
  const { CxDialQueue, LeadCadence } = require("../packages/shared-models/src");
  const { userAccountRepository } = require("../packages/shared-repositories/src");
  const { resolveAccountQueuePolicy } = require("../packages/shared-services/src/cxQueuePolicyService");

  const config = getSharedConfig();
  await connectMongo(config);
  try {
    const account = await userAccountRepository.findUserAccountByExtensionId(extensionId);
    if (!account?.email) {
      return { ok: false, error: `No active user account is paired to extension ${extensionId}` };
    }
    const domain = normalizeDomain(DOMAIN || account.company || "WYNN");
    const policy = resolveAccountQueuePolicy(account);
    const targets = policyTargets(policy);
    const families = ["fresh-day1", "fresh-day2to10", "fresh-day16to30", "aged"];
    const familyRows = {};
    const rows = [];
    for (const family of families) {
      const target = Math.max(Number(targets[family] || 0), 0);
      const selected = target > 0
        ? await sampleRowsByFamily({ LeadCadence, CxDialQueue, domain, family, target, policy, extensionId })
        : [];
      familyRows[family] = selected;
      rows.push(...selected);
    }
    const selected = rows.slice().sort(sortPreviewRows);
    return {
      ok: true,
      domain,
      agent: {
        email: account.email,
        name: account.name || null,
        extensionId: account.extensionId || extensionId,
        cxAgentId: account.cxAgentId || null,
      },
      policy,
      targets,
      totals: {
        targetOpen: Object.values(targets).reduce((sum, value) => sum + Number(value || 0), 0),
        selected: selected.length,
        byFamily: Object.fromEntries(families.map((family) => [family, familyRows[family].length])),
      },
      items: selected.slice(0, Math.max(Number(QUEUE_PREVIEW_LIMIT) || 25, 1)),
    };
  } finally {
    await disconnectMongo().catch(() => null);
  }
}

async function runQueueBuildSmoke() {
  const name = "POST /api/ringcentral/cx-queue/build-agents";
  if (!BUILD_AGENT_QUEUES) {
    console.log(`  ${tone("SKIP", DIM)}    ${name}  ${tone("(SMOKE_BUILD_AGENT_QUEUES=false)", DIM)}`);
    return { skipped: true };
  }
  if (QUEUE_PREVIEW_ONLY) {
    const previewName = "LOCAL cx queue policy preview";
    const startedAt = Date.now();
    const results = [];
    const errors = [];
    for (const extensionId of QUEUE_AGENT_EXTENSIONS.slice(0, QUEUE_MAX_AGENTS)) {
      try {
        results.push(await buildQueuePreviewForAgent(extensionId));
      } catch (error) {
        errors.push({ extensionId, error: error.message });
      }
    }
    const result = { ok: errors.length === 0, elapsedMs: Date.now() - startedAt, body: { results, errors } };
    const bad = results.filter((entry) => !entry.ok || Number(entry.totals?.selected || 0) < Math.min(Number(entry.totals?.targetOpen || 0), QUEUE_MIN_TOTAL));
    const verdict = errors.length || bad.length
      ? { tone: "red", label: "FAIL", note: `${errors.length + bad.length} preview problem(s)` }
      : { tone: "green", label: "OK", note: `previewed ${results.length} agent(s)` };
    printVerdictLine(previewName, result, verdict);
    for (const entry of results) {
      if (!entry.ok) {
        console.log(tone(`           ${entry.error}`, DIM));
        continue;
      }
      console.log(tone(
        `           ${entry.agent.name || entry.agent.email}: selected ${entry.totals.selected}/${entry.totals.targetOpen}; ` +
        `green ${entry.totals.byFamily["fresh-day1"]}, blue ${entry.totals.byFamily["fresh-day2to10"]}, ` +
        `yellow ${entry.totals.byFamily["fresh-day16to30"]}, red ${entry.totals.byFamily.aged}`,
        DIM,
      ));
      for (const item of entry.items.slice(0, QUEUE_PREVIEW_LIMIT)) {
        console.log(tone(
          `             ${item.queueFamily} ${item.caseId} ${item.name || ""} ${item.phone || ""} ` +
          `[${item.source}; ${item.state}; route=${item.routeCampaignKey || "-"}]`,
          DIM,
        ));
      }
    }
    return { verdict, result };
  }
  if (!TOKEN) {
    console.log(`  ${tone("SKIP", DIM)}    ${name}  ${tone("(needs SMOKE_TOKEN admin auth)", DIM)}`);
    return { skipped: true };
  }
  if (!ALLOW_MUTATING_QUEUE_BUILD) {
    console.log(`  ${tone("SKIP", DIM)}    ${name}  ${tone("(mutating build blocked; set SMOKE_ALLOW_MUTATING_QUEUE_BUILD=true)", DIM)}`);
    return { skipped: true };
  }

  const result = await callJson({
    name,
    method: "POST",
    path: "/api/ringcentral/cx-queue/build-agents",
    body: {
      domain: DOMAIN,
      extensionIds: QUEUE_AGENT_EXTENSIONS,
      maxAgents: QUEUE_MAX_AGENTS,
      previewLimit: QUEUE_PREVIEW_LIMIT,
    },
    acceptStatuses: [200, 207],
  });
  let verdict = classify({ name, publicRoute: false, acceptStatuses: [200, 207], path: "" }, result);
  const body = result.body && typeof result.body === "object" ? result.body : null;
  const shortfalls = body ? countQueueShortfalls(body) : [];
  if (verdict.tone !== "red" && body) {
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      verdict = {
        tone: "red",
        label: String(result.status || "ERR"),
        note: `${body.errors.length} agent build error(s)`,
      };
    } else if (Array.isArray(body.missing) && body.missing.length > 0) {
      verdict = {
        tone: "red",
        label: String(result.status || "ERR"),
        note: `missing extensions: ${body.missing.join(", ")}`,
      };
    } else if (shortfalls.length > 0) {
      verdict = {
        tone: "red",
        label: String(result.status || "ERR"),
        note: `${shortfalls.length} agent(s) below minimum queue size`,
      };
    } else if (body.totals && Number(body.totals.after || 0) < Number(body.totals.targetOpen || 0)) {
      verdict = {
        tone: "yellow",
        label: String(result.status || "OK"),
        note: `queues built but below full target (${body.totals.after}/${body.totals.targetOpen})`,
      };
    } else {
      verdict = {
        tone: "green",
        label: String(result.status || "OK"),
        note: `queues ready (${body.totals?.after || 0}/${body.totals?.targetOpen || 0})`,
      };
    }
  }

  printVerdictLine(name, result, verdict);
  if (body?.results?.length) {
    for (const entry of body.results) {
      const queueSummary =
        `total ${entry.after?.total || 0}/${entry.targetOpen || 0}; ` +
        `green ${entry.after?.byFamily?.["fresh-day1"] || 0}, ` +
        `blue ${entry.after?.byFamily?.["fresh-day2to10"] || 0}, ` +
        `yellow ${entry.after?.byFamily?.["fresh-day16to30"] || 0}, ` +
        `red ${entry.after?.byFamily?.aged || 0}`;
      console.log(
        tone(`           ${entry.agent?.name || entry.agent?.email || entry.agent?.extensionId}: ${queueSummary}`, DIM),
      );
    }
  }
  return { verdict, result };
}

(async () => {
  console.log(`\nSmoking ${tone(BASE_URL, DIM)}`);
  console.log(`Auth: ${TOKEN ? tone("token provided", GREEN) : tone("no token (routes-only check)", YELLOW)}`);
  console.log(`Domain=${DOMAIN}  ExtensionId=${EXTENSION_ID}  CaseId=${CASE_ID}\n`);

  const tallies = { green: 0, yellow: 0, red: 0, skipped: 0 };
  for (const check of CHECKS) {
    if (typeof check.skipIf === "function" && check.skipIf()) {
      console.log(`  ${tone("SKIP", DIM)}    ${check.name}  ${tone("(skipped)", DIM)}`);
      tallies.skipped++;
      continue;
    }
    const result = await callOne(check);
    const verdict = classify(check, result);
    const note = verdict.note ? tone(`· ${verdict.note}`, DIM) : "";
    printVerdictLine(check.name, result, verdict);
    tallies[verdict.tone]++;
  }

  const queueBuild = await runQueueBuildSmoke();
  if (queueBuild?.skipped) {
    tallies.skipped++;
  } else if (queueBuild?.verdict?.tone) {
    tallies[queueBuild.verdict.tone]++;
  }

  console.log(
    `\n${tallies.green + tallies.yellow + tallies.red} checks · ` +
    `${tone(tallies.green + " green", GREEN)} · ` +
    `${tone(tallies.yellow + " yellow", YELLOW)} · ` +
    `${tone(tallies.red + " red", RED)}` +
    (tallies.skipped ? ` · ${tallies.skipped} skipped` : ""),
  );

  if (tallies.red > 0) {
    console.log(tone("\nFAIL — at least one red. See notes above.", RED));
    process.exit(1);
  }
  console.log(tone("\nOK — control plane looks healthy.", GREEN));

  // Auto-promote step — only runs on full green/yellow, opt-in.
  const handoff = runPostSuccessHandoff();
  if (!handoff) process.exit(1);

  if (PROMOTE_TO_LIVE) {
    const promoted = promoteToLive();
    process.exit(promoted ? 0 : 1);
  }
  process.exit(0);
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(2);
});

function runPostSuccessHandoff() {
  if (ENSURE_NGROK_TUNNEL) {
    const scriptPath = path.resolve(__dirname, "ensure-parallel-ngrok-tunnel.js");
    console.log("");
    console.log(tone(`Ensuring ngrok tunnel for ${GO_LIVE_DOMAIN}`, YELLOW));
    const result = spawnSync(
      process.execPath,
      [scriptPath],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          NGROK_DOMAIN: GO_LIVE_DOMAIN,
        },
      },
    );
    if (result.error) {
      console.log(tone(`ngrok handoff failed: ${result.error.message}`, RED));
      return false;
    }
    if (result.status !== 0) {
      console.log(tone(`ngrok handoff exited with code ${result.status}`, RED));
      console.log(tone("This can run unelevated only when the ngrok agent API is already up.", DIM));
      return false;
    }
  }

  if (POST_SUCCESS_COMMAND) {
    console.log("");
    console.log(tone(`Running post-success command: ${POST_SUCCESS_COMMAND}`, YELLOW));
    const result = spawnSync(POST_SUCCESS_COMMAND, {
      stdio: "inherit",
      shell: true,
      env: process.env,
    });
    if (result.error) {
      console.log(tone(`post-success command failed: ${result.error.message}`, RED));
      return false;
    }
    if (result.status !== 0) {
      console.log(tone(`post-success command exited with code ${result.status}`, RED));
      return false;
    }
  }

  if (!ENSURE_NGROK_TUNNEL && !POST_SUCCESS_COMMAND && process.platform === "win32") {
    console.log(tone("\nWindows handoff: smoke passed. Full service reset still needs elevated PowerShell.", DIM));
    console.log(tone("Set SMOKE_ENSURE_NGROK_TUNNEL=true to ask the already-running ngrok agent to claim the live domain.", DIM));
  }

  return true;
}

// Invokes ops/linux/go-live-linux.sh to swap ngrok + restart services.
// Returns true on success, false on any failure. Logs each step so the
// operator can see exactly where it stopped if it does. Designed to be
// called ONLY after all smoke checks pass.
function promoteToLive() {
  console.log("");
  console.log(tone("─".repeat(60), DIM));
  console.log(tone(`PROMOTING: swap ngrok → ${GO_LIVE_DOMAIN} and restart services`, YELLOW));
  console.log(tone("─".repeat(60), DIM));

  if (process.platform !== "linux") {
    console.log(tone(`  SKIP: not running on Linux (platform=${process.platform})`, YELLOW));
    console.log(tone("  Run go-live manually on the Ubuntu box: sudo ops/linux/go-live-linux.sh", DIM));
    return true;
  }

  // Resolve the go-live script path. Try the configured path first;
  // fall back to a search relative to the script's directory and the
  // working dir. Either should land on ops/linux/go-live-linux.sh.
  const candidates = [
    GO_LIVE_SCRIPT,
    path.resolve(GO_LIVE_SCRIPT),
    path.resolve(__dirname, "..", "ops", "linux", "go-live-linux.sh"),
  ];
  const scriptPath = candidates.find((p) => {
    try { return fs.existsSync(p); } catch { return false; }
  });
  if (!scriptPath) {
    console.log(tone(`  FAIL: could not find go-live script. Tried: ${candidates.join(", ")}`, RED));
    return false;
  }
  console.log(`  using: ${scriptPath}`);
  console.log(`  domain: ${GO_LIVE_DOMAIN}`);

  // sudo -n = non-interactive. Fails fast if NOPASSWD isn't set up,
  // rather than hanging waiting for a password.
  console.log(tone("  running: sudo -n DOMAIN=" + GO_LIVE_DOMAIN + " " + scriptPath, DIM));
  const result = spawnSync(
    "sudo",
    ["-n", `DOMAIN=${GO_LIVE_DOMAIN}`, "bash", scriptPath],
    { stdio: "inherit" },
  );

  if (result.error) {
    console.log(tone(`  FAIL: spawn error — ${result.error.message}`, RED));
    return false;
  }
  if (result.status !== 0) {
    console.log(tone(`  FAIL: go-live exited with code ${result.status}`, RED));
    console.log(tone("  Likely cause: sudo NOPASSWD not configured for this user, or the", DIM));
    console.log(tone("  parallel-ngrok systemd unit isn't installed. Run by hand:", DIM));
    console.log(tone(`    sudo DOMAIN=${GO_LIVE_DOMAIN} ${scriptPath}`, DIM));
    return false;
  }

  console.log(tone(`\n  CUTOVER COMPLETE — public domain is now ${GO_LIVE_DOMAIN}`, GREEN));
  return true;
}
