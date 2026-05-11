"use strict";

const { getCompanyKeys } = require("../../shared-config/src");
const {
  callLogRepository,
  caseProfileRepository,
  masterProspectRepository,
  reviewQueueRepository,
  sourceCanonicalRepository,
} = require("../../shared-repositories/src");
const { lookupInboundCall } = require("./callrailLookupService");
const { createLogicsFacade } = require("./logicsFacadeService");
const {
  resolveSourceFromLegs,
  resolveSourceFromDid,
} = require("./ringcentralAttributionService");
const {
  resolveCanonicalSource,
} = require("./sourceCanonicalService");
const {
  promoteOrUpdateFromResolution,
} = require("./caseProfilePromotionService");
const {
  queueCallRecordingArchiveJob,
} = require("./recordingArchiveService");
const { emitServiceRequest } = require("./serviceRequestService");

/**
 * Form-based intake sources where Logics / MasterProspect carry the
 * authoritative source. These bypass the call-layer resolution because the
 * lead's source was captured at form submission, not on the phone.
 *
 * Anything not in this set (notably "mailer", "ABC", null, or unknown) has
 * to be resolved via CallRail or RC legs — Logics's source for those is the
 * generic tenant label.
 */
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

/**
 * Logics `SourceName` values that are too generic to use as attribution
 * on their own. When Logics says the source is one of these, we skip
 * the logics-source short-circuit and continue down the chain (CallRail
 * → legs → DID) to find the specific mailer piece.
 *
 * "ABC" is the tenant-level catch-all for all mailer traffic — it tells
 * us the lead came via mail but not which piece. Other tenant-specific
 * generic labels can be added via env `LOGICS_GENERIC_SOURCE_NAMES`
 * (comma-separated, case-insensitive).
 */
function parseGenericSourceNames() {
  const fromEnv = String(process.env.LOGICS_GENERIC_SOURCE_NAMES || "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  // Defaults: ABC is the tenant-level mailer catch-all; BCD is the
  // broadcast-dialer aggregator (same "came from a mailer but we don't
  // know which piece" problem). Both need refinement via CallRail/legs.
  const defaults = ["abc", "bcd"];
  return new Set([...defaults, ...fromEnv]);
}
const GENERIC_LOGICS_SOURCE_NAMES = parseGenericSourceNames();

function isGenericLogicsSource(sourceName) {
  if (!sourceName) return true;
  return GENERIC_LOGICS_SOURCE_NAMES.has(
    String(sourceName).trim().toLowerCase(),
  );
}

function normalizeDomain(domain) {
  return String(domain || "").toUpperCase();
}

function normalizeDigits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits.slice(-10);
}

function emptyResolution() {
  return {
    matched: false,
    strategy: "none",
    sourceCanonicalId: null,
    canonicalKey: null,
    internalName: "unknown",
    channel: "unknown",
    caseId: null,
    caseDomain: null,
    confidence: "none",
    attempts: {},
  };
}

async function findProspectCrossTenant(phone, domains, logger) {
  for (const domainKey of domains) {
    const dom = normalizeDomain(domainKey);
    try {
      const p =
        await masterProspectRepository.findMasterProspectByNormalizedPhone(
          dom,
          phone,
        );
      if (p) return { prospect: p, domain: dom };
    } catch (error) {
      logger?.warn?.("attribution.prospect_lookup_failed", {
        phone,
        domain: dom,
        error: error.message,
      });
    }
  }
  return null;
}

async function findCaseProfileCrossTenant(phone, domains, logger) {
  for (const domainKey of domains) {
    const dom = normalizeDomain(domainKey);
    try {
      const cp = await caseProfileRepository.findCaseProfileByPhone(dom, phone);
      if (cp) return { caseProfile: cp, domain: dom };
    } catch (error) {
      logger?.warn?.("attribution.caseprofile_lookup_failed", {
        phone,
        domain: dom,
        error: error.message,
      });
    }
  }
  return null;
}

