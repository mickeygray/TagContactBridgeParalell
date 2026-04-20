"use strict";

function formatEntry(level, scope, message, meta) {
  return {
    timestamp: new Date().toISOString(),
    level,
    scope,
    message,
    meta: meta || null,
  };
}

function write(level, scope, message, meta) {
  const entry = formatEntry(level, scope, message, meta);
  const serialized = JSON.stringify(entry);

  if (level === "error") {
    console.error(serialized);
    return;
  }

  console.log(serialized);
}

function createLogger(scope) {
  return {
    info(message, meta) {
      write("info", scope, message, meta);
    },
    warn(message, meta) {
      write("warn", scope, message, meta);
    },
    error(message, meta) {
      write("error", scope, message, meta);
    },
  };
}

module.exports = {
  createLogger,
};
