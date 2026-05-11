"use strict";

// Unified reconcile script. Walks three known gap-paths between Logics
// and the parallel app, fixing each:
//
// PHASE 1 — Logics paid-case discovery
//   For every case currently in a "sold" status in Logics (Tier 1-5,
//   New Client, etc.), check whether parallel has a CaseProfile. If
//   not, create one — sourced via Logics SourceCampaignID. This catches
//   cases that closed in Logics directly (NCOA agent entry, hand-keyed,
//   or any other path that didn't generate a phone-call signal in our
//   parallel CallLog).
//
// PHASE 2 — Legacy-imported CallLog backfill
//   Migrated CallLogs (resolverActor=import) sometimes landed with
//   caseId=null because the legacy resolver couldn't bind. Run Logics
//   findCaseByPhone for each unique unresolved phone, bind caseId on
//   the CallLog rows. The hourly bridge sweep then promotes them into
//   CaseProfile.
//
// PHASE 3 — Force payment reconcile
//   For every case touched (or that we suspect has new payments), call
//   paymentReconcileService.reconcilePaymentsForCase. The hourly
//   reconciler is staleAfterMs-gated; this bypasses that for fresh
//   sales.
//
// Idempotent: re-running on the same data is a no-op merge except for
// new findings since the last pass.
//
// Usage:
//   node scripts/reconcile-parallel-from-logics.js                    # DRY (default)
//   node scripts/reconcile-parallel-from-logics.js --commit
//   node scripts/reconcile-parallel-from-logics.js --commit --domain TAG
//   node scripts/reconcile-parallel-from-logics.js --commit --phase 1     # phase 1 only
//   node scripts/reconcile-parallel-from-logics.js --commit --phase 1,3   # 1 + 3
//   node scripts/reconcile-parallel-from-logics.js --commit --statuses 206,207,210
//   node scripts/reconcile-parallel-from-logics.js --commit --days 30     # phase-1 lookback

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const {
  CallLog,
  CaseProfile,
  SourceCanonical,
} = require("../packages/shared-models/src");
const {
  caseProfileRepository,
  masterProspectRepository,
} = require("../packages/shared-repositories/src");
const { createLogicsClient } = require("../packages/shared-integrations/src");
const {
  resolveCanonicalSource,
} = require("../packages/shared-services/src/sourceCanonicalService");
const {
  reconcilePaymentsForCase,
} = require("../packages/shared-services/src/paymentReconcileService");

// Sold-tier status IDs per domain. These are the statuses where revenue
// has changed hands and the case must exist in parallel for hourly
// payment reconcile to find it.
const SOLD_STATUS_IDS = {
  TAG: [206, 207, 208, 209, 210, 211, 212],
  // WYNN sold-equivalent statuses: client + redline. Includes
  // chargeback/redline because we still want their CaseProfile present
  // so payment reversals get tracked.
  WYNN: [
    10, 11, 12, 13, 18, 60, 181, 182, 183, 184, 188, 190, 191, 192, 193,
    194, 197, 198, 200, 201, 202, 215, 222, 223,
  ],
};

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

function normalizeDigits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  return digits.length === 11 && digits.startsWith("1")
    ? digits.slice(1)
    : digits.slice(-10);
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

function unwrapList(payload) {
  const data = payload?.data || payload?.Data || payload;
  if (!Array.isArray(data)) return [];
  return data
    .map((value) => {
      if (Number.isFinite(Number(value))) return Number(value);
      if (value && typeof value === "object") {
        return Number(value.CaseID ?? value.caseId ?? value.ID ?? value.id);
      }
      return Number.NaN;
    })
    .filter((v) => Number.isFinite(v));
}

