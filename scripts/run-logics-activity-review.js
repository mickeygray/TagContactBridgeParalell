"use strict";

const {
  runLogicsActivityReview,
  runLogicsActivityReviewBatch,
  yesterdayInTz,
} = require("../packages/shared-services/src/logicsActivityReviewService");
const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
const { getSharedConfig } = require("../packages/shared-config/src");

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

function parseList(value) {
  if (Array.isArray(value)) return value;
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
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
  const domain = String(
    readFlag(argv, "--domain", process.env.LOGICS_ACTIVITY_REVIEW_DOMAIN || "TAG"),
  ).toUpperCase();
  const domainsRaw = readFlag(argv, "--domains", process.env.LOGICS_ACTIVITY_REVIEW_DOMAINS || "");
  const includeAiReview = hasFlag(argv, "--ai-review")
    ? true
    : hasFlag(argv, "--no-ai-review")
      ? false
      : parseBoolean(process.env.LOGICS_ACTIVITY_REVIEW_AI_ENABLED, false);
  return {
    domain,
    domains: domainsRaw
      ? parseList(domainsRaw).map((value) => String(value).toUpperCase())
      : [domain],
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
      process.env.LOGICS_ACTIVITY_REVIEW_REPORT_EMAIL || "mgray@taxadvocategroup.com",
    ),
    attachCsv: parseBoolean(process.env.LOGICS_ACTIVITY_REVIEW_ATTACH_CSV, false) || hasFlag(argv, "--attach-csv"),
    outDir: readFlag(argv, "--out-dir", process.env.LOGICS_ACTIVITY_REVIEW_OUTPUT_DIR || ""),
    sendEmail: !hasFlag(argv, "--no-email"),
    includeAiReview,
    aiReviewMaxCases: Number(
      readFlag(argv, "--ai-max-cases", process.env.LOGICS_ACTIVITY_REVIEW_AI_MAX_CASES || "75"),
    ) || 75,
    aiReviewConcurrency: Number(
      readFlag(argv, "--ai-concurrency", process.env.LOGICS_ACTIVITY_REVIEW_AI_CONCURRENCY || "1"),
    ) || 1,
    aiReviewModel: readFlag(argv, "--ai-model", process.env.LOGICS_ACTIVITY_REVIEW_AI_MODEL || ""),
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  let mongoConnected = false;
  if (options.includeAiReview) {
    const mongoState = await connectMongo(getSharedConfig());
    mongoConnected = Boolean(mongoState.connected);
    if (!mongoConnected) {
      throw new Error("Mongo is required for --ai-review because activity AI reviews are persisted");
    }
  }

  let result;
  try {
    result = options.domains.length > 1
      ? await runLogicsActivityReviewBatch(options)
      : await runLogicsActivityReview(options);
  } finally {
    if (mongoConnected) {
      await disconnectMongo();
    }
  }
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    ok: true,
    domain: result.domain || null,
    domains: result.domains || [result.domain],
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
    aiReview: result.processed?.aiReview || null,
    suspendedAiReview: result.processed?.suspendedAiReview || null,
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
