"use strict";

const { connectMongo, disconnectMongo, getMongoState } = require("../../event-core/src");
const { validateSharedConfig } = require("../../shared-config/src");
const { createLogger } = require("../../shared-observability/src");

async function initializeServiceRuntime(config) {
  validateSharedConfig(config);
  await connectMongo(config);

  const logger = createLogger(config.serviceName);
  const cleanupTasks = new Map();
  let shuttingDown = false;

  function registerCleanup(name, handler) {
    cleanupTasks.set(String(name), handler);
    return () => cleanupTasks.delete(String(name));
  }

  async function shutdown(reason = "manual") {
    if (shuttingDown) {
      return { ok: true, skipped: true, reason };
    }

    shuttingDown = true;
    const errors = [];

    for (const [name, handler] of cleanupTasks.entries()) {
      try {
        await handler();
      } catch (error) {
        errors.push({ name, error: error.message });
      }
    }

    try {
      await disconnectMongo();
    } catch (error) {
      errors.push({ name: "mongo", error: error.message });
    }

    if (errors.length > 0) {
      logger.error("runtime.shutdown.errors", {
        reason,
        errors,
      });
    } else {
      logger.info("runtime.shutdown.completed", { reason });
    }

    return {
      ok: errors.length === 0,
      reason,
      errors,
    };
  }

  function installSignalHandlers() {
    const signals = ["SIGINT", "SIGTERM"];
    for (const signal of signals) {
      process.once(signal, async () => {
        try {
          await shutdown(signal);
        } finally {
          process.exit(0);
        }
      });
    }
  }

  return {
    config,
    logger,
    getMongoState,
    installSignalHandlers,
    registerCleanup,
    shutdown,
  };
}

module.exports = {
  initializeServiceRuntime,
};
