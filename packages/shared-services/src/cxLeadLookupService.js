"use strict";

const {
  caseProfileRepository,
  leadCadenceRepository,
  masterProspectRepository,
} = require("../../shared-repositories/src");
const { MailImport } = require("../../shared-models/src");
const { createLogicsClient } = require("../../shared-integrations/src");

// Cache mail-intake context lookups within a single candidate-build
// pass. The CX lookup may produce multiple candidates that share the
// same caseId (e.g. MP + LC tiers for a recently-converted lead), and
// we don't want to hit the DB twice.
async function fetchMailIntakeContext(domain, caseId, cache) {
  if (!domain || caseId == null) return null;
  const key = `${domain}:${caseId}`;
  if (cache.has(key)) return cache.get(key);
  const row = await MailImport.findOne({ domain, caseId })
    .select({ address: 1, city: 1, state: 1, zip: 1, mailIntake: 1, createdAt: 1, importBatch: 1 })
    .lean()
    .catch(() => null);
  cache.set(key, row);
  return row;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Name+address search against MailImport — sibling to the MP-side
// `searchMasterProspectByNameAddress`. Mail-intake leads no longer
// land in MPI (NCOA service writes to MailImport now), so the CX
// "find by name + address" path needs to look here too.
async function searchMailImportByNameAddress(domain, filters = {}) {
  const normalizedDomain = String(domain || "").toUpperCase();
  const query = { domain: normalizedDomain };

  const firstName = String(filters.firstName || "").trim();
  const lastName = String(filters.lastName || "").trim();
  const address = String(filters.address || "").trim();
  const city = String(filters.city || "").trim();
  const state = String(filters.state || "").trim();
  const zip = String(filters.zip || "").trim();

  if (!firstName && !lastName && !address && !city && !state && !zip) {
    return [];
  }
  if (firstName) query.firstName = new RegExp(`^${escapeRegex(firstName)}`, "i");
  if (lastName) query.lastName = new RegExp(`^${escapeRegex(lastName)}`, "i");
  if (address) query.address = new RegExp(escapeRegex(address), "i");
  if (city) query.city = new RegExp(`^${escapeRegex(city)}`, "i");
  if (state) query.state = new RegExp(`^${escapeRegex(state)}$`, "i");
  if (zip) query.zip = new RegExp(`^${escapeRegex(zip)}`);

  const limit = Math.min(Number(filters.limit) || 25, 100);
  return MailImport.find(query)
    .sort({ createdAt: -1, updatedAt: -1, _id: -1 })
    .limit(limit)
    .lean();
}

/**
 * Unified lookup for the CX center panel.
 *
 * When an operator picks up a call (or manually types a phone / case
 * id), the CX workspace wants a single "best known" view of the caller.
 * We walk the sources in authoritativeness order:
 *
 *   1. CaseProfile       — our own promoted case record. Has attribution,
 *                          payments, conversation summary. Trusted.
 *   2. MasterProspect    — pre-promotion lead identity. Richer than
 *                          cadence because it has Logics sync status,
 *                          full intake payload, status history.
 *   3. LeadCadence       — scheduled-action record. Narrow (mostly
 *                          schedule + normalized contact fields) but
 *                          useful when the lead is brand-new.
 *   4. Logics            — if none of the above, ask Logics by phone.
 *                          Only hits the network when the Mongo tiers
 *                          all miss.
 *
 * Returns `{ source, match, raw, lookupPhone, lookupCaseId }`. The
 * `match` is normalized to a small shape the UI form can bind to
 * regardless of which tier answered. `raw` is the tier's native
 * record for callers that want extra fields.
 *
 * A null match means "no record in any tier" — the UI treats that as
 * "new prospect, start with a blank form."
 */

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.slice(-10);
}

function normalizeDomain(value) {
  return String(value || "").trim().toUpperCase();
}

function splitName(fullName) {
  const trimmed = String(fullName || "").trim();
  if (!trimmed) return { firstName: null, lastName: null };
  const parts = trimmed.split(/\s+/);
  const firstName = parts[0] || null;
  const lastName = parts.slice(1).join(" ") || null;
  return { firstName, lastName };
}

/**
 * Normalize a record from any tier into the shape the UI form binds
 * to. Unset fields stay `null` so the form's placeholders render.
 */
