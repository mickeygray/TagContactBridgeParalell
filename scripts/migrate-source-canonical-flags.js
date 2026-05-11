"use strict";

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const { SourceCanonical } = require("../packages/shared-models/src");

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

function normalizeToken(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function parseTokens(value) {
  return String(value || "ABC,BCD")
    .split(",")
    .map(normalizeToken)
    .filter(Boolean);
}

function canonicalMatches(canonical, tokens) {
  const values = [
    canonical.canonicalKey,
    canonical.internalName,
    ...(Array.isArray(canonical.aliases) ? canonical.aliases : []),
  ].map(normalizeToken);
  return values.some((value) => tokens.includes(value));
}

async function main() {
  const argv = process.argv.slice(2);
  const commit = hasFlag(argv, "--commit");
  const tokens = parseTokens(readFlag(argv, "--tokens"));

  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(process.env.MONGO_URI, { dbName });

  const canonicals = await SourceCanonical.find({
    active: { $ne: false },
  })
    .select({
      canonicalKey: 1,
      internalName: 1,
      aliases: 1,
      flags: 1,
    })
    .lean();

  const matches = canonicals.filter((canonical) => canonicalMatches(canonical, tokens));

  console.log("Generic mail catch-all flag migration");
  console.log(`mode: ${commit ? "COMMIT" : "DRY"}`);
  console.log(`tokens: ${tokens.join(", ")}`);
  console.log(`matches: ${matches.length}`);
  for (const canonical of matches) {
    const already = Boolean(canonical.flags?.genericMailCatchall);
    console.log(
      ` - ${canonical.internalName} [${canonical.canonicalKey}] ${already ? "(already flagged)" : ""}`,
    );
  }

  if (commit && matches.length > 0) {
    const result = await SourceCanonical.updateMany(
      { _id: { $in: matches.map((canonical) => canonical._id) } },
      { $set: { "flags.genericMailCatchall": true } },
    );
    console.log(`updated: matched=${result.matchedCount} modified=${result.modifiedCount}`);
  } else if (!commit) {
    console.log("dry run only; rerun with --commit to write flags");
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
