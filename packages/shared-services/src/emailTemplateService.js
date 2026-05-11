"use strict";

const fs = require("fs");
const path = require("path");
const { getBrandConfig } = require("../../shared-data/src/brandConfig");
const { getCompanyConfig } = require("../../shared-config/src");

const TEMPLATES_DIR = path.join(__dirname, "emailTemplates");
const PARTIALS_DIR = path.join(TEMPLATES_DIR, "partials");

/**
 * File-content cache keyed by absolute path. Templates don't change at
 * runtime, so a process-lifetime cache is fine and keeps renders fast
 * without inventing an invalidation story. Dev reloads pick up changes
 * via `nodemon` restarting the process.
 */
const fileCache = new Map();

function readTemplateFile(absPath) {
  if (fileCache.has(absPath)) return fileCache.get(absPath);
  const contents = fs.readFileSync(absPath, "utf8");
  fileCache.set(absPath, contents);
  return contents;
}

function loadPartial(kind, name) {
  // `kind` = "text" or "html" — selects the matching partial variant.
  const filename = `${name}.${kind}.hbs`;
  const absPath = path.join(PARTIALS_DIR, filename);
  try {
    return readTemplateFile(absPath);
  } catch {
    return ""; // Missing partial → silent empty, never a thrown error mid-email.
  }
}

function resolveValueByPath(context, keyPath) {
  const parts = String(keyPath || "").split(".");
  let cursor = context;
  for (const part of parts) {
    if (cursor == null) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function isTruthyForIfBlock(value) {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "number") return value !== 0;
  return Boolean(value);
}

/**
 * Minimal Handlebars-flavored renderer. Supports:
 *   - `{{var}}` and `{{nested.path}}` substitution
 *   - `{{> partialName}}` partial inclusion (single-pass; partials can't
 *     reference other partials to keep the implementation small)
 *   - `{{#if var}}...{{/if}}` block conditionals on truthy strings/arrays
 *
 * NOT supported: `{{#each}}`, `{{#unless}}`, helpers, escaping. Keep
 * templates simple. If we outgrow this we'll pull in real handlebars.
 */
function renderTemplateString(source, context, kind) {
  let body = String(source || "");

  // Pass 1: inline partials. Do this before anything else so interpolation
  // inside partials picks up the full context.
  body = body.replace(/\{\{\s*>\s*([\w-]+)\s*\}\}/g, (_, name) => {
    return loadPartial(kind, name);
  });

  // Pass 2: {{#if var}}...{{/if}} block conditionals. Non-greedy inner
  // match and no nesting — the templates don't need it.
  body = body.replace(
    /\{\{\s*#if\s+([\w.]+)\s*\}\}([\s\S]*?)\{\{\s*\/if\s*\}\}/g,
    (_, keyPath, inner) => {
      const value = resolveValueByPath(context, keyPath);
      return isTruthyForIfBlock(value) ? inner : "";
    },
  );

  // Pass 3: simple variable substitution. Anything unresolved renders
  // as empty to keep outbound emails clean.
  body = body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, keyPath) => {
    const value = resolveValueByPath(context, keyPath);
    return value == null ? "" : String(value);
  });

  return body;
}

/**
 * Build the default template context. Caller-provided `variables` are
 * merged last so they can override anything (e.g. the UI showing a
 * preview with a fake name).
 */
function buildTemplateContext({ domain, user, variables = {} }) {
  const brand = getBrandConfig(domain);
  const company = getCompanyConfig(domain);

  const fullName = String(variables.name || variables.customerName || "").trim();
  const firstName =
    variables.firstName ||
    (fullName ? fullName.split(" ")[0] : null) ||
    "there";

  return {
    brand,
    domainLabel: brand.domainKey,
    companyName: brand.name,
    // Agent-level fields — derived from the logged-in sender. Caller can
    // override via `variables` for preview/test sends.
    agentName: variables.agentName || user?.name || user?.email || "Your case team",
    agentEmail: variables.agentEmail || user?.email || company.fromEmail || "",
    agentPhone: variables.agentPhone || company.clientContactPhone || brand.supportPhone || "",
    // Customer-level fields
    firstName,
    name: fullName || "there",
    // Template-specific variables
    ...variables,
  };
}

/**
 * Available templates. Kept as a static list so the UI can present
 * them as a picker without a filesystem scan on every render.
 */
const TEMPLATE_CATALOG = Object.freeze([
  {
    key: "direct-intro",
    label: "Direct intro",
    description:
      "Warm first-touch from the agent so the client has a direct point of contact.",
    requiredVariables: [],
    optionalVariables: ["firstName"],
  },
  {
    key: "call-scheduled",
    label: "Call scheduled",
    description: "Confirms a scheduled callback with a time + number.",
    requiredVariables: ["scheduledAtLabel", "callbackPhone"],
    optionalVariables: ["firstName"],
  },
  {
    key: "documents-requested",
    label: "Documents requested",
    description: "Asks the client for the paperwork we need to move forward.",
    requiredVariables: ["documentList"],
    optionalVariables: ["firstName", "secureUploadUrl"],
  },
  {
    key: "status-update",
    label: "Status update",
    description:
      "Lightweight keep-warm update — summary plus an optional next step.",
    requiredVariables: ["updateSummary"],
    optionalVariables: ["firstName", "nextStep"],
  },
]);

function isKnownTemplateKey(key) {
  return TEMPLATE_CATALOG.some((t) => t.key === key);
}

function listTemplates() {
  return TEMPLATE_CATALOG.map((t) => ({ ...t }));
}

/**
 * Render a template into `{ subject, text, html }`. Throws only when
 * `templateKey` isn't recognized — missing optional variables silently
 * render as empty strings.
 */
function renderEmailTemplate({ templateKey, domain, user, variables = {} } = {}) {
  if (!isKnownTemplateKey(templateKey)) {
    const err = new Error(`Unknown email template: "${templateKey}"`);
    err.status = 400;
    throw err;
  }

  const context = buildTemplateContext({ domain, user, variables });
  const baseDir = path.join(TEMPLATES_DIR, templateKey);

  const subjectSource = readTemplateFile(path.join(baseDir, "subject.hbs")).trim();
  // Subject-line rendering uses the text-flavor partials (no HTML partials
  // in a subject). Usually partials aren't referenced from subjects.
  const subject = renderTemplateString(subjectSource, context, "text").trim();

  // Inject the rendered subject so body templates can reference it in
  // <title> tags and similar.
  const bodyContext = { ...context, subject };

  const textSource = readTemplateFile(path.join(baseDir, "body.text.hbs"));
  const text = renderTemplateString(textSource, bodyContext, "text").trim() + "\n";

  const htmlSource = readTemplateFile(path.join(baseDir, "body.html.hbs"));
  const html = renderTemplateString(htmlSource, bodyContext, "html");

  return { subject, text, html, templateKey, domain: context.brand.domainKey };
}

/**
 * Dev-only: wipe the file cache. Exported so tests and hot-reload
 * tooling can force a fresh read without restarting the process.
 */
function clearTemplateCache() {
  fileCache.clear();
}

module.exports = {
  TEMPLATE_CATALOG,
  buildTemplateContext,
  clearTemplateCache,
  isKnownTemplateKey,
  listTemplates,
  renderEmailTemplate,
  renderTemplateString,
};
