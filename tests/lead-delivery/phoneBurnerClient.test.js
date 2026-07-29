"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  EXTERNAL_ID_CUSTOM_FIELD,
  createPhoneBurnerClient,
  createPhoneBurnerDurableCredentialStore,
  createPhoneBurnerEnvironmentCredentialStore,
} = require("../../packages/shared-integrations/src/phoneBurnerClient");

const BASE_INPUT = Object.freeze({
  folderId: "7001",
  ownerId: "8001",
  externalLeadId: "TAG:case-101:attempt-1",
  phone: "3105550100",
  firstName: "CanaryFirst",
  lastName: "CanaryLast",
  email: "canary@example.test",
});

function successContact(contactId = "9001") {
  return {
    ok: true,
    status: 201,
    data: {
      status: "success",
      contacts: { contacts: { contact_user_id: contactId } },
    },
  };
}

function contactsPage({
  contacts = [],
  page = 1,
  pageSize = 100,
  totalPages = contacts.length ? 1 : 0,
  totalResults = contacts.length,
} = {}) {
  return {
    ok: true,
    status: 200,
    data: {
      status: "success",
      contacts: {
        contacts,
        page,
        page_size: pageSize,
        total_pages: totalPages,
        total_results: totalResults,
      },
    },
  };
}

function matchingContact(contactId, externalLeadId = BASE_INPUT.externalLeadId, extra = {}) {
  return {
    contact_user_id: contactId,
    category_id: BASE_INPUT.folderId,
    custom_fields: [{ name: EXTERNAL_ID_CUSTOM_FIELD, type: "1", value: externalLeadId }],
    ...extra,
  };
}

function createHarness(handler, { credentials = {}, logger: loggerOverride = null, clientOptions = {} } = {}) {
  const requests = [];
  const writes = [];
  const logs = [];
  let stored = {
    accessToken: "access-secret-old",
    refreshToken: "refresh-secret-old",
    clientId: "client-id-secret",
    clientSecret: "client-secret-value",
    ...credentials,
  };
  const transport = {
    async request(request) {
      requests.push(request);
      return handler(request, requests.length);
    },
  };
  const credentialStore = {
    async read() { return { ...stored }; },
    async writeTokens(tokens) {
      writes.push({ ...tokens });
      stored = { ...stored, ...tokens };
    },
  };
  const logger = {
    info(event, details) { logs.push(["info", event, details]); },
    warn(event, details) { logs.push(["warn", event, details]); },
    error(event, details) { logs.push(["error", event, details]); },
  };
  return {
    client: createPhoneBurnerClient({
      transport,
      credentialStore,
      logger: loggerOverride || logger,
      baseUrl: "https://phoneburner.test/rest/1/",
      oauthBaseUrl: "https://phoneburner.test/oauth/",
      ...clientOptions,
    }),
    logs,
    requests,
    writes,
  };
}

function pathOf(request) {
  return new URL(request.url).pathname;
}

function contactPosts(requests) {
  return requests.filter((request) => request.method === "POST" && pathOf(request) === "/rest/1/contacts");
}

function refreshPosts(requests) {
  return requests.filter((request) => request.method === "POST" && pathOf(request) === "/oauth/refreshtoken");
}

test("contact create sends exact folder, stable identity, owner, and non-updating duplicate policy", async () => {
  const { client, requests } = createHarness(async () => successContact("9001"));
  const result = await client.createContact({
    ...BASE_INPUT,
    customFields: [
      { name: "Source", type: 1, value: "web" },
      { name: EXTERNAL_ID_CUSTOM_FIELD, type: 1, value: "caller-cannot-replace" },
    ],
    tags: ["canary"],
  });

  assert.deepEqual(result, {
    ok: true,
    status: "accepted",
    httpStatus: 201,
    contactId: "9001",
    reconciled: false,
    postAttempts: 1,
  });
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.method, "POST");
  assert.equal(pathOf(request), "/rest/1/contacts");
  assert.equal(request.json.category_id, BASE_INPUT.folderId);
  assert.equal(request.json.lead_id, BASE_INPUT.externalLeadId);
  assert.equal(request.json.owner_id, 8001);
  assert.deepEqual(request.json.duplicate_checks, { phone: false, email: false });
  assert.equal(request.json.on_duplicate, "skip");
  assert.equal(request.json.allow_duplicates, 1);
  assert.equal(request.json.custom_fields.filter((field) => field.name === EXTERNAL_ID_CUSTOM_FIELD).length, 1);
  assert.deepEqual(request.json.custom_fields.at(-1), {
    name: EXTERNAL_ID_CUSTOM_FIELD,
    type: 1,
    value: BASE_INPUT.externalLeadId,
  });
});

