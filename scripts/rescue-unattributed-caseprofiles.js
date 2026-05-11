"use strict";

// One-shot retroactive attribution rescue for CaseProfiles that the
// bridge sweep created with `sourceCanonicalId: null`. Walks the
// targeted cohort (created recently OR has at most one payment),
// fetches each from Logics, resolves SourceCampaignID to a canonical,
// and writes the result back.
//
// Targeting rationale: the historical Unknown bucket includes
// legacy-era multi-payment cases that have no business getting
// attributed in the parallel app. The selective filter focuses on
// where attribution actually matters: fresh engagements + first-
// payment conversions (where ROI metrics drive ad spend decisions).
//
// Usage:
//   node scripts/rescue-unattributed-caseprofiles.js                # DRY (default)
//   node scripts/rescue-unattributed-caseprofiles.js --commit
//   node scripts/rescue-unattributed-caseprofiles.js --commit --days 60
//   node scripts/rescue-unattributed-caseprofiles.js --commit --domain WYNN
//   node scripts/rescue-unattributed-caseprofiles.js --commit --max-payments 0   # unpaid only

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const { CaseProfile } = require("../packages/shared-models/src");
const { createLogicsClient } = require("../packages/shared-integrations/src");
const {
  resolveCanonicalSource,
} = require("../packages/shared-services/src/sourceCanonicalService");

function readFlag(argv, name) {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1) return argv[idx + 1];
  return null;
}
function hasFlag(argv, name) {
  return argv.includes(name);
}

async function fetchLogicsSourceForCase(client, caseId) {
  try {
    const payload = await client.getCaseInfo(Number(caseId));
    const data = payload?.data || payload?.Data || payload || null;
    if (!data || typeof data !== "object") return null;
    const logicsSourceId =
      data.SourceCampaignID ||
      data.CampaignSourceID ||
      data.CampaignID ||
      data.SourceID ||
      data.SourceId ||
      null;
    return {
      caseInfo: data,
      logicsSourceId: logicsSourceId ? Number(logicsSourceId) : null,
    };
  } catch (err) {
    if (err?.details?.responseStatus === 404) return null;
    return { error: err.message };
  }
}

