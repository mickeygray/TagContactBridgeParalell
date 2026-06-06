"use strict";

// Voicemail-drop serving resolver.
//
// Given whatever identifier the CX app sends for the agent who clicked the
// "Voicemail" button (RC internal extensionId, the dialable extensionNumber,
// cxAgentId, or email), resolve the full drop plan:
//   - targetExtensionNumber : the dialable ext for the *82 barge (NOT the id)
//   - monitorExtension       : the agent's assigned headless barger (metadata.barge)
//   - voicemailPath          : that agent's recorded message file (per-agent)
//
// Audio resolution order (first existing file wins):
//   1. metadata.barge.voicemail (explicit filename or absolute path)
//   2. <audioDir>/<extensionNumber>.raw   (convention)
//   3. <audioDir>/<email-local-part>.raw  (convention)
//   4. fallbackPath (the shared default) -- flagged via usingFallbackVoicemail
//
// Pure/injectable: pass findAgent + fileExists so it unit-tests offline.

const path = require("path");
const fs = require("fs");

const DEFAULT_AUDIO_DIR =
  process.env.VOICEMAIL_AUDIO_DIR ||
  path.resolve(__dirname, "..", "..", "..", "runtime", "audio", "voicemails");
// ONE shared voicemail for everyone (current design). The shared recording is the
// intended message for all agents; per-agent files are an optional override that
// simply won't exist. Resolution order: per-agent override -> per-agent <ext>.raw
// -> SHARED -> drop-message.raw (the legacy test clip, used only until the real
// shared recording is dropped in).
const DEFAULT_SHARED =
  process.env.VOICEMAIL_SHARED_AUDIO ||
  path.resolve(__dirname, "..", "..", "..", "runtime", "audio", "voicemail-shared.raw");
const DEFAULT_FALLBACK =
  process.env.VOICEMAIL_FALLBACK_AUDIO ||
  path.resolve(__dirname, "..", "..", "..", "runtime", "audio", "drop-message.raw");

function norm(v) {
  return String(v == null ? "" : v).trim();
}

function defaultFileExists(p) {
  try {
    return Boolean(p) && fs.existsSync(p);
  } catch {
    return false;
  }
}

// Build a Mongo-backed finder over the UserAccount model. Matches the agent by
// any of the identifiers the frontend might send, so the resolver never depends
// on which one it gets.
function makeMongoAgentFinder(UserAccount) {
  return async function findAgent(identifier) {
    const id = norm(identifier);
    if (!id) return null;
    const doc = await UserAccount.findOne({
      $or: [
        { extensionId: id },
        { extensionNumber: id },
        { cxAgentId: id },
        { email: id.toLowerCase() },
      ],
    })
      .lean()
      .exec();
    return doc || null;
  };
}

async function resolveAgentVoicemailPlan(identifier, options = {}) {
  const {
    findAgent,
    audioDir = DEFAULT_AUDIO_DIR,
    sharedPath = DEFAULT_SHARED,
    fallbackPath = DEFAULT_FALLBACK,
    fileExists = defaultFileExists,
  } = options;

  if (typeof findAgent !== "function") {
    throw new Error("resolveAgentVoicemailPlan requires options.findAgent");
  }

  const id = norm(identifier);
  if (!id) return { ok: false, reason: "no-identifier", problems: ["no-identifier"] };

  const agent = await findAgent(id);
  if (!agent) return { ok: false, reason: "agent-not-found", identifier: id, problems: ["agent-not-found"] };

  const targetExtensionNumber = norm(agent.extensionNumber) || null;
  const monitorExtension = norm(agent.metadata?.barge?.monitorExtension) || null;

  // Resolution order: optional per-agent override -> per-agent <ext>.raw ->
  // SHARED (the one-for-everyone) -> drop-message.raw (legacy test clip).
  const perAgent = [];
  const explicit = norm(agent.metadata?.barge?.voicemail);
  if (explicit) perAgent.push(path.isAbsolute(explicit) ? explicit : path.join(audioDir, explicit));
  if (targetExtensionNumber) perAgent.push(path.join(audioDir, `${targetExtensionNumber}.raw`));
  const emailLocal = norm(agent.email).split("@")[0];
  if (emailLocal) perAgent.push(path.join(audioDir, `${emailLocal}.raw`));

  const perAgentPath = perAgent.find((c) => fileExists(c)) || null;
  let voicemailPath = perAgentPath;
  let usingSharedVoicemail = false;
  let usingLegacyFallback = false;
  if (!voicemailPath && fileExists(sharedPath)) {
    voicemailPath = sharedPath;            // the intended one-for-everyone message
    usingSharedVoicemail = true;
  }
  if (!voicemailPath && fileExists(fallbackPath)) {
    voicemailPath = fallbackPath;          // legacy test clip until the shared recording exists
    usingSharedVoicemail = true;
    usingLegacyFallback = true;
  }

  const problems = [];
  if (!targetExtensionNumber) problems.push("missing-extensionNumber");
  if (!monitorExtension) problems.push("missing-monitorExtension");
  if (!voicemailPath) problems.push("missing-voicemail-file");
  // Using the shared recording is NORMAL (one voicemail for everyone) -> not a problem.
  // Only flag when we've fallen all the way to the legacy test clip (shared not recorded yet).
  else if (usingLegacyFallback) problems.push("shared-recording-not-set");

  // Barge-able requires at minimum a dialable target + something to play.
  const ok = Boolean(targetExtensionNumber && voicemailPath);

  return {
    ok,
    identifier: id,
    agentName: agent.name || null,
    agentEmail: agent.email || null,
    agentExtensionId: norm(agent.extensionId) || null,
    targetExtensionNumber,
    monitorExtension,
    voicemailPath,
    usingSharedVoicemail,
    usingLegacyFallback,
    // Back-compat: old callers read usingFallbackVoicemail to mean "not a personalized
    // file". With one-voicemail-for-everyone, that's the shared message (normal).
    usingFallbackVoicemail: usingSharedVoicemail,
    voicemailCandidatesTried: perAgent.concat([sharedPath, fallbackPath]),
    problems,
  };
}

module.exports = {
  resolveAgentVoicemailPlan,
  makeMongoAgentFinder,
  DEFAULT_AUDIO_DIR,
  DEFAULT_SHARED,
  DEFAULT_FALLBACK,
};
