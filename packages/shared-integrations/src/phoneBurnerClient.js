"use strict";

const { createHash } = require("crypto");
const { decryptField, encryptField } = require("../../shared-auth/src/fieldCrypto");
const { requestJson } = require("./httpClient");

const DEFAULT_REST_BASE_URL = "https://www.phoneburner.com/rest/1/";
const DEFAULT_OAUTH_BASE_URL = "https://www.phoneburner.com/oauth/";
const EXTERNAL_ID_CUSTOM_FIELD = "Lead Delivery External ID";
const EXTERNAL_CRM_NAMESPACE = "TagContactBridge Lead Delivery";
const AMBIGUOUS_CONTACT_STATUSES = new Set([408, 500, 502, 503, 504]);

function requireText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  return value.trim();
}

function optionalText(value, name) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value.trim() || null;
}

function positiveId(value, name, { numeric = false } = {}) {
  const raw = typeof value === "number" ? String(value) : value;
  if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw.trim())) {
    throw new TypeError(`${name} must be a positive integer identifier`);
  }
  const normalized = raw.trim();
  if (!numeric) return normalized;
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) throw new TypeError(`${name} is outside the supported integer range`);
  return parsed;
}

function boundedInteger(value, name, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER, fallback } = {}) {
  if ((value == null || value === "") && fallback !== undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function retryAfterMilliseconds(headers) {
  if (!headers) return null;
  let value = null;
  try {
    if (typeof headers.get === "function") {
      value = headers.get("retry-after");
    } else if (typeof headers === "object") {
      const match = Object.entries(headers)
        .find(([name]) => String(name).toLowerCase() === "retry-after");
      value = match?.[1] ?? null;
    }
  } catch {
    return null;
  }
  if (Array.isArray(value)) value = value[0];
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (!text || text.length > 128) return null;
  if (/^\d+$/.test(text)) {
    const milliseconds = Number(text) * 1_000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : null;
  }
  const deadline = Date.parse(text);
  return Number.isFinite(deadline) ? Math.max(0, deadline - Date.now()) : null;
}

function normalizeResponse(value) {
  const status = Number(value?.status ?? value?.statusCode ?? 0);
  const retryAfterMs = retryAfterMilliseconds(value?.headers);
  return {
    ok: typeof value?.ok === "boolean" ? value.ok : status >= 200 && status < 300,
    status: Number.isFinite(status) ? status : 0,
    data: value?.data ?? value?.body ?? null,
    ...(retryAfterMs == null ? {} : { retryAfterMs }),
  };
}

function buildUrl(baseUrl, path, query = null) {
  const url = new URL(String(path || "").replace(/^\/+/, ""), baseUrl);
  for (const [key, value] of Object.entries(query || {})) {
    if (value != null && value !== "") url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function createDefaultTransport() {
  return {
    async request({ method = "GET", url, headers = {}, json, form, timeoutMs }) {
      const nextHeaders = { ...headers };
      let body;
      if (json !== undefined) {
        nextHeaders["Content-Type"] ||= "application/json";
        body = JSON.stringify(json);
      } else if (form !== undefined) {
        nextHeaders["Content-Type"] ||= "application/x-www-form-urlencoded";
        body = new URLSearchParams(form).toString();
      }
      return requestJson(url, { method, headers: nextHeaders, body }, { retries: 0, timeoutMs });
    },
  };
}

function createPhoneBurnerEnvironmentCredentialStore({ env = process.env } = {}) {
  if (!env || typeof env !== "object") throw new TypeError("env must be an object");
  return {
    async read() {
      return {
        accessToken: env.PB_HOT_SEAT_TOKEN || null,
        refreshToken: env.PB_REFRESH_TOKEN || null,
        clientId: env.PB_CLIENT_ID || null,
        clientSecret: env.PB_CLIENT_SECRET || null,
      };
    },
    async writeTokens(tokens = {}) {
      if (tokens.accessToken) env.PB_HOT_SEAT_TOKEN = String(tokens.accessToken);
      if (tokens.refreshToken) env.PB_REFRESH_TOKEN = String(tokens.refreshToken);
    },
  };
}

function createPhoneBurnerDurableCredentialStore({
  env = process.env,
  serviceEmail,
  credentialRepository,
  encrypt = encryptField,
  decrypt = decryptField,
  now = () => new Date(),
} = {}) {
  if (!env || typeof env !== "object") throw new TypeError("env must be an object");
  const normalizedServiceEmail = requireText(serviceEmail, "serviceEmail").toLowerCase();
  if (
    !credentialRepository
    || typeof credentialRepository.readServiceProviderCredentialPair !== "function"
    || typeof credentialRepository.writeServiceProviderCredentialPair !== "function"
  ) {
    throw new TypeError("credentialRepository read/write pair methods are required");
  }
  if (typeof encrypt !== "function" || typeof decrypt !== "function") {
    throw new TypeError("encrypt and decrypt are required");
  }
  if (typeof now !== "function") throw new TypeError("now must be a function");

  function currentDate() {
    const value = now();
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error("phoneburner credential clock failed");
    return date;
  }

  function recordRevision(record) {
    const revision = Number(record?.revision ?? 0);
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new Error("phoneburner stored credential metadata is invalid");
    }
    return revision;
  }

  function decodeStoredPair(record) {
    if (!record) return null;
    const accessCiphertext = optionalText(record.accessTokenEnc, "accessTokenEnc");
    const refreshCiphertext = optionalText(record.refreshTokenEnc, "refreshTokenEnc");
    if (!accessCiphertext && !refreshCiphertext) {
      if (recordRevision(record) > 0) {
        throw new Error("phoneburner stored credential pair is incomplete");
      }
      return null;
    }
    if (!accessCiphertext || !refreshCiphertext) {
      throw new Error("phoneburner stored credential pair is incomplete");
    }

    let accessToken;
    let refreshToken;
    try {
      accessToken = optionalText(decrypt(accessCiphertext), "accessToken");
      refreshToken = optionalText(decrypt(refreshCiphertext), "refreshToken");
    } catch {
      throw new Error("phoneburner stored credential decryption failed");
    }
    if (!accessToken || !refreshToken) {
      throw new Error("phoneburner stored credential decryption failed");
    }
    return { accessToken, refreshToken };
  }

  function encryptPair(accessToken, refreshToken) {
    let accessTokenEnc;
    let refreshTokenEnc;
    try {
      accessTokenEnc = optionalText(encrypt(accessToken), "accessTokenEnc");
      refreshTokenEnc = optionalText(encrypt(refreshToken), "refreshTokenEnc");
    } catch {
      throw new Error("phoneburner credential encryption failed");
    }
    if (!accessTokenEnc || !refreshTokenEnc) {
      throw new Error("phoneburner credential encryption failed");
    }
    return { accessTokenEnc, refreshTokenEnc };
  }

  function clientCredentials(pair) {
    return {
      ...pair,
      clientId: optionalText(env.PB_CLIENT_ID, "clientId"),
      clientSecret: optionalText(env.PB_CLIENT_SECRET, "clientSecret"),
    };
  }

  async function readRecord() {
    return credentialRepository.readServiceProviderCredentialPair({
      serviceEmail: normalizedServiceEmail,
      provider: "phoneburner",
    });
  }

  async function read() {
    let record = await readRecord();
    let pair = decodeStoredPair(record);
    if (!pair) {
      const accessToken = optionalText(env.PB_HOT_SEAT_TOKEN, "accessToken");
      const refreshToken = optionalText(env.PB_REFRESH_TOKEN, "refreshToken");
      if (!accessToken || !refreshToken) {
        throw new Error("phoneburner credential bootstrap unavailable");
      }
      const encrypted = encryptPair(accessToken, refreshToken);
      const migratedAt = currentDate();
      await credentialRepository.writeServiceProviderCredentialPair({
        serviceEmail: normalizedServiceEmail,
        provider: "phoneburner",
        ...encrypted,
        tokenType: "bearer",
        accessTokenExpiresAt: null,
        expectedRevision: recordRevision(record),
        migratedAt,
        refreshedAt: migratedAt,
      });

      // Mongo is authoritative immediately, including when another process
      // won the revision-zero bootstrap race. Never keep serving the env pair.
      record = await readRecord();
      pair = decodeStoredPair(record);
      if (!pair) throw new Error("phoneburner credential bootstrap failed");
    }
    return clientCredentials(pair);
  }

  function accessTokenExpiry(tokens, at) {
    const explicit = tokens.expiresAt;
    if (explicit != null && explicit !== "") {
      const numeric = typeof explicit === "number" || /^\d+$/.test(String(explicit).trim())
        ? Number(explicit)
        : null;
      const date = numeric != null && Number.isFinite(numeric)
        ? new Date(numeric < 1_000_000_000_000 ? numeric * 1000 : numeric)
        : new Date(explicit);
      if (Number.isFinite(date.getTime())) return date;
    }
    const expiresIn = Number(tokens.expiresIn);
    if (Number.isFinite(expiresIn) && expiresIn > 0) {
      return new Date(at.getTime() + Math.floor(expiresIn * 1000));
    }
    return null;
  }

  async function writeTokens(tokens = {}) {
    const accessToken = requireText(tokens.accessToken, "accessToken");
    const refreshToken = requireText(tokens.refreshToken, "refreshToken");
    const record = await readRecord();
    if (!decodeStoredPair(record)) {
      throw new Error("phoneburner credential store is not initialized");
    }
    const encrypted = encryptPair(accessToken, refreshToken);
    const refreshedAt = currentDate();
    const written = await credentialRepository.writeServiceProviderCredentialPair({
      serviceEmail: normalizedServiceEmail,
      provider: "phoneburner",
      ...encrypted,
      tokenType: optionalText(tokens.tokenType, "tokenType") || "bearer",
      accessTokenExpiresAt: accessTokenExpiry(tokens, refreshedAt),
      expectedRevision: recordRevision(record),
      refreshedAt,
    });
    if (!written) throw new Error("phoneburner credential write conflict");
  }

  return { read, writeTokens };
}

function arrayFrom(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

function isCollectionShape(value) {
  return Array.isArray(value) || Boolean(value && typeof value === "object");
}

function integerMetadata(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function providerId(value) {
  const normalized = String(value ?? "").trim();
  return /^[1-9]\d*$/.test(normalized) ? normalized : null;
}

function providerText(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  return String(value).trim() || null;
}

function providerHttpsUrl(value) {
  const normalized = providerText(value);
  if (!normalized || normalized.length > 2048) return null;
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function providerBoolean(value) {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return null;
}

function controlledCustomFields(contact) {
  return arrayFrom(contact?.custom_fields ?? contact?.customFields)
    .filter((field) => String(field?.name || field?.display_name || "") === EXTERNAL_ID_CUSTOM_FIELD)
    .map((field) => ({
      name: EXTERNAL_ID_CUSTOM_FIELD,
      type: Number(field?.type ?? field?.type_id ?? 1),
      value: field?.value == null ? null : String(field.value),
    }));
}

function controlledExternalCrmData(contact) {
  return arrayFrom(contact?.external_crm_data ?? contact?.externalCrmData)
    .filter((entry) => String(entry?.crm_name || entry?.crmName || entry?.namespace || "") === EXTERNAL_CRM_NAMESPACE)
    .map((entry) => ({
      namespace: EXTERNAL_CRM_NAMESPACE,
      externalId: (entry?.crm_id ?? entry?.externalId) == null
        ? null
        : String(entry?.crm_id ?? entry?.externalId),
    }));
}

function normalizeContactIdentity(contact) {
  if (!contact || typeof contact !== "object") return null;
  const contactId = providerId(contact.contact_user_id ?? contact.user_id ?? contact.contactId);
  return {
    contactId,
    ownerId: String(contact.owner_id ?? contact.ownerId ?? "").trim() || null,
    folderId: String(contact.category_id ?? contact.category?.category_id ?? contact.folderId ?? "").trim() || null,
    leadId: String(contact.lead_id ?? contact.leadId ?? "").trim() || null,
    customFields: controlledCustomFields(contact),
    externalCrmData: controlledExternalCrmData(contact),
  };
}

function hasExactExternalIdentity(contact, externalLeadId) {
  const identity = normalizeContactIdentity(contact);
  if (!identity) return false;
  if (identity.leadId === externalLeadId) return true;
  if (identity.customFields.some((field) => field.value === externalLeadId)) return true;
  return identity.externalCrmData.some((entry) => entry.externalId === externalLeadId);
}

function extractCreatedContactId(data) {
  return providerId(data?.contacts?.contacts?.contact_user_id);
}

function normalizeSession(value, { includeCalls = false } = {}) {
  if (!value || typeof value !== "object") return null;
  const session = {
    dialSessionId: providerId(value.dialsession_id),
    startedAt: providerText(value.start_when),
    endedAt: providerText(value.end_when),
    connectedAt: providerText(value.connected_when),
    disconnectedAt: providerText(value.disconnected_when),
    callCount: integerMetadata(value.call_count),
    sourceTimeZone: "Central",
  };
  if (includeCalls) {
    // Keep this a narrow whitelist. The recording URL is the only added
    // evidence needed downstream; phone, notes, caller ID, and transcript
    // content remain outside the normalized provider contract.
    session.calls = arrayFrom(value.calls).map((call) => ({
      callId: providerId(call?.call_id),
      startedAt: providerText(call?.start_when),
      endedAt: providerText(call?.end_when),
      connected: providerBoolean(call?.connected),
      voicemail: providerBoolean(call?.voicemail),
      disposition: providerText(call?.disposition),
      recordingUrl: providerHttpsUrl(call?.recording_url),
      sourceTimeZone: "Central",
    }));
  }
  return session;
}

function createPhoneBurnerClient({
  transport = createDefaultTransport(),
  credentialStore,
  logger = null,
  baseUrl = DEFAULT_REST_BASE_URL,
  oauthBaseUrl = DEFAULT_OAUTH_BASE_URL,
  timeoutMs = 15_000,
  maxReconciliationPages = 100,
  refreshOnUnauthorized = true,
} = {}) {
  if (!transport || typeof transport.request !== "function") {
    throw new TypeError("transport.request is required");
  }
  if (!credentialStore || typeof credentialStore.read !== "function" || typeof credentialStore.writeTokens !== "function") {
    throw new TypeError("credentialStore.read and credentialStore.writeTokens are required");
  }
  const requestTimeoutMs = boundedInteger(timeoutMs, "timeoutMs", { minimum: 1 });
  const reconciliationPageLimit = boundedInteger(maxReconciliationPages, "maxReconciliationPages", { minimum: 1 });
  if (typeof refreshOnUnauthorized !== "boolean") {
    throw new TypeError("refreshOnUnauthorized must be a boolean");
  }
  const restBase = `${new URL(baseUrl).toString().replace(/\/+$/, "")}/`;
  const oauthBase = `${new URL(oauthBaseUrl).toString().replace(/\/+$/, "")}/`;
  let refreshInFlight = null;

  function log(level, event, details = {}) {
    try {
      const writer = logger?.[level];
      if (typeof writer !== "function") return;
      writer.call(logger, event, details);
    } catch {
      // Observability must never change delivery/reconciliation behavior.
    }
  }

  function workHash(externalLeadId) {
    return createHash("sha256").update(externalLeadId).digest("hex").slice(0, 16);
  }

  async function readCredentials() {
    try {
      const credentials = await credentialStore.read();
      const accessToken = optionalText(credentials?.accessToken ?? credentials?.access_token, "accessToken");
      if (!accessToken) throw new Error("missing access token");
      return {
        accessToken,
        refreshToken: optionalText(credentials?.refreshToken ?? credentials?.refresh_token, "refreshToken"),
        clientId: optionalText(credentials?.clientId ?? credentials?.client_id, "clientId"),
        clientSecret: optionalText(credentials?.clientSecret ?? credentials?.client_secret, "clientSecret"),
      };
    } catch {
      throw new Error("phoneburner credential read failed");
    }
  }

  async function doRefreshAccessToken() {
    const credentials = await readCredentials();
    if (!credentials.refreshToken || !credentials.clientId || !credentials.clientSecret) {
      throw new Error("phoneburner refresh credentials unavailable");
    }
    let response;
    try {
      response = normalizeResponse(await transport.request({
        method: "POST",
        url: buildUrl(oauthBase, "refreshtoken"),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        form: {
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
          refresh_token: credentials.refreshToken,
          grant_type: "refresh_token",
        },
        timeoutMs: requestTimeoutMs,
      }));
    } catch {
      throw new Error("phoneburner token refresh failed");
    }
    const accessToken = optionalText(response.data?.access_token ?? response.data?.accessToken, "accessToken");
    if (!response.ok || !accessToken) throw new Error("phoneburner token refresh failed");
    const refreshToken = optionalText(response.data?.refresh_token ?? response.data?.refreshToken, "refreshToken")
      || credentials.refreshToken;
    try {
      await credentialStore.writeTokens({
        accessToken,
        refreshToken,
        tokenType: optionalText(response.data?.token_type, "tokenType") || "bearer",
        expiresAt: response.data?.expires ?? null,
        expiresIn: response.data?.expires_in ?? null,
      });
    } catch {
      throw new Error("phoneburner token persistence failed");
    }
    return accessToken;
  }

  function refreshAccessToken() {
    if (!refreshInFlight) {
      refreshInFlight = doRefreshAccessToken().finally(() => {
        refreshInFlight = null;
      });
    }
    return refreshInFlight;
  }

  async function authorizedRequest(spec, { budget = null } = {}) {
    const credentials = await readCredentials();
    const send = async (accessToken) => {
      if (budget && budget.used >= budget.maximum) return { budgetExhausted: true };
      if (budget) budget.used += 1;
      return normalizeResponse(await transport.request({
        ...spec,
        headers: {
          ...(spec.headers || {}),
          Authorization: `Bearer ${accessToken}`,
        },
        timeoutMs: requestTimeoutMs,
      }));
    };
    const first = await send(credentials.accessToken);
    if (first.budgetExhausted || first.status !== 401) return first;
    if (!refreshOnUnauthorized) {
      return { ok: false, status: 401, data: null, reason: "auth_failed" };
    }
    if (budget && budget.used >= budget.maximum) {
      return { ok: false, status: 401, data: null, reason: "auth_failed", budgetExhausted: true };
    }
    let accessToken;
    try {
      const latestCredentials = await readCredentials();
      accessToken = latestCredentials.accessToken !== credentials.accessToken
        ? latestCredentials.accessToken
        : await refreshAccessToken();
    } catch {
      return { ok: false, status: 401, data: null, reason: "auth_failed" };
    }
    const replay = await send(accessToken);
    if (replay.budgetExhausted || replay.status === 401) {
      return { ok: false, status: 401, data: null, reason: "auth_failed", budgetExhausted: replay.budgetExhausted === true };
    }
    return replay;
  }

  async function readOperation(spec, operation) {
    try {
      return await authorizedRequest(spec);
    } catch {
      log("warn", "phoneburner.read_failed", { operation, reason: "transport_error" });
      return { ok: false, status: 0, data: null, reason: "transport_error" };
    }
  }

  function buildContactPayload(input) {
    const folderId = positiveId(input.folderId, "folderId");
    const externalLeadId = requireText(input.externalLeadId, "externalLeadId");
    const phone = requireText(input.phone, "phone");
    const hasOwnerId = input.ownerId != null && input.ownerId !== "";
    const hasOwnerUsername = input.ownerUsername != null && input.ownerUsername !== "";
    if (hasOwnerId && hasOwnerUsername) {
      throw new TypeError("ownerId and ownerUsername are mutually exclusive");
    }
    if (input.customFields != null && !Array.isArray(input.customFields)) {
      throw new TypeError("customFields must be an array");
    }
    const customFields = (input.customFields || [])
      .filter((field) => String(field?.name || "") !== EXTERNAL_ID_CUSTOM_FIELD)
      .map((field) => ({ ...field }));
    customFields.push({ name: EXTERNAL_ID_CUSTOM_FIELD, type: 1, value: externalLeadId });
    const payload = {
      category_id: folderId,
      lead_id: externalLeadId,
      phone,
      duplicate_checks: { phone: false, email: false },
      on_duplicate: "skip",
      allow_duplicates: 1,
      custom_fields: customFields,
    };
    if (hasOwnerId) payload.owner_id = positiveId(input.ownerId, "ownerId", { numeric: true });
    if (hasOwnerUsername) payload.owner_username = requireText(input.ownerUsername, "ownerUsername");
    for (const [target, source] of [["first_name", "firstName"], ["last_name", "lastName"], ["email", "email"]]) {
      const value = optionalText(input[source], source);
      if (value) payload[target] = value;
    }
    if (input.tags != null) {
      if (!Array.isArray(input.tags)) throw new TypeError("tags must be an array");
      payload.tags = input.tags.map((tag) => requireText(tag, "tag"));
    }
    return { folderId, externalLeadId, payload };
  }

  async function getContact(contactId) {
    const id = positiveId(contactId, "contactId");
    const response = await readOperation({ method: "GET", url: buildUrl(restBase, `contacts/${encodeURIComponent(id)}`) }, "get_contact");
    if (!response.ok || response.data?.status !== "success") {
      return { ok: false, httpStatus: response.status, reason: response.reason || "provider_rejected" };
    }
    const raw = response.data?.contacts?.contacts ?? response.data?.contact?.contact ?? response.data?.contact;
    const contact = normalizeContactIdentity(Array.isArray(raw) ? raw[0] : raw);
    if (!contact?.contactId || contact.contactId !== id) {
      return { ok: false, httpStatus: response.status, reason: "provider_schema_error" };
    }
    return { ok: true, httpStatus: response.status, contact };
  }

  async function listFolderContacts(folderId, options = {}) {
    const categoryId = positiveId(folderId, "folderId");
    const page = boundedInteger(options.page, "page", { minimum: 1, fallback: 1 });
    const pageSize = boundedInteger(options.pageSize, "pageSize", { minimum: 1, maximum: 100, fallback: 100 });
    const response = await readOperation({
      method: "GET",
      url: buildUrl(restBase, "contacts", {
        category_id: categoryId,
        page,
        page_size: pageSize,
        sort_order: options.sortOrder || "ASC",
      }),
    }, "list_folder_contacts");
    if (!response.ok || response.data?.status !== "success") {
      return {
        ok: false,
        httpStatus: response.status,
        reason: response.reason || "provider_rejected",
        ...(response.retryAfterMs == null ? {} : { retryAfterMs: response.retryAfterMs }),
      };
    }
    const envelope = response.data?.contacts;
    if (!envelope || typeof envelope !== "object") {
      return { ok: false, httpStatus: response.status, reason: "provider_schema_error" };
    }
    if (!isCollectionShape(envelope.contacts)) {
      return { ok: false, httpStatus: response.status, reason: "provider_schema_error" };
    }
    const rawContacts = arrayFrom(envelope.contacts);
    const actualPage = integerMetadata(envelope.page);
    const actualPageSize = integerMetadata(envelope.page_size);
    const totalPages = integerMetadata(envelope.total_pages);
    const totalResults = integerMetadata(envelope.total_results);
    const emptyCollection = totalPages === 0
      && totalResults === 0
      && rawContacts.length === 0;
    const requestedPageCount = emptyCollection || totalResults == null
      ? 0
      : Math.ceil(totalResults / pageSize);
    const reportedPageCount = emptyCollection || totalResults == null || actualPageSize < 1
      ? 0
      : Math.ceil(totalResults / actualPageSize);
    const logicalPageSize = emptyCollection
      ? 0
      : totalPages === requestedPageCount
        ? pageSize
        : totalPages === reportedPageCount
          ? actualPageSize
          : null;
    const expectedPageCount = logicalPageSize == null
      ? null
      : emptyCollection
        ? 0
        : Math.ceil(totalResults / logicalPageSize);
    const expectedRowsOnPage = totalPages === 0
      ? 0
      : (actualPage < totalPages
        ? logicalPageSize
        : totalResults - (logicalPageSize * (totalPages - 1)));
    // PhoneBurner reports the requested page_size on full pages but may report
    // the actual row count on the final partial page. Accept either shape while
    // still proving total_pages and the exact number of returned identities.
    const pageSizeValid = emptyCollection
      ? actualPageSize === 0 || (actualPageSize >= 1 && actualPageSize <= pageSize)
      : actualPageSize >= 1
        && actualPageSize <= pageSize
        && logicalPageSize != null
        && (actualPageSize === logicalPageSize || actualPageSize === expectedRowsOnPage);
    const normalizedContacts = rawContacts.map(normalizeContactIdentity);
    const metadataInvalid = actualPage == null
      || actualPageSize == null
      || !pageSizeValid
      || totalPages == null
      || totalResults == null
      || actualPage !== page
      || rawContacts.length !== expectedRowsOnPage
      || totalPages !== expectedPageCount
      || rawContacts.length !== expectedRowsOnPage
      || normalizedContacts.some((contact) => !contact?.contactId)
      || (totalPages === 0 && (totalResults !== 0 || rawContacts.length !== 0))
      || (totalPages > 0 && actualPage > totalPages);
    if (metadataInvalid) {
      return { ok: false, httpStatus: response.status, reason: "provider_schema_error" };
    }
    return {
      ok: true,
      httpStatus: response.status,
      folderId: categoryId,
      page: actualPage,
      pageSize: actualPageSize,
      totalPages,
      totalResults,
      contacts: normalizedContacts,
    };
  }

  async function getFolderCount(folderId) {
    const page = await listFolderContacts(folderId, { page: 1, pageSize: 1 });
    return page.ok
      ? { ok: true, httpStatus: page.httpStatus, folderId: page.folderId, count: page.totalResults }
      : page;
  }

  async function reconcileExternalIdentity(externalLeadId, folderIds) {
    const matches = new Map();
    for (const folderId of folderIds) {
      let pageNumber = 1;
      let expectedTotalPages = null;
      let expectedTotalResults = null;
      let observedContacts = 0;
      const observedContactIds = new Set();
      while (true) {
        if (pageNumber > reconciliationPageLimit) return { status: "incomplete" };
        const page = await listFolderContacts(folderId, { page: pageNumber, pageSize: 100 });
        if (!page.ok) return { status: "incomplete" };
        if (expectedTotalPages == null) {
          expectedTotalPages = page.totalPages;
          expectedTotalResults = page.totalResults;
        } else if (page.totalPages !== expectedTotalPages || page.totalResults !== expectedTotalResults) {
          return { status: "incomplete" };
        }
        for (const contact of page.contacts) {
          if (observedContactIds.has(contact.contactId)) return { status: "incomplete" };
          observedContactIds.add(contact.contactId);
          observedContacts += 1;
          if (contact.folderId && contact.folderId !== folderId) return { status: "incomplete" };
          if (!hasExactExternalIdentity(contact, externalLeadId)) continue;
          if (!contact.contactId) return { status: "incomplete" };
          matches.set(contact.contactId, contact);
        }
        if (expectedTotalPages === 0 || pageNumber >= expectedTotalPages) break;
        pageNumber += 1;
      }
      if (observedContacts !== expectedTotalResults) return { status: "incomplete" };
    }
    if (matches.size === 1) return { status: "matched", contactId: [...matches.keys()][0] };
    if (matches.size > 1) return { status: "conflict" };
    return { status: "absent" };
  }

  function contactFailure(status, reason, budget, httpStatus = 0) {
    return { ok: false, status, reason, httpStatus, postAttempts: budget.used };
  }

  async function createContact(input = {}) {
    const { folderId, externalLeadId, payload } = buildContactPayload(input);
    if (input.reconcileBeforePost != null && typeof input.reconcileBeforePost !== "boolean") {
      throw new TypeError("reconcileBeforePost must be a boolean");
    }
    if (input.reconciliationFolderIds != null && !Array.isArray(input.reconciliationFolderIds)) {
      throw new TypeError("reconciliationFolderIds must be an array");
    }
    const reconciliationFolderIds = [...new Set([
      folderId,
      ...arrayFrom(input.reconciliationFolderIds).map((value) => positiveId(value, "reconciliationFolderId")),
    ])];
    const budget = { used: 0, maximum: 2 };
    const identityHash = workHash(externalLeadId);
    if (input.reconcileBeforePost === true) {
      const reconciliation = await reconcileExternalIdentity(externalLeadId, reconciliationFolderIds);
      if (reconciliation.status === "matched") {
        return {
          ok: true,
          status: "accepted",
          httpStatus: 200,
          contactId: reconciliation.contactId,
          reconciled: true,
          postAttempts: 0,
        };
      }
      if (reconciliation.status === "conflict") {
        return contactFailure("identity_conflict", "multiple_external_identity_matches", budget);
      }
      if (reconciliation.status === "incomplete") {
        return contactFailure("acceptance_unknown", "reconciliation_incomplete", budget);
      }
    }
    while (budget.used < budget.maximum) {
      let response;
      try {
        response = await authorizedRequest({ method: "POST", url: buildUrl(restBase, "contacts"), json: payload }, { budget });
      } catch {
        response = { ok: false, status: 0, data: null, reason: "transport_error" };
      }
      if (response.reason === "auth_failed") {
        log("warn", "phoneburner.contact_rejected", { operation: "create_contact", reason: "auth_failed", workHash: identityHash, postAttempts: budget.used });
        return contactFailure("auth_failed", "auth_failed", budget, 401);
      }
      const providerStatus = String(response.data?.status || "").trim().toLowerCase();
      const contactId = extractCreatedContactId(response.data);
      if (response.ok && providerStatus === "success" && contactId) {
        return { ok: true, status: "accepted", httpStatus: response.status, contactId, reconciled: false, postAttempts: budget.used };
      }
      if (response.status === 429) {
        return {
          ...contactFailure("rate_limited", "rate_limited", budget, 429),
          ...(response.retryAfterMs == null ? {} : { retryAfterMs: response.retryAfterMs }),
        };
      }
      if (response.ok && providerStatus && providerStatus !== "success") {
        return contactFailure("rejected", "provider_rejected", budget, response.status);
      }
      const ambiguous = response.status === 0
        || AMBIGUOUS_CONTACT_STATUSES.has(response.status)
        || (response.status >= 500 && response.status <= 599)
        || (response.ok && !contactId);
      if (!ambiguous) {
        const reason = response.status === 403 ? "forbidden" : "provider_rejected";
        return contactFailure("rejected", reason, budget, response.status);
      }
      log("warn", "phoneburner.contact_ambiguous", {
        operation: "create_contact",
        reason: response.ok ? "missing_contact_id" : "ambiguous_transport",
        httpStatus: response.status,
        workHash: identityHash,
        postAttempts: budget.used,
      });
      const reconciliation = await reconcileExternalIdentity(externalLeadId, reconciliationFolderIds);
      if (reconciliation.status === "matched") {
        return { ok: true, status: "accepted", httpStatus: response.status, contactId: reconciliation.contactId, reconciled: true, postAttempts: budget.used };
      }
      if (reconciliation.status === "conflict") {
        return contactFailure("identity_conflict", "multiple_external_identity_matches", budget, response.status);
      }
      if (reconciliation.status === "incomplete") {
        return contactFailure("acceptance_unknown", "reconciliation_incomplete", budget, response.status);
      }
      if (budget.used >= budget.maximum) {
        return contactFailure("acceptance_unknown", "not_found_after_final_reconciliation", budget, response.status);
      }
    }
    return contactFailure("acceptance_unknown", "contact_post_budget_exhausted", budget);
  }

  async function moveContact(contactId, folderId) {
    const id = positiveId(contactId, "contactId");
    const categoryId = positiveId(folderId, "folderId");
    const response = await readOperation({
      method: "PUT",
      url: buildUrl(restBase, `contacts/${encodeURIComponent(id)}`),
      json: { category_id: categoryId },
    }, "move_contact");
    return response.ok && response.data?.status === "success"
      ? { ok: true, httpStatus: response.status, contactId: id, folderId: categoryId }
      : { ok: false, httpStatus: response.status, reason: response.reason || "provider_rejected" };
  }

  async function deleteContact(contactId) {
    const id = positiveId(contactId, "contactId");
    const response = await readOperation({ method: "DELETE", url: buildUrl(restBase, `contacts/${encodeURIComponent(id)}`) }, "delete_contact");
    const deleted = response.status === 204
      || (response.ok && response.data?.status === "success");
    return deleted
      ? { ok: true, httpStatus: response.status, contactId: id, trashed: true }
      : {
        ok: false,
        httpStatus: response.status,
        reason: response.reason || "provider_rejected",
        ...(response.retryAfterMs == null ? {} : { retryAfterMs: response.retryAfterMs }),
      };
  }

  async function listDialSessions(options = {}) {
    const page = boundedInteger(options.page, "page", { minimum: 1, fallback: 1 });
    const pageSize = boundedInteger(options.pageSize, "pageSize", { minimum: 1, maximum: 100, fallback: 25 });
    const response = await readOperation({
      method: "GET",
      url: buildUrl(restBase, "dialsession", {
        page,
        page_size: pageSize,
        date_start: options.dateStart,
        date_end: options.dateEnd,
      }),
    }, "list_dial_sessions");
    const envelope = response.data?.dialsessions;
    if (!response.ok || response.data?.status !== "success" || !envelope || typeof envelope !== "object") {
      return { ok: false, httpStatus: response.status, reason: response.reason || "provider_schema_error" };
    }
    if (!isCollectionShape(envelope.dialsessions)) {
      return { ok: false, httpStatus: response.status, reason: "provider_schema_error" };
    }
    const sessions = arrayFrom(envelope.dialsessions).map((entry) => normalizeSession(entry)).filter(Boolean);
    const metadata = {
      page: integerMetadata(envelope.page),
      pageSize: integerMetadata(envelope.page_size),
      totalPages: integerMetadata(envelope.total_pages),
      totalResults: integerMetadata(envelope.total_results),
    };
    if (Object.values(metadata).some((value) => value == null)
      || sessions.some((session) => !session.dialSessionId || session.callCount == null)
      || (metadata.totalPages === 0 && (metadata.totalResults !== 0 || sessions.length !== 0))
      || (metadata.totalPages > 0 && metadata.page > metadata.totalPages)) {
      return { ok: false, httpStatus: response.status, reason: "provider_schema_error" };
    }
    return {
      ok: true,
      httpStatus: response.status,
      ...metadata,
      sessions,
    };
  }

  async function getDialSession(dialSessionId, options = {}) {
    const id = positiveId(dialSessionId, "dialSessionId");
    const response = await readOperation({
      method: "GET",
      url: buildUrl(restBase, `dialsession/${encodeURIComponent(id)}`, {
        page: options.page,
        page_size: options.pageSize,
        include_recording: options.includeRecording === true ? 1 : undefined,
        include_transcript: options.includeTranscript === true ? 1 : undefined,
      }),
    }, "get_dial_session");
    const envelope = response.data?.dialsessions;
    const raw = envelope?.dialsessions;
    if (!response.ok || response.data?.status !== "success" || !raw || typeof raw !== "object") {
      return { ok: false, httpStatus: response.status, reason: response.reason || "provider_schema_error" };
    }
    const session = normalizeSession(Array.isArray(raw) ? raw[0] : raw, { includeCalls: true });
    if (!session?.dialSessionId
      || session.dialSessionId !== id
      || session.callCount == null
      || session.calls.some((call) => !call.callId)) {
      return { ok: false, httpStatus: response.status, reason: "provider_schema_error" };
    }
    return { ok: true, httpStatus: response.status, session };
  }

  return {
    createContact,
    deleteContact,
    getContact,
    getDialSession,
    getFolderCount,
    listDialSessions,
    listFolderContacts,
    moveContact,
    refreshAccessToken,
  };
}

module.exports = {
  EXTERNAL_CRM_NAMESPACE,
  EXTERNAL_ID_CUSTOM_FIELD,
  createPhoneBurnerClient,
  createPhoneBurnerDurableCredentialStore,
  createPhoneBurnerEnvironmentCredentialStore,
};