async function runConcurrent(items, concurrency, fn, onProgress) {
  const results = new Array(items.length);
  let inflight = 0;
  let nextIndex = 0;
  let completed = 0;
  return new Promise((resolve, reject) => {
    function pump() {
      while (inflight < concurrency && nextIndex < items.length) {
        const myIndex = nextIndex;
        nextIndex += 1;
        inflight += 1;
        Promise.resolve()
          .then(() => fn(items[myIndex]))
          .then((value) => {
            results[myIndex] = value;
            completed += 1;
            inflight -= 1;
            if (onProgress) onProgress(completed, items.length);
            if (completed === items.length) resolve(results);
            else pump();
          })
          .catch(reject);
      }
    }
    if (items.length === 0) resolve(results);
    else pump();
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const commit = hasFlag(argv, "--commit");
  const days = Number(readFlag(argv, "--days")) || 30;
  const domain = readFlag(argv, "--domain") || null;
  // Number(null) === 0, which is a valid value, so check the raw flag
  // first to distinguish "not set" from "set to 0".
  const maxPaymentsRaw = readFlag(argv, "--max-payments");
  const maxPayments = maxPaymentsRaw == null ? null : Number(maxPaymentsRaw);
  const concurrency = Number(readFlag(argv, "--concurrency")) || 10;

  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(process.env.MONGO_URI, { dbName });

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  // Targeted cohort: null source AND
  //   (created in window OR paymentsCount <= 1)
  // Multi-payment legacy-era cases are excluded — they were already
  // working before parallel and don't need parallel-side attribution.
  const query = {
    sourceCanonicalId: { $in: [null, undefined] },
    $or: [
      { createdAt: { $gte: since } },
      { paymentsCount: { $in: [null, 0, 1] } },
    ],
  };
  if (domain) query.domain = String(domain).toUpperCase();
  if (maxPayments != null && Number.isFinite(maxPayments)) {
    // Override: ignore the OR — pin to specific payment-count cap
    delete query.$or;
    query.paymentsCount = { $lte: maxPayments };
    if (since) {
      // Still narrow by created window if days is set
      query.createdAt = { $gte: since };
    }
  }

  const total = await CaseProfile.countDocuments(query);
  const totalPaid = await CaseProfile.aggregate([
    { $match: query },
    { $group: { _id: null, sum: { $sum: { $ifNull: ["$totalPaid", 0] } } } },
  ]);
  const totalRevenueAtRisk = totalPaid[0]?.sum || 0;

  console.log("══ Attribution rescue ══");
  console.log(`  mode:            ${commit ? "COMMIT" : "DRY"}`);
  console.log(`  cohort:          last ${days}d OR paymentsCount<=1`);
  if (domain) console.log(`  domain filter:   ${domain}`);
  if (Number.isFinite(maxPayments)) console.log(`  max-payments:    ${maxPayments}`);
  console.log(`  candidates:      ${total}`);
  console.log(`  revenue-at-risk: $${totalRevenueAtRisk.toFixed(0)}`);
  console.log(`  concurrency:     ${concurrency}\n`);

  if (total === 0) {
    console.log("  Nothing to rescue.");
    await mongoose.disconnect();
    return;
  }

  // Fetch in batches of 1000 to keep memory predictable; full select
  // for now since we need domain/caseId/totalPaid/createdAt at minimum.
  const candidates = await CaseProfile.find(query)
    .select({ _id: 1, domain: 1, caseId: 1, name: 1, totalPaid: 1, paymentsCount: 1, createdAt: 1 })
    .lean();

  // Cache Logics clients per domain (one per tenant — opening fresh
  // clients per row would burn token-refresh budget).
  const clientCache = new Map();
  function getClient(d) {
    if (!clientCache.has(d)) clientCache.set(d, createLogicsClient(d));
    return clientCache.get(d);
  }

  let ticker = 0;
  const results = await runConcurrent(
    candidates,
    concurrency,
    async (cp) => {
      const client = getClient(cp.domain);
      const fetched = await fetchLogicsSourceForCase(client, cp.caseId);
      if (!fetched || fetched.error || !fetched.logicsSourceId) {
        return { cp, outcome: "no-logics-source", err: fetched?.error || null };
      }
      const canonical = await resolveCanonicalSource({
        domain: cp.domain,
        sourceId: fetched.logicsSourceId,
      }).catch(() => null);
      if (!canonical) {
        return { cp, outcome: "canonical-not-found", logicsSourceId: fetched.logicsSourceId };
      }
      return {
        cp,
        outcome: "resolved",
        logicsSourceId: fetched.logicsSourceId,
        canonical,
      };
    },
    (completed, totalCount) => {
      ticker += 1;
      if (ticker % 50 === 0 || completed === totalCount) {
        process.stdout.write(`\r  enrich progress: ${completed}/${totalCount}`);
      }
    },
  );
  process.stdout.write("\n");

  // Tally
  const tally = {
    resolved: 0,
    "no-logics-source": 0,
    "canonical-not-found": 0,
    errors: 0,
    revenue_recovered: 0,
  };
  const updates = [];
  for (const r of results) {
    if (r.err) tally.errors += 1;
    if (r.outcome === "resolved") {
      tally.resolved += 1;
      tally.revenue_recovered += Number(r.cp.totalPaid || 0);
      updates.push(r);
    } else {
      tally[r.outcome] = (tally[r.outcome] || 0) + 1;
    }
  }

  console.log(`\n  resolved:             ${tally.resolved}  ($${tally.revenue_recovered.toFixed(0)} recovered)`);
  console.log(`  no-logics-source:     ${tally["no-logics-source"]}  (Logics has no SourceCampaignID for the case)`);
  console.log(`  canonical-not-found:  ${tally["canonical-not-found"]}  (Logics has source but it's not in our canonical mapping)`);
  console.log(`  errors:               ${tally.errors}`);

  // Show breakdown of resolved by canonical name
  const byCanonical = new Map();
  for (const u of updates) {
    const k = u.canonical?.internalName || "(unknown)";
    const cur = byCanonical.get(k) || { count: 0, revenue: 0 };
    cur.count += 1;
    cur.revenue += Number(u.cp.totalPaid || 0);
    byCanonical.set(k, cur);
  }
  console.log(`\n  by canonical (top 15):`);
  const sorted = [...byCanonical.entries()].sort((a, b) => b[1].revenue - a[1].revenue).slice(0, 15);
  for (const [name, stats] of sorted) {
    console.log(`    ${String(name).padEnd(40)} ${String(stats.count).padStart(5)} cases  $${stats.revenue.toFixed(0).padStart(10)}`);
  }

  if (!commit) {
    console.log(`\n  Re-run with --commit to write ${updates.length} updates.`);
    await mongoose.disconnect();
    return;
  }

  // Bulk write the updates
  console.log(`\n  writing ${updates.length} CaseProfile updates...`);
  const ops = updates.map((u) => ({
    updateOne: {
      filter: { _id: u.cp._id },
      update: {
        $set: {
          sourceCanonicalId: u.canonical.doc?._id || null,
          "attribution.matchedBy": "logics-source-rescue",
          "attribution.confidence": "high",
          "attribution.lastResolvedAt": new Date(),
        },
      },
    },
  }));
  const chunkSize = 500;
  let modified = 0;
  for (let i = 0; i < ops.length; i += chunkSize) {
    const chunk = ops.slice(i, i + chunkSize);
    const r = await CaseProfile.bulkWrite(chunk, { ordered: false });
    modified += r.modifiedCount || 0;
  }
  console.log(`  modified: ${modified}`);

  // Verify
  const stillNull = await CaseProfile.countDocuments({
    ...query,
    sourceCanonicalId: { $in: [null, undefined] },
  });
  console.log(`  remaining null in cohort: ${stillNull}`);

  await mongoose.disconnect();
  console.log(`\n[done]`);
}

main().catch((err) => {
  console.error("FATAL:", err.stack || err.message);
  process.exit(1);
});
