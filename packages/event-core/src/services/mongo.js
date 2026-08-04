"use strict";

const mongoose = require("mongoose");
const { resolveMongoPoolConfig } = require("../../../shared-config/src");

let connectionPromise = null;
let skippedMongo = false;
let activePoolPolicy = null;

function resolveMongoConnectionOptions(config = {}) {
  const mongoPool = resolveMongoPoolConfig({ mongoPool: config.mongoPool || {} }, {});
  return {
    dbName: config.parallelDbName,
    serverSelectionTimeoutMS: 5000,
    ...mongoPool,
  };
}

async function connectMongo(config) {
  const connectionOptions = resolveMongoConnectionOptions(config);
  activePoolPolicy = {
    maxPoolSize: connectionOptions.maxPoolSize,
    minPoolSize: connectionOptions.minPoolSize,
    maxIdleTimeMS: connectionOptions.maxIdleTimeMS,
    maxConnecting: connectionOptions.maxConnecting,
    waitQueueTimeoutMS: connectionOptions.waitQueueTimeoutMS,
  };
  if (config.skipMongo) {
    skippedMongo = true;
    return { connected: false, skipped: true };
  }

  skippedMongo = false;
  if (!connectionPromise) {
    connectionPromise = mongoose.connect(config.mongoUri, connectionOptions);
  }

  await connectionPromise;
  return {
    connected: mongoose.connection.readyState === 1,
    host: mongoose.connection.host,
    name: mongoose.connection.name,
  };
}

function getMongoState() {
  return {
    connected: mongoose.connection.readyState === 1,
    skipped: skippedMongo,
    readyState: mongoose.connection.readyState,
    pool: activePoolPolicy ? { ...activePoolPolicy } : null,
  };
}

async function disconnectMongo() {
  if (skippedMongo) {
    connectionPromise = null;
    return { disconnected: true, skipped: true };
  }

  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  connectionPromise = null;

  return {
    disconnected: mongoose.connection.readyState === 0,
    skipped: false,
  };
}

module.exports = {
  connectMongo,
  disconnectMongo,
  getMongoState,
  resolveMongoConnectionOptions,
};
