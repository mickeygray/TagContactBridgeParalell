"use strict";

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const { CaseProfile, SourceCanonical } = require("../packages/shared-models/src");
const { caseProfileRepository } = require("../packages/shared-repositories/src");

function readFlag(argv, name) {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  if (index >= 0 && index < argv.length - 1) return argv[index + 1];
  return null;
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function normalizeText(value) {
  return String(value || "").trim();
}

function sameSourceName(left, right) {
  return normalizeText(left).toLowerCase() === normalizeText(right).toLowerCase();
}

async function main() {
  const argv = process.argv.slice(2);
  const commit = hasFlag(argv, "--commit");
  const domain = readFlag(argv, "--domain");
  const limit = Math.min(Number(readFlag(argv, "--limit")) || 10000, 100000);

  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(process.env.MONGO_URI, { dbName });

  const query = {
    sourceCanonicalId: { $ne: null },
  };
  if (domain) query.domain = String(domain).toUpperCase();

  const cursor = CaseProfile.find(query)
    .select({
      _id: 1,
      domain: 1,
      caseId: 1,
      sourceCanonicalId: 1,
      sourceName: 1,
      sourceChannel: 1,
    })
    .limit(limit)
    .lean()
    .cursor();

  const canonicalCache = new Map();
  let scanned = 0;
  let missingCanonical = 0;
  let drifted = 0;
  let updated = 0;
  let skippedLocked = 0;
  const samples = [];

  for await (const cp of cursor) {
    scanned += 1;
    const canonicalId = String(cp.sourceCanonicalId || "");
    let canonical = canonicalCache.get(canonicalId);
    if (canonical === undefined) {
      canonical = await SourceCanonical.findById(canonicalId)
        .select({ _id: 1, internalName: 1, channel: 1 })
        .lean();
      canonicalCache.set(canonicalId, canonical || null);
    }

    if (!canonical) {
      missingCanonical += 1;
      continue;
    }

    const nameMatches = sameSourceName(cp.sourceName, canonical.internalName);
    const channelMatches = normalizeText(cp.sourceChannel) === normalizeText(canonical.channel);
    if (nameMatches && channelMatches) continue;

    drifted += 1;
    if (samples.length < 20) {
      samples.push({
        domain: cp.domain,
        caseId: cp.caseId,
        from: cp.sourceName || "",
        to: canonical.internalName || "",
        channelFrom: cp.sourceChannel || "",
        channelTo: canonical.channel || "",
      });
    }

    if (!commit) continue;

    const result = await caseProfileRepository.writeSourceAttribution(cp.domain, cp.caseId, {
      sourceCanonicalId: canonical._id,
      matchedBy: "source-name-canonical-migration",
      confidence: "high",
      forceMirrorSourceName: true,
      allowOverwriteLocked: true,
    });

    if (result.ok) updated += 1;
    else if (result.reason === "locked-manual-or-not-found") skippedLocked += 1;
  }

  console.log("CaseProfile sourceName/sourceChannel canonical sync");
  console.log(`mode: ${commit ? "COMMIT" : "DRY"}`);
  if (domain) console.log(`domain: ${String(domain).toUpperCase()}`);
  console.log(`scanned: ${scanned}`);
  console.log(`drifted: ${drifted}`);
  console.log(`missing canonical: ${missingCanonical}`);
  if (commit) {
    console.log(`updated: ${updated}`);
    console.log(`skipped locked/not found: ${skippedLocked}`);
  } else {
    console.log("dry run only; rerun with --commit to write changes");
  }

  for (const sample of samples) {
    console.log(
      ` - ${sample.domain} ${sample.caseId}: "${sample.from}" -> "${sample.to}", ` +
        `channel "${sample.channelFrom}" -> "${sample.channelTo}"`,
    );
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch (_) {
    // ignore
  }
  process.exitCode = 1;
});