test("folder, external identity, and phone are required while owner modes are mutually exclusive", async () => {
  const { client, requests } = createHarness(async () => successContact());
  const invalid = [
    { ...BASE_INPUT, folderId: "" },
    { ...BASE_INPUT, folderId: "12x" },
    { ...BASE_INPUT, folderId: 0 },
    { ...BASE_INPUT, externalLeadId: " " },
    { ...BASE_INPUT, phone: "" },
    { ...BASE_INPUT, ownerUsername: "other-owner" },
    { ...BASE_INPUT, ownerId: "8x" },
    { ...BASE_INPUT, customFields: {} },
    { ...BASE_INPUT, reconciliationFolderIds: "7002" },
  ];
  for (const input of invalid) await assert.rejects(client.createContact(input), TypeError);
  assert.equal(requests.length, 0);
});

test("contact create may use the authenticated PhoneBurner owner without inventing an owner field", async () => {
  const { client, requests } = createHarness(async () => successContact());
  await client.createContact({ ...BASE_INPUT, ownerId: null });
  assert.equal(Object.hasOwn(requests[0].json, "owner_id"), false);
  assert.equal(Object.hasOwn(requests[0].json, "owner_username"), false);
});

test("environment credential store exposes only the PhoneBurner credential contract and rotates in memory", async () => {
  const env = {
    PB_HOT_SEAT_TOKEN: "access-old-test",
    PB_REFRESH_TOKEN: "refresh-old-test",
    PB_CLIENT_ID: "client-test",
    PB_CLIENT_SECRET: "secret-test",
    UNRELATED: "preserved",
  };
  const store = createPhoneBurnerEnvironmentCredentialStore({ env });
  assert.deepEqual(await store.read(), {
    accessToken: "access-old-test",
    refreshToken: "refresh-old-test",
    clientId: "client-test",
    clientSecret: "secret-test",
  });
  await store.writeTokens({ accessToken: "access-new-test", refreshToken: "refresh-new-test" });
  assert.equal(env.PB_HOT_SEAT_TOKEN, "access-new-test");
  assert.equal(env.PB_REFRESH_TOKEN, "refresh-new-test");
  assert.equal(env.UNRELATED, "preserved");
});

test("explicit owner username is supported without inventing an owner", async () => {
  const { client, requests } = createHarness(async () => successContact());
  await client.createContact({ ...BASE_INPUT, ownerId: null, ownerUsername: "agent-user" });
  assert.equal(requests[0].json.owner_username, "agent-user");
  assert.equal(Object.hasOwn(requests[0].json, "owner_id"), false);
});

test("2xx success without contact ID reconciles exact controlled custom-field identity", async () => {
  const { client, requests } = createHarness(async (request) => {
    if (request.method === "POST") return { ok: true, status: 201, data: { status: "success", contacts: { contacts: {} } } };
    return contactsPage({ contacts: [matchingContact("9101")] });
  });
  const result = await client.createContact(BASE_INPUT);
  assert.equal(result.ok, true);
  assert.equal(result.reconciled, true);
  assert.equal(result.contactId, "9101");
  assert.equal(contactPosts(requests).length, 1);
});

test("restart recovery reconciles a prepared external identity before any new POST", async () => {
  const { client, requests } = createHarness(async (request) => {
    assert.equal(request.method, "GET");
    return contactsPage({ contacts: [matchingContact("9102")] });
  });
  const result = await client.createContact({ ...BASE_INPUT, reconcileBeforePost: true });
  assert.deepEqual(result, {
    ok: true,
    status: "accepted",
    httpStatus: 200,
    contactId: "9102",
    reconciled: true,
    postAttempts: 0,
  });
  assert.equal(contactPosts(requests).length, 0);
});

