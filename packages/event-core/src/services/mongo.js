"use strict";

const mongoose = require("mongoose");

let connectionPromise = null;
let skippedMongo = false;

async function connectMongo(config) {
  if (config.skipMongo) {
    skippedMongo = true;
    return { connected: false, skipped: true };
  }

  skippedMongo = false;
  if (!connectionPromise) {
    connectionPromise = mongoose.connect(config.mongoUri, {
      dbName: config.parallelDbName,
      serverSelectionTimeoutMS: 5000,
    });
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
    host: mongoose.connection.host || null,
    name: mongoose.connection.name || null,
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
};