async function findLogicsCrossTenant(phone, domains, logger) {
  for (const domainKey of domains) {
    const dom = normalizeDomain(domainKey);
    try {
      const facade = createLogicsFacade(dom);
      const result = await facade.findCaseByPhone(phone);
      if (result.ok && result.matches?.length > 0) {
        const first = result.matches[0];
        return {
          domain: dom,
          caseId: Number(first.caseId),
          firstName: first.firstName || null,
          lastName: first.lastName || null,
          name: first.name || null,
          email: first.email || null,
          cellPhone: first.cellPhone || null,
          homePhone: first.homePhone || null,
          workPhone: first.workPhone || null,
          statusId: first.statusId || null,
          sourceName: first.sourceName || null,
          // Age-related fields for the aged-data override path —
          // createdDate is when the lead was bought in Logics, saleDate
          // is when they signed (null for still-active prospects).
          createdDate: first.createdDate || null,
          saleDate: first.saleDate || null,
        };
      }
    } catch (error) {
      logger?.warn?.("attribution.logics_lookup_failed", {
        phone,
        domain: dom,
        error: error.message,
      });
    }
  }
  return null;
}

/**
 * Unified inbound call source resolver.
 *
 * Priority chain (first match wins; each step is tried only after prior
 * ones miss). CaseProfile is the authority when it exists — we never
 * relitigate a case that's already been attributed. Form-based intakes
 * short-circuit because Logics carries the real partner. Phone-originated
 * traffic flows through CallRail (primary for mail) then RC legs (backup
 * for dedicated-queue mailers) then DID.
 *
 *   1. CaseProfile by phone          → reuse existing attribution
 *   2. MasterProspect form-intake    → LD/affiliate/VF/web/social
 *   3. Prior CallLog by phone        → repeat caller, reuse last decision
 *   4. Logics findCaseByPhone        → bind caseId (if not already)
 *   5. CallRail lookup               → primary mail source authority
 *   6. RC legs[]                     → dedicated-queue backup
 *   7. DID fallback                  → last-resort tracking-number match
 *   8. None                          → write ReviewQueueItem alert if caseId
 *
 * Every resolution (including `none`) carries `caseId` + `caseDomain`
 * when they're bindable — that's the pass criterion for downstream
 * payment joins.
 */
