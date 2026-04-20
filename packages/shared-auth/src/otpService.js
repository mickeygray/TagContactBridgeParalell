"use strict";

const crypto = require("crypto");
const { ValidationError, AuthorizationError } = require("../../shared-errors/src");
const { authOtpChallengeRepository } = require("../../shared-repositories/src");

function hashCode(secret, email, code) {
  return crypto
    .createHmac("sha256", secret)
    .update(`${String(email).toLowerCase()}:${String(code)}`)
    .digest("hex");
}

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function issueOtpChallenge(config, account, context = {}) {
  if (!account?.email) {
    throw new ValidationError("Account email is required for OTP");
  }

  await authOtpChallengeRepository.expirePendingChallengesForEmail(account.email);

  const code = generateCode();
  const challenge = await authOtpChallengeRepository.createAuthOtpChallenge({
    accountId: account.id,
    email: account.email,
    codeHash: hashCode(config.jwtSecret, account.email, code),
    expiresAt: new Date(Date.now() + (config.otpTtlMinutes * 60 * 1000)),
    attemptsRemaining: config.otpMaxAttempts,
    delivery: {
      channel: "email",
      previewEnabled: config.authOtpPreview,
      deliveredAt: new Date(),
    },
    metadata: {
      audience: account.audience,
      role: account.role,
      workspace: account.workspace,
      requestedByIp: context.ip || null,
    },
  });

  return {
    challengeId: String(challenge._id),
    email: account.email,
    expiresAt: challenge.expiresAt,
    code: config.authOtpPreview ? code : null,
  };
}

async function verifyOtpChallenge(config, account, code) {
  const challenge = await authOtpChallengeRepository.findLatestPendingChallengeByEmail(account.email);
  if (!challenge) {
    throw new AuthorizationError("No pending login challenge");
  }

  if (challenge.expiresAt.getTime() < Date.now()) {
    challenge.status = "expired";
    await authOtpChallengeRepository.saveAuthOtpChallenge(challenge);
    throw new AuthorizationError("Login code expired");
  }

  const candidateHash = hashCode(config.jwtSecret, account.email, code);
  if (candidateHash !== challenge.codeHash) {
    challenge.attemptsRemaining -= 1;
    if (challenge.attemptsRemaining <= 0) {
      challenge.status = "failed";
    }
    await authOtpChallengeRepository.saveAuthOtpChallenge(challenge);
    throw new AuthorizationError("Invalid login code");
  }

  challenge.status = "used";
  challenge.attemptsRemaining = 0;
  await authOtpChallengeRepository.saveAuthOtpChallenge(challenge);

  return {
    challengeId: String(challenge._id),
    accountId: challenge.accountId,
  };
}

module.exports = {
  issueOtpChallenge,
  verifyOtpChallenge,
};
