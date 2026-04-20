"use strict";

const {
  getSharedConfig,
  SERVICE_NAMES,
} = require("../../../packages/shared-config/src");
const {
  connectMongo,
  processNextEvent,
} = require("../../../packages/event-core/src");

function buildHandlers() {
  return {
    "inbound.demo.received": async (event) => {
      if (event.payload?.forceError) {
        throw new Error("Forced inbound failure");
      }
      console.log(`[event-worker] normalized inbound lead ${event.aggregateId}`);
    },
    "outbound.demo.requested": async (event) => {
      if (event.payload?.forceError) {
        throw new Error("Forced outbound failure");
      }
      console.log(`[event-worker] delivered outbound message ${event.aggregateId}`);
    },
    "ring.demo.received": async (event) => {
      if (event.payload?.forceError) {
        throw new Error("Forced ring failure");
      }
      console.log(`[event-worker] applied ring event ${event.aggregateId}`);
    },
  };
}

async function startWorker() {
  const config = {
    ...getSharedConfig(),
    serviceName: SERVICE_NAMES.eventWorker,
  };

  await connectMongo(config);

  console.log("[event-worker] connected");
  const handlers = buildHandlers();

  setInterval(async () => {
    try {
      const result = await processNextEvent({
        workerName: config.serviceName,
        handlers,
      });

      if (result.claimed) {
        console.log("[event-worker] processed", result);
      }
    } catch (error) {
      console.error("[event-worker] loop error", error);
    }
  }, 2000);
}

if (require.main === module) {
  startWorker().catch((error) => {
    console.error("[event-worker] failed to start", error);
    process.exit(1);
  });
}

module.exports = {
  startWorker,
};
