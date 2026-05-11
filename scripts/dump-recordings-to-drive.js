"use strict";

const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const {
  createCallrailClient,
  createGoogleDriveClient,
  createRingCentralClient,
} = require("../packages/shared-integrations/src");
const {
  getCompanyKeys,
  getSharedConfig,
} = require("../packages/shared-config/src");

const CALLRAIL_FIELDS = [
  "id",
  "customer_phone_number",
  "tracking_phone_number",
  "formatted_tracking_phone_number",
  "source",
  "source_name",
  "start_time",
  "duration",
  "direction",
  "recording",
  "recording_duration",
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

function normalizeDigits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.slice(-10);
}

function toE164(phone) {
  const normalized = normalizeDigits(phone);
  return normalized ? `+1${normalized}` : "";
}

function formatDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown-date";
  return date.toISOString().slice(0, 10);
}

function monthWindow(monthsAgo = 0) {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo + 1, 0));
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
    label: `${start.toISOString().slice(0, 7)}`,
  };
}

function buildCallrailWindows(maxMonths = 6) {
  const windows = [
    { label: "this_month", dateRange: "this_month" },
    { label: "last_month", dateRange: "last_month" },
  ];
  for (let monthsAgo = 0; monthsAgo < maxMonths; monthsAgo += 1) {
    const window = monthWindow(monthsAgo);
    if (!windows.some((entry) => entry.label === window.label)) {
      windows.push(window);
    }
  }
  return windows;
}

function inferExtension(mimeType = "", sourceUri = "") {
  const normalizedMime = String(mimeType || "").toLowerCase();
  if (normalizedMime.includes("mpeg") || normalizedMime.includes("mp3")) return "mp3";
  if (normalizedMime.includes("wav") || normalizedMime.includes("wave")) return "wav";
  if (normalizedMime.includes("mp4") || normalizedMime.includes("m4a")) return "m4a";
  const pathname = String(sourceUri || "").split("?")[0];
  const ext = pathname.includes(".") ? pathname.split(".").pop() : "";
  return String(ext || "bin").toLowerCase();
}

