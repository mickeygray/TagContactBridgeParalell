"use strict";

/**
 * Focused dry-run: pull recent Inbound ContactActivity rows, check which
 * ones CallRail has no record for, then probe RC legs[] for those misses
 * to measure how often legs fill the gap CallRail can't.
 *
 * Reads only — no writes anywhere.
 */

require("dotenv").config();

const mongoose = require("mongoose");
const { getSharedConfig } = require("../packages/shared-config/src");
const { createRingCentralClient } = require("../packages/shared-integrations/src");
const {
  lookupInboundCall,
} = require("../packages/shared-services/src/callrailLookupService");
const {
  resolveSourceFromLegs,
} = require("../packages/shared-services/src/ringcentralAttributionService");

function normalizeDigits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits.slice(-10);
}

function looksInternal(phone) {
  const digits = normalizeDigits(phone);
  if (!digits) return true;
  // TAG internal caller IDs are in the +1818 range (818-2xx, 818-3xx ...).
  // Also treat short extensions as internal.
  return digits.length !== 10 || digits.startsWith("818");
}

async function main() {
  const targetMisses = Number(process.argv[2]) || 10;
  const config = getSharedConfig();

  await mongoose.connect(config.mongoUri, {
    dbName: config.parallelDbName,
    serverSelectionTimeoutMS: 5000,
  });

  const rc = createRingCentralClient();
  await rc.reinitializePlatform({ force: false, reason: "probe" });
  console.log("RC auth ok.\n");

  const legacy = mongoose.connection.useDb(
    process.env.LEGACY_APP_DB_NAME || "test",
    { useCache: true },
  );

  // Overfetch — we're filtering aggressively.
  const docs = await legacy
    .collection("rb_contactactivities")
    .find({
      direction: "Inbound",
      phone: { $exists: true, $ne: null },
      telephonySessionId: { $exists: true, $ne: null },
      callStartTime: { $exists: true },
    })
    .sort({ callStartTime: -1 })
    .limit(300)
    .toArray();

  // Dedupe by sessionId + external caller only.
  const seen = new Set();
  const external = [];
  for (const d of docs) {
    const key = d.telephonySessionId || `${d.phone}:${d.callStartTime}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (looksInternal(d.phone)) continue;
    external.push(d);
  }

  console.log(`Scanning ${external.length} recent external inbound sessions...`);
  const misses = [];
  for (const d of external) {
    try {
      const cr = await lookupInboundCall(d.company || "TAG", d.phone);
      if (!cr?.call) misses.push(d);
    } catch {
      misses.push(d);
    }
    if (misses.length >= targetMisses) break;
  }

  console.log(`Found ${misses.length} CallRail-misses. Probing legs[] for each...\n`);

  // Single RC account-call-log prefetch over the window spanned by misses.
  const times = misses
    .map((d) => new Date(d.callStartTime).getTime())
    .filter((t) => Number.isFinite(t));
  const windowStart = Math.min(...times) - 5 * 60 * 1000;
  const windowEnd = Math.max(...times) + 10 * 60 * 1000;

  const byId = new Map();
  const baseParams = {
    view: "Detailed",
    dateFrom: new Date(windowStart).toISOString(),
    dateTo: new Date(windowEnd).toISOString(),
    type: "Voice",
    perPage: 250,
  };
  let page = 1;
  while (page < 10) {
    try {
      const payload = await rc.getAccountCallLog({ ...baseParams, page });
      const records = payload.records || [];
      for (const r of records) {
        if (r.telephonySessionId) byId.set(String(r.telephonySessionId), r);
        for (const l of r.legs || []) {
          if (l.telephonySessionId && !byId.has(String(l.telephonySessionId))) {
            byId.set(String(l.telephonySessionId), r);
          }
        }
      }
      if (records.length < 250) break;
      page += 1;
      await new Promise((r) => setTimeout(r, 400));
    } catch (err) {
      console.log(`RC fetch page ${page} failed: ${err.message}`);
      break;
    }
  }
  console.log(`RC prefetch: ${byId.size} unique session ids indexed\n`);

  const stats = {
    examined: misses.length,
    legsHit: 0,
    legsMissingRecord: 0,
    legsNoCanonical: 0,
    canonicalsFound: new Map(),
  };

  for (const [i, d] of misses.entries()) {
    const rec = byId.get(String(d.telephonySessionId));
    console.log(`[${i + 1}/${misses.length}] sid=${d.telephonySessionId.slice(0, 20)}… phone=${d.phone} start=${d.callStartTime.toISOString?.()}`);

    if (!rec) {
      stats.legsMissingRecord += 1;
      console.log("  → RC record not in cache (outside prefetch window or not in RC)\n");
      continue;
    }
    const legsResult = await resolveSourceFromLegs(rec.legs || []);
    if (legsResult.matched) {
      stats.legsHit += 1;
      stats.canonicalsFound.set(
        legsResult.canonicalKey,
        (stats.canonicalsFound.get(legsResult.canonicalKey) || 0) + 1,
      );
      console.log(
        `  ✓ legs[${legsResult.legIndex}] → ${legsResult.canonicalKey} (${legsResult.internalName})`,
      );
    } else {
      stats.legsNoCanonical += 1;
      // Print queue-name hints from legs so we can see what WOULD have been
      // matchable if the canonical existed.
      const hints = (rec.legs || [])
        .map((l, idx) => {
          const name = l.extension?.name || l.to?.name || null;
          const id = l.extension?.id || null;
          if (!name && !id) return null;
          return `  leg[${idx}]: name="${name || "-"}" extId=${id || "-"}`;
        })
        .filter(Boolean)
        .join("\n");
      console.log("  ✗ no canonical match. leg hints:\n" + (hints || "    (no extensions on any leg)"));
    }
    console.log();
  }

  console.log("── Summary ──");
  console.log(`  examined:            ${stats.examined}`);
  console.log(`  legs[] matched:      ${stats.legsHit} / ${stats.examined}`);
  console.log(`  RC record missing:   ${stats.legsMissingRecord}`);
  console.log(`  Record found, no canonical match: ${stats.legsNoCanonical}`);
  if (stats.canonicalsFound.size > 0) {
    console.log("\n  canonicals hit:");
    for (const [key, count] of stats.canonicalsFound) {
      console.log(`    ${key}: ${count}`);
    }
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("dry-run failed:", err.message);
  process.exit(1);
});
