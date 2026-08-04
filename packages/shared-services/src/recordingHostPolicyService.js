"use strict";

const net = require("net");

const MAX_RECORDING_URL_LENGTH = 2048;

function parseAllowedRecordingHosts(value) {
  const values = Array.isArray(value)
    ? value
    : String(value || "").split(/[\s,;]+/);
  return [...new Set(
    values
      .map((item) => String(item || "").trim().toLowerCase().replace(/\.$/, ""))
      .filter(
        (item) =>
          item &&
          item.length <= 253 &&
          !item.includes("://") &&
          !item.includes("/") &&
          !item.includes("@") &&
          !item.includes(":"),
      ),
  )];
}

function hostnameMatchesAllowedRule(hostname, rule) {
  const host = String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  const normalizedRule = String(rule || "").trim().toLowerCase();
  if (!host || !normalizedRule) return false;
  if (normalizedRule.startsWith(".")) {
    return host.endsWith(normalizedRule) && host.length > normalizedRule.length;
  }
  return host === normalizedRule;
}

function isPublicIpv4(address) {
  const parts = String(address).split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function isPublicIpv6(address) {
  const value = String(address || "")
    .toLowerCase()
    .split("%")[0]
    .replace(/^\[|\]$/g, "");
  if (!value || value === "::" || value === "::1") return false;
  if (value.startsWith("::ffff:")) {
    const mapped = value.slice("::ffff:".length);
    return net.isIP(mapped) === 4 && isPublicIpv4(mapped);
  }
  const first = Number.parseInt(value.split(":")[0] || "0", 16);
  if (!Number.isFinite(first)) return false;
  if ((first & 0xfe00) === 0xfc00) return false;
  if ((first & 0xffc0) === 0xfe80) return false;
  if ((first & 0xff00) === 0xff00) return false;
  if (value.startsWith("2001:db8:") || value === "2001:db8::") return false;
  return true;
}

function isPublicIp(address) {
  const family = net.isIP(String(address || ""));
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

function isForbiddenHostname(hostname) {
  const host = String(hostname || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  return (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan") ||
    host.endsWith(".home")
  );
}

function normalizeAllowedHttpsRecordingUrl(value, { allowedHosts = [] } = {}) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim();
  if (!normalized || normalized.length > MAX_RECORDING_URL_LENGTH) return null;
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
  if (parsed.href.length > MAX_RECORDING_URL_LENGTH) return null;
  if (isForbiddenHostname(parsed.hostname)) return null;
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && !isPublicIp(host)) return null;
  const rules = parseAllowedRecordingHosts(allowedHosts);
  if (!rules.some((rule) => hostnameMatchesAllowedRule(host, rule))) return null;
  return parsed.toString();
}

module.exports = {
  MAX_RECORDING_URL_LENGTH,
  hostnameMatchesAllowedRule,
  isForbiddenHostname,
  isPublicIp,
  normalizeAllowedHttpsRecordingUrl,
  parseAllowedRecordingHosts,
};
