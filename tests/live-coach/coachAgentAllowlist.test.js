"use strict";

// AGENT ALLOWLIST PINS (2026-07-08, the 3002 coach rig hardening). The fence that
// keeps a test bridge from coaching the floor: unset = production behavior (allow
// everyone); set = only listed agents; unknown identity = fail-OPEN (real dials bind
// via Mongo AFTER the stream opens — failing closed would block the tester's own
// calls; the residual is documented at the definition).

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");

// same isolation the uiiReconcile pins use — the kill-file path is a load-time const
process.env.LIVE_COACH_KILL_FILE = path.join(os.tmpdir(), `allowlist-no-kill-${process.pid}`);

const { isAgentAllowedForCoach } = require("../../scripts/ringcx-grpc-live-coach-bridge.js");

let saved;
beforeEach(() => {
  saved = process.env.LIVE_COACH_AGENT_EMAIL_ALLOWLIST;
  delete process.env.LIVE_COACH_AGENT_EMAIL_ALLOWLIST;
});
afterEach(() => {
  if (saved === undefined) delete process.env.LIVE_COACH_AGENT_EMAIL_ALLOWLIST;
  else process.env.LIVE_COACH_AGENT_EMAIL_ALLOWLIST = saved;
});

test("unset allowlist = allow everyone (production behavior unchanged)", () => {
  assert.equal(isAgentAllowedForCoach("anyone@taxadvocategroup.com"), true);
  assert.equal(isAgentAllowedForCoach(""), true);
  assert.equal(isAgentAllowedForCoach(null), true);
});

test("set allowlist: listed agent allowed (case/whitespace-insensitive), foreign denied", () => {
  process.env.LIVE_COACH_AGENT_EMAIL_ALLOWLIST = " MGray@TaxAdvocateGroup.com ";
  assert.equal(isAgentAllowedForCoach("mgray@taxadvocategroup.com"), true);
  assert.equal(isAgentAllowedForCoach("MGRAY@taxadvocategroup.com"), true);
  assert.equal(isAgentAllowedForCoach("slucas@taxadvocategroup.com"), false);
});

test("set allowlist: UNKNOWN identity fails OPEN (late Mongo binds must not be blocked)", () => {
  process.env.LIVE_COACH_AGENT_EMAIL_ALLOWLIST = "mgray@taxadvocategroup.com";
  assert.equal(isAgentAllowedForCoach(""), true);
  assert.equal(isAgentAllowedForCoach(undefined), true);
});

test("comma list + read-per-call (a flip needs no restart)", () => {
  process.env.LIVE_COACH_AGENT_EMAIL_ALLOWLIST = "a@x.com, b@x.com";
  assert.equal(isAgentAllowedForCoach("b@x.com"), true);
  assert.equal(isAgentAllowedForCoach("c@x.com"), false);
  process.env.LIVE_COACH_AGENT_EMAIL_ALLOWLIST = "c@x.com";
  assert.equal(isAgentAllowedForCoach("c@x.com"), true, "env change takes effect immediately");
});
