"use strict";

// One-shot cleanup: walk every recording in the OG/AS/CS Drive
// folders (recursive into date subfolders), parse the actual audio
// file's duration via music-metadata (NOT the API-reported call
// duration — those drift from the recording's true length when calls
// transfer, IVR-trim, or clip early), and trash anything under the
// threshold (default 480s = 8 minutes).
//
// Why parse the file directly:
//   - RC's call-log `duration` and CallRail's `recording_duration`
//     are based on the call lifecycle, not the audio file. A call
//     that lasted 8 minutes can produce a 3-minute audio file if the
//     recording started after an IVR, ended at a transfer, or was
//     clipped by the provider.
//   - music-metadata reads only the file header (a few KB), so we
//     don't have to download whole files.
//
// Trash semantics: Drive trash (recoverable for ~30 days), not
// permanent delete. Operator can restore via Drive UI if needed.
//
// Usage:
//   node scripts/cleanup-short-recordings.js                      # dry-run, all buckets
//   node scripts/cleanup-short-recordings.js --apply              # actually trash files
//   node scripts/cleanup-short-recordings.js --buckets OG,AS      # restrict
//   node scripts/cleanup-short-recordings.js --threshold 600      # custom seconds
//   node scripts/cleanup-short-recordings.js --max-files 50       # debug cap
//   node scripts/cleanup-short-recordings.js --concurrency 8      # parallel parses

const path = require("path");
const { Readable } = require("stream");
const mm = require("music-metadata");

require("dotenv").config({
  path: path.resolve(__dirname, "..", ".env"),
});

const {
  createGoogleDriveClient,
} = require("../packages/shared-integrations/src");
const { getSharedConfig } = require("../packages/shared-config/src");

const DEFAULT_THRESHOLD_SEC = 480;
const DEFAULT_CONCURRENCY = 8;

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

async function walkFolderRecursively(driveClient, parentId) {
  const out = [];
  const stack = [parentId];
  while (stack.length > 0) {
    const folderId = stack.pop();
    let pageToken = null;
    do {
      const page = await driveClient.listFilesInFolder({
        parentId: folderId,
        pageSize: 1000,
        pageToken,
        fields:
          "nextPageToken, files(id,name,mimeType,parents,appProperties,size)",
      });
      for (const file of page.files) {
        if (file.mimeType === "application/vnd.google-apps.folder") {
          stack.push(file.id);
        } else {
          out.push(file);
        }
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
  }
  return out;
}

// Stream a Drive file through music-metadata. Stops as soon as the
// metadata is parsed — typically reads only a few KB. Falls back to
// downloading more if the format requires it.
async function parseAudioDurationFromDrive(driveClient, fileId, mimeType) {
  const token = await driveClient.getAccessToken();
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
  const response = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`Drive download HTTP ${response.status}`);
  }
  // Convert Web ReadableStream → Node Readable for music-metadata.
  const nodeStream = Readable.fromWeb(response.body);
  // music-metadata supports {duration: true} to short-circuit on
  // duration, plus {skipPostHeaders: true} for fast MP3 reads.
  const metadata = await mm.parseStream(
    nodeStream,
    { mimeType: mimeType || undefined, size: undefined },
    { duration: true, skipCovers: true, skipPostHeaders: true },
  );
  // Defensive — make sure the stream is fully consumed/cancelled.
  try {
    nodeStream.destroy();
  } catch {
    // ignore
  }
  const seconds = Number(metadata?.format?.duration || 0);
  return Number.isFinite(seconds) ? seconds : 0;
}

