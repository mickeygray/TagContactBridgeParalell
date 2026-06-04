"use strict";

// Monthly filler-pool refresh.
//
// Replaces the prior month's filler pool in MasterProspectIndex with a
// fresh DNC-scrubbed sample of currently-status=2 prospects from
// Logics, then GCs MPI rows whose case is no longer status=2.
//
// Per-domain selection:
//   WYNN  → status=2 (opened) AND sourceId ∈ digital-canonical set
//           (sourceName matches /VF|LD|Affiliate|Digital/i). Sorted
//           CaseID-desc; early-stop on Jan-2026 floor (digital
//           launch).
//   TAG   → status=2 (opened) AND caseId >= 50000 (post-mail-era
//           floor) AND has any phone. Sorted ModifiedDate-desc —
//           that ordering surfaces phone-having cases at ~92% vs
//           <1% for CaseID-desc (mail intake creates address-only
//           cases that get phones added later via CSR activity,
//           which bumps ModifiedDate).
//
// Pipeline per refresh:
//   1. getCasesByStatus(2) per domain → case-id list
//   2. getCaseInfo(caseId) per case in concurrent batches → sourceName,
//      phone, createDate, name fields
//   3. Filter on tenant criteria (above)
//   4. De-dupe by (domain, caseId)
//   5. lookupDnc(phone) per survivor in concurrent batches, with
//      30-day cache reuse (keeps us inside SafeHarbor's 31-day window)
//      and 429 retry-with-backoff
//   6. Drop DNC + litigator; landlines OK (no federal compliance
//      issue calling residential landlines off the DNC registry)
//   7. Atomic-ish swap: clear pool.tag from prior-month rows (keep
//      their dnc cache), upsert new survivors with current month's
//      pool.tag, GC any MPI row whose caseId is no longer in the
//      domain's status=2 set
//
// Vault-only DNC-listed leads naturally drop out here even if they
// entered cadence under the 30-day grace window — by the time the
// next monthly rebuild runs, they're either past day 30 (sweep
// already cx-blocked them) or about to be excluded from the next
// pool because the DNC scrub catches them.
//
// Caller is responsible for the mongoose connection. Service uses
// the global mongoose connection; does NOT call connect/disconnect.

const mongoose = require("mongoose");

const {
  createLogicsClient,
  createRealPhoneValidationClient,
} = require("../../shared-integrations/src");
const {
  CallLog,
  CxDialQueue,
  LeadCadence,
  MasterProspectIndex,
} = require("../../shared-models/src");
const { recordWorkflowStage } = require("./workflowStateService");

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Aged-pool rolling-refresh tunables. Env knobs are read at call time so
// tests / dry-runs can override without restart.
const AGED_DAILY_CHECKPOINT_DAYS = [30, 60, 90];
const AGED_CADENCE_RETIRE_DAYS = 120;
const AGED_DAILY_DEFAULT_LIMIT_PER_DOMAIN = 500;
const AGED_GRADUATION_THRESHOLD_DEFAULT = 8;
const AGED_GRADUATION_WINDOW_DAYS_DEFAULT = 120;
const AGED_GRADUATION_DURATION_FLOOR_SEC_DEFAULT = 10;
const ACTIVE_CX_QUEUE_STATES = ["queued", "ready", "claimed", "serving", "paused"];

// Logics returns SourceCampaignID as a number, not a name string. We
// pre-load the source-canonical mapping once and convert the regex to
// a set of allowed campaign IDs per domain, then test in O(1).
const DIGITAL_SOURCE_REGEX = /VF|LD|Affiliate|Digital/i;
const TAG_LOOKBACK_MONTHS = 4;
const DEFAULT_CONCURRENCY = 20;

// WYNN digital sources didn't exist before Jan 2026 — anything older
// is guaranteed to not match the sourceId filter, so we can early-stop
// the WYNN scan on createDate < this floor regardless of source.
const WYNN_DIGITAL_FLOOR_DATE = new Date("2026-01-01T00:00:00-08:00");

// CaseID floor for TAG. Cases below this number predate the modern
// mail-intake era — they're noise for filler purposes.
const TAG_CASE_ID_FLOOR = 50000;

// DNC freshness window. Federal SafeHarbor compliance is 31 days —
// any DNC scrub older than that is no longer a valid check. 30 days
// keeps us inside the safe window with a one-day buffer.
const DNC_REUSE_WINDOW_MS = 30 * 24 * 3600 * 1000;

function defaultMonthTag(now = new Date()) {
  // PT month, since the refresh fires on PT calendar.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
  });
  const parts = fmt.formatToParts(now);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  return `filler-${year}-${month}`;
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length === 10) return digits;
  return null;
}

function pickField(obj, ...keys) {
  for (const k of keys) {
    if (obj?.[k] != null && obj[k] !== "") return obj[k];
  }
  return null;
}

// Run promises in fixed-concurrency chunks. Keeps memory + API load
// predictable.
async function runConcurrent(items, concurrency, fn, onProgress = null) {
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
          .then(() => fn(items[myIndex], myIndex))
          .then((value) => {
            results[myIndex] = value;
            completed += 1;
            inflight -= 1;
            if (onProgress) onProgress(completed, items.length);
            if (completed === items.length) {
              resolve(results);
            } else {
              pump();
            }
          })
          .catch(reject);
      }
    }
    if (items.length === 0) resolve(results);
    else pump();
  });
}

async function loadDigitalSourceIdSet(domain) {
  const col = mongoose.connection.db.collection("controlplanesourcecanonicals");
  const docs = await col.find({ active: true, domains: domain }).toArray();
  const ids = new Set();
  for (const doc of docs) {
    if (!DIGITAL_SOURCE_REGEX.test(doc.internalName || "")) continue;
    for (const entry of doc.sourceIds || []) {
      if (entry.domain === domain && Number.isFinite(Number(entry.sourceId))) {
        ids.add(Number(entry.sourceId));
      }
    }
  }
  return ids;
}

async function fetchCaseInfoSafe(client, caseId, logger) {
  try {
    const payload = await client.getCaseInfo(caseId);
    const data = payload?.data || payload?.Data || payload;
    if (data && typeof data === "object") return data;
    return null;
  } catch (error) {
    if (error?.details?.responseStatus === 404) return null;
    logger?.warn?.("filler.case-info.failed", { caseId, error: error.message });
    return null;
  }
}

function shouldKeepWynn(caseInfo, allowedSourceIds) {
  const sourceId = Number(
    pickField(caseInfo, "SourceCampaignID", "sourceCampaignId", "SourceID", "sourceId"),
  );
  if (!Number.isFinite(sourceId)) return false;
  return allowedSourceIds.has(sourceId);
}

