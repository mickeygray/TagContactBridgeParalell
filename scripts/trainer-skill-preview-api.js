"use strict";

/**
 * Local-only API adapter for visually exercising draft Trainer skill packets.
 *
 * This is deliberately not a production course publisher or model grader. It
 * binds to loopback, keeps state in memory, and labels every response as a
 * preview. The real course registry and persistence paths remain untouched.
 */

const express = require("express");
const {
  CONTENT_VERSION,
  RULE_REVISION,
  TAX_RESOLUTION_SKILL_PACKETS,
} = require("../packages/shared-services/src/trainer-content/taxResolutionSkillPackets.v1");

const HOST = "127.0.0.1";
const PORT = Number(process.env.TRAINER_SKILL_PREVIEW_PORT || 5001);
const COURSE_ID = "tax-resolution-skill-preview";
const COURSE_VERSION = CONTENT_VERSION;
const ENROLLMENT_ID = "local-preview-enrollment";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));

const packetsByItemId = new Map(
  TAX_RESOLUTION_SKILL_PACKETS.map((packet) => [packet.id, packet]),
);
const attempts = new Map();
let enrolled = true;
let attemptSequence = 0;

function ok(res, result) {
  res.json({ ok: true, preview: true, result });
}

function railItems() {
  return TAX_RESOLUTION_SKILL_PACKETS.map((packet) => ({
    itemId: packet.id,
    itemVersion: packet.version,
    title: `${packet.sectionId}. ${packet.title}`,
    type: "gauntlet",
    status: "available",
    required: true,
  }));
}

function enrollment() {
  const items = railItems();
  return {
    enrollmentId: ENROLLMENT_ID,
    status: "active",
    courseId: COURSE_ID,
    courseVersion: COURSE_VERSION,
    rulePackVersion: RULE_REVISION,
    resumeItemId: items[0]?.itemId || null,
    version: 1,
    progress: {
      completed: 0,
      total: items.length,
      requiredCompleted: 0,
      requiredTotal: items.length,
    },
    activeRemediation: [],
    items,
    mastery: null,
  };
}

function courseHome() {
  return {
    course: {
      courseId: COURSE_ID,
      courseVersion: COURSE_VERSION,
      title: "Tax Resolution Targeted Talk Preview",
      status: "draft-preview",
    },
    enrollment: enrolled ? enrollment() : null,
    capabilities: {
      courseV1Enabled: true,
      gauntletV1Enabled: true,
      callReviewV1Enabled: false,
    },
  };
}

function publicItem(packet) {
  const personaSummary = packet.personas
    .map((persona) => `${persona.difficulty}: ${persona.posture}`)
    .join("; ");
  return {
    itemId: packet.id,
    itemVersion: packet.version,
    type: "gauntlet",
    title: `${packet.sectionId}. ${packet.title}`,
    required: true,
    status: "available",
    completedAttemptId: null,
    content: {
      summary: packet.localObjective,
      body: [
        "Local draft preview. This session is confined to one section of the call.",
        `Possible prospect postures: ${personaSummary}.`,
        `Things not to do here: ${packet.prohibitedMoves.join("; ")}.`,
      ].join("\n\n"),
      instructions: [
        packet.localObjective,
        "The preview marks one required skill per learner turn so the complete UI flow can be tested.",
        "It does not represent production semantic grading.",
      ].join(" "),
      prompt: packet.situations[0] || null,
      choices: [],
      estimatedMinutes: Math.max(3, Math.ceil(packet.maxTurns / 2)),
    },
  };
}

function publicAttempt(record) {
  return {
    attemptId: record.attemptId,
    enrollmentId: ENROLLMENT_ID,
    itemId: record.packet.id,
    itemVersion: record.packet.version,
    itemType: "gauntlet",
    version: record.version,
    status: record.status,
    createdAt: record.createdAt,
  };
}

function gauntletState(record) {
  return {
    schemaVersion: "1",
    experienceMode: "gauntlet",
    sectionId: record.packet.sectionId,
    status: record.status,
    stateVersion: record.version,
    runNumber: record.runNumber,
    nextTurn: record.nextTurn,
    currentNodeId: `section-${record.packet.sectionId}-turn-${record.nextTurn}`,
    variantId: record.variant.variantId,
    criteria: record.packet.criteria.map((criterion, index) => ({
      criterionId: criterion.criterionId,
      ruleId: criterion.ruleId,
      ruleRevision: criterion.ruleRevision,
      status: index < record.satisfiedCount ? "satisfied" : "pending",
      evidenceTurnIds: index < record.satisfiedCount
        ? [`preview-turn-${index + 1}`]
        : [],
    })),
  };
}

function gauntletResult(record, extras = {}) {
  return {
    attemptId: record.attemptId,
    version: record.version,
    attempt: publicAttempt(record),
    duplicate: false,
    state: gauntletState(record),
    reactionIntent: extras.reactionIntent || null,
    prospectReply: extras.prospectReply || null,
    terminal: extras.terminal || null,
  };
}

function findAttempt(req, res) {
  const record = attempts.get(req.params.attemptId);
  if (!record) {
    res.status(404).json({
      ok: false,
      preview: true,
      code: "preview_attempt_not_found",
      error: "That local preview attempt no longer exists.",
    });
    return null;
  }
  return record;
}

function chooseVariant(packet, runNumber) {
  return packet.personas[runNumber % packet.personas.length];
}

