"use strict";

// Re-run transcription + scoring on CX CallLog rows that got stuck on
// the old RingCentral-only download path.
//
// Background: until the Drive-first patch in transcriptionScoringService,
// every transcription attempt went to RingCentral's CDN. CX outbound
// calls have their recordings on Drive (via the RingCX
// interaction-metadata pipeline, NOT RC), so when RC rate-limited, the
// transcription marked the row `transcription_failed` even though the
// Drive copy was right there. The new code path reads from Drive when
// `recordingArchive.driveFileId` is set.
//
// This script:
//   1. Finds CX rows in a window where recordingArchive.status =
//      "completed" + driveFileId is set, but callScore.overall is null.
//   2. Resets transcription.status to "pending" + clears the stale
//      error so the next sweep picks them up.
//   3. Optionally (with --run) invokes processCallLogRecording directly
//      so the score appears in tonight's vendor email without waiting
//      for the next hourly tick.
//
// Usage:
//   node scripts/retry-stuck-cx-transcriptions.js                  # dry-run
//   node scripts/retry-stuck-cx-transcriptions.js --reset          # flip status, let sweep pick up
//   node scripts/retry-stuck-cx-transcriptions.js --reset --run    # also process inline
//   node scripts/retry-stuck-cx-transcriptions.js --domain WYNN --days 3 --run

require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const { CallLog } = require("../packages/shared-models/src");
const { processCallLogRecording } = require("../packages/shared-services/src/transcriptionScoringService");

function parseArgs(argv) {
  const args = { reset: false, run: false, domain: null, days: 7, limit: 200 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--reset") args.reset = true;
    else if (arg === "--run") args.run = true;
    else if (arg === "--domain") {
      args.domain = String(argv[i + 1] || "").toUpperCase() || null;
      i += 1;
    } else if (arg === "--days") {
      args.days = Math.max(Number(argv[i + 1]) || 7, 1);
      i += 1;
    } else if (arg === "--limit") {
      args.limit = Math.max(Number(argv[i + 1]) || 200, 1);
      i += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(uri, { dbName });

  const since = new Date(Date.now() - args.days * 24 * 60 * 60 * 1000);
  const query = {
    platform: "cx",
    callStartTime: { $gte: since },
    "recordingArchive.status": "completed",
    "recordingArchive.driveFileId": { $exists: true, $ne: null },
    "callScore.overall": null,
  };
  if (args.domain) query.domain = args.domain;

  const rows = await CallLog.find(query, {
    domain: 1,
    telephonySessionId: 1,
    callStartTime: 1,
    durationSec: 1,
    agentName: 1,
    caseId: 1,
    "transcription.status": 1,
    "transcription.attempts": 1,
    "recordingArchive.driveFileId": 1,
  })
    .sort({ callStartTime: -1 })
    .limit(args.limit)
    .lean();

  console.log(
    `\nFound ${rows.length} CX call(s) in last ${args.days}d with Drive archive but no score.\n`,
  );
  if (rows.length === 0) {
    await mongoose.disconnect();
    return;
  }

  const byStatus = {};
  for (const r of rows) {
    const s = r.transcription?.status || "—";
    byStatus[s] = (byStatus[s] || 0) + 1;
  }
  console.log("transcription.status distribution:", byStatus);

  if (!args.reset && !args.run) {
    console.log(
      "\nDry run only. Re-run with --reset to flip status to pending,\n" +
        "or --reset --run to also process inline now.\n",
    );
    await mongoose.disconnect();
    return;
  }

  if (args.reset) {
    // Reset attempts back to 0 so the abandonment cap doesn't fire — the
    // earlier attempts were against the broken RC-only path; the Drive
    // path is a fresh approach.
    const resetResult = await CallLog.updateMany(
      query,
      {
        $set: {
          "transcription.status": "pending",
          "transcription.error": null,
          "transcription.attempts": 0,
        },
      },
    );
    console.log(
      `Reset: matched=${resetResult.matchedCount}, modified=${resetResult.modifiedCount}`,
    );
  }

  if (args.run) {
    let completed = 0;
    let noTranscript = 0;
    let failed = 0;
    let other = 0;
    let i = 0;
    for (const row of rows) {
      i += 1;
      process.stdout.write(
        `[${i}/${rows.length}] ${row.domain} ${row.telephonySessionId} (${row.durationSec}s)... `,
      );
      try {
        const result = await processCallLogRecording({
          domain: row.domain,
          telephonySessionId: row.telephonySessionId,
          lane: "manual",
        });
        switch (result.status) {
          case "completed":
            completed += 1;
            console.log(`✓ scored (transcript ${result.transcriptLength} chars)`);
            break;
          case "no_transcript":
            noTranscript += 1;
            console.log("∅ Whisper returned empty");
            break;
          default:
            other += 1;
            console.log(`? ${result.status}`);
            break;
        }
      } catch (error) {
        failed += 1;
        console.log(`✗ ${error.message}`);
      }
    }
    console.log(
      `\nResult: completed=${completed}, noTranscript=${noTranscript}, failed=${failed}, other=${other}`,
    );
  }

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  try {
    await mongoose.disconnect();
  } catch (_) {
    // ignore
  }
  process.exit(1);
});
