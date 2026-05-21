"use strict";

// Admin "call review" endpoints — feed the per-agent and per-lead
// detail panels under the users component. Reads CallLog rows for a
// single PT calendar day and shapes them into review-friendly rows
// (timing, direction, lead, recording availability, status-shift
// correlation TODO).
//
// Routes mounted at /api/admin/call-review:
//   GET /agent/:extensionId/today?domain=TAG&sort=duration|time
//     → calls today for one agent's extension.
//   GET /case/:caseId/today?domain=TAG&sort=time|duration
//     → calls today against one lead, across all agents.
//
// Auth: requireAdmin. Same posture as the rest of /api/admin.

const express = require("express");
const {
  callLogRepository,
} = require("../../../../packages/shared-repositories/src");
const { CallLog } = require("../../../../packages/shared-models/src");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");

const PACIFIC_TZ = "America/Los_Angeles";
const DEFAULT_DOMAIN = "TAG";
// Tenants we union across when the caller doesn't pin a domain. Agents
// freely dial across both — Anthony today has 229 calls on WYNN + 6 on
// TAG — so a single-domain filter would hide most of their activity.
// Adjust here if a new tenant is introduced.
const KNOWN_DOMAINS = Object.freeze(["TAG", "WYNN"]);

// Resolve the ?domain= query param into an array of domains to query.
// Accepts:
//   - missing / "ALL" / "*"        → both tenants (default behavior)
//   - "WYNN" / "TAG"               → single tenant (back-compat)
//   - "WYNN,TAG" or "TAG,WYNN"     → CSV list, deduped
function resolveDomainScope(rawDomain) {
  const raw = String(rawDomain || "").trim().toUpperCase();
  if (!raw || raw === "ALL" || raw === "*") {
    return [...KNOWN_DOMAINS];
  }
  if (raw.includes(",")) {
    const set = new Set();
    for (const part of raw.split(",")) {
      const cleaned = part.trim().toUpperCase();
      if (cleaned && KNOWN_DOMAINS.includes(cleaned)) set.add(cleaned);
    }
    return set.size > 0 ? [...set] : [...KNOWN_DOMAINS];
  }
  return KNOWN_DOMAINS.includes(raw) ? [raw] : [...KNOWN_DOMAINS];
}
const MAX_ROWS = 200;
// Higher cap for the org-wide /today endpoint — busiest day across both
// tenants is in the low thousands of rows.
const MAX_TRACKER_ROWS = 2000;

// Compute the UTC instant for "today 00:00 in Pacific time." Used as
// the lower bound on callStartTime so we only ever return rows whose
// start happened on the current PT calendar day.
function startOfPacificDay(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: PACIFIC_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const lookup = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const isoLocal = `${lookup.year}-${lookup.month}-${lookup.day}T00:00:00`;
  // Offset trick: build a UTC Date from the wall-clock, then ask Intl
  // what the zone offset is for that moment, then subtract.
  const utcGuess = new Date(`${isoLocal}Z`);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_TZ,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const zoned = Object.fromEntries(
    fmt.formatToParts(utcGuess).map((p) => [p.type, p.value]),
  );
  const zonedAsUtc = Date.UTC(
    Number(zoned.year),
    Number(zoned.month) - 1,
    Number(zoned.day),
    Number(zoned.hour),
    Number(zoned.minute),
    Number(zoned.second),
  );
  const offsetMs = zonedAsUtc - utcGuess.getTime();
  return new Date(utcGuess.getTime() - offsetMs);
}

function pacificDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: PACIFIC_TZ }).format(
    new Date(date),
  );
}

