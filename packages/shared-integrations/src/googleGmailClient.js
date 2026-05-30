"use strict";

const crypto = require("crypto");

const { ExternalServiceError } = require("../../shared-errors/src");

let tokenState = {
  cacheKey: null,
  accessToken: null,
  expiresAt: 0,
};

function base64urlEncode(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64urlDecode(value = "") {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64");
}

function parseResponseBody(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

function buildCacheKey(config = {}) {
  return JSON.stringify({
    authMode: config.authMode || "",
    clientEmail: config.clientEmail || "",
    clientId: config.clientId || "",
    tokenUri: config.tokenUri || "",
    scope: config.scope || "",
    subject: config.subject || config.user || "",
  });
}

function buildSignedJwt(config = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: config.clientEmail,
    scope: config.scope,
    aud: config.tokenUri,
    iat: now,
    exp: now + 3600,
  };
  const subject = config.subject || config.user;
  if (subject) claims.sub = subject;
  const unsigned = `${base64urlEncode(JSON.stringify(header))}.${base64urlEncode(JSON.stringify(claims))}`;
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(unsigned)
    .end()
    .sign(config.privateKey);
  return `${unsigned}.${base64urlEncode(signature)}`;
}

function ensureConfigured(config = {}) {
  const authMode = String(config.authMode || "service_account").trim().toLowerCase();
  if (authMode === "refresh_token") {
    if (config.clientId && config.clientSecret && config.refreshToken && config.tokenUri) return;
  } else if (config.clientEmail && config.privateKey && config.tokenUri && config.scope) {
    return;
  }
  throw new ExternalServiceError("gmail", "Gmail mailbox ingest is not configured", {
    status: 500,
    retryable: false,
    details: {
      authMode,
      hasClientEmail: Boolean(config.clientEmail),
      hasPrivateKey: Boolean(config.privateKey),
      hasClientId: Boolean(config.clientId),
      hasClientSecret: Boolean(config.clientSecret),
      hasRefreshToken: Boolean(config.refreshToken),
      hasTokenUri: Boolean(config.tokenUri),
      hasScope: Boolean(config.scope),
    },
  });
}

async function requestAccessToken(config = {}) {
  ensureConfigured(config);
  const authMode = String(config.authMode || "service_account").trim().toLowerCase();
  const body = authMode === "refresh_token"
    ? new URLSearchParams({
      grant_type: "refresh_token",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
    })
    : new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: buildSignedJwt(config),
    });

  const response = await fetch(config.tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await response.text();
  const data = parseResponseBody(text);
  if (!response.ok || !data?.access_token) {
    throw new ExternalServiceError("gmail", `Gmail token request failed: ${response.status}`, {
      status: 502,
      retryable: response.status >= 500 || response.status === 429,
      details: {
        responseStatus: response.status,
        responseBody: data,
      },
    });
  }

  tokenState = {
    cacheKey: buildCacheKey(config),
    accessToken: data.access_token,
    expiresAt: Date.now() + Math.max((Number(data.expires_in) || 3600) - 60, 60) * 1000,
  };
  return tokenState.accessToken;
}

async function getAccessToken(config = {}) {
  ensureConfigured(config);
  const cacheKey = buildCacheKey(config);
  if (
    tokenState.cacheKey === cacheKey &&
    tokenState.accessToken &&
    Date.now() < tokenState.expiresAt
  ) {
    return tokenState.accessToken;
  }
  return requestAccessToken(config);
}

async function gmailRequest(config = {}, endpoint, options = {}) {
  const token = await getAccessToken(config);
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const data = parseResponseBody(text);
  if (!response.ok) {
    throw new ExternalServiceError("gmail", `Gmail request failed: ${response.status}`, {
      status: 502,
      retryable: response.status >= 500 || response.status === 429,
      details: {
        endpoint,
        responseStatus: response.status,
        responseBody: data,
      },
    });
  }
  return data;
}

function gmailUser(config = {}) {
  return encodeURIComponent(config.user || config.subject || "me");
}

function createGoogleGmailClient(config = {}) {
  return {
    listMessages({ query = "", maxResults = 10, pageToken = "" } = {}) {
      const params = new URLSearchParams();
      if (query) params.set("q", query);
      if (maxResults) params.set("maxResults", String(maxResults));
      if (pageToken) params.set("pageToken", pageToken);
      return gmailRequest(config, `/users/${gmailUser(config)}/messages?${params.toString()}`);
    },
    getMessage(id, { format = "full" } = {}) {
      const params = new URLSearchParams({ format });
      return gmailRequest(config, `/users/${gmailUser(config)}/messages/${encodeURIComponent(id)}?${params.toString()}`);
    },
    getAttachment(messageId, attachmentId) {
      return gmailRequest(
        config,
        `/users/${gmailUser(config)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
      );
    },
    modifyMessage(messageId, { addLabelIds = [], removeLabelIds = [] } = {}) {
      return gmailRequest(config, `/users/${gmailUser(config)}/messages/${encodeURIComponent(messageId)}/modify`, {
        method: "POST",
        body: JSON.stringify({ addLabelIds, removeLabelIds }),
      });
    },
    decodeData(data) {
      return base64urlDecode(data);
    },
  };
}

module.exports = {
  createGoogleGmailClient,
};
