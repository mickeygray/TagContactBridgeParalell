"use strict";

const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const mongo = require("../../packages/event-core/src/services/mongo");

const originalConnect = mongoose.connect;
const originalDisconnect = mongoose.disconnect;
const originalReadyState = Object.getOwnPropertyDescriptor(mongoose.connection, "readyState");

afterEach(async () => {
  mongoose.connect = originalConnect;
  mongoose.disconnect = originalDisconnect;
  if (originalReadyState) {
    Object.defineProperty(mongoose.connection, "readyState", originalReadyState);
  }
  await mongo.disconnectMongo().catch(() => {});
});

test("connection options preserve selection timeout and bounded pool values", () => {
  assert.deepEqual(mongo.resolveMongoConnectionOptions({
    parallelDbName: "parallel_test",
    mongoPool: {
      maxPoolSize: 25,
      minPoolSize: 1,
      maxIdleTimeMS: 400000,
      maxConnecting: 3,
      waitQueueTimeoutMS: 12000,
    },
  }), {
    dbName: "parallel_test",
    serverSelectionTimeoutMS: 5000,
    maxPoolSize: 25,
    minPoolSize: 1,
    maxIdleTimeMS: 400000,
    maxConnecting: 3,
    waitQueueTimeoutMS: 12000,
  });
});

test("concurrent callers share one connect promise and health exposes only safe policy", async () => {
  let resolveConnect;
  let connectCalls = 0;
  mongoose.connect = async (_uri, options) => {
    connectCalls += 1;
    await new Promise((resolve) => { resolveConnect = resolve; });
    return { options };
  };
  mongoose.disconnect = async () => {};
  Object.defineProperty(mongoose.connection, "readyState", { configurable: true, get: () => 1 });

  const config = {
    mongoUri: "mongodb://user:secret@example.invalid/database",
    parallelDbName: "parallel_test",
    mongoPool: {
      maxPoolSize: 20,
      minPoolSize: 0,
      maxIdleTimeMS: 300000,
      maxConnecting: 2,
      waitQueueTimeoutMS: 10000,
    },
  };
  const first = mongo.connectMongo(config);
  const second = mongo.connectMongo(config);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connectCalls, 1);
  resolveConnect();
  await Promise.all([first, second]);

  const state = mongo.getMongoState();
  assert.deepEqual(state.pool, config.mongoPool);
  assert.equal(JSON.stringify(state).includes("secret"), false);
  assert.equal(JSON.stringify(state).includes("mongodb://"), false);
});

test("disconnect resets the singleton and skipMongo does not connect", async () => {
  let connectCalls = 0;
  mongoose.connect = async () => { connectCalls += 1; };
  mongoose.disconnect = async () => {};
  let readyState = 0;
  Object.defineProperty(mongoose.connection, "readyState", { configurable: true, get: () => readyState });
  await mongo.disconnectMongo();
  readyState = 1;

  const base = {
    mongoUri: "mongodb://example.invalid/database",
    parallelDbName: "parallel_test",
  };
  await mongo.connectMongo({ ...base, skipMongo: true });
  assert.equal(connectCalls, 0);

  await mongo.connectMongo(base);
  assert.equal(connectCalls, 1);
  readyState = 0;
  await mongo.disconnectMongo();
  readyState = 1;
  await mongo.connectMongo(base);
  assert.equal(connectCalls, 2);
});
