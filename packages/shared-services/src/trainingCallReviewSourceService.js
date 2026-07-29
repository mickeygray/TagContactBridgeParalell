"use strict";

const crypto = require("crypto");

const { getSalesTrainerFeatureFlags } = require("./salesTrainerFeatureFlags");
const {
  buildPublicCaseCallReviewSource,
  isOpaqueReviewSourceId,
  resolveCallReviewListingProvider,
  resolveCallReviewRecordingCandidate,
} = require("./trainingCallReviewSourceContract");

const TRAINING_CALL_REVIEW_DOMAINS = Object.freeze(["TAG", "WYNN", "AMITY"]);
const SETTLEMENT_OFFICER_FIELD_BY_DOMAIN = Object.freeze({
  TAG: "tagLogicsName",
  WYNN: "wynnLogicsName",
});
const MINIMUM_CALL_REVIEW_DURATION_SEC = 300;
const CASE_CALL_QUERY_LIMIT = 500;
const ASSIGNMENT_AUTHORITY = "logics-case-activities";
const ASSIGNMENT_RE = /^Assigned to\s+(.+?)\s*:\s*(.+?)\s*$/i;
const ASSIGNMENT_SUBJECT_KEYS = Object.freeze([
  "Subject",
  "ActivitySubject",
  "Activity Subject",
  "Title",
]);
const ASSIGNMENT_CREATED_KEYS = Object.freeze([
  "CreatedDate",
  "Created Date",
  "Created",
  "ActivityDate",
  "Activity Date",
  "Date",
]);
const PENDING_RECORDING_STATUSES = new Set([
  "pending",
  "processing",
  "retrying",
]);

class TrainingCallReviewSourceError extends Error {
  constructor(message, { code, status } = {}) {
    super(message);
    this.name = "TrainingCallReviewSourceError";
    this.code = code || "TRAINER_CALL_REVIEW_SOURCE_ERROR";
    this.status = Number(status) || 500;
    this.statusCode = this.status;
  }
}

