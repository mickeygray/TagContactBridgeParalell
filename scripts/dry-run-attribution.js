"use strict";

/**
 * Dry-run attribution harness.
 *
 * Pulls recent Inbound rows from legacy `rb_contactactivities`, runs the
 * proposed Parallel resolver priority chain against each one WITHOUT
 * writing anywhere, and compares the result against the legacy
 * `caseMatch` as ground truth.
 *
 * Usage:
 *   node scripts/dry-run-attribution.js                    # default: 50 recent inbound
 *   node scripts/dry-run-attribution.js --limit 100        # sample size
 *   node scripts/dry-run-attribution.js --domain WYNN      # filter by domain
 *   node scripts/dry-run-attribution.js --verbose          # per-row breakdown
 *
 * Does NOT require RC creds or Parallel DB writes. Reads:
 *   - legacy rb_contactactivities (sample source)
 *   - Parallel CaseProfile / MasterProspect / SourceCanonical
 *   - Logics API cross-tenant
 *   - CallRail API
 */

require("dotenv").config();

const mongoose = require("mongoose");
const {
  getCompanyKeys,
  getSharedConfig,
} = require("../packages/shared-config/src");
const {
  caseProfileRepository,
  masterProspectRepository,
  sourceCanonicalRepository,
} = require("../packages/shared-repositories/src");
const {
  createLogicsFacade,
} = require("../packages/shared-services/src/logicsFacadeService");
const {
  lookupInboundCall,
} = require("../packages/shared-services/src/callrailLookupService");
const {
  createRingCentralClient,
} = require("../packages/shared-integrations/src");
const {
  resolveSourceFromLegs,
} = require("../packages/shared-services/src/ringcentralAttributionService");

const SHORT_CIRCUIT_INTAKE_SOURCES = new Set([
  "ld",
  "ld-posting",
  "affiliate",
  "vf",
  "website",
  "facebook",
  "instagram",
  "tiktok",
  "organic-landing",
]);

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { limit: 50, domain: null, verbose: false };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--limit") out.limit = Number(args[i + 1]);
    else if (args[i] === "--domain") out.domain = String(args[i + 1]).toUpperCase();
    else if (args[i] === "--verbose") out.verbose = true;
  }
  return out;
}

function normalizeDigits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.length === 11 && digits.startsWith("1")
    ? digits.slice(1)
    : digits.slice(-10);
}

function getLegacyDb() {
  const name = process.env.LEGACY_APP_DB_NAME || "test";
  return mongoose.connection.useDb(name, { useCache: true });
}

async function findProspectCrossTenant(phone, domains) {
  for (const dom of domains) {
    const p = await masterProspectRepository.findMasterProspectByNormalizedPhone(dom, phone);
    if (p) return { prospect: p, domain: dom };
  }
  return null;
}

async function findCaseProfileCrossTenant(phone, domains) {
  for (const dom of domains) {
    const cp = await caseProfileRepository.findCaseProfileByPhone?.(dom, phone);
    if (cp) return { caseProfile: cp, domain: dom };
  }
  return null;
}

