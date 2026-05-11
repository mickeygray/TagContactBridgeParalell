"use strict";

const {
  createRingCentralClient,
} = require("../../../../packages/shared-integrations/src");
const {
  recordWorkflowStage,
} = require("../../../../packages/shared-services/src");

const MINUTE_MS = 60 * 1000;

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return String(value || "").trim();
}

function maskPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length < 4) return "";
  return `***${digits.slice(-4)}`;
}

function parseTime(value, fallbackHour, fallbackMinute = 0) {
  const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return { hour: fallbackHour, minute: fallbackMinute };
  const hour = Math.max(0, Math.min(23, Number(match[1])));
  const minute = Math.max(0, Math.min(59, Number(match[2])));
  return { hour, minute };
}

function getZonedParts(date, timezone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const hour = Number(parts.hour) === 24 ? 0 : Number(parts.hour);
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function zonedTimestamp(date, timezone) {
  const parts = getZonedParts(date, timezone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0);
}

function ymdToParts(ymd) {
  const match = String(ymd || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

function wallClockToDate(ymd, hour, minute, timezone) {
  const parts = ymdToParts(ymd);
  if (!parts) return null;
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, hour, minute, 0);
  let guess = new Date(target);
  for (let i = 0; i < 3; i += 1) {
    const observed = zonedTimestamp(guess, timezone);
    guess = new Date(guess.getTime() + (target - observed));
  }
  return guess;
}

function collectStatusStrings(value, out = []) {
  if (value === null || value === undefined) return out;
  if (typeof value === "string") {
    out.push(value.trim().toLowerCase());
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStatusStrings(item, out);
    return out;
  }
  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      if (/status|result|reason/i.test(key)) collectStatusStrings(nested, out);
    }
  }
  return out;
}

function isConnectedStatus(payload) {
  const statuses = collectStatusStrings(payload);
  return statuses.some((status) =>
    ["success", "answered", "connected", "callconnected", "inprogress"].includes(status.replace(/\s+/g, "")),
  );
}

