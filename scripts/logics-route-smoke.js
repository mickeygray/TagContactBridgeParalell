"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createLogicsClient } = require("../packages/shared-integrations/src");
const { buildDomainStatusScanPlan } = require("../packages/shared-services/src");

const EXPORT_DIR = process.env.LOGICS_EXPORT_DIR || path.join(os.homedir(), "Downloads");

function normalizeResponseData(payload) {
  if (!payload) {
    return payload;
  }

  const rawData =
    payload.data !== undefined && payload.data !== null
      ? payload.data
      : payload.Data !== undefined && payload.Data !== null
        ? payload.Data
        : payload;

  if (typeof rawData === "string") {
    try {
      return JSON.parse(rawData);
    } catch {
      return rawData;
    }
  }

  return rawData;
}

function summarizeResult(name, ok, details = {}) {
  return {
    route: name,
    ok,
    ...details,
  };
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current);
  return values.map((value) => value.trim());
}

function getFallbackSeed(domain) {
  const fileByDomain = {
    TAG: path.join(EXPORT_DIR, "CaseFilter_All_20260417101725.csv"),
    WYNN: path.join(EXPORT_DIR, "CaseFilter_All_20260417102000.csv"),
  };

  const filePath = fileByDomain[String(domain || "").toUpperCase()];
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }

  // Logics CSV exports on Windows are UTF-16 LE with a BOM; on Linux
  // they may arrive as UTF-8. Sniff the BOM, decode accordingly.
  const buffer = fs.readFileSync(filePath);
  const raw = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe
    ? buffer.toString("utf16le").replace(/^\uFEFF/, "")
    : buffer.toString("utf8").replace(/^\uFEFF/, "");
  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) {
    return null;
  }

  const headers = parseCsvLine(lines[0]);
  const values = parseCsvLine(lines[1]);
  const row = {};
  headers.forEach((header, index) => {
    row[header] = values[index] || "";
  });

  const caseId = Number(row["Case #"]);
  const phone = String(row.Cell || "")
    .replace(/\D/g, "")
    .replace(/^1(\d{10})$/, "$1");

  return {
    caseId: Number.isFinite(caseId) ? caseId : null,
    phone: phone.length === 10 ? phone : "",
  };
}

