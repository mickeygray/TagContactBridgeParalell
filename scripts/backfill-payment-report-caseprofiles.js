"use strict";

require("dotenv").config();

const fs = require("fs");
const os = require("os");
const path = require("path");
const Papa = require("papaparse");
const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
const { getSharedConfig } = require("../packages/shared-config/src");
const { CaseProfile } = require("../packages/shared-models/src");
const { caseProfileRepository } = require("../packages/shared-repositories/src");
const { createLogicsFacade } = require("../packages/shared-services/src/logicsFacadeService");
const { resolveCanonicalSource } = require("../packages/shared-services/src/sourceCanonicalService");

function readFlagValue(argv, name) {
  const prefixed = argv.find((arg) => arg.startsWith(`${name}=`));
  if (prefixed) return prefixed.slice(name.length + 1);
  const index = argv.indexOf(name);
  if (index >= 0 && index < argv.length - 1) {
    return argv[index + 1];
  }
  return null;
}

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase() || "TAG";
}

function normalizeText(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function normalizeDigits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.length === 11 && digits.startsWith("1")
    ? digits.slice(1)
    : digits.slice(-10);
}

function collectNormalizedPhones(...values) {
  const phones = [];
  const seen = new Set();
  for (const value of values) {
    const digits = normalizeDigits(value);
    if (!digits || seen.has(digits)) continue;
    seen.add(digits);
    phones.push(digits);
  }
  return phones;
}

function parseMoney(value) {
  const text = String(value || "").trim();
  if (!text) return 0;
  const negative = /^\(.*\)$/.test(text);
  const numeric = Number(text.replace(/[\$,()]/g, "").replace(/\s+/g, ""));
  if (!Number.isFinite(numeric)) return 0;
  return negative ? -numeric : numeric;
}

function parsePaidDate(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateKey(value) {
  return value.toISOString().slice(0, 10);
}

function nearlyEqualMoney(left, right, tolerance = 0.01) {
  return Math.abs(Number(left || 0) - Number(right || 0)) <= tolerance;
}

function hasMatchingSuccessfulPayment(payments = [], row = {}) {
  const targetDate = String(row.paidDateKey || "");
  const targetAmount = Number(row.amount || 0);
  return payments.some((payment) => {
    if (String(payment?.TransactionStatus || "").toUpperCase() !== "SUCCESS") {
      return false;
    }
    const paidDate = parsePaidDate(payment?.PaidDate);
    const paidDateKey = paidDate ? formatDateKey(paidDate) : "";
    return paidDateKey === targetDate && nearlyEqualMoney(payment?.Amount, targetAmount);
  });
}

function splitClientName(value) {
  const text = normalizeText(value);
  if (!text) {
    return { firstName: null, lastName: null, name: null };
  }
  const parts = text.split(/\s+/);
  return {
    firstName: parts[0] || null,
    lastName: parts.slice(1).join(" ") || null,
    name: text,
  };
}

function readPaymentReportRows(filePath) {
  const raw = fs.readFileSync(filePath, "utf16le");
  const parsed = Papa.parse(raw, {
    header: true,
    skipEmptyLines: true,
  });
  return Array.isArray(parsed.data) ? parsed.data : [];
}

function listReportFiles(dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /^PaymentsReport_.*\.csv$/i.test(entry.name))
    .map((entry) => path.join(dirPath, entry.name))
    .sort();
}

function pickLatestRowByCaseId(rows) {
  const byCaseId = new Map();
  for (const row of rows) {
    const caseId = Number(row.caseId);
    if (!Number.isFinite(caseId)) continue;
    const existing = byCaseId.get(caseId);
    if (!existing || existing.paidAt.getTime() < row.paidAt.getTime()) {
      byCaseId.set(caseId, row);
    }
  }
  return [...byCaseId.values()];
}

