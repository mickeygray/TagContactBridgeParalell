"use strict";

// Validate the NEW skeleton-fed prompts against real models: does Opus (deep) +
// Haiku (reactor) fill in the response object and honor the intent —
// say-as-choice, ~75/25 objection/tactic, script-anchored beats, reads the rolling
// summary (Codex's job), keeps tax OUT of the says?
// Uses the PRODUCTION request builders (buildBatchGuidanceRequest), not a copy.

const {
  buildBatchGuidanceRequest,
  parseBatchGuidance,
  reduceDeepPullSteering,
  DEEP_PULL,
  REACTOR,
} = require("../packages/shared-services/src/coachBatchRunner");
const {
  buildActiveLiveCoachBatch,
  buildActiveLiveCoachChangeSet,
} = require("../packages/shared-services/src/liveCoachBatchProjectionService");
const { buildReferenceBody } = require("../packages/shared-services/src/coachReferenceLibrary");
const { createClaudeAgentRunner } = require("./claudeAgentRunner");

const REFERENCE = buildReferenceBody();
const now = new Date().toISOString();
const t = (role, text) => ({ role, text, at: now, final: true });

// Sessions carry a CODEX-style rolling summary in callSummary — the deep pull must
// INTERPRET it (not rewrite it) and must not echo tax facts into the says.
const sessions = [
  {
    id: "coach-sean", status: "listening", lastEventAt: now, updatedAt: now,
    metadata: { source: "grpc-mongo", agentEmail: "sean@tag.com", agentName: "Sean", domain: "WYNN", caseId: "884412", uii: "uii-sean", contactName: "Robert M." },
    callSummary: "Built the case (unfiled years + active wage garnishment) and quoted the $1,800 flat fee. Defused 'call the IRS myself' with his two-hours-on-hold story. He just asked point-blank whether you can stop the garnishment. Tax: active garnishment (enforcing), substitute returns likely inflating the balance, FTA may apply once represented.",
    // Codex's STRUCTURED rolling summary (latest.rollingSummary) — the deep pull must
    // interpret the buckets: objections -> says (overcome), taxIssues -> tax-memory remember,
    // factsCaptured -> don't re-ask, openQuestions -> asks. It must NOT echo taxIssues into says.
    latest: {
      rollingSummary: {
        summaryText: "Built the case (unfiled years + active wage garnishment) and quoted the $1,800 flat fee. Defused 'call the IRS myself' with his two-hours-on-hold story. He just asked point-blank whether you can stop the garnishment.",
        factsCaptured: ["Multiple unfiled years", "Active wage garnishment", "Quoted $1,800 flat fee"],
        openQuestions: ["How many years unfiled exactly?", "Current monthly garnishment amount?"],
        objections: ["$1,800 is a lot", "Could just call the IRS himself"],
        taxIssues: ["Active wage garnishment (enforcing)", "Substitute returns likely inflating the balance", "FTA may apply once represented"],
        nextBestFocus: "Answer the garnishment question directly, then tie the fee to stopping enforcement.",
      },
    },
    memory: { transcripts: [
      t("agent", "To open the case the flat fee is eighteen hundred."),
      t("prospect", "That's a lot. And what's stopping me from just calling the IRS myself?"),
      t("agent", "Fair question — when you dealt with them before, how did that go?"),
      t("prospect", "Two hours on hold, got nowhere."),
      t("prospect", "So can you actually stop the garnishment? That's what I care about."),
    ] },
  },
  {
    id: "coach-dana", status: "listening", lastEventAt: now, updatedAt: now,
    metadata: { source: "grpc-mongo", agentEmail: "dana@tag.com", agentName: "Dana", domain: "TAG", caseId: "771200", uii: "uii-dana", contactName: "Alicia P." },
    callSummary: "Early discovery. Surfaced a CP504 notice, 3 unfiled years, self-employed. Her core fear is money pulled from her account. Balance unknown. Tax: CP504 = intent to levy (~30 day clock); unfiled years mean substitute returns inflate the balance.",
    memory: { transcripts: [
      t("agent", "I see a notice came across — what's going on?"),
      t("prospect", "I got a CP504. Haven't filed in three years. I'm self-employed."),
      t("agent", "Do you know roughly how much you owe?"),
      t("prospect", "No idea. I just don't want them taking money out of my account."),
    ] },
  },
  {
    id: "coach-mike", status: "listening", lastEventAt: now, updatedAt: now,
    metadata: { source: "grpc-mongo", agentEmail: "mike@tag.com", agentName: "Mike", domain: "WYNN", caseId: "905631", uii: "uii-mike", contactName: "Gerald T." },
    callSummary: "Full close setup — all three POAs and a four-month $350 plan on the table. He accepted the structure, then asked to think it over the weekend. Reads as commitment nerves, not cost.",
    memory: { transcripts: [
      t("agent", "We're set — 2848, 8821, state POA filed today. Four months at three-fifty."),
      t("prospect", "Can I think about it over the weekend?"),
      t("agent", "Totally fair."),
      t("prospect", "I'm just nervous committing on the spot."),
    ] },
  },
];

function sayMix(parsed) {
  const counts = { objection: 0, tactic: 0, line: 0, tax: 0 };
  for (const row of parsed.guidance || []) {
    for (const s of row.says || (row.say ? [row.say] : [])) {
      counts[s.type] = (counts[s.type] || 0) + 1;
      if (/cp504|substitute|levy|garnish|fta|2848|8821|circular 230/i.test(s.text) && s.type !== "objection") counts.tax += 1;
    }
  }
  return counts;
}

(async () => {
  const opus = createClaudeAgentRunner({ model: "opus", maxThinkingTokens: 0, timeoutMs: 180000 });
  const haiku = createClaudeAgentRunner({ model: "haiku", maxThinkingTokens: 0, timeoutMs: 120000 });

  // DEEP PULL (Opus) — full batch.
  const batch = buildActiveLiveCoachBatch(sessions, {});
  const deepReq = buildBatchGuidanceRequest(batch, { tier: DEEP_PULL, reference: REFERENCE });
  let started = Date.now();
  const deepRes = await opus(deepReq);
  const deep = parseBatchGuidance(deepRes);
  console.log(`\n===== OPUS DEEP PULL (${Date.now() - started}ms, ok=${deepRes.ok}) =====`);
  console.log(JSON.stringify(deep.guidance, null, 2));
  console.log("say-type mix:", JSON.stringify(sayMix(deep)));
  console.log("state updates:", JSON.stringify(reduceDeepPullSteering(deep).map((u) => ({ s: u.sessionId, sec: u.currentSection, beats: u.beats.length, says: u.says.length })), null, 0));

  // REACTOR (Haiku) — changed calls.
  const changes = buildActiveLiveCoachChangeSet(sessions, {});
  const reactReq = buildBatchGuidanceRequest(changes, { tier: REACTOR, reference: REFERENCE });
  started = Date.now();
  const reactRes = await haiku(reactReq);
  const react = parseBatchGuidance(reactRes);
  console.log(`\n===== HAIKU REACTOR (${Date.now() - started}ms, ok=${reactRes.ok}) =====`);
  console.log(JSON.stringify(react.guidance, null, 2));
  console.log("say-type mix:", JSON.stringify(sayMix(react)));
})().catch((e) => { console.error("fatal:", e.message); process.exit(1); });
