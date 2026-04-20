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
  refreshIntervalMs: 0,
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
  if (refreshCallback) {
    await refreshCallback({
      reason,
      authenticatedAt: authState.lastAuthenticatedAt,
    });
  }
  return getAuthStatus();
}

async function warmupPlatform(options = {}) {
  const config = getRingCentralConfig();
  const refreshIntervalMs = Number(options.refreshIntervalMs ?? config.refreshIntervalMs ?? 0);
  await doLogin(Boolean(options.force));

  stopWarmupTimer();
  authState = {
    ...authState,
    refreshIntervalMs,
  };

  if (refreshIntervalMs > 0) {
    refreshTimer = setInterval(async () => {
      try {
        await reinitializePlatform({
          force: true,
          reason: "scheduled-refresh",
        });
      } catch {
        // Keep timer alive; caller can inspect auth state via status route.
      }
    }, refreshIntervalMs);
  }

  return getAuthStatus();
}

function getAuthStatus() {
  return {
    ...authState,
    hasAccessToken: Boolean(tokenState.accessToken),
    expiresAt: tokenState.expiresAt ? new Date(tokenState.expiresAt).toISOString() : null,
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

  return {
    config,
    authenticate,
    doLogin,
    getAuthStatus,
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
    reinitializePlatform,
    setRefreshCallback,
    stopWarmupTimer,
    warmupPlatform,
  };
}

module.exports = {
  createRingCentralClient,
};
