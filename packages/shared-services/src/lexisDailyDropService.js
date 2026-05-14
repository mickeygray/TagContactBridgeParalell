"use strict";

const fs = require("fs");
const path = require("path");
const {
  env,
  getInternalFromEmail,
} = require("../../shared-config/src");
const { sendPlainEmail } = require("./sendgridMailService");
const { recordWorkflowStage } = require("./workflowStateService");
const { emitHourlyJobEvent } = require("./hourlyJobEventService");
const {
  buildRunId,
  fetchLatestLexisDrop,
} = require("./lexisSftpService");

const DEFAULT_TIMEZONE = "America/Los_Angeles";
const STATE_ROOT = path.resolve(__dirname, "..", "..", "..", "runtime", "lexis-daily-drop");
const DEFAULT_ATTACHMENT_RECIPIENTS = [
  "tax_advocate@wizbangsolutions.com",
  "mike.ciletti@wizbangsolutions.com",
  "james.wickstrom@wizbangsolutions.com",
];
const DEFAULT_ALERT_RECIPIENTS = [
  "mgray@taxadvocategroup.com",
  "manderson@taxadvocategroup.com",
  "abanks@taxadvocategroup.com",
  "jonathan13pineda@yahoo.com",
];

function formatDateKey(now = new Date(), timezone = DEFAULT_TIMEZONE) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function splitRecipients(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry || "").trim().toLowerCase())
      .filter(Boolean);
  }

  return String(value || "")
    .split(",")
    .map((entry) => String(entry || "").trim().toLowerCase())
    .filter(Boolean);
}

function missingRecipients(desired = [], alreadySent = []) {
  const sent = new Set(
    (Array.isArray(alreadySent) ? alreadySent : [])
      .map((entry) => String(entry || "").trim().toLowerCase())
      .filter(Boolean),
  );
  return (Array.isArray(desired) ? desired : [])
    .map((entry) => String(entry || "").trim().toLowerCase())
    .filter((entry) => entry && !sent.has(entry));
}

function mergeRecipients(existing = [], additions = []) {
  return [...new Set([
    ...(Array.isArray(existing) ? existing : []),
    ...(Array.isArray(additions) ? additions : []),
  ].map((entry) => String(entry || "").trim().toLowerCase()).filter(Boolean))];
}

function ensureStateRoot() {
  fs.mkdirSync(STATE_ROOT, { recursive: true });
}

function getStateFilePath(domain) {
  ensureStateRoot();
  return path.join(STATE_ROOT, `${String(domain || "TAG").toUpperCase()}.json`);
}

function createInitialState(domain) {
  return {
    domain: String(domain || "TAG").toUpperCase(),
    lastStartedAt: null,
    lastCompletedAt: null,
    lastSuccessDateKey: null,
    lastError: null,
    lastFailureAt: null,
    deliveries: {},
  };
}

function normalizeStateShape(domain, state = null) {
  const normalized = state && typeof state === "object"
    ? { ...state }
    : createInitialState(domain);
  normalized.domain = String(domain || normalized.domain || "TAG").toUpperCase();
  normalized.deliveries =
    normalized.deliveries && typeof normalized.deliveries === "object"
      ? normalized.deliveries
      : {};
  return normalized;
}

function readLexisDailyDropState(domain) {
  const filePath = getStateFilePath(domain);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return normalizeStateShape(domain, parsed);
  } catch {
    return createInitialState(domain);
  }
}

function pruneDeliveries(deliveries = {}, keep = 21) {
  const entries = Object.entries(deliveries)
    .sort((left, right) => String(right[0]).localeCompare(String(left[0])));
  return Object.fromEntries(entries.slice(0, keep));
}

