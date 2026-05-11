"use strict";

// One-time (per Drive) migration: take the flat-archived recordings
// living directly under each bucket folder (OG/AS/CS) and move them
// into `<bucket>/<dateKey>/` subfolders so the player can render a
// date picker instead of one giant flat list.
//
// The date is parsed from the filename — the archiver writes
// `AGENT__BUCKET__YYYY-MM-DD__phone__id.ext`, so we extract the third
// `__`-delimited segment if it matches `YYYY-MM-DD`, falling back to a
// regex sweep for any embedded `YYYY-MM-DD` substring (covers oddly
// renamed legacy files).
//
// Flags:
//   --apply              actually move files (default: dry-run)
//   --buckets OG,AS,CS   restrict to specific buckets (default: all)
//   --max-per-bucket N   cap files moved per bucket (debug; 0 = no cap)
//   --concurrency N      parallel moves per bucket (default: 4)
//   --batch-delay-ms N   delay between batches (default: 250ms)
//
// Idempotent: re-running after partial completion just resumes — files
// already in date subfolders aren't at the bucket root anymore so the
// listing skips them.

const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const {
  createGoogleDriveClient,
} = require("../packages/shared-integrations/src");
const {
  getSharedConfig,
} = require("../packages/shared-config/src");

const FOLDER_MIME = "application/vnd.google-apps.folder";
const DATE_REGEX = /\b(\d{4}-\d{2}-\d{2})\b/;

function parseArgs(argv = []) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || String(next).startsWith("--")) {
      args[key] = "true";
      continue;
    }
    args[key] = String(next);
    index += 1;
  }
  return args;
}

function intArg(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolArg(value, fallback = false) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  return !["0", "false", "no", "off"].includes(normalized);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(Number(ms) || 0, 0)));
}

function extractDateFromName(name) {
  const raw = String(name || "");
  // Preferred: third __-delimited segment, since the archiver writes
  // exactly that layout. Falling back to a regex catches files renamed
  // by hand or imported from elsewhere with the date in some other
  // position.
  const segments = raw.split("__");
  if (segments.length >= 3 && /^\d{4}-\d{2}-\d{2}$/.test(segments[2])) {
    return segments[2];
  }
  const match = raw.match(DATE_REGEX);
  return match ? match[1] : null;
}

