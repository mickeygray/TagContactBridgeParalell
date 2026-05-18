"use strict";

const mongoose = require("mongoose");
const {
  legacyReadDb,
  resolveLegacyReadDbName,
} = require("../../shared-repositories/src/legacyReadDb");

function getLegacyDbName() {
  return resolveLegacyReadDbName(mongoose);
}

function getLegacyDb() {
  return legacyReadDb(mongoose);
}

function buildSearchQuery(search) {
  const value = String(search || "").trim();
  if (!value) return null;

  const regex = new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const digits = value.replace(/\D/g, "");
  const clauses = [
    { name: regex },
    { email: regex },
    { cell: regex },
    { caseNumber: regex },
    { status: regex },
    { stage: regex },
  ];

  if (digits) {
    clauses.push({ cell: new RegExp(digits) });
    clauses.push({ caseNumber: digits });
  }

  return { $or: clauses };
}

function normalizeLegacyClient(row = {}) {
  const caseId = Number(row.caseNumber);
  return {
    caseId: Number.isFinite(caseId) ? caseId : null,
    name: row.name || null,
    email: row.email || null,
    primaryPhone: row.cell || null,
    normalizedPhone: String(row.cell || "").replace(/\D/g, "") || null,
    status: row.status || null,
    currentStage: row.stage || null,
    updatedAt: row.lastContactDate || row.createDate || row.saleDate || null,
    statusCategory: "client",
    totalPayment: Number(row.totalPayment || 0) || 0,
    initialPayment: Number(row.initialPayment || 0) || 0,
    invoiceCount: Number(row.invoiceCount || 0) || 0,
    lastInvoiceAmount: Number(row.lastInvoiceAmount || 0) || 0,
    lastInvoiceDate: row.lastInvoiceDate || null,
    secondPaymentDate: row.secondPaymentDate || null,
    delinquentAmount: Number(row.delinquentAmount || 0) || 0,
    delinquentDate: row.delinquentDate || null,
    saleDate: row.saleDate || null,
    reviewDates: Array.isArray(row.reviewDates) ? row.reviewDates : [],
    stagesReceived: Array.isArray(row.stagesReceived) ? row.stagesReceived : [],
    stagePieces: Array.isArray(row.stagePieces) ? row.stagePieces : [],
  };
}

async function listLegacyClients(domain, filters = {}) {
  const query = {
    domain: String(domain || "").toUpperCase(),
  };

  if (filters.search) {
    Object.assign(query, buildSearchQuery(filters.search));
  }

  if (filters.status) {
    query.status = String(filters.status).trim();
  }

  const limit = Math.min(Number(filters.limit) || 200, 5000);
  const rows = await getLegacyDb()
    .collection("clients")
    .find(query)
    .sort({ lastContactDate: -1, createDate: -1, caseNumber: -1 })
    .limit(limit)
    .toArray();

  return rows
    .map(normalizeLegacyClient)
    .filter((row) => Number.isFinite(Number(row.caseId)));
}

module.exports = {
  listLegacyClients,
};
