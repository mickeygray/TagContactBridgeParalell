"use strict";

const {
  recordServiceAlert,
  runGroupedNightlyClose,
} = require("../../../../packages/shared-services/src");

const REQUIRED_NIGHTLY_DOMAINS = ["WYNN", "TAG"];
const DEFAULT_WEEKDAYS = Object.freeze([1, 2, 3, 4, 5]);

function normalizeActiveWeekdays(values = null) {
  const source = Array.isArray(values) && values.length > 0
    ? values
    : DEFAULT_WEEKDAYS;
  const normalized = [...new Set(
    source
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6),
  )];
  return normalized.length > 0 ? normalized : [...DEFAULT_WEEKDAYS];
}

function normalizeRecipients(values = []) {
  return (Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
}

function firstRecipientList(...candidates) {
  for (const candidate of candidates) {
    const normalized = normalizeRecipients(candidate);
    if (normalized.length > 0) return normalized;
  }
  return [];
}

function computeNextRunAt(
  hour,
  minute,
  timezone = "America/Los_Angeles",
  now = new Date(),
  options = {},
) {
  const activeWeekdays = new Set(normalizeActiveWeekdays(options.activeWeekdays));
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

  const parts = Object.fromEntries(
    formatter.formatToParts(now).map((part) => [part.type, part.value]),
  );
  const candidate = new Date(
    `${parts.year}-${parts.month}-${parts.day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`,
  );
  if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
    candidate.setHours(hour, minute, 0, 0);
  }
  for (let attempts = 0; attempts < 8; attempts += 1) {
    if (activeWeekdays.has(candidate.getDay())) {
      return candidate;
    }
    candidate.setDate(candidate.getDate() + 1);
    candidate.setHours(hour, minute, 0, 0);
  }
  return candidate;
}

function createState(config = {}) {
  return {
    enabled: Boolean(config.enabled),
    running: false,
    domains: normalizeNightlyDomains(config.domains),
    hour: Number(config.hour || 21),
    minute: Number(config.minute || 30),
    timezone: config.timezone || "America/Los_Angeles",
    intervalMs: Number(config.intervalMs || 60000),
    activeWeekdays: normalizeActiveWeekdays(config.activeWeekdays),
    sendEmail: Boolean(config.sendEmail),
    recipients: normalizeRecipients(config.recipients),
    financialRecipients: normalizeRecipients(config.financialRecipients),
    leadDataRecipients: normalizeRecipients(config.leadDataRecipients),
    opsRecipients: normalizeRecipients(config.opsRecipients),
    timer: null,
    nextRunAt: null,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastResult: null,
    lastError: null,
  };
}

function normalizeNightlyDomains(domains) {
  const requested = (Array.isArray(domains) ? domains : [])
    .map((value) => String(value || "").trim().toUpperCase())
    .filter(Boolean);
  return [...new Set([...requested, ...REQUIRED_NIGHTLY_DOMAINS])];
}

function summarizeState(state) {
  return {
    enabled: state.enabled,
    running: state.running,
    domains: state.domains,
    hour: state.hour,
    minute: state.minute,
    timezone: state.timezone,
    intervalMs: state.intervalMs,
    activeWeekdays: state.activeWeekdays,
    sendEmail: state.sendEmail,
    recipients: state.recipients,
    financialRecipients: state.financialRecipients,
    leadDataRecipients: state.leadDataRecipients,
    opsRecipients: state.opsRecipients,
    nextRunAt: state.nextRunAt,
    lastStartedAt: state.lastStartedAt,
    lastCompletedAt: state.lastCompletedAt,
    lastResult: state.lastResult,
    lastError: state.lastError,
  };
}

