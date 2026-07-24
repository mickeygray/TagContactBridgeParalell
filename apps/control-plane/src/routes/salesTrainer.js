"use strict";

const express = require("express");
const multer = require("multer");
const {
  issueOtpChallenge,
  verifyOtpChallenge,
} = require("../../../../packages/shared-auth/src/otpService");
const { verifyToken } = require("../../../../packages/shared-auth/src");
const { userAccountRepository } = require("../../../../packages/shared-repositories/src");
const { safeSecretEquals } = require("../../../../packages/shared-utils/src");
const {
  SALES_TRAINER_TTS_FORMATS,
  SALES_TRAINER_TTS_PERSONAS,
  SALES_TRAINER_TTS_VOICES,
  TAX_RESOLUTION_SALES_TRAINER_PROMPT,
  buildSalesTrainerAccount,
  getSalesTrainerConfig,
  isAnthropicConfigured,
  isEmailAllowedForSalesTrainer,
  isConfigured,
  isOpenAiConfigured,
  isSalesTrainerAccountAllowed,
  issueSalesTrainerToken,
  listConfiguredProviders,
  listPresetProfiles,
  getSalesTrainerUiState,
  gradeSalesTrainerQuizAnswer,
  publishSalesTrainerUiState,
  runSalesTrainerCoachingPanel,
  runSalesTrainerTurn,
  runTaxResolutionSalesTrainer,
  startSalesTrainerSession,
  synthesizeSalesTrainerSpeech,
  transcribeSalesTrainerAudio,
  verifySalesTrainerToken,
} = require("../../../../packages/shared-services/src/taxResolutionSalesTrainerService");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");
const { createRateLimiter } = require("../middleware/rateLimit");

const sendCodeLimit = createRateLimiter({
  windowMs: 60_000,
  max: 8,
  message: "Too many trainer code requests. Try again shortly.",
});

const verifyCodeLimit = createRateLimiter({
  windowMs: 60_000,
  max: 20,
  message: "Too many trainer verification attempts. Try again shortly.",
});

const speechLimit = createRateLimiter({
  windowMs: 60_000,
  max: 60,
  message: "Too many trainer speech requests. Try again shortly.",
});

const coachLimit = createRateLimiter({
  windowMs: 60_000,
  max: 90,
  message: "Too many trainer coach requests. Try again shortly.",
});

// Drill grading is one small model call; score-my-call is a heavy
// download + whisper + score pipeline — keep the latter tight.
const drillLimit = createRateLimiter({
  windowMs: 60_000,
  max: 30,
  message: "Too many drill submissions. Try again shortly.",
});
const scoreCallLimit = createRateLimiter({
  windowMs: 60_000,
  max: 6,
  message: "Too many call-scoring requests. Try again shortly.",
});

// One end-to-end voice turn = STT + Claude + TTS. Limit slightly tighter
// than /respond+/speech combined because each turn fans out to three
// OpenAI/Anthropic calls; we don't want a runaway mic to vacuum credit.
const turnLimit = createRateLimiter({
  windowMs: 60_000,
  max: 45,
  message: "Too many trainer voice turns. Try again shortly.",
});

// Mic uploads are kept in memory and handed straight to Whisper. 24 MB
// matches the OpenAI cap; a per-turn clip runs ~50-300 KB so this is a
// guardrail for accidental long-form uploads, not the normal size.
const trainerAudioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 24 * 1024 * 1024 },
});

// Multipart fields arrive as strings. Some clients prefer to stuff the
// whole JSON body into a single `payload` field next to the audio file;
// others send each property as its own form field. parseTurnPayload
// accepts both and returns a plain object the route can read uniformly.
function parseTurnPayload(body = {}) {
  if (body && typeof body.payload === "string" && body.payload.trim()) {
    try {
      const parsed = JSON.parse(body.payload);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // fall through and use the raw body
    }
  }
  return body || {};
}

