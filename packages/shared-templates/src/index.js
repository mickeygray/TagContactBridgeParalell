"use strict";

// Single source of truth for the on-disk template tree. The mailer
// service joins this base path with `<category>/<name>.hbs` to find a
// template, and walks the assets dir for inline CIDs (logos, PDFs,
// etc).
//
// Categories live alongside each other on purpose:
//   - nightly/        operational reports (financial close, vendor, redline)
//   - cadence/<DOMAIN>/  outbound prospect cadences (welcome chain, ProspectWelcome1..5)
//   - clientcontact/  follow-up emails to converted clients
//   - transactional/  intake confirmations, internal lead notifications
//   - marketing/      one-off campaign sends
//   - partials/       shared header/footer/css fragments — referenced as `{{> partial-name}}`
//   - assets/<DOMAIN>/  brand assets (logos, PDFs) attached as CID inlines
const path = require("path");

const TEMPLATES_DIR = path.join(__dirname, "templates");
const PARTIALS_DIR = path.join(TEMPLATES_DIR, "partials");
const ASSETS_DIR = path.join(TEMPLATES_DIR, "assets");

const TEMPLATE_CATEGORIES = Object.freeze([
  "nightly",
  "cadence",
  "clientcontact",
  "transactional",
  "marketing",
]);

function templatePath(category, name) {
  return path.join(TEMPLATES_DIR, category, `${name}.hbs`);
}

function partialPath(name) {
  return path.join(PARTIALS_DIR, `${name}.hbs`);
}

function assetPath(domain, filename) {
  return path.join(ASSETS_DIR, String(domain || "").toUpperCase(), filename);
}

module.exports = {
  TEMPLATES_DIR,
  PARTIALS_DIR,
  ASSETS_DIR,
  TEMPLATE_CATEGORIES,
  templatePath,
  partialPath,
  assetPath,
};
