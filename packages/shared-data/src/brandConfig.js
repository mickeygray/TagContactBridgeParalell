"use strict";

/**
 * Per-domain brand values used by email templates. These are display
 * strings — not secrets — so keeping them in code is fine and avoids
 * yet another env var surface for templates to fail on.
 *
 * Pulled into the email renderer's template context so every template
 * can render `{{brand.name}}`, `{{brand.supportPhone}}`, etc. without
 * the caller having to remember which fields belong where.
 *
 * Missing overrides fall through to the BRAND_DEFAULTS below — a new
 * company can be added later with minimal changes.
 */

const BRAND_DEFAULTS = Object.freeze({
  name: "Our Team",
  legalName: "",
  tagline: "Here to help.",
  headerColor: "#1f2937", // slate-800
  accentColor: "#0ea5e9", // sky-500
  supportPhone: "",
  supportEmail: "",
  websiteUrl: "",
  addressLine: "",
  disclaimer:
    "This email is intended for the addressee only. If you received it in error, please reply so we can correct our records.",
});

const BRAND_OVERRIDES = Object.freeze({
  TAG: {
    name: "Tax Advocate Group",
    legalName: "Tax Advocate Group, LLC",
    tagline: "Straightforward tax-relief advocacy.",
    // TAG brand slate with a warm accent that reads well on desktop + mobile
    headerColor: "#1e293b",
    accentColor: "#c2410c", // orange-700
    supportPhone: "818-686-5483",
    supportEmail: "clients@taxadvocategroup.com",
    websiteUrl: "https://taxadvocategroup.com",
    addressLine: "Tax Advocate Group",
    disclaimer:
      "This email is intended only for the named recipient and may contain confidential information. Tax Advocate Group does not provide legal advice through email.",
  },
  WYNN: {
    name: "Wynn Tax Solutions",
    legalName: "Wynn Tax Solutions",
    tagline: "Resolving tax debt, clearly.",
    headerColor: "#0f172a",
    accentColor: "#2563eb", // blue-600
    supportPhone: "310-561-1009",
    supportEmail: "clients@wynntaxsolutions.com",
    websiteUrl: "https://wynntaxsolutions.com",
    addressLine: "Wynn Tax Solutions",
    disclaimer:
      "This email is intended only for the named recipient and may contain confidential information. Wynn Tax Solutions does not provide legal advice through email.",
  },
});

function getBrandConfig(domain) {
  const key = String(domain || "").trim().toUpperCase();
  return { ...BRAND_DEFAULTS, ...(BRAND_OVERRIDES[key] || {}), domainKey: key };
}

function listBrandKeys() {
  return Object.keys(BRAND_OVERRIDES);
}

module.exports = {
  BRAND_DEFAULTS,
  BRAND_OVERRIDES,
  getBrandConfig,
  listBrandKeys,
};
