"use strict";

// Offline contract test for logicsClient.uploadCaseDocument — proves the
// request is built EXACTLY to the Logics "Create a Case Document" spec
// (POST publicapi/V4/Documents/CaseDocument, Basic auth, CaseID/Comment as
// headers, the file as a `File` multipart part, and NO JSON Content-Type so
// fetch sets its own multipart boundary) by stubbing global.fetch.
// It NEVER touches a real Logics tenant and NEVER uploads a real document.

// The client needs a Logics apiUrl to build a URL; set it before requiring.
process.env.WYNN_LOGICS_API_URL = "https://wynntax.irslogics.com/publicapi/V4/";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  createLogicsClient,
} = require("../../packages/shared-integrations/src/logicsClient");

function makeClient() {
  return createLogicsClient("WYNN", {
    authOverride: { apiKey: "testkey", secret: "testsecret" },
  });
}

function stubFetch(responder) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return responder();
  };
  return { calls, restore: () => { global.fetch = original; } };
}

const okEnvelope = () => ({
  ok: true,
  status: 200,
  text: async () =>
    JSON.stringify({
      Success: true,
      data: { CaseDocumentID: 128346 },
      message: "File uploaded succefully by User: Pedro Medina",
      StatusCode: 200,
    }),
});

test("posts multipart to the documented endpoint with Basic auth + CaseID header", async () => {
  const { calls, restore } = stubFetch(okEnvelope);
  try {
    const result = await makeClient().uploadCaseDocument({
      caseId: 12345,
      file: Buffer.from("%PDF-1.4 fake transcript bytes"),
      filename: "WIT_2022_608827503.pdf",
      comment: "THS pull 2026-06-18",
    });

    assert.equal(calls.length, 1);
    const { url, options } = calls[0];

    // endpoint (host is normalized irslogics.com -> logiqsapi.com by config)
    assert.ok(
      url.endsWith("/publicapi/V4/Documents/CaseDocument"),
      `unexpected url: ${url}`,
    );
    assert.match(url, /wynntax\.logiqsapi\.com/);
    assert.equal(options.method, "POST");

    // Basic auth carrying our override creds
    assert.ok(String(options.headers.Authorization).startsWith("Basic "));
    const decoded = Buffer.from(
      String(options.headers.Authorization).slice(6),
      "base64",
    ).toString();
    assert.equal(decoded, "testkey:testsecret");

    // metadata as HEADERS (per spec), not form fields
    assert.equal(options.headers.CaseID, "12345");
    assert.equal(options.headers.Comment, "THS pull 2026-06-18");

    // NO JSON content-type — multipart must set its own boundary
    assert.ok(
      !("Content-Type" in options.headers) && !("content-type" in options.headers),
    );

    // the file rides in the `File` multipart part, original filename preserved
    assert.ok(options.body instanceof FormData);
    assert.ok(options.body.has("File"));
    assert.equal(options.body.get("File").name, "WIT_2022_608827503.pdf");

    // returns the Logics envelope
    assert.equal(result.data.CaseDocumentID, 128346);
  } finally {
    restore();
  }
});

test("strips CR/LF from the Comment header", async () => {
  const { calls, restore } = stubFetch(okEnvelope);
  try {
    await makeClient().uploadCaseDocument({
      caseId: 7,
      file: Buffer.from("x"),
      filename: "a.pdf",
      comment: "line1\r\nline2",
    });
    assert.equal(calls[0].options.headers.Comment, "line1 line2");
  } finally {
    restore();
  }
});

test("rejects a >6MB file before any network call", async () => {
  const { calls, restore } = stubFetch(okEnvelope);
  try {
    const big = Buffer.alloc(6 * 1024 * 1024 + 1, 0x41);
    await assert.rejects(
      makeClient().uploadCaseDocument({ caseId: 7, file: big, filename: "big.pdf" }),
      (e) => e.status === 413,
    );
    assert.equal(calls.length, 0, "must not hit the network for an oversize file");
  } finally {
    restore();
  }
});

test("validates caseId and file before sending", async () => {
  const { restore } = stubFetch(okEnvelope);
  try {
    const client = makeClient();
    await assert.rejects(
      client.uploadCaseDocument({ caseId: 0, file: Buffer.from("x") }),
      (e) => e.status === 400,
    );
    await assert.rejects(
      client.uploadCaseDocument({ caseId: "abc", file: Buffer.from("x") }),
      (e) => e.status === 400,
    );
    await assert.rejects(
      client.uploadCaseDocument({ caseId: 7 }),
      (e) => e.status === 400,
    );
  } finally {
    restore();
  }
});

test("throws on a 200 body with Success:false (e.g. missing case.write scope)", async () => {
  const { restore } = stubFetch(() => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        Success: false,
        message: "Access denied. Missing required scope: case.write",
      }),
  }));
  try {
    await assert.rejects(
      makeClient().uploadCaseDocument({
        caseId: 7,
        file: Buffer.from("x"),
        filename: "a.pdf",
      }),
      (e) => e.details && e.details.responseStatus === 200,
    );
  } finally {
    restore();
  }
});

test("throws on a transport 401 (missing/invalid Basic auth)", async () => {
  const { restore } = stubFetch(() => ({
    ok: false,
    status: 401,
    text: async () =>
      JSON.stringify({
        message: "Unauthorized. Missing or invalid Authorization header.",
      }),
  }));
  try {
    await assert.rejects(
      makeClient().uploadCaseDocument({
        caseId: 7,
        file: Buffer.from("x"),
        filename: "a.pdf",
      }),
      (e) => e.details && e.details.responseStatus === 401,
    );
  } finally {
    restore();
  }
});
