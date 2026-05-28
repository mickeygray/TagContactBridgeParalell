"use strict";

// Unified mailer service.
//
// Single entry point: `sendMail(domain, { to, subject, template, data, attachments })`.
// Renders Handlebars templates from `packages/shared-templates`, sends via
// per-domain SendGrid SMTP (Nodemailer). Mirrors the legacy
// TagContactBridge `services/emailService.js` pattern so cadence /
// clientcontact / transactional / nightly all flow through one infra.
//
// Why nodemailer + handlebars (and not sendgrid-v3 + tiny renderer):
//   - lead cadence + client contact emails are already authored as .hbs
//     and ship soon; one renderer = one mental model + one cache + one
//     bug surface
//   - inline asset attachments via `cid:` (logos, PDFs) are first-class
//     in nodemailer; the v3 JSON API forces base64 hand-encoding
//   - SMTP transport via SendGrid uses the same per-company API keys
//     that already exist in .env (TAG_API_KEY, WYNN_API_KEY)

const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");
const Handlebars = require("handlebars");
const {
  TEMPLATES_DIR,
  PARTIALS_DIR,
  ASSETS_DIR,
  templatePath,
  partialPath,
  assetPath,
} = require("../../shared-templates/src");
const {
  getCompanyConfig,
  getInternalFromEmail,
  getMarketingFromEmail,
} = require("../../shared-config/src");

const TEMPLATE_CACHE = new Map(); // "<category>/<name>" → compiled fn
const PARTIALS_REGISTERED = { done: false };
const TRANSPORT_CACHE = new Map(); // "<DOMAIN>" → nodemailer transport

// ── Handlebars helpers ───────────────────────────────────────────────
//
// Helpers are registered once at module load. Anything a template
// might want for date/money/conditional formatting belongs here so
// templates stay declarative.
function registerHelpers() {
  if (Handlebars.helpers.money) return;
  Handlebars.registerHelper("money", function (value) {
    const num = Number(value || 0);
    if (!Number.isFinite(num)) return "$0.00";
    return `$${num.toFixed(2)}`;
  });
  Handlebars.registerHelper("int", function (value) {
    const num = Number(value || 0);
    return Number.isFinite(num) ? Math.round(num).toString() : "0";
  });
  Handlebars.registerHelper("eq", function (a, b) {
    return a === b;
  });
  Handlebars.registerHelper("ne", function (a, b) {
    return a !== b;
  });
  Handlebars.registerHelper("gt", function (a, b) {
    return Number(a) > Number(b);
  });
  Handlebars.registerHelper("gte", function (a, b) {
    return Number(a) >= Number(b);
  });
  Handlebars.registerHelper("lt", function (a, b) {
    return Number(a) < Number(b);
  });
  Handlebars.registerHelper("or", function () {
    const args = Array.prototype.slice.call(arguments, 0, -1);
    return args.some(Boolean);
  });
  Handlebars.registerHelper("and", function () {
    const args = Array.prototype.slice.call(arguments, 0, -1);
    return args.every(Boolean);
  });
  Handlebars.registerHelper("scoreClass", function (value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return "score-amber";
    if (num >= 7) return "score-green";
    if (num >= 4) return "score-amber";
    return "score-red";
  });
  Handlebars.registerHelper("statusPillClass", function (category) {
    const c = String(category || "").toLowerCase();
    if (c === "client" || c.startsWith("tier")) return "client";
    if (c === "dnc") return "dnc";
    if (c === "postdate") return "postdate";
    if (c === "redline") return "redline";
    if (c === "prospect") return "prospect";
    return "unknown";
  });
  Handlebars.registerHelper("default", function (value, fallback) {
    if (value === undefined || value === null || value === "") return fallback;
    return value;
  });
  Handlebars.registerHelper("formatDate", function (value) {
    if (!value) return "";
    const d = new Date(value);
    if (isNaN(d.getTime())) return String(value);
    return d.toLocaleDateString("en-US");
  });
  Handlebars.registerHelper("formatTime", function (value) {
    if (!value) return "";
    const d = new Date(value);
    if (isNaN(d.getTime())) return String(value);
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  });
  Handlebars.registerHelper("duration", function (seconds) {
    const s = Number(seconds || 0);
    if (!Number.isFinite(s) || s <= 0) return "0:00";
    const m = Math.floor(s / 60);
    const r = Math.round(s % 60);
    return `${m}:${String(r).padStart(2, "0")}`;
  });
  Handlebars.registerHelper("when", function (value, ifTruthy, ifFalsy) {
    return value ? ifTruthy : ifFalsy;
  });
}

