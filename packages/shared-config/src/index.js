"use strict";

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", "..", ".env") });
const { env, envBool, envInt } = require("./env");

const ROOT_DIR = path.resolve(__dirname, "..", "..", "..");
const {
  DEFAULT_COMPANY,
  getCompanyConfig,
  getCompanyKeys,
  resolveCompanyFromPayload,
} = require("./companyConfig");
const { getRingCentralConfig } = require("./ringCentralConfig");

const PORTS = Object.freeze({
  webClient: 3001,
  controlPlane: 5001,
  inboundGateway: 4001,
  outboundGateway: 4002,
  ringcentralCx: 6101,
  brandSshGateway: Number(process.env.BRAND_SSH_PORT || 3333),
});

const SERVICE_NAMES = Object.freeze({
  webClient: "web-client",
  controlPlane: "control-plane",
  inboundGateway: "inbound-gateway",
  outboundGateway: "outbound-gateway",
  ringcentralCx: "ringcentral-cx",
  brandSshGateway: "brand-ssh-gateway",
  eventWorker: "event-worker",
});

function boolFromEnv(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function getSharedConfig(overrides = {}) {
  return {
    rootDir: ROOT_DIR,
    mongoUri:
      overrides.mongoUri ||
      process.env.MONGO_URI ||
      "mongodb://127.0.0.1:27017/tagcontactbridge_parallel",
    parallelDbName:
      overrides.parallelDbName ||
      process.env.PARALLEL_DB_NAME ||
      "tagcontactbridge_parallel",
    jwtSecret: overrides.jwtSecret || process.env.JWT_SECRET || "change-me",
    jwtTtlHours: Number(overrides.jwtTtlHours || process.env.JWT_TTL_HOURS || 12),
    defaultLoginCode:
      overrides.defaultLoginCode || process.env.DEFAULT_LOGIN_CODE || "246810",
    otpTtlMinutes: Number(overrides.otpTtlMinutes || process.env.AUTH_OTP_TTL_MINUTES || 10),
    otpMaxAttempts: Number(overrides.otpMaxAttempts || process.env.AUTH_OTP_MAX_ATTEMPTS || 5),
    authOtpPreview: boolFromEnv(
      overrides.authOtpPreview !== undefined ? overrides.authOtpPreview : process.env.AUTH_OTP_PREVIEW,
      true,
    ),
    skipMongo: boolFromEnv(
      overrides.skipMongo !== undefined ? overrides.skipMongo : process.env.SKIP_MONGO,
      false,
    ),
    adminAccount: {
      email: env("ADMIN_EMAIL", "admin@example.com").toLowerCase(),
      name: env("ADMIN_NAME", "Parallel Admin"),
      role: "admin",
    },
    runtimeDefaults: {
      testEmail: env("PARALLEL_TEST_EMAIL", env("ADMIN_EMAIL", "admin@example.com")).toLowerCase(),
      testPhone: env("PARALLEL_TEST_PHONE", "3106665997"),
    },
    anthropic: {
      model: env("ANTHROPIC_MODEL", "claude-3-5-haiku-latest"),
      maxTokens: envInt("ANTHROPIC_MAX_TOKENS", 1200),
      temperature: Number(env("ANTHROPIC_TEMPERATURE", "0")),
    },
    internalServiceSecret:
      overrides.internalServiceSecret ||
      process.env.INTERNAL_SERVICE_SECRET ||
      process.env.OUTBOUND_GATEWAY_SECRET ||
      "",
    outboundRequireInternalAuth: boolFromEnv(
      overrides.outboundRequireInternalAuth !== undefined
        ? overrides.outboundRequireInternalAuth
        : process.env.OUTBOUND_REQUIRE_INTERNAL_AUTH,
      false,
    ),
    outboundWorker: {
      enabled: boolFromEnv(
        overrides.outboundWorkerEnabled !== undefined
          ? overrides.outboundWorkerEnabled
          : process.env.OUTBOUND_WORKER_ENABLED,
        true,
      ),
      intervalMs: envInt("OUTBOUND_WORKER_INTERVAL_MS", 5000),
      batchSize: envInt("OUTBOUND_WORKER_BATCH_SIZE", 25),
      idleSleepMs: envInt("OUTBOUND_WORKER_IDLE_SLEEP_MS", 2000),
      maxAttempts: envInt("OUTBOUND_WORKER_MAX_ATTEMPTS", 5),
    },
    controlPlaneWorker: {
      enabled: boolFromEnv(
        overrides.controlPlaneWorkerEnabled !== undefined
          ? overrides.controlPlaneWorkerEnabled
          : process.env.CONTROL_PLANE_WORKER_ENABLED,
        true,
      ),
      intervalMs: envInt("CONTROL_PLANE_WORKER_INTERVAL_MS", 5000),
      batchSize: envInt("CONTROL_PLANE_WORKER_BATCH_SIZE", 25),
      maxAttempts: envInt("CONTROL_PLANE_WORKER_MAX_ATTEMPTS", 5),
    },
    ports: PORTS,
    serviceNames: SERVICE_NAMES,
  };
}

module.exports = {
  DEFAULT_COMPANY,
  PORTS,
  ROOT_DIR,
  SERVICE_NAMES,
  getCompanyConfig,
  getCompanyKeys,
  getRingCentralConfig,
  getSharedConfig,
  resolveCompanyFromPayload,
  env,
  envBool,
  envInt,
};
