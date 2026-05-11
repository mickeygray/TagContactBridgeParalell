"use strict";

const express = require("express");
const crypto = require("crypto");
const { Readable } = require("stream");

const {
  createGoogleDriveClient,
  createRingCentralClient,
} = require("../../../../packages/shared-integrations/src");
const {
  getSharedConfig,
} = require("../../../../packages/shared-config/src");

// Headers we forward FROM client → Drive on each playback request.
// Range/If-Range/If-None-Match are the seek + cache primitives the
// HTML5 audio element relies on for scrubbing through long calls.
const REQUEST_HEADERS_TO_FORWARD = [
  "range",
  "if-range",
  "if-none-match",
  "if-modified-since",
];

// Headers we forward FROM Drive → client. Drive's response carries
// Content-Length / Content-Range / ETag / Last-Modified / Accept-Ranges
// natively when range mode is in play, plus the audio Content-Type.
const RESPONSE_HEADERS_TO_FORWARD = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
  "cache-control",
];

function timingSafeStringEqual(a, b) {
  const ba = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Verify the HMAC-signed playback URL. The signing message is
 * deterministic — `<fileId>|<exp>|<viewer>` — and the secret lives in
 * RECORDING_PLAYBACK_SIGNING_SECRET (env) and the matching Apps Script
 * `Script Properties` entry. Apps Script signs at URL-issuance time;
 * the control-plane verifies on every playback request.
 *
 * Returns `{ ok: true }` on success or `{ ok: false, reason }` so the
 * caller can return precise error codes for debugging without
 * leaking signature details.
 */
function verifyPlaybackSignature({ fileId, exp, viewer, sig }, secret) {
  if (!secret) return { ok: false, reason: "secret-not-configured" };
  if (!fileId || !exp || !viewer || !sig) {
    return { ok: false, reason: "missing-fields" };
  }

  const expSeconds = Number(exp);
  if (!Number.isFinite(expSeconds)) {
    return { ok: false, reason: "exp-not-numeric" };
  }
  // Apps Script issues `exp` as Unix seconds. Reject already-expired
  // and reject suspiciously-far-future values (anti-replay if the
  // signing secret leaks).
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (expSeconds <= nowSeconds) {
    return { ok: false, reason: "expired" };
  }
  if (expSeconds - nowSeconds > 24 * 3600) {
    return { ok: false, reason: "exp-too-far" };
  }

  const message = `${fileId}|${exp}|${viewer}`;
  const expectedSig = crypto
    .createHmac("sha256", secret)
    .update(message)
    .digest("hex");

  if (!timingSafeStringEqual(sig, expectedSig)) {
    return { ok: false, reason: "bad-signature" };
  }

  return { ok: true };
}

function isViewerAllowed(viewer, allowedSet) {
  if (!allowedSet || allowedSet.size === 0) return true;
  const normalized = String(viewer || "").trim().toLowerCase();
  return allowedSet.has(normalized);
}

function createRecordingPlaybackRouter() {
  const router = express.Router();

  // CORS pre-flight + headers for the audio element. The Apps Script
  // player runs on script.google.com / googleusercontent.com — fetch
  // and HTML5 <audio> requests to this proxy are always cross-origin.
  // We respond `*` since the route is already gated by HMAC signature
  // (anyone can hit it but only Apps Script can mint a working URL).
  router.options("/play/:fileId", (req, res) => {
    res
      .set({
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Range, If-Range, If-None-Match, If-Modified-Since",
        "Access-Control-Expose-Headers":
          "Content-Type, Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified",
        "Access-Control-Max-Age": "600",
      })
      .status(204)
      .end();
  });

  router.get("/play/:fileId", async (req, res) => {
    res.set({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers":
        "Content-Type, Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified",
    });
    const config = getSharedConfig().recordingArchive || {};
    const playbackConfig = config.playback || {};
    const driveConfig = config.drive || {};

    const secret = String(playbackConfig.signingSecret || "");
    if (!secret) {
      return res
        .status(500)
        .json({ ok: false, error: "playback-not-configured" });
    }

    // Verify the signed URL the Apps Script player issued.
    const fileId = req.params.fileId;
    const verification = verifyPlaybackSignature(
      {
        fileId,
        exp: req.query.exp,
        viewer: String(req.query.viewer || ""),
        sig: String(req.query.sig || ""),
      },
      secret,
    );
    if (!verification.ok) {
      return res
        .status(401)
        .json({ ok: false, error: "unauthorized", reason: verification.reason });
    }

    // Defense-in-depth: even with a valid signature, the viewer email
    // must be on the backend allowlist. Stops a leaked signing secret
    // from being used to mint URLs for non-approved viewers.
    const allowedSet = Array.isArray(playbackConfig.allowedViewers)
      ? new Set(
          playbackConfig.allowedViewers.map((value) =>
            String(value || "").trim().toLowerCase(),
          ),
        )
      : null;
    if (!isViewerAllowed(req.query.viewer, allowedSet)) {
      return res.status(403).json({ ok: false, error: "viewer-not-allowed" });
    }

    if (!driveConfig.clientEmail || !driveConfig.privateKey) {
      return res
        .status(500)
        .json({ ok: false, error: "drive-service-account-missing" });
    }

    let driveClient;
    try {
      driveClient = createGoogleDriveClient(driveConfig);
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: "drive-client-init-failed",
        message: error.message,
      });
    }

    let accessToken;
    try {
      accessToken = await driveClient.getAccessToken();
    } catch (error) {
      return res.status(502).json({
        ok: false,
        error: "drive-auth-failed",
        message: error.message,
      });
    }

    // Build upstream headers — service-account bearer + any range
    // headers the audio element sent us so seek/scrub works.
    const upstreamHeaders = {
      Authorization: `Bearer ${accessToken}`,
    };
    for (const header of REQUEST_HEADERS_TO_FORWARD) {
      const value = req.headers[header];
      if (value) upstreamHeaders[header] = value;
    }

    const driveUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
      fileId,
    )}?alt=media&supportsAllDrives=${driveConfig.supportsAllDrives === false ? "false" : "true"}`;

    let upstream;
    try {
      upstream = await fetch(driveUrl, {
        method: "GET",
        headers: upstreamHeaders,
        // Drive 302s to googleusercontent.com — fetch follows by default.
        redirect: "follow",
      });
    } catch (error) {
      return res.status(502).json({
        ok: false,
        error: "drive-fetch-failed",
        message: error.message,
      });
    }

    if (!upstream.ok && upstream.status !== 206) {
      // 416 Range Not Satisfiable + 304 Not Modified are passthrough.
      if (upstream.status === 416 || upstream.status === 304) {
        res.status(upstream.status);
        for (const header of RESPONSE_HEADERS_TO_FORWARD) {
          const value = upstream.headers.get(header);
          if (value) res.setHeader(header, value);
        }
        return res.end();
      }
      const bodySnippet = await upstream.text().catch(() => "");
      return res.status(upstream.status === 404 ? 404 : 502).json({
        ok: false,
        error: "drive-upstream-error",
        status: upstream.status,
        body: bodySnippet.slice(0, 200),
      });
    }

    res.status(upstream.status); // 200 (full) or 206 (partial)
    for (const header of RESPONSE_HEADERS_TO_FORWARD) {
      const value = upstream.headers.get(header);
      if (value) res.setHeader(header, value);
    }
    // Always advertise range support — Drive's `alt=media` does support
    // it even when this particular response wasn't a range request.
    if (!res.getHeader("accept-ranges")) {
      res.setHeader("accept-ranges", "bytes");
    }
    res.setHeader("x-content-type-options", "nosniff");

    if (!upstream.body) {
      return res.end();
    }

    // Convert the Web ReadableStream from native fetch to a Node
    // Readable so we can pipe with native backpressure handling.
    const nodeStream = Readable.fromWeb(upstream.body);
    nodeStream.on("error", (error) => {
      // Connection errors mid-stream — the audio element retries on
      // its own (range request for the missing bytes) so we just
      // close cleanly here.
      if (!res.writableEnded) res.end();
      // Light log; full noise would be too chatty for a streaming
      // endpoint that handles every audio scrub.
      // eslint-disable-next-line no-console
      console.warn("[recording-playback] upstream stream error:", error.message);
    });
    req.on("close", () => {
      // Client navigated away / new range request — abort the upstream
      // pipe so we don't waste bandwidth pulling bytes nobody wants.
      nodeStream.destroy();
    });

    nodeStream.pipe(res);
  });

  // ── RingCentral media proxy ──────────────────────────────────────
  //
  // Drive playback (above) handles the legacy archive — Apps Script
  // mints signed URLs and the proxy streams from Drive.
  //
  // This sibling route handles RC media URLs that
  // `transcriptionScoringService` saves to `transcription.recordingUri`
  // for newer calls. The raw RC URL
  // `https://media.ringcentral.com/restapi/v1.0/account/.../recording/<id>/content`
  // requires `Authorization: Bearer <rc-token>` on every request — an
  // HTML5 <audio> element can't add auth headers, so the SPA has to
  // hit a server-side proxy that adds the bearer token.
  //
  // Signed-URL pattern matches the Drive proxy verbatim so the audio
  // element doesn't need cookies or headers — the URL itself carries
  // the HMAC. Read-time URL-rewriting in `frontendReadService` mints
  // the signed URL before serving call rows to the SPA, so existing
  // <audio src={call.transcription.recordingUri} /> renders keep
  // working without any frontend change.
  router.options("/rc-play/:recordingId", (_req, res) => {
    res
      .set({
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Range, If-Range, If-None-Match, If-Modified-Since",
        "Access-Control-Expose-Headers":
          "Content-Type, Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified",
        "Access-Control-Max-Age": "600",
      })
      .status(204)
      .end();
  });

  router.get("/rc-play/:recordingId", async (req, res) => {
    res.set({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers":
        "Content-Type, Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified",
    });

    const config = getSharedConfig().recordingArchive || {};
    const playbackConfig = config.playback || {};

    const secret = String(playbackConfig.signingSecret || "");
    if (!secret) {
      return res.status(500).json({ ok: false, error: "playback-not-configured" });
    }

    const recordingId = String(req.params.recordingId || "").trim();
    const verification = verifyPlaybackSignature(
      {
        // Re-using the same signing function as Drive — `fileId` slot
        // carries the recordingId here so the signing/verifying is
        // symmetric with the Drive path. The signing message remains
        // `<id>|<exp>|<viewer>` regardless of backend.
        fileId: recordingId,
        exp: req.query.exp,
        viewer: String(req.query.viewer || ""),
        sig: String(req.query.sig || ""),
      },
      secret,
    );
    if (!verification.ok) {
      return res
        .status(401)
        .json({ ok: false, error: "unauthorized", reason: verification.reason });
    }

    // Defense-in-depth viewer allowlist — same as Drive proxy.
    const allowedSet = Array.isArray(playbackConfig.allowedViewers)
      ? new Set(
          playbackConfig.allowedViewers.map((value) =>
            String(value || "").trim().toLowerCase(),
          ),
        )
      : null;
    if (
      allowedSet &&
      allowedSet.size > 0 &&
      !allowedSet.has(String(req.query.viewer || "").trim().toLowerCase())
    ) {
      return res.status(403).json({ ok: false, error: "viewer-not-allowed" });
    }

    // Fetch RC bearer token. The RC client manages refresh-on-expire;
    // we just call authenticate() which returns the cached or fresh
    // token. If RC auth fails we 502 — the audio element will show a
    // broken player and the operator can re-trigger via the failed
    // call's row.
    const rc = createRingCentralClient();
    let bearerToken;
    try {
      bearerToken = await rc.authenticate();
    } catch (error) {
      return res.status(502).json({
        ok: false,
        error: "rc-auth-failed",
        message: error.message,
      });
    }
    if (!bearerToken) {
      return res.status(502).json({ ok: false, error: "rc-no-token" });
    }

    // Build the RC media URL. Pulled from env so we don't bake the
    // account ID into source. RC_ACCOUNT_ID falls back to the legacy
    // `2252193005` only because that's what every recordingUri sample
    // in the DB shows today — when CX migrates we'll already be off
    // this path.
    const rcAccountId = String(
      process.env.RC_ACCOUNT_ID ||
        process.env.RING_CENTRAL_ACCOUNT_ID ||
        "2252193005",
    ).trim();
    const rcMediaUrl = `https://media.ringcentral.com/restapi/v1.0/account/${rcAccountId}/recording/${encodeURIComponent(recordingId)}/content`;

    // Forward Range / If-Range / etc. so seek/scrub works (especially
    // on iOS Safari which always sends Range on initial audio load).
    const upstreamHeaders = { Authorization: `Bearer ${bearerToken}` };
    for (const header of REQUEST_HEADERS_TO_FORWARD) {
      const value = req.headers[header];
      if (value) upstreamHeaders[header] = value;
    }

    let upstream;
    try {
      upstream = await fetch(rcMediaUrl, {
        method: "GET",
        headers: upstreamHeaders,
        redirect: "follow",
      });
    } catch (error) {
      return res.status(502).json({
        ok: false,
        error: "rc-fetch-failed",
        message: error.message,
      });
    }

    if (!upstream.ok && upstream.status !== 206) {
      if (upstream.status === 416 || upstream.status === 304) {
        res.status(upstream.status);
        for (const header of RESPONSE_HEADERS_TO_FORWARD) {
          const value = upstream.headers.get(header);
          if (value) res.setHeader(header, value);
        }
        return res.end();
      }
      const bodySnippet = await upstream.text().catch(() => "");
      return res.status(upstream.status === 404 ? 404 : 502).json({
        ok: false,
        error: "rc-upstream-error",
        status: upstream.status,
        body: bodySnippet.slice(0, 200),
      });
    }

    res.status(upstream.status);
    for (const header of RESPONSE_HEADERS_TO_FORWARD) {
      const value = upstream.headers.get(header);
      if (value) res.setHeader(header, value);
    }
    if (!res.getHeader("accept-ranges")) {
      res.setHeader("accept-ranges", "bytes");
    }
    res.setHeader("x-content-type-options", "nosniff");

    if (!upstream.body) {
      return res.end();
    }

    const nodeStream = Readable.fromWeb(upstream.body);
    nodeStream.on("error", (error) => {
      if (!res.writableEnded) res.end();
      // eslint-disable-next-line no-console
      console.warn("[recording-playback] rc upstream stream error:", error.message);
    });
    req.on("close", () => {
      nodeStream.destroy();
    });

    nodeStream.pipe(res);
  });

  return router;
}

module.exports = {
  createRecordingPlaybackRouter,
  verifyPlaybackSignature,
};
