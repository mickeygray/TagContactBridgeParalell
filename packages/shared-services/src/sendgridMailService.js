"use strict";

// Compatibility shim. The original implementation called the SendGrid
// v3 HTTP API directly (`/v3/mail/send`); we've migrated to nodemailer +
// handlebars in `mailerService.js` so cadence + nightly + transactional
// share a single mail surface.
//
// Existing call sites pass a v3-API-shaped payload:
//   { personalizations: [{ to: [{email}] }], from: {email,name}, subject,
//     content: [{type,value}], attachments: [{content(base64),filename,...}] }
//
// We translate that shape into the mailerService.sendMail call so we
// don't have to chase every caller through the codebase. New code
// should import `sendMail` from `mailerService` directly.

const { sendMail } = require("./mailerService");

function flattenRecipients(personalizations) {
  const out = [];
  for (const p of personalizations || []) {
    for (const t of p.to || []) {
      if (t?.email) out.push(t.email);
    }
  }
  return out;
}

function pickContent(content, mimeType) {
  for (const item of content || []) {
    if (String(item?.type || "").toLowerCase() === mimeType) {
      return item.value || "";
    }
  }
  return "";
}

function adaptAttachments(list) {
  // v3 sends base64 strings; nodemailer wants buffers. Decode in place.
  return (list || []).map((att) => {
    if (!att) return null;
    if (att.content && typeof att.content === "string") {
      // Heuristic: any v3 attachment encoded base64.
      try {
        return {
          filename: att.filename,
          content: Buffer.from(att.content, "base64"),
          contentType: att.type || "application/octet-stream",
        };
      } catch {
        // fall through and pass as-is
      }
    }
    return att;
  }).filter(Boolean);
}

function fromHeader(payload) {
  const from = payload?.from || {};
  if (from.name && from.email) return `${from.name} <${from.email}>`;
  return from.email || null;
}

async function sendPlainEmail(companyKey, payload) {
  const recipients = flattenRecipients(payload.personalizations);
  if (recipients.length === 0) {
    throw new Error("sendPlainEmail: no recipients in payload");
  }

  const subject =
    payload.subject ||
    payload.personalizations?.[0]?.subject ||
    "(no subject)";
  const text = pickContent(payload.content, "text/plain");
  const html = pickContent(payload.content, "text/html");

  const result = await sendMail(companyKey, {
    to: recipients,
    subject,
    text: text || undefined,
    html: html || undefined,
    from: fromHeader(payload),
    attachments: adaptAttachments(payload.attachments),
  });

  return {
    ok: true,
    company: String(companyKey || "").toUpperCase(),
    to: recipients[0],
    subject,
    messageId: result.messageId || null,
  };
}

async function sendTestEmail(companyKey, options = {}) {
  const toEmail = options.toEmail || "mgray@taxadvocategroup.com";
  const subject =
    options.subject ||
    `[${String(companyKey || "").toUpperCase() || "TAG"}] Parallel Mailer Test`;
  const text = options.text || "test";
  return sendMail(companyKey, {
    to: toEmail,
    subject,
    text,
  });
}

module.exports = {
  sendPlainEmail,
  sendTestEmail,
};
