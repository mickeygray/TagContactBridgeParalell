"use strict";

// Break down today's null-caseId CallLog rows by phone-digit-length.
// Per the operator's heuristic: 3-4 digit dialed numbers are internal
// extension calls (never tied to a case, fine to ignore). Anything
// with 7+ digits should resolve to a case — if it isn't, that's a real
// attribution gap, not an "internal" call.

require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
const mongoose = require("mongoose");

const { CallLog } = require("../packages/shared-models/src");
const { buildTimezoneDateWindow } = require("../packages/shared-services/src/timezoneDateWindowService");

function digitsOf(phone) {
  return String(phone || "").replace(/\D/g, "");
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(uri, { dbName });

  const TZ = "America/Los_Angeles";
  const dk = process.argv[2] || new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const { start, end } = buildTimezoneDateWindow(dk, TZ);

  for (const domain of ["TAG", "WYNN"]) {
    console.log(`\n=== ${domain} ${dk} — null-caseId rows by phone-digit-length ===`);
    const rows = await CallLog.find(
      {
        domain,
        callStartTime: { $gte: start, $lte: end },
        caseId: null,
      },
      { phone: 1, normalizedPhone: 1, direction: 1, agentName: 1, telephonySessionId: 1, callStartTime: 1 },
    ).limit(500).lean();

    const bins = {
      total: rows.length,
      lenBuckets: {},
      tenDigitRows: [],
    };
    for (const r of rows) {
      const digits = digitsOf(r.phone || r.normalizedPhone);
      const bucket = digits.length === 0 ? "0" :
        digits.length <= 4 ? "1-4 (internal)" :
        digits.length <= 6 ? "5-6 (short)" :
        digits.length === 7 ? "7 (local)" :
        digits.length === 10 ? "10 (US)" :
        digits.length === 11 ? "11 (1+US)" :
        `${digits.length} (other)`;
      bins.lenBuckets[bucket] = (bins.lenBuckets[bucket] || 0) + 1;
      if (digits.length >= 10) {
        bins.tenDigitRows.push({
          phone: r.phone,
          normalized: digits,
          direction: r.direction,
          agentName: r.agentName,
          startedAt: r.callStartTime,
        });
      }
    }
    console.log(`  total null-caseId: ${bins.total}`);
    console.log(`  by digit-length:`, JSON.stringify(bins.lenBuckets, null, 2));
    if (bins.tenDigitRows.length) {
      console.log(`  10+ digit rows with no caseId (attribution gap candidates): ${bins.tenDigitRows.length}`);
      for (const r of bins.tenDigitRows.slice(0, 12)) {
        console.log(`    ${r.startedAt?.toISOString?.()} ${r.direction} phone=${r.phone} agent=${r.agentName}`);
      }
    }
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
