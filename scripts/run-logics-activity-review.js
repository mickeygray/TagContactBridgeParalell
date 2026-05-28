"use strict";

const {
  runLogicsActivityReview,
  yesterdayInTz,
} = require("../packages/shared-services/src/logicsActivityReviewService");

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

function parseOptions(argv) {
  const timezone = readFlag(
    argv,
    "--timezone",
    process.env.LOGICS_ACTIVITY_REVIEW_TIMEZONE || "America/Los_Angeles",
  );
  const date = readFlag(argv, "--date", "");
  const startDate = readFlag(argv, "--start-date", date || yesterdayInTz(timezone));
  const endDate = readFlag(argv, "--end-date", date || startDate);
  return {
    domain: String(
      readFlag(argv, "--domain", process.env.LOGICS_ACTIVITY_REVIEW_DOMAIN || "TAG"),
    ).toUpperCase(),
    dateKey: date || endDate,
    startDateKey: startDate,
    endDateKey: endDate,
    timezone,
    concurrency: Number(
      readFlag(argv, "--concurrency", process.env.LOGICS_ACTIVITY_REVIEW_CONCURRENCY || "3"),
    ) || 3,
    recipients: readFlag(
      argv,
      "--recipients",
      process.env.LOGICS_ACTIVITY_REVIEW_RECIPIENTS ||
        "mgray@taxadvocategroup.com,manderson@taxadvocategroup.com",
    ),
    reportEmail: readFlag(
      argv,
      "--report-email",
      process.env.LOGICS_ACTIVITY_REVIEW_REPORT_EMAIL || "documents@taxadvocategroup.com",
    ),
    outDir: readFlag(argv, "--out-dir", process.env.LOGICS_ACTIVITY_REVIEW_OUTPUT_DIR || ""),
    sendEmail: !hasFlag(argv, "--no-email"),
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const result = await runLogicsActivityReview(options);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    ok: true,
    domain: result.domain,
    startDate: result.startDate,
    endDate: result.endDate,
    activityRows: result.processed?.parsedRows || 0,
    rawDocumentUploads: result.processed?.documentUploadActivities || 0,
    excludedUploads: result.processed?.excludedActivities || 0,
    noticeRows: result.processed?.rowLevelOutputRows || 0,
    noticeCases: result.processed?.outputRows || 0,
    suspendedStatusChanges: result.processed?.suspendedStatusChanges || 0,
    suspendedCurrentStatusChanges: result.processed?.suspendedCurrentStatusChanges || 0,
    suspendedStaleStatusChanges: result.processed?.suspendedStaleStatusChanges || 0,
    suspendedCases: result.processed?.suspendedOutputRows || 0,
    csvOut: result.processed?.csvOut || null,
    suspendedCsvOut: result.processed?.suspendedCsvOut || null,
    jsonOut: result.processed?.jsonOut || null,
    email: result.email || null,
  }, null, 2));
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
});
