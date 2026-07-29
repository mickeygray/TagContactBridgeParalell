"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  asksCompanyLocation,
  containsCompanyLocationClaim,
} = require("../../packages/shared-services/src/smsCompanyFactSafety");
const {
  classifySms,
} = require("../../packages/shared-services/src/smsClassifierService");
const {
  evaluateAutoSendGates,
} = require("../../packages/shared-services/src/smsAutoResponderService");

test("company-location questions are detected without catching tax-state questions", () => {
  assert.equal(asksCompanyLocation("What state are you from?"), true);
  assert.equal(asksCompanyLocation("Where is your office?"), true);
  assert.equal(asksCompanyLocation("Are you based in California?"), true);
  assert.equal(asksCompanyLocation("What state is my case in?"), false);
  assert.equal(asksCompanyLocation("I owe California state tax."), false);
});

test("unsupported company-location claims are detected without catching ordinary based-on language", () => {
  assert.equal(containsCompanyLocationClaim("We're based out of Nevada. - Wynn Tax Solutions"), true);
  assert.equal(containsCompanyLocationClaim("Our office is in Nevada. - Wynn Tax Solutions"), true);
  assert.equal(containsCompanyLocationClaim("Based on what you shared, a rep can review it. - Wynn Tax Solutions"), false);
  assert.equal(containsCompanyLocationClaim("We're basing the next step on your notice. - Wynn Tax Solutions"), false);
});

test("the incident shape short-circuits to human review before any model call", async () => {
  const result = await classifySms({
    company: "WYNN",
    text: "What state are you from? If California don't waste my time with your bull shit",
  });

  assert.equal(result.intent, "asked_business_location");
  assert.equal(result.tier, "needs_human");
  assert.equal(result.suggestedReply, "");
  assert.equal(result.model, "deterministic-company-fact-guard");
  assert.equal(result.validationError, "company-location-not-configured");
});

test("the final auto-send gate rejects a fabricated company location", async () => {
  const result = await evaluateAutoSendGates({
    domain: "WYNN",
    phone: "0000000000",
    workflow: {},
    classification: {
      tier: "callback_prompt",
      suggestedReply: "We're based out of Nevada. - Wynn Tax Solutions",
    },
  });

  assert.deepEqual(result, {
    shouldSend: false,
    reason: "company-location-not-configured",
  });
});
