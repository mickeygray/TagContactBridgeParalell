"use strict";

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function timeValue(value) {
  if (!value) return null;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function buildVersionGuardOptions(session = {}) {
  const version = finiteNumber(session.__v);
  if (version !== null) {
    return { expectedVersion: version, versionGuard: true };
  }
  if (session.updatedAt) {
    return { expectedUpdatedAt: session.updatedAt, versionGuard: true };
  }
  return {};
}

function describeBulkLoadMutationEligibility(input = {}) {
  const session = input.session || {};
  const latest = input.latest || null;
  if (input.busy) {
    return { ok: false, reason: "session-busy", writeOptions: buildVersionGuardOptions(session) };
  }

  if (latest) {
    const expectedVersion = finiteNumber(session.__v);
    const latestVersion = finiteNumber(latest.__v);
    if (expectedVersion !== null && latestVersion !== null && expectedVersion !== latestVersion) {
      return {
        ok: false,
        reason: "stale-projection",
        expectedVersion,
        latestVersion,
        writeOptions: buildVersionGuardOptions(session),
      };
    }

    if (expectedVersion === null && session.updatedAt && latest.updatedAt) {
      const expectedUpdatedAt = timeValue(session.updatedAt);
      const latestUpdatedAt = timeValue(latest.updatedAt);
      if (expectedUpdatedAt !== null && latestUpdatedAt !== null && expectedUpdatedAt !== latestUpdatedAt) {
        return {
          ok: false,
          reason: "stale-projection",
          expectedUpdatedAt: session.updatedAt,
          latestUpdatedAt: latest.updatedAt,
          writeOptions: buildVersionGuardOptions(session),
        };
      }
    }
  }

  return { ok: true, reason: null, writeOptions: buildVersionGuardOptions(session) };
}

module.exports = {
  buildVersionGuardOptions,
  describeBulkLoadMutationEligibility,
};
