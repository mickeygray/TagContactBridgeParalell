const PLAYER_FOLDER_CONFIG = {
  OG: {
    label: "Origination",
    propertyKey: "OG_RECORDING_DUMP_FOLDER_ID",
  },
  AS: {
    label: "Ad Serv",
    propertyKey: "AS_RECORDING_DUMP_FOLDER_ID",
  },
  CS: {
    label: "Customer Service",
    propertyKey: "CS_RECORDING_DUMP_FOLDER_ID",
  },
};

const PLAYABLE_MIME_TYPES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/ogg",
  "audio/opus",
  "audio/mp4",
  "audio/x-m4a",
  "video/mp4",
]);

const APPROVED_EMAILS_PROPERTY_KEY = "APPROVED_VIEWER_EMAILS";
const CALL_GRADER_OPTIONS_PROPERTY_KEY = "CALL_GRADER_OPTIONS";
const CALL_GRADE_PROPERTY_PREFIX = "CALL_GRADE_V1_";
const DEFAULT_GRADER_OPTIONS = [
  "M Anderson",
  "J Pineda",
  "M Gray",
  "B Allen",
  "J Wallace",
  "A Banks",
];
const DEFAULT_GRADER_BY_EMAIL = {
  "manderson@taxadvocategroup.com": "M Anderson",
  "jpineda@taxadvocategroup.com": "J Pineda",
  "mgray@taxadvocategroup.com": "M Gray",
  "ballen@taxadvocategroup.com": "B Allen",
  "jwallace@taxadvocategroup.com": "J Wallace",
  "abanks@taxadvocategroup.com": "A Banks",
};

// ── Mobile-friendly playback proxy ──────────────────────────────────
// The Drive `/preview` iframe doesn't render usable audio controls on
// mobile (X-Frame-Options + redirect-token-loss issues), so we mint
// short-lived HMAC-signed URLs that point at the Parallel control-
// plane's streaming proxy (`/api/recordings/play/:fileId`). The proxy
// streams Drive bytes back with proper Range support so the HTML5
// <audio> element can scrub on phones.
//
// Both Script Properties below must be set for mobile mode to work:
//   PLAYBACK_PROXY_BASE_URL  = https://tagcontactbridge.ngrok.app
//   RECORDING_PLAYBACK_SIGNING_SECRET = <matches .env on parallel>
const PLAYBACK_BASE_URL_PROPERTY_KEY = "PLAYBACK_PROXY_BASE_URL";
const PLAYBACK_SIGNING_SECRET_PROPERTY_KEY = "RECORDING_PLAYBACK_SIGNING_SECRET";
const PLAYBACK_TTL_SECONDS = 600; // 10 minutes — token lifetime per file

function doGet() {
  return HtmlService.createHtmlOutputFromFile("Index")
    .setTitle("Recording Player")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}

function getPlayerBootstrap() {
  const viewerEmail = requireAuthorizedUser_();
  const graderOptions = getGraderOptions_();
  return {
    folders: getConfiguredFolders_(),
    generatedAt: new Date().toISOString(),
    viewerEmail,
    graderOptions: graderOptions,
    defaultGrader: resolveDefaultGrader_(viewerEmail, graderOptions),
  };
}

const DATE_SUBFOLDER_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * List the per-day subfolders under a bucket so the UI can render a
 * date dropdown. Files-at-the-root (legacy flat layout, before
 * migration) are surfaced as `hasFlatFiles` so the player can fall
 * back to the old "list everything at bucket root" mode without a
 * date pick.
 */
