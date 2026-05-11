"use strict";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function boolFromEnv(name) {
  return TRUE_VALUES.has(String(process.env[name] || "").trim().toLowerCase());
}

function currentConnectionDbName(mongoose) {
  return String(
    mongoose?.connection?.name ||
      process.env.PARALLEL_DB_NAME ||
      "tagcontactbridge_parallel",
  ).trim();
}

function resolveLegacyReadDbName(mongoose) {
  if (
    boolFromEnv("PARALLEL_READ_CLONED_LEGACY_DATA") ||
    boolFromEnv("PARALLEL_READ_DATA_FROM_CURRENT_DB")
  ) {
    return currentConnectionDbName(mongoose);
  }

  return String(
    process.env.LEGACY_READ_DB_NAME ||
      process.env.LEGACY_APP_DB_NAME ||
      "test",
  ).trim();
}

function legacyReadDb(mongoose) {
  const dbName = resolveLegacyReadDbName(mongoose);
  if (dbName === currentConnectionDbName(mongoose)) {
    return mongoose.connection;
  }
  return mongoose.connection.useDb(dbName, { useCache: true });
}

module.exports = {
  legacyReadDb,
  resolveLegacyReadDbName,
};
