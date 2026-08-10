"use strict";

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

const ROOT = path.resolve(__dirname, "..");
const ENV_PATH = path.join(ROOT, ".env");
const NGINX_CONF_PATH = path.join(ROOT, "ops", "nginx", "parallel.conf");
const NSSM_PATH = path.join(ROOT, "ops", "nssm", "install-services.ps1");
const WEB_BUILD_PATH = path.join(ROOT, "apps", "web-client", "build", "index.html");

const failures = [];
const warnings = [];
const passes = [];

function record(list, label, detail) {
  list.push({ label, detail });
}

function pass(label, detail) {
  record(passes, label, detail);
}

function warn(label, detail) {
  record(warnings, label, detail);
}

function fail(label, detail) {
  record(failures, label, detail);
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function ensureFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    fail(label, `Missing file: ${filePath}`);
    return null;
  }
  pass(label, filePath);
  return readText(filePath);
}

function hasAny(env, keys) {
  return keys.some((key) => String(env[key] || "").trim());
}

function checkEnvValue(env, key, label) {
  if (String(env[key] || "").trim()) {
    pass(label, `${key} is set`);
  } else {
    fail(label, `${key} is required for cutover`);
  }
}

function checkEnvAny(env, keys, label) {
  if (hasAny(env, keys)) {
    pass(label, `One of ${keys.join(", ")} is set`);
  } else {
    fail(label, `One of ${keys.join(", ")} must be set for cutover`);
  }
}

function checkTextIncludes(text, needle, label) {
  if (text.includes(needle)) {
    pass(label, `Found ${needle}`);
  } else {
    fail(label, `Missing ${needle}`);
  }
}

function printGroup(title, items) {
  if (items.length === 0) return;
  console.log(`\n${title}`);
  for (const item of items) {
    console.log(`- ${item.label}: ${item.detail}`);
  }
}

function main() {
  const nginxConf = ensureFile(NGINX_CONF_PATH, "nginx config");
  const nssmScript = ensureFile(NSSM_PATH, "nssm install script");

  if (fs.existsSync(WEB_BUILD_PATH)) {
    pass("web build", WEB_BUILD_PATH);
  } else {
    warn("web build", `Missing built app shell at ${WEB_BUILD_PATH}`);
  }

  let env = {};
  if (fs.existsSync(ENV_PATH)) {
    env = dotenv.parse(readText(ENV_PATH));
    pass(".env", ENV_PATH);
  } else {
    warn(".env", `Missing ${ENV_PATH}; env validation is limited`);
  }

  checkEnvValue(env, "WEB_CLIENT_ORIGINS", "cors origin");
  checkEnvAny(env, ["EXTERNAL_WEBHOOK_SECRET", "INTERNAL_SERVICE_SECRET"], "webhook secret");
  checkEnvValue(env, "CALLRAIL_WEBHOOK_SECRET", "callrail signing secret");
  checkEnvAny(env, ["FB_APP_SECRET", "TAG_FB_APP_SECRET", "WYNN_FB_APP_SECRET"], "meta app secret");
  checkEnvAny(env, ["TT_CLIENT_SECRET", "TIKTOK_SIGNING_KEY"], "tiktok signing secret");
  checkEnvValue(env, "NGROK_DOMAIN", "ngrok domain");

  if (nginxConf) {
    checkTextIncludes(nginxConf, "proxy_pass http://parallel_cp/api/auth/check;", "nginx auth gate");
    checkTextIncludes(nginxConf, "location /api/inbound/", "nginx inbound api route");
    checkTextIncludes(nginxConf, "location = /api/jira/webhook", "nginx Jira webhook route");
    checkTextIncludes(nginxConf, "location = /fb/webhook", "nginx facebook route");
    checkTextIncludes(nginxConf, "location = /tt/webhook", "nginx tiktok route");
    checkTextIncludes(nginxConf, "location = /lead-contact", "nginx lead-contact route");
    checkTextIncludes(nginxConf, "location = /lead-contact/pre-ping", "nginx pre-ping route");
    checkTextIncludes(nginxConf, "location = /sms/inbound", "nginx sms inbound route");
    checkTextIncludes(nginxConf, "location = /api/client/runtime", "nginx public runtime heartbeat");
    checkTextIncludes(nginxConf, "location /api/sales-trainer/", "nginx sales trainer route");
    checkTextIncludes(nginxConf, "client_max_body_size 32m;", "nginx trainer audio body size");
    checkTextIncludes(nginxConf, "server 127.0.0.1:5001;", "nginx 5001 shell upstream");
  }

  if (nssmScript) {
    checkTextIncludes(nssmScript, "ParallelControlPlane", "nssm control-plane service");
    checkTextIncludes(nssmScript, "ParallelInboundGateway", "nssm inbound service");
    checkTextIncludes(nssmScript, "ParallelOutboundGateway", "nssm outbound service");
    checkTextIncludes(nssmScript, "ParallelRingCentralCx", "nssm ringcentral service");
  }

  printGroup("PASS", passes);
  printGroup("WARN", warnings);
  printGroup("FAIL", failures);

  if (failures.length > 0) {
    console.error(`\nCutover preflight failed with ${failures.length} blocking issue(s).`);
    process.exit(1);
  }

  console.log(`\nCutover preflight passed${warnings.length > 0 ? ` with ${warnings.length} warning(s)` : ""}.`);
}

main();