async function resolveInboundCallSource({
  domain,
  customerPhone,
  record,
  telephonySessionId,
  extensionId = null,
  agentName = null,
  resolverActor = "live",
  logger = null,
}) {
  const normalizedDomain = normalizeDomain(domain);
  const tenDigit = normalizeDigits(customerPhone);
  const attempts = {};
  const companyKeys = getCompanyKeys();
  const candidateDomains = [
    normalizedDomain || companyKeys[0] || "TAG",
    ...companyKeys.filter((key) => normalizeDomain(key) !== normalizedDomain),
  ];

  let caseId = null;
  let caseDomain = null;

  // Pre-compute contact name from the record so both persistCallLog and
  // the promotion service pick it up. Direction-aware — for inbound we
  // want the caller's name, for outbound the callee's.
  const directionAtStart = pickDirection(record);
  const contactName = pickContactName(record, directionAtStart);

  const ctx = {
    inputDomain: normalizedDomain,
    customerPhone,
    record,
    telephonySessionId,
    extensionId,
    agentName,
    contactName,
    resolverActor,
    logger,
    caseDomainHint: null,
  };

  if (!tenDigit) {
    return finishResolution({ ...emptyResolution(), attempts }, ctx);
  }

  // ── 1. CaseProfile — already-attributed case wins every time ───────────
  const cpHit = await findCaseProfileCrossTenant(tenDigit, candidateDomains, logger);
  if (cpHit) {
    const cp = cpHit.caseProfile;
    caseId = cp.caseId;
    caseDomain = cpHit.domain;
    // CaseProfile carries the authoritative caseCreatedDate (captured
    // during earlier promotion); pull it onto ctx so the aged-data
    // flag can be computed without refetching CaseInfo.
    if (cp.caseCreatedDate) ctx.caseCreatedDate = cp.caseCreatedDate;
    attempts.caseProfile = {
      found: true,
      caseId,
      domain: caseDomain,
      hasSource: Boolean(cp.sourceCanonicalId),
      lockedManual: Boolean(cp.attribution?.lockedManual),
    };
    ctx.caseDomainHint = caseDomain;
    if (cp.sourceCanonicalId || cp.attribution?.lockedManual) {
      const canonical = cp.sourceCanonicalId
        ? await sourceCanonicalRepository.findSourceCanonicalById(
            cp.sourceCanonicalId,
          )
        : null;
      return finishResolution(
        {
          matched: true,
          strategy: "caseprofile",
          caseId,
          caseDomain,
          sourceCanonicalId: canonical ? String(canonical._id) : null,
          canonicalKey: canonical?.canonicalKey || null,
          internalName: canonical?.internalName || "unknown",
          channel: canonical?.channel || "unknown",
          confidence: cp.attribution?.lockedManual ? "high" : "medium",
          attempts,
        },
        ctx,
      );
    }
  } else {
    attempts.caseProfile = { found: false };
  }

  // ── 2. MasterProspect with form-based intake short-circuit ─────────────
  const mpHit = await findProspectCrossTenant(tenDigit, candidateDomains, logger);
  const prospect = mpHit?.prospect || null;
  if (prospect && !caseId) {
    caseId = prospect.caseId;
    caseDomain = mpHit.domain;
  }
  const intakeSource = prospect?.metadata?.intakeSource || null;
  attempts.prospect = {
    found: Boolean(prospect),
    caseId: prospect?.caseId || null,
    caseDomain: mpHit?.domain || null,
    intakeSource,
    shortCircuitable:
      Boolean(intakeSource) && SHORT_CIRCUIT_INTAKE_SOURCES.has(intakeSource),
  };

  if (
    prospect &&
    intakeSource &&
    SHORT_CIRCUIT_INTAKE_SOURCES.has(intakeSource)
  ) {
    const canonical = prospect.sourceCanonicalId
      ? await sourceCanonicalRepository.findSourceCanonicalById(
          prospect.sourceCanonicalId,
        )
      : null;
    ctx.caseDomainHint = caseDomain;
    return finishResolution(
      {
        matched: true,
        strategy: "prospect-intake",
        intakeSource,
        caseId,
        caseDomain,
        sourceCanonicalId: canonical ? String(canonical._id) : null,
        canonicalKey: canonical?.canonicalKey || null,
        internalName: canonical?.internalName || intakeSource,
        channel: canonical?.channel || intakeSource,
        confidence: "high",
        attempts,
      },
      ctx,
    );
  }

  // ── 3. Prior CallLog — repeat caller, reuse last medium+ decision ──────
  //
  // Every phone that's called before generated a CallLog row; if it was
  // resolved with medium+ confidence, trust that rather than re-running
  // the full chain. Saves API calls and keeps attribution stable across
  // repeat calls on the same number.
  //
  // Cross-tenant scan — same as earlier steps, in case the repeat
  // caller's prior CallLog lives in a different tenant than the
  // current inbound's domain.
  let priorCallLog = null;
  for (const domainKey of candidateDomains) {
    try {
      const hit = await callLogRepository.findLatestResolvedByPhone(
        normalizeDomain(domainKey),
        tenDigit,
        { minConfidence: "medium" },
      );
      if (hit) {
        priorCallLog = hit;
        break;
      }
    } catch {
      // Try next tenant; a failure on one shouldn't block the chain.
    }
  }
  attempts.priorCallLog = {
    found: Boolean(priorCallLog),
    sessionId: priorCallLog?.telephonySessionId || null,
    strategy: priorCallLog?.strategy || null,
    confidence: priorCallLog?.confidence || null,
  };
  if (priorCallLog?.sourceCanonicalId) {
    const finalDomain = priorCallLog.caseDomain || caseDomain;
    ctx.caseDomainHint = finalDomain;
    // Prior CallLog rows captured caseCreatedDateAtResolve the last
    // time the case was processed — reuse to avoid an extra Logics
    // fetch on repeat callers.
    if (priorCallLog.caseCreatedDateAtResolve && !ctx.caseCreatedDate) {
      ctx.caseCreatedDate = priorCallLog.caseCreatedDateAtResolve;
    }
    return finishResolution(
      {
        matched: true,
        strategy: "prior-calllog",
        caseId: priorCallLog.caseId || caseId,
        caseDomain: finalDomain,
        sourceCanonicalId: String(priorCallLog.sourceCanonicalId),
        // CallLog stores the canonical key as `mailPieceKey` — that's
        // the column the rest of the resolver treats as `canonicalKey`.
        canonicalKey: priorCallLog.mailPieceKey || null,
        internalName: priorCallLog.sourceName || "unknown",
        channel: priorCallLog.sourceChannel || "unknown",
        confidence: priorCallLog.confidence || "medium",
        attempts,
      },
      ctx,
    );
  }

  // ── 4. Logics findCaseByPhone — bind caseId ────────────────────────────
  //
  // Runs even when we already have a caseId (from prospect short-circuit)
  // because we'll also want the domain confirmed for the CaseInfo lookup
  // that follows. `findCaseByPhone` does NOT return a reliable
  // SourceName — Logics only populates that field on the full CaseInfo
  // response (via `CampaignSourceID`), which step 4b fetches below.
  let logicsHit = null;
  if (tenDigit) {
    logicsHit = await findLogicsCrossTenant(
      tenDigit,
      candidateDomains,
      logger,
    );
    if (logicsHit) {
      if (!caseId) {
        caseId = logicsHit.caseId;
        caseDomain = logicsHit.domain;
      }
      attempts.logics = logicsHit;
      // Stash for promotion service — lets us enrich the CaseProfile with
      // firstName/lastName/email from Logics when no MasterProspect row
      // is available to pull them from.
      ctx.logicsMatch = logicsHit;
    } else {
      attempts.logics = { found: false };
    }
  }

  // ── 4b. Logics source refinement via CaseInfo → CampaignSourceID ───────
  //
  // Once we have a caseId bound, fetch the full CaseInfo record. The
  // authoritative source reference lives on `CampaignSourceID` /
  // `SourceID` there (the `findCaseByPhone` shortcut doesn't return
  // those). Map the sourceId → SourceCanonical via the per-tenant
  // `sourceIds[]` on canonicals, then short-circuit if the resolved
  // canonical is NOT generic.
  //
  // Rule: "ABC" (and any LOGICS_GENERIC_SOURCE_NAMES additions) means
  // mailer-sourced but unspecified — keep going. Anything else
  // (Facebook, Google Ads, VF Google, …) is specific enough to use.
  if (caseId && caseDomain) {
    try {
      const facade = createLogicsFacade(caseDomain);
      const info = await facade.fetchCaseInfo(caseId);
      const data = info?.ok ? info.data : null;
      // Logics's field is `SourceCampaignID` on CaseInfo responses
      // (confirmed empirically). Legacy code also probed `SourceID` /
      // `SourceId` / `CampaignID` as fallbacks — kept them here because
      // older cases may predate the current schema.
      const logicsSourceId =
        data?.SourceCampaignID ||
        data?.CampaignSourceID ||
        data?.CampaignID ||
        data?.SourceID ||
        data?.SourceId ||
        null;
      // Capture the authoritative case creation date. CaseInfo's
      // CreatedDate is the lead-bought date; SaleDate is when they
      // signed (null for still-active prospects). Used downstream for
      // the aged-data override (outbound calls on a case >30 days old
      // attribute to "aged data" rather than the original mail piece).
      if (data?.CreatedDate) {
        ctx.caseCreatedDate = new Date(data.CreatedDate);
      }
      if (data?.SaleDate) {
        ctx.caseSaleDate = new Date(data.SaleDate);
      }
      attempts.logicsCaseInfo = {
        fetched: Boolean(data),
        campaignSourceId: logicsSourceId,
        caseCreatedDate: data?.CreatedDate || null,
        saleDate: data?.SaleDate || null,
      };
      if (logicsSourceId) {
        const canonical = await resolveCanonicalSource({
          domain: caseDomain,
          sourceId: Number(logicsSourceId),
        });
        attempts.logicsSource = {
          sourceId: logicsSourceId,
          matched: Boolean(canonical),
          canonicalKey: canonical?.canonicalKey || null,
          internalName: canonical?.internalName || null,
          generic: canonical
            ? isGenericLogicsSource(canonical.internalName)
            : null,
        };
        if (canonical && !isGenericLogicsSource(canonical.internalName)) {
          ctx.caseDomainHint = caseDomain;
          return finishResolution(
            {
              matched: true,
              strategy: "logics-source",
              caseId,
              caseDomain,
              sourceCanonicalId: canonical.doc?._id
                ? String(canonical.doc._id)
                : null,
              canonicalKey: canonical.canonicalKey,
              internalName: canonical.internalName,
              channel: canonical.channel,
              confidence: "high",
              attempts,
            },
            ctx,
          );
        }
      }
    } catch (error) {
      attempts.logicsCaseInfo = { fetched: false, error: error.message };
      logger?.warn?.("attribution.logics_caseinfo_failed", {
        caseId,
        caseDomain,
        error: error.message,
      });
    }
  }

  // ── 5. CallRail — primary source for phone-originated mail traffic ─────
  if (tenDigit) {
    try {
      const callrailResult = await lookupInboundCall(
        caseDomain || normalizedDomain,
        tenDigit,
      );
      const call = callrailResult?.call || null;
      attempts.callrail = {
        matched: Boolean(call),
        callId: call?.callId || null,
        source: call?.sourceName || null,
        tracker: call?.trackingNumber || null,
      };
      if (call) {
        const canonical = call.trackingNumber
          ? await sourceCanonicalRepository.findSourceCanonicalByTrackingNumber(
              call.trackingNumber,
            )
          : null;
        const sourceDomainHint =
          Array.isArray(canonical?.domains) && canonical.domains.length === 1
            ? canonical.domains[0]
            : null;
        ctx.caseDomainHint = caseDomain || sourceDomainHint || normalizedDomain;
        return finishResolution(
          {
            matched: true,
            strategy: "callrail",
            caseId,
            caseDomain,
            callrailId: call.callId,
            sourceCanonicalId: canonical ? String(canonical._id) : null,
            canonicalKey: canonical?.canonicalKey || null,
            internalName: canonical?.internalName || call.sourceName || "callrail",
            channel: canonical?.channel || "callrail",
            confidence: "high",
            attempts,
          },
          ctx,
        );
      }
    } catch (error) {
      attempts.callrail = { matched: false, error: error.message };
      logger?.warn?.("attribution.callrail_lookup_failed", {
        phone: tenDigit,
        error: error.message,
      });
    }
  }

  // ── 6. RC legs[] — dedicated-queue backup for mail that skipped CallRail
  if (record?.legs) {
    const legsResult = await resolveSourceFromLegs(record.legs);
    attempts.legs = {
      matched: legsResult.matched,
      legIndex: legsResult.legIndex,
      extensionId: legsResult.extensionId,
      canonicalKey: legsResult.canonicalKey || null,
    };
    if (legsResult.matched) {
      ctx.caseDomainHint = caseDomain || legsResult.domainHint || normalizedDomain;
      return finishResolution(
        {
          ...legsResult,
          caseId,
          caseDomain,
          confidence: "medium",
          attempts,
        },
        ctx,
      );
    }
  }

  // ── 7. DID fallback — tracking-number lookup on the to-number ─────────
  const didTarget = record?.to?.phoneNumber || null;
  if (didTarget) {
    const didResult = await resolveSourceFromDid(didTarget);
    attempts.did = {
      matched: didResult.matched,
      did: didResult.did,
      canonicalKey: didResult.canonicalKey || null,
    };
    if (didResult.matched) {
      ctx.caseDomainHint = caseDomain || didResult.domainHint || normalizedDomain;
      return finishResolution(
        {
          ...didResult,
          caseId,
          caseDomain,
          confidence: "low",
          attempts,
        },
        ctx,
      );
    }
  }

  // ── 8. No source matched ──────────────────────────────────────────────
  //
  // CallLog still gets a row (status=pending-retry); missing-source alert
  // is fired inside finishResolution when conditions warrant it (caseId
  // known + direction=inbound, agent dials are exempt).
  ctx.caseDomainHint = caseDomain || normalizedDomain;
  return finishResolution(
    {
      ...emptyResolution(),
      caseId,
      caseDomain,
      attempts,
    },
    ctx,
  );
}