function buildFormShape({
  firstName = null,
  lastName = null,
  name = null,
  email = null,
  phone = null,
  caseId = null,
  sourceName = null,
  intakeSource = null,
  status = null,
  notes = null,
} = {}) {
  const resolved = firstName || lastName
    ? { firstName: firstName || null, lastName: lastName || null }
    : splitName(name);
  return {
    firstName: resolved.firstName,
    lastName: resolved.lastName,
    email: email || null,
    phone: normalizePhone(phone) || null,
    caseId: caseId != null ? Number(caseId) : null,
    sourceName: sourceName || null,
    intakeSource: intakeSource || null,
    status: status || null,
    notes: notes || null,
  };
}

// ── Tier 1: CaseProfile ──────────────────────────────────────────────
async function tryCaseProfile({ domain, phone, caseId }) {
  let record = null;
  if (caseId != null) {
    record = await caseProfileRepository.findCaseProfile(domain, caseId);
  } else if (phone) {
    record = await caseProfileRepository.findCaseProfileByPhone(domain, phone);
  }
  if (!record) return null;
  const plain = typeof record.toObject === "function" ? record.toObject() : record;
  return {
    source: "caseProfile",
    match: buildFormShape({
      firstName: plain.firstName,
      lastName: plain.lastName,
      name: plain.name,
      email: plain.email,
      phone: plain.primaryPhone,
      caseId: plain.caseId,
      sourceName: plain.sourceName,
      intakeSource: plain.intakeSource,
      status: plain.statusLabel || plain.status,
      notes: plain.notes,
    }),
    raw: plain,
  };
}

// ── Tier 2: MasterProspect ───────────────────────────────────────────
async function tryMasterProspect({ domain, phone, caseId }) {
  let record = null;
  if (caseId != null) {
    record = await masterProspectRepository.findMasterProspect(domain, caseId);
  } else if (phone) {
    const digits = normalizePhone(phone);
    if (digits) {
      record = await masterProspectRepository.findMasterProspectByNormalizedPhone(
        domain,
        digits,
      );
    }
  }
  if (!record) return null;
  const plain = typeof record.toObject === "function" ? record.toObject() : record;
  return {
    source: "masterProspect",
    match: buildFormShape({
      firstName: plain.firstName,
      lastName: plain.lastName,
      name: plain.name,
      email: plain.email,
      phone: plain.cellPhone || plain.homePhone || plain.workPhone,
      caseId: plain.caseId,
      sourceName: plain.sourceName,
      intakeSource: plain.intakeSource || plain.metadata?.intakeSource,
      status: plain.statusLabelRaw || plain.statusCategory,
      notes: plain.notes,
    }),
    raw: plain,
  };
}

// ── Tier 3: LeadCadence ──────────────────────────────────────────────
async function tryLeadCadence({ domain, phone, caseId }) {
  let record = null;
  if (caseId != null) {
    record = await leadCadenceRepository.findLeadCadence(domain, caseId);
  } else if (phone) {
    record = await leadCadenceRepository.findLeadCadenceByPhone(domain, phone);
  }
  if (!record) return null;
  return {
    source: "leadCadence",
    match: buildFormShape({
      firstName: record.firstName,
      lastName: record.lastName,
      name: record.name,
      email: record.email,
      phone: record.normalizedPhone || record.primaryPhone,
      caseId: record.caseId,
      sourceName: record.sourceName,
      intakeSource: record.intakeSource,
      status: record.currentStage,
      notes: null,
    }),
    raw: record,
  };
}

