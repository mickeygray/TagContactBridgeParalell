"use strict";

const WYNN_STATUSES = {
  1: { label: "Unopened", category: "prospect", color: "blue" },
  2: { label: "Opened", category: "prospect", color: "blue" },
  3: { label: "Appointment Pending", category: "prospect", color: "blue" },
  5: { label: "Waiting on Client", category: "prospect", color: "amber" },
  6: { label: "Waiting on POA/Contract", category: "prospect", color: "amber" },
  8: { label: "Contacted/Call Back", category: "prospect", color: "blue" },
  10: { label: "Services Not Started", category: "client", color: "green" },
  11: { label: "SA or POA needed", category: "client", color: "amber" },
  12: { label: "Closed/Completed", category: "other", color: "gray" },
  13: { label: "Negotiations In Progress", category: "client", color: "emerald" },
  18: { label: "1st Payment Default", category: "redline", color: "red" },
  22: { label: "Refund", category: "other", color: "gray" },
  24: { label: "Non-Payment", category: "other", color: "gray" },
  25: { label: "Hold", category: "other", color: "gray" },
  26: { label: "Changed Mind", category: "other", color: "gray" },
  35: { label: "Disconnected Number", category: "other", color: "gray" },
  36: { label: "Duplicate Lead", category: "other", color: "gray" },
  37: { label: "Never Applied", category: "other", color: "gray" },
  38: { label: "SPAM (email)", category: "other", color: "gray" },
  39: { label: "Wrong Number", category: "other", color: "gray" },
  40: { label: "Wrong Product", category: "other", color: "gray" },
  41: { label: "Fake", category: "other", color: "gray" },
  42: { label: "Language Problem", category: "other", color: "gray" },
  43: { label: "Wrong Amount", category: "other", color: "gray" },
  44: { label: "Amount Too Low", category: "other", color: "gray" },
  46: { label: "Resolved Case", category: "other", color: "gray" },
  47: { label: "No Money", category: "other", color: "gray" },
  49: { label: "Partial Interview", category: "prospect", color: "blue" },
  57: { label: "DO NOT CALL", category: "dnc", color: "red" },
  60: { label: "Account Delinquent", category: "redline", color: "red" },
  160: { label: "Appointment Pending", category: "prospect", color: "blue" },
  161: { label: "Partial Interview", category: "prospect", color: "blue" },
  162: { label: "Waiting on Contract", category: "prospect", color: "amber" },
  163: { label: "Waiting on Client", category: "prospect", color: "amber" },
  165: { label: "Consultation", category: "prospect", color: "blue" },
  171: { label: "Amount Too Low", category: "other", color: "gray" },
  172: { label: "No Money", category: "other", color: "gray" },
  173: { label: "DO NOT CALL", category: "dnc", color: "red" },
  176: { label: "New Lead", category: "prospect", color: "blue" },
  177: { label: "Appointment Pending", category: "prospect", color: "blue" },
  178: { label: "Interview", category: "prospect", color: "blue" },
  179: { label: "Reviewing Docs", category: "prospect", color: "blue" },
  180: { label: "Appointment Missed", category: "prospect", color: "gray" },
  181: { label: "Compliance Under Review", category: "client", color: "green" },
  182: { label: "Missing docs", category: "client", color: "amber" },
  183: { label: "Payment Pending", category: "client", color: "amber" },
  184: { label: "Pending PIF", category: "client", color: "amber" },
  186: { label: "No Tax Liability", category: "other", color: "gray" },
  187: { label: "Not Interested", category: "other", color: "gray" },
  190: { label: "Pending", category: "client", color: "amber" },
  191: {
    label: "Sent to Client - Pending Signatures",
    category: "client",
    color: "amber",
  },
  192: { label: "Complete - Sent to IRS", category: "client", color: "emerald" },
  193: { label: "Docs Needed", category: "client", color: "amber" },
  194: { label: "Review", category: "client", color: "green" },
  195: { label: "Docs Needed", category: "client", color: "amber" },
  196: { label: "Pending Welcome Call", category: "client", color: "amber" },
  197: { label: "Submitted to Client", category: "client", color: "green" },
  198: { label: "Submitted to IRS", category: "client", color: "green" },
  199: { label: "Pending Closing Letter", category: "client", color: "amber" },
  200: { label: "Financial Analysis Review", category: "client", color: "green" },
  201: { label: "Ready for Upsale", category: "client", color: "green" },
  202: { label: "Upsale Pitched - Considering", category: "client", color: "green" },
  203: { label: "Upsale Rejected", category: "other", color: "gray" },
  204: { label: "Upsale Complete", category: "client", color: "emerald" },
  205: { label: "Pending Transcripts", category: "client", color: "amber" },
  206: { label: "Went with Diff Company", category: "other", color: "gray" },
  207: { label: "Missing Agreement", category: "client", color: "amber" },
  208: { label: "Complete", category: "client", color: "emerald" },
  209: { label: "Chargeback", category: "other", color: "gray" },
  210: { label: "Pending State TI", category: "client", color: "amber" },
  211: {
    label: "Mismatched info Verification Needed",
    category: "client",
    color: "amber",
  },
  212: { label: "Monitoring", category: "client", color: "emerald" },
  213: { label: "Sent for Input", category: "client", color: "emerald" },
  214: { label: "Upsale Dark", category: "other", color: "gray" },
  215: { label: "State Only Debt", category: "client", color: "green" },
  216: { label: "Tier 1", category: "tier1", color: "emerald" },
  217: { label: "Tier 2", category: "tier2", color: "emerald" },
  218: { label: "Tier 3", category: "tier3", color: "teal" },
  219: { label: "Tier 4", category: "tier4", color: "teal" },
  220: { label: "Tier 5", category: "tier5", color: "teal" },
  221: { label: "POST DATE", category: "postdate", color: "amber" },
  222: { label: "CHANGE BACK TO OPENED", category: "prospect", color: "blue" },
  223: { label: "AUTO CONTACT COMPLETE", category: "exhausted", color: "gray" },
};

