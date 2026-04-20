"use strict";

const { resolveCanonicalSource } = require("./sourceCanonicalService");

function parseSuccessfulPayments(raw) {
  try {
    const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(arr)) return [];
    return arr.filter((payment) => payment.TransactionStatus === "SUCCESS" && payment.PaidDate);
  } catch {
    return [];
  }
}

function summarizeSuccessfulPayments(payments) {
  if (!payments.length) return null;

  const sorted = [...payments].sort((a, b) => {
    const dateA = String(a.PaidDate || "").slice(0, 10);
    const dateB = String(b.PaidDate || "").slice(0, 10);
    if (dateA !== dateB) return dateA < dateB ? -1 : 1;
    return (a.CasePaymentID || 0) - (b.CasePaymentID || 0);
  });

  const initial = sorted[0];
  const last = sorted[sorted.length - 1];
  const totalPaid = sorted.reduce(
    (sum, payment) => sum + (parseFloat(payment.Amount) || 0),
    0,
  );

  return {
    firstPaymentDate: new Date(initial.PaidDate),
    initialPayment: parseFloat(initial.Amount) || 0,
    totalPaid,
    paymentsCount: sorted.length,
    lastPaymentDate: new Date(last.PaidDate),
    lastPaymentAmount: parseFloat(last.Amount) || 0,
    lastPaymentStatus: last.TransactionStatus || null,
  };
}

function extractMailerLabel(contactMethod) {
  const text = String(contactMethod || "").trim();
  if (!text) return "";
  const parts = text.split("—");
  if (parts.length > 1) return parts.slice(1).join("—").trim();
  return text.replace(/^Mailer Inbound/i, "").trim();
}

async function resolveCanonicalAttribution(query = {}, fallback = {}) {
  const resolved = await resolveCanonicalSource(query);
  if (resolved?.internalName) {
    return {
      sourceName: resolved.internalName,
      sourceChannel: resolved.channel || fallback.sourceChannel || null,
      matchedBy: resolved.matchedBy,
      sourceCanonical: resolved,
    };
  }

  return {
    ...fallback,
    sourceCanonical: null,
  };
}

async function classifyActivityForAttribution(activity, profile = {}) {
  if (!activity || String(activity.direction || "").toLowerCase() !== "inbound") {
    return null;
  }

  const rawSourceName = activity.caseMatch?.sourceName || "";
  const rawChannel = activity.caseMatch?.sourceChannel || "";
  const contactMethod = String(activity.contactMethod || "").trim();
  const createdAt = activity.callStartTime || activity.createdAt || null;

  if (/^Mailer Inbound/i.test(contactMethod)) {
    const mailerLabel = extractMailerLabel(contactMethod);
    const resolved = await resolveCanonicalAttribution(
      {
        rawName: mailerLabel,
        queueName: mailerLabel,
        trackerName: mailerLabel,
        sourceName: rawSourceName,
        domain: profile.domain,
      },
      {
        sourceName: mailerLabel || rawSourceName || profile.sourceName || "Unknown",
        sourceChannel: "mail",
        matchedBy: "mailer-contact-method",
      },
    );

    return {
      qualifies: true,
      branch: "mail",
      sourceName: resolved.sourceName,
      sourceChannel: resolved.sourceChannel || "mail",
      matchedBy: resolved.matchedBy || "mailer-contact-method",
      createdAt,
      sourceCanonical: resolved.sourceCanonical,
    };
  }

  if (/^Inbound Call$/i.test(contactMethod) && /^(vendor|bcd)$/i.test(rawChannel)) {
    const resolved = await resolveCanonicalAttribution(
      {
        sourceName: rawSourceName,
        rawName: rawSourceName,
        domain: profile.domain,
      },
      {
        sourceName: rawSourceName || "BCD",
        sourceChannel: "vendor",
        matchedBy: "bcd-inbound-line",
      },
    );

    return {
      qualifies: true,
      branch: "bcd",
      sourceName: resolved.sourceName,
      sourceChannel: resolved.sourceChannel || "vendor",
      matchedBy: resolved.matchedBy || "bcd-inbound-line",
      createdAt,
      sourceCanonical: resolved.sourceCanonical,
    };
  }

  if (
    /^Inbound$/i.test(contactMethod) &&
    (/^dialer$/i.test(rawChannel) || /^callfire$/i.test(rawSourceName))
  ) {
    const resolved = await resolveCanonicalAttribution(
      {
        sourceName: rawSourceName,
        rawName: rawSourceName,
        domain: profile.domain,
      },
      {
        sourceName: rawSourceName || "CallFire",
        sourceChannel: "dialer",
        matchedBy: "dialer-inbound-line",
      },
    );

    return {
      qualifies: true,
      branch: "dialer",
      sourceName: resolved.sourceName,
      sourceChannel: resolved.sourceChannel || "dialer",
      matchedBy: resolved.matchedBy || "dialer-inbound-line",
      createdAt,
      sourceCanonical: resolved.sourceCanonical,
    };
  }

  return null;
}

module.exports = {
  classifyActivityForAttribution,
  extractMailerLabel,
  parseSuccessfulPayments,
  resolveCanonicalAttribution,
  summarizeSuccessfulPayments,
};