function shouldKeepTag(caseInfo) {
  const caseId = Number(pickField(caseInfo, "CaseID", "caseId", "ID"));
  if (!Number.isFinite(caseId) || caseId < TAG_CASE_ID_FLOOR) return false;
  const cell = pickField(caseInfo, "CellPhone", "cellPhone");
  const home = pickField(caseInfo, "HomePhone", "homePhone");
  const work = pickField(caseInfo, "WorkPhone", "workPhone");
  return Boolean(cell || home || work);
}

function summarizeCaseInfo(caseInfo, domain) {
  const cell = pickField(caseInfo, "CellPhone", "cellPhone");
  const home = pickField(caseInfo, "HomePhone", "homePhone");
  const work = pickField(caseInfo, "WorkPhone", "workPhone");
  const phone = normalizePhone(cell) || normalizePhone(home) || normalizePhone(work);

  const composedName = pickField(caseInfo, "Name", "name");
  const firstName = pickField(caseInfo, "FirstName", "firstName");
  const lastName = pickField(caseInfo, "LastName", "lastName");
  const name = composedName || [firstName, lastName].filter(Boolean).join(" ").trim() || null;

  return {
    domain,
    caseId: Number(pickField(caseInfo, "CaseID", "caseId", "ID")),
    name,
    phone,
    sourceName: pickField(caseInfo, "SourceName", "sourceName") || null,
    statusId: Number(pickField(caseInfo, "StatusID", "statusId", "Status")) || null,
    createdDate: pickField(caseInfo, "CaseCreatedDate", "CreatedDate", "createdDate") || null,
  };
}

async function pullDomainCandidates({
  domain,
  filterFn,
  concurrency,
  limit,
  logger,
  earlyStopOnDateCutoff = null,
  orderByCreatedDate = true,
}) {
  logger?.info?.(`filler.scan.start`, { domain, orderByCreatedDate });
  const client = createLogicsClient(domain);
  const caseIds = await client
    .getCasesByStatus(2, { orderByCreatedDate })
    .then((payload) => {
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
        .filter((value) => Number.isFinite(value));
    })
    .catch((error) => {
      logger?.warn?.(`filler.scan.getCasesByStatus.failed`, {
        domain,
        error: error.message,
      });
      return [];
    });

  logger?.info?.(`filler.scan.ids`, { domain, count: caseIds.length });

  const ids = limit > 0 ? caseIds.slice(0, limit) : caseIds;
  if (ids.length === 0) {
    return { filtered: [], observedCaseIds: [], scanned: 0 };
  }

  // Sequential-batch with early-stop semantics. Process IDs in chunks
  // of `concurrency` so we get parallelism within a chunk but can
  // bail between chunks once we cross a date cutoff.
  const filtered = [];
  let scanned = 0;
  let stoppedEarly = false;

  for (let i = 0; i < ids.length && !stoppedEarly; i += concurrency) {
    const chunk = ids.slice(i, i + concurrency);
    const cases = await Promise.all(
      chunk.map((id) => fetchCaseInfoSafe(client, id, logger)),
    );
    scanned += chunk.length;

    let chunkOldestPassesCutoff = true;
    for (const ci of cases) {
      if (!ci) continue;
      if (!filterFn(ci)) {
        if (earlyStopOnDateCutoff) {
          const created = pickField(
            ci,
            "CaseCreatedDate",
            "CreatedDate",
            "createdDate",
            "DateCreated",
          );
          if (created) {
            const t = new Date(created).getTime();
            if (Number.isFinite(t) && t < earlyStopOnDateCutoff) {
              chunkOldestPassesCutoff = false;
            }
          }
        }
        continue;
      }
      const summary = summarizeCaseInfo(ci, domain);
      if (!summary.caseId || !Number.isFinite(summary.caseId)) continue;
      filtered.push(summary);
    }

    if (
      earlyStopOnDateCutoff &&
      !chunkOldestPassesCutoff &&
      scanned > concurrency
    ) {
      stoppedEarly = true;
    }
  }

  logger?.info?.(`filler.scan.done`, {
    domain,
    scanned,
    passed: filtered.length,
    stoppedEarly,
  });
  return { filtered, observedCaseIds: ids, scanned, stoppedEarly };
}

async function loadCachedDncByPhone(phones) {
  if (!phones || phones.length === 0) return new Map();
  const docs = await MasterProspectIndex.find(
    {
      normalizedPhones: { $in: phones },
      "dnc.checkedAt": { $exists: true, $ne: null },
    },
    { normalizedPhones: 1, dnc: 1 },
  ).lean();
  const cache = new Map();
  const fresh = Date.now() - DNC_REUSE_WINDOW_MS;
  for (const doc of docs) {
    const t = doc.dnc?.checkedAt ? new Date(doc.dnc.checkedAt).getTime() : 0;
    if (t < fresh) continue;
    for (const ph of doc.normalizedPhones || []) {
      if (!cache.has(ph)) cache.set(ph, doc.dnc);
    }
  }
  return cache;
}

// Retry wrapper for RPV calls — handles 429 rate-limits with backoff
// instead of returning a poisonous "isCell: false" stub. After max
// retries, returns null which the scrub interprets as "skip caching,
// keep cautiously in pool, retry next refresh."
async function lookupDncWithRetry(rpv, phone, logger) {
  const maxAttempts = 4;
  let delay = 500;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await rpv.lookupDnc(phone);
    } catch (error) {
      const is429 = /\b429\b/.test(error.message || "");
      if (!is429 || attempt === maxAttempts) {
        logger?.warn?.("filler.dnc-lookup.failed", {
          phone,
          attempt,
          error: error.message,
        });
        return null;
      }
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
  return null;
}

async function dncScrubBatch(rows, concurrency, logger) {
  const rpv = createRealPhoneValidationClient();
  const phones = Array.from(new Set(rows.map((r) => r.phone).filter(Boolean)));
  if (phones.length === 0) return new Map();

  const cached = await loadCachedDncByPhone(phones);
  const toCheck = phones.filter((p) => !cached.has(p));
  logger?.info?.("filler.scrub.cache", {
    cached: cached.size,
    toCheck: toCheck.length,
  });

  const dncByPhone = new Map();
  for (const [phone, dnc] of cached.entries()) {
    dncByPhone.set(phone, {
      phone,
      onNationalDNC: Boolean(dnc.onNationalDnc),
      onStateDNC: Boolean(dnc.onStateDnc),
      onDMA: Boolean(dnc.onDma),
      isLitigator: Boolean(dnc.isLitigator),
      isCell: Boolean(dnc.isCell),
      checkedAt: dnc.checkedAt,
      cached: true,
      source: dnc.source || "dnc-lookup",
    });
  }

  if (toCheck.length === 0) return dncByPhone;

  const lookups = await runConcurrent(
    toCheck,
    concurrency,
    async (phone) => lookupDncWithRetry(rpv, phone, logger),
  );

  for (let i = 0; i < toCheck.length; i += 1) {
    const lookup = lookups[i];
    if (!lookup) continue; // null = lookup failed all retries; don't cache
    dncByPhone.set(toCheck[i], { ...lookup, cached: false, source: "dnc-lookup" });
  }
  return dncByPhone;
}

