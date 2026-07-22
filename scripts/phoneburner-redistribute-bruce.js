#!/usr/bin/env node
"use strict";

// One-off July bridge operation: empty Bruce's visible PhoneBurner folders into
// the four active agents while keeping the provider-neutral owner ledger exact.
// Dry-run is the default. Output is aggregate-only and contains no contact IDs.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SOURCE_AGENT_ID = "bruce_allen";
const TARGET_AGENT_IDS = Object.freeze([
  "brad_hansen",
  "phil_olson",
  "sean_lucas",
  "chris_bolt",
]);
const APPLY_ACKNOWLEDGEMENT = "REDISTRIBUTE-BRUCE-TO-ACTIVE-FOUR";
const PROVIDER_LANE_KEY = "lead-delivery:phoneburner:contact-post";
const PROVIDER_LANE_LEASE_MS = 30 * 60_000;
const MOVE_MINIMUM_INTERVAL_MS = 1_500;
const MOVE_ATTEMPTS = 3;
const READ_ATTEMPTS = 3;

class RedistributionError extends Error {
  constructor(code) {
    super(code);
    this.name = "RedistributionError";
    this.code = code;
  }
}

function optionValue(argv, index, name) {
  const current = String(argv[index] || "");
  if (current.startsWith(`${name}=`)) return { value: current.slice(name.length + 1), consumed: 0 };
  if (current === name) {
    const next = argv[index + 1];
    if (next == null || String(next).startsWith("--")) throw new RedistributionError(`${name.slice(2)}-missing`);
    return { value: String(next), consumed: 1 };
  }
  return null;
}

function parseArgs(argv = []) {
  let apply = false;
  let dryRun = false;
  let acknowledgement = "";
  let help = false;
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index]);
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--apply") {
      if (seen.has("apply")) throw new RedistributionError("apply-duplicated");
      seen.add("apply");
      apply = true;
      continue;
    }
    if (arg === "--dry-run") {
      if (seen.has("dry-run")) throw new RedistributionError("dry-run-duplicated");
      seen.add("dry-run");
      dryRun = true;
      continue;
    }
    const ack = optionValue(argv, index, "--ack");
    if (ack) {
      if (seen.has("ack")) throw new RedistributionError("ack-duplicated");
      seen.add("ack");
      acknowledgement = ack.value;
      index += ack.consumed;
      continue;
    }
    throw new RedistributionError("unknown-argument");
  }
  if (apply && dryRun) throw new RedistributionError("mode-conflict");
  if (apply && acknowledgement !== APPLY_ACKNOWLEDGEMENT) {
    throw new RedistributionError("apply-ack-required");
  }
  return { help, apply, dryRun: !apply };
}

function balancedAllocations(currentTotals, moveCount, targetAgentIds = TARGET_AGENT_IDS) {
  if (!Number.isSafeInteger(moveCount) || moveCount < 0) throw new RedistributionError("move-count-invalid");
  const entries = targetAgentIds.map((agentId) => {
    const current = Number(currentTotals?.[agentId]);
    if (!Number.isSafeInteger(current) || current < 0) throw new RedistributionError("target-count-invalid");
    return { agentId, current };
  });
  if (moveCount === 0) return Object.fromEntries(entries.map(({ agentId }) => [agentId, 0]));
  const finalTotal = entries.reduce((sum, entry) => sum + entry.current, 0) + moveCount;
  const floor = Math.floor(finalTotal / entries.length);
  const remainder = finalTotal % entries.length;
  const extra = [...entries].sort((left, right) => (
    right.current - left.current || left.agentId.localeCompare(right.agentId)
  ));
  const desired = new Map(entries.map((entry) => [entry.agentId, floor]));
  for (let index = 0; index < remainder; index += 1) {
    desired.set(extra[index].agentId, floor + 1);
  }
  const allocations = Object.fromEntries(entries.map((entry) => [
    entry.agentId,
    desired.get(entry.agentId) - entry.current,
  ]));
  if (Object.values(allocations).some((count) => count < 0)
      || Object.values(allocations).reduce((sum, count) => sum + count, 0) !== moveCount) {
    throw new RedistributionError("target-balance-unavailable");
  }
  return allocations;
}

