"use strict";

const path = require("path");
const { bootstrapRuntime, loadCheckedInConfiguration } = require("./phoneburner-july-preload");

const REQUESTS = Object.freeze({
  sean_lucas: 20,
});

async function main() {
  require("dotenv").config({ path: path.resolve(__dirname, "..", ".env"), quiet: true });
  process.env.LEAD_DELIVERY_PROVIDER_POST_MIN_INTERVAL_MS = "1";
  const context = await bootstrapRuntime({
    configuration: loadCheckedInConfiguration(),
    options: { dryRun: false },
    env: process.env,
  });
  try {
    const results = {};
    for (const [agentId, count] of Object.entries(REQUESTS)) {
      const result = await context.runtime.postTopOfQueue(agentId, { count });
      const rows = [result];
      results[agentId] = {
        requested: count,
        accepted: rows.reduce((total, row) => total + Number(row?.accepted || 0), 0),
        status: rows.every((row) => String(row?.status || "") === "posted") ? "posted" : "partial",
        claimed: rows.reduce((total, row) => total + Number(row?.claimed || 0), 0),
        providerStatuses: Object.entries(rows.flatMap((row) => row?.results || []).reduce((counts, row) => {
          const status = String(row?.status || "unknown");
          counts[status] = Number(counts[status] || 0) + 1;
          return counts;
        }, {})).map(([status, total]) => ({ status, total })),
      };
    }
    process.stdout.write(`${JSON.stringify({ ok: true, results })}\n`);
  } finally {
    await context.close();
  }
}

if (require.main === module) void main().catch(() => {
  process.stdout.write(`${JSON.stringify({ ok: false, reason: "emergency-topup-failed" })}\n`);
  process.exitCode = 1;
});
