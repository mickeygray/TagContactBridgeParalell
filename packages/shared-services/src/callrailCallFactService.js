"use strict";

// Pure CallRail fact normalization + recovery qualification (work order CR-1).
// No Mongo, no HTTP, no flags, no provider code — everything here is a function
// of its arguments, so the qualification rules can be proved without a network.

// The ONE canonical phone normalizer. Deliberately imported rather than
// re-implemented: this repo has twice paid for a second copy of a shared rule
// drifting from the first, and casePhoneFoldService is itself dependency-free,
// so borrowing it costs nothing and keeps this module pure.
const { normalizePhone: normalizeUsPhone } = require("./casePhoneFoldService");

const CALLRAIL_PROVIDER = "callrail";
// CallRail is a SINGLE account and it belongs to TAG. This is not a default to
// be overridden — it is the tenancy fact the whole feature rests on, and the
// reason a WYNN board can never carry a CallRail call.
const CALLRAIL_TENANT_DOMAIN = "TAG";
const DEFAULT_TENANT_DOMAIN = CALLRAIL_TENANT_DOMAIN;
const MINIMUM_RECOVERY_DURATION_SECONDS = 600;

function normalizeString(value, maximumLength = 200) {
  return String(value ?? "").trim().slice(0, maximumLength);
}

function normalizeBoolean(value) {
  if (value === true || value === false) return value;
  const normalized = normalizeString(value, 20).toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;
  return null;
}

