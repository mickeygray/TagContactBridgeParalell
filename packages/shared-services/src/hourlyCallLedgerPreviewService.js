"use strict";

const { getCompanyKeys } = require("../../shared-config/src");
const { createCallrailClient } = require("../../shared-integrations/src");
const {
  callLogRepository,
  caseProfileRepository,
  masterProspectRepository,
  sourceCanonicalRepository,
} = require("../../shared-repositories/src");
const { createLogicsFacade } = require("./logicsFacadeService");
const { resolveSourceFromLegs } = require("./ringcentralAttributionService");
const { resolveCanonicalSource } = require("./sourceCanonicalService");

const DEFAULT_SINCE_MS = 60 * 60 * 1000;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const DEFAULT_CALLRAIL_MATCH_WINDOW_MS = 12 * 60 * 60 * 1000;

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

function normalizeDigits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.length === 11 && digits.startsWith("1")
    ? digits.slice(1)
    : digits.slice(-10);
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function buildPacificDateKey(value) {
  const date = toDate(value);
  if (!date) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function buildPreviewWindow(options = {}, now = new Date()) {
  const explicitFrom = toDate(options.from);
  const explicitTo = toDate(options.to);
  if (explicitFrom || explicitTo) {
    return {
      from: explicitFrom,
      to: explicitTo,
    };
  }

  const dateKey = String(options.date || "").trim();
  if (dateKey) {
    const from = new Date(`${dateKey}T00:00:00.000Z`);
    const to = new Date(`${dateKey}T23:59:59.999Z`);
    return {
      from: Number.isNaN(from.getTime()) ? null : from,
      to: Number.isNaN(to.getTime()) ? null : to,
    };
  }

  const sinceMs = Math.max(Number(options.sinceMs) || DEFAULT_SINCE_MS, 60 * 1000);
  return {
    from: new Date(now.getTime() - sinceMs),
    to: now,
  };
}

function resolveDomains(options = {}) {
  const requested = toArray(options.domains || options.domain)
    .map(normalizeDomain)
    .filter(Boolean);
  if (requested.length > 0) {
    return [...new Set(requested)];
  }
  if (options.allDomains) {
    return getCompanyKeys().map(normalizeDomain).filter(Boolean);
  }
  return ["TAG"];
}

function buildCandidateDomains(domain) {
  const normalizedDomain = normalizeDomain(domain);
  const others = getCompanyKeys()
    .map(normalizeDomain)
    .filter((value) => value && value !== normalizedDomain);
  return [normalizedDomain, ...others];
}

function emptyCaseBinding() {
  return {
    matched: false,
    matchedBy: "none",
    caseId: null,
    caseDomain: null,
    sourceCanonicalId: null,
    sourceName: null,
    sourceChannel: null,
    sourceId: null,
  };
}

function emptySourceBinding() {
  return {
    matched: false,
    matchedBy: "none",
    sourceCanonicalId: null,
    canonicalKey: null,
    sourceName: null,
    channel: null,
    trackingNumber: null,
    callrailCallId: null,
    startTime: null,
    confidence: "none",
    strategy: null,
  };
}

function buildCallLogOperation(entry, meta = {}) {
  return {
    collection: "CallLog",
    filter: {
      domain: normalizeDomain(entry.domain),
      telephonySessionId: String(entry.telephonySessionId),
    },
    update: {
      $set: entry,
    },
    meta,
  };
}

function mapCanonical(doc, meta = {}) {
  if (!doc) return emptySourceBinding();
  return {
    matched: true,
    matchedBy: meta.matchedBy || "canonical",
    sourceCanonicalId: doc._id ? String(doc._id) : null,
    canonicalKey: doc.canonicalKey || null,
    sourceName: doc.internalName || null,
    channel: doc.channel || null,
    trackingNumber: meta.trackingNumber || null,
    callrailCallId: meta.callrailCallId || null,
    startTime: meta.startTime || null,
    confidence: meta.confidence || "medium",
    strategy: meta.strategy || null,
  };
}

async function resolveExistingSourceBinding(row, defaultDomain) {
  if (row.sourceCanonicalId) {
    const canonical =
      await sourceCanonicalRepository.findSourceCanonicalById(row.sourceCanonicalId);
    if (canonical) {
      return mapCanonical(canonical, {
        matchedBy: "calllog",
        confidence: row.confidence || "medium",
        strategy: row.strategy || null,
      });
    }
  }

  if (row.mailPieceKey) {
    const canonical =
      await sourceCanonicalRepository.findSourceCanonicalByKey(row.mailPieceKey);
    if (canonical) {
      return mapCanonical(canonical, {
        matchedBy: "calllog-piece",
        confidence: row.confidence || "medium",
        strategy: row.strategy || null,
      });
    }
  }

  if (row.sourceName) {
    const canonical = await resolveCanonicalSource({
      domain: normalizeDomain(row.caseDomain || defaultDomain),
      internalName: row.sourceName,
      sourceName: row.sourceName,
      rawName: row.sourceName,
    }).catch(() => null);

    if (canonical?.doc) {
      return mapCanonical(canonical.doc, {
        matchedBy: "calllog-name",
        confidence: row.confidence || "medium",
        strategy: row.strategy || null,
      });
    }

    return {
      matched: true,
      matchedBy: "calllog-raw",
      sourceCanonicalId: null,
      canonicalKey: row.mailPieceKey || null,
      sourceName: row.sourceName,
      channel: row.sourceChannel || null,
      trackingNumber: null,
      callrailCallId: null,
      startTime: null,
      confidence: row.confidence || "low",
      strategy: row.strategy || null,
    };
  }

  return emptySourceBinding();
}

async function resolveSourceFromCaseBinding(caseBinding, defaultDomain) {
  if (!caseBinding?.matched) return emptySourceBinding();

  if (caseBinding.sourceCanonicalId) {
    const canonical =
      await sourceCanonicalRepository.findSourceCanonicalById(caseBinding.sourceCanonicalId);
    if (canonical) {
      return mapCanonical(canonical, {
        matchedBy: `${caseBinding.matchedBy}-source`,
        confidence: "medium",
        strategy: caseBinding.matchedBy === "caseprofile"
          ? "caseprofile"
          : caseBinding.matchedBy === "prior-calllog"
            ? "prior-calllog"
            : null,
      });
    }
  }

  if (caseBinding.sourceName || caseBinding.sourceId != null) {
    const canonical = await resolveCanonicalSource({
      domain: normalizeDomain(caseBinding.caseDomain || defaultDomain),
      sourceId: caseBinding.sourceId != null ? Number(caseBinding.sourceId) : null,
      internalName: caseBinding.sourceName,
      sourceName: caseBinding.sourceName,
      rawName: caseBinding.sourceName,
    }).catch(() => null);

    if (canonical?.doc) {
      return mapCanonical(canonical.doc, {
        matchedBy: `${caseBinding.matchedBy}-source`,
        confidence: "medium",
        strategy: caseBinding.matchedBy === "caseprofile"
          ? "caseprofile"
          : caseBinding.matchedBy === "prior-calllog"
            ? "prior-calllog"
            : null,
      });
    }
  }

  if (caseBinding.sourceName) {
    return {
      matched: true,
      matchedBy: `${caseBinding.matchedBy}-raw`,
      sourceCanonicalId: null,
      canonicalKey: null,
      sourceName: caseBinding.sourceName,
      channel: caseBinding.sourceChannel || null,
      trackingNumber: null,
      callrailCallId: null,
      startTime: null,
      confidence: "low",
      strategy: null,
    };
  }

  return emptySourceBinding();
}

async function findPriorResolvedCall(normalizedPhone, candidateDomains = []) {
  for (const candidateDomain of candidateDomains) {
    const hit = await callLogRepository.findLatestResolvedByPhone(
      candidateDomain,
      normalizedPhone,
      { minConfidence: "medium" },
    ).catch(() => null);
    if (hit) return hit;
  }
  return null;
}

async function resolveCaseBinding(row, candidateDomains = [], logger = null) {
  if (row.caseId != null) {
    return {
      matched: true,
      matchedBy: "calllog",
      caseId: Number(row.caseId),
      caseDomain: normalizeDomain(row.caseDomain || row.domain),
      sourceCanonicalId: row.sourceCanonicalId ? String(row.sourceCanonicalId) : null,
      sourceName: row.sourceName || null,
      sourceChannel: row.sourceChannel || null,
      sourceId: null,
    };
  }

  const normalizedPhone = normalizeDigits(row.normalizedPhone || row.phone);
  if (!normalizedPhone) {
    return emptyCaseBinding();
  }

  for (const candidateDomain of candidateDomains) {
    const caseProfile = await caseProfileRepository
      .findCaseProfileByPhone(candidateDomain, normalizedPhone)
      .catch(() => null);
    if (caseProfile?.caseId != null) {
      return {
        matched: true,
        matchedBy: "caseprofile",
        caseId: Number(caseProfile.caseId),
        caseDomain: candidateDomain,
        sourceCanonicalId: caseProfile.sourceCanonicalId
          ? String(caseProfile.sourceCanonicalId)
          : null,
        sourceName: caseProfile.sourceName || null,
        sourceChannel: null,
        sourceId: null,
      };
    }
  }

  for (const candidateDomain of candidateDomains) {
    const prospect = await masterProspectRepository
      .findMasterProspectByNormalizedPhone(candidateDomain, normalizedPhone)
      .catch(() => null);
    if (prospect?.caseId != null) {
      return {
        matched: true,
        matchedBy: "prospect",
        caseId: Number(prospect.caseId),
        caseDomain: candidateDomain,
        sourceCanonicalId: prospect.sourceCanonicalId
          ? String(prospect.sourceCanonicalId)
          : null,
        sourceName:
          prospect.metadata?.intakeSource ||
          prospect.sourceName ||
          null,
        sourceChannel: prospect.metadata?.intakeRoute || null,
        sourceId: prospect.sourceId != null ? Number(prospect.sourceId) : null,
      };
    }
  }

  const priorCallLog =
    await findPriorResolvedCall(normalizedPhone, candidateDomains);
  if (priorCallLog?.caseId != null) {
    return {
      matched: true,
      matchedBy: "prior-calllog",
      caseId: Number(priorCallLog.caseId),
      caseDomain: normalizeDomain(priorCallLog.caseDomain || priorCallLog.domain),
      sourceCanonicalId: priorCallLog.sourceCanonicalId
        ? String(priorCallLog.sourceCanonicalId)
        : null,
      sourceName: priorCallLog.sourceName || null,
      sourceChannel: priorCallLog.sourceChannel || null,
      sourceId: null,
    };
  }

  for (const candidateDomain of candidateDomains) {
    try {
      const facade = createLogicsFacade(candidateDomain);
      const result = await facade.findCaseByPhone(normalizedPhone);
      if (result.ok && Array.isArray(result.matches) && result.matches.length > 0) {
        const first = result.matches[0];
        return {
          matched: true,
          matchedBy: "logics",
          caseId: Number(first.caseId),
          caseDomain: candidateDomain,
          sourceCanonicalId: null,
          sourceName: first.sourceName || null,
          sourceChannel: null,
          sourceId: null,
        };
      }
    } catch (error) {
      logger?.warn?.("call-ledger.case_lookup_failed", {
        domain: candidateDomain,
        phone: normalizedPhone,
        error: error.message,
      });
    }
  }

  return emptyCaseBinding();
}

function mapCallrailCall(call = {}) {
  return {
    callId: call.id || null,
    customerPhoneNumber: call.customer_phone_number || null,
    trackingNumber:
      call.formatted_tracking_phone_number ||
      call.tracking_phone_number ||
      null,
    sourceName: call.source_name || call.source || null,
    startTime: call.start_time || null,
    direction: call.direction || null,
  };
}

async function listCallrailPhoneMatches(domain, normalizedPhone, cache, logger = null) {
  const cacheKey = `${normalizeDomain(domain)}::${normalizedPhone}`;
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  const promise = (async () => {
    const client = createCallrailClient(domain);
    const payload = await client.lookupInboundCallByPhone(normalizedPhone, {
      perPage: 10,
      dateRange: "this_month",
      order: "desc",
    });
    const calls = Array.isArray(payload.calls) ? payload.calls.map(mapCallrailCall) : [];
    return calls.filter(
      (call) => normalizeDigits(call.customerPhoneNumber) === normalizedPhone,
    );
  })().catch((error) => {
    logger?.warn?.("call-ledger.callrail_lookup_failed", {
      domain,
      phone: normalizedPhone,
      error: error.message,
    });
    return [];
  });

  cache.set(cacheKey, promise);
  return promise;
}

function pickBestCallrailMatch(calls = [], callStartTime) {
  if (!Array.isArray(calls) || calls.length === 0) return null;
  const targetTime = toDate(callStartTime);
  if (!targetTime) return calls[0] || null;

  const ranked = calls
    .map((call) => {
      const startedAt = toDate(call.startTime);
      const diffMs = startedAt
        ? Math.abs(startedAt.getTime() - targetTime.getTime())
        : Number.MAX_SAFE_INTEGER;
      return {
        call,
        diffMs,
        samePacificDate:
          buildPacificDateKey(startedAt) === buildPacificDateKey(targetTime),
      };
    })
    .sort((left, right) => {
      if (left.samePacificDate !== right.samePacificDate) {
        return left.samePacificDate ? -1 : 1;
      }
      return left.diffMs - right.diffMs;
    });

  const best = ranked[0];
  if (!best) return null;
  if (best.samePacificDate) return best.call;
  if (best.diffMs <= DEFAULT_CALLRAIL_MATCH_WINDOW_MS) return best.call;
  return null;
}

async function resolveSourceFromCallrail({
  domain,
  phone,
  callStartTime,
  candidateDomains = [],
  callrailCache,
  logger = null,
} = {}) {
  const normalizedPhone = normalizeDigits(phone);
  if (!normalizedPhone) return emptySourceBinding();

  const domains = [...new Set(candidateDomains.map(normalizeDomain).filter(Boolean))];
  for (const candidateDomain of domains) {
    const calls = await listCallrailPhoneMatches(
      candidateDomain,
      normalizedPhone,
      callrailCache,
      logger,
    );
    const best = pickBestCallrailMatch(calls, callStartTime);
    if (!best) continue;

    let canonical = null;
    if (best.trackingNumber) {
      canonical =
        await sourceCanonicalRepository.findSourceCanonicalByTrackingNumber(best.trackingNumber);
    }
    if (!canonical && best.sourceName) {
      const resolved = await resolveCanonicalSource({
        domain: candidateDomain,
        sourceName: best.sourceName,
        internalName: best.sourceName,
        rawName: best.sourceName,
        trackingNumber: best.trackingNumber,
      }).catch(() => null);
      canonical = resolved?.doc || null;
    }

    if (canonical) {
      return mapCanonical(canonical, {
        matchedBy: "callrail",
        trackingNumber: best.trackingNumber,
        callrailCallId: best.callId,
        startTime: best.startTime,
        confidence: "high",
        strategy: "callrail",
      });
    }

    return {
      matched: true,
      matchedBy: "callrail-raw",
      sourceCanonicalId: null,
      canonicalKey: null,
      sourceName: best.sourceName || best.trackingNumber || "callrail",
      channel: "callrail",
      trackingNumber: best.trackingNumber,
      callrailCallId: best.callId,
      startTime: best.startTime,
      confidence: "low",
      strategy: "callrail",
    };
  }

  return emptySourceBinding();
}

function buildGroupKey(sourceBinding) {
  return [
    String(sourceBinding.canonicalKey || "").trim().toLowerCase(),
    String(sourceBinding.sourceName || "").trim().toLowerCase(),
    String(sourceBinding.channel || "").trim().toLowerCase(),
  ].join("::");
}

function pushGroupedCall(groups, previewRow) {
  const key = buildGroupKey(previewRow.source);
  if (!groups.has(key)) {
    groups.set(key, {
      canonicalKey: previewRow.source.canonicalKey || null,
      piece: previewRow.source.sourceName || "Unknown",
      channel: previewRow.source.channel || "unknown",
      sourceCanonicalId: previewRow.source.sourceCanonicalId || null,
      totalCalls: 0,
      uniqueCaseIds: new Set(),
      calls: [],
    });
  }

  const entry = groups.get(key);
  entry.totalCalls += 1;
  if (previewRow.caseId != null) {
    entry.uniqueCaseIds.add(`${previewRow.caseDomain}:${previewRow.caseId}`);
  }
  entry.calls.push({
    telephonySessionId: previewRow.telephonySessionId,
    callStartTime: previewRow.callStartTime,
    phone: previewRow.phone,
    caseId: previewRow.caseId,
    caseDomain: previewRow.caseDomain,
    caseMatchedBy: previewRow.caseMatchedBy,
    sourceMatchedBy: previewRow.source.matchedBy,
    callrailTrackingNumber: previewRow.source.trackingNumber || null,
    confidence: previewRow.source.confidence || "none",
  });
}

function finalizeGroups(groups) {
  return [...groups.values()]
    .map((group) => ({
      canonicalKey: group.canonicalKey,
      piece: group.piece,
      channel: group.channel,
      sourceCanonicalId: group.sourceCanonicalId,
      totalCalls: group.totalCalls,
      uniqueCases: group.uniqueCaseIds.size,
      calls: group.calls.sort((left, right) => {
        const leftTime = new Date(left.callStartTime || 0).getTime();
        const rightTime = new Date(right.callStartTime || 0).getTime();
        return rightTime - leftTime;
      }),
    }))
    .sort((left, right) => {
      if (left.totalCalls !== right.totalCalls) {
        return right.totalCalls - left.totalCalls;
      }
      return String(left.piece || "").localeCompare(String(right.piece || ""));
    });
}

function buildCallLogPatch(row, previewRow, previewTimestamp) {
  const patch = {};

  if (row.caseId == null && previewRow.caseId != null) {
    patch.caseId = previewRow.caseId;
    patch.caseDomain = previewRow.caseDomain;
  }

  if (!row.sourceCanonicalId && previewRow.source.sourceCanonicalId) {
    patch.sourceCanonicalId = previewRow.source.sourceCanonicalId;
  }
  if (!row.sourceName && previewRow.source.sourceName) {
    patch.sourceName = previewRow.source.sourceName;
  }
  if (!row.sourceChannel && previewRow.source.channel) {
    patch.sourceChannel = previewRow.source.channel;
  }
  if (!row.mailPieceKey && previewRow.source.canonicalKey) {
    patch.mailPieceKey = previewRow.source.canonicalKey;
  }
  if (
    previewRow.caseId != null &&
    previewRow.source.matched &&
    row.status !== "resolved"
  ) {
    patch.status = "resolved";
    patch.resolvedAt = previewTimestamp;
    patch.resolverActor = "reconcile";
  }
  if (
    previewRow.source.confidence &&
    (row.confidence === "none" || !row.confidence)
  ) {
    patch.confidence = previewRow.source.confidence;
  }

  if (Object.keys(patch).length === 0) {
    return null;
  }

  return buildCallLogOperation(
    {
      domain: normalizeDomain(row.domain || previewRow.caseDomain),
      telephonySessionId: row.telephonySessionId,
      ...patch,
    },
    {
      caseMatchedBy: previewRow.caseMatchedBy,
      sourceMatchedBy: previewRow.source.matchedBy,
      priorStatus: row.status || null,
      priorConfidence: row.confidence || null,
    },
  );
}

async function previewCallLedgerForDomain(domain, options = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const previewTimestamp = options.previewTimestamp || new Date();
  const window = buildPreviewWindow(options, previewTimestamp);
  const limit = Math.min(
    Math.max(Number(options.limit) || DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  );
  const candidateDomains = buildCandidateDomains(normalizedDomain);
  const callrailCache = new Map();
  const groups = new Map();
  const operations = [];
  const unmatched = [];
  const errors = [];
  const stats = {
    callLogsScanned: 0,
    groupedCalls: 0,
    unmatchedCalls: 0,
    caseMatched: 0,
    caseFromCallLog: 0,
    caseFromHistory: 0,
    sourceMatched: 0,
    sourceFromCallLog: 0,
    sourceFromLegs: 0,
    sourceFromCallrail: 0,
    sourceFromHistory: 0,
    callrailLookups: 0,
    operations: 0,
    errors: 0,
  };

  const statuses = options.includePending
    ? ["resolved", "pending-retry"]
    : ["resolved"];
  const direction = options.direction || "inbound";

  const callLogs = await callLogRepository.listCallLogs(normalizedDomain, {
    limit,
    direction,
    statuses,
    callStartFrom: window.from,
    callStartTo: window.to,
  });

  for (const row of callLogs) {
    stats.callLogsScanned += 1;
    try {
      const caseBinding = await resolveCaseBinding(row, candidateDomains);
      if (caseBinding.matched) {
        stats.caseMatched += 1;
        if (caseBinding.matchedBy === "calllog") stats.caseFromCallLog += 1;
        else stats.caseFromHistory += 1;
      }

      let sourceBinding = await resolveExistingSourceBinding(row, normalizedDomain);
      if (sourceBinding.matched) {
        stats.sourceMatched += 1;
        stats.sourceFromCallLog += 1;
      }

      if (!sourceBinding.matched && Array.isArray(row.legsSnapshot) && row.legsSnapshot.length > 0) {
        const legsSource = await resolveSourceFromLegs(row.legsSnapshot).catch(() => null);
        if (legsSource?.matched) {
          sourceBinding = {
            matched: true,
            matchedBy: "calllog-legs",
            sourceCanonicalId: legsSource.sourceCanonicalId || null,
            canonicalKey: legsSource.canonicalKey || null,
            sourceName: legsSource.internalName || null,
            channel: legsSource.channel || null,
            trackingNumber: null,
            callrailCallId: null,
            startTime: null,
            confidence: "medium",
            strategy: legsSource.strategy || null,
          };
          stats.sourceMatched += 1;
          stats.sourceFromLegs += 1;
        }
      }

      if (!sourceBinding.matched) {
        stats.callrailLookups += 1;
        sourceBinding = await resolveSourceFromCallrail({
          domain: normalizedDomain,
          phone: row.normalizedPhone || row.phone,
          callStartTime: row.callStartTime,
          candidateDomains,
          callrailCache,
        });
        if (sourceBinding.matched) {
          stats.sourceMatched += 1;
          stats.sourceFromCallrail += 1;
        }
      }

      if (!sourceBinding.matched) {
        sourceBinding = await resolveSourceFromCaseBinding(caseBinding, normalizedDomain);
        if (sourceBinding.matched) {
          stats.sourceMatched += 1;
          stats.sourceFromHistory += 1;
        }
      }

      const previewRow = {
        telephonySessionId: String(row.telephonySessionId || ""),
        callStartTime: row.callStartTime || null,
        phone: row.phone || null,
        direction: row.direction || null,
        caseId: caseBinding.caseId,
        caseDomain: caseBinding.caseDomain,
        caseMatchedBy: caseBinding.matchedBy,
        source: sourceBinding,
        status: row.status || null,
      };

      if (previewRow.caseId != null && previewRow.source.matched) {
        pushGroupedCall(groups, previewRow);
        stats.groupedCalls += 1;
      } else {
        unmatched.push({
          telephonySessionId: previewRow.telephonySessionId,
          callStartTime: previewRow.callStartTime,
          phone: previewRow.phone,
          currentStatus: previewRow.status,
          caseId: previewRow.caseId,
          caseDomain: previewRow.caseDomain,
          caseMatchedBy: previewRow.caseMatchedBy,
          sourceMatchedBy: previewRow.source.matchedBy,
          piece: previewRow.source.sourceName || null,
          channel: previewRow.source.channel || null,
        });
        stats.unmatchedCalls += 1;
      }

      const operation = buildCallLogPatch(row, previewRow, previewTimestamp);
      if (operation) {
        operations.push(operation);
      }
    } catch (error) {
      stats.errors += 1;
      errors.push({
        telephonySessionId: row.telephonySessionId,
        error: error.message,
      });
    }
  }

  stats.operations = operations.length;

  const grouped = finalizeGroups(groups);
  const uniqueCases = new Set();
  for (const group of grouped) {
    for (const call of group.calls) {
      if (call.caseId != null) {
        uniqueCases.add(`${call.caseDomain}:${call.caseId}`);
      }
    }
  }

  return {
    domain: normalizedDomain,
    previewedAt: previewTimestamp,
    window: {
      from: window.from ? window.from.toISOString() : null,
      to: window.to ? window.to.toISOString() : null,
    },
    scan: stats,
    totals: {
      pieces: grouped.length,
      uniqueCases: uniqueCases.size,
      groupedCalls: stats.groupedCalls,
      unmatchedCalls: stats.unmatchedCalls,
    },
    groups: grouped,
    unmatched,
    operations,
    errors,
  };
}

async function previewHourlyCallLedger(options = {}) {
  const previewTimestamp = options.previewTimestamp || new Date();
  const domains = resolveDomains(options);
  const results = [];
  for (const domain of domains) {
    results.push(
      await previewCallLedgerForDomain(domain, {
        ...options,
        previewTimestamp,
      }),
    );
  }

  return {
    previewedAt: previewTimestamp,
    domains: results,
    summary: results.reduce(
      (accumulator, result) => {
        accumulator.domains += 1;
        accumulator.callLogsScanned += Number(result.scan.callLogsScanned || 0);
        accumulator.groupedCalls += Number(result.scan.groupedCalls || 0);
        accumulator.unmatchedCalls += Number(result.scan.unmatchedCalls || 0);
        accumulator.pieces += Number(result.totals.pieces || 0);
        accumulator.operations += Number(result.scan.operations || 0);
        accumulator.errors += Number(result.scan.errors || 0);
        return accumulator;
      },
      {
        domains: 0,
        callLogsScanned: 0,
        groupedCalls: 0,
        unmatchedCalls: 0,
        pieces: 0,
        operations: 0,
        errors: 0,
      },
    ),
  };
}

module.exports = {
  previewCallLedgerForDomain,
  previewHourlyCallLedger,
};
