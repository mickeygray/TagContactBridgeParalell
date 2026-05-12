"use strict";

// CX call-recording hourly poller.
//
// Fires at the top of every hour. The window pulled is the previous
// :45-to-:45 span — at fire time HH:00 we pull calls that ended
// between (HH-2):45 and (HH-1):45. That gives every call in the window
// at least 15 minutes of post-call processing time on the RingCX side
// (their stated media-readiness threshold), with the newest call right
// at the 15-min boundary and the oldest at 1h15m.
//
// Flow:
//   1. fetchInteractionMetadata for the window (one POST, well under
//      the 2-rpm metadata limit)
//   2. group segments by interactionId (UII) → cache
//   3. find CallLog rows where platform="cx", callEndTime ∈ window,
//      recordingArchive.status NOT in terminal set
//   4. for each row, run the existing processCallRecordingArchive
//      with the metadata cache passed through — the new "ringcx"
//      provider in recordingArchiveService picks the right segment,
//      downloads the WAV, and hands it off to the existing
//      Drive-upload → transcription → scoring pipeline.
//
// Gated by RINGCX_RECORDING_ENABLED (default false). Until RC
// activates recording on the account, the metadata responses will be
// empty and the rows stay at status="no_recording" — at which point
// the existing retry/backoff in queueCallRecordingArchiveJob handles
// the rest.

const { CallLog } = require("../../shared-models/src");
const { createRingcxVoiceClient } = require("../../shared-integrations/src");
const {
  buildRingcxMetadataCache,
  isRingcxRecordingEnabled,
  processCallRecordingArchive,
  queueCallRecordingArchiveJob,
} = require("./recordingArchiveService");

const TERMINAL_STATUSES = new Set([
  "completed",
  "abandoned",
  "skipped",
  "no_group_match",
]);

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

// Compute the :45-to-:45 window for a given fire time. fireTime
// defaults to "now" rounded down to the hour boundary.
//
// Example: fire at 14:00 → window [12:45, 13:45]. The bottom of the
// window (newest call end-time included) is at 13:45, which is exactly
// 15 minutes before the fire time, hitting the RingCX media-ready
// threshold precisely.
function computeWindow(fireTime = new Date()) {
  const fire = new Date(fireTime);
  const hourBoundary = new Date(fire);
  hourBoundary.setMinutes(0, 0, 0);

  // windowEnd = hourBoundary - 15 minutes = (HH-1):45
  const windowEnd = new Date(hourBoundary.getTime() - 15 * 60 * 1000);
  // windowStart = windowEnd - 1 hour = (HH-2):45
  const windowStart = new Date(windowEnd.getTime() - 60 * 60 * 1000);

  return {
    fireTime: fire,
    hourBoundary,
    windowStart,
    windowEnd,
  };
}