function normalizeNonNegativeInteger(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

function normalizeDate(value) {
  if (value == null || value === "") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function firstDefined(source, keys) {
  for (const key of keys) {
    if (source?.[key] != null && source[key] !== "") return source[key];
  }
  return null;
}

function normalizeCallRailCallFact(raw = {}, {
  tenantDomain = DEFAULT_TENANT_DOMAIN,
} = {}) {
  const durationSec = normalizeNonNegativeInteger(firstDefined(raw, [
    "durationSec",
    "duration",
    "duration_seconds",
  ]));
  const startedAt = normalizeDate(firstDefined(raw, [
    "startedAt",
    "start_time",
    "startTime",
  ]));
  const explicitEndedAt = normalizeDate(firstDefined(raw, [
    "endedAt",
    "end_time",
    "endTime",
  ]));
  const endedAt = explicitEndedAt || (startedAt && durationSec != null
    ? new Date(startedAt.getTime() + durationSec * 1000)
    : null);

  return {
    provider: CALLRAIL_PROVIDER,
    providerCallId: normalizeString(firstDefined(raw, ["providerCallId", "callId", "id", "call_id"]), 160) || null,
    tenantDomain: normalizeString(tenantDomain, 40).toUpperCase() || DEFAULT_TENANT_DOMAIN,
    direction: normalizeString(firstDefined(raw, ["direction", "call_type", "type"]), 40).toLowerCase() || null,
    answered: normalizeBoolean(firstDefined(raw, ["answered", "is_answered"])),
    durationSec,
    recordingDurationSec: normalizeNonNegativeInteger(firstDefined(raw, [
      "recordingDurationSec",
      "recording_duration",
    ])),
    startedAt,
    endedAt,
    customerPhone: normalizeUsPhone(firstDefined(raw, [
      "customerPhone",
      "customer_phone_number",
      "caller_number",
      // The metrics gather's own row shape — recovery consumes `callsRange`
      // rather than pulling CallRail a second time, and it spells this `phone`.
      "phone",
      "from",
    ])),
    trackingPhone: normalizeUsPhone(firstDefined(raw, [
      "trackingPhone",
      "tracking_phone_number",
      "dialed_number",
      "to",
    ])),
    sourceName: normalizeString(firstDefined(raw, ["sourceName", "source_name", "source"]), 160) || null,
    firstCall: normalizeBoolean(firstDefined(raw, ["firstCall", "first_call"])),
    priorCalls: normalizeNonNegativeInteger(firstDefined(raw, ["priorCalls", "prior_calls"])),
  };
}

function evidenceStatus(value) {
  const normalized = normalizeString(value?.status ?? value, 40).toLowerCase();
  if (["proved", "proven", "clear", "unique", "matched"].includes(normalized)) return "proved";
  if (["rejected", "false", "blocked", "terminal"].includes(normalized)) return "rejected";
  return "unproven";
}

function qualifyCallRailRecoveryFact(raw = {}, {
  tenantDomain = DEFAULT_TENANT_DOMAIN,
  mailSourceEvidence = null,
  humanAnswerEvidence = null,
  caseIdentityEvidence = null,
  currentCaseEvidence = null,
  minimumDurationSec = MINIMUM_RECOVERY_DURATION_SECONDS,
} = {}) {
  const fact = normalizeCallRailCallFact(raw, { tenantDomain });
  const requiredDuration = Number(minimumDurationSec);
  if (!Number.isInteger(requiredDuration) || requiredDuration <= 0) {
    throw new TypeError("minimumDurationSec must be a positive integer");
  }

  const reject = (reason) => ({ status: "rejected", reason, fact });
  const review = (reason) => ({ status: "review", reason, fact });

  if (!fact.providerCallId) return review("provider-call-id-unproven");
  // THIS GUARD USED TO PROVE NOTHING. `fact.tenantDomain` is COPIED from the
  // `tenantDomain` option, and the check compared it back to that same option —
  // so it could only ever fail on an empty string, and a caller asking for
  // `tenantDomain: "WYNN"` got a clean `qualified` verdict. Measured before the
  // fix. Work order §2.1(3) requires "call belongs to the TAG CallRail tenant",
  // and that requirement was unenforced while reading as enforced, which is
  // worse than no check at all.
  //
  // There is exactly one CallRail account and it is TAG's, so the tenant is not
  // a selector — any other value is a caller bug, and this says so.
  if (fact.tenantDomain !== CALLRAIL_TENANT_DOMAIN) {
    return reject("not-the-callrail-tenant");
  }
  if (fact.direction !== "inbound") return reject("not-inbound");
  if (fact.answered !== true) return reject("not-answered");
  if (fact.durationSec == null) return review("duration-unproven");
  if (fact.durationSec < requiredDuration) return reject("duration-below-threshold");
  if (!fact.customerPhone) return review("customer-phone-unproven");
  // TRACKING PHONE IS EVIDENCE, NOT A GATE. §10 lists it as the FIRST route to
  // proving a mail piece, but §2.1's ten conditions never require it — condition
  // 4 is "resolves to a historical mail piece", by whichever route works. Gating
  // on it here rejected every call that arrived from the metrics gather, which
  // carries the resolved source name but not the number that rang. The mail
  // proof below is what actually decides.

  const mailStatus = evidenceStatus(mailSourceEvidence);
  if (mailStatus === "rejected") return reject("not-historical-mail-source");
  if (mailStatus !== "proved") return review("mail-source-unproven");

  const humanStatus = evidenceStatus(humanAnswerEvidence);
  if (humanStatus === "rejected") return reject("human-answer-rejected");
  if (humanStatus !== "proved") return review("human-answer-unproven");

  const caseStatus = evidenceStatus(caseIdentityEvidence);
  if (caseStatus === "rejected") return reject("case-identity-rejected");
  if (caseStatus !== "proved") return review("case-identity-unproven");

  const currentStatus = evidenceStatus(currentCaseEvidence);
  if (currentStatus === "rejected") return reject("current-case-ineligible");
  if (currentStatus !== "proved") return review("current-case-state-unproven");

  return { status: "qualified", reason: "qualified", fact };
}

module.exports = {
  CALLRAIL_PROVIDER,
  CALLRAIL_TENANT_DOMAIN,
  DEFAULT_TENANT_DOMAIN,
  MINIMUM_RECOVERY_DURATION_SECONDS,
  normalizeCallRailCallFact,
  normalizeUsPhone,
  qualifyCallRailRecoveryFact,
};
