"use strict";

// Last-resort nightly mail delivery.
//
// This module deliberately has NO model, repository, or event-core imports.
// If the 19:50 pipeline is wedged on Mongo, its durable cursor cannot be the
// mechanism that tells Mickey the night failed. The only dependencies here are
// the filesystem (for a tiny process-crash checkpoint) and the same SendGrid
// transport already proven by the normal report mailer.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const {
  ROOT_DIR,
  getInternalFromEmail,
} = require("../../shared-config/src");
const { sendMail } = require("./mailerService");

const DEFAULT_STATE_FILE = path.join(ROOT_DIR, "runtime", "nightly-emergency-close.json");
const DEFAULT_LOCK_STALE_MS = 5 * 60 * 1000;
const DEFAULT_RECIPIENT = "mgray@taxadvocategroup.com";

function safeToken(value, fallback = "unknown") {
  const token = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .slice(0, 80);
  return token || fallback;
}

function normalizeRecipients(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(",");
  const recipients = raw.map((entry) => String(entry || "").trim()).filter(Boolean);
  return recipients.length ? [...new Set(recipients)] : [DEFAULT_RECIPIENT];
}

function emergencyRecipients(override = null) {
  return normalizeRecipients(
    override
      || process.env.NIGHTLY_EMERGENCY_RECIPIENTS
      || process.env.NIGHTLY_CLOSE_OPS_RECIPIENTS
      || process.env.ADMIN_EMAIL
      || DEFAULT_RECIPIENT,
  );
}

function readCheckpoint(stateFile = DEFAULT_STATE_FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeCheckpoint(next, stateFile = DEFAULT_STATE_FILE) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, stateFile);
  return next;
}

function updateCheckpoint(patch, stateFile = DEFAULT_STATE_FILE) {
  const prior = readCheckpoint(stateFile) || { version: 1 };
  return writeCheckpoint({ ...prior, ...patch, version: 1 }, stateFile);
}

function markNightlyCloseStarted({ dateKey, at = new Date(), stateFile = DEFAULT_STATE_FILE } = {}) {
  const prior = readCheckpoint(stateFile);
  if (prior?.dateKey === dateKey && (prior.status === "completed" || prior.fallbackSentAt)) {
    return prior;
  }
  return writeCheckpoint({
    version: 1,
    dateKey: String(dateKey || ""),
    status: "running",
    startedAt: new Date(at).toISOString(),
  }, stateFile);
}

function markNightlyCloseCompleted({ dateKey, at = new Date(), stateFile = DEFAULT_STATE_FILE } = {}) {
  return updateCheckpoint({
    dateKey: String(dateKey || ""),
    status: "completed",
    completedAt: new Date(at).toISOString(),
    reasonCode: null,
    taskKey: null,
  }, stateFile);
}

function checkpointNeedsRecovery(checkpoint) {
  return Boolean(
    checkpoint?.dateKey
      && checkpoint.status !== "completed"
      && !checkpoint.fallbackSentAt,
  );
}

