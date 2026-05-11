"use strict";

/**
 * Targeted provisioning: creates UserAccounts for ballen, polson, acalloway,
 * slucas and ties each to their Logics user id. Pulls extensionId from the
 * live RC extensions list by email. Skips cleanly if an account already
 * exists for an email. Idempotent.
 *
 * Usage:
 *   node scripts/provision-four-agents.js          # apply
 *   node scripts/provision-four-agents.js --dry    # preview only
 */

require("dotenv").config();

const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
const { getSharedConfig } = require("../packages/shared-config/src");
const { createRingCentralClient } = require("../packages/shared-integrations/src");
const {
  userAccountRepository,
} = require("../packages/shared-repositories/src");
const {
  findLogicsAgentByEmail,
} = require("../packages/shared-data/src/logicsAgents");

const TARGET_EMAILS = [
  "ballen@taxadvocategroup.com",
  "polson@taxadvocategroup.com",
  "acalloway@taxadvocategroup.com",
  "slucas@taxadvocategroup.com",
];

function normalize(email) {
  return String(email || "").trim().toLowerCase();
}

async function main() {
  const dryRun =
    process.argv.includes("--dry") || process.argv.includes("--dry-run");

  const config = getSharedConfig();
  const state = await connectMongo(config);
  if (!state.connected) {
    throw new Error(`Mongo not connected (state: ${JSON.stringify(state)})`);
  }

  const rc = createRingCentralClient();
  await rc.reinitializePlatform({ force: false, reason: "provision-four" });
  const payload = await rc.listExtensions();
  const records = Array.isArray(payload.records) ? payload.records : [];

  const extByEmail = new Map();
  for (const ext of records) {
    const email = normalize(ext?.contact?.email);
    if (!email) continue;
    if (ext.type !== "User") continue;
    const existing = extByEmail.get(email);
    if (!existing || (ext.status === "Enabled" && existing.status !== "Enabled")) {
      extByEmail.set(email, ext);
    }
  }

  const report = [];

  for (const rawEmail of TARGET_EMAILS) {
    const email = normalize(rawEmail);
    const logics = findLogicsAgentByEmail(email);
    const ext = extByEmail.get(email);
    const existing = await userAccountRepository.findUserAccountByEmail(email);

    const row = {
      email,
      logicsUserId: logics?.logicsUserId || null,
      logicsName: logics?.name || null,
      extensionId: ext ? String(ext.id) : null,
      rcStatus: ext?.status || null,
      action: null,
      accountId: null,
    };

    if (existing) {
      row.action = "exists (skipped)";
      row.accountId = existing.id;
      report.push(row);
      continue;
    }

    if (!logics) {
      row.action = "no-logics-entry (skipped)";
      report.push(row);
      continue;
    }

    const payload = {
      email,
      name: logics.name,
      role: "internal-agent",
      audience: "user",
      workspace: "general",
      company: "TAG",
      logicsUserId: logics.logicsUserId,
      logicsDisplayName: logics.name,
      extensionId: row.extensionId,
      phone: logics.phone || null,
      status: ext && ext.status === "Enabled" ? "invited" : "invited",
      source: "rc-poll",
      metadata: {
        provisionedFromRc: Boolean(ext),
        lastRcSyncAt: new Date(),
        rcStatus: ext?.status || null,
        logicsRoles: logics.roles,
        provisionedBy: "provision-four-agents",
      },
    };

    if (dryRun) {
      row.action = "would-create";
      report.push(row);
      continue;
    }

    const created = await userAccountRepository.createUserAccount(payload);
    row.action = "created";
    row.accountId = created.id;
    report.push(row);
  }

  console.log(`Provision four agents ${dryRun ? "(dry run)" : ""}:\n`);
  for (const r of report) {
    console.log(
      `  ${r.email.padEnd(34)}  logicsUserId=${String(r.logicsUserId).padEnd(5)}  ext=${String(r.extensionId || "-").padEnd(5)}  rc=${String(r.rcStatus || "-").padEnd(10)}  ${r.action}${r.accountId ? `  id=${r.accountId}` : ""}`,
    );
  }

  await disconnectMongo();
}

main().catch((error) => {
  console.error("provision-four-agents failed:", error.message);
  console.error(error.stack);
  process.exit(1);
});