function buildDncSubdoc(lookup, now = new Date()) {
  if (!lookup) return null;
  return {
    onNationalDnc: Boolean(lookup.onNationalDNC),
    onStateDnc: Boolean(lookup.onStateDNC),
    onDma: Boolean(lookup.onDMA),
    isLitigator: Boolean(lookup.isLitigator),
    isCell: Boolean(lookup.isCell),
    checkedAt:
      lookup.cached && lookup.checkedAt ? new Date(lookup.checkedAt) : now,
    source: lookup.source || "dnc-lookup",
    nextCheckAt: new Date(
      (lookup.cached && lookup.checkedAt
        ? new Date(lookup.checkedAt).getTime()
        : now.getTime()) + DNC_REUSE_WINDOW_MS,
    ),
  };
}

function buildUpsertOp(r, classification, { tag, retryTag, now, skipDnc }) {
  // classification: "pool" | "dnc-rejected" | "lookup-failed"
  const baseNotes = ["filler-monthly-build"];
  if (classification === "dnc-rejected") baseNotes.push("dnc-rejected");
  if (classification === "lookup-failed") baseNotes.push("dnc-lookup-failed-retry");

  const setDoc = {
    domain: r.domain,
    caseId: r.caseId,
    statusId: r.statusId,
    statusCategory: "prospect",
    name: r.name,
    normalizedPhones: r.phone ? [r.phone] : [],
    lastSeenAt: now,
    needsStatusRefresh: false,
    metadata: {
      intakeSource: "filler-build",
      sourceName: r.sourceName,
      notes: baseNotes,
    },
  };

  if (classification === "pool") {
    setDoc.pool = {
      tag,
      source: r.domain === "WYNN" ? "wynn-digital-opened" : "tag-recent-modified",
      builtAt: now,
      dncScrubbedAt: skipDnc ? null : now,
    };
  } else if (classification === "lookup-failed") {
    // Retry pool: separate tag so the CX queue (which filters on
    // current-month tag) doesn't pick these up. Next sweep tries the
    // DNC lookup again. `dnc.checkedAt` stays null so the cache-reuse
    // path skips them.
    setDoc.pool = {
      tag: retryTag,
      source: "dnc-lookup-pending-retry",
      builtAt: now,
      dncScrubbedAt: null,
    };
  } else {
    // dnc-rejected: kept for cache reuse but never callable
    setDoc.pool = null;
  }

  if (r.dncSubdoc) {
    setDoc.dnc = r.dncSubdoc;
  }
  return {
    updateOne: {
      filter: { domain: r.domain, caseId: r.caseId },
      update: {
        $set: setDoc,
        $setOnInsert: { firstSeenAt: now },
      },
      upsert: true,
    },
  };
}

/**
 * Run one filler-pool refresh.
 *
 * @param {object} options
 * @param {string} [options.tag]         - pool tag (default: filler-YYYY-MM in PT)
 * @param {string[]} [options.domains]   - which tenants to scan (default ["WYNN", "TAG"])
 * @param {boolean} [options.dryRun]     - true = no writes (default true)
 * @param {boolean} [options.skipDnc]    - true = skip RealValidation scrub (default false)
 * @param {number}  [options.limit]      - cap candidates per domain (0 = no cap)
 * @param {number}  [options.concurrency]- per-batch concurrency (default 20)
 * @param {object}  [options.logger]     - shape: { info, warn }
 * @returns {Promise<object>} structured result
 */