function listFolderDates(folderKey) {
  requireAuthorizedUser_();
  const folderMeta = resolveFolderMeta_(folderKey);
  const folder = DriveApp.getFolderById(folderMeta.folderId);

  const dates = [];
  const subfolderIterator = folder.getFolders();
  while (subfolderIterator.hasNext()) {
    const sub = subfolderIterator.next();
    const name = String(sub.getName() || "").trim();
    if (!DATE_SUBFOLDER_PATTERN.test(name)) continue;
    dates.push({
      key: name,
      label: name,
      folderId: sub.getId(),
    });
  }
  // Newest first — date strings sort lexically, so reverse-asc gives
  // most-recent at the top of the dropdown.
  dates.sort((left, right) => (left.key < right.key ? 1 : left.key > right.key ? -1 : 0));

  // Cheap check for "any flat playable files still at the bucket root"
  // — bail after the first match since we only need a boolean for the
  // UI hint. Avoids a full root-folder scan when migration is done.
  let hasFlatFiles = false;
  const fileIterator = folder.getFiles();
  while (fileIterator.hasNext()) {
    const file = fileIterator.next();
    if (isPlayableFile_(file)) {
      hasFlatFiles = true;
      break;
    }
  }

  return {
    folder: folderMeta,
    dates,
    hasFlatFiles,
  };
}

/**
 * List playable audio under a bucket. When `dateKey` is provided the
 * scope is `<bucket>/<dateKey>/`. With no `dateKey` it falls back to
 * the bucket root (legacy flat layout) — this lets the player keep
 * working between the upload-side switchover and the migration script
 * actually completing.
 */
function listFolderAudio(folderKey, dateKey) {
  // Capture the viewer email so we can stamp it into each file's
  // signed playback URL — the proxy uses it for the allowlist check
  // + so the HMAC signature is bound to who's playing.
  const viewerEmail = requireAuthorizedUser_();
  const folderMeta = resolveFolderMeta_(folderKey);
  const cleanDateKey = String(dateKey || "").trim();

  let listFolder;
  let appliedDate = null;
  if (cleanDateKey) {
    if (!DATE_SUBFOLDER_PATTERN.test(cleanDateKey)) {
      throw new Error("dateKey must be in YYYY-MM-DD format");
    }
    const bucketFolder = DriveApp.getFolderById(folderMeta.folderId);
    const matchIterator = bucketFolder.getFoldersByName(cleanDateKey);
    if (!matchIterator.hasNext()) {
      return {
        folder: folderMeta,
        dateKey: cleanDateKey,
        total: 0,
        files: [],
        oauthToken: ScriptApp.getOAuthToken(),
        notFound: true,
      };
    }
    listFolder = matchIterator.next();
    appliedDate = cleanDateKey;
  } else {
    listFolder = DriveApp.getFolderById(folderMeta.folderId);
  }

  const files = [];
  const iterator = listFolder.getFiles();
  while (iterator.hasNext()) {
    const file = iterator.next();
    if (!isPlayableFile_(file)) continue;
    files.push(mapFile_(file, folderKey, folderMeta, viewerEmail, appliedDate));
  }

  files.sort((left, right) => {
    const rightTime = new Date(right.updatedAt).getTime();
    const leftTime = new Date(left.updatedAt).getTime();
    if (rightTime !== leftTime) return rightTime - leftTime;
    return String(left.name || "").localeCompare(String(right.name || ""));
  });
  applyGradesToFiles_(files);

  return {
    folder: folderMeta,
    dateKey: appliedDate,
    total: files.length,
    files,
    oauthToken: ScriptApp.getOAuthToken(),
  };
}

/**
 * Bulk variant of listFolderAudio — fetches audio across multiple
 * date subfolders in a single Apps Script round-trip. Used when the
 * UI selects "All dates" (or any multi-day range) so we don't pay
 * the per-call Apps Script warmup N times.
 *
 * dateKeys:
 *   - falsy / empty array = every YYYY-MM-DD subfolder under the bucket
 *   - array of strings    = scope to those exact subfolders
 *
 * Files at the bucket root (legacy flat layout) are NOT included
 * here — the caller's date-pick UI surfaces those via the
 * `listFolderAudio(folderKey)` flat-mode call instead.
 */
