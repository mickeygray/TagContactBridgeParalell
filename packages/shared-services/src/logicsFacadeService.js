"use strict";

const { createLogicsClient } = require("../../shared-integrations/src");

function parseLogicsData(payload) {
  if (!payload) return null;

  const raw =
    payload.data !== undefined && payload.data !== null
      ? payload.data
      : payload.Data !== undefined && payload.Data !== null
        ? payload.Data
        : payload;

  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  return raw;
}

function createLogicsFacade(domain) {
  const client = createLogicsClient(domain);

  return {
    async fetchCaseInfo(caseId, details) {
      try {
        const payload = await client.getCaseInfo(caseId, details);
        const data = parseLogicsData(payload);
        if (!data) {
          return { ok: false, error: "No data returned" };
        }

        return {
          ok: true,
          status: data.StatusID ?? data.Status ?? null,
          data,
        };
      } catch (error) {
        return {
          ok: false,
          error:
            error?.details?.responseBody?.Message ||
            error?.details?.responseBody?.message ||
            error.message,
        };
      }
    },

    async fetchBillingSummary(caseId) {
      const payload = await client.getCaseBillingSummary(caseId);
      return parseLogicsData(payload);
    },

    async fetchActivities(caseId) {
      const payload = await client.getActivities(caseId);
      const data = parseLogicsData(payload);
      return Array.isArray(data) ? data : [];
    },

    async fetchPayments(caseId) {
      const payload = await client.getCasePayments(caseId);
      const data = parseLogicsData(payload);
      return Array.isArray(data) ? data : [];
    },

    async fetchInvoices(caseId) {
      const payload = await client.getCaseInvoices(caseId);
      const data = parseLogicsData(payload);
      return Array.isArray(data) ? data : [];
    },

    async findCaseByPhone(phone) {
      const payload = await client.findCaseByPhone(phone);
      const data = parseLogicsData(payload);
      const rows = Array.isArray(data) ? data : data ? [data] : [];
      const matches = rows
        .filter((row) => row && row.CaseID)
        .map((row) => ({
          domain: client.company.key,
          caseId: row.CaseID,
          firstName: row.FirstName || "",
          lastName: row.LastName || "",
          name: `${row.FirstName || ""} ${row.LastName || ""}`.trim(),
          statusId: row.StatusID ?? row.Status ?? null,
          saleDate: row.SaleDate || null,
          email: row.Email || "",
          cellPhone: row.CellPhone || "",
          homePhone: row.HomePhone || "",
          workPhone: row.WorkPhone || "",
          city: row.City || "",
          state: row.State || "",
          taxAmount: row.TaxAmount || 0,
          createdDate: row.CreatedDate || null,
          sourceName: row.SourceName || "",
        }));

      return {
        ok: matches.length > 0,
        matches,
        phone: String(phone || "").replace(/\D/g, ""),
      };
    },

    async getCasesByStatus(statusId, options = {}) {
      const payload = await client.getCasesByStatus(statusId, options);
      const data = parseLogicsData(payload);
      return Array.isArray(data)
        ? data
            .map((value) => {
              if (Number.isFinite(Number(value))) return Number(value);
              if (value && typeof value === "object") {
                return Number(
                  value.CaseID
                  ?? value.caseId
                  ?? value.ID
                  ?? value.Id
                  ?? value.id,
                );
              }
              return Number.NaN;
            })
            .filter((value) => Number.isFinite(value))
        : [];
    },
  };
}

module.exports = {
  createLogicsFacade,
  parseLogicsData,
};