async function testDomain(domain) {
  const client = createLogicsClient(domain);
  const plan = buildDomainStatusScanPlan(domain);
  const results = [];
  const prospectStatusIds = plan?.prospectStatusIds || [];

  let caseId = null;
  let caseInfoData = null;
  let normalizedPhone = null;
  let fallbackPhone = "";

  if (prospectStatusIds.length === 0) {
    return {
      domain,
      ok: false,
      error: "No prospect status ids configured",
      results,
    };
  }

  const scanAttempts = [];
  for (const prospectStatusId of prospectStatusIds.slice(0, 5)) {
    try {
      const payload = await client.getCasesByStatus(prospectStatusId);
      const ids = normalizeResponseData(payload);
      const list = Array.isArray(ids)
        ? ids.map((value) => Number(value)).filter(Number.isFinite)
        : [];

      scanAttempts.push({
        statusId: prospectStatusId,
        ok: true,
        count: list.length,
      });

      if (caseId == null && list.length > 0) {
        caseId = list[0];
      }
    } catch (error) {
      scanAttempts.push({
        statusId: prospectStatusId,
        ok: false,
        error: error.message,
        details: error.details || null,
      });
    }
  }

  results.push(
    summarizeResult(
      "Case/GetCasesByStatus",
      scanAttempts.some((attempt) => attempt.ok),
      {
        attempts: scanAttempts,
        sampleCaseId: caseId,
      },
    ),
  );

  const caseStatusProbeId = prospectStatusIds[0];
  try {
    const payload = await client.getCaseStatusInfo(caseStatusProbeId);
    const data = normalizeResponseData(payload);
    results.push(
      summarizeResult("Case/CaseStatusInfo", true, {
        statusId: caseStatusProbeId,
        hasData: Boolean(data),
      }),
    );
  } catch (error) {
    results.push(
      summarizeResult("Case/CaseStatusInfo", false, {
        statusId: caseStatusProbeId,
        error: error.message,
        details: error.details || null,
      }),
    );
  }

  if (caseId == null) {
    const seed = getFallbackSeed(domain);
    caseId = seed?.caseId ?? null;
    fallbackPhone = seed?.phone || "";
    if (caseId != null) {
      results.push(
        summarizeResult("FallbackCaseId", true, {
          caseId,
          source: "csv-export",
          hasPhone: Boolean(fallbackPhone),
        }),
      );
    }
  }

  if (caseId != null) {
    try {
      const payload = await client.getCaseInfo(caseId);
      caseInfoData = normalizeResponseData(payload);
      normalizedPhone = String(
        caseInfoData?.CellPhone || caseInfoData?.HomePhone || caseInfoData?.WorkPhone || "",
      ).replace(/\D/g, "");
      if (normalizedPhone.length === 11 && normalizedPhone.startsWith("1")) {
        normalizedPhone = normalizedPhone.slice(1);
      }
      if (normalizedPhone.length !== 10) {
        normalizedPhone = "";
      }

      results.push(
        summarizeResult("Case/CaseInfo", true, {
          caseId,
          status: caseInfoData?.Status ?? caseInfoData?.StatusID ?? null,
          sourceId:
            caseInfoData?.SourceID ??
            caseInfoData?.SourceId ??
            caseInfoData?.CampaignID ??
            null,
          hasPhone: Boolean(normalizedPhone),
        }),
      );
    } catch (error) {
      results.push(
        summarizeResult("Case/CaseInfo", false, {
          caseId,
          error: error.message,
          details: error.details || null,
        }),
      );
    }

    for (const [routeName, fn] of [
      ["Billing/CasePayment", () => client.getCasePayments(caseId)],
      ["Billing/CaseInvoice", () => client.getCaseInvoices(caseId)],
      ["Billing/CaseBillingsummary", () => client.getCaseBillingSummary(caseId)],
      ["CaseActivity/Activity", () => client.getActivities(caseId)],
    ]) {
      try {
        const payload = await fn();
        const data = normalizeResponseData(payload);
        results.push(
          summarizeResult(routeName, true, {
            caseId,
            kind: Array.isArray(data) ? "array" : typeof data,
            count: Array.isArray(data) ? data.length : null,
          }),
        );
      } catch (error) {
        results.push(
          summarizeResult(routeName, false, {
            caseId,
            error: error.message,
            details: error.details || null,
          }),
        );
      }
    }

    const phoneForLookup = normalizedPhone || fallbackPhone;
    if (phoneForLookup) {
      try {
        const payload = await client.findCaseByPhone(phoneForLookup);
        const data = normalizeResponseData(payload);
        results.push(
          summarizeResult("Find/FindCaseByPhone", true, {
            phone: phoneForLookup,
            kind: Array.isArray(data) ? "array" : typeof data,
            count: Array.isArray(data) ? data.length : null,
          }),
        );
      } catch (error) {
        results.push(
          summarizeResult("Find/FindCaseByPhone", false, {
            phone: phoneForLookup,
            error: error.message,
            details: error.details || null,
          }),
        );
      }
    } else {
      results.push(
        summarizeResult("Find/FindCaseByPhone", false, {
          caseId,
          error: "No phone available on sampled case",
        }),
      );
    }
  }

  return {
    domain,
    ok: results.every((result) => result.ok),
    caseId,
    results,
  };
}

async function main() {
  const domains = ["TAG", "WYNN"];
  const summaries = [];

  for (const domain of domains) {
    summaries.push(await testDomain(domain));
  }

  console.log(JSON.stringify(summaries, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