async function persistSessionIdOnProspect(domain, caseId, telephonySessionId) {
  if (!caseId || !telephonySessionId) return;
  try {
    await masterProspectRepository.pushTelephonySessionId(
      domain,
      caseId,
      telephonySessionId,
    );
  } catch {
    // Non-fatal — the resolver still returned a good answer.
  }
}

function pickDirection(record) {
  const raw = String(record?.direction || "").toLowerCase();
  if (raw === "inbound" || raw === "outbound") return raw;
  return "unknown";
}

function pickCallerPhone(record, direction, fallback) {
  if (direction === "inbound") return record?.from?.phoneNumber || fallback;
  if (direction === "outbound") return record?.to?.phoneNumber || fallback;
  return record?.from?.phoneNumber || record?.to?.phoneNumber || fallback;
}

function pickContactName(record, direction) {
  if (direction === "inbound") return record?.from?.name || null;
  if (direction === "outbound") return record?.to?.name || null;
  return record?.from?.name || record?.to?.name || null;
}

const AGED_DATA_THRESHOLD_DAYS =
  Number(process.env.AGED_DATA_THRESHOLD_DAYS) || 30;
const AGED_DATA_THRESHOLD_MS = AGED_DATA_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;

/**
 * Compute whether an outbound call on this case is stale enough to be
 * attributed to "aged data" rather than the original mail piece.
 * Returns a flag only — the actual source override is applied later
 * (the aged-data reconciler knows which canonical to redirect to).
 */
