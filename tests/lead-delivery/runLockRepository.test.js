"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { RunLock } = require("../../packages/shared-models/src");
const runLockRepository = require("../../packages/shared-repositories/src/runLockRepository");

test("durable run-lock extension is token-fenced and moves expiry from the renewal time", async (t) => {
  const original = RunLock.findOneAndUpdate;
  t.after(() => {
    RunLock.findOneAndUpdate = original;
  });
  let observed = null;
  RunLock.findOneAndUpdate = (filter, update, options) => {
    observed = { filter, update, options };
    return {
      lean: async () => ({ _id: filter._id, token: filter.token }),
    };
  };
  const before = Date.now();
  const extended = await runLockRepository.extendRunLock("lead-delivery:phoneburner:contact-post", "token-1", 30_000);
  const after = Date.now();

  assert.equal(observed.filter._id, "lead-delivery:phoneburner:contact-post");
  assert.equal(observed.filter.token, "token-1");
  assert.equal(observed.filter.lockedUntil.$gt instanceof Date, true);
  assert.deepEqual(observed.options, { new: true });
  assert.equal(observed.update.$set.lockedUntil.getTime() >= before + 30_000, true);
  assert.equal(observed.update.$set.lockedUntil.getTime() <= after + 30_000, true);
  assert.equal(extended.token, "token-1");
  assert.equal(extended.lockedUntil.getTime(), observed.update.$set.lockedUntil.getTime());
});