// Shape one CallLog into a row the review UI can consume directly. The
// recording.playbackUrl is the existing auth-protected /api/read/cx
// proxy — no new transport, no signed-URL gymnastics. If the archive
// row hasn't been stamped with a driveFileId yet (the bulk pull script
// runs on its own cadence), we surface `available: false` so the UI
// can show a "recording pending" badge instead of a play button.
function projectCallRow(callLog = {}) {
  const archive = callLog.recordingArchive || {};
  const driveFileId = String(archive.driveFileId || "").trim();
  const score = callLog.callScore || {};
  const transcription = callLog.transcription || {};
  return {
    id: String(callLog._id || callLog.id || callLog.telephonySessionId || ""),
    telephonySessionId: callLog.telephonySessionId || null,
    callStartTime: callLog.callStartTime || null,
    callEndTime: callLog.callEndTime || null,
    durationSec: Number.isFinite(Number(callLog.durationSec))
      ? Number(callLog.durationSec)
      : null,
    direction: callLog.direction || null,
    platform: callLog.platform || null,
    phone: callLog.phone || callLog.normalizedPhone || null,
    caseId: Number.isFinite(Number(callLog.caseId))
      ? Number(callLog.caseId)
      : null,
    caseProfileId: callLog.caseProfileId
      ? String(callLog.caseProfileId)
      : null,
    agentName: callLog.agentName || null,
    extensionId: callLog.extensionId ? String(callLog.extensionId) : null,
    // Vendor / campaign attribution — drives the source chip in the
    // CallRow and feeds the nightly vendor families rollup. Stamped
    // by callLogSourceBackfillService or at call-placed time
    // (cxCadenceService) for CX rows.
    sourceName: callLog.sourceName || null,
    sourceChannel: callLog.sourceChannel || null,
    routeCampaignKey: callLog.routeCampaignKey || null,
    routeCampaignName: callLog.routeCampaignName || null,
    // Claude-scored lead quality. UI badges by verdict
    // (hot / warm / cold / dead / fake). Null until transcription +
    // scoring completes — see transcriptionScoringService.
    score: {
      overall: Number.isFinite(Number(score.overall))
        ? Number(score.overall)
        : null,
      verdict: score.lead_verdict || null,
      summary: score.summary || null,
      scoredAt: score.scoredAt || null,
    },
    transcription: {
      status: transcription.status || null,
      hasText: Boolean(String(transcription.text || "").trim()),
    },
    recording: {
      driveFileId: driveFileId || null,
      // Auth-protected playback — the existing /api/read/cx route reuses
      // the user's session and proxies the Drive bytes with Range
      // support so an <audio> element can scrub.
      playbackUrl: driveFileId
        ? `/api/read/cx/recordings/play/${encodeURIComponent(driveFileId)}`
        : null,
      // Per-call deep link that resolves CallLog→fileId on the server.
      // Useful for clients that have the session id but not the fileId.
      sessionPlaybackUrl: callLog.domain && callLog.telephonySessionId
        ? `/api/read/cx/recordings/call/${encodeURIComponent(
            String(callLog.domain).toUpperCase(),
          )}/${encodeURIComponent(callLog.telephonySessionId)}`
        : null,
      available: Boolean(driveFileId),
      archiveStatus: archive.status || null,
    },
    status: callLog.status || null,
    // TODO(call-review-status-shift): correlate this call to the case's
    // status change. Two approaches under consideration:
    //   (A) heuristic — query CaseProfile.statusLastChangedAt and tag
    //       the row if it landed within ~5 min of callEndTime.
    //   (B) explicit — add `triggeredByCallId` to CaseProfile at write
    //       time in cxWorkspaceService.executeCxLogicsUpdateCase /
    //       caseProfilePromotionService, then read it back here.
    // Returning null today; UI shows "—" in the status-shift column.
    statusShift: null,
  };
}