test("restart recovery posts only after a complete reconciliation proves absence", async () => {
  const { client, requests } = createHarness(async (request) => (
    request.method === "GET" ? contactsPage() : successContact("9103")
  ));
  const result = await client.createContact({ ...BASE_INPUT, reconcileBeforePost: true });
  assert.equal(result.contactId, "9103");
  assert.equal(result.postAttempts, 1);
  assert.equal(contactPosts(requests).length, 1);
});

test("malformed created contact IDs are never accepted as provider identity", async () => {
  const { client, requests } = createHarness(async (request) => {
    if (request.method === "POST") {
      return {
        ok: true,
        status: 201,
        data: { status: "success", contacts: { contacts: { contact_user_id: {} } } },
      };
    }
    return contactsPage();
  });
  const result = await client.createContact(BASE_INPUT);
  assert.equal(result.status, "acceptance_unknown");
  assert.equal(contactPosts(requests).length, 2);
});

test("ambiguous transport with a complete zero scan retries once and succeeds", async () => {
  let post = 0;
  const { client, requests } = createHarness(async (request) => {
    if (request.method === "POST") {
      post += 1;
      if (post === 1) throw Object.assign(new Error("raw timeout with canary@example.test"), { code: "ETIMEDOUT" });
      return successContact("9002");
    }
    return contactsPage();
  });
  const result = await client.createContact(BASE_INPUT);
  assert.equal(result.status, "accepted");
  assert.equal(result.contactId, "9002");
  assert.equal(result.postAttempts, 2);
  assert.equal(contactPosts(requests).length, 2);
});

test("incomplete or malformed reconciliation is acceptance_unknown and never retries", async () => {
  const { client, requests } = createHarness(async (request) => {
    if (request.method === "POST") throw new Error("timeout");
    return { ok: true, status: 200, data: { status: "success", contacts: { contacts: [], page: 1 } } };
  });
  const result = await client.createContact(BASE_INPUT);
  assert.equal(result.status, "acceptance_unknown");
  assert.equal(result.reason, "reconciliation_incomplete");
  assert.equal(contactPosts(requests).length, 1);
});

test("reconciliation never calls metadata-complete when declared rows are absent or identity-less", async () => {
  for (const contacts of [
    [],
    [{ category_id: BASE_INPUT.folderId, custom_fields: [] }],
  ]) {
    const { client, requests } = createHarness(async (request) => {
      if (request.method === "POST") throw new Error("timeout");
      return contactsPage({ contacts, totalPages: 1, totalResults: 2 });
    });
    const result = await client.createContact(BASE_INPUT);
    assert.equal(result.status, "acceptance_unknown");
    assert.equal(result.reason, "reconciliation_incomplete");
    assert.equal(contactPosts(requests).length, 1);
  }
});

test("reconciliation scans every page and accepts one exact identity", async () => {
  const pages = [];
  const { client } = createHarness(async (request) => {
    if (request.method === "POST") throw new Error("timeout");
    const page = Number(new URL(request.url).searchParams.get("page"));
    pages.push(page);
    return contactsPage({
      page,
      pageSize: 1,
      totalPages: 2,
      totalResults: 2,
      contacts: page === 1
        ? [matchingContact("9102", "another-external-id")]
        : [matchingContact("9103")],
    });
  });
  const result = await client.createContact(BASE_INPUT);
  assert.equal(result.reconciled, true);
  assert.equal(result.contactId, "9103");
  assert.deepEqual(pages, [1, 2]);
});

test("two distinct exact identities conflict and duplicate provider rows fail closed", async () => {
  const conflictHarness = createHarness(async (request) => {
    if (request.method === "POST") throw new Error("timeout");
    return contactsPage({ contacts: [matchingContact("9201"), matchingContact("9202")] });
  });
  const conflict = await conflictHarness.client.createContact(BASE_INPUT);
  assert.equal(conflict.status, "identity_conflict");
  assert.equal(contactPosts(conflictHarness.requests).length, 1);

  const repeatedHarness = createHarness(async (request) => {
    if (request.method === "POST") throw new Error("timeout");
    return contactsPage({ contacts: [matchingContact("9301"), matchingContact("9301")] });
  });
  const repeated = await repeatedHarness.client.createContact(BASE_INPUT);
  assert.equal(repeated.status, "acceptance_unknown");
  assert.equal(repeated.reason, "reconciliation_incomplete");
});