function listFolderAudioBulk(folderKey, dateKeys) {
  const viewerEmail = requireAuthorizedUser_();
  const folderMeta = resolveFolderMeta_(folderKey);
  const bucketFolder = DriveApp.getFolderById(folderMeta.folderId);

  let targetDates = Array.isArray(dateKeys)
    ? dateKeys
        .map(function (value) { return String(value || "").trim(); })
        .filter(function (value) { return DATE_SUBFOLDER_PATTERN.test(value); })
    : [];

  if (targetDates.length === 0) {
    const subIter = bucketFolder.getFolders();
    while (subIter.hasNext()) {
      const sub = subIter.next();
      const name = String(sub.getName() || "").trim();
      if (DATE_SUBFOLDER_PATTERN.test(name)) targetDates.push(name);
    }
  }
  // Newest first — same convention as the date dropdown so order is
  // intuitive when the operator hits "Play all".
  targetDates.sort();
  targetDates.reverse();

  const files = [];
  const datesSeen = [];
  for (let index = 0; index < targetDates.length; index += 1) {
    const dateKey = targetDates[index];
    const matchIter = bucketFolder.getFoldersByName(dateKey);
    if (!matchIter.hasNext()) continue;
    const dateFolder = matchIter.next();
    datesSeen.push(dateKey);
    const fileIter = dateFolder.getFiles();
    while (fileIter.hasNext()) {
      const file = fileIter.next();
      if (!isPlayableFile_(file)) continue;
      files.push(mapFile_(file, folderKey, folderMeta, viewerEmail, dateKey));
    }
  }

  // Sort by recency so the queue plays newest-first by default — the
  // operator can flip order client-side if they want oldest-first.
  files.sort(function (left, right) {
    const rightTime = new Date(right.updatedAt).getTime();
    const leftTime = new Date(left.updatedAt).getTime();
    if (rightTime !== leftTime) return rightTime - leftTime;
    return String(left.name || "").localeCompare(String(right.name || ""));
  });
  applyGradesToFiles_(files);

  return {
    folder: folderMeta,
    dateKeys: datesSeen,
    total: files.length,
    files: files,
    oauthToken: ScriptApp.getOAuthToken(),
  };
}

function getFolderSummary() {
  requireAuthorizedUser_();
  const folders = getConfiguredFolders_();
  return folders.map((folder) => {
    try {
      const listing = listFolderDates(folder.key);
      return {
        key: folder.key,
        label: folder.label,
        dateCount: listing.dates.length,
        hasFlatFiles: listing.hasFlatFiles,
      };
    } catch (error) {
      return {
        key: folder.key,
        label: folder.label,
        dateCount: 0,
        hasFlatFiles: false,
        error: String(error && error.message ? error.message : error),
      };
    }
  });
}

function saveCallGrade(payload) {
  const viewerEmail = requireAuthorizedUser_();
  const request = payload || {};
  const folderMeta = resolveFolderMeta_(request.folderKey);
  const cleanDateKey = normalizeOptionalDateKey_(request.dateKey);
  const fileId = String(request.fileId || "").trim();
  if (!fileId) {
    throw new Error("fileId is required");
  }

  const graderOptions = getGraderOptions_();
  const grader = normalizeGraderSelection_(request.grader, graderOptions);
  const stars = Number(request.stars || 0);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    throw new Error("stars must be an integer from 1 to 5");
  }

  const grade = {
    fileId: fileId,
    folderKey: folderMeta.key,
    dateKey: cleanDateKey,
    grader: grader,
    stars: stars,
    gradedAt: new Date().toISOString(),
    gradedByEmail: viewerEmail,
  };

  PropertiesService.getScriptProperties().setProperty(
    getCallGradePropertyKey_(fileId),
    JSON.stringify(grade),
  );

  return grade;
}

function clearCallGrade(payload) {
  requireAuthorizedUser_();
  const request = payload || {};
  const fileId = String(request.fileId || "").trim();
  if (!fileId) {
    throw new Error("fileId is required");
  }

  PropertiesService.getScriptProperties().deleteProperty(
    getCallGradePropertyKey_(fileId),
  );

  return {
    fileId: fileId,
    cleared: true,
  };
}

function getConfiguredFolders_() {
  const properties = PropertiesService.getScriptProperties();
  return Object.keys(PLAYER_FOLDER_CONFIG).map((key) => {
    const config = PLAYER_FOLDER_CONFIG[key];
    const folderId = String(properties.getProperty(config.propertyKey) || "").trim();
    return {
      key,
      label: config.label,
      folderId,
      configured: Boolean(folderId),
    };
  });
}

