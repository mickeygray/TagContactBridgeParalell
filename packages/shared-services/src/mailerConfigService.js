"use strict";

const { createSendgridClient } = require("../../shared-integrations/src");
const { mailerConfigRepository } = require("../../shared-repositories/src");

let cache = {};
let digitIndex = {};
let loaded = false;
let lastLoadedAt = null;

function normalizeDigits(value) {
  return mailerConfigRepository.normalizeDigits(value);
}

function normalizePhone(value) {
  return mailerConfigRepository.normalizePhone(value);
}

function getAssignments(phone) {
  const digits = normalizeDigits(phone);
  if (!digits || digits.length !== 10) return null;
  const key = digitIndex[digits];
  if (!key) return null;
  return { key, assignments: cache[key] || [] };
}

async function loadMailerConfigCache() {
  const docs = await mailerConfigRepository.listMailerConfigs();
  const nextCache = {};
  const nextIndex = {};

  for (const doc of docs) {
    nextCache[doc.phone] = Array.isArray(doc.assignments) ? doc.assignments : [];
    nextIndex[doc.digits] = doc.phone;
  }

  cache = nextCache;
  digitIndex = nextIndex;
  loaded = true;
  lastLoadedAt = new Date();

  return {
    loaded: docs.length,
    active: docs.filter((doc) => (doc.assignments || []).some((assignment) => assignment.active)).length,
    lastLoadedAt,
  };
}

function isMailerConfigLoaded() {
  return loaded;
}

function getMailerConfigState() {
  return {
    loaded,
    trackedNumbers: Object.keys(digitIndex).length,
    activeNumbers: getActiveMailers().length,
    lastLoadedAt,
  };
}

function resolveMailer(phone) {
  const result = getAssignments(phone);
  if (!result) return null;
  const current =
    result.assignments.find((assignment) => assignment.active) ||
    result.assignments[result.assignments.length - 1] ||
    null;
  return current ? { phone: result.key, ...current } : null;
}

function resolveMailerAt(phone, date) {
  const result = getAssignments(phone);
  if (!result) return null;
  const targetDate = new Date(date);
  if (Number.isNaN(targetDate.getTime())) return resolveMailer(phone);

  const match = result.assignments.find((assignment) => {
    const from = new Date(assignment.from);
    const to = assignment.to ? new Date(assignment.to) : new Date("2099-12-31");
    return targetDate >= from && targetDate <= to;
  });

  return match ? { phone: result.key, ...match } : resolveMailer(phone);
}

function getActiveMailers() {
  const active = [];
  for (const [phone, assignments] of Object.entries(cache)) {
    const current = assignments.find((assignment) => assignment.active);
    if (current) active.push({ phone, ...current });
  }
  return active;
}

function getMailerHistory(phone) {
  const result = getAssignments(phone);
  return result ? result.assignments : [];
}

function resolveMailerByTrackingNumber(trackingNumber) {
  const digits = normalizeDigits(trackingNumber);
  if (!digits) return null;
  for (const [phone, assignments] of Object.entries(cache)) {
    for (const assignment of assignments) {
      if (normalizeDigits(assignment.crTrackingNumber) === digits) {
        return { phone, ...assignment };
      }
    }
  }
  return null;
}

function resolveMailerByRcExtension(extensionId) {
  const normalized = String(extensionId || "").trim();
  if (!normalized) return null;
  for (const [phone, assignments] of Object.entries(cache)) {
    for (const assignment of assignments) {
      if (String(assignment.rcExt || "").trim() === normalized) {
        return { phone, ...assignment };
      }
    }
  }
  return null;
}

async function sendMailerReconcileEmail(lines = []) {
  if (!lines.length) return { ok: false, skipped: true };

  const client = createSendgridClient("TAG");
  const payload = {
    personalizations: [
      {
        to: [{ email: "mgray@taxadvocategroup.com" }],
        custom_args: {
          company: "TAG",
          category: "mailer-reconcile",
        },
      },
    ],
    from: {
      email: "mgray@taxadvocategroup.com",
      name: "Matt Gray",
    },
    subject: "Mailer Config Reconciliation",
    content: [
      {
        type: "text/plain",
        value: lines.join("\n"),
      },
    ],
  };

  await client.sendEmail(payload);
  return { ok: true };
}