// ─── PHASE 1 ─────────────────────────────────────────────────────────
async function phaseDiscoverPaidCases({
  domains,
  statusIds,
  daysWindow,
  caseIdsByDomain,
  commit,
  concurrency,
  logger,
}) {
  console.log("\n══ PHASE 1: Logics paid-case discovery ══");
  const summary = {
    domains: {},
    totalLogicsCases: 0,
    alreadyInParallel: 0,
    newCaseProfiles: 0,
    noLogicsSource: 0,
    canonicalNotFound: 0,
    errors: 0,
  };
  const cutoff = daysWindow > 0 ? Date.now() - daysWindow * 24 * 3600 * 1000 : 0;

  for (const domain of domains) {
    const domStats = {
      logicsCases: 0,
      alreadyInParallel: 0,
      newCaseProfiles: 0,
      bySource: {},
    };
    summary.domains[domain] = domStats;
    const client = createLogicsClient(domain);
    const seenCaseIds = new Set();

    // Surgical mode: caller passed explicit --caseIds for this domain
    // (or via --caseIds without --domain). Skip the by-status sweep
    // and just operate on those specific cases.
    if (caseIdsByDomain && caseIdsByDomain[domain]) {
      for (const id of caseIdsByDomain[domain]) seenCaseIds.add(Number(id));
      console.log(
        `  [${domain}] surgical: ${seenCaseIds.size} explicit caseIds`,
      );
    } else {
      const statusList = statusIds[domain] || [];
      for (const statusId of statusList) {
        const ids = unwrapList(
          await client.getCasesByStatus(statusId).catch((e) => {
            summary.errors += 1;
            logger?.warn?.("phase1.getcasesbystatus.failed", {
              domain,
              statusId,
              error: e.message,
            });
            return null;
          }),
        );
        for (const id of ids) seenCaseIds.add(id);
      }
      console.log(
        `  [${domain}] ${seenCaseIds.size} cases across ${statusList.length} sold statuses`,
      );
    }
    domStats.logicsCases = seenCaseIds.size;
    summary.totalLogicsCases += seenCaseIds.size;

    // Bulk-check parallel CaseProfile presence (one query per 1000 ids
    // beats one query per case).
    const ids = [...seenCaseIds];
    const existingSet = new Set();
    const chunkSize = 1000;
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      const found = await CaseProfile.find({
        domain,
        caseId: { $in: chunk },
      })
        .select({ caseId: 1 })
        .lean();
      for (const cp of found) existingSet.add(cp.caseId);
    }
    domStats.alreadyInParallel = existingSet.size;
    summary.alreadyInParallel += existingSet.size;
    const missing = ids.filter((id) => !existingSet.has(id));
    console.log(
      `  [${domain}] missing in parallel: ${missing.length} (already present: ${existingSet.size})`,
    );

    if (missing.length === 0) continue;

    // For each missing, fetch CaseInfo + resolve canonical + create CP.
    let ticker = 0;
    const created = [];
    await runConcurrent(
      missing,
      concurrency,
      async (caseId) => {
        try {
          const r = await client.getCaseInfo(caseId);
          const data = r?.data || r?.Data || r;
          if (!data || typeof data !== "object") return;
          // Honor the day-window if specified — only create CPs for
          // cases recently sold (SaleDate or CreatedDate within window).
          if (cutoff) {
            const stamp = new Date(
              data.SaleDate || data.CreatedDate || 0,
            ).getTime();
            if (Number.isFinite(stamp) && stamp < cutoff) return;
          }
          const logicsSourceId =
            data.SourceCampaignID ||
            data.CampaignSourceID ||
            data.CampaignID ||
            data.SourceID ||
            data.SourceId ||
            null;
          let canonical = null;
          if (logicsSourceId) {
            canonical = await resolveCanonicalSource({
              domain,
              sourceId: Number(logicsSourceId),
            }).catch(() => null);
          }
          if (!logicsSourceId) summary.noLogicsSource += 1;
          if (logicsSourceId && !canonical) summary.canonicalNotFound += 1;

          const phones = [data.CellPhone, data.HomePhone, data.WorkPhone]
            .map(normalizeDigits)
            .filter(Boolean);
          if (commit) {
            await caseProfileRepository.upsertCaseProfile(domain, caseId, {
              firstName: data.FirstName || null,
              lastName: data.LastName || null,
              name:
                [data.FirstName, data.LastName].filter(Boolean).join(" ").trim() ||
                null,
              email: data.Email || null,
              primaryPhone: data.CellPhone || data.HomePhone || data.WorkPhone || null,
              normalizedPhones: phones,
              statusId: data.StatusID != null ? Number(data.StatusID) : null,
              statusCategory: "client",
              sourceCanonicalId: canonical?.doc?._id || null,
              caseCreatedDate: data.CreatedDate ? new Date(data.CreatedDate) : null,
              attribution: {
                matchedBy: "logics-discovery-rescue",
                confidence: canonical ? "high" : "none",
                lockedManual: false,
                needsReview: !canonical,
                lastResolvedAt: new Date(),
              },
            });
          }
          created.push({
            caseId,
            sourceCanonicalId: canonical?.doc?._id || null,
            internalName: canonical?.internalName || "(none)",
          });
          const k = canonical?.internalName || "(no source)";
          domStats.bySource[k] = (domStats.bySource[k] || 0) + 1;
        } catch (err) {
          summary.errors += 1;
          logger?.warn?.("phase1.case-info.failed", {
            domain,
            caseId,
            error: err.message,
          });
        }
      },
      (completed, total) => {
        ticker += 1;
        if (ticker % 25 === 0 || completed === total) {
          process.stdout.write(`\r  [${domain}] processing ${completed}/${total}`);
        }
      },
    );
    process.stdout.write("\n");
    domStats.newCaseProfiles = created.length;
    summary.newCaseProfiles += created.length;
    console.log(
      `  [${domain}] ${commit ? "created" : "would create"} ${created.length} CaseProfiles`,
    );
    if (Object.keys(domStats.bySource).length > 0) {
      console.log(`  [${domain}] by source:`);
      for (const [name, count] of Object.entries(domStats.bySource).sort(
        (a, b) => b[1] - a[1],
      )) {
        console.log(`    ${String(name).padEnd(35)} ${String(count).padStart(5)}`);
      }
    }
  }
  return summary;
}

