"use strict";

// resolutionBankService — keeps the resolution case bank (clientProfiles)
// CURRENT. Three jobs, all riding the nightly PM close (plus operator
// script + manual-add route):
//
//   1. ELEVATION: caseProfiles (per-case operational records) that became
//      clients but have no clientProfile yet get one — the
//      caseProfiles→clientProfiles mechanic.
//   2. APPENDAGES: per-case Logics refresh (CaseInfo / CasePayments /
//      CaseBillingSummary / CaseInvoices / Activities-cursor) written into
//      profile fields + shorthand with provenance — the same ledger the
//      document scrapers feed.
//   3. MANUAL ADD: someone fell through the cracks → enter a case ID, we
//      verify it in Logics and build the entry on the spot.
//
// LOGICS DOCTRINE (hard, from scars): per-case GETs only, paced + jittered,
// stalest-first, circuit breaker on consecutive failures. NEVER the group
// ActivityReport (it emails). Activities here is cursor+count only — no LLM,
// the activity review pipeline owns reading notes.

const { createLogicsClient } = require("../../shared-integrations/src");
const { parseLogicsData } = require("./logicsFacadeService");
const { scrubDeep, scrubText } = require("./resolutionDocumentService");
const {
  upsertClientProfile,
  mergeShorthandFields,
  getClientProfileByCaseNumber,
  buildClientProfileKey,
  normalizeDomain,
} = require("../../shared-repositories/src/clientProfileRepository");

const BANK_DOMAINS = String(process.env.RESOLUTION_BANK_DOMAINS || "TAG")
  .split(",").map(normalizeDomain).filter(Boolean);

// Tier-weighted refresh dueness (hours): A ~daily, B ~3d, C ~weekly,
// D ~monthly — ≈2,400 Logics calls/day across the 2k bank at 5 GETs/case.
const REFRESH_DUE_HOURS = { A: 20, B: 68, C: 164, D: 716 };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(String(value).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function toDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function pickFirst(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== "") return row[key];
  }
  return null;
}

function unwrap(payload) {
  try {
    return parseLogicsData(payload);
  } catch {
    const data = payload && payload.Data !== undefined ? payload.Data : payload;
    if (typeof data === "string") {
      try { return JSON.parse(data); } catch { return data; }
    }
    return data;
  }
}

function asRows(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return [value];
  return [];
}

// Refunds/voids/declines never count toward "money in".
const BAD_PAYMENT_STATUS = /refund|void|charge.?back|declin|nsf|return|reject|cancel/i;

function summarizePayments(rows) {
  const good = rows.filter((r) => {
    const status = String(pickFirst(r, ["TransactionStatus", "Status", "PaymentStatus"]) || "");
    return !BAD_PAYMENT_STATUS.test(status);
  });
  const dated = good
    .map((r) => ({
      amount: num(pickFirst(r, ["Amount", "PaymentAmount", "Total"])),
      date: toDate(pickFirst(r, ["PaymentDate", "Date", "CreatedDate", "TransactionDate"])),
      type: String(pickFirst(r, ["PaymentTypeName", "PaymentType", "Type"]) || "").trim() || null,
    }))
    .filter((r) => r.amount !== null);
  dated.sort((a, b) => (a.date?.getTime() || 0) - (b.date?.getTime() || 0));
  const last = dated[dated.length - 1] || null;
  const loans = dated.filter((r) => /loan/i.test(r.type || "") && !/offset/i.test(r.type || ""));
  const lastLoan = loans[loans.length - 1] || null;
  return {
    payments: dated.length
      ? {
        lastDate: last?.date || null,
        lastAmount: last?.amount ?? null,
        lastType: last?.type || null,
        count: dated.length,
        totalPaid: Math.round(dated.reduce((sum, r) => sum + (r.amount || 0), 0) * 100) / 100,
      }
      : null,
    loan: lastLoan
      ? { funded: true, lastLoanDate: lastLoan.date || null, lastLoanTotal: lastLoan.amount ?? null }
      : null,
  };
}

