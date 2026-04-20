"use strict";

const { createSendgridClient } = require("../../shared-integrations/src");

async function sendPlainEmail(companyKey, payload) {
  const client = createSendgridClient(companyKey);
  await client.sendEmail(payload);

  return {
    company: client.company.key,
    to: payload?.personalizations?.[0]?.to?.[0]?.email || null,
    from: payload?.from?.email || null,
    subject: payload?.subject || null,
  };
}

async function sendTestEmail(companyKey, options = {}) {
  const toEmail = options.toEmail || "mgray@taxadvocategroup.com";
  const fromEmail = options.fromEmail || "mgray@taxadvocategroup.com";
  const subject = options.subject || `[${String(companyKey || "").toUpperCase() || "TAG"}] Parallel SendGrid Test`;
  const text = options.text || "test";

  const payload = {
    personalizations: [
      {
        to: [{ email: toEmail }],
        custom_args: {
          company: String(companyKey || "").toUpperCase() || "TAG",
          channel: "parallel-sendgrid-test",
          purpose: "smoke-test",
        },
      },
    ],
    from: {
      email: fromEmail,
      name: "Matt Gray",
    },
    reply_to: {
      email: fromEmail,
      name: "Matt Gray",
    },
    subject,
    content: [
      {
        type: "text/plain",
        value: text,
      },
    ],
    mail_settings: {
      sandbox_mode: {
        enable: false,
      },
    },
  };

  return sendPlainEmail(companyKey, payload);
}

module.exports = {
  sendPlainEmail,
  sendTestEmail,
};