async function fetchBinary(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Binary download failed (${response.status}): ${String(text).slice(0, 200)}`);
  }
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    mimeType: response.headers.get("content-type") || "application/octet-stream",
    finalUrl: response.url || url,
  };
}

function selectLatest(items = [], getTime) {
  return [...items].sort((left, right) => getTime(right) - getTime(left))[0] || null;
}

function normalizeAgentDisplayName(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const withoutCompanySuffix = raw.replace(/\s*-\s*(tag|wynn|amity)\b.*$/i, "").trim();
  const firstSegment = withoutCompanySuffix.split(/\s*-\s*/)[0].trim();
  return firstSegment || withoutCompanySuffix || raw;
}

async function findCallrailRecording(phone) {
  const normalizedPhone = normalizeDigits(phone);
  if (!normalizedPhone) {
    throw new Error("CallRail phone is required");
  }

  const windows = buildCallrailWindows(6);
  for (const companyKey of getCompanyKeys()) {
    let client;
    try {
      client = createCallrailClient(companyKey);
    } catch {
      client = null;
    }
    if (!client) continue;

    for (const window of windows) {
      try {
        const payload = await client.lookupInboundCallByPhone(normalizedPhone, {
          perPage: 20,
          fields: CALLRAIL_FIELDS,
          ...(window.dateRange
            ? { dateRange: window.dateRange }
            : { startDate: window.startDate, endDate: window.endDate }),
        });
        const candidates = (payload.calls || []).filter((call) =>
          normalizeDigits(call.customer_phone_number) === normalizedPhone &&
          call.id,
        );
        const winner = selectLatest(
          candidates,
          (call) => new Date(call.start_time || 0).getTime(),
        );
        if (!winner) continue;

        const call = await client.getCall(winner.id, { fields: CALLRAIL_FIELDS });
        const recording = await client.getCallRecording(winner.id).catch(() => null);
        const sourceUri = String(recording?.url || call?.recording || "").trim();
        if (!sourceUri) continue;
        const download = await fetchBinary(sourceUri);
        return {
          provider: "callrail",
          companyKey,
          callId: String(winner.id),
          phone: normalizedPhone,
          startedAt: call?.start_time || winner.start_time || null,
          durationSec: Number(call?.recording_duration || call?.duration || winner.duration || 0) || null,
          sourceName: call?.source_name || winner.source_name || null,
          sourceUri,
          mimeType: download.mimeType,
          buffer: download.buffer,
          finalUrl: download.finalUrl,
        };
      } catch (error) {
        if (/configuration missing/i.test(String(error.message || ""))) {
          break;
        }
      }
    }
  }

  return null;
}

function collectPhoneMatches(value, targetPhone, matches = new Set()) {
  if (value == null) return matches;
  if (Array.isArray(value)) {
    value.forEach((entry) => collectPhoneMatches(entry, targetPhone, matches));
    return matches;
  }
  if (typeof value === "object") {
    Object.values(value).forEach((entry) => collectPhoneMatches(entry, targetPhone, matches));
    return matches;
  }
  const normalized = normalizeDigits(value);
  if (normalized && normalized === targetPhone) {
    matches.add(normalized);
  }
  return matches;
}

function recordContainsPhone(record, phone) {
  return collectPhoneMatches(record, phone).size > 0;
}

async function listRingcentralRecordsForWindow(client, query) {
  const payload = await client.getAccountCallLog(query);
  return Array.isArray(payload?.records) ? payload.records : [];
}

function selectBestRingcentralRecord(records = [], startedAt = null) {
  const targetStart = startedAt ? new Date(startedAt).getTime() : null;
  return [...records]
    .filter(Boolean)
    .sort((left, right) => {
      const leftStart = left.startTime ? new Date(left.startTime).getTime() : 0;
      const rightStart = right.startTime ? new Date(right.startTime).getTime() : 0;
      const leftScore = targetStart == null ? 0 : Math.abs(leftStart - targetStart);
      const rightScore = targetStart == null ? 0 : Math.abs(rightStart - targetStart);
      if (leftScore !== rightScore) return leftScore - rightScore;
      return rightStart - leftStart;
    })[0] || null;
}

async function findRingcentralRecordByPhone(client, phone, startedAt = null, { requireRecording = false } = {}) {
  const normalizedPhone = normalizeDigits(phone);
  if (!normalizedPhone) {
    throw new Error("RingCentral phone is required");
  }

  const windows = startedAt
    ? [{ startDate: formatDate(startedAt), endDate: formatDate(startedAt) }]
    : Array.from({ length: 12 }, (_, monthsAgo) => monthWindow(monthsAgo));

  for (const window of windows) {
    const query = {
      view: "Detailed",
      type: "Voice",
      perPage: 1000,
      dateFrom: `${window.startDate}T00:00:00.000Z`,
      dateTo: `${window.endDate}T23:59:59.999Z`,
    };

    const searchVariants = [
      { ...query, phoneNumber: toE164(normalizedPhone) },
      query,
    ];

    for (const variant of searchVariants) {
      const records = await listRingcentralRecordsForWindow(client, variant);
      const candidates = records.filter((record) => {
        if (!recordContainsPhone(record, normalizedPhone)) return false;
        if (requireRecording && !record?.recording?.contentUri) return false;
        return true;
      });
      const winner = selectBestRingcentralRecord(candidates, startedAt);
      if (winner) return winner;
    }
  }

  return null;
}

function buildLegCandidate(leg = {}, legIndex = null) {
  const extensionId = String(
    leg.extension?.id ||
    leg.extensionId ||
    leg.to?.extensionId ||
    leg.from?.extensionId ||
    "",
  ).trim();
  const extensionNumber = String(
    leg.extension?.extensionNumber ||
    leg.to?.extensionNumber ||
    leg.from?.extensionNumber ||
    "",
  ).trim();

  let agentName = String(leg.extension?.name || "").trim();
  if (!agentName && extensionId && String(leg.from?.extensionId || "").trim() === extensionId) {
    agentName = String(leg.from?.name || "").trim();
  }
  if (!agentName && extensionId && String(leg.to?.extensionId || "").trim() === extensionId) {
    agentName = String(leg.to?.name || "").trim();
  }
  if (!agentName) {
    agentName = String(leg.from?.name || leg.to?.name || "").trim();
  }

  if (!extensionId && !extensionNumber && !agentName) return null;
  return {
    legIndex,
    extensionId: extensionId || null,
    extensionNumber: extensionNumber || null,
    agentName: normalizeAgentDisplayName(agentName) || null,
    durationSec: Number(leg.duration || 0) || 0,
    durationMs: Number(leg.durationMs || 0) || 0,
    result: String(leg.result || "").trim(),
    action: String(leg.action || "").trim(),
    legType: String(leg.legType || "").trim(),
    direction: String(leg.direction || "").trim(),
    internalType: String(leg.internalType || "").trim(),
    isMaster: Boolean(leg.master),
  };
}

function containsCustomerServiceText(value) {
  return /customer\s*service/i.test(String(value || ""));
}

function legHasCustomerServiceText(leg = {}) {
  return [
    leg?.from?.name,
    leg?.to?.name,
    leg?.extension?.name,
    leg?.name,
    leg?.reason,
    leg?.reasonDescription,
  ].some((value) => containsCustomerServiceText(value));
}

function isConnectedLeg(candidate = {}) {
  const result = String(candidate.result || "").toLowerCase();
  const action = String(candidate.action || "").toLowerCase();
  const legType = String(candidate.legType || "").toLowerCase();
  return (
    (result.includes("call connected") || result.includes("accepted")) &&
    (action.includes("findme") || action.includes("transfer") || legType.includes("findme"))
  );
}

function isIngressQueueLeg(candidate = {}) {
  return (
    candidate.isMaster ||
    (
      String(candidate.direction || "").toLowerCase() === "inbound" &&
      String(candidate.action || "").toLowerCase() === "phone call" &&
      String(candidate.legType || "").toLowerCase() === "accept"
    )
  );
}

function pickTerminalCandidate(candidates = []) {
  const agentCandidates = candidates.filter((candidate) =>
    !isIngressQueueLeg(candidate) &&
    (candidate.agentName || candidate.extensionId || candidate.extensionNumber),
  );
  const connectedAgents = agentCandidates.filter((candidate) => isConnectedLeg(candidate));
  const pool = connectedAgents.length > 0
    ? connectedAgents
    : agentCandidates.length > 0
      ? agentCandidates
      : candidates;

  return [...pool].sort((left, right) => {
    const rightDuration = Number(right.durationSec || 0);
    const leftDuration = Number(left.durationSec || 0);
    if (rightDuration !== leftDuration) return rightDuration - leftDuration;
    const rightMs = Number(right.durationMs || 0);
    const leftMs = Number(left.durationMs || 0);
    if (rightMs !== leftMs) return rightMs - leftMs;
    return Number(right.legIndex ?? -1) - Number(left.legIndex ?? -1);
  })[0] || null;
}

function deriveRoutingFromRecord(provider, record = null) {
  const candidates = [];
  const legs = Array.isArray(record?.legs) ? record.legs : [];
  for (let index = 0; index < legs.length; index += 1) {
    const candidate = buildLegCandidate(legs[index], index);
    if (candidate) candidates.push(candidate);
  }

  const hasCustomerServiceTouch = legs.some((leg) => legHasCustomerServiceText(leg));
  const queueTouches = candidates.filter((candidate) =>
    ["505", "5051", "5052"].includes(String(candidate.extensionNumber || "").trim()),
  );
  const terminalCandidate = pickTerminalCandidate(candidates);
  const bucket =
    provider === "callrail"
      ? "OG"
      : (queueTouches.length > 0 || hasCustomerServiceTouch)
        ? "CS"
        : "AS";

  return {
    bucket,
    candidate: terminalCandidate,
    queueTouches,
  };
}

function buildOutputFileName(artifact, routing) {
  const extension = inferExtension(artifact.mimeType, artifact.sourceUri);
  const agentPart = (normalizeAgentDisplayName(routing?.candidate?.agentName || "") || "UNKNOWN AGENT")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const bucketPart = String(routing?.bucket || "UNASSIGNED").toUpperCase();
  return [
    agentPart || "UNKNOWN-AGENT",
    bucketPart,
    formatDate(artifact.startedAt),
    normalizeDigits(artifact.phone) || "unknown-phone",
  ].join("__") + `.${extension}`;
}

async function ensureDriveFolder(driveClient, parentId, name) {
  const token = await driveClient.getAccessToken();
  const base = new URL("https://www.googleapis.com/drive/v3/files");
  base.searchParams.set(
    "q",
    [
      `name='${String(name).replace(/'/g, "\\'")}'`,
      `mimeType='application/vnd.google-apps.folder'`,
      `'${parentId}' in parents`,
      "trashed=false",
    ].join(" and "),
  );
  base.searchParams.set("fields", "files(id,name)");
  base.searchParams.set("supportsAllDrives", "true");
  base.searchParams.set("includeItemsFromAllDrives", "true");

  const lookup = await fetch(base.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  const lookupData = await lookup.json();
  if (lookup.ok && Array.isArray(lookupData.files) && lookupData.files.length > 0) {
    return lookupData.files[0];
  }

  const create = await fetch("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id,name", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    }),
  });
  const createData = await create.json();
  if (!create.ok) {
    throw new Error(`Could not create Drive folder ${name}: ${JSON.stringify(createData).slice(0, 300)}`);
  }
  return createData;
}

