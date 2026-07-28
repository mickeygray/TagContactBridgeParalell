"use strict";

// THE SCHEDULER — run a saved shape, on a clock, without a model in the loop.
//
// Mickey 2026-07-28: "so yeah mostly this is a report scheduler on the common
// things. so if i want to run something and email it tonight i can set that up
// without talkign to a model. but if i get asked an interesting question we can
// design something that uses this set of tools to get an answer."
//
// This file is the FIRST half of that sentence. It resolves a rolling range,
// composes the report from the authoritative services, and delivers it. It has
// no opinions about content — the blocks own that.

const ReportDefinition = require("../../shared-models/src/ReportDefinition");
const { composeReport, renderHtml, renderText } = require("./reportComposerService");
const { resolveSelection } = require("./reportBlocksService");

const DAY_MS = 86400000;

/** Pacific day key — every loop on this box is Pacific, so reports are too. */
function pacificKey(at = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(at);
}

function pacificParts(at = new Date()) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit",
    weekday: "short", day: "2-digit", hour12: false,
  }).formatToParts(at);
  const get = (t) => f.find((p) => p.type === t)?.value;
  const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[get("weekday")];
  return { hour: Number(get("hour")) % 24, minute: Number(get("minute")), dayOfWeek: dow, dayOfMonth: Number(get("day")) };
}

const shift = (key, days) => new Date(Date.parse(`${key}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/**
 * Resolve a rolling range token to real dates.
 *
 * "yesterday" must mean yesterday on the day it RUNS — a saved shape that
 * froze a literal date would quietly email the same numbers forever.
 */
function resolveRange(token, now = new Date()) {
  const today = pacificKey(now);
  switch (String(token || "yesterday")) {
    case "today": return { from: today, to: today };
    case "yesterday": { const y = shift(today, -1); return { from: y, to: y }; }
    case "last7": return { from: shift(today, -7), to: shift(today, -1) };
    case "last30": return { from: shift(today, -30), to: shift(today, -1) };
    case "mtd": return { from: `${today.slice(0, 7)}-01`, to: today };
    case "lastmonth": {
      const first = `${today.slice(0, 7)}-01`;
      const lastDayPrev = shift(first, -1);
      return { from: `${lastDayPrev.slice(0, 7)}-01`, to: lastDayPrev };
    }
    case "ytd": return { from: `${today.slice(0, 4)}-01-01`, to: today };
    default: { const y = shift(today, -1); return { from: y, to: y }; }
  }
}

/**
 * Is this definition due right now?
 *
 * Due-ness is decided against lastRunKey, not an in-memory flag: the control
 * plane restarts often and must not re-send a report that already went out.
 */
function isDue(def, now = new Date()) {
  if (!def?.schedule?.enabled || def.archivedAt) return { due: false, reason: "not scheduled" };
  const { hour, minute, dayOfWeek, dayOfMonth } = pacificParts(now);
  const dows = def.schedule.daysOfWeek || [];
  if (dows.length && !dows.includes(dayOfWeek)) return { due: false, reason: "not a scheduled weekday" };
  const doms = def.schedule.daysOfMonth || [];
  if (doms.length) {
    const isLastDay = shift(pacificKey(now), 1).slice(8) === "01";
    const wanted = doms.includes(dayOfMonth) || (doms.includes(0) && isLastDay);
    if (!wanted) return { due: false, reason: "not a scheduled day of month" };
  }
  const nowMins = hour * 60 + minute;
  const wantMins = (def.schedule.hour || 0) * 60 + (def.schedule.minute || 0);
  if (nowMins < wantMins) return { due: false, reason: "before scheduled time" };
  const key = pacificKey(now);
  if (def.lastRunKey === key) return { due: false, reason: "already ran today" };
  return { due: true, reason: null };
}

/**
 * Run one saved shape. Always re-gathers; never reads a stored answer.
 *
 * `dryRun` composes and renders but does not send or record the run — so a
 * schedule can be inspected before it is armed.
 */
async function runDefinition(def, {
  now = new Date(), dryRun = false, logger = null, sendMail = null, fromEmail = null,
} = {}) {
  const started = Date.now();
  const range = resolveRange(def.range, now);
  const selection = resolveSelection(def.blocks && def.blocks.length ? def.blocks : ["daily"]);
  if (selection.unknown.length) {
    // Refuse rather than quietly emailing a report missing the thing that was
    // asked for — a silently-dropped block looks like a zero.
    throw new Error(`definition "${def.name}" names unknown block(s): ${selection.unknown.join(", ")}`);
  }

  const report = await composeReport({
    selection: def.blocks && def.blocks.length ? def.blocks : ["daily"],
    from: range.from, to: range.to,
    domain: def.domain || null,
    // composeReport destructures `where`, not `filters`. Passing the wrong key
    // did not throw — it silently dropped every saved filter, so a definition
    // saved as "cohort=2024 only" emailed the UNFILTERED numbers and looked
    // perfectly fine doing it.
    where: def.filters || [],
    live: true, logger,
  });

  const text = renderText(report);
  const html = renderHtml(report);
  const result = {
    definition: def.name, range, blocks: selection.blocks.map((b) => b.id),
    sections: report.sections.length,
    errors: report.sections.filter((s) => s.error).map((s) => `${s.id}: ${s.error}`),
    notes: report.notes || [],
    text, html, report, delivered: false, durationMs: Date.now() - started,
  };

  if (dryRun) return result;

  const to = (def.recipients || []).filter(Boolean);
  if (def.sendEmail && to.length && typeof sendMail === "function") {
    // sendMail(domain, options) — the DOMAIN is the first positional argument,
    // not a field on the options object. Passing options first silently sends
    // from the wrong transport at best and throws at worst.
    await sendMail(def.domain || null, {
      to, from: fromEmail || undefined,
      subject: `${def.name} · ${range.from}${range.to !== range.from ? ` → ${range.to}` : ""}`,
      text, html,
    });
    result.delivered = true;
  } else if (def.sendEmail && !to.length) {
    result.notes = [...result.notes, "no recipients on this definition — nothing was sent"];
  }

  if (typeof def.save === "function") {
    def.lastRunKey = pacificKey(now);
    def.lastRunAt = new Date();
    def.lastDurationMs = result.durationMs;
    def.lastError = result.errors.length ? result.errors.join(" | ").slice(0, 400) : null;
    def.runCount = (def.runCount || 0) + 1;
    await def.save();
  }
  return result;
}

/** Every definition due right now, oldest-scheduled first. */
async function dueDefinitions(now = new Date()) {
  const defs = await ReportDefinition.find({ "schedule.enabled": true, archivedAt: null });
  return defs.filter((d) => isDue(d, now).due);
}

module.exports = {
  ReportDefinition, dueDefinitions, isDue, pacificKey, pacificParts, resolveRange, runDefinition,
};