function computeOutboundBufferAged({ result, ctx }) {
  const direction = pickDirection(ctx.record);
  if (direction !== "outbound") return { aged: false, caseCreatedDate: null };
  if (!result.caseId) return { aged: false, caseCreatedDate: null };
  const caseCreated = ctx.caseCreatedDate || null;
  if (!caseCreated) return { aged: false, caseCreatedDate: null };
  const callAt = ctx.record?.startTime
    ? new Date(ctx.record.startTime).getTime()
    : Date.now();
  const ageMs = callAt - new Date(caseCreated).getTime();
  return {
    aged: ageMs > AGED_DATA_THRESHOLD_MS,
    caseCreatedDate: caseCreated,
  };
}

/**
 * Persist the CallLog row for this resolution. Every resolver pass
 * writes one row (`resolved` if source was matched, `pending-retry`
 * otherwise). Upserted by `{domain, telephonySessionId}` so re-runs
 * (live → reconcile → end-of-day) update the same row in place.
 */
async function persistCallLog({ result, ctx }) {
  const {
    telephonySessionId,
    record,
    customerPhone,
    resolverActor,
    inputDomain,
  } = ctx;
  if (!telephonySessionId) return null;

  const direction = pickDirection(record);
  const phone = pickCallerPhone(record, direction, customerPhone);
  const contactName = pickContactName(record, direction);

  const domain = normalizeDomain(
    result.caseDomain || ctx.caseDomainHint || inputDomain || "TAG",
  );

  const durationSec =
    typeof record?.duration === "number" ? record.duration : null;
  const status = result.matched ? "resolved" : "pending-retry";
  const agedOutbound = computeOutboundBufferAged({ result, ctx });

  try {
    return await callLogRepository.upsertCallLog({
      domain,
      telephonySessionId: String(telephonySessionId),
      callSessionId: record?.sessionId || null,
      callStartTime: record?.startTime ? new Date(record.startTime) : null,
      callEndTime: record?.endTime
        ? new Date(record.endTime)
        : durationSec && record?.startTime
          ? new Date(new Date(record.startTime).getTime() + durationSec * 1000)
          : null,
      durationSec,
      missed:
        String(record?.result || "").toLowerCase() === "missed" ||
        String(record?.result || "").toLowerCase() === "voicemail",
      direction,
      phone: phone || null,
      contactName,
      extensionId: ctx.extensionId ? String(ctx.extensionId) : null,
      agentName: ctx.agentName || null,
      caseId: result.caseId ?? null,
      caseDomain: result.caseDomain || null,
      sourceCanonicalId: result.sourceCanonicalId || null,
      sourceName: result.internalName !== "unknown" ? result.internalName : null,
      sourceChannel: result.channel !== "unknown" ? result.channel : null,
      mailPieceKey: result.canonicalKey || null,
      strategy: result.strategy || "none",
      confidence: result.confidence || "none",
      status,
      resolvedAt: result.matched ? new Date() : null,
      resolverActor: resolverActor || "live",
      attempts: result.attempts || null,
      legsSnapshot: Array.isArray(record?.legs) ? record.legs : null,
      // Aged-data flag: outbound calls on a mailer-sourced case that's
      // more than AGED_DATA_THRESHOLD_DAYS past the case's CreatedDate.
      // The source is NOT overridden here — this just surfaces the
      // signal for the aged-data reconciler (a follow-up step) to flip
      // the attribution to the "aged data" canonical downstream.
      outboundBufferAged: agedOutbound.aged,
      caseCreatedDateAtResolve: agedOutbound.caseCreatedDate,
    });
  } catch (error) {
    // CallLog write is best-effort — the resolver's answer stands even
    // if persistence fails. But we log the warn so the error doesn't
    // vanish into thin air; the downstream promotion/back-link steps
    // get a null callLogId and won't run correctly, which is why we
    // need to know this happened.
    ctx.logger?.warn?.("calllog.persist_failed", {
      telephonySessionId,
      error: error.message,
    });
    return null;
  }
}

