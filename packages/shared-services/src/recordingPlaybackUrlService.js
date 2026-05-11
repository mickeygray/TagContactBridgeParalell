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
//   - URI is a Drive URL or already a Parallel URL → leave unchanged
//     (Drive URLs are issued + signed by Apps Script; rewriting them
//     would break that flow)
//   - Anything else → leave unchanged for visibility
//
// Returns the rewritten URL or the original URI on any path that
// shouldn't be transformed.

function mintRecordingPlaybackUrl(uri, { viewer, ttlSeconds = 3600 } = {}) {
  const raw = String(uri || "").trim();
  if (!raw) return raw;

  const config = getSharedConfig().recordingArchive || {};
  const playbackConfig = config.playback || {};
  const secret = String(playbackConfig.signingSecret || "");
  if (!secret) return raw;

  const baseUrl = String(playbackConfig.baseUrl || "").replace(/\/$/, "");
  const viewerEmail = String(viewer || "").trim().toLowerCase();
  if (!viewerEmail) return raw;

  const exp =
    Math.floor(Date.now() / 1000) +
    Math.max(60, Math.min(24 * 3600, ttlSeconds));

  // RC media URL pattern: extract recordingId from
  // .../account/<acct>/recording/<id>/content
  const rcMatch = raw.match(/\/recording\/(\d+)\/content/i);
  if (rcMatch && raw.includes("media.ringcentral.com")) {
    const recordingId = rcMatch[1];
    const message = `${recordingId}|${exp}|${viewerEmail}`;
    const sig = crypto.createHmac("sha256", secret).update(message).digest("hex");
    const params = new URLSearchParams({
      exp: String(exp),
      viewer: viewerEmail,
      sig,
    });
    const path = `/api/recordings/rc-play/${encodeURIComponent(recordingId)}?${params.toString()}`;
    return baseUrl ? `${baseUrl}${path}` : path;
  }

  // Drive / Apps Script-issued URL — pass through. Apps Script owns
  // signing for Drive playback; rewriting these would invalidate the
  // sig already attached.
  return raw;
}

module.exports = {
  mintRecordingPlaybackUrl,
};
