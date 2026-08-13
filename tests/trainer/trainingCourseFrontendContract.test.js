"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");

function source(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("Trainer outer routes accept canonical course deep links without changing auth wrappers", () => {
  const routes = source("apps/web-client/src/app/routes.tsx");
  assert.match(routes, /path="\/trainer\/\*"/);
  assert.match(routes, /path="coach\/\*"/);
  assert.match(
    routes,
    /path="coach\/\*"[\s\S]*?<SalesTrainerWorkspace \/>/,
  );
});

test("Course shell is default-off at the workspace boundary and preserves legacy tabs", () => {
  const workspace = source(
    "apps/web-client/src/workspaces/trainer/SalesTrainerWorkspace.tsx",
  );
  assert.match(
    workspace,
    /const courseEnabled = trainerConfig\?\.features\?\.courseV1Enabled === true/,
  );
  assert.match(
    workspace,
    /if \(courseEnabled && !coursePracticeActive\)[\s\S]*?<TrainerCourseShell/,
  );
  assert.match(workspace, /const TRAINING_TABS:[\s\S]*?"practice"[\s\S]*?"study"[\s\S]*?"calls"/);
  assert.match(workspace, /\{!courseEnabled \? \([\s\S]*?TRAINING_TABS\.map/);
});

test("shared shell preserves the authenticated trainer route family", () => {
  const workspace = source(
    "apps/web-client/src/workspaces/trainer/SalesTrainerWorkspace.tsx",
  );
  const shell = source(
    "apps/web-client/src/workspaces/trainer/TrainerCourseShell.tsx",
  );
  const player = source(
    "apps/web-client/src/workspaces/trainer/TrainerCoursePlayer.tsx",
  );
  const results = source(
    "apps/web-client/src/workspaces/trainer/TrainerAttemptResults.tsx",
  );
  assert.match(
    workspace,
    /location\.pathname\.startsWith\("\/cx\/coach"\)[\s\S]*?trainerBasePath/,
  );
  assert.match(shell, /basePath: "\/trainer" \| "\/cx\/coach"/);
  assert.match(shell, /`\$\{basePath\}\/course\//);
  assert.match(player, /`\$\{basePath\}\/attempt\//);
  assert.match(results, /`\$\{basePath\}\/course\//);
  assert.doesNotMatch(`${shell}\n${player}\n${results}`, /`\/trainer\/(?:course|attempt)\//);
});
test("Course client keeps server-owned contracts and both authenticated entry tokens", () => {
  const client = source("apps/web-client/src/lib/api/trainingCourse.ts");
  const quiz = source(
    "apps/web-client/src/workspaces/trainer/TrainerQuizItem.tsx",
  );
  for (const endpoint of [
    "/course/home",
    "/enrollments",
    "/attempts",
    "/answers",
    "/complete",
    "/reflection",
    "/results",
  ]) {
    assert.ok(client.includes(endpoint), endpoint);
  }
  assert.doesNotMatch(client, /referenceAnswer|canonicalAnswer|rubric/);
  assert.doesNotMatch(client, /questionId/);
  assert.match(client, /\.ok === true/);
  assert.match(client, /SALES_TRAINER_TOKEN_KEY[\s\S]*?TOKEN_STORAGE_KEY/);
  assert.match(
    client,
    /getItem\(SALES_TRAINER_TOKEN_KEY\) \|\|[\s\S]*?getItem\(TOKEN_STORAGE_KEY\)/,
  );
  assert.match(quiz, /onChange=\{\(\) => setAnswer\(choice\.choiceId\)\}/);
  assert.doesNotMatch(quiz, /onAnswer\(choice\.label\)/);
  assert.match(client, /completedAttemptId\?: string \| null/);
});

test("Phase-2 players fail closed and completed items stay read only", () => {
  const player = source(
    "apps/web-client/src/workspaces/trainer/TrainerCoursePlayer.tsx",
  );
  const lesson = source(
    "apps/web-client/src/workspaces/trainer/TrainerLessonItem.tsx",
  );
  const quiz = source(
    "apps/web-client/src/workspaces/trainer/TrainerQuizItem.tsx",
  );
  assert.match(
    player,
    /const isAssessed =[\s\S]*?"quiz"[\s\S]*?"say_it"[\s\S]*?"say-it"/,
  );
  assert.match(
    player,
    /isAssessed \? \([\s\S]*?<TrainerQuizItem[\s\S]*?\) : \([\s\S]*?Only lesson, quiz, and say-it items/,
  );
  assert.match(lesson, /item\.status === "completed"[\s\S]*?onViewResults/);
  assert.match(quiz, /item\.status === "completed"[\s\S]*?Completed knowledge check/);
  assert.ok(
    quiz.indexOf("useEffect(() =>") <
      quiz.indexOf('if (!attempt && item.status === "completed")'),
    "hooks must run before the completed-item return",
  );
  assert.match(player, /completedAttemptId[\s\S]*?onViewResults=\{viewCompletedResults\}/);
});

test("ambiguous mutation retries bind IDs to the exact outbound payload", () => {
  const attemptHook = source(
    "apps/web-client/src/workspaces/trainer/hooks/useTrainingAttempt.ts",
  );
  const results = source(
    "apps/web-client/src/workspaces/trainer/TrainerAttemptResults.tsx",
  );
  assert.match(
    attemptHook,
    /const outboundAnswer = value\.trim\(\);[\s\S]*?const eventKey = outboundAnswer[\s\S]*?answer: outboundAnswer/,
  );
  assert.match(
    attemptHook,
    /answerEventIdsRef\.current\.get\(eventKey\)[\s\S]*?answerEventIdsRef\.current\.set\(eventKey, eventId\)/,
  );
  assert.match(
    results,
    /const outboundReflection = reflection\.trim\(\);[\s\S]*?priorMutation\?\.input === outboundReflection[\s\S]*?reflection: outboundReflection/,
  );
  assert.match(
    results,
    /result\.attempt\.status !== "completed" \|\| result\.terminalSummary == null/,
  );
});

test("Targeted Talk reuses authenticated Trainer STT with server-owned turns", () => {
  const client = source("apps/web-client/src/lib/api/trainingCourse.ts");
  const player = source("apps/web-client/src/workspaces/trainer/TrainerCoursePlayer.tsx");
  const gauntlet = source("apps/web-client/src/workspaces/trainer/TrainerGauntletPlayer.tsx");
  assert.match(client, /expectedTurn: number;[\s\S]*?text: string/);
  assert.match(client, /cache: "no-store"/);
  assert.match(gauntlet, /salesTrainerApi\.speech\(\{ text: clean \}\)/);
  assert.match(gauntlet, /playbackForAudio\(audio\)/);
  assert.match(gauntlet, /result = await trainingCourseApi\.gauntlet\(started\.attemptId\)/);
  assert.match(gauntlet, /if \(status !== 422\) throw cause/);
  assert.doesNotMatch(client, /submitGauntletTurn[\s\S]{0,500}evidence:/);
  assert.match(player, /isGauntlet && home\?\.capabilities\.gauntletV1Enabled === true/);
  assert.match(gauntlet, /turnEventRef\.current\?\.input === mutationInput/);
  assert.match(gauntlet, /Practice only this part of the call/);
  assert.match(gauntlet, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(gauntlet, /salesTrainerApi\.transcribeAudio/);
  assert.match(gauntlet, /submitGauntletTurn/);
  assert.match(gauntlet, /expectedVersion: runtime\.version/);
  assert.match(gauntlet, /function finishProspectPlayback\(autoArm = true\)/);
  assert.match(gauntlet, /prospectSpeakingRef\.current = false/);
  assert.match(gauntlet, /utterance\.onend = \(\) => finishProspectPlayback\(\)/);
  assert.match(gauntlet, /busyRef\.current \|\|[\s\S]*?prospectSpeakingRef\.current/);
  assert.match(gauntlet, /No speech was detected\. Try the response again\./);
  assert.doesNotMatch(gauntlet, /The prospect responds and keeps this section moving/);
  assert.match(gauntlet, /Coach · what to notice/);
  // The practice count and section name are DERIVED — every one of the 11
  // packets renders this header, so a hardcoded "Five ... Introduction" was
  // wrong on ten of them.
  assert.match(gauntlet, /practiceModules\.length\}\s*brief practices/);
  assert.doesNotMatch(gauntlet, /Five brief Introduction practices/);
  assert.match(gauntlet, /Short model-graded Q&A/);
  assert.match(gauntlet, /gradeTargetedModuleAnswer/);
  assert.match(gauntlet, /Listen for:/);
  assert.doesNotMatch(gauntlet, /coach\.exactLanguage/);
  assert.match(gauntlet, /Start voice session/);
  assert.match(gauntlet, /Text fallback and transcript/);
});

test("course Free Call wrapper keeps natural practice on the unchanged legacy cockpit", () => {
  const player = source("apps/web-client/src/workspaces/trainer/TrainerCoursePlayer.tsx");
  const freeCall = source("apps/web-client/src/workspaces/trainer/TrainerFreeCallPlayer.tsx");
  assert.match(player, /<TrainerFreeCallPlayer onOpenLegacyPractice=\{onOpenPractice\}/);
  assert.match(freeCall, /does not use[\s\S]*Targeted Talk nodes, phase locks/);
  assert.match(freeCall, /onOpenLegacyPractice/);
});

test("the curriculum rail numbers from the section label, not array position", () => {
  const rail = fs.readFileSync(
    path.join(__dirname, "../../apps/web-client/src/workspaces/trainer/TrainerCurriculumRail.tsx"),
    "utf8",
  );
  // Section "4B" sits fifth in the list. Numbering from the index while the
  // title also carried the number rendered "5. 4B. Payment Terms".
  assert.ok(rail.includes("item.sectionLabel || String(index + 1)"));
  assert.ok(rail.includes("{sectionNumber}. {item.title}"));

  // Scoped to railItems() on purpose: the item-detail payload SHOULD keep
  // "4B. Payment Terms" in its title, because that renders as the page heading
  // with no index in front of it. Only the rail double-numbered.
  const preview = fs.readFileSync(
    path.join(__dirname, "../../scripts/trainer-skill-preview-api.js"),
    "utf8",
  );
  const railStart = preview.indexOf("function railItems()");
  assert.ok(railStart > -1, "railItems() must exist");
  const railBody = preview.slice(railStart, preview.indexOf("\nfunction ", railStart + 1));
  assert.ok(railBody.includes("sectionLabel: packet.sectionId"));
  assert.ok(railBody.includes("title: packet.title"));
  assert.doesNotMatch(railBody, /title: `\$\{packet\.sectionId\}\. \$\{packet\.title\}`/);
});

test("an open section lists its own practices as N.M", () => {
  const rail = fs.readFileSync(
    path.join(__dirname, "../../apps/web-client/src/workspaces/trainer/TrainerCurriculumRail.tsx"),
    "utf8",
  );
  // Nested practices appear only for the ACTIVE section and only when the
  // player has reported progress for that same item.
  assert.ok(rail.includes("moduleProgress?.itemId === item.itemId"));
  assert.ok(rail.includes("{sectionNumber}.{moduleIndex + 1}"));
  assert.ok(rail.includes('aria-label={`${item.title} practices`}'));
  // Completed vs current comes from the server projection, not local guessing.
  assert.ok(rail.includes("completed.has(moduleItem.moduleId)"));
  assert.ok(rail.includes("moduleItem.moduleId === moduleProgress?.currentModuleId"));

  const player = fs.readFileSync(
    path.join(__dirname, "../../apps/web-client/src/workspaces/trainer/TrainerCoursePlayer.tsx"),
    "utf8",
  );
  assert.ok(player.includes("moduleProgress={moduleProgress}"));
  assert.ok(player.includes("onModuleProgress={handleModuleProgress}"));
});
