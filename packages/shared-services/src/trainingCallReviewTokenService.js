"use strict";

const crypto = require("crypto");

const CASE_SOURCE_PREFIX = "trcase_v1";
const RECORDING_SOURCE_PREFIX = "trsrc_";
const CASE_SOURCE_AAD = Buffer.from(
  "training-call-review:case-source:v1",
  "utf8",
);
const DEFAULT_CASE_SOURCE_TTL_MS = 5 * 60 * 1000;
const MAX_CASE_SOURCE_TTL_MS = 15 * 60 * 1000;

class TrainingCallReviewTokenError extends Error {
  constructor() {
    super("The requested Case Review source is unavailable");
    this.name = "TrainingCallReviewTokenError";
    this.code = "TRAINER_CALL_REVIEW_CASE_SOURCE_UNAVAILABLE";
    this.status = 404;
    this.statusCode = 404;
  }
}

function unavailableCaseSource() {
  return new TrainingCallReviewTokenError();
}

function normalizeLearnerKey(value) {
  const learnerKey = String(value || "").trim().toLowerCase();
  if (!learnerKey || learnerKey.length > 320) {
    throw new TypeError("learnerKey is required");
  }
  return learnerKey;
}

function normalizeDomain(value) {
  const domain = String(value || "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_-]{1,31}$/.test(domain)) {
    throw new TypeError("domain is required");
  }
  return domain;
}

function normalizeCaseId(value) {
  const caseId = Number(value);
  if (!Number.isSafeInteger(caseId) || caseId <= 0) {
    throw new TypeError("caseId is required");
  }
  return caseId;
}

function asEpochMs(value) {
  const date = value instanceof Date ? value : new Date(value);
  const epochMs = date.getTime();
  if (!Number.isFinite(epochMs)) throw new TypeError("now returned an invalid date");
  return epochMs;
}

function base64Url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function decodeBase64Url(value, expectedLength = null) {
  const encoded = String(value || "");
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw unavailableCaseSource();
  let decoded;
  try {
    decoded = Buffer.from(encoded, "base64url");
  } catch {
    throw unavailableCaseSource();
  }
  if (
    decoded.length === 0 ||
    base64Url(decoded) !== encoded ||
    (expectedLength != null && decoded.length !== expectedLength)
  ) {
    throw unavailableCaseSource();
  }
  return decoded;
}