test("same phone and PII never reconcile a different external identity", async () => {
  let post = 0;
  const { client, requests } = createHarness(async (request) => {
    if (request.method === "POST") {
      post += 1;
      if (post === 1) throw new Error("timeout");
      return successContact("9402");
    }
    return contactsPage({ contacts: [matchingContact("9401", "different-id", {
      raw_phone: BASE_INPUT.phone,
      first_name: BASE_INPUT.firstName,
      email_address: BASE_INPUT.email,
    })] });
  });
  const result = await client.createContact(BASE_INPUT);
  assert.equal(result.contactId, "9402");
  assert.equal(contactPosts(requests).length, 2);
});

test("read-only validation can refuse token refresh without rotating credentials", async () => {
  const { client, requests, writes } = createHarness(
    async () => ({ ok: false, status: 401, data: { error: "expired" } }),
    { clientOptions: { refreshOnUnauthorized: false } },
  );
  const result = await client.getFolderCount(BASE_INPUT.folderId);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "auth_failed");
  assert.equal(requests.length, 1);
  assert.equal(writes.length, 0);
});

test("401 refreshes once, preserves an omitted refresh token, and replays within two POSTs", async () => {
  let contactAttempt = 0;
  const { client, requests, writes } = createHarness(async (request) => {
    if (pathOf(request) === "/oauth/refreshtoken") {
      return { ok: true, status: 200, data: { access_token: "access-secret-new", token_type: "bearer" } };
    }
    contactAttempt += 1;
    return contactAttempt === 1
      ? { ok: false, status: 401, data: { error: "expired" } }
      : successContact("9501");
  });
  const result = await client.createContact(BASE_INPUT);
  assert.equal(result.status, "accepted");
  assert.equal(result.postAttempts, 2);
  assert.equal(contactPosts(requests).length, 2);
  assert.equal(refreshPosts(requests).length, 1);
  assert.equal(contactPosts(requests)[1].headers.Authorization, "Bearer access-secret-new");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].refreshToken, "refresh-secret-old");
});

test("a second 401 stops after one refresh and two contact POSTs", async () => {
  const { client, requests } = createHarness(async (request) => {
    if (pathOf(request) === "/oauth/refreshtoken") return { ok: true, status: 200, data: { access_token: "new-token" } };
    return { ok: false, status: 401, data: null };
  });
  const result = await client.createContact(BASE_INPUT);
  assert.equal(result.status, "auth_failed");
  assert.equal(contactPosts(requests).length, 2);
  assert.equal(refreshPosts(requests).length, 1);
});

test("401 replay ambiguity reconciles but can never create a third physical POST", async () => {
  let contactAttempt = 0;
  const { client, requests } = createHarness(async (request) => {
    if (pathOf(request) === "/oauth/refreshtoken") return { ok: true, status: 200, data: { access_token: "new-token" } };
    if (request.method === "POST") {
      contactAttempt += 1;
      if (contactAttempt === 1) return { ok: false, status: 401, data: null };
      throw new Error("ambiguous after replay");
    }
    return contactsPage();
  });
  const result = await client.createContact(BASE_INPUT);
  assert.equal(result.status, "acceptance_unknown");
  assert.equal(contactPosts(requests).length, 2);
  assert.equal(refreshPosts(requests).length, 1);
});

test("ambiguous first POST followed by a 401 cannot refresh into a third POST", async () => {
  let contactAttempt = 0;
  const { client, requests } = createHarness(async (request) => {
    if (request.method === "POST" && pathOf(request) === "/rest/1/contacts") {
      contactAttempt += 1;
      if (contactAttempt === 1) throw new Error("timeout");
      return { ok: false, status: 401, data: null };
    }
    if (pathOf(request) === "/oauth/refreshtoken") return { ok: true, status: 200, data: { access_token: "new-token" } };
    return contactsPage();
  });
  const result = await client.createContact(BASE_INPUT);
  assert.equal(result.status, "auth_failed");
  assert.equal(contactPosts(requests).length, 2);
  assert.equal(refreshPosts(requests).length, 0);
});

test("403 never refreshes or retries", async () => {
  const { client, requests } = createHarness(async () => ({ ok: false, status: 403, data: { error: "forbidden" } }));
  const result = await client.createContact(BASE_INPUT);
  assert.equal(result.status, "rejected");
  assert.equal(result.reason, "forbidden");
  assert.equal(contactPosts(requests).length, 1);
  assert.equal(refreshPosts(requests).length, 0);
});