/**
 * Finalize a resolution: persist CallLog, push telephonySessionId onto
 * MasterProspect, optionally emit the missing-source alert, and return
 * the result unchanged. Every return path in `resolveInboundCallSource`
 * funnels through here to avoid duplication.
 */
async function finishResolution(result, ctx) {
  const callLogDoc = await persistCallLog({ result, ctx });

  if (callLogDoc) {
    await queueCallRecordingArchiveJob(callLogDoc).catch((error) => {
      ctx.logger?.warn?.("recording_archive.queue_failed", {
        telephonySessionId: ctx.telephonySessionId,
        error: error.message,
      });
      return null;
    });
  }

  // Note: we don't push telephonySessionId onto MasterProspect anymore.
  // When caseId is bound, the promotion service creates/updates the
  // CaseProfile with contactActivityIds (the canonical call history
  // for the case) and marks MP converted. When caseId is null, there's
  // no prospect row to update. Either way, the MP session array is
  // redundant with the CaseProfile's contactActivityIds.

  const direction = pickDirection(ctx.record);
  const isInbound = direction === "inbound" || direction === "unknown";

  // ── CaseProfile promotion + MasterProspect cleanup ──────────────────
  //
  // Any resolution that carries a caseId (even without source) triggers
  // the promotion path. If we have source too, attribution is written
  // first-touch. MasterProspect deletion happens inside the promotion
  // service once the profile exists.
  //
  // Outbound agent dials DO promote too — the case is real even if the
  // call's source is not attributable. We just skip the source write
  // for those (no sourceCanonicalId passed). That keeps agent outbound
  // calls in the contact history without mislabeling attribution.
  let promotion = null;
  if (result.caseId) {
    try {
      promotion = await promoteOrUpdateFromResolution({
        domain: ctx.inputDomain,
        caseId: result.caseId,
        caseDomain: result.caseDomain,
        telephonySessionId: ctx.telephonySessionId,
        callLogId: callLogDoc?._id || null,
        // Pass source through for ANY direction. Case-level strategies
        // (caseprofile / prospect-intake / prior-calllog / logics-source)
        // are valid regardless of the current call's direction. The
        // aged-data override for outbound calls on >30d cases is handled
        // downstream by the reconciler — we don't drop the source here.
        sourceCanonicalId: result.matched ? result.sourceCanonicalId || null : null,
        strategy: result.strategy,
        confidence: result.confidence,
        customerPhone: ctx.customerPhone,
        contactName: ctx.contactName || null,
        // Logics enrichment: firstName / lastName / email / phones. Used
        // as fallback when no MasterProspect row exists (common for cases
        // that live only in Logics but haven't been ingested).
        logicsEnrichment: ctx.logicsMatch || null,
        // Authoritative case creation date from Logics CaseInfo (if we
        // fetched it during step 4b). The promotion service persists
        // this on CaseProfile.caseCreatedDate — needed downstream by
        // the aged-data reconciler to decide when an outbound call
        // should attribute to "aged data" instead of the original
        // mail piece.
        caseCreatedDate: ctx.caseCreatedDate || null,
        caseSaleDate: ctx.caseSaleDate || null,
        logger: ctx.logger,
      });
    } catch (error) {
      ctx.logger?.warn?.("caseprofile.promotion_failed", {
        caseId: result.caseId,
        error: error.message,
      });
    }
  }
  if (promotion) {
    result.promotion = {
      action: promotion.action,
      caseProfileId: promotion.caseProfileId,
      attributionWritten: promotion.attributionWritten,
      prospectDeleted: promotion.prospectDeleted,
    };
  }

  if (!result.matched && result.caseId && isInbound) {
    await emitMissingSourceAlert({
      domain: result.caseDomain || ctx.inputDomain,
      caseId: result.caseId,
      caseDomain: result.caseDomain,
      phone: normalizeDigits(ctx.customerPhone),
      telephonySessionId: ctx.telephonySessionId,
      attempts: result.attempts,
      logger: ctx.logger,
    });
  }

  // ── Service-request emissions ──────────────────────────────────────
  //
  // Any incomplete outcome emits a structured event into the ledger so
  // the generalized sweeper (separate service, hourly) can work through
  // the backlog. One event per incomplete reason, deduped per session so
  // replays don't spam.
  await emitIncompleteEvents(result, ctx, isInbound);

  return result;
}

