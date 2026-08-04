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
const {
  getClientProfileByCaseNumber,
  mergeShorthandFields,
} = require("../../shared-repositories/src/clientProfileRepository");
const { rollupStatusChanges } = require("./activityStatusChangeRollupService");

const DEFAULT_DOMAIN = "TAG";
const DEFAULT_TIMEZONE = "America/Los_Angeles";
const DEFAULT_REPORT_NAME = "ActivityReport";
const DEFAULT_OUT_DIR = path.join(ROOT_DIR, "runtime", "logics-activity-review");
const DEFAULT_REPORT_EMAIL = getInternalFromEmail();
const DEFAULT_REVIEW_RECIPIENTS = [
  "mgray@taxadvocategroup.com",
  "manderson@taxadvocategroup.com",
];
const DEFAULT_DOMAINS = Object.freeze(["TAG", "WYNN", "AMITY"]);
const DEFAULT_AI_REVIEW_MAX_CASES = 75;
const DEFAULT_AI_REVIEW_CONCURRENCY = 1;

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
const ACTIVITY_TEMPERATURE_RULES = Object.freeze([
  {
    severity: "stop_contact",
    name: "do-not-contact",
    pattern: /\b(do not call|do not contact|don't call|dont call|stop calling|stop texting|stop text|unsubscribe|opt out|remove me|take me off|never contact)\b/i,
  },
  {
    severity: "stop_contact",
    name: "legal-risk",
    pattern: /\b(cease and desist|attorney general|complaint|lawsuit|sue you|harassment|harassing|fraud|scam)\b/i,
  },
  {
    severity: "stop_contact",
    name: "wrong-person",
    pattern: /\b(wrong number|wrong person|not me|this is not me|this isn't me|never applied|did not apply|didn't apply|did not sign up|didn't sign up)\b/i,
  },
  {
    severity: "stop_contact",
    name: "deceased",
    pattern: /\b(deceased|passed away|died|dead)\b/i,
  },
  {
    severity: "manual_review",
    name: "represented",
    pattern: /\b(attorney|lawyer|cpa|ea|tax pro|tax professional|represented|representation|already hired|already signed|working with another|working with a firm)\b/i,
  },
  {
    severity: "manual_review",
    name: "not-interested",
    pattern: /\b(not interested|no longer interested|no thanks|changed mind|doesn't want|does not want|declined|refused)\b/i,
  },
  {
    severity: "manual_review",
    name: "contact-friction",
    pattern: /\b(no answer|left voicemail|voicemail|vm\b|bad number|disconnected|busy|hang ?up|hung up|call failed|unable to reach)\b/i,
  },
  {
    severity: "pause_contact",
    name: "call-later",
    pattern: /\b(call back|callback|call later|bad time|busy right now|follow up|try again|not available)\b/i,
  },
  {
    severity: "allow_contact",
    name: "engaged",
    pattern: /\b(sent docs|uploaded|asked|requested|wants help|needs help|interested|appointment|scheduled|spoke with|called back)\b/i,
  },
]);
const ACTIVITY_TEMPERATURE_RANK = {
  clear: 0,
  allow_contact: 1,
  pause_contact: 2,
  manual_review: 3,
  stop_contact: 4,
};

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

function parseDomains(value, fallback = DEFAULT_DOMAINS) {
  const raw = value === undefined || value === null || value === "" ? fallback : value;
  const domains = parseList(raw)
    .map((item) => String(item || "").trim().toUpperCase())
    .filter(Boolean);
  return [...new Set(domains)].length ? [...new Set(domains)] : [...fallback];
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
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

function sortActivitiesNewestFirst(activities = []) {
  return [...(Array.isArray(activities) ? activities : [])].sort(
    (a, b) =>
      parseDateMs(b.CreatedDate || b.ModifiedDate || b.Date) -
      parseDateMs(a.CreatedDate || a.ModifiedDate || a.Date),
  );
}

function summarizeActivityTemperature(activities = []) {
  const hits = [];
  const rows = sortActivitiesNewestFirst(activities).slice(0, 40);
  for (const row of rows) {
    const text = clean([
      row.Subject,
      row.ActivityType,
      row.Comment,
      row.Notes,
      row.Description,
    ].filter(Boolean).join(" "), 2000);
    if (!text) continue;
    for (const rule of ACTIVITY_TEMPERATURE_RULES) {
      if (!rule.pattern.test(text)) continue;
      hits.push({
        severity: rule.severity,
        name: rule.name,
        at: clean(row.CreatedDate || row.ModifiedDate || row.Date || "", 80),
        evidence: clean(text, 160),
      });
    }
  }

  if (hits.length === 0) {
    return {
      status: "clear",
      label: "clear",
      flags: "",
      evidence: "",
    };
  }

  const status = hits.reduce((best, hit) =>
    ACTIVITY_TEMPERATURE_RANK[hit.severity] > ACTIVITY_TEMPERATURE_RANK[best]
      ? hit.severity
      : best,
  "clear");
  const names = [...new Set(hits
    .filter((hit) => hit.severity === status || status === "clear")
    .map((hit) => hit.name))]
    .slice(0, 4);
  const evidence = hits
    .filter((hit) => hit.severity === status)
    .slice(0, 2)
    .map((hit) => hit.at ? `${hit.at}: ${hit.evidence}` : hit.evidence)
    .join(" | ");

  return {
    status,
    label: names.length ? `${status}: ${names.join(", ")}` : status,
    flags: names.join(" | "),
    evidence,
  };
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

function formatWholeMoney(value) {
  if (value === null || value === undefined || value === "") return "";
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return `$${Math.round(number).toLocaleString()}`;
}

function formatShortDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return clean(value, 40);
  return date.toISOString().slice(0, 10);
}

function compactParts(parts, max = 500) {
  return clean((parts || []).filter(Boolean).join(" | "), max);
}

function summarizeProfileEntry(entry, max = 160) {
  if (!entry) return "";
  if (typeof entry === "string") return clean(entry, max);
  if (entry.snippet) return clean(entry.snippet, max);
  if (entry.value !== undefined) {
    if (typeof entry.value === "string") return clean(entry.value, max);
    try {
      return clean(JSON.stringify(entry.value), max);
    } catch {
      return "";
    }
  }
  return "";
}

function summarizeProfileOpportunities(profile, maxItems = 3) {
  const opportunities = Array.isArray(profile?.opportunities) ? profile.opportunities : [];
  return opportunities
    .slice(0, maxItems)
    .map((opp) => compactParts([
      opp.play || opp.name || opp.type || "opportunity",
      opp.status,
      opp.basis || opp.clock || opp.strategy,
    ], 220))
    .filter(Boolean)
    .join(" || ");
}

function summarizeProfileSalesContext(profile) {
  if (!profile) return emptyClientProfileFields();
  const shorthand = profile.shorthand || {};
  const pursuitTier = clean(profile.pursuit?.tier || "", 30);
  const pursuitScore = Number.isFinite(Number(profile.pursuit?.score))
    ? String(Number(profile.pursuit.score))
    : "";
  const profileTemperature = compactParts([
    profile.temperature?.label,
    profile.temperature?.signals,
  ], 220);
  const payments = compactParts([
    profile.payments?.totalPaid ? `paid ${formatWholeMoney(profile.payments.totalPaid)}` : "",
    profile.payments?.lastAmount ? `last ${formatWholeMoney(profile.payments.lastAmount)}` : "",
    profile.payments?.lastDate ? `on ${formatShortDate(profile.payments.lastDate)}` : "",
    profile.payments?.count ? `${profile.payments.count} payments` : "",
  ], 180);
  const funding = compactParts([
    profile.funding?.funded ? `funded ${formatWholeMoney(profile.funding.lastLoanTotal)}` : "",
    profile.funding?.lastLoanDate ? `loan ${formatShortDate(profile.funding.lastLoanDate)}` : "",
    profile.funding?.rejected ? "funding rejected" : "",
    Array.isArray(profile.funding?.denialLenders) && profile.funding.denialLenders.length
      ? `denied by ${profile.funding.denialLenders.slice(-3).join(", ")}`
      : "",
  ], 220);
  const salesTouch = compactParts([
    profile.touches?.sales?.lastDate ? `sales ${formatShortDate(profile.touches.sales.lastDate)}` : "",
    profile.touches?.sales?.lastBy,
    profile.touches?.sales?.lastPitched || profile.touches?.sales?.servicesPitched,
  ], 220);
  const workTouch = compactParts([
    profile.touches?.work?.lastDate ? `work ${formatShortDate(profile.touches.work.lastDate)}` : "",
    profile.touches?.work?.lastBy,
    profile.touches?.work?.product,
  ], 180);
  const shorthandSnapshot = compactParts([
    summarizeProfileEntry(shorthand.logics_status),
    summarizeProfileEntry(shorthand.logics_billing),
    summarizeProfileEntry(shorthand.logics_invoices),
    summarizeProfileEntry(shorthand.lexis_tax_liens),
    summarizeProfileEntry(shorthand.lexis_notice_of_default),
    summarizeProfileEntry(shorthand.logics_notice_alerts),
  ], 520);

  return {
    profileTier: pursuitTier,
    profileScore: pursuitScore,
    profileTemperature,
    profileReasons: clean(profile.pursuit?.reasons || "", 300),
    profilePayments: payments,
    profileFunding: funding,
    profileSalesTouch: salesTouch,
    profileWorkTouch: workTouch,
    profileOpportunities: summarizeProfileOpportunities(profile),
    profileSnapshot: shorthandSnapshot,
  };
}

function emptyClientProfileFields() {
  return {
    profileTier: "",
    profileScore: "",
    profileTemperature: "",
    profileReasons: "",
    profilePayments: "",
    profileFunding: "",
    profileSalesTouch: "",
    profileWorkTouch: "",
    profileOpportunities: "",
    profileSnapshot: "",
  };
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

function isSuspendedStatusName(statusName) {
  return /\bsuspend(ed|)\b/i.test(String(statusName || ""));
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

function isAiReviewEnabled(options = {}) {
  if (options.includeAiReview !== undefined) {
    return parseBoolean(options.includeAiReview, false);
  }
  return parseBoolean(process.env.LOGICS_ACTIVITY_REVIEW_AI_ENABLED, false);
}

function emptyAiReviewFields(error = "") {
  return {
    contactReviewStatus: "",
    contactReviewConfidence: "",
    contactRecommendedAction: "",
    contactRiskFlags: "",
    contactEvidence: "",
    contactReviewError: clean(error, 300),
  };
}

function summarizeAiReviewResult(result) {
  if (!result?.ok) {
    return emptyAiReviewFields(result?.reason || "ai-review-unavailable");
  }
  const review = result.review || {};
  return {
    contactReviewStatus: clean(review.status || "", 80),
    contactReviewConfidence: clean(review.confidence || "", 40),
    contactRecommendedAction: clean(review.recommendedAction || "", 220),
    contactRiskFlags: uniqueJoined(review.riskFlags || []),
    contactEvidence: uniqueJoined([
      ...(Array.isArray(review.evidence) ? review.evidence : []),
      ...(Array.isArray(review.concerns) ? review.concerns : []),
    ]),
    contactReviewError: "",
  };
}

async function attachAiActivityReviews(domain, rows, options = {}) {
  if (!isAiReviewEnabled(options) || rows.length === 0) {
    return rows.map((row) => ({ ...row, ...emptyAiReviewFields() }));
  }

  const uniqueCaseIds = [...new Set(rows.map((row) => Number(row.caseId)).filter(Boolean))];
  const maxCases = Math.max(
    0,
    Number(options.aiReviewMaxCases || process.env.LOGICS_ACTIVITY_REVIEW_AI_MAX_CASES || DEFAULT_AI_REVIEW_MAX_CASES) ||
      DEFAULT_AI_REVIEW_MAX_CASES,
  );
  const concurrency = Math.max(
    1,
    Number(options.aiReviewConcurrency || process.env.LOGICS_ACTIVITY_REVIEW_AI_CONCURRENCY || DEFAULT_AI_REVIEW_CONCURRENCY) ||
      DEFAULT_AI_REVIEW_CONCURRENCY,
  );
  const caseIdsToReview = maxCases > 0 ? uniqueCaseIds.slice(0, maxCases) : [];
  const skippedCaseIds = new Set(maxCases > 0 ? uniqueCaseIds.slice(maxCases) : uniqueCaseIds);
  const reviewByCaseId = new Map();

  if (caseIdsToReview.length) {
    const { reviewCaseActivities } = require("./activityAiReviewService");
    await mapLimit(caseIdsToReview, concurrency, async (caseId) => {
      try {
        const result = await reviewCaseActivities(domain, caseId, {
          model: options.aiReviewModel || process.env.LOGICS_ACTIVITY_REVIEW_AI_MODEL || undefined,
          maxTokens: Number(options.aiReviewMaxTokens || process.env.LOGICS_ACTIVITY_REVIEW_AI_MAX_TOKENS || 0) || undefined,
          temperature:
            options.aiReviewTemperature !== undefined
              ? Number(options.aiReviewTemperature)
              : process.env.LOGICS_ACTIVITY_REVIEW_AI_TEMPERATURE !== undefined
                ? Number(process.env.LOGICS_ACTIVITY_REVIEW_AI_TEMPERATURE)
                : undefined,
        });
        reviewByCaseId.set(caseId, summarizeAiReviewResult(result));
      } catch (error) {
        reviewByCaseId.set(caseId, emptyAiReviewFields(error.message));
      }
    });
  }

  return rows.map((row) => {
    const numericCaseId = Number(row.caseId);
    const review = reviewByCaseId.get(numericCaseId) ||
      (skippedCaseIds.has(numericCaseId)
        ? emptyAiReviewFields("ai-review-skipped:max-cases")
        : emptyAiReviewFields());
    return {
      ...row,
      ...review,
    };
  });
}

function summarizeAiReviewRows(rows = []) {
  const byCase = new Map();
  for (const row of rows) {
    const caseId = String(row.caseId || "");
    if (!caseId || byCase.has(caseId)) continue;
    byCase.set(caseId, row);
  }
  const values = [...byCase.values()];
  return {
    enabled: values.some((row) => row.contactReviewStatus || row.contactReviewError),
    reviewedCases: values.filter((row) => row.contactReviewStatus).length,
    errorCases: values.filter((row) => row.contactReviewError && !/skipped:max-cases/i.test(row.contactReviewError)).length,
    skippedCases: values.filter((row) => /skipped:max-cases/i.test(String(row.contactReviewError || ""))).length,
  };
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
      const [info, billing, invoices, activities, profile] = await Promise.all([
        facade.fetchCaseInfo(caseId),
        facade.fetchBillingSummary(caseId).catch((error) => ({ error: error.message })),
        facade.fetchInvoices(caseId).catch((error) => ({ error: error.message })),
        facade.fetchActivities(caseId).catch(() => []),
        getClientProfileByCaseNumber(String(caseId), domain).catch((error) => ({ error: error.message })),
      ]);
      entry.caseInfo = info?.data || {};
      entry.caseInfoError = info?.ok === false ? info.error : "";
      entry.billing = billing && !billing.error ? billing : {};
      entry.billingError = billing?.error || "";
      entry.invoices = Array.isArray(invoices) ? invoices : [];
      entry.invoiceError = invoices?.error || "";
      entry.activities = Array.isArray(activities) ? activities : [];
      entry.clientProfile = profile && !profile.error ? profile : null;
      entry.clientProfileError = profile?.error || "";
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
    const activityTemperature = summarizeActivityTemperature(entry.activities || []);
    const exactActivity = findMatchingCaseActivity(entry.activities || [], candidate);
    const documentName = candidate.documentName || exactActivity.documentName || "";
    const profileContext = summarizeProfileSalesContext(entry.clientProfile);
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
      currentStatusName: caseInfo.statusName,
      currentStatusTier: caseInfo.statusTier,
      currentlySuspended: isSuspendedStatusName(caseInfo.statusName) ? "yes" : "no",
      activityTemperature: activityTemperature.label,
      activityTemperatureStatus: activityTemperature.status,
      activityTemperatureFlags: activityTemperature.flags,
      activityTemperatureEvidence: activityTemperature.evidence,
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
      ...profileContext,
      clientProfileFound: entry.clientProfile ? "yes" : "no",
      clientProfileError: entry.clientProfileError || "",
      caseInfoError: entry.caseInfoError || entry.error || "",
      billingError: entry.billingError || "",
      invoiceError: entry.invoiceError || "",
    };
  });
}

function outputColumns() {
  return [
    "caseId",
    "database",
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
    "profileTier",
    "profileScore",
    "profileTemperature",
    "profileReasons",
    "profilePayments",
    "profileFunding",
    "profileSalesTouch",
    "profileWorkTouch",
    "profileOpportunities",
    "profileSnapshot",
    "contactReviewStatus",
    "contactReviewConfidence",
    "contactRecommendedAction",
    "contactRiskFlags",
    "contactEvidence",
    "contactReviewError",
  ];
}

function finalCsvRow(row) {
  const documentUploaded = row.documentName || row.activitySubject || row.activityType;
  return {
    database: row.domain,
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
    temperature: row.activityTemperature || row.statusName,
    tier: row.clientTemperature || parseStatusTier(row.fromStatus) || parseStatusTier(row.toStatus),
    profileTier: row.profileTier || "",
    profileScore: row.profileScore || "",
    profileTemperature: row.profileTemperature || "",
    profileReasons: row.profileReasons || "",
    profilePayments: row.profilePayments || "",
    profileFunding: row.profileFunding || "",
    profileSalesTouch: row.profileSalesTouch || "",
    profileWorkTouch: row.profileWorkTouch || "",
    profileOpportunities: row.profileOpportunities || "",
    profileSnapshot: row.profileSnapshot || "",
    contactReviewStatus: row.contactReviewStatus || "",
    contactReviewConfidence: row.contactReviewConfidence || "",
    contactRecommendedAction: row.contactRecommendedAction || "",
    contactRiskFlags: row.contactRiskFlags || "",
    contactEvidence: row.contactEvidence || "",
    contactReviewError: row.contactReviewError || "",
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
        database: base.database,
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
        profileTier: base.profileTier,
        profileScore: base.profileScore,
        profileTemperature: base.profileTemperature,
        profileReasons: base.profileReasons,
        profilePayments: base.profilePayments,
        profileFunding: base.profileFunding,
        profileSalesTouch: base.profileSalesTouch,
        profileWorkTouch: base.profileWorkTouch,
        profileOpportunities: base.profileOpportunities,
        profileSnapshot: base.profileSnapshot,
        contactReviewStatus: base.contactReviewStatus,
        contactReviewConfidence: base.contactReviewConfidence,
        contactRecommendedAction: base.contactRecommendedAction,
        contactRiskFlags: base.contactRiskFlags,
        contactEvidence: base.contactEvidence,
        contactReviewError: base.contactReviewError,
      };
    })
    .sort((a, b) => parseDateMs(a.firstUploadAt) - parseDateMs(b.firstUploadAt));
}

function noticeAlertFromRow(row) {
  return {
    activityId: clean(row.activityId || "", 80),
    uploadedAt: clean(row.uploadedAt || "", 80),
    documentName: clean(row.documentName || row.activitySubject || row.activityType || "", 220),
    noticeMatches: clean(row.noticeMatches || "", 220),
    createdBy: clean(row.createdBy || "", 120),
    contactReviewStatus: clean(row.contactReviewStatus || "", 80),
    recommendedAction: clean(row.contactRecommendedAction || row.recommendedAction || "", 240),
  };
}

function noticeAlertKey(alert) {
  return [
    alert.activityId,
    alert.uploadedAt,
    alert.documentName,
    alert.noticeMatches,
  ].map((part) => String(part || "").toLowerCase()).join("|");
}

function compactNoticeAlertSnippet(alerts = []) {
  return alerts
    .slice(-3)
    .map((alert) => compactParts([
      alert.noticeMatches || "notice",
      alert.documentName,
      alert.uploadedAt,
      alert.recommendedAction,
    ], 260))
    .filter(Boolean)
    .join(" || ");
}

async function recordNoticeAlertsOnClientProfiles(domain, rows = [], options = {}) {
  if (options.recordClientProfileNoticeAlerts === false) {
    return { enabled: false, updated: 0, skipped: 0, failed: 0 };
  }
  const byCase = new Map();
  for (const row of rows) {
    const caseId = String(row.caseId || "").trim();
    if (!caseId) continue;
    if (!byCase.has(caseId)) byCase.set(caseId, []);
    byCase.get(caseId).push(row);
  }

  let updated = 0;
  let skipped = 0;
  let failed = 0;
  const asOf = new Date();

  for (const [caseId, caseRows] of byCase.entries()) {
    try {
      const existing = await getClientProfileByCaseNumber(caseId, domain);
      if (!existing) {
        skipped += 1;
        continue;
      }
      const prior = Array.isArray(existing.shorthand?.logics_notice_alerts?.value)
        ? existing.shorthand.logics_notice_alerts.value
        : [];
      const alerts = [
        ...prior.map((alert) => noticeAlertFromRow(alert)),
        ...caseRows.map(noticeAlertFromRow),
      ];
      const deduped = [];
      const seen = new Set();
      for (const alert of alerts) {
        const key = noticeAlertKey(alert);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        deduped.push(alert);
      }
      const value = deduped.slice(-25);
      await mergeShorthandFields(caseId, {
        logics_notice_alerts: {
          value,
          snippet: compactNoticeAlertSnippet(value),
          asOf,
          source: `logics-activity-review:${domain}`,
        },
      }, { domain, upsert: false });
      updated += 1;
    } catch {
      failed += 1;
    }
  }

  return { enabled: true, updated, skipped, failed };
}

function suspendedOutputColumns() {
  return [
    "caseId",
    "database",
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
    "profileTier",
    "profileScore",
    "profileTemperature",
    "profileReasons",
    "profilePayments",
    "profileFunding",
    "profileSalesTouch",
    "profileWorkTouch",
    "profileOpportunities",
    "profileSnapshot",
    "contactReviewStatus",
    "contactReviewConfidence",
    "contactRecommendedAction",
    "contactRiskFlags",
    "contactEvidence",
    "contactReviewError",
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
        database: base.database,
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
        profileTier: base.profileTier,
        profileScore: base.profileScore,
        profileTemperature: base.profileTemperature,
        profileReasons: base.profileReasons,
        profilePayments: base.profilePayments,
        profileFunding: base.profileFunding,
        profileSalesTouch: base.profileSalesTouch,
        profileWorkTouch: base.profileWorkTouch,
        profileOpportunities: base.profileOpportunities,
        profileSnapshot: base.profileSnapshot,
        contactReviewStatus: base.contactReviewStatus,
        contactReviewConfidence: base.contactReviewConfidence,
        contactRecommendedAction: base.contactRecommendedAction,
        contactRiskFlags: base.contactRiskFlags,
        contactEvidence: base.contactEvidence,
        contactReviewError: base.contactReviewError,
      };
    })
    .sort((a, b) => parseDateMs(a.firstChangedAt) - parseDateMs(b.firstChangedAt));
}

