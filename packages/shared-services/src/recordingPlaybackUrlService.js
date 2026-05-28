"use strict";

const crypto = require("crypto");
const { getSharedConfig } = require("../../shared-config/src");

// Sign a recording-playback URL the SPA can put on `<audio src=...>`.
//
// The audio element can't add Authorization headers — so for any
// recording stored at a backend that requires auth (Drive via service
// account, RC media via bearer token), the URL itself has to carry
// proof-of-permission. We use the same HMAC signing pattern the Apps
// Script player uses for Drive: `<id>|<exp>|<viewer>` HMAC-SHA256
// hex, with the secret in `RECORDING_PLAYBACK_SIGNING_SECRET`.
//
// Detection logic:
//   - URI matches `media.ringcentral.com/.../recording/<id>/content`
//     → mint `/api/recordings/rc-play/<id>?exp=&viewer=&sig=`
//   - New Drive-backed library rows call mintDriveRecordingPlaybackUrl()
//     directly with the Drive file ID, matching the old Apps Script
//     `/api/recordings/play/:fileId` signing contract.
//   - Existing Drive URLs or already-signed Parallel URLs → leave
//     unchanged for visibility.
//   - Anything else → leave unchanged for visibility
//
// Returns the rewritten URL or the original URI on any path that
// shouldn't be transformed.

function signPlaybackPath({ id, pathPrefix, viewer, ttlSeconds = 3600 }) {
  const config = getSharedConfig().recordingArchive || {};
  const playbackConfig = config.playback || {};
  const secret = String(playbackConfig.signingSecret || "");
  if (!secret) return null;

  const baseUrl = String(playbackConfig.baseUrl || "").replace(/\/$/, "");
  const viewerEmail = String(viewer || "").trim().toLowerCase();
  if (!viewerEmail) return null;

  const maxTtlSeconds = Math.max(
    60,
    Number(playbackConfig.maxTtlSeconds) || 600,
  );
  const exp =
    Math.floor(Date.now() / 1000) +
    Math.max(60, Math.min(maxTtlSeconds, ttlSeconds));

  const normalizedId = String(id || "").trim();
  if (!normalizedId) return null;

  const message = `${normalizedId}|${exp}|${viewerEmail}`;
  const sig = crypto.createHmac("sha256", secret).update(message).digest("hex");
  const params = new URLSearchParams({
    exp: String(exp),
    viewer: viewerEmail,
    sig,
  });
  const path = `${pathPrefix}/${encodeURIComponent(normalizedId)}?${params.toString()}`;
  return baseUrl ? `${baseUrl}${path}` : path;
}

function mintDriveRecordingPlaybackUrl(fileId, { viewer, ttlSeconds = 600 } = {}) {
  return signPlaybackPath({
    id: fileId,
    pathPrefix: "/api/recordings/play",
    viewer,
    ttlSeconds,
  });
}

function mintRecordingPlaybackUrl(uri, { viewer, ttlSeconds = 3600 } = {}) {
  const raw = String(uri || "").trim();
  if (!raw) return raw;

  // RC media URL pattern: extract recordingId from
  // .../account/<acct>/recording/<id>/content
  const rcMatch = raw.match(/\/recording\/(\d+)\/content/i);
  if (rcMatch && raw.includes("media.ringcentral.com")) {
    const recordingId = rcMatch[1];
    return (
      signPlaybackPath({
        id: recordingId,
        pathPrefix: "/api/recordings/rc-play",
        viewer,
        ttlSeconds,
      }) || raw
    );
  }

  // Drive / Apps Script-issued URL — pass through. Apps Script owns
  // signing for Drive playback; rewriting these would invalidate the
  // sig already attached.
  return raw;
}

module.exports = {
  mintDriveRecordingPlaybackUrl,
  mintRecordingPlaybackUrl,
};
