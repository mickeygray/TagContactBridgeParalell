"use strict";

// Tests for the permissions catalog + helper functions.
// Run via: node --test tests/auth/permissionsCatalog.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  PERMISSIONS_CATALOG,
  ROLE_DEFAULT_PERMISSIONS,
  ALL_PERMISSIONS,
  ALL_ROLES,
  isKnownPermission,
  isKnownRole,
  getRoleDefaults,
  effectivePermissionsFor,
  hasPermission,
  hasAnyPermission,
  hasAllPermissions,
  normalizePermissionList,
} = require("../../packages/shared-auth/src/permissionsCatalog");

test("PERMISSIONS_CATALOG is non-empty + every entry has a description", () => {
  const keys = Object.keys(PERMISSIONS_CATALOG);
  assert.ok(keys.length > 10);
  for (const key of keys) {
    assert.equal(typeof PERMISSIONS_CATALOG[key], "string");
    assert.ok(PERMISSIONS_CATALOG[key].length > 0);
  }
});

test("PERMISSIONS_CATALOG and ROLE_DEFAULT_PERMISSIONS are frozen", () => {
  assert.throws(() => { PERMISSIONS_CATALOG["new.key"] = "tampered"; });
  assert.throws(() => { ROLE_DEFAULT_PERMISSIONS.admin = ["tampered"]; });
});

test("ROLE_DEFAULT_PERMISSIONS — admin has all permissions", () => {
  const adminPerms = ROLE_DEFAULT_PERMISSIONS.admin;
  for (const key of Object.keys(PERMISSIONS_CATALOG)) {
    assert.ok(adminPerms.includes(key), `admin missing: ${key}`);
  }
});

test("ROLE_DEFAULT_PERMISSIONS — every role has only known permissions", () => {
  for (const [role, perms] of Object.entries(ROLE_DEFAULT_PERMISSIONS)) {
    for (const p of perms) {
      assert.ok(isKnownPermission(p), `role ${role} has unknown permission: ${p}`);
    }
  }
});

test("ROLE_DEFAULT_PERMISSIONS — internal-agent has queue.dial + queue.dispose", () => {
  const perms = ROLE_DEFAULT_PERMISSIONS["internal-agent"];
  assert.ok(perms.includes("queue.dial"));
  assert.ok(perms.includes("queue.dispose"));
});

test("ROLE_DEFAULT_PERMISSIONS — internal-agent does NOT have agents.manage", () => {
  const perms = ROLE_DEFAULT_PERMISSIONS["internal-agent"];
  assert.equal(perms.includes("agents.manage"), false);
});

test("ROLE_DEFAULT_PERMISSIONS — manager has agents.manage + pacing.write", () => {
  const perms = ROLE_DEFAULT_PERMISSIONS.manager;
  assert.ok(perms.includes("agents.manage"));
  assert.ok(perms.includes("pacing.write"));
});

test("ROLE_DEFAULT_PERMISSIONS — manager does NOT have system.deploy", () => {
  const perms = ROLE_DEFAULT_PERMISSIONS.manager;
  assert.equal(perms.includes("system.deploy"), false);
});

test("isKnownPermission / isKnownRole", () => {
  assert.equal(isKnownPermission("queue.dial"), true);
  assert.equal(isKnownPermission("not-a-real-key"), false);
  assert.equal(isKnownRole("admin"), true);
  assert.equal(isKnownRole("nonsense"), false);
});

test("getRoleDefaults — unknown role returns empty array", () => {
  const r = getRoleDefaults("not-a-role");
  assert.deepEqual(r, []);
});

test("hasPermission — admin has every permission implicitly", () => {
  const admin = { role: "admin" };
  for (const key of Object.keys(PERMISSIONS_CATALOG)) {
    assert.ok(hasPermission(admin, key));
  }
});

test("hasPermission — admin does NOT have unknown permission", () => {
  const admin = { role: "admin" };
  assert.equal(hasPermission(admin, "made-up.key"), false);
});

test("hasPermission — internal-agent has role defaults", () => {
  const agent = { role: "internal-agent", permissions: [] };
  assert.equal(hasPermission(agent, "queue.dial"), true);
  assert.equal(hasPermission(agent, "queue.dispose"), true);
  assert.equal(hasPermission(agent, "agents.manage"), false);
});

test("hasPermission — extra grants are additive on top of role", () => {
  const agent = { role: "internal-agent", permissions: ["agents.manage"] };
  assert.equal(hasPermission(agent, "agents.manage"), true);
  assert.equal(hasPermission(agent, "queue.dial"), true);
});

test("hasPermission — null user always false", () => {
  assert.equal(hasPermission(null, "queue.dial"), false);
  assert.equal(hasPermission(undefined, "queue.dial"), false);
});

test("hasPermission — empty key always false", () => {
  assert.equal(hasPermission({ role: "admin" }, ""), false);
  assert.equal(hasPermission({ role: "admin" }, null), false);
});

test("hasAnyPermission — true if any match", () => {
  const agent = { role: "internal-agent" };
  assert.equal(hasAnyPermission(agent, ["agents.manage", "queue.dial"]), true);
  assert.equal(hasAnyPermission(agent, ["agents.manage", "system.admin"]), false);
});

test("hasAllPermissions — true only if all match", () => {
  const agent = { role: "internal-agent" };
  assert.equal(hasAllPermissions(agent, ["queue.dial", "queue.dispose"]), true);
  assert.equal(hasAllPermissions(agent, ["queue.dial", "agents.manage"]), false);
});

test("effectivePermissionsFor — admin returns all", () => {
  const result = effectivePermissionsFor({ role: "admin" });
  assert.equal(result.length, ALL_PERMISSIONS.size);
});

test("effectivePermissionsFor — agent role + extra grants merges", () => {
  const result = effectivePermissionsFor({
    role: "internal-agent",
    permissions: ["agents.manage"],
  });
  assert.ok(result.includes("queue.dial"));      // role default
  assert.ok(result.includes("queue.dispose"));    // role default
  assert.ok(result.includes("agents.manage"));    // extra grant
  assert.equal(result.includes("system.deploy"), false);
});

test("effectivePermissionsFor — dedupes when role default and extra grant overlap", () => {
  const result = effectivePermissionsFor({
    role: "internal-agent",
    permissions: ["queue.dial"],  // already in role defaults
  });
  const dialCount = result.filter((p) => p === "queue.dial").length;
  assert.equal(dialCount, 1);
});

test("effectivePermissionsFor — filters unknown grants", () => {
  const result = effectivePermissionsFor({
    role: "internal-agent",
    permissions: ["fake.permission"],
  });
  assert.equal(result.includes("fake.permission"), false);
});

test("effectivePermissionsFor — null user returns empty", () => {
  assert.deepEqual(effectivePermissionsFor(null), []);
});

test("normalizePermissionList — filters unknowns + dedupes + trims", () => {
  const result = normalizePermissionList([
    "queue.dial",
    " queue.dial ", // duplicate after trim
    "fake.key",
    "agents.manage",
    "",
    null,
  ]);
  assert.deepEqual(result, ["queue.dial", "agents.manage"]);
});

test("normalizePermissionList — non-array returns empty", () => {
  assert.deepEqual(normalizePermissionList(null), []);
  assert.deepEqual(normalizePermissionList("queue.dial"), []);
});
