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

function parseResponseBody(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

function buildCacheKey(config = {}) {
  return JSON.stringify({
    clientEmail: config.clientEmail || "",
    tokenUri: config.tokenUri || "",
    scope: config.scope || "",
  });
}

function isConfigured(config = {}) {
  return Boolean(
    config.clientEmail &&
      config.privateKey &&
      config.tokenUri &&
      config.scope,
  );
}

function ensureConfigured(config = {}) {
  if (isConfigured(config)) return;
  throw new ExternalServiceError(
    "google-drive",
    "Google Drive recording archive is not configured",
    {
      status: 500,
      retryable: false,
      details: {
        hasClientEmail: Boolean(config.clientEmail),
        hasPrivateKey: Boolean(config.privateKey),
        hasTokenUri: Boolean(config.tokenUri),
        hasScope: Boolean(config.scope),
      },
    },
  );
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
  const unsigned = `${base64urlEncode(JSON.stringify(header))}.${base64urlEncode(JSON.stringify(claims))}`;
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(unsigned)
    .end()
    .sign(config.privateKey);
  return `${unsigned}.${base64urlEncode(signature)}`;
}

async function requestAccessToken(config = {}) {
  ensureConfigured(config);

  const response = await fetch(config.tokenUri, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: buildSignedJwt(config),
    }).toString(),
  });

  const text = await response.text();
  const data = parseResponseBody(text);
  if (!response.ok || !data?.access_token) {
    throw new ExternalServiceError(
      "google-drive",
      `Google token request failed: ${response.status}`,
      {
        status: 502,
        retryable: response.status >= 500 || response.status === 429,
        details: {
          responseStatus: response.status,
          responseBody: data,
        },
      },
    );
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

function buildDriveUploadUrl(config = {}) {
  const url = new URL("https://www.googleapis.com/upload/drive/v3/files");
  url.searchParams.set("uploadType", "resumable");
  url.searchParams.set("fields", "id,name,mimeType,parents,webViewLink,webContentLink,size");
  if (config.supportsAllDrives) {
    url.searchParams.set("supportsAllDrives", "true");
  }
  return url.toString();
}

async function startResumableUpload(config = {}, metadata = {}, contentLength, mimeType) {
  const token = await getAccessToken(config);
  const response = await fetch(buildDriveUploadUrl(config), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": mimeType || "application/octet-stream",
      "X-Upload-Content-Length": String(contentLength || 0),
    },
    body: JSON.stringify(metadata),
  });

  const text = await response.text();
  const data = parseResponseBody(text);
  const uploadUrl = response.headers.get("location");
  if (!response.ok || !uploadUrl) {
    throw new ExternalServiceError(
      "google-drive",
      `Google Drive resumable init failed: ${response.status}`,
      {
        status: 502,
        retryable: response.status >= 500 || response.status === 429,
        details: {
          responseStatus: response.status,
          responseBody: data,
        },
      },
    );
  }

  return uploadUrl;
}

async function uploadFileResumable(config = {}, {
  folderId,
  name,
  mimeType = "application/octet-stream",
  buffer,
  description = null,
  appProperties = null,
} = {}) {
  ensureConfigured(config);
  if (!folderId) {
    throw new ExternalServiceError("google-drive", "Drive folderId is required", {
      status: 400,
      retryable: false,
    });
  }
  if (!name) {
    throw new ExternalServiceError("google-drive", "Drive file name is required", {
      status: 400,
      retryable: false,
    });
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new ExternalServiceError("google-drive", "Drive upload buffer is required", {
      status: 400,
      retryable: false,
    });
  }

  const metadata = {
    name,
    parents: [folderId],
  };
  if (description) metadata.description = description;
  if (appProperties && typeof appProperties === "object") {
    metadata.appProperties = appProperties;
  }

  const uploadUrl = await startResumableUpload(
    config,
    metadata,
    buffer.length,
    mimeType,
  );

  const token = await getAccessToken(config);
  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Length": String(buffer.length),
      "Content-Type": mimeType || "application/octet-stream",
    },
    body: buffer,
  });

  const text = await response.text();
  const data = parseResponseBody(text);
  if (!response.ok) {
    throw new ExternalServiceError(
      "google-drive",
      `Google Drive upload failed: ${response.status}`,
      {
        status: 502,
        retryable: response.status >= 500 || response.status === 429,
        details: {
          responseStatus: response.status,
          responseBody: data,
          folderId,
          name,
        },
      },
    );
  }

  return data;
}

