"use strict";

// Find recent CX calls with enough duration to be worth pulling a
// recording of. Prints the identifiers needed to attempt a spot-
// download via RingCX's interaction-metadata endpoint:
//
//   • telephonySessionId      → the UII (our universal id)
//   • ringcx.dialogId         → set after interaction-metadata returns
//   • ringcx.segmentIds       → segments inside the dialog
//   • ringcx.agentId          → narrows the metadata POST to one agent
//   • ringcx.campaignId       → backup filter
//   • ringcx.externId         → our forensic id (parallel:DOMAIN:caseId:queueItemId)
//   • recordingArchive.status → did the hourly sweep already grab it?
//   • driveFileId / driveWebViewLink → if archived, where it lives now
//
// Usage:
//   node scripts/find-cx-recording-candidates.js [days=2] [minDurationSec=60] [limit=15]

require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const { CallLog } = require("../packages/shared-models/src");

function fmtDuration(sec) {
  const n = Number(sec || 0);
  const m = Math.floor(n / 60);
  const s = n % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtTime(date) {
  if (!date) return "—";
  return new Date(date).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(uri, { dbName });

  const days = Number(process.argv[2] || 2);
  const minDurationSec = Number(process.argv[3] || 60);
  const limit = Number(process.argv[4] || 15);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  console.log(`\nWindow:  last ${days} days (since ${fmtTime(since)})`);
  console.log(`Filter:  platform=cx, durationSec >= ${minDurationSec}, direction=outbound`);
  console.log(`Limit:   top ${limit} by duration desc\n`);

  for (const domain of ["TAG", "WYNN"]) {
    const rows = await CallLog.find(
      {
        domain,
        platform: "cx",
        direction: "outbound",
        callStartTime: { $gte: since },
        durationSec: { $gte: minDurationSec },
      },
      {
        telephonySessionId: 1,
        callStartTime: 1,
        durationSec: 1,
        agentName: 1,
        extensionId: 1,
        phone: 1,
        caseId: 1,
        sourceName: 1,
        routeCampaignKey: 1,
        ringcx: 1,
        recordingArchive: 1,
        "transcription.status": 1,
        "transcription.recordingUri": 1,
        "callScore.overall": 1,
        "callScore.lead_verdict": 1,
      },
    )
      .sort({ durationSec: -1, callStartTime: -1 })
      .limit(limit)
      .lean();

    console.log(`=== ${domain} — ${rows.length} candidate(s) ===\n`);
    if (rows.length === 0) continue;

    rows.forEach((r, i) => {
      const archive = r.recordingArchive || {};
      const archived = archive.status === "completed";
      const tag = archived ? "✓ARCHIVED" : `(${archive.status || "no-archive"})`;
      const route = r.routeCampaignKey || "—";
      console.log(`  [${i + 1}] ${fmtTime(r.callStartTime)}  dur=${fmtDuration(r.durationSec)}  ${tag}`);
      console.log(`       agent      : ${r.agentName || "—"} (ext ${r.extensionId || "—"})`);
      console.log(`       phone      : ${r.phone || "—"}  case=${r.caseId || "—"}`);
      console.log(`       source     : ${r.sourceName || "—"}  routeCampaign=${route}`);
      console.log(`       uii        : ${r.telephonySessionId || "—"}`);
      console.log(`       ringcx     :`);
      console.log(`         agentId      ${r.ringcx?.agentId || "—"}`);
      console.log(`         campaignId   ${r.ringcx?.campaignId || "—"}`);
      console.log(`         dialogId     ${r.ringcx?.dialogId || "—"}`);
      console.log(`         segmentIds   ${(r.ringcx?.segmentIds || []).join(", ") || "—"}`);
      console.log(`         externId     ${r.ringcx?.externId || "—"}`);
      if (archived) {
        console.log(`       drive      : ${archive.driveWebViewLink || archive.driveFileId || "(no link)"}`);
      } else if (archive.status === "download_failed" || archive.error) {
        console.log(`       error      : ${archive.error || archive.status}`);
      }
      if (r.transcription?.status === "completed") {
        console.log(`       transcript : completed  score=${r.callScore?.overall ?? "—"}  verdict=${r.callScore?.lead_verdict || "—"}`);
      } else if (r.transcription?.status) {
        console.log(`       transcript : ${r.transcription.status}`);
      }
      console.log("");
    });
  }

  // Quick summary line: how many archived-with-drive-link in the window?
  for (const domain of ["TAG", "WYNN"]) {
    const archivedCount = await CallLog.countDocuments({
      domain,
      platform: "cx",
      callStartTime: { $gte: since },
      "recordingArchive.status": "completed",
    });
    console.log(`${domain}: ${archivedCount} CX call(s) in window with recordingArchive.status=completed`);
  }

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
