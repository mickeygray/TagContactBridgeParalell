"use strict";

// Backfill names on filler-pool rows that lost their name in the
// repromote step.
//
// The earlier build / repromote sequence ended up writing `name: null`
// onto every pool row (firstName + lastName were $unset, and the
// summarizeCaseInfo at commit time wasn't composing `name` from them).
// Logics still has the FirstName/LastName per case, so this script
// fetches getCaseInfo per pool row and writes the composed name back.
//
// Cheap — pure Logics REST, no RealValidation calls.
//
// Usage:
//   node scripts/backfill-pool-names.js --dry            # show what would change
//   node scripts/backfill-pool-names.js --commit         # write
//   node scripts/backfill-pool-names.js --commit --tag filler-2026-05

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const { MasterProspectIndex } = require("../packages/shared-models/src");
const { createLogicsClient } = require("../packages/shared-integrations/src");

const CONCURRENCY = 25;

function readFlag(argv, name) {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1) return argv[idx + 1];
  return null;
}
function hasFlag(argv, name) {
  return argv.includes(name);
}

function defaultMonthTag(now = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
  });
  const parts = fmt.formatToParts(now);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  return `filler-${year}-${month}`;
}

function pickField(obj, ...keys) {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") {
      return String(v).trim();
    }
  }
  return null;
}

function composeName(caseInfo) {
  const composed = pickField(caseInfo, "Name", "name");
  if (composed) return composed;
  const first = pickField(caseInfo, "FirstName", "firstName");
  const last = pickField(caseInfo, "LastName", "lastName");
  const joined = [first, last].filter(Boolean).join(" ").trim();
  return joined || null;
}

async function runConcurrent(items, concurrency, fn) {
  const results = new Array(items.length);
  let inflight = 0;
  let nextIndex = 0;
  let completed = 0;
  return new Promise((resolve, reject) => {
    function pump() {
      while (inflight < concurrency && nextIndex < items.length) {
        const myIndex = nextIndex;
        nextIndex += 1;
        inflight += 1;
        Promise.resolve()
          .then(() => fn(items[myIndex], myIndex))
          .then((value) => {
            results[myIndex] = value;
            completed += 1;
            inflight -= 1;
            if (completed === items.length) resolve(results);
            else pump();
          })
          .catch(reject);
      }
    }
    if (items.length === 0) resolve(results);
    else pump();
  });
}

async function fetchCaseInfoSafe(client, caseId) {
  try {
    const r = await client.getCaseInfo(caseId);
    return r?.data || r?.Data || r || null;
  } catch (err) {
    return { __error: err.message };
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const commit = hasFlag(argv, "--commit");
  const tag = readFlag(argv, "--tag") || defaultMonthTag(new Date());

  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(process.env.MONGO_URI, { dbName });

  console.log(`══ Pool name backfill ══`);
  console.log(`  mode: ${commit ? "COMMIT" : "DRY"}`);
  console.log(`  tag:  ${tag}\n`);

  // Pull every pool row that's missing a name.
  // (Repromote stripped firstName/lastName, so name is the only field
  //  to look at.)
  const rows = await MasterProspectIndex.find({
    "pool.tag": tag,
    $or: [{ name: null }, { name: "" }, { name: { $exists: false } }],
  })
    .select({ domain: 1, caseId: 1, name: 1 })
    .lean();

  console.log(`[scan] ${rows.length} pool rows missing name\n`);
  if (rows.length === 0) {
    await mongoose.disconnect();
    return;
  }

  const clients = {
    WYNN: createLogicsClient("WYNN"),
    TAG: createLogicsClient("TAG"),
  };

  let processed = 0;
  let resolved = 0;
  let stillMissing = 0;
  let errors = 0;

  const updates = [];

  console.log(`[fetch] resolving names from Logics (concurrency=${CONCURRENCY})...`);

  await runConcurrent(rows, CONCURRENCY, async (row) => {
    const client = clients[row.domain];
    if (!client) {
      errors += 1;
      return;
    }
    const caseInfo = await fetchCaseInfoSafe(client, row.caseId);
    processed += 1;
    if (processed % 500 === 0) {
      console.log(`  …${processed}/${rows.length}  resolved=${resolved}  missing=${stillMissing}  errors=${errors}`);
    }
    if (!caseInfo || caseInfo.__error) {
      errors += 1;
      return;
    }
    const name = composeName(caseInfo);
    if (!name) {
      stillMissing += 1;
      return;
    }
    resolved += 1;
    updates.push({
      updateOne: {
        filter: { domain: row.domain, caseId: row.caseId },
        update: { $set: { name } },
      },
    });
  });

  console.log(`\n[fetch] done.  processed=${processed}  resolved=${resolved}  missing-in-logics=${stillMissing}  errors=${errors}`);

  if (!commit) {
    console.log(`\n[dry] sample of resolved names (first 10):`);
    for (const u of updates.slice(0, 10)) {
      const f = u.updateOne.filter;
      const n = u.updateOne.update.$set.name;
      console.log(`  ${f.domain}/${String(f.caseId).padStart(7)}  ${n}`);
    }
    console.log(`\nRe-run with --commit to apply ${updates.length} updates.`);
    await mongoose.disconnect();
    return;
  }

  if (updates.length === 0) {
    console.log(`[commit] nothing to write.`);
    await mongoose.disconnect();
    return;
  }

  console.log(`\n[commit] writing ${updates.length} name updates...`);
  // bulkWrite in chunks of 1000 to keep payload reasonable
  const CHUNK = 1000;
  let modified = 0;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const slice = updates.slice(i, i + CHUNK);
    const r = await MasterProspectIndex.bulkWrite(slice, { ordered: false });
    modified += r.modifiedCount || 0;
    console.log(`  chunk ${i / CHUNK + 1}/${Math.ceil(updates.length / CHUNK)}: modified=${r.modifiedCount}`);
  }
  console.log(`\n[commit] total modified: ${modified}`);

  // Verify
  const remaining = await MasterProspectIndex.countDocuments({
    "pool.tag": tag,
    $or: [{ name: null }, { name: "" }, { name: { $exists: false } }],
  });
  const withName = await MasterProspectIndex.countDocuments({
    "pool.tag": tag,
    name: { $type: "string", $ne: "" },
  });
  console.log(`\n[verify] pool.tag=${tag}: with-name=${withName}  still-missing=${remaining}`);

  await mongoose.disconnect();
  console.log(`\n[done]`);
}

main().catch((error) => {
  console.error("[backfill-pool-names] FATAL:", error.stack || error.message);
  process.exit(1);
});
