"use strict";

// One-off: build + send the cross-domain nightly emails for a given
// date as if the scheduled close had run. Three emails by default:
//   - Financial / topline   → cross-domain (TAG + WYNN combined)
//   - Vendor lead-data      → WYNN only (LD posting / affiliate / social)
//   - Ops status            → cross-domain, dev only
// Plus redline alert if any failed payments landed for the date.
//
//   node scripts/nightly-close-oneoff.js                     # yesterday in PT, both domains
//   node scripts/nightly-close-oneoff.js --date 2026-04-30
//   node scripts/nightly-close-oneoff.js --domains TAG,WYNN
//   node scripts/nightly-close-oneoff.js --to mgray@taxadvocategroup.com
//   node scripts/nightly-close-oneoff.js --domain TAG        # legacy single-domain mode (one set of emails)

require("dotenv").config({
  path: require("path").resolve(__dirname, "..", ".env"),
});

const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
const {
  runGroupedNightlyClose,
  buildManagementSnapshot,
  buildMonthToDateSnapshot,
  buildVendorReport,
  buildTransitionsBySource,
  buildDealsBySource,
  buildSpendByChannel,
  buildTodaysCalls,
  buildTodaysPaymentAlerts,
  buildOpenServiceAlerts,
  sendFinancialCloseEmail,
  sendLeadDataCloseEmail,
  sendRedlineAlertEmail,
  sendOpsStatusEmail,
  wrapHourlyJobs,
} = require("../packages/shared-services/src");
const { getSharedConfig } = require("../packages/shared-config/src");
const { getCompanyConfig } = require("../packages/shared-config/src");

function readFlag(argv, name) {
  const prefixed = argv.find((a) => a.startsWith(`${name}=`));
  if (prefixed) return prefixed.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1) return argv[idx + 1];
  return null;
}