async function main() {
  const argv = process.argv.slice(2);
  const domain = normalizeDomain(readFlagValue(argv, "--domain") || "TAG");
  const from = readFlagValue(argv, "--from") || "2026-04-01";
  const to = readFlagValue(argv, "--to") || new Date().toISOString().slice(0, 10);
  const reportsDir = path.resolve(
    readFlagValue(argv, "--dir") || path.join(os.homedir(), "Downloads"),
  );
  const outPath = path.resolve(
    readFlagValue(argv, "--out") ||
      `ops/backfill-payment-report-caseprofiles-${domain.toLowerCase()}-${from}-to-${to}.json`,
  );
  const allowedSources = new Set(
    String(readFlagValue(argv, "--sources") || "")
      .split(",")
      .map((value) => normalizeText(value).toLowerCase())
      .filter(Boolean),
  );

  const fromKey = String(from);
  const toKey = String(to);

  await connectMongo(getSharedConfig());
  const facade = createLogicsFacade(domain);
  const files = listReportFiles(reportsDir);

  const candidateRows = [];
  for (const filePath of files) {
    for (const rawRow of readPaymentReportRows(filePath)) {
      const paymentType = normalizeText(rawRow["Payment Type"]);
      const paymentStatus = normalizeText(rawRow["Payment Status"]).toUpperCase();
      if (paymentType.toLowerCase() !== "initial" || paymentStatus !== "SUCCESS") continue;

      const sourceName = normalizeText(rawRow["Source Name"]);
      if (!sourceName) continue;
      if (allowedSources.size > 0 && !allowedSources.has(sourceName.toLowerCase())) continue;

      const paidAt = parsePaidDate(rawRow["PaidDate"] || rawRow["Paid Date"]);
      if (!paidAt) continue;
      const paidDateKey = formatDateKey(paidAt);
      if (paidDateKey < fromKey || paidDateKey > toKey) continue;

      const caseId = Number(rawRow["Case ID"]);
      if (!Number.isFinite(caseId)) continue;

      candidateRows.push({
        filePath,
        caseId,
        clientName: normalizeText(rawRow["Client Name"]),
        sourceName,
        amount: parseMoney(rawRow.Amount),
        paidAt,
        paidDateKey,
      });
    }
  }

  const rows = pickLatestRowByCaseId(candidateRows);
  const results = [];

  for (const row of rows) {
    const existing = await CaseProfile.findOne({
      domain,
      caseId: Number(row.caseId),
    }).lean();

    if (
      existing &&
      normalizeText(existing.sourceName).toLowerCase() &&
      normalizeText(existing.sourceName).toLowerCase() !== row.sourceName.toLowerCase()
    ) {
      results.push({
        caseId: row.caseId,
        action: "skipped-conflict",
        existingSourceName: existing.sourceName || null,
        requestedSourceName: row.sourceName,
      });
      continue;
    }

    const caseInfoResult = await facade.fetchCaseInfo(row.caseId).catch(() => null);
    const payments = await facade.fetchPayments(row.caseId).catch(() => []);
    const caseInfo = caseInfoResult?.data || null;
    const matchingPaymentFound = hasMatchingSuccessfulPayment(payments, row);
    if (!matchingPaymentFound) {
      results.push({
        caseId: row.caseId,
        action: "skipped-no-domain-payment",
        requestedSourceName: row.sourceName,
        amount: row.amount,
        paidDate: row.paidDateKey,
        fetchedName:
          normalizeText(
            [normalizeText(caseInfo?.FirstName), normalizeText(caseInfo?.LastName)]
              .filter(Boolean)
              .join(" "),
          ) || null,
        statusId: Number(caseInfo?.StatusID) || null,
        statusName: normalizeText(caseInfo?.StatusName) || null,
        saleDate: caseInfo?.SaleDate || null,
      });
      continue;
    }

    const fallbackName = splitClientName(row.clientName);
    const firstName = normalizeText(caseInfo?.FirstName) || fallbackName.firstName;
    const lastName = normalizeText(caseInfo?.LastName) || fallbackName.lastName;
    const name =
      normalizeText(
        [normalizeText(caseInfo?.FirstName), normalizeText(caseInfo?.LastName)]
          .filter(Boolean)
          .join(" "),
      ) || fallbackName.name;
    const email = normalizeText(caseInfo?.Email) || null;
    const primaryPhone =
      normalizeText(caseInfo?.CellPhone) ||
      normalizeText(caseInfo?.HomePhone) ||
      normalizeText(caseInfo?.WorkPhone) ||
      null;
    const normalizedPhones = collectNormalizedPhones(
      caseInfo?.CellPhone,
      caseInfo?.HomePhone,
      caseInfo?.WorkPhone,
    );
    const canonical = await resolveCanonicalSource({
      domain,
      internalName: row.sourceName,
      sourceName: row.sourceName,
      sourceId: caseInfo?.SourceID ?? null,
    }).catch(() => null);

    const update = {
      firstName,
      lastName,
      name,
      email,
      primaryPhone,
      normalizedPhones,
      sourceName: row.sourceName,
      sourceCanonicalId: canonical?.doc?._id || null,
      statusId: Number(caseInfo?.StatusID) || Number(caseInfoResult?.status) || 2,
      statusCategory: "client",
      convertedAt: row.paidAt,
      caseCreatedDate: caseInfo?.CreatedDate ? new Date(caseInfo.CreatedDate) : null,
      firstPaymentDate: row.paidAt,
      initialPayment: row.amount,
      totalPaid: row.amount,
      paymentsCount: 1,
      lastPaymentDate: row.paidAt,
      lastPaymentAmount: row.amount,
    };

    await caseProfileRepository.upsertCaseProfile(domain, row.caseId, update);
    results.push({
      caseId: row.caseId,
      action: existing ? "updated" : "created",
      sourceName: row.sourceName,
      sourceCanonicalId: canonical?.doc?._id || null,
      amount: row.amount,
      paidDate: row.paidDateKey,
      file: path.basename(row.filePath),
    });
  }

  const summary = {
    domain,
    from,
    to,
    reportsDir,
    filesScanned: files.map((filePath) => path.basename(filePath)),
    candidateRows: candidateRows.length,
    uniqueCases: rows.length,
    results,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));

  await disconnectMongo();
}

main().catch(async (error) => {
  console.error(error && error.stack ? error.stack : error);
  try {
    await disconnectMongo();
  } catch {}
  process.exit(1);
});
