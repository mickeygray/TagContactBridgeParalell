"use strict";

const { getInternalFromEmail } = require("../../shared-config/src");
const { sendMail } = require("./mailerService");
const {
  loadNightlyOperationalSummary,
} = require("./nightlyOperationalReceiptService");

const DEFAULT_RECIPIENTS = Object.freeze(["mgray@taxadvocategroup.com"]);

function normalizeRecipients(values = DEFAULT_RECIPIENTS) {
  const source = Array.isArray(values) ? values : String(values || "").split(",");
  const normalized = source
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(normalized.length ? normalized : DEFAULT_RECIPIENTS)];
}

function count(value) {
  return Math.max(0, Number(value) || 0);
}

function buildNightlyRunSummary(results = [], operational = {}) {
  const completed = [];
  const leadHealth = [];
  const followUps = [];

  for (const row of Array.isArray(results) ? results : []) {
    const task = String(row?.task || "task");
    const label = String(row?.label || task);
    if (row?.error || row?.errorCode) {
      followUps.push(`${label}: failed; review the service alert before the next run.`);
      continue;
    }

    if (row?.dryRun) {
      if (count(row.planned) > 0) {
        followUps.push(`${label}: ${count(row.planned)} item(s) found; write path is not enabled.`);
      }
      continue;
    }

    const applied = row?.applied || {};
    if (task === "mail-invoice") {
      if (count(applied.ncoaProcessed) > 0) {
        completed.push(`Added ${count(applied.ncoaProcessed)} NCOA return file(s).`);
      } else if (count(applied.ncoaFailed) === 0) {
        completed.push("NCOA mailbox checked; no new return file required processing.");
      }
      if (count(applied.ncoaFailed) > 0) {
        followUps.push(`NCOA: ${count(applied.ncoaFailed)} file or mailbox operation(s) failed.`);
      }
      if (count(applied.invoiceProcessed) > 0) {
        completed.push(`Added ${count(applied.invoiceProcessed)} vendor invoice(s).`);
      }
      continue;
    }

    if (task === "mail-spend-derive") {
      if (count(applied.written) > 0) {
        completed.push(`Costed ${count(applied.written)} mail-spend day(s).`);
      }
      if (count(applied.repaired) > 0) {
        completed.push(`Repaired ${count(applied.repaired)} earlier nightly report day(s).`);
      }
      if (count(applied.held) > 0) {
        followUps.push(`Mail spend: ${count(applied.held)} item(s) remain held for evidence.`);
      }
      continue;
    }

    if (task === "report-delivery") {
      completed.push(`Sent ${count(applied.written)} scheduled report(s).`);
      for (const report of Array.isArray(applied.reports) ? applied.reports : []) {
        const sourceWrite = report?.agedSourceWrite || {};
        if (count(sourceWrite.written) > 0) {
          completed.push(`Changed ${count(sourceWrite.written)} case source status(es) to Aged.`);
        }
        if (count(sourceWrite.failed) > 0 || count(sourceWrite.deferred) > 0 || sourceWrite.status === "failed") {
          followUps.push(`Aged case-source update: ${count(sourceWrite.failed) + count(sourceWrite.deferred) || 1} item(s) need attention.`);
        }
      }
      continue;
    }

    if (task === "historical-report-repair") {
      if (count(applied.written) > 0) {
        completed.push(`Patched ${count(applied.written)} unresolved prior report day(s).`);
      }
      if (count(applied.attention) > 0) {
        followUps.push(`Historical report repair: ${count(applied.attention)} day(s) still need attention.`);
      }
      continue;
    }

    if (task === "retry-drain") {
      const completedRetries = count(applied.completed);
      const autoResolved = count(applied.autoResolved);
      const deferred = count(applied.deferred);
      const deadLettered = count(applied.deadLettered);
      const retriedInPass = count(applied.inlineRetries);
      if (completedRetries + autoResolved > 0) {
        completed.push(
          `Durable retries: ${completedRetries} completed, ${autoResolved} auto-resolved; `
          + `${retriedInPass} bounded in-pass retry attempt(s).`,
        );
      } else {
        completed.push("Durable retry queue checked; no due job completed in this pass.");
      }
      if (deferred > 0) {
        followUps.push(`Durable retries: ${deferred} job(s) failed this pass and remain deferred.`);
      }
      if (deadLettered > 0) {
        followUps.push(`Durable retries: ${deadLettered} job(s) exhausted their retry budget.`);
      }
      continue;
    }

    if (task === "lead-health") {
      const health = applied.leadHealth;
      if (!health) {
        followUps.push("Lead health: no count-only result was available.");
        continue;
      }
      const inventory = health.inventory || {};
      const due = inventory.due || {};
      const attempts = health.attempts || {};
      const alerts = health.alerts || {};
      const repair = health.repair || {};
      leadHealth.push(
        `Today's PhoneBurner calls: ${count(attempts.total)} total; `
        + `${count(attempts.firstTouches)} first touch, ${count(attempts.lowTouch)} ending at 2-9, `
        + `${count(attempts.highTouch)} ending at 10-14, ${count(attempts.phaseOut)} ending at 15+.`,
      );
      leadHealth.push(
        `Open ordinary inventory: ${count(inventory.zeroTouch)} zero-touch `
        + `(${count(inventory.zeroTouchProviderHeld)} already provider-held; `
        + `${count(inventory.zeroTouchOlderThanToday)} carried from before today), `
        + `${count(inventory.lowTouch)} at 1-9, ${count(inventory.highTouch)} at 10-14, `
        + `${count(inventory.phaseOut)} at 15+; ${count(inventory.review)} in review.`,
      );
      leadHealth.push(
        `Due and not provider-held: ${count(due.zeroTouch)} zero-touch, `
        + `${count(due.lowTouch)} at 1-9, ${count(due.highTouch)} at 10-14, `
        + `${count(due.phaseOut)} at 15+.`,
      );
      leadHealth.push(
        `Gentle repair: ${count(repair.expiredReservationsReleased)} expired reservation(s) released, `
        + `${count(repair.phaseOutDatesRepaired)} premature phase-out date(s) corrected; `
        + `${count(repair.conflicts)} conflict(s), ${count(repair.skippedContradictory)} contradictory row(s).`,
      );
      if (alerts.zeroTouchDue || count(due.zeroTouch) > 0) {
        followUps.push(`Lead health: ${count(due.zeroTouch)} zero-touch lead(s) remain due and unserved.`);
      }
      if (alerts.staleZeroTouch || count(inventory.zeroTouchOlderThanToday) > 0) {
        followUps.push(
          `Lead health: ${count(inventory.zeroTouchOlderThanToday)} zero-touch lead(s) arrived before today and remain open.`,
        );
      }
      if (alerts.highTouchWhileLightDue) {
        followUps.push(
          `Lead health: ${count(due.lowTouch)} lead(s) below ten touches remain due after `
          + `${count(attempts.highTouch) + count(attempts.phaseOut)} call(s) were spent at ten-plus touches.`,
        );
      }
      if (alerts.noCallsWithOpenWork) {
        followUps.push("Lead health: no PhoneBurner calls were recorded while zero/low-touch work remained due.");
      }
      if (repair.truncated) {
        followUps.push("Lead health repair reached its nightly safety cap; remaining candidates will resume next run.");
      }
      if (count(repair.conflicts) > 0 || count(repair.skippedContradictory) > 0) {
        followUps.push(
          `Lead health repair: ${count(repair.conflicts)} compare-and-set conflict(s) and `
          + `${count(repair.skippedContradictory)} contradictory row(s) were left unchanged.`,
        );
      }
      continue;
    }

    const written = count(applied.written);
    const repaired = count(applied.repaired);
    const failed = count(applied.failed);
    if (written > 0) completed.push(`${label}: ${written} update(s) completed.`);
    if (repaired > 0) completed.push(`${label}: ${repaired} prior item(s) repaired.`);
    if (failed > 0) followUps.push(`${label}: ${failed} item(s) failed or remain unresolved.`);
  }

  const aged = operational?.aged || { status: "missing" };
  if (aged.status === "completed") {
    completed.push(
      `Aged/DNC refresh: ${count(aged.checked)} checked, ${count(aged.promoted)} promoted, `
      + `${count(aged.retired)} retired.`,
    );
    if (count(aged.lookupFailures) > 0) {
      const paymentFailures = count(aged.lookupFailureReasons?.paymentRequired);
      const detail = paymentFailures === count(aged.lookupFailures)
        ? "all were rejected for insufficient provider credit or payment required"
        : `${paymentFailures} were rejected for insufficient provider credit or payment required`;
      followUps.push(
        `Aged/DNC refresh: ${count(aged.lookupFailures)} lookup(s) deferred; ${detail}.`,
      );
    }
  } else if (aged.status === "failed") {
    followUps.push("Aged/DNC refresh failed; no successful daily receipt was recorded.");
  } else {
    followUps.push("Aged/DNC refresh: no daily run receipt was recorded.");
  }

  const blogger = operational?.blogger || { status: "missing" };
  if (blogger.status === "completed") {
    const seconds = Math.max(0, Math.round(count(blogger.durationMs) / 1000));
    completed.push(`Blogger completed successfully${seconds ? ` in ${seconds} second(s)` : ""}.`);
  } else if (blogger.status === "failed") {
    followUps.push(
      `Blogger failed${blogger.timedOut ? " after timing out" : ""}; review the blogger service alert.`,
    );
  } else {
    followUps.push("Blogger: no scheduled run receipt was recorded.");
  }

  if (completed.length === 0) completed.push("The nightly run completed with no material changes.");
  if (followUps.length === 0) followUps.push("No follow-up work was identified by this run.");
  if (leadHealth.length === 0) leadHealth.push("Lead-health counts were not available in this run.");
  return { completed, leadHealth, followUps };
}

