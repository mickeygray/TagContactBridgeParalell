"use strict";

// CR-3 gate: the discovery funnel.
//
// The product risk this phase carries is not "we miss a candidate" — it is "we
// enrol somebody we should not have". So almost every test here is about a
// REJECTION or a HOLD, and the distinction between the two:
//
//   rejected = this call is not a candidate, we know why
//   review   = we could not tell, so nobody gets called
//
// A `review` that quietly becomes a `rejected` loses a lead. A `review` that
// quietly becomes `qualified` dials a stranger. The second one is why every
// unproven evidence path in this service holds instead of assuming.

const test = require("node:test");
const assert = require("node:assert/strict");

const svc = require("../../packages/shared-services/src/callRecoveryDiscoveryService");
const { resolveRecoveryEpisodeTiming } = require("../../packages/shared-services/src/leadDeliveryService");

const CALL = (over = {}) => ({
  id: "CAL-1",
  direction: "inbound",
  answered: true,
  duration: 900,
  customer_phone_number: "7249674387",
  tracking_phone_number: "8005551212",
  source_name: "Urgent Third State",
  start_time: "2026-07-30T18:00:00Z",
  ...over,
});

const LEG = (over = {}) => ({
  _id: "leg-1", direction: "inbound", answered: true,
  agentId: "phil.olson", extension: "204",
  caseDomain: "TAG", caseId: 421385,
  callStartTime: "2026-07-30T18:00:10Z",
  ...over,
});

const OPEN_CASE = {
  allowedProspectStatus: true,
  convertedAt: null,
  paymentCount: 0,
  totalPaid: 0,
  firstName: "Private",
  lastName: "Example",
};

function harness(over = {}) {
  const episodes = [];
  return {
    episodes,
    deps: {
      listCallsForDay: async () => [CALL()],
      listInternalLegs: async () => [LEG()],
      readCaseState: async () => OPEN_CASE,
      resolveEpisodeTiming: (at) => resolveRecoveryEpisodeTiming(at),
      repository: {
        recordQualifyingCall: async (doc) => { episodes.push(doc); return { inserted: true, evidenceAdded: true }; },
      },
      ...over,
    },
  };
}

// ── the mail-source gate (§10) ────────────────────────────────────────────

test("a RETIRED mail piece still proves mail — provenance is historical", () => {
  // The single most important thing about this gate. Yesterday's caller
  // responded to a piece we have since stopped running; the piece was still
  // mail when they called, and current-active config is not history.
  const r = svc.proveMailSource("Urgent Third Postcard State");
  assert.equal(r.status, "proved");
});

test("LD and BCD are rejected outright, not held", () => {
  // We know exactly what they are, so they are a decision, not an ambiguity.
  for (const name of ["LD CUSTOM", "LD GENERAL", "BCD", "BCD V3"]) {
    const r = svc.proveMailSource(name);
    assert.equal(r.status, "rejected", `${name} must reject`);
    assert.match(r.reason, /^not-mail-source-/);
  }
});

test("an unrecognised source is HELD, never guessed into mail", () => {
  for (const name of ["Client Contact - TAG", "TAG Website - Number Pool", "", null, "Some 2019 Thing"]) {
    const r = svc.proveMailSource(name);
    assert.notEqual(r.status, "proved", `${JSON.stringify(name)} must not qualify as mail`);
  }
});

// ── the human-answer gate (§11) ───────────────────────────────────────────

test("a shared queue line answering for ten minutes is NOT a conversation", () => {
  // The whole reason this gate exists: CallRail's `duration` is call duration,
  // not connected-human duration. Hold music qualifies on seconds alone.
  const fact = { startedAt: new Date("2026-07-30T18:00:00Z"), tenantDomain: "TAG" };
  for (const shared of ["queue-main", "ivr", "reception", "overflow-hunt"]) {
    const r = svc.proveHumanAnswer(fact, [LEG({ agentId: shared, extension: null })]);
    assert.equal(r.status, "rejected", `${shared} must not prove a human`);
    assert.equal(r.reason, "shared-line-only");
  }
});

test("no internal leg at all holds — it does not reject", () => {
  const fact = { startedAt: new Date("2026-07-30T18:00:00Z"), tenantDomain: "TAG" };
  assert.equal(svc.proveHumanAnswer(fact, []).status, "unproven");
  assert.equal(svc.proveHumanAnswer(fact, [LEG({ answered: false })]).status, "unproven");
});

test("two plausible agents is ambiguous, and ambiguity holds", () => {
  const fact = { startedAt: new Date("2026-07-30T18:00:00Z"), tenantDomain: "TAG" };
  const r = svc.proveHumanAnswer(fact, [LEG(), LEG({ _id: "leg-2", agentId: "bruce.allen" })]);
  assert.equal(r.status, "unproven");
  assert.equal(r.reason, "multiple-agent-matches");
});

