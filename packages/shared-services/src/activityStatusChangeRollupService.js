"use strict";

// Status-change day rollup from the Logics ACTIVITY feed (Mickey,
// 2026-07-27): "status changes are recorded as activities ... that way we
// can count DNCs, count post dates from a canonical source. Activities."
//
// Every status flip in Logics writes an activity whose subject reads
// `Status changed from "X" to "Y"`. Counting those — instead of inferring
// from next-morning case-status snapshots — gives the end-of-day close its
// DNC and post-date counts from the same feed the CRM itself writes, the
// way payments now come from the payment sheet.
//
// Category resolution goes through the status CATALOG, never a hardcoded
// list: activity text carries status NAMES, `resolveExportStatus` maps a
// name to its tenant-scoped id, and the id's catalog category is what we
// count. An unresolvable name lands in `unresolved`, visibly.

const { resolveExportStatus } = require("../../shared-config/src/statusMap");

function clean(value, max = 300) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function pick(row, keys) {
  for (const key of keys) {
    const value = row?.[key];
    if (value != null && String(value).trim() !== "") return value;
  }
  return "";
}

function extractCaseId(row) {
  const value = pick(row, ["CaseID", "Case ID", "CaseId", "Case #", "Case", "Case Number", "CaseNumber"]);
  const number = Number(String(value ?? "").replace(/[^\d]/g, ""));
  return Number.isFinite(number) && number > 0 ? number : null;
}

// Same subject grammar the activity-review service parses; kept in sync by
// the shared test fixture rather than a cross-module import so this module
// stays dependency-light.
function parseStatusChange(subject) {
  const text = clean(subject, 1000);
  const quoted = [...text.matchAll(/"([^"]*)"/g)].map((match) => clean(match[1]));
  if (quoted.length >= 2) return { fromStatus: quoted[0], toStatus: quoted[1] };
  const match = text.match(/status\s+changed\s+from\s+(.+?)\s+to\s+(.+)$/i);
  if (!match) return { fromStatus: "", toStatus: "" };
  return {
    fromStatus: clean(match[1]).replace(/^"|"$/g, ""),
    toStatus: clean(match[2]).replace(/^"|"$/g, ""),
  };
}

function isStatusChangeActivity(row) {
  const subject = clean(pick(row, ["Subject", "Activity Subject", "ActivitySubject", "Title"]), 1000);
  return /status\s+changed\s+from/i.test(subject);
}

/**
 * Extract every status-change activity from a day's activity rows.
 */
function extractStatusChanges(rows = []) {
  const changes = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isStatusChangeActivity(row)) continue;
    const caseId = extractCaseId(row);
    if (!caseId) continue;
    const subject = clean(pick(row, ["Subject", "Activity Subject", "ActivitySubject", "Title"]), 1000);
    const { fromStatus, toStatus } = parseStatusChange(subject);
    changes.push({
      caseId,
      fromStatus,
      toStatus,
      changedAt: clean(pick(row, ["CreatedDate", "Created Date", "ActivityDate", "Activity Date", "Created", "Date"]), 80),
      changedBy: clean(pick(row, ["CreatedBy", "Created By", "User", "Agent", "Employee"]), 120),
    });
  }
  return changes;
}

/**
 * Count a day's status changes by catalog category for one tenant.
 *
 * A case that flips several times in one day counts ONCE, on its FINAL
 * status of the day — the close reports where the day ended, not how many
 * times an agent clicked. Per-transition detail stays in `changes`.
 */
function rollupStatusChanges({ domain, rows = [] } = {}) {
  const normalizedDomain = String(domain || "").trim().toUpperCase();
  if (!normalizedDomain) throw new TypeError("domain is required");

  const changes = extractStatusChanges(rows);

  // Last flip per case wins (rows arrive in feed order; changedAt text
  // formats vary, so feed order is the tiebreak when dates do not parse).
  const finalByCase = new Map();
  for (const change of changes) {
    const previous = finalByCase.get(change.caseId);
    if (!previous) {
      finalByCase.set(change.caseId, change);
      continue;
    }
    const prevMs = Date.parse(previous.changedAt);
    const nextMs = Date.parse(change.changedAt);
    if (!Number.isFinite(prevMs) || !Number.isFinite(nextMs) || nextMs >= prevMs) {
      finalByCase.set(change.caseId, change);
    }
  }

  const byCategory = {};
  const byStatus = new Map();
  const dncCases = [];
  const postdateCases = [];
  let unresolved = 0;

  for (const change of finalByCase.values()) {
    const resolvedTo = change.toStatus
      ? resolveExportStatus(normalizedDomain, change.toStatus)
      : null;
    const category = resolvedTo?.statusId != null ? resolvedTo.category : null;
    if (!category) {
      unresolved += 1;
      continue;
    }
    byCategory[category] = (byCategory[category] || 0) + 1;
    const statusLabel = resolvedTo.label || change.toStatus;
    byStatus.set(statusLabel, (byStatus.get(statusLabel) || 0) + 1);
    if (category === "dnc") {
      dncCases.push({ caseId: change.caseId, toStatus: statusLabel, changedBy: change.changedBy });
    }
    if (category === "postdate") {
      postdateCases.push({ caseId: change.caseId, toStatus: statusLabel, changedBy: change.changedBy });
    }
  }

  return {
    domain: normalizedDomain,
    transitions: changes.length,
    casesChanged: finalByCase.size,
    // The two counts Mickey asked the close to carry, plus the full map.
    dnc: byCategory.dnc || 0,
    postdate: byCategory.postdate || 0,
    byCategory,
    byStatus: Object.fromEntries(byStatus),
    dncCases,
    postdateCases,
    unresolved,
    changes,
  };
}

module.exports = {
  extractStatusChanges,
  parseStatusChange,
  rollupStatusChanges,
};
