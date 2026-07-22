"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  requestedAgent,
  safeResult,
} = require("../../scripts/validate-phoneburner-lead-delivery-folders");

test("folder validation CLI selects one normalized agent without accepting a blank", () => {
  assert.equal(requestedAgent(["--agent", " Bruce_Allen "]), "bruce_allen");
  assert.equal(requestedAgent(["--agent=SEAN_LUCAS"]), "sean_lucas");
  assert.equal(requestedAgent([]), null);
});

test("folder validation result exposes only agent, role, aggregate count, and safe status", () => {
  const result = safeResult("bruce_allen", "distribution", {
    ok: true,
    count: 5,
    httpStatus: 200,
    folderId: "must-not-escape",
    contacts: [{ phone: "must-not-escape" }],
    accessToken: "must-not-escape",
  });
  assert.deepEqual(result, {
    agentId: "bruce_allen",
    role: "distribution",
    ok: true,
    count: 5,
    httpStatus: 200,
    reason: null,
  });
  assert.equal(JSON.stringify(result).includes("must-not-escape"), false);
});
