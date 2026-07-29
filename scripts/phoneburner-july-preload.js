#!/usr/bin/env node
"use strict";

// One-shot July 2026 PhoneBurner preload. Dry-run is the default. The service
// remains the sole owner of selection, fairness, assignment, and provider
// posting; this file only validates operator intent and assembles its ports.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const {
  validateLeadDeliveryConfiguration,
} = require("../packages/shared-services/src/leadDeliveryService");

const APPLY_ACKNOWLEDGEMENT = "POST-JULY-2026-TO-FIVE-POOLS";
const MONDAY_CHECKPOINT_KEY = "phoneburner-july-bridge-2026-07-13";
const JULY_START = new Date("2026-07-01T07:00:00.000Z");
const AUGUST_START = new Date("2026-08-01T07:00:00.000Z");
const DEFAULT_MAX_CONTACTS = 5_000;
const MAX_CONTACTS_CAP = 5_000;
const PRELOAD_AGENT_IDS = Object.freeze([
  "bruce_allen",
  "phil_olson",
  "sean_lucas",
  "brad_hansen",
  "chris_bolt",
]);

// This pins the five Mickey-supplied distribution/receiving mappings without
// embedding or printing any folder identifier in the operator script.
const EXPECTED_FOLDER_MAPPING_DIGEST = "c8a4648cdc4ad28bac0bb438ec9bf6620ada2801c57b3dec40f1fb307e4e3432";

const RESULT_COUNT_FIELDS = Object.freeze([
  "scanned",
  "eligible",
  "skipped",
  "selected",
  "assigned",
  "accepted",
  "recovered",
  "pending",
  "failed",
  "fairnessSpread",
  "conflictCount",
]);

class PreloadCliError extends Error {
  constructor(code) {
    super(code);
    this.name = "PreloadCliError";
    this.code = code;
  }
}

function exactTrue(value) {
  return String(value || "").trim().toLowerCase() === "true";
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new PreloadCliError(`${name}-invalid`);
  }
  return parsed;
}

function optionValue(argv, index, name) {
  const current = String(argv[index] || "");
  if (current.startsWith(`${name}=`)) {
    return { value: current.slice(name.length + 1), consumed: 0 };
  }
  if (current === name) {
    const next = argv[index + 1];
    if (next == null || String(next).startsWith("--")) {
      throw new PreloadCliError(`${name.slice(2)}-missing`);
    }
    return { value: String(next), consumed: 1 };
  }
  return null;
}

function parseArgs(argv = [], { snapshot = new Date() } = {}) {
  const args = Array.isArray(argv) ? argv.map(String) : [];
  let apply = false;
  let explicitDryRun = false;
  let acknowledgement = "";
  let maxContacts = DEFAULT_MAX_CONTACTS;
  let snapshotOverride = null;
  let help = false;
  const seen = new Set();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--apply") {
      if (seen.has("apply")) throw new PreloadCliError("apply-duplicated");
      seen.add("apply");
      apply = true;
      continue;
    }
    if (arg === "--dry-run") {
      if (seen.has("dry-run")) throw new PreloadCliError("dry-run-duplicated");
      seen.add("dry-run");
      explicitDryRun = true;
      continue;
    }
    const ack = optionValue(args, index, "--ack");
    if (ack) {
      if (seen.has("ack")) throw new PreloadCliError("ack-duplicated");
      seen.add("ack");
      acknowledgement = ack.value;
      index += ack.consumed;
      continue;
    }
    const limit = optionValue(args, index, "--limit");
    if (limit) {
      if (seen.has("limit")) throw new PreloadCliError("limit-duplicated");
      seen.add("limit");
      maxContacts = positiveInteger(limit.value, "limit");
      index += limit.consumed;
      continue;
    }
    const snapshotOption = optionValue(args, index, "--snapshot");
    if (snapshotOption) {
      if (seen.has("snapshot")) throw new PreloadCliError("snapshot-duplicated");
      seen.add("snapshot");
      snapshotOverride = snapshotOption.value;
      index += snapshotOption.consumed;
      continue;
    }
    throw new PreloadCliError("unknown-argument");
  }

  if (apply && explicitDryRun) throw new PreloadCliError("mode-conflict");
  if (maxContacts > MAX_CONTACTS_CAP) throw new PreloadCliError("limit-over-cap");
  if (apply && acknowledgement !== APPLY_ACKNOWLEDGEMENT) {
    throw new PreloadCliError("apply-ack-required");
  }
  if (apply && !seen.has("snapshot")) {
    throw new PreloadCliError("apply-snapshot-required");
  }

  if (snapshotOverride != null
      && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(snapshotOverride)) {
    throw new PreloadCliError("snapshot-invalid");
  }
  const snapshotValue = snapshotOverride == null ? snapshot : snapshotOverride;
  const receivedBefore = snapshotValue instanceof Date
    ? new Date(snapshotValue.getTime())
    : new Date(snapshotValue);
  if (!Number.isFinite(receivedBefore.getTime())) throw new PreloadCliError("snapshot-invalid");
  if (receivedBefore.getTime() < JULY_START.getTime()) throw new PreloadCliError("snapshot-before-july");
  if (receivedBefore.getTime() >= AUGUST_START.getTime()) throw new PreloadCliError("snapshot-after-july");

  return {
    help,
    apply,
    dryRun: !apply,
    receivedFrom: new Date(JULY_START.getTime()),
    receivedBefore,
    maxContacts,
    agentIds: [...PRELOAD_AGENT_IDS],
  };
}

