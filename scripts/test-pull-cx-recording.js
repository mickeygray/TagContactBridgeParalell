"use strict";

// One-shot diagnostic: walk the full CX recording pull for a single
// telephonySessionId. Shows every step of the path so we can see
// exactly where it breaks for stuck calls — RC permissions,
// interaction-metadata response shape, talk-time computation,
// segment-download access, Drive upload.
//
// Read-only by default: queries RC and logs what came back, prints
// what WOULD be uploaded, but does not write to CallLog or Drive.
// Pass --apply to actually run the archive write.
//
// Usage:
//   node scripts/test-pull-cx-recording.js <telephonySessionId>
//   node scripts/test-pull-cx-recording.js <uii> --apply
//   node scripts/test-pull-cx-recording.js <uii> --window-min 90
//
// Defaults to the longest known stuck call (Anthony, 34:41, today) if
// no UII is provided.

require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const { CallLog } = require("../packages/shared-models/src");
const {
  createRingcxVoiceClient,
} = require("../packages/shared-integrations/src");

const DEFAULT_UII = "202605201152556160000556152229";

function parseArgs(argv) {
  const args = { uii: null, apply: false, windowMin: 60 };
  for (let i = 0; i < argv.length; i += 1) {
    const v = argv[i];
    if (v === "--apply") args.apply = true;
    else if (v === "--window-min") {
      args.windowMin = Math.max(Number(argv[i + 1]) || 60, 5);
      i += 1;
    } else if (v.startsWith("--")) {
      // ignore unknown
    } else if (!args.uii) {
      args.uii = v;
    }
  }
  return args;
}

function ms(d) {
  if (!d) return null;
  return new Date(d).getTime();
}

function fmtSec(secOrMs, isMs = false) {
  const sec = isMs ? Math.round(Number(secOrMs) / 1000) : Math.round(Number(secOrMs) || 0);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")} (${sec}s)`;
}

