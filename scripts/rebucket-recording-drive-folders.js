"use strict";

// One-off Drive rebucketer for call recordings.
//
// Rules:
//   - CallRail recordings stay in OG.
//   - Named AS/CS reps move to the AS/CS target folder. In current
//     config that is CSERV CALLS, because there is no separate AS root
//     visible to the service account.
//   - Everything else moves to CX.
//
// Default is dry-run. Pass --apply to move files.

const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const {
  createGoogleDriveClient,
} = require("../packages/shared-integrations/src");
const {
  getSharedConfig,
} = require("../packages/shared-config/src");

const FOLDER_MIME = "application/vnd.google-apps.folder";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ASCS_AGENT_NAMES = [
  "Neyla Ramirez",
  "Neyla",
  "Jonathan Haro",
  "Leo Collins",
  "Leo",
  "Matthew Anderson",
  "Matthew",
  "Matt Anderson",
  "Andrew Wells",
  "Andrew",
  "Monica Cazares",
  "Monica",
];
const ALWAYS_CX_AGENT_NAMES = [
  "Chris Bolt",
  "Brad Hansen",
  "James Sharp",
];

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

function boolArg(value, fallback = false) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  return !["0", "false", "no", "off"].includes(normalized);
}

function intArg(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(Number(ms) || 0, 0)));
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractDateKey(file, parentName = "") {
  const appDate = String(file?.appProperties?.dateKey || "").trim();
  if (DATE_RE.test(appDate)) return appDate;

  const parent = String(parentName || "").trim();
  if (DATE_RE.test(parent)) return parent;

  const name = String(file?.name || "");
  const segments = name.split("__");
  if (segments.length >= 3 && DATE_RE.test(segments[2])) return segments[2];
  const match = name.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  return match ? match[1] : null;
}

function nameMatchesHaystack(haystack, name) {
  const normalizedName = normalizeText(name);
  if (!normalizedName) return false;
  return ` ${haystack} `.includes(` ${normalizedName} `);
}

function agentNameHit(file, names) {
  const haystack = normalizeText([
    file.name,
    file.appProperties?.agentName,
    file.appProperties?.agent,
  ].filter(Boolean).join(" "));
  return names.find((name) => nameMatchesHaystack(haystack, name)) || null;
}

function isCallRail(file) {
  const provider = normalizeText(file?.appProperties?.provider);
  if (provider === "callrail") return true;
  const source = normalizeText([
    file.name,
    file.appProperties?.source,
    file.appProperties?.sourceKind,
  ].filter(Boolean).join(" "));
  return source.includes("callrail") || source.includes("call rail");
}

function inferBucketFromFile(file, currentBucket) {
  const bucket = String(file?.appProperties?.bucket || "").trim().toUpperCase();
  if (bucket) return bucket;
  const segments = String(file?.name || "").split("__");
  if (segments.length >= 2 && /^[A-Z]{2,4}$/.test(segments[1])) return segments[1];
  return currentBucket;
}

function targetBucketForFile(file, currentBucket) {
  if (isCallRail(file)) {
    return { bucket: "OG", reason: "callrail-provider", agent: null };
  }
  const alwaysCxAgent = agentNameHit(file, ALWAYS_CX_AGENT_NAMES);
  if (alwaysCxAgent) {
    return { bucket: "CX", reason: "always-cx-agent", agent: alwaysCxAgent };
  }
  const ascsAgent = agentNameHit(file, ASCS_AGENT_NAMES);
  if (ascsAgent) {
    return { bucket: "ASCS", reason: "named-as-cs-agent", agent: ascsAgent };
  }
  return {
    bucket: "CX",
    reason: inferBucketFromFile(file, currentBucket) === "OG"
      ? "non-callrail-og-to-cx"
      : "default-cx",
    agent: null,
  };
}

function buildBuckets(destinations = {}) {
  const og = String(destinations.og?.folderId || "").trim();
  const cx = String(destinations.cx?.folderId || "").trim();
  const as = String(destinations.as?.folderId || "").trim();
  const cs = String(destinations.cs?.folderId || "").trim();
  return {
    OG: { key: "OG", folderId: og },
    CX: { key: "CX", folderId: cx || as },
    ASCS: { key: "ASCS", folderId: cs || as },
    CS: { key: "CS", folderId: cs },
    AS: { key: "AS", folderId: as },
  };
}