test("a leg outside the match window is not this call", () => {
  const fact = { startedAt: new Date("2026-07-30T18:00:00Z"), tenantDomain: "TAG" };
  const far = LEG({ callStartTime: "2026-07-30T19:30:00Z" });
  assert.equal(svc.proveHumanAnswer(fact, [far]).status, "unproven");
});

// ── the identity gate (§12) ───────────────────────────────────────────────

test("an ambiguous phone lookup never picks results[0]", () => {
  const fact = { tenantDomain: "TAG" };
  const r = svc.proveCaseIdentity(fact, {
    logicsMatches: [{ domain: "TAG", caseId: 1 }, { domain: "TAG", caseId: 2 }],
  });
  assert.equal(r.status, "unproven");
  assert.equal(r.reason, "multiple-case-matches");
});

test("a phone match never crosses tenants", () => {
  // One household can exist in TAG and WYNN. Guessing puts the call on the
  // wrong company's case.
  const fact = { tenantDomain: "TAG" };
  const r = svc.proveCaseIdentity(fact, { logicsMatches: [{ domain: "WYNN", caseId: 99 }] });
  assert.equal(r.status, "unproven");
});

test("an exact CallLog binding wins over everything else", () => {
  const r = svc.proveCaseIdentity({ tenantDomain: "TAG" }, {
    leg: LEG(),
    logicsMatches: [{ domain: "TAG", caseId: 777 }],
  });
  assert.equal(r.status, "proved");
  assert.equal(r.caseId, "421385");
  assert.equal(r.via, "call-log-binding");
});

// ── the still-open gate (§13) ─────────────────────────────────────────────

test("'could not verify' is never treated as 'did not close'", () => {
  assert.equal(svc.proveStillOpen(null).status, "unproven");
  assert.equal(svc.proveStillOpen({}).status, "unproven");
  assert.equal(svc.proveStillOpen({ allowedProspectStatus: null }).status, "unproven");
});

test("any sale signal rejects", () => {
  for (const state of [
    { allowedProspectStatus: true, convertedAt: new Date() },
    { allowedProspectStatus: true, paymentCount: 1 },
    { allowedProspectStatus: true, totalPaid: 250 },
    { allowedProspectStatus: true, dnc: true },
    { allowedProspectStatus: true, activeAppointment: true },
    { allowedProspectStatus: false },
  ]) {
    assert.equal(svc.proveStillOpen(state).status, "rejected", JSON.stringify(state));
  }
});

// ── the pass itself ───────────────────────────────────────────────────────

test("a clean qualifying day writes exactly one episode", async () => {
  const h = harness();
  const r = await svc.runCallRecoveryDiscovery({ apply: true, deps: h.deps });
  assert.equal(r.factsRead, 1);
  assert.equal(r.qualified, 1);
  assert.equal(r.episodesInserted, 1);
  assert.equal(h.episodes.length, 1);
  const ep = h.episodes[0];
  assert.equal(ep.domain, "TAG");
  assert.equal(ep.caseId, "421385");
  assert.equal(ep.normalizedPhone, "7249674387");
  assert.equal(ep.displayName, "Private Example");
  assert.equal(ep.sourceDateKey, r.dateKey);
  assert.equal(ep.state, "awaiting_start", "discovered has no legal edge to expired — start past it");
  assert.ok(ep.eligibleFrom > ep.callAt, "start is the NEXT business morning, never same-day");
});

test("shadow mode reads and decides everything but writes nothing", async () => {
  // The dry run and the real run share one code path on purpose: what the
  // funnel reports is what arming it would actually do.
  const h = harness();
  const r = await svc.runCallRecoveryDiscovery({ apply: false, deps: h.deps });
  assert.equal(r.qualified, 1);
  assert.equal(r.episodesInserted, 0);
  assert.equal(h.episodes.length, 0);
  assert.equal(r.rejectedByReason["would-qualify"], 1);
});

test("599 seconds is counted as a rejection with its own reason", async () => {
  const h = harness({ listCallsForDay: async () => [CALL({ duration: 599 })] });
  const r = await svc.runCallRecoveryDiscovery({ apply: true, deps: h.deps });
  assert.equal(r.qualified, 0);
  assert.equal(r.rejectedByReason["duration-below-threshold"], 1);
  assert.equal(h.episodes.length, 0);
});

test("a failed day read is an ERROR, never an empty day", async () => {
  // These look identical in a count-only funnel unless the read failure is
  // reported separately — and "zero qualified" is normal, so the alert would
  // never fire.
  const h = harness({ listCallsForDay: async () => { throw new Error("CallRail 503"); } });
  const r = await svc.runCallRecoveryDiscovery({ apply: true, deps: h.deps });
  assert.equal(r.errors, 1);
  assert.match(r.readFailed, /CallRail 503/);
  assert.equal(r.factsRead, 0);
});