function sortRows(rows, sort) {
  const normalized = String(sort || "time").toLowerCase();
  if (normalized === "duration") {
    return [...rows].sort(
      (a, b) => (Number(b.durationSec) || 0) - (Number(a.durationSec) || 0),
    );
  }
  if (normalized === "score") {
    // Highest-scored calls first. Unscored rows (overall === null)
    // sink to the bottom; ties broken by duration desc so a 12-min
    // unscored call still beats a 30-second unscored call.
    return [...rows].sort((a, b) => {
      const ascore = Number(a.score?.overall);
      const bscore = Number(b.score?.overall);
      const aHas = Number.isFinite(ascore);
      const bHas = Number.isFinite(bscore);
      if (aHas && bHas && ascore !== bscore) return bscore - ascore;
      if (aHas && !bHas) return -1;
      if (!aHas && bHas) return 1;
      return (Number(b.durationSec) || 0) - (Number(a.durationSec) || 0);
    });
  }
  // Default: most-recent first.
  return [...rows].sort((a, b) => {
    const at = a.callStartTime ? new Date(a.callStartTime).getTime() : 0;
    const bt = b.callStartTime ? new Date(b.callStartTime).getTime() : 0;
    return bt - at;
  });
}

function buildSummary(rows) {
  let totalDurationSec = 0;
  let longestSec = 0;
  let withRecording = 0;
  const byDirection = { inbound: 0, outbound: 0, unknown: 0 };
  for (const row of rows) {
    const dur = Number(row.durationSec) || 0;
    totalDurationSec += dur;
    if (dur > longestSec) longestSec = dur;
    if (row.recording?.available) withRecording++;
    const dir = String(row.direction || "unknown").toLowerCase();
    byDirection[dir] = (byDirection[dir] || 0) + 1;
  }
  return {
    callCount: rows.length,
    totalDurationSec,
    longestDurationSec: longestSec,
    withRecording,
    withoutRecording: rows.length - withRecording,
    byDirection,
  };
}

