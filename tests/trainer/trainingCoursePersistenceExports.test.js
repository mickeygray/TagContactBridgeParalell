"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const models = require("../../packages/shared-models/src");
const repositories = require("../../packages/shared-repositories/src");
const services = require("../../packages/shared-services/src");

function hasIndex(schema, key, predicate = () => true) {
  return schema
    .indexes()
    .some(([fields, options]) => {
      assert.equal(typeof options, "object");
      return JSON.stringify(fields) === JSON.stringify(key) && predicate(options);
    });
}

test("course persistence models and repository are exported", () => {
  assert.ok(models.TrainingEnrollment);
  assert.ok(models.TrainingAttempt);
  assert.ok(models.listModels().includes("TrainingEnrollment"));
  assert.ok(models.listModels().includes("TrainingAttempt"));
  assert.ok(repositories.trainingCourseRepository);
  assert.ok(services.trainingCourseService);
});

test("TrainingEnrollment has the required unique and lookup indexes", () => {
  const schema = models.TrainingEnrollment.schema;
  assert.ok(schema.path("requestId"));
  assert.equal(
    hasIndex(
      schema,
      { learnerEmailNormalized: 1, courseId: 1, courseVersion: 1 },
      (options) => options.unique === true,
    ),
    true,
  );
  assert.equal(
    hasIndex(
      schema,
      { learnerEmailNormalized: 1, requestId: 1 },
      (options) => options.unique === true,
    ),
    true,
  );
  assert.equal(
    hasIndex(schema, {
      learnerEmailNormalized: 1,
      status: 1,
      updatedAt: -1,
    }),
    true,
  );
  assert.equal(
    hasIndex(schema, {
      companySnapshot: 1,
      courseId: 1,
      courseVersion: 1,
    }),
    true,
  );
});

test("TrainingAttempt pins identity and has request, event, and history indexes", () => {
  const schema = models.TrainingAttempt.schema;
  for (const path of [
    "attemptId",
    "enrollmentId",
    "learnerEmailNormalized",
    "companySnapshot",
    "courseId",
    "courseVersion",
    "itemId",
    "itemVersion",
    "itemType",
    "rulePackVersion",
    "events",
    "version",
    "terminalSummary",
  ]) {
    assert.ok(schema.path(path), path);
  }
  assert.equal(
    hasIndex(
      schema,
      { learnerEmailNormalized: 1, requestId: 1 },
      (options) => options.unique === true,
    ),
    true,
  );
  assert.equal(
    hasIndex(
      schema,
      { attemptId: 1, "events.eventId": 1 },
      (options) => options.unique === true,
    ),
    true,
  );
  assert.equal(
    hasIndex(
      schema,
      { enrollmentId: 1, itemId: 1 },
      (options) => options.unique === true,
    ),
    true,
  );
  assert.equal(
    hasIndex(schema, { learnerEmailNormalized: 1, createdAt: -1 }),
    true,
  );
});
