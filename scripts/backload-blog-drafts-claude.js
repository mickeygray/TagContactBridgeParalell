"use strict";

// Backloader v2 — uses Claude (Sonnet) to write a draft for every
// topic seed in scripts/blogger-corpus.js. Idempotent: skips seeds
// whose draft file already exists in scripts/blog-drafts/. Drafts
// written by Claude carry a `generatedBy` + `generatedAt` so we can
// audit which drafts came from which model.
//
// Usage:
//   node scripts/backload-blog-drafts-claude.js                # all seeds
//   node scripts/backload-blog-drafts-claude.js --only <id>    # one seed
//   node scripts/backload-blog-drafts-claude.js --limit 5      # first N
//   node scripts/backload-blog-drafts-claude.js --dry-run      # show plan

const fs = require("fs");
const path = require("path");

// `override: true` because Windows shells sometimes inject an empty
// ANTHROPIC_API_KEY into the parent env which beats dotenv's default
// non-override behavior. Force the .env file to win.
require("dotenv").config({
  path: path.resolve(__dirname, "..", ".env"),
  override: true,
});

const { SEEDS } = require("./blogger-corpus");
const { createWriter } = require("./blogger-claude-writer");

const DRAFTS_DIR = path.resolve(__dirname, "blog-drafts");
fs.mkdirSync(DRAFTS_DIR, { recursive: true });
fs.mkdirSync(path.join(DRAFTS_DIR, "posted"), { recursive: true });

function parseArgs(argv = []) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || "");
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || String(next).startsWith("--")) {
      args[key] = "true";
      continue;
    }
    args[key] = String(next);
    i += 1;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = args["dry-run"] === "true";
  const onlyId = args.only || null;
  const limit = args.limit ? Math.max(1, Number(args.limit)) : null;

  const candidateSeeds = SEEDS.filter((seed) => {
    if (onlyId) return seed.id === onlyId;
    const filename = path.join(DRAFTS_DIR, `${seed.id}.json`);
    return !fs.existsSync(filename);
  });
  const seedsToRun = limit ? candidateSeeds.slice(0, limit) : candidateSeeds;

  console.log(JSON.stringify({
    event: "backload-start",
    totalSeeds: SEEDS.length,
    alreadyDrafted: SEEDS.length - candidateSeeds.length,
    plannedThisRun: seedsToRun.length,
    dryRun,
  }));

  if (dryRun) {
    for (const seed of seedsToRun) {
      console.log(`  - [${seed.category}] ${seed.id}`);
    }
    return;
  }

  if (seedsToRun.length === 0) {
    console.log("[backloader] nothing to do — all seeds already drafted");
    return;
  }

  const writer = createWriter();
  const results = { written: 0, failed: 0, errors: [] };

  for (const seed of seedsToRun) {
    const filename = path.join(DRAFTS_DIR, `${seed.id}.json`);
    process.stdout.write(`[backloader] writing ${seed.id} (${seed.category})... `);
    try {
      const draft = await writer.writeBlogDraft(seed);
      fs.writeFileSync(filename, JSON.stringify(draft, null, 2), "utf8");
      results.written += 1;
      console.log("ok");
    } catch (err) {
      results.failed += 1;
      results.errors.push({ id: seed.id, error: String(err.message || err) });
      console.log(`FAILED: ${err.message}`);
    }
    // Slight throttle between requests so we don't hit Anthropic
    // rate limits when running through 20+ seeds.
    await new Promise((resolve) => setTimeout(resolve, 750));
  }

  console.log(JSON.stringify({
    event: "backload-complete",
    written: results.written,
    failed: results.failed,
    errors: results.errors,
    draftsDir: DRAFTS_DIR,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
