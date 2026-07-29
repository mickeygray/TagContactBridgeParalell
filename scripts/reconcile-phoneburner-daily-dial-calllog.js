#!/usr/bin/env node
"use strict";

function option(argv, name) {
  const inline = argv.find((value) => value.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : null;
}

function parseArgs(argv = process.argv.slice(2)) {
  const from = String(option(argv, "from") || "").trim();
  const to = String(option(argv, "to") || "").trim();
  if (!from || !to) {
    throw new TypeError("both --from=YYYY-MM-DD and --to=YYYY-MM-DD are required");
  }
  return {
    from,
    to,
    apply: argv.includes("--apply"),
    pretty: argv.includes("--pretty"),
  };
}

function unsafeRepairReasons(audit) {
  const totals = audit?.totals || {};
  const reasons = [];
  if (Number(totals.nonPhoneBurnerAttempts || 0) > 0) {
    reasons.push("out-of-scope-provider-attempts");
  }
  if (Number(totals.explicitRejects || 0) > 0) reasons.push("daily-dial-rejects");
  if (Number(totals.duplicates || 0) > 0) reasons.push("identity-duplicates");
  if (Number(totals.mismatched || 0) > 0) reasons.push("existing-calllog-mismatch");
  if (Number(totals.unexpectedProjectedCallLogs || 0) > 0) {
    reasons.push("unexpected-calllog-projections");
  }
  return reasons;
}

async function main() {
  const options = parseArgs();
  const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
  const { getSharedConfig } = require("../packages/shared-config/src");
  const { CallLog, DailyDial } = require("../packages/shared-models/src");
  const {
    callLogRepository,
    userAccountRepository,
  } = require("../packages/shared-repositories/src");
  const {
    getPacificDateKey,
  } = require("../packages/shared-services/src/leadDeliveryService");
  const {
    createDailyDialCallLogProjection,
  } = require("../packages/shared-services/src/dailyDialCallLogProjectionService");
  const {
    auditDailyDialCallLogs,
  } = require("../packages/shared-services/src/dailyDialCallLogAuditService");
  const configuration = require("../config/lead-delivery-agents.json");

  await connectMongo(getSharedConfig());
  try {
    const before = await auditDailyDialCallLogs({
      DailyDial,
      CallLog,
      from: options.from,
      to: options.to,
    });
    if (!options.apply) {
      process.stdout.write(`${JSON.stringify({
        ...before,
        applied: false,
        mode: "dry-run",
      }, null, options.pretty ? 2 : 0)}\n`);
      if (!before.equalityOk) process.exitCode = 2;
      return;
    }

    const today = getPacificDateKey(new Date());
    if (options.to >= today) {
      process.stdout.write(`${JSON.stringify({
        ok: false,
        applied: false,
        reason: "apply-requires-closed-date-range",
        range: before.range,
      }, null, options.pretty ? 2 : 0)}\n`);
      process.exitCode = 3;
      return;
    }
    const blockedBy = unsafeRepairReasons(before);
    if (blockedBy.length > 0) {
      process.stdout.write(`${JSON.stringify({
        ok: false,
        applied: false,
        reason: "repair-preflight-blocked",
        blockedBy,
        before,
      }, null, options.pretty ? 2 : 0)}\n`);
      process.exitCode = 3;
      return;
    }

    let inserted = 0;
    let skippedExisting = 0;
    const insertMissingCallLog = async (input) => {
      const exists = await CallLog.exists({
        domain: String(input.domain || "").trim().toUpperCase(),
        telephonySessionId: String(input.telephonySessionId || ""),
      });
      if (exists) {
        skippedExisting += 1;
        return null;
      }
      const result = await callLogRepository.upsertCallLog(input);
      inserted += 1;
      return result;
    };
    const reconcile = createDailyDialCallLogProjection({
      DailyDial,
      upsertCallLog: insertMissingCallLog,
      resolveAgent: async (agentId) => {
        const configured = configuration?.agents?.[
          String(agentId || "").trim().toLowerCase()
        ] || null;
        const email = String(configured?.applicationAccountEmail || "").trim().toLowerCase();
        const account = email
          ? await userAccountRepository.findUserAccountByEmail(email)
          : null;
        return {
          extensionId: account?.extensionId || null,
          name: account?.name || configured?.displayName || null,
        };
      },
    });

    const dates = [];
    for (const day of before.dates) {
      if (Number(day.missing || 0) < 1) continue;
      const result = await reconcile({ dateKey: day.dateKey });
      dates.push({
        dateKey: day.dateKey,
        status: result.status,
        attempts: result.attempts,
        reconciled: result.reconciled,
        rejected: result.rejected,
        agentUnmapped: result.agentUnmapped,
      });
    }
    const after = await auditDailyDialCallLogs({
      DailyDial,
      CallLog,
      from: options.from,
      to: options.to,
    });
    process.stdout.write(`${JSON.stringify({
      ok: after.equalityOk,
      applied: true,
      mode: "missing-calllogs-only",
      range: after.range,
      inserted,
      skippedExisting,
      dates,
      before,
      after,
    }, null, options.pretty ? 2 : 0)}\n`);
    if (!after.equalityOk) process.exitCode = 2;
  } finally {
    await disconnectMongo();
  }
}

if (require.main === module) {
  main().catch(() => {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      applied: false,
      reason: "phoneburner-daily-dial-calllog-repair-failed",
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  unsafeRepairReasons,
};
