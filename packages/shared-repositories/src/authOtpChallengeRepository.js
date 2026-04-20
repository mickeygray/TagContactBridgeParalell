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

module.exports = {
  createAuthOtpChallenge,
  expirePendingChallengesForEmail,
  findLatestPendingChallengeByEmail,
  saveAuthOtpChallenge,
};