function assignContacts(contacts, allocations, targetAgentIds = TARGET_AGENT_IDS) {
  const remaining = { ...allocations };
  const ordered = [...contacts].sort((left, right) => (
    String(left.contactId).localeCompare(String(right.contactId), "en", { numeric: true })
  ));
  const plan = [];
  let cursor = 0;
  for (const contact of ordered) {
    let selected = null;
    for (let offset = 0; offset < targetAgentIds.length; offset += 1) {
      const index = (cursor + offset) % targetAgentIds.length;
      const agentId = targetAgentIds[index];
      if (remaining[agentId] > 0) {
        selected = agentId;
        cursor = (index + 1) % targetAgentIds.length;
        break;
      }
    }
    if (!selected) throw new RedistributionError("allocation-plan-incomplete");
    remaining[selected] -= 1;
    plan.push({ contact, targetAgentId: selected });
  }
  if (Object.values(remaining).some((count) => count !== 0)) {
    throw new RedistributionError("allocation-plan-incomplete");
  }
  return plan;
}

async function readAllFolderContacts(phoneBurner, folderId) {
  const contacts = [];
  const contactIds = new Set();
  let page = 1;
  let totalPages = null;
  let totalResults = null;
  while (totalPages == null || page <= totalPages) {
    const result = await phoneBurner.listFolderContacts(folderId, { page, pageSize: 100, sortOrder: "ASC" });
    if (!result?.ok) throw new RedistributionError("folder-read-failed");
    if (totalPages == null) {
      totalPages = result.totalPages;
      totalResults = result.totalResults;
    } else if (result.totalPages !== totalPages || result.totalResults !== totalResults) {
      throw new RedistributionError("folder-read-changed");
    }
    for (const contact of result.contacts) {
      if (!contact?.contactId
          || (contact.folderId && contact.folderId !== String(folderId))
          || contactIds.has(contact.contactId)) {
        throw new RedistributionError("folder-identity-invalid");
      }
      contactIds.add(contact.contactId);
      contacts.push(contact);
    }
    if (totalPages === 0 || page >= totalPages) break;
    page += 1;
  }
  if (contacts.length !== totalResults) throw new RedistributionError("folder-read-incomplete");
  return contacts;
}

async function readFolderCounts(phoneBurner, configuration) {
  const counts = {};
  const agentIds = [SOURCE_AGENT_ID, ...TARGET_AGENT_IDS];
  for (const agentId of agentIds) {
    const agent = configuration.agents[agentId];
    counts[agentId] = { distribution: 0, receiving: 0, total: 0 };
    for (const [role, folderId] of [
      ["distribution", agent.distributionFolderId],
      ["receiving", agent.receivingFolderId],
    ]) {
      const result = await phoneBurner.getFolderCount(folderId);
      if (!result?.ok || !Number.isSafeInteger(result.count)) throw new RedistributionError("folder-count-failed");
      counts[agentId][role] = result.count;
      counts[agentId].total += result.count;
    }
  }
  return counts;
}

async function readSourceContacts(phoneBurner, configuration) {
  const source = configuration.agents[SOURCE_AGENT_ID];
  const contacts = [];
  const seen = new Set();
  for (const folderId of [source.distributionFolderId, source.receivingFolderId]) {
    for (const contact of await readAllFolderContacts(phoneBurner, folderId)) {
      if (seen.has(contact.contactId)) throw new RedistributionError("provider-contact-duplicated");
      seen.add(contact.contactId);
      contacts.push({ ...contact, sourceFolderId: String(folderId) });
    }
  }
  return contacts;
}

function assertMovableItem(item, contactId) {
  const valid = item
    && String(item.state || "") === "provider_accepted"
    && item.activeAttempt === true
    && String(item.deliveryAgentId || "") === SOURCE_AGENT_ID
    && String(item.provider || "") === "phoneburner"
    && String(item.providerContactId || "") === String(contactId)
    && Boolean(String(item.providerExternalLeadId || "").trim())
    && Boolean(String(item.packetId || "").startsWith("preload-v1-"))
    && String(item.providerPostState || "") === "accepted"
    && item.providerAcceptedAt
    && !item.providerCompletedAt
    && !item.providerCallId;
  if (!valid) throw new RedistributionError("ledger-item-not-movable");
}

function exactItemExpectation(item) {
  return {
    state: "provider_accepted",
    activeAttempt: true,
    deliveryAgentId: SOURCE_AGENT_ID,
    provider: "phoneburner",
    providerContactId: String(item.providerContactId),
    providerExternalLeadId: String(item.providerExternalLeadId),
    providerAcceptedAt: item.providerAcceptedAt,
    providerCompletedAt: null,
    providerCallId: null,
    providerPostState: "accepted",
    packetId: String(item.packetId),
  };
}

