"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const previewSource = fs.readFileSync(
  path.resolve(__dirname, "../../scripts/trainer-skill-preview-api.js"),
  "utf8",
);

test("local skill preview uses a model prospect that hears the actual conversation", () => {
  assert.match(previewSource, /createAnthropicClient/);
  assert.match(previewSource, /conversationSoFar: conversationText\(record\)/);
  assert.match(previewSource, /newestAgentUtterance: learnerText/);
  assert.match(previewSource, /Stay fully in character/);
  assert.match(previewSource, /The section boundary limits the topic/);
  assert.match(previewSource, /Never coach, grade, name rubric criteria/);
});

test("preview grading remains separate and never advances one criterion per turn", () => {
  assert.match(previewSource, /gradeLearnerTurn\(record, learnerText\)/);
  assert.match(previewSource, /record\.satisfiedCriterionIds\.add\(criterionId\)/);
  assert.doesNotMatch(previewSource, /satisfiedCount\s*\+\s*1/);
});

test("targeted voice sessions run through the real Free Call turn stack", () => {
  assert.match(previewSource, /startSalesTrainerSession/);
  assert.match(previewSource, /runSalesTrainerTurn/);
  assert.match(previewSource, /messages: bundle\.messages \|\| \[\]/);
  assert.match(previewSource, /playbook: bundle\.playbook/);
  assert.match(previewSource, /audio: \{ voiceProfile: bundle\.voice \}/);
  assert.match(previewSource, /voice-turns/);
});

test("section packets drive local teaching prompts without replacing the voice loop", () => {
  assert.match(previewSource, /Learner reading:/);
  assert.match(previewSource, /function coachForRecord\(record, prospectText/);
  assert.match(previewSource, /coachNotice/);
  assert.match(previewSource, /suggestedMove/);
  assert.match(previewSource, /listenFor/);
  assert.match(previewSource, /gradeModuleAnswer/);
  assert.match(previewSource, /module-answer/);
  assert.match(previewSource, /reveal the approved wording/);
});

test("live Coach guidance is regenerated from the newest two-sided exchange", () => {
  assert.match(previewSource, /async function generateTurnCoach/);
  assert.match(previewSource, /newestProspectUtterance/);
  assert.match(previewSource, /newestLearnerUtterance/);
  assert.match(previewSource, /recentConversation: conversationText\(record\)/);
  assert.match(previewSource, /React to the newest prospect and agent utterances/);
  assert.match(previewSource, /Never supply a script line, approved wording, answer, hidden rubric/);
  assert.match(previewSource, /coach_latest_exchange/);
  assert.match(previewSource, /const coach = await generateTurnCoach\(record/);
});

test("direction-specific criteria are filtered before the short section begins", () => {
  assert.match(previewSource, /function activeCriteria\(record\)/);
  assert.match(
    previewSource,
    /!requiredDirection \|\| requiredDirection === record\.direction/,
  );
});

test("strict grading only credits evidence quoted from the learner turn", () => {
  assert.ok(previewSource.includes("quoteAppearsIn(item?.quote, learnerText)"));
  assert.ok(previewSource.includes("you must QUOTE the exact fragment"));
  assert.ok(previewSource.includes("When in doubt, the criterion is NOT satisfied"));
});

test("a verified prohibited move ends the run instead of costing a point", () => {
  assert.ok(previewSource.includes("prohibitedMove"));
  assert.ok(previewSource.includes("record.status = prohibited ? \"failed\""));
  // A violation names WHICH tier it broke: an engraved hard rule or the
  // packet-scoped prohibited move.
  assert.ok(previewSource.includes("kind: record.lastProhibitedMove.ruleId ? \"hard-rule\" : \"prohibited-move\""));
});

test("a failed run repeats the SAME module with a harder persona", () => {
  // Mickey 2026-07-29: "you have to accomplish things in a certain way or it
  // repeats itself." Advancement is earned by a pass; failure escalates the
  // prospect and rotates the situation but never changes the objective.
  assert.ok(previewSource.includes("record.moduleAttempt += 1"));
  assert.ok(previewSource.includes("escalatePersona(record.packet, record.moduleAttempt)"));
  assert.ok(previewSource.includes("moduleSituations[record.moduleAttempt % moduleSituations.length]"));
  assert.ok(previewSource.includes("record.moduleIndex = Math.min(record.moduleIndex + 1"));
});

test("persona difficulty never de-escalates on retry", () => {
  assert.ok(previewSource.includes("Math.min(attempt, ordered.length - 1)"));
  assert.ok(previewSource.includes("foundation: 0, intermediate: 1, advanced: 2"));
});

test("the draft preview cannot squat a real service port or leave loopback", () => {
  // A dev tool on the control plane's port already cost a debugging session:
  // runtime/trainer-course-preview/mock-control-plane.js held 5001 and answered
  // auth for any email, which looked exactly like lost admin roles.
  assert.ok(previewSource.includes("const DEFAULT_PREVIEW_PORT = 5099"));
  assert.ok(previewSource.includes('[5001, "control-plane"]'));
  assert.ok(previewSource.includes("RESERVED_PORTS.has(PORT)"));
  assert.ok(previewSource.includes('refusing to bind ${HOST}'));
  assert.ok(previewSource.includes('const HOST = "127.0.0.1"'));
  // NODE_ENV is deliberately NOT the guard — this repo's .env sets it to
  // production, so that check would block the tool on its only machine.
  assert.doesNotMatch(previewSource, /NODE_ENV\)\.toLowerCase\(\) === "production"/);
});

test("the preview launcher keeps API port and proxy target in agreement", () => {
  const launcher = fs.readFileSync(
    path.join(__dirname, "../../scripts/preview-trainer-skills.js"),
    "utf8",
  );
  assert.ok(launcher.includes("TRAINER_SKILL_PREVIEW_PORT"));
  assert.ok(launcher.includes("WEB_CLIENT_API_TARGET"));
  assert.ok(launcher.includes("|| 5099"));
  // Mismatched halves are the silent failure — warn rather than serve a dead UI.
  assert.ok(launcher.includes("does not point at port"));

  const vite = fs.readFileSync(
    path.join(__dirname, "../../apps/web-client/vite.config.ts"),
    "utf8",
  );
  assert.ok(vite.includes("process.env.WEB_CLIENT_API_TARGET"));
});
