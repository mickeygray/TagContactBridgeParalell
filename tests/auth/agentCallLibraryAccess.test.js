"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ROLE_DEFAULT_PERMISSIONS,
  effectivePermissionsFor,
  hasPermission,
} = require("../../packages/shared-auth/src/permissionsCatalog");

test("internal agents can access the CX Calls tab by default", () => {
  const roleDefaults = ROLE_DEFAULT_PERMISSIONS["internal-agent"];
  assert.ok(roleDefaults.includes("calls.read-self"));
  assert.ok(roleDefaults.includes("calls.recordings"));
  assert.equal(hasPermission({ role: "internal-agent" }, "calls.recordings"), true);
  assert.ok(effectivePermissionsFor({ role: "internal-agent" }).includes("calls.recordings"));
});

test("managers also retain recording access for the Calls tab", () => {
  const roleDefaults = ROLE_DEFAULT_PERMISSIONS.manager;
  assert.ok(roleDefaults.includes("calls.read"));
  assert.ok(roleDefaults.includes("calls.recordings"));
  assert.equal(hasPermission({ role: "manager" }, "calls.recordings"), true);
});
