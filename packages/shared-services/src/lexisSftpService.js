"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const Papa = require("papaparse");
const SftpClient = require("ssh2-sftp-client");
const Seven = require("node-7z");
const { path7za } = require("7zip-bin");
const { env } = require("../../shared-config/src");
const { sendPlainEmail } = require("./sendgridMailService");
const { intakeLexisBatch } = require("./inboundIntakeService");
const { recordWorkflowStage } = require("./workflowStateService");

const KEEP_STATES = new Set(["MO", "KS", "NE", "IA", "OK", "IN", "ND", "SD", "MN", "MI", "TX", "IL"]);
const STATE_NAMES = {
  MO: "Missouri",
  KS: "Kansas",
  NE: "Nebraska",
  IA: "Iowa",
  OK: "Oklahoma",
  IN: "Indiana",
  ND: "North Dakota",
  SD: "South Dakota",
  MN: "Minnesota",
  MI: "Michigan",
  TX: "Texas",
  IL: "Illinois",
};
const FEDERAL_PHONE = "(800) 513-0704";
const STATE_PHONE = "(800) 590-2477";

function ensureDependency(value, name) {
  if (!value) throw new Error(`${name} is not available. Install Lexis SFTP dependencies first.`);
}

function buildRunId(prefix = "lexis") {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(4).toString("hex")}`;
}

function toTitleCase(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/(?:^|\s|[-/])\S/g, (char) => char.toUpperCase());
}

function formatDate(date) {
  if (!date || Number.isNaN(date.getTime())) return "";
  return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}/${date.getFullYear()}`;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function parseAmount(value) {
  const parsed = parseFloat(String(value || "").replace(/[$,\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function cleanCsvText(rawCsvText = "") {
  return String(rawCsvText || "")
    .replace(/\u0000/g, "")
    .replace(/\r/g, "")
    .replace(/" +/g, '"')
    .replace(/"/g, "")
    .trim();
}

function parseLexisCsv(rawCsvText = "") {
  const { data } = Papa.parse(cleanCsvText(rawCsvText), {
    header: true,
    skipEmptyLines: true,
  });
  return Array.isArray(data) ? data : [];
}

function processMailHouseCsv(rawCsvText = "") {
  const allRows = parseLexisCsv(rawCsvText);
  const filtered = allRows.filter((row) => {
    const state = String(row.STATE || "").trim().toUpperCase();
    if (!KEEP_STATES.has(state)) return false;
    const isFederal = /federal tax lien/i.test(String(row.FILE_TYPE || ""));
    const amount = parseAmount(row.AMOUNT);
    if (isFederal && amount < 10000) return false;
    if (!isFederal && amount < 6000) return false;
    return true;
  });

  const groups = {};
  for (const row of filtered) {
    const key = [
      String(row.FILE_TYPE || "").trim().toUpperCase(),
      String(row.LAST_NAME || "").trim().toUpperCase(),
      String(row.ADDRESS || "").trim().toUpperCase(),
      String(row.STATE || "").trim().toUpperCase(),
      String(row.AMOUNT || "").trim(),
    ].join("|");
    if (!groups[key]) groups[key] = [];
    groups[key].push(row);
  }

  const deduped = [];
  let dupsRemoved = 0;
  for (const group of Object.values(groups)) {
    if (group.length === 1) deduped.push(group[0]);
    else {
      deduped.push(group[1]);
      dupsRemoved += group.length - 1;
    }
  }

  const transformed = deduped.map((row) => {
    const isFederal = /federal tax lien/i.test(String(row.FILE_TYPE || ""));
    const state = String(row.STATE || "").trim().toUpperCase();
    const amount = parseAmount(row.AMOUNT);
    const loadDate = row.LOAD_DATE ? new Date(row.LOAD_DATE) : new Date();
    return {
      Type: toTitleCase(String(row.FILE_TYPE || "")),
      "Filing Date": row.FILING_DATE || "",
      "Mail Date": formatDate(loadDate),
      "Mail Date +7": formatDate(addDays(loadDate, 7)),
      Authority: isFederal ? "Federal Taxing Authority" : "State Taxing Authority",
      Identification: isFederal ? "Passport" : "Driver's License",
      Number: isFederal ? FEDERAL_PHONE : STATE_PHONE,
      Address: toTitleCase(row.ADDRESS || ""),
      City: toTitleCase(row.CITY || ""),
      State: state,
      "State Name": STATE_NAMES[state] || "your state",
      Zip: String(row.ZIP || "").trim(),
      Amount: amount.toFixed(2),
      "05 Amount": (amount * 0.05).toFixed(2),
      "95 Amount": (amount * 0.95).toFixed(2),
      County: toTitleCase(row.COUNTY || ""),
      "First Name": toTitleCase(row.FIRST_NAME || ""),
      "Last Name": toTitleCase(row.LAST_NAME || ""),
    };
  });

  return {
    csv: Papa.unparse(transformed),
    stats: {
      inputRows: allRows.length,
      filteredRows: filtered.length,
      droppedRows: allRows.length - filtered.length,
      dupsRemoved,
      dedupedRows: deduped.length,
      stateBreakdown: filtered.reduce((accumulator, row) => {
        const state = String(row.STATE || "").trim().toUpperCase();
        accumulator[state] = (accumulator[state] || 0) + 1;
        return accumulator;
      }, {}),
      federalCount: filtered.filter((row) => /federal tax lien/i.test(String(row.FILE_TYPE || ""))).length,
      stateCount: filtered.filter((row) => /state tax/i.test(String(row.FILE_TYPE || ""))).length,
    },
  };
}

function mapLexisRowsForIntake(rows = [], domain = "TAG") {
  return rows
    .map((row) => ({
      company: domain,
      firstName: String(row.FIRST_NAME || "").trim() || null,
      lastName: String(row.LAST_NAME || "").trim() || "Prospect",
      name: [String(row.FIRST_NAME || "").trim(), String(row.LAST_NAME || "").trim()].filter(Boolean).join(" ").trim() || null,
      city: String(row.CITY || "").trim() || null,
      state: String(row.STATE || "").trim().toUpperCase() || null,
      source: "lexis-sftp",
      sourceName: "ABC",
      logicsSourceName: "ABC",
      address: String(row.ADDRESS || "").trim() || null,
      zip: String(row.ZIP || "").trim() || null,
      filingDate: String(row.FILING_DATE || "").trim() || null,
      amount: parseAmount(row.AMOUNT),
      lienType: String(row.FILE_TYPE || "").trim() || null,
      county: String(row.COUNTY || "").trim() || null,
      loadDate: String(row.LOAD_DATE || "").trim() || null,
      rawLexis: row,
    }))
    .filter((row) => row.name || row.address || row.city || row.state);
}

async function downloadLatestLexisZip(options = {}) {
  ensureDependency(SftpClient, "ssh2-sftp-client");
  const sftp = new SftpClient();
  const remoteDir = options.remoteDir || env("SFTP_REMOTE_DIR", "OUT");
  const tmpDir = options.tmpDir || os.tmpdir();
  await sftp.connect({
    host: options.host || env("SFTP_HOST", ""),
    port: Number(options.port || env("SFTP_PORT", 22)),
    username: options.username || env("SFTP_USER", ""),
    password: options.password || env("SFTP_SITE_PASSWORD", ""),
  });

  try {
    const list = (await sftp.list(remoteDir)).filter((item) => item.type === "-");
    if (!list.length) throw new Error(`No files found in remote Lexis directory ${remoteDir}`);
    const latest = list.reduce((left, right) => Number(left.modifyTime || 0) > Number(right.modifyTime || 0) ? left : right);
    const remotePath = path.posix.join(remoteDir, latest.name);
    const localPath = path.join(tmpDir, `${buildRunId("lexis-zip")}-${latest.name}`);
    await sftp.fastGet(remotePath, localPath);
    return {
      remoteDir,
      remotePath,
      localPath,
      filename: latest.name,
      modifyTime: latest.modifyTime || null,
      size: latest.size || null,
    };
  } finally {
    await sftp.end();
  }
}

async function unzipLexisArchive(zipPath, outDir, password) {
  ensureDependency(Seven, "node-7z");
  ensureDependency(path7za, "7zip-bin");
  fs.mkdirSync(outDir, { recursive: true });
  return new Promise((resolve, reject) => {
    const extractor = Seven.extractFull(zipPath, outDir, {
      $bin: path7za,
      password,
      recursive: true,
    });
    extractor.on("end", () => resolve(fs.readdirSync(outDir).map((name) => path.join(outDir, name))));
    extractor.on("error", reject);
  });
}

function collectFiles(dir) {
  let output = [];
  for (const name of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, name);
    if (fs.statSync(fullPath).isDirectory()) output = output.concat(collectFiles(fullPath));
    else if (path.extname(fullPath).toLowerCase() !== ".zip") output.push(fullPath);
  }
  return output;
}

async function fetchLatestLexisDrop(options = {}) {
  const runId = buildRunId();
  const workDir = path.join(options.workDir || os.tmpdir(), runId);
  fs.mkdirSync(workDir, { recursive: true });
  const download = await downloadLatestLexisZip(options);
  const zipTarget = path.join(workDir, path.basename(download.localPath));
  fs.copyFileSync(download.localPath, zipTarget);
  await unzipLexisArchive(zipTarget, workDir, options.zipPassword || env("SFTP_ZIP_PASSWORD", ""));
  const attachments = collectFiles(workDir);
  const csvPath = attachments.find((file) => path.extname(file).toLowerCase() === ".csv") || null;
  const rawCsv = csvPath ? fs.readFileSync(csvPath, "utf8") : "";
  const parsedRows = rawCsv ? parseLexisCsv(rawCsv) : [];
  const mailHouse = rawCsv ? processMailHouseCsv(rawCsv) : { csv: "", stats: {} };
  return {
    runId,
    workDir,
    download,
    attachments,
    csvPath,
    rawCsv,
    parsedRows,
    mailHouse,
  };
}

async function ingestLatestLexisDrop(options = {}) {
  const domain = String(options.domain || "TAG").toUpperCase();
  const aggregateId = buildRunId("lexis-ingest");
  await recordWorkflowStage({
    domain,
    family: "lexis",
    subtype: "manual-ingest",
    stage: "requested",
    aggregateType: "lexis-drop",
    aggregateId,
    sourceService: options.sourceService || "control-plane",
    title: "Lexis ingest requested",
    summary: `Fetching and ingesting latest Lexis drop for ${domain}`,
    payload: {
      importBatch: options.importBatch || null,
    },
  });
  try {
    const drop = options.drop || await fetchLatestLexisDrop(options);
    const intakeRows = mapLexisRowsForIntake(drop.parsedRows, domain);
    const intakeResult = await intakeLexisBatch(intakeRows, {
      sourceService: options.sourceService || "control-plane",
      importBatch: options.importBatch || path.basename(drop.download.filename, path.extname(drop.download.filename)),
    });
    const result = {
      domain,
      runId: drop.runId,
      file: {
        remotePath: drop.download.remotePath,
        filename: drop.download.filename,
        modifyTime: drop.download.modifyTime,
        size: drop.download.size,
      },
      attachments: drop.attachments.map((file) => path.basename(file)),
      parsedRows: drop.parsedRows.length,
      intakeRows: intakeRows.length,
      intakeResult,
      mailHouseStats: drop.mailHouse.stats,
      workDir: drop.workDir,
    };

    await recordWorkflowStage({
      domain,
      family: "lexis",
      subtype: "manual-ingest",
      stage: "completed",
      aggregateType: "lexis-drop",
      aggregateId: drop.runId || aggregateId,
      sourceService: options.sourceService || "control-plane",
      title: "Lexis ingest completed",
      summary: `Ingested ${intakeRows.length} Lexis row(s) for ${domain}`,
      payload: {
        filename: drop.download.filename,
        parsedRows: drop.parsedRows.length,
        intakeRows: intakeRows.length,
      },
      result,
    });

    return result;
  } catch (error) {
    await recordWorkflowStage({
      domain,
      family: "lexis",
      subtype: "manual-ingest",
      stage: "failed",
      aggregateType: "lexis-drop",
      aggregateId,
      sourceService: options.sourceService || "control-plane",
      status: "failed",
      title: "Lexis ingest failed",
      summary: error.message,
      result: { error: error.message },
    });
    throw error;
  }
}

async function sendLexisRegionalMail(options = {}) {
  const domain = String(options.domain || "TAG").toUpperCase();
  const aggregateId = buildRunId("lexis-regional-mail");
  await recordWorkflowStage({
    domain,
    family: "lexis",
    subtype: "regional-mail",
    stage: "requested",
    aggregateType: "lexis-mail",
    aggregateId,
    sourceService: options.sourceService || "control-plane",
    title: "Lexis regional mail requested",
    summary: `Preparing regional mail-house file for ${domain}`,
  });
  try {
    const drop = options.drop || await fetchLatestLexisDrop(options);
    const stats = drop.mailHouse.stats || {};
    if (!drop.mailHouse.csv || !stats.dedupedRows) {
      const result = { ok: true, skipped: true, reason: "no-regional-records", stats };
      await recordWorkflowStage({
        domain,
        family: "lexis",
        subtype: "regional-mail",
        stage: "completed",
        aggregateType: "lexis-mail",
        aggregateId,
        sourceService: options.sourceService || "control-plane",
        title: "Lexis regional mail skipped",
        summary: "No regional mail records were available to send",
        result,
      });
      return result;
    }

    const fileName = `RegionalDrop-${new Date().toISOString().slice(0, 10)}.csv`;
    const recipients = String(options.recipients || env("MAILHOUSE_2_EMAIL", ""))
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (!recipients.length) {
      const result = { ok: false, skipped: true, reason: "missing-mailhouse-recipient", stats };
      await recordWorkflowStage({
        domain,
        family: "lexis",
        subtype: "regional-mail",
        stage: "failed",
        aggregateType: "lexis-mail",
        aggregateId,
        sourceService: options.sourceService || "control-plane",
        status: "failed",
        title: "Lexis regional mail failed",
        summary: "No regional mail recipients were configured",
        result,
      });
      return result;
    }

    await sendPlainEmail(domain, {
      from: {
        email: options.fromEmail || env("ADMIN_EMAIL", ""),
        name: options.fromName || "Lexis Regional Drop",
      },
      personalizations: recipients.map((email) => ({
        to: [{ email }],
        subject: options.subject || "Maverick Daily Drop",
      })),
      content: [{ type: "text/plain", value: options.text || "Please see the attached file." }],
      attachments: [{
        filename: fileName,
        type: "text/csv",
        disposition: "attachment",
        content: Buffer.from(drop.mailHouse.csv, "utf8").toString("base64"),
      }],
    });

    const result = { ok: true, recipients, stats, fileName };
    await recordWorkflowStage({
      domain,
      family: "lexis",
      subtype: "regional-mail",
      stage: "completed",
      aggregateType: "lexis-mail",
      aggregateId,
      sourceService: options.sourceService || "control-plane",
      title: "Lexis regional mail sent",
      summary: `Sent regional mail-house file to ${recipients.length} recipient(s)`,
      result,
    });
    return result;
  } catch (error) {
    await recordWorkflowStage({
      domain,
      family: "lexis",
      subtype: "regional-mail",
      stage: "failed",
      aggregateType: "lexis-mail",
      aggregateId,
      sourceService: options.sourceService || "control-plane",
      status: "failed",
      title: "Lexis regional mail failed",
      summary: error.message,
      result: { error: error.message },
    });
    throw error;
  }
}

module.exports = {
  buildRunId,
  collectFiles,
  downloadLatestLexisZip,
  fetchLatestLexisDrop,
  ingestLatestLexisDrop,
  mapLexisRowsForIntake,
  parseLexisCsv,
  processMailHouseCsv,
  sendLexisRegionalMail,
  unzipLexisArchive,
};
