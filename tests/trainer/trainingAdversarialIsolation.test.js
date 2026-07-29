"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  createTrainingDispositionReviewService,
} = require("../../packages/shared-services/src/trainingDispositionReviewService");

const ROOT = path.resolve(__dirname, "../..");

test("simulated DNC remains an evidence-cited training recommendation with no operational action", async () => {
  const service = createTrainingDispositionReviewService({
    evaluateDisposition: async () => ({
      disposition: "training_dnc_recommended",
      citedEvidenceIds: ["prospect-2"],
    }),
  });
  const result = await service.review({
    transcriptEvidence: [
      { evidenceId: "prospect-2", speaker: "prospect", text: "I will not answer anything." },
    ],
    learnerReflection: "They were only fishing for information.",
  });
  assert.equal(result.disposition, "training_dnc_recommended");
  assert.deepEqual(result.citedEvidenceIds, ["prospect-2"]);
  assert.equal(result.operationalAction, null);
});

test("simulated DNC fails to insufficient evidence when the model invents a citation", async () => {
  const service = createTrainingDispositionReviewService({
    evaluateDisposition: async () => ({
      disposition: "training_dnc_recommended",
      citedEvidenceIds: ["invented"],
    }),
  });
  const result = await service.review({
    transcriptEvidence: [{ evidenceId: "actual", speaker: "prospect", text: "No." }],
  });
  assert.equal(result.disposition, "insufficient_evidence");
  assert.equal(result.operationalAction, null);
});

test("new Trainer runtimes have no direct operational DNC, customer, or live-call writers", () => {
  const files = [
    "trainingGauntletService.js",
    "trainingFreeCallCourseService.js",
    "trainingReviewCoachService.js",
    "trainingDispositionReviewService.js",
  ];
  for (const file of files) {
    const source = fs.readFileSync(
      path.join(ROOT, "packages/shared-services/src", file),
      "utf8",
    );
    assert.doesNotMatch(source, /dncAuditRepository|caseProfileRepository|callLogRepository|leadDeliveryRepository|CxDialQueue|QueueItem/);
  }
});
