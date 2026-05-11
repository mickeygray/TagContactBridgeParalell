"use strict";

const { createRingCentralClient } = require("../../shared-integrations/src");
const { emitHourlyJobEvent } = require("./hourlyJobEventService");

/**
 * RingCentral subscription watchdog.
 *
 * RC push subscriptions expire server-side (expirationTime is returned
 * at create/renew time — typically hours, not days, in newer RC
 * accounts). If the subscription lapses without renewal, webhook
 * delivery stops **silently** — no error, no event, no alarm —
 * which is the worst failure mode for the system.
 *
 * This watchdog is the single source of truth for subscription
 * liveness. It does three jobs:
 *
 *   1. `runSubscriptionWatchdog()` — periodic check:
 *      - List subs, identify ours by matching `deliveryMode.address`
 *        to our webhook URL (survives process restarts and lets us
 *        cleanly take over a pre-existing subscription).
 *      - Renew when time-to-expire is under `minRemainingMinutes`.
 *      - Recreate if renewal fails, status is non-Active, or the sub
 *        is missing entirely.
 *      - Emit an hourly retry job on unexpected failure so operators
 *        see it in the review queue even if this process itself
 *        survives.
 *
 *   2. `recordRingcentralEvent()` — called by the webhook handler on
 *      every inbound telephony/presence envelope. Stamps a runtime
 *      timestamp used by the silence checker.
 *
 *   3. `checkEventSilence()` — second-layer check. Even when a
 *      subscription looks healthy in the RC API, a middlebox or
 *      upstream proxy could be dropping deliveries. If no event has
 *      arrived for `silentThresholdMs` during business hours, surface
 *      a review item.
 *
 * All state is in-process (module-scoped). Restarting the service
 * clears it; the first watchdog tick after restart will re-detect
 * the current subscription from the RC API.
 */

const watchdogState = {
  // Subscription-side
  subscriptionId: null,
  expiresAt: null,
  status: null,
  lastCheckAt: null,
  lastAction: null, // "healthy" | "renewed" | "created" | "recreated" | "error"
  lastCheckError: null,

  // Event-stream-side
  lastEventAt: null,
  lastEventType: null,
  eventCount: 0,

  // Silence-side
  lastSilenceAlertAt: null,
};

function normalizeWebhookAddress(address) {
  const value = String(address || "").trim();
  if (!value) return null;
  // Strip trailing slash so comparisons are stable regardless of how
  // the URL is configured upstream.
  return value.replace(/\/+$/, "");
}

function addressesMatch(a, b) {
  const aa = normalizeWebhookAddress(a);
  const bb = normalizeWebhookAddress(b);
  if (!aa || !bb) return false;
  return aa === bb;
}

function extractSubscriptions(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.records)) return payload.records;
  if (Array.isArray(payload?.subscriptions)) return payload.subscriptions;
  return [];
}