async function runFillerPoolRefresh(options = {}) {
  const startedAt = new Date();
  const tag = options.tag || defaultMonthTag(startedAt);
  const domains = (options.domains && options.domains.length > 0
    ? options.domains
    : ["WYNN", "TAG"]
  ).map((d) => String(d).toUpperCase());
  const dryRun = options.dryRun !== false; // default true — caller must opt-in
  const skipDnc = Boolean(options.skipDnc);
  const limit = Number(options.limit) || 0;
  const concurrency = Math.max(Number(options.concurrency) || DEFAULT_CONCURRENCY, 1);
  const logger = options.logger || {
    info: () => {},
    warn: (msg, meta) => console.warn(`[warn] ${msg}`, meta || ""),
  };

  logger.info("filler.refresh.start", {
    tag,
    domains,
    dryRun,
    skipDnc,
    limit,
    concurrency,
  });

  // Pre-load WYNN's digital source-canonical set if scanning WYNN.
  let wynnDigitalSourceIds = new Set();
  if (domains.includes("WYNN")) {
    wynnDigitalSourceIds = await loadDigitalSourceIdSet("WYNN");
    logger.info("filler.refresh.wynn-digital-source-ids", {
      count: wynnDigitalSourceIds.size,
      ids: [...wynnDigitalSourceIds].sort((a, b) => a - b),
    });
  }

  const observedByDomain = {};
  const allCandidates = [];
  const perDomainScan = {};

  for (const dom of domains) {
    const filterFn =
      dom === "WYNN"
        ? (ci) => shouldKeepWynn(ci, wynnDigitalSourceIds)
        : (ci) => shouldKeepTag(ci);
    const orderByCreatedDate = dom === "WYNN";
    const earlyStopOnDateCutoff =
      dom === "WYNN" ? WYNN_DIGITAL_FLOOR_DATE.getTime() : null;
    const { filtered, observedCaseIds, scanned, stoppedEarly } =
      await pullDomainCandidates({
        domain: dom,
        filterFn,
        concurrency,
        limit,
        logger,
        earlyStopOnDateCutoff,
        orderByCreatedDate,
      });
    observedByDomain[dom] = new Set(observedCaseIds);
    allCandidates.push(...filtered);
    perDomainScan[dom] = {
      observed: observedCaseIds.length,
      passed: filtered.length,
      scanned,
      stoppedEarly: Boolean(stoppedEarly),
    };
  }

  // De-dupe by (domain, caseId).
  const dedupKey = (r) => `${r.domain}:${r.caseId}`;
  const dedup = new Map();
  for (const r of allCandidates) {
    if (!dedup.has(dedupKey(r))) dedup.set(dedupKey(r), r);
  }
  const candidates = [...dedup.values()];

  // DNC scrub. Outputs:
  //   poolEligible     — DNC-clean phones, get pool.tag = currentMonth
  //                      (dialable in the CX queue)
  //   dncRejected      — DNC / litigator, persisted WITHOUT pool.tag so
  //                      cached for next refresh's skip-if-fresh check
  //                      but invisible to the dialer
  //   dncLookupFailed  — RealValidation lookup failed all retries
  //                      (429-storm, network blip, etc.). Tagged
  //                      `filler-retry-YYYY-MM` so they're invisible to
  //                      the CX queue (which filters on
  //                      pool.tag === current month) but still tracked.
  //                      Next refresh's `loadCachedDncByPhone` won't
  //                      match them (no `dnc.checkedAt`) so they
  //                      automatically retry the lookup.
  // Rows without a phone are dropped from MPI entirely.
  const poolEligible = [];
  const dncRejected = [];
  const dncLookupFailed = [];
  const dncStats = {
    droppedNoPhone: 0,
    poolEligible: 0,
    cachedReused: 0,
    rejectedDnc: 0,
    rejectedLitigator: 0,
    rejectedTotal: 0,
    rpvCalls: 0,
    lookupFailed: 0,
  };

  if (!skipDnc) {
    const dncByPhone = await dncScrubBatch(candidates, concurrency, logger);
    for (const lookup of dncByPhone.values()) {
      if (lookup.cached) dncStats.cachedReused += 1;
      else dncStats.rpvCalls += 1;
    }

    for (const c of candidates) {
      if (!c.phone) {
        dncStats.droppedNoPhone += 1;
        continue;
      }
      const dnc = dncByPhone.get(c.phone);
      if (!dnc) {
        // All retries failed — quarantine, don't make dialable. The
        // 30-day SafeHarbor compliance window means an unverified
        // phone shouldn't be in the dialable pool. Retry on next
        // monthly sweep (or sooner via manual retry).
        dncLookupFailed.push({ ...c, dncSubdoc: null });
        dncStats.lookupFailed += 1;
        continue;
      }
      const dncSubdoc = buildDncSubdoc(dnc, startedAt);
      // Reject only on actual DNC or litigator. Landlines (isCell:false)
      // are FINE for filler dialing.
      const isRejected = dnc.onNationalDNC || dnc.onStateDNC || dnc.isLitigator;
      if (isRejected) {
        dncRejected.push({ ...c, dncSubdoc });
        dncStats.rejectedTotal += 1;
        if (dnc.onNationalDNC || dnc.onStateDNC) dncStats.rejectedDnc += 1;
        if (dnc.isLitigator) dncStats.rejectedLitigator += 1;
      } else {
        poolEligible.push({ ...c, dncSubdoc });
        dncStats.poolEligible += 1;
      }
    }
  } else {
    for (const c of candidates) {
      if (!c.phone) {
        dncStats.droppedNoPhone += 1;
        continue;
      }
      poolEligible.push({ ...c, dncSubdoc: null });
      dncStats.poolEligible += 1;
    }
  }

  const byDomainPool = poolEligible.reduce((acc, r) => {
    acc[r.domain] = (acc[r.domain] || 0) + 1;
    return acc;
  }, {});

  // Retry pool tag — same shape as the dialable tag but distinct so the
  // CX queue render doesn't include them. Stays in MPI until next
  // refresh's lookup attempt either succeeds (promoted to dialable) or
  // fails again (still quarantined).
  const retryTag = tag.replace(/^filler-/, "filler-retry-");

  logger.info("filler.refresh.scrub-summary", {
    poolEligible: poolEligible.length,
    byDomainPool,
    dncRejected: dncRejected.length,
    dncLookupFailed: dncLookupFailed.length,
    retryTag,
    dncStats,
  });

  if (dryRun) {
    const finishedAt = new Date();
    return {
      ok: true,
      dryRun: true,
      tag,
      retryTag,
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      domains,
      perDomainScan,
      candidates: { total: candidates.length, byDomainPool },
      scrub: {
        poolEligible: poolEligible.length,
        dncRejected: dncRejected.length,
        dncLookupFailed: dncLookupFailed.length,
        ...dncStats,
      },
      upsert: { skippedDryRun: true },
      gc: { skippedDryRun: true },
      verify: null,
    };
  }

  // Operating rule: MPI contains ONLY currently-dialable rows. A row
  // with no active pool.tag is by definition not dialable, so we
  // delete it rather than null-out the pool subdoc and let it linger.
  //
  // What gets deleted:
  //   - Rows tagged with a prior-month filler-* tag (no longer in
  //     this build's selection)
  //   - Rows tagged with a prior retry pool tag
  //   - Rows with `pool: null` or no pool subdoc (orphans, dnc-rejected
  //     rows that never had pool.tag, migration leftovers)
  //
  // Trade-off: we lose the DNC cache for deleted rows. For the
  // monthly cadence the cache barely helped anyway (build runs ~30
  // days apart, cache TTL is 30 days → mostly miss). The leaner MPI
  // is worth the extra RPV calls.
  const orphanDelete = await MasterProspectIndex.deleteMany({
    $or: [
      { "pool.tag": { $in: [null, undefined] } },
      { "pool.tag": { $exists: false } },
      {
        "pool.tag": {
          $exists: true,
          $ne: null,
          $nin: [tag, retryTag],
        },
      },
    ],
  });
  logger.info("filler.refresh.prune-non-dialable", {
    deleted: orphanDelete.deletedCount,
  });

  const ops = [
    ...poolEligible.map((r) =>
      buildUpsertOp(r, "pool", { tag, retryTag, now: startedAt, skipDnc }),
    ),
    ...dncRejected.map((r) =>
      buildUpsertOp(r, "dnc-rejected", { tag, retryTag, now: startedAt, skipDnc }),
    ),
    ...dncLookupFailed.map((r) =>
      buildUpsertOp(r, "lookup-failed", { tag, retryTag, now: startedAt, skipDnc }),
    ),
  ];

  let upserted = 0;
  let modified = 0;
  if (ops.length > 0) {
    const chunkSize = 500;
    for (let i = 0; i < ops.length; i += chunkSize) {
      const chunk = ops.slice(i, i + chunkSize);
      const res = await MasterProspectIndex.bulkWrite(chunk, { ordered: false });
      upserted += res.upsertedCount || 0;
      modified += res.modifiedCount || 0;
    }
  }
  logger.info("filler.refresh.upsert-summary", { upserted, modified });

  // GC: drop MPI rows whose caseId is NOT in this refresh's observed
  // status=2 set. They've converted, closed, or otherwise left the
  // prospect bucket. Skip if --limit was passed (observed set is
  // partial; would over-delete). Per-domain — a single-domain refresh
  // doesn't delete rows in the other domain.
  const gcByDomain = {};
  if (limit > 0) {
    logger.info("filler.refresh.gc.skipped", {
      reason: "limit-set-partial-observed",
      limit,
    });
  } else {
    for (const [dom, observed] of Object.entries(observedByDomain)) {
      const observedArr = [...observed];
      if (observedArr.length === 0) {
        gcByDomain[dom] = { skipped: true, reason: "empty-observed-set" };
        continue;
      }
      const gcResult = await MasterProspectIndex.deleteMany({
        domain: dom,
        caseId: { $nin: observedArr },
      });
      gcByDomain[dom] = {
        deleted: gcResult.deletedCount,
        observed: observedArr.length,
      };
    }
  }
  logger.info("filler.refresh.gc-summary", { byDomain: gcByDomain });

  // Verify
  const poolCount = await MasterProspectIndex.countDocuments({ "pool.tag": tag });
  const retryPoolCount = await MasterProspectIndex.countDocuments({
    "pool.tag": retryTag,
  });
  const dncCacheCount = await MasterProspectIndex.countDocuments({
    "dnc.checkedAt": { $exists: true, $ne: null },
  });
  const totalMpi = await MasterProspectIndex.countDocuments({});

  // Raise a workflow ticket when the retry queue is non-empty. The DNC
  // check is the whole point of the monthly refresh — failures are
  // operationally significant. Emit at "blocked" stage so monitoring
  // panels surface it; manual review can promote them via a one-off
  // sweep, or the next monthly refresh's automatic retry resolves it.
  if (dncLookupFailed.length > 0) {
    await recordWorkflowStage({
      domain: null, // multi-domain
      family: "filler-pool",
      subtype: "dnc-lookup-retry-queue",
      stage: "blocked",
      aggregateType: "filler-pool",
      aggregateId: retryTag,
      sourceService: "filler-pool-refresh-service",
      title: "Filler pool DNC lookup retry queue",
      summary: `${dncLookupFailed.length} rows failed RealValidation DNC lookup in this refresh; quarantined under pool.tag=${retryTag} for next-sweep retry`,
      status: "warning",
      payload: {
        retryTag,
        currentTag: tag,
        retryQueueSize: dncLookupFailed.length,
        rpvCalls: dncStats.rpvCalls,
        cachedReused: dncStats.cachedReused,
        domains,
      },
    }).catch((err) => {
      logger.warn?.("filler.refresh.retry-ticket.failed", { error: err.message });
    });
  }

  const finishedAt = new Date();
  return {
    ok: true,
    dryRun: false,
    tag,
    retryTag,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    domains,
    perDomainScan,
    candidates: { total: candidates.length, byDomainPool },
    scrub: {
      poolEligible: poolEligible.length,
      dncRejected: dncRejected.length,
      dncLookupFailed: dncLookupFailed.length,
      ...dncStats,
    },
    upsert: { upserted, modified, prunedNonDialable: orphanDelete.deletedCount },
    gc: { byDomain: gcByDomain },
    verify: { poolCount, retryPoolCount, dncCacheCount, totalMpi },
  };
}

