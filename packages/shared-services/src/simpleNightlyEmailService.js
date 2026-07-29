"use strict";

// The reborn nightly email (2026-07-24) — Mickey's spec, verbatim:
// "spend for the day, calls for the day, initials for the day, total for
// the day" with calls and initials split by source. One email, one
// screen, no attachments — rendered from the SAME lean read the metrics
// board uses, so the inbox and the board can never disagree.
//
// Gated by SIMPLE_NIGHTLY_EMAIL_ENABLED (default off). Recipients from
// SIMPLE_NIGHTLY_RECIPIENTS (comma list, default mgray).

const fs = require("fs");
const path = require("path");
const { ROOT_DIR } = require("../../shared-config/src");
const { sendMail } = require("./mailerService");
const {
  buildSimpleNightlySummary,
  listFailedPayments,
  listLongCalls,
} = require("./simpleMarketingReadService");

function money(value) {
  const num = Number(value) || 0;
  const sign = num < 0 ? "-" : "";
  return `${sign}$${Math.abs(num).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function simpleNightlyEmailEnabled() {
  return String(process.env.SIMPLE_NIGHTLY_EMAIL_ENABLED ?? "false") === "true";
}

function resolveNightlyEmailMode({
  legacyEnabled = false,
  simpleEnabled = simpleNightlyEmailEnabled(),
  explicitlyDisabled = false,
} = {}) {
  if (explicitlyDisabled) return { mode: "off", conflict: false };
  if (legacyEnabled && simpleEnabled) return { mode: "off", conflict: true };
  if (simpleEnabled) return { mode: "simple", conflict: false };
  if (legacyEnabled) return { mode: "legacy", conflict: false };
  return { mode: "off", conflict: false };
}

function simpleNightlyRecipients() {
  return String(process.env.SIMPLE_NIGHTLY_RECIPIENTS || "mgray@taxadvocategroup.com")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

// The 20:00 activity review persists its day rollup to disk; the 21:00
// close reads it back for the narrative. Absence is tolerated — the email
// says the counts are unavailable rather than inventing zeros.
function readActivityStatusCounts(dateKey, {
  outDir = path.join(ROOT_DIR, "runtime", "logics-activity-review"),
} = {}) {
  try {
    const file = path.join(outDir, `logics-activity-review-ALL-${dateKey}.json`);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const counts = parsed?.processed?.statusChangeCounts;
    return counts && !counts.error ? counts : null;
  } catch {
    return null;
  }
}

// "A summary email should go out as part of the night that says in a few
// sentences here's what happened with case statuses, money, and lead
// sources" (Mickey, 2026-07-27) — read straight from Logics Activities and
// the payment sheet. Three sentences, no adjectives, numbers only.
function buildNightlyNarrative({ summary, statusCounts = null } = {}) {
  const totals = summary?.totals || {};
  const lines = [];

  if (statusCounts) {
    const changed = Number(statusCounts.casesChanged || 0);
    lines.push(
      `Case statuses: ${Number(statusCounts.dnc || 0)} DNC'd and `
      + `${Number(statusCounts.postdate || 0)} post-dated today, per Logics activities `
      + `(${changed} case${changed === 1 ? "" : "s"} changed status).`,
    );
  } else {
    lines.push(`Case statuses: activity counts unavailable for ${summary?.dateKey || "today"} (review has not run).`);
  }

  const byDomain = (summary?.byDomain || [])
    .filter((row) => row.cashCollected !== 0)
    .sort((left, right) => right.cashCollected - left.cashCollected)
    .map((row) => `${row.domain} ${money(row.cashCollected)}`)
    .join(" / ");
  const restated = [
    ...(summary?.chargebackRestatement?.pushedOut || []),
    ...(summary?.chargebackRestatement?.pulledIn || []),
  ].length;
  const breakdown = totals.cashBreakdown || null;
  lines.push(
    `Money: ${Number(totals.initialsCount || 0)} new client${Number(totals.initialsCount || 0) === 1 ? "" : "s"} `
    + `for ${money(totals.initialsNet)} in initials; ${money(totals.cashCollected ?? totals.totalCollected)} cash collected`
    + (byDomain ? ` (${byDomain})` : "")
    + (breakdown
      ? ` — ${money(breakdown.initial)} new-client money, `
        + `${money(breakdown.recurringFromThisMonth)} recurring from this month's clients, `
        + `${money(breakdown.recurringFromOlderMonths + (breakdown.recurringUnknownVintage || 0))} from the back book`
      : "")
    + (restated ? `; ${restated} payment${restated === 1 ? "" : "s"} restated to the month of sale` : "")
    + ".",
  );

  const dealSources = (summary?.rows || [])
    .filter((row) => Number(row.initialsCount || 0) > 0)
    .sort((left, right) => Number(right.initialsCount) - Number(left.initialsCount))
    .map((row) => `${row.source} (${row.initialsCount})`)
    .join(", ");
  lines.push(
    `Lead sources: ${dealSources ? `deals from ${dealSources}; ` : "no deals attributed today; "}`
    + `${Number(totals.ldLeads || 0)} LD leads and ${Number(totals.uniqueLeads || 0)} mail responses in.`,
  );

  return lines;
}

