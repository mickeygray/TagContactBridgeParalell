"use strict";

const { requestJson } = require("../../shared-integrations/src");
const { spendEntryRepository } = require("../../shared-repositories/src");
const {
  getMailerConfigState,
  isMailerConfigLoaded,
  loadMailerConfigCache,
  reconcileMailerConfigsWithSheet,
  resolveMailerAt,
} = require("./mailerConfigService");
const { resolveCanonicalSource } = require("./sourceCanonicalService");
const { recordWorkflowStage } = require("./workflowStateService");
const { recordServiceAlert } = require("./controlPlaneHealthService");

const DEFAULT_WEEKDAYS = Object.freeze([1, 2, 3, 4, 5]);
const WEEKDAY_INDEX = Object.freeze({
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
});

function normalizeActiveWeekdays(values = null) {
  const source = Array.isArray(values) && values.length > 0
    ? values
    : DEFAULT_WEEKDAYS;
  const normalized = [...new Set(
    source
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6),
  )];
  return normalized.length > 0 ? normalized : [...DEFAULT_WEEKDAYS];
}

function getZonedParts(date, timezone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAY_INDEX[parts.weekday],
  };
}

function addDaysToYmd(ymd, days) {
  const date = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function getTimeZoneOffsetMs(date, timezone) {
  const parts = getZonedParts(date, timezone);
  const utcWithZonedClock = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return utcWithZonedClock - date.getTime();
}

function makeDateInTimezone(ymd, hour, minute, timezone) {
  const utcGuess = Date.UTC(ymd.year, ymd.month - 1, ymd.day, hour, minute, 0);
  let candidate = new Date(utcGuess);
  for (let attempts = 0; attempts < 3; attempts += 1) {
    candidate = new Date(utcGuess - getTimeZoneOffsetMs(candidate, timezone));
  }
  return candidate;
}

function parseDollar(value) {
  if (!value) return 0;
  const parsed = parseFloat(String(value).replace(/[$,\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseWholeNumber(value) {
  if (value === undefined || value === null || value === "") return 0;
  const parsed = parseInt(String(value).replace(/[,\s]/g, ""), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().split("T")[0];
}

function parseCsv(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .filter((line) => line.trim());
  if (lines.length < 2) return [];

  const parseRow = (line) => {
    const fields = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === "\"") {
        if (inQuotes && line[i + 1] === "\"") {
          current += "\"";
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === "," && !inQuotes) {
        fields.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
    fields.push(current.trim());
    return fields;
  };

  const headers = parseRow(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseRow(line);
    const row = {};
    headers.forEach((header, index) => {
      row[String(header || "").trim()] = String(values[index] || "").trim();
    });
    return row;
  }).filter((row) => Object.values(row).some(Boolean));
}

function parseMailerRow(row, sheetConfig) {
  const date = parseDate(row["Data Date"] || row["Drop Date"]);
  if (!date) return null;

  const spend = parseDollar(row.Total);
  const pieces = parseWholeNumber(row.Pieces);
  if (!spend && !pieces) return null;

  const phoneDigits = String(row.Phone || "").replace(/\D/g, "");
  const phone = phoneDigits.length === 10
    ? `${phoneDigits.slice(0, 3)}-${phoneDigits.slice(3, 6)}-${phoneDigits.slice(6)}`
    : phoneDigits || null;

  const jobName = row["Job Name"] || "Unknown";
  const mailerOwnership = phone && isMailerConfigLoaded()
    ? resolveMailerAt(phone, date)
    : null;
  const fallbackStream =
    parseWholeNumber(row.State) > 0 && parseWholeNumber(row.Federal) > 0
      ? "both"
      : parseWholeNumber(row.State) > 0
        ? "state"
        : "federal";
  const resolvedSource =
    mailerOwnership?.internalName ||
    mailerOwnership?.mailHouseName ||
    jobName;

  return {
    date,
    domain: sheetConfig.domain,
    channel: sheetConfig.channel,
    source: resolvedSource,
    mailHouseName: jobName,
    sheetId: sheetConfig.id,
    spend,
    postage: parseDollar(row.Postage),
    cost: parseDollar(row.Cost),
    pieces,
    jobNumber: row["Job Number"] || null,
    jobName,
    phone,
    form: mailerOwnership?.form || row.Form || null,
    stream: mailerOwnership?.stream || fallbackStream,
    trackingNumber: mailerOwnership?.crTrackingNumber || null,
    trackerName: mailerOwnership?.crTrackerName || null,
    rcQueueName: mailerOwnership?.rcQueueName || null,
    rcExt: mailerOwnership?.rcExt || null,
    internalMailerName: mailerOwnership?.internalName || null,
    ownershipMatched: Boolean(mailerOwnership),
    raw: row,
  };
}

function parseMetaRow(row, sheetConfig) {
  const date = parseDate(row["Reporting starts"] || row.Date);
  if (!date) return null;

  const campaignName = row["Campaign name"] || row.Campaign || null;
  const platform = row.Platform || "Meta";
  if (/^daily total$/i.test(String(campaignName || "").trim())) {
    return null;
  }

  const spend = parseDollar(row["Amount spent (USD)"] || row.Cost);
  if (!spend) return null;

  return {
    date,
    domain: sheetConfig.domain,
    channel: sheetConfig.channel,
    source: campaignName || "Unknown",
    sheetId: sheetConfig.id,
    spend,
    cost: spend,
    impressions: parseWholeNumber(row.Impressions),
    reach: parseWholeNumber(row.Reach),
    clicks: parseWholeNumber(row["Link clicks"] || row.Clicks),
    allClicks: parseWholeNumber(row["Clicks (all)"]),
    leadsReported: parseWholeNumber(row.Results || row.Leads),
    resultType: row["Result indicator"] || (row.Leads != null ? "Leads" : null),
    landingPageViews: parseWholeNumber(row["Website landing page views"]),
    campaign: campaignName,
    adSet: row["Ad set name"] || null,
    adName: row["Ad name"] || null,
    platform,
    raw: row,
  };
}

function normalizeGoogleSheetCsvUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.includes("output=csv")) return raw;
  if (raw.includes("/pubhtml")) {
    return raw.replace(/\/pubhtml(?:\?.*)?$/i, "/pub?output=csv");
  }
  if (raw.includes("/pub")) {
    return raw.replace(/\/pub(?:\?.*)?$/i, "/pub?output=csv");
  }
  return raw;
}

function getSpendSheets(config = {}) {
  return [
    {
      id: "mailer-tag",
      url: normalizeGoogleSheetCsvUrl(
        config.mailerTagUrl ||
        process.env.SPEND_SHEET_MAILER_TAG_URL ||
        process.env.MAILER_SPEND_SHEET ||
        "https://docs.google.com/spreadsheets/d/e/2PACX-1vRH1HGQrxnePrKzleAFlogKuOjxisbqz3d8bGruK9Sg54aqcFLqw8T2VQ5KTnTHU6zvShjhc5XhoA9x/pub?output=csv",
      ),
      domain: "TAG",
      channel: "mailer",
      parser: parseMailerRow,
      label: "TAG Mailer Spend",
    },
    {
      id: "meta-tag",
      url: normalizeGoogleSheetCsvUrl(
        config.metaTagUrl ||
        process.env.SPEND_SHEET_META_TAG_URL ||
        process.env.SOCIAL_SPEND_SHEET ||
        "",
      ),
      domain: "TAG",
      channel: "paid-social",
      parser: parseMetaRow,
      label: "TAG Meta Spend",
    },
    {
      id: "meta-wynn",
      url: normalizeGoogleSheetCsvUrl(
        config.metaWynnUrl ||
        process.env.SPEND_SHEET_META_WYNN_URL ||
        "https://docs.google.com/spreadsheets/d/e/2PACX-1vRRS0XHDEuDeYOjBBO7IFVyDXCD82mATCE8BrCkW3E0nL0XX7JIskB4_pU4ZggmB0V5jqrTSchORbS1/pub?output=csv",
      ),
      domain: "WYNN",
      channel: "paid-social",
      parser: parseMetaRow,
      label: "WYNN Meta Spend",
    },
  ].filter((sheet) => Boolean(sheet.url));
}

async function enrichSpendRowWithCanonical(row = {}) {
  if (!row || !row.domain || !row.source) return row;

  const canonical = await resolveCanonicalSource({
    domain: row.domain,
    internalName: row.source,
    sourceName: row.source,
    rawName: row.mailHouseName || row.jobName || row.source,
    mailHouseName: row.mailHouseName || row.jobName || null,
    trackerName: row.trackerName || null,
    trackingNumber: row.trackingNumber || row.phone || null,
    phone: row.phone || null,
    extensionId: row.rcExt || null,
    queueName: row.rcQueueName || null,
  }).catch(() => null);

  if (!canonical) return row;

  return {
    ...row,
    source: canonical.internalName || row.source,
    sourceCanonicalId: canonical.doc?._id || row.sourceCanonicalId || null,
  };
}

function computeNextRunAt(
  hour,
  minute,
  timezone = "America/Los_Angeles",
  now = new Date(),
  options = {},
) {
  const activeWeekdays = new Set(normalizeActiveWeekdays(options.activeWeekdays));
  let ymd = getZonedParts(now, timezone);
  let candidate = makeDateInTimezone(ymd, hour, minute, timezone);
  if (candidate.getTime() <= now.getTime()) {
    ymd = addDaysToYmd(ymd, 1);
    candidate = makeDateInTimezone(ymd, hour, minute, timezone);
  }
  for (let attempts = 0; attempts < 8; attempts += 1) {
    const zonedWeekday = getZonedParts(candidate, timezone).weekday;
    if (activeWeekdays.has(zonedWeekday)) {
      return candidate;
    }
    ymd = addDaysToYmd(ymd, 1);
    candidate = makeDateInTimezone(ymd, hour, minute, timezone);
  }
  return candidate;
}

function createSpendSyncRuntime({ config = {}, runtime }) {
  const state = {
    enabled: Boolean(config.enabled),
    running: false,
    hour: Number(config.hour || 19),
    minute: Number(config.minute || 45),
    timezone: config.timezone || "America/Los_Angeles",
    intervalMs: Number(config.intervalMs || 60000),
    activeWeekdays: normalizeActiveWeekdays(config.activeWeekdays),
    timer: null,
    nextRunAt: null,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastResult: null,
    lastError: null,
  };

async function syncSheet(sheetConfig) {
    if (sheetConfig.channel === "mailer" && !isMailerConfigLoaded()) {
      await loadMailerConfigCache();
    }

    const response = await requestJson(sheetConfig.url, {}, {
      timeoutMs: 30000,
      retries: 1,
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch spend sheet ${sheetConfig.id}: ${response.status}`);
    }

    const rawRows = parseCsv(response.data);
    let parsedRows = rawRows
      .map((row) => sheetConfig.parser(row, sheetConfig))
      .filter(Boolean)
      .map((row) => ({ ...row, syncedAt: new Date() }));

    parsedRows = await Promise.all(
      parsedRows.map((row) => enrichSpendRowWithCanonical(row)),
    );

    let reconcileResult = null;
    if (sheetConfig.channel === "mailer") {
      reconcileResult = await reconcileMailerConfigsWithSheet(
        parsedRows.map((row) => ({
          phone: row.phone,
          jobName: row.jobName,
          dropDate: row.date,
          pieces: row.pieces,
          total: row.spend,
        })),
        { sendConfirmation: true },
      );
    }

    let upserted = 0;
    let skipped = 0;
    for (const row of parsedRows) {
      try {
        await spendEntryRepository.upsertSpendEntry(row);
        upserted += 1;
      } catch (_error) {
        skipped += 1;
      }
    }

    return {
      sheet: sheetConfig.id,
      label: sheetConfig.label,
      parsedRows: rawRows.length,
      upserted,
      skipped,
      reconcileResult,
    };
  }

  async function syncAll(options = {}) {
    if (state.running) {
      return { ok: false, skipped: true, reason: "spend-sync-already-running" };
    }

    state.running = true;
    state.lastStartedAt = new Date();
    state.lastError = null;

    const sheets = getSpendSheets(config).filter((sheet) => {
      if (options.sheetId) return sheet.id === options.sheetId;
      if (options.domain) return sheet.domain === String(options.domain).toUpperCase();
      return true;
    });

    await recordWorkflowStage({
      domain: options.domain ? String(options.domain).toUpperCase() : null,
      family: "metrics",
      subtype: "spend-sync",
      stage: "requested",
      aggregateType: "spend-sync",
      aggregateId: String(Date.now()),
      sourceService: "control-plane",
      title: "Spend sync started",
      summary: `Syncing ${sheets.length} spend sheet(s)`,
      payload: { sheets: sheets.map((sheet) => sheet.id) },
    });

    try {
      const results = [];
      for (const sheet of sheets) {
        results.push(await syncSheet(sheet));
      }

      const summary = {
        ok: true,
        sheets: results,
        totalUpserted: results.reduce((sum, row) => sum + (row.upserted || 0), 0),
        totalSkipped: results.reduce((sum, row) => sum + (row.skipped || 0), 0),
      };

      state.lastCompletedAt = new Date();
      state.lastResult = summary;
      state.lastError = null;
      state.nextRunAt = computeNextRunAt(
        state.hour,
        state.minute,
        state.timezone,
        state.lastCompletedAt,
        { activeWeekdays: state.activeWeekdays },
      );

      await recordWorkflowStage({
        domain: options.domain ? String(options.domain).toUpperCase() : null,
        family: "metrics",
        subtype: "spend-sync",
        stage: "completed",
        aggregateType: "spend-sync",
        aggregateId: String(state.lastStartedAt.getTime()),
        sourceService: "control-plane",
        title: "Spend sync completed",
        summary: `${summary.totalUpserted} rows upserted across ${results.length} sheet(s)`,
        payload: summary,
        result: summary,
      });

      return summary;
    } catch (error) {
      state.lastCompletedAt = new Date();
      state.lastResult = null;
      state.lastError = error.message;
      state.nextRunAt = computeNextRunAt(
        state.hour,
        state.minute,
        state.timezone,
        state.lastCompletedAt,
        { activeWeekdays: state.activeWeekdays },
      );

      await recordWorkflowStage({
        family: "metrics",
        subtype: "spend-sync",
        stage: "failed",
        aggregateType: "spend-sync",
        aggregateId: String(state.lastStartedAt.getTime()),
        sourceService: "control-plane",
        status: "failed",
        title: "Spend sync failed",
        summary: error.message,
        result: { error: error.message },
      });

      await recordServiceAlert({
        domain: "TAG",
        sourceService: "control-plane",
        category: "spend-sync",
        severity: "high",
        title: "Spend sync failed",
        summary: error.message,
        tags: ["metrics", "spend-sync", "google-sheets"],
      });

      runtime.logger.error("spend-sync.failed", { error: error.message });
      throw error;
    } finally {
      state.running = false;
    }
  }

  async function start() {
    state.enabled = Boolean(config.enabled);
    state.nextRunAt = computeNextRunAt(state.hour, state.minute, state.timezone, new Date(), {
      activeWeekdays: state.activeWeekdays,
    });

    if (!state.enabled) {
      runtime.logger.warn("spend-sync.disabled");
      return;
    }

    const tick = async () => {
      if (state.running || !state.nextRunAt) return;
      if (Date.now() < state.nextRunAt.getTime()) return;
      try {
        await syncAll({ scheduled: true });
      } catch (_error) {
        // Recorded elsewhere.
      }
    };

    state.timer = setInterval(() => { void tick(); }, state.intervalMs);
    if (typeof state.timer.unref === "function") state.timer.unref();

    runtime.logger.info("spend-sync.armed", {
      hour: state.hour,
      minute: state.minute,
      timezone: state.timezone,
      activeWeekdays: state.activeWeekdays,
      nextRunAt: state.nextRunAt,
    });
  }

  async function stop() {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
  }

  function getState() {
    return {
      enabled: state.enabled,
      running: state.running,
      hour: state.hour,
      minute: state.minute,
      timezone: state.timezone,
      intervalMs: state.intervalMs,
      activeWeekdays: state.activeWeekdays,
      nextRunAt: state.nextRunAt,
      lastStartedAt: state.lastStartedAt,
      lastCompletedAt: state.lastCompletedAt,
      lastResult: state.lastResult,
      lastError: state.lastError,
      mailerConfig: getMailerConfigState(),
      sheets: getSpendSheets(config).map((sheet) => ({
        id: sheet.id,
        label: sheet.label,
        domain: sheet.domain,
        channel: sheet.channel,
      })),
    };
  }

  return {
    getState,
    syncAll,
    start,
    stop,
  };
}

module.exports = {
  computeNextRunAt,
  createSpendSyncRuntime,
  getSpendSheets,
  normalizeActiveWeekdays,
  parseCsv,
  parseMailerRow,
  parseMetaRow,
};