function buildRangeKey(dateKey, startDateKey, endDateKey) {
  return startDateKey && endDateKey && startDateKey !== endDateKey
    ? `${startDateKey}_to_${endDateKey}`
    : dateKey;
}

function formatEmailCaseRows(rows = [], { limit = 15, label = "Notice cases" } = {}) {
  const visible = (Array.isArray(rows) ? rows : []).slice(0, limit);
  if (!visible.length) return "";
  const lines = [
    "",
    `${label}:`,
  ];
  for (const row of visible) {
    const sales = compactParts([
      row.profileTier || row.tier ? `tier ${row.profileTier || row.tier}` : "",
      row.profileScore ? `score ${row.profileScore}` : "",
      row.profileTemperature,
      row.profileReasons,
      row.profilePayments,
      row.profileFunding,
      row.profileSalesTouch,
      row.profileOpportunities,
      row.profileSnapshot,
    ], 700);
    const ai = compactParts([
      row.contactReviewStatus,
      row.contactRecommendedAction,
      row.contactRiskFlags,
    ], 420);
    lines.push(
      `- ${row.database || ""} ${row.caseId || ""} ${row.name || ""}: ${row.matchedTerms || row.documentsUploaded || "matched notice"}`,
    );
    if (sales) lines.push(`  Sales/profile: ${sales}`);
    if (ai) lines.push(`  Review: ${ai}`);
  }
  const remaining = (Array.isArray(rows) ? rows.length : 0) - visible.length;
  if (remaining > 0) lines.push(`  ...and ${remaining} more in the CSV.`);
  return lines.join("\n");
}

