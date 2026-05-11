"use strict";

/**
 * Registry of cheap "did the underlying issue self-heal?" checks.
 *
 * Paired with `hourlyJobHandlerRegistry` but deliberately separate —
 * resolution checks are reads (Logics getCaseInfo, PaymentLedger lookup,
 * DB probe) while handlers are writes (retry the action). Running the
 * read first avoids duplicate writes when the failure was transient
 * and the real system recovered without us.
 *
 * Shape: resolver function receives the HourlyJobEvent doc (lean) and
 * returns:
 *   { resolved: true,  note: "short audit string" }   // mark completed, skip handler
 *   { resolved: false, note: "why not" }              // run the handler normally
 *
 * Throwing is treated as "not resolved" — resolution checks must not
 * escalate. They're an optimization, never a blocker.
 *
 * Naming convention for resolutionCheckKey:
 *   "<domain>-<concept>-<state>"
 * e.g., "logics-case-visible", "logics-payment-landed",
 *       "callrail-call-indexed", "cxAgent-session-completed".
 */

const registry = new Map();

function register(key, fn) {
  if (!key || typeof key !== "string") {
    throw new TypeError(
      "resolutionCheckRegistry.register: key must be a non-empty string",
    );
  }
  if (typeof fn !== "function") {
    throw new TypeError(
      `resolutionCheckRegistry.register("${key}"): fn must be a function`,
    );
  }
  registry.set(key, fn);
}

function unregister(key) {
  return registry.delete(key);
}

function isRegistered(key) {
  return registry.has(key);
}

function listRegisteredKeys() {
  return Array.from(registry.keys()).sort();
}

/**
 * Run the resolution check for `job.resolutionCheckKey`.
 *
 * Returns `null` when the job has no key (nothing to check — caller
 * should fall through to the handler). Returns the resolver's result
 * otherwise, normalized to `{ resolved, note }`.
 *
 * Any resolver error is swallowed and reported as `{ resolved: false,
 * note: "check-errored:<msg>" }` so a broken resolver never blocks a
 * retry.
 */
async function runCheck(job) {
  const key = job?.resolutionCheckKey;
  if (!key) return null;

  const resolver = registry.get(key);
  if (!resolver) {
    return {
      resolved: false,
      note: `check-unregistered:${key}`,
    };
  }

  try {
    const raw = await resolver(job);
    if (!raw || typeof raw !== "object") {
      return { resolved: false, note: `check-invalid-return:${key}` };
    }
    return {
      resolved: Boolean(raw.resolved),
      note: raw.note ? String(raw.note).slice(0, 200) : null,
    };
  } catch (error) {
    return {
      resolved: false,
      note: `check-errored:${String(error?.message || error).slice(0, 160)}`,
    };
  }
}

module.exports = {
  isRegistered,
  listRegisteredKeys,
  register,
  runCheck,
  unregister,
};
