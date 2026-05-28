"use strict";

const fs = require("fs");
const path = require("path");

const { createLogicsClient } = require("../../shared-integrations/src");
const {
  ROOT_DIR,
  getInternalFromEmail,
} = require("../../shared-config/src");
const {
  createLogicsFacade,
  parseLogicsData,
} = require("./logicsFacadeService");
const { sendMail } = require("./mailerService");

const DEFAULT_DOMAIN = "TAG";
const DEFAULT_TIMEZONE = "America/Los_Angeles";
const DEFAULT_REPORT_NAME = "ActivityReport";
const DEFAULT_OUT_DIR = path.join(ROOT_DIR, "runtime", "logics-activity-review");
const DEFAULT_REPORT_EMAIL = "documents@taxadvocategroup.com";
const DEFAULT_REVIEW_RECIPIENTS = [
  "mgray@taxadvocategroup.com",
  "manderson@taxadvocategroup.com",
];

const DEFAULT_NOTICE_RULES = Object.freeze([
  { name: "LT11", pattern: /\bLT[-\s]?11\b/i },
  { name: "Letter 1058", pattern: /\b(letter\s*)?1058\b/i },
  { name: "LT16", pattern: /\bLT[-\s]?16\b/i },
  { name: "CP504", pattern: /\bCP[-\s]?504\b/i },
  { name: "CP503", pattern: /\bCP[-\s]?503\b/i },
  { name: "CP501", pattern: /\bCP[-\s]?501\b/i },
  { name: "CP14", pattern: /\bCP[-\s]?14\b/i },
  { name: "CDP", pattern: /\bCDP\b|collection due process/i },
  { name: "Final Notice", pattern: /final notice/i },
  { name: "Intent to Levy", pattern: /intent to levy|notice of levy|proposed levy/i },
  { name: "Lien", pattern: /tax lien|\blien\b/i },
  { name: "Levy", pattern: /\blevy\b/i },
  { name: "IRS Notice", pattern: /\bIRS\b.*\bnotice\b|\bnotice\b.*\bIRS\b/i },
  { name: "State Notice", pattern: /\bFTB\b|\bstate\b.*\bnotice\b|\bnotice\b.*\bstate\b/i },
]);

const DEFAULT_DOCUMENT_EXCLUDE_RULES = Object.freeze([
  {
    name: "WIT",
    pattern: /(?:^|[^a-z0-9])w[\s_&/-]*i[\s_&/-]*t(?:[^a-z0-9]|$)|wage.*income.*transcript|wage[\s_-]*income/i,
  },
  { name: "Tax Analysis", pattern: /tax[\s_-]*analysis/i },
  {
    name: "POA",
    pattern: /(?:^|[^a-z0-9])poa(?:[^a-z0-9]|$)|power[\s_-]+of[\s_-]+attorney|(?:^|[^0-9])2848(?:[^0-9]|$)|(?:^|[^0-9])8821(?:[^0-9]|$)/i,
  },
  { name: "Soft Pull", pattern: /i?soft[\s_-]*pull/i },
]);