test("429 is retryable rate_limited and never performs an immediate second POST", async () => {
  const { client, requests } = createHarness(async () => ({
    ok: false,
    status: 429,
    data: { error: "too_many_requests" },
  }));
  const result = await client.createContact(BASE_INPUT);
  assert.deepEqual(result, {
    ok: false,
    status: "rate_limited",
    reason: "rate_limited",
    httpStatus: 429,
    postAttempts: 1,
  });
  assert.equal(contactPosts(requests).length, 1);
  assert.equal(refreshPosts(requests).length, 0);
  assert.equal(requests.length, 1);
});

test("429 preserves a valid Retry-After header as normalized milliseconds", async () => {
  const { client, requests } = createHarness(async () => ({
    ok: false,
    status: 429,
    headers: { "Retry-After": "7" },
    data: null,
  }));
  const result = await client.createContact(BASE_INPUT);
  assert.equal(result.status, "rate_limited");
  assert.equal(result.retryAfterMs, 7_000);
  assert.equal(contactPosts(requests).length, 1);
  assert.equal(requests.length, 1);
});

test("concurrent 401s share one in-flight refresh and token-store write", async () => {
  let releaseRefresh;
  const refreshBarrier = new Promise((resolve) => { releaseRefresh = resolve; });
  let refreshCalls = 0;
  let acceptedId = 9800;
  const { client, requests, writes } = createHarness(async (request) => {
    if (pathOf(request) === "/oauth/refreshtoken") {
      refreshCalls += 1;
      if (refreshCalls === 1) setImmediate(releaseRefresh);
      await refreshBarrier;
      return { ok: true, status: 200, data: { access_token: "shared-new-token" } };
    }
    if (request.headers.Authorization === "Bearer access-secret-old") return { ok: false, status: 401, data: null };
    acceptedId += 1;
    return successContact(String(acceptedId));
  });
  const [one, two] = await Promise.all([
    client.createContact(BASE_INPUT),
    client.createContact({ ...BASE_INPUT, externalLeadId: "TAG:case-102:attempt-1" }),
  ]);
  assert.equal(one.ok, true);
  assert.equal(two.ok, true);
  assert.equal(refreshPosts(requests).length, 1);
  assert.equal(writes.length, 1);
  assert.equal(contactPosts(requests).length, 4);
});

test("refresh failure or missing access token produces a safe auth failure without replay", async () => {
  const { client, requests } = createHarness(async (request) => {
    if (pathOf(request) === "/oauth/refreshtoken") return { ok: true, status: 200, data: {} };
    return { ok: false, status: 401, data: null };
  });
  const result = await client.createContact(BASE_INPUT);
  assert.equal(result.status, "auth_failed");
  assert.equal(contactPosts(requests).length, 1);
  assert.equal(refreshPosts(requests).length, 1);
});

test("public refresh normalizes a raw credential-store failure", async () => {
  const sentinel = "credential-read-secret-sentinel";
  const client = createPhoneBurnerClient({
    transport: { async request() { throw new Error("not reached"); } },
    credentialStore: {
      async read() { throw new Error(sentinel); },
      async writeTokens() {},
    },
  });
  await assert.rejects(client.refreshAccessToken(), (error) => (
    error.message === "phoneburner credential read failed"
    && !error.message.includes(sentinel)
  ));
});

test("provider-declared error on 2xx is rejected rather than retried", async () => {
  const { client, requests } = createHarness(async () => ({ ok: true, status: 200, data: { status: "error", error: "raw body" } }));
  const result = await client.createContact(BASE_INPUT);
  assert.equal(result.status, "rejected");
  assert.equal(result.reason, "provider_rejected");
  assert.equal(requests.length, 1);
});

test("safe logs and results never contain contact PII, tokens, or raw provider errors", async () => {
  const rawError = "raw-provider-error-client-secret-value";
  const { client, logs } = createHarness(async (request) => {
    if (request.method === "POST") throw new Error(`${rawError}-${BASE_INPUT.phone}-${BASE_INPUT.email}`);
    return { ok: false, status: 500, data: { error: rawError, phone: BASE_INPUT.phone } };
  });
  const result = await client.createContact(BASE_INPUT);
  const rendered = JSON.stringify({ logs, result });
  for (const forbidden of [
    BASE_INPUT.phone,
    BASE_INPUT.firstName,
    BASE_INPUT.lastName,
    BASE_INPUT.email,
    "access-secret-old",
    "refresh-secret-old",
    "client-secret-value",
    rawError,
  ]) assert.equal(rendered.includes(forbidden), false, forbidden);
});