// ─── PHASE 2 ─────────────────────────────────────────────────────────
async function phaseLegacyCallLogBackfill({ domains, commit, concurrency, logger }) {
  console.log("\n══ PHASE 2: Legacy CallLog caseId backfill ══");
  const summary = {
    scanned: 0,
    boundCaseId: 0,
    callogsUpdated: 0,
    noLogicsMatch: 0,
    errors: 0,
  };

  // Distinct (domain, normalizedPhone) pairs where caseId is null
  // and the row was migrated from legacy.
  const phoneMap = new Map(); // "domain|phone" → [row ids]
  for (const domain of domains) {
    const rows = await CallLog.find({
      domain,
      caseId: { $in: [null, undefined] },
      resolverActor: "import",
      normalizedPhone: { $exists: true, $ne: null },
    })
      .select({ _id: 1, normalizedPhone: 1 })
      .lean();
    for (const r of rows) {
      const key = `${domain}|${r.normalizedPhone}`;
      if (!phoneMap.has(key)) phoneMap.set(key, []);
      phoneMap.get(key).push(r._id);
    }
  }
  summary.scanned = [...phoneMap.values()].reduce((s, v) => s + v.length, 0);
  const phones = [...phoneMap.keys()];
  console.log(
    `  ${summary.scanned} legacy CallLog rows missing caseId across ${phones.length} unique (domain,phone) pairs`,
  );
  if (phones.length === 0) return summary;

  const clientCache = new Map();
  function getClient(d) {
    if (!clientCache.has(d)) clientCache.set(d, createLogicsClient(d));
    return clientCache.get(d);
  }

  let ticker = 0;
  const updates = [];
  await runConcurrent(
    phones,
    concurrency,
    async (key) => {
      const [domain, phone] = key.split("|");
      try {
        const r = await getClient(domain).findCaseByPhone(phone);
        const data = r?.data || r?.Data || r;
        const arr = Array.isArray(data) ? data : data ? [data] : [];
        const first = arr[0];
        const caseId = first
          ? Number(first.CaseID || first.caseId || first.ID)
          : null;
        if (!caseId || !Number.isFinite(caseId)) {
          summary.noLogicsMatch += 1;
          return;
        }
        summary.boundCaseId += 1;
        for (const id of phoneMap.get(key)) {
          updates.push({ id, caseId, domain });
        }
      } catch (err) {
        summary.errors += 1;
        logger?.warn?.("phase2.find-case-by-phone.failed", {
          domain,
          phone,
          error: err.message,
        });
      }
    },
    (completed, total) => {
      ticker += 1;
      if (ticker % 25 === 0 || completed === total) {
        process.stdout.write(`\r  finding case by phone: ${completed}/${total}`);
      }
    },
  );
  process.stdout.write("\n");

  if (commit && updates.length > 0) {
    const ops = updates.map((u) => ({
      updateOne: {
        filter: { _id: u.id },
        update: {
          $set: {
            caseId: u.caseId,
            caseDomain: u.domain,
            "attempts.legacyEnrichmentStatus": "matched-via-reconcile",
          },
        },
      },
    }));
    const chunkSize = 500;
    let modified = 0;
    for (let i = 0; i < ops.length; i += chunkSize) {
      const r = await CallLog.bulkWrite(ops.slice(i, i + chunkSize), {
        ordered: false,
      });
      modified += r.modifiedCount || 0;
    }
    summary.callogsUpdated = modified;
  } else {
    summary.callogsUpdated = updates.length; // would-update count
  }
  console.log(
    `  ${commit ? "bound caseId on" : "would bind caseId on"} ${updates.length} CallLog rows (${summary.boundCaseId} unique cases via Logics phone match)`,
  );
  console.log(`  no-logics-match: ${summary.noLogicsMatch}, errors: ${summary.errors}`);
  return summary;
}