/**
 * Should the monthly refresh fire on this hourly tick?
 *
 * Fires once per month, on the 1st of the month between 5:00 and
 * 5:59 PT. Idempotent across multiple ticks in that hour because
 * the caller checks `hasFreshPoolForTag` before invoking.
 *
 * @param {Date} now - current time
 * @returns {boolean}
 */
function isAtMonthlyRefreshBoundary(now = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const day = parts.find((p) => p.type === "day")?.value;
  const hour = parts.find((p) => p.type === "hour")?.value;
  return day === "01" && hour === "05";
}

/**
 * Has the pool already been built (and verified) for the given tag?
 *
 * Used as an idempotency guard so the hourly sweeper doesn't run the
 * refresh twice in the same 5am window — finds at least one MPI row
 * with this tag where pool.builtAt is set.
 */
async function hasFreshPoolForTag(tag) {
  const existing = await MasterProspectIndex.findOne(
    { "pool.tag": tag, "pool.builtAt": { $exists: true, $ne: null } },
    { _id: 1 },
  ).lean();
  return Boolean(existing);
}

// ─────────────────────────────────────────────────────────────────────
// Rolling daily aged-pool refresh.
//
// Replaces the once-monthly burst with a per-lead checkpoint sweep:
//   age 30d → first DNC scrub  → promote (clean) or drop (hit)
//   age 60d → re-scrub          → stay in red (clean) or evict (hit)
//   age 90d → final re-scrub    → mark cleared (clean) or evict (hit)
//   age 90d+ → ignored          (graduation sweep + cadence rule handles)
//
// All state lives on LeadCadence.dncCheckpoints { count, lastAt, nextAt,
// cleared, hit, ... }. MPI gets pool.tag stamped/cleared as a side
// effect. CallLog is read-only here.
//
// Idempotent: query gates on `dncCheckpoints.nextAt <= now`, and every
// touched row advances `nextAt` (forward or to null) so the same lead
// can't be picked up twice on the same day. graduatedAt-set leads are
// excluded.
// ─────────────────────────────────────────────────────────────────────

function isAtDailyAgedRefreshBoundary(now = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const hour = parts.find((p) => p.type === "hour")?.value;
  return hour === "06";
}

function isAgedRollingRefreshEnabled() {
  return String(process.env.AGED_ROLLING_REFRESH_ENABLED || "false")
    .trim()
    .toLowerCase() === "true";
}

