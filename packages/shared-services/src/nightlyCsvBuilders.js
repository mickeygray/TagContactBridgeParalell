"use strict";

// CSV builders for the nightly close emails.
// All return `{ filename, content, contentType, encoding }` shaped for
// nodemailer attachments — content is a Buffer, not base64. (The legacy
// SendGrid v3 API needed base64; nodemailer takes raw bytes.)
//
// Builders are pure functions of their input payloads — no DB access
// here. The caller (nightlyCloseService) is responsible for assembling
// the payloads from snapshot/repo reads.

function csvCell(value) {
  const s = value == null ? "" : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""').replace(/\r?\n/g, " ")}"`;
  return s;
}

function csvRow(cells) {
  return cells.map(csvCell).join(",");
}

function buildCsvBuffer(rows) {
  return Buffer.from(rows.join("\n") + "\n", "utf8");
}

function num(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function moneyCell(value) {
  return num(value).toFixed(2);
}

// ── 1. Financial close CSV — today vs MTD ────────────────────────────
//
// Compact: one column for today, one for MTD. Top-line metrics stack
// vertically. Then a per-channel spend block, then a per-source new-
// deals block. Used by Pool A (financial close email).
function buildFinancialCsv({
  domain,
  dateKey,
  daily,
  mtd,
  dealsBySource = [],
  spendByChannel = [],
  dealsByCase = [],
  failedPayments = [],
  mtdRoiBySource = [],
}) {
  const rows = [];
  rows.push(csvRow(["[FINANCIAL CLOSE]", domain, dateKey]));
  rows.push("");

  // Topline daily-vs-MTD.
  rows.push(csvRow(["[TOPLINE — TODAY VS MTD]"]));
  rows.push(csvRow(["metric", "today", "mtd"]));
  rows.push(csvRow(["leads_total", daily.leads.total, mtd.leads.total]));
  rows.push(csvRow(["calls_total", num(daily.calls.total), num(mtd.calls.total)]));
  rows.push(csvRow(["calls_over_5min", num(daily.calls.callsOver5), num(mtd.calls.callsOver5)]));
  rows.push(csvRow(["spend_total", moneyCell(daily.spend.total), moneyCell(mtd.spend.total)]));
  rows.push(csvRow(["spend_pieces", num(daily.spend.pieces), num(mtd.spend.pieces)]));
  rows.push(csvRow(["payments_total_amount", moneyCell(daily.payments.totalAmount), moneyCell(mtd.payments.totalAmount)]));
  rows.push(csvRow(["payments_total_count", num(daily.payments.totalCount), num(mtd.payments.totalCount)]));
  rows.push(csvRow(["payments_initial_amount", moneyCell(daily.payments.initialAmount), moneyCell(mtd.payments.initialAmount)]));
  rows.push(csvRow(["payments_initial_count", num(daily.payments.initialCount), num(mtd.payments.initialCount)]));
  rows.push(csvRow(["payments_recurring_amount", moneyCell(daily.payments.recurringAmount), moneyCell(mtd.payments.recurringAmount)]));
  rows.push(csvRow(["payments_recurring_count", num(daily.payments.recurringCount), num(mtd.payments.recurringCount)]));
  rows.push(csvRow(["failed_payments_today", num(failedPayments.length), "—"]));
  rows.push("");

  // MTD ROI by source — same column shape as the metrics-page CSV
  // export. One row per (source, channel) with derived ratios.
  rows.push(csvRow(["[MTD ROI BY SOURCE]", `${mtd.monthStart || ""} → ${mtd.monthEnd || ""}`]));
  rows.push(csvRow([
    "Source", "Channel", "Spend", "Pieces", "Calls", "Calls_Over_5m",
    "Leads", "Deals", "Initials", "Paid",
    "CPL", "CPA", "ROAS", "ROI",
  ]));
  for (const r of mtdRoiBySource) {
    rows.push(csvRow([
      r.source || "",
      r.channel || "",
      moneyCell(r.spend),
      num(r.pieces),
      num(r.calls),
      num(r.callsOver5),
      num(r.leads),
      num(r.deals),
      moneyCell(r.initials),
      moneyCell(r.paid),
      r.cpl != null ? r.cpl.toFixed(2) : "",
      r.cpa != null ? r.cpa.toFixed(2) : "",
      r.roas != null ? r.roas.toFixed(4) : "",
      r.roi != null ? r.roi.toFixed(4) : "",
    ]));
  }
  rows.push("");

  rows.push(csvRow(["[SPEND BY CHANNEL — TODAY]"]));
  rows.push(csvRow(["channel", "spend", "pieces", "leads_reported"]));
  for (const r of spendByChannel) {
    rows.push(csvRow([r.channel, moneyCell(r.spend), num(r.pieces), num(r.leadsReported)]));
  }
  rows.push("");

  rows.push(csvRow(["[NEW DEALS BY SOURCE — TODAY]"]));
  rows.push(csvRow(["source", "deals", "initial_amount", "total_collected"]));
  for (const r of dealsBySource) {
    rows.push(csvRow([r.source, num(r.deals), moneyCell(r.initialPayments), moneyCell(r.totalCollected)]));
  }
  rows.push("");

  // Per-case detail. One row per casePaymentId — the dedup key — so
  // the count here always matches `dealsBySource` totals. The conflict
  // column makes attribution holes audit-able.
  rows.push(csvRow(["[DEALS — CASE DETAIL — TODAY]"]));
  rows.push(csvRow([
    "domain", "case_id", "case_payment_id", "name", "amount",
    "attributed_source", "attributed_channel", "attribution_path", "conflict",
    "source_parallel", "channel_parallel", "source_canonical_id",
    "source_legacy", "channel_legacy",
    "source_profile", "channel_profile",
  ]));
  for (const r of dealsByCase) {
    rows.push(csvRow([
      r.domain || domain,
      r.caseId || "",
      r.casePaymentId || "",
      r.name || "",
      moneyCell(r.amount),
      r.sourceName || "",
      r.sourceChannel || "",
      r.attributionPath || "",
      r.conflict ? "yes" : "",
      r.sourceName_parallel || "",
      r.sourceChannel_parallel || "",
      r.sourceCanonicalId || "",
      r.sourceName_legacy || "",
      r.sourceChannel_legacy || "",
      r.sourceName_profile || "",
      r.sourceChannel_profile || "",
    ]));
  }
  rows.push("");

  // Failed payments today (replaces the redline-alert email).
  rows.push(csvRow(["[FAILED PAYMENTS — TODAY]"]));
  rows.push(csvRow([
    "domain", "case_id", "name", "phone", "amount", "attempts",
    "status", "comment",
  ]));
  for (const a of failedPayments) {
    rows.push(csvRow([
      a.domain || domain,
      a.caseId || "",
      a.name || "",
      a.phoneFormatted || a.phone || "",
      moneyCell(a.declinedAmount || a.amount),
      num(a.attempts),
      a.lastTransactionStatus || a.status || "",
      a.lastTransactionComment || a.comment || "",
    ]));
  }
  rows.push("");

  rows.push(csvRow(["[LEADS BY SOURCE — TODAY VS MTD]"]));
  rows.push(csvRow(["source", "today", "mtd"]));
  const dailyMap = new Map((daily.leads.entries || []).map((r) => [r.source, num(r.count)]));
  const mtdMap = new Map((mtd.leads.entries || []).map((r) => [r.source, num(r.count)]));
  const allSources = new Set([...dailyMap.keys(), ...mtdMap.keys()]);
  for (const src of [...allSources].sort()) {
    rows.push(csvRow([src, dailyMap.get(src) || 0, mtdMap.get(src) || 0]));
  }

  return {
    filename: `${domain}-financial-close-${dateKey}.csv`,
    content: buildCsvBuffer(rows),
    contentType: "text/csv",
  };
}

// ── 2. Vendor per-source CSV — Pool B ────────────────────────────────
//
// One row per (family, source). Columns track exactly what the user
// asked for: leads, calls today and their scores by vendor, outcome
// changes, money in.
function buildVendorCsv({ domain, dateKey, vendorRows = [], vendorFamilies = [] }) {
  const rows = [];
  rows.push(csvRow(["[VENDOR DAILY ROLLUP]", domain, dateKey]));
  rows.push("");

  rows.push(csvRow(["[BY FAMILY]"]));
  rows.push(csvRow([
    "family", "leads", "calls", "calls_over_5min", "scored_calls",
    "average_score", "hot", "warm", "cold", "dead", "fake",
    "deals_today", "postdate_today", "dnc_today", "redline_today",
    "initial_payments", "total_collected",
  ]));
  for (const r of vendorFamilies) {
    rows.push(csvRow([
      r.familyLabel || r.familyKey || "Unknown",
      num(r.leads), num(r.calls), num(r.callsOver5), num(r.scoredCalls),
      r.averageScore ?? "",
      num(r.hot), num(r.warm), num(r.cold), num(r.dead), num(r.fake),
      num(r.dealsToday), num(r.postdateToday), num(r.dncToday), num(r.redlineToday),
      moneyCell(r.initialPayments), moneyCell(r.totalCollected),
    ]));
  }
  rows.push("");

  rows.push(csvRow(["[BY SOURCE]"]));
  rows.push(csvRow([
    "source", "channel", "spend", "leads", "calls", "calls_over_5min",
    "scored_calls", "average_score", "hot", "warm", "cold", "dead", "fake",
    "deals_today", "postdate_today", "dnc_today", "redline_today",
    "initial_payments", "total_collected",
  ]));
  for (const r of vendorRows) {
    rows.push(csvRow([
      r.source || "Unknown",
      r.channel || "",
      moneyCell(r.spend),
      num(r.leads), num(r.calls), num(r.callsOver5), num(r.scoredCalls),
      r.averageScore ?? "",
      num(r.hot), num(r.warm), num(r.cold), num(r.dead), num(r.fake),
      num(r.dealsToday), num(r.postdateToday), num(r.dncToday), num(r.redlineToday),
      moneyCell(r.initialPayments), moneyCell(r.totalCollected),
    ]));
  }

  return {
    filename: `${domain}-vendor-rollup-${dateKey}.csv`,
    content: buildCsvBuffer(rows),
    contentType: "text/csv",
  };
}

// ── 3. Today's call log CSV — Pool B sidecar ─────────────────────────
//
// One row per call activity for the day. Useful for sales-team review
// and the rawest "what calls came in" view.
function buildLeadReconciliationCsv({ domain, dateKey, leads = [] }) {
  const rows = [];
  rows.push(csvRow([
    "date", "created_at", "domain", "case_id", "logics_result",
    "name", "phone", "email", "source_family", "source_family_key",
    "source", "channel", "intake_source", "intake_route",
    "current_stage", "active",
  ]));
  for (const lead of leads) {
    const caseId = lead.caseId || "";
    rows.push(csvRow([
      lead.date || dateKey,
      lead.createdAt || "",
      lead.domain || domain,
      caseId,
      caseId ? "logics_case_created" : "accepted_without_case",
      lead.name || "",
      lead.phone || "",
      lead.email || "",
      lead.sourceFamily || "",
      lead.sourceFamilyKey || "",
      lead.sourceName || "",
      lead.sourceChannel || "",
      lead.intakeSource || "",
      lead.intakeRoute || "",
      lead.currentStage || "",
      lead.active || "",
    ]));
  }
  return {
    filename: `${domain}-lead-reconciliation-${dateKey}.csv`,
    content: buildCsvBuffer(rows),
    contentType: "text/csv",
  };
}

function buildCallLogCsv({ domain, dateKey, calls = [] }) {
  const rows = [];
  rows.push(csvRow([
    "date", "time", "agent", "direction", "phone", "name",
    "duration_sec", "disposition", "source", "channel",
    "case_id", "recording_available", "transcript_available",
    "transcription_status", "score", "verdict", "score_summary",
    "telephony_session_id", "missed",
  ]));
  for (const c of calls) {
    const at = c.callStartTime || c.createdAt || null;
    const d = at ? new Date(at) : null;
    const durationSec = c.durationSeconds ?? c.durationSec ?? c.duration ?? 0;
    const score = c.callScore?.overall ?? c.scoreOverall ?? c.score ?? "";
    const verdict = c.callScore?.lead_verdict ?? c.scoreVerdict ?? c.verdict ?? "";
    const summary = c.callScore?.summary ?? c.scoreSummary ?? c.summary ?? "";
    rows.push(csvRow([
      d ? d.toLocaleDateString("en-US") : "",
      d ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "",
      c.agentName || "",
      c.direction || "",
      c.phoneFormatted || c.phone || "",
      c.callerName || c.contactName || "",
      num(durationSec),
      c.disposition || "",
      c.sourceName || "",
      c.sourceChannel || "",
      c.caseId || "",
      c.recordingAvailable || c.recordingAvailable === true ? c.recordingAvailable : "",
      c.transcriptAvailable || c.transcriptAvailable === true ? c.transcriptAvailable : "",
      c.transcriptionStatus || "",
      score,
      verdict,
      summary,
      c.telephonySessionId || "",
      c.missed || "",
    ]));
  }
  return {
    filename: `${domain}-call-log-${dateKey}.csv`,
    content: buildCsvBuffer(rows),
    contentType: "text/csv",
  };
}

// ── 4. Redline CSV — Pool C ──────────────────────────────────────────
function buildRedlineCsv({ domain, dateKey, alerts = [] }) {
  const rows = [];
  rows.push(csvRow([
    "domain", "case_id", "name", "phone", "amount",
    "attempts", "status", "comment",
  ]));
  for (const a of alerts) {
    rows.push(csvRow([
      a.domain || domain,
      a.caseId || "",
      a.name || "",
      a.phoneFormatted || a.phone || "",
      moneyCell(a.declinedAmount || a.amount),
      num(a.attempts),
      a.lastTransactionStatus || a.status || "",
      a.lastTransactionComment || a.comment || "",
    ]));
  }
  return {
    filename: `${domain}-payment-alerts-${dateKey}.csv`,
    content: buildCsvBuffer(rows),
    contentType: "text/csv",
  };
}

module.exports = {
  buildFinancialCsv,
  buildLeadReconciliationCsv,
  buildVendorCsv,
  buildCallLogCsv,
  buildRedlineCsv,
};