async function listAllChildren(driveClient, parentId) {
  const items = [];
  let pageToken = null;
  do {
    const page = await driveClient.listFilesInFolder({
      parentId,
      pageSize: 1000,
      pageToken,
      fields: "nextPageToken, files(id,name,mimeType,parents,appProperties,size,modifiedTime)",
    });
    items.push(...page.files);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return items;
}

async function listBucketFiles(driveClient, bucketKey, bucketFolderId) {
  const rows = [];
  const rootChildren = await listAllChildren(driveClient, bucketFolderId);
  for (const child of rootChildren) {
    if (child.mimeType === FOLDER_MIME) {
      const nested = await listAllChildren(driveClient, child.id);
      for (const file of nested.filter((item) => item.mimeType !== FOLDER_MIME)) {
        rows.push({
          bucket: bucketKey,
          bucketFolderId,
          parentId: child.id,
          parentName: child.name,
          file,
        });
      }
      continue;
    }
    rows.push({
      bucket: bucketKey,
      bucketFolderId,
      parentId: bucketFolderId,
      parentName: "",
      file: child,
    });
  }
  return rows;
}

async function patchFileMetadata(driveClient, fileId, body) {
  const token = await driveClient.getAccessToken();
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("fields", "id,name,appProperties,parents");
  url.searchParams.set("supportsAllDrives", "true");
  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    throw new Error(`Drive metadata patch failed ${response.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

function maybeRenamedFileName(name, targetBucket) {
  const parts = String(name || "").split("__");
  if (parts.length >= 3 && /^[A-Z]{2,4}$/.test(parts[1])) {
    parts[1] = targetBucket === "ASCS" ? "CS" : targetBucket;
    return parts.join("__");
  }
  return name;
}

function appBucketForTarget(targetBucket) {
  return targetBucket === "ASCS" ? "CS" : targetBucket;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apply = boolArg(args.apply, false);
  const rename = boolArg(args.rename, true);
  const maxMoves = Math.max(intArg(args["max-moves"], 0), 0);
  const delayMs = Math.max(intArg(args["delay-ms"], 150), 0);
  const outDir = path.resolve(String(args["out-dir"] || path.join("runtime", "drive-rebucket")));
  fs.mkdirSync(outDir, { recursive: true });
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const eventsPath = path.join(outDir, `rebucket-${runId}.ndjson`);

  const sharedConfig = getSharedConfig();
  const archiveConfig = sharedConfig.recordingArchive || {};
  const driveClient = createGoogleDriveClient(archiveConfig.drive || {});
  if (!driveClient.isConfigured()) throw new Error("Google Drive client is not configured");

  const buckets = buildBuckets(archiveConfig.destinations || {});
  for (const key of ["OG", "CX", "ASCS"]) {
    if (!buckets[key]?.folderId) throw new Error(`Missing ${key} folder id`);
  }

  const scanRoots = [
    ["OG", buckets.OG.folderId],
    ["CX", buckets.CX.folderId],
    ["CS", buckets.CS.folderId],
  ].filter(([, folderId], index, list) =>
    folderId && list.findIndex(([, id]) => id === folderId) === index);

  const rows = [];
  for (const [bucketKey, folderId] of scanRoots) {
    rows.push(...await listBucketFiles(driveClient, bucketKey, folderId));
  }

  const planned = [];
  for (const row of rows) {
    const target = targetBucketForFile(row.file, row.bucket);
    const targetFolderId = buckets[target.bucket]?.folderId;
    if (!targetFolderId) continue;
    const dateKey = extractDateKey(row.file, row.parentName);
    if (!dateKey) {
      planned.push({
        action: "skip",
        reason: "missing-date",
        currentBucket: row.bucket,
        fileId: row.file.id,
        fileName: row.file.name,
      });
      continue;
    }
    const appBucket = appBucketForTarget(target.bucket);
    const newName = rename ? maybeRenamedFileName(row.file.name, target.bucket) : row.file.name;
    const currentAppBucket = inferBucketFromFile(row.file, row.bucket);
    const alreadyThere = row.bucketFolderId === targetFolderId && row.parentName === dateKey;
    const needsRename = rename && newName !== row.file.name;
    const needsMetadataPatch = currentAppBucket !== appBucket;
    if (alreadyThere && !needsRename && !needsMetadataPatch) {
      planned.push({
        action: "keep",
        reason: target.reason,
        matchedAgent: target.agent,
        targetBucket: target.bucket,
        currentBucket: row.bucket,
        dateKey,
        fileId: row.file.id,
        fileName: row.file.name,
      });
      continue;
    }
    planned.push({
      action: alreadyThere ? "metadata" : "move",
      reason: target.reason,
      matchedAgent: target.agent,
      targetBucket: target.bucket,
      targetFolderId,
      currentBucket: row.bucket,
      currentParentId: row.parentId,
      dateKey,
      fileId: row.file.id,
      fileName: row.file.name,
      newName,
      appBucket,
      currentAppBucket,
      needsRename,
      needsMetadataPatch,
    });
  }

  const moves = planned.filter((item) => item.action === "move");
  const metadata = planned.filter((item) => item.action === "metadata");
  const changes = [...moves, ...metadata];
  const changesToApply = maxMoves > 0 ? changes.slice(0, maxMoves) : changes;
  const summary = {
    apply,
    rename,
    runId,
    eventsPath,
    scanned: rows.length,
    plannedMoves: moves.length,
    plannedMetadata: metadata.length,
    plannedChanges: changes.length,
    changesCappedTo: changesToApply.length,
    kept: planned.filter((item) => item.action === "keep").length,
    skipped: planned.filter((item) => item.action === "skip").length,
    byTarget: changes.reduce((acc, item) => {
      acc[item.targetBucket] = (acc[item.targetBucket] || 0) + 1;
      return acc;
    }, {}),
    byReason: changes.reduce((acc, item) => {
      acc[item.reason] = (acc[item.reason] || 0) + 1;
      return acc;
    }, {}),
  };
  console.log(JSON.stringify({ event: "summary", ...summary }));

  for (const item of planned) {
    fs.appendFileSync(eventsPath, `${JSON.stringify({ event: "plan", ...item })}\n`);
  }

  if (!apply) {
    return;
  }

  const dateFolderCache = new Map();
  async function ensureTargetDateFolder(folderId, dateKey) {
    const key = `${folderId}:${dateKey}`;
    if (dateFolderCache.has(key)) return dateFolderCache.get(key);
    const folder = await driveClient.ensureFolder({ parentId: folderId, name: dateKey });
    dateFolderCache.set(key, folder.id);
    return folder.id;
  }

  let movedOk = 0;
  let metadataOk = 0;
  let failed = 0;
  for (const item of changesToApply) {
    try {
      if (item.action === "move") {
        const targetDateFolderId = await ensureTargetDateFolder(item.targetFolderId, item.dateKey);
        await driveClient.moveFile({
          fileId: item.fileId,
          addParents: [targetDateFolderId],
          removeParents: [item.currentParentId],
        });
      }
      if (rename && item.newName && item.newName !== item.fileName) {
        await patchFileMetadata(driveClient, item.fileId, {
          name: item.newName,
          appProperties: {
            bucket: item.appBucket,
            rebucketedAt: new Date().toISOString(),
            rebucketReason: item.reason,
          },
        });
      } else {
        await patchFileMetadata(driveClient, item.fileId, {
          appProperties: {
            bucket: item.appBucket,
            rebucketedAt: new Date().toISOString(),
            rebucketReason: item.reason,
          },
        });
      }
      if (item.action === "move") {
        movedOk += 1;
        fs.appendFileSync(eventsPath, `${JSON.stringify({ event: "moved", ...item })}\n`);
      } else {
        metadataOk += 1;
        fs.appendFileSync(eventsPath, `${JSON.stringify({ event: "metadata", ...item })}\n`);
      }
    } catch (error) {
      failed += 1;
      fs.appendFileSync(eventsPath, `${JSON.stringify({ event: "failed", error: String(error?.message || error), ...item })}\n`);
    }
    if (delayMs > 0) await sleep(delayMs);
  }

  console.log(JSON.stringify({ event: "complete", movedOk, metadataOk, failed, eventsPath }));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
