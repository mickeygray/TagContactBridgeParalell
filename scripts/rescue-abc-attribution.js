"use strict";

// Targeted attribution upgrade for CaseProfiles currently attributed
// to "ABC" (the mail-house catch-all). The whole point of attribution
// rescue is to break ABC apart into specific mailer pieces — not to
// leave it as the catch-all bucket.
//
// Strategy per case:
//   1. Find CallLog rows for the case. We prioritize INBOUND rows
//      because their `trackingNumber` is the actual tracker the
//      caller dialed in response to a mail piece. Outbound rows have
//      a caller-ID tracking number that doesn't point at the mailer.
//   2. For each unique tracking number, look up the SourceCanonical
//      via `findSourceCanonicalByTrackingNumber`. Each tracker is
//      attached to ONE specific source (mailer drop, campaign, etc.).
//   3. If we find a non-generic canonical (not ABC / BCD / any other
//      configured catch-all), update the CaseProfile to that source.
//   4. If multiple non-generic candidates exist, take the most-recent
//      inbound call's tracker (most recent = strongest signal).
//   5. If no non-generic match, leave as ABC.
//
// What this script does NOT do:
//   - Touch BCD-attributed cases (broadcast-dialer aggregator, fine
//     as-is per ops decision).
//   - Touch cases without inbound CallLogs (outbound-only cases need
//     a different signal — DID lookup, mail-intake batch, etc.).
//   - Re-run the full attribution resolver chain (heavier, but lots
//     of side effects we don't want here).
//
// Usage:
//   node scripts/rescue-abc-attribution.js                   # DRY (default)
//   node scripts/rescue-abc-attribution.js --commit
//   node scripts/rescue-abc-attribution.js --commit --domain TAG

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const {
  CaseProfile,
  CallLog,
  SourceCanonical,
} = require("../packages/shared-models/src");
const {
  sourceCanonicalRepository,
} = require("../packages/shared-repositories/src");
const {
  lookupInboundCall,
} = require("../packages/shared-services/src/callrailLookupService");
const {
  resolveSourceFromLegs,
} = require("../packages/shared-services/src/ringcentralAttributionService");

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