app.get("/api/client/runtime", (_req, res) => {
  res.json({
    ok: true,
    runtime: "trainer-skill-preview",
    preview: true,
  });
});

app.get("/api/sales-trainer/auth/check", (_req, res) => {
  res.json({
    ok: true,
    preview: true,
    user: {
      displayName: "Local Trainer Preview",
      role: "preview",
    },
  });
});

app.get("/api/sales-trainer/config", (_req, res) => {
  ok(res, {
    configured: false,
    model: "local-preview-no-model",
    providers: {
      available: ["preview"],
      default: "preview",
      openai: { configured: false, model: "" },
      anthropic: { configured: false, model: "" },
    },
    twoStation: { enabled: false },
    features: {
      courseV1Enabled: true,
      gauntletV1Enabled: true,
      callReviewV1Enabled: false,
    },
    modes: ["targeted-talk-preview"],
  });
});

app.get("/api/sales-trainer/course/home", (_req, res) => {
  ok(res, courseHome());
});

app.post("/api/sales-trainer/enrollments", (_req, res) => {
  enrolled = true;
  ok(res, {
    enrollment: enrollment(),
    resumeTarget: {
      courseId: COURSE_ID,
      itemId: TAX_RESOLUTION_SKILL_PACKETS[0]?.id || null,
    },
  });
});

app.get("/api/sales-trainer/course/:courseId/items/:itemId", (req, res) => {
  if (req.params.courseId !== COURSE_ID) {
    return res.status(404).json({ ok: false, preview: true, error: "Preview course not found." });
  }
  const packet = packetsByItemId.get(req.params.itemId);
  if (!packet) {
    return res.status(404).json({ ok: false, preview: true, error: "Preview item not found." });
  }
  return ok(res, { item: publicItem(packet) });
});

app.post("/api/sales-trainer/attempts", (req, res) => {
  const packet = packetsByItemId.get(String(req.body?.itemId || ""));
  if (!packet) {
    return res.status(400).json({ ok: false, preview: true, error: "A valid preview itemId is required." });
  }
  attemptSequence += 1;
  const record = {
    attemptId: `local-preview-attempt-${attemptSequence}`,
    packet,
    variant: chooseVariant(packet, 0),
    runNumber: 0,
    nextTurn: 0,
    satisfiedCount: 0,
    version: 0,
    status: "ready",
    createdAt: new Date().toISOString(),
  };
  attempts.set(record.attemptId, record);
  return ok(res, { attempt: publicAttempt(record) });
});

app.get("/api/sales-trainer/course/gauntlet/attempts/:attemptId", (req, res) => {
  const record = findAttempt(req, res);
  if (!record) return;
  ok(res, gauntletResult(record));
});

app.post("/api/sales-trainer/course/gauntlet/attempts/:attemptId/initialize", (req, res) => {
  const record = findAttempt(req, res);
  if (!record) return;
  record.version += 1;
  record.status = "in_progress";
  record.nextTurn = 1;
  ok(res, gauntletResult(record, {
    reactionIntent: record.variant.behavior,
    prospectReply: {
      text: record.packet.situations[record.runNumber % record.packet.situations.length],
      speechActs: ["section_opening"],
    },
  }));
});

app.post("/api/sales-trainer/course/gauntlet/attempts/:attemptId/turns", (req, res) => {
  const record = findAttempt(req, res);
  if (!record) return;
  const text = String(req.body?.text || "").trim();
  if (!text) {
    return res.status(400).json({ ok: false, preview: true, error: "Say what you would say to the prospect." });
  }

  record.version += 1;
  record.satisfiedCount = Math.min(
    record.packet.criteria.length,
    record.satisfiedCount + 1,
  );
  record.nextTurn += 1;
  const passed = record.satisfiedCount >= record.packet.criteria.length;
  const exhausted = record.nextTurn > record.packet.maxTurns;
  record.status = passed ? "passed" : exhausted ? "failed" : "in_progress";

  const nextCriterion = record.packet.criteria[record.satisfiedCount];
  const prospectText = nextCriterion
    ? `That helps. ${record.variant.behavior} Keep this response inside ${record.packet.title}.`
    : "Understood. You handled the required moves for this section.";
  ok(res, gauntletResult(record, {
    reactionIntent: nextCriterion?.description || "section_complete",
    prospectReply: passed || exhausted
      ? null
      : { text: prospectText, speechActs: ["preview_follow_up"] },
    terminal: passed ? "passed" : exhausted ? "failed" : null,
  }));
});

app.post("/api/sales-trainer/course/gauntlet/attempts/:attemptId/retry", (req, res) => {
  const record = findAttempt(req, res);
  if (!record) return;
  record.version += 1;
  record.runNumber += 1;
  record.variant = chooseVariant(record.packet, record.runNumber);
  record.nextTurn = 0;
  record.satisfiedCount = 0;
  record.status = "ready";
  ok(res, gauntletResult(record));
});

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    preview: true,
    code: "preview_route_not_implemented",
    error: `The local Trainer preview does not implement ${req.method} ${req.path}.`,
  });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`[trainer-preview] API listening on http://${HOST}:${PORT}`);
  console.log(`[trainer-preview] Loaded ${TAX_RESOLUTION_SKILL_PACKETS.length} draft section packets`);
  console.log("[trainer-preview] Deterministic UI adapter only; no model grading or persistence");
});

function close() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", close);
process.on("SIGTERM", close);
