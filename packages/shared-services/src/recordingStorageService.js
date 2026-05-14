"use strict";

const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const { env } = require("../../shared-config/src");
const { ExternalServiceError, ValidationError } = require("../../shared-errors/src");
const {
  createGoogleDriveClient,
  isGoogleDriveConfigured,
} = require("../../shared-integrations/src/googleDriveClient");

// Why this module exists:
//   Recordings used to land in `os.tmpdir()/parallel-recordings` and the
//   archive-to-Drive logic was inlined in scripts/dump-recordings-to-drive.js.
//   That left two unanswered questions: where does the local file live
//   permanently between download and upload? when does it get deleted?
//
//   Policy (locked 2026-05-13):
//     - Local cache is staging, Drive is canonical.
//     - On successful Drive upload, delete the local audio bytes.
//     - Keep a sidecar `<basename>.manifest.json` next to (or replacing)
//       the deleted file so we can prove archival without paying for the
//       audio bytes on disk twice.
//     - Per-machine root is env-driven so Windows-now and Ubuntu-later
//       both work without hardcoding paths in services.
//
// Layout:
//   $PARALLEL_RECORDINGS_ROOT/
//     inbound/YYYY-MM-DD/{tenant}/{sessionId}-{segmentId}.{ext}
//     inbound/YYYY-MM-DD/{tenant}/{sessionId}-{segmentId}.manifest.json
//     training/YYYY-MM-DD/{sessionId}/turn-NNN-{rep|prospect}.{ext}
//     training/YYYY-MM-DD/{sessionId}/session.manifest.json
//
// All paths are case-sensitive on Linux; we normalize tenants to upper
// (TAG/WYNN) and side names to lower (rep/prospect) so the same path is
// produced regardless of caller convention.

const KIND_INBOUND = "inbound";
const KIND_TRAINING = "training";
const SUPPORTED_KINDS = new Set([KIND_INBOUND, KIND_TRAINING]);

const DEFAULT_INBOUND_FOLDER_ENV = "RECORDINGS_DRIVE_INBOUND_FOLDER_ID";
const DEFAULT_TRAINING_FOLDER_ENV = "RECORDINGS_DRIVE_TRAINING_FOLDER_ID";

function getDefaultRoot() {
  // Windows: %LOCALAPPDATA%\Parallel\recordings — survives reboots, not
  // wiped by temp cleaners, doesn't roam.
  // Linux:   /var/lib/parallel/recordings — standard system data path,
  //          systemd unit will own the directory.
  // macOS:   ~/Library/Application Support/Parallel/recordings (dev only).
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "Parallel", "recordings");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Parallel", "recordings");
  }
  return "/var/lib/parallel/recordings";
}

function getRecordingsRoot() {
  const override = String(env("PARALLEL_RECORDINGS_ROOT", "")).trim();
  return override || getDefaultRoot();
}

function getDriveConfig() {
  return {
    clientEmail: env("GOOGLE_DRIVE_CLIENT_EMAIL", ""),
    privateKey: env("GOOGLE_DRIVE_PRIVATE_KEY", "").replace(/\\n/g, "\n"),
    tokenUri: env("GOOGLE_DRIVE_TOKEN_URI", "https://oauth2.googleapis.com/token"),
    scope: env("GOOGLE_DRIVE_SCOPE", "https://www.googleapis.com/auth/drive.file"),
  };
}

function getDriveFolderForKind(kind) {
  if (kind === KIND_INBOUND) {
    return String(env(DEFAULT_INBOUND_FOLDER_ENV, "")).trim();
  }
  if (kind === KIND_TRAINING) {
    return String(env(DEFAULT_TRAINING_FOLDER_ENV, "")).trim();
  }
  return "";
}

function isDriveArchiveConfigured(kind = null) {
  if (!isGoogleDriveConfigured(getDriveConfig())) return false;
  if (kind && !getDriveFolderForKind(kind)) return false;
  return true;
}

function todayDateStamp(date = new Date()) {
  // ISO date in UTC. We use UTC so the same recording doesn't land in
  // two different folders if the host crosses midnight in the middle of
  // a download.
  return date.toISOString().slice(0, 10);
}

