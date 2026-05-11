"use strict";

const { envBool } = require("../../shared-config/src");

const DEFAULT_EXCLUDED_AGENT_TOKENS = Object.freeze([
  "mgray",
  "mickey gray",
  "mgray@taxadvocategroup.com",
]);

function normalizeToken(value) {
  return String(value || "").trim().toLowerCase();
}

function parseTokenList(value) {
  return String(value || "")
    .split(",")
    .map(normalizeToken)
    .filter(Boolean);
}

function getExcludedAgentTokens() {
  const raw = Object.prototype.hasOwnProperty.call(
    process.env,
    "CX_LEAD_SERVING_EXCLUDED_AGENT_TOKENS",
  )
    ? process.env.CX_LEAD_SERVING_EXCLUDED_AGENT_TOKENS
    : DEFAULT_EXCLUDED_AGENT_TOKENS.join(",");
  return parseTokenList(raw);
}

function getAllowedAgentTokens() {
  return parseTokenList(process.env.CX_LEAD_SERVING_ALLOWED_AGENT_TOKENS || "");
}

function hasExplicitLeadServingAllowlist() {
  return getAllowedAgentTokens().length > 0;
}

function buildAgentTokens(agentState = {}) {
  return [
    agentState.name,
    agentState.extensionId,
    agentState.cxAgentId,
    agentState.cxProfileId,
    agentState.email,
    agentState.userEmail,
    agentState.accountEmail,
    agentState.metadata?.email,
  ]
    .map(normalizeToken)
    .filter(Boolean);
}

function tokenMatchesAgent(candidateToken, agentTokens) {
  if (!candidateToken) return false;
  return agentTokens.some((agentToken) => {
    if (agentToken === candidateToken) return true;
    if (candidateToken.includes("@")) return agentToken === candidateToken;
    return agentToken.includes(candidateToken);
  });
}

function isLeadServingExcludedAgent(agentState = {}) {
  const agentTokens = buildAgentTokens(agentState);
  if (agentTokens.length === 0) return false;

  const allowedTokens = getAllowedAgentTokens();
  if (allowedTokens.length > 0) {
    return !allowedTokens.some((token) => tokenMatchesAgent(token, agentTokens));
  }

  if (envBool("CX_LEAD_SERVING_INCLUDE_MGRAY", false)) {
    return false;
  }

  const excludedTokens = getExcludedAgentTokens();
  if (excludedTokens.length === 0) return false;

  return excludedTokens.some((token) => tokenMatchesAgent(token, agentTokens));
}

function isLeadServingAllowedAgent(agentState = {}) {
  const agentTokens = buildAgentTokens(agentState);
  if (agentTokens.length === 0) return false;

  const allowedTokens = getAllowedAgentTokens();
  if (allowedTokens.length > 0) {
    return allowedTokens.some((token) => tokenMatchesAgent(token, agentTokens));
  }

  return !isLeadServingExcludedAgent(agentState);
}

module.exports = {
  DEFAULT_EXCLUDED_AGENT_TOKENS,
  buildAgentTokens,
  getAllowedAgentTokens,
  getExcludedAgentTokens,
  hasExplicitLeadServingAllowlist,
  isLeadServingAllowedAgent,
  isLeadServingExcludedAgent,
};