// ─── PHASE 3 ─────────────────────────────────────────────────────────
async function phaseForcePaymentReconcile({ domains, commit, concurrency, logger }) {
  console.log("\n══ PHASE 3: Force payment reconcile (recently-touched CPs) ══");
  const summary = {
    scanned: 0,
    paymentsWritten: 0,
    casesWithPayments: 0,
    errors: 0,
  };

  // Targeting: CaseProfiles touched by us (rescue tags) OR with
  // recent statuses but no firstPaymentDate. We don't iterate every
  // CP — that's the hourly sweeper's job. We pick the ones likely
  // to have unsynced payments based on what we just did.
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  for (const domain of domains) {
    const candidates = await CaseProfile.find({
      domain,
      $or: [
        { "attribution.matchedBy": "logics-discovery-rescue" },
        { "attribution.matchedBy": "logics-source-rescue" },
        { "attribution.matchedBy": "abc-callrail-rescue" },
        { "attribution.matchedBy": "abc-rc-legs-rescue" },
        // Also: anything updated in the last 7 days with no first-pmt
        // (likely missing a payment sync).
        {
          $and: [
            { updatedAt: { $gte: since } },
            { firstPaymentDate: { $in: [null, undefined] } },
          ],
        },
      ],
    })
      .select({ caseId: 1 })
      .lean();
    summary.scanned += candidates.length;
    console.log(`  [${domain}] ${candidates.length} CaseProfiles to force-reconcile`);
    if (!commit || candidates.length === 0) continue;

    let ticker = 0;
    await runConcurrent(
      candidates,
      concurrency,
      async (cp) => {
        try {
          const r = await reconcilePaymentsForCase({
            domain,
            caseId: Number(cp.caseId),
            lane: "manual-reconcile",
            logger,
          });
          if (r?.casesWithPayments) summary.casesWithPayments += 1;
          summary.paymentsWritten += Number(r?.newLedgerRows || 0);
        } catch (err) {
          summary.errors += 1;
          logger?.warn?.("phase3.reconcile-payments.failed", {
            domain,
            caseId: cp.caseId,
            error: err.message,
          });
        }
      },
      (completed, total) => {
        ticker += 1;
        if (ticker % 25 === 0 || completed === total) {
          process.stdout.write(`\r  [${domain}] reconciling: ${completed}/${total}`);
        }
      },
    );
    process.stdout.write("\n");
  }
  console.log(
    `  payments written: ${summary.paymentsWritten} across ${summary.casesWithPayments} cases (${summary.errors} errors)`,
  );
  return summary;
}

