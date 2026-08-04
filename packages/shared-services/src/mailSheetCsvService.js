"use strict";

// THE MAIL SPEND SHEET, READ AS A CSV. That is the whole service.
//
// Mickey 2026-08-03: "we just need to read just the csv dont need a big
// complicated service" / "just read the csv if we have no email at 7:50" /
// "and if neither matches".
//
// ── WHY THIS EXISTS AT ALL ─────────────────────────────────────────────────
//
// The vendor does ONE OR THE OTHER on a given day, not reliably both:
//   "they updated the sheet but didnt send me invoices"
//   "when they normally send me invoices and dont update the sheet"
//
// So mail spend has two legitimate sources and the day's answer is whichever
// arrived. The invoice is preferred — it is what they actually billed — and
// this is the fallback when no invoice landed.
//
// ── WHY NOT spendSyncService ───────────────────────────────────────────────
//
// That path is 1,142 lines across two files, drives nine sheets, and only runs
// inside the control plane — which is Manual+Stopped, so the sheet had not
// reached SpendEntry since 2026-07-30 while the vendor was still updating it.
// A report that needs one CSV should not depend on a scheduled service being
// up. This reads the sheet at report time, live, and stores nothing.
//
// It is deliberately NOT a writer. No new collection, no second copy of the
// numbers to drift — the reader gets rows shaped exactly like the spend rows
// the composer already merges, and partitionMailSpend does the rest.

const DEFAULT_TIMEOUT_MS = 15000;

const clean = (v) => String(v ?? "").trim();

/**
 * Minimal RFC-4180 CSV: quoted fields, escaped quotes, embedded commas and
 * newlines. Self-contained on purpose — the point of this service is to not
 * depend on the big one.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const src = String(text || "").replace(/\r\n/g, "\n");
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ",") { row.push(field); field = ""; continue; }
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0].map(clean);
  return rows.slice(1)
    .filter((r) => r.some((c) => clean(c)))
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, clean(r[i])])));
}

const dollars = (v) => {
  const n = Number(String(v ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const whole = (v) => {
  const n = Number(String(v ?? "").replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? Math.round(n) : 0;
};

/**
 * The vendor's own job name -> our canonical source name.
 *
 * The sheet and the invoice are written by the SAME vendor and use the SAME
 * job names — "Urgent 3rd White", "Afford Csnap", "3rd Notice Pink" — so this
 * reuses the invoice parser's PIECES map rather than starting a second one.
 * Two piece maps for one vendor is how they drift.
 *
 * Left unmapped, these names are not on the active roster, so every dollar
 * bucketed to "Aged / inactive source": on 2026-08-03 that put the whole
 * $1,584.48 on Aged while the three real pieces showed responses and no spend,
 * and BY CHANNEL / MAIL read $0.00 on a day mail cost $1,584.48.
 *
 * SOURCE_ALIASES is consulted first because it is the wider, hand-maintained
 * map; PIECES is the vendor-specific fallback.
 */
function canonicalJobName(jobName) {
  const raw = clean(jobName);
  if (!raw) return raw;
  try {
    const { SOURCE_ALIASES } = require("./simpleMarketingReadService");
    if (SOURCE_ALIASES && SOURCE_ALIASES[raw]) return SOURCE_ALIASES[raw];
  } catch { /* the alias map is optional */ }
  try {
    const { PIECES } = require("./mailInvoiceParseService");
    for (const piece of PIECES || []) {
      if (piece.name && piece.name.test(raw)) return piece.source;
    }
  } catch { /* fall through to the raw name */ }
  // Unresolvable names are returned AS WRITTEN, never dropped. An unknown
  // piece must show up as an unknown piece — silently discarding it would
  // lose real money from the day.
  return raw;
}

/** The sheet writes dates a few ways; normalise to a YYYY-MM-DD key. */
function toDateKey(raw) {
  const s = clean(raw);
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (m) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${year}-${String(m[1]).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}`;
  }
  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null;
}

/**
 * Read mail spend rows for [from..to] straight off the sheet.
 *
 * Returns rows in the SAME shape the composer's spend rows already use, so
 * partitionMailSpend can treat them exactly like SpendEntry rows — the invoice
 * still wins any day it covers.
 *
 * `unavailable` is set when the sheet could not be read at all. A day with no
 * rows and a sheet we could not fetch must never render the same: the first is
 * "they did not update it", the second is "we could not look".
 */
async function readMailSheetCsv({
  from, to = from, url = null, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = null,
} = {}) {
  // An EXPLICITLY passed url wins, even when empty. `url || config` meant a
  // caller saying "no sheet" silently got the configured one and went to the
  // network — which in a test is a live fetch nobody asked for, and in
  // production is a fallback firing where the caller meant to disable it.
  const target = url === undefined || url === null
    ? require("../../shared-config/src").getSharedConfig()?.spendSync?.mailerTagUrl
    : url;
  if (!target) {
    return { rows: [], days: [], unavailable: "no mail sheet URL configured" };
  }

  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== "function") {
    return { rows: [], days: [], unavailable: "no fetch implementation available" };
  }

  let text;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
    try {
      const res = await doFetch(target, { redirect: "follow", signal: controller.signal });
      if (!res.ok) {
        // Never the URL in the message — it is a credentialed export link.
        return { rows: [], days: [], unavailable: `mail sheet responded ${res.status}` };
      }
      text = await res.text();
    } finally { clearTimeout(timer); }
  } catch (error) {
    const why = error?.name === "AbortError" ? "timed out" : String(error.message).slice(0, 90);
    return { rows: [], days: [], unavailable: `mail sheet unreadable — ${why}` };
  }

  // A sheet that answers with a login page is NOT an empty sheet.
  if (/^\s*<(!doctype|html)/i.test(text)) {
    return { rows: [], days: [], unavailable: "mail sheet returned HTML, not CSV — the export link is not public" };
  }

  const parsed = parseCsv(text);
  const rows = [];
  const days = new Set();
  for (const r of parsed) {
    const date = toDateKey(r["Data Date"] || r["Drop Date"] || r.Date);
    if (!date || date < from || date > to) continue;
    const spend = dollars(r.Total);
    const pieces = whole(r.Pieces);
    if (!spend && !pieces) continue;   // a blank or spacer line is not a drop
    days.add(date);
    rows.push({
      date,
      channel: "mailer",
      source: canonicalJobName(r["Job Name"]) || "Unknown",
      spend,
      // `cost` is what the night board sums as its POSTAGE subtotal.
      cost: dollars(r.Postage),
      pieces,
      leadsReported: 0,
      fromSheet: true,
    });
  }
  return { rows, days: [...days].sort(), unavailable: null };
}

module.exports = { readMailSheetCsv, parseCsv, toDateKey, canonicalJobName };
