"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  APPLY_ACKNOWLEDGEMENT,
  RedistributionError,
  assignContacts,
  balancedAllocations,
  parseArgs,
} = require("../../scripts/phoneburner-redistribute-bruce");

test("Bruce redistribution is dry-run by default and apply requires the exact acknowledgement", () => {
  assert.deepEqual(parseArgs([]), { help: false, apply: false, dryRun: true });
  assert.throws(
    () => parseArgs(["--apply"]),
    (error) => error instanceof RedistributionError && error.code === "apply-ack-required",
  );
  assert.deepEqual(parseArgs(["--apply", `--ack=${APPLY_ACKNOWLEDGEMENT}`]), {
    help: false,
    apply: true,
    dryRun: false,
  });
});

test("445 Bruce contacts balance the observed four pools as 111/111/111/112", () => {
  const allocations = balancedAllocations({
    brad_hansen: 446,
    phil_olson: 446,
    sean_lucas: 446,
    chris_bolt: 444,
  }, 445);
  assert.deepEqual(allocations, {
    brad_hansen: 111,
    phil_olson: 111,
    sean_lucas: 111,
    chris_bolt: 112,
  });
});

test("contact assignment consumes every quota exactly once", () => {
  const contacts = Array.from({ length: 9 }, (_, index) => ({ contactId: String(index + 1) }));
  const plan = assignContacts(contacts, {
    brad_hansen: 2,
    phil_olson: 2,
    sean_lucas: 2,
    chris_bolt: 3,
  });
  assert.equal(plan.length, 9);
  assert.deepEqual(
    Object.fromEntries(["brad_hansen", "phil_olson", "sean_lucas", "chris_bolt"].map((agentId) => [
      agentId,
      plan.filter((entry) => entry.targetAgentId === agentId).length,
    ])),
    { brad_hansen: 2, phil_olson: 2, sean_lucas: 2, chris_bolt: 3 },
  );
});

test("an already-empty Bruce folder is an idempotent zero allocation", () => {
  assert.deepEqual(balancedAllocations({
    brad_hansen: 557,
    phil_olson: 556,
    sean_lucas: 556,
    chris_bolt: 556,
  }, 0), {
    brad_hansen: 0,
    phil_olson: 0,
    sean_lucas: 0,
    chris_bolt: 0,
  });
});