async function main() {
  const argv = process.argv.slice(2);
  const commit = hasFlag(argv, "--commit");
  const domainFilter = readFlag(argv, "--domain");
  const phaseRaw = readFlag(argv, "--phase") || "1,2,3";
  const phases = new Set(
    phaseRaw.split(",").map((s) => Number(String(s).trim())).filter((n) => [1, 2, 3].includes(n)),
  );
  const days = Number(readFlag(argv, "--days")) || 0; // 0 = no window
  const concurrency = Number(readFlag(argv, "--concurrency")) || 5;
  const statusOverride = readFlag(argv, "--statuses");
  // Surgical mode: --caseIds 331548,342866 [--domain TAG] reconciles
  // only the named cases, skipping the broad by-status sweep. Useful
  // for "I noticed something off in metrics, just fix this caseId."
  const caseIdsRaw = readFlag(argv, "--caseIds");

  const domains = domainFilter
    ? [String(domainFilter).toUpperCase()]
    : ["TAG", "WYNN"];

  let caseIdsByDomain = null;
  if (caseIdsRaw) {
    caseIdsByDomain = {};
    const ids = caseIdsRaw
      .split(",")
      .map((s) => Number(String(s).trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    // If a single domain is specified (or implied), apply all caseIds
    // to that domain. Otherwise the caller must explicitly scope with
    // --domain to avoid querying both Logics tenants for IDs that only
    // exist in one.
    if (domains.length !== 1) {
      console.error(
        "--caseIds requires --domain so we know which Logics tenant to query.",
      );
      process.exit(1);
    }
    caseIdsByDomain[domains[0]] = ids;
  }
  let statusIds = SOLD_STATUS_IDS;
  if (statusOverride) {
    const ids = statusOverride
      .split(",")
      .map((s) => Number(String(s).trim()))
      .filter((n) => Number.isFinite(n));
    statusIds = Object.fromEntries(domains.map((d) => [d, ids]));
  }

  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(process.env.MONGO_URI, { dbName });

  console.log("══ Reconcile parallel ← Logics ══");
  console.log(`  mode:        ${commit ? "COMMIT" : "DRY"}`);
  console.log(`  domains:     ${domains.join(", ")}`);
  console.log(`  phases:      ${[...phases].sort().join(", ")}`);
  console.log(`  concurrency: ${concurrency}`);
  if (days > 0) console.log(`  window:      last ${days} days`);
  if (statusOverride) console.log(`  statuses:    ${statusOverride}`);

  const logger = {
    info: () => {},
    warn: (msg, meta) => console.warn(`[warn] ${msg}`, JSON.stringify(meta || {})),
  };

  const out = {};
  if (phases.has(1)) {
    out.phase1 = await phaseDiscoverPaidCases({
      domains,
      statusIds,
      daysWindow: days,
      caseIdsByDomain,
      commit,
      concurrency,
      logger,
    });
  }
  if (phases.has(2)) {
    out.phase2 = await phaseLegacyCallLogBackfill({
      domains,
      commit,
      concurrency,
      logger,
    });
  }
  if (phases.has(3)) {
    out.phase3 = await phaseForcePaymentReconcile({
      domains,
      commit,
      concurrency,
      logger,
    });
  }

  console.log("\n══ Reconcile summary ══");
  console.log(JSON.stringify(out, null, 2));

  await mongoose.disconnect();
  console.log("\n[done]");
}

main().catch((err) => {
  console.error("FATAL:", err.stack || err.message);
  process.exit(1);
});
