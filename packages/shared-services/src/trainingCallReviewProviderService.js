"use strict";

const crypto = require("crypto");
const dns = require("dns");
const fs = require("fs");
const fsPromises = require("fs/promises");
const net = require("net");
const os = require("os");
const path = require("path");
const { Readable, Transform } = require("stream");
const { pipeline } = require("stream/promises");

const { env } = require("../../shared-config/src");
const {
  createCallrailClient,
  createRingCentralClient,
} = require("../../shared-integrations/src");
const {
  hostnameMatchesAllowedRule,
  isForbiddenHostname,
  isPublicIp,
  parseAllowedRecordingHosts,
} = require("./recordingHostPolicyService");

const DEFAULT_MAX_BYTES = 24 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const AUDIO_CONTENT_TYPES = new Set([
  "application/octet-stream",
  "binary/octet-stream",
]);

class TrainingCallReviewProviderError extends Error {
  constructor(code, message = "Call recording is unavailable") {
    super(message);
    this.name = "TrainingCallReviewProviderError";
    this.code = code;
  }
}

function providerError(code, message) {
  return new TrainingCallReviewProviderError(code, message);
}

function normalizeToken(value) {
  return String(value || "").trim();
}

function normalizeProvider(value) {
  return normalizeToken(value).toLowerCase();
}

async function assertPublicHttpsUrl(value, { lookup, isHostAllowed }) {
  let url;
  try {
    url = new URL(normalizeToken(value));
  } catch {
    throw providerError(
      "TRAINER_CALL_REVIEW_RECORDING_URL_INVALID",
      "Recording URL is invalid",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.href.length > 2_048 ||
    isForbiddenHostname(url.hostname)
  ) {
    throw providerError(
      "TRAINER_CALL_REVIEW_RECORDING_URL_REJECTED",
      "Recording URL is not allowed",
    );
  }

  const literalHost = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(literalHost)) {
    if (!isPublicIp(literalHost)) {
      throw providerError(
        "TRAINER_CALL_REVIEW_PRIVATE_TARGET_REJECTED",
        "Recording target is not public",
      );
    }
    if (!isHostAllowed?.(literalHost)) {
      throw providerError(
        "TRAINER_CALL_REVIEW_RECORDING_HOST_NOT_ALLOWED",
        "Recording host is not allowed",
      );
    }
    return url;
  }

  let resolved;
  try {
    resolved = await lookup(literalHost, { all: true, verbatim: true });
  } catch {
    throw providerError(
      "TRAINER_CALL_REVIEW_DNS_LOOKUP_FAILED",
      "Recording target could not be resolved",
    );
  }
  const rows = Array.isArray(resolved) ? resolved : [resolved];
  const addresses = rows
    .map((row) => (typeof row === "string" ? row : row?.address))
    .filter(Boolean);
  if (
    addresses.length === 0 ||
    addresses.some((address) => !isPublicIp(address))
  ) {
    throw providerError(
      "TRAINER_CALL_REVIEW_PRIVATE_TARGET_REJECTED",
      "Recording target is not public",
    );
  }
  if (!isHostAllowed?.(literalHost)) {
    throw providerError(
      "TRAINER_CALL_REVIEW_RECORDING_HOST_NOT_ALLOWED",
      "Recording host is not allowed",
    );
  }
  return url;
}