// ── Partials registration ────────────────────────────────────────────
//
// Walks `partials/` once and registers each `<name>.hbs` as a partial
// keyed by `<name>`. Templates reference them via `{{> name }}`.
function ensurePartialsRegistered() {
  if (PARTIALS_REGISTERED.done) return;
  registerHelpers();
  if (!fs.existsSync(PARTIALS_DIR)) {
    PARTIALS_REGISTERED.done = true;
    return;
  }
  for (const filename of fs.readdirSync(PARTIALS_DIR)) {
    if (!filename.endsWith(".hbs")) continue;
    const name = filename.replace(/\.hbs$/, "");
    const source = fs.readFileSync(path.join(PARTIALS_DIR, filename), "utf8");
    Handlebars.registerPartial(name, source);
  }
  PARTIALS_REGISTERED.done = true;
}

// ── Template lookup + compile cache ──────────────────────────────────
//
// Two lookup forms supported:
//   "nightly/financial-close"        → templates/nightly/financial-close.hbs
//   "cadence/WYNN/prospect-welcome-1"→ templates/cadence/WYNN/prospect-welcome-1.hbs
//
// Anything missing throws a clear error so callers don't silently send
// blank emails.
function compileTemplate(templateKey) {
  ensurePartialsRegistered();
  if (TEMPLATE_CACHE.has(templateKey)) return TEMPLATE_CACHE.get(templateKey);

  const parts = String(templateKey).split("/");
  if (parts.length < 2) {
    throw new Error(
      `mailerService: invalid template key "${templateKey}" — expected "<category>/<name>"`,
    );
  }

  const filePath = path.join(TEMPLATES_DIR, ...parts) + ".hbs";
  if (!fs.existsSync(filePath)) {
    throw new Error(`mailerService: template not found at ${filePath}`);
  }
  const source = fs.readFileSync(filePath, "utf8");
  const compiled = Handlebars.compile(source, { noEscape: false });
  TEMPLATE_CACHE.set(templateKey, compiled);
  return compiled;
}

function renderTemplate(templateKey, data = {}) {
  const compiled = compileTemplate(templateKey);
  return compiled(data);
}

// ── Per-domain SMTP transport ────────────────────────────────────────
//
// SendGrid SMTP relay; one Nodemailer transport per domain so each
// company's API key authenticates its own send (matters for sender
// reputation + per-domain throttling).
//
// Env contract (matches legacy app):
//   SENDGRID_GATEWAY     SMTP host (default "smtp.sendgrid.net")
//   SENDGRID_PORT        SMTP port (default 587)
//   SENDGRID_USER        SMTP username (default "apikey")
//   <DOMAIN>_API_KEY     SendGrid API key — read via companyConfig
function getTransport(domainKey) {
  const key = String(domainKey || "").toUpperCase();
  if (TRANSPORT_CACHE.has(key)) return TRANSPORT_CACHE.get(key);

  const company = getCompanyConfig(key);
  const apiKey =
    company?.integrations?.sendgrid?.apiKey ||
    process.env[`${key}_API_KEY`] ||
    "";

  if (!apiKey) {
    throw new Error(
      `mailerService: no SendGrid API key configured for domain "${key}" (set ${key}_API_KEY)`,
    );
  }

  const transport = nodemailer.createTransport({
    host: process.env.SENDGRID_GATEWAY || "smtp.sendgrid.net",
    port: Number(process.env.SENDGRID_PORT) || 587,
    secure: false, // STARTTLS on 587
    auth: {
      user: process.env.SENDGRID_USER || "apikey",
      pass: apiKey,
    },
  });
  TRANSPORT_CACHE.set(key, transport);
  return transport;
}

// ── From-line resolution ─────────────────────────────────────────────
//
// Default From-line for marketing/cadence/customer mail. Internal
// jobs pass an explicit From header through getInternalFromEmail().
function resolveFrom(domainKey, explicitFrom) {
  if (explicitFrom) return explicitFrom;
  const key = String(domainKey || "").toUpperCase();
  const company = getCompanyConfig(key);
  const fromEmail = getMarketingFromEmail();
  const fromName =
    process.env[`${key}_EMAIL_NAME`] ||
    company?.name ||
    `${key} Parallel`;
  return `${fromName} <${fromEmail}>`;
}