async function emitIncompleteEvents(result, ctx, isInbound) {
  // Skip if we don't even have a session id — nothing to track.
  if (!ctx.telephonySessionId) return;

  const domain = result.caseDomain || ctx.inputDomain || null;

  // 1. Attribution incomplete — inbound call, no source resolved. The
  //    sweeper retries the full chain later; RC call-log / CallRail
  //    often populate late.
  if (isInbound && !result.matched) {
    await emitServiceRequest({
      eventType: "attribution.retry-pending",
      telephonySessionId: ctx.telephonySessionId,
      domain,
      caseId: result.caseId,
      reason: "no-source-at-live-resolve",
      payload: {
        strategy: result.strategy,
        confidence: result.confidence,
        attempts: result.attempts,
      },
    });
  }

  // 2. Source resolved but caseId missing. Rare (inbound call from an
  //    unknown phone to a tracking DID) but real — the case might be
  //    created later by an agent, at which point we want to re-bind.
  if (result.matched && !result.caseId) {
    await emitServiceRequest({
      eventType: "attribution.case-binding-missing",
      telephonySessionId: ctx.telephonySessionId,
      domain,
      caseId: null,
      reason: "source-resolved-no-case",
      payload: {
        strategy: result.strategy,
        confidence: result.confidence,
        customerPhone: ctx.customerPhone || null,
      },
    });
  }

  // 3. Transcription + scoring pipeline — Outbound agent dials only.
  //    Scope matches the old app: we transcribe/score outbound calls
  //    for vendor-lead quality review, where the agent dialed a lead
  //    and we want to know if the lead vendor was sending real
  //    qualified prospects. The scoring rubric (contactability,
  //    legitimacy, tax_issue_present, interest_level, qualification)
  //    is written assuming that frame. Inbound mail calls have no
  //    equivalent "vendor quality" signal to score, so they don't
  //    get queued. If we ever want inbound QC, it needs its own
  //    rubric and its own eventType.
  //
  //    Delayed ~2 minutes (configurable) because RC needs time to
  //    finalize the recording after call end — fetching any earlier
  //    returns no_recording and burns sweeper cycles.
  const callDirection = pickDirection(ctx.record);
  if (result.matched && result.caseId && callDirection === "outbound") {
    const transcriptionDelayMs =
      Number(process.env.TRANSCRIPTION_EVENT_DELAY_MS) || 120_000;
    await emitServiceRequest({
      eventType: "calllog.transcription-pending",
      telephonySessionId: ctx.telephonySessionId,
      domain,
      caseId: result.caseId,
      reason: "pipeline-queued",
      delayMs: transcriptionDelayMs,
      payload: {
        direction: callDirection,
        extensionId: ctx.extensionId || null,
      },
      sourceService: "attribution-resolver",
    });
  }
}

