"use strict";

// Stage 1 of the nightly pass: ActivityReport rows → typed ActivityEvents.
// (Pipeline contract Part I stage 1; grammar per master plan §4; every
// pattern below was censused from 4,130 real rows on 2026-07-23 + 07-27.)
//
// PURE parse — no I/O, no clocks. `insertActivityEvents` is the one writer,
// and counters derive from ITS outcomes (first-seen inserts), never from
// raw rows: the feed windows on LastModifiedDate, so edited old activities
// resurface and would otherwise re-inflate every counter.

const crypto = require("crypto");

const { ActivityEvent } = require("../../shared-models/src");

// ── the system partition (exact, censused: 3,389/4,130 rows) ─────────────
// `Case received from X` = intake (kept as intake events — the free lead
// feed); `Case updated by Public API` = our own writes echoing back (never
// interpreted). CreatedBy is NOT the filter — a human Mickey row survives.
const INTAKE_RE = /^Case received from\s+(.+)$/i;
const API_ECHO_RE = /^Case updated by Public API/i;

// ── the money tip-off lanes (typed by Logics itself) ─────────────────────
const MONEY_LANES = new Set(["Payment", "CaseAccount", "LOAN"]);
const PAYMENT_VERB_RE = /^Payment (made|Declined|deleted)\s*\$([\d,]+\.?\d*)/i;

// ── General-lane grammar (subjects are structured where Logics wrote them)
const STATUS_RE = /^Status changed from\s+"(.+?)"\s+to\s+"(.+?)"/i;
const ASSIGN_RE = /^Assigned to\s+(.+?)\s*:\s*(.+)$/;
const CONVERSION_RE = /^(Converted from prospect to client|Approved - Converted to client|Converted to Prospect|Submitted for approval|Case created)\s*$/i;
const LIABILITY_RE = /^Tax Liability changed to\s+([\d,.]+)\s+from\s+([\d,.]+)/i;
const SOURCE_RE = /^Source updated to\s+(.+)$/i;
const SCORE_RE = /(?:isoftpull|transunion).*?score:\s*(\d{3})/i;
const TASK_RE = /^(New task assigned to|Task updated|Task Completed|Task marked as completed|Task deleted)/i;

// Status names are "[Bracket]-Label". Safety classes match on the LABEL
// suffix — POST DATE appears under three different brackets, so matching
// the full string is exactly the mistake this avoids.
function parseStatusName(name) {
  const m = String(name || "").match(/^\[(.+?)\]\s*-\s*(.*)$/);
  const bracket = m ? m[1].trim() : null;
  const label = (m ? m[2] : String(name || "")).trim();
  let safetyClass = null;
  if (/DO NOT CALL/i.test(label)) safetyClass = "dnc";
  else if (/POST\s*DATE/i.test(label)) safetyClass = "postdate";
  else if (/suspend|payment default|1st payment default/i.test(`${bracket} ${label}`)) safetyClass = "suspended";
  return { bracket, label, safetyClass };
}