async function logicsCrossTenant(phone, domains) {
  for (const dom of domains) {
    try {
      const facade = createLogicsFacade(dom);
      const res = await facade.findCaseByPhone(phone);
      if (res.ok && res.matches?.length > 0) {
        return {
          domain: dom,
          caseId: Number(res.matches[0].caseId),
          name: res.matches[0].name,
          sourceName: res.matches[0].sourceName,
        };
      }
    } catch (err) {
      // swallow — log if verbose
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

async function callrailLookup(domain, phone) {
  try {
    const res = await lookupInboundCall(domain, phone);
    if (res?.call) {
      return {
        callId: res.call.callId,
        source: res.call.sourceName || res.call.source,
        tracker: res.call.trackingNumber,
        trackingPhone: res.call.formattedTrackingNumber,
        start: res.call.startTime,
      };
    }
    return null;
  } catch (err) {
    // Surface it — silent swallowing was the exact bug this script is
    // meant to catch.
    return { _error: err.message };
  }
}

/**
 * Prefetch the account call-log once (with pagination) over a wide window
 * and index by telephonySessionId. Sample-wide call-log lookup avoids
 * firing one-request-per-row and getting rate-limited (HTTP 429) by RC.
 */
async function prefetchCallLog(rc, windowStartMs, windowEndMs) {
  const byId = new Map();
  if (!rc) return byId;
  const dateFrom = new Date(windowStartMs).toISOString();
  const dateTo = new Date(windowEndMs).toISOString();
  const baseParams = {
    view: "Detailed",
    dateFrom,
    dateTo,
    type: "Voice",
    perPage: 250,
  };

  let page = 1;
  let fetched = 0;
  while (page < 20) {
    const payload = await rc.getAccountCallLog({ ...baseParams, page });
    const records = payload.records || [];
    fetched += records.length;
    for (const r of records) {
      if (r.telephonySessionId) byId.set(String(r.telephonySessionId), r);
      if (Array.isArray(r.legs)) {
        for (const leg of r.legs) {
          if (leg.telephonySessionId) {
            // Leg's session id can reference back to parent record — point
            // it at the parent so any match on a leg id returns the full
            // call. Only set if we haven't seen a direct top-level match.
            const key = String(leg.telephonySessionId);
            if (!byId.has(key)) byId.set(key, r);
          }
        }
      }
    }
    if (records.length < 250) break;
    page += 1;
    // Gentle pacing between pages to avoid 429.
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  console.log(`RC prefetch: ${fetched} records across ${page} page(s), ${byId.size} unique session ids indexed`);
  return byId;
}

function lookupLegsFromCache(cache, telephonySessionId) {
  if (!cache || !telephonySessionId) return null;
  const rec = cache.get(String(telephonySessionId));
  return rec ? { record: rec, legs: rec.legs || [] } : null;
}

async function resolvePhone(phone, sampleDomain, domains, rcCtx = null) {
  const tenDigit = normalizeDigits(phone);
  if (!tenDigit) {
    return { matched: false, strategy: "invalid-phone", steps: {} };
  }

  const steps = {};

  // Step 1: CaseProfile
  const cp = await findCaseProfileCrossTenant(tenDigit, domains);
  steps.caseProfile = cp
    ? {
        hit: true,
        domain: cp.domain,
        caseId: cp.caseProfile.caseId,
        sourceCanonicalId: cp.caseProfile.sourceCanonicalId
          ? String(cp.caseProfile.sourceCanonicalId)
          : null,
        locked: Boolean(cp.caseProfile.attribution?.lockedManual),
      }
    : { hit: false };
  if (cp && (cp.caseProfile.sourceCanonicalId || cp.caseProfile.attribution?.lockedManual)) {
    return {
      matched: true,
      strategy: "caseprofile",
      caseId: cp.caseProfile.caseId,
      caseDomain: cp.domain,
      sourceCanonicalId: cp.caseProfile.sourceCanonicalId
        ? String(cp.caseProfile.sourceCanonicalId)
        : null,
      confidence: "high",
      steps,
    };
  }

  // Step 2: MasterProspect with form-based intake
  const mp = await findProspectCrossTenant(tenDigit, domains);
  const intakeSource = mp?.prospect?.metadata?.intakeSource || null;
  steps.prospect = mp
    ? {
        hit: true,
        domain: mp.domain,
        caseId: mp.prospect.caseId,
        intakeSource,
        shortCircuit: intakeSource && SHORT_CIRCUIT_INTAKE_SOURCES.has(intakeSource),
      }
    : { hit: false };
  if (mp && intakeSource && SHORT_CIRCUIT_INTAKE_SOURCES.has(intakeSource)) {
    return {
      matched: true,
      strategy: "prospect-intake",
      caseId: mp.prospect.caseId,
      caseDomain: mp.domain,
      intakeSource,
      confidence: "high",
      steps,
    };
  }

  // Step 3: Prior CallLog — skipped, collection is empty
  steps.priorCallLog = { hit: false, reason: "collection empty (not yet populated)" };

  // Step 4: Logics cross-tenant (the big one)
  const lg = await logicsCrossTenant(tenDigit, domains);
  steps.logics = lg
    ? {
        hit: true,
        domain: lg.domain,
        caseId: lg.caseId,
        name: lg.name,
        sourceName: lg.sourceName,
      }
    : { hit: false };

  // Step 5: CallRail (we try using the sample's domain for the API creds)
  const cr = await callrailLookup(sampleDomain, tenDigit);
  if (cr?._error) {
    steps.callrail = { hit: false, error: cr._error };
  } else if (cr) {
    steps.callrail = { hit: true, ...cr };
  } else {
    steps.callrail = { hit: false };
  }

  // Step 6: RC legs[] — walk the pre-fetched call-log cache for this
  // session's legs, looking for a queue extension that maps to a
  // SourceCanonical.
  if (rcCtx && rcCtx.cache) {
    try {
      const legsResult = lookupLegsFromCache(
        rcCtx.cache,
        rcCtx.telephonySessionId,
      );
      if (legsResult?.legs) {
        const match = await resolveSourceFromLegs(legsResult.legs);
        steps.legs = match.matched
          ? {
              hit: true,
              legIndex: match.legIndex,
              extensionId: match.extensionId,
              canonicalKey: match.canonicalKey,
              internalName: match.internalName,
            }
          : {
              hit: false,
              reason: "record found, no canonical match",
              legCount: legsResult.legs.length,
            };
      } else {
        steps.legs = { hit: false, reason: "record not found in RC call-log" };
      }
    } catch (err) {
      steps.legs = { hit: false, error: err.message };
    }
  } else {
    steps.legs = { hit: false, reason: "skipped (no RC ctx)" };
  }

  // Step 7: DID — not applicable without an RC record target. Skip.
  steps.did = { hit: false, reason: "skipped (no RC record)" };

  // Synthesize best answer. If Logics gave us caseId + CallRail gave source,
  // that's a full resolution. Either alone is partial.
  if (lg && cr) {
    return {
      matched: true,
      strategy: "callrail+logics",
      caseId: lg.caseId,
      caseDomain: lg.domain,
      callrailSource: cr.source,
      callrailTracker: cr.tracker,
      confidence: "high",
      steps,
    };
  }
  if (lg) {
    return {
      matched: true,
      strategy: "logics-only",
      caseId: lg.caseId,
      caseDomain: lg.domain,
      confidence: "medium",
      steps,
    };
  }
  if (cr) {
    return {
      matched: false,
      strategy: "callrail-only",
      callrailSource: cr.source,
      callrailTracker: cr.tracker,
      confidence: "low",
      steps,
    };
  }

  return { matched: false, strategy: "none", steps };
}

async function main() {
  const args = parseArgs();
  const config = getSharedConfig();
  const domains = getCompanyKeys();

  console.log(
    `Dry-run: limit=${args.limit}, domain=${args.domain || "any"}, tenants=${domains.join(",")}`,
  );

  await mongoose.connect(config.mongoUri, {
    dbName: config.parallelDbName,
    serverSelectionTimeoutMS: 5000,
  });

  // Warm up RC — one auth, reused for every session lookup.
  let rcClient = null;
  try {
    rcClient = createRingCentralClient();
    await rcClient.reinitializePlatform({ force: false, reason: "dry-run" });
    console.log("RC: authenticated");
  } catch (err) {
    console.log("RC: not available — legs[] step will be skipped. " + err.message);
    rcClient = null;
  }

  const legacy = getLegacyDb();
  const query = {
    direction: "Inbound",
    "caseMatch.caseId": { $exists: true, $ne: null },
  };
  if (args.domain) {
    query.$or = [
      { company: args.domain },
      { "caseMatch.domain": args.domain },
    ];
  }

  const sample = await legacy
    .collection("rb_contactactivities")
    .find(query)
    .sort({ callStartTime: -1, createdAt: -1 })
    .limit(args.limit * 3) // overfetch for dedup
    .toArray();

  // Dedupe by telephonySessionId (old app writes multiple rows per call)
  const seenSid = new Set();
  const unique = [];
  for (const doc of sample) {
    const key = doc.telephonySessionId || `${doc.phone}:${doc.callStartTime}`;
    if (seenSid.has(key)) continue;
    seenSid.add(key);
    unique.push(doc);
    if (unique.length >= args.limit) break;
  }

  console.log(`Sampled ${unique.length} unique inbound calls with caseId in legacy.\n`);

  // Prefetch RC call-log over the window the sample spans. One-time request
  // (paginated), then in-memory lookup per row — stays under RC's rate limit.
  let rcCache = null;
  if (rcClient && unique.length > 0) {
    const times = unique
      .map((d) => new Date(d.callStartTime || d.createdAt || 0).getTime())
      .filter((t) => Number.isFinite(t) && t > 0);
    if (times.length > 0) {
      const start = Math.min(...times) - 5 * 60 * 1000;
      const end = Math.max(...times) + 10 * 60 * 1000;
      try {
        rcCache = await prefetchCallLog(rcClient, start, end);
      } catch (err) {
        console.log("RC prefetch failed:", err.message);
      }
    }
  }


  const stats = {
    sampled: unique.length,
    step1_caseProfile: 0,
    step2_prospectIntake: 0,
    step3_priorCallLog: 0,
    step4_logics: 0,
    step5_callrail: 0,
    step6_legs: 0,
    resolved_full: 0,
    resolved_caseId_only: 0,
    unresolved: 0,
    caseIdAgreement: 0,
    caseIdMismatch: 0,
    crossTenantHits: 0,
  };
  const mismatches = [];
  const t0 = Date.now();

  for (const [i, doc] of unique.entries()) {
    const sampleDomain = doc.company || doc.caseMatch?.domain || domains[0];
    const rcCtx = rcCache && doc.telephonySessionId
      ? {
          cache: rcCache,
          telephonySessionId: doc.telephonySessionId,
        }
      : null;
    const result = await resolvePhone(doc.phone, sampleDomain, domains, rcCtx);

    if (result.steps.caseProfile?.hit) stats.step1_caseProfile += 1;
    if (result.steps.prospect?.hit && result.steps.prospect.shortCircuit)
      stats.step2_prospectIntake += 1;
    if (result.steps.logics?.hit) stats.step4_logics += 1;
    if (result.steps.callrail?.hit) stats.step5_callrail += 1;
    if (result.steps.legs?.hit) stats.step6_legs += 1;

    if (result.matched && result.caseId) stats.resolved_full += 1;
    else if (result.caseId) stats.resolved_caseId_only += 1;
    else stats.unresolved += 1;

    const truthCaseId = doc.caseMatch?.caseId;
    const truthDomain = doc.caseMatch?.domain;
    if (truthCaseId && result.caseId) {
      if (Number(result.caseId) === Number(truthCaseId)) {
        stats.caseIdAgreement += 1;
        if (truthDomain && result.caseDomain && truthDomain !== sampleDomain) {
          stats.crossTenantHits += 1;
        }
      } else {
        stats.caseIdMismatch += 1;
        mismatches.push({
          phone: doc.phone,
          sampleDomain,
          legacyCaseId: truthCaseId,
          legacyDomain: truthDomain,
          resolvedCaseId: result.caseId,
          resolvedDomain: result.caseDomain,
          strategy: result.strategy,
        });
      }
    }

    if (args.verbose) {
      console.log(
        `[${i + 1}/${unique.length}] ${doc.phone} (legacy: case=${truthCaseId}, domain=${truthDomain})`,
      );
      console.log(
        `  resolver: ${result.strategy} case=${result.caseId || "-"} domain=${result.caseDomain || "-"}`,
      );
      console.log(`  steps:`, JSON.stringify(result.steps));
      console.log("");
    } else if ((i + 1) % 10 === 0) {
      process.stdout.write(`  ${i + 1}/${unique.length} processed\r`);
    }
  }

  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`\n── Dry-run complete in ${elapsed}s ──\n`);
  console.log("Per-step hit counts (not exclusive):");
  console.log(`  Step 1  CaseProfile:     ${stats.step1_caseProfile} / ${stats.sampled}`);
  console.log(
    `  Step 2  Prospect intake: ${stats.step2_prospectIntake} / ${stats.sampled} (form-based short-circuit)`,
  );
  console.log(`  Step 3  Prior CallLog:   ${stats.step3_priorCallLog} / ${stats.sampled} (empty, as expected)`);
  console.log(`  Step 4  Logics:          ${stats.step4_logics} / ${stats.sampled}`);
  console.log(`  Step 5  CallRail:        ${stats.step5_callrail} / ${stats.sampled}`);
  console.log(`  Step 6  RC legs[]:       ${stats.step6_legs} / ${stats.sampled}`);
  console.log();
  console.log("Final classification:");
  console.log(`  Fully resolved (caseId + source):  ${stats.resolved_full} / ${stats.sampled}`);
  console.log(`  CaseId only (no source found):     ${stats.resolved_caseId_only} / ${stats.sampled}`);
  console.log(`  Unresolved:                        ${stats.unresolved} / ${stats.sampled}`);
  console.log();
  console.log("Agreement with legacy caseMatch.caseId:");
  console.log(`  Agreements:   ${stats.caseIdAgreement} / ${stats.sampled}`);
  console.log(`  Mismatches:   ${stats.caseIdMismatch}`);
  console.log(`  Cross-tenant hits: ${stats.crossTenantHits}`);

  if (mismatches.length > 0) {
    console.log("\nFirst 10 mismatches:");
    for (const m of mismatches.slice(0, 10)) {
      console.log(
        `  phone=${m.phone} sampleDomain=${m.sampleDomain} legacy=${m.legacyCaseId}(${m.legacyDomain}) resolved=${m.resolvedCaseId}(${m.resolvedDomain}) via=${m.strategy}`,
      );
    }
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("dry-run failed:", err);
  process.exit(1);
});
