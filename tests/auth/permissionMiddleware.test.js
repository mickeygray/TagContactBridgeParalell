"use strict";

// Tests for requirePermission / requireAnyPermission / requireAllPermissions
// Express middleware. Pure unit tests — fake req/res/next.
// Run via: node --test tests/auth/permissionMiddleware.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  requirePermission,
  requireAnyPermission,
  requireAllPermissions,
} = require("../../packages/shared-auth/src");

function fakeRes() {
  const captured = { statusCode: null, body: null };
  return {
    captured,
    status(code) { captured.statusCode = code; return this; },
    json(body) { captured.body = body; return this; },
  };
}

function makeReq(user) {
  return { user };
}

test("requirePermission — passes when user has the key", () => {
  const mw = requirePermission("queue.dial");
  const req = makeReq({ role: "internal-agent" });
  const res = fakeRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(res.captured.statusCode, null);
});

test("requirePermission — 403 when user lacks the key", () => {
  const mw = requirePermission("agents.manage");
  const req = makeReq({ role: "internal-agent" });
  const res = fakeRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.captured.statusCode, 403);
  assert.equal(res.captured.body.requiredPermission, "agents.manage");
});

test("requirePermission — 401 when no user (auth missing)", () => {
  const mw = requirePermission("queue.dial");
  const req = { user: null };
  const res = fakeRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.captured.statusCode, 401);
});

test("requirePermission — admin always passes", () => {
  const mw = requirePermission("system.admin");
  const req = makeReq({ role: "admin" });
  const res = fakeRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test("requireAnyPermission — passes if user has any of the keys", () => {
  const mw = requireAnyPermission(["agents.manage", "queue.dial"]);
  const req = makeReq({ role: "internal-agent" });
  const res = fakeRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test("requireAnyPermission — 403 if user has none", () => {
  const mw = requireAnyPermission(["agents.manage", "system.deploy"]);
  const req = makeReq({ role: "internal-agent" });
  const res = fakeRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.captured.statusCode, 403);
  assert.deepEqual(res.captured.body.requiredAnyOf, ["agents.manage", "system.deploy"]);
});

test("requireAllPermissions — passes only if user has all", () => {
  const mw = requireAllPermissions(["queue.dial", "queue.dispose"]);
  const req = makeReq({ role: "internal-agent" });
  const res = fakeRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test("requireAllPermissions — 403 if missing one", () => {
  const mw = requireAllPermissions(["queue.dial", "agents.manage"]);
  const req = makeReq({ role: "internal-agent" });
  const res = fakeRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.captured.statusCode, 403);
});

test("requirePermission — extra grants beyond role count", () => {
  const mw = requirePermission("agents.manage");
  const req = makeReq({ role: "internal-agent", permissions: ["agents.manage"] });
  const res = fakeRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});