const DEFAULT_DOCUMENT_INCLUDE_RULES = Object.freeze([
  { name: "LT", pattern: /(?:^|[^a-z0-9])LT[\s_-]*[A-Z0-9]*/i },
  { name: "CP", pattern: /(?:^|[^a-z0-9])CP[\s_-]*[A-Z0-9]*/i },
  { name: "668", pattern: /(?:^|[^0-9])668(?:[^0-9]|$)/ },
]);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function clean(value, max = 5000) {
  return String(value ?? "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function parseList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeDateKey(value, timeZone = DEFAULT_TIMEZONE) {
  const raw = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const date = raw ? new Date(raw) : new Date();
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${value}`);
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function addDaysToDateKey(dateKey, days) {
  const [year, month, day] = normalizeDateKey(dateKey).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function yesterdayInTz(timeZone = DEFAULT_TIMEZONE, now = new Date()) {
  return addDaysToDateKey(normalizeDateKey(now, timeZone), -1);
}

function formatLogicsReportDate(dateKey) {
  const normalized = normalizeDateKey(dateKey);
  const [year, month, day] = normalized.split("-");
  return `${month}/${day}/${year}`;
}

function parseDateMs(value) {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function formatCsvValue(value) {
  const text = value == null ? "" : String(value);
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, "\"\"")}"`;
  return text;
}

function writeCsv(file, rows, columns) {
  const lines = [
    columns.join(","),
    ...rows.map((row) => columns.map((col) => formatCsvValue(row[col])).join(",")),
  ];
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
}

function writeJson(file, data) {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function pick(row, names) {
  for (const name of names) {
    if (row && row[name] !== undefined && row[name] !== null && String(row[name]).trim() !== "") {
      return row[name];
    }
  }
  const lowerMap = new Map(
    Object.keys(row || {}).map((key) => [key.toLowerCase().replace(/[^a-z0-9]/g, ""), key]),
  );
  for (const name of names) {
    const hit = lowerMap.get(String(name).toLowerCase().replace(/[^a-z0-9]/g, ""));
    if (hit && String(row[hit] ?? "").trim() !== "") return row[hit];
  }
  return null;
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length >= 10) return digits.slice(-10);
  return digits;
}

function parseMoney(value) {
  const number = Number(String(value ?? "").replace(/[$,%\s,]/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function formatMoney(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : "";
}

function extractDocumentNameFromText(value) {
  const text = clean(value);
  const match =
    text.match(/Document name:\s*(.*?)\s*Comment:/i) ||
    text.match(/Document name:\s*(.*)$/i);
  return match ? match[1].trim() : null;
}

function extractDocumentName(row) {
  return clean(
    pick(row, [
      "DocumentName",
      "Document Name",
      "FileName",
      "File Name",
      "Filename",
      "AttachmentName",
      "Attachment",
    ]) ||
      extractDocumentNameFromText(
        pick(row, ["Comment", "Notes", "Description", "Body", "ActivityText"]),
      ),
    500,
  );
}

function extractReportRows(result) {
  const data = parseLogicsData(result);
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.Data)) return data.Data;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

function summarizeReportResult(result) {
  const data = parseLogicsData(result);
  return {
    success: data?.Success ?? data?.success ?? null,
    message: clean(data?.Message ?? data?.message ?? "", 300),
    statusCode: data?.StatusCode ?? data?.statusCode ?? null,
    timestamp: clean(data?.Timestamp ?? data?.timestamp ?? "", 80),
    rowCount: extractReportRows(data).length,
  };
}

function regexRulesFromEnv(raw, fallbackRules) {
  const text = String(raw || "").trim();
  if (!text) return fallbackRules;
  if (/^(none|off|false)$/i.test(text)) return [];
  return text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((name) => ({
      name,
      pattern: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
    }));
}

function matchRules(text, rules) {
  const haystack = clean(text, 5000);
  const normalized = haystack.replace(/[_-]+/g, " ");
  return rules
    .filter((rule) => rule.pattern.test(haystack) || rule.pattern.test(normalized))
    .map((rule) => rule.name);
}

function getNoticeRules(options = {}) {
  return regexRulesFromEnv(options.noticeKeywords || process.env.LOGICS_ACTIVITY_NOTICE_KEYWORDS, DEFAULT_NOTICE_RULES);
}

function getDocumentExcludeRules(options = {}) {
  return regexRulesFromEnv(
    options.excludeKeywords || process.env.LOGICS_ACTIVITY_DOCUMENT_EXCLUDE_KEYWORDS,
    DEFAULT_DOCUMENT_EXCLUDE_RULES,
  );
}

function getDocumentIncludeRules(options = {}) {
  const raw = options.includeKeywords || process.env.LOGICS_ACTIVITY_DOCUMENT_INCLUDE_KEYWORDS;
  if (/^(all|any)$/i.test(String(raw || "").trim())) return [];
  return regexRulesFromEnv(raw, DEFAULT_DOCUMENT_INCLUDE_RULES);
}

function matchNotices(text, options = {}) {
  return matchRules(text, getNoticeRules(options));
}

function matchDocumentExclusions(text, options = {}) {
  return matchRules(text, getDocumentExcludeRules(options));
}

function matchDocumentIncludes(text, options = {}) {
  const rules = getDocumentIncludeRules(options);
  if (rules.length === 0) return ["Included"];
  return matchRules(text, rules);
}

function isDocumentUploadActivity(row) {
  const subject = clean(pick(row, ["Subject", "Activity Subject", "ActivitySubject", "Title"]));
  const type = clean(pick(row, ["ActivityType", "Activity Type", "Type"]));
  const comment = clean(pick(row, ["Comment", "Notes", "Description", "Body", "ActivityText"]), 1000);
  return /new document has been uploaded/i.test(subject) ||
    /document has been updated/i.test(subject) ||
    /new file uploaded/i.test(type) ||
    /Document name:/i.test(comment);
}

function documentExclusionText(row) {
  return [
    row.documentName,
    row.activitySubject,
    row.activityType,
    row.activityComment,
    row.subject,
    row.comment,
    row.type,
  ].filter(Boolean).join(" ");
}

function extractCaseId(row) {
  const value = pick(row, ["CaseID", "Case ID", "CaseId", "Case #", "Case", "Case Number", "CaseNumber"]);
  const number = Number(String(value ?? "").replace(/[^\d]/g, ""));
  return Number.isFinite(number) && number > 0 ? number : null;
}

function classifyActivityRows(rows, options = {}) {
  return rows
    .map((row, index) => {
      const caseId = extractCaseId(row);
      const documentName = extractDocumentName(row);
      const subject = clean(pick(row, ["Subject", "Activity Subject", "ActivitySubject", "Title"]));
      const activityType = clean(pick(row, ["ActivityType", "Activity Type", "Type"]));
      const comment = clean(pick(row, ["Comment", "Notes", "Description", "Body", "ActivityText"]), 3000);
      const uploadedAt = clean(pick(row, ["CreatedDate", "Created Date", "ActivityDate", "Activity Date", "Created", "Date"]));
      const createdBy = clean(pick(row, ["CreatedBy", "Created By", "User", "Agent", "Employee"]));
      const activityId = clean(pick(row, ["ActivityID", "Activity ID", "Id", "ID"]));
      const noticeMatches = matchNotices(`${documentName} ${subject} ${comment}`, options);
      return {
        row,
        index,
        caseId,
        activityId,
        uploadedAt,
        createdBy,
        activityType,
        subject,
        comment,
        documentName,
        noticeMatches,
      };
    })
    .filter((item) => item.caseId && isDocumentUploadActivity(item.row));
}

function parseStatusChangeSubject(subject) {
  const text = clean(subject, 1000);
  const quoted = [...text.matchAll(/"([^"]*)"/g)].map((match) => clean(match[1], 300));
  if (quoted.length >= 2) {
    return { fromStatus: quoted[0], toStatus: quoted[1] };
  }
  const match = text.match(/status\s+changed\s+from\s+(.+?)\s+to\s+(.+)$/i);
  if (!match) return { fromStatus: "", toStatus: "" };
  return {
    fromStatus: clean(match[1], 300).replace(/^"|"$/g, ""),
    toStatus: clean(match[2], 300).replace(/^"|"$/g, ""),
  };
}

function classifySuspendedStatusRows(rows) {
  return rows
    .map((row, index) => {
      const caseId = extractCaseId(row);
      const subject = clean(pick(row, ["Subject", "Activity Subject", "ActivitySubject", "Title"]));
      const activityType = clean(pick(row, ["ActivityType", "Activity Type", "Type"]));
      const changedAt = clean(pick(row, ["CreatedDate", "Created Date", "ActivityDate", "Activity Date", "Created", "Date"]));
      const changedBy = clean(pick(row, ["CreatedBy", "Created By", "User", "Agent", "Employee"]));
      const activityId = clean(pick(row, ["ActivityID", "Activity ID", "Id", "ID"]));
      const comment = clean(pick(row, ["Comment", "Notes", "Description", "Body", "ActivityText"]), 3000);
      const { fromStatus, toStatus } = parseStatusChangeSubject(subject);
      return {
        row,
        index,
        caseId,
        activityId,
        uploadedAt: changedAt,
        createdBy: changedBy,
        activityType,
        subject,
        comment,
        documentName: "",
        noticeMatches: [],
        fromStatus,
        toStatus,
      };
    })
    .filter((item) => item.caseId && /status\s+changed\s+from/i.test(item.subject) && /suspended/i.test(item.toStatus));
}

function parseStatusTier(statusName) {
  const text = String(statusName || "");
  const match = text.match(/\bT(?:IER)?\s*([1-5])\b/i);
  return match ? `T${match[1]}` : "";
}

function summarizeInvoices(invoices = []) {
  const rows = Array.isArray(invoices) ? invoices : [];
  const total = rows.reduce(
    (sum, row) => sum + (parseMoney(row.UnitPrice) * (Number(row.Quantity) || 1)),
    0,
  );
  const latest = [...rows].sort(
    (a, b) => parseDateMs(b.CreatedDate || b.Date) - parseDateMs(a.CreatedDate || a.Date),
  )[0] || null;
  return {
    invoiceCount: rows.length,
    invoiceTotal: total,
    latestInvoiceDescription: clean(latest?.Description || latest?.InvoiceTypeName || "", 300),
    latestInvoiceDate: clean(latest?.CreatedDate || latest?.Date || ""),
  };
}

function summarizeBilling(billing = {}) {
  return {
    totalFees: parseMoney(billing.TotalFees),
    paidAmount: parseMoney(billing.PaidAmount),
    paidPercentage: clean(billing.PaidPercentage || ""),
    balance: parseMoney(billing.Balance),
    amountDue: parseMoney(billing.AmountDue),
    dueDate: clean(billing.DueDate || ""),
    pastDue: parseMoney(billing.PastDue),
  };
}

function summarizeCaseInfo(caseInfo = {}) {
  const firstName = clean(caseInfo.FirstName || "");
  const lastName = clean(caseInfo.LastName || "");
  const statusName = clean(caseInfo.StatusName || caseInfo.Status || "");
  const statusTier = parseStatusTier(statusName);
  return {
    firstName,
    lastName,
    name: `${firstName} ${lastName}`.trim(),
    cell: normalizePhone(caseInfo.CellPhone || caseInfo.HomePhone || caseInfo.WorkPhone),
    rawCell: clean(caseInfo.CellPhone || caseInfo.HomePhone || caseInfo.WorkPhone || ""),
    email: clean(caseInfo.Email || ""),
    smsPermitted:
      caseInfo.SMSPermitted === true ||
      String(caseInfo.SMSPermitted).toLowerCase() === "true",
    statusId: caseInfo.StatusID ?? caseInfo.StatusId ?? "",
    statusName,
    statusTier,
    statusIsT1T4: ["T1", "T2", "T3", "T4"].includes(statusTier),
    taxLiability: parseMoney(caseInfo.TaxLiability),
    saleDate: clean(caseInfo.SaleDate || ""),
  };
}

async function mapLimit(items, limit, fn) {
  const output = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await fn(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, worker),
  );
  return output;
}

function findMatchingCaseActivity(activities, candidate) {
  const normalizedDoc = clean(candidate.documentName).toLowerCase();
  const activityId = String(candidate.activityId || "").trim();
  const candidateTime = parseDateMs(candidate.uploadedAt);
  const candidateBy = clean(candidate.createdBy).toLowerCase();
  const rows = (Array.isArray(activities) ? activities : []).map((row) => ({
    activityId: clean(row.ActivityID || row.Id || row.ID || ""),
    uploadedAt: clean(row.CreatedDate || row.Date || ""),
    createdBy: clean(row.CreatedBy || ""),
    activityType: clean(row.ActivityType || ""),
    subject: clean(row.Subject || ""),
    comment: clean(row.Comment || "", 3000),
    documentName: extractDocumentName(row),
  }));
  return rows.find((row) => activityId && row.activityId === activityId) ||
    rows.find((row) => normalizedDoc && clean(row.documentName).toLowerCase() === normalizedDoc) ||
    rows
      .filter((row) => isDocumentUploadActivity(row))
      .map((row) => ({
        row,
        score:
          (candidateBy && clean(row.createdBy).toLowerCase() === candidateBy ? 0 : 100000000) +
          (candidateTime ? Math.abs(parseDateMs(row.uploadedAt) - candidateTime) : 0),
      }))
      .filter((item) => !candidateTime || item.score < 100000000 + 15 * 60 * 1000)
      .sort((a, b) => a.score - b.score)[0]?.row ||
    {};
}

async function enrichCandidates(domain, candidates, options = {}) {
  if (candidates.length === 0) return [];
  const facade = createLogicsFacade(domain);
  const uniqueCaseIds = [...new Set(candidates.map((item) => item.caseId))];
  const concurrency = Math.max(1, Number(options.concurrency || 3) || 3);
  const caseCache = new Map();

  await mapLimit(uniqueCaseIds, concurrency, async (caseId) => {
    const entry = { caseId, ok: true, error: "" };
    try {
      const [info, billing, invoices, activities] = await Promise.all([
        facade.fetchCaseInfo(caseId),
        facade.fetchBillingSummary(caseId).catch((error) => ({ error: error.message })),
        facade.fetchInvoices(caseId).catch((error) => ({ error: error.message })),
        facade.fetchActivities(caseId).catch(() => []),
      ]);
      entry.caseInfo = info?.data || {};
      entry.caseInfoError = info?.ok === false ? info.error : "";
      entry.billing = billing && !billing.error ? billing : {};
      entry.billingError = billing?.error || "";
      entry.invoices = Array.isArray(invoices) ? invoices : [];
      entry.invoiceError = invoices?.error || "";
      entry.activities = Array.isArray(activities) ? activities : [];
    } catch (error) {
      entry.ok = false;
      entry.error = error.message;
    }
    caseCache.set(caseId, entry);
  });

  return candidates.map((candidate) => {
    const entry = caseCache.get(candidate.caseId) || {};
    const caseInfo = summarizeCaseInfo(entry.caseInfo || {});
    const billing = summarizeBilling(entry.billing || {});
    const invoices = summarizeInvoices(entry.invoices || []);
    const exactActivity = findMatchingCaseActivity(entry.activities || [], candidate);
    const documentName = candidate.documentName || exactActivity.documentName || "";
    const noticeMatches = [...new Set([
      ...candidate.noticeMatches,
      ...matchNotices(`${documentName} ${exactActivity.comment || ""}`, options),
    ])];

    return {
      domain,
      caseId: candidate.caseId,
      activityId: candidate.activityId || exactActivity.activityId || "",
      uploadedAt: candidate.uploadedAt || exactActivity.uploadedAt || "",
      createdBy: candidate.createdBy || exactActivity.createdBy || "",
      name: caseInfo.name,
      firstName: caseInfo.firstName,
      lastName: caseInfo.lastName,
      cell: caseInfo.cell,
      rawCell: caseInfo.rawCell,
      smsPermitted: caseInfo.smsPermitted ? "yes" : "no",
      email: caseInfo.email,
      statusId: caseInfo.statusId,
      statusName: caseInfo.statusName,
      clientTemperature: caseInfo.statusTier,
      statusIsT1T4: caseInfo.statusIsT1T4 ? "yes" : "no",
      taxLiability: caseInfo.taxLiability,
      saleDate: caseInfo.saleDate,
      documentName,
      noticeMatches: noticeMatches.join(" | "),
      fromStatus: candidate.fromStatus || "",
      toStatus: candidate.toStatus || "",
      activitySubject: candidate.subject || exactActivity.subject || "",
      activityType: candidate.activityType || exactActivity.activityType || "",
      activityComment: candidate.comment || exactActivity.comment || "",
      totalFees: billing.totalFees,
      paidAmount: billing.paidAmount,
      paidPercentage: billing.paidPercentage,
      balance: billing.balance,
      amountDue: billing.amountDue,
      dueDate: billing.dueDate,
      pastDue: billing.pastDue,
      invoiceCount: invoices.invoiceCount,
      invoiceTotal: invoices.invoiceTotal,
      latestInvoiceDate: invoices.latestInvoiceDate,
      latestInvoiceDescription: invoices.latestInvoiceDescription,
      caseInfoError: entry.caseInfoError || entry.error || "",
      billingError: entry.billingError || "",
      invoiceError: entry.invoiceError || "",
    };
  });
}

function outputColumns() {
  return [
    "caseId",
    "name",
    "cell",
    "documentsUploaded",
    "matchedTerms",
    "uploadCount",
    "firstUploadAt",
    "latestUploadAt",
    "totalFees",
    "paidAmount",
    "balance",
    "amountDue",
    "pastDue",
    "invoiceTotal",
    "latestInvoiceDate",
    "temperature",
    "tier",
  ];
}

function finalCsvRow(row) {
  const documentUploaded = row.documentName || row.activitySubject || row.activityType;
  return {
    name: row.name,
    cell: row.cell,
    documentUploaded,
    matchedTerms: row.noticeMatches || row.documentName || row.activitySubject || row.activityType,
    totalFees: formatMoney(row.totalFees),
    paidAmount: formatMoney(row.paidAmount),
    balance: formatMoney(row.balance),
    amountDue: formatMoney(row.amountDue),
    pastDue: formatMoney(row.pastDue),
    invoiceTotal: formatMoney(row.invoiceTotal),
    latestInvoiceDate: row.latestInvoiceDate,
    temperature: row.statusName,
    tier: row.clientTemperature,
  };
}

function uniqueJoined(values) {
  return [...new Set(values.map((value) => clean(value, 500)).filter(Boolean))].join(" | ");
}

function collapseRowsByCase(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = String(row.caseId || "");
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  return [...groups.values()]
    .map((caseRows) => {
      const sortedRows = [...caseRows].sort((a, b) => parseDateMs(a.uploadedAt) - parseDateMs(b.uploadedAt));
      const latest = sortedRows[sortedRows.length - 1] || sortedRows[0] || {};
      const base = finalCsvRow(latest);
      return {
        caseId: latest.caseId,
        name: latest.name,
        cell: latest.cell,
        documentsUploaded: uniqueJoined(sortedRows.map((row) => row.documentName || row.activitySubject || row.activityType)),
        matchedTerms: uniqueJoined(sortedRows.map((row) => row.noticeMatches || row.documentName || row.activitySubject || row.activityType)),
        uploadCount: sortedRows.length,
        firstUploadAt: sortedRows[0]?.uploadedAt || "",
        latestUploadAt: latest.uploadedAt || "",
        totalFees: base.totalFees,
        paidAmount: base.paidAmount,
        balance: base.balance,
        amountDue: base.amountDue,
        pastDue: base.pastDue,
        invoiceTotal: base.invoiceTotal,
        latestInvoiceDate: base.latestInvoiceDate,
        temperature: base.temperature,
        tier: base.tier,
      };
    })
    .sort((a, b) => parseDateMs(a.firstUploadAt) - parseDateMs(b.firstUploadAt));
}

function suspendedOutputColumns() {
  return [
    "caseId",
    "name",
    "cell",
    "statusChanges",
    "changedCount",
    "firstChangedAt",
    "latestChangedAt",
    "changedBy",
    "totalFees",
    "paidAmount",
    "balance",
    "amountDue",
    "pastDue",
    "invoiceTotal",
    "latestInvoiceDate",
    "temperature",
    "tier",
  ];
}

function statusChangeLabel(row) {
  if (row.fromStatus || row.toStatus) {
    return `${row.fromStatus || "(unknown)"} -> ${row.toStatus || "(unknown)"}`;
  }
  return row.activitySubject || "Status changed to Suspended";
}

function collapseSuspendedRowsByCase(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = String(row.caseId || "");
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  return [...groups.values()]
    .map((caseRows) => {
      const sortedRows = [...caseRows].sort((a, b) => parseDateMs(a.uploadedAt) - parseDateMs(b.uploadedAt));
      const latest = sortedRows[sortedRows.length - 1] || sortedRows[0] || {};
      const base = finalCsvRow(latest);
      return {
        caseId: latest.caseId,
        name: latest.name,
        cell: latest.cell,
        statusChanges: uniqueJoined(sortedRows.map(statusChangeLabel)),
        changedCount: sortedRows.length,
        firstChangedAt: sortedRows[0]?.uploadedAt || "",
        latestChangedAt: latest.uploadedAt || "",
        changedBy: uniqueJoined(sortedRows.map((row) => row.createdBy)),
        totalFees: base.totalFees,
        paidAmount: base.paidAmount,
        balance: base.balance,
        amountDue: base.amountDue,
        pastDue: base.pastDue,
        invoiceTotal: base.invoiceTotal,
        latestInvoiceDate: base.latestInvoiceDate,
        temperature: base.temperature,
        tier: base.tier,
      };
    })
    .sort((a, b) => parseDateMs(a.firstChangedAt) - parseDateMs(b.firstChangedAt));
}

function buildRangeKey(dateKey, startDateKey, endDateKey) {
  return startDateKey && endDateKey && startDateKey !== endDateKey
    ? `${startDateKey}_to_${endDateKey}`
    : dateKey;
}

async function processSuspendedStatusRows({ domain, rows, outDir, concurrency, rangeKey, options }) {
  const candidates = classifySuspendedStatusRows(rows);
  const enriched = await enrichCandidates(domain, candidates, { ...options, concurrency });
  const sorted = enriched.sort((a, b) => parseDateMs(a.uploadedAt) - parseDateMs(b.uploadedAt));
  const collapsedRows = collapseSuspendedRowsByCase(sorted);
  const outputDir = path.resolve(outDir || DEFAULT_OUT_DIR);
  ensureDir(outputDir);
  const csvOut = path.join(outputDir, `logics-suspended-status-${domain}-${rangeKey}.csv`);
  writeCsv(csvOut, collapsedRows, suspendedOutputColumns());
  return {
    statusChangeRows: candidates.length,
    outputRows: collapsedRows.length,
    uniqueCases: collapsedRows.length,
    csvOut,
    rows: sorted,
    collapsedRows,
  };
}

async function processActivityRows({
  domain,
  dateKey,
  startDateKey,
  endDateKey,
  rows,
  outDir,
  concurrency,
  source = "activity-report-api",
  sourceFile = "",
  options = {},
}) {
  const candidates = classifyActivityRows(rows, options);
  const enriched = await enrichCandidates(domain, candidates, { ...options, concurrency });
  const filtered = enriched
    .map((row) => ({
      row,
      exclusionMatches: matchDocumentExclusions(documentExclusionText(row), options),
      includeMatches: matchDocumentIncludes(documentExclusionText(row), options),
      excludedTier5:
        row.clientTemperature === "T5" ||
        /\btier\s*5\b|\[TIER 5\]/i.test(String(row.statusName || "")),
      eligibleClientTier: row.statusIsT1T4 === "yes",
    }))
    .filter(
      (entry) =>
        entry.exclusionMatches.length === 0 &&
        !entry.excludedTier5 &&
        entry.eligibleClientTier &&
        entry.includeMatches.length > 0,
    )
    .map((entry) => ({
      ...entry.row,
      noticeMatches: entry.row.noticeMatches || entry.includeMatches.join(" | "),
    }));
  const sorted = filtered.sort((a, b) => parseDateMs(a.uploadedAt) - parseDateMs(b.uploadedAt));
  const outputDir = path.resolve(outDir || DEFAULT_OUT_DIR);
  ensureDir(outputDir);
  const rangeKey = buildRangeKey(dateKey, startDateKey, endDateKey);
  const base = `logics-document-uploads-${domain}-${rangeKey}`;
  const csvOut = path.join(outputDir, `${base}.csv`);
  const jsonOut = path.join(outputDir, `${base}.json`);
  const suspended = await processSuspendedStatusRows({
    domain,
    rows,
    outDir,
    concurrency,
    rangeKey,
    options,
  });
  const collapsedRows = collapseRowsByCase(sorted);
  const uniqueCases = collapsedRows.length;
  writeCsv(csvOut, collapsedRows, outputColumns());
  writeJson(jsonOut, {
    ok: true,
    domain,
    date: dateKey,
    startDate: startDateKey || dateKey,
    endDate: endDateKey || dateKey,
    source,
    sourceFile,
    parsedRows: rows.length,
    documentUploadActivities: candidates.length,
    excludedActivities: enriched.length - filtered.length,
    matchedActivities: filtered.length,
    outputRows: collapsedRows.length,
    rowLevelOutputRows: sorted.length,
    uniqueCases,
    csvOut,
    jsonOut,
    suspendedCsvOut: suspended.csvOut,
    generatedAt: new Date().toISOString(),
    collapsedRows,
    rows: sorted,
    suspended,
  });
  return {
    parsedRows: rows.length,
    documentUploadActivities: candidates.length,
    excludedActivities: enriched.length - filtered.length,
    matchedActivities: filtered.length,
    outputRows: collapsedRows.length,
    rowLevelOutputRows: sorted.length,
    uniqueCases,
    csvOut,
    jsonOut,
    suspendedStatusChanges: suspended.statusChangeRows,
    suspendedOutputRows: suspended.outputRows,
    suspendedUniqueCases: suspended.uniqueCases,
    suspendedCsvOut: suspended.csvOut,
  };
}

async function requestActivityReport({
  domain,
  dateKey,
  startDateKey,
  endDateKey,
  reportName = DEFAULT_REPORT_NAME,
  reportEmail = DEFAULT_REPORT_EMAIL,
}) {
  const client = createLogicsClient(domain);
  const start = startDateKey || dateKey;
  const end = endDateKey || dateKey;
  const payload = {
    StartDate: formatLogicsReportDate(start),
    EndDate: formatLogicsReportDate(end),
    ReportName: reportName || DEFAULT_REPORT_NAME,
    Email: reportEmail || DEFAULT_REPORT_EMAIL,
  };
  const result = await client.requestActivityReport(payload);
  return {
    payload,
    result: summarizeReportResult(result),
    rows: extractReportRows(result),
  };
}

function buildEmailText({ domain, dateKey, startDateKey, endDateKey, processed }) {
  const range = startDateKey && endDateKey && startDateKey !== endDateKey
    ? `${startDateKey} to ${endDateKey}`
    : dateKey;
  return [
    "Logics activity review complete.",
    "",
    `Domain: ${domain}`,
    `Range: ${range}`,
    `Activity rows scanned: ${processed.parsedRows || 0}`,
    `Raw document uploads: ${processed.documentUploadActivities || 0}`,
    `Excluded uploads: ${processed.excludedActivities || 0}`,
    `Notice upload rows after filters: ${processed.rowLevelOutputRows || 0}`,
    `Notice upload cases: ${processed.outputRows || 0}`,
    `Suspended status changes: ${processed.suspendedStatusChanges || 0}`,
    `Suspended status cases: ${processed.suspendedOutputRows || 0}`,
    "",
    `Notice CSV: ${processed.csvOut || ""}`,
    `Suspended CSV: ${processed.suspendedCsvOut || ""}`,
    `Audit JSON: ${processed.jsonOut || ""}`,
  ].join("\n");
}

async function emailActivityReview(result, options = {}) {
  const processed = result.processed || result;
  const domain = String(options.domain || DEFAULT_DOMAIN).toUpperCase();
  const recipients = parseList(options.recipients);
  if (recipients.length === 0) {
    throw new Error("No Logics activity review recipients configured");
  }
  const dateKey = options.dateKey;
  const startDateKey = options.startDateKey || dateKey;
  const endDateKey = options.endDateKey || dateKey;
  const range = startDateKey && endDateKey && startDateKey !== endDateKey
    ? `${startDateKey} to ${endDateKey}`
    : dateKey;
  const subject = `Logics activity review ${range}: ${processed.outputRows || 0} notices, ${processed.suspendedOutputRows || 0} suspended`;
  const text = buildEmailText({ domain, dateKey, startDateKey, endDateKey, processed });
  const attachments = [];
  if (processed.csvOut && fs.existsSync(processed.csvOut)) {
    attachments.push({ filename: path.basename(processed.csvOut), path: processed.csvOut });
  }
  if (processed.suspendedCsvOut && fs.existsSync(processed.suspendedCsvOut)) {
    attachments.push({ filename: path.basename(processed.suspendedCsvOut), path: processed.suspendedCsvOut });
  }

  return sendMail(domain, {
    to: recipients,
    from: `Logics Activity Review <${getInternalFromEmail()}>`,
    replyTo: getInternalFromEmail(),
    subject,
    text,
    attachments,
  });
}

async function runLogicsActivityReview(options = {}) {
  const timezone = options.timezone || DEFAULT_TIMEZONE;
  const dateKey = normalizeDateKey(
    options.dateKey || options.date || yesterdayInTz(timezone),
    timezone,
  );
  const startDateKey = normalizeDateKey(options.startDateKey || options.startDate || dateKey, timezone);
  const endDateKey = normalizeDateKey(options.endDateKey || options.endDate || dateKey, timezone);
  const domain = String(options.domain || DEFAULT_DOMAIN).toUpperCase();
  const outDir = path.resolve(options.outDir || DEFAULT_OUT_DIR);
  const concurrency = Math.max(1, Number(options.concurrency || 3) || 3);
  const recipients = parseList(
    options.recipients ||
      process.env.LOGICS_ACTIVITY_REVIEW_RECIPIENTS ||
      DEFAULT_REVIEW_RECIPIENTS,
  );
  const reportEmail =
    options.reportEmail ||
    process.env.LOGICS_ACTIVITY_REVIEW_REPORT_EMAIL ||
    DEFAULT_REPORT_EMAIL;
  const sendEmail = options.sendEmail !== false;

  const request = await requestActivityReport({
    domain,
    dateKey,
    startDateKey,
    endDateKey,
    reportName: options.reportName || DEFAULT_REPORT_NAME,
    reportEmail,
  });
  const processed = await processActivityRows({
    domain,
    dateKey,
    startDateKey,
    endDateKey,
    rows: request.rows,
    outDir,
    concurrency,
    options,
  });
  const email = sendEmail
    ? await emailActivityReview(
        { request, processed },
        { domain, dateKey, startDateKey, endDateKey, recipients },
      )
    : null;

  return {
    ok: true,
    domain,
    date: dateKey,
    startDate: startDateKey,
    endDate: endDateKey,
    report: request.result,
    requestPayload: request.payload,
    processed,
    email,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  DEFAULT_REVIEW_RECIPIENTS,
  buildEmailText,
  classifyActivityRows,
  classifySuspendedStatusRows,
  emailActivityReview,
  normalizeDateKey,
  processActivityRows,
  requestActivityReport,
  runLogicsActivityReview,
  yesterdayInTz,
};
