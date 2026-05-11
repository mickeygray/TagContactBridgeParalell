"use strict";

// Pure-function tests for cxTokenStorageService.encrypt/decrypt and
// related crypto invariants. Run via:
//   node --test tests/auth/cxTokenStorage.test.js

// IMPORTANT: clear any existing CX_TOKEN_ENCRYPTION_KEY BEFORE require
// so we control the test key.
const _origKey = process.env.CX_TOKEN_ENCRYPTION_KEY;
process.env.CX_TOKEN_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.on("exit", () => {
  if (_origKey === undefined) delete process.env.CX_TOKEN_ENCRYPTION_KEY;
  else process.env.CX_TOKEN_ENCRYPTION_KEY = _origKey;
});

const { test } = require("node:test");
const assert = require("node:assert/strict");

const cx = require("../../packages/shared-services/src/cxTokenStorageService");

test("isConfigured — true with valid 64-hex key", () => {
  cx.resetCache();
  assert.equal(cx.isConfigured(), true);
});

test("isConfigured — false with missing key", () => {
  const saved = process.env.CX_TOKEN_ENCRYPTION_KEY;
  delete process.env.CX_TOKEN_ENCRYPTION_KEY;
  cx.resetCache();
  assert.equal(cx.isConfigured(), false);
  process.env.CX_TOKEN_ENCRYPTION_KEY = saved;
  cx.resetCache();
});

test("isConfigured — false with non-hex key", () => {
  const saved = process.env.CX_TOKEN_ENCRYPTION_KEY;
  process.env.CX_TOKEN_ENCRYPTION_KEY = "not-hex-at-all";
  cx.resetCache();
  assert.equal(cx.isConfigured(), false);
  process.env.CX_TOKEN_ENCRYPTION_KEY = saved;
  cx.resetCache();
});

test("isConfigured — false with wrong-length hex", () => {
  const saved = process.env.CX_TOKEN_ENCRYPTION_KEY;
  process.env.CX_TOKEN_ENCRYPTION_KEY = "abcdef";
  cx.resetCache();
  assert.equal(cx.isConfigured(), false);
  process.env.CX_TOKEN_ENCRYPTION_KEY = saved;
  cx.resetCache();
});

test("encrypt — returns null for null/undefined/empty", () => {
  assert.equal(cx.encrypt(null), null);
  assert.equal(cx.encrypt(undefined), null);
  assert.equal(cx.encrypt(""), null);
});

test("decrypt — returns null for null/empty input", () => {
  assert.equal(cx.decrypt(null), null);
  assert.equal(cx.decrypt(""), null);
});

test("encrypt → decrypt roundtrip preserves plaintext", () => {
  const plain = "this-is-a-rc-refresh-token-very-long-and-important-12345";
  const enc = cx.encrypt(plain);
  assert.notEqual(enc, plain);
  assert.equal(cx.decrypt(enc), plain);
});

test("encrypt produces different ciphertext for same plaintext (random IV)", () => {
  const plain = "same-secret";
  const a = cx.encrypt(plain);
  const b = cx.encrypt(plain);
  assert.notEqual(a, b, "two encryptions of same input must differ (random IV)");
  assert.equal(cx.decrypt(a), plain);
  assert.equal(cx.decrypt(b), plain);
});

test("decrypt — tampered ciphertext throws (GCM auth failure)", () => {
  const plain = "secret-to-tamper";
  const enc = cx.encrypt(plain);
  // Flip a byte in the ciphertext portion (after IV+TAG = 28 bytes base64-decoded)
  const buf = Buffer.from(enc, "base64");
  buf[buf.length - 1] = buf[buf.length - 1] ^ 0xff;
  const tampered = buf.toString("base64");
  assert.throws(() => cx.decrypt(tampered));
});

test("decrypt — short blob throws", () => {
  const tooShort = Buffer.from([1, 2, 3]).toString("base64");
  assert.throws(() => cx.decrypt(tooShort), /too short/);
});

test("encrypt handles long values (>1KB tokens)", () => {
  const plain = "x".repeat(2000);
  const enc = cx.encrypt(plain);
  assert.equal(cx.decrypt(enc), plain);
});

test("encrypt handles unicode + special chars", () => {
  const plain = "tøken-ñ-üñîcødé:🔐:!@#$%^&*";
  const enc = cx.encrypt(plain);
  assert.equal(cx.decrypt(enc), plain);
});

// ── deriveOAuthValidity / summarizeOAuthValidityFromAccount ──────

test("deriveOAuthValidity — false when no refresh token", () => {
  const r = cx.deriveOAuthValidity({}, {});
  assert.equal(r.isOAuthValidated, false);
  assert.equal(r.reason, "no-refresh-token");
});

test("deriveOAuthValidity — true with refresh token, no expiry", () => {
  const r = cx.deriveOAuthValidity(
    { refreshTokenEnc: "anything" },
    { bearerEnc: "anything" },
  );
  assert.equal(r.isOAuthValidated, true);
  assert.equal(r.reason, null);
});

test("deriveOAuthValidity — false when consent revoked", () => {
  const r = cx.deriveOAuthValidity(
    { refreshTokenEnc: "x", consentRevokedAt: new Date() },
    {},
  );
  assert.equal(r.isOAuthValidated, false);
  assert.equal(r.reason, "consent-revoked");
});

test("deriveOAuthValidity — false when refresh token expired", () => {
  const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const r = cx.deriveOAuthValidity(
    { refreshTokenEnc: "x", refreshTokenExpiresAt: past },
    {},
  );
  assert.equal(r.isOAuthValidated, false);
  assert.equal(r.reason, "refresh-token-expired");
});

test("deriveOAuthValidity — true with future expiry", () => {
  const future = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
  const r = cx.deriveOAuthValidity(
    { refreshTokenEnc: "x", refreshTokenExpiresAt: future },
    { bearerEnc: "y" },
  );
  assert.equal(r.isOAuthValidated, true);
});

test("deriveOAuthValidity — false when last refresh failed AND no bearer", () => {
  const r = cx.deriveOAuthValidity(
    { refreshTokenEnc: "x", lastRefreshError: "rc-401" },
    {}, // no bearer
  );
  assert.equal(r.isOAuthValidated, false);
  assert.equal(r.reason, "refresh-failed");
});

test("deriveOAuthValidity — true if old error but bearer present", () => {
  // Successful refresh after a transient error → bearer was minted
  const r = cx.deriveOAuthValidity(
    { refreshTokenEnc: "x", lastRefreshError: "old-error" },
    { bearerEnc: "current" },
  );
  assert.equal(r.isOAuthValidated, true);
});

test("summarizeOAuthValidityFromAccount — extracts known fields", () => {
  const account = {
    cxAuth: {
      refreshTokenEnc: "x",
      rcUserEmail: "agent@example.com",
      refreshTokenExpiresAt: new Date("2030-01-01"),
      consentGrantedAt: new Date("2026-01-01"),
    },
    cxSession: { bearerEnc: "y" },
  };
  const s = cx.summarizeOAuthValidityFromAccount(account);
  assert.equal(s.isOAuthValidated, true);
  assert.equal(s.rcUserEmail, "agent@example.com");
  assert.deepEqual(s.refreshTokenExpiresAt, new Date("2030-01-01"));
});

test("summarizeOAuthValidityFromAccount — null account → not validated", () => {
  const s = cx.summarizeOAuthValidityFromAccount(null);
  assert.equal(s.isOAuthValidated, false);
  assert.equal(s.invalidReason, "no-refresh-token");
});