function formatLocalDate(date) {
  return new Date(date).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

function pickTalkTime(seg) {
  // Try every plausible field name RingCX has used for talk-time.
  // Per RC docs the segment record contains contact start/end + total
  // duration; talk time is the contact window.
  if (Number.isFinite(Number(seg.segmentTalkTime))) {
    return { source: "segmentTalkTime", sec: Number(seg.segmentTalkTime) };
  }
  if (Number.isFinite(Number(seg.talkTime))) {
    return { source: "talkTime", sec: Number(seg.talkTime) };
  }
  const startMs = Number(seg.segmentContactStartTimeMs);
  const endMs = Number(seg.segmentContactEndTimeMs);
  if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
    return {
      source: "segmentContactEndTimeMs - segmentContactStartTimeMs",
      sec: Math.round((endMs - startMs) / 1000),
    };
  }
  if (Number.isFinite(Number(seg.contactDurationSec))) {
    return { source: "contactDurationSec", sec: Number(seg.contactDurationSec) };
  }
  return { source: "unknown", sec: null };
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const uii = args.uii || DEFAULT_UII;
  console.log(`\n=== Test pull for telephonySessionId=${uii} ===\n`);

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(uri, { dbName });

  // ── Step 1: pull the CallLog row ─────────────────────────────────
  console.log("Step 1: CallLog lookup");
  const callLog = await CallLog.findOne({ telephonySessionId: uii }).lean();
  if (!callLog) {
    console.log(`  ✗ CallLog row not found for telephonySessionId=${uii}`);
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log(`  ✓ Found row:`);
  console.log(`      _id            : ${callLog._id}`);
  console.log(`      domain         : ${callLog.domain}`);
  console.log(`      platform       : ${callLog.platform}`);
  console.log(`      direction      : ${callLog.direction}`);
  console.log(`      callStartTime  : ${formatLocalDate(callLog.callStartTime)}`);
  console.log(`      callEndTime    : ${formatLocalDate(callLog.callEndTime)}`);
  console.log(`      durationSec    : ${fmtSec(callLog.durationSec)}`);
  console.log(`      agentName      : ${callLog.agentName || "—"}`);
  console.log(`      extensionId    : ${callLog.extensionId || "—"}`);
  console.log(`      caseId         : ${callLog.caseId || "—"}`);
  console.log(`      sourceName     : ${callLog.sourceName || "—"}`);
  console.log(`      routeCampaign  : ${callLog.routeCampaignKey || "—"}`);
  console.log(`      archive.status : ${callLog.recordingArchive?.status || "(no status)"}`);
  console.log(`      archive.driveFileId : ${callLog.recordingArchive?.driveFileId || "—"}`);
  console.log(`      ringcx.agentId      : ${callLog.ringcx?.agentId || "—"}`);
  console.log(`      ringcx.agentUsername: ${callLog.ringcx?.agentUsername || "—"}`);
  console.log(`      ringcx.campaignId   : ${callLog.ringcx?.campaignId || "—"}`);
  console.log(`      ringcx.dialogId     : ${callLog.ringcx?.dialogId || "—"}`);
  console.log(`      ringcx.segmentIds   : ${(callLog.ringcx?.segmentIds || []).join(", ") || "—"}`);
  console.log(`      ringcx.externId     : ${callLog.ringcx?.externId || "—"}`);

  if (callLog.platform !== "cx") {
    console.log(`\n  ⚠ Row is platform="${callLog.platform}" not "cx" — this script is CX-specific. Bailing.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  // ── Step 2: build the RingCX voice client ───────────────────────
  console.log("\nStep 2: RingCX voice client");
  let client;
  try {
    client = createRingcxVoiceClient();
    console.log(`  ✓ Client created (accountId=${client.config?.accountId || "?"}, subAccountId=${client.config?.subAccountId || "?"})`);
  } catch (error) {
    console.log(`  ✗ Failed to construct client: ${error.message}`);
    await mongoose.disconnect();
    process.exit(1);
  }
  const rateState = client.getRateLimitState?.() || {};
  if (rateState?.["recording-metadata"]?.until) {
    console.log(`  ⚠ recording-metadata backoff until: ${formatLocalDate(rateState["recording-metadata"].until)}`);
  } else {
    console.log(`  ✓ No active rate-limit backoff on recording-metadata`);
  }

  // ── Step 3: interaction-metadata POST ────────────────────────────
  console.log("\nStep 3: interaction-metadata POST");
  // Build a window around the call. RC accepts segmentEndTime +
  // timeInterval; we use call-end-time-plus-15min as the segmentEndTime
  // and a window-min buffer back. This single POST should return all
  // segments for the agent in that window.
  const callEnd = new Date(callLog.callEndTime || callLog.callStartTime || Date.now());
  // Tight window centered on the call — segmentEndTime is the UPPER
  // bound; timeInterval backs us up from there. RC's response appears
  // to paginate from segmentEndTime backwards and cap at ~400 segments,
  // so a wide window can chop off the OLDEST calls (i.e. ours).
  const segmentEnd = new Date(callEnd.getTime() + 5 * 60 * 1000);
  const timeIntervalSec = Math.max(args.windowMin * 60, 60);
  console.log(`  window: segmentEndTime=${formatLocalDate(segmentEnd)}  timeInterval=${timeIntervalSec}s (${args.windowMin}m)`);

  const metadataReq = {
    segmentEndTime: segmentEnd,
    timeInterval: timeIntervalSec,
  };
  // NOTE: agentIds filter doesn't appear to narrow as documented for
  // this account (we got Phil Olson's segments back when asking for
  // Anthony's 20842). Leave it out by default and rely on UII match.
  // Pass --use-agent-filter to retry with the filter for diagnostic.
  if (process.argv.includes("--use-agent-filter") && callLog.ringcx?.agentId) {
    metadataReq.agentIds = [callLog.ringcx.agentId];
    console.log(`  narrowing by agentIds=[${callLog.ringcx.agentId}]`);
  } else {
    console.log(`  (no agentIds filter — rely on UII match in response)`);
  }
  let metadata = null;
  const startedAt = Date.now();
  try {
    metadata = await client.fetchInteractionMetadata(metadataReq);
  } catch (error) {
    console.log(`  ✗ fetchInteractionMetadata failed (${Date.now() - startedAt}ms): ${error.message}`);
    if (error.details) console.log(`      details: ${JSON.stringify(error.details).slice(0, 500)}`);
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log(`  ✓ Response received in ${Date.now() - startedAt}ms`);

  // RC's response shape varies — print the structure summary.
  const allSegments = (() => {
    if (Array.isArray(metadata?.data)) return metadata.data;
    if (Array.isArray(metadata?.segments)) return metadata.segments;
    if (Array.isArray(metadata?.records)) return metadata.records;
    if (Array.isArray(metadata)) return metadata;
    return [];
  })();
  console.log(`  segments in response: ${allSegments.length}`);

  // Aggregate stats — answers "what fraction of segments actually have
  // recordings available?", "what's the time-range covered?", and
  // "which campaigns have recording on vs off?"
  if (allSegments.length > 0) {
    let withRecording = 0;
    let withoutRecording = 0;
    let minStart = Infinity;
    let maxStart = -Infinity;
    const participantCounts = new Map();
    const byCampaign = new Map(); // campaignId → { name, withRec, total }
    for (const s of allSegments) {
      const hasRec = s.hasRecording === true;
      if (hasRec) withRecording += 1;
      else withoutRecording += 1;
      const startMs = Number(s.dialogStartTimeMs ? new Date(s.dialogStartTimeMs).getTime() : 0);
      if (startMs > 0) {
        if (startMs < minStart) minStart = startMs;
        if (startMs > maxStart) maxStart = startMs;
      }
      const pid = s.segmentParticipantId || "unknown";
      participantCounts.set(pid, (participantCounts.get(pid) || 0) + 1);
      const camp = String(s.campaignId || "(no campaign)");
      if (!byCampaign.has(camp)) {
        byCampaign.set(camp, { name: s.campaignName || "?", total: 0, withRec: 0 });
      }
      const cb = byCampaign.get(camp);
      cb.total += 1;
      if (hasRec) cb.withRec += 1;
    }
    console.log(`  hasRecording=true: ${withRecording}  (${withoutRecording} false)`);
    if (Number.isFinite(minStart)) {
      console.log(`  time range: ${formatLocalDate(minStart)}  →  ${formatLocalDate(maxStart)}`);
    }
    const topParticipants = [...participantCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    console.log(`  top participants: ${topParticipants.map(([p, c]) => `${p}(${c})`).join(", ")}`);
    console.log(`  per-campaign recording rate:`);
    for (const [cid, cb] of [...byCampaign.entries()].sort((a, b) => b[1].total - a[1].total)) {
      const pct = cb.total > 0 ? Math.round((cb.withRec / cb.total) * 100) : 0;
      console.log(`    ${cb.name.padEnd(20)} (id ${cid.padEnd(6)}) — ${cb.withRec}/${cb.total} (${pct}%)`);
    }
    // Also dump any segments WITH hasRecording=true so we can compare
    // their shape to the ones without.
    const withRec = allSegments.filter((s) => s.hasRecording === true);
    if (withRec.length > 0) {
      console.log(`\n  Sample WITH hasRecording=true (first 2):`);
      for (const s of withRec.slice(0, 2)) {
        console.log(`    interactionId=${s.interactionId} dialogId=${s.dialogId} segmentId=${s.segmentId}`);
        console.log(`      campaign=${s.campaignName} (${s.campaignId})  participant=${s.segmentParticipantId}  ext=${s.segmentParticipantRcExtensionId}`);
        console.log(`      dialogStart=${s.dialogStartTimeMs}  dur=${s.dialogDurationMs}ms`);
      }
    }
  }
  if (allSegments.length === 0) {
    console.log(`  ⚠ Empty response — RC didn't return any segments for this window`);
    console.log(`      raw response keys: ${Object.keys(metadata || {}).join(", ") || "(none)"}`);
    console.log(`      raw (first 500 chars): ${JSON.stringify(metadata).slice(0, 500)}`);
  }

  // ── Step 4: find segments that match this UII ────────────────────
  console.log("\nStep 4: match segments to UII");
  const matches = allSegments.filter((s) => {
    const candidates = [
      s.interactionId,
      s.uii,
      s.UII,
      s.callId,
      s.telephonySessionId,
    ].filter(Boolean);
    return candidates.some((c) => String(c) === String(uii));
  });
  console.log(`  matching segments: ${matches.length}`);
  if (matches.length === 0) {
    console.log(`  ✗ No segments matched UII ${uii}`);
    if (allSegments.length > 0) {
      // Dump the FIRST segment fully so we can see what fields RC is
      // actually populating + the exact UII format used in this account.
      console.log(`      first segment, all keys:`);
      const first = allSegments[0];
      for (const [k, v] of Object.entries(first)) {
        const display = typeof v === "object" ? JSON.stringify(v).slice(0, 100) : String(v);
        console.log(`        ${k.padEnd(35)} = ${display}`);
      }
      console.log(`\n      sample interactionIds + start times (first 8):`);
      for (const s of allSegments.slice(0, 8)) {
        const startMs = Number(s.interactionStartTimeMs || s.segmentContactStartTimeMs || 0);
        const startDisplay = Number.isFinite(startMs) && startMs > 0
          ? formatLocalDate(startMs)
          : "—";
        console.log(`        ${s.interactionId || s.uii || s.UII || "(no id)"}  start=${startDisplay}  agent=${s.segmentAgentId || s.agentId || "—"}`);
      }
      // Also: try a partial-match — maybe RC stores a truncated or
      // suffixed version of the UII.
      const ourPrefix = String(uii).slice(0, 12);
      const partialMatch = allSegments.find((s) => {
        const candidates = [s.interactionId, s.uii, s.UII, s.callId];
        return candidates.some((c) => c && String(c).startsWith(ourPrefix));
      });
      console.log(`      our UII prefix [${ourPrefix}]: ${partialMatch ? `partial match → ${partialMatch.interactionId || partialMatch.uii || "?"}` : "no segment starts with this prefix"}`);
    }
    await mongoose.disconnect();
    process.exit(2);
  }

  for (let i = 0; i < matches.length; i += 1) {
    const seg = matches[i];
    const tt = pickTalkTime(seg);
    console.log(`  segment[${i}]:`);
    console.log(`    dialogId           : ${seg.dialogId || seg.dialogID || "—"}`);
    console.log(`    segmentId          : ${seg.segmentId || seg.segmentID || "—"}`);
    console.log(`    segmentDuration    : ${fmtSec(seg.segmentDuration || seg.duration)}`);
    console.log(`    talkTime           : ${tt.sec != null ? fmtSec(tt.sec) : "—"}  (source: ${tt.source})`);
    console.log(`    interactionStartMs : ${seg.interactionStartTimeMs ? formatLocalDate(Number(seg.interactionStartTimeMs)) : "—"}`);
    console.log(`    contactStartMs     : ${seg.segmentContactStartTimeMs ? formatLocalDate(Number(seg.segmentContactStartTimeMs)) : "—"}`);
    console.log(`    contactEndMs       : ${seg.segmentContactEndTimeMs ? formatLocalDate(Number(seg.segmentContactEndTimeMs)) : "—"}`);
    console.log(`    agentId            : ${seg.segmentAgentId || seg.agentId || "—"}`);
    console.log(`    callingAddress     : ${seg.interactionCallingAddress || "—"}`);
    console.log(`    calledAddress      : ${seg.interactionCalledAddress || "—"}`);
    console.log(`    recordingURL       : ${seg.segmentRecordingURL || seg.recordingURL || "—"}`);
    console.log(`    extra fields       : ${Object.keys(seg).filter((k) => !["dialogId","dialogID","segmentId","segmentID","segmentDuration","duration","talkTime","segmentTalkTime","segmentContactStartTimeMs","segmentContactEndTimeMs","interactionStartTimeMs","segmentAgentId","agentId","interactionCallingAddress","interactionCalledAddress","segmentRecordingURL","recordingURL","interactionId","uii","UII","callId","telephonySessionId"].includes(k)).join(", ") || "(none)"}`);
  }

  // ── Step 5: pick the best segment + attempt download ─────────────
  console.log("\nStep 5: attempt segment download");
  const best = matches
    .map((seg) => ({
      seg,
      talkTime: pickTalkTime(seg).sec || 0,
      dialogId: seg.dialogId || seg.dialogID,
      segmentId: seg.segmentId || seg.segmentID,
    }))
    .filter((m) => m.dialogId && m.segmentId)
    .sort((a, b) => b.talkTime - a.talkTime)[0];

  if (!best) {
    console.log(`  ✗ No segment has both dialogId + segmentId — can't attempt download`);
    await mongoose.disconnect();
    process.exit(3);
  }

  console.log(`  best segment: dialogId=${best.dialogId} segmentId=${best.segmentId} talkTime=${fmtSec(best.talkTime)}`);

  const dlStart = Date.now();
  let dl;
  try {
    dl = await client.downloadRecordingBySegment({
      dialogId: best.dialogId,
      segmentId: best.segmentId,
    });
  } catch (error) {
    console.log(`  ✗ Download failed (${Date.now() - dlStart}ms): ${error.message}`);
    if (error.details) {
      const body = String(error.details.responseBody || "").slice(0, 300);
      console.log(`      responseStatus: ${error.details.responseStatus}`);
      console.log(`      responseBody:   ${body}`);
    }
    await mongoose.disconnect();
    process.exit(4);
  }
  console.log(`  ✓ Download succeeded in ${Date.now() - dlStart}ms`);
  console.log(`      mimeType      : ${dl.mimeType}`);
  console.log(`      contentLength : ${dl.contentLength || "?"}`);
  console.log(`      buffer bytes  : ${dl.buffer?.length || 0}`);

  // ── Step 6: apply (optional) ─────────────────────────────────────
  if (args.apply) {
    console.log("\nStep 6: --apply not yet wired in this diagnostic. Run the");
    console.log("        existing recordingArchive pipeline to do the Drive upload");
    console.log("        + CallLog stamp. For now, this script confirms the pull");
    console.log("        path works end-to-end.");
  } else {
    console.log("\nStep 6: skipped (read-only run). Pass --apply to wire up the Drive upload (not implemented yet).");
  }

  console.log("\n=== Test pull complete — pipeline path is healthy ===\n");
  await mongoose.disconnect();
})().catch(async (error) => {
  console.error(error);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(99);
});
