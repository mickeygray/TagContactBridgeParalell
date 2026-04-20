"use strict";

const { createSendgridClient } = require("../../shared-integrations/src");
const { getCompanyConfig } = require("../../shared-config/src");

function buildDefaultEmailContent({ name, domain }) {
  const company = getCompanyConfig(domain);
  return {
    subject: `Welcome to ${company.name}`,
    text: `Hi ${name || "there"}, we're reaching out regarding your recent tax relief inquiry. Reply to this email or call us if you'd like to talk through next steps.`,
  };
}

async function sendOutboundEmail({ domain, toEmail, subject, text, html, name }) {
  if (!toEmail) {
    return { ok: false, skipped: true, reason: "missing-email" };
  }

  const company = getCompanyConfig(domain);
  const client = createSendgridClient(domain);
  const fallback = buildDefaultEmailContent({ name, domain });

  await client.sendEmail({
    from: {
      email: company.fromEmail,
      name: company.name,
    },
    personalizations: [
      {
        to: [{ email: toEmail }],
        subject: subject || fallback.subject,
      },
    ],
    content: [
      {
        type: "text/plain",
        value: text || fallback.text,
      },
      ...(html
        ? [
            {
              type: "text/html",
              value: html,
            },
          ]
        : []),
    ],
  });

  return {
    ok: true,
    provider: "sendgrid",
    toEmail,
  };
}

module.exports = {
  sendOutboundEmail,
};