async function processSuspendedStatusRows({ domain, rows, outDir, concurrency, rangeKey, options }) {
  const candidates = classifySuspendedStatusRows(rows);
  const enriched = await enrichCandidates(domain, candidates, { ...options, concurrency });
  const currentSuspended = enriched.filter((row) => isSuspendedStatusName(row.statusName));
  const reviewed = await attachAiActivityReviews(domain, currentSuspended, options);
  const sorted = reviewed.sort((a, b) => parseDateMs(a.uploadedAt) - parseDateMs(b.uploadedAt));
  const collapsedRows = collapseSuspendedRowsByCase(sorted);
  const aiReview = summarizeAiReviewRows(sorted);
  const outputDir = path.resolve(outDir || DEFAULT_OUT_DIR);
  ensureDir(outputDir);
  const csvOut = path.join(outputDir, `logics-suspended-status-${domain}-${rangeKey}.csv`);
  writeCsv(csvOut, collapsedRows, suspendedOutputColumns());
  return {
    statusChangeRows: candidates.length,
    staleStatusRows: enriched.length - currentSuspended.length,
    currentSuspendedRows: currentSuspended.length,
    outputRows: collapsedRows.length,
    uniqueCases: collapsedRows.length,
    aiReview,
    csvOut,
    rows: sorted,
    staleRows: enriched.filter((row) => !isSuspendedStatusName(row.statusName)),
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
  const reviewed = await attachAiActivityReviews(domain, filtered, options);
  const sorted = reviewed.sort((a, b) => parseDateMs(a.uploadedAt) - parseDateMs(b.uploadedAt));
  const clientProfileNoticeAlerts = await recordNoticeAlertsOnClientProfiles(domain, sorted, options);
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
  const aiReview = summarizeAiReviewRows(sorted);
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
    aiReview,
    clientProfileNoticeAlerts,
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
    aiReview,
    clientProfileNoticeAlerts,
    csvOut,
    jsonOut,
    suspendedStatusChanges: suspended.statusChangeRows,
    suspendedStaleStatusChanges: suspended.staleStatusRows,
    suspendedCurrentStatusChanges: suspended.currentSuspendedRows,
    suspendedOutputRows: suspended.outputRows,
    suspendedUniqueCases: suspended.uniqueCases,
    suspendedAiReview: suspended.aiReview,
    suspendedCsvOut: suspended.csvOut,
    collapsedRows,
    suspendedCollapsedRows: suspended.collapsedRows,
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
    processed.domains ? `Databases: ${processed.domains.join(", ")}` : "",
    `Range: ${range}`,
    `Activity rows scanned: ${processed.parsedRows || 0}`,
    `Raw document uploads: ${processed.documentUploadActivities || 0}`,
    `Excluded uploads: ${processed.excludedActivities || 0}`,
    `Notice upload rows after filters: ${processed.rowLevelOutputRows || 0}`,
    `Notice upload cases: ${processed.outputRows || 0}`,
    `AI-reviewed notice cases: ${processed.aiReview?.reviewedCases || 0}`,
    `AI review skips/errors: ${(processed.aiReview?.skippedCases || 0) + (processed.aiReview?.errorCases || 0)}`,
    `Client profiles stamped with notice memory: ${processed.clientProfileNoticeAlerts?.updated || 0}`,
    processed.clientProfileNoticeAlerts
      ? `Client profile stamp skips/errors: ${(processed.clientProfileNoticeAlerts.skipped || 0) + (processed.clientProfileNoticeAlerts.failed || 0)}`
      : "",
    processed.statusChangeCounts && !processed.statusChangeCounts.error
      ? `DNC'd today (from Activities): ${processed.statusChangeCounts.dnc || 0}`
      : "",
    processed.statusChangeCounts && !processed.statusChangeCounts.error
      ? `Post-dated today (from Activities): ${processed.statusChangeCounts.postdate || 0}`
      : "",
    `Suspended status changes: ${processed.suspendedStatusChanges || 0}`,
    `Suspended changes still current: ${processed.suspendedCurrentStatusChanges || 0}`,
    `Suspended changes no longer current: ${processed.suspendedStaleStatusChanges || 0}`,
    `Suspended status cases: ${processed.suspendedOutputRows || 0}`,
    `AI-reviewed suspended cases: ${processed.suspendedAiReview?.reviewedCases || 0}`,
    "",
    formatEmailCaseRows(processed.collapsedRows, { label: "Notice cases with sales/profile context" }),
    formatEmailCaseRows(processed.suspendedCollapsedRows, { label: "Suspended cases with sales/profile context", limit: 8 }),
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
  const subjectPrefix = domain === "ALL" ? "Logics activity review ALL" : "Logics activity review";
  const subject = `${subjectPrefix} ${range}: ${processed.outputRows || 0} notices, ${processed.suspendedOutputRows || 0} suspended`;
  const text = buildEmailText({ domain, dateKey, startDateKey, endDateKey, processed });
  const attachments = [];
  const attachCsv = options.attachCsv === true;
  if (attachCsv && processed.csvOut && fs.existsSync(processed.csvOut)) {
    attachments.push({ filename: path.basename(processed.csvOut), path: processed.csvOut });
  }
  if (attachCsv && processed.suspendedCsvOut && fs.existsSync(processed.suspendedCsvOut)) {
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

function sumProcessed(results, key) {
  return results.reduce((sum, result) => {
    const value = String(key)
      .split(".")
      .reduce((cursor, part) => (cursor ? cursor[part] : undefined), result.processed);
    return sum + (Number(value) || 0);
  }, 0);
}

async function runLogicsActivityReviewBatch(options = {}) {
  const timezone = options.timezone || DEFAULT_TIMEZONE;
  const dateKey = normalizeDateKey(
    options.dateKey || options.date || yesterdayInTz(timezone),
    timezone,
  );
  const startDateKey = normalizeDateKey(options.startDateKey || options.startDate || dateKey, timezone);
  const endDateKey = normalizeDateKey(options.endDateKey || options.endDate || dateKey, timezone);
  const domains = parseDomains(
    options.domains ||
      process.env.LOGICS_ACTIVITY_REVIEW_DOMAINS ||
      options.domain ||
      DEFAULT_DOMAINS,
  );
  const outDir = path.resolve(options.outDir || DEFAULT_OUT_DIR);
  const rangeKey = buildRangeKey(dateKey, startDateKey, endDateKey);
  const recipients = parseList(
    options.recipients ||
      process.env.LOGICS_ACTIVITY_REVIEW_RECIPIENTS ||
      DEFAULT_REVIEW_RECIPIENTS,
  );
  const results = [];

  for (const domain of domains) {
    results.push(await runLogicsActivityReview({
      ...options,
      domain,
      dateKey,
      startDateKey,
      endDateKey,
      outDir,
      sendEmail: false,
    }));
  }

  ensureDir(outDir);
  const combinedRows = results.flatMap((result) => result.processed?.collapsedRows || []);
  const combinedSuspendedRows = results.flatMap((result) => result.processed?.suspendedCollapsedRows || []);
  const csvOut = path.join(outDir, `logics-document-uploads-ALL-${rangeKey}.csv`);
  const suspendedCsvOut = path.join(outDir, `logics-suspended-status-ALL-${rangeKey}.csv`);
  const jsonOut = path.join(outDir, `logics-activity-review-ALL-${rangeKey}.json`);

  writeCsv(csvOut, combinedRows, outputColumns());
  writeCsv(suspendedCsvOut, combinedSuspendedRows, suspendedOutputColumns());

  const processed = {
    domains,
    parsedRows: sumProcessed(results, "parsedRows"),
    documentUploadActivities: sumProcessed(results, "documentUploadActivities"),
    excludedActivities: sumProcessed(results, "excludedActivities"),
    matchedActivities: sumProcessed(results, "matchedActivities"),
    rowLevelOutputRows: sumProcessed(results, "rowLevelOutputRows"),
    outputRows: combinedRows.length,
    uniqueCases: combinedRows.length,
    suspendedStatusChanges: sumProcessed(results, "suspendedStatusChanges"),
    suspendedStaleStatusChanges: sumProcessed(results, "suspendedStaleStatusChanges"),
    suspendedCurrentStatusChanges: sumProcessed(results, "suspendedCurrentStatusChanges"),
    suspendedOutputRows: combinedSuspendedRows.length,
    suspendedUniqueCases: combinedSuspendedRows.length,
    statusChangeCounts: {
      dnc: sumProcessed(results, "statusChangeCounts.dnc"),
      postdate: sumProcessed(results, "statusChangeCounts.postdate"),
      casesChanged: sumProcessed(results, "statusChangeCounts.casesChanged"),
      unresolved: sumProcessed(results, "statusChangeCounts.unresolved"),
      byDomain: Object.fromEntries(
        results.map((result) => [
          result.domain,
          {
            dnc: result.processed?.statusChangeCounts?.dnc || 0,
            postdate: result.processed?.statusChangeCounts?.postdate || 0,
            casesChanged: result.processed?.statusChangeCounts?.casesChanged || 0,
          },
        ]),
      ),
    },
    aiReview: {
      enabled: results.some((result) => result.processed?.aiReview?.enabled),
      reviewedCases: sumProcessed(results, "aiReview.reviewedCases"),
      errorCases: sumProcessed(results, "aiReview.errorCases"),
      skippedCases: sumProcessed(results, "aiReview.skippedCases"),
    },
    clientProfileNoticeAlerts: {
      enabled: results.some((result) => result.processed?.clientProfileNoticeAlerts?.enabled),
      updated: sumProcessed(results, "clientProfileNoticeAlerts.updated"),
      skipped: sumProcessed(results, "clientProfileNoticeAlerts.skipped"),
      failed: sumProcessed(results, "clientProfileNoticeAlerts.failed"),
    },
    suspendedAiReview: {
      enabled: results.some((result) => result.processed?.suspendedAiReview?.enabled),
      reviewedCases: sumProcessed(results, "suspendedAiReview.reviewedCases"),
      errorCases: sumProcessed(results, "suspendedAiReview.errorCases"),
      skippedCases: sumProcessed(results, "suspendedAiReview.skippedCases"),
    },
    csvOut,
    suspendedCsvOut,
    jsonOut,
    perDomain: results.map((result) => ({
      domain: result.domain,
      activityRows: result.processed?.parsedRows || 0,
      noticeCases: result.processed?.outputRows || 0,
      suspendedCases: result.processed?.suspendedOutputRows || 0,
      csvOut: result.processed?.csvOut || "",
      suspendedCsvOut: result.processed?.suspendedCsvOut || "",
    })),
  };

  writeJson(jsonOut, {
    ok: true,
    domains,
    date: dateKey,
    startDate: startDateKey,
    endDate: endDateKey,
    generatedAt: new Date().toISOString(),
    processed,
    results,
  });

  const email = options.sendEmail !== false
    ? await emailActivityReview(
        { processed },
        {
          domain: "ALL",
          dateKey,
          startDateKey,
          endDateKey,
          recipients,
          attachCsv: options.attachCsv === true,
        },
      )
    : null;

  return {
    ok: true,
    domains,
    date: dateKey,
    startDate: startDateKey,
    endDate: endDateKey,
    results,
    processed,
    email,
    generatedAt: new Date().toISOString(),
  };
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
  // EOD status-change counts from the same activity feed (Mickey
  // 2026-07-27: count DNCs and post-dates from the canonical source —
  // Activities). Counting must never break the review itself.
  try {
    processed.statusChangeCounts = rollupStatusChanges({ domain, rows: request.rows });
  } catch (error) {
    processed.statusChangeCounts = { error: String(error.message).slice(0, 160) };
  }

  // ── RECORD THE DAY, THEN SEND IT ────────────────────────────────────────
  //
  // Mickey 2026-08-04: "the nightly activity service worked to produce an
  // accurate day — all we are doing is organizing it and getting it to record."
  //
  // Until now this function gathered an accurate day and then spent it entirely
  // on an email. The numbers below are the same ones the email prints; they are
  // simply written down first, so a mail failure costs the message and not the
  // day. Same ordering rule the report path follows.
  //
  // Non-fatal by construction: recording is not what this service is FOR, and a
  // storage problem must not cost the review its email.
  try {
    const { attachDailyActivityFacts } = require("./dailyReportFactService");
    processed.recorded = await attachDailyActivityFacts({
      dateKey: endDateKey || dateKey,
      activityFacts: {
        domain,
        range: { from: startDateKey || dateKey, to: endDateKey || dateKey },
        rowsScanned: processed.parsedRows || 0,
        documentUploads: processed.documentUploadActivities || 0,
        excludedUploads: processed.excludedActivities || 0,
        noticeUploadCases: processed.outputRows || 0,
        suspendedStatusChanges: processed.suspendedStatusChanges || 0,
        suspendedStillCurrent: processed.suspendedCurrentStatusChanges || 0,
        // These two come from the canonical source — the activity feed itself —
        // which is the whole reason they are worth keeping.
        dncToday: processed.statusChangeCounts?.dnc ?? null,
        postdateToday: processed.statusChangeCounts?.postdate ?? null,
        // A count that could not be computed is NULL, never 0. "We could not
        // look" and "nothing happened" are different days.
        statusCountsError: processed.statusChangeCounts?.error || null,
        aiReviewedCases: processed.aiReview?.reviewedCases ?? null,
        profilesStamped: processed.clientProfileNoticeAlerts?.updated ?? null,
      },
    });
  } catch (error) {
    processed.recorded = { status: "failed", reason: String(error.message).slice(0, 160) };
  }

  const email = sendEmail
    ? await emailActivityReview(
        { request, processed },
        {
          domain,
          dateKey,
          startDateKey,
          endDateKey,
          recipients,
          attachCsv: options.attachCsv === true,
        },
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
  DEFAULT_DOMAINS,
  DEFAULT_REVIEW_RECIPIENTS,
  buildEmailText,
  classifyActivityRows,
  classifySuspendedStatusRows,
  emailActivityReview,
  normalizeDateKey,
  processActivityRows,
  requestActivityReport,
  runLogicsActivityReview,
  runLogicsActivityReviewBatch,
  yesterdayInTz,
};