async function reconcileMailerConfigsWithSheet(sheetRows = [], options = {}) {
  const recentCutoff = new Date();
  recentCutoff.setDate(recentCutoff.getDate() - 14);

  const sheetActive = new Set();
  const sheetByDigits = {};
  for (const row of sheetRows) {
    const digits = normalizeDigits(row.phone);
    const dropDate = new Date(row.dropDate || row.date);
    if (!digits || Number.isNaN(dropDate.getTime())) continue;
    if (dropDate >= recentCutoff) {
      sheetActive.add(digits);
      sheetByDigits[digits] = {
        jobName: row.jobName || row.mailHouseName || null,
        dropDate: row.dropDate || row.date || null,
        pieces: Number(row.pieces || 0),
        spend: Number(row.total || row.spend || 0),
      };
    }
  }

  const docs = await mailerConfigRepository.listMailerConfigs();
  const mongoByDigits = new Map();
  const mongoActive = new Set();
  for (const doc of docs) {
    mongoByDigits.set(doc.digits, doc);
    if ((doc.assignments || []).some((assignment) => assignment.active)) {
      mongoActive.add(doc.digits);
    }
  }

  const changes = {
    confirmed: [],
    newlyActive: [],
    newlyInactive: [],
    unknown: [],
  };

  for (const digits of sheetActive) {
    const doc = mongoByDigits.get(digits);
    if (!doc) {
      changes.unknown.push({ digits, ...sheetByDigits[digits] });
    } else if (!mongoActive.has(digits)) {
      changes.newlyActive.push({ phone: doc.phone, digits, ...sheetByDigits[digits] });
    } else {
      changes.confirmed.push({ phone: doc.phone, digits });
    }
  }

  for (const digits of mongoActive) {
    if (!sheetActive.has(digits)) {
      const doc = mongoByDigits.get(digits);
      changes.newlyInactive.push({ phone: doc?.phone || normalizePhone(digits), digits });
    }
  }

  const applied = [];

  for (const item of changes.newlyActive) {
    const doc = mongoByDigits.get(item.digits);
    if (!doc) continue;
    const assignments = Array.isArray(doc.assignments) ? [...doc.assignments] : [];
    const lastIndex = assignments.length - 1;
    if (lastIndex >= 0 && !assignments[lastIndex].active) {
      assignments[lastIndex] = {
        ...assignments[lastIndex],
        active: true,
        to: null,
      };
      await mailerConfigRepository.replaceMailerAssignments(doc.phone, assignments);
      applied.push(`ACTIVATED ${doc.phone} -> ${assignments[lastIndex].mailHouseName || assignments[lastIndex].internalName || "Unknown"}`);
    }
  }

  for (const item of changes.newlyInactive) {
    const doc = mongoByDigits.get(item.digits);
    if (!doc) continue;
    const assignments = Array.isArray(doc.assignments) ? [...doc.assignments] : [];
    const activeIndex = assignments.findIndex((assignment) => assignment.active);
    if (activeIndex >= 0) {
      assignments[activeIndex] = {
        ...assignments[activeIndex],
        active: false,
        to: assignments[activeIndex].to || new Date().toISOString().split("T")[0],
      };
      await mailerConfigRepository.replaceMailerAssignments(doc.phone, assignments);
      applied.push(`DEACTIVATED ${doc.phone} -> ${assignments[activeIndex].mailHouseName || assignments[activeIndex].internalName || "Unknown"}`);
    }
  }

  if (applied.length) {
    await loadMailerConfigCache();
  }

  if (options.sendConfirmation !== false && (applied.length || changes.unknown.length)) {
    const lines = [];
    if (applied.length) {
      lines.push("CHANGES APPLIED:");
      applied.forEach((line) => lines.push(` - ${line}`));
      lines.push("");
    }
    if (changes.unknown.length) {
      lines.push("UNKNOWN NUMBERS:");
      changes.unknown.forEach((item) => {
        lines.push(` - ${item.digits} | ${item.jobName || "Unknown"} | ${item.dropDate || "Unknown date"}`);
      });
    }
    try {
      await sendMailerReconcileEmail(lines);
    } catch (_error) {
      // Best-effort notification only.
    }
  }

  return {
    applied: applied.length,
    confirmed: changes.confirmed.length,
    newlyActive: changes.newlyActive.length,
    newlyInactive: changes.newlyInactive.length,
    unknown: changes.unknown.length,
    details: changes,
  };
}

module.exports = {
  getActiveMailers,
  getMailerConfigState,
  getMailerHistory,
  isMailerConfigLoaded,
  loadMailerConfigCache,
  normalizeDigits,
  normalizePhone,
  reconcileMailerConfigsWithSheet,
  resolveMailer,
  resolveMailerAt,
  resolveMailerByRcExtension,
  resolveMailerByTrackingNumber,
};
