"use strict";

const express = require("express");
const {
  userAccountRepository: defaultUserAccountRepository,
} = require("../../../../packages/shared-repositories/src");
const {
  createTrainingCourseService,
} = require("../../../../packages/shared-services/src/trainingCourseService");

const BODY_KEYS = Object.freeze({
  enrollment: new Set(["courseAlias", "requestId"]),
  attempt: new Set(["itemId", "requestId"]),
  answer: new Set(["answer", "eventId", "expectedVersion"]),
  complete: new Set(["eventId", "expectedVersion"]),
  reflection: new Set(["reflection", "eventId", "expectedVersion"]),
});

function exactBody(body, allowed) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  return Object.keys(body).every((key) => allowed.has(key));
}

function safeError(error) {
  const status = Number(error?.status || error?.statusCode);
  if (status === 401) {
    return {
      status: 401,
      body: {
        ok: false,
        error: "Trainer authentication is required.",
        code: "TRAINER_COURSE_AUTH_REQUIRED",
      },
    };
  }
  if (status === 403) {
    return {
      status: 403,
      body: {
        ok: false,
        error: "This course is unavailable for this Trainer account.",
        code: "TRAINER_COURSE_FORBIDDEN",
      },
    };
  }
  if (status === 404 || error?.name === "CastError") {
    return {
      status: 404,
      body: {
        ok: false,
        error: "The requested Trainer resource is unavailable.",
        code: "TRAINER_COURSE_NOT_FOUND",
      },
    };
  }
  if (status === 409) {
    return {
      status: 409,
      body: {
        ok: false,
        error: "The course state changed. Reload and try again.",
        code: "TRAINER_COURSE_CONFLICT",
      },
    };
  }
  if (status === 400 || status === 422) {
    return {
      status: 422,
      body: {
        ok: false,
        error: "The Trainer course transition is unavailable.",
        code: "TRAINER_COURSE_INPUT_INVALID",
      },
    };
  }
  if (status === 503) {
    return {
      status: 503,
      body: {
        ok: false,
        error: "Trainer course content is currently unavailable.",
        code: "TRAINER_COURSE_UNAVAILABLE",
      },
    };
  }
  return {
    status: 500,
    body: {
      ok: false,
      error: "Trainer course request failed.",
      code: "TRAINER_COURSE_FAILED",
    },
  };
}

function createSalesTrainerCourseRouter(options = {}) {
  const router = express.Router();
  const requireSalesTrainerAccess = options.requireSalesTrainerAccess;
  if (typeof requireSalesTrainerAccess !== "function") {
    throw new TypeError("requireSalesTrainerAccess is required");
  }
  const courseService =
    options.courseService ||
    createTrainingCourseService(options.courseServiceOptions);
  const userAccountRepository =
    options.userAccountRepository || defaultUserAccountRepository;
  const courseLimit =
    typeof options.courseLimit === "function"
      ? options.courseLimit
      : (_req, _res, next) => next();

  async function principal(req) {
    const email = String(
      req.salesTrainerUser?.email || req.user?.email || "",
    )
      .trim()
      .toLowerCase();
    if (!email) {
      const error = new Error("Trainer authentication is required");
      error.status = 401;
      throw error;
    }
    let company = String(
      req.user?.company || req.salesTrainerUser?.company || "",
    )
      .trim()
      .toUpperCase();
    if (!company) {
      const account = await userAccountRepository.findUserAccountByEmail(
        email,
      );
      company = String(account?.company || "").trim().toUpperCase();
    }
    if (!company) {
      const error = new Error("Trainer company is unavailable");
      error.status = 403;
      throw error;
    }
    return { email, company };
  }

  function handler(fn) {
    return async (req, res) => {
      try {
        return res.json({
          ok: true,
          result: await fn(req),
        });
      } catch (error) {
        const safe = safeError(error);
        return res.status(safe.status).json(safe.body);
      }
    };
  }

  router.get(
    "/course/home",
    courseLimit,
    requireSalesTrainerAccess,
    handler(async (req) =>
      courseService.getHome({
        principal: await principal(req),
        courseAlias: req.query?.courseAlias || null,
      }),
    ),
  );

  router.post(
    "/enrollments",
    courseLimit,
    requireSalesTrainerAccess,
    handler(async (req) => {
      if (!exactBody(req.body, BODY_KEYS.enrollment)) {
        const error = new Error("Invalid enrollment request");
        error.status = 422;
        throw error;
      }
      return courseService.enroll({
        principal: await principal(req),
        courseAlias: req.body.courseAlias || null,
        requestId: req.body.requestId,
      });
    }),
  );

  router.get(
    "/course/:courseId/items/:itemId",
    courseLimit,
    requireSalesTrainerAccess,
    handler(async (req) =>
      courseService.getItem({
        principal: await principal(req),
        courseId: req.params.courseId,
        itemId: req.params.itemId,
      }),
    ),
  );

  router.post(
    "/attempts",
    courseLimit,
    requireSalesTrainerAccess,
    handler(async (req) => {
      if (!exactBody(req.body, BODY_KEYS.attempt)) {
        const error = new Error("Invalid attempt request");
        error.status = 422;
        throw error;
      }
      return courseService.startAttempt({
        principal: await principal(req),
        itemId: req.body.itemId,
        requestId: req.body.requestId,
      });
    }),
  );

  router.post(
    "/attempts/:attemptId/answers",
    courseLimit,
    requireSalesTrainerAccess,
    handler(async (req) => {
      if (!exactBody(req.body, BODY_KEYS.answer)) {
        const error = new Error("Invalid answer request");
        error.status = 422;
        throw error;
      }
      return courseService.submitAnswer({
        principal: await principal(req),
        attemptId: req.params.attemptId,
        answer: req.body.answer,
        eventId: req.body.eventId,
        expectedVersion: req.body.expectedVersion,
      });
    }),
  );

  router.post(
    "/attempts/:attemptId/complete",
    courseLimit,
    requireSalesTrainerAccess,
    handler(async (req) => {
      if (!exactBody(req.body, BODY_KEYS.complete)) {
        const error = new Error("Invalid completion request");
        error.status = 422;
        throw error;
      }
      return courseService.completeAttempt({
        principal: await principal(req),
        attemptId: req.params.attemptId,
        eventId: req.body.eventId,
        expectedVersion: req.body.expectedVersion,
      });
    }),
  );

  router.post(
    "/attempts/:attemptId/reflection",
    courseLimit,
    requireSalesTrainerAccess,
    handler(async (req) => {
      if (!exactBody(req.body, BODY_KEYS.reflection)) {
        const error = new Error("Invalid reflection request");
        error.status = 422;
        throw error;
      }
      return courseService.addReflection({
        principal: await principal(req),
        attemptId: req.params.attemptId,
        reflection: req.body.reflection,
        eventId: req.body.eventId,
        expectedVersion: req.body.expectedVersion,
      });
    }),
  );

  router.get(
    "/attempts/:attemptId/results",
    courseLimit,
    requireSalesTrainerAccess,
    handler(async (req) =>
      courseService.getResults({
        principal: await principal(req),
        attemptId: req.params.attemptId,
      }),
    ),
  );

  return router;
}

module.exports = {
  createSalesTrainerCourseRouter,
  safeError,
};
