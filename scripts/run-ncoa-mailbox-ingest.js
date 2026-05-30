"use strict";

const path = require("path");
const dotenv = require("dotenv");

const ENV_PATH = path.resolve(__dirname, "..", ".env");
dotenv.config({ path: ENV_PATH });

const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
const { getSharedConfig } = require("../packages/shared-config/src");
const {
  runNcoaMailboxIngest,
  runNcoaMailboxIngestIfDue,
} = require("../packages/shared-services/src");

function readFlag(argv, name, fallback = "") {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1) return argv[idx + 1];
  return fallback;
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function printHelp() {
  console.log(`NCOA mailbox ingest

Usage:
  node scripts/run-ncoa-mailbox-ingest.js --once
  node scripts/run-ncoa-mailbox-ingest.js --loop --interval-ms 300000

Options:
  --once              Run one mailbox sweep and exit
  --loop              Keep sweeping until stopped
  --interval-ms N     Loop interval, default 300000
  --force             Bypass enabled/weekdays/already-ran guard
  --until-iso ISO     Stop loop at this absolute ISO timestamp
  --dry-run           Download/parse only; do not upload to Logics or mark mail read
  --skip-email        Do not send completion email
  --query Q           Override Gmail search query for this run
  --max-messages N    Override message scan limit
`);
}

async function runOnce(argv) {
  // Long-running local watcher: pick up credentials/config the user adds
  // to .env after the process starts, without needing a manual restart.
  dotenv.config({ path: ENV_PATH, override: true });
  const query = readFlag(argv, "--query", "");
  const maxMessages = Number(readFlag(argv, "--max-messages", "")) || undefined;
  const runner = hasFlag(argv, "--force") ? runNcoaMailboxIngest : runNcoaMailboxIngestIfDue;
  const summary = await runner({
    dryRun: hasFlag(argv, "--dry-run"),
    skipEmail: hasFlag(argv, "--skip-email"),
    ...(query ? { gmailQuery: query } : {}),
    ...(maxMessages ? { maxMessages } : {}),
  });
  console.log(JSON.stringify({
    domain: summary.domain,
    dryRun: summary.dryRun,
    skipped: summary.skipped,
    reason: summary.reason,
    messagesScanned: summary.messagesScanned,
    attachments: (summary.attachments || []).map((item) => ({
      filename: item.filename,
      total: item.total,
      succeeded: item.succeeded,
      failed: item.failed,
      skipped: item.skipped,
      skipReason: item.skipReason,
      error: item.error,
      dryRun: item.dryRun,
    })),
    runDir: summary.runDir,
    emailMessageId: summary.email?.messageId || null,
  }, null, 2));
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
    printHelp();
    return;
  }

  await connectMongo(getSharedConfig());
  try {
    if (hasFlag(argv, "--loop")) {
      const intervalMs = Math.max(Number(readFlag(argv, "--interval-ms", "300000")) || 300000, 60000);
      const untilIso = readFlag(argv, "--until-iso", "");
      const untilMs = untilIso ? Date.parse(untilIso) : 0;
      for (;;) {
        if (Number.isFinite(untilMs) && untilMs > 0 && Date.now() >= untilMs) {
          console.log(JSON.stringify({
            ok: true,
            at: new Date().toISOString(),
            stopped: true,
            reason: "until-iso-reached",
            untilIso,
          }));
          break;
        }
        try {
          await runOnce(argv);
        } catch (error) {
          console.error(JSON.stringify({
            ok: false,
            at: new Date().toISOString(),
            error: error.stack || error.message,
          }));
        }
        const remainingMs = Number.isFinite(untilMs) && untilMs > 0
          ? Math.max(untilMs - Date.now(), 0)
          : intervalMs;
        await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remainingMs || intervalMs)));
      }
      return;
    }
    await runOnce(argv);
  } finally {
    await disconnectMongo().catch(() => null);
  }
}

main().catch(async (error) => {
  console.error(`fatal: ${error.stack || error.message}`);
  await disconnectMongo().catch(() => null);
  process.exit(1);
});