// ── The appendage runner: one case, five quiet GETs ──────────────────────────
async function refreshClientProfileFromLogics({ caseNumber, domain = "TAG", client = null, logger = null } = {}) {
  const key = String(caseNumber || "").trim();
  if (!key) throw Object.assign(new Error("caseNumber required"), { status: 400 });
  const tenant = normalizeDomain(domain);
  const profileKey = buildClientProfileKey(tenant, key);
  const logics = client || createLogicsClient(tenant);
  const now = new Date();
  const shorthand = {};
  const set = { domain: tenant };
  const sourceTag = `logics:${tenant}`;
  const errors = [];

  // CaseInfo — status (carries "[TIER n]"), liabilities, unfiled flags.
  let infoRow = null;
  try {
    infoRow = asRows(unwrap(await logics.getCase(key)))[0] || null;
  } catch (error) {
    errors.push(`CaseInfo: ${error.message}`);
  }
  if (infoRow) {
    const statusName = String(pickFirst(infoRow, ["StatusName", "Status"]) || "").trim() || null;
    const tierMatch = statusName ? statusName.match(/\[\s*TIER\s*(\d)\s*\]/i) : null;
    const value = {
      statusName,
      statusId: num(pickFirst(infoRow, ["StatusID", "StatusId"])),
      statusTier: tierMatch ? Number(tierMatch[1]) : null,
      taxLiability: num(infoRow.TaxLiability),
      oweTaxesFederal: pickFirst(infoRow, ["OweTaxestoFederal", "OweTaxesToFederal"]),
      oweTaxesState: pickFirst(infoRow, ["OweTaxestoState", "OweTaxesToState"]),
      unfiledTaxesFederal: pickFirst(infoRow, ["UnfiledTaxestoFederal", "UnfiledTaxesToFederal"]),
      unfiledTaxesState: pickFirst(infoRow, ["UnfiledTaxestoState", "UnfiledTaxesToState"]),
      agency: String(infoRow.Agency || "").trim() || null,
      caseCreatedDate: pickFirst(infoRow, ["CreatedDate", "CaseCreatedDate"]),
    };
    shorthand.logics_status = {
      value,
      snippet: scrubText(`${statusName || "?"}${value.taxLiability ? ` · liability $${Number(value.taxLiability).toLocaleString()}` : ""}${value.agency ? ` · ${value.agency}` : ""}`).slice(0, 200),
      asOf: now,
      source: sourceTag,
    };
  }

  // CasePayments — authoritative money-in + Loan-type funding detection.
  try {
    const { payments, loan } = summarizePayments(asRows(unwrap(await logics.getCasePayments(key))));
    if (payments) set.payments = payments;
    if (loan) set.fundingLoan = loan;
  } catch (error) {
    errors.push(`CasePayments: ${error.message}`);
  }

  // CaseBillingSummary — PastDue is the distress signal.
  try {
    const bill = asRows(unwrap(await logics.getCaseBillingSummary(key)))[0] || null;
    if (bill) {
      const value = {
        totalFees: num(pickFirst(bill, ["TotalFees", "TotalFee"])),
        paidAmount: num(pickFirst(bill, ["PaidAmount", "Paid"])),
        balance: num(bill.Balance),
        amountDue: num(pickFirst(bill, ["AmountDue", "DueAmount"])),
        pastDue: num(pickFirst(bill, ["PastDue", "PastDueAmount"])),
      };
      shorthand.logics_billing = {
        value,
        snippet: scrubText(`fees $${(value.totalFees ?? 0).toLocaleString()} · paid $${(value.paidAmount ?? 0).toLocaleString()} · balance $${(value.balance ?? 0).toLocaleString()}${value.pastDue ? ` · PAST DUE $${value.pastDue.toLocaleString()}` : ""}`).slice(0, 200),
        asOf: now,
        source: sourceTag,
      };
    }
  } catch (error) {
    errors.push(`CaseBillingSummary: ${error.message}`);
  }

  // CaseInvoices — secondary-sale revenue ground truth, grouped by type.
  try {
    const rows = asRows(unwrap(await logics.getCaseInvoices(key)));
    if (rows.length) {
      const byGroup = {};
      let total = 0;
      for (const r of rows) {
        const group = String(pickFirst(r, ["InvoiceTypeGroup", "InvoiceType", "TypeGroup"]) || "other").trim() || "other";
        const amount = num(pickFirst(r, ["Amount", "InvoiceAmount", "Total"])) || 0;
        byGroup[group] = byGroup[group] || { count: 0, total: 0 };
        byGroup[group].count += 1;
        byGroup[group].total = Math.round((byGroup[group].total + amount) * 100) / 100;
        total += amount;
      }
      shorthand.logics_invoices = {
        value: { count: rows.length, total: Math.round(total * 100) / 100, byGroup },
        snippet: scrubText(Object.entries(byGroup).map(([g, v]) => `${g}: ${v.count} ($${v.total.toLocaleString()})`).join("; ")).slice(0, 200),
        asOf: now,
        source: sourceTag,
      };
    }
  } catch (error) {
    errors.push(`CaseInvoices: ${error.message}`);
  }

  // Activities — CURSOR ONLY (count + max ActivityID + last date). A delta
  // versus the stored cursor = "something happened" → future agent wake
  // event. The note-reading LLM lives in the activity review pipeline.
  try {
    const acts = asRows(unwrap(await logics.getActivities(key)));
    if (acts.length) {
      let maxId = 0;
      let lastDate = null;
      for (const a of acts) {
        const id = num(pickFirst(a, ["ActivityID", "ActivityId", "ID"])) || 0;
        if (id > maxId) maxId = id;
        const d = toDate(pickFirst(a, ["CreatedDate", "ActivityDate", "Date"]));
        if (d && (!lastDate || d > lastDate)) lastDate = d;
      }
      shorthand.logics_activity_cursor = {
        value: { count: acts.length, maxActivityId: maxId || null, lastActivityAt: lastDate },
        snippet: `${acts.length} activities${lastDate ? `, last ${lastDate.toISOString().slice(0, 10)}` : ""}`,
        asOf: now,
        source: sourceTag,
      };
    }
  } catch (error) {
    errors.push(`Activities: ${error.message}`);
  }

  if (!infoRow && Object.keys(shorthand).length === 0 && !set.payments) {
    const err = new Error(`Logics refresh got nothing for case ${key}${errors.length ? ` (${errors.join("; ")})` : ""}`);
    err.status = 502;
    throw err;
  }

  // Selective, ATOMIC merge: dot-paths for everything Logics returned, in
  // one update — concurrent document uploads can't be clobbered, funding
  // keys we didn't fetch (denialLenders, rejection history) survive, and
  // the dueness stamp rides the same write.
  const extraSet = {
    // The sweep's dueness clock. Distinct from lifecycle.lastRefreshedAt,
    // which EVERY upsert stamps (seeds, ingests, elevation) — using that
    // made never-polled profiles look current (due: 0 on the first run).
    "lifecycle.lastLogicsRefreshAt": now,
  };
  // Never flip an existing profile's tenant — Logics CaseIDs are
  // per-company, so a TAG-defaulted manual add of a WYNN case number must
  // not relabel (or have queried) the wrong tenant.
  extraSet.domain = tenant;
  extraSet.profileKey = profileKey;
  if (set.payments) extraSet.payments = set.payments; // whole subdoc: Logics is the authority for money-in
  if (set.fundingLoan) {
    for (const [k, v] of Object.entries(set.fundingLoan)) extraSet[`funding.${k}`] = v;
  }
  const profile = await mergeShorthandFields(key, scrubDeep(shorthand), { domain: tenant, extraSet, upsert: true });
  logger?.info?.("resolution.bank.refresh", {
    profileKey,
    caseNumber: key,
    domain: tenant,
    fields: Object.keys(shorthand),
    paymentsRefreshed: Boolean(set.payments),
    errors: errors.length ? errors : undefined,
  });
  return { profile, fields: Object.keys(shorthand), errors };
}