function responseContentType(response) {
  return String(response.headers?.get?.("content-type") || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
}

function contentTypeMayContainAudio(contentType) {
  return (
    contentType.startsWith("audio/") ||
    AUDIO_CONTENT_TYPES.has(contentType)
  );
}

function hasAudioMagic(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;
  if (buffer.subarray(0, 3).toString("ascii") === "ID3") return true;
  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return true;
  if (
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.length >= 12 &&
    buffer.subarray(8, 12).toString("ascii") === "WAVE"
  ) {
    return true;
  }
  if (buffer.subarray(0, 4).toString("ascii") === "OggS") return true;
  if (buffer.subarray(0, 4).toString("ascii") === "fLaC") return true;
  if (
    buffer.length >= 8 &&
    buffer.subarray(4, 8).toString("ascii") === "ftyp"
  ) {
    return true;
  }
  return buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
}

function toNodeReadable(body) {
  if (!body) {
    throw providerError(
      "TRAINER_CALL_REVIEW_RECORDING_BODY_MISSING",
      "Recording response was empty",
    );
  }
  if (typeof body.getReader === "function") return Readable.fromWeb(body);
  if (typeof body.pipe === "function") return body;
  throw providerError(
    "TRAINER_CALL_REVIEW_RECORDING_BODY_INVALID",
    "Recording response could not be streamed",
  );
}

function safeExtension(contentType) {
  if (contentType.includes("wav")) return ".wav";
  if (contentType.includes("ogg")) return ".ogg";
  if (contentType.includes("webm")) return ".webm";
  if (contentType.includes("mp4") || contentType.includes("m4a")) return ".m4a";
  if (contentType.includes("flac")) return ".flac";
  return ".mp3";
}

async function streamResponseToTemp({
  response,
  contentType,
  maxBytes,
  tempRoot,
}) {
  const statedLength = Number(response.headers?.get?.("content-length"));
  if (
    Number.isFinite(statedLength) &&
    statedLength >= 0 &&
    statedLength > maxBytes
  ) {
    throw providerError(
      "TRAINER_CALL_REVIEW_RECORDING_TOO_LARGE",
      "Recording exceeds the byte limit",
    );
  }
  await fsPromises.mkdir(tempRoot, { recursive: true });
  const filePath = path.join(
    tempRoot,
    `review-${crypto.randomUUID()}${safeExtension(contentType)}`,
  );
  let byteLength = 0;
  let prefix = Buffer.alloc(0);
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += bytes.length;
      if (byteLength > maxBytes) {
        callback(
          providerError(
            "TRAINER_CALL_REVIEW_RECORDING_TOO_LARGE",
            "Recording exceeds the byte limit",
          ),
        );
        return;
      }
      if (prefix.length < 16) {
        prefix = Buffer.concat([prefix, bytes]).subarray(0, 16);
      }
      callback(null, bytes);
    },
  });

  try {
    await pipeline(
      toNodeReadable(response.body),
      limiter,
      fs.createWriteStream(filePath, { flags: "wx" }),
    );
    if (byteLength === 0 || !hasAudioMagic(prefix)) {
      throw providerError(
        "TRAINER_CALL_REVIEW_AUDIO_CONTENT_INVALID",
        "Recording response was not recognized audio",
      );
    }
  } catch (error) {
    await fsPromises.rm(filePath, { force: true }).catch(() => {});
    throw error;
  }

  let cleaned = false;
  return Object.freeze({
    path: filePath,
    mimeType: contentType,
    byteLength,
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      await fsPromises.rm(filePath, { force: true });
    },
  });
}

function recordMatchesSession(record, sessionId) {
  if (normalizeToken(record?.telephonySessionId) === sessionId) return true;
  return Array.isArray(record?.legs) && record.legs.some(
    (leg) => normalizeToken(leg?.telephonySessionId) === sessionId,
  );
}

function selectExactRingcentralRecording(records, sessionId) {
  const matches = (Array.isArray(records) ? records : [])
    .filter((record) => recordMatchesSession(record, sessionId))
    .filter((record) => normalizeToken(record?.recording?.contentUri));
  const unique = new Map();
  for (const record of matches) {
    unique.set(normalizeToken(record.recording.contentUri), record);
  }
  if (unique.size > 1) {
    throw providerError(
      "TRAINER_CALL_REVIEW_EX_RECORDING_AMBIGUOUS",
      "Exact EX session returned conflicting recordings",
    );
  }
  return unique.values().next().value || null;
}

