"use strict";

const EVENT_STATUS = Object.freeze({
  PENDING: "pending",
  PROCESSING: "processing",
  COMPLETED: "completed",
  FAILED: "failed",
  DEAD_LETTER: "dead-letter",
  REPLAYED: "replayed",
});

module.exports = {
  EVENT_STATUS,
};