function parseExpirationTime(raw) {
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function summarizeSubscription(sub) {
  if (!sub) return null;
  return {
    id: sub.id || null,
    status: sub.status || null,
    expirationTime: sub.expirationTime || null,
    creationTime: sub.creationTime || null,
    eventFilters: Array.isArray(sub.eventFilters) ? sub.eventFilters : [],
    address: sub.deliveryMode?.address || null,
  };
}

/**
 * Main watchdog tick. Safe to call repeatedly; every call reconciles
 * the RC-side state with our runtime cache.
 *
 * @param {Object} args
 * @param {string} args.webhookAddress - our public webhook URL; must
 *   match what was (or will be) posted to `deliveryMode.address`.
 * @param {string} [args.webhookSecret] - verification token echoed
 *   back to us by RC on every delivery. Required to create a new sub.
 * @param {number} [args.minRemainingMinutes=15] - renew when the sub
 *   has less than this many minutes of life left. Keep it a bit above
 *   the watchdog interval so we never race a near-expired sub.
 * @param {boolean} [args.emitOnFailure=true] - emit an hourly retry job
 *   when renewal/creation throws.
 * @param {Object} [args.logger] - optional logger.
 */
async function runSubscriptionWatchdog({
  webhookAddress,
  webhookSecret = null,
  minRemainingMinutes = 15,
  emitOnFailure = true,
  logger = null,
} = {}) {
  const now = new Date();
  watchdogState.lastCheckAt = now;
  watchdogState.lastCheckError = null;

  const address = normalizeWebhookAddress(webhookAddress);
  if (!address) {
    const note = "webhookAddress-missing";
    watchdogState.lastAction = "error";
    watchdogState.lastCheckError = note;
    logger?.warn?.("rc.watchdog.config_missing", { webhookAddress });
    return { action: "error", reason: note };
  }

  const rc = createRingCentralClient();
  // Warm the platform — cheap when token is already valid.
  try {
    await rc.reinitializePlatform({ force: false, reason: "watchdog" });
  } catch (error) {
    watchdogState.lastAction = "error";
    watchdogState.lastCheckError = `auth-failed: ${error.message}`;
    logger?.warn?.("rc.watchdog.auth_failed", { error: error.message });
    if (emitOnFailure) {
      await emitWatchdogRetry({ error, reason: "auth-failed", address, webhookSecret });
    }
    return { action: "error", reason: "auth-failed", error: error.message };
  }

  let subs;
  try {
    const payload = await rc.listSubscriptions();
    subs = extractSubscriptions(payload);
  } catch (error) {
    watchdogState.lastAction = "error";
    watchdogState.lastCheckError = `list-failed: ${error.message}`;
    logger?.warn?.("rc.watchdog.list_failed", { error: error.message });
    if (emitOnFailure) {
      await emitWatchdogRetry({ error, reason: "list-failed", address, webhookSecret });
    }
    return { action: "error", reason: "list-failed", error: error.message };
  }

  const ours = subs.find((sub) => addressesMatch(sub?.deliveryMode?.address, address));
  const summary = summarizeSubscription(ours);
  const expiresAt = parseExpirationTime(summary?.expirationTime);
  const remainingMs = expiresAt ? expiresAt.getTime() - now.getTime() : null;
  const remainingMinutes = remainingMs != null ? remainingMs / 60000 : null;

  if (!ours) {
    // Nothing to renew — create.
    if (!webhookSecret) {
      const reason = "no-subscription-and-no-secret";
      watchdogState.lastAction = "error";
      watchdogState.lastCheckError = reason;
      logger?.warn?.("rc.watchdog.cannot_create", { reason });
      return { action: "error", reason };
    }
    return createFresh({ rc, address, webhookSecret, emitOnFailure, logger });
  }

  watchdogState.subscriptionId = summary.id;
  watchdogState.expiresAt = expiresAt ? expiresAt.toISOString() : null;
  watchdogState.status = summary.status;

  const statusBad = summary.status && summary.status !== "Active";
  const nearExpiry =
    remainingMinutes != null && remainingMinutes < minRemainingMinutes;
  const alreadyExpired = remainingMinutes != null && remainingMinutes <= 0;

  if (!statusBad && !nearExpiry && !alreadyExpired) {
    watchdogState.lastAction = "healthy";
    logger?.info?.("rc.watchdog.healthy", {
      id: summary.id,
      remainingMinutes: remainingMinutes != null ? Math.round(remainingMinutes) : null,
    });
    return {
      action: "healthy",
      id: summary.id,
      expiresAt: watchdogState.expiresAt,
      remainingMinutes: remainingMinutes != null ? Math.round(remainingMinutes) : null,
    };
  }

  // Try to renew first — cheaper than delete+create.
  if (!alreadyExpired) {
    try {
      const renewed = await rc.renewSubscription(summary.id);
      const newSummary = summarizeSubscription(renewed);
      const newExpiresAt = parseExpirationTime(newSummary?.expirationTime);
      watchdogState.subscriptionId = newSummary?.id || summary.id;
      watchdogState.expiresAt = newExpiresAt ? newExpiresAt.toISOString() : null;
      watchdogState.status = newSummary?.status || "Active";
      watchdogState.lastAction = "renewed";
      logger?.info?.("rc.watchdog.renewed", {
        id: watchdogState.subscriptionId,
        previousRemainingMinutes:
          remainingMinutes != null ? Math.round(remainingMinutes) : null,
        newExpiresAt: watchdogState.expiresAt,
      });
      return {
        action: "renewed",
        id: watchdogState.subscriptionId,
        expiresAt: watchdogState.expiresAt,
      };
    } catch (error) {
      logger?.warn?.("rc.watchdog.renew_failed", {
        id: summary.id,
        error: error.message,
      });
      // Fall through to recreate.
    }
  }

  // Recreate: delete the bad one (best-effort), create fresh.
  if (!webhookSecret) {
    const reason = "recreate-needed-but-no-secret";
    watchdogState.lastAction = "error";
    watchdogState.lastCheckError = reason;
    if (emitOnFailure) {
      await emitWatchdogRetry({
        error: new Error(reason),
        reason,
        address,
        webhookSecret: null,
      });
    }
    return { action: "error", reason };
  }

  try {
    await rc.deleteSubscription(summary.id);
  } catch (error) {
    // Non-fatal — if delete fails, create might still succeed and we'll
    // have a stray sub; the next watchdog cycle can mop it up.
    logger?.warn?.("rc.watchdog.delete_before_recreate_failed", {
      id: summary.id,
      error: error.message,
    });
  }

  return createFresh({
    rc,
    address,
    webhookSecret,
    emitOnFailure,
    logger,
    recreatedFromId: summary.id,
  });
}

async function createFresh({
  rc,
  address,
  webhookSecret,
  emitOnFailure,
  logger,
  recreatedFromId = null,
}) {
  try {
    const created = await rc.createAccountTelephonySubscription(address, webhookSecret);
    const summary = summarizeSubscription(created);
    const newExpiresAt = parseExpirationTime(summary?.expirationTime);
    watchdogState.subscriptionId = summary?.id || null;
    watchdogState.expiresAt = newExpiresAt ? newExpiresAt.toISOString() : null;
    watchdogState.status = summary?.status || "Active";
    watchdogState.lastAction = recreatedFromId ? "recreated" : "created";
    logger?.info?.(
      recreatedFromId ? "rc.watchdog.recreated" : "rc.watchdog.created",
      {
        id: watchdogState.subscriptionId,
        expiresAt: watchdogState.expiresAt,
        recreatedFromId,
      },
    );
    return {
      action: recreatedFromId ? "recreated" : "created",
      id: watchdogState.subscriptionId,
      expiresAt: watchdogState.expiresAt,
      recreatedFromId,
    };
  } catch (error) {
    watchdogState.lastAction = "error";
    watchdogState.lastCheckError = `create-failed: ${error.message}`;
    logger?.warn?.("rc.watchdog.create_failed", {
      error: error.message,
      recreatedFromId,
    });
    if (emitOnFailure) {
      await emitWatchdogRetry({
        error,
        reason: recreatedFromId ? "recreate-failed" : "create-failed",
        address,
        webhookSecret,
      });
    }
    return { action: "error", reason: "create-failed", error: error.message };
  }
}

async function emitWatchdogRetry({ error, reason, address, webhookSecret }) {
  try {
    // Dedupe window: 1 hour. If the watchdog fails to renew 10 times in
    // an hour (tick = 5min), we emit once, not ten times. The unique
    // `(lane, dedupeKey)` index on HourlyJobEvent collapses the rest.
    // Hour bucket uses the local ISO hour prefix for readability.
    const hourBucket = new Date().toISOString().slice(0, 13);
    await emitHourlyJobEvent({
      lane: "hourly",
      domain: "TAG", // RC is tenant-shared; domain isn't meaningful here.
      eventType: "ringcentral.subscription.renew",
      targetService: "ringcentral-cx",
      handlerKey: "renewRingcentralSubscription",
      aggregateType: "ringcentral-subscription",
      aggregateId: "primary",
      payload: {
        reason,
        address,
        // NOT including the secret in the payload — handlers pull from
        // config at run time. Payload is persisted and reviewable.
        hasWebhookSecret: Boolean(webhookSecret),
        notifyOnResolution: true,
      },
      resolutionCheckKey: null, // No cheap read resolves this; handler does the work.
      dedupeKey: `TAG:ringcentral-subscription:${reason}:${hourBucket}`,
      emittedBy: "ringcentral-cx",
      priority: 95, // High — silent webhook failure is a P1 symptom.
      severity: "critical",
      firstError: error?.message || String(error),
      notes: `RC subscription watchdog tripped: ${reason}`,
      alertTitle: "RingCentral subscription watchdog alert",
      alertSummary: reason,
    });
  } catch {
    // Emission failures are themselves logged elsewhere; suppress here
    // so the watchdog never throws.
  }
}

/**
 * Call from the webhook handler on every inbound envelope. Stamps the
 * last-event timestamp that `checkEventSilence` consults.
 */
function recordRingcentralEvent(eventType = null) {
  watchdogState.lastEventAt = new Date();
  watchdogState.lastEventType = eventType;
  watchdogState.eventCount += 1;
}

/**
 * Second-layer check: even when the subscription *looks* healthy in
 * the RC API, a middlebox or proxy could be dropping deliveries. If
 * no event has landed for `silentThresholdMs` during business hours,
 * emit a review item so ops can investigate.
 *
 * Business-hours gate prevents noise during nights/weekends when low
 * call volume is expected. Override by passing `businessHoursOnly:false`.
 */
const DEFAULT_SILENCE_THRESHOLD_MS = 15 * 60 * 1000;
const SILENCE_ALERT_COOLDOWN_MS = 60 * 60 * 1000;

function isBusinessHours(date = new Date()) {
  const day = date.getDay();
  const hour = date.getHours();
  // Mon-Fri, 7am-7pm local. Intentionally conservative — we'd rather
  // skip a late-evening alert than wake an on-call at 2am.
  return day >= 1 && day <= 5 && hour >= 7 && hour < 19;
}

async function checkEventSilence({
  silentThresholdMs = DEFAULT_SILENCE_THRESHOLD_MS,
  businessHoursOnly = true,
  emitOnSilence = true,
  logger = null,
} = {}) {
  const now = new Date();

  if (businessHoursOnly && !isBusinessHours(now)) {
    return { silent: false, reason: "outside-business-hours" };
  }

  if (!watchdogState.lastEventAt) {
    // Process just started and nothing has come in yet; don't alarm.
    return { silent: false, reason: "no-baseline-yet" };
  }

  const silentForMs = now.getTime() - watchdogState.lastEventAt.getTime();
  if (silentForMs < silentThresholdMs) {
    return {
      silent: false,
      silentForMs,
      lastEventAt: watchdogState.lastEventAt.toISOString(),
    };
  }

  // Cooldown so we don't re-alert every tick during prolonged silence.
  const lastAlert = watchdogState.lastSilenceAlertAt;
  if (lastAlert && now.getTime() - lastAlert.getTime() < SILENCE_ALERT_COOLDOWN_MS) {
    return {
      silent: true,
      silentForMs,
      reason: "alert-suppressed-by-cooldown",
      lastEventAt: watchdogState.lastEventAt.toISOString(),
    };
  }

  logger?.warn?.("rc.watchdog.event_silence", {
    silentForMs,
    lastEventAt: watchdogState.lastEventAt,
  });
  watchdogState.lastSilenceAlertAt = now;

  if (emitOnSilence) {
    try {
      await emitHourlyJobEvent({
        lane: "hourly",
        domain: "TAG",
        eventType: "ringcentral.subscription.silence",
        targetService: "ringcentral-cx",
        handlerKey: "investigateRingcentralSilence",
        aggregateType: "ringcentral-subscription",
        aggregateId: "primary",
        payload: {
          silentForMs,
          lastEventAt: watchdogState.lastEventAt.toISOString(),
          subscriptionId: watchdogState.subscriptionId,
          subscriptionStatus: watchdogState.status,
          notifyOnResolution: true,
        },
        dedupeKey: `TAG:ringcentral-silence:${new Date().toISOString().slice(0, 13)}`,
        emittedBy: "ringcentral-cx",
        priority: 90,
        severity: "warning",
        firstError: `No RC events for ${Math.round(silentForMs / 60000)} minutes`,
        notes: "RC webhook stream appears silent during business hours",
        alertTitle: "RingCentral event silence",
        alertSummary: `No webhooks for ${Math.round(silentForMs / 60000)}m`,
      });
    } catch {
      // Suppress — this is an alerting path; no cascade.
    }
  }

  return {
    silent: true,
    silentForMs,
    lastEventAt: watchdogState.lastEventAt.toISOString(),
  };
}

function getWatchdogState() {
  return {
    subscriptionId: watchdogState.subscriptionId,
    expiresAt: watchdogState.expiresAt,
    status: watchdogState.status,
    lastCheckAt: watchdogState.lastCheckAt
      ? watchdogState.lastCheckAt.toISOString()
      : null,
    lastAction: watchdogState.lastAction,
    lastCheckError: watchdogState.lastCheckError,
    lastEventAt: watchdogState.lastEventAt
      ? watchdogState.lastEventAt.toISOString()
      : null,
    lastEventType: watchdogState.lastEventType,
    eventCount: watchdogState.eventCount,
    lastSilenceAlertAt: watchdogState.lastSilenceAlertAt
      ? watchdogState.lastSilenceAlertAt.toISOString()
      : null,
  };
}

/** Testing hook — reset state without restarting the process. */
function __resetWatchdogStateForTests() {
  watchdogState.subscriptionId = null;
  watchdogState.expiresAt = null;
  watchdogState.status = null;
  watchdogState.lastCheckAt = null;
  watchdogState.lastAction = null;
  watchdogState.lastCheckError = null;
  watchdogState.lastEventAt = null;
  watchdogState.lastEventType = null;
  watchdogState.eventCount = 0;
  watchdogState.lastSilenceAlertAt = null;
}

module.exports = {
  DEFAULT_SILENCE_THRESHOLD_MS,
  checkEventSilence,
  getWatchdogState,
  recordRingcentralEvent,
  runSubscriptionWatchdog,
  __resetWatchdogStateForTests,
};
