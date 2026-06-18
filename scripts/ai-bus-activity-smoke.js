"use strict";

// LIVE smoke for the activity-review round-trip (the box step at 5:30).
// Requires: ai-bus running on 7000 with real keys, and
//   AI_TASK_ACTIVITY_CONTACTSAFETYREVIEW_ENABLED=true
// Hits the bus for BOTH providers with a fixed sample case (no Logics, no Mongo)
// and prints whether each returned a contract-valid review + timing.
//
//   node scripts/ai-bus-activity-smoke.js
//
// Pass = both providers return ok with a valid status enum. A REAL model call
// through the full 5001->7000->5001 path. If a provider fails, you see the code.

const { createAiTaskClient } = require("../packages/shared-services/src/aiTaskClient");

const SAMPLE = [
  { ActivityType: "Note", Subject: "Attorney letter", Comment: "cease and desist — represented by counsel", CreatedDate: "2026-06-01" },
  { ActivityType: "Call", Subject: "Hostile", Comment: "told us to stop calling and threatened to report us to the FTC", ModifiedDate: "2026-06-05" },
];
const STATUSES = ["allow_contact", "pause_contact", "stop_contact", "manual_review"];

(async () => {
  const client = createAiTaskClient();
  console.log(`bus base: ${client.baseUrl}`);
  let allValid = true;
  for (const provider of ["anthropic", "openai"]) {
    const r = await client.runAiTask(
      "activity.contactSafetyReview",
      { domain: "TAG", caseId: 99999, activities: SAMPLE },
      { forceProvider: provider, caller: "activity-smoke" },
    );
    const valid = Boolean(r.ok && r.result && STATUSES.includes(r.result.status));
    allValid = allValid && valid;
    const t = r.timing || {};
    console.log(
      `[${provider}] ok=${r.ok} servedBy=${r.provider || "-"} model=${r.model || "-"} ` +
        `status=${r.result && r.result.status} confidence=${r.result && r.result.confidence} ` +
        `valid=${valid} transportMs=${t.transportMs != null ? t.transportMs.toFixed(1) : "-"} busMs=${t.busMs != null ? t.busMs : "-"}`,
    );
    if (!r.ok) console.log(`   code=${r.code} fallback=${JSON.stringify(r.safeFallback)}`);
  }
  console.log(allValid ? "\nPASS — both providers returned a contract-valid review through the bus." : "\nFAIL — see codes above.");
  process.exit(allValid ? 0 : 1);
})().catch((e) => {
  console.error("smoke error:", e && e.message);
  process.exit(1);
});