// ── Elevation: caseProfiles → clientProfiles ─────────────────────────────────
async function elevateCaseProfiles({ domains = BANK_DOMAINS, logger = null } = {}) {
  const mongoose = require("mongoose");
  require("../../shared-models/src");
  const CaseProfile = mongoose.model("ControlPlaneCaseProfile");
  const ClientProfile = mongoose.model("ClientProfile");

  const existing = new Set(
    (await ClientProfile.find({}, { profileKey: 1, caseNumber: 1, domain: 1 }).lean())
      .map((p) => p.profileKey || buildClientProfileKey(p.domain || "TAG", p.caseNumber)),
  );
  const candidates = await CaseProfile.find(
    { statusCategory: "client", domain: { $in: domains } },
    {
      caseId: 1, domain: 1,
      totalPaid: 1, paymentsCount: 1, lastPaymentDate: 1, lastPaymentAmount: 1,
      "callScoreSummary.latestVerdict": 1,
    },
  ).lean();

  let created = 0;
  const seededFrom = `caseProfile-elevation ${new Date().toISOString().slice(0, 10)}`;
  for (const cp of candidates) {
    const caseNumber = String(cp.caseId);
    const domain = normalizeDomain(cp.domain || "TAG");
    const profileKey = buildClientProfileKey(domain, caseNumber);
    if (!caseNumber || existing.has(profileKey)) continue;
    const verdict = String(cp.callScoreSummary?.latestVerdict || "").toLowerCase();
    await upsertClientProfile({
      caseNumber,
      domain,
      payments: {
        lastDate: cp.lastPaymentDate || null,
        lastAmount: cp.lastPaymentAmount ?? null,
        lastType: null,
        count: cp.paymentsCount || 0,
        totalPaid: cp.totalPaid || 0,
      },
      ...(["hot", "warm", "cold"].includes(verdict)
        ? { temperature: { label: verdict, signals: "from call scoring (elevation)" } }
        : {}),
      lifecycle: { status: "active", seededFrom },
    });
    existing.add(profileKey);
    created += 1;
  }
  logger?.info?.("resolution.bank.elevation", { candidates: candidates.length, created });
  return { candidates: candidates.length, created };
}

