"use strict";

// Runs the realistic fixtures through the bus with REAL providers, in-process.
// SPENDS REAL MONEY (pennies). Loads .env for keys. The full real path: request
// building (baked sandbox prompts) -> real model -> contract validation -> failover.
//
//   node scripts/ai-bus-replay-real.js
//   node scripts/ai-bus-replay-real.js --task resolution.pitch
//   node scripts/ai-bus-replay-real.js --provider openai     # force OpenAI on all (proves either provider)

require("dotenv").config();
const { createAnthropicClient, createOpenAiClient } = require("../packages/shared-integrations/src");
const { createAiProviders } = require("../packages/shared-services/src/aiProviders");
const { createAiTaskRunner } = require("../packages/shared-services/src/aiTaskRunner");
const { buildBusRegistry } = require("../packages/shared-services/src/aiBusRegistry");
const fixtures = require("../tests/ai-bus/fixtures/realRequests");

const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
const FORCE = arg("--provider");
const ONLY = arg("--task");

const registry = buildBusRegistry();
const runner = createAiTaskRunner({
  providers: createAiProviders({ anthropic: createAnthropicClient(), openai: createOpenAiClient() }),
  registry,
  telemetry: { record: () => {} },
});

function show(v, n = 1400) {
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  return s && s.length > n ? `${s.slice(0, n)}…` : s;
}

(async () => {
  const list = ONLY ? fixtures.filter((f) => f.taskId === ONLY) : fixtures;
  console.log(`Replaying ${list.length} packet(s) through REAL models${FORCE ? ` (forced provider=${FORCE})` : ""}.\n`);
  for (const fx of list) {
    const opts = { ...(fx.options || {}), ignoreEnabled: true };
    if (FORCE) opts.forceProvider = FORCE;
    const t0 = Date.now();
    let out;
    try {
      out = await runner.runAiTask(fx.taskId, fx.payload, opts);
    } catch (e) {
      console.log(`=== ${fx.taskId} === THREW: ${e.message}\n`);
      continue;
    }
    const ms = Date.now() - t0;
    console.log(`=== ${fx.taskId} ===  [${ms}ms]`);
    console.log(`  ${fx.note}`);
    console.log(`  ok=${out.ok} provider=${out.provider} model=${out.model}` + (out.usage ? ` usage=${JSON.stringify(out.usage)}` : ""));
    if (out.ok) {
      console.log(`  RESULT:\n${show(out.result).split("\n").map((l) => "    " + l).join("\n")}`);
    } else {
      console.log(`  code=${out.code}`);
      console.log(`  attempts=${show(out.attempts, 500)}`);
    }
    console.log("");
  }
  console.log("done — real models, real spend.");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
