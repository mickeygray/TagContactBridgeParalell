#!/usr/bin/env node
"use strict";

function option(argv, name) {
  const inline = argv.find((value) => value.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : null;
}

function parseArgs(argv = process.argv.slice(2)) {
  const month = String(option(argv, "month") || "").trim();
  let from = String(option(argv, "from") || "").trim();
  let to = String(option(argv, "to") || "").trim();
  if (month) {
    if (!/^\d{4}-\d{2}$/.test(month)) throw new TypeError("month must use YYYY-MM");
    const [year, monthNumber] = month.split("-").map(Number);
    if (monthNumber < 1 || monthNumber > 12) throw new TypeError("month is invalid");
    from = `${month}-01`;
    const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    to = `${month}-${String(lastDay).padStart(2, "0")}`;
  }
  if (!from || !to) {
    throw new TypeError("use --month=YYYY-MM or both --from=YYYY-MM-DD and --to=YYYY-MM-DD");
  }
  return {
    from,
    to,
    pretty: argv.includes("--pretty"),
  };
}

async function main() {
  const options = parseArgs();
  const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
  const { getSharedConfig } = require("../packages/shared-config/src");
  const { CallLog, DailyDial } = require("../packages/shared-models/src");
  const {
    auditDailyDialCallLogs,
  } = require("../packages/shared-services/src/dailyDialCallLogAuditService");

  await connectMongo(getSharedConfig());
  try {
    const result = await auditDailyDialCallLogs({
      DailyDial,
      CallLog,
      from: options.from,
      to: options.to,
    });
    process.stdout.write(`${JSON.stringify(result, null, options.pretty ? 2 : 0)}\n`);
    if (!result.equalityOk) process.exitCode = 2;
  } finally {
    await disconnectMongo();
  }
}

if (require.main === module) {
  main().catch(() => {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      readOnly: true,
      reason: "phoneburner-daily-dial-calllog-audit-failed",
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
};