function acquireLock(lockFile, staleMs = DEFAULT_LOCK_STALE_MS) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockFile, "wx", 0o600);
      fs.writeFileSync(fd, `${process.pid}\n`, "utf8");
      return fd;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const ageMs = Date.now() - fs.statSync(lockFile).mtimeMs;
        if (ageMs <= staleMs) return null;
        fs.unlinkSync(lockFile);
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function sendEmergencyNightlyClose({
  dateKey,
  reasonCode = "pipeline-failed",
  taskKey = null,
  recipients = null,
  at = new Date(),
  stateFile = DEFAULT_STATE_FILE,
  sendMailImpl = sendMail,
} = {}) {
  const lockFile = `${stateFile}.lock`;
  const lockFd = acquireLock(lockFile);
  if (lockFd == null) return { sent: false, skipped: true, reason: "another-fallback-sender" };

  const safeReason = safeToken(reasonCode, "pipeline-failed");
  const safeTask = taskKey == null ? null : safeToken(taskKey);
  try {
    const checkpoint = readCheckpoint(stateFile);
    if (checkpoint?.dateKey === dateKey && checkpoint.fallbackSentAt) {
      return { sent: false, skipped: true, reason: "fallback-already-sent" };
    }

    updateCheckpoint({
      dateKey: String(dateKey || ""),
      status: "fallback-sending",
      fallbackStartedAt: new Date(at).toISOString(),
      reasonCode: safeReason,
      taskKey: safeTask,
    }, stateFile);

    const to = emergencyRecipients(recipients);
    const taskLine = safeTask ? `Failed stage: ${safeTask}.` : "Failed stage: unavailable.";
    const text = [
      `Daily Close ${dateKey}`,
      "",
      "The normal nightly report pipeline did not complete.",
      "No metrics are included because this emergency close does not read Mongo or any customer system.",
      taskLine,
      `Failure class: ${safeReason}.`,
      "The full report can be rerun after the pipeline is repaired.",
    ].join("\n");

    const result = await sendMailImpl("TAG", {
      to,
      from: `Parallel Reports <${getInternalFromEmail()}>`,
      replyTo: getInternalFromEmail(),
      subject: `[DEGRADED] Daily Close ${dateKey} — summary unavailable`,
      text,
      html: `<h2>Daily Close ${dateKey}</h2>`
        + "<p><strong>The normal nightly report pipeline did not complete.</strong></p>"
        + "<p>No metrics are included because this emergency close does not read Mongo or any customer system.</p>"
        + `<p>${taskLine} Failure class: ${safeReason}.</p>`
        + "<p>The full report can be rerun after the pipeline is repaired.</p>",
    });

    updateCheckpoint({
      dateKey: String(dateKey || ""),
      status: "fallback-sent",
      fallbackSentAt: new Date().toISOString(),
      reasonCode: safeReason,
      taskKey: safeTask,
    }, stateFile);
    return { sent: true, recipientCount: to.length, messageId: result?.messageId || null };
  } catch (error) {
    updateCheckpoint({
      dateKey: String(dateKey || ""),
      status: "fallback-failed",
      fallbackFailedAt: new Date().toISOString(),
      reasonCode: safeReason,
      taskKey: safeTask,
    }, stateFile);
    throw error;
  } finally {
    try { fs.closeSync(lockFd); } catch { /* best effort */ }
    try { fs.unlinkSync(lockFile); } catch { /* best effort */ }
  }
}

function launchEmergencyNightlyClose({
  dateKey,
  reasonCode = "pipeline-failed",
  taskKey = null,
  recipients = null,
  stateFile = DEFAULT_STATE_FILE,
  scriptPath = path.join(ROOT_DIR, "scripts", "send-nightly-emergency-close.js"),
  spawnImpl = spawn,
} = {}) {
  const checkpoint = readCheckpoint(stateFile);
  if (checkpoint?.dateKey === dateKey && checkpoint.fallbackSentAt) {
    return { launched: false, skipped: true, reason: "fallback-already-sent" };
  }

  const safeReason = safeToken(reasonCode, "pipeline-failed");
  const safeTask = taskKey == null ? null : safeToken(taskKey);
  updateCheckpoint({
    dateKey: String(dateKey || ""),
    status: "fallback-launched",
    fallbackLaunchedAt: new Date().toISOString(),
    reasonCode: safeReason,
    taskKey: safeTask,
  }, stateFile);

  const args = [scriptPath, "--date", String(dateKey || ""), "--reason", safeReason, "--state", stateFile];
  if (safeTask) args.push("--task", safeTask);
  const child = spawnImpl(process.execPath, args, {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      ...(recipients
        ? { NIGHTLY_EMERGENCY_RECIPIENTS: emergencyRecipients(recipients).join(",") }
        : {}),
    },
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref?.();
  return { launched: true, pid: child.pid || null };
}

module.exports = {
  DEFAULT_STATE_FILE,
  checkpointNeedsRecovery,
  emergencyRecipients,
  launchEmergencyNightlyClose,
  markNightlyCloseCompleted,
  markNightlyCloseStarted,
  readCheckpoint,
  sendEmergencyNightlyClose,
};