function requireAuthorizedUser_() {
  const email = String(Session.getActiveUser().getEmail() || "")
    .trim()
    .toLowerCase();
  if (!email) {
    throw new Error("Unable to determine your Google account. Sign in with an approved workspace account.");
  }

  const rawApproved = String(
    PropertiesService.getScriptProperties().getProperty(APPROVED_EMAILS_PROPERTY_KEY) || "",
  ).trim();
  if (!rawApproved) {
    throw new Error(`Missing Script Property ${APPROVED_EMAILS_PROPERTY_KEY}`);
  }

  const approved = new Set(
    rawApproved
      .split(",")
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean),
  );
  if (!approved.has(email)) {
    throw new Error(`Not authorized for recording access: ${email}`);
  }

  return email;
}

function resolveFolderMeta_(folderKey) {
  const key = String(folderKey || "").trim().toUpperCase();
  const config = PLAYER_FOLDER_CONFIG[key];
  if (!config) {
    throw new Error(`Unknown folder key: ${folderKey}`);
  }

  const folderId = String(
    PropertiesService.getScriptProperties().getProperty(config.propertyKey) || "",
  ).trim();
  if (!folderId) {
    throw new Error(`Missing Script Property ${config.propertyKey}`);
  }

  return {
    key,
    label: config.label,
    folderId,
    propertyKey: config.propertyKey,
  };
}

function isPlayableFile_(file) {
  const mimeType = String(file.getMimeType() || "").toLowerCase();
  if (PLAYABLE_MIME_TYPES.has(mimeType)) return true;
  const name = String(file.getName() || "").toLowerCase();
  return [".mp3", ".wav", ".ogg", ".opus", ".m4a", ".mp4"].some((suffix) =>
    name.endsWith(suffix),
  );
}

function mapFile_(file, folderKey, folderMeta, viewerEmail, dateKey) {
  const id = file.getId();
  return {
    id,
    folderKey,
    folderLabel: folderMeta.label,
    dateKey: dateKey || null,
    name: file.getName(),
    mimeType: file.getMimeType(),
    sizeBytes: Number(file.getSize() || 0),
    updatedAt: file.getLastUpdated().toISOString(),
    previewUrl: buildPreviewUrl_(id),
    audioApiUrl: buildAudioApiUrl_(id),
    // streamUrl is the mobile-friendly path: the audio element fetches
    // bytes from our streaming proxy with Range support. Null if the
    // proxy isn't configured yet — the player falls back to the iframe.
    streamUrl: buildSignedPlaybackUrl_(id, viewerEmail),
    humanGrade: null,
  };
}

function buildPreviewUrl_(fileId) {
  return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/preview`;
}

function buildAudioApiUrl_(fileId) {
  return `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
}

/**
 * Mint a short-lived HMAC-signed URL the audio element can hit
 * directly. The signing message is `<fileId>|<exp>|<viewerEmail>`,
 * the secret lives in Script Properties + the matching env on the
 * control-plane. Returns null if either property is unset — the
 * player will fall back to the iframe path.
 *
 * Why client-side signing: only Apps Script knows whether the user
 * passed `requireAuthorizedUser_()` checks. By signing here we tell
 * the proxy "this viewer is approved" without the proxy needing its
 * own auth. The exp is 10 min, narrow enough that a leaked URL
 * can't be reused later.
 */
function buildSignedPlaybackUrl_(fileId, viewerEmail) {
  const properties = PropertiesService.getScriptProperties();
  const baseUrl = String(
    properties.getProperty(PLAYBACK_BASE_URL_PROPERTY_KEY) || "",
  ).trim().replace(/\/+$/, "");
  const secret = String(
    properties.getProperty(PLAYBACK_SIGNING_SECRET_PROPERTY_KEY) || "",
  );
  if (!baseUrl || !secret) return null;
  const cleanViewer = String(viewerEmail || "").trim().toLowerCase();
  if (!cleanViewer) return null;

  const exp = Math.floor(Date.now() / 1000) + PLAYBACK_TTL_SECONDS;
  const message = fileId + "|" + exp + "|" + cleanViewer;
  const sigBytes = Utilities.computeHmacSha256Signature(message, secret);
  const sig = sigBytes
    .map(function (byte) {
      const value = (byte < 0 ? byte + 256 : byte).toString(16);
      return value.length === 1 ? "0" + value : value;
    })
    .join("");

  return (
    baseUrl +
    "/api/recordings/play/" +
    encodeURIComponent(fileId) +
    "?exp=" +
    exp +
    "&viewer=" +
    encodeURIComponent(cleanViewer) +
    "&sig=" +
    sig
  );
}