// ── The PM-close sweep: elevation + tier-weighted due refresh ────────────────
async function runResolutionBankClose({
  maxCases = Math.max(1, Number(process.env.RESOLUTION_CLOSE_MAX_CASES || 600) || 600),
  paceMs = Math.max(100, Number(process.env.RESOLUTION_CLOSE_PACE_MS || 300) || 300),
  domains = BANK_DOMAINS,
  logger = null,
} = {}) {
  const startedAt = new Date();
  const elevation = await elevateCaseProfiles({ domains, logger })
    .catch((error) => ({ error: error.message }));

  const mongoose = require("mongoose");
  const ClientProfile = mongoose.model("ClientProfile");
  const rows = await ClientProfile.find(
    { "lifecycle.status": "active" },
    {
      profileKey: 1, caseNumber: 1, domain: 1, "pursuit.tier": 1,
      "lifecycle.lastLogicsRefreshAt": 1, "lifecycle.lastLogicsAttemptAt": 1,
    },
  ).lean();

  const now = Date.now();
  // Dueness clocks off the LATER of success/attempt: a case Logics keeps
  // rejecting retries on its tier cadence like everyone else, instead of
  // leading the stalest-first queue nightly until five of its kind trip
  // the circuit breaker and starve the whole sweep.
  const lastTouch = (r) => Math.max(
    r.lifecycle?.lastLogicsRefreshAt ? new Date(r.lifecycle.lastLogicsRefreshAt).getTime() : 0,
    r.lifecycle?.lastLogicsAttemptAt ? new Date(r.lifecycle.lastLogicsAttemptAt).getTime() : 0,
  );
  const due = rows
    .filter((r) => {
      const tier = String(r.pursuit?.tier || "D").charAt(0).toUpperCase();
      const hours = REFRESH_DUE_HOURS[tier] || REFRESH_DUE_HOURS.D;
      return now - lastTouch(r) >= hours * 3_600_000;
    })
    // Stalest first — never-polled cases (whole bank on night one) lead;
    // the nightly cap walks the backlog down across the first few closes.
    .sort((a, b) => lastTouch(a) - lastTouch(b))
    .slice(0, maxCases);

  const clients = new Map();
  let refreshed = 0;
  let failed = 0;
  let consecutiveFailures = 0;
  let circuitOpened = false;
  for (const row of due) {
    const domain = normalizeDomain(row.domain || "TAG");
    const profileKey = row.profileKey || buildClientProfileKey(domain, row.caseNumber);
    if (!clients.has(domain)) clients.set(domain, createLogicsClient(domain));
    try {
      await refreshClientProfileFromLogics({
        caseNumber: row.caseNumber,
        domain,
        client: clients.get(domain),
        logger,
      });
      refreshed += 1;
      consecutiveFailures = 0;
    } catch (error) {
      failed += 1;
      consecutiveFailures += 1;
      logger?.warn?.("resolution.bank.refresh_failed", {
        profileKey,
        caseNumber: row.caseNumber,
        domain,
        error: error.message,
      });
      // Stamp the attempt so this case rejoins its tier cadence instead of
      // leading tomorrow's queue again (see lastTouch above).
      await ClientProfile.updateOne(
        { profileKey },
        { $set: { "lifecycle.lastLogicsAttemptAt": new Date() } },
      ).catch(() => null);
      // Logics looks down — stop burning the budget; tomorrow's close
      // picks up where staleness left off.
      if (consecutiveFailures >= 5) {
        circuitOpened = true;
        break;
      }
    }
    await sleep(paceMs + Math.floor(Math.random() * 200));
  }

  const result = {
    startedAt,
    finishedAt: new Date(),
    elevation,
    bankSize: rows.length,
    due: due.length,
    refreshed,
    failed,
    circuitOpened,
  };
  logger?.info?.("resolution.bank.close", result);
  return result;
}