function buildSimpleNightlyEmailData(summary, {
  statusCounts = null,
  longCalls = null,
  failedPayments = null,
  scope = "TAG + WYNN",
} = {}) {
  const { totals } = summary;
  return {
    headerTitle: "Daily Close",
    headerSub: summary.dateKey,
    dateKey: summary.dateKey,
    scopeLabel: scope,
    narrativeLines: buildNightlyNarrative({ summary, statusCounts }),
    // "any status change maybe worth noting" — the full category map from
    // Activities, not just the two headline counts.
    statusChangeRows: statusCounts?.byCategory
      ? Object.entries(statusCounts.byCategory)
        .map(([category, count]) => ({ category, count }))
        .sort((left, right) => right.count - left.count)
      : [],
    officers: (totals.cashByOfficer || [])
      .filter((row) => row.cash !== 0)
      .slice(0, 12)
      .map((row) => ({ ...row, cashLabel: money(row.cash) })),
    // Card-chasing list — body only, never a CSV row, never a dollar total.
    failedPayments: (failedPayments || []).map((row) => ({
      ...row,
      caseLabel: `${row.domain || ""} ${row.caseId}`.trim(),
      amountLabel: money(row.amount),
    })),
    longCalls: (longCalls || []).map((call) => ({
      ...call,
      caseLabel: call.caseId ? `${call.domain || ""} ${call.caseId}`.trim() : "",
      durationLabel: `${call.minutes}m`,
      pending: !call.listenUrl,
    })),
    tiles: [
      { label: "Spend", value: money(totals.spend) },
      { label: "Unique Leads", value: `${totals.uniqueLeads}` },
      { label: "New Clients", value: `${totals.initialsCount} · ${money(totals.initialsNet)}` },
      // Cash is the finance number — it ties to the bank. The attributed
      // total lives in the reconcile line below the table.
      { label: "Collected (cash)", value: money(totals.cashCollected ?? totals.totalCollected) },
    ],
    rows: summary.rows
      .filter(
        (row) =>
          row.responses > 0 || row.calls > 0 || row.spend > 0 || row.initialsCount !== 0,
      )
      .map((row) => ({
        ...row,
        spendLabel: row.spend > 0 ? money(row.spend) : "—",
        initialsAmountLabel: row.initialsAmount !== 0 ? money(row.initialsAmount) : "—",
      })),
    byDomain: (summary.byDomain || [])
      .filter((row) => row.deals !== 0 || row.initialsNet !== 0 || row.cashCollected !== 0)
      .sort((a, b) => b.cashCollected - a.cashCollected)
      .map((row) => ({
        ...row,
        initialsLabel: money(row.initialsNet),
        cashLabel: money(row.cashCollected),
      })),
    // Money that moved to the month that actually sold the deal. Shown so a
    // changed number is never silent — a reader can see WHY today's initials
    // differ from today's deposits.
    restatements: [
      ...(summary.chargebackRestatement?.pushedOut || []),
      ...(summary.chargebackRestatement?.pulledIn || []),
    ].map((entry) => ({
      ...entry,
      caseLabel: `${entry.domain}:${entry.caseId}`,
      amountLabel: money(entry.amount),
    })),
    restatementNote:
      "A first-invoice installment or a chargeback belongs to the month that sold the client, "
      + "not the month the money moved. Those months are restated, so a closed month can change.",
    reconcileLine: Number.isFinite(totals.cashCollected)
      && Math.abs(totals.cashCollected - totals.totalCollected) >= 0.005
      ? `Cash collected ${money(totals.cashCollected)} vs attributed ${money(totals.totalCollected)} — `
        + `${money(totals.totalCollected - totals.cashCollected)} sits in the month of the sale. `
        + `Use CASH to tie to the bank.`
      : `Cash collected ${money(totals.cashCollected ?? totals.totalCollected)} — ties to the bank.`,
    footerLine: `Parallel nightly · ${summary.dateKey} · ${totals.totalCalls} total calls · ${totals.ldLeads} LD leads · ${totals.paymentsCount} payments`,
    footerSmall: summary.feeds
      ? `Feeds — CallRail ${summary.feeds.callrail?.lastSyncedAt ? "ok" : "STALE"} · Spend ${summary.feeds.spend?.lastSyncedAt ? "ok" : "STALE"} · Payments ${summary.feeds.payments?.lastReconciledAt ? "ok" : "STALE"}`
      : null,
  };
}