async function reassignLedgerItem(repository, item, targetAgentId, now = () => new Date()) {
  let current = item;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (String(current?.deliveryAgentId || "") === targetAgentId) return current;
    assertMovableItem(current, item.providerContactId);
    const updated = await repository.compareAndSetItem({
      itemId: String(current._id),
      expectedVersion: current.version,
      expected: exactItemExpectation(current),
      set: {
        deliveryAgentId: targetAgentId,
        "metadata.lastOperatorRedistribution": {
          fromAgentId: SOURCE_AGENT_ID,
          toAgentId: targetAgentId,
          reason: "agent-out-of-office",
          movedAt: now(),
        },
      },
    });
    if (updated) return updated;
    current = await repository.getItemById(String(current._id));
  }
  throw new RedistributionError("ledger-cas-conflict");
}

function createMovePacer({ minimumIntervalMs = MOVE_MINIMUM_INTERVAL_MS, clock = () => Date.now(), sleep }) {
  let lastStartedAt = null;
  return async () => {
    const current = Number(clock());
    if (lastStartedAt != null) {
      const waitMs = Math.max(0, minimumIntervalMs - (current - lastStartedAt));
      if (waitMs > 0) await sleep(waitMs);
    }
    lastStartedAt = Number(clock());
  };
}

async function readContactFolder(phoneBurner, contactId, { sleep }) {
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
    const result = await phoneBurner.getContact(contactId);
    if (result?.ok && result.contact?.folderId) return String(result.contact.folderId);
    if (attempt + 1 < READ_ATTEMPTS) await sleep(500 * (attempt + 1));
  }
  return null;
}

async function moveAndVerify(phoneBurner, contactId, sourceFolderId, targetFolderIds, { pace, sleep }) {
  for (let attempt = 0; attempt < MOVE_ATTEMPTS; attempt += 1) {
    await pace();
    const result = await phoneBurner.moveContact(contactId, targetFolderIds.distribution);
    const observedFolderId = await readContactFolder(phoneBurner, contactId, { sleep });
    if (targetFolderIds.all.has(observedFolderId)) return;
    if (observedFolderId && observedFolderId !== sourceFolderId) {
      throw new RedistributionError("provider-location-conflict");
    }
    if (result?.httpStatus === 429) await sleep(30_000);
    else if (attempt + 1 < MOVE_ATTEMPTS) await sleep(2_000 * (attempt + 1));
  }
  throw new RedistributionError("provider-move-unconfirmed");
}

async function moveBackAfterLedgerConflict(phoneBurner, contactId, sourceFolderId, { pace, sleep }) {
  await pace();
  await phoneBurner.moveContact(contactId, sourceFolderId);
  const observedFolderId = await readContactFolder(phoneBurner, contactId, { sleep });
  if (observedFolderId !== sourceFolderId) throw new RedistributionError("rollback-unconfirmed");
}

async function repairProjection(repository, reconstructAgentProjection, agentId) {
  const items = await repository.listAgentDeliveryItems(agentId);
  const projection = reconstructAgentProjection(items, { agentId });
  if (!projection.reliable) throw new RedistributionError("projection-unreliable");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const agent = await repository.getAgentById(agentId);
    if (!agent) return null;
    const updated = await repository.compareAndSetAgent({
      agentId,
      expectedVersion: agent.version,
      set: { estimatedOutstanding: projection.estimatedOutstanding },
    });
    if (updated) return projection.estimatedOutstanding;
  }
  throw new RedistributionError("agent-projection-cas-conflict");
}

function safeCounts(counts) {
  return Object.fromEntries([SOURCE_AGENT_ID, ...TARGET_AGENT_IDS].map((agentId) => [
    agentId,
    {
      distribution: counts[agentId].distribution,
      receiving: counts[agentId].receiving,
      total: counts[agentId].total,
    },
  ]));
}

