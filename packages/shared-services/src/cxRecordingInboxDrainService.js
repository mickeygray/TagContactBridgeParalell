"use strict";

// CX recording inbox drain — once-per-hour batch that processes
// whatever RingCX (or a manual test drop) has left in the local
// inbox directory. Reads files via fs (no SFTP client needed when
// the drain runs on the same machine as the SFTP server), uploads
// each one to Google Drive via the existing archive helper pattern,
// stamps the matching CallLog row, then moves the source file to
// /processed/<YYYY-MM-DD>/ on success or /unknown/ when no CallLog
// row matches.
//
// Cross-platform: paths come from env vars so the same service works
// on Windows (dev test) and Linux (production). Default paths assume
// a project-relative `ops/cx-recording-inbox/` layout for the
// Windows test bed; production overrides those via env.
//
// Idempotent: Drive-side dedup (via appProperties on telephonySessionId)
// catches re-uploads if a file is reprocessed; CallLog stamping is a
// $set so re-runs land the same fields.

const fs = require("fs").promises;
const path = require("path");
const { CallLog } = require("../../shared-models/src");
const { getSharedConfig } = require("../../shared-config/src");
const {
  createGoogleDriveClient,
  isGoogleDriveConfigured,
} = require("../../shared-integrations/src");

// RC's recording filenames usually embed the 30-digit telephonySessionId
// (interactionId) somewhere — sometimes prefixed by accountId,
// sometimes suffixed with dialogId / segmentId, sometimes inside
// underscores or dashes. Rather than depend on a specific format,
// we extract the first 30-digit run from the filename. Negative
// lookbehind/lookahead on \d so we don't grab 30-digit substrings
// of a longer run. (\b boundaries don't work here because `_` is a
// word character in JS regex — `_202605...` doesn't have a word
// boundary before the digits.)
const UII_PATTERN = /(?<!\d)(\d{30})(?!\d)/;

// Mime-type → extension lookup so we name the Drive file with the
// right extension regardless of what RC's filename ended in.
const MIME_EXTENSIONS = {
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/ogg": ".ogg",
};

function getConfig() {
  const inboxDir = String(
    process.env.CX_RECORDING_INBOX_DIR || "",
  ).trim();
  const processedDir = String(
    process.env.CX_RECORDING_INBOX_PROCESSED_DIR || "",
  ).trim();
  const unknownDir = String(
    process.env.CX_RECORDING_INBOX_UNKNOWN_DIR || "",
  ).trim();
  return {
    enabled:
      String(process.env.CX_RECORDING_INBOX_DRAIN_ENABLED || "false")
        .trim()
        .toLowerCase() === "true",
    inboxDir: inboxDir || path.resolve(__dirname, "..", "..", "..", "ops", "cx-recording-inbox", "inbox"),
    processedDir: processedDir || path.resolve(__dirname, "..", "..", "..", "ops", "cx-recording-inbox", "processed"),
    unknownDir: unknownDir || path.resolve(__dirname, "..", "..", "..", "ops", "cx-recording-inbox", "unknown"),
    maxPerTick: Math.max(Number(process.env.CX_RECORDING_INBOX_MAX_PER_TICK) || 200, 1),
  };
}

