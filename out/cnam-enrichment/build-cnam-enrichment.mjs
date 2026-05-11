import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const require = createRequire(import.meta.url);

const INPUT_CSV = "C:/Users/Admin/Downloads/cnam-list_20260506-223742.csv";
const REPO_ROOT = "C:/Users/Admin/Code/TagContactBridgeParallel";
const OUTPUT_DIR = path.join(REPO_ROOT, "out", "cnam-enrichment");
const OUTPUT_XLSX = "C:/Users/Admin/Downloads/cnam-list_20260506-223742_ringcentral-enriched.xlsx";
const OUTPUT_CSV = "C:/Users/Admin/Downloads/cnam-list_20260506-223742_ringcentral-enriched.csv";
const FETCH_TIMEOUT_MS = 30000;
const LOOKUP_OWNER_DEVICES = String(process.env.CNAM_LOOKUP_OWNER_DEVICES || "false").toLowerCase() === "true";

const { EX_SHELL_DIRECTORY } = require(
  "C:/Users/Admin/Code/TagContactBridgeParallel/packages/shared-data/src/exShellDirectory.js",
);

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length > 10) return digits.slice(-10);
  return digits.length === 10 ? digits : digits;
}

function formatPhone(value) {
  const normalized = normalizePhone(value);
  return normalized.length === 10 ? `+1${normalized}` : String(value || "");
}

function csvEscape(value) {
  if (value == null) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        value += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        value += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(value);
      value = "";
    } else if (char === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else if (char !== "\r") {
      value += char;
    }
  }

  if (value.length > 0 || row.length > 0) {
    row.push(value);
    rows.push(row);
  }

  const headers = rows.shift() || [];
  return rows
    .filter((cells) => cells.some((cell) => String(cell || "").trim()))
    .map((cells) => Object.fromEntries(headers.map((header, idx) => [header, cells[idx] || ""])));
}