async function execute(options, dependencies = {}) {
  const {
    configuration,
    phoneBurner,
    repository,
    reconstructAgentProjection,
    acquireLane = async () => null,
    extendLane = async () => null,
    releaseLane = async () => {},
    sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
    now = () => new Date(),
    onProgress = () => {},
  } = dependencies;
  const beforeCounts = await readFolderCounts(phoneBurner, configuration);
  const visibleSourceContacts = await readSourceContacts(phoneBurner, configuration);
  if (visibleSourceContacts.length !== beforeCounts[SOURCE_AGENT_ID].total) {
    throw new RedistributionError("source-folder-snapshot-changed");
  }
  const sourceItems = await repository.listAgentDeliveryItems(SOURCE_AGENT_ID);
  const sourceItemsByContact = new Map();
  for (const item of sourceItems) {
    const contactId = String(item.providerContactId || "");
    if (!contactId) continue;
    if (sourceItemsByContact.has(contactId)) throw new RedistributionError("ledger-contact-duplicated");
    sourceItemsByContact.set(contactId, item);
  }

  const sourceContacts = [];
  const repairCandidates = [];
  for (const contact of visibleSourceContacts) {
    const item = sourceItemsByContact.get(contact.contactId);
    if (!item) throw new RedistributionError("source-contact-ledger-mismatch");
    assertMovableItem(item, contact.contactId);
    sourceContacts.push({ ...contact, item });
  }
  const visibleContactIds = new Set(sourceContacts.map((contact) => contact.contactId));
  const targetByFolderId = new Map(TARGET_AGENT_IDS.flatMap((agentId) => {
    const target = configuration.agents[agentId];
    return [target.distributionFolderId, target.receivingFolderId].map((folderId) => [String(folderId), agentId]);
  }));
  const sourceFolderIds = new Set([
    String(configuration.agents[SOURCE_AGENT_ID].distributionFolderId),
    String(configuration.agents[SOURCE_AGENT_ID].receivingFolderId),
  ]);
  let unmatchedLedgerCount = 0;
  for (const item of sourceItems) {
    const contactId = String(item.providerContactId || "");
    if (!contactId) {
      unmatchedLedgerCount += 1;
      continue;
    }
    if (visibleContactIds.has(contactId)) continue;
    const observedFolderId = await readContactFolder(phoneBurner, contactId, { sleep });
    const targetAgentId = targetByFolderId.get(observedFolderId);
    if (targetAgentId) {
      assertMovableItem(item, contactId);
      repairCandidates.push({ item, targetAgentId });
    } else if (sourceFolderIds.has(observedFolderId)) {
      throw new RedistributionError("source-folder-snapshot-changed");
    } else {
      unmatchedLedgerCount += 1;
    }
  }
  const currentTotals = Object.fromEntries(TARGET_AGENT_IDS.map((agentId) => [agentId, beforeCounts[agentId].total]));
  const allocations = balancedAllocations(currentTotals, sourceContacts.length);
  const plan = assignContacts(sourceContacts, allocations);
  const summary = {
    ok: true,
    status: options.dryRun ? "preview" : "running",
    dryRun: options.dryRun,
    sourceAgentId: SOURCE_AGENT_ID,
    sourceVisibleCount: sourceContacts.length,
    repairNeededCount: repairCandidates.length,
    unmatchedLedgerCount,
    allocations,
    moved: 0,
    repaired: 0,
    folderCountsBefore: safeCounts(beforeCounts),
  };
  if (options.dryRun) return summary;

  let lane = await acquireLane();
  if (!lane) throw new RedistributionError("provider-lane-unavailable");
  let lastLaneExtensionAt = now().getTime();
  const pace = createMovePacer({ sleep });
  try {
    for (const candidate of repairCandidates) {
      await reassignLedgerItem(repository, candidate.item, candidate.targetAgentId, now);
      summary.repaired += 1;
    }
    for (const entry of plan) {
      const target = configuration.agents[entry.targetAgentId];
      const targetFolderIds = {
        distribution: String(target.distributionFolderId),
        all: new Set([String(target.distributionFolderId), String(target.receivingFolderId)]),
      };
      await moveAndVerify(
        phoneBurner,
        entry.contact.contactId,
        entry.contact.sourceFolderId,
        targetFolderIds,
        { pace, sleep },
      );
      try {
        await reassignLedgerItem(repository, entry.contact.item, entry.targetAgentId, now);
      } catch (error) {
        await moveBackAfterLedgerConflict(
          phoneBurner,
          entry.contact.contactId,
          entry.contact.sourceFolderId,
          { pace, sleep },
        );
        throw error;
      }
      summary.moved += 1;
      if (summary.moved % 25 === 0) onProgress({ moved: summary.moved, total: plan.length });
      if (now().getTime() - lastLaneExtensionAt >= 120_000) {
        lane = await extendLane(lane);
        if (!lane) throw new RedistributionError("provider-lane-lost");
        lastLaneExtensionAt = now().getTime();
      }
    }
    const projections = {};
    for (const agentId of [SOURCE_AGENT_ID, ...TARGET_AGENT_IDS]) {
      projections[agentId] = await repairProjection(repository, reconstructAgentProjection, agentId);
    }
    const afterCounts = await readFolderCounts(phoneBurner, configuration);
    summary.folderCountsAfter = safeCounts(afterCounts);
    summary.projections = projections;
    summary.status = afterCounts[SOURCE_AGENT_ID].total === 0 ? "completed" : "source-not-empty";
    summary.ok = summary.status === "completed";
    return summary;
  } finally {
    await releaseLane(lane).catch(() => {});
  }
}

