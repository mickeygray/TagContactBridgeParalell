"use strict";

/**
 * Backfill TAG + Wynn Logics identity fields onto existing UserAccounts
 * for every human in the roster. Idempotent — only fills gaps, never
 * overwrites existing values. Run after the roster has been extended
 * with Wynn pairings.
 *
 * Usage:
 *   node scripts/backfill-logics-pairings.js --dry
 *   node scripts/backfill-logics-pairings.js
 *   node scripts/backfill-logics-pairings.js --only=ballen,polson,acalloway,slucas
 */

require("dotenv").config();

const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
const { getSharedConfig } = require("../packages/shared-config/src");
const {
  userAccountRepository,
} = require("../packages/shared-repositories/src");
const {
  LOGICS_AGENTS,
} = require("../packages/shared-data/src/logicsAgents");

function norm(e) { return String(e || "").trim().toLowerCase(); }

function getSettlementOfficerId(block) {
  return block?.settlementOfficerId || block?.soId || block?.logicsId || null;
}

async function main() {
  const dry = process.argv.includes("--dry") || process.argv.includes("--dry-run");
  const onlyArg = process.argv.find((a) => a.startsWith("--only="));
  const only = onlyArg
    ? new Set(onlyArg.slice("--only=".length).split(",").map((s) => s.trim().toLowerCase()))
    : null;

  const state = await connectMongo(getSharedConfig());
  if (!state.connected) throw new Error("mongo not connected");

  const report = [];

  for (const agent of LOGICS_AGENTS) {
    if (only) {
      const local = agent.tag?.email?.split("@")[0]?.toLowerCase();
      if (!local || !only.has(local)) continue;
    }

    // Primary login email is whichever side is present, prefer TAG
    const loginEmail = norm(agent.tag?.email || agent.wynn?.email);
    if (!loginEmail) continue;

    const ua = await userAccountRepository.findUserAccountByEmail(loginEmail);
    if (!ua) {
      report.push({ loginEmail, name: agent.name, action: "no-ua-found (skip)" });
      continue;
    }

    const patch = {};
    const changes = [];

    if (agent.tag) {
      const tagSOId = getSettlementOfficerId(agent.tag);
      if (!ua.tagLogicsId) { patch.tagLogicsId = agent.tag.logicsId; changes.push(`tagLogicsId=${agent.tag.logicsId}`); }
      if (!ua.tagSOId && tagSOId) { patch.tagSOId = tagSOId; changes.push(`tagSOId=${tagSOId}`); }
      if (!ua.tagEmail) { patch.tagEmail = agent.tag.email; changes.push(`tagEmail=${agent.tag.email}`); }
      if (!ua.tagLogicsName) { patch.tagLogicsName = agent.tag.displayName || agent.name; changes.push(`tagLogicsName`); }
      if (!ua.tagLogicsRoles) { patch.tagLogicsRoles = agent.tag.roles; changes.push(`tagLogicsRoles`); }
    }
    if (agent.wynn) {
      const wynnSOId = getSettlementOfficerId(agent.wynn);
      if (!ua.wynnLogicsId) { patch.wynnLogicsId = agent.wynn.logicsId; changes.push(`wynnLogicsId=${agent.wynn.logicsId}`); }
      if (!ua.wynnSOId && wynnSOId) { patch.wynnSOId = wynnSOId; changes.push(`wynnSOId=${wynnSOId}`); }
      if (!ua.wynnEmail) { patch.wynnEmail = agent.wynn.email; changes.push(`wynnEmail=${agent.wynn.email}`); }
      if (!ua.wynnLogicsName) { patch.wynnLogicsName = agent.wynn.displayName || agent.name; changes.push(`wynnLogicsName`); }
      if (!ua.wynnLogicsRoles) { patch.wynnLogicsRoles = agent.wynn.roles; changes.push(`wynnLogicsRoles`); }
    }

    if (changes.length === 0) {
      report.push({ loginEmail, name: agent.name, action: "already-complete" });
      continue;
    }

    if (!dry) {
      await userAccountRepository.updateUserAccount(ua.id, patch);
    }
    report.push({ loginEmail, name: agent.name, action: dry ? "would-patch" : "patched", changes });
  }

  console.log(`\nLogics pairing backfill ${dry ? "(dry run)" : ""}:\n`);
  for (const r of report) {
    const changeLabel = r.changes ? ` [${r.changes.join(", ")}]` : "";
    console.log(`  ${r.loginEmail.padEnd(36)} ${r.name.padEnd(22)} ${r.action}${changeLabel}`);
  }

  await disconnectMongo();
}

main().catch((e) => { console.error(e); console.error(e.stack); process.exit(1); });