/**
 * Search files by appProperties + parent folder. Used as a pre-upload
 * idempotency check so re-running the recording archive doesn't lay
 * down duplicate files for the same telephonySessionId.
 *
 * appProperties query escaping: Drive's `q` syntax wants single-quoted
 * string values with embedded `'` escaped as `\'`. Most telephony
 * sessionIds are alphanumeric so this is rarely an issue, but escape
 * defensively.
 */
async function findFilesByAppProperties(config = {}, {
  folderId = null,
  appProperties = {},
  pageSize = 10,
} = {}) {
  ensureConfigured(config);
  const entries = Object.entries(appProperties || {}).filter(([, value]) =>
    value != null && String(value).length > 0,
  );
  if (entries.length === 0) {
    throw new ExternalServiceError(
      "google-drive",
      "findFilesByAppProperties requires at least one appProperty",
      { status: 400, retryable: false },
    );
  }

  const escape = (value) => String(value).replace(/'/g, "\\'");
  const clauses = entries.map(
    ([key, value]) =>
      `appProperties has { key='${escape(key)}' and value='${escape(value)}' }`,
  );
  if (folderId) {
    clauses.push(`'${escape(folderId)}' in parents`);
  }
  clauses.push("trashed = false");
  const q = clauses.join(" and ");

  const token = await getAccessToken(config);
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("q", q);
  url.searchParams.set("fields", "files(id,name,mimeType,size,parents,appProperties,webViewLink,webContentLink,modifiedTime)");
  url.searchParams.set("pageSize", String(Math.max(1, Math.min(Number(pageSize) || 10, 100))));
  if (config.supportsAllDrives) {
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");
  }

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  const data = parseResponseBody(text);
  if (!response.ok) {
    throw new ExternalServiceError(
      "google-drive",
      `Google Drive search failed: ${response.status}`,
      {
        status: 502,
        retryable: response.status >= 500 || response.status === 429,
        details: { responseStatus: response.status, responseBody: data, q },
      },
    );
  }
  return Array.isArray(data?.files) ? data.files : [];
}

/**
 * Find a child folder by exact name under a parent folder. Used by
 * `ensureFolder` for the date-subfolder layout (`<bucket>/<dateKey>/`)
 * — caller passes parent = bucket folder id, name = e.g. "2026-04-22".
 *
 * Returns the first hit or null. Drive permits sibling folders with
 * identical names; we always take the first which is fine for our
 * controlled writer (we never create duplicates ourselves).
 */
async function findFolder(config = {}, { parentId, name } = {}) {
  ensureConfigured(config);
  if (!parentId || !name) {
    throw new ExternalServiceError(
      "google-drive",
      "findFolder requires parentId + name",
      { status: 400, retryable: false },
    );
  }
  const escape = (value) => String(value).replace(/'/g, "\\'");
  const q = [
    `'${escape(parentId)}' in parents`,
    `name = '${escape(name)}'`,
    "mimeType = 'application/vnd.google-apps.folder'",
    "trashed = false",
  ].join(" and ");

  const token = await getAccessToken(config);
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("q", q);
  url.searchParams.set("fields", "files(id,name,parents)");
  url.searchParams.set("pageSize", "10");
  if (config.supportsAllDrives) {
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");
  }

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  const data = parseResponseBody(text);
  if (!response.ok) {
    throw new ExternalServiceError(
      "google-drive",
      `Google Drive findFolder failed: ${response.status}`,
      {
        status: 502,
        retryable: response.status >= 500 || response.status === 429,
        details: { responseStatus: response.status, responseBody: data, q },
      },
    );
  }
  const files = Array.isArray(data?.files) ? data.files : [];
  return files[0] || null;
}

/**
 * Create a child folder under a parent. Mostly used as the second half
 * of `ensureFolder`'s find-or-create path.
 */
async function createFolder(config = {}, { parentId, name } = {}) {
  ensureConfigured(config);
  if (!parentId || !name) {
    throw new ExternalServiceError(
      "google-drive",
      "createFolder requires parentId + name",
      { status: 400, retryable: false },
    );
  }
  const token = await getAccessToken(config);
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("fields", "id,name,parents");
  if (config.supportsAllDrives) {
    url.searchParams.set("supportsAllDrives", "true");
  }
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify({
      name,
      parents: [parentId],
      mimeType: "application/vnd.google-apps.folder",
    }),
  });
  const text = await response.text();
  const data = parseResponseBody(text);
  if (!response.ok) {
    throw new ExternalServiceError(
      "google-drive",
      `Google Drive createFolder failed: ${response.status}`,
      {
        status: 502,
        retryable: response.status >= 500 || response.status === 429,
        details: { responseStatus: response.status, responseBody: data, parentId, name },
      },
    );
  }
  return data;
}

