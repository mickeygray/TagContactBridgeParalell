"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  withoutManagedTimestamps,
} = require("../../packages/shared-repositories/src/trainingCourseRepository");

test("course upsert inserts leave Mongoose-managed timestamps to the model", () => {
  const createdAt = new Date("2026-08-13T20:00:00.000Z");
  const updatedAt = new Date("2026-08-13T20:00:01.000Z");
  const source = {
    enrollmentId: "enrollment-1",
    requestId: "request-1",
    createdAt,
    updatedAt,
  };

  const insert = withoutManagedTimestamps(source);

  assert.deepEqual(insert, {
    enrollmentId: "enrollment-1",
    requestId: "request-1",
  });
  assert.equal(source.createdAt, createdAt);
  assert.equal(source.updatedAt, updatedAt);
});
