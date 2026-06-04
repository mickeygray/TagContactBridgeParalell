"use strict";

const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { Readable } = require("node:stream");
const express = require("express");
const ffmpegPath = require("ffmpeg-static");
const {
  buildCxCallQueue,
  buildCxCommLog,
  buildCxWorkspace,
  listCxAppointments,
  listCxLogicsTasks,
  listCxPostDateHolds,
  listCxTasks,
  lookupCxLead,
  findCxLeadCandidates,
  lookupCxLogicsMatch,
  searchCxCases,
} = require("../../../../packages/shared-services/src");
const {
  mintDriveRecordingPlaybackUrl,
} = require("../../../../packages/shared-services/src/recordingPlaybackUrlService");
const {
  callLogRepository,
} = require("../../../../packages/shared-repositories/src");
const { CaseProfile } = require("../../../../packages/shared-models/src");
const { getSharedConfig } = require("../../../../packages/shared-config/src");
const { createGoogleDriveClient } = require("../../../../packages/shared-integrations/src");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");

const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";
const AUDIO_FILE_RE = /\.(mp3|wav|m4a|aac|ogg|oga|flac|webm)$/i;
const DEFAULT_USER_RECORDING_BUCKETS = Object.freeze(["cx", "og"]);
const DRIVE_PLAYBACK_TICKET_TTL_MS = 60 * 60 * 1000;
const WAV_FORMAT_GSM610 = 0x31;

function parseCsvSet(value, fallback = []) {
  const raw = String(value || "").trim();
  const source = raw ? raw.split(",") : fallback;
  return new Set(
    source
      .map((part) => String(part || "").trim().toLowerCase())
      .filter(Boolean),
  );
}

