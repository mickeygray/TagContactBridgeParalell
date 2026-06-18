"use strict";

// Realistic request packets — the JSON a real caller (5001) would send to the bus
// for each NON-COACH task, shaped for the PRODUCTION registry (buildBusRegistry,
// where the named tasks carry their baked sandbox prompts). The route envelope is
// { payload, options }; these are the `payload` (+ optional `options`). Used by
// realRequestReplay.test.js (in-process, synthetic) and scripts/ai-bus-replay.js
// (live HTTP). Coach tasks are intentionally excluded.

module.exports = [
  {
    taskId: "activity.contactSafetyReview",
    note: "Batch contact-safety review — a case mixing normal notes with an attorney/cease-desist signal (should NOT be allow_contact).",
    payload: {
      domain: "TAG",
      caseId: 778412,
      activities: [
        { ActivityType: "Note", Subject: "Inbound call", Comment: "Client called about a CP504 notice, owes ~$48k for 2019-2021, wants options.", CreatedDate: "2026-06-02" },
        { ActivityType: "Note", Subject: "Attorney letter", Comment: "Received cease and desist — client is represented by counsel, do not contact directly.", CreatedDate: "2026-06-10" },
        { ActivityType: "Call", Subject: "Follow-up", Comment: "No answer, left a voicemail.", ModifiedDate: "2026-06-12" },
      ],
    },
    options: { caller: "replay.activity" },
  },
  {
    taskId: "sms.classify",
    note: "Inbound SMS classifier — an explicit stop/DNC plus a legal threat (should land in a hard tier).",
    payload: { input: "STOP texting me. I never signed up for this and I'll report you to the FTC if you contact me again." },
    options: { caller: "replay.sms" },
  },
  {
    taskId: "resolution.pitch",
    note: "Secondary-sales pitch designer (compose + verdict fence) — a developable dossier.",
    payload: {
      input:
        "CLIENT DOSSIER: balance $48,200 across 2019-2021; 2022 unfiled; W2 income ~$72k; single; a prior installment agreement defaulted in 2023; CP504 issued 2026-05. " +
        "ASK: what is the strongest secondary play here and why? Anchor the fee against the enforcement consequence.",
    },
    options: { caller: "replay.resolution" },
  },
  {
    taskId: "ai.read",
    note: "Primitive aiRead — extract structured facts from free-text case notes (schema-constrained JSON).",
    payload: {
      system: "You extract structured facts from tax-resolution case notes. Return only the structured result.",
      input:
        "Spoke with Maria today. She owes roughly forty-eight thousand to the IRS spanning 2019 through 2021 and hasn't filed 2022 yet. " +
        "W2 income about seventy-two thousand. She's worried about wage garnishment after the latest notice.",
      schema: {
        type: "object",
        properties: {
          balance: { type: "number" },
          taxYears: { type: "array", items: { type: "string" } },
          unfiledYears: { type: "array", items: { type: "string" } },
          incomeType: { type: "string", enum: ["W2", "1099", "mixed", "unknown"] },
          enforcementRisk: { type: "string", enum: ["low", "medium", "high"] },
        },
        required: ["balance", "taxYears", "enforcementRisk"],
      },
    },
    options: { caller: "replay.read" },
  },
  {
    taskId: "ai.write",
    note: "Primitive aiWrite — compose a compliant follow-up SMS (no schema => prose).",
    payload: {
      system: "You write a concise, compliant follow-up SMS to a tax-resolution prospect. No promises, no savings numbers, no guarantees. Under 320 characters.",
      input: "Prospect Maria missed her 10am callback. She owes ~$48k and was anxious about wage garnishment. Re-engage warmly and offer two callback windows.",
    },
    options: { caller: "replay.write" },
  },
  {
    taskId: "ai.judge",
    note: "Primitive aiJudge — classify prospect readiness (schema-constrained).",
    payload: {
      system: "Classify the prospect's readiness to move forward right now.",
      input:
        "I want to do this but I need to talk to my husband first. The garnishment notice is really scaring me though — can you call me back tomorrow at 2?",
      schema: {
        type: "object",
        properties: {
          readiness: { type: "string", enum: ["ready", "warming", "stalling", "not_ready"] },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
          nextMove: { type: "string" },
        },
        required: ["readiness", "confidence"],
      },
    },
    options: { caller: "replay.judge" },
  },
];
