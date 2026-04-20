"use strict";

function env(name, fallback = "") {
  const value = process.env[name];
  return value === undefined || value === null || value === "" ? fallback : value;
}

function envInt(name, fallback) {
  const value = env(name, "");
  if (value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(name, fallback = false) {
  const value = env(name, "");
  if (value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

module.exports = {
  env,
  envBool,
  envInt,
};
