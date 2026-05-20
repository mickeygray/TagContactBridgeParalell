"use strict";
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const { getSharedConfig } = require("../packages/shared-config/src");
const { UserAccount, AgentState } = require("../packages/shared-models/src");

const FOCUS = (process.env.FOCUS || "bruce,sean").split(",").map(s => s.trim());

function dig(o, p, d = null) {
  return p.split(".").reduce((a, k) => (a == null ? a : a[k]), o) ?? d;
}

(async () => {
  const cfg = getSharedConfig();
  await mongoose.connect(cfg.mongoUri, { dbName: cfg.parallelDbName });

  for (const needle of FOCUS) {
    const accounts = await UserAccount.find(
      { $or: [
        { name: new RegExp(needle, "i") },
        { email: new RegExp(needle, "i") },
        { firstName: new RegExp(needle, "i") },
      ] },
    ).lean();
    for (const a of accounts) {
      console.log(`\n=== ${a.name || a.email} (${needle}) ===`);
      console.log(`  email:          ${a.email}`);
      console.log(`  status:         ${a.status}`);
      console.log(`  role:           ${a.role || "?"}`);
      console.log(`  extensionId:    ${a.extensionId || "(unpaired)"}`);
      console.log(`  audience:       ${a.audience || "?"}`);
      console.log(`  isHardened:     ${a.isHardened || false}`);
      console.log(`  cxQueuePolicy.enabled:        ${dig(a, "cxQueuePolicy.enabled")}`);
      console.log(`  cxQueuePolicy.routeCampaigns: ${JSON.stringify(dig(a, "cxQueuePolicy.routeCampaigns"))}`);
      console.log(`  cxQueuePolicy.totalOpen:      ${dig(a, "cxQueuePolicy.totalOpen")}`);
      console.log(`  cxQueuePolicy.fresh:          ${JSON.stringify(dig(a, "cxQueuePolicy.fresh"))}`);
      console.log(`  cxQueuePolicy.day2to15:       ${JSON.stringify(dig(a, "cxQueuePolicy.day2to15"))}`);
      console.log(`  cxQueuePolicy.aged:           ${JSON.stringify(dig(a, "cxQueuePolicy.aged"))}`);
      console.log(`  cxAuth.tokenExpiresAt:        ${dig(a, "cxAuth.tokenExpiresAt") || "—"}`);
      console.log(`  cxAuth.scopes:                ${JSON.stringify(dig(a, "cxAuth.scopes"))}`);

      if (a.extensionId) {
        const ag = await AgentState.findOne({ extensionId: String(a.extensionId) }).lean();
        if (!ag) {
          console.log(`  AgentState:                   NOT FOUND`);
        } else {
          console.log(`  AgentState.status:            ${ag.status}`);
          console.log(`  AgentState.activityState:     ${ag.activityState || "?"}`);
          console.log(`  AgentState.lastActivityAt:    ${ag.lastActivityAt || "?"}`);
          console.log(`  AgentState.presence:          ${JSON.stringify(ag.presence || {}).slice(0, 200)}`);
          console.log(`  AgentState.cxWorkspace:       ${JSON.stringify(ag.cxWorkspace || {}).slice(0, 200)}`);
          console.log(`  AgentState.assignmentStats:   ${JSON.stringify(ag.cxRouting?.assignmentStats || {})}`);
          console.log(`  AgentState.idleReaper?:       ${JSON.stringify(ag.idleReaper || ag.idle || null)}`);
          console.log(`  AgentState.lastTouchedAt:     ${ag.lastTouchedAt || "?"}`);
          console.log(`  AgentState.updatedAt:         ${ag.updatedAt}`);
        }
      }
    }
  }
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
