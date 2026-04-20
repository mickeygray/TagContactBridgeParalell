"use strict";

const crypto = require("crypto");
const { listAccounts, findAccountByEmail } = require("../../shared-data/src/accounts");
const { getWorkspaceForUser } = require("../../shared-services/src/workspaceService");
const { issueOtpChallenge, verifyOtpChallenge } = require("./otpService");

function signToken(payload, secret) {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${sig}`;
}

function verifyToken(token, secret) {
  if (!token || !token.includes(".")) {
    throw new Error("Invalid token");
  }

  const [encoded, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
  if (sig !== expected) {
    throw new Error("Bad signature");
  }

  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (payload.expiresAt && Number(payload.expiresAt) < Date.now()) {
    throw new Error("Token expired");
  }

  return payload;
}

function issueLoginToken(config, account) {
  const issuedAt = Date.now();
  const ttlHours = Number(config.jwtTtlHours || 12);
  return signToken(
    {
      id: account.id,
      email: account.email,
      name: account.name,
      role: account.role,
      audience: account.audience,
      capabilities: account.capabilities,
      views: account.views || [],
      workspace: account.workspace,
      stationLabel: account.stationLabel,
      company: account.company || null,
      extensionId: account.extensionId || null,
      cxAgentId: account.cxAgentId || null,
      issuedAt,
      expiresAt: issuedAt + ttlHours * 60 * 60 * 1000,
    },
    config.jwtSecret,
  );
}

function getBearerToken(req) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    return null;
  }

  return authHeader.slice("Bearer ".length);
}

function requireAuth(config) {
  return (req, res, next) => {
    try {
      const token = getBearerToken(req);
      if (!token) {
        return res.status(401).json({ ok: false, error: "Authentication required" });
      }

      req.user = verifyToken(token, config.jwtSecret);
      return next();
    } catch (error) {
      return res.status(401).json({ ok: false, error: error.message });
    }
  };
}

function requireRole(role) {
  return (req, res, next) => {
    if (req.user?.role !== role) {
      return res.status(403).json({ ok: false, error: "Forbidden" });
    }

    return next();
  };
}

module.exports = {
  createAccounts: listAccounts,
  findAccountByEmail,
  getWorkspaceForUser,
  issueOtpChallenge,
  issueLoginToken,
  requireAuth,
  requireRole,
  verifyOtpChallenge,
  verifyToken,
};
