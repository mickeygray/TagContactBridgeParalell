"use strict";

const { env } = require("../../shared-config/src/env");
const { ExternalServiceError } = require("../../shared-errors/src");
const { requestJson } = require("./httpClient");

const CALLFIRE_BASE_URL = env("CALLFIRE_BASE_URL", "https://api.callfire.com/v2/");

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "https://api.callfire.com/v2/";
  return raw.endsWith("/") ? raw : `${raw}/`;
}

function buildDateKey(value, timezone = "America/Los_Angeles") {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function createCallFireClient() {
  const config = {
    baseUrl: normalizeBaseUrl(CALLFIRE_BASE_URL),
    username: env("CALLFIRE_USER", ""),
    password: env("CALLFIRE_PASSWORD", ""),
    broadcastId: env("CALLFIRE_BROADCAST_ID", ""),
    fromNumber: env("CALLFIRE_FROM_NUMBER", ""),
  };

  function ensureConfigured() {
    if (!config.username || !config.password) {
      throw new ExternalServiceError("callfire", "CallFire configuration missing", {
        status: 500,
        retryable: false,
        details: {
          hasUsername: Boolean(config.username),
          hasPassword: Boolean(config.password),
        },
      });
    }
  }

  function buildUrl(path, params = {}) {
    const url = new URL(String(path || "").replace(/^\//, ""), config.baseUrl);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    });
    return url.toString();
  }

  async function request(path, options = {}) {
    ensureConfigured();
    const token = Buffer.from(`${config.username}:${config.password}`).toString("base64");
    const method = String(options.method || "GET").toUpperCase();
    const params = options.params || {};
    const body = options.body;
    const response = await requestJson(
      buildUrl(path, params),
      {
        method,
        headers: {
          Authorization: `Basic ${token}`,
          "Content-Type": "application/json",
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      },
      {
        timeoutMs: 20000,
        retries: 1,
      },
    );

    if (!response.ok) {
      throw new ExternalServiceError(
        "callfire",
        `CallFire request failed for ${path}: ${response.status}`,
        {
          status: 502,
          retryable: response.status >= 500,
          details: {
            path,
            responseStatus: response.status,
            responseBody: response.data,
          },
        },
      );
    }

    return response.data;
  }

  async function listBroadcasts(options = {}) {
    const limit = Math.min(Number(options.limit) || 100, 100);
    const maxPages = Math.max(Number(options.maxPages) || 25, 1);
    const items = [];

    for (let page = 0; page < maxPages; page += 1) {
      const offset = page * limit;
      const payload = await request("calls/broadcasts", { params: { limit, offset } });
      const pageItems = Array.isArray(payload?.items) ? payload.items : [];
      items.push(...pageItems);
      if (pageItems.length < limit) break;
    }

    return items;
  }

  async function getBroadcastStats(broadcastId) {
    return request(`calls/broadcasts/${encodeURIComponent(broadcastId)}/stats`);
  }

  async function getBroadcast(broadcastId) {
    return request(`calls/broadcasts/${encodeURIComponent(broadcastId)}`);
  }

  async function createBroadcast(body) {
    return request("calls/broadcasts", {
      method: "POST",
      body,
    });
  }

  async function addRecipientsToBroadcast(broadcastId, recipients = []) {
    return request(`calls/broadcasts/${encodeURIComponent(broadcastId)}/recipients`, {
      method: "POST",
      body: recipients,
    });
  }

  async function startBroadcast(broadcastId) {
    return request(`calls/broadcasts/${encodeURIComponent(broadcastId)}/start`, {
      method: "POST",
      body: {},
    });
  }

  async function listBroadcastsWithStatsForRange(options = {}) {
    const timezone = options.timezone || "America/Los_Angeles";
    const from = options.from ? String(options.from) : "";
    const to = options.to ? String(options.to) : "";
    const allBroadcasts = await listBroadcasts(options);
    const filtered = allBroadcasts.filter((broadcast) => {
      const dateKey = buildDateKey(broadcast.lastModified, timezone);
      if (!dateKey) return false;
      if (from && dateKey < from) return false;
      if (to && dateKey > to) return false;
      return true;
    });

    const broadcasts = [];
    for (const broadcast of filtered) {
      const stats = await getBroadcastStats(broadcast.id);
      broadcasts.push({
        ...broadcast,
        stats,
        date: buildDateKey(broadcast.lastModified, timezone),
      });
    }

    return broadcasts;
  }

  return {
    config,
    buildDateKey,
    addRecipientsToBroadcast,
    createBroadcast,
    getBroadcastStats,
    getBroadcast,
    listBroadcasts,
    listBroadcastsWithStatsForRange,
    startBroadcast,
  };
}

module.exports = {
  buildDateKey,
  createCallFireClient,
};