// Pull a date out of a Logics case row for newest-first sorting. Logics
// returns a few different date field names depending on endpoint; check
// in priority order and fall back to 0 if none parse.
function extractLogicsDate(record) {
  const candidates = [
    record?.CaseCreatedDate,
    record?.CreatedDate,
    record?.CreateDate,
    record?.LastModifiedDate,
    record?.ModifiedDate,
  ];
  for (const c of candidates) {
    if (!c) continue;
    const t = new Date(c).getTime();
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

// ── Logics (authoritative tier) ───────────────────────────────────────
async function tryLogics({ domain, phone, caseId, logger }) {
  // Logics' findCaseByPhone REJECTS the +1 E.164 prefix with a 404 —
  // it only accepts plain 10-digit or formatted strings ("3106665997",
  // "(310)666-5997"). The 10-digit form matches everything Logics has
  // and avoids the format-sensitivity gotcha entirely.
  const tenDigit = phone ? normalizePhone(phone) : null;
  if (!tenDigit && caseId == null) return null;

  try {
    const client = createLogicsClient(domain);
    let payload = null;

    if (caseId != null) {
      payload = await client.getCaseInfo(caseId);
    } else if (tenDigit) {
      payload = await client.findCaseByPhone(tenDigit);
    }

    const data =
      payload?.data !== undefined && payload.data !== null
        ? payload.data
        : payload?.Data !== undefined && payload.Data !== null
          ? payload.Data
          : payload;

    // findCaseByPhone returns an array of every case sharing that
    // number — pick the freshest by CaseCreatedDate so the operator
    // lands on the most recent case for the caller, not whatever
    // Logics happened to order first.
    let record;
    if (Array.isArray(data)) {
      if (data.length === 0) return null;
      record = data
        .slice()
        .sort((a, b) => extractLogicsDate(b) - extractLogicsDate(a))[0];
    } else {
      record = data;
    }
    if (!record || typeof record !== "object") return null;

    return {
      source: "logics",
      match: buildFormShape({
        firstName: record.FirstName,
        lastName: record.LastName,
        email: record.Email,
        phone: record.CellPhone || record.HomePhone || record.WorkPhone,
        caseId: record.CaseID ?? record.caseId,
        sourceName: record.SourceName || record.sourceName,
        status:
          record.StatusLabel ||
          record.Status ||
          (record.StatusID != null ? `StatusID ${record.StatusID}` : null),
        notes: record.Notes || record.notes,
      }),
      raw: record,
    };
  } catch (error) {
    // 404 on Logics findCaseByPhone / getCaseInfo means "no record" —
    // not an error. Other failures degrade silently; the UI still
    // gets a null match and the operator starts from a blank form.
    if (error?.details?.responseStatus === 404) {
      return null;
    }
    logger?.warn?.("cx.lead_lookup.logics_error", {
      domain,
      phone,
      caseId,
      error: error.message,
    });
    return null;
  }
}

/**
 * Merge a Logics-primary `match` with whatever Mongo enrichment tiers
 * also had a row for the same caseId. Logics is authoritative for
 * identity (name, phone, email) and case state (status, caseId), so
 * those win. Mongo records contribute fields Logics typically lacks
 * (sourceName, intakeSource, internal notes).
 */
function mergeMatchWithEnrichments(primary, enrichments = {}) {
  if (!primary) return primary;
  const next = { ...primary };
  for (const tier of ["caseProfile", "masterProspect", "leadCadence"]) {
    const enr = enrichments[tier];
    if (!enr || !enr.match) continue;
    if (!next.sourceName && enr.match.sourceName) next.sourceName = enr.match.sourceName;
    if (!next.intakeSource && enr.match.intakeSource) next.intakeSource = enr.match.intakeSource;
    if (!next.notes && enr.match.notes) next.notes = enr.match.notes;
  }
  return next;
}

/**
 * Entry point. Either `phone` or `caseId` must be provided.
 *
 * Priority order (per domain, in fallback order):
 *   1. Logics — authoritative source for case identity + state
 *   2. After Logics matches, silently tie in our Mongo records
 *      (CaseProfile, MasterProspect, LeadCadence) by the resolved
 *      caseId; they decorate `enrichments` and fill in any fields
 *      Logics doesn't carry (sourceName, intakeSource, notes).
 *   3. If Logics misses across every fallback domain, FALL THROUGH
 *      to a Mongo-only walk per domain — catches the rare case where
 *      a Logics case was deleted but our record persists.
 *   4. If everything misses, return a blank shape so the UI can run
 *      "new prospect" mode (operator searches prospect index by name).
 *
 * @param {Object} args
 * @param {string} args.domain — primary domain to try first
 * @param {string[]} [args.domainFallback] — when set, walks every domain
 *   in order. The CX app uses this on inbound calls (default order is
 *   the caller's choice — typically ["WYNN", "TAG"] for the live setup).
 * @param {string} [args.phone] — 10-digit or E.164 tolerated
 * @param {number} [args.caseId] — Logics CaseID / our caseId
 * @param {Object} [args.logger]
 * @param {boolean} [args.skipLogics=false] — dev knob; skip the network
 */
async function lookupCxLead({
  domain,
  domainFallback = null,
  phone = null,
  caseId = null,
  logger = null,
  skipLogics = false,
  skipMongoFallback = false,
} = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const normalizedPhone = phone ? normalizePhone(phone) : null;
  const normalizedCaseId =
    caseId != null && Number.isFinite(Number(caseId)) ? Number(caseId) : null;

  if (!normalizedPhone && normalizedCaseId == null) {
    return {
      source: null,
      match: null,
      raw: null,
      lookupPhone: null,
      lookupCaseId: null,
      reason: "no-lookup-key",
    };
  }

  const domainsToTry = (() => {
    if (Array.isArray(domainFallback) && domainFallback.length > 0) {
      const seen = new Set();
      const out = [];
      for (const d of domainFallback) {
        const norm = normalizeDomain(d);
        if (!norm || seen.has(norm)) continue;
        seen.add(norm);
        out.push(norm);
      }
      return out;
    }
    return [normalizedDomain];
  })();

  // ── Tier 1: Logics-first walk across every fallback domain ────────
  if (!skipLogics) {
    for (const tryDomain of domainsToTry) {
      const lookupArgs = {
        domain: tryDomain,
        phone: normalizedPhone,
        caseId: normalizedCaseId,
        logger,
      };
      const logics = await tryLogics(lookupArgs);
      if (!logics) continue;

      // Resolve the caseId from the Logics record (or use the input)
      // so we can quietly tie any local Mongo rows we have for it.
      const resolvedCaseId =
        logics.match?.caseId != null
          ? Number(logics.match.caseId)
          : normalizedCaseId;
      const enrichArgs = {
        domain: tryDomain,
        phone: normalizedPhone,
        caseId: resolvedCaseId,
        logger,
      };
      const [caseProfileEnr, prospectEnr, cadenceEnr] = await Promise.all([
        tryCaseProfile(enrichArgs).catch(() => null),
        tryMasterProspect(enrichArgs).catch(() => null),
        tryLeadCadence(enrichArgs).catch(() => null),
      ]);
      const enrichments = {
        caseProfile: caseProfileEnr || null,
        masterProspect: prospectEnr || null,
        leadCadence: cadenceEnr || null,
      };

      return {
        ...logics,
        match: mergeMatchWithEnrichments(logics.match, enrichments),
        domain: tryDomain,
        enrichments,
        lookupPhone: normalizedPhone,
        lookupCaseId: resolvedCaseId,
        triedDomains: domainsToTry,
      };
    }
  }

  // ── Tier 2: Mongo-only fallback (Logics missed everywhere) ────────
  // Same domain order — preserves "WYNN first" preference even when
  // we degrade to local records only.
  if (skipMongoFallback) {
    return {
      source: "none",
      match: buildFormShape({ phone: normalizedPhone, caseId: normalizedCaseId }),
      raw: null,
      lookupPhone: normalizedPhone,
      lookupCaseId: normalizedCaseId,
      triedDomains: domainsToTry,
      reason: "logics-miss-skip-mongo",
    };
  }

  for (const tryDomain of domainsToTry) {
    const lookupArgs = {
      domain: tryDomain,
      phone: normalizedPhone,
      caseId: normalizedCaseId,
      logger,
    };

    const caseProfile = await tryCaseProfile(lookupArgs);
    if (caseProfile) {
      return {
        ...caseProfile,
        domain: tryDomain,
        enrichments: { caseProfile, masterProspect: null, leadCadence: null },
        lookupPhone: normalizedPhone,
        lookupCaseId: normalizedCaseId,
        triedDomains: domainsToTry,
      };
    }

    const prospect = await tryMasterProspect(lookupArgs);
    if (prospect) {
      return {
        ...prospect,
        domain: tryDomain,
        enrichments: { caseProfile: null, masterProspect: prospect, leadCadence: null },
        lookupPhone: normalizedPhone,
        lookupCaseId: normalizedCaseId,
        triedDomains: domainsToTry,
      };
    }

    const cadence = await tryLeadCadence(lookupArgs);
    if (cadence) {
      return {
        ...cadence,
        domain: tryDomain,
        enrichments: { caseProfile: null, masterProspect: null, leadCadence: cadence },
        lookupPhone: normalizedPhone,
        lookupCaseId: normalizedCaseId,
        triedDomains: domainsToTry,
      };
    }
  }

  // Nothing found anywhere — return a blank shape with the caller's
  // phone pre-filled so the UI can run "new prospect" mode.
  return {
    source: "none",
    match: buildFormShape({ phone: normalizedPhone, caseId: normalizedCaseId }),
    raw: null,
    lookupPhone: normalizedPhone,
    lookupCaseId: normalizedCaseId,
    triedDomains: domainsToTry,
    reason: "no-match",
  };
}

/**
 * Multi-candidate variant — returns EVERY phone match across both
 * domains × all tiers, so the CX UI can show "found this number in N
 * places, pick one" buttons. Avoids the auto-pick guesswork: when a
 * number is registered in multiple cases (TAG Mickey vs WYNN Mickey
 * vs old test record vs CaseProfile etc.), the operator gets a
 * single-click choice.
 *
 * Per (domain, tier) cell:
 *   • Logics:        top 3 by CaseCreatedDate desc — covers "freshest
 *                    plus a couple older for context"
 *   • CaseProfile:   0..1 (already sorted latest-first by repo)
 *   • MasterProspect: 0..1 (sorted latest-first)
 *   • LeadCadence:   0..1 (sorted latest-first)
 *
 * Domains are walked in `domainsToTry` order (the channel-driven
 * preference flows through to the order of returned candidates).
 *
 * @returns {Object}
 *   {
 *     candidates: Array<{
 *       key, domain, tier, caseId, name, firstName, lastName,
 *       email, phone, status, sourceName, intakeSource, notes,
 *       createdAt, raw
 *     }>,
 *     lookupPhone, triedDomains
 *   }
 */
async function findCxLeadCandidates({
  domain,
  domainFallback = null,
  phone = null,
  caseId = null,
  // Optional name+address criteria for the "no phone match — find by
  // other stuff" path. Used for mail-intake leads (NCOA / Lexis /
  // mail-house) where we don't have a phone yet. Searches MasterProspectIndex
  // across both domains and includes mailIntake context (lien, plaintiff,
  // address) so the operator can disambiguate.
  nameSearch = null,
  logger = null,
  skipLogics = false,
  // Default to "every Logics match per domain". 9/10 numbers resolve to
  // a single record so the candidate bar is normally one button — but
  // when a number is registered across many cases (e.g. test phones,
  // multi-case clients), we'd rather show them all than hide the right
  // one behind a hardcoded top-N slice. Cap is a high safety bound.
  logicsLimit = 50,
} = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const normalizedPhone = phone ? normalizePhone(phone) : null;
  const normalizedCaseId =
    caseId != null && Number.isFinite(Number(caseId)) ? Number(caseId) : null;

  const hasNameSearch =
    nameSearch &&
    typeof nameSearch === "object" &&
    Object.values(nameSearch).some(
      (v) => v != null && String(v).trim().length > 0,
    );

  if (!normalizedPhone && normalizedCaseId == null && !hasNameSearch) {
    return {
      candidates: [],
      lookupPhone: null,
      lookupCaseId: null,
      triedDomains: [],
      reason: "no-lookup-key",
    };
  }

  const domainsToTry = (() => {
    if (Array.isArray(domainFallback) && domainFallback.length > 0) {
      const seen = new Set();
      const out = [];
      for (const d of domainFallback) {
        const norm = normalizeDomain(d);
        if (!norm || seen.has(norm)) continue;
        seen.add(norm);
        out.push(norm);
      }
      return out;
    }
    return [normalizedDomain];
  })();

  const candidates = [];
  // Per-call cache for MailImport joins. The candidate build can
  // produce multiple rows for the same caseId (across tiers), and
  // we want one DB hit per case.
  const mailIntakeCache = new Map();

  for (const tryDomain of domainsToTry) {
    const lookupArgs = {
      domain: tryDomain,
      phone: normalizedPhone,
      caseId: normalizedCaseId,
      logger,
    };

    // Logics: pull every phone match, take top N by createDate
    if (!skipLogics) {
      try {
        const tenDigit = normalizedPhone || null;
        const client = createLogicsClient(tryDomain);
        let payload = null;
        if (normalizedCaseId != null) {
          payload = await client.getCaseInfo(normalizedCaseId);
        } else if (tenDigit) {
          payload = await client.findCaseByPhone(tenDigit);
        }
        const data =
          payload?.data !== undefined && payload.data !== null
            ? payload.data
            : payload?.Data !== undefined && payload.Data !== null
              ? payload.Data
              : payload;
        const arr = Array.isArray(data) ? data : data ? [data] : [];
        const sorted = arr
          .slice()
          .sort((a, b) => extractLogicsDate(b) - extractLogicsDate(a));
        for (const record of sorted.slice(0, Math.max(1, Number(logicsLimit) || 50))) {
          if (!record || typeof record !== "object") continue;
          const recCaseId = record.CaseID ?? record.caseId;
          candidates.push({
            key: `${tryDomain}:logics:${recCaseId ?? "unknown"}`,
            domain: tryDomain,
            tier: "logics",
            caseId: recCaseId != null ? Number(recCaseId) : null,
            firstName: record.FirstName || null,
            lastName: record.LastName || null,
            name: [record.FirstName, record.LastName].filter(Boolean).join(" ") || null,
            email: record.Email || null,
            phone: record.CellPhone || record.HomePhone || record.WorkPhone || null,
            status:
              record.StatusLabel ||
              record.Status ||
              (record.StatusID != null ? `StatusID ${record.StatusID}` : null),
            sourceName: record.SourceName || record.sourceName || null,
            intakeSource: null,
            notes: record.Notes || record.notes || null,
            createdAt:
              record.CaseCreatedDate ||
              record.CreatedDate ||
              record.CreateDate ||
              null,
            raw: record,
          });
        }
      } catch (error) {
        if (error?.details?.responseStatus !== 404) {
          logger?.warn?.("cx.lead_candidates.logics_error", {
            domain: tryDomain,
            phone: normalizedPhone,
            caseId: normalizedCaseId,
            error: error.message,
          });
        }
      }
    }

    // Mongo tiers — each repo's phone finder already sorts by latest.
    const cp = await tryCaseProfile(lookupArgs).catch(() => null);
    if (cp?.match?.caseId != null) {
      candidates.push({
        key: `${tryDomain}:caseProfile:${cp.match.caseId}`,
        domain: tryDomain,
        tier: "caseProfile",
        caseId: Number(cp.match.caseId),
        firstName: cp.match.firstName,
        lastName: cp.match.lastName,
        name: [cp.match.firstName, cp.match.lastName].filter(Boolean).join(" ") || null,
        email: cp.match.email,
        phone: cp.match.phone,
        status: cp.match.status,
        sourceName: cp.match.sourceName,
        intakeSource: cp.match.intakeSource,
        notes: cp.match.notes,
        createdAt: cp.raw?.createdAt || null,
        raw: cp.raw || null,
      });
    }
    const mp = await tryMasterProspect(lookupArgs).catch(() => null);
    if (mp?.match?.caseId != null) {
      // Pull mail-intake context from MailImport (the new home for
      // mail-house/NCOA address + lien metadata; MPI no longer
      // carries it). Falls back to anything still on the MP raw row
      // for backward compat with old orphan rows that haven't been
      // GC'd yet.
      const mailContext = await fetchMailIntakeContext(
        tryDomain,
        Number(mp.match.caseId),
        mailIntakeCache,
      );
      candidates.push({
        key: `${tryDomain}:masterProspect:${mp.match.caseId}`,
        domain: tryDomain,
        tier: "masterProspect",
        caseId: Number(mp.match.caseId),
        firstName: mp.match.firstName,
        lastName: mp.match.lastName,
        name: [mp.match.firstName, mp.match.lastName].filter(Boolean).join(" ") || null,
        email: mp.match.email,
        phone: mp.match.phone,
        status: mp.match.status,
        sourceName: mp.match.sourceName,
        intakeSource: mp.match.intakeSource,
        notes: mp.match.notes,
        address: mailContext?.address || mp.raw?.address || null,
        city: mailContext?.city || mp.raw?.city || null,
        state: mailContext?.state || mp.raw?.state || null,
        zip: mailContext?.zip || mp.raw?.zip || null,
        mailIntake: mailContext?.mailIntake || mp.raw?.mailIntake || null,
        createdAt: mailContext?.createdAt || mp.raw?.createdAt || null,
        raw: mp.raw || null,
      });
    }
    const lc = await tryLeadCadence(lookupArgs).catch(() => null);
    if (lc?.match?.caseId != null) {
      candidates.push({
        key: `${tryDomain}:leadCadence:${lc.match.caseId}`,
        domain: tryDomain,
        tier: "leadCadence",
        caseId: Number(lc.match.caseId),
        firstName: lc.match.firstName,
        lastName: lc.match.lastName,
        name: [lc.match.firstName, lc.match.lastName].filter(Boolean).join(" ") || null,
        email: lc.match.email,
        phone: lc.match.phone,
        status: lc.match.status,
        sourceName: lc.match.sourceName,
        intakeSource: lc.match.intakeSource,
        notes: lc.match.notes,
        createdAt: lc.raw?.createdAt || null,
        raw: lc.raw || null,
      });
    }
  }

  // Name + address search — only fires when the operator passed
  // `nameSearch` (the CX UI surfaces inputs for this when the phone
  // walk returned nothing). Walks every fallback domain so a TAG mail
  // intake comes back even if the operator was searching from a WYNN
  // session.
  if (hasNameSearch) {
    for (const tryDomain of domainsToTry) {
      try {
        const rows = await masterProspectRepository.searchMasterProspectByNameAddress(
          tryDomain,
          {
            firstName: nameSearch.firstName,
            lastName: nameSearch.lastName,
            address: nameSearch.address,
            city: nameSearch.city,
            state: nameSearch.state,
            zip: nameSearch.zip,
            limit: 25,
          },
        );
        for (const row of rows) {
          const rowCaseId = row.caseId != null ? Number(row.caseId) : null;
          if (rowCaseId == null) continue;

          // Dedup by (domain, caseId) — if any tier already produced a
          // candidate for this case, skip. Per the operator-stated
          // preference (CaseProfile > MasterProspect > LeadCadence),
          // we'd rather show one row per person than the same person
          // three times across tiers.
          const sameCase = candidates.find(
            (c) => c.domain === tryDomain && c.caseId === rowCaseId,
          );
          if (sameCase) continue;

          // Tier upgrade: if a CaseProfile exists for this caseId,
          // surface as caseProfile tier (the higher-priority record).
          // CaseProfile is our authoritative case shape, so its
          // identity wins display.
          let tier = "masterProspect";
          let cpRaw = null;
          let cpMatch = null;
          try {
            const cp = await tryCaseProfile({
              domain: tryDomain,
              caseId: rowCaseId,
              logger,
            });
            if (cp?.match?.caseId != null) {
              tier = "caseProfile";
              cpRaw = cp.raw;
              cpMatch = cp.match;
            }
          } catch {
            // Non-fatal — fall through to masterProspect tier.
          }

          if (tier === "caseProfile" && cpMatch) {
            candidates.push({
              key: `${tryDomain}:caseProfile:${rowCaseId}`,
              domain: tryDomain,
              tier: "caseProfile",
              caseId: rowCaseId,
              firstName: cpMatch.firstName,
              lastName: cpMatch.lastName,
              name:
                [cpMatch.firstName, cpMatch.lastName].filter(Boolean).join(" ") ||
                null,
              email: cpMatch.email,
              phone: cpMatch.phone,
              status: cpMatch.status,
              sourceName: cpMatch.sourceName,
              intakeSource: cpMatch.intakeSource,
              notes: cpMatch.notes,
              address: cpRaw?.address || row.address || null,
              city: cpRaw?.city || row.city || null,
              state: cpRaw?.state || row.state || null,
              zip: cpRaw?.zip || row.zip || null,
              mailIntake: row.mailIntake || null,
              createdAt: cpRaw?.createdAt || row.createdAt || null,
              raw: cpRaw || row,
            });
            continue;
          }

          candidates.push({
            key: `${tryDomain}:masterProspect:${rowCaseId}`,
            domain: tryDomain,
            tier: "masterProspect",
            caseId: rowCaseId,
            firstName: row.firstName,
            lastName: row.lastName,
            name:
              row.name ||
              [row.firstName, row.lastName].filter(Boolean).join(" ") ||
              null,
            email: row.email,
            phone: row.cellPhone || row.homePhone || row.workPhone || null,
            status: row.statusLabelRaw || row.statusCategory || null,
            sourceName: row.metadata?.intakeSource || null,
            intakeSource: row.metadata?.intakeSource || null,
            notes: null,
            address: row.address || null,
            city: row.city || null,
            state: row.state || null,
            zip: row.zip || null,
            mailIntake: row.mailIntake || null,
            createdAt: row.createdAt || null,
            raw: row,
          });
        }
      } catch (error) {
        logger?.warn?.("cx.lead_candidates.name_search_error", {
          domain: tryDomain,
          nameSearch,
          error: error.message,
        });
      }

      // Also search MailImport — mail-intake leads no longer land in
      // MPI, so the MP search above won't find new ones. Old orphan
      // MPI rows are still found by the MP path; new mail-house
      // returns are found here. Dedup against existing candidates by
      // (domain, caseId) so a tier-promoted lead doesn't show twice.
      try {
        const mailRows = await searchMailImportByNameAddress(tryDomain, {
          firstName: nameSearch.firstName,
          lastName: nameSearch.lastName,
          address: nameSearch.address,
          city: nameSearch.city,
          state: nameSearch.state,
          zip: nameSearch.zip,
          limit: 25,
        });
        for (const row of mailRows) {
          const rowCaseId = row.caseId != null ? Number(row.caseId) : null;
          if (rowCaseId == null) continue;
          const sameCase = candidates.find(
            (c) => c.domain === tryDomain && c.caseId === rowCaseId,
          );
          if (sameCase) {
            // Tier-promoted candidate already exists; just enrich its
            // mail-intake context so the operator gets the address +
            // lien-type tooltip even though we found it via tier 1/2/3.
            if (!sameCase.mailIntake && row.mailIntake) {
              sameCase.mailIntake = row.mailIntake;
              sameCase.address = sameCase.address || row.address || null;
              sameCase.city = sameCase.city || row.city || null;
              sameCase.state = sameCase.state || row.state || null;
              sameCase.zip = sameCase.zip || row.zip || null;
            }
            // Keep the cache hot for any other consumer in this pass.
            mailIntakeCache.set(`${tryDomain}:${rowCaseId}`, row);
            continue;
          }

          // No tier-1/2/3 candidate for this case — try CaseProfile
          // upgrade first (mail-intake leads often DO have a profile
          // after first contact), else surface as a plain mailImport
          // candidate so the operator can confirm the match and act.
          let tier = "mailImport";
          let cpRaw = null;
          let cpMatch = null;
          try {
            const cp = await tryCaseProfile({
              domain: tryDomain,
              caseId: rowCaseId,
              logger,
            });
            if (cp?.match?.caseId != null) {
              tier = "caseProfile";
              cpRaw = cp.raw;
              cpMatch = cp.match;
            }
          } catch {
            // non-fatal
          }

          mailIntakeCache.set(`${tryDomain}:${rowCaseId}`, row);
          candidates.push({
            key: `${tryDomain}:${tier}:${rowCaseId}`,
            domain: tryDomain,
            tier,
            caseId: rowCaseId,
            firstName: cpMatch?.firstName || row.firstName || null,
            lastName: cpMatch?.lastName || row.lastName || null,
            name:
              (cpMatch
                ? [cpMatch.firstName, cpMatch.lastName].filter(Boolean).join(" ")
                : [row.firstName, row.lastName].filter(Boolean).join(" ")) ||
              null,
            email: cpMatch?.email || null,
            phone: cpMatch?.phone || row.cellPhone || null,
            status: cpMatch?.status || null,
            sourceName: cpMatch?.sourceName || row.sourceName || null,
            intakeSource: cpMatch?.intakeSource || row.intakeRoute || "ncoa-upload",
            notes: cpMatch?.notes || null,
            address: cpRaw?.address || row.address || null,
            city: cpRaw?.city || row.city || null,
            state: cpRaw?.state || row.state || null,
            zip: cpRaw?.zip || row.zip || null,
            mailIntake: row.mailIntake || null,
            createdAt: cpRaw?.createdAt || row.createdAt || null,
            raw: cpRaw || row,
          });
        }
      } catch (error) {
        logger?.warn?.("cx.lead_candidates.mailimport_search_error", {
          domain: tryDomain,
          nameSearch,
          error: error.message,
        });
      }
    }
  }

  return {
    candidates,
    lookupPhone: normalizedPhone,
    lookupCaseId: normalizedCaseId,
    triedDomains: domainsToTry,
    nameSearch: hasNameSearch ? nameSearch : null,
  };
}

module.exports = {
  buildFormShape,
  findCxLeadCandidates,
  lookupCxLead,
  normalizePhone,
};
