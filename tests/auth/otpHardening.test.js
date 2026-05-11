"use strict";

// Tests for the OTP hardening startup validator.
// Run via: node --test tests/auth/otpHardening.test.js

// IMPORTANT: clear any deprecated env var BEFORE requiring shared-config
// (which loads dotenv at require-time and would set it from the live .env).
// We test the validator's ability to detect this var via explicit per-test
// setting; the baseline state must be unset.
const _originalDefaultLoginCode = process.env.DEFAULT_LOGIN_CODE;
delete process.env.DEFAULT_LOGIN_CODE;
process.on("exit", () => {
  if (_originalDefaultLoginCode !== undefined) {
    process.env.DEFAULT_LOGIN_CODE = _originalDefaultLoginCode;
  }
});

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { validateSharedConfig } = require("../../packages/shared-config/src");

// Re-clear in case the dotenv load inside shared-config restored it
// (shouldn't happen since we deleted the live env var BEFORE require,
// but defense-in-depth — dotenv non-override mode means our delete wins).
delete process.env.DEFAULT_LOGIN_CODE;

function baseConfig(overrides = {}) {
  return {
    mongoUri: "mongodb://localhost:27017/test",
    parallelDbName: "test",
    serviceName: "test-service",
    jwtSecret: "test-secret-strong-enough",
    healthToken: "h",
    authOtpDelivery: { fromEmail: "noreply@example.com" },
    authOtpPreview: false,
    startupValidation: { strict: false, requireHealthToken: false },
    ...overrides,
  };
}

test("validateSharedConfig — non-strict mode allows AUTH_OTP_PREVIEW=true", () => {
  const config = baseConfig({
    authOtpPreview: true,
    startupValidation: { strict: false },
  });
  assert.doesNotThrow(() => validateSharedConfig(config));
});

test("validateSharedConfig — strict mode rejects AUTH_OTP_PREVIEW=true", () => {
  const config = baseConfig({
    authOtpPreview: true,
    startupValidation: { strict: true },
  });
  assert.throws(
    () => validateSharedConfig(config),
    /AUTH_OTP_PREVIEW=true must NOT be enabled in production/,
  );
});

test("validateSharedConfig — strict mode requires authOtpDelivery.fromEmail when preview off", () => {
  const config = baseConfig({
    authOtpPreview: false,
    authOtpDelivery: { fromEmail: "" },
    startupValidation: { strict: true },
  });
  assert.throws(
    () => validateSharedConfig(config),
    /AUTH_OTP_FROM_EMAIL/,
  );
});

test("validateSharedConfig — strict mode passes with proper config", () => {
  const config = baseConfig({
    authOtpPreview: false,
    authOtpDelivery: { fromEmail: "noreply@example.com" },
    startupValidation: { strict: true },
  });
  assert.doesNotThrow(() => validateSharedConfig(config));
});

test("validateSharedConfig — strict mode rejects DEFAULT_LOGIN_CODE env var", () => {
  const previous = process.env.DEFAULT_LOGIN_CODE;
  process.env.DEFAULT_LOGIN_CODE = "246810";
  try {
    const config = baseConfig({
      authOtpPreview: false,
      authOtpDelivery: { fromEmail: "noreply@example.com" },
      startupValidation: { strict: true },
    });
    assert.throws(
      () => validateSharedConfig(config),
      /DEFAULT_LOGIN_CODE.*no longer supported/,
    );
  } finally {
    if (previous === undefined) {
      delete process.env.DEFAULT_LOGIN_CODE;
    } else {
      process.env.DEFAULT_LOGIN_CODE = previous;
    }
  }
});

test("validateSharedConfig — strict mode rejects weak JWT secret", () => {
  const config = baseConfig({
    jwtSecret: "change-me",
    startupValidation: { strict: true },
  });
  assert.throws(
    () => validateSharedConfig(config),
    /JWT_SECRET/,
  );
});

test("validateSharedConfig — non-strict mode allows weak JWT for dev", () => {
  const config = baseConfig({
    jwtSecret: "change-me",
    startupValidation: { strict: false },
  });
  assert.doesNotThrow(() => validateSharedConfig(config));
});
