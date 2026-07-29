"use strict";

const express = require("express");
const {
  isOpaqueReviewSourceId,
} = require("../../../../packages/shared-services/src/trainingCallReviewSourceContract");

const SUPPORTED_DOMAINS = new Set(["TAG", "WYNN", "AMITY"]);
const REVIEW_STATUSES = new Set(["processing", "completed", "failed"]);
const ALLOWED_CASE_BODY_KEYS = new Set(["domain", "caseNumber"]);
const ALLOWED_ANALYZE_BODY_KEYS = new Set([
  "caseSourceId",
  "sourceId",
  "requestId",
]);

class SalesTrainerCallReviewRouteError extends Error {
  constructor(status, code) {
    super("Call Review request failed");
    this.name = "SalesTrainerCallReviewRouteError";
    this.status = status;
    this.statusCode = status;
    this.code = code;
  }
}

function routeError(status, code) {
  return new SalesTrainerCallReviewRouteError(status, code);
}

function normalizeLearnerKey(req) {
  const learnerKey = String(
    req.salesTrainerUser?.email || req.user?.email || "",
  )
    .trim()
    .toLowerCase();
  if (!learnerKey || learnerKey.length > 320) {
    throw routeError(401, "TRAINER_CALL_REVIEW_AUTH_REQUIRED");
  }
  return learnerKey;
}

function normalizeDomain(value) {
  const domain = String(value || "").trim().toUpperCase();
  if (!SUPPORTED_DOMAINS.has(domain)) {
    throw routeError(422, "TRAINER_CALL_REVIEW_INPUT_INVALID");
  }
  return domain;
}

function normalizeCaseId(value) {
  const caseId = Number(value);
  if (!Number.isSafeInteger(caseId) || caseId <= 0) {
    throw routeError(422, "TRAINER_CALL_REVIEW_INPUT_INVALID");
  }
  return caseId;
}

function normalizeRequestId(value) {
  const requestId = String(value || "").trim();
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(requestId)) {
    throw routeError(422, "TRAINER_CALL_REVIEW_INPUT_INVALID");
  }
  return requestId;
}

function normalizeReviewId(value) {
  const reviewId = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{6,160}$/.test(reviewId)) {
    throw routeError(404, "TRAINER_CALL_REVIEW_NOT_FOUND");
  }
  return reviewId;
}

function assertExactBody(body, allowedKeys) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw routeError(422, "TRAINER_CALL_REVIEW_INPUT_INVALID");
  }
  const keys = Object.keys(body);
  if (keys.some((key) => !allowedKeys.has(key))) {
    throw routeError(422, "TRAINER_CALL_REVIEW_INPUT_INVALID");
  }
}

function safeIsoDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function safeText(value, maxLength = 2_000) {
  const text = String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/https?:\/\/\S+/gi, "[redacted url]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted email]")
    .replace(/\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/g, "[redacted]")
    .replace(/(?:\+?1[-. (]*)?(?:\d{3})[-. )]*(?:\d{3})[-. ]*(?:\d{4})\b/g, "[redacted phone]")
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, "[redacted payment data]")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, maxLength) : null;
}

function safeConfidence(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : null;
}

function publicCitation(citation) {
  return {
    segmentId: safeText(citation?.segmentId, 120),
    startMs: Math.max(0, Math.floor(Number(citation?.startMs) || 0)),
    endMs: Math.max(0, Math.floor(Number(citation?.endMs) || 0)),
    quote: safeText(citation?.quote, 4_000) || "",
  };
}

function publicFinding(finding, { script = false } = {}) {
  const result = {
    findingId: safeText(finding?.findingId, 120),
    title: safeText(finding?.title, 240),
    summary: safeText(finding?.summary, 2_000),
    confidence: safeConfidence(finding?.confidence),
    citations: Array.isArray(finding?.citations)
      ? finding.citations.map(publicCitation)
      : [],
  };
  if (script) {
    result.sectionId = safeText(finding?.sectionId, 80);
    result.beatId = safeText(finding?.beatId, 160);
    result.status = [
      "observed",
      "partial",
      "missed",
      "not_applicable",
      "uncertain",
    ].includes(String(finding?.status || "").toLowerCase())
      ? String(finding.status).toLowerCase()
      : "uncertain";
  }
  return result;
}

