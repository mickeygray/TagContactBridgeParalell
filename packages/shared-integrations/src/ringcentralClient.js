"use strict";

const { ExternalServiceError } = require("../../shared-errors/src");
const { getRingCentralConfig } = require("../../shared-config/src");
const { queueRateLimitAlert } = require("./rateLimitAlertService");

// Cutover kill-switch. When set, this process makes ZERO calls to
// RingCentral — no token refresh, no presence, no recordings, no
// subscriptions. Used during machine cutover so two hosts don't fight
// over the same OAuth token (which causes auth-endpoint 429 cascades).
//
// Accepts: 1, true, yes, on (case-insensitive). Anything else = enabled.
//
// Read on every call (not cached) so the operator can flip it via env
// + service restart without rebuilding.
function rcSuspendedByEnv() {
  const raw = String(process.env.PARALLEL_RC_SUSPENDED || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

let tokenState = {
  accessToken: null,
  expiresAt: 0,
};
let authState = {
  isAuthenticated: false,
  lastAuthenticatedAt: null,
  lastError: null,
  lastCallbackError: null,
  refreshIntervalMs: 0,
  lastScheduledSkipAt: null,
  lastScheduledRunAt: null,
  lastRateLimitedAt: null,
  nextAuthAttemptAt: null,
  lastApiRateLimitedAt: null,
  nextApiAttemptAt: null,
  lastApiRateLimitError: null,
};
let refreshTimer = null;
let refreshCallback = null;

const DEFAULT_RATE_LIMIT_BACKOFF_MS = 60 * 1000;
const DEFAULT_MAX_RATE_LIMIT_BACKOFF_MS = 15 * 60 * 1000;

function hasCredentials(config) {
  return Boolean(config.clientId && config.clientSecret && config.jwtToken);
}

function buildBasicAuth(config) {
  return Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
}

async function parseResponse(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

function buildUrl(baseUrl, path, query = {}) {
  const url = new URL(path.replace(/^\//, ""), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });
  return url.toString();
}

function parseWeekdays(raw) {
  return String(raw || "")
    .split(",")
    .map((value) => Number(String(value).trim()))
    .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6);
}

function getBusinessTimeParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "numeric",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const weekdayLabel = parts.find((part) => part.type === "weekday")?.value || "";
  const hour = Number(parts.find((part) => part.type === "hour")?.value || 0);
  const weekdayMap = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return {
    weekday: weekdayMap[weekdayLabel] ?? -1,
    hour,
  };
}

function shouldRunScheduledReinitialize(config, now = new Date()) {
  return getRingCentralBusinessWindow(config, now).active;
}

function getRingCentralBusinessWindow(config = getRingCentralConfig(), now = new Date(), prefix = "autoReinit") {
  const businessHoursOnly = prefix === "presencePoll"
    ? config.presencePollBusinessHoursOnly !== false
    : config.autoReinitBusinessHoursOnly !== false;
  if (!businessHoursOnly) {
    return {
      active: true,
      reason: "business-hours-disabled",
      businessHoursOnly: false,
      timezone: prefix === "presencePoll"
        ? config.presencePollTimezone || config.autoReinitTimezone || "America/Los_Angeles"
        : config.autoReinitTimezone || "America/Los_Angeles",
      weekday: null,
      hour: null,
      startHour: null,
      endHour: null,
      weekdays: [],
    };
  }

  const timezone = prefix === "presencePoll"
    ? config.presencePollTimezone || config.autoReinitTimezone || "America/Los_Angeles"
    : config.autoReinitTimezone || "America/Los_Angeles";
  const allowedWeekdays = parseWeekdays(
    prefix === "presencePoll"
      ? config.presencePollWeekdays || config.autoReinitWeekdays
      : config.autoReinitWeekdays,
  );
  const { weekday, hour } = getBusinessTimeParts(now, timezone);
  const configuredStartHour = prefix === "presencePoll"
    ? config.presencePollStartHour
    : config.autoReinitStartHour;
  const configuredEndHour = prefix === "presencePoll"
    ? config.presencePollEndHour
    : config.autoReinitEndHour;
  const startHour = Math.max(0, Math.min(23, Number(configuredStartHour) || 7));
  const endHour = Math.max(startHour, Math.min(23, Number(configuredEndHour) || 18));
  const active = allowedWeekdays.includes(weekday) && hour >= startHour && hour < endHour;

  return {
    active,
    reason: active ? "inside-business-hours" : "outside-business-hours",
    businessHoursOnly: true,
    timezone,
    weekday,
    hour,
    startHour,
    endHour,
    weekdays: allowedWeekdays,
  };
}

function tokenExpiresInMs() {
  return tokenState.expiresAt ? Math.max(tokenState.expiresAt - Date.now(), 0) : 0;
}

function hasFreshToken(minTtlMs = 60000) {
  return Boolean(
    authState.isAuthenticated
      && tokenState.accessToken
      && Date.now() < tokenState.expiresAt - Math.max(Number(minTtlMs) || 0, 0),
  );
}

function isRateLimitError(error) {
  const status = Number(error?.status || error?.details?.responseStatus || 0);
  return status === 429 || /\b429\b|rate\s+exceeded/i.test(String(error?.message || ""));
}

function envDurationMs(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function parseRetryAfterMs(error) {
  const raw = error?.details?.retryAfter || error?.details?.retryAfterSeconds;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const parsed = Date.parse(String(raw || ""));
  if (Number.isFinite(parsed)) {
    return Math.max(parsed - Date.now(), 0);
  }
  return null;
}

function getRateLimitBackoffMs(error, envName) {
  const configured = envDurationMs(
    envName,
    envDurationMs("RC_RATE_LIMIT_BACKOFF_MS", DEFAULT_RATE_LIMIT_BACKOFF_MS),
  );
  const max = envDurationMs("RC_RATE_LIMIT_MAX_BACKOFF_MS", DEFAULT_MAX_RATE_LIMIT_BACKOFF_MS);
  const minPenalty = envDurationMs("RC_RATE_LIMIT_MIN_BACKOFF_MS", DEFAULT_RATE_LIMIT_BACKOFF_MS);
  const retryAfterMs = parseRetryAfterMs(error);
  const candidate = retryAfterMs == null ? configured : Math.max(retryAfterMs, minPenalty);
  return Math.min(Math.max(candidate, minPenalty), max);
}

function getAuthBackoffMs(error) {
  return getRateLimitBackoffMs(error, "RC_AUTH_RATE_LIMIT_BACKOFF_MS");
}

function getApiBackoffMs(error) {
  return getRateLimitBackoffMs(error, "RC_API_RATE_LIMIT_BACKOFF_MS");
}

function recordAuthRateLimit(error) {
  const nextAttemptAt = new Date(Date.now() + getAuthBackoffMs(error)).toISOString();
  const lastRateLimitedAt = new Date().toISOString();
  authState = {
    ...authState,
    isAuthenticated: false,
    lastError: error.message,
    lastRateLimitedAt,
    nextAuthAttemptAt: nextAttemptAt,
  };
  queueRateLimitAlert({
    platform: "RingCentral EX",
    service: "ringcentral",
    scope: "auth",
    usageGroup: error?.details?.rateLimitHeaders?.group || "auth",
    openedAt: lastRateLimitedAt,
    nextAttemptAt,
    error,
  });
  return nextAttemptAt;
}

function recordApiRateLimit(error) {
  const nextAttemptAt = new Date(Date.now() + getApiBackoffMs(error)).toISOString();
  const lastRateLimitedAt = new Date().toISOString();
  authState = {
    ...authState,
    lastApiRateLimitedAt: lastRateLimitedAt,
    nextApiAttemptAt: nextAttemptAt,
    lastApiRateLimitError: error.message,
  };
  queueRateLimitAlert({
    platform: "RingCentral EX",
    service: "ringcentral",
    scope: "api",
    usageGroup: error?.details?.rateLimitHeaders?.group || "api",
    openedAt: lastRateLimitedAt,
    nextAttemptAt,
    method: error?.details?.method,
    path: error?.details?.path,
    error,
  });
  return nextAttemptAt;
}

function buildBackoffError(message, details) {
  return new ExternalServiceError("ringcentral", message, {
    status: 429,
    retryable: true,
    details,
  });
}

function assertNotInAuthBackoff() {
  const nextAuthAttemptAt = authState.nextAuthAttemptAt
    ? new Date(authState.nextAuthAttemptAt).getTime()
    : 0;
  if (Number.isFinite(nextAuthAttemptAt) && nextAuthAttemptAt > Date.now()) {
    throw buildBackoffError(
      `RingCentral auth in rate-limit backoff until ${authState.nextAuthAttemptAt}`,
      {
        rateLimitedCircuitOpen: true,
        scope: "auth",
        nextAuthAttemptAt: authState.nextAuthAttemptAt,
        lastRateLimitedAt: authState.lastRateLimitedAt,
        lastError: authState.lastError,
      },
    );
  }
}

function assertNotInApiBackoff(method, path) {
  const nextApiAttemptAt = authState.nextApiAttemptAt
    ? new Date(authState.nextApiAttemptAt).getTime()
    : 0;
  if (Number.isFinite(nextApiAttemptAt) && nextApiAttemptAt > Date.now()) {
    throw buildBackoffError(
      `RingCentral API in rate-limit backoff until ${authState.nextApiAttemptAt}`,
      {
        rateLimitedCircuitOpen: true,
        scope: "api",
        method,
        path,
        nextApiAttemptAt: authState.nextApiAttemptAt,
        lastApiRateLimitedAt: authState.lastApiRateLimitedAt,
        lastApiRateLimitError: authState.lastApiRateLimitError,
      },
    );
  }
}

async function runRefreshCallback(reason) {
  if (!refreshCallback) return;
  try {
    await refreshCallback({
      reason,
      authenticatedAt: authState.lastAuthenticatedAt,
    });
    authState = {
      ...authState,
      lastCallbackError: null,
    };
  } catch (error) {
    authState = {
      ...authState,
      lastCallbackError: error.message,
    };
  }
}

async function runScheduledReinitialize(reason = "scheduled-refresh") {
  const config = getRingCentralConfig();
  const window = getRingCentralBusinessWindow(config, new Date(), "autoReinit");
  if (!window.active) {
    authState = {
      ...authState,
      lastScheduledSkipAt: new Date().toISOString(),
    };
    return {
      ok: true,
      skipped: true,
      reason: window.reason,
      window,
    };
  }

  authState = {
    ...authState,
    lastScheduledRunAt: new Date().toISOString(),
  };

  return reinitializePlatform({
    force: true,
    reason,
  });
}

async function ensureAuthenticated(options = {}) {
  const config = getRingCentralConfig();

  // Hard kill-switch for cutover scenarios. When PARALLEL_RC_SUSPENDED
  // is truthy (any of: 1, true, yes, on), this process makes ZERO calls
  // to RingCentral — no token refresh, no presence polls, no recording
  // downloads. The flag exists for the new-machine bring-up during
  // cutover: the new host runs the full app but stays silent toward RC
  // until the operator flips this flag off. Two simultaneous machines
  // refreshing the same OAuth token = the 429 snowball we saw on
  // 2026-05-13. This is the single gate that prevents it.
  if (rcSuspendedByEnv()) {
    return {
      ok: true,
      skipped: true,
      reason: "parallel-rc-suspended",
      auth: getAuthStatus(),
      window: { active: false, reason: "parallel-rc-suspended" },
    };
  }

  const businessHoursOnly = Boolean(options.businessHoursOnly);
  const window = businessHoursOnly
    ? getRingCentralBusinessWindow(config, new Date(), options.windowPrefix || "autoReinit")
    : { active: true, reason: "business-hours-disabled" };
  if (!window.active) {
    authState = {
      ...authState,
      lastScheduledSkipAt: new Date().toISOString(),
    };
    return {
      ok: true,
      skipped: true,
      reason: window.reason,
      auth: getAuthStatus(),
      window,
    };
  }

  const minTtlMs = Math.max(Number(options.minTtlMs) || 60000, 0);
  const nextAuthAttemptAt = authState.nextAuthAttemptAt
    ? new Date(authState.nextAuthAttemptAt).getTime()
    : 0;
  if (
    !options.force
    && !hasFreshToken(minTtlMs)
    && Number.isFinite(nextAuthAttemptAt)
    && nextAuthAttemptAt > Date.now()
  ) {
    return {
      ok: true,
      skipped: true,
      reason: "auth-rate-limit-backoff",
      auth: getAuthStatus(),
      window,
    };
  }
  if (!options.force && hasFreshToken(minTtlMs)) {
    return {
      ok: true,
      skipped: false,
      reason: "token-fresh",
      auth: getAuthStatus(),
      window,
    };
  }

  try {
    const auth = await reinitializePlatform({
      force: true,
      reason: options.reason || "ensure-authenticated",
    });
    return {
      ok: true,
      skipped: false,
      reason: options.reason || "ensure-authenticated",
      auth,
      window,
    };
  } catch (error) {
    const rateLimited = isRateLimitError(error);
    if (rateLimited) {
      const nextAuthAttemptMs = authState.nextAuthAttemptAt
        ? new Date(authState.nextAuthAttemptAt).getTime()
        : 0;
      if (!Number.isFinite(nextAuthAttemptMs) || nextAuthAttemptMs <= Date.now()) {
        recordAuthRateLimit(error);
      }
    }
    authState = {
      ...authState,
      isAuthenticated: false,
      lastError: error.message,
    };
    return {
      ok: false,
      skipped: false,
      reason: options.reason || "ensure-authenticated",
      error: error.message,
      auth: getAuthStatus(),
      window,
    };
  }
}

async function authenticate(force = false) {
  const config = getRingCentralConfig();
  if (!hasCredentials(config)) {
    throw new ExternalServiceError("ringcentral", "RingCentral credentials are missing", {
      status: 500,
      retryable: false,
    });
  }

  if (!force && tokenState.accessToken && Date.now() < tokenState.expiresAt - 60000) {
    return tokenState.accessToken;
  }

  assertNotInAuthBackoff();

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: config.jwtToken,
  });

  const response = await fetch(`${config.serverUrl}/restapi/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${buildBasicAuth(config)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const data = await parseResponse(response);
  if (!response.ok) {
    // On 429, capture all of RC's rate-limit headers — without these
    // we have no visibility into what the actual configured limits are.
    // RC may send: Retry-After (seconds OR HTTP date), X-Rate-Limit-Limit
    // (the ceiling), X-Rate-Limit-Remaining, X-Rate-Limit-Window (period),
    // X-Rate-Limit-Group (Light/Medium/Heavy/Auth).
    const rateLimitHeaders = response.status === 429 ? {
      retryAfter: response.headers?.get?.("retry-after") || null,
      limit:      response.headers?.get?.("x-rate-limit-limit") || null,
      remaining:  response.headers?.get?.("x-rate-limit-remaining") || null,
      window:     response.headers?.get?.("x-rate-limit-window") || null,
      group:      response.headers?.get?.("x-rate-limit-group") || null,
    } : null;
    const error = new ExternalServiceError(
      "ringcentral",
      `RingCentral authentication failed: ${response.status}`,
      {
        status: response.status === 429 ? 429 : 502,
        retryable: response.status >= 500 || response.status === 429,
        details: {
          responseStatus: response.status,
          responseBody: data,
          retryAfter: response.headers?.get?.("retry-after") || null,
          rateLimitHeaders,
          rateLimitedCircuitOpened: response.status === 429 ? true : undefined,
        },
      },
    );
    if (response.status === 429) {
      recordAuthRateLimit(error);
    }
    throw error;
  }

  tokenState = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in || 3600) * 1000),
  };
  authState = {
    ...authState,
    isAuthenticated: true,
    lastAuthenticatedAt: new Date().toISOString(),
    lastError: null,
    nextAuthAttemptAt: null,
  };

  return tokenState.accessToken;
}

async function doLogin(force = false) {
  try {
    await authenticate(force);
    return true;
  } catch (error) {
    authState = {
      ...authState,
      isAuthenticated: false,
      lastError: error.message,
    };
    throw error;
  }
}

function setRefreshCallback(callback) {
  refreshCallback = callback;
}

function stopWarmupTimer() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

async function reinitializePlatform({ force = true, reason = "manual" } = {}) {
  if (rcSuspendedByEnv()) {
    authState = {
      ...authState,
      isAuthenticated: false,
      lastScheduledSkipAt: new Date().toISOString(),
      lastError: null,
    };
    return getAuthStatus();
  }

  const previousTokenState = { ...tokenState };
  const previousAuthState = { ...authState };

  try {
    await doLogin(force);
    await runRefreshCallback(reason);
    return getAuthStatus();
  } catch (error) {
    const previousTokenFresh = Boolean(
      previousTokenState.accessToken
        && previousTokenState.expiresAt
        && Date.now() < previousTokenState.expiresAt - 60000,
    );
    if (previousTokenFresh) {
      tokenState = previousTokenState;
      authState = {
        ...previousAuthState,
        isAuthenticated: true,
        lastError: error.message,
      };
    }
    throw error;
  }
}

async function warmupPlatform(options = {}) {
  const config = getRingCentralConfig();
  const refreshIntervalMs = Number(options.refreshIntervalMs ?? config.refreshIntervalMs ?? 0);

  stopWarmupTimer();
  authState = {
    ...authState,
    refreshIntervalMs,
  };

  if (rcSuspendedByEnv()) {
    authState = {
      ...authState,
      isAuthenticated: false,
      lastScheduledSkipAt: new Date().toISOString(),
      lastError: null,
    };
    return getAuthStatus();
  }

  if (refreshIntervalMs > 0) {
    refreshTimer = setInterval(async () => {
      try {
        await runScheduledReinitialize("scheduled-refresh");
      } catch (error) {
        authState = {
          ...authState,
          isAuthenticated: false,
          lastError: error.message,
        };
      }
    }, refreshIntervalMs);
    if (typeof refreshTimer.unref === "function") {
      refreshTimer.unref();
    }
  }

  await doLogin(Boolean(options.force));
  return getAuthStatus();
}

function getAuthStatus() {
  return {
    ...authState,
    hasAccessToken: Boolean(tokenState.accessToken),
    expiresAt: tokenState.expiresAt ? new Date(tokenState.expiresAt).toISOString() : null,
    tokenExpiresInMs: tokenExpiresInMs(),
    tokenFresh: hasFreshToken(60000),
    autoReinitializeWindow: {
      businessHoursOnly: Boolean(getRingCentralConfig().autoReinitBusinessHoursOnly),
      timezone: getRingCentralConfig().autoReinitTimezone || "America/Los_Angeles",
      startHour: Number(getRingCentralConfig().autoReinitStartHour) || 7,
      endHour: Number(getRingCentralConfig().autoReinitEndHour) || 18,
      weekdays: parseWeekdays(getRingCentralConfig().autoReinitWeekdays),
    },
  };
}

async function request(method, path, { query, body, headers } = {}, retry = true) {
  const config = getRingCentralConfig();
  assertNotInApiBackoff(method, path);
  const token = await authenticate();
  const response = await fetch(buildUrl(config.serverUrl, path, query), {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(headers || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await parseResponse(response);
  if (response.status === 401 && retry) {
    await authenticate(true);
    return request(method, path, { query, body, headers }, false);
  }

  if (!response.ok) {
    // Capture full rate-limit header set on 429 for forensics. RC's
    // X-Rate-Limit-Group tells us which bucket fired (Light/Medium/
    // Heavy/Auth), Limit + Window give the actual configured ceiling.
    const rateLimitHeaders = response.status === 429 ? {
      retryAfter: response.headers?.get?.("retry-after") || null,
      limit:      response.headers?.get?.("x-rate-limit-limit") || null,
      remaining:  response.headers?.get?.("x-rate-limit-remaining") || null,
      window:     response.headers?.get?.("x-rate-limit-window") || null,
      group:      response.headers?.get?.("x-rate-limit-group") || null,
    } : null;
    const error = new ExternalServiceError(
      "ringcentral",
      `RingCentral request failed ${method} ${path}: ${response.status}`,
      {
        status: response.status === 429 ? 429 : 502,
        retryable: response.status >= 500 || response.status === 429,
        details: {
          method,
          path,
          query: query || null,
          responseStatus: response.status,
          responseBody: data,
          retryAfter: response.headers?.get?.("retry-after") || null,
          rateLimitHeaders,
          rateLimitedCircuitOpened: response.status === 429 ? true : undefined,
        },
      },
    );
    if (response.status === 429) {
      recordApiRateLimit(error);
    }
    throw error;
  }

  return data;
}

function createRingCentralClient() {
  const config = getRingCentralConfig();
  const extensionPath = (extensionId) => {
    const value = String(extensionId || "~").trim() || "~";
    return value === "~" ? "~" : encodeURIComponent(value);
  };

  return {
    config,
    authenticate,
    doLogin,
    getAuthStatus,
    ensureAuthenticated,
    async listExtensions(options = {}) {
      const perPage = Math.max(1, Math.min(Number(options.perPage || 100) || 100, 1000));
      const status = options.status === undefined ? "Enabled" : options.status;
      const type = options.type === undefined ? "User" : options.type;
      const records = [];
      let page = Math.max(Number(options.page || 1) || 1, 1);
      let totalPages = page;
      let lastPayload = null;

      do {
        const query = {
          perPage,
          page,
        };
        if (type !== null && type !== false && String(type || "").trim()) {
          query.type = String(type).trim();
        }
        if (status !== null && status !== false && String(status || "").trim()) {
          query.status = String(status).trim();
        }

        const payload = await request("GET", "/restapi/v1.0/account/~/extension", { query });
        lastPayload = payload;
        records.push(...(Array.isArray(payload?.records) ? payload.records : []));
        totalPages = Number(payload?.paging?.totalPages || page) || page;
        page += 1;
      } while (options.allPages !== false && page <= totalPages);

      return {
        ...(lastPayload || {}),
        records,
      };
    },
    getPresence(extensionId) {
      return request(
        "GET",
        `/restapi/v1.0/account/~/extension/${encodeURIComponent(extensionId)}/presence`,
        {
          query: {
            detailedTelephonyState: true,
          },
        },
      );
    },
    listSubscriptions() {
      return request("GET", "/restapi/v1.0/subscription");
    },
    createAccountTelephonySubscription(address, verificationToken) {
      return request("POST", "/restapi/v1.0/subscription", {
        body: {
          eventFilters: ["/restapi/v1.0/account/~/telephony/sessions"],
          deliveryMode: {
            transportType: "WebHook",
            address,
            verificationToken,
          },
        },
      });
    },
    renewSubscription(subscriptionId) {
      return request("PUT", `/restapi/v1.0/subscription/${encodeURIComponent(subscriptionId)}`, {
        body: {},
      });
    },
    deleteSubscription(subscriptionId) {
      return request("DELETE", `/restapi/v1.0/subscription/${encodeURIComponent(subscriptionId)}`);
    },
    getExtensionCallLog(extensionId, query = {}) {
      return request(
        "GET",
        `/restapi/v1.0/account/~/extension/${encodeURIComponent(extensionId)}/call-log`,
        {
          query,
        },
      );
    },
    getAccountCallLog(query = {}) {
      return request("GET", "/restapi/v1.0/account/~/call-log", {
        query,
      });
    },
    getCallLogRecord(extensionId, recordId) {
      return request(
        "GET",
        `/restapi/v1.0/account/~/extension/${encodeURIComponent(extensionId)}/call-log/${encodeURIComponent(recordId)}`,
      );
    },
    listExtensionPhoneNumbers(extensionId) {
      return request(
        "GET",
        `/restapi/v1.0/account/~/extension/${encodeURIComponent(extensionId)}/phone-number`,
      );
    },
    sendExtensionSms(extensionId, { fromPhoneNumber, toPhoneNumber, text }) {
      return request(
        "POST",
        `/restapi/v1.0/account/~/extension/${encodeURIComponent(extensionId)}/sms`,
        {
          body: {
            from: { phoneNumber: fromPhoneNumber },
            to: [{ phoneNumber: toPhoneNumber }],
            text,
          },
        },
      );
    },
    createRingOut(extensionId = "~", {
      fromPhoneNumber,
      toPhoneNumber,
      callerIdPhoneNumber = null,
      playPrompt = false,
      countryId = "1",
    } = {}) {
      const body = {
        from: { phoneNumber: fromPhoneNumber },
        to: { phoneNumber: toPhoneNumber },
        playPrompt: Boolean(playPrompt),
        country: { id: String(countryId || "1") },
      };
      if (callerIdPhoneNumber) {
        body.callerId = { phoneNumber: callerIdPhoneNumber };
      }
      return request(
        "POST",
        `/restapi/v1.0/account/~/extension/${extensionPath(extensionId)}/ring-out`,
        { body },
      );
    },
    getRingOut(extensionId = "~", ringOutId) {
      return request(
        "GET",
        `/restapi/v1.0/account/~/extension/${extensionPath(extensionId)}/ring-out/${encodeURIComponent(ringOutId)}`,
      );
    },
    deleteRingOut(extensionId = "~", ringOutId) {
      return request(
        "DELETE",
        `/restapi/v1.0/account/~/extension/${extensionPath(extensionId)}/ring-out/${encodeURIComponent(ringOutId)}`,
      );
    },
    reinitializePlatform,
    setRefreshCallback,
    stopWarmupTimer,
    warmupPlatform,
  };
}

module.exports = {
  createRingCentralClient,
  getRingCentralBusinessWindow,
  shouldRunScheduledReinitialize,
};