function resolveTransportDomain(domainKey, explicitFrom, explicitTransportDomain) {
  if (explicitTransportDomain) {
    return String(explicitTransportDomain || "").toUpperCase();
  }
  const internalEmail = String(getInternalFromEmail() || "").trim().toLowerCase();
  const from = String(explicitFrom || "").toLowerCase();
  if (internalEmail && from.includes(internalEmail)) {
    return "TAG";
  }
  return String(domainKey || "").toUpperCase();
}

// ── Attachment resolution ────────────────────────────────────────────
//
// Attachments accept legacy nodemailer shape, plus a sugar form for the
// brand-asset case:
//   { asset: "Wynn_Logo.png", domain: "WYNN", cid: "emailLogo" }
// resolves to `{ filename, path, cid }` pointing at
// `shared-templates/assets/WYNN/Wynn_Logo.png`.
//
// Inline-buffer attachments (CSVs etc) pass through unchanged.
function resolveAttachments(domainKey, attachments = []) {
  const out = [];
  for (const attachment of attachments) {
    if (!attachment) continue;
    if (attachment.asset) {
      const dom = String(attachment.domain || domainKey || "").toUpperCase();
      const filename = attachment.filename || attachment.asset;
      const filePath = assetPath(dom, attachment.asset);
      if (!fs.existsSync(filePath)) {
        // Skip missing brand assets quietly — preferable to bombing the
        // whole send for a logo that hasn't been uploaded yet
        continue;
      }
      out.push({
        filename,
        path: filePath,
        cid: attachment.cid || undefined,
      });
      continue;
    }
    out.push(attachment);
  }
  return out;
}

// ── Public API ───────────────────────────────────────────────────────
//
// `sendMail(domain, options)` — single send.
//
// options:
//   to            string | string[]     required
//   subject       string                required
//   template      string                "<category>/<name>" or "<category>/<DOMAIN>/<name>"
//   data          object                template render context
//   text          string                fallback plain-text body (optional)
//   html          string                explicit HTML override (skips template)
//   from          string                explicit From header (optional)
//   replyTo       string | object       optional
//   attachments   array                 see resolveAttachments
//   transportDomain string               optional SendGrid key domain override
//   bcc, cc       string | string[]     optional
async function sendMail(domain, options = {}) {
  const key = String(domain || "").toUpperCase();
  if (!options.to) {
    throw new Error("mailerService.sendMail: `to` required");
  }
  if (!options.subject) {
    throw new Error("mailerService.sendMail: `subject` required");
  }

  let html = options.html || null;
  if (!html && options.template) {
    html = renderTemplate(options.template, options.data || {});
  }

  const transportKey = resolveTransportDomain(key, options.from, options.transportDomain);
  const transport = getTransport(transportKey);
  const mail = {
    from: resolveFrom(key, options.from),
    to: Array.isArray(options.to) ? options.to.join(", ") : options.to,
    subject: options.subject,
    text: options.text || "",
    html: html || "",
    attachments: resolveAttachments(key, options.attachments || []),
  };
  if (options.replyTo) mail.replyTo = options.replyTo;
  if (options.cc) mail.cc = options.cc;
  if (options.bcc) mail.bcc = options.bcc;

  const info = await transport.sendMail(mail);
  return {
    ok: true,
    messageId: info?.messageId || null,
    domain: key,
    transportDomain: transportKey,
    to: mail.to,
    subject: mail.subject,
  };
}

// ── Test / preview helpers ───────────────────────────────────────────
//
// `renderOnly(template, data)` returns the compiled HTML without
// sending — useful for SPA previews and test scripts that want to
// snapshot what an email will look like before letting it fly.
function renderOnly(template, data) {
  return renderTemplate(template, data || {});
}

function clearCaches() {
  TEMPLATE_CACHE.clear();
  PARTIALS_REGISTERED.done = false;
  TRANSPORT_CACHE.clear();
}

module.exports = {
  sendMail,
  renderOnly,
  renderTemplate,
  compileTemplate,
  getTransport,
  resolveTransportDomain,
  resolveFrom,
  resolveAttachments,
  clearCaches,
};