function yesterdayInTz(timeZone = "America/Los_Angeles") {
  const now = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function logHeader(line) {
  // eslint-disable-next-line no-console
  console.log(`\n══ ${line}`);
}

function logKv(key, value) {
  // eslint-disable-next-line no-console
  console.log(`  ${String(key).padEnd(28, " ")} ${value}`);
}

function logResult(label, result) {
  if (!result) {
    logKv(`${label}.sent`, "no-result");
    return;
  }
  logKv(`${label}.sent`, result.sent);
  if (result.sent && result.recipients) logKv(`${label}.recipients`, result.recipients.join(", "));
  if (result.error) logKv(`${label}.error`, result.error);
  if (result.skipped) logKv(`${label}.skipped`, result.reason || "yes");
}

async function runGrouped({ domains, dateKey, to, vendorDomain }) {
  logHeader(`grouped close — ${domains.join(" + ")} ${dateKey}`);
  const opts = {
    date: dateKey,
    vendorDomain,
    sendDomain: domains.includes("TAG") ? "TAG" : domains[0],
  };
  if (to) {
    opts.financialEmail = { recipients: [to] };
    opts.leadDataEmail = { recipients: [to] };
    opts.redlineEmail = { recipients: [to] };
    opts.opsEmail = { recipients: [to] };
  }
  const out = await runGroupedNightlyClose(domains, opts);

  logKv("payload.leads.total", out.payload.managementSnapshot.leads.total);
  logKv("payload.payments.total", `$${out.payload.managementSnapshot.payments.totalAmount.toFixed(2)}`);
  logKv("payload.spend.total", `$${out.payload.managementSnapshot.spend.total.toFixed(2)}`);
  logKv("payload.calls.total", out.payload.managementSnapshot.calls.total);
  logKv("payload.todaysAlerts", out.payload.todaysAlerts.length);
  logKv("payload.openServiceAlerts", out.payload.openServiceAlerts.length);
  logKv("payload.vendor.rows", (out.payload.vendorReport.rows || []).length);
  logKv("payload.dealsByCase", (out.payload.dealsByCase || []).length);
  if (out.payload.attributionRefresh) {
    const ar = out.payload.attributionRefresh;
    logKv("attribution.casesWalked", ar.casesWalked || 0);
    logKv("attribution.profilesUpdated", ar.caseProfileUpdates || 0);
    logKv("attribution.ledgerRowsFixed", ar.paymentLedgerUpdates || 0);
    logKv("attribution.conflicts", ar.conflicts || 0);
    if (ar.error) logKv("attribution.error", ar.error);
    if (Array.isArray(ar.audit)) {
      for (const row of ar.audit) {
        logKv(
          `  audit ${row.domain}#${row.caseId}`,
          `${row.previousSource || "(none)"} → ${row.resolved?.internalName || "unresolved"} via ${row.resolved?.matchedBy || "—"}${row.update?.caseProfile ? " [profile updated]" : ""}${row.update?.paymentLedger ? ` [+${row.update.paymentLedger} ledger rows]` : ""}`,
        );
      }
    }
  }

  logResult("financial", out.results.financial);
  logResult("leadData", out.results.leadData);
  logResult("redline", out.results.redline);
  logResult("ops", out.results.ops);

  return out;
}

async function runSingleDomain({ domain, dateKey, to }) {
  logHeader(`single-domain close — ${domain} ${dateKey}`);
  const company = getCompanyConfig(domain);
  const timeZone = company.cadence?.timezone || "America/Los_Angeles";

  const managementSnapshot = await buildManagementSnapshot(domain, dateKey, timeZone);
  const monthToDate = await buildMonthToDateSnapshot(domain, dateKey, timeZone);
  const vendorReport = await buildVendorReport(domain, dateKey, { timezone: timeZone });

  const [
    transitions,
    dealsBySource,
    spendByChannel,
    todaysCalls,
    todaysAlerts,
    openServiceAlerts,
  ] = await Promise.all([
    buildTransitionsBySource(domain, dateKey, timeZone).catch(() => []),
    buildDealsBySource(domain, dateKey).catch(() => []),
    buildSpendByChannel(domain, dateKey).catch(() => []),
    buildTodaysCalls(domain, dateKey, timeZone).catch(() => []),
    buildTodaysPaymentAlerts(domain, dateKey).catch(() => []),
    buildOpenServiceAlerts(domain, 15).catch(() => []),
  ]);
  const bugWrap = await wrapHourlyJobs(domain, dateKey, {
    timezone: timeZone,
    pruneResolved: false,
  }).catch(() => ({ unresolved: [], unresolvedCount: 0, prunedResolved: 0 }));

  const recip = to ? { recipients: [to] } : {};

  const fin = await sendFinancialCloseEmail(domain, {
    date: dateKey, managementSnapshot, monthToDate, dealsBySource, spendByChannel, hygiene: {},
  }, recip).catch((e) => ({ sent: false, error: e.message, pool: "financial" }));
  const ld = await sendLeadDataCloseEmail(domain, {
    date: dateKey, managementSnapshot, vendorReport, bugWrap, transitions, todaysCalls,
  }, recip).catch((e) => ({ sent: false, error: e.message, pool: "leadData" }));
  const rl = todaysAlerts.length > 0
    ? await sendRedlineAlertEmail(domain, { date: dateKey, alerts: todaysAlerts }, recip)
        .catch((e) => ({ sent: false, error: e.message, pool: "redline" }))
    : { sent: false, skipped: true, reason: "no-alerts", pool: "redline" };
  const ops = await sendOpsStatusEmail(domain, {
    date: dateKey,
    spendSync: { ok: true, skipped: true, reason: "one-off" },
    paymentSweep: { casesScanned: 0, newLedgerRows: 0, flaggedFailures: 0 },
    bugWrap,
    attributionReview: vendorReport.attributionReview || {},
    openServiceAlerts,
    leadIntake: managementSnapshot.leads,
  }, recip).catch((e) => ({ sent: false, error: e.message, pool: "ops" }));

  logResult("financial", fin);
  logResult("leadData", ld);
  logResult("redline", rl);
  logResult("ops", ops);
}

async function main() {
  const argv = process.argv.slice(2);
  const single = readFlag(argv, "--domain");
  const domainsFlag = readFlag(argv, "--domains");
  const domains = domainsFlag
    ? domainsFlag.split(",").map((d) => d.trim().toUpperCase()).filter(Boolean)
    : ["TAG", "WYNN"];
  const dateKey = readFlag(argv, "--date") || yesterdayInTz();
  const to = readFlag(argv, "--to");
  const vendorDomain = (readFlag(argv, "--vendor-domain") || "WYNN").toUpperCase();

  logHeader(`nightly-close-oneoff`);
  logKv("date", dateKey);
  logKv("recipient override", to || "(use development pool)");

  await connectMongo(getSharedConfig());

  try {
    if (single) {
      await runSingleDomain({ domain: single.toUpperCase(), dateKey, to });
    } else {
      await runGrouped({ domains, dateKey, to, vendorDomain });
    }
    logHeader("Done");
  } finally {
    await disconnectMongo();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("nightly-close-oneoff failed:", err);
  process.exitCode = 1;
});