function createAdminCallReviewRouter(auth) {
  const router = express.Router();

  /**
   * GET /agent/:extensionId/today?domain=TAG&sort=duration|time
   *
   * Today's call activity for a specific agent extension. Returns the
   * row list (sorted) + a summary block (call count, total talk time,
   * longest call, recording coverage).
   */
  router.get(
    "/agent/:extensionId/today",
    auth.requireAuth,
    auth.requireAdmin,
    async (req, res) => {
      try {
        const extensionId = String(req.params.extensionId || "").trim();
        if (!extensionId) {
          return res
            .status(400)
            .json({ ok: false, error: "extensionId is required" });
        }
        const domains = resolveDomainScope(req.query?.domain);
        const dayStart = startOfPacificDay();

        // Fan out per tenant — listCallLogs requires a single domain.
        // Parallel + merge keeps the wall-clock equivalent to a single-
        // tenant query. MAX_ROWS applies post-merge so a hot tenant
        // can't crowd out a quiet one.
        const perTenant = await Promise.all(
          domains.map((d) =>
            callLogRepository.listCallLogs(d, {
              extensionId,
              callStartFrom: dayStart,
              limit: MAX_ROWS,
            }),
          ),
        );
        const callLogs = perTenant.flat();

        const rows = sortRows(callLogs.map(projectCallRow), req.query?.sort)
          .slice(0, MAX_ROWS);
        return res.json({
          ok: true,
          dateKey: pacificDateKey(),
          // Echo what was queried so the SPA can show "across all
          // tenants" vs "WYNN only" badges if it wants.
          domains,
          domain: domains.length === 1 ? domains[0] : "ALL",
          extensionId,
          summary: buildSummary(rows),
          calls: rows,
        });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  /**
   * GET /case/:caseId/today?domain=TAG&sort=time|duration
   *
   * Today's call activity against a single lead — useful for the
   * "who dialed this lead today" view that the admin board can pop
   * open when an operator clicks a lead row from an agent's call list.
   * Returns every CallLog row for the case on today's PT date.
   */
  router.get(
    "/case/:caseId/today",
    auth.requireAuth,
    auth.requireAdmin,
    async (req, res) => {
      try {
        const caseId = Number(req.params.caseId);
        if (!Number.isFinite(caseId) || caseId <= 0) {
          return res
            .status(400)
            .json({ ok: false, error: "caseId must be a positive number" });
        }
        const domains = resolveDomainScope(req.query?.domain);
        const dayStart = startOfPacificDay();

        const perTenant = await Promise.all(
          domains.map((d) =>
            callLogRepository.listCallLogs(d, {
              caseId,
              callStartFrom: dayStart,
              limit: MAX_ROWS,
            }),
          ),
        );
        const callLogs = perTenant.flat();

        const rows = sortRows(callLogs.map(projectCallRow), req.query?.sort)
          .slice(0, MAX_ROWS);
        // Build per-agent grouping so the UI can render "Sean dialed
        // 3 times, Maria once" without a second client query.
        const byAgent = new Map();
        for (const row of rows) {
          const key = row.extensionId || "unknown";
          if (!byAgent.has(key)) {
            byAgent.set(key, {
              extensionId: row.extensionId,
              agentName: row.agentName || null,
              callCount: 0,
              totalDurationSec: 0,
              lastCallAt: null,
            });
          }
          const bucket = byAgent.get(key);
          bucket.callCount += 1;
          bucket.totalDurationSec += Number(row.durationSec) || 0;
          if (
            row.callStartTime &&
            (!bucket.lastCallAt ||
              new Date(row.callStartTime) > new Date(bucket.lastCallAt))
          ) {
            bucket.lastCallAt = row.callStartTime;
          }
        }
        return res.json({
          ok: true,
          dateKey: pacificDateKey(),
          domains,
          domain: domains.length === 1 ? domains[0] : "ALL",
          caseId,
          summary: buildSummary(rows),
          agents: Array.from(byAgent.values()).sort(
            (a, b) => b.callCount - a.callCount,
          ),
          calls: rows,
        });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  /**
   * GET /today
   *
   * Org-wide today's calls. Powers the CX Call Tracker workspace —
   * flat list of every CallLog row on the PT calendar day, across all
   * tenants by default. Filters narrow the result; sort orders it.
   *
   * Query params (all optional):
   *   domain          "ALL" (default) | "TAG" | "WYNN" | CSV
   *   platform        "cx" (default) | "ex" | "all"
   *   direction       "outbound" | "inbound" | "all" (default)
   *   hasRecording    "true" | "false" (omit for both)
   *   extensionId     filter to one agent's extension
   *   sort            "time" (default) | "duration" | "score"
   *   limit           default 500, cap MAX_TRACKER_ROWS
   *
   * Response shape mirrors /agent/:extensionId/today: summary block +
   * calls[], plus per-agent rollup so the UI can show an at-a-glance
   * "Anthony 219, Bruce 50, Sean 145" panel.
   */
  router.get(
    "/today",
    auth.requireAuth,
    auth.requireAdmin,
    async (req, res) => {
      try {
        const domains = resolveDomainScope(req.query?.domain);
        const platformParam = String(req.query?.platform || "cx")
          .trim()
          .toLowerCase();
        const directionParam = String(req.query?.direction || "all")
          .trim()
          .toLowerCase();
        const hasRecordingParam = req.query?.hasRecording;
        const extensionFilter = req.query?.extensionId
          ? String(req.query.extensionId).trim()
          : null;
        const limit = Math.min(
          Math.max(Number(req.query?.limit) || 500, 1),
          MAX_TRACKER_ROWS,
        );
        const dayStart = startOfPacificDay();

        const baseQuery = {
          domain: { $in: domains },
          callStartTime: { $gte: dayStart },
        };
        if (platformParam !== "all") {
          // CallLog rows from before the platform stamp landed are null.
          // For "cx" filter, "ex" matters too — null is "unattributed,"
          // not "missing." Only include the requested value explicitly.
          baseQuery.platform = platformParam;
        }
        if (directionParam !== "all") {
          baseQuery.direction = directionParam;
        }
        if (extensionFilter) {
          baseQuery.extensionId = extensionFilter;
        }
        if (hasRecordingParam !== undefined) {
          const wantsRecording = String(hasRecordingParam) === "true";
          if (wantsRecording) {
            baseQuery["recordingArchive.driveFileId"] = {
              $exists: true,
              $ne: null,
            };
          } else {
            baseQuery.$or = [
              { "recordingArchive.driveFileId": null },
              { "recordingArchive.driveFileId": { $exists: false } },
            ];
          }
        }

        const callLogs = await CallLog.find(baseQuery)
          .sort({ callStartTime: -1, createdAt: -1 })
          .limit(limit)
          .lean();

        const rows = sortRows(callLogs.map(projectCallRow), req.query?.sort);

        // Per-agent rollup so the UI can show "today's leaderboard"
        // above the row list. Skips unknown-agent rows so the panel
        // doesn't get noisy with anonymous inbound legs.
        const byAgent = new Map();
        for (const row of rows) {
          const key = row.extensionId || null;
          if (!key) continue;
          if (!byAgent.has(key)) {
            byAgent.set(key, {
              extensionId: key,
              agentName: row.agentName || null,
              callCount: 0,
              cxCount: 0,
              exCount: 0,
              totalDurationSec: 0,
              withRecording: 0,
              lastCallAt: null,
            });
          }
          const bucket = byAgent.get(key);
          bucket.callCount += 1;
          if (row.platform === "cx") bucket.cxCount += 1;
          else if (row.platform === "ex") bucket.exCount += 1;
          bucket.totalDurationSec += Number(row.durationSec) || 0;
          if (row.recording?.available) bucket.withRecording += 1;
          if (
            row.callStartTime &&
            (!bucket.lastCallAt ||
              new Date(row.callStartTime) > new Date(bucket.lastCallAt))
          ) {
            bucket.lastCallAt = row.callStartTime;
          }
        }

        return res.json({
          ok: true,
          dateKey: pacificDateKey(),
          domains,
          domain: domains.length === 1 ? domains[0] : "ALL",
          filters: {
            platform: platformParam,
            direction: directionParam,
            extensionId: extensionFilter,
            hasRecording:
              hasRecordingParam === undefined
                ? null
                : String(hasRecordingParam) === "true",
          },
          summary: buildSummary(rows),
          agents: Array.from(byAgent.values()).sort(
            (a, b) => b.callCount - a.callCount,
          ),
          calls: rows,
          truncated: callLogs.length >= limit,
        });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  /**
   * GET /by-phone/:phone
   *
   * Phone-centric lookup — every CallLog row to/from a single phone
   * number, across all agents, all tenants, over a configurable
   * window. Powers the "how many times have we called X" workflow in
   * the CX Call Tracker workspace.
   *
   * Path: `:phone` accepts any format; we normalize to a 10-digit US
   * trunk before querying.
   *
   * Query params (all optional):
   *   domain          "ALL" (default) | "TAG" | "WYNN" | CSV
   *   days            integer days back (default 90) or "all"
   *   hasRecording    "true" | "false"
   *   sort            "time" (default) | "duration" | "score"
   *   limit           default 500, cap MAX_TRACKER_ROWS
   *
   * Hits the (domain, normalizedPhone, status, callStartTime) compound
   * index so it stays fast even for power-dialed numbers with hundreds
   * of historical attempts.
   */
  router.get(
    "/by-phone/:phone",
    auth.requireAuth,
    auth.requireAdmin,
    async (req, res) => {
      try {
        const raw = String(req.params.phone || "").replace(/\D/g, "");
        const tenDigit =
          raw.length === 11 && raw.startsWith("1")
            ? raw.slice(1)
            : raw.length === 10
              ? raw
              : raw.length > 10
                ? raw.slice(-10)
                : null;
        if (!tenDigit || tenDigit.length !== 10) {
          return res.status(400).json({
            ok: false,
            error:
              "phone must contain at least 10 digits (US format, optionally +1)",
          });
        }
        const domains = resolveDomainScope(req.query?.domain);
        const daysParam = String(req.query?.days || "90").toLowerCase();
        const allTime = daysParam === "all" || daysParam === "*";
        const days = allTime ? 0 : Math.max(Number(daysParam) || 90, 1);
        const limit = Math.min(
          Math.max(Number(req.query?.limit) || 500, 1),
          MAX_TRACKER_ROWS,
        );
        const hasRecordingParam = req.query?.hasRecording;

        const baseQuery = {
          domain: { $in: domains },
          normalizedPhone: tenDigit,
        };
        if (!allTime) {
          const windowStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
          baseQuery.callStartTime = { $gte: windowStart };
        }
        if (hasRecordingParam !== undefined) {
          const wantsRecording = String(hasRecordingParam) === "true";
          if (wantsRecording) {
            baseQuery["recordingArchive.driveFileId"] = {
              $exists: true,
              $ne: null,
            };
          } else {
            baseQuery.$or = [
              { "recordingArchive.driveFileId": null },
              { "recordingArchive.driveFileId": { $exists: false } },
            ];
          }
        }

        const callLogs = await CallLog.find(baseQuery)
          .sort({ callStartTime: -1, createdAt: -1 })
          .limit(limit)
          .lean();
        const rows = sortRows(callLogs.map(projectCallRow), req.query?.sort);

        // Per-agent rollup so the UI can show "you've called this
        // person X times across N agents."
        const byAgent = new Map();
        let firstCallAt = null;
        let lastCallAt = null;
        for (const row of rows) {
          const key = row.extensionId || "unknown";
          if (!byAgent.has(key)) {
            byAgent.set(key, {
              extensionId: row.extensionId,
              agentName: row.agentName || null,
              callCount: 0,
              cxCount: 0,
              exCount: 0,
              totalDurationSec: 0,
              withRecording: 0,
              lastCallAt: null,
            });
          }
          const bucket = byAgent.get(key);
          bucket.callCount += 1;
          if (row.platform === "cx") bucket.cxCount += 1;
          else if (row.platform === "ex") bucket.exCount += 1;
          bucket.totalDurationSec += Number(row.durationSec) || 0;
          if (row.recording?.available) bucket.withRecording += 1;
          if (row.callStartTime) {
            const t = new Date(row.callStartTime).getTime();
            if (Number.isFinite(t)) {
              if (!firstCallAt || t < new Date(firstCallAt).getTime()) {
                firstCallAt = row.callStartTime;
              }
              if (!lastCallAt || t > new Date(lastCallAt).getTime()) {
                lastCallAt = row.callStartTime;
              }
              if (
                !bucket.lastCallAt ||
                t > new Date(bucket.lastCallAt).getTime()
              ) {
                bucket.lastCallAt = row.callStartTime;
              }
            }
          }
        }

        return res.json({
          ok: true,
          phone: tenDigit,
          phoneDisplay: `(${tenDigit.slice(0, 3)}) ${tenDigit.slice(3, 6)}-${tenDigit.slice(6)}`,
          domains,
          domain: domains.length === 1 ? domains[0] : "ALL",
          window: {
            allTime,
            days: allTime ? null : days,
          },
          filters: {
            hasRecording:
              hasRecordingParam === undefined
                ? null
                : String(hasRecordingParam) === "true",
          },
          summary: {
            ...buildSummary(rows),
            firstCallAt,
            lastCallAt,
            uniqueAgents: byAgent.size,
          },
          agents: Array.from(byAgent.values()).sort(
            (a, b) => b.callCount - a.callCount,
          ),
          calls: rows,
          truncated: callLogs.length >= limit,
        });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  return router;
}

module.exports = {
  createAdminCallReviewRouter,
  // Exported for testing.
  projectCallRow,
  sortRows,
  buildSummary,
  startOfPacificDay,
  pacificDateKey,
};
