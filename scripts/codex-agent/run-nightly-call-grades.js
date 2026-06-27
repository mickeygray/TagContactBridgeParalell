"use strict";

// Nightly Codex call-grade runner.
//
// Default mode is a Mongo dry-run: list grade candidates, build stable packets,
// and write a small report. It does not call Codex and does not mutate rows.
//
// Examples:
//   node scripts/codex-agent/run-nightly-call-grades.js --date 2026-06-26
//   node scripts/codex-agent/run-nightly-call-grades.js --date 2026-06-26 --codex --limit 1
//   node scripts/codex-agent/run-nightly-call-grades.js --date 2026-06-26 --codex --apply --limit 5

const fs = require("fs");
const path = require("path");

const { connectMongo, disconnectMongo } = require("../../packages/event-core/src");
const { getSharedConfig } = require("../../packages/shared-config/src");
const callNoteRepository = require("../../packages/shared-repositories/src/cxAgentCallNoteRepository");
const {
  applyCallGradeResult,
  buildCallGradePrompt,
  buildCallGradeTaskPacket,
  buildNightlyCallGradeReport,
  hasEnoughGradeEvidence,
  markCallGradeFailure,
  normalizeCallGradeResult,
} = require("../../packages/shared-services/src/cxNightlyCallGradeService");
const { createCodexMcpClient } = require("./codexMcpClient");

const DEFAULT_TIMEZONE = "America/Los_Angeles";
const DEFAULT_LIMIT = 5;
const DEFAULT_MIN_DURATION_SEC = 120;
const DEFAULT_OUT_DIR = path.resolve(__dirname, "..", "..", "runtime", "codex-agent", "nightly-call-grades");

function readArg(argv, name, fallback = "") {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  if (index >= 0 && index < argv.length - 1) return argv[index + 1];
  return fallback;
}

function hasArg(argv, name) {
  return argv.includes(name);
}

function cleanInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function cleanDateKey(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function dateKeyInTimeZone(now = new Date(), timezone = DEFAULT_TIMEZONE) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(now).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getTimeZoneOffsetMs(date, timezone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - date.getTime();
}

function zonedWallClockToUtc(dateKey, hour, minute, timezone) {
  const [year, month, day] = dateKey.split("-").map((part) => Number(part));
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
  const firstOffset = getTimeZoneOffsetMs(utcGuess, timezone);
  let result = new Date(utcGuess.getTime() - firstOffset);
  const secondOffset = getTimeZoneOffsetMs(result, timezone);
  if (secondOffset !== firstOffset) {
    result = new Date(utcGuess.getTime() - secondOffset);
  }
  return result;
}

function addDays(dateKey, days) {
  const [year, month, day] = dateKey.split("-").map((part) => Number(part));
  const date = new Date(Date.UTC(year, month - 1, day + days, 0, 0, 0, 0));
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function dateRangeForDateKey(dateKey, timezone) {
  return {
    from: zonedWallClockToUtc(dateKey, 0, 0, timezone),
    to: zonedWallClockToUtc(addDays(dateKey, 1), 0, 0, timezone),
  };
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function safeJsonParse(text) {
  const value = String(text || "").trim();
  if (!value) throw new Error("empty Codex response");
  try {
    return JSON.parse(value);
  } catch {
    const first = value.indexOf("{");
    const last = value.lastIndexOf("}");
    if (first >= 0 && last > first) {
      return JSON.parse(value.slice(first, last + 1));
    }
    throw new Error("Codex response did not contain JSON object");
  }
}

function parseOptions(argv) {
  const timezone = readArg(argv, "--timezone", process.env.CODEX_NIGHTLY_CALL_GRADE_TIMEZONE || DEFAULT_TIMEZONE);
  const dateKey = cleanDateKey(readArg(argv, "--date", "")) || dateKeyInTimeZone(new Date(), timezone);
  const range = dateRangeForDateKey(dateKey, timezone);
  const from = readArg(argv, "--from", "") ? new Date(readArg(argv, "--from")) : range.from;
  const to = readArg(argv, "--to", "") ? new Date(readArg(argv, "--to")) : range.to;
  const limit = cleanInt(
    readArg(argv, "--limit", process.env.CODEX_NIGHTLY_CALL_GRADE_LIMIT || String(DEFAULT_LIMIT)),
    DEFAULT_LIMIT,
  );
  return {
    help: hasArg(argv, "--help") || hasArg(argv, "-h"),
    dateKey,
    timezone,
    from,
    to,
    agentEmail: readArg(argv, "--agent-email", process.env.CODEX_NIGHTLY_CALL_GRADE_AGENT_EMAIL || ""),
    limit: Math.max(1, Math.min(limit, 200)),
    minDurationSec: Math.max(0, cleanInt(
      readArg(argv, "--min-duration-sec", process.env.CODEX_NIGHTLY_CALL_GRADE_MIN_DURATION_SEC || String(DEFAULT_MIN_DURATION_SEC)),
      DEFAULT_MIN_DURATION_SEC,
    )),
    outDir: readArg(argv, "--out-dir", process.env.CODEX_NIGHTLY_CALL_GRADE_OUT_DIR || DEFAULT_OUT_DIR),
    codex: hasArg(argv, "--codex") || String(process.env.CODEX_NIGHTLY_CALL_GRADE_CODEX || "").toLowerCase() === "true",
    apply: hasArg(argv, "--apply") || String(process.env.CODEX_NIGHTLY_CALL_GRADE_APPLY || "").toLowerCase() === "true",
    writePackets: hasArg(argv, "--write-packets"),
    timeoutMs: Math.max(30000, cleanInt(
      readArg(argv, "--timeout-ms", process.env.CODEX_NIGHTLY_CALL_GRADE_TIMEOUT_MS || "180000"),
      180000,
    )),
    model: readArg(argv, "--model", process.env.CODEX_NIGHTLY_CALL_GRADE_MODEL || process.env.CODEX_AGENT_MODEL || ""),
  };
}

function printHelp() {
  // eslint-disable-next-line no-console
  console.log([
    "Nightly Codex call-grade runner",
    "",
    "Dry-run candidate report:",
    "  node scripts/codex-agent/run-nightly-call-grades.js --date 2026-06-26",
    "",
    "One Codex call, no writes:",
    "  node scripts/codex-agent/run-nightly-call-grades.js --date 2026-06-26 --codex --limit 1",
    "",
    "Apply validated grades:",
    "  node scripts/codex-agent/run-nightly-call-grades.js --date 2026-06-26 --codex --apply --limit 5",
    "",
    "Recommended first schedule: 18:05 PT, capped, after the floor day and away from top-of-hour workers.",
  ].join("\n"));
}

function compactRow(note, packet, eligible) {
  return {
    noteKey: note.noteKey,
    eligible,
    idempotencyKey: packet.idempotencyKey,
    agentEmail: packet.call.agentEmail,
    domain: packet.call.domain,
    caseId: packet.call.caseId,
    uii: packet.call.uii,
    happenedAt: packet.call.happenedAt,
    durationSec: packet.call.durationSec,
    outcome: packet.call.outcome,
    evidenceChars: JSON.stringify(packet.evidence || {}).length,
  };
}

async function runCodexGrade(client, packet, options) {
  const prompt = buildCallGradePrompt(packet);
  const response = await client.ask(prompt.prompt, {
    baseInstructions: prompt.system,
    model: options.model || undefined,
    timeoutMs: options.timeoutMs,
    sandbox: "read-only",
    approvalPolicy: "never",
    cwd: path.resolve(__dirname, "..", ".."),
  });
  const parsed = safeJsonParse(response.text);
  return {
    grade: normalizeCallGradeResult(parsed),
    threadId: response.threadId || null,
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  fs.mkdirSync(options.outDir, { recursive: true });
  const outputPath = path.join(options.outDir, `nightly-call-grades-${options.dateKey}-${stamp()}.json`);
  const packetPath = path.join(options.outDir, `nightly-call-grade-packets-${options.dateKey}-${stamp()}.jsonl`);

  await connectMongo(getSharedConfig());
  let client = null;
  const results = [];
  try {
    const notes = await callNoteRepository.listNightlyGradeCandidates({
      from: options.from,
      to: options.to,
      agentEmail: options.agentEmail || null,
      minDurationSec: options.minDurationSec,
      limit: options.limit,
    });
    const report = buildNightlyCallGradeReport(notes, options);
    const packets = [];

    for (const note of notes) {
      const packet = buildCallGradeTaskPacket(note, options);
      const eligible = hasEnoughGradeEvidence(note, options);
      packets.push({ note, packet, eligible });
      results.push({
        ...compactRow(note, packet, eligible),
        status: eligible ? "ready" : "skipped",
        reason: eligible ? null : "insufficient-evidence",
      });
    }

    if (options.writePackets) {
      fs.writeFileSync(
        packetPath,
        packets.map((row) => JSON.stringify(row.packet)).join("\n") + (packets.length ? "\n" : ""),
      );
    }

    if (options.codex) {
      client = createCodexMcpClient({
        model: options.model || undefined,
        timeoutMs: options.timeoutMs,
      });
      await client.start();

      for (let index = 0; index < packets.length; index += 1) {
        const { note, packet, eligible } = packets[index];
        if (!eligible) continue;
        const row = results[index];
        row.status = options.apply ? "grading" : "grading-dry-run";
        const startedAt = Date.now();
        try {
          const graded = await runCodexGrade(client, packet, options);
          row.status = options.apply ? "graded" : "graded-dry-run";
          row.elapsedMs = Date.now() - startedAt;
          row.threadId = graded.threadId;
          row.overallScore = graded.grade.overallScore;
          row.verdict = graded.grade.verdict;
          if (options.apply) {
            await applyCallGradeResult(note.noteKey, graded.grade, callNoteRepository);
          }
        } catch (error) {
          row.status = options.apply ? "failed" : "failed-dry-run";
          row.elapsedMs = Date.now() - startedAt;
          row.error = error.message;
          if (options.apply) {
            await markCallGradeFailure(note.noteKey, error, callNoteRepository);
          }
        }
      }
    }

    const output = {
      ok: true,
      generatedAt: new Date().toISOString(),
      taskId: "liveCoach.callGrader",
      mode: {
        codex: options.codex,
        apply: options.apply,
        writePackets: options.writePackets,
      },
      window: {
        dateKey: options.dateKey,
        timezone: options.timezone,
        from: options.from.toISOString(),
        to: options.to.toISOString(),
      },
      limits: {
        limit: options.limit,
        minDurationSec: options.minDurationSec,
        agentEmail: options.agentEmail || null,
      },
      counts: {
        candidates: notes.length,
        eligible: report.eligibleCount,
        graded: results.filter((row) => row.status === "graded").length,
        dryRunGrades: results.filter((row) => row.status === "graded-dry-run").length,
        failed: results.filter((row) => row.status === "failed").length,
      },
      report,
      results,
      outputPath,
      packetPath: options.writePackets ? packetPath : null,
    };

    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      ok: true,
      outputPath,
      packetPath: options.writePackets ? packetPath : null,
      counts: output.counts,
      window: output.window,
      mode: output.mode,
    }, null, 2));
  } finally {
    if (client) client.stop();
    await disconnectMongo().catch(() => null);
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