async function listAllChildren(driveClient, parentId) {
  const items = [];
  let pageToken = null;
  do {
    const page = await driveClient.listFilesInFolder({
      parentId,
      pageSize: 1000,
      pageToken,
    });
    for (const file of page.files) {
      items.push(file);
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return items;
}

function chunk(list, size) {
  const groups = [];
  for (let index = 0; index < list.length; index += size) {
    groups.push(list.slice(index, index + size));
  }
  return groups;
}

async function migrateBucket({
  driveClient,
  bucketKey,
  bucketFolderId,
  apply,
  maxPerBucket,
  concurrency,
  batchDelayMs,
}) {
  const stats = {
    bucket: bucketKey,
    bucketFolderId,
    listedAtRoot: 0,
    foldersAtRoot: 0,
    filesAtRoot: 0,
    skippedDateless: 0,
    plannedMoves: 0,
    movedOk: 0,
    moveFailures: 0,
    perDate: {},
  };

  const children = await listAllChildren(driveClient, bucketFolderId);
  stats.listedAtRoot = children.length;

  // Anything that's already a folder is presumably a date subfolder we
  // (or a previous run) created. Leave it alone.
  const filesAtRoot = children.filter((file) => file.mimeType !== FOLDER_MIME);
  stats.foldersAtRoot = children.length - filesAtRoot.length;
  stats.filesAtRoot = filesAtRoot.length;

  const grouped = new Map(); // dateKey -> [file]
  for (const file of filesAtRoot) {
    const dateKey = extractDateFromName(file.name);
    if (!dateKey) {
      stats.skippedDateless += 1;
      continue;
    }
    if (!grouped.has(dateKey)) grouped.set(dateKey, []);
    grouped.get(dateKey).push(file);
  }

  // Honor caller's per-bucket cap by trimming oldest dates first (since
  // newest is what people care about most for a partial run).
  if (maxPerBucket > 0) {
    let remaining = maxPerBucket;
    const sortedDates = [...grouped.keys()].sort().reverse();
    const trimmedGroups = new Map();
    for (const dateKey of sortedDates) {
      if (remaining <= 0) break;
      const files = grouped.get(dateKey);
      if (files.length <= remaining) {
        trimmedGroups.set(dateKey, files);
        remaining -= files.length;
      } else {
        trimmedGroups.set(dateKey, files.slice(0, remaining));
        remaining = 0;
      }
    }
    grouped.clear();
    for (const [dateKey, files] of trimmedGroups.entries()) {
      grouped.set(dateKey, files);
    }
  }

  for (const [dateKey, files] of grouped.entries()) {
    stats.perDate[dateKey] = {
      planned: files.length,
      movedOk: 0,
      failures: 0,
    };
    stats.plannedMoves += files.length;
  }

  if (!apply) {
    return stats;
  }

  const dateKeysSorted = [...grouped.keys()].sort().reverse();
  for (const dateKey of dateKeysSorted) {
    const files = grouped.get(dateKey);
    if (!files || files.length === 0) continue;

    const subfolder = await driveClient.ensureFolder({
      parentId: bucketFolderId,
      name: dateKey,
    });
    const subfolderId = subfolder?.id;
    if (!subfolderId) {
      stats.perDate[dateKey].failures += files.length;
      stats.moveFailures += files.length;
      continue;
    }

    const batches = chunk(files, Math.max(1, concurrency));
    for (const batch of batches) {
      await Promise.all(
        batch.map(async (file) => {
          try {
            await driveClient.moveFile({
              fileId: file.id,
              addParents: [subfolderId],
              // file.parents always contains the bucket folder for
              // root-level files, but pass it explicitly so we strip
              // exactly the parent we intended (defensive vs files
              // sitting in multiple parents).
              removeParents: [bucketFolderId],
            });
            stats.perDate[dateKey].movedOk += 1;
            stats.movedOk += 1;
          } catch (error) {
            stats.perDate[dateKey].failures += 1;
            stats.moveFailures += 1;
            stats.perDate[dateKey].lastError = String(
              error?.message || error,
            );
          }
        }),
      );
      if (batchDelayMs > 0) await sleep(batchDelayMs);
    }
  }

  return stats;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apply = boolArg(args.apply, false);
  const bucketFilter = String(args.buckets || "")
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
  const maxPerBucket = Math.max(intArg(args["max-per-bucket"], 0), 0);
  const concurrency = Math.max(intArg(args.concurrency, 4), 1);
  const batchDelayMs = Math.max(intArg(args["batch-delay-ms"], 250), 0);

  const sharedConfig = getSharedConfig();
  const archiveConfig = sharedConfig.recordingArchive || {};
  const driveConfig = archiveConfig.drive || {};
  const destinations = archiveConfig.destinations || {};
  const allBuckets = [
    ["OG", String(destinations.og?.folderId || "").trim()],
    ["AS", String(destinations.as?.folderId || "").trim()],
    ["CS", String(destinations.cs?.folderId || "").trim()],
  ];
  const buckets = allBuckets.filter(
    ([key, folderId]) =>
      Boolean(folderId) &&
      (bucketFilter.length === 0 || bucketFilter.includes(key)),
  );

  if (buckets.length === 0) {
    // eslint-disable-next-line no-console
    console.error(
      "No bucket folders configured (or all filtered out). Check shared-config recordingArchive.destinations.{og,as,cs}.folderId.",
    );
    process.exit(1);
  }

  const driveClient = createGoogleDriveClient(driveConfig);
  if (!driveClient.isConfigured()) {
    // eslint-disable-next-line no-console
    console.error(
      "Google Drive client is not configured (missing client_email/private_key/scope). Aborting.",
    );
    process.exit(1);
  }

  const summary = {
    apply,
    runMode: apply ? "apply" : "dry-run",
    bucketFilter: bucketFilter.length ? bucketFilter : "ALL",
    maxPerBucket,
    concurrency,
    batchDelayMs,
    startedAt: new Date().toISOString(),
    buckets: [],
    totals: {
      filesAtRoot: 0,
      plannedMoves: 0,
      movedOk: 0,
      moveFailures: 0,
      skippedDateless: 0,
    },
  };

  for (const [bucketKey, bucketFolderId] of buckets) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      event: "bucket-start",
      bucket: bucketKey,
      bucketFolderId,
      mode: summary.runMode,
    }));
    const stats = await migrateBucket({
      driveClient,
      bucketKey,
      bucketFolderId,
      apply,
      maxPerBucket,
      concurrency,
      batchDelayMs,
    });
    summary.buckets.push(stats);
    summary.totals.filesAtRoot += stats.filesAtRoot;
    summary.totals.plannedMoves += stats.plannedMoves;
    summary.totals.movedOk += stats.movedOk;
    summary.totals.moveFailures += stats.moveFailures;
    summary.totals.skippedDateless += stats.skippedDateless;
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ event: "bucket-done", ...stats }));
  }

  summary.endedAt = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ event: "summary", ...summary }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
}