// ── Manual add: the fell-through-the-cracks path ─────────────────────────────
async function addCaseToBank({ caseNumber, domain = "TAG", addedBy = null, logger = null } = {}) {
  const key = String(caseNumber || "").trim();
  if (!/^\d{3,12}$/.test(key)) {
    throw Object.assign(new Error("caseNumber must be a Logics case ID (digits)"), { status: 400 });
  }
  const effectiveDomain = normalizeDomain(domain);
  const profileKey = buildClientProfileKey(effectiveDomain, key);
  const existing = await getClientProfileByCaseNumber(key, effectiveDomain);
  // An existing profile's tenant wins over the requested default — querying
  // the other company's Logics for the same numeric ID would merge a
  // stranger's financials into this client.
  // effectiveDomain is explicit: a TAG and WYNN case can share the same ID.
  // Verify in Logics FIRST — a bank entry no Logics case backs is noise.
  // (refreshClientProfileFromLogics throws 502 when nothing comes back.)
  const { profile, fields, errors } = await refreshClientProfileFromLogics({
    caseNumber: key,
    domain: effectiveDomain,
    logger,
  });
  if (!existing) {
    await upsertClientProfile({
      caseNumber: key,
      domain: effectiveDomain,
      lifecycle: {
        status: "active",
        seededFrom: `manual-add${addedBy ? ` by ${addedBy}` : ""} ${new Date().toISOString().slice(0, 10)}`,
      },
    });
  } else if (existing.lifecycle?.status === "retired") {
    // Manual re-add of a retired case is an explicit "this one matters" —
    // bring it back into the active bank or the add silently does nothing
    // visible (the bank lists active only).
    await upsertClientProfile({ caseNumber: key, domain: effectiveDomain, lifecycle: { status: "active" } });
  }
  logger?.info?.("resolution.bank.manual_add", {
    profileKey,
    caseNumber: key,
    domain: effectiveDomain,
    existed: Boolean(existing),
    addedBy,
  });
  return {
    profile: await getClientProfileByCaseNumber(key, effectiveDomain),
    created: !existing,
    fields,
    errors,
  };
}

module.exports = {
  refreshClientProfileFromLogics,
  elevateCaseProfiles,
  runResolutionBankClose,
  addCaseToBank,
  REFRESH_DUE_HOURS,
};
