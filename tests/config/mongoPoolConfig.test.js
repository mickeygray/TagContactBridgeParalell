"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  getSharedConfig,
  resolveMongoPoolConfig,
  validateSharedConfig,
} = require("../../packages/shared-config/src");

test("Mongo pool policy resolves bounded defaults", () => {
  assert.deepEqual(resolveMongoPoolConfig({}, {}), {
    maxPoolSize: 20,
    minPoolSize: 0,
    maxIdleTimeMS: 300000,
    maxConnecting: 2,
    waitQueueTimeoutMS: 10000,
  });
});

test("Mongo pool policy accepts explicit valid values", () => {
  assert.deepEqual(resolveMongoPoolConfig({
    mongoPool: {
      maxPoolSize: 30,
      minPoolSize: 2,
      maxIdleTimeMS: 600000,
      maxConnecting: 4,
      waitQueueTimeoutMS: 15000,
    },
  }, {}), {
    maxPoolSize: 30,
    minPoolSize: 2,
    maxIdleTimeMS: 600000,
    maxConnecting: 4,
    waitQueueTimeoutMS: 15000,
  });
});

for (const [name, overrides] of [
  ["maximum below range", { mongoPool: { maxPoolSize: 4 } }],
  ["fractional maximum", { mongoPool: { maxPoolSize: 20.5 } }],
  ["minimum above maximum", { mongoPool: { maxPoolSize: 10, minPoolSize: 11 } }],
  ["idle timeout below range", { mongoPool: { maxIdleTimeMS: 59999 } }],
  ["connecting above range", { mongoPool: { maxConnecting: 11 } }],
  ["wait queue below range", { mongoPool: { waitQueueTimeoutMS: 999 } }],
]) {
  test(`Mongo pool policy rejects ${name}`, () => {
    assert.throws(() => resolveMongoPoolConfig(overrides, {}), /must be an integer between/);
  });
}

test("shared config validates its normalized Mongo pool without exposing the URI", () => {
  const config = {
    ...getSharedConfig({
    mongoUri: "mongodb://user:secret@example.invalid/database",
    parallelDbName: "test",
    strictStartupValidation: false,
    }),
    serviceName: "test-service",
  };
  assert.equal(validateSharedConfig(config), config);
  assert.equal(JSON.stringify(config.mongoPool).includes("mongodb"), false);
  assert.equal(JSON.stringify(config.mongoPool).includes("secret"), false);
});
