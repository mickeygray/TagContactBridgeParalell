"use strict";

function buildHealthPayload({ service, port, mongo = null, extra = {} }) {
  const mongoOk =
    mongo === null ? true : mongo.connected === true || mongo.skipped === true;

  return {
    ok: mongoOk,
    service,
    port,
    mongo,
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

module.exports = {
  buildHealthPayload,
};