function writeLexisDailyDropState(domain, nextState) {
  const filePath = getStateFilePath(domain);
  const normalized = normalizeStateShape(domain, nextState);
  normalized.deliveries = pruneDeliveries(normalized.deliveries);
  fs.writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

function withDeliveryState(state, dateKey) {
  const next = normalizeStateShape(state.domain, state);
  next.deliveries = { ...(next.deliveries || {}) };
  next.deliveries[dateKey] = {
    ...(next.deliveries[dateKey] || {}),
  };
  return next;
}

function summarizeLexisCounts(rows = []) {
  const parsedRows = Array.isArray(rows) ? rows : [];
  return {
    totalCount: parsedRows.length,
    stateCount: parsedRows.filter((row) => /State Tax/i.test(String(row.FILE_TYPE || ""))).length,
    federalCount: parsedRows.filter((row) => /Federal Tax/i.test(String(row.FILE_TYPE || ""))).length,
  };
}

function buildCountSummaryText(recordCount = {}, options = {}) {
  const customText = String(options.alertText || "").trim();
  const lines = [
    `Total Liens: ${Number(recordCount.totalCount || 0)}`,
    `State Tax Liens: ${Number(recordCount.stateCount || 0)}`,
    `Federal Tax Liens: ${Number(recordCount.federalCount || 0)}`,
  ];

  if (customText) {
    lines.push("", customText);
  }

  if (options.filename) {
    lines.push("", `File: ${options.filename}`);
  }

  return lines.join("\n");
}

function guessAttachmentType(filePath) {
  const ext = String(path.extname(filePath) || "").toLowerCase();
  switch (ext) {
    case ".csv":
      return "text/csv";
    case ".txt":
      return "text/plain";
    case ".pdf":
      return "application/pdf";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    default:
      return "application/octet-stream";
  }
}

function buildAttachmentPayload(files = []) {
  return files.map((filePath) => ({
    filename: path.basename(filePath),
    type: guessAttachmentType(filePath),
    disposition: "attachment",
    content: fs.readFileSync(filePath).toString("base64"),
  }));
}

function resolveRecipients(options = {}) {
  const defaultAttachmentRecipients = DEFAULT_ATTACHMENT_RECIPIENTS.join(",");
  const defaultAlertRecipients = DEFAULT_ALERT_RECIPIENTS.join(",");
  const attachmentRecipients = splitRecipients(
    options.recipients ||
      (!options.ignoreConfiguredRecipients
        ? env("LEXIS_DAILY_DROP_RECIPIENTS", defaultAttachmentRecipients)
        : ""),
  );
  const alertRecipients = splitRecipients(
    options.alertRecipients ||
      (!options.ignoreConfiguredAlertRecipients
        ? env("LEXIS_DAILY_DROP_ALERT_RECIPIENTS", defaultAlertRecipients)
        : ""),
  );

  return {
    attachmentRecipients,
    alertRecipients,
  };
}

function buildDailyDropRetryPayload(domain, dateKey, options = {}) {
  return {
    domain,
    dateKey,
    recipients: options.recipients || "",
    alertRecipients: options.alertRecipients || "",
    subject: options.subject || "",
    text: options.text || "",
    alertSubject: options.alertSubject || "",
    alertText: options.alertText || "",
    ignoreConfiguredRecipients: Boolean(options.ignoreConfiguredRecipients),
    ignoreConfiguredAlertRecipients: Boolean(options.ignoreConfiguredAlertRecipients),
    host: options.host || "",
    port: options.port || null,
    username: options.username || "",
    password: options.password || "",
    remoteDir: options.remoteDir || "",
    zipPassword: options.zipPassword || "",
    force: Boolean(options.force),
  };
}

async function queueLexisDailyDropRetry(domain, dateKey, error, options = {}) {
  return emitHourlyJobEvent({
    lane: "hourly",
    domain,
    eventType: "lexis.daily-drop.retry",
    targetService: "control-plane",
    handlerKey: "retryLexisDailyDrop",
    resolutionCheckKey: "lexis-daily-drop-sent",
    aggregateType: "lexis-daily-drop",
    aggregateId: `${domain}:${dateKey}`,
    payload: buildDailyDropRetryPayload(domain, dateKey, options),
    dedupeKey: `lexis-daily-drop:${domain}:${dateKey}`,
    emittedBy: options.sourceService || "control-plane",
    severity: "critical",
    priority: 95,
    maxAttempts: 6,
    nextAttemptAt: new Date(),
    provideSummary: true,
    summaryLabel: "Lexis daily drop retry",
    firstError: error?.message || String(error || "unknown error"),
    lastError: error?.message || String(error || "unknown error"),
    alertTitle: "Lexis daily drop retry queued",
    alertSummary: `${domain} daily drop will retry for ${dateKey}`,
    notify: true,
    notifyOptions: {
      toEmail: env("ADMIN_EMAIL", "mgray@taxadvocategroup.com"),
    },
  });
}

async function sendLexisDailyDropMail(options = {}) {
  const domain = String(options.domain || "TAG").toUpperCase();
  const sourceService = options.sourceService || "control-plane";
  const timezone = options.timezone || DEFAULT_TIMEZONE;
  const dateKey = String(options.dateKey || formatDateKey(new Date(), timezone));
  const aggregateId = options.aggregateId || buildRunId("lexis-daily-drop");
  const state = withDeliveryState(readLexisDailyDropState(domain), dateKey);
  const delivery = state.deliveries[dateKey] || {};
  const initialRecipients = resolveRecipients(options);

  if (
    delivery.completedAt &&
    !options.force &&
    missingRecipients(
      initialRecipients.attachmentRecipients,
      delivery.attachmentRecipients,
    ).length === 0 &&
    missingRecipients(
      initialRecipients.alertRecipients,
      delivery.alertRecipients,
    ).length === 0
  ) {
    return {
      ok: true,
      skipped: true,
      reason: "already-sent-for-date",
      domain,
      dateKey,
      state: delivery,
    };
  }

  state.lastStartedAt = new Date();
  state.lastError = null;
  writeLexisDailyDropState(domain, state);

  await recordWorkflowStage({
    domain,
    family: "lexis",
    subtype: "daily-drop",
    stage: "requested",
    aggregateType: "lexis-daily-drop",
    aggregateId,
    sourceService,
    title: "Lexis daily drop requested",
    summary: `Preparing daily Lexis mail drop for ${domain} (${dateKey})`,
    payload: {
      dateKey,
      scheduled: Boolean(options.scheduled),
      force: Boolean(options.force),
    },
  });

  try {
    const drop = options.drop || await fetchLatestLexisDrop(options);
    const { attachmentRecipients, alertRecipients } = initialRecipients;
    if (!attachmentRecipients.length) {
      throw new Error("No Lexis daily drop attachment recipients were configured");
    }
    if (!alertRecipients.length) {
      throw new Error("No Lexis daily drop alert recipients were configured");
    }

    const recordCount = summarizeLexisCounts(drop.parsedRows);
    const attachments = buildAttachmentPayload(drop.attachments);
    const deliveryState = withDeliveryState(readLexisDailyDropState(domain), dateKey);
    const deliveryEntry = deliveryState.deliveries[dateKey];
    const attachmentRecipientsToSend = options.force
      ? attachmentRecipients
      : missingRecipients(attachmentRecipients, deliveryEntry.attachmentRecipients);
    const alertRecipientsToSend = options.force
      ? alertRecipients
      : missingRecipients(alertRecipients, deliveryEntry.alertRecipients);

    if (attachmentRecipientsToSend.length > 0) {
      await sendPlainEmail(domain, {
        personalizations: attachmentRecipientsToSend.map((email) => ({
          to: [{ email }],
          subject: options.subject || "Daily Drop",
        })),
        from: {
          email: options.fromEmail || getInternalFromEmail(),
          name: options.fromName || "Lexis Daily Drop",
        },
        reply_to: {
          email: options.replyToEmail || options.fromEmail || getInternalFromEmail(),
          name: options.replyToName || options.fromName || "Lexis Daily Drop",
        },
        content: [
          {
            type: "text/plain",
            value: options.text || "Please see the attached file.",
          },
        ],
        attachments,
      });

      deliveryEntry.attachmentsSentAt = new Date().toISOString();
      deliveryEntry.attachmentRecipients = mergeRecipients(
        options.force ? [] : deliveryEntry.attachmentRecipients,
        attachmentRecipientsToSend,
      );
      deliveryEntry.attachmentNames = drop.attachments.map((file) => path.basename(file));
      deliveryEntry.remoteFilename = drop.download?.filename || null;
      deliveryEntry.recordCount = recordCount;
      writeLexisDailyDropState(domain, deliveryState);
    }

    if (alertRecipientsToSend.length > 0) {
      await sendPlainEmail(domain, {
        personalizations: alertRecipientsToSend.map((email) => ({
          to: [{ email }],
          subject: options.alertSubject || `Daily Drop - ${dateKey}`,
        })),
        from: {
          email: options.fromEmail || getInternalFromEmail(),
          name: options.fromName || "Lexis Daily Drop",
        },
        reply_to: {
          email: options.replyToEmail || options.fromEmail || getInternalFromEmail(),
          name: options.replyToName || options.fromName || "Lexis Daily Drop",
        },
        content: [
          {
            type: "text/plain",
            value: buildCountSummaryText(recordCount, {
              alertText: options.alertText,
              filename: drop.download?.filename || null,
            }),
          },
        ],
      });

      deliveryEntry.alertSentAt = new Date().toISOString();
      deliveryEntry.alertRecipients = mergeRecipients(
        options.force ? [] : deliveryEntry.alertRecipients,
        alertRecipientsToSend,
      );
      writeLexisDailyDropState(domain, deliveryState);
    }

    deliveryEntry.completedAt = new Date().toISOString();
    deliveryEntry.runId = aggregateId;
    deliveryEntry.workDir = drop.workDir;
    deliveryState.lastCompletedAt = deliveryEntry.completedAt;
    deliveryState.lastSuccessDateKey = dateKey;
    deliveryState.lastError = null;
    writeLexisDailyDropState(domain, deliveryState);

    const result = {
      ok: true,
      domain,
      dateKey,
      runId: aggregateId,
      file: {
        remotePath: drop.download?.remotePath || null,
        filename: drop.download?.filename || null,
        modifyTime: drop.download?.modifyTime || null,
        size: drop.download?.size || null,
      },
      attachmentRecipients,
      alertRecipients,
      attachments: drop.attachments.map((file) => path.basename(file)),
      recordCount,
      workDir: drop.workDir,
    };

    await recordWorkflowStage({
      domain,
      family: "lexis",
      subtype: "daily-drop",
      stage: "completed",
      aggregateType: "lexis-daily-drop",
      aggregateId,
      sourceService,
      title: "Lexis daily drop completed",
      summary: `Sent ${attachments.length} attachment(s) and count alert for ${dateKey}`,
      result,
    });

    return result;
  } catch (error) {
    const failedState = withDeliveryState(readLexisDailyDropState(domain), dateKey);
    failedState.lastCompletedAt = new Date().toISOString();
    failedState.lastFailureAt = failedState.lastCompletedAt;
    failedState.lastError = error.message;
    failedState.deliveries[dateKey] = {
      ...(failedState.deliveries[dateKey] || {}),
      failedAt: failedState.lastCompletedAt,
      lastError: error.message,
    };
    writeLexisDailyDropState(domain, failedState);

    await recordWorkflowStage({
      domain,
      family: "lexis",
      subtype: "daily-drop",
      stage: "failed",
      aggregateType: "lexis-daily-drop",
      aggregateId,
      sourceService,
      status: "failed",
      title: "Lexis daily drop failed",
      summary: error.message,
      payload: {
        dateKey,
        scheduled: Boolean(options.scheduled),
      },
      result: {
        error: error.message,
      },
    });

    if (options.emitRetryOnFailure !== false && (options.scheduled || options.emitRetryOnFailure === true)) {
      await queueLexisDailyDropRetry(domain, dateKey, error, {
        ...options,
        sourceService,
      });
    }

    throw error;
  }
}

function isLexisDailyDropDelivered(domain, dateKey) {
  const state = readLexisDailyDropState(domain);
  const delivery = state.deliveries?.[String(dateKey || "")];
  return Boolean(delivery?.completedAt);
}

module.exports = {
  DEFAULT_ALERT_RECIPIENTS,
  DEFAULT_ATTACHMENT_RECIPIENTS,
  formatDateKey,
  getStateFilePath,
  isLexisDailyDropDelivered,
  queueLexisDailyDropRetry,
  readLexisDailyDropState,
  sendLexisDailyDropMail,
  buildCountSummaryText,
  summarizeLexisCounts,
  writeLexisDailyDropState,
};
