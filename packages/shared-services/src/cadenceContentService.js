"use strict";

const { getCompanyConfig } = require("../../shared-config/src");
const { renderOnly } = require("./mailerService");

const CADENCE_EMAIL_SUBJECTS = Object.freeze({
  1: (company, name) => `Welcome to ${company.name}, ${name || "there"}!`,
  2: (_company, name) => `${name || "Hi"}, your tax situation deserves a plan`,
  3: (company) => `How ${company.name} has helped thousands of clients`,
  4: (_company, name) => `${name || "Hi"}, you have more options than you think`,
  5: (_company, name) => `${name || "Hi"}, the best time to act is now`,
});

const CADENCE_EMAIL_ASSETS = Object.freeze({
  TAG: {
    logo: "TAG_Logo.png",
    guide: "tag-tax-guide.pdf",
  },
  WYNN: {
    logo: "Wynn_Logo.png",
    guide: "wynn-tax-guide.pdf",
  },
});

function formatFirstName(raw) {
  if (!raw || typeof raw !== "string") return "";
  const first = raw.trim().split(/\s+/)[0];
  if (!first) return "";
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

function normalizePhoneForDisplay(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  const normalized = digits.length === 11 && digits.startsWith("1")
    ? digits.slice(1)
    : digits;
  if (normalized.length !== 10) return String(raw || "").trim();
  return `${normalized.slice(0, 3)}-${normalized.slice(3, 6)}-${normalized.slice(6)}`;
}

function extractCadenceEmailIndex(templateKey) {
  const value = String(templateKey || "").trim().toLowerCase();
  if (!value) return null;
  if (value === "prospect-welcome-email") return 1;
  const match = value.match(/^prospect-follow-up-(\d+)-email$/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) && parsed >= 2 ? parsed : null;
}

function extractCadenceSmsIndex(templateKey) {
  const value = String(templateKey || "").trim().toLowerCase();
  if (!value) return null;
  if (value === "prospect-first-text") return 1;
  const match = value.match(/^prospect-follow-up-text-(\d+)$/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) && parsed >= 2 ? parsed : null;
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|table|section|article|h[1-6]|li)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&mdash;/gi, "-")
    .replace(/&ndash;/gi, "-")
    .replace(/&amp;/gi, "&")
    .replace(/&rsquo;/gi, "'")
    .replace(/&lsquo;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#10003;/gi, "✓")
    .replace(/&#10060;/gi, "X")
    .replace(/&#128222;/gi, "")
    .replace(/&#128203;/gi, "")
    .replace(/&#128737;/gi, "")
    .replace(/&#9888;&#65039;/gi, "")
    .replace(/&#9878;&#65039;/gi, "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function getCadenceTemplateContext(domain, name) {
  const company = getCompanyConfig(domain);
  return {
    company,
    displayName: formatFirstName(name) || name || "there",
    phone: normalizePhoneForDisplay(
      company.clientContactPhone || company.integrations?.callrail?.trackingNumber || "",
    ),
    scheduleUrl: company.scheduleUrl || "",
    year: new Date().getFullYear(),
  };
}

function resolveCadenceEmailContent({ domain, templateKey, name }) {
  const emailIndex = extractCadenceEmailIndex(templateKey);
  if (!emailIndex) return null;

  const normalizedDomain = String(domain || "").trim().toUpperCase();
  const { company, displayName, phone, scheduleUrl, year } = getCadenceTemplateContext(
    normalizedDomain,
    name,
  );
  const renderedIndex = emailIndex <= 5 ? emailIndex : 1;
  const subjectIndex = emailIndex <= 5 ? emailIndex : 1;
  const subjectBuilder = CADENCE_EMAIL_SUBJECTS[subjectIndex] || CADENCE_EMAIL_SUBJECTS[1];
  const html = renderOnly(`cadence/${normalizedDomain}/prospect-welcome-${renderedIndex}`, {
    name: displayName || "there",
    phone,
    scheduleUrl,
    year,
  });
  const attachments = [];
  const assetConfig = CADENCE_EMAIL_ASSETS[normalizedDomain] || null;
  if (assetConfig?.logo) {
    attachments.push({
      asset: assetConfig.logo,
      domain: normalizedDomain,
      cid: "emailLogo",
    });
  }
  if (emailIndex === 1 && assetConfig?.guide) {
    attachments.push({
      asset: assetConfig.guide,
      domain: normalizedDomain,
    });
  }

  return {
    emailIndex,
    renderedIndex,
    subject: subjectBuilder(company, displayName || name || ""),
    html,
    text: htmlToText(html),
    attachments,
  };
}

function resolveCadenceSmsContent({ domain, templateKey, name }) {
  const textIndex = extractCadenceSmsIndex(templateKey);
  if (!textIndex) return null;

  const company = getCompanyConfig(domain);
  const firstName = formatFirstName(name) || "there";
  const companyName = company.name;
  const phone = normalizePhoneForDisplay(
    company.clientContactPhone || company.integrations?.callrail?.trackingNumber || "",
  );

  switch (textIndex) {
    case 1:
      return (
        `${firstName}, this is ${companyName}. We received your request for tax relief assistance. ` +
        `The IRS adds penalties and interest daily - the sooner we review your case, the more options you have.\n\n` +
        `Call us now: ${phone}`
      );
    case 2:
      return (
        `${firstName}, following up from ${companyName}. ` +
        `If you owe the IRS, they can garnish wages, levy bank accounts, and file liens without warning. ` +
        `We may be able to reduce what you owe or stop collections.\n\n` +
        `Speak with our team today: ${phone}`
      );
    case 3:
      return (
        `${firstName}, ${companyName} here. Penalties on your tax debt are compounding daily. ` +
        `Our clients have saved thousands by acting quickly - some qualify to settle for a fraction of what they owe.\n\n` +
        `Don't wait. Call us: ${phone}`
      );
    case 4:
      return (
        `${firstName}, this is ${companyName}. You may qualify for an Offer in Compromise, installment agreement, or penalty abatement - ` +
        `but these programs have deadlines and eligibility requirements.\n\n` +
        `Let us review your case before your options narrow: ${phone}`
      );
    case 5:
      return (
        `${firstName}, this is our final follow-up from ${companyName}. ` +
        `Every day without a resolution plan is another day the IRS has the upper hand. ` +
        `If you want to take control of your tax situation, we're ready to help.\n\n` +
        `${phone}`
      );
    default:
      return null;
  }
}

module.exports = {
  extractCadenceEmailIndex,
  extractCadenceSmsIndex,
  formatFirstName,
  resolveCadenceEmailContent,
  resolveCadenceSmsContent,
};
