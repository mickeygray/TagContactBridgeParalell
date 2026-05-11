"use strict";

/**
 * Classifier-only smoke test. No DB, no send. Runs 8 representative
 * inbound payloads through smsClassifierService.classifySms and prints
 * tier + intent + confidence + reply.
 */

require("dotenv").config();

const { classifySms } = require("../packages/shared-services/src");

const TRACKING_NUMBER = "818-686-5483";

const SAMPLES = [
  { label: "carrier STOP", text: "STOP" },
  { label: "has representation", text: "i have a lawyer handling this, please dont contact me" },
  { label: "doesnt owe taxes", text: "i dont owe any taxes, you have the wrong person" },
  { label: "wrong number", text: "wrong number, this isnt me" },
  { label: "polite fee question", text: "what would you charge to help with $20k i owe from 2019?" },
  { label: "callback request", text: "can someone call me? i got a letter from IRS" },
  { label: "hostile", text: "stop calling me you scammers, ill sue" },
  { label: "ambiguous", text: "ok" },
];

async function main() {
  console.log(`Running ${SAMPLES.length} classifier samples…\n`);
  for (const sample of SAMPLES) {
    const result = await classifySms({
      text: sample.text,
      fromPhone: "8185551234",
      company: "TAG",
      trackingNumber: TRACKING_NUMBER,
      history: [],
    });
    console.log(
      `[${sample.label.padEnd(22)}] tier=${result.tier.padEnd(17)} intent=${String(result.intent).padEnd(22)} conf=${result.confidence.toFixed(2)}  model=${result.model || "-"}`,
    );
    if (result.suggestedReply) {
      console.log(`  reply: ${result.suggestedReply}`);
    }
    if (result.rationale) {
      console.log(`  why:   ${result.rationale}`);
    }
    console.log("");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
