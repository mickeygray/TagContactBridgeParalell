"use strict";

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const { getSharedConfig } = require("../packages/shared-config/src");
const { createLogicsClient } = require("../packages/shared-integrations/src");
const { LeadCadence, SourceCanonical } = require("../packages/shared-models/src");
const { parseLogicsPayload } = require("../packages/shared-services/src/ncoaUploadService");

function parseArgs(argv) {
  const args = {
    apply: false,
    since: "2026-05-14T00:00:00.000Z",
    customId: 45,
    generalId: 46,
    concurrency: 3,
    delayMs: 150,
    limit: 0,
    audit: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--since") {
      args.since = argv[index + 1] || args.since;
      index += 1;
    } else if (arg === "--custom-id") {
      args.customId = Number(argv[index + 1]) || args.customId;
      index += 1;
    } else if (arg === "--general-id") {
      args.generalId = Number(argv[index + 1]) || args.generalId;
      index += 1;
    } else if (arg === "--concurrency") {
      args.concurrency = Math.max(Number(argv[index + 1]) || args.concurrency, 1);
      index += 1;
    } else if (arg === "--delay-ms") {
      args.delayMs = Math.max(Number(argv[index + 1]) || args.delayMs, 0);
      index += 1;
    } else if (arg === "--limit") {
      args.limit = Math.max(Number(argv[index + 1]) || 0, 0);
      index += 1;
    } else if (arg === "--audit") {
      args.audit = argv[index + 1] || null;
      index += 1;
    }
  }
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unwrapLogics(value) {
  const parsed = parseLogicsPayload(value);
  if (Array.isArray(parsed)) return parsed[0] || null;
  return parsed || null;
}

function pickCaseSource(value) {
  const row = unwrapLogics(value) || {};
  return {
    caseId: Number(row.CaseID || row.caseId || 0) || null,
    sourceCampaignId: Number(row.SourceCampaignID || row.CampaignSourceID || row.SourceID || 0) || null,
  };
}

function appendAudit(filePath, entry) {
  if (!filePath) return;
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`);
}

async function ensureCanonicalSourceId(canonicalKey, label, sourceId) {
  await SourceCanonical.updateOne(
    { canonicalKey },
    {
      $set: {
        canonicalKey,
        internalName: label,
        channel: "ld-posting",
        active: true,
        "flags.digital": true,
      },
      $addToSet: {
        domains: "WYNN",
      },
    },
    { upsert: true },
  );
  const existing = await SourceCanonical.findOne({
    canonicalKey,
    sourceIds: {
      $elemMatch: { domain: "WYNN", sourceId: Number(sourceId) },
    },
  }).lean();
  if (!existing) {
    await SourceCanonical.updateOne(
      { canonicalKey },
      { $push: { sourceIds: { domain: "WYNN", sourceId: Number(sourceId) } } },
    );
  }
}

async function collectCases(since, limit) {
  const configs = [
    { key: "ld-custom", label: "LD CUSTOM", sourceId: null },
    { key: "ld-general", label: "LD GENERAL", sourceId: null },
  ];
  const items = [];
  for (const config of configs) {
    const rows = await LeadCadence.find(
      {
        domain: "WYNN",
        intakeSource: { $in: ["ld", "ld-posting"] },
        createdAt: { $gte: since },
        routeCampaignKey: config.key,
      },
      { caseId: 1, createdAt: 1 },
    )
      .sort({ createdAt: 1 })
      .lean();

    const seen = new Set();
    for (const row of rows) {
      const caseId = Number(row.caseId);
      if (!Number.isFinite(caseId) || caseId <= 0 || seen.has(caseId)) continue;
      seen.add(caseId);
      items.push({ key: config.key, label: config.label, caseId });
    }
  }
  items.sort((left, right) => left.caseId - right.caseId);
  return limit > 0 ? items.slice(0, limit) : items;
}

async function runPool(items, workerCount, worker) {
  let cursor = 0;
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await worker(item);
    }
  });
  await Promise.all(workers);
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const since = new Date(args.since);
  if (Number.isNaN(since.getTime())) throw new Error(`Invalid --since: ${args.since}`);

  const config = getSharedConfig();
  await mongoose.connect(config.mongoUri, { dbName: config.parallelDbName });
  await ensureCanonicalSourceId("ld-custom", "LD CUSTOM", args.customId);
  await ensureCanonicalSourceId("ld-general", "LD GENERAL", args.generalId);
  const cases = await collectCases(since, args.limit);
  await mongoose.disconnect();

  const sourceByKey = {
    "ld-custom": Number(args.customId),
    "ld-general": Number(args.generalId),
  };
  const summary = {
    since: since.toISOString(),
    apply: args.apply,
    total: cases.length,
    byKey: cases.reduce((acc, item) => {
      acc[item.key] = (acc[item.key] || 0) + 1;
      return acc;
    }, {}),
    sourceByKey,
    ok: 0,
    alreadyOk: 0,
    failed: 0,
    failures: [],
    audit: args.audit,
  };

  if (!args.apply) {
    console.log(JSON.stringify(summary, null, 2));
    console.log("Dry run only. Re-run with --apply to write Logics UpdateCase SourceID values.");
    return;
  }

  if (args.audit) {
    fs.mkdirSync(path.dirname(path.resolve(args.audit)), { recursive: true });
  }
  const client = createLogicsClient("WYNN");
  let completed = 0;

  await runPool(cases, args.concurrency, async (item) => {
    const sourceId = sourceByKey[item.key];
    const auditBase = {
      ts: new Date().toISOString(),
      caseId: item.caseId,
      routeCampaignKey: item.key,
      label: item.label,
      sourceId,
    };

    try {
      const result = await client.updateCase({ CaseID: item.caseId, SourceID: sourceId });
      summary.ok += 1;
      appendAudit(args.audit, {
        ...auditBase,
        ok: true,
        message: result?.Message || null,
        statusCode: result?.StatusCode || null,
      });
    } catch (error) {
      const body = error?.details?.responseBody || null;
      const message = body?.Message || error.message || "";
      let alreadyOk = false;
      if (/no updates passed|ignore list/i.test(message)) {
        try {
          const info = await client.getCaseInfo(item.caseId);
          alreadyOk = pickCaseSource(info).sourceCampaignId === sourceId;
        } catch {
          alreadyOk = false;
        }
      }

      if (alreadyOk) {
        summary.alreadyOk += 1;
        appendAudit(args.audit, { ...auditBase, ok: true, alreadyOk: true, message });
      } else {
        summary.failed += 1;
        const failure = {
          caseId: item.caseId,
          routeCampaignKey: item.key,
          sourceId,
          message,
          status: error?.details?.responseStatus || error.status || null,
        };
        summary.failures.push(failure);
        appendAudit(args.audit, { ...auditBase, ok: false, ...failure });
      }
    } finally {
      completed += 1;
      if (completed % 100 === 0 || completed === cases.length) {
        console.log(JSON.stringify({
          progress: completed,
          total: cases.length,
          ok: summary.ok,
          alreadyOk: summary.alreadyOk,
          failed: summary.failed,
        }));
      }
      if (args.delayMs > 0) await sleep(args.delayMs);
    }
  });

  console.log(JSON.stringify(summary, null, 2));
})().catch(async (error) => {
  console.error(error && error.stack ? error.stack : error);
  try {
    await mongoose.disconnect();
  } catch (_) {
    // ignore cleanup failure
  }
  process.exit(1);
});
