"use strict";

const fs = require("fs");
const path = require("path");

const ROOT_CODE_DIR = path.resolve(__dirname, "..", "..", "..", "..");
const ORIGINAL_APP_DIR = path.join(ROOT_CODE_DIR, "TagContactBridge");
const ORIGINAL_TEXT_LIBRARY_PATH = path.join(ORIGINAL_APP_DIR, "libraries", "textMessageLibrary.js");
const ORIGINAL_TEMPLATE_DIR = path.join(ORIGINAL_APP_DIR, "Templates");

function safeExists(targetPath) {
  try {
    return fs.existsSync(targetPath);
  } catch (_error) {
    return false;
  }
}

function decodeLegacyText(value) {
  return String(value || "")
    .replace(/â€™/g, "'")
    .replace(/â€‘/g, "-")
    .replace(/â€”/g, "-")
    .replace(/â€“/g, "-")
    .replace(/â€¦/g, "...")
    .replace(/â€œ/g, "\"")
    .replace(/â€/g, "\"")
    .replace(/ðŸ”¹/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function inferAudience(relativePath) {
  const normalized = String(relativePath || "").toLowerCase();
  if (normalized.includes("clientcontactemails")) return "client";
  if (normalized.includes("prospectwelcome")) return "prospect";
  if (normalized.includes("marketingemails")) return "prospect";
  if (normalized.includes("taxorganizer2026prospect")) return "prospect";
  if (normalized.includes("taxorganizer2026")) return "client";
  return "mixed";
}

function inferCategory(label, relativePath) {
  const value = `${label || ""} ${relativePath || ""}`.toLowerCase();
  if (value.includes("433a")) return "433a";
  if (value.includes("prac")) return "practitioner-call";
  if (value.includes("tax organizer") || value.includes("taxorganizer") || value.includes("toemail")) return "tax-organizer";
  if (value.includes("tax deadline")) return "tax-deadline";
  if (value.includes("penalty") || value.includes("paemail") || value.includes("pa text")) return "penalty-abatement";
  if (value.includes("transcript")) return "transcripts";
  if (value.includes("past-due")) return "past-due";
  if (value.includes("welcome")) return "welcome";
  if (value.includes("update433a")) return "update-433a";
  if (value.includes("doc review") || value.includes("document")) return "document-review";
  return "general";
}

function inferBrand(relativePath, bodyText) {
  const value = `${relativePath || ""} ${bodyText || ""}`.toLowerCase();
  if (value.includes("\\wynn\\") || value.includes("/wynn/") || value.includes("wynn tax")) return "WYNN";
  if (value.includes("\\tag\\") || value.includes("/tag/") || value.includes("tax advocate")) return "TAG";
  if (value.includes("amity")) return "AMITY";
  return "ALL";
}

function inferStage(label, relativePath) {
  const value = `${label || ""} ${relativePath || ""}`.toLowerCase();
  if (value.includes("welcome")) return "welcome";
  if (value.includes("followup") || value.includes("follow-up")) return "follow-up";
  if (value.includes("urgent") || value.includes("last call") || value.includes("deadline")) return "urgent";
  if (value.includes("schedule")) return "schedule";
  if (value.includes("update")) return "update";
  return "standard";
}

function extractPreview(text, length = 280) {
  const normalized = decodeLegacyText(text);
  if (!normalized) return "";
  return normalized.length > length ? `${normalized.slice(0, length - 3)}...` : normalized;
}

function stripHtmlToText(contents) {
  return decodeLegacyText(
    String(contents || "")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/{{{?[^}]+}}}?/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&mdash;/gi, "-")
      .replace(/&ndash;/gi, "-"),
  );
}

function listFilesRecursive(targetDir, extension, bucket = []) {
  if (!safeExists(targetDir)) return bucket;
  const entries = fs.readdirSync(targetDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      listFilesRecursive(fullPath, extension, bucket);
      continue;
    }
    if (entry.isFile() && fullPath.toLowerCase().endsWith(extension.toLowerCase())) {
      bucket.push(fullPath);
    }
  }
  return bucket;
}