function normalizePublicReview(review) {
  if (!review || typeof review !== "object") return null;
  const rawStatus = String(review.status || "").toLowerCase();
  const status = rawStatus === "pending" ? "processing" : rawStatus;
  const transcriptCompleted = review.transcript?.status === "completed";
  return {
    reviewId: String(review.reviewId || review._id || review.id || ""),
    status: REVIEW_STATUSES.has(status) ? status : "processing",
    generation: Math.max(0, Math.floor(Number(review.generation) || 0)),
    versions: {
      scriptVersion: safeText(review.versions?.scriptVersion, 160),
      transcriptVersion: safeText(review.versions?.transcriptVersion, 160),
      graderVersion: safeText(review.versions?.graderVersion, 160),
    },
    source: {
      provider: ["ex", "phoneburner", "callrail"].includes(
        String(review.source?.provider || "").toLowerCase(),
      )
        ? String(review.source.provider).toLowerCase()
        : null,
      startedAt: safeIsoDate(review.source?.startedAt),
      durationSec:
        review.source?.durationSec == null
          ? null
          : Math.max(0, Math.floor(Number(review.source.durationSec) || 0)),
      direction: safeText(review.source?.direction, 32) || "unknown",
      agentName: safeText(review.source?.agentName, 120),
      outcome: safeText(review.source?.outcome, 120),
    },
    transcript: transcriptCompleted
      ? {
          segments: Array.isArray(review.transcript?.segments)
            ? review.transcript.segments.map((segment) => ({
                segmentId: safeText(segment?.segmentId, 120),
                startMs: Math.max(0, Math.floor(Number(segment?.startMs) || 0)),
                endMs: Math.max(0, Math.floor(Number(segment?.endMs) || 0)),
                speaker: ["agent", "prospect", "unknown"].includes(
                  String(segment?.speaker || "").toLowerCase(),
                )
                  ? String(segment.speaker).toLowerCase()
                  : "unknown",
                speakerConfidence: safeConfidence(segment?.speakerConfidence),
                text: safeText(segment?.text, 8_000) || "",
              }))
            : [],
        }
      : null,
    scriptFindings: Array.isArray(review.scriptFindings)
      ? review.scriptFindings.map((finding) =>
          publicFinding(finding, { script: true }),
        )
      : [],
    thingsToConsider: Array.isArray(review.thingsToConsider)
      ? review.thingsToConsider.map((finding) => publicFinding(finding))
      : [],
    createdAt: safeIsoDate(review.createdAt),
    completedAt: safeIsoDate(review.completedAt),
    errorCode:
      status === "failed"
        ? String(review.errorCode || "")
            .toUpperCase()
            .replace(/[^A-Z0-9_:-]/g, "_")
            .slice(0, 120) || null
        : null,
  };
}

function safeErrorPayload(error) {
  const status = Number(error?.status || error?.statusCode);
  if (status === 401) {
    return {
      status: 401,
      body: {
        ok: false,
        error: "Trainer authentication is required.",
        code: "TRAINER_CALL_REVIEW_AUTH_REQUIRED",
      },
    };
  }
  if (status === 403) {
    return {
      status: 403,
      body: {
        ok: false,
        error: "This case is unavailable for this Trainer account.",
        code: "TRAINER_CALL_REVIEW_FORBIDDEN",
      },
    };
  }
  if (status === 404 || error?.name === "CastError") {
    return {
      status: 404,
      body: {
        ok: false,
        error: "The requested Case Review resource is unavailable.",
        code: "TRAINER_CALL_REVIEW_NOT_FOUND",
      },
    };
  }
  if (status === 409 || error?.code === "TRAINER_CALL_REVIEW_STALE_GENERATION") {
    return {
      status: 409,
      body: {
        ok: false,
        error: "The Case Review state changed. Check the case again.",
        code: "TRAINER_CALL_REVIEW_CONFLICT",
      },
    };
  }
  if (
    status === 400 ||
    status === 422 ||
    error?.code === "TRAINER_CALL_REVIEW_LOCATOR_REJECTED" ||
    error?.code === "TRAINER_CALL_REVIEW_INPUT_INVALID"
  ) {
    return {
      status: 422,
      body: {
        ok: false,
        error: "The Case Review request is invalid.",
        code: "TRAINER_CALL_REVIEW_INPUT_INVALID",
      },
    };
  }
  return {
    status: 503,
    body: {
      ok: false,
      error: "Case Review is temporarily unavailable.",
      code: "TRAINER_CALL_REVIEW_UNAVAILABLE",
    },
  };
}

function sendSafeError(res, error) {
  const failure = safeErrorPayload(error);
  return res.status(failure.status).json(failure.body);
}

