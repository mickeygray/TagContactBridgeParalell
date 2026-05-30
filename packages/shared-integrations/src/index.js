"use strict";

const {
  createAnthropicClient,
  extractTextBlocks,
  extractToolUse,
} = require("./anthropicClient");
const { createCallFireClient } = require("./callFireClient");
const {
  createCallrailClient,
  resolveCompanyByTrackingNumber,
  validateCompanyTrackingNumbers,
} = require("./callrailClient");
const { createDropClient } = require("./dropClient");
const { createGoogleGmailClient } = require("./googleGmailClient");
const { createGoogleDriveClient, isGoogleDriveConfigured } = require("./googleDriveClient");
const { requestJson } = require("./httpClient");
const { createLogicsClient } = require("./logicsClient");
const { createNeverBounceClient } = require("./neverBounceClient");
const { createRealPhoneValidationClient } = require("./realPhoneValidationClient");
const { createRingCentralClient } = require("./ringcentralClient");
const {
  createRingcxVoiceClient,
  getRingcxVoiceRateLimitState,
} = require("./ringcxVoiceClient");
const { createSendgridClient } = require("./sendgridClient");
const { createTrustedFormClient } = require("./trustedFormClient");
const { createCompanyRuntime, getCompanyRuntime } = require("./companyRuntime");
const githubClient = require("./githubClient");

module.exports = {
  createAnthropicClient,
  extractTextBlocks,
  extractToolUse,
  createCallFireClient,
  createCallrailClient,
  createCompanyRuntime,
  createDropClient,
  createGoogleGmailClient,
  createGoogleDriveClient,
  createLogicsClient,
  createNeverBounceClient,
  createRealPhoneValidationClient,
  createRingCentralClient,
  createRingcxVoiceClient,
  getRingcxVoiceRateLimitState,
  createSendgridClient,
  createTrustedFormClient,
  githubClient,
  getCompanyRuntime,
  isGoogleDriveConfigured,
  requestJson,
  resolveCompanyByTrackingNumber,
  validateCompanyTrackingNumbers,
};