/**
 * Create a review-queue item flagging a case that has a known caseId but
 * no resolved source. Shows up in the operator's review queue so they can
 * jump to client search and set the source manually. Dedupes per-case so
 * repeat calls for the same unresolved case don't spam the feed.
 */
async function emitMissingSourceAlert({
  domain,
  caseId,
  caseDomain,
  phone,
  telephonySessionId,
  attempts,
  logger,
}) {
  // Always use an uppercased, explicit domain in the dedupe key. Logics
  // caseIds are per-tenant, so a key like `missing-source::322058` (when
  // caseDomain is null) would dedupe across tenants and hide one tenant's
  // alert behind another's. Require the caller to supply a resolvable
  // domain — bail if neither is set.
  const alertDomain = normalizeDomain(caseDomain || domain);
  if (!alertDomain) {
    logger?.warn?.("attribution.missing_source_alert_skipped", {
      caseId,
      reason: "no-domain",
    });
    return;
  }
  try {
    await reviewQueueRepository.createReviewQueueItem({
      domain: alertDomain,
      sourceService: "attribution-resolver",
      workflow: "attribution-review",
      category: "source-attribution-missing",
      severity: "warning",
      title: `Missing source attribution for case ${caseId}`,
      summary: `Inbound call from ${phone} resolved to case ${caseId} (${alertDomain}) but no source could be attributed. Review in client search to set manually.`,
      caseId: Number(caseId),
      primaryPhone: phone || null,
      happenedAt: new Date(),
      payload: {
        phone,
        telephonySessionId,
        attempts,
      },
      tags: ["attribution", "needs-manual"],
      dedupeKey: `missing-source:${alertDomain}:${caseId}`,
    });
  } catch (error) {
    logger?.warn?.("attribution.missing_source_alert_failed", {
      caseId,
      error: error.message,
    });
  }
}

module.exports = {
  SHORT_CIRCUIT_INTAKE_SOURCES,
  emitMissingSourceAlert,
  resolveInboundCallSource,
};
