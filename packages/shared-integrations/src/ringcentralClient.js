"use strict";

const { ExternalServiceError } = require("../../shared-errors/src");
const { getRingCentralConfig } = require("../../shared-config/src");

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
};
let refreshTimer = null;
let refreshCallback = null;

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
    throw new ExternalServiceError(
      "ringcentral",
      `RingCentral authentication failed: ${response.status}`,
      {
        status: 502,
        retryable: response.status >= 500,
        details: {
          responseStatus: response.status,
          responseBody: data,
        },
      },
    );
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
  tokenState = {
    accessToken: null,
    expiresAt: 0,
  };
  await doLogin(force);
  await runRefreshCallback(reason);
  return getAuthStatus();
}

async function warmupPlatform(options = {}) {
  const config = getRingCentralConfig();
  const refreshIntervalMs = Number(options.refreshIntervalMs ?? config.refreshIntervalMs ?? 0);

  stopWarmupTimer();
  authState = {
    ...authState,
    refreshIntervalMs,
  };

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
    throw new ExternalServiceError(
      "ringcentral",
      `RingCentral request failed ${method} ${path}: ${response.status}`,
      {
        status: 502,
        retryable: response.status >= 500 || response.status === 429,
        details: {
          method,
          path,
          query: query || null,
          responseStatus: response.status,
          responseBody: data,
        },
      },
    );
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
    listExtensions() {
      return request("GET", "/restapi/v1.0/account/~/extension", {
        query: {
          type: "User",
          status: "Enabled",
          perPage: 100,
        },
      });
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