function productionTokenSecret(config = {}) {
  return String(
    config.salesTrainerCallReviewSourceSecret ||
      process.env.SALES_TRAINER_CALL_REVIEW_SOURCE_SECRET ||
      config.salesTrainerTokenSecret ||
      process.env.SALES_TRAINER_TOKEN_SECRET ||
      config.jwtSecret ||
      process.env.JWT_SECRET ||
      "",
  );
}

function createProductionDependencies(config = {}) {
  const {
    createTrainingCallReviewTokenService,
  } = require("../../../../packages/shared-services/src/trainingCallReviewTokenService");
  const {
    createTrainingCallReviewSourceService,
  } = require("../../../../packages/shared-services/src/trainingCallReviewSourceService");
  const {
    createLogicsFacade,
  } = require("../../../../packages/shared-services/src/logicsFacadeService");
  const {
    userAccountRepository,
    callLogRepository,
    trainingCallReviewRepository,
  } = require("../../../../packages/shared-repositories/src");
  const {
    toPublicReview,
  } = require("../../../../packages/shared-services/src/trainingCallReviewAnalysisService");

  const tokenService = createTrainingCallReviewTokenService({
    secret: productionTokenSecret(config),
  });
  const sourceService = createTrainingCallReviewSourceService({
    findUserAccountByEmail: (email) =>
      userAccountRepository.findUserAccountByEmail(email),
    getActivitiesForCase: (domain, caseId) =>
      createLogicsFacade(domain).fetchActivities(caseId),
    listCallLogsByCaseId: (domain, caseId, options) =>
      callLogRepository.listCallLogsByCaseId(domain, caseId, options),
    issueRecordingSource: tokenService.issueRecordingSource,
  });

  return Object.freeze({
    tokenService,
    sourceService,
    findReviewById: (reviewId) =>
      trainingCallReviewRepository.findReviewById(reviewId),
    toPublicReview,
    now: () => new Date(),
    createAnalysisService({ resolveAuthorizedSource }) {
      const {
        createTrainingCallReviewProviderService,
      } = require("../../../../packages/shared-services/src/trainingCallReviewProviderService");
      const {
        createTrainingCallReviewModelService,
      } = require("../../../../packages/shared-services/src/trainingCallReviewModelService");
      const {
        createTrainingCallReviewAnalysisService,
      } = require("../../../../packages/shared-services/src/trainingCallReviewAnalysisService");
      const providerService = createTrainingCallReviewProviderService({
        resolveAuthorizedSource,
      });
      const modelService = createTrainingCallReviewModelService();
      return createTrainingCallReviewAnalysisService({
        downloadRecording: providerService.downloadRecording,
        transcribeRecording: modelService.transcribeRecording,
        gradeCallReview: modelService.gradeCallReview,
        scriptVersion: modelService.versions.scriptVersion,
        transcriptVersion: modelService.versions.transcriptVersion,
        graderVersion: modelService.versions.graderVersion,
      });
    },
  });
}