const GENERIC_NAMES = new Set([
  "abc",
  "bcd",
  ...String(process.env.LOGICS_GENERIC_SOURCE_NAMES || "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean),
]);

function isGeneric(internalName) {
  if (!internalName) return true;
  return GENERIC_NAMES.has(String(internalName).trim().toLowerCase());
}

function normalizeDigits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits.slice(-10);
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
  const domain = readFlag(argv, "--domain") || null;
  const concurrency = Number(readFlag(argv, "--concurrency")) || 10;

  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(process.env.MONGO_URI, { dbName });

  // Resolve ABC canonical(s) — TAG-only per current setup, but query
  // by name in case it's set up cross-tenant later.
  const abcCanonicals = await SourceCanonical.find({
    internalName: { $regex: /^abc$/i },
  })
    .select({ _id: 1, domains: 1 })
    .lean();
  if (abcCanonicals.length === 0) {
    console.error("No ABC canonical found in SourceCanonical collection.");
    await mongoose.disconnect();
    process.exit(1);
  }
  const abcIds = abcCanonicals.map((a) => a._id);
  console.log(`ABC canonical _id(s): ${abcIds.map((id) => String(id)).join(", ")}`);

  // Find CaseProfiles currently attributed to ABC.
  const query = {
    sourceCanonicalId: { $in: abcIds },
    "attribution.lockedManual": { $ne: true },
  };
  if (domain) query.domain = String(domain).toUpperCase();

  const total = await CaseProfile.countDocuments(query);
  const totalPaid = await CaseProfile.aggregate([
    { $match: query },
    { $group: { _id: null, sum: { $sum: { $ifNull: ["$totalPaid", 0] } } } },
  ]);
  const revenueAtRisk = totalPaid[0]?.sum || 0;

  console.log(`\n══ ABC attribution upgrade ══`);
  console.log(`  mode:            ${commit ? "COMMIT" : "DRY"}`);
  if (domain) console.log(`  domain filter:   ${domain}`);
  console.log(`  candidates:      ${total}`);
  console.log(`  revenue under ABC: $${revenueAtRisk.toFixed(0)}`);
  console.log(`  concurrency:     ${concurrency}\n`);

  if (total === 0) {
    console.log("  Nothing to upgrade.");
    await mongoose.disconnect();
    return;
  }

  const candidates = await CaseProfile.find(query)
    .select({ _id: 1, domain: 1, caseId: 1, name: 1, totalPaid: 1, primaryPhone: 1, normalizedPhones: 1 })
    .lean();

  // For each case, find inbound CallLogs and try to upgrade attribution
  // via tracking-number lookup.
  let ticker = 0;
  const trackerCache = new Map(); // trackingNumber → canonical | null
  async function lookupTracker(num) {
    const key = normalizeDigits(num);
    if (!key) return null;
    if (trackerCache.has(key)) return trackerCache.get(key);
    const can = await sourceCanonicalRepository
      .findSourceCanonicalByTrackingNumber(key)
      .catch(() => null);
    trackerCache.set(key, can || null);
    return can;
  }

  // CallRail's public API rate-limits at ~60 req/min. With concurrency=1
  // and a ~1100ms inter-call gap we stay safely under. The previous run
  // saturated the limit and 429'd ~half the cohort.
  const callrailGapMs = Number(readFlag(argv, "--callrail-gap-ms")) || 1100;
  let lastCallrailAt = 0;
  async function paced(fn) {
    const now = Date.now();
    const wait = Math.max(0, callrailGapMs - (now - lastCallrailAt));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallrailAt = Date.now();
    return fn();
  }

  const results = await runConcurrent(
    candidates,
    concurrency,
    async (cp) => {
      const phone = normalizeDigits(
        cp.primaryPhone || (cp.normalizedPhones && cp.normalizedPhones[0]),
      );
      if (!phone) {
        return { cp, chosen: null, reason: "no-phone" };
      }
      // Query CallRail directly for this phone — it returns the most-
      // recent inbound call with the actual `trackingNumber` baked in.
      // This is the same data source the live attribution resolver
      // hits at step 5 ("CallRail" strategy), which is the canonical
      // way to resolve a mailer caller back to its specific source.
      let cr;
      let callrailErr;
      try {
        cr = await paced(() => lookupInboundCall(cp.domain, phone));
      } catch (err) {
        // Soft-fall to legs[] path if CallRail rate-limits / 5xx —
        // we still want a chance at upgrading via RC even when
        // CallRail won't talk to us.
        cr = null;
        callrailErr = err.message;
      }
      const call = cr?.call || null;
      if (call?.trackingNumber) {
        const canonical = await lookupTracker(call.trackingNumber);
        if (canonical && !isGeneric(canonical.internalName)) {
          return {
            cp,
            chosen: canonical,
            reason: "upgraded-callrail",
            trackingNumber: call.trackingNumber,
          };
        }
      }

      // CallRail miss (or tracker mapped to generic) — try RC legs[].
      // Parallel CallLog stores `legsSnapshot` per row. Mail-house
      // calls that route through a dedicated RingCentral queue (DID
      // direct, no CallRail in front) still leave a leg with the
      // queue's extensionId — which `findSourceCanonicalByRingCentralExtension`
      // maps to the specific source.
      const inboundLogs = await CallLog.find({
        domain: cp.domain,
        caseId: cp.caseId,
      })
        .select({ legsSnapshot: 1, startedAt: 1, direction: 1 })
        .sort({ startedAt: -1, createdAt: -1 })
        .limit(10)
        .lean();
      for (const cl of inboundLogs) {
        if (!cl.legsSnapshot) continue;
        const legs = Array.isArray(cl.legsSnapshot)
          ? cl.legsSnapshot
          : Array.isArray(cl.legsSnapshot?.legs)
            ? cl.legsSnapshot.legs
            : null;
        if (!legs || legs.length === 0) continue;
        const legResult = await resolveSourceFromLegs(legs).catch(() => null);
        if (
          legResult?.matched &&
          legResult.internalName &&
          !isGeneric(legResult.internalName)
        ) {
          // Convert leg result shape to a canonical-like object.
          // `resolveSourceFromLegs` returns sourceCanonicalId (string)
          // but not the doc itself; we fetch the doc so the update
          // bulk-write can use _id directly.
          const can = await sourceCanonicalRepository.findSourceCanonicalById(
            legResult.sourceCanonicalId,
          );
          if (can) {
            return {
              cp,
              chosen: can,
              reason: "upgraded-rc-legs",
              extensionId: legResult.extensionId,
              legIndex: legResult.legIndex,
            };
          }
        }
      }

      // Neither path matched — categorize the miss
      if (callrailErr) {
        return { cp, chosen: null, reason: "callrail-error-no-legs", err: callrailErr };
      }
      if (!call) return { cp, chosen: null, reason: "no-callrail-no-legs" };
      if (!call.trackingNumber) return { cp, chosen: null, reason: "callrail-no-tracker" };
      return { cp, chosen: null, reason: "tracker-generic-or-unmapped" };
    },
    (completed, totalCount) => {
      ticker += 1;
      if (ticker % 25 === 0 || completed === totalCount) {
        process.stdout.write(`\r  upgrade progress: ${completed}/${totalCount}`);
      }
    },
  );
  process.stdout.write("\n");

  // Tally
  const tally = {
    upgraded: 0,
    revenue_re_attributed: 0,
  };
  const reasonTally = {};
  const updates = [];
  const upgradeBuckets = new Map();

  for (const r of results) {
    reasonTally[r.reason] = (reasonTally[r.reason] || 0) + 1;
    if (r.chosen) {
      tally.upgraded += 1;
      tally.revenue_re_attributed += Number(r.cp.totalPaid || 0);
      updates.push(r);
      const k = r.chosen.internalName;
      const cur = upgradeBuckets.get(k) || { count: 0, revenue: 0 };
      cur.count += 1;
      cur.revenue += Number(r.cp.totalPaid || 0);
      upgradeBuckets.set(k, cur);
    }
  }

  console.log(`\n  upgraded:           ${tally.upgraded}  ($${tally.revenue_re_attributed.toFixed(0)} re-attributed)`);
  console.log(`\n  outcomes by reason:`);
  for (const [reason, count] of Object.entries(reasonTally).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(reason).padEnd(28)} ${String(count).padStart(5)}`);
  }
  // If callrail errors dominate, sample one
  const sampleErr = results.find((r) => r.err);
  if (sampleErr) {
    console.log(`\n  sample callrail error: ${String(sampleErr.err).slice(0, 200)}`);
  }

  if (upgradeBuckets.size > 0) {
    console.log(`\n  by upgraded source:`);
    const sorted = [...upgradeBuckets.entries()].sort((a, b) => b[1].revenue - a[1].revenue);
    for (const [name, stats] of sorted) {
      console.log(`    ${String(name).padEnd(40)} ${String(stats.count).padStart(5)} cases  $${stats.revenue.toFixed(0).padStart(10)}`);
    }
  }

  if (!commit) {
    console.log(`\n  Re-run with --commit to write ${updates.length} updates.`);
    await mongoose.disconnect();
    return;
  }

  console.log(`\n  writing ${updates.length} CaseProfile updates...`);
  const ops = updates.map((u) => ({
    updateOne: {
      filter: { _id: u.cp._id },
      update: {
        $set: {
          sourceCanonicalId: u.chosen._id,
          "attribution.matchedBy":
            u.reason === "upgraded-rc-legs"
              ? "abc-rc-legs-rescue"
              : "abc-callrail-rescue",
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

  await mongoose.disconnect();
  console.log(`\n[done]`);
}

main().catch((err) => {
  console.error("FATAL:", err.stack || err.message);
  process.exit(1);
});
