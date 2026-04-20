"use strict";

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return value.startsWith?.("+") ? `+${digits}` : digits;
}

function normalizeCompanyKey(value, fallback = "WYNN") {
  const key = String(value || fallback).trim().toUpperCase();
  return key || fallback;
}

module.exports = {
  normalizeCompanyKey,
  normalizeEmail,
  normalizePhone,
};
