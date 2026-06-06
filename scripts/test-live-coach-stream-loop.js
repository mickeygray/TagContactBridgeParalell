#!/usr/bin/env node
"use strict";

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const {
  runStreamLoopFixture,
} = require("../packages/shared-services/src/liveCoachStreamLoopHarnessService");

function readFlag(argv, name, fallback = "") {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1) return argv[idx + 1];
  return fallback;
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

const FIXTURES = {
  irs_collection: [
    { text: "I got certified mail from the Department of Treasury", vadRelease: false },
    { text: "and it says they can take money out of my check.", vadRelease: true },
  ],
  unfiled_1099_cost: [
    { text: "I haven't done my taxes in years", vadRelease: false },
    { text: "I drive DoorDash and my CPA told me to ask what this costs.", vadRelease: true },
  ],
  state_ambiguous: [
    { text: "I got a scary state letter but I don't know if I owe the IRS too.", vadRelease: true },
  ],
  screener: [
    { text: "I'll see if this person is available one moment.", vadRelease: true },
  ],
  voicemail: [
    { text: "At the tone please record your message.", vadRelease: true },
  ],
};

function printHelp() {
  console.log(`Live coach stream-loop local fixture

Usage:
  node scripts/test-live-coach-stream-loop.js [options]

Options:
  --scenario NAME       ${Object.keys(FIXTURES).join(" | ")}
  --text TEXT           Single ad hoc prospect phrase; overrides --scenario
  --agent-name NAME     Agent name for prompt payload
  --firm-name NAME      Firm name for prompt payload
  --json                Print full JSON result

This does not call OpenAI or Anthropic. It tests the local handoff:
STT text -> deterministic watcher -> VAD release -> simulated mini key judgement -> Sonnet prompt/draft.
`);
}

function summarize(result) {
  const context = result.contextFrame || null;
  const dialog = result.dialog || null;
  const release = result.release || null;
  return {
    status: result.status,
    action: release?.action || null,
    phraseText: context?.phraseText || release?.phraseText || "",
    selectedKeys: context?.miniJudgement?.selectedKeys || [],
    candidateKeys: context?.miniJudgement?.candidateKeys || (release?.candidates || []).map((item) => item.key),
    specificity: context?.miniJudgement?.specificity || null,
    meaning: context?.miniJudgement?.meaning || null,
    dialog: dialog
      ? {
        status: dialog.status,
        label: dialog.label,
        say: dialog.say,
      }
      : null,
    events: (result.events || []).map((event) => ({
      stage: event.stage,
      action: event.action,
      selectedKeys: event.selectedKeys,
      status: event.status,
      label: event.label,
      say: event.say,
    })),
  };
}

function main() {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
    printHelp();
    return;
  }

  const text = readFlag(argv, "--text", "");
  const scenario = readFlag(argv, "--scenario", "irs_collection");
  const chunks = text
    ? [{ text, vadRelease: true }]
    : FIXTURES[scenario];
  if (!chunks) {
    throw new Error(`Unknown scenario ${scenario}. Use one of: ${Object.keys(FIXTURES).join(", ")}`);
  }

  const metadata = {
    agentName: readFlag(argv, "--agent-name", "Chris"),
    firmName: readFlag(argv, "--firm-name", "Tax Advocate Group"),
    uii: `fixture-${scenario}`,
    agentEmail: "local.fixture@taxadvocategroup.com",
  };

  const result = runStreamLoopFixture({
    chunks,
    metadata,
    maxMatches: 7,
  });

  if (hasFlag(argv, "--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(JSON.stringify(summarize(result), null, 2));
}

main();