async function findRingcentralRecording(phone, startedAt = null) {
  const client = createRingCentralClient();
  await client.reinitializePlatform({ force: false, reason: "manual-recording-dump" });
  const winner = await findRingcentralRecordByPhone(client, phone, startedAt, {
    requireRecording: true,
  });
  if (!winner) return null;

  const token = await client.authenticate();
  const download = await fetchBinary(winner.recording.contentUri, {
    headers: { Authorization: `Bearer ${token}` },
  });

  return {
    provider: "ringcentral",
    phone: normalizeDigits(phone),
    telephonySessionId: winner.telephonySessionId || null,
    recordingId: winner.recording?.id || null,
    startedAt: winner.startTime || winner.sessionStartTime || null,
    durationSec: Number(winner.duration || 0) || null,
    sourceUri: winner.recording.contentUri,
    mimeType: download.mimeType,
    buffer: download.buffer,
    finalUrl: download.finalUrl,
    record: winner,
  };
}

async function uploadArtifact(driveClient, folderId, fileName, artifact) {
  if (!artifact) {
    return { ok: false, reason: "not-found" };
  }
  const resolvedFileName = String(fileName || "").trim() || buildOutputFileName(artifact, {
    bucket: artifact.provider === "callrail" ? "OG" : "AS",
    candidate: null,
  });

  try {
    const upload = await driveClient.uploadFileResumable({
      folderId,
      name: resolvedFileName,
      mimeType: artifact.mimeType,
      buffer: artifact.buffer,
      description: `Manual recording dump for ${artifact.provider} ${artifact.phone}`,
      appProperties: {
        provider: artifact.provider,
        phone: artifact.phone,
      },
    });

    return {
      ok: true,
      fileName: resolvedFileName,
      upload,
    };
  } catch (error) {
    return {
      ok: false,
      fileName: resolvedFileName,
      error: error.message,
      details: error.details || null,
    };
  }
}