function parseMaybeJsonField(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function getBearerToken(req) {
  const authHeader = String(req.headers.authorization || "");
  return authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
}

function getAudioOptions(body = {}) {
  const audio = body?.audio && typeof body.audio === "object" ? body.audio : {};
  return {
    ...audio,
    voice: audio.voice || body.voice,
    voiceProfile: audio.voiceProfile || audio.profile || body.voiceProfile || body.profile || null,
    persona: audio.persona || body.persona,
    personality: audio.personality || body.personality,
    emotion: audio.emotion || body.emotion,
    pacing: audio.pacing || body.pacing,
    intensity: audio.intensity || body.intensity,
    extraInstructions: audio.extraInstructions || audio.voiceNotes || body.extraInstructions || body.voiceNotes,
    responseFormat: audio.responseFormat || audio.format || body.responseFormat || body.format,
    speed: audio.speed ?? body.speed,
  };
}

function wantsAudio(body = {}) {
  return body?.includeAudio === true || body?.audio?.enabled === true;
}

function stripTrainerUiTags(text) {
  return String(text || "")
    .replace(/<(UI_HEALTH|UI_PAYLOAD|UI_SCORECARD)>[\s\S]*?<\/\1>/g, "")
    .trim();
}

function hasInternalSalesTrainerAccess(req, config = {}) {
  const expected = String(
    config.internalServiceSecret ||
      process.env.INTERNAL_SERVICE_SECRET ||
      process.env.SALES_TRAINER_BRIDGE_SECRET ||
      "",
  ).trim();
  if (!expected) return false;
  const provided = String(
    req.headers["x-internal-secret"] ||
      req.headers["x-internal-service-secret"] ||
      req.headers["x-service-secret"] ||
      req.headers["x-sales-trainer-secret"] ||
      "",
  ).trim();
  return Boolean(provided && safeSecretEquals(provided, expected));
}

async function resolveSalesTrainerOtpAccount(email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) return null;

  const account = await userAccountRepository.findUserAccountByEmail(normalized);
  if (account && isSalesTrainerAccountAllowed(account, normalized)) {
    return account;
  }
  if (isEmailAllowedForSalesTrainer(normalized)) {
    return buildSalesTrainerAccount(normalized);
  }
  return null;
}

