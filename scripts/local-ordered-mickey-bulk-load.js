"use strict";

const mongoose = require("mongoose");
const { getSharedConfig } = require("../packages/shared-config/src");
const { createRingcxVoiceClient } = require("../packages/shared-integrations/src");
const { CxBulkLoadSession, CxDialQueue } = require("../packages/shared-models/src");
const {
  buildBulkLeadLoaderPayload,
  toCandidatePublishPatch,
} = require("../packages/shared-services/src/cxBulkLoadRingcxPublisher");

const AGENT_EXTENSION_ID = "63730035004";
const AGENT_EMAIL = "mgray@taxadvocategroup.com";
const CX_AGENT_ID = "21018";
const ACCOUNT_ID = "50810001";
const CAMPAIGN_ID = "2306";
const DIAL_GROUP_ID = "963";
const AGENT_GROUP_ID = "2187";
const DOMAIN = "WYNN";
const CASE_ID = 101617;
const TEST_KEY = "mgray-simple-loop-bulk";

function readArgValue(names, fallback = null) {
  const flags = Array.isArray(names) ? names : [names];
  for (let i = 0; i < process.argv.length; i += 1) {
    const raw = String(process.argv[i] || "");
    for (const flag of flags) {
      if (raw === flag) return process.argv[i + 1] ?? fallback;
      if (raw.startsWith(`${flag}=`)) return raw.slice(flag.length + 1);
    }
  }
  return fallback;
}

function parsePositiveInteger(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function str(value) {
  return String(value == null ? "" : value).trim();
}

function normalizePhone(value) {
  const digits = str(value).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length >= 10) return digits.slice(-10);
  return "";
}

const PHONE = normalizePhone(
  process.env.CX_BULK_MICKEY_TEST_PHONE ||
    process.env.PARALLEL_TEST_PHONE ||
    process.env.DEPLOY_PANEL_PHONE ||
    "13106665997",
);
if (!PHONE) throw new Error("Missing CX bulk Mickey test phone");

function legacyExternFor(row) {
  return `cxbl-${DOMAIN}-${String(row._id)}`.toLowerCase();
}

function externFor(row, sessionId) {
  const token = str(sessionId).replace(/^cxbl-ordered-/i, "").replace(/[^a-z0-9]/gi, "").slice(-12) || Date.now();
  return `cxbl-${DOMAIN}-${token}-${String(row._id).slice(-8)}`.toLowerCase();
}

function rowCaseId(row) {
  return Number(row?.caseId) || CASE_ID;
}

function candidateFromRow(row, sessionId) {
  return {
    queueItemId: String(row._id),
    domain: DOMAIN,
    caseId: rowCaseId(row),
    name: row.name,
    phone: PHONE,
    phoneLast4: PHONE.slice(-4),
    externId: externFor(row, sessionId),
  };
}

function acceptedCandidate(candidate, result) {
  const nowIso = new Date().toISOString();
  return {
    ...candidate,
    phase: "accepted",
    status: "accepted",
    ringcx: {
      campaignId: CAMPAIGN_ID,
      dialGroupId: DIAL_GROUP_ID,
      accountId: ACCOUNT_ID,
      externId: candidate.externId,
      loadSummary: result || null,
      acceptedAt: nowIso,
    },
    campaignId: CAMPAIGN_ID,
    dialGroupId: DIAL_GROUP_ID,
    accountId: ACCOUNT_ID,
    acceptedAt: nowIso,
  };
}

async function cancelKnownTestCopies(client, rows, sessions) {
  const externIds = new Set();
  for (const session of sessions) {
    if (session.current?.externId) externIds.add(session.current.externId);
    for (const item of session.acceptedBuffer || []) if (item.externId) externIds.add(item.externId);
    for (const item of session.completed || []) if (item.externId) externIds.add(item.externId);
  }
  for (const row of rows) {
    externIds.add(legacyExternFor(row));
    if (row.metadata?.lastRingcxPublishedExternId) externIds.add(row.metadata.lastRingcxPublishedExternId);
    if (row.metadata?.rcxVisibilityExternId) externIds.add(row.metadata.rcxVisibilityExternId);
  }
  const list = [...externIds].filter(Boolean);
  if (!list.length) return null;
  return client.leadAction("CANCEL_LEADS", {
    campaignLeadSearchCriteria: { campaignId: CAMPAIGN_ID, campaignIds: [CAMPAIGN_ID], externIds: list },
    leadActionParams: {},
  }).catch((error) => ({ error: error.message || String(error), externIds: list.length }));
}