async function runCxRecordingHourly({
  fireTime = new Date(),
  domains = ["TAG", "WYNN"],
  logger = null,
  // Override the computed window — used by the admin backfill route to
  // process an arbitrary historical slot.
  windowStart: overrideStart = null,
  windowEnd: overrideEnd = null,
  // Cap on rows pulled from CallLog per domain. Plenty of headroom
  // above a typical hour (most days well under 100 CX calls/hour);
  // safety rail.
  maxRowsPerDomain = 500,
} = {}) {
  if (!isRingcxRecordingEnabled()) {
    return {
      ok: true,
      skipped: true,
      reason: "ringcx-recording-disabled",
      fireTime: new Date(fireTime).toISOString(),
    };
  }

  const computed = overrideStart && overrideEnd
    ? {
        fireTime: new Date(fireTime),
        hourBoundary: new Date(fireTime),
        windowStart: new Date(overrideStart),
        windowEnd: new Date(overrideEnd),
      }
    : computeWindow(fireTime);

  const summary = {
    ok: true,
    fireTime: computed.fireTime.toISOString(),
    windowStart: computed.windowStart.toISOString(),
    windowEnd: computed.windowEnd.toISOString(),
    domains: {},
    metadata: null,
    errors: [],
  };

  // Single bulk metadata POST for the window — one request feeds N
  // CallLog rows across both domains.
  let client = null;
  try {
    client = createRingcxVoiceClient();
  } catch (error) {
    return {
      ...summary,
      ok: false,
      skipped: true,
      reason: "ringcx-client-unconfigured",
      error: error.message,
    };
  }

  let metadata = null;
  try {
    metadata = await client.fetchInteractionMetadata({
      startTime: computed.windowStart,
      endTime: computed.windowEnd,
    });
  } catch (error) {
    summary.errors.push({
      step: "fetch-interaction-metadata",
      error: error.message,
      responseBody: error?.details?.responseBody || null,
      responseStatus: error?.details?.responseStatus || null,
    });
    return { ...summary, ok: false };
  }

  const cache = buildRingcxMetadataCache(metadata);
  summary.metadata = {
    totalSegments: cache.totalSegments,
    uniqueInteractions: cache.byUii.size,
  };

  for (const rawDomain of domains) {
    const domain = normalizeDomain(rawDomain);
    if (!domain) continue;
    summary.domains[domain] = {
      candidateRows: 0,
      queued: 0,
      processedInline: 0,
      processedCompleted: 0,
      processedNoRecording: 0,
      processedErrors: 0,
      skippedNoMetadata: 0,
      errors: [],
    };
    const ds = summary.domains[domain];

    let rows = [];
    try {
      rows = await CallLog.find(
        {
          domain,
          platform: "cx",
          callEndTime: {
            $gte: computed.windowStart,
            $lte: computed.windowEnd,
          },
          $or: [
            { "recordingArchive.status": { $exists: false } },
            { "recordingArchive.status": null },
            { "recordingArchive.status": { $nin: [...TERMINAL_STATUSES] } },
          ],
        },
        {
          _id: 1,
          telephonySessionId: 1,
          domain: 1,
          caseId: 1,
          callStartTime: 1,
          callEndTime: 1,
          extensionId: 1,
          agentName: 1,
          durationSec: 1,
          recordingArchive: 1,
        },
      )
        .sort({ callStartTime: 1 })
        .limit(maxRowsPerDomain)
        .lean();
    } catch (error) {
      ds.errors.push({ step: "calllog-find", error: error.message });
      continue;
    }

    ds.candidateRows = rows.length;
    if (rows.length === 0) continue;

    // Per row: enqueue an archive job (so the existing retry/backoff
    // is preserved) AND run processCallRecordingArchive inline with
    // the metadata cache attached. The inline call will be the one
    // that actually downloads the WAV during this tick; the queued
    // job becomes a no-op (status=completed by the time the worker
    // picks it up) or retries naturally if the inline call failed.
    for (const row of rows) {
      // Ensure a job event exists for downstream observability + retry.
      // This is idempotent (dedupeKey) so re-runs of the hour don't
      // duplicate.
      await queueCallRecordingArchiveJob(row, { force: false, lane: "hourly" }).catch(
        (error) => {
          ds.errors.push({
            step: "queue-archive",
            telephonySessionId: row.telephonySessionId,
            error: error.message,
          });
        },
      );
      ds.queued += 1;

      // Inline process with metadata cache. processCallRecordingArchive
      // re-fetches the CallLog row itself; we just pass the IDs +
      // cache. Errors here don't kill the loop — the retry framework
      // owns recovery.
      try {
        const result = await processCallRecordingArchive({
          domain,
          telephonySessionId: row.telephonySessionId,
          ringcxMetadataCache: cache,
          logger,
        });
        ds.processedInline += 1;
        if (result?.status === "completed") ds.processedCompleted += 1;
        if (result?.status === "no_recording") ds.processedNoRecording += 1;
      } catch (error) {
        ds.processedErrors += 1;
        ds.errors.push({
          step: "process-archive",
          telephonySessionId: row.telephonySessionId,
          error: error.message,
        });
      }
    }
  }

  if (logger?.info) {
    logger.info("cx-recording.hourly", {
      windowStart: summary.windowStart,
      windowEnd: summary.windowEnd,
      uniqueInteractions: summary.metadata?.uniqueInteractions,
      domains: Object.fromEntries(
        Object.entries(summary.domains).map(([k, v]) => [
          k,
          {
            candidateRows: v.candidateRows,
            processedCompleted: v.processedCompleted,
            processedNoRecording: v.processedNoRecording,
            processedErrors: v.processedErrors,
          },
        ]),
      ),
    });
  }

  return summary;
}

module.exports = {
  computeWindow,
  runCxRecordingHourly,
};
