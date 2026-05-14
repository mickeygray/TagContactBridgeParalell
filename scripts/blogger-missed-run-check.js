"use strict";

// Missed-run detector. Fires shortly AFTER the daily runner's
// scheduled time. Compares blogger-state.json's `lastRunDate` to
// today's PT date — if the runner didn't fire (or didn't update
// state), email an alert. Cron silence is the failure mode this
// catches: the daily task being disabled, the box being asleep at
// 8 AM, no one being logged in, etc.
//
// Schedule via:
//   schtasks /Create /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 09:30 \
//     /TN WynnTAGBloggerHealth \
//     /TR "node <repo>\\scripts\\blogger-missed-run-check.js"

const fs = require("fs");
const path = require("path");

require("dotenv").config({
  path: path.resolve(__dirname, "..", ".env"),
  override: true,
});

const STATE_FILE = path.resolve(__dirname, "blogger-state.json");
const DAILY_RUNNER = path.resolve(__dirname, "blogger-daily-runner.js");

function todayDateKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
  }).format(new Date());
}

function isWeekend(dateKey) {
  const [y, m, d] = String(dateKey).split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
  return dow === 0 || dow === 6;
}

async function main() {
  const today = todayDateKey();
  if (isWeekend(today)) {
    console.log(`[health-check] ${today} is weekend, skipping`);
    return;
  }

  let state = null;
  if (fs.existsSync(STATE_FILE)) {
    try {
      state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    } catch {
      state = null;
    }
  }

  const lastRunDate = state && state.lastRunDate;
  if (lastRunDate === today) {
    console.log(`[health-check] ${today}: blogger ran (lastPostedId=${state.lastPostedId || "none"})`);
    return;
  }

  // Bot didn't run today. Send alarm.
  const reason = lastRunDate
    ? `Last run was ${lastRunDate} — today is ${today}`
    : `No state file or no recorded runs ever`;
  console.error(`[health-check] MISSED: ${reason}`);

  // Use the same SendGrid wiring the runner uses.
  try {
    const { sendPlainEmail } = require(
      "../packages/shared-services/src/sendgridMailService",
    );
    await sendPlainEmail("TAG", {
      personalizations: [
        {
          to: [{ email: "mgray@taxadvocategroup.com" }],
          custom_args: { channel: "blogger-health", today },
        },
      ],
      from: { email: "mgray@taxadvocategroup.com", name: "Blogger Health Check" },
      reply_to: { email: "mgray@taxadvocategroup.com", name: "Blogger Health Check" },
      subject: `[BLOGGER ALERT] Daily run missed — ${today}`,
      content: [
        {
          type: "text/plain",
          value: [
            `The daily blogger did NOT run for ${today}.`,
            "",
            reason,
            "",
            "Likely causes:",
            "  - Scheduled task disabled (run `schtasks /Query /TN WynnTAGBlogger` to verify)",
            "  - Machine was asleep / locked at 8 AM PT",
            "  - User not logged in (task is configured Interactive only)",
            "  - Sonnet API outage or other transient error caused the runner to crash before writing state",
            "",
            "To run manually right now:",
            `  node ${DAILY_RUNNER}`,
            "",
            "To check task status:",
            "  schtasks /Query /TN WynnTAGBlogger /V /FO LIST",
          ].join("\n"),
        },
      ],
    });
    console.log("[health-check] alert email sent");
  } catch (err) {
    console.error("[health-check] failed to send alert email:", err.message);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
