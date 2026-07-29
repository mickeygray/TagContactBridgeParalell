"use strict";

const TRAINING_DISPOSITIONS = Object.freeze([
  "retry_recommended",
  "training_dnc_recommended",
  "insufficient_evidence",
]);

function createTrainingDispositionReviewService({ evaluateDisposition }) {
  if (typeof evaluateDisposition !== "function") {
    throw new TypeError("training disposition evaluator is required");
  }
  async function review({ transcriptEvidence, learnerReflection }) {
    const evidence = Array.isArray(transcriptEvidence)
      ? transcriptEvidence.map((entry) => ({
          evidenceId: String(entry?.evidenceId || "").trim(),
          speaker: entry?.speaker === "prospect" ? "prospect" : "learner",
          text: String(entry?.text || "").trim(),
        })).filter((entry) => entry.evidenceId && entry.text)
      : [];
    const allowed = new Set(evidence.map((entry) => entry.evidenceId));
    let raw;
    try {
      raw = await evaluateDisposition({
        evidence,
        learnerReflection: String(learnerReflection || "").trim(),
        signals: [
          "refuses_to_share_or_answer",
          "aggressive_or_combative",
          "only_asks_without_responding",
          "bad_actor_or_fishing_pattern",
          "learner_could_materially_improve",
        ],
      });
    } catch {
      raw = null;
    }
    const disposition = TRAINING_DISPOSITIONS.includes(raw?.disposition)
      ? raw.disposition
      : "insufficient_evidence";
    const citedEvidenceIds = Array.isArray(raw?.citedEvidenceIds)
      ? [...new Set(raw.citedEvidenceIds.map(String).filter((id) => allowed.has(id)))]
      : [];
    if (disposition !== "insufficient_evidence" && citedEvidenceIds.length === 0) {
      return Object.freeze({
        disposition: "insufficient_evidence",
        citedEvidenceIds: Object.freeze([]),
        operationalAction: null,
      });
    }
    return Object.freeze({
      disposition,
      citedEvidenceIds: Object.freeze(citedEvidenceIds),
      operationalAction: null,
    });
  }
  return Object.freeze({ review });
}

module.exports = {
  TRAINING_DISPOSITIONS,
  createTrainingDispositionReviewService,
};