// WYNN-only slice: "tag + wynn goes to everyone. Wynn only goes to other
// people" (Mickey, 2026-07-27). WYNN stakeholders see WYNN money, WYNN deal
// sources, and WYNN status counts — never TAG's numbers. Calls are NOT
// included: CallRail is one shared tenant, so calls cannot be split by
// company and a WYNN email must not imply otherwise.
function buildWynnNightlyEmailData(summary, { statusCounts = null } = {}) {
  const wynnMoney = (summary.byDomain || []).find((row) => row.domain === "WYNN")
    || { deals: 0, initialsNet: 0, cashCollected: 0 };
  const wynnCounts = statusCounts?.byDomain?.WYNN || null;
  const wynnDeals = summary.dealsBySourceByDomain?.WYNN || [];

  const lines = [];
  if (wynnCounts) {
    lines.push(
      `Case statuses: ${Number(wynnCounts.dnc || 0)} DNC'd and `
      + `${Number(wynnCounts.postdate || 0)} post-dated today, per Logics activities.`,
    );
  } else {
    lines.push(`Case statuses: activity counts unavailable for ${summary.dateKey}.`);
  }
  lines.push(
    `Money: ${wynnMoney.deals} new client${wynnMoney.deals === 1 ? "" : "s"} for `
    + `${money(wynnMoney.initialsNet)} in initials; ${money(wynnMoney.cashCollected)} cash collected.`,
  );
  lines.push(
    wynnDeals.length
      ? `Lead sources: deals from ${wynnDeals.map((row) => `${row.source} (${row.count})`).join(", ")}.`
      : "Lead sources: no deals attributed today.",
  );

  return {
    headerTitle: "WYNN Daily Close",
    headerSub: summary.dateKey,
    dateKey: summary.dateKey,
    scopeLabel: "WYNN",
    narrativeLines: lines,
    tiles: [
      { label: "New Clients", value: `${wynnMoney.deals} · ${money(wynnMoney.initialsNet)}` },
      { label: "Collected (cash)", value: money(wynnMoney.cashCollected) },
    ],
    rows: [],
    byDomain: [],
    restatements: [],
    officers: [],
    longCalls: [],
    statusChangeRows: wynnCounts
      ? [
        { category: "dnc", count: Number(wynnCounts.dnc || 0) },
        { category: "postdate", count: Number(wynnCounts.postdate || 0) },
      ].filter((row) => row.count > 0)
      : [],
    dealsBySource: wynnDeals.map((row) => ({
      ...row,
      amountLabel: money(row.amount),
    })),
    footerLine: `Parallel nightly · WYNN · ${summary.dateKey}`,
    footerSmall: null,
    reconcileLine: null,
    restatementNote: null,
  };
}

