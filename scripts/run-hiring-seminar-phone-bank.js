"use strict";

require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");

const {
  createRingCentralClient,
} = require("../packages/shared-integrations/src");

const TARGET_NAMES = Object.freeze([
  "James Monitor",
  "Brad Monitor",
  "Voicemail One",
  "Anthony Monitor",
]);
const TARGET_EXTENSION_NUMBERS = Object.freeze({
  "James Monitor": "1105",
  "Brad Monitor": "1106",
  "Voicemail One": "987",
  "Anthony Monitor": "1103",
});
const DEFAULT_TIMEZONE = "America/Los_Angeles";
const MAX_CYCLES = 100;
const MINUTE_MS = 60 * 1000;
const LOCK_PATH = path.join(
  __dirname, "..", "runtime", "hiring-seminar-phone-bank.lock",
);

function hasArg(argv, name) {
  return argv.includes(name);
}

function readArg(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  if (index === -1 || index + 1 >= argv.length) return fallback;
  return argv[index + 1];
}

function readIntegerArg(argv, name, fallback) {
  const raw = readArg(argv, name, null);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be a whole number`);
  }
  return value;
}

function normalizeName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return "";
}

function extensionName(extension) {
  const explicit = String(extension?.name || "").trim();
  if (explicit) return explicit;
  return [
    extension?.contact?.firstName,
    extension?.contact?.lastName,
  ].filter(Boolean).join(" ").trim();
}

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(
    String(value || "").trim().toLowerCase(),
  );
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function acquireProcessLock(lockPath = LOCK_PATH) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const createLock = () => {
    const fd = fs.openSync(lockPath, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    } finally {
      fs.closeSync(fd);
    }
  };

  try {
    createLock();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    let owner = null;
    try {
      owner = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    } catch {
      owner = null;
    }
    if (isProcessAlive(Number(owner?.pid))) {
      throw new Error("Another live hiring-seminar phone-bank process already owns the lock");
    }
    fs.unlinkSync(lockPath);
    createLock();
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const owner = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      if (Number(owner?.pid) === process.pid) fs.unlinkSync(lockPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  };
}
function parseDate(value) {
  const match = String(value || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error("--date must use YYYY-MM-DD");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year
    || probe.getUTCMonth() + 1 !== month
    || probe.getUTCDate() !== day
  ) {
    throw new Error("--date is not a valid calendar date");
  }
  return { year, month, day, text: match[0] };
}

function parseTime(value, flagName = "time") {
  const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error(`${flagName} must use HH:MM`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`${flagName} is not a valid time`);
  }
  return {
    hour,
    minute,
    text: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}

function getZonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) === 24 ? 0 : Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function zonedTimestamp(date, timeZone) {
  const parts = getZonedParts(date, timeZone);
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
}

function wallClockToDate(dateText, timeText, timeZone) {
  const date = parseDate(dateText);
  const time = parseTime(timeText);
  const target = Date.UTC(
    date.year,
    date.month - 1,
    date.day,
    time.hour,
    time.minute,
    0,
  );
  let guess = new Date(target);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const observed = zonedTimestamp(guess, timeZone);
    guess = new Date(guess.getTime() + (target - observed));
  }
  const observed = getZonedParts(guess, timeZone);
  if (
    observed.year !== date.year
    || observed.month !== date.month
    || observed.day !== date.day
    || observed.hour !== time.hour
    || observed.minute !== time.minute
  ) {
    throw new Error(`The requested wall-clock time does not exist in ${timeZone}`);
  }
  return guess;
}

function validateTimezone(timeZone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch {
    throw new Error(`Unknown timezone: ${timeZone}`);
  }
}

function assertNonOverlapping(slots, cycleDurationMs) {
  for (let index = 1; index < slots.length; index += 1) {
    if (slots[index].getTime() - slots[index - 1].getTime() < cycleDurationMs) {
      throw new Error("Scheduled ring cycles overlap; increase the time between cycles");
    }
  }
}

function buildScheduleSlots(options, now = new Date()) {
  if (options.once) return [new Date(now)];

  const cycleDurationMs = (
    options.ringSeconds * 1000
    + options.staggerMs * (TARGET_NAMES.length - 1)
  );
  let slots;

  if (options.times.length > 0) {
    slots = [...new Set(options.times.map((time) => parseTime(time, "--times").text))]
      .map((time) => wallClockToDate(options.date, time, options.timeZone))
      .sort((left, right) => left.getTime() - right.getTime());
  } else {
    const startAt = wallClockToDate(options.date, options.startTime, options.timeZone);
    const endAt = wallClockToDate(options.date, options.endTime, options.timeZone);
    if (endAt.getTime() <= startAt.getTime()) {
      throw new Error("--end must be later than --start on the same date");
    }
    slots = [];
    for (
      let cursor = startAt.getTime();
      cursor < endAt.getTime();
      cursor += options.intervalMinutes * MINUTE_MS
    ) {
      slots.push(new Date(cursor));
      if (slots.length > MAX_CYCLES) {
        throw new Error(`Schedule exceeds the ${MAX_CYCLES}-cycle safety limit`);
      }
    }
  }

  if (slots.length === 0) throw new Error("The schedule contains no ring cycles");
  if (slots.length > MAX_CYCLES) {
    throw new Error(`Schedule exceeds the ${MAX_CYCLES}-cycle safety limit`);
  }
  assertNonOverlapping(slots, cycleDurationMs);
  return slots;
}

function parseOptions(argv = process.argv.slice(2), env = process.env) {
  const apply = hasArg(argv, "--apply");
  if (apply && hasArg(argv, "--dry-run")) {
    throw new Error("Use either --apply or --dry-run, not both");
  }

  const once = hasArg(argv, "--once");
  const date = String(readArg(argv, "--date", "") || "").trim();
  const startTime = String(readArg(argv, "--start", "") || "").trim();
  const endTime = String(readArg(argv, "--end", "") || "").trim();
  const rawTimes = String(readArg(argv, "--times", "") || "").trim();
  const times = rawTimes
    ? rawTimes.split(",").map((value) => value.trim()).filter(Boolean)
    : [];
  const timeZone = String(
    readArg(argv, "--timezone", env.DEMO_RINGOUT_TIMEZONE || DEFAULT_TIMEZONE),
  ).trim();
  const intervalMinutes = readIntegerArg(argv, "--interval-minutes", 10);
  const ringSeconds = readIntegerArg(argv, "--ring-seconds", 20);
  const staggerMs = readIntegerArg(argv, "--stagger-ms", 750);
  const lateToleranceSeconds = readIntegerArg(argv, "--late-tolerance-seconds", 60);
  if (hasArg(argv, "--to")) {
    throw new Error("--to is disabled; use the configured desk target");
  }
  const toPhone = normalizePhone(env.DEMO_RINGOUT_TO_PHONE || "");

  if (!toPhone) {
    throw new Error("DEMO_RINGOUT_TO_PHONE must contain a valid US desk number");
  }
  validateTimezone(timeZone);
  if (ringSeconds < 1 || ringSeconds > 300) {
    throw new Error("--ring-seconds must be between 1 and 300");
  }
  if (staggerMs < 0 || staggerMs > 5000) {
    throw new Error("--stagger-ms must be between 0 and 5000");
  }
  if (intervalMinutes < 1 || intervalMinutes > 720) {
    throw new Error("--interval-minutes must be between 1 and 720");
  }
  if (lateToleranceSeconds < 0 || lateToleranceSeconds > 600) {
    throw new Error("--late-tolerance-seconds must be between 0 and 600");
  }

  const hasWindow = Boolean(date || startTime || endTime || times.length);
  if (once && hasWindow) {
    throw new Error("--once cannot be combined with --date, --start, --end, or --times");
  }
  if (!once) {
    if (!date) throw new Error("--date is required for a scheduled run");
    parseDate(date);
    if (times.length > 0 && (startTime || endTime)) {
      throw new Error("Use --times or --start/--end, not both");
    }
    if (times.length === 0 && (!startTime || !endTime)) {
      throw new Error("A scheduled run needs --times or both --start and --end");
    }
  }

  return {
    apply,
    dryRun: !apply,
    once,
    date,
    startTime,
    endTime,
    times,
    timeZone,
    intervalMinutes,
    ringSeconds,
    staggerMs,
    lateToleranceSeconds,
    toPhone,
  };
}

function selectPrimaryDirectNumber(payload, label) {
  const records = Array.isArray(payload?.records) ? payload.records : [];
  const candidates = records.filter((record) => {
    const usageType = normalizeName(record?.usageType || record?.type);
    return usageType === "directnumber"
      && record?.primary === true
      && Boolean(normalizePhone(record?.phoneNumber));
  });
  if (candidates.length !== 1) {
    throw new Error(
      `${label} must have exactly one primary DirectNumber; found ${candidates.length}`,
    );
  }
  return normalizePhone(candidates[0].phoneNumber);
}

async function resolveTargets(client, targetNames = TARGET_NAMES) {
  const directory = await client.listExtensions({
    allPages: true,
    status: "Enabled",
    type: "User",
  });
  const extensions = Array.isArray(directory?.records) ? directory.records : [];
  const targets = [];

  for (const label of targetNames) {
    const wanted = normalizeName(label);
    const matches = extensions.filter(
      (extension) => normalizeName(extensionName(extension)) === wanted,
    );
    if (matches.length !== 1) {
      throw new Error(
        `${label} must resolve to exactly one enabled User extension; found ${matches.length}`,
      );
    }
    const extension = matches[0];
    if (!extension?.id) throw new Error(`${label} has no extension identity`);
    const expectedExtensionNumber = TARGET_EXTENSION_NUMBERS[label];
    const stableIdentityMatches = Boolean(
      expectedExtensionNumber
      && String(extension.extensionNumber || "") === expectedExtensionNumber
      && normalizeName(extension.status) === "enabled"
      && normalizeName(extension.type) === "user"
    );
    if (!stableIdentityMatches) {
      throw new Error(`${label} does not match its pinned enabled User extension`);
    }
    const phonePayload = await client.listExtensionPhoneNumbers(extension.id);
    targets.push({
      label,
      extensionId: String(extension.id),
      fromPhone: selectPrimaryDirectNumber(phonePayload, label),
    });
  }

  const extensionIds = new Set(targets.map((target) => target.extensionId));
  const sourcePhones = new Set(targets.map((target) => target.fromPhone));
  if (extensionIds.size !== targetNames.length || sourcePhones.size !== targetNames.length) {
    throw new Error("The four monitor targets do not have unique extension/source identities");
  }
  return targets;
}


async function verifyDeskTarget(client, toPhone, targets) {
  if (targets.some((target) => target.fromPhone === toPhone)) {
    throw new Error("The configured desk target cannot also be a monitor source");
  }
  const payload = await client.listAccountPhoneNumbers({ allPages: true });
  const records = Array.isArray(payload?.records) ? payload.records : [];
  const isTenantOwned = records.some(
    (record) => normalizePhone(record?.phoneNumber) === toPhone,
  );
  if (!isTenantOwned) {
    throw new Error("The configured desk target is not a tenant-owned RingCentral number");
  }
  return true;
}
function ringOutId(payload) {
  return payload?.id || payload?.uri?.split("/").pop() || null;
}

function errorStatus(error) {
  return Number(
    error?.details?.responseStatus
    || error?.status
    || error?.statusCode
    || 0,
  );
}

function safeError(error) {
  const rawCode = String(
    error?.code
    || error?.details?.errorCode
    || error?.details?.body?.errorCode
    || "operation_failed",
  );
  return {
    status: errorStatus(error) || null,
    code: rawCode.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80),
  };
}

function emit(write, event, detail = {}) {
  write(`${JSON.stringify({ event, ...detail })}\n`);
}

function createAbortError() {
  const error = new Error("Operation cancelled");
  error.name = "AbortError";
  return error;
}

async function cancelCalls(client, activeCalls, write = () => {}) {
  const rows = activeCalls.splice(0, activeCalls.length);
  const results = await Promise.all(rows.map(async (call) => {
    try {
      await client.deleteRingOut(call.extensionId, call.ringOutId);
      return { call, label: call.label, ok: true, alreadyGone: false };
    } catch (error) {
      const status = errorStatus(error);
      return {
        call,
        label: call.label,
        ok: status === 404,
        alreadyGone: status === 404,
        error: status === 404 ? null : safeError(error),
      };
    }
  }));
  activeCalls.push(
    ...results.filter((result) => !result.ok).map((result) => result.call),
  );
  if (results.length > 0) {
    emit(write, "cycle_cleanup", {
      targets: results.map((result) => ({
        label: result.label,
        ok: result.ok,
        alreadyGone: result.alreadyGone,
        error: result.error || null,
      })),
    });
  }
  return results.map(({ call, ...result }) => result);
}

async function runCycle({
  client,
  targets,
  toPhone,
  ringSeconds,
  staggerMs,
  activeCalls,
  sleepFn,
  write,
  shouldStop = () => false,
  authorized = false,
}) {
  if (authorized !== true || isTruthy(process.env.PARALLEL_RC_SUSPENDED)) {
    throw new Error("RingOut mutation is not authorized");
  }
  const accepted = [];
  let cycleError = null;
  emit(write, "cycle_start", { targetCount: targets.length });
  try {
    for (let index = 0; index < targets.length; index += 1) {
      if (shouldStop()) throw createAbortError();
      const target = targets[index];
      let response;
      try {
        response = await client.createRingOut(target.extensionId, {
          fromPhoneNumber: target.fromPhone,
          toPhoneNumber: toPhone,
          playPrompt: false,
          countryId: "1",
        });
      } catch (error) {
        cycleError = error;
        emit(write, "target_failed", {
          label: target.label,
          error: safeError(error),
        });
        throw error;
      }
      const id = ringOutId(response);
      if (!id) {
        cycleError = new Error("RingOut acceptance omitted its identity");
        emit(write, "target_failed", {
          label: target.label,
          error: { status: null, code: "missing_ringout_identity" },
        });
        throw cycleError;
      }
      activeCalls.push({
        label: target.label,
        extensionId: target.extensionId,
        ringOutId: id,
      });
      accepted.push(target.label);
      emit(write, "target_accepted", { label: target.label });
      if (index < targets.length - 1 && staggerMs > 0) {
        await sleepFn(staggerMs);
      }
    }

    if (shouldStop()) throw createAbortError();
    await sleepFn(ringSeconds * 1000);
  } catch (error) {
    cycleError = cycleError || error;
    throw error;
  } finally {
    const cleanup = await cancelCalls(client, activeCalls, write);
    const failedCleanup = cleanup.filter((row) => !row.ok);
    emit(write, "cycle_complete", {
      acceptedCount: accepted.length,
      cleanupFailedCount: failedCleanup.length,
      ok: !cycleError && failedCleanup.length === 0,
    });
    if (!cycleError && failedCleanup.length > 0) {
      const error = new Error("One or more RingOut calls could not be cancelled");
      error.code = "ringout_cleanup_failed";
      throw error;
    }
  }
  return { acceptedCount: accepted.length };
}


async function waitUntil(slot, { nowFn, sleepFn, shouldStop }) {
  while (true) {
    if (shouldStop()) throw createAbortError();
    const remainingMs = slot.getTime() - nowFn().getTime();
    if (remainingMs <= 0) return;
    await sleepFn(Math.min(remainingMs, MINUTE_MS));
  }
}

async function execute({
  client,
  options,
  nowFn = () => new Date(),
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  write = (value) => process.stdout.write(value),
  shouldStop = () => false,
  activeCalls = [],
}) {
  if (!options.dryRun && options.apply !== true) {
    throw new Error("A live RingOut run requires apply authorization");
  }
  if (!options.dryRun && isTruthy(process.env.PARALLEL_RC_SUSPENDED)) {
    throw new Error("RingCentral mutations are suspended");
  }
  const slots = buildScheduleSlots(options, nowFn());
  const targets = await resolveTargets(client);
  await verifyDeskTarget(client, options.toPhone, targets);
  emit(write, "plan", {
    dryRun: options.dryRun,
    mode: options.once ? "once" : options.times.length > 0 ? "times" : "window",
    timeZone: options.timeZone,
    date: options.once ? null : options.date,
    scheduledCycles: slots.length,
    ringSeconds: options.ringSeconds,
    staggerMs: options.staggerMs,
    deskTargetConfigured: true,
    targets: targets.map((target) => target.label),
  });
  if (options.dryRun) {
    emit(write, "complete", {
      dryRun: true,
      completedCycles: 0,
      skippedCycles: 0,
    });
    return { dryRun: true, completedCycles: 0, skippedCycles: 0 };
  }

  let completedCycles = 0;
  let skippedCycles = 0;
  const launchedAt = nowFn();
  let initialCatchupIndex = -1;
  for (let index = 0; index < slots.length; index += 1) {
    const latenessMs = launchedAt.getTime() - slots[index].getTime();
    if (latenessMs >= 0 && latenessMs <= options.lateToleranceSeconds * 1000) {
      initialCatchupIndex = index;
    }
  }
  let lastCycleFinishedAt = null;

  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index];
    if (shouldStop()) throw createAbortError();
    if (
      slot.getTime() <= launchedAt.getTime()
      && index !== initialCatchupIndex
    ) {
      skippedCycles += 1;
      emit(write, "cycle_skipped", {
        scheduledFor: slot.toISOString(),
        reason: "past_before_start",
      });
      continue;
    }
    if (
      lastCycleFinishedAt
      && slot.getTime() < lastCycleFinishedAt.getTime()
    ) {
      skippedCycles += 1;
      emit(write, "cycle_skipped", {
        scheduledFor: slot.toISOString(),
        reason: "missed_during_prior_cycle",
      });
      continue;
    }
    if (slot.getTime() > nowFn().getTime()) {
      emit(write, "waiting", { scheduledFor: slot.toISOString() });
      await waitUntil(slot, { nowFn, sleepFn, shouldStop });
    }
    const latenessMs = nowFn().getTime() - slot.getTime();
    if (latenessMs > options.lateToleranceSeconds * 1000) {
      skippedCycles += 1;
      emit(write, "cycle_skipped", {
        scheduledFor: slot.toISOString(),
        reason: "late",
      });
      continue;
    }
    emit(write, "cycle_due", { scheduledFor: slot.toISOString() });
    await runCycle({
      client,
      targets,
      toPhone: options.toPhone,
      ringSeconds: options.ringSeconds,
      staggerMs: options.staggerMs,
      activeCalls,
      sleepFn,
      write,
      shouldStop,
      authorized: true,
    });
    completedCycles += 1;
    lastCycleFinishedAt = nowFn();
  }
  emit(write, "complete", {
    dryRun: false,
    completedCycles,
    skippedCycles,
  });
  return { dryRun: false, completedCycles, skippedCycles };
}

function printHelp(write = (value) => process.stdout.write(value)) {
  write([
    "Hiring seminar phone-bank RingOut scheduler",
    "",
    "Dry-run a window:",
    "  node scripts/run-hiring-seminar-phone-bank.js --date YYYY-MM-DD --start HH:MM --end HH:MM --interval-minutes 10",
    "",
    "Dry-run exact times:",
    "  node scripts/run-hiring-seminar-phone-bank.js --date YYYY-MM-DD --times HH:MM,HH:MM,HH:MM",
    "",
    "Make calls only after the dry-run is correct:",
    "  add --apply",
    "",
    "One controlled immediate cycle:",
    "  node scripts/run-hiring-seminar-phone-bank.js --once --ring-seconds 20 --apply",
    "",
    "The desk target comes only from DEMO_RINGOUT_TO_PHONE.",
  ].join("\n") + "\n");
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasArg(argv, "--help") || hasArg(argv, "-h")) {
    printHelp();
    return;
  }

  const options = parseOptions(argv);
  if (options.apply && isTruthy(process.env.PARALLEL_RC_SUSPENDED)) {
    throw new Error("RingCentral mutations are suspended by PARALLEL_RC_SUSPENDED");
  }

  const client = createRingCentralClient();
  const releaseLock = options.apply
    ? acquireProcessLock()
    : () => {};
  const activeCalls = [];
  let stopping = false;
  let abortWait = null;
  const sleepFn = (ms) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      abortWait = null;
      resolve();
    }, ms);
    abortWait = () => {
      clearTimeout(timer);
      abortWait = null;
      reject(createAbortError());
    };
  });
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    emit((value) => process.stdout.write(value), "stopping", { signal });
    if (abortWait) abortWait();
    await cancelCalls(
      client,
      activeCalls,
      (value) => process.stdout.write(value),
    );
  };
  const onSignal = (signal) => {
    if (stopping) {
      process.stderr.write(`${JSON.stringify({ event: "forced_stop", signal })}\n`);
      process.exit(130);
    }
    void stop(signal);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    await execute({
      client,
      options,
      sleepFn,
      shouldStop: () => stopping,
      activeCalls,
    });
  } catch (error) {
    if (error?.name === "AbortError" && stopping) {
      process.exitCode = 130;
      return;
    }
    throw error;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    if (activeCalls.length > 0) {
      await cancelCalls(
        client,
        activeCalls,
        (value) => process.stdout.write(value),
      );
    }
    releaseLock();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      event: "failed",
      error: safeError(error),
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  TARGET_NAMES,
  buildScheduleSlots,
  cancelCalls,
  execute,
  normalizeName,
  normalizePhone,
  parseOptions,
  resolveTargets,
  runCycle,
  safeError,
  selectPrimaryDirectNumber,
  wallClockToDate,
};