const TAG_STATUSES = {
  1: { label: "New Lead", category: "prospect", color: "blue" },
  2: { label: "Prospect", category: "prospect", color: "blue" },
  18: { label: "Payment Default", category: "redline", color: "red" },
  39: { label: "DNC", category: "dnc", color: "red" },
  60: { label: "Redline", category: "redline", color: "red" },
  150: { label: "Post-Date", category: "postdate", color: "amber" },
  173: { label: "DNC", category: "dnc", color: "red" },
  176: { label: "Post-Date", category: "postdate", color: "amber" },
  206: { label: "Tier 1", category: "tier1", color: "emerald" },
  207: { label: "Tier 2", category: "tier2", color: "emerald" },
  208: { label: "Tier 3", category: "tier3", color: "teal" },
  209: { label: "Tier 4", category: "tier4", color: "teal" },
  210: { label: "New Client", category: "client", color: "green" },
  211: { label: "New Client", category: "client", color: "green" },
  212: { label: "Tier 5", category: "tier5", color: "teal" },
};

const STATUS_TABLES = {
  TAG: TAG_STATUSES,
  WYNN: WYNN_STATUSES,
};

const EXPORT_STATUS_OVERRIDES = {
  TAG: {
    "non collectible refund": 22,
    "non collectible non payment": 24,
    "non collectible hold": 25,
    "non collectible changed mind": 26,
    "non collectible chargeback": 214,
    "non collectible loan default": 215,
    "active client sa or poa needed": 6,
    "active client start docs in": 210,
    "ti payment pending": 5,
    "settled/completed closed/completed": 170,
    "suspended account delinquent": 18,
    "suspended chargeback": 214,
    "suspended dead case": 185,
    "suspended 1st payment default": 18,
    "suspended payment default stop work": 18,
    "suspended payment default continue work": 60,
    "tax prep tax prep": 202,
  },
  WYNN: {
    "active prospect opened": 2,
    "active prospect unopened": 1,
    "active prospect appointment pending": 177,
    "active prospect contacted/call back": 8,
    "active prospect auto contact complete": 223,
    "non collectible refund": 22,
    "non collectible non payment": 24,
    "non collectible hold": 25,
    "non collectible changed mind": 26,
    "non collectible chargeback": 209,
    "non collectible loan default": 215,
    "suspended 1st payment default": 18,
    "suspended account delinquent": 60,
    "active client sa or poa needed": 11,
    "lead appointment pending": 177,
    "ti payment pending": 183,
    "lead reviewing docs": 179,
    "suspended payment default stop work": 18,
    "suspended payment default continue work": 60,
    "suspended chargeback": 209,
    "suspended dead case": 185,
    "settled/completed closed/completed": 12,
    "active client start docs in": 10,
    "tax prep tax prep": 202,
  },
};