/**
 * Find-or-create. Caller-side caches keyed by `${parentId}:${name}`
 * remove redundant Drive round-trips inside batch operations like the
 * EOD archiver (one bucket × one dateKey reused across many files).
 */
async function ensureFolder(config = {}, { parentId, name } = {}) {
  const existing = await findFolder(config, { parentId, name });
  if (existing) return existing;
  return createFolder(config, { parentId, name });
}

/**
 * Move a file between folders by adjusting its `parents` collection.
 * Drive's PATCH `?addParents=&removeParents=` is atomic — the file is
 * never parentless mid-operation. Used by the one-time
 * `reorganize-recordings-to-date-folders.js` migration.
 */
async function moveFile(config = {}, { fileId, addParents = [], removeParents = [] } = {}) {
  ensureConfigured(config);
  if (!fileId) {
    throw new ExternalServiceError("google-drive", "moveFile requires fileId", {
      status: 400,
      retryable: false,
    });
  }
  const add = (Array.isArray(addParents) ? addParents : [addParents])
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const remove = (Array.isArray(removeParents) ? removeParents : [removeParents])
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  if (add.length === 0 && remove.length === 0) {
    throw new ExternalServiceError(
      "google-drive",
      "moveFile requires at least one of addParents/removeParents",
      { status: 400, retryable: false },
    );
  }

  const token = await getAccessToken(config);
  const url = new URL(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`,
  );
  if (add.length) url.searchParams.set("addParents", add.join(","));
  if (remove.length) url.searchParams.set("removeParents", remove.join(","));
  url.searchParams.set("fields", "id,name,parents");
  if (config.supportsAllDrives) {
    url.searchParams.set("supportsAllDrives", "true");
  }
  const response = await fetch(url.toString(), {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: "{}",
  });
  const text = await response.text();
  const data = parseResponseBody(text);
  if (!response.ok) {
    throw new ExternalServiceError(
      "google-drive",
      `Google Drive moveFile failed: ${response.status}`,
      {
        status: 502,
        retryable: response.status >= 500 || response.status === 429,
        details: {
          responseStatus: response.status,
          responseBody: data,
          fileId,
          addParents: add,
          removeParents: remove,
        },
      },
    );
  }
  return data;
}

/**
 * Page through files under a parent folder. Used by the one-time
 * migration to enumerate flat-archived recordings, and by anything else
 * that needs full-folder enumeration (the appProperties path is faster
 * when the caller has a key, but here we need every direct child).
 *
 * Pass mimeType to filter (string for one type, array for OR-set, or
 * `"!folder"`-style "not equal" by prefixing with "!"). Skipping it
 * returns everything including subfolders.
 */
async function listFilesInFolder(config = {}, {
  parentId,
  mimeType = null,
  pageSize = 100,
  pageToken = null,
  fields = "nextPageToken, files(id,name,mimeType,parents,appProperties,size,modifiedTime)",
} = {}) {
  ensureConfigured(config);
  if (!parentId) {
    throw new ExternalServiceError(
      "google-drive",
      "listFilesInFolder requires parentId",
      { status: 400, retryable: false },
    );
  }
  const escape = (value) => String(value).replace(/'/g, "\\'");
  const clauses = [`'${escape(parentId)}' in parents`, "trashed = false"];
  if (mimeType) {
    if (Array.isArray(mimeType)) {
      const orClauses = mimeType
        .filter(Boolean)
        .map((mime) => `mimeType = '${escape(mime)}'`)
        .join(" or ");
      if (orClauses) clauses.push(`(${orClauses})`);
    } else if (String(mimeType).startsWith("!")) {
      clauses.push(`mimeType != '${escape(String(mimeType).slice(1))}'`);
    } else {
      clauses.push(`mimeType = '${escape(mimeType)}'`);
    }
  }
  const q = clauses.join(" and ");

  const token = await getAccessToken(config);
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("q", q);
  url.searchParams.set("fields", fields);
  url.searchParams.set(
    "pageSize",
    String(Math.max(1, Math.min(Number(pageSize) || 100, 1000))),
  );
  if (pageToken) url.searchParams.set("pageToken", pageToken);
  if (config.supportsAllDrives) {
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");
  }

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  const data = parseResponseBody(text);
  if (!response.ok) {
    throw new ExternalServiceError(
      "google-drive",
      `Google Drive listFilesInFolder failed: ${response.status}`,
      {
        status: 502,
        retryable: response.status >= 500 || response.status === 429,
        details: { responseStatus: response.status, responseBody: data, q },
      },
    );
  }
  return {
    files: Array.isArray(data?.files) ? data.files : [],
    nextPageToken: data?.nextPageToken || null,
  };
}

/**
 * Download a Drive file's binary content as a Buffer.
 *
 * Used by the transcription pipeline (transcriptionScoringService) to
 * read recordings that the recordingArchive pipeline already pulled
 * down + uploaded — sidesteps the RingCentral CDN entirely so a
 * RingCentral rate-limit doesn't wedge transcription.
 *
 * Returns { buffer, mimeType, contentLength }. Throws ExternalServiceError
 * on non-OK responses with `retryable` set on 5xx / 429.
 */
async function downloadFile(config = {}, { fileId, supportsAllDrives = true } = {}) {
  if (!fileId) {
    throw new Error("downloadFile: fileId is required");
  }
  const token = await getAccessToken(config);
  const url = new URL(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`,
  );
  url.searchParams.set("alt", "media");
  if (supportsAllDrives) {
    url.searchParams.set("supportsAllDrives", "true");
  }

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new ExternalServiceError(
      "google-drive",
      `Google Drive downloadFile failed: ${response.status}`,
      {
        status: 502,
        retryable: response.status >= 500 || response.status === 429,
        details: {
          responseStatus: response.status,
          responseBody: text.slice(0, 500),
          fileId,
        },
      },
    );
  }
  const mimeType = response.headers.get("content-type") || "application/octet-stream";
  const contentLength = Number(response.headers.get("content-length") || 0) || null;
  const buffer = Buffer.from(await response.arrayBuffer());
  return { buffer, mimeType, contentLength };
}

function createGoogleDriveClient(config = {}) {
  return {
    config,
    isConfigured: () => isConfigured(config),
    getAccessToken: () => getAccessToken(config),
    findFilesByAppProperties: (options) => findFilesByAppProperties(config, options),
    uploadFileResumable: (options) => uploadFileResumable(config, options),
    downloadFile: (options) => downloadFile(config, options),
    findFolder: (options) => findFolder(config, options),
    createFolder: (options) => createFolder(config, options),
    ensureFolder: (options) => ensureFolder(config, options),
    moveFile: (options) => moveFile(config, options),
    listFilesInFolder: (options) => listFilesInFolder(config, options),
  };
}

module.exports = {
  createGoogleDriveClient,
  isGoogleDriveConfigured: isConfigured,
};