test("a broken logger cannot interrupt ambiguous reconciliation", async () => {
  const { client, requests } = createHarness(async (request) => {
    if (request.method === "POST") throw new Error("timeout");
    return contactsPage({ contacts: [matchingContact("9601")] });
  }, {
    logger: { warn() { throw new Error("logger unavailable"); } },
  });
  const result = await client.createContact(BASE_INPUT);
  assert.equal(result.status, "accepted");
  assert.equal(result.contactId, "9601");
  assert.equal(contactPosts(requests).length, 1);
});

test("folder reads normalize identity only, validate pagination, and count without PII", async () => {
  const { client, requests } = createHarness(async (request) => {
    const requestedPageSize = Number(new URL(request.url).searchParams.get("page_size"));
    return contactsPage({
    contacts: [matchingContact("9701", BASE_INPUT.externalLeadId, {
      first_name: BASE_INPUT.firstName,
      raw_phone: BASE_INPUT.phone,
      notes: "private note",
    })],
    pageSize: requestedPageSize,
    totalPages: requestedPageSize === 1 ? 17 : 1,
    totalResults: requestedPageSize === 1 ? "17" : "1",
    });
  });
  const page = await client.listFolderContacts(BASE_INPUT.folderId, { page: 1, pageSize: 100 });
  assert.equal(page.ok, true);
  assert.equal(page.totalResults, 1);
  assert.equal(page.contacts[0].contactId, "9701");
  assert.equal(JSON.stringify(page).includes(BASE_INPUT.phone), false);
  assert.equal(JSON.stringify(page).includes(BASE_INPUT.firstName), false);
  const count = await client.getFolderCount(BASE_INPUT.folderId);
  assert.equal(count.count, 17);
  assert.equal(new URL(requests.at(-1).url).searchParams.get("page_size"), "1");
});

test("empty live folders accept PhoneBurner's zero page_size success shape", async () => {
  const { client } = createHarness(async () => contactsPage({
    contacts: [],
    page: 1,
    pageSize: 0,
    totalPages: 0,
    totalResults: 0,
  }));
  const result = await client.getFolderCount(BASE_INPUT.folderId);
  assert.deepEqual(result, {
    ok: true,
    httpStatus: 200,
    folderId: BASE_INPUT.folderId,
    count: 0,
  });
});

test("a final partial folder page accepts PhoneBurner's actual-row page_size shape", async () => {
  const contacts = Array.from({ length: 45 }, (_, index) => matchingContact(String(9800 + index)));
  const { client } = createHarness(async () => contactsPage({
    contacts,
    page: 5,
    pageSize: 45,
    totalPages: 5,
    totalResults: 445,
  }));
  const result = await client.listFolderContacts(BASE_INPUT.folderId, { page: 5, pageSize: 100 });
  assert.equal(result.ok, true);
  assert.equal(result.contacts.length, 45);
  assert.equal(result.totalResults, 445);
});

test("exact contact reads reject a mismatched provider identity", async () => {
  const { client } = createHarness(async () => ({
    ok: true,
    status: 200,
    data: { status: "success", contacts: { contacts: { contact_user_id: "9002" } } },
  }));
  const result = await client.getContact("9001");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "provider_schema_error");
});

test("exact contact reads normalize PhoneBurner's nested category folder", async () => {
  const { client } = createHarness(async () => ({
    ok: true,
    status: 200,
    data: {
      status: "success",
      contacts: {
        contacts: {
          contact_user_id: "9001",
          category: { category_id: BASE_INPUT.folderId, name: "private-folder-name" },
        },
      },
    },
  }));
  const result = await client.getContact("9001");
  assert.equal(result.ok, true);
  assert.equal(result.contact.folderId, BASE_INPUT.folderId);
  assert.equal(JSON.stringify(result).includes("private-folder-name"), false);
});