function createSalesTrainerCallReviewRouter({
  requireSalesTrainerAccess,
  analyzeLimit = (_req, _res, next) => next(),
  lookupLimit = (_req, _res, next) => next(),
  config = {},
  dependencies = {},
} = {}) {
  if (typeof requireSalesTrainerAccess !== "function") {
    throw new TypeError("requireSalesTrainerAccess middleware is required");
  }
  if (typeof analyzeLimit !== "function") {
    throw new TypeError("analyzeLimit middleware must be a function");
  }
  if (typeof lookupLimit !== "function") {
    throw new TypeError("lookupLimit middleware must be a function");
  }
  const router = express.Router();
  let production = null;
  function dependency(name) {
    if (Object.prototype.hasOwnProperty.call(dependencies, name)) {
      return dependencies[name];
    }
    if (!production) production = createProductionDependencies(config);
    return production[name];
  }

  router.post(
    "/call-review/case-calls",
    requireSalesTrainerAccess,
    lookupLimit,
    async (req, res) => {
      try {
        assertExactBody(req.body, ALLOWED_CASE_BODY_KEYS);
        const learnerKey = normalizeLearnerKey(req);
        const domain = normalizeDomain(req.body.domain);
        const caseId = normalizeCaseId(req.body.caseNumber);
        const sourceService = dependency("sourceService");
        const listed = await sourceService.listCaseCalls({
          principal: req.salesTrainerUser || req.user,
          domain,
          caseId,
        });
        const caseSourceId = dependency("tokenService").issueCaseSource({
          learnerKey,
          domain,
          caseId,
        });
        const checkedAt = dependency("now")();
        return res.json({
          ok: true,
          result: {
            caseSourceId,
            authorizationCheckedAt: safeIsoDate(checkedAt),
            calls: (Array.isArray(listed?.calls) ? listed.calls : []).map(
              (call) => ({
                sourceId: call.sourceId || null,
                provider: call.provider,
                startedAt: call.startedAt,
                durationSec: call.durationSec,
                direction: call.direction,
                agentName: safeText(call.agentName, 120),
                outcome: safeText(call.outcome, 120),
                recordingStatus: call.recordingStatus,
                reviewStatus: "not_started",
                reviewId: null,
              }),
            ),
          },
        });
      } catch (error) {
        return sendSafeError(res, error);
      }
    },
  );

  router.post(
    "/call-reviews",
    requireSalesTrainerAccess,
    analyzeLimit,
    async (req, res) => {
      try {
        assertExactBody(req.body, ALLOWED_ANALYZE_BODY_KEYS);
        const learnerKey = normalizeLearnerKey(req);
        const requestId = normalizeRequestId(req.body.requestId);
        if (!isOpaqueReviewSourceId(req.body.sourceId)) {
          throw routeError(404, "TRAINER_CALL_REVIEW_NOT_FOUND");
        }
        const caseSource = dependency("tokenService").resolveCaseSource({
          caseSourceId: req.body.caseSourceId,
          learnerKey,
        });
        const principal = req.salesTrainerUser || req.user;
        const sourceService = dependency("sourceService");
        const resolved = await sourceService.resolveAuthorizedSource({
          principal,
          domain: caseSource.domain,
          caseId: caseSource.caseId,
          sourceId: req.body.sourceId,
        });
        const candidate = resolved.recordingCandidate || resolved.candidate;
        const capturedProviderSource = Object.freeze({
          callLog: resolved.callLog,
          recordingCandidate: candidate,
        });
        const resolveAuthorizedSource = async () => capturedProviderSource;
        const source = {
          domain: resolved.authorization.domain,
          caseId: resolved.authorization.caseId,
          provider: candidate.provider,
          callFingerprint: resolved.source.callFingerprint,
          recordingFingerprint: resolved.source.recordingFingerprint,
          sourceId: req.body.sourceId,
          startedAt: resolved.callLog.callStartTime,
          durationSec: resolved.callLog.durationSec,
          direction: resolved.callLog.direction,
          agentName: resolved.callLog.agentName,
          outcome: resolved.callLog.outcome,
        };
        const analysisService = dependency("createAnalysisService")({
          resolveAuthorizedSource,
        });
        const review = normalizePublicReview(
          await analysisService.analyzeCallReview({
            learnerKey,
            source,
            requestId,
          }),
        );
        if (!review?.reviewId) {
          throw routeError(503, "TRAINER_CALL_REVIEW_UNAVAILABLE");
        }
        return res.json({
          ok: true,
          result: {
            reviewId: review.reviewId,
            status: review.status,
            generation: review.generation,
          },
        });
      } catch (error) {
        return sendSafeError(res, error);
      }
    },
  );

  router.get(
    "/call-reviews/:reviewId",
    requireSalesTrainerAccess,
    lookupLimit,
    async (req, res) => {
      try {
        const learnerKey = normalizeLearnerKey(req);
        const reviewId = normalizeReviewId(req.params.reviewId);
        let privateReview;
        try {
          privateReview = await dependency("findReviewById")(reviewId);
        } catch {
          throw routeError(404, "TRAINER_CALL_REVIEW_NOT_FOUND");
        }
        if (
          !privateReview ||
          String(privateReview.learnerKey || "").trim().toLowerCase() !==
            learnerKey
        ) {
          throw routeError(404, "TRAINER_CALL_REVIEW_NOT_FOUND");
        }
        const recordingSourceId = String(
          privateReview.recordingSourceId || "",
        ).trim();
        if (!isOpaqueReviewSourceId(recordingSourceId)) {
          throw routeError(404, "TRAINER_CALL_REVIEW_NOT_FOUND");
        }
        await dependency("sourceService").resolveAuthorizedSource({
          principal: req.salesTrainerUser || req.user,
          domain: privateReview.domain,
          caseId: privateReview.caseId,
          sourceId: recordingSourceId,
        });
        const publicReview = dependency("toPublicReview")(privateReview);
        const result = normalizePublicReview(publicReview);
        if (!result?.reviewId) {
          throw routeError(404, "TRAINER_CALL_REVIEW_NOT_FOUND");
        }
        return res.json({ ok: true, result });
      } catch (error) {
        return sendSafeError(res, error);
      }
    },
  );

  return router;
}

module.exports = {
  createSalesTrainerCallReviewRouter,
  normalizePublicReview,
  safeErrorPayload,
};
