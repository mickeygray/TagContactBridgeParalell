"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const {
  openMailbox,
  collectAttachmentParts,
  readAttachmentBuffer,
  listMessageRefs,
} = require("./mailboxIngestService");
const { WorkflowRecord } = require("../../shared-models/src");
const { getInternalFromEmail, getSharedConfig } = require("../../shared-config/src");
const { recordWorkflowStage } = require("./workflowStateService");
const { parseNcoaCsv, uploadNcoaRows } = require("./ncoaUploadService");
const { sendMail } = require("./mailerService");

const DEFAULT_TIMEZONE = "America/Los_Angeles";

function cleanText(value, max = 500) {
  return String(value || "").trim().slice(0, max);
}

function normalizeDomain(value) {
  return String(value || "TAG").trim().toUpperCase() || "TAG";
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function safeFileName(value = "attachment.csv") {
  const base = path.basename(String(value || "attachment.csv"));
  return base.replace(/[^a-z0-9._ -]/gi, "_").slice(0, 160) || "attachment.csv";
}

function extensionAllowed(filename, acceptedExtensions = []) {
  const lower = String(filename || "").toLowerCase();
  const list = acceptedExtensions.length ? acceptedExtensions : [".csv", ".txt"];
  return list.some((extension) => lower.endsWith(String(extension || "").toLowerCase()));
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function formatDateKey(date = new Date(), timeZone = DEFAULT_TIMEZONE) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function getWeekday(date = new Date(), timeZone = DEFAULT_TIMEZONE) {
  const raw = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).format(date);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(raw);
}

function messageHeader(message = {}, name) {
  const headers = Array.isArray(message.payload?.headers) ? message.payload.headers : [];
  const hit = headers.find((header) => String(header?.name || "").toLowerCase() === String(name || "").toLowerCase());
  return cleanText(hit?.value || "", 1000);
}



// collectAttachmentParts / readAttachmentBuffer / listMessageRefs used to live
// here. They are now in mailboxIngestService so this loop and the mail-invoice
// reader share ONE Gmail path — Mickey 2026-07-31: "turn the open gmail into an
// agnostic service that is called in both functions."
const listMailboxMessageRefs = (gmail, config = {}) => listMessageRefs(gmail, {
  gmailQuery: config.gmailQuery,
  maxMessages: config.maxMessages,
  maxPages: config.maxMessagePages || config.maxPages,
});

async function alreadyProcessed(dedupeKey) {
  if (!dedupeKey) return false;
  const existing = await WorkflowRecord.findOne({
    dedupeKey,
    family: "lexis",
    subtype: "ncoa-mailbox-attachment",
    stage: "completed",
  }).lean();
  return Boolean(existing);
}

async function hasCompletedMailboxRun({ domain, dateKey }) {
  const hit = await WorkflowRecord.findOne({
    domain: normalizeDomain(domain),
    family: "lexis",
    subtype: "ncoa-mailbox-run",
    stage: "completed",
    "payload.dateKey": dateKey,
  }).lean();
  return Boolean(hit);
}

async function recordCompletedMailboxRun({
  domain,
  dateKey,
  files = [],
  query = "",
  result = {},
  summary = "",
  empty = false,
}) {
  const normalizedDomain = normalizeDomain(domain);
  const total = Number(result.total || 0) || 0;
  const succeeded = Number(result.succeeded || 0) || 0;
  const failed = Number(result.failed || 0) || 0;
  const attachments = Number(result.attachments || files.length || 0) || 0;
  return recordWorkflowStage({
    domain: normalizedDomain,
    family: "lexis",
    subtype: "ncoa-mailbox-run",
    stage: "completed",
    aggregateType: "ncoa-mailbox-run",
    aggregateId: `${normalizedDomain}:${dateKey}`,
    sourceService: "ncoa-mailbox-ingest",
    title: empty
      ? "NCOA mailbox daily ingest checked empty"
      : "NCOA mailbox daily ingest completed",
    summary: summary || (empty
      ? "No unread NCOA mailbox messages found"
      : `${attachments} attachment(s), ${succeeded}/${total} rows succeeded`),
    payload: {
      dateKey,
      files,
      query,
      empty: Boolean(empty),
    },
    result: {
      attachments,
      total,
      succeeded,
      failed,
    },
    dedupeKey: `ncoa-mailbox-run:${normalizedDomain}:${dateKey}`,
  }).catch((error) => {
    if (!/duplicate key/i.test(String(error?.message || ""))) throw error;
    return null;
  });
}

function buildConfig(overrides = {}) {
  const shared = getSharedConfig();
  return {
    ...(shared.ncoaMailbox || {}),
    ...(overrides || {}),
    gmail: {
      ...(shared.ncoaMailbox?.gmail || {}),
      ...(overrides.gmail || {}),
    },
  };
}

async function processAttachment({
  gmail,
  message,
  part,
  // Already downloaded, when the caller has it. The shared mailbox ingest loop
  // fetches every attachment on a message before handing them to a handler — so
  // a handler that let this refetch would pull the same bytes from Gmail twice
  // per file, for no gain and against the same quota.
  //
  // Left null the original behaviour is unchanged: fetch it here. That keeps the
  // standalone runner working exactly as before.
  buffer: providedBuffer = null,
  config,
  runDir,
  dryRun = false,
}) {
  const domain = normalizeDomain(config.domain);
  const filename = safeFileName(part.filename || "attachment.csv");
  const buffer = providedBuffer || await readAttachmentBuffer(gmail, message.id, part);
  if (!buffer || buffer.length === 0) {
    return {
      filename,
      skipped: true,
      skipReason: "empty-attachment",
    };
  }

  const contentHash = sha256(buffer);
  const dedupeKey = `ncoa-mailbox:${domain}:${contentHash}`;
  if (await alreadyProcessed(dedupeKey)) {
    return {
      filename,
      skipped: true,
      skipReason: "already-processed",
      contentHash,
    };
  }

  // PARSE FIRST, PERSIST AFTER THE GATE. This used to create the run
  // directory, write the attachment to disk and record a Mongo workflow row
  // BEFORE looking at dryRun — so a "read-only" preview left a file and a
  // database row behind on every attachment. The nightly pass made that a
  // standing cost: plan() runs every night whether or not the task is armed,
  // which meant a DARK task wrote evidence nightly. Parsing is in-memory and
  // stays above the gate; everything durable moves below it.
  const csvText = buffer.toString("utf8").replace(/^\uFEFF/, "");
  const rows = parseNcoaCsv(csvText);
  const importBatch = `mailbox-${path.parse(filename).name}-${contentHash.slice(0, 12)}`;
  const aggregateId = `${message.id}:${part.body?.attachmentId || contentHash.slice(0, 12)}`;
  const localPath = path.join(runDir, `${contentHash.slice(0, 12)}-${filename}`);

  if (dryRun) {
    return {
      filename,
      localPath,
      contentHash,
      importBatch,
      total: rows.length,
      dryRun: true,
    };
  }

  ensureDir(runDir);
  fs.writeFileSync(localPath, buffer);

  await recordWorkflowStage({
    domain,
    family: "lexis",
    subtype: "ncoa-mailbox-attachment",
    stage: "observed",
    aggregateType: "ncoa-mailbox-attachment",
    aggregateId,
    sourceService: "ncoa-mailbox-ingest",
    title: "NCOA mailbox attachment observed",
    summary: `${filename}: ${rows.length} parsed row(s)`,
    payload: {
      messageId: message.id,
      filename,
      localPath,
      contentHash,
      rows: rows.length,
      importBatch,
      from: messageHeader(message, "from"),
      subject: messageHeader(message, "subject"),
      date: messageHeader(message, "date"),
    },
  });

  let uploadResult = null;
  try {
    uploadResult = await uploadNcoaRows(rows, {
      domain,
      importBatch,
      sourceService: "ncoa-mailbox-ingest",
    });
  } catch (error) {
    await recordWorkflowStage({
      domain,
      family: "lexis",
      subtype: "ncoa-mailbox-attachment",
      stage: "failed",
      aggregateType: "ncoa-mailbox-attachment",
      aggregateId,
      sourceService: "ncoa-mailbox-ingest",
      status: "error",
      title: "NCOA mailbox upload failed",
      summary: `${filename}: ${error.message}`,
      payload: {
        messageId: message.id,
        filename,
        localPath,
        contentHash,
        importBatch,
      },
      result: {
        error: error.message,
      },
    });
    throw error;
  }

  await recordWorkflowStage({
    domain,
    family: "lexis",
    subtype: "ncoa-mailbox-attachment",
    stage: "completed",
    aggregateType: "ncoa-mailbox-attachment",
    aggregateId,
    sourceService: "ncoa-mailbox-ingest",
    title: "NCOA mailbox upload completed",
    summary: `${filename}: ${uploadResult.succeeded} succeeded, ${uploadResult.failed} failed, ${uploadResult.skipped} skipped`,
    payload: {
      messageId: message.id,
      filename,
      localPath,
      contentHash,
      importBatch,
    },
    result: {
      total: uploadResult.total,
      succeeded: uploadResult.succeeded,
      failed: uploadResult.failed,
      skipped: uploadResult.skipped,
    },
    dedupeKey,
  });

  return {
    filename,
    localPath,
    contentHash,
    importBatch,
    total: uploadResult.total,
    succeeded: uploadResult.succeeded,
    failed: uploadResult.failed,
    skipped: uploadResult.skipped,
  };
}

async function sendSummaryEmail(config, summary) {
  const recipients = Array.isArray(config.notifyRecipients) ? config.notifyRecipients : [];
  if (!recipients.length) return null;
  const domain = normalizeDomain(config.domain);
  const processed = summary.attachments.filter((item) => !item.skipped && !item.error);
  const failed = summary.attachments.filter((item) => item.error);
  const failedRows = processed.reduce((sum, item) => sum + (Number(item.failed || 0) || 0), 0);
  const skipped = summary.attachments.filter((item) => item.skipped);
  const needsAttention = failed.length > 0 || failedRows > 0;
  const subject = `[${domain}] NCOA mailbox ingest ${needsAttention ? "needs attention" : "completed"} (${processed.length} file${processed.length === 1 ? "" : "s"})`;
  const lines = [
    `NCOA mailbox ingest finished at ${new Date().toISOString()}.`,
    "",
    `Messages scanned: ${summary.messagesScanned}`,
    `Attachments processed: ${processed.length}`,
    `Attachments skipped: ${skipped.length}`,
    `Attachments failed: ${failed.length}`,
    `Rows failed: ${failedRows}`,
    "",
    ...summary.attachments.map((item) => {
      if (item.error) return `FAILED ${item.filename}: ${item.error}`;
      if (item.skipped) return `SKIPPED ${item.filename}: ${item.skipReason}`;
      if (item.dryRun) return `DRY RUN ${item.filename}: ${item.total} parsed row(s)`;
      return `OK ${item.filename}: ${item.succeeded}/${item.total} succeeded, ${item.failed} failed, ${item.skipped} skipped`;
    }),
  ];
  return sendMail(domain, {
    to: recipients,
    from: `Mickey Gray <${getInternalFromEmail()}>`,
    transportDomain: "TAG",
    subject,
    text: lines.join("\n"),
  });
}

async function runNcoaMailboxIngest(options = {}) {
  const config = buildConfig(options.config || options);
  const domain = normalizeDomain(config.domain);
  const dryRun = Boolean(options.dryRun || config.dryRun);
  const dateKey = options.dateKey || formatDateKey(new Date(), config.timezone || DEFAULT_TIMEZONE);
  const runDir = path.join(config.outDir, `run-${timestampForFile()}`);
  const gmail = openMailbox({ gmail: options.gmailClient, config });
  const summary = {
    domain,
    dryRun,
    query: config.gmailQuery,
    messagesScanned: 0,
    messagePagesScanned: 0,
    messageScanTruncated: false,
    attachments: [],
    runDir,
    dateKey,
  };

  const listed = await listMailboxMessageRefs(gmail, config);
  const messages = listed.messages;
  summary.messagesScanned = messages.length;
  summary.messagePagesScanned = listed.pagesScanned;
  summary.messageScanTruncated = listed.truncated;

  for (const row of messages) {
    const message = await gmail.getMessage(row.id, { format: "full" });
    const parts = collectAttachmentParts(message.payload);
    let acceptedAny = false;
    const messageResults = [];
    for (const part of parts) {
      const filename = safeFileName(part.filename || "");
      if (!extensionAllowed(filename, config.acceptedExtensions || [])) {
        const result = {
          filename,
          skipped: true,
          skipReason: "unsupported-extension",
        };
        summary.attachments.push(result);
        continue;
      }
      acceptedAny = true;
      try {
        const result = await processAttachment({
          gmail,
          message,
          part,
          config,
          runDir,
          dryRun,
        });
        summary.attachments.push(result);
        messageResults.push(result);
      } catch (error) {
        const result = {
          filename,
          error: error.message,
        };
        summary.attachments.push(result);
        messageResults.push(result);
      }
    }
    if (acceptedAny && config.markRead && !dryRun && !messageResults.some((item) => item.error)) {
      try {
        const removeLabelIds = ["UNREAD"];
        if (config.archiveProcessed) removeLabelIds.push("INBOX");
        await gmail.modifyMessage(message.id, { removeLabelIds });
      } catch (error) {
        summary.attachments.push({
          filename: `(message ${message.id})`,
          skipped: true,
          skipReason: `mark-read-failed: ${error.message}`,
        });
      }
    }
  }

  const attempted = summary.attachments.filter((item) => !item.skipped && !item.error);
  if (!dryRun && attempted.length > 0) {
    const succeeded = attempted.reduce((sum, item) => sum + (Number(item.succeeded || 0) || 0), 0);
    const failed = attempted.reduce((sum, item) => sum + (Number(item.failed || 0) || 0), 0);
    const total = attempted.reduce((sum, item) => sum + (Number(item.total || 0) || 0), 0);
    await recordCompletedMailboxRun({
      domain,
      dateKey,
      files: attempted.map((item) => item.filename),
      query: config.gmailQuery,
      result: {
        attachments: attempted.length,
        total,
        succeeded,
        failed,
      },
    });
  }
  if (summary.attachments.length && !options.skipEmail) {
    try {
      summary.email = await sendSummaryEmail(config, summary);
    } catch (error) {
      summary.emailError = error.message;
    }
  }
  return summary;
}

async function runNcoaMailboxIngestIfDue(options = {}) {
  const config = buildConfig(options.config || options);
  if (!config.enabled) {
    return { skipped: true, reason: "disabled" };
  }
  const now = options.now || new Date();
  const timeZone = config.timezone || DEFAULT_TIMEZONE;
  const weekday = getWeekday(now, timeZone);
  const activeWeekdays = Array.isArray(config.activeWeekdays) && config.activeWeekdays.length
    ? config.activeWeekdays
    : [1, 2, 3, 4, 5];
  if (!activeWeekdays.includes(weekday)) {
    return { skipped: true, reason: "inactive-weekday", weekday };
  }
  const domain = normalizeDomain(config.domain);
  const dateKey = options.dateKey || formatDateKey(now, timeZone);
  if (await hasCompletedMailboxRun({ domain, dateKey })) {
    const gmail = openMailbox({ gmail: options.gmailClient, config });
    const unreadCheck = await listMailboxMessageRefs(gmail, {
      ...config,
      maxMessages: 1,
      maxMessagePages: 1,
    });
    if (!unreadCheck.messages.length) {
      return {
        skipped: true,
        reason: "already-completed-today",
        dateKey,
        messagesScanned: 0,
        messagePagesScanned: unreadCheck.pagesScanned,
      };
    }
  }
  const result = await runNcoaMailboxIngest({
    ...options,
    config,
    dateKey,
  });
  if (!result.attachments.length) {
    if (
      config.completeOnNoUnread &&
      !result.dryRun &&
      Number(result.messagesScanned || 0) === 0
    ) {
      await recordCompletedMailboxRun({
        domain,
        dateKey,
        query: config.gmailQuery,
        result: {
          attachments: 0,
          total: 0,
          succeeded: 0,
          failed: 0,
        },
        empty: true,
      });
      return {
        ...result,
        skipped: true,
        reason: "no-unread-completed-today",
      };
    }
    return {
      ...result,
      skipped: true,
      reason: "no-attachments",
    };
  }
  return result;
}

module.exports = {
  hasCompletedMailboxRun,
  listMailboxMessageRefs,
  runNcoaMailboxIngest,
  runNcoaMailboxIngestIfDue,
  // Exported so the shared mailbox loop can drive NCOA as a handler rather than
  // opening the mailbox a second time on its own schedule. See ncoaMailboxHandler.
  buildConfig,
  processAttachment,
};