function loadTextMessageLibrary() {
  if (!safeExists(ORIGINAL_TEXT_LIBRARY_PATH)) {
    return {
      available: false,
      sourcePath: ORIGINAL_TEXT_LIBRARY_PATH,
      entries: [],
    };
  }

  delete require.cache[require.resolve(ORIGINAL_TEXT_LIBRARY_PATH)];
  const source = require(ORIGINAL_TEXT_LIBRARY_PATH);
  const entries = Object.entries(source || {}).map(([name, value]) => {
    const message = decodeLegacyText(value?.message || "");
    return {
      id: `sms:${name.replace(/\s+/g, "-").toLowerCase()}`,
      channel: "sms",
      name,
      category: inferCategory(name, ""),
      audience: "client",
      brand: "ALL",
      stage: inferStage(name, ""),
      placeholders: ["{name}", "{number}"],
      preview: extractPreview(message, 180),
      body: message,
      numbers: {
        TAG: value?.TAG || null,
        WYNN: value?.WYNN || null,
        AMITY: value?.AMITY || null,
      },
      sourcePath: ORIGINAL_TEXT_LIBRARY_PATH,
    };
  });

  return {
    available: true,
    sourcePath: ORIGINAL_TEXT_LIBRARY_PATH,
    entries,
  };
}

function loadEmailTemplateLibrary() {
  if (!safeExists(ORIGINAL_TEMPLATE_DIR)) {
    return {
      available: false,
      sourcePath: ORIGINAL_TEMPLATE_DIR,
      entries: [],
    };
  }

  const files = listFilesRecursive(ORIGINAL_TEMPLATE_DIR, ".hbs");
  const entries = files.map((filePath) => {
    const contents = fs.readFileSync(filePath, "utf8");
    const relativePath = path.relative(ORIGINAL_APP_DIR, filePath);
    const titleMatch = contents.match(/<title>([\s\S]*?)<\/title>/i);
    const title = decodeLegacyText(titleMatch?.[1] || path.basename(filePath, ".hbs"));
    const bodyText = stripHtmlToText(contents);
    return {
      id: `email:${relativePath.replace(/[\\/]/g, "::").replace(/\.hbs$/i, "").toLowerCase()}`,
      channel: "email",
      name: title,
      fileName: path.basename(filePath),
      relativePath,
      category: inferCategory(title, relativePath),
      audience: inferAudience(relativePath),
      brand: inferBrand(relativePath, bodyText),
      stage: inferStage(title, relativePath),
      preview: extractPreview(bodyText, 220),
      subject: title,
      bodyText,
      sourcePath: filePath,
    };
  });

  return {
    available: true,
    sourcePath: ORIGINAL_TEMPLATE_DIR,
    entries,
  };
}

function buildCategorySummary(entries = []) {
  return entries.reduce((accumulator, entry) => {
    const key = entry.category || "general";
    accumulator[key] = (accumulator[key] || 0) + 1;
    return accumulator;
  }, {});
}

function buildBrandSummary(entries = []) {
  return entries.reduce((accumulator, entry) => {
    const key = entry.brand || "ALL";
    accumulator[key] = (accumulator[key] || 0) + 1;
    return accumulator;
  }, {});
}

function buildContactLibraryCatalog() {
  const textLibrary = loadTextMessageLibrary();
  const emailLibrary = loadEmailTemplateLibrary();

  return {
    source: {
      originalAppDir: ORIGINAL_APP_DIR,
      textLibraryPath: textLibrary.sourcePath,
      emailTemplateRoot: emailLibrary.sourcePath,
    },
    sms: {
      available: textLibrary.available,
      count: textLibrary.entries.length,
      byCategory: buildCategorySummary(textLibrary.entries),
      entries: textLibrary.entries,
    },
    email: {
      available: emailLibrary.available,
      count: emailLibrary.entries.length,
      byCategory: buildCategorySummary(emailLibrary.entries),
      byBrand: buildBrandSummary(emailLibrary.entries),
      entries: emailLibrary.entries,
    },
  };
}

module.exports = {
  buildContactLibraryCatalog,
};