async function normalizeLocalTestProfiles(rows, now) {
  const caseIds = Array.from(new Set(rows.map(rowCaseId).filter(Boolean)));
  if (!caseIds.length) return;
  const profileCollection = mongoose.connection.db.collection("controlplanecaseprofiles");
  for (const caseId of caseIds) {
    await profileCollection.updateOne(
      { domain: DOMAIN, caseId },
      {
        $set: {
          domain: DOMAIN,
          caseId,
          statusId: 2,
          statusCategory: "prospect",
          statusLabelRaw: "Opened",
          active: true,
          firstName: "Mickey",
          lastName: "Gray",
          name: "Mickey Gray",
          primaryPhone: PHONE,
          normalizedPhones: [PHONE],
          updatedAt: now,
          "metadata.localBulkTestNormalizedAt": now.toISOString(),
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );
  }
}

async function resetRows(rows, now, sessionId) {
  let seq = 0;
  for (const row of rows) {
    const label = String(++seq).padStart(2, "0");
    const caseId = rowCaseId(row);
    await CxDialQueue.updateOne({ _id: row._id }, { $set: {
      domain: DOMAIN,
      caseId,
      name: `Mickey Gray ${label}`,
      phone: PHONE,
      state: "claimed",
      releaseAt: new Date(Date.now() - 1000),
      claimUntil: null,
      lastPlacedAt: null,
      cancelledAt: null,
      completedAt: null,
      lastClaimedAt: now,
      "assignment.extensionId": null,
      "assignment.agentName": null,
      "assignment.assignedAt": null,
      "metadata.actionKey": `mickey-test:${TEST_KEY}:${caseId}:${label}`,
      "metadata.manualDialTest": TEST_KEY,
      "metadata.bulkLoadTest": true,
      "metadata.testLead": true,
      "metadata.testLogicsCaseId": caseId,
      "metadata.testLogicsDomain": DOMAIN,
      "metadata.cancelReason": null,
      "metadata.cancelledAt": null,
      "metadata.reservationSessionId": sessionId,
      "metadata.reservedAt": now,
      "metadata.reservationExpiresAt": null,
      "metadata.bulkLoadSessionId": sessionId,
      "metadata.bulkLoadPublishedAt": null,
      "metadata.bulkLoadActiveAt": null,
      "metadata.bulkLoadRuntime": "bulk_load_ordered",
      "metadata.lastRingcxPublishedAt": null,
      "metadata.lastRingcxPublishedCampaignId": null,
      "metadata.lastRingcxPublishedDialGroupId": null,
      "metadata.lastRingcxPublishedExternId": null,
      "metadata.rcxVisibilityStatus": null,
      "metadata.rcxVisibilityReason": null,
      "metadata.rcxVisibilityExternId": null,
      "metadata.rcxVisibilityCampaignId": null,
      "metadata.rcxVisibilityPublishedAt": null,
      "metadata.rcxVisibilityCancelledAt": null,
      "metadata.rcxVisibilityCancelAttemptAt": null,
      "metadata.rcxVisibilityCancelResponse": null,
      "metadata.rcxVisibilityCancelError": null,
      "metadata.lastDialExecutionUii": null,
      "metadata.lastQueueAttemptUii": null,
      "metadata.lastQueueAttemptAt": null,
      "metadata.lastDialExecutionSource": null,
      "metadata.assignedExtensionId": null,
      "metadata.lastDialIntentStatus": "bulk-load-order-reserved",
      "metadata.lastQueueAttemptHeldForDisposition": false,
      "metadata.wrapUpRequired": false,
      "metadata.wrapUpReason": null,
      "metadata.servingAt": null,
      "metadata.lastReleaseReason": null,
      "metadata.lastReleasedAgentName": null,
      "metadata.lastReleasedAt": null,
      "metadata.lastReleasedBy": null,
      "metadata.lastReleasedExtensionId": null,
      "metadata.lastRingcxReleaseCancel": null,
      "metadata.lastRingcxReleaseCancelAt": null,
      "metadata.lastTerminalOutcome": null,
      "metadata.lastTerminalOutcomeNormalized": null,
      "metadata.lastTerminalOutcomeIgnoredReason": null,
      "metadata.lastTerminalOutcomeIgnoredAt": null,
    } });
  }
}

async function main() {
  const config = getSharedConfig();
  await mongoose.connect(config.mongoUri, { dbName: config.parallelDbName });
  const client = createRingcxVoiceClient();
  const now = new Date();
  const requestedCount = parsePositiveInteger(readArgValue(["--count", "--limit", "-n"]), null);

  const oldSessions = await CxBulkLoadSession.find({ agentExtensionId: AGENT_EXTENSION_ID }).lean();
  const rowsToCancel = await CxDialQueue.find({
    $or: [
      { "metadata.manualDialTest": TEST_KEY },
      { "metadata.testLead": true, phone: PHONE },
      { phone: PHONE, caseId: CASE_ID },
      { name: /^Mickey/i, phone: PHONE },
    ],
  }).sort({ createdAt: 1, _id: 1 }).lean();
  const allRowsToLoad = await CxDialQueue.find({ "metadata.manualDialTest": TEST_KEY }).sort({ createdAt: 1, _id: 1 }).lean();
  const rowsToLoad = requestedCount ? allRowsToLoad.slice(0, requestedCount) : allRowsToLoad;
  if (!rowsToLoad.length) {
    throw new Error(`No Mickey ordered bulk source rows found for tag ${TEST_KEY}`);
  }
  const rowIdsToLoad = rowsToLoad.map((row) => row._id);
  const sessionId = `cxbl-ordered-${Date.now()}`;
  const cancelResult = await cancelKnownTestCopies(client, rowsToCancel, oldSessions);
  await sleep(750);
  if (requestedCount && allRowsToLoad.length > rowsToLoad.length) {
    const skippedIds = allRowsToLoad
      .slice(rowsToLoad.length)
      .map((row) => row._id)
      .filter(Boolean);
    if (skippedIds.length) {
      await CxDialQueue.updateMany(
        { _id: { $in: skippedIds }, "metadata.manualDialTest": TEST_KEY },
        {
          $set: {
            state: "cancelled",
            cancelledAt: now,
            "metadata.reservationSessionId": null,
            "metadata.reservedAt": null,
            "metadata.reservationExpiresAt": null,
            "metadata.bulkLoadSessionId": null,
            "metadata.bulkLoadPublishedAt": null,
            "metadata.bulkLoadRuntime": null,
            "metadata.lastRingcxPublishedAt": null,
            "metadata.lastRingcxPublishedCampaignId": null,
            "metadata.lastRingcxPublishedDialGroupId": null,
            "metadata.lastRingcxPublishedExternId": null,
            "metadata.lastReleaseReason": "ordered-loader-count-trim",
            "metadata.lastReleasedAt": now,
            "metadata.lastReleasedBy": "local-ordered-mickey-bulk-load",
            "metadata.lastReleasedExtensionId": AGENT_EXTENSION_ID,
            "metadata.dialRuntimeClearedAt": now,
            "metadata.dialRuntimeClearedReason": "ordered-loader-count-trim",
          },
        },
      );
    }
  }

  await CxBulkLoadSession.updateMany(
    { agentExtensionId: AGENT_EXTENSION_ID, status: "running" },
    { $set: { status: "killed", phase: "released", current: null, acceptedBuffer: [], lastError: "ordered-loader-reset", killedAt: now } },
  );
  await normalizeLocalTestProfiles(rowsToLoad, now);
  await resetRows(rowsToLoad, now, sessionId);

  const rows = await CxDialQueue.find({ _id: { $in: rowIdsToLoad } }).sort({ name: 1 }).lean();
  await CxBulkLoadSession.create({
    sessionId,
    status: "running",
    phase: "preloading",
    agentEmail: AGENT_EMAIL,
    agentExtensionId: AGENT_EXTENSION_ID,
    cxAgentId: CX_AGENT_ID,
    domain: DOMAIN,
    ringcx: {
      accountId: ACCOUNT_ID,
      campaignId: CAMPAIGN_ID,
      dialGroupId: DIAL_GROUP_ID,
      agentGroupId: AGENT_GROUP_ID,
      dialPriority: "NORMAL",
      orderedLoader: true,
    },
    current: null,
    acceptedBuffer: [],
    completed: [],
    stats: { targetSize: rows.length, refillThreshold: 5, orderedLoadStartedAt: now.toISOString() },
    trace: { loader: "one-at-a-time-wait-for-response" },
    lastError: null,
  });

  const acceptedBuffer = [];
  const results = [];
  let index = 0;
  for (const row of rows) {
    index += 1;
    const candidate = candidateFromRow(row, sessionId);
    const started = Date.now();
    const payload = buildBulkLeadLoaderPayload([candidate], { dialPriority: "NORMAL" });
    payload.description = `Parallel CX ordered load ${index}/${rows.length} (${candidate.externId})`;

    let result = null;
    let ok = false;
    let error = null;
    try {
      result = await client.loadLeads(CAMPAIGN_ID, payload);
      const patch = toCandidatePublishPatch(result, [candidate]);
      ok = patch.accepted.length === 1;
      if (!ok) error = patch.rejected[0]?.reason || result?.processingStatus || "rejected";
    } catch (err) {
      error = err.message || String(err);
    }

    const elapsedMs = Date.now() - started;
    if (ok) {
      const accepted = acceptedCandidate(candidate, result);
      acceptedBuffer.push(accepted);
      await CxDialQueue.updateOne({ _id: row._id }, { $set: {
        state: "claimed",
        claimUntil: null,
        lastPlacedAt: null,
        lastClaimedAt: new Date(),
        "metadata.reservationSessionId": sessionId,
        "metadata.bulkLoadSessionId": sessionId,
        "metadata.bulkLoadPublishedAt": new Date(),
        "metadata.bulkLoadRuntime": "bulk_load_ordered",
        "metadata.lastRingcxPublishedAt": new Date(),
        "metadata.lastRingcxPublishedCampaignId": CAMPAIGN_ID,
        "metadata.lastRingcxPublishedDialGroupId": DIAL_GROUP_ID,
        "metadata.lastRingcxPublishedExternId": candidate.externId,
        "metadata.rcxVisibilityStatus": null,
        "metadata.rcxVisibilityReason": null,
        "metadata.rcxVisibilityExternId": null,
        "metadata.rcxVisibilityCampaignId": null,
        "metadata.rcxVisibilityPublishedAt": null,
        "metadata.rcxVisibilityCancelledAt": null,
        "metadata.rcxVisibilityCancelAttemptAt": null,
        "metadata.rcxVisibilityCancelResponse": null,
        "metadata.rcxVisibilityCancelError": null,
        "metadata.lastQueueAttemptAt": null,
        "metadata.assignedExtensionId": null,
        "metadata.lastDialIntentStatus": "bulk-loaded-ordered",
        "metadata.lastQueueAttemptHeldForDisposition": false,
        "metadata.wrapUpRequired": false,
      } });
    } else {
      await CxDialQueue.updateOne({ _id: row._id }, { $set: {
        state: "ready",
        claimUntil: null,
        "metadata.reservationSessionId": null,
        "metadata.reservedAt": null,
        "metadata.reservationExpiresAt": null,
        "assignment.extensionId": AGENT_EXTENSION_ID,
        "metadata.bulkLoadSessionId": sessionId,
        "metadata.lastRingcxPublishedExternId": candidate.externId,
        "metadata.lastDialIntentStatus": "ordered-load-failed",
        "metadata.lastDialIntentError": error,
      } });
    }

    results.push({ index, name: row.name, externId: candidate.externId, ok, elapsedMs, processingStatus: result?.processingStatus || null, error });
    await CxBulkLoadSession.updateOne({ sessionId }, { $set: {
      acceptedBuffer,
      phase: acceptedBuffer.length > 0 ? "ready" : "preloading",
      stats: {
        targetSize: rows.length,
        refillThreshold: 5,
        orderedLoadStartedAt: now.toISOString(),
        orderedAcceptedCount: acceptedBuffer.length,
        orderedAttemptedCount: index,
        lastLoadElapsedMs: elapsedMs,
      },
      trace: {
        loader: "one-at-a-time-wait-for-response",
        lastLoadedExternId: candidate.externId,
        lastLoadOk: ok,
        lastLoadAt: new Date().toISOString(),
      },
      lastError: ok ? null : error,
    } });
    await sleep(150);
  }

  await CxBulkLoadSession.updateOne({ sessionId }, { $set: {
    acceptedBuffer,
    phase: acceptedBuffer.length > 0 ? "ready" : "failed",
    stats: {
      targetSize: rows.length,
      refillThreshold: 5,
      orderedAcceptedCount: acceptedBuffer.length,
      orderedAttemptedCount: rows.length,
      orderedLoadCompletedAt: new Date().toISOString(),
      orderedLoadTotalMs: results.reduce((sum, row) => sum + row.elapsedMs, 0),
    },
    trace: { loader: "one-at-a-time-wait-for-response", completedAt: new Date().toISOString() },
    lastError: acceptedBuffer.length === rows.length ? null : "some-ordered-loads-failed",
  } });

  const active = await client.listActiveCalls({ product: "ACCOUNT", productId: ACCOUNT_ID }).catch(() => null);
  const activeRecords = Array.isArray(active?.records)
    ? active.records
    : Array.isArray(active)
      ? active
      : Array.isArray(active?.data)
        ? active.data
        : [];

  console.log(JSON.stringify({
    sessionId,
    cancelResult,
    attempted: rows.length,
    accepted: acceptedBuffer.length,
    failed: results.filter((row) => !row.ok).length,
    totalRequestMs: results.reduce((sum, row) => sum + row.elapsedMs, 0),
    firstFive: results.slice(0, 5),
    lastFive: results.slice(-5),
    activeTestCalls: activeRecords
      .filter((call) => str(call.externalId).startsWith(`cxbl-${DOMAIN.toLowerCase()}-`))
      .map((call) => ({
        uii: call.uii,
        state: call.callState,
        externalId: call.externalId,
        ani: call.ani,
        dnis: call.dnis,
      })),
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error && (error.stack || error.message || error));
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await mongoose.disconnect();
    } catch {}
  });
