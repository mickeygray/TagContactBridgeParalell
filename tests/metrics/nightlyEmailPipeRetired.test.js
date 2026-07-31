"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// The nightly metrics email pipe, closed off in stages:
//   2026-07-27  financial, lead-data and redline emails retired
//   2026-07-30  the simple nightly email retired — the last one still sending
//
// Mickey: "its not even a feature, the things that drive it dont exist and we
// only collect metrics via activity pull loop." These tests exist so the pipe
// cannot quietly reopen: SIMPLE_NIGHTLY_EMAIL_ENABLED is TRUE in the live
// environment, so if the retirement is ever made to honour that flag again the
// email comes straight back on the next deploy.

const svc = require("../../packages/shared-services/src/simpleNightlyEmailService");
const blocks = require("../../packages/shared-services/src/reportBlocksService");

test("the nightly email does not send, even with the live env flag set true", async () => {
  const prior = process.env.SIMPLE_NIGHTLY_EMAIL_ENABLED;
  process.env.SIMPLE_NIGHTLY_EMAIL_ENABLED = "true";   // exactly as production has it
  try {
    const r = await svc.sendSimpleNightlyEmail({ dateKey: "2026-07-30" });
    assert.equal(r.sent, false);
    assert.equal(r.retired, true, "retirement must not depend on the env flag");
    assert.match(r.reason, /retired-2026-07-30/);
  } finally {
    if (prior === undefined) delete process.env.SIMPLE_NIGHTLY_EMAIL_ENABLED;
    else process.env.SIMPLE_NIGHTLY_EMAIL_ENABLED = prior;
  }
});

test("it reaches no mail transport at all", async () => {
  // Belt and braces: a retirement that still built the body would still hit
  // simpleMarketingReadService and Logics on a schedule for nothing.
  const r = await svc.sendSimpleNightlyEmail({ dateKey: "2026-07-30" });
  assert.equal(r.messageId, undefined);
  assert.equal(r.recipients, undefined);
});

test("what the retired email carried still has a home in the report blocks", () => {
  // Nothing may be lost by retiring it. Each of these was a section of that
  // email; each now belongs to a block gathered live at send time.
  for (const id of ["topline", "source", "status", "declines"]) {
    assert.ok(blocks.BY_ID.get(id), `${id} block must exist to carry the retired email's content`);
  }
  // "payments that did not process today" was the one signal the 2026-07-27
  // retirement deliberately kept in the simple email. It must survive this one.
  const declines = blocks.BY_ID.get("declines");
  assert.match(declines.hint + " " + declines.termsShort, /fail|bounce|decline/i);
  // Status movement now comes from the activity pull loop, not a file on disk.
  assert.ok(blocks.BY_ID.get("status").needs.includes("activity"));
});