function timingSafeStringEqual(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function playbackTicketSecret(config = {}) {
  return String(
    config.recordingArchive?.playback?.signingSecret ||
      config.jwtSecret ||
      "",
  );
}

function signDrivePlaybackTicket(config, payload) {
  const secret = playbackTicketSecret(config);
  if (!secret) {
    const error = new Error("Recording playback tickets are not configured");
    error.status = 503;
    throw error;
  }
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${signature}`;
}

function verifyDrivePlaybackTicket(config, ticket, expectedFileId) {
  const secret = playbackTicketSecret(config);
  if (!secret) {
    const error = new Error("Recording playback tickets are not configured");
    error.status = 503;
    throw error;
  }
  const [encoded, signature] = String(ticket || "").split(".");
  if (!encoded || !signature) {
    const error = new Error("Playback ticket is missing or invalid");
    error.status = 401;
    throw error;
  }
  const expected = crypto
    .createHmac("sha256", secret)
    .update(encoded)
    .digest("base64url");
  if (!timingSafeStringEqual(signature, expected)) {
    const error = new Error("Playback ticket signature is invalid");
    error.status = 401;
    throw error;
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    const error = new Error("Playback ticket payload is invalid");
    error.status = 401;
    throw error;
  }
  if (payload.type !== "drive-recording-playback") {
    const error = new Error("Playback ticket type is invalid");
    error.status = 401;
    throw error;
  }
  if (String(payload.fileId || "") !== String(expectedFileId || "")) {
    const error = new Error("Playback ticket does not match this recording");
    error.status = 403;
    throw error;
  }
  if (!payload.expiresAt || Number(payload.expiresAt) < Date.now()) {
    const error = new Error("Playback ticket expired");
    error.status = 401;
    throw error;
  }
  return payload;
}

function buildDrivePlaybackUrl(config, fileId, user = {}) {
  const normalizedFileId = String(fileId || "").trim();
  if (!normalizedFileId) return null;
  return mintDriveRecordingPlaybackUrl(normalizedFileId, {
    viewer: String(user?.email || "").trim().toLowerCase(),
    ttlSeconds: config?.recordingArchive?.playback?.maxTtlSeconds || 600,
  });
}

function attachDrivePlaybackUrl(config, row, user = {}) {
  const playbackUrl = buildDrivePlaybackUrl(config, row.driveFileId, user) || row.playbackUrl;
  return {
    ...row,
    playbackUrl,
    recording: {
      ...(row.recording || {}),
      playbackUrl,
    },
  };
}

function recordingBucketKeysForUser(user = {}) {
  void user;
  // This route powers the agent-side `/cx/call-library` surface. Admins
  // have their own `/api/admin/call-review/library` endpoint, so keep
  // this read path to the agent-safe recording buckets even when an admin
  // account is viewing the agent shell.
  const configured = parseCsvSet(
    process.env.RECORDING_ARCHIVE_USER_BUCKETS,
    DEFAULT_USER_RECORDING_BUCKETS,
  );
  return new Set(
    [...configured].filter((key) => DEFAULT_USER_RECORDING_BUCKETS.includes(key)),
  );
}

function configuredRecordingFolders(recordingArchive = {}, user = {}) {
  const destinations = recordingArchive.destinations || {};
  const allowedKeys = recordingBucketKeysForUser(user);
  const folderMap = new Map();
  for (const key of ["og", "cx", "as", "cs"]) {
    const destination = destinations[key] || {};
    const bucketKey = String(destination.key || key).trim().toLowerCase() || key;
    if (!allowedKeys.has(bucketKey) && !allowedKeys.has(key)) continue;
    const folderId = String(destination.folderId || "").trim();
    if (!folderId) continue;
    if (!folderMap.has(folderId)) {
      folderMap.set(folderId, {
        folderId,
        key: bucketKey,
        label: String(destination.label || key.toUpperCase()).trim() || key.toUpperCase(),
      });
    }
  }
  return Array.from(folderMap.values());
}

function parseLibraryWindow(rawDays) {
  const value = String(rawDays || "7").trim().toLowerCase();
  if (value === "today") {
    return {
      allTime: false,
      today: true,
      days: null,
      startAt: startOfPacificDay(),
    };
  }
  if (value === "all" || value === "*") {
    return {
      allTime: true,
      today: false,
      days: null,
      startAt: null,
    };
  }
  const days = Math.min(Math.max(Number(value) || 7, 1), 3650);
  return {
    allTime: false,
    today: false,
    days,
    startAt: new Date(Date.now() - days * 24 * 60 * 60 * 1000),
  };
}

function startOfPacificDay(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const lookup = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const utcGuess = new Date(`${lookup.year}-${lookup.month}-${lookup.day}T00:00:00Z`);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
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
  return new Date(utcGuess.getTime() - (zonedAsUtc - utcGuess.getTime()));
}

function isDriveAudioFile(file = {}) {
  const mime = String(file.mimeType || "").toLowerCase();
  if (mime.startsWith("audio/")) return true;
  return AUDIO_FILE_RE.test(String(file.name || ""));
}

function isWavRecording(file = {}) {
  const name = String(file.name || "").toLowerCase();
  const mime = String(file.mimeType || "").toLowerCase();
  return name.endsWith(".wav") || mime.includes("wav") || mime.includes("wave");
}

function parseWavFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 32) return null;
  if (buffer.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buffer.toString("ascii", 8, 12) !== "WAVE") return null;
  let offset = 12;
  while (offset + 24 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === "fmt ") {
      return {
        audioFormat: buffer.readUInt16LE(offset + 8),
        channels: buffer.readUInt16LE(offset + 10),
        sampleRate: buffer.readUInt32LE(offset + 12),
        bitsPerSample: buffer.readUInt16LE(offset + 22),
      };
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  return null;
}

function transcodeWavToMp3(buffer) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      reject(new Error("ffmpeg-static is not available for WAV playback conversion"));
      return;
    }
    const child = spawn(ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "wav",
      "-i",
      "pipe:0",
      "-codec:a",
      "libmp3lame",
      "-b:a",
      "64k",
      "-f",
      "mp3",
      "pipe:1",
    ]);
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`WAV playback conversion failed: ${Buffer.concat(stderr).toString("utf8").slice(0, 300)}`));
        return;
      }
      resolve(Buffer.concat(stdout));
    });
    child.stdin.end(buffer);
  });
}

function parseByteRange(rangeHeader, size) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(rangeHeader || "").trim());
  if (!match || !Number.isFinite(size) || size <= 0) return null;
  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : size - 1;
  if (!match[1] && match[2]) {
    const suffix = Math.max(Number(match[2]) || 0, 0);
    start = Math.max(size - suffix, 0);
    end = size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return { invalid: true };
  }
  return {
    start,
    end: Math.min(end, size - 1),
  };
}

function sendBufferedAudio(req, res, buffer, {
  contentType = "audio/mpeg",
  downloadName = "",
  inlineName = "recording.mp3",
} = {}) {
  const size = buffer.length;
  const range = parseByteRange(req.headers.range, size);
  if (range?.invalid) {
    res.status(416);
    res.setHeader("content-range", `bytes */${size}`);
    return res.end();
  }
  const safeDownloadName = String(downloadName || inlineName || "recording.mp3")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120);
  res.setHeader("content-type", contentType);
  res.setHeader("accept-ranges", "bytes");
  res.setHeader("cache-control", "private, max-age=0, must-revalidate");
  res.setHeader(
    "content-disposition",
    downloadName
      ? `attachment; filename="${safeDownloadName || "recording.mp3"}"`
      : "inline",
  );
  if (range) {
    const chunk = buffer.subarray(range.start, range.end + 1);
    res.status(206);
    res.setHeader("content-range", `bytes ${range.start}-${range.end}/${size}`);
    res.setHeader("content-length", String(chunk.length));
    if (req.method === "HEAD") return res.end();
    return res.end(chunk);
  }
  res.status(200);
  res.setHeader("content-length", String(size));
  if (req.method === "HEAD") return res.end();
  return res.end(buffer);
}

function parseDriveRecordingName(name) {
  const stem = String(name || "").replace(/\.[^.]+$/, "");
  const parts = stem.split("__");
  if (parts.length < 5) return {};
  const [agentRaw, bucketRaw, dateRaw, phoneRaw, ...sessionParts] = parts;
  return {
    agentName: String(agentRaw || "")
      .replace(/-/g, " ")
      .replace(/\b\w/g, (char) => char.toUpperCase())
      .trim(),
    bucketKey: String(bucketRaw || "").trim().toLowerCase(),
    bucketLabel: String(bucketRaw || "").trim().toUpperCase(),
    dateKey: /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : null,
    phone: String(phoneRaw || "").replace(/\D/g, "") || null,
    telephonySessionId: sessionParts.join("__") || null,
  };
}

function projectDriveRecordingFile(file = {}, folder = {}) {
  const props = file.appProperties || {};
  const parsed = parseDriveRecordingName(file.name);
  const driveFileId = String(file.id || "").trim();
  const groupKey = String(props.bucket || parsed.bucketKey || folder.key || "unknown")
    .trim()
    .toLowerCase();
  const groupLabel =
    String(parsed.bucketLabel || folder.label || groupKey.toUpperCase()).trim() ||
    "Unknown";
  const dateKey = props.dateKey || parsed.dateKey || null;
  const callStartTime = dateKey
    ? `${dateKey}T12:00:00.000Z`
    : file.createdTime || file.modifiedTime || null;
  const playbackUrl = driveFileId
    ? `/api/read/cx/recordings/play/${encodeURIComponent(driveFileId)}`
    : null;
  return {
    id: driveFileId,
    driveFileId,
    fileName: file.name || null,
    mimeType: file.mimeType || null,
    sizeBytes: Number.isFinite(Number(file.size)) ? Number(file.size) : null,
    createdTime: file.createdTime || null,
    modifiedTime: file.modifiedTime || null,
    webViewLink: file.webViewLink || null,
    parentFolderId: Array.isArray(file.parents) ? file.parents[0] || null : null,
    rootFolderId: folder.folderId || null,
    rootFolderKey: folder.key || null,
    rootFolderLabel: folder.label || null,
    folderPath: folder.path || folder.label || null,
    telephonySessionId: props.telephonySessionId || parsed.telephonySessionId || null,
    domain: props.domain || null,
    provider: props.provider || null,
    platform: props.platform || null,
    direction: props.direction || null,
    dateKey,
    callStartTime,
    phone: parsed.phone,
    agentName: parsed.agentName || null,
    groupKey,
    groupLabel,
    playbackUrl,
    recording: {
      driveFileId: driveFileId || null,
      playbackUrl,
      available: Boolean(driveFileId),
      archiveStatus: "completed",
      provider: props.provider || null,
      mimeType: file.mimeType || null,
      fileName: file.name || null,
      groupKey,
      groupLabel,
      uploadedAt: file.createdTime || file.modifiedTime || null,
    },
  };
}

function shouldSkipDateFolder(folderName, startAt) {
  if (!startAt) return false;
  const name = String(folderName || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) return false;
  return name < startAt.toISOString().slice(0, 10);
}

async function listDriveRecordingLibrary({ driveClient, folders, window, limit }) {
  const fields =
    "nextPageToken, files(id,name,mimeType,parents,appProperties,size,createdTime,modifiedTime,webViewLink)";
  const queue = folders.map((folder) => ({ ...folder, path: folder.label, depth: 0 }));
  const seenFolders = new Set(queue.map((folder) => folder.folderId));
  const seenFiles = new Set();
  const recordings = [];

  while (queue.length > 0) {
    const folder = queue.shift();
    let pageToken = null;
    do {
      const page = await driveClient.listFilesInFolder({
        parentId: folder.folderId,
        pageSize: 1000,
        pageToken,
        fields,
      });
      for (const file of page.files || []) {
        if (file.mimeType === DRIVE_FOLDER_MIME) {
          if (folder.depth >= 4 || shouldSkipDateFolder(file.name, window.startAt)) continue;
          const folderId = String(file.id || "").trim();
          if (!folderId || seenFolders.has(folderId)) continue;
          seenFolders.add(folderId);
          queue.push({
            ...folder,
            folderId,
            path: [folder.path, file.name].filter(Boolean).join("/"),
            depth: folder.depth + 1,
          });
          continue;
        }
        if (!isDriveAudioFile(file)) continue;
        const row = projectDriveRecordingFile(file, folder);
        if (!row.driveFileId || seenFiles.has(row.driveFileId)) continue;
        const eventTime = row.callStartTime || row.createdTime || row.modifiedTime;
        if (window.startAt && eventTime) {
          const t = new Date(eventTime).getTime();
          if (Number.isFinite(t) && t < window.startAt.getTime()) continue;
        }
        seenFiles.add(row.driveFileId);
        recordings.push(row);
      }
      pageToken = page.nextPageToken || null;
    } while (pageToken);
  }

  return recordings
    .sort((a, b) => {
      const at = new Date(a.callStartTime || a.createdTime || a.modifiedTime || 0).getTime() || 0;
      const bt = new Date(b.callStartTime || b.createdTime || b.modifiedTime || 0).getTime() || 0;
      return bt - at;
    })
    .slice(0, limit);
}

function buildRecordingGroupSummary(rows) {
  const byGroup = new Map();
  for (const row of rows) {
    const key = String(row.groupKey || "unknown").trim().toLowerCase();
    if (!byGroup.has(key)) {
      byGroup.set(key, {
        key,
        label: row.groupLabel || (key === "unknown" ? "Unknown" : key.toUpperCase()),
        callCount: 0,
        totalBytes: 0,
      });
    }
    const bucket = byGroup.get(key);
    bucket.callCount += 1;
    bucket.totalBytes += Number(row.sizeBytes) || 0;
  }
  return Array.from(byGroup.values()).sort((a, b) => b.callCount - a.callCount);
}

function buildDriveRecordingSummary(rows) {
  return {
    callCount: rows.length,
    totalDurationSec: 0,
    longestDurationSec: 0,
    withRecording: rows.length,
    withoutRecording: 0,
    byDirection: rows.reduce((acc, row) => {
      const key = String(row.direction || "unknown").toLowerCase();
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
    totalBytes: rows.reduce((sum, row) => sum + (Number(row.sizeBytes) || 0), 0),
  };
}

async function fileHasAllowedAncestor(driveClient, fileMetadata, allowedRootIds) {
  const queue = Array.isArray(fileMetadata.parents) ? [...fileMetadata.parents] : [];
  const seen = new Set();
  let depth = 0;
  while (queue.length > 0 && depth < 10) {
    const folderId = String(queue.shift() || "").trim();
    if (!folderId || seen.has(folderId)) continue;
    if (allowedRootIds.has(folderId)) return true;
    seen.add(folderId);
    depth += 1;
    const folder = await driveClient.getFileMetadata({
      fileId: folderId,
      fields: "id,name,mimeType,parents,trashed",
    }).catch(() => null);
    if (Array.isArray(folder?.parents)) {
      queue.push(...folder.parents);
    }
  }
  return false;
}

async function assertCanAccessDriveRecording({ req, driveClient, archiveConfig, fileId }) {
  const allowedFolders = configuredRecordingFolders(archiveConfig, req.user);
  const allowedRootIds = new Set(allowedFolders.map((folder) => folder.folderId));
  const allowedKeys = recordingBucketKeysForUser(req.user);
  if (allowedRootIds.size === 0) {
    const error = new Error("No recording folders are available for this user");
    error.status = 403;
    throw error;
  }
  const metadata = await driveClient.getFileMetadata({
    fileId,
    fields: "id,name,mimeType,parents,appProperties,trashed",
  });
  if (metadata?.trashed) {
    const error = new Error("Recording not found");
    error.status = 404;
    throw error;
  }
  const bucket = String(metadata?.appProperties?.bucket || "").trim().toLowerCase();
  if (bucket && allowedKeys.has(bucket)) return;
  if (await fileHasAllowedAncestor(driveClient, metadata, allowedRootIds)) return;
  const error = new Error("Recording is outside your allowed library folders");
  error.status = 403;
  throw error;
}

function unwrapLogicsPayload(payload) {
  if (!payload) return null;
  const raw =
    payload.data !== undefined && payload.data !== null
      ? payload.data
      : payload.Data !== undefined && payload.Data !== null
        ? payload.Data
        : payload;
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function wrapLogicsPayloadWithData(payload, data) {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    if (payload.data !== undefined || payload.Data === undefined) {
      return { ...payload, data };
    }
    return { ...payload, Data: data };
  }
  return { data };
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number(code);
      return Number.isFinite(n) ? String.fromCharCode(n) : _;
    });
}

function normalizeLogicsComment(value) {
  return decodeHtmlEntities(value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<b>\s*Comment posted by\s+(.+?)\s+on\s+\[(.+?)\]:\s*<\/b>/gi, "$1 - $2")
    .replace(/<[^>]+>/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n-{10,}\n/g, "\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isNoteLikeActivity(row) {
  if (!row || typeof row !== "object") return false;
  const subject = String(row.Subject || row.subject || row.Title || row.title || "").toLowerCase();
  const type = String(row.ActivityType || row.activityType || row.Type || row.type || "").toLowerCase();
  const comment = String(row.Comment || row.comment || row.Notes || row.notes || "").trim();
  if (!comment) return false;
  if (/file upload|document|email|sms|text message|call/i.test(type)) return false;
  if (/note|sales|origination|originator|case review|review notes|tax prep|a\/s review/.test(subject)) {
    return true;
  }
  if (row.Pin === true || row.Pin === "true" || row.pin === true || row.pin === "true") {
    return true;
  }
  return false;
}

function formatActivityNotes(activitiesPayload) {
  const data = unwrapLogicsPayload(activitiesPayload);
  const rows = Array.isArray(data) ? data : data && typeof data === "object" ? [data] : [];
  const noteRows = rows
    .filter(isNoteLikeActivity)
    .slice()
    .sort((left, right) => {
      const leftTime = new Date(left.CreatedDate || left.createdAt || left.Date || 0).getTime();
      const rightTime = new Date(right.CreatedDate || right.createdAt || right.Date || 0).getTime();
      return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
    });

  const blocks = noteRows
    .map((row) => {
      const subject = String(row.Subject || row.subject || row.Title || row.title || "Logics note").trim();
      const createdBy = String(row.CreatedBy || row.createdBy || "").trim();
      const createdAt = String(row.CreatedDate || row.createdAt || row.Date || "").trim();
      const comment = normalizeLogicsComment(row.Comment || row.comment || row.Notes || row.notes || "");
      if (!comment) return "";
      const headerParts = [subject, createdBy, createdAt].filter(Boolean);
      return `${headerParts.join(" | ")}\n${comment}`;
    })
    .filter(Boolean);

  return {
    text: blocks.join("\n\n---\n\n"),
    count: blocks.length,
  };
}

async function buildLogicsInfoWithNotes(domain, caseId, client) {
  const normalizedDomain = String(domain || "").trim().toUpperCase();
  const numericCaseId = Number(caseId);
  const [caseInfoPayload, activitiesPayload, localCaseProfile] = await Promise.all([
    client.getCaseInfo(caseId),
    client.getActivities(caseId).catch((error) => {
      if (error?.details?.responseStatus === 404) return { data: [] };
      throw error;
    }),
    Number.isFinite(numericCaseId)
      ? CaseProfile.findOne({ domain: normalizedDomain, caseId: numericCaseId })
          .select({ notes: 1 })
          .lean()
          .catch(() => null)
      : Promise.resolve(null),
  ]);

  const caseInfo = unwrapLogicsPayload(caseInfoPayload);
  const caseInfoData =
    caseInfo && typeof caseInfo === "object" && !Array.isArray(caseInfo)
      ? { ...caseInfo }
      : {};
  const caseNotes = normalizeLogicsComment(caseInfoData.Notes || caseInfoData.notes || "");
  const localNotes = normalizeLogicsComment(localCaseProfile?.notes || "");
  const activityNotes = formatActivityNotes(activitiesPayload);

  const notes = caseNotes || localNotes || "";
  return {
    payload: wrapLogicsPayloadWithData(caseInfoPayload, {
      ...caseInfoData,
      Notes: notes,
      notes,
      ActivityNotes: activityNotes.text,
      activityNotes: activityNotes.text,
    }),
    metadata: {
      notesSource: caseNotes
        ? activityNotes.count > 0
          ? "case-info+activity"
          : "case-info"
        : localNotes
          ? activityNotes.count > 0
            ? "local-case-profile+activity"
            : "local-case-profile"
          : activityNotes.count > 0
            ? "activity-fallback"
            : "none",
      notesActivityCount: activityNotes.count,
    },
  };
}

function buildDriveMediaUrl(fileId, supportsAllDrives) {
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("alt", "media");
  if (supportsAllDrives) {
    url.searchParams.set("supportsAllDrives", "true");
  }
  return url.toString();
}

async function proxyDriveFile(req, res, fileId, { skipAccessCheck = false } = {}) {
  const config = getSharedConfig();
  const driveClient = createGoogleDriveClient(config.recordingArchive?.drive || {});
  if (!driveClient.isConfigured()) {
    const error = new Error("Recording archive playback is not configured");
    error.status = 503;
    throw error;
  }

  if (!skipAccessCheck) {
    await assertCanAccessDriveRecording({
      req,
      driveClient,
      archiveConfig: config.recordingArchive || {},
      fileId,
    });
  }

  const token = await driveClient.getAccessToken();
  const downloadName = String(req.query?.download || "").trim();
  const metadata = await driveClient.getFileMetadata({
    fileId,
    fields: "id,name,mimeType,size,trashed",
  }).catch(() => null);
  if (metadata?.trashed) {
    const error = new Error("Recording not found");
    error.status = 404;
    throw error;
  }

  if (isWavRecording(metadata)) {
    const download = await driveClient.downloadFile({
      fileId,
      supportsAllDrives: config.recordingArchive?.drive?.supportsAllDrives,
    });
    const wavFormat = parseWavFormat(download.buffer);
    if (wavFormat?.audioFormat === WAV_FORMAT_GSM610) {
      const mp3Buffer = await transcodeWavToMp3(download.buffer);
      const mp3Name = String(downloadName || metadata?.name || "recording.wav")
        .replace(/\.wav$/i, ".mp3");
      return sendBufferedAudio(req, res, mp3Buffer, {
        contentType: "audio/mpeg",
        downloadName: downloadName ? mp3Name : "",
        inlineName: mp3Name,
      });
    }
    return sendBufferedAudio(req, res, download.buffer, {
      contentType: download.mimeType || metadata?.mimeType || "audio/wav",
      downloadName,
      inlineName: metadata?.name || "recording.wav",
    });
  }

  const response = await fetch(buildDriveMediaUrl(fileId, config.recordingArchive?.drive?.supportsAllDrives), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(req.headers.range ? { Range: req.headers.range } : {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`Drive playback failed: ${response.status}${text ? ` ${text}` : ""}`);
    error.status = response.status === 404 ? 404 : 502;
    throw error;
  }

  res.status(response.status);
  for (const name of [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
    "cache-control",
  ]) {
    const value = response.headers.get(name);
    if (value) {
      res.setHeader(name, value);
    }
  }
  if (!res.getHeader("accept-ranges")) {
    res.setHeader("accept-ranges", "bytes");
  }
  // Default to inline so the HTML5 <audio> element streams it for
  // playback. When the client wants a Save As dialog (the "Download"
  // button in the CX Call Tracker workspace), pass ?download=<name>
  // and we flip to attachment with the requested filename.
  if (downloadName) {
    const safeName = downloadName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
    res.setHeader(
      "content-disposition",
      `attachment; filename="${safeName || "recording.mp3"}"`,
    );
  } else {
    res.setHeader("content-disposition", "inline");
  }

  if (response.body && typeof Readable.fromWeb === "function") {
    return Readable.fromWeb(response.body).pipe(res);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  return res.end(buffer);
}

function normalizeDomain(value) {
  return String(value || "").trim().toUpperCase();
}

function requireCxDomainAccess(req, res, next) {
  try {
    const requestedDomain = normalizeDomain(req.params?.domain);
    if (!requestedDomain) {
      const error = new Error("domain is required");
      error.status = 400;
      throw error;
    }
    return next();
  } catch (error) {
    return res.status(error.status || 500).json(toErrorResponse(error));
  }
}

function createReadCxRouter(auth) {
  const router = express.Router();

  router.get("/workspace/:domain", auth.requireAuth, auth.requireUser, requireCxDomainAccess, async (req, res) => {
    try {
      const result = await buildCxWorkspace(req.params.domain, req.user);
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/call-queue/:domain", auth.requireAuth, auth.requireUser, requireCxDomainAccess, async (req, res) => {
    try {
      const result = await buildCxCallQueue(req.params.domain, req.user);
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/appointments/:domain", auth.requireAuth, auth.requireUser, requireCxDomainAccess, async (req, res) => {
    try {
      const result = await listCxAppointments(req.params.domain, req.user, {
        status: req.query.status || "active",
        from: req.query.from || null,
        to: req.query.to || null,
        caseId: req.query.caseId || null,
        agentExtensionId: req.query.agentExtensionId || null,
        limit: req.query.limit || null,
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/postdates/:domain", auth.requireAuth, auth.requireAdmin, requireCxDomainAccess, async (req, res) => {
    try {
      const result = await listCxPostDateHolds(req.params.domain, req.user, {
        status: req.query.status || "active",
        date: req.query.date || null,
        from: req.query.from || null,
        to: req.query.to || null,
        firstPaymentDueOnOrBefore: req.query.firstPaymentDueOnOrBefore || null,
        caseId: req.query.caseId || null,
        limit: req.query.limit || null,
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  // Unified lookup across CaseProfile → MasterProspect → LeadCadence
  // → Logics. Used by the CX workspace center panel when a call
  // connects or an operator types a phone, so the case form can
  // auto-populate from whichever tier has the best record.
  router.get("/recordings/library", auth.requireAuth, auth.requireUser, async (req, res) => {
    try {
      const config = getSharedConfig();
      const archiveConfig = config.recordingArchive || {};
      const driveClient = createGoogleDriveClient(archiveConfig.drive || {});
      if (!driveClient.isConfigured()) {
        return res.status(503).json({
          ok: false,
          error: "recording-archive-drive-not-configured",
        });
      }
      const folders = configuredRecordingFolders(archiveConfig, req.user);
      if (folders.length === 0) {
        return res.status(403).json({
          ok: false,
          error: "no-recording-library-folders-available",
        });
      }

      const platformParam = String(req.query?.platform || "all").trim().toLowerCase();
      const directionParam = String(req.query?.direction || "all").trim().toLowerCase();
      const recordingGroupParam = String(req.query?.recordingGroup || "all").trim().toLowerCase();
      const limit = Math.min(Math.max(Number(req.query?.limit) || 500, 1), 2000);
      const window = parseLibraryWindow(req.query?.days);
      let recordings = await listDriveRecordingLibrary({
        driveClient,
        folders,
        window,
        limit: 2000,
      });
      const availableRecordingGroups = buildRecordingGroupSummary(recordings);

      if (platformParam !== "all") {
        recordings = recordings.filter((row) => row.platform === platformParam);
      }
      if (directionParam !== "all") {
        recordings = recordings.filter((row) => row.direction === directionParam);
      }
      if (recordingGroupParam !== "all") {
        recordings = recordings.filter((row) => row.groupKey === recordingGroupParam);
      }

      const rows = recordings
        .slice(0, limit)
        .map((row) => attachDrivePlaybackUrl(config, row, req.user));
      return res.json({
        ok: true,
        dateKey: new Date().toISOString().slice(0, 10),
        source: "google-drive",
        domain: "DRIVE",
        domains: [],
        window: {
          allTime: window.allTime,
          today: window.today,
          days: window.days,
          startAt: window.startAt ? window.startAt.toISOString() : null,
        },
        filters: {
          platform: platformParam,
          direction: directionParam,
          recordingGroup: recordingGroupParam,
          hasRecording: true,
        },
        folders,
        summary: buildDriveRecordingSummary(rows),
        recordingGroups: availableRecordingGroups,
        visibleRecordingGroups: buildRecordingGroupSummary(rows),
        calls: rows,
        recordings: rows,
        truncated: recordings.length > rows.length,
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/recordings/play/:fileId", auth.requireAuth, auth.requireUser, async (req, res) => {
    try {
      return await proxyDriveFile(req, res, req.params.fileId);
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/recordings/play-ticket/:fileId", auth.requireAuth, auth.requireUser, async (req, res) => {
    try {
      const config = getSharedConfig();
      const archiveConfig = config.recordingArchive || {};
      const driveClient = createGoogleDriveClient(archiveConfig.drive || {});
      if (!driveClient.isConfigured()) {
        return res.status(503).json({
          ok: false,
          error: "recording-archive-drive-not-configured",
        });
      }
      const fileId = String(req.params.fileId || "").trim();
      await assertCanAccessDriveRecording({
        req,
        driveClient,
        archiveConfig,
        fileId,
      });
      const expiresAt = Date.now() + DRIVE_PLAYBACK_TICKET_TTL_MS;
      const ticket = signDrivePlaybackTicket(config, {
        type: "drive-recording-playback",
        fileId,
        email: String(req.user?.email || "").trim().toLowerCase(),
        role: req.user?.role || null,
        issuedAt: Date.now(),
        expiresAt,
        nonce: crypto.randomBytes(8).toString("hex"),
      });
      return res.json({
        ok: true,
        expiresAt: new Date(expiresAt).toISOString(),
        playbackUrl: `/api/read/cx/recordings/stream/${encodeURIComponent(fileId)}?ticket=${encodeURIComponent(ticket)}`,
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/recordings/stream/:fileId", async (req, res) => {
    try {
      const config = getSharedConfig();
      verifyDrivePlaybackTicket(config, req.query?.ticket, req.params.fileId);
      return await proxyDriveFile(req, res, req.params.fileId, {
        skipAccessCheck: true,
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get(
    "/recordings/call/:domain/:telephonySessionId",
    auth.requireAuth,
    auth.requireUser,
    requireCxDomainAccess,
    async (req, res) => {
      try {
        const callLog = await callLogRepository.findCallLog(req.params.domain, req.params.telephonySessionId);
        const fileId = String(callLog?.recordingArchive?.driveFileId || "").trim();
        if (!fileId) {
          const error = new Error("Archived recording not found for call");
          error.status = 404;
          throw error;
        }
        return await proxyDriveFile(req, res, fileId);
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  router.get("/lookup/:domain", auth.requireAuth, auth.requireUser, requireCxDomainAccess, async (req, res) => {
    try {
      // Comma-joined list of domains to walk in order ("WYNN,TAG").
      // The frontend uses this on phone-only inbound lookups so we try
      // both tenants before giving up.
      const fallbackParam = req.query.domainFallback
        ? String(req.query.domainFallback)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : null;
      const result = await lookupCxLead({
        domain: req.params.domain,
        domainFallback: fallbackParam && fallbackParam.length > 0 ? fallbackParam : null,
        phone: req.query.phone ? String(req.query.phone) : null,
        caseId: req.query.caseId ? Number(req.query.caseId) : null,
        skipLogics: String(req.query.skipLogics || "").toLowerCase() === "true",
        skipMongoFallback: String(req.query.skipMongoFallback || "").toLowerCase() === "true",
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  // Logics case-level fields (incl. Notes) fetched fresh per call —
  // bypasses our local case-profile cache so the Notes panel always
  // reflects whatever a user just typed in Logics' own UI. Logics does
  // not reliably return a CaseInfo Notes field, so we also fall back to
  // note-like case activities and present them as clean plain text at
  // `result.data.ActivityNotes`. `result.data.Notes` stays reserved for
  // the editable case-level field so saving cannot rewrite activity
  // history.
  router.get(
    "/case/:domain/:caseId/logics-info",
    auth.requireAuth,
    auth.requireUser,
    requireCxDomainAccess,
    async (req, res) => {
      try {
        const {
          createLogicsClient,
        } = require("../../../../packages/shared-integrations/src");
        const client = createLogicsClient(req.params.domain);
        const { payload, metadata } = await buildLogicsInfoWithNotes(
          req.params.domain,
          req.params.caseId,
          client,
        );
        return res.json({ ok: true, result: payload, metadata });
      } catch (error) {
        if (error?.details?.responseStatus === 404) {
          return res.json({ ok: true, result: { data: null } });
        }
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  // Unified communication log for a case (or a phone-only prospect).
  // Fan-out reader: pulls from CaseProfile.communications,
  // ConversationMessage (sms in/out), CallLog, and LeadCadence.schedule.
  // Returns a single chronological list (newest first) with normalized
  // entry shape. See `cxCommLogService.js` for the contract.
  //
  // `:caseId` may be the literal string "phone" to indicate a phone-only
  // lookup; the actual phone is then read from ?phone=…. This keeps the
  // URL shape consistent with the other /case/:domain/:caseId/* reads.
  router.get(
    "/case/:domain/:caseId/comm-log",
    auth.requireAuth,
    auth.requireUser,
    requireCxDomainAccess,
    async (req, res) => {
      try {
        const phone = String(req.query.phone || "").trim() || null;
        const rawCaseId = String(req.params.caseId || "").trim();
        const caseId = /^\d+$/.test(rawCaseId) ? Number(rawCaseId) : null;
        const limit = Number(req.query.limit) || 200;
        if (caseId == null && !phone) {
          return res
            .status(400)
            .json({ ok: false, error: "caseId or phone required" });
        }
        const result = await buildCxCommLog(req.params.domain, {
          caseId,
          phone,
          limit,
        });
        return res.json({ ok: true, result });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  // Logics activities for a case — powers the activities list + the
  // nest-under picker in the center panel. Passthrough of the Logics
  // API response (activities are usually a flat list; any nesting
  // happens via ActivityID parent references on the nested child).
  router.get(
    "/case/:domain/:caseId/activities",
    auth.requireAuth,
    auth.requireUser,
    requireCxDomainAccess,
    async (req, res) => {
      try {
        const {
          createLogicsClient,
        } = require("../../../../packages/shared-integrations/src");
        const client = createLogicsClient(req.params.domain);
        const payload = await client.getActivities(req.params.caseId);
        return res.json({ ok: true, result: payload });
      } catch (error) {
        // 404 from Logics = no activities yet. Normalize to an empty list.
        if (error?.details?.responseStatus === 404) {
          return res.json({ ok: true, result: { data: [] } });
        }
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  router.get(
    "/case/:domain/:caseId/invoices",
    auth.requireAuth,
    auth.requireUser,
    requireCxDomainAccess,
    async (req, res) => {
      try {
        const {
          createLogicsClient,
        } = require("../../../../packages/shared-integrations/src");
        const client = createLogicsClient(req.params.domain);
        const payload = await client.getCaseInvoices(req.params.caseId);
        return res.json({ ok: true, result: payload });
      } catch (error) {
        if (error?.details?.responseStatus === 404) {
          return res.json({ ok: true, result: { data: [] } });
        }
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  // Multi-candidate lookup — returns every phone match across both
  // domains × all tiers so the CX UI can offer "found in N places,
  // pick one" buttons instead of guessing the right case.
  router.get(
    "/lookup-candidates/:domain",
    auth.requireAuth,
    auth.requireUser,
    requireCxDomainAccess,
    async (req, res) => {
      try {
        const fallbackParam = req.query.domainFallback
          ? String(req.query.domainFallback)
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : null;
        // nameSearch fields — only included when at least one is set,
        // so the service can branch on `hasNameSearch` cleanly.
        const ns = {
          firstName: req.query.firstName ? String(req.query.firstName) : null,
          lastName: req.query.lastName ? String(req.query.lastName) : null,
          address: req.query.address ? String(req.query.address) : null,
          city: req.query.city ? String(req.query.city) : null,
          state: req.query.state ? String(req.query.state) : null,
          zip: req.query.zip ? String(req.query.zip) : null,
        };
        const nameSearch =
          Object.values(ns).some((v) => v && String(v).trim().length > 0)
            ? ns
            : null;
        const result = await findCxLeadCandidates({
          domain: req.params.domain,
          domainFallback: fallbackParam && fallbackParam.length > 0 ? fallbackParam : null,
          phone: req.query.phone ? String(req.query.phone) : null,
          caseId: req.query.caseId ? Number(req.query.caseId) : null,
          nameSearch,
          skipLogics: String(req.query.skipLogics || "").toLowerCase() === "true",
          logicsLimit: req.query.logicsLimit ? Number(req.query.logicsLimit) : 50,
        });
        return res.json({ ok: true, result });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  // Per-case Logics tasks. Logics doesn't expose a getTasks(caseId)
  // endpoint, so we pull a 365-day window from getTasksByDateRange and
  // filter server-side by CaseID. Wide window because tasks can be set
  // with future due dates well past the case's recent activity.
  router.get(
    "/case/:domain/:caseId/tasks",
    auth.requireAuth,
    auth.requireUser,
    requireCxDomainAccess,
    async (req, res) => {
      try {
        const {
          createLogicsClient,
        } = require("../../../../packages/shared-integrations/src");
        const client = createLogicsClient(req.params.domain);
        const now = new Date();
        const past = new Date(now);
        past.setDate(past.getDate() - 180);
        const future = new Date(now);
        future.setDate(future.getDate() + 365);
        const fmt = (d) => d.toISOString().slice(0, 10);
        const payload = await client.getTasksByDateRange(fmt(past), fmt(future));
        const data = payload?.data ?? payload?.Data ?? payload;
        const all = Array.isArray(data) ? data : [];
        const target = String(req.params.caseId);
        const filtered = all.filter((row) => {
          const rid = row?.CaseID ?? row?.caseId ?? row?.CaseId;
          return rid != null && String(rid) === target;
        });
        return res.json({ ok: true, result: { data: filtered } });
      } catch (error) {
        if (error?.details?.responseStatus === 404) {
          return res.json({ ok: true, result: { data: [] } });
        }
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  router.get(
    "/case/:domain/:caseId/payments",
    auth.requireAuth,
    auth.requireUser,
    requireCxDomainAccess,
    async (req, res) => {
      try {
        const {
          createLogicsClient,
        } = require("../../../../packages/shared-integrations/src");
        const client = createLogicsClient(req.params.domain);
        const payload = await client.getCasePayments(req.params.caseId);
        return res.json({ ok: true, result: payload });
      } catch (error) {
        if (error?.details?.responseStatus === 404) {
          return res.json({ ok: true, result: { data: [] } });
        }
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  router.get("/tasks/:domain", auth.requireAuth, auth.requireUser, requireCxDomainAccess, async (req, res) => {
    try {
      const result = await listCxTasks(req.params.domain, req.user);
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/search/:domain", auth.requireAuth, auth.requireUser, requireCxDomainAccess, async (req, res) => {
    try {
      const result = await searchCxCases(req.params.domain, req.user, {
        search: req.query.search,
        limit: req.query.limit,
        scope: req.query.scope,
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/logics/match/:domain", auth.requireAuth, auth.requireUser, requireCxDomainAccess, async (req, res) => {
    try {
      const result = await lookupCxLogicsMatch(req.params.domain, req.user, {
        phone: req.query.phone,
        caseId: req.query.caseId,
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/logics/tasks/:domain", auth.requireAuth, auth.requireUser, requireCxDomainAccess, async (req, res) => {
    try {
      const result = await listCxLogicsTasks(req.params.domain, req.user, {
        startDate: req.query.startDate,
        endDate: req.query.endDate,
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  return router;
}

module.exports = {
  createReadCxRouter,
};