function safeEqual(left, right) {
  const leftDigest = crypto.createHash("sha256").update(String(left)).digest();
  const rightDigest = crypto.createHash("sha256").update(String(right)).digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

function stableCallIdentity(callLog = {}, provider) {
  const telephonySessionId = String(callLog.telephonySessionId || "").trim();
  const startedAt = new Date(callLog.callStartTime);
  if (!telephonySessionId || !Number.isFinite(startedAt.getTime())) {
    throw new TypeError("Exact call identity is required");
  }
  return JSON.stringify({
    provider,
    callLogId: String(callLog._id || callLog.id || "").trim() || null,
    telephonySessionId,
    providerCallId: String(callLog.providerCallId || "").trim() || null,
    startedAt: startedAt.toISOString(),
    durationSec: Math.max(0, Math.floor(Number(callLog.durationSec) || 0)),
  });
}

function stableRecordingIdentity(recordingCandidate = {}) {
  const provider = String(recordingCandidate.provider || "").trim().toLowerCase();
  const kind = String(recordingCandidate.kind || "").trim().toLowerCase();
  if (!recordingCandidate.eligible || !provider || !kind) {
    throw new TypeError("Eligible recording evidence is required");
  }
  const locator = recordingCandidate.locator || {};
  return JSON.stringify({
    provider,
    kind,
    telephonySessionId:
      String(locator.telephonySessionId || "").trim() || null,
    providerCallId: String(locator.providerCallId || "").trim() || null,
    sourceUri: String(locator.sourceUri || "").trim() || null,
  });
}

function createTrainingCallReviewTokenService({
  secret,
  ttlMs = DEFAULT_CASE_SOURCE_TTL_MS,
  now = () => new Date(),
  randomBytes = crypto.randomBytes,
} = {}) {
  const secretText = String(secret || "");
  if (secretText.length < 16) {
    throw new TypeError("A Case Review token secret of at least 16 characters is required");
  }
  if (typeof now !== "function" || typeof randomBytes !== "function") {
    throw new TypeError("Clock and randomBytes dependencies must be functions");
  }
  const effectiveTtlMs = Math.max(
    1_000,
    Math.min(Number(ttlMs) || DEFAULT_CASE_SOURCE_TTL_MS, MAX_CASE_SOURCE_TTL_MS),
  );
  const encryptionKey = crypto
    .createHash("sha256")
    .update("training-call-review:case-source:key:v1\0")
    .update(secretText)
    .digest();
  const fingerprintKey = crypto
    .createHmac("sha256", encryptionKey)
    .update("training-call-review:fingerprints:v1")
    .digest();

  function hmacHex(label, value) {
    return crypto
      .createHmac("sha256", fingerprintKey)
      .update(`${label}\0${String(value)}`)
      .digest("hex");
  }

  function hmacBase64Url(label, value) {
    return crypto
      .createHmac("sha256", fingerprintKey)
      .update(`${label}\0${String(value)}`)
      .digest("base64url");
  }

  function issueCaseSource({ learnerKey, domain, caseId } = {}) {
    const issuedAt = asEpochMs(now());
    const payload = Buffer.from(
      JSON.stringify({
        version: 1,
        learnerKey: normalizeLearnerKey(learnerKey),
        domain: normalizeDomain(domain),
        caseId: normalizeCaseId(caseId),
        issuedAt,
        expiresAt: issuedAt + effectiveTtlMs,
      }),
      "utf8",
    );
    const iv = Buffer.from(randomBytes(12));
    if (iv.length !== 12) throw new TypeError("randomBytes must return 12 bytes");
    const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv);
    cipher.setAAD(CASE_SOURCE_AAD);
    const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [
      CASE_SOURCE_PREFIX,
      base64Url(iv),
      base64Url(ciphertext),
      base64Url(authTag),
    ].join(".");
  }

  function resolveCaseSource({ caseSourceId, learnerKey } = {}) {
    const encoded = String(caseSourceId || "");
    if (!encoded || encoded.length > 2_048) {
      throw unavailableCaseSource();
    }
    const parts = encoded.split(".");
    if (parts.length !== 4 || parts[0] !== CASE_SOURCE_PREFIX) {
      throw unavailableCaseSource();
    }
    try {
      const iv = decodeBase64Url(parts[1], 12);
      const ciphertext = decodeBase64Url(parts[2]);
      const authTag = decodeBase64Url(parts[3], 16);
      const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, iv);
      decipher.setAAD(CASE_SOURCE_AAD);
      decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString("utf8");
      const payload = JSON.parse(plaintext);
      const expectedLearner = normalizeLearnerKey(learnerKey);
      const tokenLearner = normalizeLearnerKey(payload.learnerKey);
      const domain = normalizeDomain(payload.domain);
      const caseId = normalizeCaseId(payload.caseId);
      const currentTime = asEpochMs(now());
      if (
        payload.version !== 1 ||
        !safeEqual(expectedLearner, tokenLearner) ||
        !Number.isFinite(payload.issuedAt) ||
        !Number.isFinite(payload.expiresAt) ||
        payload.expiresAt <= payload.issuedAt ||
        payload.expiresAt - payload.issuedAt > MAX_CASE_SOURCE_TTL_MS ||
        currentTime < payload.issuedAt - 30_000 ||
        currentTime >= payload.expiresAt
      ) {
        throw unavailableCaseSource();
      }
      return Object.freeze({ learnerKey: tokenLearner, domain, caseId });
    } catch (error) {
      if (error instanceof TrainingCallReviewTokenError) throw error;
      throw unavailableCaseSource();
    }
  }

  function issueRecordingSource({
    authorization,
    callLog,
    recordingCandidate,
  } = {}) {
    const learnerKey = normalizeLearnerKey(authorization?.actorEmail);
    const domain = normalizeDomain(authorization?.domain);
    const caseId = normalizeCaseId(authorization?.caseId);
    const provider = String(recordingCandidate?.provider || "")
      .trim()
      .toLowerCase();
    const callIdentity = stableCallIdentity(callLog, provider);
    const recordingIdentity = stableRecordingIdentity(recordingCandidate);
    const callFingerprint = `callfp:${hmacHex("call", callIdentity)}`;
    const recordingFingerprint = `recfp:${hmacHex(
      "recording",
      JSON.stringify({
        domain,
        caseId,
        callIdentity,
        recordingIdentity,
      }),
    )}`;
    const sourceBinding = JSON.stringify({
      learnerKey,
      domain,
      caseId,
      callFingerprint,
      recordingFingerprint,
    });
    return Object.freeze({
      sourceId: `${RECORDING_SOURCE_PREFIX}${hmacBase64Url(
        "source",
        sourceBinding,
      )}`,
      callFingerprint,
      recordingFingerprint,
    });
  }

  return Object.freeze({
    issueCaseSource,
    issueRecordingSource,
    resolveCaseSource,
  });
}

module.exports = {
  CASE_SOURCE_PREFIX,
  DEFAULT_CASE_SOURCE_TTL_MS,
  MAX_CASE_SOURCE_TTL_MS,
  RECORDING_SOURCE_PREFIX,
  TrainingCallReviewTokenError,
  createTrainingCallReviewTokenService,
};