function createTrainingCallReviewProviderService({
  resolveAuthorizedSource,
  createCallrailClientImpl = createCallrailClient,
  createRingCentralClientImpl = createRingCentralClient,
  fetchImpl = globalThis.fetch,
  dnsLookup = dns.promises.lookup,
  allowedRecordingHosts = [
    env("PHONEBURNER_RECORDING_ALLOWED_HOSTS", ""),
    env("SALES_TRAINER_CALL_REVIEW_ALLOWED_RECORDING_HOSTS", ""),
  ].filter(Boolean).join(","),
  tempRoot = path.join(os.tmpdir(), "training-call-review"),
  maxBytes = DEFAULT_MAX_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
} = {}) {
  if (typeof resolveAuthorizedSource !== "function") {
    throw new TypeError("resolveAuthorizedSource closure is required");
  }
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetch implementation is required");
  }
  const effectiveMaxBytes = Math.max(
    1,
    Math.min(Number(maxBytes) || DEFAULT_MAX_BYTES, 128 * 1024 * 1024),
  );
  const effectiveTimeoutMs = Math.max(
    1_000,
    Math.min(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 120_000),
  );
  const effectiveMaxRedirects = Math.max(
    0,
    Math.min(Number(maxRedirects) || DEFAULT_MAX_REDIRECTS, 10),
  );
  const allowedHostRules = new Set(
    parseAllowedRecordingHosts(allowedRecordingHosts),
  );
  function addAllowedHostFromUrl(value) {
    try {
      const parsed = new URL(String(value || ""));
      if (parsed.protocol === "https:" && parsed.hostname) {
        allowedHostRules.add(parsed.hostname.toLowerCase().replace(/\.$/, ""));
      }
    } catch {
      // A missing/invalid RC API base adds no authority; the explicit
      // recording-host allowlist still fails closed.
    }
  }
  function isHostAllowed(hostname) {
    return [...allowedHostRules].some((rule) =>
      hostnameMatchesAllowedRule(hostname, rule));
  }

  async function downloadHttpsRecording({
    url,
    provider,
    headers = {},
  }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), effectiveTimeoutMs);
    let current = await assertPublicHttpsUrl(url, {
      lookup: dnsLookup,
      isHostAllowed,
    });
    const authenticatedOrigin = current.origin;
    let mayForwardSensitiveHeaders = true;
    try {
      for (let redirectCount = 0; ; redirectCount += 1) {
        let response;
        try {
          response = await fetchImpl(current, {
            method: "GET",
            headers:
              mayForwardSensitiveHeaders && current.origin === authenticatedOrigin
                ? headers
                : {},
            redirect: "manual",
            signal: controller.signal,
          });
        } catch (error) {
          if (error?.name === "AbortError") {
            throw providerError(
              "TRAINER_CALL_REVIEW_RECORDING_TIMEOUT",
              "Recording download timed out",
            );
          }
          throw providerError(
            "TRAINER_CALL_REVIEW_RECORDING_FETCH_FAILED",
            "Recording download failed",
          );
        }

        if (REDIRECT_STATUSES.has(response.status)) {
          if (redirectCount >= effectiveMaxRedirects) {
            throw providerError(
              "TRAINER_CALL_REVIEW_REDIRECT_LIMIT",
              "Recording redirect limit exceeded",
            );
          }
          const location = normalizeToken(response.headers?.get?.("location"));
          if (!location) {
            throw providerError(
              "TRAINER_CALL_REVIEW_REDIRECT_INVALID",
              "Recording redirect was invalid",
            );
          }
          const next = await assertPublicHttpsUrl(
            new URL(location, current).toString(),
            { lookup: dnsLookup, isHostAllowed },
          );
          if (next.origin !== authenticatedOrigin) {
            mayForwardSensitiveHeaders = false;
          }
          current = next;
          continue;
        }
        if (!response.ok) {
          throw providerError(
            "TRAINER_CALL_REVIEW_RECORDING_HTTP_FAILED",
            `Recording provider returned HTTP ${Number(response.status) || 0}`,
          );
        }
        const contentType = responseContentType(response);
        if (!contentTypeMayContainAudio(contentType)) {
          throw providerError(
            "TRAINER_CALL_REVIEW_AUDIO_CONTENT_TYPE_REJECTED",
            "Recording response content type was not audio",
          );
        }
        const artifact = await streamResponseToTemp({
          response,
          contentType,
          maxBytes: effectiveMaxBytes,
          tempRoot,
        });
        return Object.freeze({
          ...artifact,
          provider,
        });
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  async function resolveExUrl(callLog, candidate) {
    const sessionId = normalizeToken(callLog?.telephonySessionId);
    if (!sessionId) {
      throw providerError(
        "TRAINER_CALL_REVIEW_EX_SESSION_REQUIRED",
        "Exact EX session identity is required",
      );
    }
    const candidateSession = normalizeToken(
      candidate?.locator?.telephonySessionId,
    );
    if (candidateSession && candidateSession !== sessionId) {
      throw providerError(
        "TRAINER_CALL_REVIEW_EX_SESSION_MISMATCH",
        "EX session identity did not match",
      );
    }
    const startedAt = new Date(callLog?.callStartTime);
    if (!Number.isFinite(startedAt.getTime())) {
      throw providerError(
        "TRAINER_CALL_REVIEW_EX_START_REQUIRED",
        "EX call start time is required",
      );
    }
    const query = {
      view: "Detailed",
      type: "Voice",
      perPage: 100,
      dateFrom: new Date(startedAt.getTime() - 10 * 60 * 1000).toISOString(),
      dateTo: new Date(startedAt.getTime() + 30 * 60 * 1000).toISOString(),
    };
    const client = createRingCentralClientImpl();
    addAllowedHostFromUrl(client?.config?.serverUrl);
    await client.reinitializePlatform?.({
      force: false,
      reason: "training-call-review",
    });
    let exact = null;
    if (callLog.extensionId && typeof client.getExtensionCallLog === "function") {
      const extensionPayload = await client
        .getExtensionCallLog(String(callLog.extensionId), query)
        .catch(() => null);
      exact = selectExactRingcentralRecording(
        extensionPayload?.records,
        sessionId,
      );
    }
    if (!exact) {
      const accountPayload = await client.getAccountCallLog(query);
      exact = selectExactRingcentralRecording(accountPayload?.records, sessionId);
    }
    if (!exact) {
      throw providerError(
        "TRAINER_CALL_REVIEW_EX_RECORDING_NOT_FOUND",
        "No recording matched the exact EX session",
      );
    }
    const token = await client.authenticate();
    return {
      url: exact.recording.contentUri,
      headers: { Authorization: `Bearer ${token}` },
    };
  }

  async function downloadRecording() {
    const privateSource = await resolveAuthorizedSource();
    const callLog =
      privateSource?.callLog && typeof privateSource.callLog === "object"
        ? privateSource.callLog
        : null;
    const privateCandidate =
      privateSource?.recordingCandidate || privateSource?.candidate;
    const candidate =
      privateCandidate && typeof privateCandidate === "object"
        ? privateCandidate
        : null;
    if (!callLog || !candidate || candidate.eligible !== true) {
      throw providerError(
        "TRAINER_CALL_REVIEW_AUTHORIZED_SOURCE_REQUIRED",
        "Freshly authorized recording source is required",
      );
    }
    const provider = normalizeProvider(candidate.provider);

    if (provider === "phoneburner") {
      const sourceUri = normalizeToken(candidate.locator?.sourceUri);
      const persisted = normalizeToken(callLog.recordingArchive?.sourceUri);
      if (
        candidate.kind !== "persisted-provider-recording" ||
        !sourceUri ||
        sourceUri !== persisted
      ) {
        throw providerError(
          "TRAINER_CALL_REVIEW_PHONEBURNER_SOURCE_MISMATCH",
          "PhoneBurner recording source did not match persisted evidence",
        );
      }
      return downloadHttpsRecording({ url: sourceUri, provider });
    }

    if (provider === "callrail") {
      const providerCallId = normalizeToken(
        candidate.locator?.providerCallId,
      );
      const exactIds = new Set(
        [
          callLog.providerCallId,
          callLog.attempts?.callrail?.callId,
        ].map(normalizeToken).filter(Boolean),
      );
      if (
        candidate.kind !== "provider-call-lookup" ||
        !providerCallId ||
        !exactIds.has(providerCallId)
      ) {
        throw providerError(
          "TRAINER_CALL_REVIEW_CALLRAIL_ID_MISMATCH",
          "CallRail provider call identity did not match",
        );
      }
      const client = createCallrailClientImpl(callLog.domain);
      const recording = await client.getCallRecording(providerCallId);
      const url = normalizeToken(recording?.url);
      if (!url) {
        throw providerError(
          "TRAINER_CALL_REVIEW_CALLRAIL_RECORDING_NOT_FOUND",
          "CallRail returned no recording for the exact call",
        );
      }
      return downloadHttpsRecording({ url, provider });
    }

    if (provider === "ex") {
      const resolved = await resolveExUrl(callLog, candidate);
      return downloadHttpsRecording({
        url: resolved.url,
        headers: resolved.headers,
        provider,
      });
    }

    throw providerError(
      "TRAINER_CALL_REVIEW_PROVIDER_UNSUPPORTED",
      "Recording provider is unsupported",
    );
  }

  return Object.freeze({
    downloadRecording,
  });
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_TIMEOUT_MS,
  TrainingCallReviewProviderError,
  assertPublicHttpsUrl,
  createTrainingCallReviewProviderService,
  hasAudioMagic,
  hostnameMatchesAllowedRule,
  isPublicIp,
  parseAllowedRecordingHosts,
  selectExactRingcentralRecording,
};