function applyGradesToFiles_(files) {
  if (!Array.isArray(files) || files.length === 0) return;
  const ids = files
    .map(function (file) {
      return String((file && file.id) || "").trim();
    })
    .filter(Boolean);
  const gradeMap = getCallGradesForIds_(ids);
  files.forEach(function (file) {
    file.humanGrade = gradeMap[file.id] || null;
  });
}

function getCallGradesForIds_(fileIds) {
  const wanted = new Set(
    (Array.isArray(fileIds) ? fileIds : [])
      .map(function (value) {
        return String(value || "").trim();
      })
      .filter(Boolean),
  );
  if (!wanted.size) return {};

  const allProperties = PropertiesService.getScriptProperties().getProperties();
  const grades = {};

  Object.keys(allProperties).forEach(function (key) {
    if (String(key).indexOf(CALL_GRADE_PROPERTY_PREFIX) !== 0) return;
    const fileId = key.slice(CALL_GRADE_PROPERTY_PREFIX.length);
    if (!wanted.has(fileId)) return;
    try {
      const parsed = JSON.parse(String(allProperties[key] || "{}"));
      if (!parsed || typeof parsed !== "object") return;
      grades[fileId] = {
        fileId: fileId,
        grader: String(parsed.grader || "").trim(),
        stars: Number(parsed.stars || 0),
        gradedAt: parsed.gradedAt || null,
        gradedByEmail: parsed.gradedByEmail || null,
        folderKey: parsed.folderKey || null,
        dateKey: parsed.dateKey || null,
      };
    } catch (error) {
      // Ignore malformed rows so one bad property doesn't break the UI.
    }
  });

  return grades;
}

function getCallGradePropertyKey_(fileId) {
  return CALL_GRADE_PROPERTY_PREFIX + String(fileId || "").trim();
}

function getGraderOptions_() {
  const raw = String(
    PropertiesService.getScriptProperties().getProperty(CALL_GRADER_OPTIONS_PROPERTY_KEY) || "",
  ).trim();
  const parsed = raw
    ? raw
        .split(",")
        .map(function (value) {
          return String(value || "").trim();
        })
        .filter(Boolean)
    : [];
  return parsed.length ? parsed : DEFAULT_GRADER_OPTIONS.slice();
}

function resolveDefaultGrader_(viewerEmail, graderOptions) {
  const cleanEmail = String(viewerEmail || "").trim().toLowerCase();
  const direct = DEFAULT_GRADER_BY_EMAIL[cleanEmail];
  if (direct && graderOptions.indexOf(direct) !== -1) return direct;

  const normalizedLocal = normalizeLookupKey_(cleanEmail.split("@")[0] || "");
  for (var index = 0; index < graderOptions.length; index += 1) {
    const grader = graderOptions[index];
    if (normalizeLookupKey_(grader) === normalizedLocal) {
      return grader;
    }
  }

  return graderOptions[0] || "";
}

function normalizeGraderSelection_(grader, graderOptions) {
  const clean = String(grader || "").trim();
  if (!clean) {
    throw new Error("Pick a grader before saving a score");
  }

  const normalized = normalizeLookupKey_(clean);
  for (var index = 0; index < graderOptions.length; index += 1) {
    const option = graderOptions[index];
    if (normalizeLookupKey_(option) === normalized) {
      return option;
    }
  }

  throw new Error("Selected grader is not allowed");
}

function normalizeOptionalDateKey_(dateKey) {
  const clean = String(dateKey || "").trim();
  if (!clean) return null;
  if (!DATE_SUBFOLDER_PATTERN.test(clean)) {
    throw new Error("dateKey must be in YYYY-MM-DD format");
  }
  return clean;
}

function normalizeLookupKey_(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}