function normalizeStatusText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\[\]]/g, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function resolveStatus(domain, statusId) {
  if (!statusId && statusId !== 0) {
    return { label: "Unknown", category: "other", color: "gray" };
  }

  const table = STATUS_TABLES[String(domain || "").toUpperCase()];
  if (!table) {
    return { label: `Status ${statusId}`, category: "other", color: "gray" };
  }

  return (
    table[Number(statusId)] || {
      label: `Status ${statusId}`,
      category: "other",
      color: "gray",
    }
  );
}

function buildLabelIndex(domain) {
  const table = STATUS_TABLES[String(domain || "").toUpperCase()] || {};
  const byLabel = new Map();

  for (const [statusId, entry] of Object.entries(table)) {
    byLabel.set(normalizeStatusText(entry.label), {
      statusId: Number(statusId),
      ...entry,
    });
  }

  return byLabel;
}

function resolveExportStatus(domain, rawStatus) {
  const normalized = normalizeStatusText(rawStatus);
  const byLabel = buildLabelIndex(domain);
  const overrideStatusId =
    EXPORT_STATUS_OVERRIDES[String(domain || "").toUpperCase()]?.[normalized];
  if (overrideStatusId != null) {
    const resolved = resolveStatus(domain, overrideStatusId);
    return {
      statusId: overrideStatusId,
      ...resolved,
      matchedBy: "export-override",
      rawStatus,
    };
  }

  const direct = byLabel.get(normalized);
  if (direct) {
    return { ...direct, matchedBy: "direct-label", rawStatus };
  }

  const aliasRules = [
    {
      when: normalized.includes("new lead"),
      label: "new lead",
      matchedBy: "contains-new-lead",
    },
    {
      when:
        normalized.includes("active prospect") ||
        normalized.includes("prospect") ||
        normalized.includes("opened") ||
        normalized.includes("unopened"),
      label: "prospect",
      matchedBy: "prospect-alias",
    },
    {
      when: normalized.includes("contacted/call back"),
      label: "contacted/call back",
      matchedBy: "contacted-call-back-alias",
    },
    {
      when: normalized.includes("appointment pending"),
      label: "appointment pending",
      matchedBy: "appointment-pending-alias",
    },
    {
      when: normalized.includes("auto contact complete"),
      label: "auto contact complete",
      matchedBy: "auto-contact-complete-alias",
    },
    {
      when: normalized.includes("new client"),
      label: "new client",
      matchedBy: "contains-new-client",
    },
    {
      when: normalized === "opened",
      label: "opened",
      matchedBy: "opened-direct",
    },
    {
      when: normalized === "unopened",
      label: "unopened",
      matchedBy: "unopened-direct",
    },
    {
      when: normalized.includes("post date"),
      label: "post date",
      matchedBy: "contains-post-date",
    },
    {
      when: normalized.includes("payment default"),
      label: "payment default",
      matchedBy: "contains-payment-default",
    },
    {
      when: normalized.includes("dnc") || normalized.includes("do not call"),
      label: "dnc",
      matchedBy: "contains-dnc",
    },
    {
      when: normalized.includes("exhaust"),
      label: "exhausted",
      matchedBy: "contains-exhausted",
    },
    {
      when: normalized.includes("redline"),
      label: "redline",
      matchedBy: "contains-redline",
    },
  ];

  for (const rule of aliasRules) {
    if (!rule.when) continue;
    const match = byLabel.get(rule.label);
    if (match) {
      return { ...match, matchedBy: rule.matchedBy, rawStatus };
    }
  }

  const tierMatch = normalized.match(/\btier\s*([1-5])\b/);
  if (tierMatch) {
    const match = byLabel.get(`tier ${tierMatch[1]}`);
    if (match) {
      return { ...match, matchedBy: "tier-pattern", rawStatus };
    }
  }

  return null;
}

module.exports = {
  resolveExportStatus,
  resolveStatus,
  STATUS_TABLES,
  TAG_STATUSES,
  WYNN_STATUSES,
  normalizeStatusText,
};