test("one bad call does not abort the rest of the day", async () => {
  const h = harness({
    listCallsForDay: async () => [CALL({ id: "CAL-A" }), CALL({ id: "CAL-B" })],
    listInternalLegs: async ({ fact }) => {
      if (fact.providerCallId === "CAL-A") throw new Error("leg lookup exploded");
      return [LEG()];
    },
  });
  const r = await svc.runCallRecoveryDiscovery({ apply: true, deps: h.deps });
  assert.equal(r.factsRead, 2);
  assert.equal(r.errors, 1);
  assert.equal(r.qualified, 1, "the healthy call still enrols");
});

test("the funnel is count-only — no customer detail escapes", async () => {
  const h = harness({ listCallsForDay: async () => [CALL({ duration: 100 }), CALL({ source_name: "LD CUSTOM" })] });
  const r = await svc.runCallRecoveryDiscovery({ apply: false, deps: h.deps });
  const blob = JSON.stringify(r);
  for (const secret of ["7249674387", "421385", "CAL-1", "8005551212", "phil.olson"]) {
    assert.ok(!blob.includes(secret), `funnel leaked ${secret}`);
  }
  for (const v of Object.values(r.rejectedByReason)) assert.equal(typeof v, "number");
});

test("apply mode without a repository refuses rather than silently dry-running", async () => {
  await assert.rejects(
    () => svc.runCallRecoveryDiscovery({ apply: true, deps: { ...harness().deps, repository: null } }),
    /apply mode requires/,
  );
});

// ── the three defects the sanity check found ──────────────────────────────

test("a half-wired dep set fails LOUDLY instead of reporting a clean empty funnel", async () => {
  // readCaseState used to default to `async () => null`, and proveStillOpen(null)
  // holds — so with the dep missing, EVERY call held on the last gate and
  // `qualified` was structurally 0. The nightly task counts `qualified` to decide
  // whether to write, so an operator could arm discovery, watch the task report
  // itself as writing, and persist nothing at all, forever, with no error.
  const h = harness();
  const { readCaseState, ...missing } = h.deps;
  await assert.rejects(
    () => svc.runCallRecoveryDiscovery({ apply: false, deps: missing }),
    /readCaseState is required/,
  );
});

test("an unproven answered flag holds — it must never default to true", async () => {
  // The binding used to derive `answered` from a CallLog field that does not
  // exist, so the expression `result == null ? true : ...` stamped answered:true
  // on EVERY leg. Hold music would have read as a human conversation. Unknown
  // is null now, and proveHumanAnswer requires an explicit true.
  const fact = { startedAt: new Date("2026-07-30T18:00:00Z"), tenantDomain: "TAG" };
  const unknown = { ...LEG(), answered: null };
  assert.equal(svc.proveHumanAnswer(fact, [unknown]).status, "unproven");
  assert.equal(svc.proveHumanAnswer(fact, [{ ...LEG(), answered: undefined }]).status, "unproven");
  assert.equal(svc.proveHumanAnswer(fact, [{ ...LEG(), answered: true }]).status, "proved");
});

test("discovery sources from the METRICS loop, not a second CallRail/CallLog pull", () => {
  // Mickey 2026-07-31: "none of these should be added before they loop through
  // the metrics and this should just be an offshoot of that by which you will
  // learn the agent who touched them first."
  //
  // The first version re-derived everything from raw CallRail plus its own
  // CallLog query, and it could not work: on an INBOUND leg agentName is the
  // CALLER name and providerAgentId/ringcx.agentId/connected are never
  // populated (0 of 4,530 July legs). The name the email actually prints comes
  // from officerByCase — the settlement officer off the activity sweep — which
  // resolved 6 of 8 long calls on 2026-07-30 where the RC leg resolved none.
  const src = require("fs").readFileSync(
    require.resolve("../../apps/control-plane/src/services/nightlyHygieneRuntime"), "utf8");
  const block = src.slice(src.indexOf("function buildCallRecoveryDiscoveryDeps"),
    src.indexOf("const TASKS ="));
  assert.ok(block.includes("gatherMaterial"),
    "discovery must consume the metrics gather");
  assert.ok(block.includes("officerByCase"),
    "the agent must come from the officer sweep the metrics pass already paid for");
  assert.ok(!/CallLog.find/.test(block),
    "a second CallLog query is the duplicate this repo keeps paying for");
  assert.ok(!/createCallrailClient/.test(block),
    "and a second CallRail pull would re-ask a question the gather answered");
});
