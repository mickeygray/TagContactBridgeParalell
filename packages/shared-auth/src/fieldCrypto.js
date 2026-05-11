"use strict";

const crypto = require("crypto");

// Field-level encryption util for sensitive PII (SSN, spouse SSN, etc.)
// stored at rest in CaseProfile / MasterProspectIndex.
//
// Uses AES-256-GCM with a per-record random IV. The same plaintext
// encrypts to a different ciphertext each call (no deterministic
// equality leak). The key is loaded from FIELD_ENCRYPTION_KEY env —
// must be 32 bytes (64 hex chars or 44 base64 chars) — and rotated
// outside the codebase via the deploy pipeline.
//
// Output format (string, single-line, easy to store in Mongo strings):
//   v1:<base64-iv>:<base64-tag>:<base64-ciphertext>
//
// `decrypt` is tolerant: if the input is empty / null / not-our-shape
// it returns null. If the input IS our shape but decryption fails
// (wrong key, corruption) it throws — that's a real error worth
// surfacing.

const ALGO = "aes-256-gcm";
const VERSION = "v1";
const KEY_LENGTH = 32;
const IV_LENGTH = 12;

let cachedKey = null;
let cachedKeyMissing = null;

function loadKey() {
  if (cachedKey) return cachedKey;
  if (cachedKeyMissing) return null;
  const raw = (process.env.FIELD_ENCRYPTION_KEY || "").trim();
  if (!raw) {
    cachedKeyMissing = true;
    return null;
  }
  // Accept hex (64 chars) or base64 (44 chars). Anything else throws
  // because shipping a misconfigured key is a footgun.
  let buf;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    buf = Buffer.from(raw, "hex");
  } else if (raw.length === 44) {
    buf = Buffer.from(raw, "base64");
  } else {
    throw new Error(
      "FIELD_ENCRYPTION_KEY must be 32 bytes — provide either 64 hex chars or 44 base64 chars",
    );
  }
  if (buf.length !== KEY_LENGTH) {
    throw new Error(
      `FIELD_ENCRYPTION_KEY decoded length ${buf.length} != ${KEY_LENGTH} bytes`,
    );
  }
  cachedKey = buf;
  return buf;
}

/**
 * Encrypt a plaintext string. Returns null when input is empty so
 * `null` always means "no value stored" — callers can use the result
 * as the field value verbatim.
 *
 * If FIELD_ENCRYPTION_KEY is unset, throws — encryption is mandatory
 * for the fields that call this. Don't silently store plaintext.
 */
function encryptField(plaintext) {
  const value = plaintext == null ? "" : String(plaintext);
  if (!value) return null;
  const key = loadKey();
  if (!key) {
    const err = new Error(
      "FIELD_ENCRYPTION_KEY is not configured — refusing to store plaintext PII",
    );
    err.status = 500;
    throw err;
  }
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(":");
}

/**
 * Decrypt a previously-encrypted string. Returns null on null/empty
 * input or on values that aren't in our shape (eg. legacy plaintext —
 * don't crash on those, just refuse to expose). Throws on real
 * decryption failures.
 */
function decryptField(value) {
  if (value == null) return null;
  const text = String(value);
  if (!text) return null;
  const parts = text.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  const key = loadKey();
  if (!key) {
    const err = new Error(
      "FIELD_ENCRYPTION_KEY is not configured — cannot decrypt stored PII",
    );
    err.status = 500;
    throw err;
  }
  const iv = Buffer.from(parts[1], "base64");
  const tag = Buffer.from(parts[2], "base64");
  const enc = Buffer.from(parts[3], "base64");
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString("utf8");
}

/**
 * Mask an SSN-shaped string for logs / UI ("XXX-XX-1234"). Tolerates
 * any input — returns null when nothing usable.
 */
function maskSsn(ssn) {
  const digits = String(ssn || "").replace(/\D/g, "");
  if (digits.length < 4) return null;
  return `XXX-XX-${digits.slice(-4)}`;
}

/**
 * Format an SSN as Logics expects: `xxx-xx-xxxx`. Returns null if the
 * input doesn't have 9 digits.
 */
function formatSsnForLogics(ssn) {
  const digits = String(ssn || "").replace(/\D/g, "");
  if (digits.length !== 9) return null;
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
}

function isFieldEncryptionConfigured() {
  return Boolean(loadKey());
}

module.exports = {
  decryptField,
  encryptField,
  formatSsnForLogics,
  isFieldEncryptionConfigured,
  maskSsn,
};
