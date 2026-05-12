"use strict";

// Diagnose CX-call recording archival state. Walks the last N days of
// CallLog rows with platform="cx" and reports:
//   • how many have recording archive state
//   • by status (pending / archived / abandoned / no_recording / etc.)
//   • how many have a CallRail or RC artifact attached
//   • sample of "abandoned" rows so we can see what's missing
//
// Usage: node scripts/inspect-cx-recordings.js [days=7]

require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
const mongoose = require("mongoose");

const { CallLog } = require("../packages/shared-models/src");

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(uri, { dbName });

  const days = Number(process.argv[2] || 7);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  console.log(`window: last ${days} days (since ${since.toISOString()})`);

  for (const domain of ["TAG", "WYNN"]) {
    console.log(`\n=== ${domain} — platform="cx" call rows ===`);
    const cxRows = await CallLog.find(
      { domain, platform: "cx", callStartTime: { $gte: since } },
      {
        telephonySessionId: 1,
        callStartTime: 1,
        durationSec: 1,
        durationSeconds: 1,
        direction: 1,
        executionOwner: 1,
        recordingArchive: 1,
        transcription: 1,
        callScore: 1,
        legsSnapshot: 1,
        sourceName: 1,
        caseId: 1,
        agentName: 1,
        phone: 1,
      },
    )
      .sort({ callStartTime: -1 })
      .limit(500)
      .lean();
    console.log(`  total CX rows: ${cxRows.length}`);

    const archiveBuckets = {};
    let withRecordingUri = 0;
    let withTranscriptText = 0;
    let withScore = 0;
    let withLegsSnapshot = 0;
    let dur0 = 0;
    let dur1_29 = 0;
    let dur30_59 = 0;
    let dur60plus = 0;

    for (const r of cxRows) {
      const status = r.recordingArchive?.status || "(no recordingArchive)";
      archiveBuckets[status] = (archiveBuckets[status] || 0) + 1;
      if (r.recordingArchive?.driveFileId || r.recordingArchive?.driveWebViewLink) withRecordingUri += 1;
      if (r.transcription?.recordingUri) withRecordingUri += 0; // already counted via archive bucket
      if (String(r.transcription?.text || "").trim()) withTranscriptText += 1;
      if (r.callScore?.overall != null) withScore += 1;
      if (Array.isArray(r.legsSnapshot) && r.legsSnapshot.length > 0) withLegsSnapshot += 1;
      const d = Number(r.durationSec || r.durationSeconds || 0);
      if (d === 0) dur0 += 1;
      else if (d < 30) dur1_29 += 1;
      else if (d < 60) dur30_59 += 1;
      else dur60plus += 1;
    }

    console.log("  recordingArchive.status distribution:", archiveBuckets);
    console.log(`  with driveFileId / driveWebViewLink: ${withRecordingUri}`);
    console.log(`  with transcript text: ${withTranscriptText}`);
    console.log(`  with callScore: ${withScore}`);
    console.log(`  with legsSnapshot: ${withLegsSnapshot}`);
    console.log("  duration buckets (sec):", { dur0, "1-29": dur1_29, "30-59": dur30_59, "60+": dur60plus });

    // Show samples of CX-recorded calls that have NO recording attached
    const abandoned = cxRows.filter(
      (r) =>
        Number(r.durationSec || r.durationSeconds || 0) >= 60 &&
        !r.recordingArchive?.driveFileId &&
        !r.transcription?.recordingUri,
    );
    console.log(`\n  long CX calls (60+ sec) with no recording artifact: ${abandoned.length}`);
    for (const r of abandoned.slice(0, 8)) {
      console.log(
        `    ${r.callStartTime?.toISOString?.()} dir=${r.direction} dur=${r.durationSec || r.durationSeconds}s owner=${r.executionOwner} agent=${r.agentName} caseId=${r.caseId} legs=${r.legsSnapshot?.length || 0} status=${r.recordingArchive?.status || "(none)"} err=${r.recordingArchive?.error || ""}`,
      );
    }
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