test("move and delete use category update and soft-delete path only", async () => {
  const { client, requests } = createHarness(async (request) => (
    request.method === "DELETE"
      ? { ok: true, status: 204, data: null }
      : { ok: true, status: 200, data: { status: "success" } }
  ));
  assert.equal((await client.moveContact("9001", "7002")).ok, true);
  assert.equal((await client.deleteContact("9001")).ok, true);
  assert.equal(requests[0].method, "PUT");
  assert.deepEqual(requests[0].json, { category_id: "7002" });
  assert.equal(Object.hasOwn(requests[0].json, "transfer_to_user_id"), false);
  assert.equal(requests[1].method, "DELETE");
  assert.equal(new URL(requests[1].url).search, "");
});

test("delete does not report an error-shaped 2xx response as success", async () => {
  const { client } = createHarness(async () => ({ ok: true, status: 200, data: { status: "error" } }));
  const result = await client.deleteContact("9001");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "provider_rejected");
});

test("folder count and delete preserve provider Retry-After backpressure", async () => {
  const { client } = createHarness(async () => ({
    ok: false,
    status: 429,
    headers: { "Retry-After": "9" },
    data: null,
  }));
  const count = await client.getFolderCount(BASE_INPUT.folderId);
  const deleted = await client.deleteContact("9001");
  assert.equal(count.httpStatus, 429);
  assert.equal(count.retryAfterMs, 9_000);
  assert.equal(deleted.httpStatus, 429);
  assert.equal(deleted.retryAfterMs, 9_000);
});

test("dial-session reads strip phone, caller ID, notes, recordings, and transcripts", async () => {
  const { client } = createHarness(async (request) => {
    if (pathOf(request) === "/rest/1/dialsession") {
      return {
        ok: true,
        status: 200,
        data: {
          status: "success",
          dialsessions: {
            page: 1, page_size: 25, total_pages: 1, total_results: 1,
            dialsessions: [{ dialsession_id: "11", callerid: BASE_INPUT.phone, start_when: "2026-07-10 10:00:00", call_count: 1 }],
          },
        },
      };
    }
    return {
      ok: true,
      status: 200,
      data: {
        status: "success",
        dialsessions: {
          dialsessions: {
            dialsession_id: "11",
            callerid: BASE_INPUT.phone,
            call_count: 2,
            calls: [{
              call_id: "22", phone: BASE_INPUT.phone, note: "private", recording: "secret-url",
              transcript: { summary: "private words" }, connected: "1", voicemail: "0", disposition: "Interested",
            }, { call_id: "23" }],
          },
        },
      },
    };
  });
  const list = await client.listDialSessions();
  const detail = await client.getDialSession("11");
  const rendered = JSON.stringify({ list, detail });
  for (const forbidden of [BASE_INPUT.phone, "private", "secret-url", "private words"]) {
    assert.equal(rendered.includes(forbidden), false);
  }
  assert.equal(detail.session.calls[0].callId, "22");
  assert.equal(detail.session.calls[0].connected, true);
  assert.equal(detail.session.calls[1].connected, null);
  assert.equal(detail.session.calls[1].voicemail, null);
});

test("exact dial-session reads reject mismatched IDs and missing call counts", async () => {
  const mismatched = createHarness(async () => ({
    ok: true,
    status: 200,
    data: { status: "success", dialsessions: { dialsessions: { dialsession_id: "12", call_count: 0, calls: [] } } },
  }));
  assert.equal((await mismatched.client.getDialSession("11")).reason, "provider_schema_error");

  const missingCount = createHarness(async () => ({
    ok: true,
    status: 200,
    data: {
      status: "success",
      dialsessions: { page: 1, page_size: 25, total_pages: 1, total_results: 1, dialsessions: [{ dialsession_id: "11" }] },
    },
  }));
  assert.equal((await missingCount.client.listDialSessions()).reason, "provider_schema_error");
});

test("shared integration barrel exposes the PhoneBurner client factory", () => {
  const integrations = require("../../packages/shared-integrations/src");
  assert.equal(integrations.createPhoneBurnerClient, createPhoneBurnerClient);
  assert.equal(
    integrations.createPhoneBurnerDurableCredentialStore,
    createPhoneBurnerDurableCredentialStore,
  );
  assert.equal(
    integrations.createPhoneBurnerEnvironmentCredentialStore,
    createPhoneBurnerEnvironmentCredentialStore,
  );
});