function parseMoney(text) {
  const m = String(text || "").match(/\$([\d,]+\.?\d*)/);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

function parseCreated(value) {
  // "7/23/2026 4:13:51 PM" — Pacific wall clock. Parsed leniently; the raw
  // string is what the dedupeKey uses, so a parse miss never breaks dedupe.
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/** dedupeKey: IMMUTABLE fields only. Created, never LastModifiedDate — the
 * window selects on LastModified, so a touched row resurfaces with a new
 * LastModifiedDate; keying on it would defeat the dedupe entirely. */
function buildDedupeKey({ domain, caseId, subject, created }) {
  return crypto.createHash("sha1")
    .update(`${domain}|${caseId}|${String(subject)}|${String(created)}`)
    .digest("hex");
}

/** Classify ONE report row. Pure. Returns { kind, payload, staff } —
 * staff=false for the system lane (intake / API echo / rule engine). */
function classifyRow(row) {
  const type = String(row.Type || "").trim();
  const subject = String(row.ActivitySubject || "").trim();

  const intake = subject.match(INTAKE_RE);
  if (intake) return { kind: "intake", staff: false, payload: { source: intake[1].trim() } };
  if (API_ECHO_RE.test(subject)) return { kind: "system-echo", staff: false, payload: { echo: "public-api" } };
  if (/^RuleEngine$/i.test(type)) return { kind: "system-echo", staff: false, payload: { echo: "rule-engine" } };

  if (MONEY_LANES.has(type)) {
    const verb = subject.match(PAYMENT_VERB_RE);
    return {
      kind: "payment-claim",
      staff: true,
      payload: {
        lane: type.toLowerCase(),
        verb: verb ? verb[1].toLowerCase() : /invoice/i.test(subject) ? "invoice" : /plan/i.test(subject) ? "plan" : "other",
        amountClaimed: verb ? Number(verb[2].replace(/,/g, "")) : parseMoney(subject),
      },
    };
  }

  if (/^New File Uploaded$/i.test(type)) return { kind: "doc-upload", staff: true, payload: null };
  if (/^Document sent$/i.test(type)) return { kind: "doc-sent", staff: true, payload: null };
  if (/^Conversation$/i.test(type)) return { kind: "conversation", staff: true, payload: null };
  if (/softpull/i.test(type) || SCORE_RE.test(subject)) {
    const score = subject.match(SCORE_RE);
    return { kind: "credit-score", staff: true, payload: score ? { score: Number(score[1]), bureau: "TransUnion" } : null };
  }

  const status = subject.match(STATUS_RE);
  if (status) {
    const from = parseStatusName(status[1]);
    const to = parseStatusName(status[2]);
    return {
      kind: "status-change",
      staff: true,
      payload: {
        fromStatus: status[1].trim(), toStatus: status[2].trim(),
        fromLabel: from.label, toLabel: to.label,
        toBracket: to.bracket, safetyClass: to.safetyClass,
        selfTransition: status[1].trim() === status[2].trim(),
      },
    };
  }

  const assign = subject.match(ASSIGN_RE);
  if (assign) {
    const assignee = assign[2].trim();
    return {
      kind: "assignment",
      staff: true,
      payload: {
        role: assign[1].trim(),
        // --Unassigned-- is a valid assignee meaning "slot cleared".
        assignee: /^--\s*Unassigned\s*--$/i.test(assignee) ? null : assignee,
      },
    };
  }

  const conversion = subject.match(CONVERSION_RE);
  if (conversion) return { kind: "conversion", staff: true, payload: { stage: conversion[1].trim() } };

  const liability = subject.match(LIABILITY_RE);
  if (liability) {
    return {
      kind: "liability-change",
      staff: true,
      payload: { to: Number(liability[1].replace(/,/g, "")), from: Number(liability[2].replace(/,/g, "")) },
    };
  }

  const source = subject.match(SOURCE_RE);
  if (source) return { kind: "source-update", staff: true, payload: { source: source[1].trim() } };

  if (TASK_RE.test(subject)) {
    const parens = subject.match(/\(([^)]*)\)\s*$/);
    return { kind: "task", staff: true, payload: { taskText: parens ? parens[1].trim() : null } };
  }

  if (!subject && !type) return { kind: "unclassified", staff: true, payload: null };

  // Staff free text — the model residue ("SWC", "A/S REVIEW:", "RE REDLINE:").
  return { kind: "note", staff: true, payload: null };
}

/**
 * Parse one domain-day of report rows into events. PURE — no I/O.
 *
 * Returns:
 *   events      — one per row, dedupeKey'd, ready for insertActivityEvents
 *   staffCases  — Set<caseId> touched by any staff-lane row
 *   moneyCases  — Set<caseId> for the money loop: payment-lane cases ∪ ALL
 *                 staff-touched cases (the $29,405 check lesson — 2/9 real
 *                 payments had no payment activity)
 *   stats       — raw parse tallies (NOT the day-doc counters; those come
 *                 from insert outcomes)
 */
function parseReportRows(rows = [], { domain, dateKey } = {}) {
  const dom = String(domain || "").toUpperCase();
  const events = [];
  const staffCases = new Set();
  const paymentLaneCases = new Set();
  const stats = { rows: 0, staffRows: 0, systemRows: 0, byKind: {} };

  for (const row of Array.isArray(rows) ? rows : []) {
    stats.rows += 1;
    const caseId = Number(row.CaseID) || null;
    const subject = String(row.ActivitySubject || "").trim();
    const { kind, staff, payload } = classifyRow(row);

    stats.byKind[kind] = (stats.byKind[kind] || 0) + 1;
    if (staff) {
      stats.staffRows += 1;
      if (caseId) staffCases.add(caseId);
      if (kind === "payment-claim" && caseId) paymentLaneCases.add(caseId);
    } else {
      stats.systemRows += 1;
    }

    events.push({
      domain: dom,
      caseId,
      dateKey: String(dateKey || ""),
      kind,
      subject: subject.slice(0, 300),
      createdAt: parseCreated(row.Created),
      createdBy: String(row.CreatedBy || "").trim() || null,
      payload,
      source: "grammar",
      dedupeKey: buildDedupeKey({ domain: dom, caseId, subject, created: row.Created }),
      needsReview: false,
    });
  }

  const moneyCases = new Set([...paymentLaneCases, ...staffCases]);
  return { events, staffCases, moneyCases, paymentLaneCases, stats };
}

/**
 * The one writer. Bulk insert, unordered; duplicate dedupeKeys no-op.
 * Returns first-seen vs resurfaced counts — THE inputs for day-doc counters.
 */
async function insertActivityEvents(events = []) {
  if (!events.length) return { inserted: 0, resurfaced: 0, byKind: {} };
  let inserted = 0;
  let insertedDocs = [];
  try {
    insertedDocs = await ActivityEvent.insertMany(events, { ordered: false, rawResult: false });
    inserted = insertedDocs.length;
  } catch (error) {
    // Unordered bulk: duplicates land in writeErrors, the rest insert fine.
    const writeErrors = error?.writeErrors || (error?.code === 11000 ? [] : null);
    if (writeErrors === null) throw error;
    inserted = error?.insertedDocs?.length ?? Math.max(0, events.length - (writeErrors.length || 0));
    insertedDocs = error?.insertedDocs || [];
  }
  const byKind = {};
  for (const doc of insertedDocs) byKind[doc.kind] = (byKind[doc.kind] || 0) + 1;
  return { inserted, resurfaced: events.length - inserted, byKind };
}

module.exports = {
  buildDedupeKey,
  classifyRow,
  insertActivityEvents,
  parseCreated,
  parseReportRows,
  parseStatusName,
};