function createSalesTrainerRouter(auth, config = {}) {
  const router = express.Router();

  async function requireSalesTrainerAccess(req, res, next) {
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({ ok: false, error: "Trainer OTP required" });
    }

    let trainerSession = null;
    try {
      trainerSession = verifySalesTrainerToken(config, token);
    } catch {
      // Fall through and try normal app auth below. This lets active
      // TAG agents/admins keep using their regular OTP-backed app session.
    }

    if (trainerSession) {
      let account = null;
      if (trainerSession.access === "account") {
        account = await userAccountRepository.findUserAccountByEmail(trainerSession.email);
        if (!account || !isSalesTrainerAccountAllowed(account, trainerSession.email)) {
          return res.status(403).json({ ok: false, error: "Account is not allowed for the sales trainer" });
        }
      }
      req.salesTrainerUser = {
        ...(account || {}),
        email: account?.email || trainerSession.email,
        role: account?.role || trainerSession.role || "sales-trainer",
        audience: account?.audience || "sales-trainer",
        scope: trainerSession.scope,
        trainerAccess: trainerSession.access,
      };
      req.user = req.salesTrainerUser;
      return next();
    }

    try {
      const sessionUser = verifyToken(token, config.jwtSecret);
      const account = await userAccountRepository.findUserAccountByEmail(sessionUser.email);
      if (!account || account.status !== "active") {
        return res.status(403).json({ ok: false, error: "Account is not active" });
      }
      if (!isSalesTrainerAccountAllowed(account, sessionUser.email)) {
        return res.status(403).json({ ok: false, error: "Account is not allowed for the sales trainer" });
      }
      req.user = {
        ...sessionUser,
        ...account,
      };
      req.salesTrainerUser = {
        email: account.email,
        role: account.role || sessionUser.role,
        audience: account.audience || sessionUser.audience,
        trainerAccess: isEmailAllowedForSalesTrainer(account.email) ? "allowlist" : "account",
      };
      return next();
    } catch {
      return res.status(401).json({ ok: false, error: "Invalid or expired trainer token" });
    }
  }

  async function requireSalesTrainerOrInternalAccess(req, res, next) {
    if (hasInternalSalesTrainerAccess(req, config)) {
      req.salesTrainerUser = {
        email: "internal-service",
        role: "service",
        audience: "sales-trainer",
        trainerAccess: "internal",
      };
      req.user = req.salesTrainerUser;
      return next();
    }
    return requireSalesTrainerAccess(req, res, next);
  }

  router.post("/auth/send-code", sendCodeLimit, async (req, res) => {
    try {
      const email = String(req.body?.email || "").trim().toLowerCase();
      const account = await resolveSalesTrainerOtpAccount(email);
      if (!account) {
        return res.status(403).json({ ok: false, error: "Email is not allowed for the sales trainer" });
      }
      const challenge = await issueOtpChallenge(config, account, {
        ip: req.ip,
      });
      return res.json({
        ok: true,
        challengeId: challenge.challengeId,
        email: challenge.email,
        expiresAt: challenge.expiresAt,
        attemptsRemaining: challenge.attemptsRemaining,
        delivery: {
          channel: "email",
          previewEnabled: config.authOtpPreview,
        },
        ...(config.authOtpPreview ? { previewCode: challenge.code } : {}),
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/auth/verify-code", verifyCodeLimit, async (req, res) => {
    try {
      const email = String(req.body?.email || "").trim().toLowerCase();
      const account = await resolveSalesTrainerOtpAccount(email);
      if (!account) {
        return res.status(403).json({ ok: false, error: "Email is not allowed for the sales trainer" });
      }
      try {
        await verifyOtpChallenge(config, account, String(req.body?.code || ""));
      } catch (verifyError) {
        return res.status(verifyError.status || 401).json({
          ok: false,
          error: verifyError.message,
          attemptsRemaining: verifyError.attemptsRemaining ?? null,
        });
      }
      const token = issueSalesTrainerToken(config, email, account);
      return res.json({
        ok: true,
        token: token.token,
        expiresAt: token.expiresAt,
        user: {
          email: account.email,
          role: account.role || "sales-trainer",
          audience: account.audience || "sales-trainer",
        },
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/auth/check", requireSalesTrainerAccess, async (req, res) => {
    return res.json({
      ok: true,
      user: req.salesTrainerUser || req.user,
    });
  });

  router.get("/config", requireSalesTrainerAccess, async (_req, res) => {
    const config = getSalesTrainerConfig();
    return res.json({
      ok: true,
      result: {
        configured: isConfigured(),
        // Backwards-compat: keep the original `model` field pointing at
        // the OpenAI model so any existing client code that reads it
        // doesn't break. New code should use `providers.{anthropic,openai}.model`.
        model: config.model,
        providers: {
          available: listConfiguredProviders(),
          default: config.provider,
          openai: {
            configured: isOpenAiConfigured(),
            model: config.model,
          },
          anthropic: {
            configured: isAnthropicConfigured(),
            model: config.anthropicModel,
          },
        },
        maxOutputTokens: config.maxOutputTokens,
        tts: {
          configured: isOpenAiConfigured(),
          model: config.ttsModel,
          defaultVoice: config.ttsVoice,
          defaultFormat: config.ttsFormat,
          defaultSpeed: config.ttsSpeed,
          instructionsSupported: String(config.ttsModel || "").toLowerCase().startsWith("gpt-4o-mini-tts"),
          voices: SALES_TRAINER_TTS_VOICES,
          formats: SALES_TRAINER_TTS_FORMATS,
          personas: SALES_TRAINER_TTS_PERSONAS,
          profileLocking: "client-reuse-voiceProfile",
          disclosure: "AI-generated voice disclosure required anywhere this is exposed to end users.",
        },
        allowlistConfigured:
          config.allowedEmails.length > 0 || config.allowedDomains.length > 0,
        // Two-station trainer: when enabled, the server-side observer owns
        // the coach panel (published via ui-state) — clients must NOT fire
        // the legacy per-turn /coach call on top of it.
        twoStation: {
          enabled: Boolean(config.twoStationEnabled),
          dialogueModel: config.dialogueModel,
        },
        modes: ["auto", "roleplay", "coach", "objection-drill", "transcript-review"],
      },
    });
  });

  router.get("/prompt", auth.requireAuth, auth.requireAdmin, async (_req, res) => {
    return res.json({
      ok: true,
      result: {
        prompt: TAX_RESOLUTION_SALES_TRAINER_PROMPT,
        characterCount: TAX_RESOLUTION_SALES_TRAINER_PROMPT.length,
      },
    });
  });

  router.post("/session/start", coachLimit, requireSalesTrainerAccess, async (req, res) => {
    try {
      const result = await startSalesTrainerSession({
        leadSource: req.body?.leadSource,
        difficulty: req.body?.difficulty,
        mode: req.body?.mode,
        scenarioArchetype: req.body?.scenarioArchetype,
        // Optional preset key (e.g. "newly_retired", "trucker_unfiled") —
        // picks a common-call template that locks the matching demographics.
        // Omit for a fully randomized roll from the weighted pools.
        presetKey: req.body?.presetKey,
        // Optional per-field demographic overrides for fine-grained control.
        // Shape: { ethnicity, age, sex, education, affluency,
        // employmentCategory, spouseStatus, ageBucket }.
        demographicOverrides: req.body?.demographicOverrides,
        // Operator free-text describing who to practice against — shapes the
        // generated caller (tax stack, mood, backstory) within locked demographics.
        situation: req.body?.situation,
        includeAudio: req.body?.includeAudio,
        audio: req.body?.audio,
        user: req.salesTrainerUser || req.user,
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  // List available preset profiles for the UI's "common calls" picker.
  // Cheap, sync — no auth-sensitive data, just labels + keys.
  router.get("/session/presets", requireSalesTrainerAccess, async (_req, res) => {
    return res.json({ ok: true, presets: listPresetProfiles() });
  });

  // Training Center: model-graded drills. The client sends the fixed question
  // + the field manual's reference answer + the trainee's free-text answer;
  // the coach model grades substance against the reference under the analyst
  // doctrine (promises/figures/chin-leads cap the score).
  router.post("/quiz/grade", drillLimit, requireSalesTrainerAccess, async (req, res) => {
    try {
      const result = await gradeSalesTrainerQuizAnswer({
        topic: req.body?.topic,
        question: req.body?.question,
        referenceAnswer: req.body?.referenceAnswer,
        answer: req.body?.answer,
        model: req.body?.model,
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  // Training Center: score one of MY calls on demand — the same
  // download → whisper → score pipeline the nightly grader runs, for a single
  // recording the trainee picked from the library.
  router.post("/score-call", scoreCallLimit, requireSalesTrainerAccess, async (req, res) => {
    const scoring = require("../../../../packages/shared-services/src/transcriptionScoringService");
    const fs = require("fs");
    let audioPath = null;
    try {
      const driveFileId = String(req.body?.driveFileId || "").trim();
      if (!driveFileId) {
        return res.status(400).json({ ok: false, error: "driveFileId is required" });
      }
      if (!scoring.isScoringConfigured()) {
        return res.status(503).json({ ok: false, error: "call scoring is not configured on this server" });
      }
      const safeId = driveFileId.replace(/[^\w-]/g, "").slice(0, 60) || "score-call";
      audioPath = await scoring.downloadRecordingFromDrive(driveFileId, `training-${safeId}`);
      if (!audioPath) {
        return res.status(502).json({ ok: false, error: "recording could not be downloaded" });
      }
      const transcript = await scoring.transcribeWithWhisper(audioPath);
      if (!transcript || !String(transcript).trim()) {
        return res.status(422).json({ ok: false, error: "no speech found in the recording" });
      }
      const score = await scoring.scoreWithClaude(transcript, {
        agentName: req.salesTrainerUser?.name || req.salesTrainerUser?.email || "Trainee",
        domain: String(req.body?.domain || "").toUpperCase() || "Unknown",
        phone: String(req.body?.phone || "") || "Unknown",
        direction: String(req.body?.direction || "") || "Unknown",
        durationSec: Number(req.body?.durationSec) || 0,
      });
      return res.json({ ok: true, result: { transcript: String(transcript).slice(0, 20000), score } });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    } finally {
      if (audioPath) {
        try { fs.unlinkSync(audioPath); } catch { /* temp cleanup is best-effort */ }
      }
    }
  });

  router.post("/coach", coachLimit, requireSalesTrainerAccess, async (req, res) => {
    try {
      const result = await runSalesTrainerCoachingPanel({
        messages: req.body?.messages,
        profile: req.body?.profile,
        scenario: req.body?.scenario,
        previousPhase: req.body?.previousPhase,
        provider: req.body?.provider,
        model: req.body?.model,
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/session/:sessionId/ui-state", requireSalesTrainerAccess, async (req, res) => {
    try {
      const result = getSalesTrainerUiState(req.params.sessionId, {
        sinceVersion: req.query?.sinceVersion,
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post(
    "/session/:sessionId/ui-state",
    coachLimit,
    requireSalesTrainerOrInternalAccess,
    async (req, res) => {
      try {
        const result = publishSalesTrainerUiState(req.params.sessionId, req.body, {
          email: req.salesTrainerUser?.email || req.user?.email,
          source: req.salesTrainerUser?.trainerAccess || "trainer",
        });
        return res.json({ ok: true, result });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  router.post("/respond", requireSalesTrainerAccess, async (req, res) => {
    try {
      const result = await runTaxResolutionSalesTrainer({
        messages: req.body?.messages,
        mode: req.body?.mode,
        scenario: req.body?.scenario,
        user: req.salesTrainerUser || req.user,
        profile: req.body?.profile,
        // Sonnet-generated story playbook handed to Haiku as the
        // per-turn "map." Client passes this back from /session/start.
        playbook: req.body?.playbook,
        // Per-request provider override. Omit in the body to fall back
        // to env (SALES_TRAINER_PROVIDER, default anthropic). Useful for
        // A/B comparing Claude vs OpenAI from the same trainer UI by
        // toggling a selector.
        provider: req.body?.provider,
        // Per-request model override. Rare — mostly for trying out new
        // Claude or GPT model variants without touching env.
        model: req.body?.model,
      });
      const responseResult = { ...result };
      if (wantsAudio(req.body)) {
        try {
          const speechText = stripTrainerUiTags(result.text);
          if (!speechText) {
            return res.json({ ok: true, result: responseResult });
          }
          responseResult.audio = await synthesizeSalesTrainerSpeech({
            text: speechText,
            ...getAudioOptions(req.body),
          });
        } catch (speechError) {
          responseResult.audio = {
            ok: false,
            ...toErrorResponse(speechError),
          };
        }
      }
      return res.json({ ok: true, result: responseResult });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/speech", speechLimit, requireSalesTrainerAccess, async (req, res) => {
    try {
      const result = await synthesizeSalesTrainerSpeech({
        text: req.body?.text,
        ...getAudioOptions(req.body),
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  // Standalone STT — useful for text-only fallback UIs that want to
  // transcribe a mic clip into the input box without immediately running
  // a turn, and for diagnostic tooling.
  router.post(
    "/transcribe",
    speechLimit,
    requireSalesTrainerAccess,
    trainerAudioUpload.single("audio"),
    async (req, res) => {
      try {
        if (!req.file?.buffer) {
          return res.status(400).json({ ok: false, error: "audio file is required" });
        }
        const result = await transcribeSalesTrainerAudio({
          buffer: req.file.buffer,
          mimeType: req.file.mimetype || "audio/webm",
          filename: req.file.originalname || "trainer-mic.webm",
          language: req.body?.language || null,
          prompt: req.body?.prompt || "",
        });
        return res.json({ ok: true, result });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  // Unified voice turn: STT → Claude → TTS in a single round-trip. The
  // client uploads:
  //   - multipart `audio` file (the rep's mic clip), OR `textInput` field
  //   - `payload` JSON field (or top-level fields) containing
  //     { messages, profile, mode, scenario, provider, model, includeAudio, audio }
  // The response carries { transcript, response, audio, messages, elapsedMs }.
  router.post(
    "/turn",
    turnLimit,
    requireSalesTrainerAccess,
    trainerAudioUpload.single("audio"),
    async (req, res) => {
      try {
        const payload = parseTurnPayload(req.body);
        const messages = parseMaybeJsonField(payload.messages) ?? [];
        const profile = parseMaybeJsonField(payload.profile);
        const playbook = parseMaybeJsonField(payload.playbook);
        const audio = parseMaybeJsonField(payload.audio) ?? {};
        const includeAudio = payload.includeAudio === false
          || payload.includeAudio === "false"
          ? false
          : true;

        const result = await runSalesTrainerTurn({
          audioBuffer: req.file?.buffer || null,
          audioMimeType: req.file?.mimetype || "audio/webm",
          audioFilename: req.file?.originalname || "trainer-mic.webm",
          textInput: payload.textInput || payload.text || "",
          messages: Array.isArray(messages) ? messages : [],
          profile,
          playbook,
          // Slim by default — every live turn runs Sonnet + slim prompt.
          // UI may pass "full" explicitly (e.g. a "break character"
          // recovery button) to force the 27k master prompt for one turn.
          promptVariant: payload.promptVariant === "full" ? "full" : "slim",
          mode: payload.mode || "auto",
          scenario: payload.scenario || "",
          user: req.salesTrainerUser || req.user,
          provider: payload.provider || null,
          model: payload.model || null,
          maxOutputTokens: Number(payload.maxOutputTokens) || null,
          includeAudio,
          audio,
          sttPrompt: payload.sttPrompt || "",
          sttLanguage: payload.sttLanguage || null,
          // Recording capture — the client passes sessionId (from
          // /session/start) and turnNumber (1-indexed) so each turn
          // lands in the right folder. recordTurn defaults to true on
          // the server; set { recordTurn: false } on the payload to
          // disable for a given turn (e.g., a sanity-check run).
          sessionId: payload.sessionId || null,
          turnNumber: Number.isFinite(Number(payload.turnNumber)) ? Number(payload.turnNumber) : null,
          recordTurn: payload.recordTurn === false ? false : true,
          archiveToDrive: payload.archiveToDrive === false ? false : true,
        });
        return res.json({ ok: true, result });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  return router;
}

module.exports = {
  createSalesTrainerRouter,
};