function sanitizeSegment(segment) {
  return String(segment || "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function normalizeKind(kind) {
  if (!SUPPORTED_KINDS.has(kind)) {
    throw new ValidationError(`Unsupported recording kind: ${kind}`);
  }
  return kind;
}

function buildLocalPath({
  kind,
  tenant = "default",
  sessionId,
  segmentId = null,
  ext = "mp3",
  date = null,
  turnNumber = null,
  side = null,
  basenameOverride = null,
} = {}) {
  normalizeKind(kind);
  const dateStamp = date || todayDateStamp();
  const safeExt = sanitizeSegment(ext) || "bin";
  const safeSession = sanitizeSegment(sessionId);
  if (!safeSession) {
    throw new ValidationError("sessionId is required for recording storage");
  }
  if (kind === KIND_INBOUND) {
    const safeTenant = sanitizeSegment(String(tenant || "default").toUpperCase()) || "DEFAULT";
    const base = basenameOverride
      || (segmentId
        ? `${safeSession}-${sanitizeSegment(segmentId)}.${safeExt}`
        : `${safeSession}.${safeExt}`);
    return path.join(
      getRecordingsRoot(),
      KIND_INBOUND,
      dateStamp,
      safeTenant,
      base,
    );
  }
  // training
  const turnPart = turnNumber != null ? String(turnNumber).padStart(3, "0") : "000";
  const safeSide = sanitizeSegment(String(side || "rep").toLowerCase()) || "rep";
  const base = basenameOverride || `turn-${turnPart}-${safeSide}.${safeExt}`;
  return path.join(
    getRecordingsRoot(),
    KIND_TRAINING,
    dateStamp,
    safeSession,
    base,
  );
}

function manifestPathFor(localPath) {
  // Sit next to the audio file so a single `ls` on the date dir shows
  // both bytes and provenance. .manifest.json (not .json) so we don't
  // collide with the verbose_json transcript dumps some scripts make.
  return `${localPath}.manifest.json`;
}

function sessionManifestPathFor({ kind, sessionId, date = null }) {
  if (kind !== KIND_TRAINING) {
    throw new ValidationError("Session-level manifest is training-only");
  }
  const dateStamp = date || todayDateStamp();
  return path.join(
    getRecordingsRoot(),
    KIND_TRAINING,
    dateStamp,
    sanitizeSegment(sessionId),
    "session.manifest.json",
  );
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * Write an audio buffer to the canonical local path for the given kind.
 * Returns metadata the caller can hand to archiveRecordingToDrive later
 * (or stash in a session manifest for batched archive).
 */
async function writeRecordingBuffer({
  kind,
  buffer,
  tenant = "default",
  sessionId,
  segmentId = null,
  ext = "mp3",
  mimeType = "audio/mpeg",
  turnNumber = null,
  side = null,
  date = null,
  basenameOverride = null,
} = {}) {
  normalizeKind(kind);
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new ValidationError("Recording buffer is required");
  }
  const localPath = buildLocalPath({
    kind,
    tenant,
    sessionId,
    segmentId,
    ext,
    date,
    turnNumber,
    side,
    basenameOverride,
  });
  await ensureDir(path.dirname(localPath));
  await fsp.writeFile(localPath, buffer);
  return {
    localPath,
    byteLength: buffer.length,
    sha256: sha256(buffer),
    mimeType,
    kind,
    tenant,
    sessionId,
    segmentId,
    turnNumber,
    side,
    date: date || todayDateStamp(),
  };
}

async function readManifest(localPath) {
  const p = manifestPathFor(localPath);
  try {
    const raw = await fsp.readFile(p, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

async function writeManifest(localPath, manifest) {
  const p = manifestPathFor(localPath);
  await ensureDir(path.dirname(p));
  await fsp.writeFile(p, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return p;
}

/**
 * Upload a recording to Google Drive, write a sidecar manifest, and
 * delete the local audio bytes on success. Idempotent via Drive
 * appProperties keyed by { kind, sessionId, segmentId|turn-side }.
 *
 * Returns the manifest object (also persisted to disk). Caller can use
 * `manifest.driveFileId` to build a sharing link.
 */
async function archiveRecordingToDrive({
  localPath,
  kind,
  tenant = "default",
  sessionId,
  segmentId = null,
  turnNumber = null,
  side = null,
  mimeType = "audio/mpeg",
  driveFolderId = null,
  description = null,
  extraAppProperties = null,
  deleteLocalOnSuccess = true,
} = {}) {
  normalizeKind(kind);
  if (!localPath) throw new ValidationError("localPath is required");

  const driveConfig = getDriveConfig();
  if (!isGoogleDriveConfigured(driveConfig)) {
    throw new ExternalServiceError("google-drive", "Drive is not configured for archive", {
      status: 500,
      retryable: false,
    });
  }
  const folderId = driveFolderId || getDriveFolderForKind(kind);
  if (!folderId) {
    throw new ExternalServiceError(
      "google-drive",
      `No Drive folder configured for kind=${kind}; set ${
        kind === KIND_INBOUND ? DEFAULT_INBOUND_FOLDER_ENV : DEFAULT_TRAINING_FOLDER_ENV
      }`,
      { status: 500, retryable: false },
    );
  }

  // If the manifest already exists with a driveFileId, we've already
  // archived this one. Don't re-upload. This makes the function safe to
  // call from a retry loop or a sweeper.
  const existingManifest = await readManifest(localPath);
  if (existingManifest && existingManifest.driveFileId) {
    return existingManifest;
  }

  let buffer;
  try {
    buffer = await fsp.readFile(localPath);
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new ValidationError(`Local recording not found at ${localPath}`);
    }
    throw err;
  }
  const digest = sha256(buffer);
  const driveClient = createGoogleDriveClient(driveConfig);

  // appProperties form the idempotency key. We also encode the sha256
  // so a duplicate file with the same logical key gets caught even if
  // the bytes differ (likely a re-pull from the carrier).
  const appProperties = {
    kind,
    sessionId,
    sha256: digest,
    ...(segmentId ? { segmentId } : {}),
    ...(turnNumber != null ? { turnNumber: String(turnNumber) } : {}),
    ...(side ? { side } : {}),
    ...(tenant ? { tenant: String(tenant).toUpperCase() } : {}),
    ...(extraAppProperties && typeof extraAppProperties === "object" ? extraAppProperties : {}),
  };

  // Pre-upload de-dupe: was this exact logical recording already in the
  // folder? Drive search is eventually-consistent but works well enough
  // for our minutes-not-seconds retry cadence.
  const idempotencyQuery = { kind, sessionId };
  if (segmentId) idempotencyQuery.segmentId = segmentId;
  if (turnNumber != null) idempotencyQuery.turnNumber = String(turnNumber);
  if (side) idempotencyQuery.side = side;
  let existingDriveFiles = [];
  try {
    existingDriveFiles = await driveClient.findFilesByAppProperties({
      folderId,
      appProperties: idempotencyQuery,
    });
  } catch (lookupErr) {
    // If the lookup fails (e.g., transient Drive 5xx), don't abort the
    // archive — proceed with the upload and rely on Drive's own dedup
    // when the manifest sweeper next runs.
  }

  let driveFileId;
  if (Array.isArray(existingDriveFiles) && existingDriveFiles.length > 0) {
    driveFileId = existingDriveFiles[0].id;
  } else {
    const uploaded = await driveClient.uploadFileResumable({
      folderId,
      name: path.basename(localPath),
      mimeType,
      buffer,
      description: description || `Parallel ${kind} recording for session ${sessionId}`,
      appProperties,
    });
    if (!uploaded?.id) {
      throw new ExternalServiceError("google-drive", "Drive upload returned no file id", {
        status: 502,
        retryable: true,
      });
    }
    driveFileId = uploaded.id;
  }

  const manifest = {
    driveFileId,
    driveFolderId: folderId,
    uploadedAt: new Date().toISOString(),
    sha256: digest,
    byteLength: buffer.length,
    mimeType,
    originalName: path.basename(localPath),
    kind,
    tenant: String(tenant || "").toUpperCase() || null,
    sessionId,
    segmentId,
    turnNumber,
    side,
  };
  await writeManifest(localPath, manifest);

  if (deleteLocalOnSuccess) {
    try {
      await fsp.unlink(localPath);
    } catch (err) {
      // Manifest is already written; a stray bytes file will be caught
      // by the sweeper. Don't fail the archive on cleanup hiccups.
      if (err.code !== "ENOENT") {
        manifest.localCleanupError = err.message;
      }
    }
  }

  return manifest;
}

/**
 * Best-effort archive — never throws. Used by hot paths (like the
 * trainer turn orchestrator) that shouldn't fail a live call because
 * Drive is down. Returns { ok, manifest?, error? }.
 */
async function archiveRecordingSafe(opts) {
  try {
    const manifest = await archiveRecordingToDrive(opts);
    return { ok: true, manifest };
  } catch (error) {
    return {
      ok: false,
      error: {
        message: error?.message || String(error),
        status: error?.status || null,
      },
    };
  }
}

/**
 * Append a turn record to the session-level manifest for a training
 * session. The session manifest gives us a single file to scan for
 * "what's in this training session" without listing the directory.
 */
async function appendTrainingSessionEntry({
  sessionId,
  date = null,
  entry,
} = {}) {
  if (!sessionId) throw new ValidationError("sessionId is required");
  if (!entry || typeof entry !== "object") {
    throw new ValidationError("entry is required");
  }
  const p = sessionManifestPathFor({ kind: KIND_TRAINING, sessionId, date });
  await ensureDir(path.dirname(p));
  let manifest;
  try {
    const raw = await fsp.readFile(p, "utf8");
    manifest = JSON.parse(raw);
    if (!Array.isArray(manifest.entries)) manifest.entries = [];
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    manifest = {
      sessionId,
      kind: KIND_TRAINING,
      createdAt: new Date().toISOString(),
      entries: [],
    };
  }
  manifest.entries.push({ ...entry, appendedAt: new Date().toISOString() });
  manifest.updatedAt = new Date().toISOString();
  await fsp.writeFile(p, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

module.exports = {
  KIND_INBOUND,
  KIND_TRAINING,
  appendTrainingSessionEntry,
  archiveRecordingSafe,
  archiveRecordingToDrive,
  buildLocalPath,
  getDriveConfig,
  getDriveFolderForKind,
  getRecordingsRoot,
  isDriveArchiveConfigured,
  manifestPathFor,
  readManifest,
  sessionManifestPathFor,
  todayDateStamp,
  writeManifest,
  writeRecordingBuffer,
};