function loadConfiguration() {
  return JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "config", "lead-delivery-agents.json"), "utf8"));
}

async function bootstrap(options) {
  const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
  const { getSharedConfig } = require("../packages/shared-config/src");
  const { leadDeliveryRepository, runLockRepository, userAccountRepository } = require("../packages/shared-repositories/src");
  const { createPhoneBurnerClient, createPhoneBurnerDurableCredentialStore } = require("../packages/shared-integrations/src");
  const { isFieldEncryptionConfigured } = require("../packages/shared-auth/src");
  const { reconstructAgentProjection, validateLeadDeliveryConfiguration } = require("../packages/shared-services/src/leadDeliveryService");
  const { findArmedPhoneBurnerWriters } = require("./phoneburner-july-preload");

  const configuration = loadConfiguration();
  const validation = validateLeadDeliveryConfiguration(configuration);
  if (!validation.valid) throw new RedistributionError("configuration-invalid");
  for (const agentId of [SOURCE_AGENT_ID, ...TARGET_AGENT_IDS]) {
    if (!configuration.agents?.[agentId]) throw new RedistributionError("configuration-agent-missing");
  }
  if (findArmedPhoneBurnerWriters(process.env).length > 0) {
    throw new RedistributionError("phoneburner-writer-armed");
  }
  if (!isFieldEncryptionConfigured()) throw new RedistributionError("field-encryption-unavailable");
  await connectMongo(getSharedConfig());
  const serviceEmail = String(process.env.PARALLEL_SERVICE_EMAIL || "service@taxadvocategroup.com").trim().toLowerCase();
  const credentialStore = createPhoneBurnerDurableCredentialStore({
    env: process.env,
    serviceEmail,
    credentialRepository: userAccountRepository,
  });
  await credentialStore.read();
  const phoneBurner = createPhoneBurnerClient({ credentialStore });
  const owner = `phoneburner-redistribute-${process.pid}-${crypto.randomUUID()}`;
  return {
    dependencies: {
      configuration,
      phoneBurner,
      repository: leadDeliveryRepository,
      reconstructAgentProjection,
      acquireLane: () => runLockRepository.acquireRunLock(PROVIDER_LANE_KEY, PROVIDER_LANE_LEASE_MS, owner),
      extendLane: (lane) => runLockRepository.extendRunLock(PROVIDER_LANE_KEY, lane?.token, PROVIDER_LANE_LEASE_MS),
      releaseLane: (lane) => runLockRepository.releaseRunLock(PROVIDER_LANE_KEY, lane?.token),
      onProgress: (progress) => process.stdout.write(`${JSON.stringify({
        type: "phoneburner_redistribution_progress",
        moved: progress.moved,
        total: progress.total,
      })}\n`),
    },
    close: disconnectMongo,
  };
}

function usage() {
  return [
    "PhoneBurner Bruce redistribution (dry-run by default)",
    "",
    "Dry-run:",
    "  node scripts/phoneburner-redistribute-bruce.js",
    "",
    "Apply:",
    `  node scripts/phoneburner-redistribute-bruce.js --apply --ack=${APPLY_ACKNOWLEDGEMENT}`,
  ].join("\n");
}

function safeFailure(error) {
  return {
    ok: false,
    status: "error",
    reason: error instanceof RedistributionError ? error.code : "redistribution-failed",
  };
}

async function main() {
  require("dotenv").config({ path: path.resolve(__dirname, "..", ".env"), quiet: true });
  let context = null;
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    context = await bootstrap(options);
    const result = await execute(options, context.dependencies);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify(safeFailure(error))}\n`);
    process.exitCode = 1;
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

if (require.main === module) void main();

module.exports = {
  APPLY_ACKNOWLEDGEMENT,
  RedistributionError,
  assignContacts,
  balancedAllocations,
  execute,
  parseArgs,
  safeFailure,
};