function writeArtifactToDisk(outDir, fileName, artifact) {
  if (!outDir || !artifact) return null;
  const resolvedFileName = String(fileName || "").trim() || buildOutputFileName(artifact, {
    bucket: artifact.provider === "callrail" ? "OG" : "AS",
    candidate: null,
  });
  fs.mkdirSync(outDir, { recursive: true });
  const filePath = path.join(outDir, resolvedFileName);
  fs.writeFileSync(filePath, artifact.buffer);
  return filePath;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sharedConfig = getSharedConfig();
  const driveConfig = sharedConfig.recordingArchive?.drive || {};
  const archiveDestinations = sharedConfig.recordingArchive?.destinations || {};
  const rootFolderId = String(
    args["root-folder-id"] ||
    args["folder-id"] ||
    process.env.TEST_RECORDING_DUMP_FOLDER_ID ||
    "",
  ).trim();
  const callrailPhone = String(args["callrail-phone"] || "").trim();
  const ringcentralPhone = String(args["ringcentral-phone"] || "").trim();
  const outDir = String(args["out-dir"] || "").trim();
  const hasConfiguredDestinations = ["og", "as", "cs"].every((key) =>
    String(archiveDestinations[key]?.folderId || "").trim(),
  );

  if (!rootFolderId && !hasConfiguredDestinations) {
    throw new Error("--root-folder-id or TEST_RECORDING_DUMP_FOLDER_ID is required");
  }
  if (!callrailPhone) {
    throw new Error("--callrail-phone is required");
  }
  if (!ringcentralPhone) {
    throw new Error("--ringcentral-phone is required");
  }

  const driveClient = createGoogleDriveClient(driveConfig);
  if (!driveClient.isConfigured()) {
    throw new Error("Google Drive client is not configured");
  }

  const [callrailArtifact, ringcentralArtifact] = await Promise.all([
    findCallrailRecording(callrailPhone),
    findRingcentralRecording(ringcentralPhone),
  ]);

  const rcClient = createRingCentralClient();
  await rcClient.reinitializePlatform({ force: false, reason: "manual-recording-routing" });
  const callrailRcRecord = callrailArtifact
    ? await findRingcentralRecordByPhone(
        rcClient,
        callrailArtifact.phone,
        callrailArtifact.startedAt,
        { requireRecording: false },
      )
    : null;

  const callrailRouting = deriveRoutingFromRecord("callrail", callrailRcRecord);
  const ringcentralRouting = deriveRoutingFromRecord("ringcentral", ringcentralArtifact?.record || null);

  const ogFolder = String(archiveDestinations.og?.folderId || "").trim()
    ? { id: String(archiveDestinations.og.folderId).trim(), name: archiveDestinations.og?.label || "OG", mode: "configured" }
    : await ensureDriveFolder(driveClient, rootFolderId, "OG");
  const asFolder = String(archiveDestinations.as?.folderId || "").trim()
    ? { id: String(archiveDestinations.as.folderId).trim(), name: archiveDestinations.as?.label || "AS", mode: "configured" }
    : await ensureDriveFolder(driveClient, rootFolderId, "AS");
  const csFolder = String(archiveDestinations.cs?.folderId || "").trim()
    ? { id: String(archiveDestinations.cs.folderId).trim(), name: archiveDestinations.cs?.label || "CS", mode: "configured" }
    : await ensureDriveFolder(driveClient, rootFolderId, "CS");

  const folderByBucket = {
    OG: ogFolder.id,
    AS: asFolder.id,
    CS: csFolder.id,
  };

  const callrailFileName = callrailArtifact ? buildOutputFileName(callrailArtifact, callrailRouting) : null;
  const ringcentralFileName = ringcentralArtifact ? buildOutputFileName(ringcentralArtifact, ringcentralRouting) : null;

  const callrailLocalPath = writeArtifactToDisk(
    outDir ? path.join(outDir, callrailRouting.bucket) : "",
    callrailFileName,
    callrailArtifact,
  );
  const ringcentralLocalPath = writeArtifactToDisk(
    outDir ? path.join(outDir, ringcentralRouting.bucket) : "",
    ringcentralFileName,
    ringcentralArtifact,
  );

  const [callrailUpload, ringcentralUpload] = await Promise.all([
    uploadArtifact(
      driveClient,
      folderByBucket[callrailRouting.bucket],
      callrailFileName,
      callrailArtifact,
    ),
    uploadArtifact(
      driveClient,
      folderByBucket[ringcentralRouting.bucket],
      ringcentralFileName,
      ringcentralArtifact,
    ),
  ]);

  console.log(JSON.stringify({
    rootFolderId: rootFolderId || null,
    folders: {
      OG: ogFolder,
      AS: asFolder,
      CS: csFolder,
    },
    callrail: {
      found: Boolean(callrailArtifact),
      routing: callrailRouting,
      artifact: callrailArtifact
        ? {
            provider: callrailArtifact.provider,
            companyKey: callrailArtifact.companyKey,
            callId: callrailArtifact.callId,
            phone: callrailArtifact.phone,
            startedAt: callrailArtifact.startedAt,
            durationSec: callrailArtifact.durationSec,
            sourceName: callrailArtifact.sourceName,
            mimeType: callrailArtifact.mimeType,
            bytes: callrailArtifact.buffer.length,
            localPath: callrailLocalPath,
            fileName: callrailFileName,
          }
        : null,
      upload: callrailUpload,
    },
    ringcentral: {
      found: Boolean(ringcentralArtifact),
      routing: ringcentralRouting,
      artifact: ringcentralArtifact
        ? {
            provider: ringcentralArtifact.provider,
            telephonySessionId: ringcentralArtifact.telephonySessionId,
            recordingId: ringcentralArtifact.recordingId,
            phone: ringcentralArtifact.phone,
            startedAt: ringcentralArtifact.startedAt,
            durationSec: ringcentralArtifact.durationSec,
            mimeType: ringcentralArtifact.mimeType,
            bytes: ringcentralArtifact.buffer.length,
            localPath: ringcentralLocalPath,
            fileName: ringcentralFileName,
          }
        : null,
      upload: ringcentralUpload,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
