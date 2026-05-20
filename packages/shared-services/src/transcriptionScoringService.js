"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createRingCentralClient,
  createGoogleDriveClient,
  isGoogleDriveConfigured,
} = require("../../shared-integrations/src");
const { callLogRepository } = require("../../shared-repositories/src");
const { CallLog } = require("../../shared-models/src");
const { emitHourlyJobEvent } = require("./hourlyJobEventService");
const { syncCallLedgerBySession } = require("./callLedgerService");
const { syncCaseCallRollup } = require("./caseCallRollupService");

// Google Drive config — mirrors recordingStorageService.getDriveConfig so
// transcription can pull from the already-archived file when the
// recording-archive pipeline beat us to it. Avoids the RingCentral
// rate-limit wedge: a single 429 from RC's call-log API otherwise
// blocks every subsequent transcription for the duration of the
// backoff window, even though we already have the file locally on Drive.
function getDriveConfigFromEnv() {
  return {
    clientEmail: process.env.GOOGLE_DRIVE_CLIENT_EMAIL || "",
    privateKey: String(process.env.GOOGLE_DRIVE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    tokenUri: process.env.GOOGLE_DRIVE_TOKEN_URI || "https://oauth2.googleapis.com/token",
    scope: process.env.GOOGLE_DRIVE_SCOPE || "https://www.googleapis.com/auth/drive.file",
  };
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const WHISPER_MODEL = process.env.WHISPER_MODEL || "whisper-1";
const CLAUDE_MODEL =
  process.env.CLAUDE_SCORING_MODEL || "claude-sonnet-4-5";
const RECORDING_SEARCH_WINDOW_MS =
  Number(process.env.RB_RECORDING_SEARCH_WINDOW_MS) || 30 * 60 * 1000;
// Minimum age the call must be before we try to fetch the recording. RC
// needs time to finalize recordings after a call ends; querying too early
// always returns no_recording. Tunable via env (ms).
const MIN_RECORDING_AGE_MS =
  Number(process.env.MIN_RECORDING_AGE_MS) || 90_000;

// Hard limit on transcription retry attempts. RC generally publishes
// recordings within 5-10 minutes; a call still returning `no_recording`
// 24 hourly tries later (~24h) will never resolve — typically the
// recording was never made (no consent, call too short, recording
// disabled for that extension). Flip to `abandoned` so the hourly
// sweeper's `recording-ready-state` resolution check stops waking it.
const MAX_TRANSCRIPTION_ATTEMPTS =
  Number(process.env.MAX_TRANSCRIPTION_ATTEMPTS) || 24;

const TEMP_DIR = path.join(os.tmpdir(), "parallel-recordings");
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

function isConfigured() {
  return Boolean(OPENAI_API_KEY);
}

function isScoringConfigured() {
  return Boolean(ANTHROPIC_API_KEY);
}

/**
 * Find the RC call-log record carrying the recording for this session.
 * Searches a ±30-minute window around the call start time and matches on
 * telephonySessionId (top-level or on any leg). Returns the `recording`
 * sub-object with `contentUri` and duration if found, else null.
 *
 * Does NOT retry — the sweeper's outer loop owns retry cadence. That
 * avoids the inline 60s blocking from the old app: recordings often
 * need time to finalize in RC, and a sweeper that runs every 10 min
 * will catch them eventually without any single call blocking.
 */
async function findRecordingForSession({ telephonySessionId, callStartTime, extensionId }) {
  const rc = createRingCentralClient();
  await rc.reinitializePlatform({ force: false, reason: "transcription-lookup" });

  const start = callStartTime
    ? new Date(callStartTime).getTime()
    : Date.now() - RECORDING_SEARCH_WINDOW_MS;
  const params = {
    view: "Detailed",
    type: "Voice",
    perPage: 100,
    dateFrom: new Date(start - 10 * 60 * 1000).toISOString(),
    dateTo: new Date(start + RECORDING_SEARCH_WINDOW_MS).toISOString(),
  };

  let records = [];
  if (extensionId) {
    try {
      const payload = await rc.getExtensionCallLog(String(extensionId), params);
      records = payload.records || [];
    } catch {
      records = [];
    }
  }
  if (records.length === 0) {
    const payload = await rc.getAccountCallLog(params);
    records = payload.records || [];
  }

  const rec = records.find(
    (r) =>
      r.telephonySessionId === telephonySessionId ||
      (Array.isArray(r.legs) &&
        r.legs.some((l) => l.telephonySessionId === telephonySessionId)),
  );
  if (!rec?.recording) return null;
  return {
    record: rec,
    recording: {
      id: rec.recording.id,
      contentUri: rec.recording.contentUri,
      duration: rec.duration || 0,
    },
  };
}

/**
 * Read a previously-archived recording from Google Drive and write it
 * to a temp file. Used when `callLog.recordingArchive.driveFileId` is
 * set — bypasses the RingCentral CDN entirely so a RC rate-limit
 * cannot block transcription on files we already own.
 *
 * mimeType from Drive drives the file extension (Whisper accepts both
 * mp3 and wav). Returns null when Drive isn't configured (caller
 * should fall back to the RC path).
 */
async function downloadRecordingFromDrive(driveFileId, sessionIdSafe) {
  const driveConfig = getDriveConfigFromEnv();
  if (!isGoogleDriveConfigured(driveConfig)) return null;
  const client = createGoogleDriveClient(driveConfig);
  const { buffer, mimeType } = await client.downloadFile({ fileId: driveFileId });
  if (!buffer || buffer.length === 0) {
    throw new Error(`Drive file ${driveFileId} returned empty body`);
  }
  const ext =
    mimeType?.includes("wav") ? ".wav" :
    mimeType?.includes("mpeg") || mimeType?.includes("mp3") ? ".mp3" :
    mimeType?.includes("ogg") ? ".ogg" :
    ".mp3"; // safe default — Whisper sniffs the format anyway
  const filePath = path.join(TEMP_DIR, `${sessionIdSafe}${ext}`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

async function downloadRecording(contentUri, sessionIdSafe) {
  const rc = createRingCentralClient();
  // `authenticate()` is the public entry point — returns the cached
  // access token or refreshes if it's expiring soon. The older
  // `getAccessToken` helper isn't exposed on the client surface.
  const token = await rc.authenticate();
  if (!token) throw new Error("No RC access token available");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  let response;
  try {
    response = await fetch(contentUri, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      redirect: "follow",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`recording download HTTP ${response.status}`);
  }
  const ct = response.headers.get("content-type") || "";
  const ext = ct.includes("mpeg") ? ".mp3" : ct.includes("wav") ? ".wav" : ".mp3";
  const buf = Buffer.from(await response.arrayBuffer());
  const filePath = path.join(TEMP_DIR, `${sessionIdSafe}${ext}`);
  fs.writeFileSync(filePath, buf);
  return filePath;
}

async function transcribeWithWhisper(audioPath) {
  // Node 18+ has global FormData + Blob. We build the multipart by
  // wrapping the file buffer in a Blob so fetch serializes it correctly.
  const buf = fs.readFileSync(audioPath);
  const blob = new Blob([buf], { type: "audio/mpeg" });
  const form = new FormData();
  form.append("file", blob, path.basename(audioPath));
  form.append("model", WHISPER_MODEL);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  let response;
  try {
    response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`whisper HTTP ${response.status}: ${body.slice(0, 200)}`);
  }
  const data = await response.json();
  if (Array.isArray(data.segments) && data.segments.length > 0) {
    return data.segments.map((s) => String(s.text || "").trim()).join(" ");
  }
  return data.text || "";
}

const SCORING_SYSTEM_PROMPT = `You are a call quality analyst for a tax resolution firm. You are scoring an outbound sales call where an agent called a lead that was purchased from a form vendor.

Your job is to assess the LEAD QUALITY (not the agent's performance) for vendor reporting purposes. The firm wants to know if the lead vendor is sending real, qualified prospects or garbage.

Score each dimension 1-10 and provide a brief justification. Return ONLY valid JSON, no markdown.

JSON schema:
{
  "overall": <number 1-10>,
  "dimensions": {
    "contactability": { "score": <1-10>, "note": "<brief>" },
    "legitimacy": { "score": <1-10>, "note": "<brief>" },
    "tax_issue_present": { "score": <1-10>, "note": "<brief>" },
    "interest_level": { "score": <1-10>, "note": "<brief>" },
    "qualification": { "score": <1-10>, "note": "<brief>" }
  },
  "lead_verdict": "<hot|warm|cold|dead|fake>",
  "summary": "<2-3 sentence summary for vendor report>",
  "red_flags": ["<list any red flags>"],
  "key_details": {
    "answered": <boolean>,
    "voicemail": <boolean>,
    "tax_type": "<irs|state|both|unclear|none>",
    "tax_amount_mentioned": "<string or null>",
    "employed": "<yes|no|unclear>",
    "willing_to_proceed": "<yes|no|maybe|n/a>"
  }
}

Scoring guide:
- contactability: Did someone answer? Was it the right person? (1=disconnected/wrong number, 10=answered immediately, confirmed identity)
- legitimacy: Is this a real person with a real tax issue? (1=fake/spam, 10=clearly legitimate taxpayer)
- tax_issue_present: Do they actually owe taxes? (1=no tax issue, 10=confirmed large tax debt)
- interest_level: Are they interested in getting help? (1=hostile/not interested, 10=eager to proceed)
- qualification: Overall, is this a viable prospect? (1=total waste, 10=ready to sign)`;

async function scoreWithClaude(transcript, callLogDoc) {
  const userMessage = `Score this call to a lead.

Agent: ${callLogDoc.agentName || "Unknown"}
Company: ${callLogDoc.domain || "Unknown"}
Phone: ${callLogDoc.phone || "Unknown"}
Direction: ${callLogDoc.direction || "Unknown"}
Duration: ${callLogDoc.durationSec || 0} seconds
${callLogDoc.caseId ? `Logics Case: ${callLogDoc.caseDomain} #${callLogDoc.caseId}` : "No existing case"}
${callLogDoc.sourceName ? `Marketing source: ${callLogDoc.sourceName}` : ""}

TRANSCRIPT:
${String(transcript).slice(0, 12000)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  let response;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 1000,
        messages: [{ role: "user", content: userMessage }],
        system: SCORING_SYSTEM_PROMPT,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`claude HTTP ${response.status}: ${body.slice(0, 200)}`);
  }
  const data = await response.json();
  const text = data?.content?.[0]?.text || "";
  const clean = text
    .replace(/```json\s*/g, "")
    .replace(/```\s*/g, "")
    .trim();
  return JSON.parse(clean);
}

async function syncLedgerAndCaseRollup(domain, telephonySessionId, caseId = null) {
  await syncCallLedgerBySession(domain, telephonySessionId).catch(() => null);
  if (caseId != null) {
    await syncCaseCallRollup(domain, caseId, {
      recentLimit: 5,
    }).catch(() => null);
  }
}

async function scoreCallLogTranscript({
  domain,
  telephonySessionId,
  logger = null,
}) {
  const callLog = await callLogRepository.findCallLog(
    domain,
    telephonySessionId,
  );
  if (!callLog) {
    return { status: "error", error: "CallLog row not found" };
  }

  const transcript = String(callLog?.transcription?.text || "").trim();
  if (!transcript) {
    return { status: "no_transcript" };
  }

  if (callLog?.callScore?.overall != null) {
    return { status: "already_scored" };
  }

  if (!isScoringConfigured()) {
    await CallLog.updateOne(
      { _id: callLog._id },
      {
        $set: {
          "callScore.scoreError": "ANTHROPIC_API_KEY not set",
        },
      },
    );
    return { status: "skipped" };
  }

  try {
    const scoring = await scoreWithClaude(transcript, callLog);
    await CallLog.updateOne(
      { _id: callLog._id },
      {
        $set: {
          callScore: {
            ...scoring,
            scoredAt: new Date(),
            scoreError: null,
          },
        },
      },
    );
    await syncLedgerAndCaseRollup(domain, telephonySessionId, callLog.caseId);
    return {
      status: "completed",
      scored: true,
    };
  } catch (error) {
    logger?.warn?.("scoring.transcript_failed", {
      telephonySessionId,
      error: error.message,
    });
    await CallLog.updateOne(
      { _id: callLog._id },
      {
        $set: {
          "callScore.scoreError": error.message,
        },
      },
    );
    return {
      status: "score_failed",
      error: error.message,
    };
  }
}

/**
 * Full pipeline for a single CallLog row. Idempotent — running it twice
 * on the same session is safe (re-transcription replaces the transcript;
 * re-scoring replaces the score).
 *
 * Returns a status enum describing the final state so the sweeper can
 * decide whether to re-queue:
 *   completed       — transcript + score written
 *   no_recording    — RC has no recording; don't retry indefinitely
 *   no_transcript   — Whisper returned empty string
 *   transcription_failed — Whisper API call failed
 *   download_failed — could not download audio
 *   skipped         — OpenAI key not configured
 *   error           — unexpected failure
 */
async function processCallLogRecording({
  domain,
  telephonySessionId,
  lane = "hourly",
  logger = null,
}) {
  const callLog = await callLogRepository.findCallLog(
    domain,
    telephonySessionId,
  );
  if (!callLog) {
    return { status: "error", error: "CallLog row not found" };
  }

  if (!isConfigured()) {
    await CallLog.updateOne(
      { _id: callLog._id },
      {
        $set: {
          "transcription.status": "skipped",
          "transcription.error": "OPENAI_API_KEY not set",
        },
      },
    );
    return { status: "skipped" };
  }

  // Age guard — if the call ended less than MIN_RECORDING_AGE_MS ago,
  // RC almost certainly doesn't have the recording ready yet. Bail fast
  // with a distinct status so the sweeper requeues with backoff rather
  // than burning a retry attempt on a no_recording response.
  const callEndReference =
    callLog.callEndTime ||
    (callLog.callStartTime && callLog.durationSec
      ? new Date(
          new Date(callLog.callStartTime).getTime() +
            (callLog.durationSec || 0) * 1000,
        )
      : callLog.callStartTime);
  if (callEndReference) {
    const ageMs = Date.now() - new Date(callEndReference).getTime();
    if (ageMs < MIN_RECORDING_AGE_MS) {
      // Don't increment transcription.attempts — this isn't a real try.
      return {
        status: "too_early",
        ageMs,
        thresholdMs: MIN_RECORDING_AGE_MS,
      };
    }
  }

  await CallLog.updateOne(
    { _id: callLog._id },
    {
      $set: { "transcription.status": "processing" },
      $inc: { "transcription.attempts": 1 },
    },
  );

  const sessionIdSafe = String(telephonySessionId).replace(/[^a-z0-9]/gi, "_");
  let audioPath = null;

  try {
    // Drive-first: if the recordingArchive pipeline already pulled and
    // uploaded the file, read it from Drive instead of going back to
    // RingCentral. Two reasons:
    //   1. RC rate-limits (a single 429 from RC's call-log API sets a
    //      global backoff that wedges every subsequent transcription,
    //      even ones whose recording we already own).
    //   2. RingCX-platform calls — recordingArchive pulls those via
    //      RingCX's interaction-metadata pipeline (entirely separate
    //      from RC's EX call-log endpoint), so the Drive copy is the
    //      ONLY working path for CX outbound.
    let driveRecordingDuration = null;
    let driveRecordingUri = null;
    const archive = callLog.recordingArchive || {};
    if (archive.status === "completed" && archive.driveFileId) {
      try {
        audioPath = await downloadRecordingFromDrive(
          archive.driveFileId,
          sessionIdSafe,
        );
      } catch (driveError) {
        // Drive blip — log and fall through to the RC path below.
        logger?.warn?.("transcription.drive_download_failed", {
          telephonySessionId,
          driveFileId: archive.driveFileId,
          error: driveError.message,
        });
        audioPath = null;
      }
      if (audioPath) {
        driveRecordingUri =
          archive.driveWebViewLink || archive.driveWebContentLink || null;
        driveRecordingDuration = Number(callLog.durationSec) || null;
      }
    }

    let recInfo = null;
    if (!audioPath) {
      recInfo = await findRecordingForSession({
        telephonySessionId,
        callStartTime: callLog.callStartTime,
        extensionId: callLog.extensionId,
      });
    }
    if (!audioPath && !recInfo) {
      // `transcription.attempts` was just incremented above. Check if
      // we've burned through the retry budget — at that point the
      // recording is never coming and we should stop polling.
      const attempts = Number(callLog?.transcription?.attempts || 0) + 1;
      const exhausted = attempts >= MAX_TRANSCRIPTION_ATTEMPTS;
      await CallLog.updateOne(
        { _id: callLog._id },
        {
          $set: {
            "transcription.status": exhausted ? "abandoned" : "no_recording",
            "transcription.error": exhausted
              ? `Recording never published after ${attempts} attempts — abandoning`
              : "Recording not found in RC call log (may not be finalized yet)",
          },
        },
      );
      logger?.info?.(
        exhausted ? "transcription.abandoned" : "transcription.no_recording",
        { telephonySessionId, attempts },
      );
      return {
        status: exhausted ? "abandoned" : "no_recording",
        attempts,
      };
    }

    // Only pull from RC if we didn't already get the file from Drive.
    if (!audioPath) {
      audioPath = await downloadRecording(recInfo.recording.contentUri, sessionIdSafe);
    }
    const transcript = await transcribeWithWhisper(audioPath);

    // recordingUri + recordingDuration on the saved transcription
    // depend on which source we used.
    const finalRecordingUri = recInfo
      ? recInfo.recording.contentUri
      : driveRecordingUri;
    const finalRecordingDuration = recInfo
      ? recInfo.recording.duration
      : driveRecordingDuration;
    const transcriptionSource = recInfo ? "whisper" : "whisper-drive";

    if (!transcript) {
      await CallLog.updateOne(
        { _id: callLog._id },
        {
          $set: {
            "transcription.status": "no_transcript",
            "transcription.error": "Whisper returned empty string",
            "transcription.recordingUri": finalRecordingUri,
            "transcription.recordingDuration": finalRecordingDuration,
            "transcription.source": transcriptionSource,
          },
        },
      );
      await syncCallLedgerBySession(domain, telephonySessionId).catch(() => null);
      return { status: "no_transcript" };
    }

    let scoring = null;
    let scoreError = null;
    if (ANTHROPIC_API_KEY) {
      try {
        scoring = await scoreWithClaude(transcript, callLog);
      } catch (err) {
        scoreError = err.message;
        logger?.warn?.("scoring.failed", { telephonySessionId, error: err.message });
      }
    }

    const update = {
      "transcription.status": "completed",
      "transcription.text": transcript,
      "transcription.recordingUri": finalRecordingUri,
      "transcription.recordingDuration": finalRecordingDuration,
      "transcription.transcribedAt": new Date(),
      "transcription.error": null,
      "transcription.source": transcriptionSource,
    };
    if (scoring) {
      update.callScore = { ...scoring, scoredAt: new Date(), scoreError: null };
    } else if (scoreError) {
      update["callScore.scoreError"] = scoreError;
    }
    await CallLog.updateOne({ _id: callLog._id }, { $set: update });
    await syncLedgerAndCaseRollup(domain, telephonySessionId, callLog.caseId);
    return {
      status: "completed",
      transcriptLength: transcript.length,
      scored: Boolean(scoring),
    };
  } catch (err) {
    const failStatus = err.message?.includes("download")
      ? "download_failed"
      : "transcription_failed";
    await CallLog.updateOne(
      { _id: callLog._id },
      {
        $set: {
          "transcription.status": failStatus,
          "transcription.error": err.message,
        },
      },
    );
    logger?.warn?.("transcription.pipeline_failed", {
      telephonySessionId,
      error: err.message,
    });
    await emitHourlyJobEvent({
      lane: String(lane || "hourly").toLowerCase() === "nightly" ? "nightly" : "hourly",
      domain,
      eventType: "call.recording.pipeline.retry",
      targetService: "control-plane",
      handlerKey: "retryCallRecordingPipeline",
      aggregateType: "call-log",
      aggregateId: String(telephonySessionId),
      caseId: callLog.caseId != null ? Number(callLog.caseId) : null,
      payload: {
        domain,
        telephonySessionId,
        callLogId: String(callLog._id),
        failStatus,
      },
      resolutionCheckKey: "recording-ready-state",
      resolutionContext: {
        telephonySessionId,
        extensionId: callLog.extensionId || null,
      },
      dedupeKey: `${String(domain || "").toUpperCase()}:recording:${String(telephonySessionId)}`,
      emittedBy: "control-plane",
      priority: 60,
      severity: "warning",
      alertSummary: `Call recording pipeline failed with ${failStatus}; hourly retry queued`,
      immediateRetryAttempts: 1,
      immediateRetryDelayMs: 1000,
      provideSummary: false,
      firstError: err.message,
      notify: false,
    }).catch(() => null);
    return { status: failStatus, error: err.message };
  } finally {
    if (audioPath && fs.existsSync(audioPath)) {
      try {
        fs.unlinkSync(audioPath);
      } catch {
        /* ignore */
      }
    }
  }
}

module.exports = {
  isConfigured,
  isScoringConfigured,
  processCallLogRecording,
  scoreCallLogTranscript,
};
