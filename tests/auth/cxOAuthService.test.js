"use strict";

// Pure-function tests for cxOAuthService PKCE helpers + config detection.
// No actual HTTP calls. Run via:
//   node --test tests/auth/cxOAuthService.test.js

// Save + clear so config-check tests are hermetic
const _saved = {};
for (const k of [
  "RC_OAUTH_CLIENT_ID",
  "RC_OAUTH_CLIENT_SECRET",
  "RC_OAUTH_REDIRECT_URI",
  "RING_CENTRAL_CLIENT_ID",
  "RING_CENTRAL_CLIENT_SECRET",
  "CX_TOKEN_ENCRYPTION_KEY",
]) {
  _saved[k] = process.env[k];
  delete process.env[k];
}
process.on("exit", () => {
  for (const [k, v] of Object.entries(_saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// Set a valid encryption key so cxTokenStorage's config check passes
process.env.CX_TOKEN_ENCRYPTION_KEY =
  "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const cxOAuth = require("../../packages/shared-services/src/cxOAuthService");
const cxStore = require("../../packages/shared-services/src/cxTokenStorageService");

// Reset crypto cache so env changes are picked up
cxStore.resetCache();

test("generateCodeVerifier — RFC 7636 length range", () => {
  const v = cxOAuth.generateCodeVerifier();
  assert.ok(v.length >= 43 && v.length <= 128, `verifier length ${v.length}`);
});

test("generateCodeVerifier — URL-safe base64 chars only", () => {
  const v = cxOAuth.generateCodeVerifier();
  assert.match(v, /^[A-Za-z0-9_-]+$/);
});

test("generateCodeVerifier — different each call (32 bytes entropy)", () => {
  const a = cxOAuth.generateCodeVerifier();
  const b = cxOAuth.generateCodeVerifier();
  assert.notEqual(a, b);
});

test("generateCodeChallenge — S256 of verifier", () => {
  const v = "test-verifier-fixed";
  const c = cxOAuth.generateCodeChallenge(v);
  // Same input → same challenge (deterministic SHA256)
  assert.equal(cxOAuth.generateCodeChallenge(v), c);
  // URL-safe base64
  assert.match(c, /^[A-Za-z0-9_-]+$/);
});

test("generateState — URL-safe + unique", () => {
  const a = cxOAuth.generateState();
  const b = cxOAuth.generateState();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
});

test("isConfigured — false when no client_id set", () => {
  delete process.env.RC_OAUTH_CLIENT_ID;
  delete process.env.RING_CENTRAL_CLIENT_ID;
  assert.equal(cxOAuth.isConfigured(), false);
});

test("isConfigured — false when no redirect_uri set", () => {
  process.env.RC_OAUTH_CLIENT_ID = "client-id-123";
  process.env.RC_OAUTH_CLIENT_SECRET = "client-secret-xyz";
  delete process.env.RC_OAUTH_REDIRECT_URI;
  assert.equal(cxOAuth.isConfigured(), false);
});

test("isConfigured — true when all three set + encryption key", () => {
  process.env.RC_OAUTH_CLIENT_ID = "client-id-123";
  process.env.RC_OAUTH_CLIENT_SECRET = "client-secret-xyz";
  process.env.RC_OAUTH_REDIRECT_URI = "https://example.com/api/auth/cx/callback";
  cxStore.resetCache();
  assert.equal(cxOAuth.isConfigured(), true);
});

test("describeConfig — returns config flags without secrets", () => {
  process.env.RC_OAUTH_CLIENT_ID = "client-id-123";
  process.env.RC_OAUTH_CLIENT_SECRET = "secret-do-not-leak";
  process.env.RC_OAUTH_REDIRECT_URI = "https://example.com/cb";
  const desc = cxOAuth.describeConfig();
  assert.equal(desc.clientIdSet, true);
  assert.equal(desc.clientSecretSet, true);
  assert.equal(desc.redirectUri, "https://example.com/cb");
  // Should NOT leak the secret value
  assert.ok(!JSON.stringify(desc).includes("secret-do-not-leak"));
});

test("start — fails cleanly when not configured", async () => {
  delete process.env.RC_OAUTH_CLIENT_ID;
  delete process.env.RING_CENTRAL_CLIENT_ID;
  const result = await cxOAuth.start({ user: { id: "x", email: "x@y.com" } });
  assert.equal(result.ok, false);
  assert.equal(result.error, "cx-oauth-not-configured");
  assert.ok(result.details);
});

test("start — fails cleanly when no user", async () => {
  process.env.RC_OAUTH_CLIENT_ID = "client-id-123";
  process.env.RC_OAUTH_CLIENT_SECRET = "secret";
  process.env.RC_OAUTH_REDIRECT_URI = "https://example.com/cb";
  const result = await cxOAuth.start({ user: null });
  assert.equal(result.ok, false);
  assert.equal(result.error, "user-context-required");
});