// Concurrency-limited mapper. Resolves with an array of results in
// input order. `worker(item, index)` returns a promise.
async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      try {
        results[idx] = await worker(items[idx], idx);
      } catch (err) {
        results[idx] = { error: err };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apply = boolArg(args.apply, false);
  const threshold = Math.max(intArg(args.threshold, DEFAULT_THRESHOLD_SEC), 1);
  const maxFiles = Math.max(intArg(args["max-files"], 0), 0);
  const concurrency = Math.max(intArg(args.concurrency, DEFAULT_CONCURRENCY), 1);
  const bucketFilter = String(args.buckets || "")
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);

  const sharedConfig = getSharedConfig();
  const archiveConfig = sharedConfig.recordingArchive || {};
  const driveConfig = archiveConfig.drive || {};
  const destinations = archiveConfig.destinations || {};
  const allBuckets = [
    ["OG", String(destinations.og?.folderId || "").trim()],
    ["CX", String(destinations.cx?.folderId || "").trim()],
    ["AS", String(destinations.as?.folderId || "").trim()],
    ["CS", String(destinations.cs?.folderId || "").trim()],
  ];
  const buckets = allBuckets.filter(
    ([key, folderId]) =>
      Boolean(folderId) &&
      (bucketFilter.length === 0 || bucketFilter.includes(key)),
  );
  if (buckets.length === 0) {
    console.error("No bucket folders configured / matched");
    process.exit(1);
  }

  const driveClient = createGoogleDriveClient(driveConfig);
  if (!driveClient.isConfigured()) {
    console.error("Drive client not configured");
    process.exit(1);
  }

  // ── 1. Walk every file ─────────────────────────────────────────
  console.log(JSON.stringify({
    event: "walking-buckets",
    buckets: buckets.map(([k]) => k),
    threshold,
    apply,
    concurrency,
  }));

  const allFiles = [];
  for (const [bucketKey, folderId] of buckets) {
    const files = await walkFolderRecursively(driveClient, folderId);
    for (const f of files) {
      f.bucket = bucketKey;
      allFiles.push(f);
    }
    console.log(`  ${bucketKey}: ${files.length} files`);
  }
  console.log(`Total files: ${allFiles.length}`);

  const filesToCheck = maxFiles > 0 ? allFiles.slice(0, maxFiles) : allFiles;

  // ── 2. Parse each file's actual audio duration ─────────────────
  console.log(`[cleanup] parsing audio duration for ${filesToCheck.length} files (concurrency=${concurrency})...`);
  let parsed = 0;
  const startedAt = Date.now();

  const resolutions = await mapWithConcurrency(
    filesToCheck,
    concurrency,
    async (file) => {
      try {
        const seconds = await parseAudioDurationFromDrive(
          driveClient,
          file.id,
          file.mimeType,
        );
        parsed += 1;
        if (parsed % 25 === 0) {
          const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
          console.log(`  ${parsed}/${filesToCheck.length} (${elapsed}s)`);
        }
        return { file, durationSec: seconds, error: null };
      } catch (err) {
        return { file, durationSec: null, error: err.message };
      }
    },
  );

  const tooShort = [];
  const ok = [];
  const unknown = [];
  for (const r of resolutions) {
    if (r.error || r.durationSec == null || r.durationSec === 0) {
      unknown.push(r);
    } else if (r.durationSec < threshold) {
      tooShort.push(r);
    } else {
      ok.push(r);
    }
  }

  // Bucket-level breakdown for quick eyeballing.
  const byBucket = (group) =>
    group.reduce((acc, r) => {
      const key = r.file.bucket || "?";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});

  console.log(JSON.stringify({
    event: "decision",
    threshold,
    totalChecked: resolutions.length,
    tooShort: tooShort.length,
    tooShortByBucket: byBucket(tooShort),
    ok: ok.length,
    okByBucket: byBucket(ok),
    unknown: unknown.length,
    unknownByBucket: byBucket(unknown),
    sampleTooShort: tooShort.slice(0, 8).map((r) => ({
      bucket: r.file.bucket,
      name: r.file.name,
      durationSec: Math.round(r.durationSec),
      sizeBytes: Number(r.file.size || 0),
    })),
    sampleUnknown: unknown.slice(0, 5).map((r) => ({
      bucket: r.file.bucket,
      name: r.file.name,
      error: r.error || "no-duration",
    })),
  }, null, 2));

  if (!apply) {
    console.log("[cleanup] dry-run — pass --apply to actually trash short recordings");
    return;
  }

  // ── 3. Trash the short ones ────────────────────────────────────
  console.log(`[cleanup] trashing ${tooShort.length} files...`);
  let trashed = 0;
  let failed = 0;
  for (const r of tooShort) {
    try {
      const token = await driveClient.getAccessToken();
      const url = new URL(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(r.file.id)}`,
      );
      url.searchParams.set("supportsAllDrives", "true");
      const response = await fetch(url.toString(), {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ trashed: true }),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
      }
      trashed += 1;
      if (trashed % 25 === 0) {
        console.log(`  trashed ${trashed}/${tooShort.length}`);
      }
    } catch (err) {
      failed += 1;
      console.error(`  FAILED to trash ${r.file.name}: ${err.message}`);
    }
  }

  console.log(JSON.stringify({
    event: "cleanup-complete",
    threshold,
    tooShort: tooShort.length,
    trashed,
    failed,
    unknown: unknown.length,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