function renderNightlyRunSummary(dateKey, summary) {
  return [
    `Nightly run summary — ${dateKey}`,
    "",
    "Successfully completed:",
    ...summary.completed.map((line) => `- ${line}`),
    "",
    "Lead health:",
    ...summary.leadHealth.map((line) => `- ${line}`),
    "",
    "Needs attention:",
    ...summary.followUps.map((line) => `- ${line}`),
  ].join("\n");
}

async function sendNightlyRunSummary({
  dateKey,
  results = [],
  recipients = DEFAULT_RECIPIENTS,
  mailer = sendMail,
  operational = null,
  operationalLoader = loadNightlyOperationalSummary,
} = {}) {
  const to = normalizeRecipients(recipients);
  let resolvedOperational = operational;
  if (!resolvedOperational) {
    try {
      resolvedOperational = await operationalLoader(dateKey);
    } catch {
      resolvedOperational = {
        aged: { status: "unavailable" },
        blogger: { status: "unavailable" },
      };
    }
  }
  const summary = buildNightlyRunSummary(results, resolvedOperational);
  const text = renderNightlyRunSummary(dateKey, summary);
  const result = await mailer("TAG", {
    to,
    subject: `Nightly run summary · ${dateKey}`,
    text,
    from: `Parallel Nightly <${getInternalFromEmail()}>`,
    replyTo: `Parallel Nightly <${getInternalFromEmail()}>`,
  });
  return {
    sent: true,
    recipientCount: to.length,
    completedCount: summary.completed.length,
    followUpCount: summary.followUps.length,
    messageId: result?.messageId || null,
  };
}

module.exports = {
  buildNightlyRunSummary,
  normalizeRecipients,
  renderNightlyRunSummary,
  sendNightlyRunSummary,
};
