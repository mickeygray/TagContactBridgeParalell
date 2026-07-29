"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const models = require("../../packages/shared-models/src");
const repositories = require("../../packages/shared-repositories/src");

test("sealed Free Call persistence is exported with attempt and event uniqueness", () => {
  const model = models.TrainingFreeCallSession;
  assert.ok(model);
  assert.ok(repositories.trainingFreeCallSessionRepository);
  const indexes = model.schema.indexes();
  assert.ok(indexes.some(([fields, options]) =>
    fields.attemptId === 1 && options.unique === true));
  assert.ok(indexes.some(([fields, options]) =>
    fields.sessionId === 1 &&
    fields["turns.eventId"] === 1 &&
    options.unique === true));
  assert.equal(model.schema.path("sealed").options.select, false);
});
