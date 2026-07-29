"use strict";

const {
  TrainingAttempt,
  TrainingEnrollment,
} = require("../../shared-models/src");

function leanValue(value) {
  if (!value) return value;
  return typeof value.toObject === "function"
    ? value.toObject({ depopulate: true })
    : value;
}

async function findActiveEnrollment({
  learnerEmailNormalized,
  courseId = null,
}) {
  const query = {
    learnerEmailNormalized,
    status: { $in: ["active", "completed"] },
  };
  if (courseId) query.courseId = courseId;
  return TrainingEnrollment.findOne(query)
    .sort({ updatedAt: -1 })
    .lean();
}

async function findEnrollmentById(enrollmentId) {
  return TrainingEnrollment.findOne({ enrollmentId }).lean();
}

async function findEnrollmentByPinnedIdentity({
  learnerEmailNormalized,
  courseId,
  courseVersion,
}) {
  return TrainingEnrollment.findOne({
    learnerEmailNormalized,
    courseId,
    courseVersion,
  }).lean();
}

async function findOrCreateEnrollment({
  learnerEmailNormalized,
  courseId,
  courseVersion,
  create,
}) {
  const query = {
    learnerEmailNormalized,
    courseId,
    courseVersion,
  };
  try {
    return await TrainingEnrollment.findOneAndUpdate(
      query,
      { $setOnInsert: create },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
        runValidators: true,
      },
    ).lean();
  } catch (error) {
    if (error?.code !== 11000) throw error;
    return TrainingEnrollment.findOne(query).lean();
  }
}

async function updateEnrollmentCas(enrollmentId, expectedVersion, set) {
  return TrainingEnrollment.findOneAndUpdate(
    { enrollmentId, version: expectedVersion },
    {
      $set: set,
      $inc: { version: 1 },
    },
    { new: true, runValidators: true },
  ).lean();
}

async function findAttemptById(attemptId) {
  return TrainingAttempt.findOne({ attemptId }).lean();
}

async function findAttemptByRequest({
  learnerEmailNormalized,
  requestId,
}) {
  return TrainingAttempt.findOne({
    learnerEmailNormalized,
    requestId,
  }).lean();
}

async function findLatestAttemptForEnrollmentItem({
  enrollmentId,
  itemId,
}) {
  return TrainingAttempt.findOne({
    enrollmentId,
    itemId,
    terminalSummary: null,
  })
    .sort({ createdAt: -1 })
    .lean();
}

async function findOrCreateAttempt({
  learnerEmailNormalized,
  requestId,
  create,
}) {
  const itemQuery = {
    enrollmentId: create.enrollmentId,
    itemId: create.itemId,
  };
  try {
    return await TrainingAttempt.findOneAndUpdate(
      itemQuery,
      { $setOnInsert: create },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
        runValidators: true,
      },
    ).lean();
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const itemAttempt = await TrainingAttempt.findOne(itemQuery).lean();
    if (itemAttempt) return itemAttempt;
    return TrainingAttempt.findOne({
      learnerEmailNormalized,
      requestId,
    }).lean();
  }
}

async function appendAttemptEvent({
  attemptId,
  eventId,
  expectedVersion,
  event,
  terminalSummary,
  gauntletState,
  expectedGauntletStateVersion,
}) {
  const set = {};
  if (terminalSummary !== undefined) {
    set.terminalSummary = terminalSummary;
  }
  if (gauntletState !== undefined) {
    set.gauntletState = gauntletState;
  }
  const update = {
    $push: {
      events: event,
      eventIds: eventId,
    },
    $inc: { version: 1 },
  };
  if (Object.keys(set).length > 0) update.$set = set;

  const query = {
    attemptId,
    version: expectedVersion,
    eventIds: { $ne: eventId },
  };
  if (expectedGauntletStateVersion !== undefined) {
    query["gauntletState.stateVersion"] = expectedGauntletStateVersion;
  }

  const accepted = await TrainingAttempt.findOneAndUpdate(
    query,
    update,
    { new: true, runValidators: true },
  ).lean();
  if (accepted) {
    return {
      attempt: accepted,
      duplicate: false,
      conflict: false,
    };
  }

  const current = await TrainingAttempt.findOne({ attemptId }).lean();
  if (!current) {
    return { attempt: null, duplicate: false, conflict: false };
  }
  if ((current.eventIds || []).includes(eventId)) {
    return {
      attempt: current,
      duplicate: true,
      conflict: false,
    };
  }
  return {
    attempt: current,
    duplicate: false,
    conflict: true,
  };
}

async function createEnrollment(document) {
  return leanValue(await TrainingEnrollment.create(document));
}

async function createAttempt(document) {
  return leanValue(await TrainingAttempt.create(document));
}

module.exports = {
  appendAttemptEvent,
  createAttempt,
  createEnrollment,
  findActiveEnrollment,
  findAttemptById,
  findAttemptByRequest,
  findLatestAttemptForEnrollmentItem,
  findEnrollmentById,
  findEnrollmentByPinnedIdentity,
  findOrCreateAttempt,
  findOrCreateEnrollment,
  updateEnrollmentCas,
};
