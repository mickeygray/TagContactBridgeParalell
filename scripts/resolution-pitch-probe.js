"use strict";

// Operator tool: run the resolution pitch designer against a real case
// WITHOUT the service stack — same doctrine, same dossier assembly, same
// verdict parse as ai-bus + control-plane. The harness for doctrine
// iteration: edit resolutionPitchDoctrine.md, re-run, read the assessment.
// Read-only against Mongo; one Anthropic call; nothing persisted.
//
// Usage: node scripts/resolution-pitch-probe.js [--domain TAG|WYNN] <caseNumber> ["follow-up question"]

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { getClientProfileByCaseNumber } = require("../packages/shared-repositories/src/clientProfileRepository");
const { parsePitchVerdict } = require("../packages/shared-services/src/resolutionPitchVerdict");

function argValue(flag, fallback = null) {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

function normalizeDomain(value) {
  return String(value || "TAG").trim().toUpperCase() || "TAG";
}

const DOCTRINE = fs.readFileSync(
  path.join(__dirname, "../packages/shared-services/src/resolutionPitchDoctrine.md"),
  "utf8",
);

(async () => {
  const domain = normalizeDomain(argValue("--domain", "TAG"));
  const args = process.argv.slice(2).filter((a, index, list) => (
    a !== "--domain" && list[index - 1] !== "--domain"
  ));
  const caseNumber = args[0];
  const ask = args[1] || "";
  if (!caseNumber) throw new Error("usage: node scripts/resolution-pitch-probe.js [--domain TAG|WYNN] <caseNumber> [\"question\"]");
  const apiKey = String(process.env.ANTHROPIC_API_KEY || "").trim();
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  await mongoose.connect(process.env.MONGO_URI, {
    dbName: process.env.MONGO_DB_NAME || "tagcontactbridge_parallel",
  });
  const profile = await getClientProfileByCaseNumber(caseNumber, domain);
  await mongoose.disconnect();
  if (!profile) throw new Error(`no profile for ${domain}:${caseNumber}`);

  const { _id, __v, pitch, createdAt, updatedAt, ...dossier } = profile;
  if (Array.isArray(dossier.documentHashes)) {
    dossier.documentHashes = dossier.documentHashes.map((d) => ({
      docType: d.docType, label: d.label, parsedAt: d.parsedAt,
    }));
  }

  const messages = [
    { role: "user", content: `CLIENT DOSSIER (shorthand values carry provenance + as-of dates):\n${JSON.stringify(dossier)}` },
    ask
      ? { role: "user", content: ask }
      : { role: "user", content: "First read on this client. Produce the full pitchability assessment." },
  ];

  const startedAt = Date.now();
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: String(process.env.RESOLUTION_AGENT_MODEL || "claude-opus-4-8").trim(),
      // Thinking + reply share this budget; starve it and you get all
      // thinking, no text (observed live at 2400).
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      system: [{ type: "text", text: DOCTRINE, cache_control: { type: "ephemeral" } }],
      messages,
    }),
  });
  if (!response.ok) {
    throw new Error(`anthropic ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  const payload = await response.json();
  const text = (payload.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  const { reply, verdict } = parsePitchVerdict(text);

  console.log(`=== pitch assessment for ${domain}:${caseNumber} (${Date.now() - startedAt}ms, ${payload.model}) ===\n`);
  console.log(reply);
  console.log("\n=== parsed verdict ===");
  console.log(JSON.stringify(verdict, null, 2));
  console.log("\n=== usage ===");
  console.log(JSON.stringify(payload.usage));
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