function sourceError(code, status, message) {
  return new TrainingCallReviewSourceError(message, { code, status });
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function requirePrincipalEmail(principal) {
  const email = normalizeEmail(principal?.email);
  if (!email) {
    throw sourceError(
      "TRAINER_CALL_REVIEW_AUTH_REQUIRED",
      401,
      "An authenticated Trainer principal is required",
    );
  }
  return email;
}

function normalizeCallReviewDomain(value) {
  const domain = String(value || "").trim().toUpperCase();
  if (!TRAINING_CALL_REVIEW_DOMAINS.includes(domain)) {
    throw sourceError(
      "TRAINER_CALL_REVIEW_DOMAIN_UNSUPPORTED",
      422,
      "A supported company domain is required",
    );
  }
  return domain;
}

function normalizeCallReviewCaseId(value) {
  const caseId = Number(value);
  if (!Number.isSafeInteger(caseId) || caseId <= 0) {
    throw sourceError(
      "TRAINER_CALL_REVIEW_CASE_INVALID",
      422,
      "A valid case number is required",
    );
  }
  return caseId;
}

function normalizeSettlementOfficerName(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function accountRecord(value) {
  if (!value || typeof value !== "object") return null;
  return typeof value.toObject === "function" ? value.toObject() : value;
}

function resolveDomainSettlementOfficerIdentity(accountInput, domainInput) {
  const account = accountRecord(accountInput);
  const domain = normalizeCallReviewDomain(domainInput);
  if (!account || String(account.status || "").trim().toLowerCase() !== "active") {
    throw sourceError(
      "TRAINER_CALL_REVIEW_ACCOUNT_UNAVAILABLE",
      403,
      "This Trainer account is not eligible for Call Review",
    );
  }

  if (String(account.role || "").trim().toLowerCase() === "admin") {
    return Object.freeze({
      isAdmin: true,
      displayName: null,
      canonicalName: null,
    });
  }

  const identityField = SETTLEMENT_OFFICER_FIELD_BY_DOMAIN[domain];
  const displayName = identityField
    ? String(account[identityField] || "").trim()
    : "";
  const canonicalName = normalizeSettlementOfficerName(displayName);
  if (!identityField || !canonicalName) {
    throw sourceError(
      "TRAINER_CALL_REVIEW_IDENTITY_UNAVAILABLE",
      403,
      "A domain-specific Logics settlement-officer identity is required",
    );
  }

  return Object.freeze({
    isAdmin: false,
    displayName,
    canonicalName,
  });
}

function firstActivityValue(activity, keys) {
  if (!activity || typeof activity !== "object") return undefined;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(activity, key)) continue;
    const value = activity[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function parseActivityTime(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function parseSettlementOfficerAssignment(activity) {
  const subject = String(
    firstActivityValue(activity, ASSIGNMENT_SUBJECT_KEYS) || "",
  ).trim();
  const match = subject.match(ASSIGNMENT_RE);
  if (!match) return null;

  const role = match[1].replace(/\s+/g, " ").trim().toLowerCase();
  if (role !== "set. officer") return null;

  const rawAssignee = match[2].trim();
  const unassigned = /^--\s*Unassigned\s*--$/i.test(rawAssignee);
  const canonicalAssignee = unassigned
    ? null
    : normalizeSettlementOfficerName(rawAssignee);
  const createdAt = parseActivityTime(
    firstActivityValue(activity, ASSIGNMENT_CREATED_KEYS),
  );

  return {
    assignee: unassigned ? null : rawAssignee,
    canonicalAssignee,
    createdAt,
  };
}

/**
 * Fold only immutable Created timestamps. Modified timestamps are deliberately
 * ignored because an edited old activity must not become the current owner.
 */
function foldLatestSettlementOfficerAssignment(activities) {
  const assignments = [];
  for (const activity of Array.isArray(activities) ? activities : []) {
    const parsed = parseSettlementOfficerAssignment(activity);
    if (!parsed) continue;
    if (!parsed.createdAt || (!parsed.assignee && parsed.canonicalAssignee !== null)) {
      return Object.freeze({
        state: "ambiguous",
        assignee: null,
        canonicalAssignee: null,
        observedAt: null,
        reason: "invalid-assignment-activity",
      });
    }
    assignments.push(parsed);
  }

  if (assignments.length === 0) {
    return Object.freeze({
      state: "missing",
      assignee: null,
      canonicalAssignee: null,
      observedAt: null,
      reason: "no-settlement-officer-assignment",
    });
  }

  const latestTime = Math.max(
    ...assignments.map((assignment) => assignment.createdAt.getTime()),
  );
  const latest = assignments.filter(
    (assignment) => assignment.createdAt.getTime() === latestTime,
  );
  const latestStates = new Set(
    latest.map((assignment) => assignment.canonicalAssignee || "__unassigned__"),
  );
  if (latestStates.size !== 1) {
    return Object.freeze({
      state: "ambiguous",
      assignee: null,
      canonicalAssignee: null,
      observedAt: new Date(latestTime).toISOString(),
      reason: "conflicting-latest-assignments",
    });
  }

  const selected = [...latest].sort((left, right) =>
    String(left.assignee || "").localeCompare(String(right.assignee || "")),
  )[0];
  return Object.freeze({
    state: selected.canonicalAssignee ? "assigned" : "unassigned",
    assignee: selected.assignee,
    canonicalAssignee: selected.canonicalAssignee,
    observedAt: new Date(latestTime).toISOString(),
    reason: null,
  });
}

function defaultCallReviewFlag() {
  return getSalesTrainerFeatureFlags().callReviewV1Enabled;
}

function validateFactoryDependency(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`${name} must be a function`);
  }
  return value;
}

function callLogRecord(value) {
  if (!value || typeof value !== "object") return null;
  return typeof value.toObject === "function" ? value.toObject() : value;
}

function hasMeaningfulConnectedCall(callLog) {
  if (!callLog || typeof callLog !== "object") return false;
  if (callLog.connected === false || callLog.missed === true) return false;

  const outcome = String(callLog.outcome || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
  if (
    /\b(no\s*answer|missed|voicemail(?:\s*only)?|left\s+(?:a\s+)?voicemail|busy|failed|cancelled?|abandoned)\b/.test(
      outcome,
    )
  ) {
    return false;
  }

  if (callLog.connected === true) return true;
  if (callLog.connected !== null && callLog.connected !== undefined) return false;
  return (
    Number(callLog.durationSec) >= MINIMUM_CALL_REVIEW_DURATION_SEC &&
    Boolean(outcome)
  );
}

function selectBoundCaseCalls(rows, { domain, caseId }) {
  const selected = [];
  for (const [index, input] of (Array.isArray(rows) ? rows : []).entries()) {
    const row = callLogRecord(input);
    if (!row) continue;
    if (String(row.domain || "").trim().toUpperCase() !== domain) continue;
    if (Number(row.caseId) !== caseId) continue;

    const telephonySessionId = String(row.telephonySessionId || "").trim();
    if (!telephonySessionId) continue;

    const durationSec = Number(row.durationSec);
    if (!Number.isFinite(durationSec) || durationSec < MINIMUM_CALL_REVIEW_DURATION_SEC) {
      continue;
    }

    if (!hasMeaningfulConnectedCall(row)) continue;

    const startedAt = new Date(row.callStartTime);
    if (!Number.isFinite(startedAt.getTime())) continue;

    const provider = resolveCallReviewListingProvider(row);
    if (!provider) continue;

    selected.push({
      row,
      provider,
      telephonySessionId,
      durationSec,
      startedAt,
      index,
    });
  }

  selected.sort(
    (left, right) =>
      right.startedAt.getTime() - left.startedAt.getTime() ||
      left.index - right.index,
  );

  const seenSessions = new Set();
  return selected.filter((entry) => {
    if (seenSessions.has(entry.telephonySessionId)) return false;
    seenSessions.add(entry.telephonySessionId);
    return true;
  });
}

function recordingStatusFor(provider, callLog, candidate) {
  if (candidate.eligible) return "available";
  const status = String(callLog.recordingArchive?.status || "")
    .trim()
    .toLowerCase();
  return PENDING_RECORDING_STATUSES.has(status) ? "pending" : "unavailable";
}

function createTrainingCallReviewSourceService(dependencies = {}) {
  const findUserAccountByEmail = validateFactoryDependency(
    dependencies.findUserAccountByEmail,
    "findUserAccountByEmail",
  );
  const getActivitiesForCase = validateFactoryDependency(
    dependencies.getActivitiesForCase,
    "getActivitiesForCase",
  );
  const listCallLogsByCaseId = validateFactoryDependency(
    dependencies.listCallLogsByCaseId,
    "listCallLogsByCaseId",
  );
  const issueRecordingSource = validateFactoryDependency(
    dependencies.issueRecordingSource || dependencies.issueSourceId,
    "issueRecordingSource",
  );
  const isCallReviewEnabled =
    dependencies.isCallReviewEnabled === undefined
      ? defaultCallReviewFlag
      : typeof dependencies.isCallReviewEnabled === "function"
        ? dependencies.isCallReviewEnabled
        : () => dependencies.isCallReviewEnabled === true;

  async function assertFeatureEnabled() {
    let enabled = false;
    try {
      enabled = (await isCallReviewEnabled()) === true;
    } catch {
      enabled = false;
    }
    if (!enabled) {
      throw sourceError(
        "TRAINER_CALL_REVIEW_DISABLED",
        503,
        "Call Review is not enabled",
      );
    }
  }

  async function authorizeCaseAccess({ principal, domain: domainInput, caseId: caseInput } = {}) {
    const principalEmail = requirePrincipalEmail(principal);
    await assertFeatureEnabled();
    const domain = normalizeCallReviewDomain(domainInput);
    const caseId = normalizeCallReviewCaseId(caseInput);

    let account;
    try {
      account = accountRecord(await findUserAccountByEmail(principalEmail));
    } catch {
      throw sourceError(
        "TRAINER_CALL_REVIEW_ACCOUNT_PROVIDER_UNAVAILABLE",
        503,
        "Trainer account authorization is temporarily unavailable",
      );
    }

    const identity = resolveDomainSettlementOfficerIdentity(account, domain);
    const authorization = {
      accountId:
        account?.id != null
          ? String(account.id)
          : account?._id != null
            ? String(account._id)
            : null,
      actorEmail: normalizeEmail(account?.email) || principalEmail,
      actorRole: String(account?.role || "").trim().toLowerCase(),
      domain,
      caseId,
      isAdmin: identity.isAdmin,
      settlementOfficerName: identity.displayName,
      assignmentAuthority: identity.isAdmin ? "admin-bypass" : ASSIGNMENT_AUTHORITY,
      assignmentObservedAt: null,
    };

    let activities;
    try {
      activities = await getActivitiesForCase(domain, caseId);
    } catch {
      throw sourceError(
        "TRAINER_CALL_REVIEW_ACTIVITIES_UNAVAILABLE",
        503,
        "Current case assignment is temporarily unavailable",
      );
    }
    if (!Array.isArray(activities)) {
      throw sourceError(
        "TRAINER_CALL_REVIEW_ACTIVITIES_UNAVAILABLE",
        503,
        "Current case assignment is temporarily unavailable",
      );
    }

    const latestAssignment = foldLatestSettlementOfficerAssignment(activities);
    authorization.assignmentObservedAt = latestAssignment.observedAt;
    if (identity.isAdmin) return Object.freeze(authorization);

    if (
      latestAssignment.state !== "assigned" ||
      latestAssignment.canonicalAssignee !== identity.canonicalName
    ) {
      throw sourceError(
        "TRAINER_CALL_REVIEW_CASE_FORBIDDEN",
        403,
        "This case is not assigned to the current Trainer account",
      );
    }

    return Object.freeze(authorization);
  }

  async function readBoundCaseCalls(authorization) {
    let rows;
    try {
      rows = await listCallLogsByCaseId(
        authorization.domain,
        authorization.caseId,
        { limit: CASE_CALL_QUERY_LIMIT, includeLegacy: false },
      );
    } catch {
      throw sourceError(
        "TRAINER_CALL_REVIEW_CALLS_UNAVAILABLE",
        503,
        "Case call history is temporarily unavailable",
      );
    }
    if (!Array.isArray(rows)) {
      throw sourceError(
        "TRAINER_CALL_REVIEW_CALLS_UNAVAILABLE",
        503,
        "Case call history is temporarily unavailable",
      );
    }
    return selectBoundCaseCalls(rows, authorization);
  }

  function safeFingerprint(value) {
    const fingerprint = String(value || "").trim();
    return /^[A-Za-z0-9:_-]{16,256}$/.test(fingerprint)
      ? fingerprint
      : null;
  }

  async function issueAuthoritativeSource(authorization, entry, candidate) {
    let issued;
    try {
      issued = await issueRecordingSource({
        authorization,
        callLog: entry.row,
        recordingCandidate: candidate,
      });
    } catch {
      throw sourceError(
        "TRAINER_CALL_REVIEW_SOURCE_UNAVAILABLE",
        503,
        "A review source could not be created",
      );
    }

    const sourceId =
      typeof issued === "string"
        ? issued
        : issued?.sourceId || issued?.recordingSourceId || null;
    if (!isOpaqueReviewSourceId(sourceId)) {
      throw sourceError(
        "TRAINER_CALL_REVIEW_SOURCE_UNAVAILABLE",
        503,
        "A review source could not be created",
      );
    }

    return Object.freeze({
      sourceId,
      callFingerprint: safeFingerprint(issued?.callFingerprint),
      recordingFingerprint: safeFingerprint(issued?.recordingFingerprint),
    });
  }

  function constantTimeSourceIdMatch(left, right) {
    const leftHash = crypto.createHash("sha256").update(String(left)).digest();
    const rightHash = crypto.createHash("sha256").update(String(right)).digest();
    return crypto.timingSafeEqual(leftHash, rightHash);
  }

  async function listCaseCalls(input = {}) {
    const authorization = await authorizeCaseAccess(input);
    const entries = await readBoundCaseCalls(authorization);
    const calls = [];

    for (const entry of entries) {
      const candidate = resolveCallReviewRecordingCandidate(entry.row);
      const analysisEligible = candidate.eligible === true;
      const source = analysisEligible
        ? await issueAuthoritativeSource(authorization, entry, candidate)
        : null;
      const recordingStatus = recordingStatusFor(
        entry.provider,
        entry.row,
        candidate,
      );

      calls.push(
        buildPublicCaseCallReviewSource({
          sourceId: source?.sourceId || null,
          provider: entry.provider,
          callStartTime: entry.startedAt,
          durationSec: entry.durationSec,
          direction: entry.row.direction,
          agentName: entry.row.agentName,
          outcome: entry.row.outcome,
          recordingStatus,
          analysisEligible,
          analysisReason:
            recordingStatus === "pending"
              ? "recording-pending"
              : analysisEligible
                ? null
                : "exact-recording-evidence-unavailable",
        }),
      );
    }

    return Object.freeze({
      minimumDurationSec: MINIMUM_CALL_REVIEW_DURATION_SEC,
      calls: Object.freeze(calls),
    });
  }

  async function resolveAuthorizedSource({
    principal,
    domain,
    caseId,
    sourceId,
  } = {}) {
    const authorization = await authorizeCaseAccess({ principal, domain, caseId });
    if (!isOpaqueReviewSourceId(sourceId)) {
      throw sourceError(
        "TRAINER_CALL_REVIEW_SOURCE_NOT_FOUND",
        404,
        "The requested review source is unavailable",
      );
    }

    const entries = await readBoundCaseCalls(authorization);
    const matches = [];
    for (const entry of entries) {
      const recordingCandidate = resolveCallReviewRecordingCandidate(entry.row);
      if (!recordingCandidate.eligible) continue;
      const source = await issueAuthoritativeSource(
        authorization,
        entry,
        recordingCandidate,
      );
      if (constantTimeSourceIdMatch(source.sourceId, sourceId)) {
        matches.push({ entry, recordingCandidate, source });
      }
    }

    if (matches.length !== 1) {
      throw sourceError(
        "TRAINER_CALL_REVIEW_SOURCE_NOT_FOUND",
        404,
        "The requested review source is unavailable",
      );
    }

    const match = matches[0];
    return Object.freeze({
      authorization,
      callLog: match.entry.row,
      recordingCandidate: match.recordingCandidate,
      source: match.source,
    });
  }

  return Object.freeze({
    authorizeCaseAccess,
    listAuthorizedCaseCalls: listCaseCalls,
    listCaseCalls,
    resolveAuthorizedSource,
  });
}

module.exports = {
  ASSIGNMENT_AUTHORITY,
  CASE_CALL_QUERY_LIMIT,
  MINIMUM_CALL_REVIEW_DURATION_SEC,
  TRAINING_CALL_REVIEW_DOMAINS,
  TrainingCallReviewSourceError,
  createTrainingCallReviewSourceService,
  foldLatestSettlementOfficerAssignment,
  hasMeaningfulConnectedCall,
  normalizeCallReviewCaseId,
  normalizeCallReviewDomain,
  normalizeSettlementOfficerName,
  resolveDomainSettlementOfficerIdentity,
  selectBoundCaseCalls,
};
