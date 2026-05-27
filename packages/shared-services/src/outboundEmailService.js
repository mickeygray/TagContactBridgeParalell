"use strict";

const { sendMail } = require("./mailerService");
const {
  getCompanyConfig,
  getMarketingFromEmail,
} = require("../../shared-config/src");

function buildDefaultEmailContent({ name, domain }) {
  const company = getCompanyConfig(domain);
  return {
    subject: `Welcome to ${company.name}`,
    text: `Hi ${name || "there"}, we're reaching out regarding your recent tax relief inquiry. Reply to this email or call us if you'd like to talk through next steps.`,
  };
}

async function sendOutboundEmail({
  domain,
  toEmail,
  subject,
  text,
  html,
  name,
  attachments = [],
}) {
  if (!toEmail) {
    return { ok: false, skipped: true, reason: "missing-email" };
  }

  const company = getCompanyConfig(domain);
  const fallback = buildDefaultEmailContent({ name, domain });

  await sendMail(domain, {
    to: toEmail,
    subject: subject || fallback.subject,
    text: text || fallback.text,
    html: html || undefined,
    from: `${company.name} <${getMarketingFromEmail()}>`,
    attachments,
  });

  return {
    ok: true,
    provider: "sendgrid-smtp",
    toEmail,
  };
}

module.exports = {
  sendOutboundEmail,
};