function parseEnvDomains() {
  const raw = String(process.env.AGED_ROLLING_REFRESH_DOMAINS || "").trim();
  if (!raw) return null;
  return raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

function envNumber(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function computeNextCheckpoint(intakeAt, currentCount) {
  // Returns the milestone advance after this scrub completes.
  // currentCount is BEFORE the scrub increments — after a clean scrub
  // newCount = currentCount + 1.
  const intakeMs = new Date(intakeAt).getTime();
  if (!Number.isFinite(intakeMs)) {
    return { newCount: currentCount + 1, nextAt: null, cleared: true };
  }
  const newCount = currentCount + 1;
  const nextDayIdx = newCount; // 0→1: use index 1 (60d), 1→2: index 2 (90d), 2→3: done
  if (nextDayIdx >= AGED_DAILY_CHECKPOINT_DAYS.length) {
    return { newCount, nextAt: null, cleared: true };
  }
  const days = AGED_DAILY_CHECKPOINT_DAYS[nextDayIdx];
  return {
    newCount,
    nextAt: new Date(intakeMs + days * MS_PER_DAY),
    cleared: false,
  };
}

function describeDncReason(lookup) {
  if (!lookup) return null;
  if (lookup.isLitigator) return "litigator";
  if (lookup.onNationalDNC) return "national";
  if (lookup.onStateDNC) return "state";
  return null;
}

async function retireExpiredAgedCadence({
  now = new Date(),
  dryRun = false,
  domains = null,
  limitPerDomain = AGED_DAILY_DEFAULT_LIMIT_PER_DOMAIN,
  logger = null,
} = {}) {
  const cutoff = new Date(now.getTime() - AGED_CADENCE_RETIRE_DAYS * MS_PER_DAY);
  const baseQuery = {
    active: true,
    createdAt: { $lte: cutoff },
    graduatedAt: null,
  };
  if (Array.isArray(domains) && domains.length > 0) {
    baseQuery.domain = { $in: domains.map((domain) => String(domain).toUpperCase()) };
  }

  const rows = await LeadCadence.find(baseQuery, {
    _id: 1,
    domain: 1,
    caseId: 1,
    createdAt: 1,
    normalizedPhone: 1,
  })
    .sort({ createdAt: 1 })
    .limit(Math.max(Number(limitPerDomain) || AGED_DAILY_DEFAULT_LIMIT_PER_DOMAIN, 1) * 4)
    .lean();

  const byDomain = new Map();
  for (const row of rows) {
    const domain = String(row.domain || "").toUpperCase();
    if (!domain) continue;
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    if (byDomain.get(domain).length < limitPerDomain) byDomain.get(domain).push(row);
  }

  const summary = {
    cutoff,
    retireDays: AGED_CADENCE_RETIRE_DAYS,
    scanned: rows.length,
    retired: 0,
    queueDeleted: 0,
    mpiCleared: 0,
    perDomain: {},
  };

  for (const [domain, leads] of byDomain.entries()) {
    summary.perDomain[domain] = { retired: 0, queueDeleted: 0, mpiCleared: 0 };
    for (const lead of leads) {
      const caseId = Number(lead.caseId);
      if (!Number.isFinite(caseId)) continue;
      if (dryRun) {
        summary.retired += 1;
        summary.perDomain[domain].retired += 1;
        continue;
      }
      const [cadenceResult, queueResult, mpiResult] = await Promise.all([
        LeadCadence.deleteOne({ _id: lead._id }),
        CxDialQueue.deleteMany({
          domain,
          caseId,
          state: { $in: ACTIVE_CX_QUEUE_STATES },
        }),
        MasterProspectIndex.updateOne(
          { domain, caseId },
          {
            $set: {
              pool: null,
              "metadata.agedCadenceRetiredAt": now,
              "metadata.agedCadenceRetiredReason": "day-120",
            },
          },
        ),
      ]);
      const cadenceDeleted = Number(cadenceResult.deletedCount || 0);
      const queueDeleted = Number(queueResult.deletedCount || 0);
      const mpiCleared = Number(mpiResult.modifiedCount || 0);
      summary.retired += cadenceDeleted;
      summary.queueDeleted += queueDeleted;
      summary.mpiCleared += mpiCleared;
      summary.perDomain[domain].retired += cadenceDeleted;
      summary.perDomain[domain].queueDeleted += queueDeleted;
      summary.perDomain[domain].mpiCleared += mpiCleared;
    }
  }

  logger?.info?.("aged-rolling-refresh.retire-expired.completed", {
    retired: summary.retired,
    queueDeleted: summary.queueDeleted,
    mpiCleared: summary.mpiCleared,
  });

  return summary;
}

/**
 * Daily aged-pool refresh tick. Walks LeadCadence rows whose
 * dncCheckpoints.nextAt has passed, scrubs against RealValidation,
 * promotes / re-scrubs / evicts per the 30/60/90 cadence.
 *
 * Returns the summary structure consumed by sendAgedRefreshReportEmail.
 *
 * @param {object} options
 * @param {Date}    [options.now]              - current time (default new Date)
 * @param {boolean} [options.dryRun]           - true = no writes (default reads env DRY_RUN)
 * @param {number}  [options.limitPerDomain]   - cap per tenant (default env or 500)
 * @param {string[]}[options.domains]          - tenants (default env or all)
 * @param {number}  [options.concurrency]      - lookup concurrency
 * @param {object}  [options.logger]           - { info, warn }
 */
async function runDailyAgedRefresh(options = {}) {
  const startedAt = new Date();
  const now = options.now || startedAt;
  const dryRun = options.dryRun != null
    ? Boolean(options.dryRun)
    : String(process.env.AGED_ROLLING_REFRESH_DRY_RUN || "false").trim().toLowerCase() === "true";
  const limitPerDomain = Number(options.limitPerDomain)
    || envNumber("AGED_ROLLING_REFRESH_LIMIT_PER_DOMAIN", AGED_DAILY_DEFAULT_LIMIT_PER_DOMAIN);
  const domainsFilter = options.domains && options.domains.length > 0
    ? options.domains.map((d) => String(d).toUpperCase())
    : parseEnvDomains();
  const concurrency = Math.max(Number(options.concurrency) || DEFAULT_CONCURRENCY, 1);
  const logger = options.logger || { info: () => {}, warn: () => {} };

  const tag = defaultMonthTag(now);

  // Pull all due rows. Even with limitPerDomain=500 across two tenants,
  // we're talking ~1k docs — single query is fine. Apply per-domain
  // truncation client-side after a stable sort.
  const baseQuery = {
    active: true,
    "dncCheckpoints.nextAt": { $lte: now },
    graduatedAt: null,
  };
  if (domainsFilter) baseQuery.domain = { $in: domainsFilter };

  const due = await LeadCadence.find(baseQuery)
    .sort({ "dncCheckpoints.nextAt": 1 })
    .limit(limitPerDomain * 4) // soft cap before per-domain trim
    .lean();

  const byDomain = new Map();
  for (const lead of due) {
    const dom = lead.domain;
    if (!byDomain.has(dom)) byDomain.set(dom, []);
    if (byDomain.get(dom).length < limitPerDomain) byDomain.get(dom).push(lead);
  }

  const summary = {
    startedAt,
    now,
    dryRun,
    tag,
    domains: [...byDomain.keys()],
    checked: 0,
    promoted: 0,
    stayed: 0,
    cleared: 0,
    evicted: 0,
    droppedAtIntake: 0,
    dncLookupFailures: 0,
    noPhone: 0,
    perDomain: {},
    retiredToday: [], // for email body — capped list of DNC drops/evictions
  };

  const runExpiredRetirement = async () => {
    summary.expiredRetirement = await retireExpiredAgedCadence({
      now,
      dryRun,
      domains: domainsFilter,
      limitPerDomain,
      logger,
    }).catch((error) => ({
      error: error.message,
      retired: 0,
      queueDeleted: 0,
      mpiCleared: 0,
    }));
  };

  if (due.length === 0) {
    await runExpiredRetirement();
    summary.finishedAt = new Date();
    summary.durationMs = summary.finishedAt - startedAt;
    return summary;
  }

  const rpv = createRealPhoneValidationClient();

  for (const [domain, leads] of byDomain.entries()) {
    const perDom = {
      checked: 0,
      promoted: 0,
      stayed: 0,
      cleared: 0,
      evicted: 0,
      droppedAtIntake: 0,
      dncLookupFailures: 0,
      noPhone: 0,
    };

    // Lookups concurrent within domain. Phones may dup across leads —
    // dedupe to save RPV calls.
    const phones = Array.from(
      new Set(leads.map((l) => l.normalizedPhone).filter(Boolean)),
    );
    const lookups = new Map();
    const lookupResults = await runConcurrent(
      phones,
      concurrency,
      async (phone) => lookupDncWithRetry(rpv, phone, logger),
    );
    for (let i = 0; i < phones.length; i += 1) {
      lookups.set(phones[i], lookupResults[i] || null);
    }

    for (const lead of leads) {
      perDom.checked += 1;
      summary.checked += 1;

      const phone = lead.normalizedPhone;
      const intakeAt = lead.createdAt;
      const prevCount = Number(lead.dncCheckpoints?.count || 0);
      const isInitial = prevCount === 0;

      if (!phone) {
        perDom.noPhone += 1;
        summary.noPhone += 1;
        // Advance nextAt anyway so we don't re-query the same empty row.
        const adv = computeNextCheckpoint(intakeAt, prevCount);
        if (!dryRun) {
          await LeadCadence.updateOne(
            { _id: lead._id },
            {
              $set: {
                "dncCheckpoints.count": adv.newCount,
                "dncCheckpoints.lastAt": now,
                "dncCheckpoints.nextAt": adv.nextAt,
                "dncCheckpoints.cleared": adv.cleared || lead.dncCheckpoints?.cleared || false,
                "dncCheckpoints.source": "no-phone",
              },
            },
          );
        }
        continue;
      }

      const lookup = lookups.get(phone);
      if (!lookup) {
        perDom.dncLookupFailures += 1;
        summary.dncLookupFailures += 1;
        // Leave nextAt where it is so tomorrow's tick retries — but
        // bump lastAt so we don't hammer a chronically-failing phone
        // more than once per day. Pushes nextAt forward by 24h.
        if (!dryRun) {
          await LeadCadence.updateOne(
            { _id: lead._id },
            {
              $set: {
                "dncCheckpoints.lastAt": now,
                "dncCheckpoints.nextAt": new Date(now.getTime() + MS_PER_DAY),
                "dncCheckpoints.source": "lookup-failed",
              },
            },
          );
        }
        continue;
      }

      const dirty = Boolean(
        lookup.onNationalDNC || lookup.onStateDNC || lookup.isLitigator,
      );

      if (dirty) {
        const reason = describeDncReason(lookup);
        if (isInitial) {
          perDom.droppedAtIntake += 1;
          summary.droppedAtIntake += 1;
        } else {
          perDom.evicted += 1;
          summary.evicted += 1;
        }
        if (summary.retiredToday.length < 200) {
          summary.retiredToday.push({
            domain,
            caseId: lead.caseId,
            name: lead.name || [lead.firstName, lead.lastName].filter(Boolean).join(" ").trim() || null,
            phone,
            reason,
            checkpoint: AGED_DAILY_CHECKPOINT_DAYS[prevCount] || null,
          });
        }
        if (!dryRun) {
          await Promise.all([
            LeadCadence.deleteOne({ _id: lead._id }),
            CxDialQueue.deleteMany({
              domain,
              caseId: lead.caseId,
              state: { $in: ACTIVE_CX_QUEUE_STATES },
            }),
          ]);
          // Clear pool.tag (and stamp dnc subdoc) on MPI so the dialer
          // can't pick this lead up. Upsert because the row may not
          // exist yet (the 30d initial check fires before any monthly
          // build would have added them).
          await MasterProspectIndex.updateOne(
            { domain, caseId: lead.caseId },
            {
              $set: {
                domain,
                caseId: lead.caseId,
                normalizedPhones: [phone],
                lastSeenAt: now,
                dnc: buildDncSubdoc(lookup, now),
                pool: null,
              },
              $setOnInsert: { firstSeenAt: now },
            },
            { upsert: true },
          );
        }
        continue;
      }

      // Clean. Advance checkpoint state. Either promote (first time)
      // or just stay (subsequent re-scrubs).
      const adv = computeNextCheckpoint(intakeAt, prevCount);
      if (isInitial) {
        perDom.promoted += 1;
        summary.promoted += 1;
      } else if (adv.cleared) {
        perDom.cleared += 1;
        summary.cleared += 1;
      } else {
        perDom.stayed += 1;
        summary.stayed += 1;
      }

      if (!dryRun) {
        await LeadCadence.updateOne(
          { _id: lead._id },
          {
            $set: {
              "dncCheckpoints.count": adv.newCount,
              "dncCheckpoints.lastAt": now,
              "dncCheckpoints.nextAt": adv.nextAt,
              "dncCheckpoints.cleared": adv.cleared,
              "dncCheckpoints.source": "realvalidation",
              "dncCheckpoints.hit": false,
              "dncCheckpoints.reason": null,
            },
          },
        );
        if (isInitial) {
          // Promote: upsert MPI with current month's pool.tag.
          //
          // metadata.routeCampaignKey is stamped here so the CX queue
          // materializer (cxWorkspaceService — materializes from MPI
          // for the filler/aged path at line ~2637) can carry the LD
          // route campaign through onto the resulting queueItem.metadata.
          // Without this stamp, aged-tier queue items lose their
          // ld-custom / ld-general bucketing and fall through to the
          // legacy ld-posting family in the vendor rollup.
          await MasterProspectIndex.updateOne(
            { domain, caseId: lead.caseId },
            {
              $set: {
                domain,
                caseId: lead.caseId,
                normalizedPhones: [phone],
                lastSeenAt: now,
                dnc: buildDncSubdoc(lookup, now),
                pool: {
                  tag,
                  source: "aged-rolling-refresh",
                  builtAt: now,
                  dncScrubbedAt: now,
                },
                "metadata.routeCampaignKey": lead.routeCampaignKey || null,
                "metadata.routeCampaignName": lead.routeCampaignName || null,
              },
              $setOnInsert: { firstSeenAt: now },
            },
            { upsert: true },
          );
        } else {
          // 60d / 90d re-scrub: refresh dnc subdoc but leave pool.tag
          // alone (still in red). Don't touch pool.builtAt either.
          await MasterProspectIndex.updateOne(
            { domain, caseId: lead.caseId },
            {
              $set: {
                lastSeenAt: now,
                dnc: buildDncSubdoc(lookup, now),
                "pool.dncScrubbedAt": now,
              },
            },
          );
        }
      }
    }

    summary.perDomain[domain] = perDom;
  }

  await runExpiredRetirement();

  summary.finishedAt = new Date();
  summary.durationMs = summary.finishedAt - startedAt;
  logger.info?.("aged-rolling-refresh.daily.complete", {
    checked: summary.checked,
    promoted: summary.promoted,
    evicted: summary.evicted + summary.droppedAtIntake,
    expiredRetired: summary.expiredRetirement?.retired || 0,
    dncLookupFailures: summary.dncLookupFailures,
    durationMs: summary.durationMs,
    dryRun,
  });

  return summary;
}

/**
 * Monthly graduation sweep. Walks current red-pool leads and graduates
 * (clears pool.tag, stamps graduatedAt) any with >= AGED_GRADUATION_THRESHOLD
 * qualifying CX connects in the trailing AGED_GRADUATION_WINDOW_DAYS.
 *
 * "Qualifying" = outbound + platform:"cx" + durationSec >=
 * AGED_GRADUATION_DURATION_FLOOR_SEC (default 10s). Voicemail counts
 * because it produces wall-clock duration.
 */
async function runMonthlyGraduationSweep(options = {}) {
  const startedAt = new Date();
  const now = options.now || startedAt;
  const dryRun = options.dryRun != null
    ? Boolean(options.dryRun)
    : String(process.env.AGED_ROLLING_REFRESH_DRY_RUN || "false").trim().toLowerCase() === "true";
  const threshold = Number(options.threshold)
    || envNumber("AGED_GRADUATION_THRESHOLD", AGED_GRADUATION_THRESHOLD_DEFAULT);
  const windowDays = Number(options.windowDays)
    || envNumber("AGED_GRADUATION_WINDOW_DAYS", AGED_GRADUATION_WINDOW_DAYS_DEFAULT);
  const durationFloor = Number(options.durationFloorSec)
    || envNumber("AGED_GRADUATION_DURATION_FLOOR_SEC", AGED_GRADUATION_DURATION_FLOOR_SEC_DEFAULT);
  const domainsFilter = options.domains && options.domains.length > 0
    ? options.domains.map((d) => String(d).toUpperCase())
    : parseEnvDomains();
  const logger = options.logger || { info: () => {}, warn: () => {} };

  const windowStart = new Date(now.getTime() - windowDays * MS_PER_DAY);

  // Source of truth for "currently in red" is MPI pool.tag matching
  // filler-*. Pull (domain, caseId) only — heavy lifting happens
  // per-lead.
  const mpiQuery = { "pool.tag": { $regex: /^filler-/ } };
  if (domainsFilter) mpiQuery.domain = { $in: domainsFilter };
  const inRed = await MasterProspectIndex.find(mpiQuery, {
    domain: 1,
    caseId: 1,
  }).lean();

  const summary = {
    startedAt,
    now,
    dryRun,
    threshold,
    windowDays,
    durationFloor,
    scanned: inRed.length,
    graduated: 0,
    skippedAlreadyGraduated: 0,
    skippedNotEnoughTouches: 0,
    perDomain: {},
    graduatedToday: [],
  };

  if (inRed.length === 0) {
    summary.finishedAt = new Date();
    summary.durationMs = summary.finishedAt - startedAt;
    return summary;
  }

  for (const row of inRed) {
    const { domain, caseId } = row;
    if (!summary.perDomain[domain]) {
      summary.perDomain[domain] = {
        scanned: 0,
        graduated: 0,
        skippedAlreadyGraduated: 0,
        skippedNotEnoughTouches: 0,
      };
    }
    summary.perDomain[domain].scanned += 1;

    const lead = await LeadCadence.findOne(
      { domain, caseId },
      { _id: 1, name: 1, firstName: 1, lastName: 1, primaryPhone: 1, graduatedAt: 1, createdAt: 1 },
    ).lean();

    if (lead && lead.graduatedAt) {
      summary.skippedAlreadyGraduated += 1;
      summary.perDomain[domain].skippedAlreadyGraduated += 1;
      continue;
    }

    const connects = await CallLog.countDocuments({
      domain,
      caseId,
      direction: "outbound",
      platform: "cx",
      durationSec: { $gte: durationFloor },
      callStartTime: { $gte: windowStart },
    });

    if (connects < threshold) {
      summary.skippedNotEnoughTouches += 1;
      summary.perDomain[domain].skippedNotEnoughTouches += 1;
      continue;
    }

    summary.graduated += 1;
    summary.perDomain[domain].graduated += 1;
    if (summary.graduatedToday.length < 200) {
      summary.graduatedToday.push({
        domain,
        caseId,
        name: lead ? (lead.name || [lead.firstName, lead.lastName].filter(Boolean).join(" ").trim() || null) : null,
        phone: lead?.primaryPhone || null,
        connects,
      });
    }

    if (!dryRun) {
      if (lead) {
        await LeadCadence.updateOne(
          { _id: lead._id },
          {
            $set: {
              graduatedAt: now,
              graduatedConnects: connects,
            },
          },
        );
      }
      await MasterProspectIndex.updateOne(
        { domain, caseId },
        {
          $unset: { "pool.tag": "" },
          $set: { lastSeenAt: now },
        },
      );
    }
  }

  summary.finishedAt = new Date();
  summary.durationMs = summary.finishedAt - startedAt;
  logger.info?.("aged-rolling-refresh.graduation.complete", {
    scanned: summary.scanned,
    graduated: summary.graduated,
    durationMs: summary.durationMs,
    dryRun,
  });
  return summary;
}

module.exports = {
  runFillerPoolRefresh,
  runDailyAgedRefresh,
  retireExpiredAgedCadence,
  runMonthlyGraduationSweep,
  isAtMonthlyRefreshBoundary,
  isAtDailyAgedRefreshBoundary,
  isAgedRollingRefreshEnabled,
  hasFreshPoolForTag,
  defaultMonthTag,
  computeNextCheckpoint,
  // exported for tests / introspection
  WYNN_DIGITAL_FLOOR_DATE,
  TAG_CASE_ID_FLOOR,
  DNC_REUSE_WINDOW_MS,
  AGED_DAILY_CHECKPOINT_DAYS,
  AGED_CADENCE_RETIRE_DAYS,
};