function wynnNightlyRecipients() {
  return String(process.env.SIMPLE_NIGHTLY_WYNN_RECIPIENTS || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function sendSimpleNightlyEmail({ dateKey, recipients = null, logger = null } = {}) {
  if (!simpleNightlyEmailEnabled()) {
    return { sent: false, skipped: true, reason: "SIMPLE_NIGHTLY_EMAIL_ENABLED=false" };
  }
  const summary = await buildSimpleNightlySummary({ dateKey });
  const statusCounts = readActivityStatusCounts(dateKey);
  let longCalls = null;
  try {
    longCalls = await listLongCalls({ dateKey });
  } catch {
    longCalls = null;
  }
  let failedPayments = null;
  try {
    failedPayments = await listFailedPayments({ from: dateKey, to: dateKey });
  } catch {
    failedPayments = null;
  }
  const data = buildSimpleNightlyEmailData(summary, {
    statusCounts, longCalls, failedPayments,
  });
  const to = Array.isArray(recipients) && recipients.length ? recipients : simpleNightlyRecipients();
  const result = await sendMail(null, {
    to,
    subject: `Daily Close ${summary.dateKey} — ${data.tiles[2].value} initials · ${money(summary.totals.spend)} spend`,
    template: "nightly/simple-close",
    data,
    text: [
      `Daily Close ${summary.dateKey}`,
      `Spend: ${money(summary.totals.spend)}`,
      `Unique leads: ${summary.totals.uniqueLeads} (${summary.totals.totalCalls} calls, ${summary.totals.ldLeads} LD leads)`,
      `Initials: ${summary.totals.initialsCount} for ${money(summary.totals.initialsNet)}`,
      `Total collected: ${money(summary.totals.totalCollected)}`,
    ].join("\n"),
  });
  logger?.info?.("simple_nightly_email.sent", { dateKey: summary.dateKey, to });

  // Second audience: the WYNN-only slice, when a list is configured.
  let wynn = { sent: false, skipped: true, reason: "SIMPLE_NIGHTLY_WYNN_RECIPIENTS unset" };
  const wynnTo = wynnNightlyRecipients();
  if (wynnTo.length) {
    try {
      const wynnData = buildWynnNightlyEmailData(summary, { statusCounts });
      const wynnResult = await sendMail(null, {
        to: wynnTo,
        subject: `WYNN Daily Close ${summary.dateKey} — ${wynnData.tiles[0].value}`,
        template: "nightly/simple-close",
        data: wynnData,
        text: wynnData.narrativeLines.join("\n"),
      });
      wynn = { sent: true, recipients: wynnTo, messageId: wynnResult.messageId };
      logger?.info?.("simple_nightly_email.wynn_sent", { dateKey: summary.dateKey, to: wynnTo });
    } catch (error) {
      wynn = { sent: false, error: String(error.message).slice(0, 200) };
      logger?.warn?.("simple_nightly_email.wynn_failed", { error: wynn.error });
    }
  }

  return { sent: true, recipients: to, messageId: result.messageId, wynn };
}

module.exports = {
  buildNightlyNarrative,
  buildWynnNightlyEmailData,
  readActivityStatusCounts,
  buildSimpleNightlyEmailData,
  resolveNightlyEmailMode,
  sendSimpleNightlyEmail,
  simpleNightlyEmailEnabled,
};