function loadEnv(file) {
  const out = {};
  if (!existsSync(file)) return out;
  const text = require("node:fs").readFileSync(file, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function getEnv() {
  return {
    ...process.env,
    ...loadEnv(path.join(REPO_ROOT, ".env")),
  };
}

async function authenticate(env) {
  const serverUrl = (
    env.RING_CENTRAL_SERVER_URL ||
    env.RC_SERVER_URL ||
    "https://platform.ringcentral.com"
  ).replace(/\/$/, "");
  const clientId = env.RING_CENTRAL_CLIENT_ID || env.RC_CLIENT_ID;
  const clientSecret = env.RING_CENTRAL_CLIENT_SECRET || env.RC_CLIENT_SECRET;
  const jwt = env.RING_CENTRAL_JWT_TOKEN || env.RC_JWT_TOKEN;
  if (!clientId || !clientSecret || !jwt) {
    throw new Error("RingCentral JWT credentials are missing from .env");
  }

  const response = await fetchWithTimeout(`${serverUrl}/restapi/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`RingCentral auth failed ${response.status}: ${text.slice(0, 240)}`);
  }
  return {
    serverUrl,
    accessToken: JSON.parse(text).access_token,
  };
}

async function rcGet(auth, endpoint, query = {}) {
  const url = new URL(endpoint.replace(/^\//, ""), `${auth.serverUrl}/`);
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });
  const response = await fetchWithTimeout(url, {
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      Accept: "application/json",
    },
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok) {
    const error = new Error(`RingCentral GET ${endpoint} failed ${response.status}: ${text.slice(0, 240)}`);
    error.status = response.status;
    error.retryAfterMs = Number(response.headers.get("retry-after") || 0) * 1000;
    throw error;
  }
  return json;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  if (typeof timer.unref === "function") timer.unref();
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function rcGetWithRetry(auth, endpoint, query = {}, options = {}) {
  const maxAttempts = Number(options.maxAttempts || 4);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await rcGet(auth, endpoint, query);
    } catch (error) {
      if (error.status !== 429 || attempt >= maxAttempts) throw error;
      const delayMs = Math.max(error.retryAfterMs || 0, 1500 * attempt);
      console.log(`Rate limited on ${endpoint}; retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxAttempts})`);
      await sleep(delayMs);
    }
  }
  return null;
}

async function rcGetAll(auth, endpoint, query = {}) {
  const records = [];
  let page = 1;
  let totalPages = 1;
  do {
    const payload = await rcGetWithRetry(auth, endpoint, {
      perPage: 1000,
      ...query,
      page,
    });
    records.push(...(Array.isArray(payload?.records) ? payload.records : []));
    totalPages = Number(payload?.paging?.totalPages || page);
    page += 1;
  } while (page <= totalPages);
  return records;
}

function extensionLabel(extension) {
  if (!extension) return "";
  return [
    extension.name,
    extension.extensionNumber ? `ext ${extension.extensionNumber}` : "",
  ].filter(Boolean).join(" ");
}

function spreadsheetColumnName(count) {
  let value = count;
  let name = "";
  while (value > 0) {
    const rem = (value - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function assignmentKind(extension, phoneRecord) {
  if (!phoneRecord) return "Not found";
  const type = String(extension?.type || "").trim();
  if (type === "User") return "User";
  if (type === "Department" || type === "CallQueue") return "Queue";
  if (type === "IvrMenu") return "IVR";
  return type || "Extension";
}

function memberLabel(member = {}, extensionByNumber = new Map()) {
  const contactName = `${member.contact?.firstName || ""} ${member.contact?.lastName || ""}`.trim();
  const ext = member.extensionNumber || member.ext || member.extension?.extensionNumber || "";
  const extension = ext ? extensionByNumber.get(String(ext)) : null;
  const name = member.name || contactName || extension?.name || "";
  return [name, ext ? `ext ${ext}` : ""].filter(Boolean).join(" ");
}

function extensionTargetLabel(target, extensionById = new Map()) {
  if (!target) return "extension";
  const resolved = target.id ? extensionById.get(String(target.id)) : null;
  const name = target.name || resolved?.name || "extension";
  const ext = target.extensionNumber || resolved?.extensionNumber || "";
  return `${name}${ext ? ` ext ${ext}` : ""}`;
}

function summarizeForwardingDetail(detail = {}, extensionById = new Map()) {
  const parts = [];
  if (detail.unconditionalForwarding?.phoneNumber) {
    parts.push(`unconditional to ${detail.unconditionalForwarding.phoneNumber}`);
  }
  if (detail.transfer?.extension) {
    parts.push(`transfer to ${extensionTargetLabel(detail.transfer.extension, extensionById)}`);
  }
  for (const rule of detail.forwarding?.rules || []) {
    for (const number of rule.forwardingNumbers || []) {
      parts.push(`forward to ${number.phoneNumber || number.uri || ""}${number.label ? ` (${number.label})` : ""}`.trim());
    }
  }
  return parts.filter(Boolean);
}

async function fetchQueueDetails(auth, extensionId, { extensionById, extensionByNumber }) {
  const details = {
    members: "",
    forwarding: "",
  };

  try {
    const payload = await rcGetWithRetry(
      auth,
      `/restapi/v1.0/account/~/call-queues/${encodeURIComponent(extensionId)}/members`,
      { perPage: 100 },
      { maxAttempts: 3 },
    );
    details.members = (payload?.records || []).map((member) => memberLabel(member, extensionByNumber)).filter(Boolean).join("; ");
  } catch (error) {
    details.members = `members lookup failed: ${error.status || ""}`.trim();
  }

  try {
    const rules = await rcGetWithRetry(
      auth,
      `/restapi/v1.0/account/~/extension/${encodeURIComponent(extensionId)}/answering-rule`,
      { perPage: 20 },
      { maxAttempts: 3 },
    );
    const forwarding = [];
    for (const rule of (rules?.records || []).slice(0, 5)) {
      if (!rule.id) continue;
      await sleep(150);
      try {
        const detail = await rcGetWithRetry(
          auth,
          `/restapi/v1.0/account/~/extension/${encodeURIComponent(extensionId)}/answering-rule/${encodeURIComponent(rule.id)}`,
          {},
          { maxAttempts: 3 },
        );
        const label = rule.name || rule.type || rule.id;
        const ruleParts = summarizeForwardingDetail(detail, extensionById);
        if (ruleParts.length > 0) forwarding.push(`${label}: ${ruleParts.join(", ")}`);
      } catch (error) {
        forwarding.push(`${rule.name || rule.id}: lookup failed ${error.status || ""}`.trim());
      }
    }
    details.forwarding = forwarding.join("; ");
  } catch (error) {
    details.forwarding = `forwarding lookup failed: ${error.status || ""}`.trim();
  }

  return details;
}

async function fetchIvrDetails(auth, extensionId) {
  try {
    const payload = await rcGetWithRetry(
      auth,
      `/restapi/v1.0/account/~/ivr-menus/${encodeURIComponent(extensionId)}`,
      {},
      { maxAttempts: 3 },
    );
    const actions = [];
    for (const action of payload?.actions || []) {
      const key = action.input || "?";
      const target = action.extension
        ? `${action.extension.name || "extension"}${action.extension.extensionNumber ? ` ext ${action.extension.extensionNumber}` : ""}`
        : action.phoneNumber || "";
      actions.push(`key ${key}: ${action.action || "route"} ${target}`.trim());
    }
    return {
      members: "",
      forwarding: actions.join("; "),
    };
  } catch (error) {
    return {
      members: "",
      forwarding: `IVR lookup failed: ${error.status || ""}`.trim(),
    };
  }
}

function summarizeDevices(devices) {
  const unique = Array.from(new Map(devices.map((device) => [String(device.id), device])).values());
  const join = (mapper) => unique.map(mapper).filter(Boolean).join("; ");
  return {
    count: unique.length,
    ids: join((d) => d.id),
    types: join((d) => d.type),
    names: join((d) => d.name || d.model?.name),
    statuses: join((d) => d.status),
    serials: join((d) => d.serial),
    computers: join((d) => d.computerName),
    linePhones: join((d) =>
      (Array.isArray(d.phoneLines) ? d.phoneLines : [])
        .map((line) => line.phoneInfo?.phoneNumber)
        .filter(Boolean)
        .join(" / "),
    ),
  };
}

function compactDeviceSummary(summary) {
  if (!summary.count) return "";
  const bits = [
    `${summary.count} device${summary.count === 1 ? "" : "s"}`,
    summary.types,
    summary.names,
    summary.statuses,
  ].filter(Boolean);
  return bits.join(" | ");
}

function buildShellPhoneMap() {
  const map = new Map();
  for (const shell of EX_SHELL_DIRECTORY || []) {
    for (const rawPhone of shell.loginPhones || []) {
      const normalized = normalizePhone(rawPhone);
      if (!normalized) continue;
      if (!map.has(normalized)) map.set(normalized, []);
      map.get(normalized).push(shell);
    }
  }
  return map;
}

async function main() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const sourceRows = parseCsv(await fs.readFile(INPUT_CSV, "utf8"));
  const env = getEnv();
  const auth = await authenticate(env);

  console.log(`Fetching RingCentral inventory for ${sourceRows.length} input numbers...`);
  const phoneRecords = await rcGetAll(auth, "/restapi/v1.0/account/~/phone-number");
  console.log(`  phone-number records: ${phoneRecords.length}`);
  const extensions = await rcGetAll(auth, "/restapi/v1.0/account/~/extension");
  console.log(`  extension records: ${extensions.length}`);
  const accountDevices = await rcGetAll(auth, "/restapi/v1.0/account/~/device");
  console.log(`  account devices: ${accountDevices.length}`);

  const extensionById = new Map(extensions.map((extension) => [String(extension.id), extension]));
  const extensionByNumber = new Map(
    extensions
      .filter((extension) => extension.extensionNumber)
      .map((extension) => [String(extension.extensionNumber), extension]),
  );
  const phoneRecordByPhone = new Map();
  for (const record of phoneRecords) {
    const normalized = normalizePhone(record.phoneNumber);
    if (!normalized) continue;
    if (!phoneRecordByPhone.has(normalized)) phoneRecordByPhone.set(normalized, []);
    phoneRecordByPhone.get(normalized).push(record);
  }

  const devicesByLinePhone = new Map();
  const devicesByExtensionId = new Map();
  function indexDevice(device) {
    if (device?.extension?.id) {
      const key = String(device.extension.id);
      if (!devicesByExtensionId.has(key)) devicesByExtensionId.set(key, []);
      devicesByExtensionId.get(key).push(device);
    }
    for (const line of Array.isArray(device?.phoneLines) ? device.phoneLines : []) {
      const normalized = normalizePhone(line?.phoneInfo?.phoneNumber);
      if (!normalized) continue;
      if (!devicesByLinePhone.has(normalized)) devicesByLinePhone.set(normalized, []);
      devicesByLinePhone.get(normalized).push(device);
    }
  }
  accountDevices.forEach(indexDevice);

  const routingDetailsByExtensionId = new Map();
  const routingTargets = Array.from(new Map(
    sourceRows
      .map((row) => {
        const phone = normalizePhone(row["Phone Number"]);
        const record = phoneRecordByPhone.get(phone)?.[0];
        const extensionId = record?.extension?.id ? String(record.extension.id) : "";
        const extension = extensionById.get(extensionId);
        const kind = assignmentKind(extension, record);
        return extensionId && (kind === "Queue" || kind === "IVR")
          ? [extensionId, { extensionId, kind }]
          : null;
      })
      .filter(Boolean),
  ).values());
  console.log(`  queue/IVR routing lookups: ${routingTargets.length}`);
  for (const target of routingTargets) {
    await sleep(250);
    if (target.kind === "Queue") {
      routingDetailsByExtensionId.set(
        target.extensionId,
        await fetchQueueDetails(auth, target.extensionId, { extensionById, extensionByNumber }),
      );
    } else if (target.kind === "IVR") {
      routingDetailsByExtensionId.set(target.extensionId, await fetchIvrDetails(auth, target.extensionId));
    }
  }

  const ownerExtensionIds = LOOKUP_OWNER_DEVICES ? Array.from(new Set(
    sourceRows
      .map((row) => {
        const phone = normalizePhone(row["Phone Number"]);
        const record = phoneRecordByPhone.get(phone)?.[0];
        const extensionId = record?.extension?.id ? String(record.extension.id) : "";
        const extension = extensionById.get(extensionId);
        const alreadyHasLineDevice = devicesByLinePhone.has(phone);
        if (alreadyHasLineDevice) return "";
        if (extension?.type !== "User") return "";
        return extensionId;
      })
      .filter(Boolean),
  )) : [];

  for (const extensionId of ownerExtensionIds) {
    try {
      await sleep(250);
      const payload = await rcGetWithRetry(
        auth,
        `/restapi/v1.0/account/~/extension/${encodeURIComponent(extensionId)}/device`,
        { perPage: 100 },
      );
      for (const device of Array.isArray(payload?.records) ? payload.records : []) {
        indexDevice(device);
      }
    } catch (error) {
      console.log(`Device lookup skipped for extension ${extensionId}: ${error.message}`);
    }
  }

  const shellByPhone = buildShellPhoneMap();
  const headers = [
    "Phone Number",
    "Display Name",
    "Assigned Kind",
    "Assigned To",
    "Assigned Extension",
    "Assigned RC ID",
    "Assigned Email",
    "Queue/IVR Members",
    "Queue/IVR Forwarding",
    "Device Summary",
    "Assignment Notes",
    "Normalized Phone",
    "RC Matched",
    "RC Phone Number",
    "RC Caller ID Name",
    "RC Phone ID",
    "RC Phone Status",
    "RC Phone Usage Type",
    "RC Phone Type",
    "RC Payment Type",
    "RC Location",
    "Owner Type",
    "Owner Name",
    "Owner Extension",
    "Owner Extension ID",
    "Owner Email",
    "Directory Agent Match",
    "Directory Agent Email",
    "Directory Company",
    "Devices Found",
    "Device Match Basis",
    "Device Types",
    "Device Names",
    "Device Statuses",
    "Device Serials",
    "Device Computer Names",
    "Device IDs",
    "Device Line Phones",
    "Notes",
  ];

  const enriched = sourceRows.map((row) => {
    const normalized = normalizePhone(row["Phone Number"]);
    const matchedRecords = phoneRecordByPhone.get(normalized) || [];
    const phoneRecord = matchedRecords[0] || null;
    const extensionId = phoneRecord?.extension?.id ? String(phoneRecord.extension.id) : "";
    const extension = extensionById.get(extensionId) || null;
    const shells = shellByPhone.get(normalized) || [];
    const kind = assignmentKind(extension, phoneRecord);
    const routingDetails = routingDetailsByExtensionId.get(extensionId) || {};

    const lineDevices = devicesByLinePhone.get(normalized) || [];
    const ownerDevices = extensionId ? devicesByExtensionId.get(extensionId) || [] : [];
    const devices = lineDevices.length > 0 ? lineDevices : ownerDevices;
    const summarized = summarizeDevices(devices);
    const matchBasis = lineDevices.length > 0
      ? "phone line"
      : ownerDevices.length > 0
        ? "owner extension"
        : "";

    const notes = [];
    if (matchedRecords.length > 1) notes.push(`Multiple RC phone records matched (${matchedRecords.length})`);
    if (!phoneRecord) notes.push("No matching RingCentral phone-number record");
    if (phoneRecord && !extension) notes.push("Phone record has no resolved extension owner");
    if (phoneRecord && summarized.count === 0) notes.push("No device found for this number/owner");
    if (extension?.type && extension.type !== "User") notes.push(`Owner is ${extension.type}, not a user agent`);
    if (shells.length > 0 && extension?.name && !shells.some((shell) => String(extension.name || "").toLowerCase().includes(String(shell.name || "").split(" ")[0].toLowerCase()))) {
      notes.push("Directory phone match differs from RC owner; review");
    }

    return {
      "Phone Number": row["Phone Number"] || "",
      "Display Name": row["Display Name"] || "",
      "Assigned Kind": kind,
      "Assigned To": extension?.name || extensionLabel(phoneRecord?.extension) || "",
      "Assigned Extension": extension?.extensionNumber || phoneRecord?.extension?.extensionNumber || "",
      "Assigned RC ID": extensionId,
      "Assigned Email": extension?.contact?.email || "",
      "Queue/IVR Members": routingDetails.members || "",
      "Queue/IVR Forwarding": routingDetails.forwarding || "",
      "Device Summary": compactDeviceSummary(summarized),
      "Assignment Notes": notes.join("; "),
      "Normalized Phone": normalized,
      "RC Matched": phoneRecord ? "Yes" : "No",
      "RC Phone Number": phoneRecord?.phoneNumber || "",
      "RC Caller ID Name": phoneRecord?.callerIdName || "",
      "RC Phone ID": phoneRecord?.id || "",
      "RC Phone Status": phoneRecord?.status || "",
      "RC Phone Usage Type": phoneRecord?.usageType || "",
      "RC Phone Type": phoneRecord?.type || "",
      "RC Payment Type": phoneRecord?.paymentType || "",
      "RC Location": phoneRecord?.location || "",
      "Owner Type": extension?.type || "",
      "Owner Name": extension?.name || extensionLabel(phoneRecord?.extension) || "",
      "Owner Extension": extension?.extensionNumber || phoneRecord?.extension?.extensionNumber || "",
      "Owner Extension ID": extensionId,
      "Owner Email": extension?.contact?.email || "",
      "Directory Agent Match": shells.map((shell) => shell.name).filter(Boolean).join("; "),
      "Directory Agent Email": shells.map((shell) => shell.email).filter(Boolean).join("; "),
      "Directory Company": shells.map((shell) => shell.company).filter(Boolean).join("; "),
      "Devices Found": summarized.count,
      "Device Match Basis": matchBasis,
      "Device Types": summarized.types,
      "Device Names": summarized.names,
      "Device Statuses": summarized.statuses,
      "Device Serials": summarized.serials,
      "Device Computer Names": summarized.computers,
      "Device IDs": summarized.ids,
      "Device Line Phones": summarized.linePhones,
      "Notes": notes.join("; "),
    };
  });

  const csv = [
    headers.map(csvEscape).join(","),
    ...enriched.map((row) => headers.map((header) => csvEscape(row[header])).join(",")),
  ].join("\n");
  await fs.writeFile(OUTPUT_CSV, csv, "utf8");

  const matchedCount = enriched.filter((row) => row["RC Matched"] === "Yes").length;
  const deviceCount = enriched.filter((row) => Number(row["Devices Found"]) > 0).length;
  const userOwnedCount = enriched.filter((row) => row["Assigned Kind"] === "User").length;
  const queueOwnedCount = enriched.filter((row) => row["Assigned Kind"] === "Queue").length;
  const ivrOwnedCount = enriched.filter((row) => row["Assigned Kind"] === "IVR").length;
  const otherOwnedCount = enriched.filter((row) => row["RC Matched"] === "Yes" && !["User", "Queue", "IVR"].includes(row["Assigned Kind"])).length;

  const workbook = Workbook.create();
  const summary = workbook.worksheets.add("Summary");
  summary.showGridLines = false;
  summary.getRange("A1:B10").values = [
    ["CNAM RingCentral Enrichment", ""],
    ["Source CSV", INPUT_CSV],
    ["Generated", new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })],
    ["Input rows", sourceRows.length],
    ["Matched in RingCentral", matchedCount],
    ["Matched to user agents", userOwnedCount],
    ["Matched to queues", queueOwnedCount],
    ["Matched to IVR menus", ivrOwnedCount],
    ["Matched to other extensions", otherOwnedCount],
    ["Rows with device data", deviceCount],
  ];
  summary.getRange("A1:B1").format = {
    font: { bold: true, color: "#FFFFFF" },
    fill: { color: "#1F4E79" },
  };
  summary.getRange("A1:B10").format.columnWidthPx = 220;
  summary.getRange("A4:A10").format = { font: { bold: true } };

  const data = workbook.worksheets.add("Enriched Numbers");
  data.showGridLines = false;
  const matrix = [headers, ...enriched.map((row) => headers.map((header) => row[header]))];
  const lastColumn = spreadsheetColumnName(headers.length);
  data.getRangeByIndexes(0, 0, matrix.length, headers.length).values = matrix;
  data.getRangeByIndexes(0, 0, 1, headers.length).format = {
    font: { bold: true, color: "#FFFFFF" },
    fill: { color: "#1F4E79" },
    wrapText: true,
  };
  data.freezePanes.freezeRows(1);
  data.tables.add(`A1:${lastColumn}${matrix.length}`, true, "CnamRingCentralEnrichment");
  data.getRange("A:A").format.columnWidthPx = 135;
  data.getRange("B:B").format.columnWidthPx = 150;
  data.getRange("C:C").format.columnWidthPx = 105;
  data.getRange("D:D").format.columnWidthPx = 220;
  data.getRange("E:F").format.columnWidthPx = 115;
  data.getRange("G:G").format.columnWidthPx = 190;
  data.getRange("H:I").format.columnWidthPx = 260;
  data.getRange("J:K").format.columnWidthPx = 210;
  data.getRange(`L:${lastColumn}`).format.columnWidthPx = 150;
  data.getRange(`A1:${lastColumn}1`).format.rowHeightPx = 34;
  data.getRange(`A2:${lastColumn}${matrix.length}`).format.wrapText = false;

  const output = await SpreadsheetFile.exportXlsx(workbook);
  await output.save(OUTPUT_XLSX);

  const inspect = await workbook.inspect({
    kind: "table",
    range: `Enriched Numbers!A1:${lastColumn}${Math.min(matrix.length, 8)}`,
    include: "values",
    tableMaxRows: 8,
    tableMaxCols: headers.length,
  });
  console.log(inspect.ndjson);
  console.log(JSON.stringify({
    outputXlsx: OUTPUT_XLSX,
    outputCsv: OUTPUT_CSV,
    sourceRows: sourceRows.length,
    phoneInventoryRecords: phoneRecords.length,
    extensionRecords: extensions.length,
    accountDevices: accountDevices.length,
    routingLookups: routingTargets.length,
    matchedCount,
    userOwnedCount,
    queueOwnedCount,
    ivrOwnedCount,
    otherOwnedCount,
    deviceCount,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