function isTerminalFailureStatus(payload) {
  const statuses = collectStatusStrings(payload);
  return statuses.some((status) =>
    ["error", "failed", "busy", "noanswer", "rejected", "timeout", "cannotreach", "disconnected"].includes(status.replace(/\s+/g, "")),
  );
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function createState(config = {}) {
  const start = parseTime(config.startTime, 10, 0);
  const end = parseTime(config.endTime, 12, 0);
  return {
    enabled: Boolean(config.enabled),
    dryRun: config.dryRun !== false,
    running: false,
    timezone: config.timezone || "America/Los_Angeles",
    date: String(config.date || "2026-05-09").trim(),
    startTime: `${String(start.hour).padStart(2, "0")}:${String(start.minute).padStart(2, "0")}`,
    endTime: `${String(end.hour).padStart(2, "0")}:${String(end.minute).padStart(2, "0")}`,
    intervalMinutes: Math.max(1, Number(config.intervalMinutes) || 10),
    tickMs: Math.max(5_000, Number(config.tickMs) || 15_000),
    loopCount: Math.max(1, Number(config.loopCount) || 1),
    ringSeconds: Math.max(1, Number(config.ringSeconds) || 120),
    pauseSeconds: Math.max(0, Number(config.pauseSeconds) || 0),
    extensionId: String(config.extensionId || "~").trim() || "~",
    fromPhone: normalizePhone(config.fromPhone),
    toPhone: normalizePhone(config.toPhone),
    callerIdPhone: normalizePhone(config.callerIdPhone),
    label: String(config.label || "Inbound prospect").trim() || "Inbound prospect",
    playPrompt: Boolean(config.playPrompt),
    externalNotifyPhone: normalizePhone(config.externalNotifyPhone),
    externalNotifyMode: String(config.externalNotifyMode || "off").trim().toLowerCase(),
    externalNotifyPollSeconds: Math.max(5, Number(config.externalNotifyPollSeconds) || 60),
    timer: null,
    nextRunAt: null,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastResult: null,
    lastError: null,
    firedCount: 0,
  };
}

function getWindow(state) {
  const [startHour, startMinute] = state.startTime.split(":").map(Number);
  const [endHour, endMinute] = state.endTime.split(":").map(Number);
  const startAt = wallClockToDate(state.date, startHour, startMinute, state.timezone);
  const endAt = wallClockToDate(state.date, endHour, endMinute, state.timezone);
  return { startAt, endAt };
}

function computeNextRunAt(state, now = new Date()) {
  const { startAt, endAt } = getWindow(state);
  if (!startAt || !endAt) return null;
  if (now.getTime() >= endAt.getTime()) return null;
  if (now.getTime() <= startAt.getTime()) return startAt;

  const intervalMs = state.intervalMinutes * MINUTE_MS;
  const elapsed = now.getTime() - startAt.getTime();
  const slot = Math.ceil(elapsed / intervalMs);
  const candidate = new Date(startAt.getTime() + slot * intervalMs);
  return candidate.getTime() < endAt.getTime() ? candidate : null;
}

function summarizeState(state) {
  return {
    enabled: state.enabled,
    dryRun: state.dryRun,
    running: state.running,
    timezone: state.timezone,
    date: state.date,
    startTime: state.startTime,
    endTime: state.endTime,
    intervalMinutes: state.intervalMinutes,
    loopCount: state.loopCount,
    ringSeconds: state.ringSeconds,
    pauseSeconds: state.pauseSeconds,
    extensionId: state.extensionId,
    fromPhone: maskPhone(state.fromPhone),
    toPhone: maskPhone(state.toPhone),
    callerIdPhone: maskPhone(state.callerIdPhone),
    label: state.label,
    playPrompt: state.playPrompt,
    externalNotifyPhone: maskPhone(state.externalNotifyPhone),
    externalNotifyMode: state.externalNotifyMode,
    nextRunAt: state.nextRunAt,
    lastStartedAt: state.lastStartedAt,
    lastCompletedAt: state.lastCompletedAt,
    lastResult: state.lastResult,
    lastError: state.lastError,
    firedCount: state.firedCount,
  };
}

function buildRingoutInput(state, toPhone) {
  return {
    fromPhoneNumber: state.fromPhone,
    toPhoneNumber: toPhone,
    callerIdPhoneNumber: state.callerIdPhone || null,
    playPrompt: state.playPrompt,
    countryId: "1",
  };
}

async function waitForRingoutConnected(client, state, ringOutId, logger) {
  const started = Date.now();
  const timeoutMs = state.externalNotifyPollSeconds * 1000;
  let lastStatus = null;
  while (Date.now() - started < timeoutMs) {
    await sleep(3000);
    try {
      lastStatus = await client.getRingOut(state.extensionId, ringOutId);
      if (isConnectedStatus(lastStatus)) {
        return { connected: true, status: lastStatus };
      }
      if (isTerminalFailureStatus(lastStatus)) {
        return { connected: false, terminal: true, status: lastStatus };
      }
    } catch (error) {
      logger?.warn?.("demo-ringout.status_poll_failed", {
        error: error.message,
        ringOutId,
      });
      return { connected: false, error: error.message, status: lastStatus };
    }
  }
  return { connected: false, timedOut: true, status: lastStatus };
}

async function recordDemoStage({ state, stage, summary, payload, result }) {
  return recordWorkflowStage({
    domain: "TAG",
    family: "demo-ringout",
    subtype: "saturday-ringout",
    stage,
    aggregateType: "ringout-demo",
    aggregateId: `${state.date}-${state.startTime}-${state.endTime}`,
    sourceService: "control-plane",
    title: stage === "failed" ? "Demo RingOut failed" : "Demo RingOut tick",
    summary,
    payload,
    result,
  }).catch(() => null);
}

function getRingOutId(ringout) {
  return ringout?.id || ringout?.uri?.split("/").pop() || null;
}

async function cancelRingOut(client, state, ringout, logger, label) {
  const ringOutId = getRingOutId(ringout);
  if (!ringOutId) {
    return {
      ok: false,
      skipped: true,
      reason: "missing-ringout-id",
      label,
    };
  }
  try {
    const response = await client.deleteRingOut(state.extensionId, ringOutId);
    return {
      ok: true,
      id: ringOutId,
      label,
      response: response || null,
    };
  } catch (error) {
    logger?.warn?.("demo-ringout.cancel_failed", {
      label,
      ringOutId,
      error: error.message,
      details: error.details || null,
    });
    return {
      ok: false,
      id: ringOutId,
      label,
      error: error.message,
      details: error.details || null,
    };
  }
}

function createDemoRingoutRuntime({ config = {}, runtime }) {
  const state = createState(config);

  async function fire(options = {}) {
    if (state.running) {
      return { ok: false, skipped: true, reason: "demo-ringout-already-running" };
    }
    state.running = true;
    state.lastStartedAt = new Date();
    state.lastError = null;

    const scheduledFor = options.scheduledFor || state.nextRunAt || new Date();
    const payload = {
      scheduledFor,
      reason: options.reason || (options.scheduled ? "scheduled" : "manual"),
      label: state.label,
      extensionId: state.extensionId,
      fromPhone: maskPhone(state.fromPhone),
      toPhone: maskPhone(state.toPhone),
      callerIdPhone: maskPhone(state.callerIdPhone),
      playPrompt: state.playPrompt,
      externalNotifyPhone: maskPhone(state.externalNotifyPhone),
      externalNotifyMode: state.externalNotifyMode,
      dryRun: state.dryRun,
    };

    try {
      if (!state.fromPhone || !state.toPhone) {
        throw new Error("DEMO_RINGOUT_FROM_PHONE and DEMO_RINGOUT_TO_PHONE are required");
      }

      const primaryInput = buildRingoutInput(state, state.toPhone);
      const requestedLoopCount = Number(options.loopCount);
      const requestedRingSeconds = Number(options.ringSeconds);
      const requestedPauseSeconds = Number(options.pauseSeconds);
      const loopCount = Math.max(
        1,
        Number.isFinite(requestedLoopCount) ? requestedLoopCount : state.loopCount || 1,
      );
      const ringSeconds = Math.max(
        1,
        Number.isFinite(requestedRingSeconds) ? requestedRingSeconds : state.ringSeconds || 120,
      );
      const pauseSeconds = Math.max(
        0,
        Number.isFinite(requestedPauseSeconds) ? requestedPauseSeconds : state.pauseSeconds || 0,
      );
      if (state.dryRun) {
        const planned = {
          ok: true,
          dryRun: true,
          loop: {
            count: loopCount,
            ringSeconds,
            pauseSeconds,
            estimatedSeconds: (loopCount * ringSeconds) + (Math.max(0, loopCount - 1) * pauseSeconds),
          },
          primary: {
            extensionId: state.extensionId,
            ...payload,
          },
          external:
            state.externalNotifyPhone && state.externalNotifyMode !== "off"
              ? { toPhone: maskPhone(state.externalNotifyPhone), mode: state.externalNotifyMode }
              : null,
        };
        state.lastResult = planned;
        state.lastCompletedAt = new Date();
        state.firedCount += 1;
        await recordDemoStage({
          state,
          stage: "completed",
          summary: `Dry-run demo RingOut ${state.label} ${maskPhone(state.fromPhone)} -> ${maskPhone(state.toPhone)}`,
          payload,
          result: planned,
        });
        return planned;
      }

      const client = createRingCentralClient();
      const fireSingle = async (iteration = 1) => {
        const primary = await client.createRingOut(state.extensionId, primaryInput);
        const primaryId = getRingOutId(primary);
        let external = null;

        if (state.externalNotifyPhone && state.externalNotifyMode !== "off") {
          let shouldNotify = state.externalNotifyMode === "after-primary-accepted";
          let connectionStatus = null;
          if (state.externalNotifyMode === "after-primary-connected" && primaryId) {
            connectionStatus = await waitForRingoutConnected(client, state, primaryId, runtime.logger);
            shouldNotify = Boolean(connectionStatus.connected);
          }
          if (shouldNotify) {
            external = await client.createRingOut(
              state.extensionId,
              buildRingoutInput(state, state.externalNotifyPhone),
            );
          } else if (connectionStatus) {
            external = { skipped: true, reason: "primary-not-connected", connectionStatus };
          }
        }

        return {
          iteration,
          primary,
          primaryId,
          external,
          externalId: getRingOutId(external),
        };
      };

      if (loopCount > 1) {
        const iterations = [];
        runtime.logger.info("demo-ringout.loop_started", {
          count: loopCount,
          ringSeconds,
          pauseSeconds,
          dryRun: false,
        });
        for (let iteration = 1; iteration <= loopCount; iteration += 1) {
          const fired = await fireSingle(iteration);
          runtime.logger.info("demo-ringout.loop_iteration_fired", {
            iteration,
            count: loopCount,
            primary: fired.primaryId ? { id: fired.primaryId } : { accepted: true },
            external: fired.externalId ? { id: fired.externalId } : fired.external || null,
          });
          await sleep(ringSeconds * 1000);
          const cancelled = {
            primary: await cancelRingOut(client, state, fired.primary, runtime.logger, "primary"),
            external: fired.externalId
              ? await cancelRingOut(client, state, fired.external, runtime.logger, "external")
              : null,
          };
          iterations.push({
            iteration,
            primary: fired.primaryId ? { id: fired.primaryId } : { accepted: true },
            external: fired.externalId ? { id: fired.externalId } : fired.external || null,
            cancelled,
          });
          state.firedCount += 1;
          if (iteration < loopCount && pauseSeconds > 0) {
            await sleep(pauseSeconds * 1000);
          }
        }
        const result = {
          ok: true,
          dryRun: false,
          loop: true,
          count: loopCount,
          ringSeconds,
          pauseSeconds,
          iterations,
        };
        state.lastResult = {
          ok: true,
          dryRun: false,
          loop: true,
          count: loopCount,
          completedCount: iterations.length,
          lastIteration: iterations[iterations.length - 1] || null,
        };
        state.lastCompletedAt = new Date();
        await recordDemoStage({
          state,
          stage: "completed",
          summary: `Demo RingOut loop completed ${iterations.length}/${loopCount} cycles`,
          payload: {
            ...payload,
            loopCount,
            ringSeconds,
            pauseSeconds,
          },
          result: state.lastResult,
        });
        runtime.logger.info("demo-ringout.loop_completed", state.lastResult);
        return result;
      }

      const fired = await fireSingle(1);
      const { primary, primaryId, external } = fired;
      const result = { ok: true, dryRun: false, primary, external };
      state.lastResult = {
        ok: true,
        dryRun: false,
        primary: primaryId ? { id: primaryId } : { accepted: true },
        external: external?.id ? { id: external.id } : external || null,
      };
      state.lastCompletedAt = new Date();
      state.firedCount += 1;
      await recordDemoStage({
        state,
        stage: "completed",
        summary: `Demo RingOut fired ${state.label} ${maskPhone(state.fromPhone)} -> ${maskPhone(state.toPhone)}`,
        payload,
        result: state.lastResult,
      });
      runtime.logger.info("demo-ringout.fired", state.lastResult);
      return result;
    } catch (error) {
      state.lastError = error.message;
      state.lastCompletedAt = new Date();
      await recordDemoStage({
        state,
        stage: "failed",
        summary: `Demo RingOut failed: ${error.message}`,
        payload,
        result: { error: error.message, details: error.details || null },
      });
      runtime.logger.error("demo-ringout.failed", { error: error.message, details: error.details || null });
      return { ok: false, error: error.message, details: error.details || null };
    } finally {
      state.running = false;
      state.nextRunAt = computeNextRunAt(state, new Date(Date.now() + 1000));
    }
  }

  async function start() {
    state.nextRunAt = computeNextRunAt(state);
    if (!state.enabled) {
      runtime.logger.warn("demo-ringout.disabled", {
        reason: "DEMO_RINGOUT_ENABLED is not true",
        nextRunAt: state.nextRunAt,
      });
      return summarizeState(state);
    }

    const tick = async () => {
      if (state.running || !state.nextRunAt) return;
      if (Date.now() < state.nextRunAt.getTime()) return;
      await fire({ scheduled: true, scheduledFor: state.nextRunAt }).catch((error) => {
        runtime.logger.error("demo-ringout.tick_failed", { error: error.message });
      });
    };

    state.timer = setInterval(() => {
      void tick();
    }, state.tickMs);
    if (typeof state.timer.unref === "function") state.timer.unref();

    runtime.logger.info("demo-ringout.armed", summarizeState(state));
    return summarizeState(state);
  }

  async function stop() {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
    const deadline = Date.now() + 15_000;
    while (state.running && Date.now() < deadline) {
      await sleep(250);
    }
  }

  function getState() {
    return summarizeState(state);
  }

  return {
    fire,
    getState,
    start,
    stop,
  };
}

module.exports = {
  computeNextRunAt,
  createDemoRingoutRuntime,
  normalizePhone,
};
