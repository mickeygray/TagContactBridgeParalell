"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createTrainingCourseService,
} = require("../../packages/shared-services/src/trainingCourseService");
const {
  buildValidTrainingContentFixture,
} = require("../fixtures/trainer/trainingContentRegistry.fixture");

const LEARNER = Object.freeze({
  email: "learner@example.test",
  company: "FIXTURE_ONLY",
});
const OTHER = Object.freeze({
  email: "other@example.test",
  company: "FIXTURE_ONLY",
});

function contentFixture(version = "1.0.0-test") {
  const content = buildValidTrainingContentFixture();
  content.version = version;
  content.courseManifest.version = version;
  content.ruleRegistry.version = `rules-${version}`;
  content.courseManifest.title = "Synthetic Course";
  content.courseManifest.allowedCompanies = ["FIXTURE_ONLY"];
  content.courseManifest.items[0].presentation = {
    title: "Synthetic lesson",
    body: "Synthetic lesson body.",
    estimatedMinutes: 1,
  };
  content.courseManifest.items[1].presentation = {
    title: "Synthetic quiz",
    prompt: "Choose the synthetic canonical answer.",
    choices: [
      { choiceId: "a", label: "Synthetic correct" },
      { choiceId: "b", label: "Synthetic incorrect" },
    ],
  };
  content.courseManifest.items[1].assessment = {
    version: `grade-${version}`,
    canonicalAnswer: "a",
    acceptedAnswers: [],
    rubric: {
      privateCriterion: "This must never cross the API boundary.",
    },
  };
  return content;
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function createMemoryRepository() {
  const enrollments = new Map();
  const attempts = new Map();

  return {
    enrollments,
    attempts,
    async findActiveEnrollment({ learnerEmailNormalized, courseId = null }) {
      return (
        [...enrollments.values()]
          .filter(
            (value) =>
              value.learnerEmailNormalized === learnerEmailNormalized &&
              ["active", "completed"].includes(value.status) &&
              (!courseId || value.courseId === courseId),
          )
          .sort(
            (left, right) =>
              new Date(right.updatedAt).getTime() -
              new Date(left.updatedAt).getTime(),
          )
          .map(clone)[0] || null
      );
    },
    async findEnrollmentById(enrollmentId) {
      return clone(enrollments.get(enrollmentId) || null);
    },
    async findOrCreateEnrollment({
      learnerEmailNormalized,
      courseId,
      courseVersion,
      create,
    }) {
      const existing = [...enrollments.values()].find(
        (value) =>
          value.learnerEmailNormalized === learnerEmailNormalized &&
          value.courseId === courseId &&
          value.courseVersion === courseVersion,
      );
      if (existing) return clone(existing);
      enrollments.set(create.enrollmentId, clone(create));
      return clone(create);
    },
    async updateEnrollmentCas(enrollmentId, expectedVersion, set) {
      const current = enrollments.get(enrollmentId);
      if (!current || current.version !== expectedVersion) return null;
      const updated = {
        ...current,
        ...clone(set),
        version: current.version + 1,
        updatedAt: new Date(),
      };
      enrollments.set(enrollmentId, updated);
      return clone(updated);
    },
    async findAttemptById(attemptId) {
      return clone(attempts.get(attemptId) || null);
    },
    async findLatestAttemptForEnrollmentItem({ enrollmentId, itemId }) {
      return (
        [...attempts.values()]
          .filter(
            (value) =>
              value.enrollmentId === enrollmentId &&
              value.itemId === itemId &&
              !value.terminalSummary,
          )
          .sort(
            (left, right) =>
              new Date(right.createdAt).getTime() -
              new Date(left.createdAt).getTime(),
          )
          .map(clone)[0] || null
      );
    },
    async findOrCreateAttempt({
      learnerEmailNormalized,
      requestId,
      create,
    }) {
      const existingForItem = [...attempts.values()].find(
        (value) =>
          value.enrollmentId === create.enrollmentId &&
          value.itemId === create.itemId,
      );
      if (existingForItem) return clone(existingForItem);
      const existingForRequest = [...attempts.values()].find(
        (value) =>
          value.learnerEmailNormalized === learnerEmailNormalized &&
          value.requestId === requestId,
      );
      if (existingForRequest) return clone(existingForRequest);
      attempts.set(create.attemptId, clone(create));
      return clone(create);
    },
    async appendAttemptEvent({
      attemptId,
      eventId,
      expectedVersion,
      event,
      terminalSummary,
    }) {
      const current = attempts.get(attemptId);
      if (!current) {
        return { attempt: null, duplicate: false, conflict: false };
      }
      if ((current.eventIds || []).includes(eventId)) {
        return {
          attempt: clone(current),
          duplicate: true,
          conflict: false,
        };
      }
      if (current.version !== expectedVersion) {
        return {
          attempt: clone(current),
          duplicate: false,
          conflict: true,
        };
      }
      const updated = {
        ...current,
        eventIds: [...(current.eventIds || []), eventId],
        events: [...(current.events || []), clone(event)],
        version: current.version + 1,
        updatedAt: new Date(),
        ...(terminalSummary === undefined
          ? {}
          : { terminalSummary: clone(terminalSummary) }),
      };
      attempts.set(attemptId, updated);
      return {
        attempt: clone(updated),
        duplicate: false,
        conflict: false,
      };
    },
  };
}

let fixtureId = 0;

function serviceFixture({
  repository = createMemoryRepository(),
  contentProvider,
  flags = {
    courseV1Enabled: true,
    gauntletV1Enabled: false,
    callReviewV1Enabled: false,
  },
} = {}) {
  let milliseconds = Date.parse("2026-07-28T17:00:00.000Z");
  return {
    repository,
    service: createTrainingCourseService({
      repository,
      contentProvider: contentProvider || (() => contentFixture()),
      allowTestContent: true,
      flagsProvider: () => flags,
      idFactory: () => `fixture-id-${++fixtureId}`,
      now: () => new Date(milliseconds++),
    }),
  };
}

function isCourseError(status, code) {
  return (error) => error?.status === status && error?.code === code;
}

test("course stays neutral when default-off or production content is an empty draft", async () => {
  const off = createTrainingCourseService({
    repository: createMemoryRepository(),
    flagsProvider: () => ({
      courseV1Enabled: false,
      gauntletV1Enabled: false,
      callReviewV1Enabled: false,
    }),
  });
  await assert.rejects(
    off.getHome({ principal: LEARNER }),
    isCourseError(503, "TRAINER_COURSE_DISABLED"),
  );

  const unavailable = createTrainingCourseService({
    repository: createMemoryRepository(),
    flagsProvider: () => ({
      courseV1Enabled: true,
      gauntletV1Enabled: false,
      callReviewV1Enabled: false,
    }),
  });
  await assert.rejects(
    unavailable.getHome({ principal: LEARNER }),
    isCourseError(503, "TRAINER_COURSE_UNAVAILABLE"),
  );
});

test("enrollment pins company and content versions across a service restart and new publication", async () => {
  const repository = createMemoryRepository();
  const v1 = contentFixture("1.0.0-test");
  const v2 = contentFixture("2.0.0-test");
  v2.enrollmentDefault = true;
  let catalog = [v1];
  const first = serviceFixture({
    repository,
    contentProvider: () => catalog,
  });

  const enrolled = await first.service.enroll({
    principal: LEARNER,
    requestId: "enroll-request-1",
  });
  assert.equal(enrolled.enrollment.courseVersion, "1.0.0-test");
  assert.equal(enrolled.enrollment.rulePackVersion, "rules-1.0.0-test");
  assert.equal(enrolled.enrollment.resumeItemId, "fixture-item-learn");
  const stored = [...repository.enrollments.values()][0];
  assert.equal(stored.learnerEmailNormalized, LEARNER.email);
  assert.equal(stored.companySnapshot, LEARNER.company);

  catalog = [v1, v2];
  const afterRestart = serviceFixture({
    repository,
    contentProvider: () => catalog,
  });
  const home = await afterRestart.service.getHome({ principal: LEARNER });
  assert.equal(home.course.courseVersion, "1.0.0-test");
  assert.equal(home.enrollment.enrollmentId, enrolled.enrollment.enrollmentId);
  assert.equal(repository.enrollments.size, 1);

  const secondLearner = await afterRestart.service.enroll({
    principal: OTHER,
    requestId: "enroll-request-other",
  });
  assert.equal(secondLearner.enrollment.courseVersion, "2.0.0-test");
  assert.equal(repository.enrollments.size, 2);
});

test("browser remount reuses one nonterminal attempt and request collisions fail closed", async () => {
  const { service, repository } = serviceFixture();
  await service.enroll({
    principal: LEARNER,
    requestId: "enroll-request-1",
  });
  const first = await service.startAttempt({
    principal: LEARNER,
    itemId: "fixture-item-learn",
    requestId: "attempt-request-lesson",
  });
  const remount = await service.startAttempt({
    principal: LEARNER,
    itemId: "fixture-item-learn",
    requestId: "attempt-request-remount",
  });
  assert.equal(remount.attempt.attemptId, first.attempt.attemptId);
  assert.equal(repository.attempts.size, 1);

  const completed = await service.completeAttempt({
    principal: LEARNER,
    attemptId: first.attempt.attemptId,
    eventId: "complete-lesson",
    expectedVersion: 0,
  });
  assert.equal(completed.version, 1);
  assert.equal(completed.nextAssignment.itemId, "fixture-item-practice");

  await assert.rejects(
    service.startAttempt({
      principal: LEARNER,
      itemId: "fixture-item-practice",
      requestId: "attempt-request-lesson",
    }),
    isCourseError(409, "TRAINER_COURSE_REQUEST_REUSED"),
  );
  assert.equal(repository.attempts.size, 1);
});

test("server-owned grading, event CAS, duplicate recovery, and operation binding are fail-closed", async () => {
  const { service, repository } = serviceFixture();
  await service.enroll({
    principal: LEARNER,
    requestId: "enroll-request-1",
  });
  const lesson = await service.startAttempt({
    principal: LEARNER,
    itemId: "fixture-item-learn",
    requestId: "attempt-request-lesson",
  });
  await assert.rejects(
    service.addReflection({
      principal: LEARNER,
      attemptId: lesson.attempt.attemptId,
      reflection: "Too early.",
      eventId: "early-reflection",
      expectedVersion: 0,
    }),
    isCourseError(422, "TRAINER_COURSE_ATTEMPT_NOT_COMPLETE"),
  );
  await service.completeAttempt({
    principal: LEARNER,
    attemptId: lesson.attempt.attemptId,
    eventId: "complete-lesson",
    expectedVersion: 0,
  });
  const quiz = await service.startAttempt({
    principal: LEARNER,
    itemId: "fixture-item-practice",
    requestId: "attempt-request-quiz",
  });

  const failed = await service.submitAnswer({
    principal: LEARNER,
    attemptId: quiz.attempt.attemptId,
    answer: "b",
    eventId: "answer-1",
    expectedVersion: 0,
    referenceAnswer: "synthetic incorrect",
    rubric: { browserControlled: true },
  });
  assert.equal(failed.grade.passed, false);
  assert.equal(failed.version, 1);
  assert.equal(repository.attempts.get(quiz.attempt.attemptId).events.length, 1);

  const enrollment = [...repository.enrollments.values()][0];
  enrollment.activeRemediation = [];
  enrollment.resumeItemId = null;
  repository.enrollments.set(enrollment.enrollmentId, enrollment);
  const duplicate = await service.submitAnswer({
    principal: LEARNER,
    attemptId: quiz.attempt.attemptId,
    answer: "b",
    eventId: "answer-1",
    expectedVersion: 0,
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(
    [...repository.enrollments.values()][0].activeRemediation.length,
    2,
    "duplicate retry reconciles remediation lost after event append",
  );
  assert.equal(repository.attempts.get(quiz.attempt.attemptId).events.length, 1);

  await assert.rejects(
    service.submitAnswer({
      principal: LEARNER,
      attemptId: quiz.attempt.attemptId,
      answer: "a",
      eventId: "answer-1",
      expectedVersion: 1,
    }),
    isCourseError(409, "TRAINER_COURSE_EVENT_REUSED"),
  );
  await assert.rejects(
    service.completeAttempt({
      principal: LEARNER,
      attemptId: quiz.attempt.attemptId,
      eventId: "answer-1",
      expectedVersion: 1,
    }),
    isCourseError(409, "TRAINER_COURSE_EVENT_REUSED"),
  );
  await assert.rejects(
    service.submitAnswer({
      principal: LEARNER,
      attemptId: quiz.attempt.attemptId,
      answer: "a",
      eventId: "answer-stale",
      expectedVersion: 0,
    }),
    isCourseError(409, "TRAINER_COURSE_CONFLICT"),
  );
  assert.equal(repository.attempts.get(quiz.attempt.attemptId).events.length, 1);

  const passed = await service.submitAnswer({
    principal: LEARNER,
    attemptId: quiz.attempt.attemptId,
    answer: "a",
    eventId: "answer-2",
    expectedVersion: 1,
  });
  assert.equal(passed.grade.passed, true);
  const completed = await service.completeAttempt({
    principal: LEARNER,
    attemptId: quiz.attempt.attemptId,
    eventId: "complete-quiz",
    expectedVersion: 2,
  });
  assert.equal(completed.version, 3);
  const eventCount = repository.attempts.get(
    quiz.attempt.attemptId,
  ).events.length;
  const duplicateCompletion = await service.completeAttempt({
    principal: LEARNER,
    attemptId: quiz.attempt.attemptId,
    eventId: "complete-quiz",
    expectedVersion: 2,
  });
  assert.equal(duplicateCompletion.duplicate, true);
  assert.equal(
    repository.attempts.get(quiz.attempt.attemptId).events.length,
    eventCount,
  );
  await assert.rejects(
    service.completeAttempt({
      principal: LEARNER,
      attemptId: quiz.attempt.attemptId,
      eventId: "complete-again",
      expectedVersion: 3,
    }),
    isCourseError(422, "TRAINER_COURSE_ATTEMPT_TERMINAL"),
  );

  const reflected = await service.addReflection({
    principal: LEARNER,
    attemptId: quiz.attempt.attemptId,
    reflection: "Synthetic reflection.",
    eventId: "reflection-1",
    expectedVersion: 3,
  });
  assert.equal(reflected.version, 4);
  await assert.rejects(
    service.addReflection({
      principal: LEARNER,
      attemptId: quiz.attempt.attemptId,
      reflection: "Changed reflection.",
      eventId: "reflection-1",
      expectedVersion: 4,
    }),
    isCourseError(409, "TRAINER_COURSE_EVENT_REUSED"),
  );
});

test("learner and company ownership protect items, attempts, and results", async () => {
  const { service } = serviceFixture();
  const enrollment = await service.enroll({
    principal: LEARNER,
    requestId: "enroll-request-1",
  });
  const attempt = await service.startAttempt({
    principal: LEARNER,
    itemId: "fixture-item-learn",
    requestId: "attempt-request-lesson",
  });

  await assert.rejects(
    service.getResults({
      principal: OTHER,
      attemptId: attempt.attempt.attemptId,
    }),
    isCourseError(403, "TRAINER_COURSE_FORBIDDEN"),
  );
  await assert.rejects(
    service.getResults({
      principal: {
        email: LEARNER.email,
        company: "OTHER_COMPANY",
      },
      attemptId: attempt.attempt.attemptId,
    }),
    isCourseError(403, "TRAINER_COURSE_FORBIDDEN"),
  );
  assert.equal(enrollment.enrollment.courseVersion, "1.0.0-test");
});

test("item projection exposes presentation only, never canonical grading or unlock rules", async () => {
  const { service } = serviceFixture();
  await service.enroll({
    principal: LEARNER,
    requestId: "enroll-request-1",
  });
  const item = await service.getItem({
    principal: LEARNER,
    courseId: "fixture-course",
    itemId: "fixture-item-learn",
  });
  const serialized = JSON.stringify(item);
  assert.equal(item.item.content.body, "Synthetic lesson body.");
  assert.equal(serialized.includes("canonicalAnswer"), false);
  assert.equal(serialized.includes("privateCriterion"), false);
  assert.equal(serialized.includes("prerequisiteItemIds"), false);
  assert.equal(serialized.includes("grading"), false);
});

test("later-phase item types stay locked and direct access reauthorizes stale state", async () => {
  for (const itemType of ["gauntlet", "free-call", "reflection"]) {
    const repository = createMemoryRepository();
    const content = contentFixture();
    content.courseManifest.items[0].type = itemType;
    const { service } = serviceFixture({
      repository,
      contentProvider: () => content,
      flags: {
        courseV1Enabled: true,
        gauntletV1Enabled: false,
        callReviewV1Enabled: false,
      },
    });
    const enrolled = await service.enroll({
      principal: LEARNER,
      requestId: `enroll-${itemType}`,
    });
    assert.equal(enrolled.enrollment.items[0].status, "locked");

    const stored = [...repository.enrollments.values()][0];
    stored.itemStates[0].status = "available";
    repository.enrollments.set(stored.enrollmentId, stored);
    await assert.rejects(
      service.getItem({
        principal: LEARNER,
        courseId: "fixture-course",
        itemId: "fixture-item-learn",
      }),
      isCourseError(404, "TRAINER_COURSE_NOT_FOUND"),
    );

    const storedAgain = [...repository.enrollments.values()][0];
    storedAgain.itemStates[0].status = "available";
    repository.enrollments.set(storedAgain.enrollmentId, storedAgain);
    await assert.rejects(
      service.startAttempt({
        principal: LEARNER,
        itemId: "fixture-item-learn",
        requestId: `attempt-${itemType}`,
      }),
      isCourseError(422, "TRAINER_COURSE_ITEM_UNAVAILABLE"),
    );
  }
});

test("catalog selection requires one explicit enrollment default", async () => {
  const v1 = contentFixture("1.0.0-test");
  const v2 = contentFixture("2.0.0-test");
  const { service } = serviceFixture({ contentProvider: () => [v1, v2] });
  await assert.rejects(
    service.getHome({ principal: LEARNER }),
    isCourseError(503, "TRAINER_COURSE_UNAVAILABLE"),
  );

  v1.enrollmentDefault = true;
  v2.enrollmentDefault = true;
  await assert.rejects(
    service.getHome({ principal: LEARNER }),
    isCourseError(503, "TRAINER_COURSE_UNAVAILABLE"),
  );

  const validOld = contentFixture("3.0.0-test");
  const invalidDefault = contentFixture("4.0.0-test");
  invalidDefault.enrollmentDefault = true;
  invalidDefault.courseManifest.items[1].assessment.canonicalAnswer =
    "not-a-choice-id";
  const malformed = serviceFixture({
    contentProvider: () => [validOld, invalidDefault],
  });
  await assert.rejects(
    malformed.service.getHome({ principal: LEARNER }),
    isCourseError(503, "TRAINER_COURSE_UNAVAILABLE"),
  );

  const validStructuralOld = contentFixture("5.0.0-test");
  const emptyDefault = contentFixture("6.0.0-test");
  emptyDefault.enrollmentDefault = true;
  emptyDefault.courseManifest.items = [];
  const structurallyMalformed = serviceFixture({
    contentProvider: () => [validStructuralOld, emptyDefault],
  });
  await assert.rejects(
    structurallyMalformed.service.getHome({ principal: LEARNER }),
    isCourseError(503, "TRAINER_COURSE_UNAVAILABLE"),
  );
});

test("direction overlays do not authorize a directionless course", async () => {
  const content = contentFixture();
  delete content.courseManifest.allowedCompanies;
  const { service } = serviceFixture({ contentProvider: () => content });
  await assert.rejects(
    service.getHome({ principal: LEARNER }),
    isCourseError(503, "TRAINER_COURSE_UNAVAILABLE"),
  );
});

test("unscoped company overlays consistently own prerequisites and authorization", async () => {
  const repository = createMemoryRepository();
  const content = contentFixture();
  delete content.courseManifest.allowedCompanies;
  const overlay = content.courseManifest.overlays[0];
  delete overlay.scope.direction;
  overlay.itemOverrides[0].prerequisiteItemIds = [];
  const { service } = serviceFixture({
    repository,
    contentProvider: () => content,
  });
  const enrolled = await service.enroll({
    principal: LEARNER,
    requestId: "overlay-enroll",
  });
  assert.equal(
    enrolled.enrollment.items.find(
      (item) => item.itemId === "fixture-item-practice",
    ).status,
    "available",
  );

  const stored = [...repository.enrollments.values()][0];
  stored.itemStates.find(
    (state) => state.itemId === "fixture-item-practice",
  ).status = "locked";
  repository.enrollments.set(stored.enrollmentId, stored);
  const home = await service.getHome({ principal: LEARNER });
  assert.equal(
    home.enrollment.items.find(
      (item) => item.itemId === "fixture-item-practice",
    ).status,
    "available",
  );
  const item = await service.getItem({
    principal: LEARNER,
    courseId: "fixture-course",
    itemId: "fixture-item-practice",
  });
  assert.equal(item.item.status, "available");
});

test("choice IDs grade exactly and malformed choice contracts fail closed", async () => {
  for (const mutate of [
    (content) => {
      content.courseManifest.items[1].assessment.canonicalAnswer =
        "Synthetic correct";
    },
    (content) => {
      content.courseManifest.items[1].presentation.choices = [
        { choiceId: "a", label: "One" },
        { choiceId: " a ", label: "Two" },
      ];
    },
    (content) => {
      delete content.courseManifest.items[1].assessment;
    },
    (content) => {
      delete content.courseManifest.items[1].assessment.version;
    },
    (content) => {
      content.courseManifest.items[1].assessment.acceptedAnswers = [
        "a",
      ];
    },
    (content) => {
      delete content.courseManifest.items[1].presentation.choices;
      content.courseManifest.items[1].assessment.canonicalAnswer =
        "Synthetic correct";
      content.courseManifest.items[1].assessment.acceptedAnswers = [
        " synthetic   CORRECT ",
      ];
    },
  ]) {
    const invalid = contentFixture();
    mutate(invalid);
    const { service } = serviceFixture({ contentProvider: () => invalid });
    await assert.rejects(
      service.getHome({ principal: LEARNER }),
      isCourseError(503, "TRAINER_COURSE_UNAVAILABLE"),
    );
  }

  const content = contentFixture();
  content.courseManifest.items[1].presentation.choices = [
    { choiceId: "A", label: "Upper" },
    { choiceId: "a", label: "Lower" },
  ];
  content.courseManifest.items[1].assessment.canonicalAnswer = "A";
  const { service } = serviceFixture({ contentProvider: () => content });
  await service.enroll({ principal: LEARNER, requestId: "choice-enroll" });
  const lesson = await service.startAttempt({
    principal: LEARNER,
    itemId: "fixture-item-learn",
    requestId: "choice-lesson",
  });
  await service.completeAttempt({
    principal: LEARNER,
    attemptId: lesson.attempt.attemptId,
    eventId: "choice-lesson-complete",
    expectedVersion: 0,
  });
  const quiz = await service.startAttempt({
    principal: LEARNER,
    itemId: "fixture-item-practice",
    requestId: "choice-quiz",
  });
  const unknown = await service.submitAnswer({
    principal: LEARNER,
    attemptId: quiz.attempt.attemptId,
    answer: "missing",
    eventId: "choice-answer-1",
    expectedVersion: 0,
  });
  assert.equal(unknown.grade.passed, false);
  const lower = await service.submitAnswer({
    principal: LEARNER,
    attemptId: quiz.attempt.attemptId,
    answer: "a",
    eventId: "choice-answer-2",
    expectedVersion: 1,
  });
  assert.equal(lower.grade.passed, false);
  const upper = await service.submitAnswer({
    principal: LEARNER,
    attemptId: quiz.attempt.attemptId,
    answer: " A ",
    eventId: "choice-answer-3",
    expectedVersion: 2,
  });
  assert.equal(upper.grade.passed, true);
});

test("concurrent distinct start requests converge on one item attempt", async () => {
  const { service, repository } = serviceFixture();
  await service.enroll({ principal: LEARNER, requestId: "race-enroll" });
  const [left, right] = await Promise.all([
    service.startAttempt({
      principal: LEARNER,
      itemId: "fixture-item-learn",
      requestId: "race-left",
    }),
    service.startAttempt({
      principal: LEARNER,
      itemId: "fixture-item-learn",
      requestId: "race-right",
    }),
  ]);
  assert.equal(left.attempt.attemptId, right.attempt.attemptId);
  assert.equal(repository.attempts.size, 1);
  assert.equal(
    [...repository.enrollments.values()][0].itemStates[0].attemptId,
    left.attempt.attemptId,
  );
});

test("results require a terminal attempt and completed items expose their opaque attempt", async () => {
  const { service } = serviceFixture();
  await service.enroll({ principal: LEARNER, requestId: "results-enroll" });
  const lesson = await service.startAttempt({
    principal: LEARNER,
    itemId: "fixture-item-learn",
    requestId: "results-lesson",
  });
  await assert.rejects(
    service.getResults({
      principal: LEARNER,
      attemptId: lesson.attempt.attemptId,
    }),
    isCourseError(422, "TRAINER_COURSE_ATTEMPT_NOT_COMPLETE"),
  );
  await service.completeAttempt({
    principal: LEARNER,
    attemptId: lesson.attempt.attemptId,
    eventId: "results-complete",
    expectedVersion: 0,
  });
  const item = await service.getItem({
    principal: LEARNER,
    courseId: "fixture-course",
    itemId: "fixture-item-learn",
  });
  assert.equal(item.item.completedAttemptId, lesson.attempt.attemptId);
  const results = await service.getResults({
    principal: LEARNER,
    attemptId: lesson.attempt.attemptId,
  });
  assert.equal(results.attempt.status, "completed");
});

test("completion retry preserves accepted chronology after projection failure", async () => {
  const repository = createMemoryRepository();
  const originalUpdate = repository.updateEnrollmentCas.bind(repository);
  let failProjection = false;
  repository.updateEnrollmentCas = async (...args) => {
    if (failProjection) {
      failProjection = false;
      throw new Error("synthetic projection failure");
    }
    return originalUpdate(...args);
  };
  const { service } = serviceFixture({ repository });
  await service.enroll({ principal: LEARNER, requestId: "recovery-enroll" });
  const lesson = await service.startAttempt({
    principal: LEARNER,
    itemId: "fixture-item-learn",
    requestId: "recovery-lesson",
  });
  failProjection = true;
  await assert.rejects(
    service.completeAttempt({
      principal: LEARNER,
      attemptId: lesson.attempt.attemptId,
      eventId: "recovery-complete",
      expectedVersion: 0,
    }),
    /synthetic projection failure/,
  );
  const acceptedAt = repository.attempts
    .get(lesson.attempt.attemptId)
    .events.find((event) => event.eventId === "recovery-complete")
    .occurredAt;
  const restarted = serviceFixture({ repository });
  const recoveredHome = await restarted.service.getHome({
    principal: LEARNER,
  });
  assert.equal(recoveredHome.enrollment.items[0].status, "completed");
  const completedAt = repository.enrollments.values().next().value
    .itemStates[0].completedAt;
  assert.equal(new Date(completedAt).toISOString(), new Date(acceptedAt).toISOString());
  assert.equal(
    repository.attempts.get(lesson.attempt.attemptId).events.length,
    1,
  );
});

test("same-version curriculum drift fails before item access or completion append", async () => {
  const repository = createMemoryRepository();
  const content = contentFixture();
  const { service } = serviceFixture({
    repository,
    contentProvider: () => content,
  });
  await service.enroll({ principal: LEARNER, requestId: "drift-enroll" });
  const lesson = await service.startAttempt({
    principal: LEARNER,
    itemId: "fixture-item-learn",
    requestId: "drift-lesson",
  });
  content.courseManifest.items[0].version = "mutated-without-course-bump";
  await assert.rejects(
    service.getHome({ principal: LEARNER }),
    isCourseError(503, "TRAINER_COURSE_PINNED_CONTENT_MISSING"),
  );
  await assert.rejects(
    service.completeAttempt({
      principal: LEARNER,
      attemptId: lesson.attempt.attemptId,
      eventId: "drift-complete",
      expectedVersion: 0,
    }),
    isCourseError(503, "TRAINER_COURSE_PINNED_CONTENT_MISSING"),
  );
  assert.equal(repository.attempts.get(lesson.attempt.attemptId).events.length, 0);
});

test("projection recovery rejects a corrupted pinned attempt identity", async () => {
  const repository = createMemoryRepository();
  const { service } = serviceFixture({ repository });
  await service.enroll({
    principal: LEARNER,
    requestId: "corrupt-attempt-enroll",
  });
  const lesson = await service.startAttempt({
    principal: LEARNER,
    itemId: "fixture-item-learn",
    requestId: "corrupt-attempt-start",
  });
  const stored = repository.attempts.get(lesson.attempt.attemptId);
  stored.rulePackVersion = "corrupt-rule-pack-version";
  repository.attempts.set(stored.attemptId, stored);

  await assert.rejects(
    service.getHome({ principal: LEARNER }),
    isCourseError(503, "TRAINER_COURSE_PINNED_CONTENT_MISSING"),
  );
});

test("raced event IDs bind to the accepted answer and reflection payload", async () => {
  const answerFixture = serviceFixture();
  await answerFixture.service.enroll({
    principal: LEARNER,
    requestId: "event-enroll",
  });
  const lesson = await answerFixture.service.startAttempt({
    principal: LEARNER,
    itemId: "fixture-item-learn",
    requestId: "event-lesson",
  });
  await answerFixture.service.completeAttempt({
    principal: LEARNER,
    attemptId: lesson.attempt.attemptId,
    eventId: "event-lesson-complete",
    expectedVersion: 0,
  });
  const quiz = await answerFixture.service.startAttempt({
    principal: LEARNER,
    itemId: "fixture-item-practice",
    requestId: "event-quiz",
  });
  const answerRace = await Promise.allSettled([
    answerFixture.service.submitAnswer({
      principal: LEARNER,
      attemptId: quiz.attempt.attemptId,
      answer: "a",
      eventId: "same-answer-event",
      expectedVersion: 0,
    }),
    answerFixture.service.submitAnswer({
      principal: LEARNER,
      attemptId: quiz.attempt.attemptId,
      answer: "b",
      eventId: "same-answer-event",
      expectedVersion: 0,
    }),
  ]);
  assert.deepEqual(
    answerRace.map((result) => result.status).sort(),
    ["fulfilled", "rejected"],
  );
  assert.equal(
    answerRace.find((result) => result.status === "rejected").reason.code,
    "TRAINER_COURSE_EVENT_REUSED",
  );

  const reflectionFixture = serviceFixture();
  await reflectionFixture.service.enroll({
    principal: LEARNER,
    requestId: "reflection-enroll",
  });
  const reflectionLesson = await reflectionFixture.service.startAttempt({
    principal: LEARNER,
    itemId: "fixture-item-learn",
    requestId: "reflection-lesson",
  });
  await reflectionFixture.service.completeAttempt({
    principal: LEARNER,
    attemptId: reflectionLesson.attempt.attemptId,
    eventId: "reflection-complete",
    expectedVersion: 0,
  });
  const reflectionRace = await Promise.allSettled([
    reflectionFixture.service.addReflection({
      principal: LEARNER,
      attemptId: reflectionLesson.attempt.attemptId,
      reflection: "First reflection.",
      eventId: "same-reflection-event",
      expectedVersion: 1,
    }),
    reflectionFixture.service.addReflection({
      principal: LEARNER,
      attemptId: reflectionLesson.attempt.attemptId,
      reflection: "Second reflection.",
      eventId: "same-reflection-event",
      expectedVersion: 1,
    }),
  ]);
  assert.deepEqual(
    reflectionRace.map((result) => result.status).sort(),
    ["fulfilled", "rejected"],
  );
  assert.equal(
    reflectionRace.find((result) => result.status === "rejected").reason.code,
    "TRAINER_COURSE_EVENT_REUSED",
  );
});

test("an old failed-answer retry cannot resurrect remediation after pass and completion", async () => {
  const { service, repository } = serviceFixture();
  await service.enroll({ principal: LEARNER, requestId: "stale-enroll" });
  const lesson = await service.startAttempt({
    principal: LEARNER,
    itemId: "fixture-item-learn",
    requestId: "stale-lesson",
  });
  await service.completeAttempt({
    principal: LEARNER,
    attemptId: lesson.attempt.attemptId,
    eventId: "stale-lesson-complete",
    expectedVersion: 0,
  });
  const quiz = await service.startAttempt({
    principal: LEARNER,
    itemId: "fixture-item-practice",
    requestId: "stale-quiz",
  });
  await service.submitAnswer({
    principal: LEARNER,
    attemptId: quiz.attempt.attemptId,
    answer: "b",
    eventId: "stale-failed",
    expectedVersion: 0,
  });
  await service.submitAnswer({
    principal: LEARNER,
    attemptId: quiz.attempt.attemptId,
    answer: "a",
    eventId: "stale-passed",
    expectedVersion: 1,
  });
  await service.completeAttempt({
    principal: LEARNER,
    attemptId: quiz.attempt.attemptId,
    eventId: "stale-complete",
    expectedVersion: 2,
  });
  await service.submitAnswer({
    principal: LEARNER,
    attemptId: quiz.attempt.attemptId,
    answer: "b",
    eventId: "stale-failed",
    expectedVersion: 0,
  });
  const enrollment = repository.enrollments.values().next().value;
  assert.equal(
    enrollment.activeRemediation.some((entry) => entry.status === "active"),
    false,
  );
  assert.equal(enrollment.resumeItemId, null);
});

test("enrollment request IDs are durable, retryable, and operation-bound", async () => {
  const sameRepository = createMemoryRepository();
  const same = serviceFixture({ repository: sameRepository });
  const [first, duplicate] = await Promise.all([
    same.service.enroll({ principal: LEARNER, requestId: "same-enroll" }),
    same.service.enroll({ principal: LEARNER, requestId: "same-enroll" }),
  ]);
  assert.equal(
    first.enrollment.enrollmentId,
    duplicate.enrollment.enrollmentId,
  );
  assert.equal(sameRepository.enrollments.size, 1);
  await assert.rejects(
    same.service.enroll({
      principal: LEARNER,
      courseAlias: "different-course",
      requestId: "same-enroll",
    }),
    isCourseError(409, "TRAINER_COURSE_REQUEST_REUSED"),
  );

  const racedRepository = createMemoryRepository();
  const raced = serviceFixture({ repository: racedRepository });
  const results = await Promise.allSettled([
    raced.service.enroll({ principal: LEARNER, requestId: "enroll-left" }),
    raced.service.enroll({ principal: LEARNER, requestId: "enroll-right" }),
  ]);
  assert.deepEqual(
    results.map((result) => result.status).sort(),
    ["fulfilled", "rejected"],
  );
  assert.equal(
    results.find((result) => result.status === "rejected").reason.code,
    "TRAINER_COURSE_REQUEST_REUSED",
  );
  assert.equal(racedRepository.enrollments.size, 1);
});

test("home repairs accepted failed-answer remediation after a process restart", async () => {
  const repository = createMemoryRepository();
  const originalUpdate = repository.updateEnrollmentCas.bind(repository);
  let failProjection = false;
  repository.updateEnrollmentCas = async (...args) => {
    if (failProjection) {
      failProjection = false;
      throw new Error("synthetic answer projection failure");
    }
    return originalUpdate(...args);
  };
  const first = serviceFixture({ repository });
  await first.service.enroll({
    principal: LEARNER,
    requestId: "answer-recovery-enroll",
  });
  const lesson = await first.service.startAttempt({
    principal: LEARNER,
    itemId: "fixture-item-learn",
    requestId: "answer-recovery-lesson",
  });
  await first.service.completeAttempt({
    principal: LEARNER,
    attemptId: lesson.attempt.attemptId,
    eventId: "answer-recovery-lesson-complete",
    expectedVersion: 0,
  });
  const quiz = await first.service.startAttempt({
    principal: LEARNER,
    itemId: "fixture-item-practice",
    requestId: "answer-recovery-quiz",
  });
  failProjection = true;
  await assert.rejects(
    first.service.submitAnswer({
      principal: LEARNER,
      attemptId: quiz.attempt.attemptId,
      answer: "b",
      eventId: "answer-recovery-failed",
      expectedVersion: 0,
    }),
    /synthetic answer projection failure/,
  );
  assert.equal(
    repository.attempts.get(quiz.attempt.attemptId).events.length,
    1,
  );
  assert.equal(
    repository.enrollments.values().next().value.activeRemediation.length,
    0,
  );

  const restarted = serviceFixture({ repository });
  const home = await restarted.service.getHome({ principal: LEARNER });
  assert.equal(home.enrollment.activeRemediation.length, 2);
  assert.equal(home.enrollment.resumeItemId, "fixture-item-practice");

  failProjection = true;
  await assert.rejects(
    restarted.service.submitAnswer({
      principal: LEARNER,
      attemptId: quiz.attempt.attemptId,
      answer: "a",
      eventId: "answer-recovery-passed",
      expectedVersion: 1,
    }),
    /synthetic answer projection failure/,
  );
  const restartedAgain = serviceFixture({ repository });
  const repairedHome = await restartedAgain.service.getHome({
    principal: LEARNER,
  });
  assert.equal(repairedHome.enrollment.activeRemediation.length, 0);
});

test("Gauntlet availability honors its own feature flag without enabling Free Call", async () => {
  const content = contentFixture();
  content.courseManifest.items.push({
    id: "fixture-item-gauntlet", version: "1.0.0-test", status: "published",
    type: "gauntlet", ruleIds: ["fixture-rule-alpha"], prerequisiteItemIds: [],
  }, {
    id: "fixture-item-free", version: "1.0.0-test", status: "published",
    type: "free-call", ruleIds: ["fixture-rule-alpha"], prerequisiteItemIds: [],
  });
  const flags = { courseV1Enabled: true, gauntletV1Enabled: true, callReviewV1Enabled: false };
  const { service } = serviceFixture({ contentProvider: () => content, flags });
  const enrolled = await service.enroll({ principal: LEARNER, requestId: "flagged-gauntlet-enroll" });
  assert.equal(enrolled.enrollment.items.find((item) => item.itemId === "fixture-item-gauntlet").status, "available");
  assert.equal(enrolled.enrollment.items.find((item) => item.itemId === "fixture-item-free").status, "locked");
});
