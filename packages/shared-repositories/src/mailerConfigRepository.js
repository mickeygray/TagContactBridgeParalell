"use strict";

const { MailerConfig } = require("../../shared-models/src");

function normalizeDigits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.length === 11 && digits.startsWith("1")
    ? digits.slice(1)
    : digits.slice(-10);
}

function normalizePhone(value) {
  const digits = normalizeDigits(value);
  if (digits.length !== 10) return String(value || "").trim() || null;
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
}

async function listMailerConfigs() {
  return MailerConfig.find({}).sort({ phone: 1 }).lean();
}

async function findMailerConfigByPhone(phone) {
  const digits = normalizeDigits(phone);
  if (!digits) return null;
  return MailerConfig.findOne({ digits }).lean();
}

async function upsertMailerConfig(phone, assignment = {}) {
  const digits = normalizeDigits(phone);
  const formattedPhone = normalizePhone(phone);
  return MailerConfig.findOneAndUpdate(
    { digits },
    {
      $set: {
        phone: formattedPhone,
        digits,
        lastUpdated: new Date(),
      },
      $push: { assignments: assignment },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
}

async function replaceMailerAssignments(phone, assignments = []) {
  const digits = normalizeDigits(phone);
  const formattedPhone = normalizePhone(phone);
  return MailerConfig.findOneAndUpdate(
    { digits },
    {
      $set: {
        phone: formattedPhone,
        digits,
        assignments,
        lastUpdated: new Date(),
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
}

module.exports = {
  findMailerConfigByPhone,
  listMailerConfigs,
  normalizeDigits,
  normalizePhone,
  replaceMailerAssignments,
  upsertMailerConfig,
};