function isCxInboxDrainEnabled() {
  return getConfig().enabled;
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function pacificDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function inferMimeFromName(name) {
  const lower = String(name || "").toLowerCase();
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  return "application/octet-stream";
}

/**
 * Parse an RC inbox filename into the bits we need to match a CallLog.
 * Returns { telephonySessionId, dialogId, segmentId, agentId, raw }.
 * telephonySessionId is the only required field — anything else is
 * advisory metadata for the Drive appProperties.
 */
function parseFilename(name) {
  const base = path.basename(String(name || ""));
  const uiiMatch = base.match(UII_PATTERN);
  const telephonySessionId = uiiMatch ? uiiMatch[1] : null;
  return {
    telephonySessionId,
    raw: base,
  };
}

async function lookupCallLog(telephonySessionId) {
  if (!telephonySessionId) return null;
  return CallLog.findOne({ telephonySessionId }).lean();
}

function pickDestination(config, callLog) {
  // Reuse the existing recordingArchive destination buckets so all
  // archived recordings — EX-side AND CX-push — live alongside each
  // other in Drive. Default to `as` (ad-serv) since that's where the
  // 19 successfully-archived CX calls currently land.
  const destKey = String(process.env.CX_RECORDING_INBOX_DRIVE_DEST_KEY || "as")
    .trim()
    .toLowerCase();
  const archiveCfg = config.recordingArchive || {};
  const destinations = archiveCfg.destinations || {};
  return destinations[destKey] || destinations.as || destinations.og || null;
}

function sanitizeName(value, fallback = "unknown") {
  const cleaned = String(value || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 80);
  return cleaned || fallback;
}

function buildDriveFileName(callLog, sourceName) {
  const date = pacificDateKey(callLog.callStartTime || new Date());
  const agent = sanitizeName(callLog.agentName || "agent");
  const phone = sanitizeName(callLog.phone || callLog.normalizedPhone || "phone");
  const ext = path.extname(sourceName) || ".wav";
  return `${date}_${agent}_${phone}_${callLog.telephonySessionId}${ext}`;
}

async function uploadToDrive({
  buffer,
  fileName,
  mimeType,
  callLog,
  destination,
  driveClient,
  logger,
}) {
  const dateKey = pacificDateKey(callLog.callStartTime || new Date());
  const appProperties = {
    telephonySessionId: String(callLog.telephonySessionId),
    domain: String(callLog.domain || "").toUpperCase(),
    platform: String(callLog.platform || "cx"),
    direction: String(callLog.direction || "outbound"),
    caseId: callLog.caseId ? String(callLog.caseId) : "",
    bucket: destination.key,
    dateKey,
    source: "rcx-sftp-push",
  };

  // Dedup pre-check — if we've already uploaded a file with this
  // telephonySessionId (e.g. the EX-side archive pipeline beat us to
  // it, or a previous tick already drained this file), reuse the
  // existing Drive fileId instead of re-uploading.
  const existing = await driveClient
    .findFilesByAppProperties({
      appProperties: { telephonySessionId: appProperties.telephonySessionId },
      pageSize: 1,
    })
    .catch(() => []);
  if (Array.isArray(existing) && existing.length > 0) {
    logger?.info?.("cx-inbox.drive_dedup_hit", {
      telephonySessionId: callLog.telephonySessionId,
      driveFileId: existing[0].id,
    });
    return {
      deduped: true,
      driveFileId: existing[0].id,
      driveFolderId: existing[0].parents?.[0] || destination.folderId,
      driveWebViewLink: existing[0].webViewLink || null,
      driveWebContentLink: existing[0].webContentLink || null,
      fileName: existing[0].name || fileName,
    };
  }

  // Find-or-create the YYYY-MM-DD subfolder inside the bucket so files
  // group by day in Drive.
  const dateFolder = await driveClient.ensureFolder({
    parentId: destination.folderId,
    name: dateKey,
  });
  const uploadFolderId = dateFolder?.id || destination.folderId;

  const upload = await driveClient.uploadFileResumable({
    folderId: uploadFolderId,
    name: fileName,
    mimeType,
    buffer,
    appProperties,
    properties: appProperties,
    description: `RingCX SFTP-push recording for ${callLog.domain} ${callLog.caseId ? `case ${callLog.caseId}` : "unbound call"}`,
  });

  return {
    deduped: false,
    driveFileId: upload?.id || null,
    driveFolderId: uploadFolderId,
    driveWebViewLink: upload?.webViewLink || null,
    driveWebContentLink: upload?.webContentLink || null,
    fileName,
  };
}

async function stampCallLog(callLog, uploadResult, mimeType) {
  await CallLog.updateOne(
    { _id: callLog._id },
    {
      $set: {
        "recordingArchive.status": "completed",
        "recordingArchive.provider": "ringcx",
        "recordingArchive.source": "rcx-sftp-push",
        "recordingArchive.fileName": uploadResult.fileName,
        "recordingArchive.driveFileId": uploadResult.driveFileId,
        "recordingArchive.driveFolderId": uploadResult.driveFolderId,
        "recordingArchive.driveWebViewLink": uploadResult.driveWebViewLink,
        "recordingArchive.driveWebContentLink": uploadResult.driveWebContentLink,
        "recordingArchive.mimeType": mimeType,
        "recordingArchive.uploadedAt": new Date(),
        "recordingArchive.error": null,
        ...(uploadResult.deduped ? { "recordingArchive.dedupedAt": new Date() } : {}),
      },
    },
  );
}

async function moveFile(srcPath, destDir, destName) {
  await ensureDir(destDir);
  const destPath = path.join(destDir, destName);
  await fs.rename(srcPath, destPath);
  return destPath;
}

/**
 * Process one file from the inbox. Returns a result object describing
 * what happened (uploaded, deduped, unknown, error, dry-run).
 */
async function ingestOne({
  filePath,
  config,
  archiveConfig,
  driveClient,
  destination,
  dryRun,
  logger,
}) {
  const name = path.basename(filePath);
  const parsed = parseFilename(name);

  if (!parsed.telephonySessionId) {
    if (!dryRun) {
      await moveFile(filePath, config.unknownDir, name);
    }
    return {
      file: name,
      status: "unknown-no-uii",
      moved: dryRun ? null : path.join(config.unknownDir, name),
    };
  }

  const callLog = await lookupCallLog(parsed.telephonySessionId);
  if (!callLog) {
    if (!dryRun) {
      await moveFile(filePath, config.unknownDir, name);
    }
    return {
      file: name,
      telephonySessionId: parsed.telephonySessionId,
      status: "unknown-no-calllog",
      moved: dryRun ? null : path.join(config.unknownDir, name),
    };
  }

  if (dryRun) {
    return {
      file: name,
      telephonySessionId: parsed.telephonySessionId,
      callLogId: String(callLog._id),
      durationSec: callLog.durationSec,
      domain: callLog.domain,
      caseId: callLog.caseId || null,
      status: "would-upload",
    };
  }

  const buffer = await fs.readFile(filePath);
  const mimeType = inferMimeFromName(name);
  const fileName = buildDriveFileName(callLog, name);
  const uploadResult = await uploadToDrive({
    buffer,
    fileName,
    mimeType,
    callLog,
    destination,
    driveClient,
    logger,
  });
  await stampCallLog(callLog, uploadResult, mimeType);

  // Move source file to processed/<date>/ — keeps inbox empty and
  // gives a 30-day audit trail if anyone wants to verify what
  // landed when. Could be deleted instead via a cleanup tick.
  const processedSubdir = path.join(config.processedDir, pacificDateKey());
  await moveFile(filePath, processedSubdir, name);

  return {
    file: name,
    telephonySessionId: parsed.telephonySessionId,
    callLogId: String(callLog._id),
    domain: callLog.domain,
    caseId: callLog.caseId || null,
    durationSec: callLog.durationSec,
    status: uploadResult.deduped ? "deduped" : "uploaded",
    driveFileId: uploadResult.driveFileId,
    movedTo: path.join(processedSubdir, name),
  };
}

/**
 * Drain the inbox once. Called from the hourly sweeper, or one-off
 * via the test script.
 */
async function runCxRecordingInboxDrainTick({ logger = null, dryRun = false } = {}) {
  const startedAt = new Date();
  const cfg = getConfig();
  const summary = {
    startedAt,
    inboxDir: cfg.inboxDir,
    dryRun: Boolean(dryRun),
    scanned: 0,
    uploaded: 0,
    deduped: 0,
    unknownNoUii: 0,
    unknownNoCallLog: 0,
    errors: 0,
    items: [],
  };

  // Soft check — if the inbox doesn't exist yet, just return cleanly.
  // First-run case before the SFTP setup script has been executed.
  let names = [];
  try {
    names = await fs.readdir(cfg.inboxDir);
  } catch (error) {
    if (error.code === "ENOENT") {
      summary.skipped = true;
      summary.reason = "inbox-dir-missing";
      summary.finishedAt = new Date();
      summary.durationMs = summary.finishedAt - startedAt;
      return summary;
    }
    throw error;
  }

  // Only files; ignore subdirectories. Cap to maxPerTick so a flood
  // can't lock up the hourly sweep.
  const audioFiles = [];
  for (const name of names) {
    if (audioFiles.length >= cfg.maxPerTick) break;
    if (name.startsWith(".")) continue;
    const full = path.join(cfg.inboxDir, name);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat?.isFile()) continue;
    audioFiles.push({ name, full, size: stat.size });
  }
  summary.scanned = audioFiles.length;

  if (audioFiles.length === 0) {
    summary.finishedAt = new Date();
    summary.durationMs = summary.finishedAt - startedAt;
    return summary;
  }

  // Drive client + destination resolution once per tick.
  const sharedCfg = getSharedConfig();
  const archiveConfig = sharedCfg.recordingArchive || {};
  if (!dryRun && !isGoogleDriveConfigured(archiveConfig.drive || {})) {
    summary.skipped = true;
    summary.reason = "drive-not-configured";
    summary.finishedAt = new Date();
    summary.durationMs = summary.finishedAt - startedAt;
    return summary;
  }
  const driveClient = dryRun
    ? null
    : createGoogleDriveClient(archiveConfig.drive || {});
  const destination = dryRun ? null : pickDestination(sharedCfg, null);
  if (!dryRun && !destination?.folderId) {
    summary.skipped = true;
    summary.reason = "no-drive-destination";
    summary.finishedAt = new Date();
    summary.durationMs = summary.finishedAt - startedAt;
    return summary;
  }

  // Pre-create processed + unknown dirs so we don't race on first run.
  if (!dryRun) {
    await ensureDir(cfg.processedDir);
    await ensureDir(cfg.unknownDir);
  }

  for (const file of audioFiles) {
    try {
      const result = await ingestOne({
        filePath: file.full,
        config: cfg,
        archiveConfig,
        driveClient,
        destination,
        dryRun,
        logger,
      });
      summary.items.push(result);
      if (result.status === "uploaded") summary.uploaded += 1;
      else if (result.status === "deduped") summary.deduped += 1;
      else if (result.status === "unknown-no-uii") summary.unknownNoUii += 1;
      else if (result.status === "unknown-no-calllog") summary.unknownNoCallLog += 1;
    } catch (error) {
      summary.errors += 1;
      summary.items.push({
        file: file.name,
        status: "error",
        error: error.message,
      });
      logger?.warn?.("cx-inbox.ingest_failed", {
        file: file.name,
        error: error.message,
      });
    }
  }

  summary.finishedAt = new Date();
  summary.durationMs = summary.finishedAt - startedAt;
  return summary;
}

async function runCxRecordingInboxDrainIfEnabled({ logger } = {}) {
  if (!isCxInboxDrainEnabled()) {
    return { skipped: true, reason: "disabled" };
  }
  return runCxRecordingInboxDrainTick({ logger });
}

module.exports = {
  runCxRecordingInboxDrainTick,
  runCxRecordingInboxDrainIfEnabled,
  isCxInboxDrainEnabled,
  parseFilename,
  // exported for tests
  getConfig,
};
