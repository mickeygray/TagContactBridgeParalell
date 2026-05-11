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
  return String(crypto.randomInt(100000, 1000000));
}

/**
 * Deliver an OTP code to an account's email via SendGrid. Required when
 * `authOtpPreview` is off (production mode). Required `AUTH_OTP_FROM_EMAIL`
 * in the env (or `SENDGRID_FROM_EMAIL` as a fallback).
 *
 * Loaded lazily because shared-auth shouldn't depend on shared-services at
 * require time (would create a cycle if anything in shared-services ever
 * wanted to require shared-auth).
 */
async function deliverOtpEmail(config, account, code) {
  const delivery = config.authOtpDelivery || {};
  const fromEmail = String(delivery.fromEmail || "").trim();
  if (!fromEmail) {
    throw new Error(
      "AUTH_OTP_FROM_EMAIL must be configured when AUTH_OTP_PREVIEW is disabled",
    );
  }

  // Require lazily to avoid a cycle if shared-services ever reaches back here.
  const { sendPlainEmail } = require("../../shared-services/src/sendgridMailService");

  const ttl = Number(config.otpTtlMinutes || 10);
  const text = [
    `Your ${delivery.subject || "sign-in code"} is ${code}.`,
    `This code expires in ${ttl} minutes.`,
    "",
    "If you didn't request this, you can safely ignore this email.",
  ].join("\n");

  const companyKey = String(
    account.company || delivery.defaultCompany || "TAG",
  ).toUpperCase();

  const payload = {
    personalizations: [
      {
        to: [{ email: account.email }],
        custom_args: {
          company: companyKey,
          channel: "auth-otp",
          purpose: "login",
        },
      },
    ],
    from: {
      email: fromEmail,
      name: delivery.fromName || "TagContactBridge",
    },
    reply_to: {
      email: fromEmail,
      name: delivery.fromName || "TagContactBridge",
    },
    subject: delivery.subject || "Your sign-in code",
    content: [{ type: "text/plain", value: text }],
  };

  await sendPlainEmail(companyKey, payload);
}

async function issueOtpChallenge(config, account, context = {}) {
  if (!account?.email) {
    throw new ValidationError("Account email is required for OTP");
  }

  const cooldownSeconds = Number(config.authRateLimits?.otpRequestCooldownSeconds || 60);
  const recentChallenges = await authOtpChallengeRepository.countRecentChallengesForEmail(
    account.email,
    new Date(Date.now() - cooldownSeconds * 1000),
  );
  if (recentChallenges > 0) {
    throw new AuthorizationError("Please wait before requesting another login code");
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

  // Deliver the code. In preview mode the caller reads `code` from the
  // returned object and surfaces it inline (dev + smoke tests). In prod
  // mode we email it via SendGrid. Failure here throws so the caller can
  // 500 back to the UI — silently accepting a send failure would lock the
  // user out with no way to know why.
  if (!config.authOtpPreview) {
    await deliverOtpEmail(config, account, code);
  }

  return {
    challengeId: String(challenge._id),
    email: account.email,
    expiresAt: challenge.expiresAt,
    attemptsRemaining: challenge.attemptsRemaining ?? config.otpMaxAttempts,
    code: config.authOtpPreview ? code : null,
  };
}

async function verifyOtpChallenge(config, account, code) {
  const challenge = await authOtpChallengeRepository.findLatestPendingChallengeByEmail(account.email);
  if (!challenge) {
    throw new AuthorizationError("No pending login challenge");
  }

  if (challenge.expiresAt.getTime() < Date.now()) {
    await authOtpChallengeRepository.markChallengeStatusById(challenge._id, "expired");
    throw new AuthorizationError("Login code expired");
  }

  const candidateHash = hashCode(config.jwtSecret, account.email, code);
  const candidateBuffer = Buffer.from(candidateHash, "utf8");
  const storedBuffer = Buffer.from(challenge.codeHash, "utf8");
  if (
    candidateBuffer.length !== storedBuffer.length ||
    !crypto.timingSafeEqual(candidateBuffer, storedBuffer)
  ) {
    const updated = await authOtpChallengeRepository.decrementAttemptsForChallenge(
      challenge._id,
    );
    // Surface the remaining-attempts count so the frontend can warn
    // ("2 attempts left") before the user gets bounced entirely.
    const remaining = Math.max(
      0,
      Number(updated?.attemptsRemaining ?? challenge.attemptsRemaining ?? 0) - 1,
    );
    const err = new AuthorizationError("Invalid login code");
    err.attemptsRemaining = remaining;
    throw err;
  }

  await authOtpChallengeRepository.markChallengeStatusById(challenge._id, "used", {
    attemptsRemaining: 0,
  });

  return {
    challengeId: String(challenge._id),
    accountId: challenge.accountId,
  };
}

module.exports = {
  issueOtpChallenge,
  verifyOtpChallenge,
};
