"use strict";

const { AuthOtpChallenge } = require("../../shared-models/src");

async function expirePendingChallengesForEmail(email) {
  return AuthOtpChallenge.updateMany(
    {
      email: String(email || "").toLowerCase(),
      status: "pending",
    },
    {
      $set: {
        status: "expired",
      },
    },
  );
}

async function createAuthOtpChallenge(doc) {
  return AuthOtpChallenge.create({
    ...doc,
    email: String(doc.email || "").toLowerCase(),
  });
}

async function findLatestPendingChallengeByEmail(email) {
  return AuthOtpChallenge.findOne({
    email: String(email || "").toLowerCase(),
    status: "pending",
  })
    .sort({ createdAt: -1 });
}

async function saveAuthOtpChallenge(challenge) {
  return challenge.save();
}

async function countRecentChallengesForEmail(email, since = new Date(0)) {
  return AuthOtpChallenge.countDocuments({
    email: String(email || "").toLowerCase(),
    createdAt: { $gte: since },
  });
}

async function markChallengeStatusById(challengeId, status, extra = {}) {
  return AuthOtpChallenge.findByIdAndUpdate(
    challengeId,
    {
      $set: {
        status,
        ...extra,
      },
    },
    { new: true },
  );
}

async function decrementAttemptsForChallenge(challengeId) {
  return AuthOtpChallenge.findOneAndUpdate(
    {
      _id: challengeId,
      status: "pending",
      attemptsRemaining: { $gt: 0 },
    },
    [
      {
        $set: {
          attemptsRemaining: { $subtract: ["$attemptsRemaining", 1] },
        },
      },
      {
        $set: {
          status: {
            $cond: [
              { $lte: ["$attemptsRemaining", 0] },
              "failed",
              "$status",
            ],
          },
        },
      },
    ],
    { new: true },
  );
}

module.exports = {
  countRecentChallengesForEmail,
  createAuthOtpChallenge,
  decrementAttemptsForChallenge,
  expirePendingChallengesForEmail,
  findLatestPendingChallengeByEmail,
  markChallengeStatusById,
  saveAuthOtpChallenge,
};