function createNightlyCloseRuntime({ config = {}, runtime, spendSyncRuntime = null }) {
  const state = createState(config);
  // Held in closure so the per-tick `runNightlyClose` can pass it
  // through to the grouped service, which uses it to trigger one final
  // spend-sync pass before snapshotting.
  // Optional: when null, the service skips the spend-sync step and
  // proceeds with whatever data is already in mongo.
  const spendSyncRef = spendSyncRuntime;

  async function runNightlyClose(options = {}) {
    if (state.running) {
      return {
        ok: false,
        skipped: true,
        reason: "nightly-close-already-running",
        state: summarizeState(state),
      };
    }

    const domains = normalizeNightlyDomains(
      Array.isArray(options.domains) && options.domains.length > 0
        ? options.domains
        : state.domains,
    );

    state.running = true;
    state.lastStartedAt = new Date();
    state.lastError = null;

    const selectedDomains = domains;

    try {
      const commonEmail = options.email || {};
      const commonRecipients = commonEmail.recipients;
      const financialEmail = {
        ...commonEmail,
        ...(options.financialEmail || {}),
        recipients: firstRecipientList(
          options.financialEmail?.recipients,
          commonRecipients,
          state.financialRecipients,
          state.recipients,
        ),
      };
      const leadDataEmail = {
        ...commonEmail,
        ...(options.leadDataEmail || {}),
        recipients: firstRecipientList(
          options.leadDataEmail?.recipients,
          commonRecipients,
          state.leadDataRecipients,
          state.recipients,
        ),
      };
      const opsEmail = {
        ...(options.opsEmail || {}),
        recipients: firstRecipientList(
          options.opsEmail?.recipients,
          state.opsRecipients,
          commonRecipients,
          state.recipients,
        ),
      };

      const groupedResult = await runGroupedNightlyClose(selectedDomains, {
        ...options,
        sendEmail:
          options.sendEmail !== undefined
            ? Boolean(options.sendEmail)
            : state.sendEmail,
        email: {
          ...commonEmail,
          recipients:
            Array.isArray(commonRecipients) && commonRecipients.length > 0
              ? commonRecipients
              : state.recipients,
        },
        financialEmail,
        leadDataEmail,
        opsEmail,
        spendSyncRuntime: options.spendSyncRuntime || spendSyncRef || null,
        logger: runtime.logger,
      });

      state.lastCompletedAt = new Date();
      state.lastResult = {
        domains: selectedDomains,
        emails: groupedResult.results,
        finalClose: {
          spendSync: groupedResult.finalClose?.spendSync || null,
          paymentSweep: groupedResult.finalClose?.paymentSweep || null,
          postDateSweep: groupedResult.finalClose?.postDateSweep || null,
          leadCadenceCaseRefresh: groupedResult.finalClose?.leadCadenceCaseRefresh || null,
          hourlySweep: groupedResult.finalClose?.hourlySweep
            ? {
                startedAt: groupedResult.finalClose.hourlySweep.startedAt,
                finishedAt: groupedResult.finalClose.hourlySweep.finishedAt,
                durationMs: groupedResult.finalClose.hourlySweep.durationMs,
              }
            : null,
        },
      };
      state.lastError = null;
      state.nextRunAt = computeNextRunAt(
        state.hour,
        state.minute,
        state.timezone,
        state.lastCompletedAt,
        { activeWeekdays: state.activeWeekdays },
      );

      runtime.logger.info("nightly-close.completed", state.lastResult);
      return {
        ok: true,
        domains: selectedDomains,
        result: groupedResult,
      };
    } catch (error) {
      state.lastCompletedAt = new Date();
      state.lastResult = null;
      state.lastError = error.message;
      state.nextRunAt = computeNextRunAt(
        state.hour,
        state.minute,
        state.timezone,
        state.lastCompletedAt,
        { activeWeekdays: state.activeWeekdays },
      );

      await recordServiceAlert({
        domain: selectedDomains?.[0] || "TAG",
        sourceService: "control-plane",
        category: "nightly-close",
        severity: "high",
        title: "Nightly close run failed",
        summary: error.message,
        payload: {
          domains: selectedDomains,
          scheduled: Boolean(options.scheduled),
        },
        tags: ["nightly-close", "metrics", "payments"],
      }).catch(() => null);

      runtime.logger.error("nightly-close.failed", {
        domains: selectedDomains,
        error: error.message,
      });
      throw error;
    } finally {
      state.running = false;
    }
  }

  async function start() {
    state.enabled = Boolean(config.enabled);
    state.nextRunAt = computeNextRunAt(state.hour, state.minute, state.timezone, new Date(), {
      activeWeekdays: state.activeWeekdays,
    });

    if (!state.enabled) {
      runtime.logger.warn("nightly-close.disabled");
      return;
    }

    const tick = async () => {
      if (state.running || !state.nextRunAt) return;
      if (Date.now() < state.nextRunAt.getTime()) return;
      try {
        await runNightlyClose({ scheduled: true });
      } catch {
        // Logged in runNightlyClose.
      }
    };

    state.timer = setInterval(() => {
      void tick();
    }, state.intervalMs);

    if (typeof state.timer.unref === "function") {
      state.timer.unref();
    }

    runtime.logger.info("nightly-close.armed", {
      domains: state.domains,
      hour: state.hour,
      minute: state.minute,
      timezone: state.timezone,
      activeWeekdays: state.activeWeekdays,
      sendEmail: state.sendEmail,
      recipientCount: state.recipients.length,
      financialRecipientCount: state.financialRecipients.length,
      leadDataRecipientCount: state.leadDataRecipients.length,
      opsRecipientCount: state.opsRecipients.length,
      nextRunAt: state.nextRunAt,
    });
  }

  async function stop() {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
  }

  return {
    getState: () => summarizeState(state),
    runNightlyClose,
    start,
    stop,
  };
}

module.exports = {
  computeNextRunAt,
  createNightlyCloseRuntime,
  normalizeActiveWeekdays,
};
