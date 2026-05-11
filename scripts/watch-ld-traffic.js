"use strict";

// LD vendor → parallel-gateway forward watcher.
//
// While the FORWARD_LD_TO_NEW_GATEWAY bandaid is on, we can't tail the
// old monolith's stdout (no log capture), so we poll the parallel
// database for the side-effects every forward should produce:
//
//   1. PrePing collection — every accepted /lead-contact/pre-ping
//      writes a row with TTL 300s. Sees the pre-ping leg even if
//      no matching /lead-contact ever arrives.
//   2. LeadCadence with intakeRoute starting "ld-" — every accepted
//      /lead-contact creates one. Sees the lead leg.
//
// Output is streamed line-by-line so a parent process (Monitor /
// `tail -F`) can react on each event.

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const {
  LeadCadence,
  PrePing,
} = require("../packages/shared-models/src");

const POLL_MS = Number(process.env.LD_WATCH_POLL_MS || 4000);

function ts() {
  // PT clock for log readability — operators read these in PT.
  return new Date().toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    hour12: false,
  });
}

function shortHash(value) {
  if (!value) return "";
  const s = String(value);
  return s.length > 10 ? `${s.slice(0, 8)}…` : s;
}

async function main() {
  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(process.env.MONGO_URI, { dbName });
  // Disable mongoose buffering so we crash fast instead of hanging on
  // a dropped connection — this watcher is meant to be obvious if it
  // breaks.
  mongoose.set("bufferCommands", false);

  console.log(`[${ts()}] [WATCH] LD traffic watcher started`);
  console.log(`[${ts()}] [WATCH]   db:        ${dbName}`);
  console.log(`[${ts()}] [WATCH]   poll:     ${POLL_MS}ms`);
  console.log(`[${ts()}] [WATCH]   collections: PrePing, LeadCadence(intakeRoute=^ld-)`);
  console.log(`[${ts()}] [WATCH]   waiting for vendor traffic...`);

  // Anchor watermarks just before "now" so we don't replay history.
  let lastPrePingAt = new Date();
  let lastLeadAt = new Date();

  let consecutiveErrors = 0;

  while (true) {
    try {
      // Pre-ping leg — TTL 300s so any miss here is rare. Use createdAt.
      const newPrePings = await PrePing.find({
        createdAt: { $gt: lastPrePingAt },
      })
        .sort({ createdAt: 1 })
        .lean();

      for (const p of newPrePings) {
        console.log(
          `[${ts()}] [WATCH] PRE-PING  domain=${p.domain}  emailHash=${shortHash(p.emailHash)}  callback=${p.callbackUrl ? "yes" : "no"}`,
        );
        if (p.createdAt > lastPrePingAt) lastPrePingAt = p.createdAt;
      }

      // Lead leg — only ld- routes (covers ld-posting-lead and ld-lead).
      const newLeads = await LeadCadence.find({
        createdAt: { $gt: lastLeadAt },
        intakeRoute: { $regex: /^ld-/ },
      })
        .sort({ createdAt: 1 })
        .lean();

      for (const lead of newLeads) {
        const phone = lead.phone || "(no-phone)";
        const name = lead.name || "(no-name)";
        const route = lead.intakeRoute || "(no-route)";
        const source = lead.intakeSource || "(no-source)";
        const caseId = lead.caseId || "(no-caseId)";
        const domain = lead.domain || "(no-domain)";
        console.log(
          `[${ts()}] [WATCH] LEAD       ${domain}/${caseId}  route=${route}  source=${source}  phone=${phone}  name="${name}"`,
        );
        if (lead.createdAt > lastLeadAt) lastLeadAt = lead.createdAt;
      }

      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors += 1;
      console.error(
        `[${ts()}] [WATCH] poll error #${consecutiveErrors}: ${err.message}`,
      );
      if (consecutiveErrors >= 5) {
        console.error(`[${ts()}] [WATCH] giving up after 5 consecutive errors`);
        process.exit(1);
      }
    }

    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((err) => {
  console.error(`[${ts()}] [WATCH] FATAL:`, err.stack || err.message);
  process.exit(1);
});

// Keep process alive on SIGTERM so it can be cleanly killed.
process.on("SIGINT", () => {
  console.log(`[${ts()}] [WATCH] received SIGINT, exiting`);
  mongoose.disconnect().finally(() => process.exit(0));
});