function findArmedPhoneBurnerWriters(env = {}) {
  const armed = [];
  if (exactTrue(env.PHONEBURNER_ROTATION_ENABLED)) armed.push("PHONEBURNER_ROTATION_ENABLED");
  if (exactTrue(env.LEAD_DELIVERY_ENABLED) && exactTrue(env.LEAD_DELIVERY_ACTIONS_ENABLED)) {
    armed.push("LEAD_DELIVERY_ACTIONS_ENABLED");
  }
  for (const key of Object.keys(env)) {
    if (!/^PHONEBURNER_(?:(?:LEGACY_)?(?:WRITER|FEEDER|PRELOAD|IMPORT)|MORNING_BUILDER)_ENABLED$/.test(key)) {
      continue;
    }
    if (exactTrue(env[key])) armed.push(key);
  }
  return [...new Set(armed)].sort();
}

function folderMappingDigest(configuration) {
  const agents = configuration?.agents || {};
  const canonical = PRELOAD_AGENT_IDS.map((agentId) => {
    const agent = agents[agentId] || {};
    return [
      agentId,
      String(agent.distributionFolderId || "").trim(),
      String(agent.receivingFolderId || "").trim(),
    ].join(":");
  }).join("|");
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildPreloadConfiguration(configuration, {
  expectedFolderMappingDigest = EXPECTED_FOLDER_MAPPING_DIGEST,
  validate = validateLeadDeliveryConfiguration,
} = {}) {
  if (!configuration || typeof configuration !== "object") {
    throw new PreloadCliError("configuration-invalid");
  }
  const configuredAgentIds = Object.keys(configuration.agents || {}).sort();
  const expectedAgentIds = [...PRELOAD_AGENT_IDS].sort();
  if (configuredAgentIds.length !== expectedAgentIds.length
      || configuredAgentIds.some((agentId, index) => agentId !== expectedAgentIds[index])) {
    throw new PreloadCliError("configuration-agent-set-mismatch");
  }
  if (folderMappingDigest(configuration) !== expectedFolderMappingDigest) {
    throw new PreloadCliError("configuration-folder-mapping-mismatch");
  }

  const copy = cloneJson(configuration);
  for (const agentId of PRELOAD_AGENT_IDS) {
    copy.agents[agentId].enabled = true;
  }
  let validation;
  try {
    validation = validate(copy);
  } catch {
    throw new PreloadCliError("configuration-invalid");
  }
  if (!validation?.valid) throw new PreloadCliError("configuration-invalid");
  return copy;
}

function safeAgentCounts(countsByAgent) {
  const safe = {};
  if (!countsByAgent || typeof countsByAgent !== "object") return safe;
  for (const agentId of PRELOAD_AGENT_IDS) {
    const value = countsByAgent[agentId];
    if (Number.isFinite(value)) {
      safe[agentId] = Number(value);
      continue;
    }
    if (!value || typeof value !== "object") continue;
    const fields = {};
    for (const key of RESULT_COUNT_FIELDS) {
      if (Number.isFinite(value[key])) fields[key] = Number(value[key]);
    }
    safe[agentId] = fields;
  }
  return safe;
}

function backpressureActive(value) {
  if (value == null || value === false || value === 0 || value === "") return false;
  if (value === true || Number(value) > 0) return true;
  if (typeof value === "string") return !["none", "false", "clear", "inactive"].includes(value.toLowerCase());
  if (typeof value === "object") {
    return value.active === true
      || value.rateLimited === true
      || value.blocked === true
      || Number(value.count || 0) > 0;
  }
  return false;
}

function preloadSucceeded(result = {}, options = {}) {
  const status = String(result.status || "unknown").trim().toLowerCase();
  if (!["preview", "completed"].includes(status)) return false;
  if (Number(result.failed || 0) > 0 || Number(result.pending || 0) > 0) return false;
  if (Number(result.conflictCount || 0) > 0) return false;
  const isApply = options.dryRun === false || (options.dryRun == null && result.dryRun === false);
  if (isApply && Number(result.eligible || 0) > 0 && Number(result.accepted || 0) === 0) return false;
  if (!isApply
    && Number(result.selected || 0) >= Number(options.maxContacts || 0)
    && Number(result.eligible || 0) > Number(result.selected || 0)) return false;
  if (isApply) {
    const checkpoint = result.checkpoint;
    if (!checkpoint || String(checkpoint.status || "") !== "completed") return false;
    if (checkpoint.capReached === true) return false;
    if (Number(checkpoint.admitted || 0) !== Number(checkpoint.accepted || 0)) return false;
    if (Number(checkpoint.pending || 0) > 0
      || Number(checkpoint.failed || 0) > 0
      || Number(checkpoint.conflicts || 0) > 0) return false;
  }
  return !backpressureActive(result.backpressure);
}

function summarizeResult(result, options) {
  const status = String(result?.status || "unknown").slice(0, 80);
  const summary = {
    ok: preloadSucceeded(result, options),
    status,
    dryRun: options.dryRun,
    window: {
      receivedFrom: options.receivedFrom.toISOString(),
      receivedBefore: options.receivedBefore.toISOString(),
      maxContacts: options.maxContacts,
    },
    agentCount: PRELOAD_AGENT_IDS.length,
    folderMappingsVerified: true,
    backpressure: backpressureActive(result?.backpressure),
  };
  for (const key of RESULT_COUNT_FIELDS) {
    summary[key] = Number.isFinite(result?.[key]) ? Number(result[key]) : 0;
  }
  summary.countsByAgent = safeAgentCounts(result?.countsByAgent);
  if (result?.checkpoint && typeof result.checkpoint === "object") {
    summary.checkpoint = {
      status: String(result.checkpoint.status || "unknown").slice(0, 40),
      cutoffAt: result.checkpoint.cutoffAt instanceof Date
        ? result.checkpoint.cutoffAt.toISOString()
        : String(result.checkpoint.cutoffAt || "").slice(0, 40),
      admitted: Number(result.checkpoint.admitted || 0),
      accepted: Number(result.checkpoint.accepted || 0),
      pending: Number(result.checkpoint.pending || 0),
      failed: Number(result.checkpoint.failed || 0),
      conflicts: Number(result.checkpoint.conflicts || 0),
      capReached: result.checkpoint.capReached === true,
      completedAt: result.checkpoint.completedAt instanceof Date
        ? result.checkpoint.completedAt.toISOString()
        : String(result.checkpoint.completedAt || "").slice(0, 40) || null,
    };
  }
  return summary;
}

function loadCheckedInConfiguration() {
  const configPath = path.resolve(__dirname, "..", "config", "lead-delivery-agents.json");
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function createProgressReporter({ write = (line) => process.stdout.write(line) } = {}) {
  if (typeof write !== "function") throw new TypeError("write must be a function");
  let lastMilestone = 0;
  return (progress = {}) => {
    const accepted = Number(progress.accepted || 0);
    if (!Number.isSafeInteger(accepted) || accepted < 25) return;
    const milestone = Math.floor(accepted / 25) * 25;
    if (milestone <= lastMilestone) return;
    for (let value = lastMilestone + 25; value <= milestone; value += 25) {
      write(`${JSON.stringify({
        type: "phoneburner_july_preload_progress",
        accepted: value,
        agentCount: PRELOAD_AGENT_IDS.length,
      })}\n`);
    }
    lastMilestone = milestone;
  };
}

async function bootstrapRuntime({ configuration, options, env = process.env }) {
  const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
  const { getCompanyKeys, getSharedConfig } = require("../packages/shared-config/src");
  const { getControlPlaneConfig } = require("../apps/control-plane/src/services/appConfig");
  const {
    leadDeliveryRepository,
    runLockRepository,
    userAccountRepository,
  } = require("../packages/shared-repositories/src");
  const {
    createPhoneBurnerClient,
    createPhoneBurnerDurableCredentialStore,
  } = require("../packages/shared-integrations/src");
  const { isFieldEncryptionConfigured } = require("../packages/shared-auth/src");
  const {
    createLeadDeliveryCadenceSource,
    createLeadDeliveryRuntime,
  } = require("../packages/shared-services/src/leadDeliveryService");
  const { resolveQueueDialTimeWindow } = require("../packages/shared-services/src/cxQueuePolicyService");

  let connected = false;
  let runtime = null;
  try {
    await connectMongo(getSharedConfig());
    connected = true;
    const controlPlaneConfig = getControlPlaneConfig();
    const serviceEmail = String(env.PARALLEL_SERVICE_EMAIL || "service@taxadvocategroup.com")
      .trim()
      .toLowerCase();
    let phoneBurner = null;
    if (!options.dryRun) {
      if (!isFieldEncryptionConfigured()) throw new PreloadCliError("field-encryption-unavailable");
      const credentialStore = createPhoneBurnerDurableCredentialStore({
        env,
        serviceEmail,
        credentialRepository: userAccountRepository,
      });
      await credentialStore.read();
      phoneBurner = createPhoneBurnerClient({ credentialStore });
    }

    const source = createLeadDeliveryCadenceSource({
      repository: leadDeliveryRepository,
      domains: getCompanyKeys(),
      policyForDomain: () => ({
        allowedProspectStatusIds: controlPlaneConfig.logicsProspectStatusIds,
        dncStatusIds: controlPlaneConfig.logicsDncStatusIds,
      }),
      contactWindowEvaluator: (row, at) => resolveQueueDialTimeWindow(row, at),
    });
    const owner = `phoneburner-july-preload-${process.pid}-${crypto.randomUUID()}`;
    const configuredInterval = Number(env.LEAD_DELIVERY_PROVIDER_POST_MIN_INTERVAL_MS) || 1;
    runtime = createLeadDeliveryRuntime({
      repository: leadDeliveryRepository,
      source,
      phoneBurner,
      configuration,
      enabled: true,
      actionsEnabled: !options.dryRun,
      refillEnabled: false,
      // One-off recovery callers must opt in explicitly. Production never
      // passes this flag; its only provider writer remains the simple loop.
      simpleOperatorDirectAccessEnabled: options.simpleOperatorDirectAccessEnabled === true,
      providerPostMinimumIntervalMs: Math.max(1, configuredInterval),
      acquireProviderPostSlot: ({ laneKey, leaseMs }) => runLockRepository.acquireRunLock(
        laneKey,
        leaseMs,
        owner,
      ),
      extendProviderPostSlot: ({ laneKey, slot, leaseMs }) => runLockRepository.extendRunLock(
        laneKey,
        slot?.token,
        leaseMs,
      ),
      releaseProviderPostSlot: ({ laneKey, slot }) => runLockRepository.releaseRunLock(
        laneKey,
        slot?.token,
      ),
    });

    return {
      runtime,
      async close() {
        if (runtime && typeof runtime.stop === "function") await runtime.stop();
        if (connected) await disconnectMongo();
        connected = false;
      },
    };
  } catch (error) {
    if (runtime && typeof runtime.stop === "function") await runtime.stop().catch(() => {});
    if (connected) await disconnectMongo().catch(() => {});
    throw error;
  }
}

async function executePreload(options, {
  env = process.env,
  loadConfiguration = loadCheckedInConfiguration,
  createBootstrap = bootstrapRuntime,
  expectedFolderMappingDigest = EXPECTED_FOLDER_MAPPING_DIGEST,
  onProgress = null,
} = {}) {
  const armedWriters = findArmedPhoneBurnerWriters(env);
  if (armedWriters.length > 0) throw new PreloadCliError("phoneburner-writer-armed");

  const configuration = buildPreloadConfiguration(loadConfiguration(), {
    expectedFolderMappingDigest,
  });
  const context = await createBootstrap({ configuration, options, env });
  let result;
  try {
    if (!context?.runtime || typeof context.runtime.preloadWindow !== "function") {
      throw new PreloadCliError("preload-interface-unavailable");
    }
    const preloadInput = {
      receivedFrom: options.receivedFrom,
      receivedBefore: options.receivedBefore,
      agentIds: [...options.agentIds],
      maxContacts: options.maxContacts,
      dryRun: options.dryRun,
    };
    if (!options.dryRun) preloadInput.checkpointKey = MONDAY_CHECKPOINT_KEY;
    if (typeof onProgress === "function") preloadInput.onProgress = onProgress;
    result = await context.runtime.preloadWindow(preloadInput);
  } finally {
    if (context && typeof context.close === "function") await context.close();
  }
  return summarizeResult(result, options);
}

function safeFailure(error) {
  return {
    ok: false,
    status: "error",
    reason: error instanceof PreloadCliError ? error.code : "preload-failed",
  };
}

function usage() {
  return [
    "PhoneBurner July 2026 preload (dry-run by default)",
    "",
    "Dry-run:",
    "  npm run phoneburner:july-preload",
    "",
    "Apply:",
    `  npm run phoneburner:july-preload -- --snapshot=<ISO> --apply --ack=${APPLY_ACKNOWLEDGEMENT}`,
    "  Reuse that exact --snapshot value for every retry/resume.",
    "",
    `Optional: --limit=N (1-${MAX_CONTACTS_CAP})`,
    "Snapshot: --snapshot=<ISO timestamp inside July 2026 Pacific bounds>",
    "          required for apply; optional for dry-run.",
  ].join("\n");
}

async function runCli(argv = process.argv.slice(2), dependencies = {}) {
  const snapshot = dependencies.snapshot == null ? new Date() : dependencies.snapshot;
  const options = parseArgs(argv, { snapshot });
  if (options.help) return { help: true, text: usage(), exitCode: 0 };
  const summary = await executePreload(options, dependencies);
  return { summary, exitCode: summary.ok ? 0 : 1 };
}

async function main() {
  require("dotenv").config({ path: path.resolve(__dirname, "..", ".env"), quiet: true });
  try {
    const result = await runCli(process.argv.slice(2), {
      onProgress: createProgressReporter(),
    });
    if (result.help) {
      process.stdout.write(`${result.text}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(result.summary)}\n`);
    }
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stdout.write(`${JSON.stringify(safeFailure(error))}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) void main();

module.exports = {
  APPLY_ACKNOWLEDGEMENT,
  MONDAY_CHECKPOINT_KEY,
  AUGUST_START,
  DEFAULT_MAX_CONTACTS,
  EXPECTED_FOLDER_MAPPING_DIGEST,
  JULY_START,
  MAX_CONTACTS_CAP,
  PRELOAD_AGENT_IDS,
  PreloadCliError,
  backpressureActive,
  bootstrapRuntime,
  buildPreloadConfiguration,
  createProgressReporter,
  executePreload,
  findArmedPhoneBurnerWriters,
  folderMappingDigest,
  loadCheckedInConfiguration,
  parseArgs,
  preloadSucceeded,
  runCli,
  safeFailure,
  summarizeResult,
  usage,
};
