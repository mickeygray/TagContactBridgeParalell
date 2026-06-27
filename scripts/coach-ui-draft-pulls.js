"use strict";

// Real Opus + Haiku pulls against the ACTUAL production request shape
// (buildBatchGuidanceRequest -> claude -p -> parseBatchGuidance), to ground the
// cockpit UI design in the real batch-guidance.v1 fields the models emit.
//
// Both tiers run on claude -p / Max here for convenience (the production reactor
// uses a separate metered key, but the request + output SHAPE is identical).

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

const now = new Date().toISOString();
const REFERENCE = buildReferenceBody();

function turn(role, text) {
  return { role, text, at: now, final: true };
}

// A diverse 3-call floor: objection mid-pitch / early discovery / close-stall.
const sessions = [
  {
    id: "coach-sean",
    status: "listening",
    lastEventAt: now,
    updatedAt: now,
    metadata: { source: "grpc-mongo", agentEmail: "sean@tag.com", agentName: "Sean", domain: "WYNN", caseId: "884412", uii: "uii-sean", contactName: "Robert M.", phone: "5125550141" },
    memory: {
      transcripts: [
        turn("agent", "Based on everything you've told me, we'd file the FTA, get the lien addressed, and put a protection layer between you and collections."),
        turn("agent", "To get the case opened and the team working, the fee to get started is eighteen hundred dollars."),
        turn("prospect", "Honestly, eighteen hundred is a lot for me right now. I don't know if I can swing that."),
        turn("agent", "I completely understand. Can I ask—"),
        turn("prospect", "I mean, what's stopping me from just calling the IRS myself and setting something up?"),
      ],
    },
  },
  {
    id: "coach-dana",
    status: "listening",
    lastEventAt: now,
    updatedAt: now,
    metadata: { source: "grpc-mongo", agentEmail: "dana@tag.com", agentName: "Dana", domain: "TAG", caseId: "771200", uii: "uii-dana", contactName: "Alicia P.", phone: "8135550199" },
    memory: {
      transcripts: [
        turn("agent", "Thanks for taking my call, Alicia. I see a notice came across—can you tell me what's going on?"),
        turn("prospect", "Yeah, I got this CP504 thing in the mail. It's scary. I haven't filed in like three years honestly."),
        turn("agent", "Okay, you're in the right place. Do you know roughly how much you owe?"),
        turn("prospect", "No idea. I'm self-employed so I never did the quarterly stuff, and I think they filed something for me?"),
      ],
    },
  },
  {
    id: "coach-mike",
    status: "listening",
    lastEventAt: now,
    updatedAt: now,
    metadata: { source: "grpc-mongo", agentEmail: "mike@tag.com", agentName: "Mike", domain: "WYNN", caseId: "905631", uii: "uii-mike", contactName: "Gerald T.", phone: "9495550107" },
    memory: {
      transcripts: [
        turn("agent", "So we're all set—the 2848, the 8821, and we'll get the state POA filed today so the protection starts now."),
        turn("prospect", "Okay. And the four-month plan, that was three-fifty a month?"),
        turn("agent", "That's right, three-fifty a month for four months and the team starts immediately."),
        turn("prospect", "Let me just… can I think about it over the weekend and call you Monday?"),
      ],
    },
  },
];

async function runPull(label, runner, req) {
  const startedAt = Date.now();
  const res = await runner(req);
  const elapsedMs = Date.now() - startedAt;
  const parsed = parseBatchGuidance(res);
  console.log(`\n===== ${label} =====`);
  console.log(`ok=${res.ok} elapsedMs=${elapsedMs} usage=${JSON.stringify(res.usage || null)}`);
  if (!res.ok) console.log("ERROR:", res.error, "\nraw:", String(res.text || "").slice(0, 400));
  console.log(JSON.stringify(parsed.guidance, null, 2));
  return parsed;
}

(async () => {
  const opus = createClaudeAgentRunner({ model: "opus", maxThinkingTokens: 0, timeoutMs: 180000 });
  const haiku = createClaudeAgentRunner({ model: "haiku", maxThinkingTokens: 0, timeoutMs: 120000 });

  // 1) DEEP PULL #1 (cold) — full floor.
  let batch = buildActiveLiveCoachBatch(sessions, {});
  const deep1 = await runPull("OPUS DEEP PULL #1 (cold)", opus, buildBatchGuidanceRequest(batch, { tier: DEEP_PULL, reference: REFERENCE }));

  // 2) Apply the deep pull's steering onto the sessions (callStrategy), like the loop does.
  for (const u of reduceDeepPullSteering(deep1)) {
    const s = sessions.find((x) => x.id === u.sessionId);
    if (s && u.callStrategy) s.callStrategy = u.callStrategy;
  }

  // 3) The calls progress one turn each (the reactor's reason to fire).
  sessions[0].memory.transcripts.push(turn("agent", "Fair question. Before I answer—when you've dealt with the IRS before, how did that go?"));
  sessions[0].memory.transcripts.push(turn("prospect", "Honestly? I called once and sat on hold for two hours and got nowhere."));
  sessions[1].memory.transcripts.push(turn("agent", "That's actually really common. The fact you reached out now is the right move."));
  sessions[1].memory.transcripts.push(turn("prospect", "I just don't want them taking money out of my account, that's my real fear."));
  sessions[2].memory.transcripts.push(turn("prospect", "I'm just nervous about committing to something on the spot, you know?"));

  // 4) REACTOR #1 (steered) — only the changed calls.
  const changes1 = buildActiveLiveCoachChangeSet(sessions, {});
  const reactor1 = await runPull("HAIKU REACTOR #1 (steered, changed calls)", haiku, buildBatchGuidanceRequest(changes1, { tier: REACTOR, reference: REFERENCE }));

  // 5) DEEP PULL #2 (warm, prior strategy in the projection) — full floor.
  batch = buildActiveLiveCoachBatch(sessions, {});
  await runPull("OPUS DEEP PULL #2 (warm)", opus, buildBatchGuidanceRequest(batch, { tier: DEEP_PULL, reference: REFERENCE }));

  // 6) REACTOR #2 — one more turn on Sean's call (the objection resolves or hardens).
  sessions[0].memory.transcripts.push(turn("prospect", "So you're saying you can actually stop the garnishment? Because that's what I care about."));
  const changes2 = buildActiveLiveCoachChangeSet(sessions, { cursor: changes1.cursor });
  await runPull("HAIKU REACTOR #2 (Sean's objection turns to interest)", haiku, buildBatchGuidanceRequest(changes2, { tier: REACTOR, reference: REFERENCE }));

  console.log(`\n[reference body chars: ${REFERENCE.length}]`);
})().catch((e) => {
  console.error("fatal:", e.message);
  process.exit(1);
});
