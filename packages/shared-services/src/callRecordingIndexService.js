"use strict";

// GATHER ALL RECORDING LINKS, STORE THEM IN ONE COLLECTION.
//
// Mickey 2026-08-04: "group concepts together and write them as one coherent
// thing — so this is: gather all recording links, store them in collection."
//
// One entry point, one normalizer, one writer. The three providers differ only
// in WHERE their rows are read from and whether their link is durable; every
// other decision — exclusion, day, identity, upsert — happens once, here, so it
// cannot drift between sources. Adding a fourth provider is one reader.
//
// ── WHERE EACH PROVIDER'S LINK ACTUALLY LIVES ───────────────────────────────
//
// Measured 2026-08-04, because none of this is guessable from the model names:
//
//   PhoneBurner   DailyDial.recordingUrl. NOT CallLog — CallLog holds 23,663
//                 phoneburner calls over 30 days with ZERO recording links. A
//                 gatherer that reads CallLog for PhoneBurner finds nothing
//                 while the links sit in another collection at 792/792.
//   CallRail      MarketingCallLink.listenUrl, written by the (currently dark)
//                 capture task. Durable, serves HTTP 200 audio unauthenticated.
//   RingCentral   CallLog under platform "ex" — there is no "ringcentral"
//                 platform value anywhere. 6,454 calls in 30 days, ~15% with an
//                 archived link. What is stored is an IDENTIFIER; the playable
//                 URL is signed per request.
//
// ── THE TRAP IN "ex" ────────────────────────────────────────────────────────
//
// `platform: "ex"` is not a synonym for RingCentral. Roughly 252 CallRail rows
// are mislabelled into it. So provider is resolved from EVIDENCE — the shape of
// the stored URI — and a row whose provider cannot be established is skipped
// loudly rather than filed under a guess.

const CallRecordingIndex = require("../../shared-models/src/CallRecordingIndex");
const { findExcludedAgentMatch } = require("./recordingArchiveService");

const PACIFIC = "America/Los_Angeles";

const pacificDayWindow = (dateKey) => {
  // Stored timestamps are UTC. A string prefix match on them shifts the day by
  // up to eight hours, which silently moves evening calls into tomorrow.
  const start = new Date(`${dateKey}T00:00:00-07:00`);
  return { $gte: start, $lt: new Date(start.getTime() + 86400000) };
};

/**
 * Provider from evidence, never from `platform`.
 *
 * `recordingArchive.provider` is the authoritative field and is tried FIRST —
 * the archiver stamped it when it resolved the recording, so it beats anything
 * inferred afterwards. The URI shape is the fallback for rows that predate it.
 *
 * Measured over 90 days, rows carrying a recording URI:
 *     ex  + provider ringcentral   1,962
 *     ex  + provider callrail      1,177
 *     cx  + provider ringcx          296
 * So `platform: "ex"` is ~38% CallRail — not the ~252 mislabelled rows previously
 * believed. Trusting `platform` here would file roughly twelve hundred CallRail
 * recordings as RingCentral and send every one of them through a mint-on-read
 * path they do not need and would fail.
 */
function resolveProvider({ archiveProvider, uri, platform } = {}) {
  const stamped = String(archiveProvider || "").toLowerCase();
  if (["callrail", "phoneburner", "ringcentral", "ringcx"].includes(stamped)) return stamped;
  const s = String(uri || "").toLowerCase();
  if (s.includes("callrail")) return "callrail";
  if (s.includes("phoneburner")) return "phoneburner";
  if (s.includes("ringcentral")) return "ringcentral";
  // No stamp and no URI to judge by: only "cx" is unambiguous on its own. "ex"
  // is the mixed bucket and is exactly what must not be guessed.
  if (String(platform || "").toLowerCase() === "cx") return "ringcx";
  return null;
}

/** Back-compat shim for the earlier signature. */
const resolveProviderFromUri = (uri, platform) => resolveProvider({ uri, platform });

// SIGNIFICANCE — what earns a call a place in the collection.
//
// Mickey 2026-08-04: "it's all the SIGNIFICANT links ... a refined collection."
// 816 PhoneBurner dials landed on 08-04 alone; indexing all of them buys a
// haystack. So the same vocabulary nightRecordingsService already uses to pick
// notable calls applies here — LONG / DEAL / POSTDATE — rather than a second
// idea of "worth hearing" that would drift from the one the email applies.
// ITS OWN THRESHOLD, deliberately not nightRecordingsService.LONG_CALL_SECONDS.
//
// Mickey 2026-08-04: "5 minutes is significant enough for this version of
// things." The email's bar is ten minutes, and importing that constant to lower
// it here would have moved the nightly email's "calls worth hearing" list at the
// same time — the one thing that must not change. Two consumers, two bars, one
// vocabulary.
const INDEX_LONG_CALL_SECONDS = Math.max(
  1, Number(process.env.CALL_INDEX_LONG_CALL_SECONDS) || 300,
);

const last10 = (p) => String(p || "").replace(/\D/g, "").slice(-10);

/**
 * Why this call is worth keeping. Empty array = it is not, and no row is written.
 *
 * @param {Object} row
 * @param {Map}    notableByPhone  last-10 phone -> Set of reasons (DEAL/POSTDATE),
 *                                 supplied by the caller because resolving sales
 *                                 and post-dates is report-time work, not a
 *                                 lookup this service should own.
 */
function significanceFor(row, notableByPhone = new Map()) {
  const reasons = new Set();
  if (Number(row.durationSec || 0) >= INDEX_LONG_CALL_SECONDS) reasons.add("LONG");
  const hit = notableByPhone.get(last10(row.phone));
  if (hit) for (const r of hit) reasons.add(r);
  return [...reasons];
}

// ── WHAT COUNTS AS A RINGCENTRAL ("ex") CALL WORTH INDEXING ─────────────────
//
// Mickey 2026-08-04: "we don't have to work twice, and the ex API is a lot less
// friendly for rate limiting. So the rules for ex is like calls that are not
// inter-office or tied to a marketing piece — like when an agent talks to an
// existing client."
//
// Two reasons to be strict here and nowhere else. A marketing-attributed call
// already belongs to CallRail, which hands out durable links for free; taking it
// through RingCentral as well is the same call fetched twice, and the second
// fetch is the expensive one. And inter-office calls are not client contact at
// all.
//
// Measured over 14 days, 1,960 `ex` rows:
//     marketing-attributed (mailPieceKey / sourceCanonicalId)   1,059
//     short number, i.e. an extension                             265
//     carries a caseId                                          1,024
//     sourceChannel: mail 750 · none 664 · ld-posting 403 · callrail 83 · mailer 19
//
// So roughly two thirds are already somebody else's call or not a client at all.
const MARKETING_CHANNELS = new Set(["mail", "mailer", "callrail", "ld-posting", "ld"]);

/**
 * @returns {null|string} null to keep, or the reason it is skipped.
 */
function exSkipReason(row = {}) {
  const digits = String(row.normalizedPhone || row.phone || "").replace(/\D/g, "");
  // An extension, not a phone number — agent to agent.
  if (digits && digits.length < 10) return "inter-office";
  // CallRail owns anything attributable to a marketing piece, and it serves
  // those links without an API call.
  if (row.mailPieceKey) return "marketing-piece";
  if (MARKETING_CHANNELS.has(String(row.sourceChannel || "").toLowerCase())) return "marketing-channel";
  if (row.sourceCanonicalId) return "marketing-source";
  return null;
}

/** One row's worth of exclusion verdict, applied identically to every source. */
function exclusionFor(names = []) {
  const hit = findExcludedAgentMatch(names.filter(Boolean));
  return hit ? { excluded: true, excludedReason: `excluded-agent:${hit}` } : { excluded: false, excludedReason: null };
}

// ── READERS. Each returns normalized candidates; none writes. ───────────────

async function readPhoneBurner(dateKey, { DailyDial }) {
  const rows = await DailyDial.find({
    dateKey,
    $or: [{ recordingUrl: { $nin: [null, ""] } }, { "attempts.recordingUrl": { $nin: [null, ""] } }],
  }).select({
    caseId: 1, domain: 1, recordingUrl: 1, callStartedAt: 1, durationSeconds: 1,
    lastAgentId: 1, lastOutcome: 1, leadSnapshot: 1, attempts: 1,
  }).lean();

  const out = [];
  for (const r of rows) {
    // ONE ROW PER ATTEMPT, not per day.
    //
    // Top-level `durationSeconds` is the LAST attempt's duration, not the day's
    // longest. On 2026-08-04 it topped out at 343s across 816 rows while
    // attempts[] held a 2,227-second call — so a significance filter reading the
    // summary field kept ZERO of 816 and dropped the one call anybody would
    // actually want. The email reads attempts for exactly this reason
    // (nightRecordingsService: "attempt.recordingUrl is the strong form").
    const attempts = Array.isArray(r.attempts) ? r.attempts : [];
    const withUrl = attempts.filter((a) => a?.recordingUrl);
    const source = withUrl.length
      ? withUrl.map((a, i) => ({
        idx: i,
        url: a.recordingUrl,
        dur: Number(a.durationSec ?? a.durationSeconds ?? 0),
        startedAt: a.startedAt || a.calledAt || r.callStartedAt || null,
        agent: a.agentId || a.agentName || r.lastAgentId || null,
        outcome: a.outcome || r.lastOutcome || null,
      }))
      // Fall back to the day-level link when attempts carry none.
      : [{
        idx: 0, url: r.recordingUrl, dur: Number(r.durationSeconds || 0),
        startedAt: r.callStartedAt || null, agent: r.lastAgentId || null,
        outcome: r.lastOutcome || null,
      }];

    for (const a of source) {
      if (!a.url) continue;
      out.push({
        provider: "phoneburner",
        // DailyDial carries no provider call id, so identity is case + day +
        // attempt. Including the attempt index is what stops two calls to one
        // case in a day collapsing onto each other through the unique index.
        providerCallId: `pb:${r.domain}:${r.caseId}:${dateKey}:${a.idx}`,
        domain: r.domain || null,
        dateKey,
        startedAt: a.startedAt,
        durationSec: a.dur,
        agentName: a.agent,
        agentId: a.agent,
        caseId: Number(r.caseId) || null,
        phone: r.leadSnapshot?.phone || null,
        sourceName: r.leadSnapshot?.sourceName || null,
        outcome: a.outcome,
        direction: "outbound",
        playbackUrl: a.url,
        providerRef: null,
        captureSource: "dailydial",
      });
    }
  }
  return out;
}

async function readCallRail(dateKey, { MarketingCallLink }) {
  const rows = await MarketingCallLink.find({ dateKey, listenUrl: { $nin: [null, ""] } })
    .select({
      callId: 1, domain: 1, listenUrl: 1, startedAt: 1, durationSec: 1,
      phone: 1, source: 1, callerName: 1, caseId: 1, answered: 1,
    }).lean();
  return rows.map((r) => ({
    provider: "callrail",
    providerCallId: String(r.callId),
    domain: r.domain || null,
    dateKey,
    startedAt: r.startedAt || null,
    durationSec: Number(r.durationSec || 0),
    agentName: null,
    agentId: null,
    caseId: Number(r.caseId) || null,
    phone: r.phone || null,
    sourceName: r.source || null,
    outcome: r.answered === false ? "missed" : null,
    direction: "inbound",
    playbackUrl: r.listenUrl,
    providerRef: null,
    captureSource: "marketingcalllink",
  }));
}

async function readCallLogProviders(dateKey, { CallLog }) {
  // Everything that is neither PhoneBurner-in-DailyDial nor CallRail-in-
  // MarketingCallLink: RingCentral ("ex") and the retired cx lane.
  const rows = await CallLog.find({
    callStartTime: pacificDayWindow(dateKey),
    $or: [
      { "recordingArchive.sourceUri": { $nin: [null, ""] } },
      { "recordingArchive.driveWebViewLink": { $nin: [null, ""] } },
    ],
  }).select({
    providerCallId: 1, telephonySessionId: 1, domain: 1, platform: 1, agentName: 1,
    providerAgentId: 1, caseId: 1, phone: 1, sourceName: 1, direction: 1, outcome: 1,
    callStartTime: 1, durationSec: 1, recordingArchive: 1,
  }).lean();

  const out = [];
  const unresolved = [];
  // Why RingCentral rows were passed over, counted rather than discarded — "we
  // indexed 40 of 300" needs to be explainable without re-running the query.
  const skipped = [];
  for (const r of rows) {
    const uri = r.recordingArchive?.sourceUri || r.recordingArchive?.driveWebViewLink || "";
    const provider = resolveProvider({
      archiveProvider: r.recordingArchive?.provider, uri, platform: r.platform,
    });
    if (!provider) { unresolved.push(r.providerCallId || r.telephonySessionId); continue; }

    // The `ex` rule, applied ONLY to RingCentral. A CallRail row that happens to
    // live in the ex bucket is still a CallRail row and keeps its own handling —
    // which is the whole reason provider is resolved before this runs.
    if (provider === "ringcentral") {
      const skip = exSkipReason(r);
      if (skip) { skipped.push(skip); continue; }
    }
    // RingCentral's stored value is an identifier, not a servable URL. Anything
    // else keeps its durable link.
    //
    // The one exception that makes RC servable TODAY: if the archiver already
    // pushed the audio to Drive, driveWebViewLink IS durable and needs no
    // minting. So an RC row can be either — durable when it was archived,
    // mint-on-read when only the provider reference survives.
    const isRc = provider === "ringcentral";
    const drive = r.recordingArchive?.driveWebViewLink || null;
    out.push({
      provider,
      providerCallId: String(r.providerCallId || r.telephonySessionId),
      domain: r.domain || null,
      dateKey,
      startedAt: r.callStartTime || null,
      durationSec: Number(r.durationSec || 0),
      agentName: r.agentName || null,
      agentId: r.providerAgentId || null,
      caseId: Number(r.caseId) || null,
      phone: r.phone || null,
      sourceName: r.sourceName || null,
      outcome: r.outcome || null,
      direction: r.direction || null,
      // Durable when an archived Drive copy exists — for ANY provider. Only a
      // RingCentral row with no Drive copy falls back to mint-on-read, because
      // only then is the raw provider URI the sole locator, and that URI is not
      // independently valid.
      playbackUrl: isRc ? drive : (drive || uri || null),
      providerRef: isRc && !drive ? (r.recordingArchive?.sourceUri || uri || null) : null,
      captureSource: "calllog",
    });
  }
  return { rows: out, unresolved, skipped };
}

/**
 * Gather every provider's recording links for one Pacific day and store them.
 *
 * @param {string}  dateKey  YYYY-MM-DD (Pacific)
 * @param {boolean} apply    false (default) = full dry run, nothing written
 */
async function gatherRecordingLinks({
  dateKey, apply = false, models = {}, logger = null, notableByPhone = new Map(),
  // Injected so a test can observe the attach without a snapshot, and so the
  // index stays usable standalone. Defaults to the real writer.
  attachCallFacts = require("./dailyReportFactService").attachDailyCallFacts,
} = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ""))) {
    throw new Error(`gatherRecordingLinks: bad dateKey ${dateKey}`);
  }
  const M = {
    DailyDial: models.DailyDial || require("../../shared-models/src").DailyDial,
    CallLog: models.CallLog || require("../../shared-models/src").CallLog,
    MarketingCallLink: models.MarketingCallLink
      || require("../../shared-models/src/MarketingCallLink"),
    Index: models.CallRecordingIndex || CallRecordingIndex,
  };

  // Each source is read independently so one provider being down does not cost
  // the others their day — the same rule the nightly pass follows.
  const perSource = {};
  const candidates = [];
  const errors = [];
  let unresolved = [];
  let exSkipped = [];

  for (const [name, read] of [
    ["phoneburner", () => readPhoneBurner(dateKey, M)],
    ["callrail", () => readCallRail(dateKey, M)],
    ["calllog", async () => {
      const r = await readCallLogProviders(dateKey, M);
      unresolved = r.unresolved;
      exSkipped = r.skipped;
      return r.rows;
    }],
  ]) {
    try {
      const rows = await read();
      perSource[name] = rows.length;
      candidates.push(...rows);
    } catch (error) {
      perSource[name] = null; // NULL is "could not look", never zero.
      errors.push(`${name}: ${String(error.message).slice(0, 140)}`);
      logger?.warn?.("recording_index.source_failed", { source: name, dateKey });
    }
  }

  // Exclusion and significance applied ONCE, to every source alike — the whole
  // reason the three readers feed a single pipeline instead of writing
  // themselves.
  for (const c of candidates) {
    Object.assign(c, exclusionFor([c.agentName, c.agentId]));
    c.significance = significanceFor(c, notableByPhone);
  }

  // EVERYTHING IS STORED. Mickey 2026-08-04: "the email is a refinement of the
  // highlights, but the database should have everything."
  //
  // So significance is a LABEL, not a gate. Every call with a link lands here;
  // the email asks for the highlights. Filtering at write time would have made
  // the missing calls unrecoverable — you cannot lower the bar retroactively on
  // rows you declined to keep, and the bar is explicitly "for this version of
  // things".
  const kept = candidates;

  const summary = {
    dateKey,
    apply,
    bySource: perSource,
    candidates: candidates.length,
    kept: kept.length,
    // How many carry at least one significance tag — the subset a highlights
    // view would show. Not a count of anything dropped; nothing is dropped.
    significant: kept.filter((c) => c.significance.length > 0).length,
    bySignificance: kept.reduce((acc, c) => {
      for (const r of c.significance) acc[r] = (acc[r] || 0) + 1;
      return acc;
    }, {}),
    excluded: kept.filter((c) => c.excluded).length,
    // Three buckets that must sum to `kept`, or a row is being hidden. An
    // earlier version counted durable as "has a url AND is not RingCentral",
    // which silently lost RC rows that DO have an archived Drive copy — they
    // were neither durable nor mint and appeared nowhere.
    durable: kept.filter((c) => c.playbackUrl).length,
    mintOnly: kept.filter((c) => !c.playbackUrl && c.providerRef).length,
    noLocator: kept.filter((c) => !c.playbackUrl && !c.providerRef).length,
    unresolvedProvider: unresolved.length,
    // RingCentral rows deliberately passed over, by reason. Reported so the
    // count is explainable — a silent filter and an empty day look identical.
    exSkipped: exSkipped.reduce((acc, r) => { acc[r] = (acc[r] || 0) + 1; return acc; }, {}),
    written: 0,
    errors,
  };

  // The day's call facts, as counts. This is the shape the snapshot has been
  // waiting on: `coverage.callProjection` sits at "pending" forever because
  // attachDailyCallFacts has never had a caller, which pins `coverage.complete`
  // to false on days that are otherwise perfectly good.
  //
  // Counts ONLY — no urls, no phones, no call rows. The fact sanitizer strips
  // those anyway, and the model documents the calls slot as a count-only
  // projection. What is useful in a stored day is "how many, of what kind",
  // not a copy of the index that already holds the detail.
  summary.callFacts = {
    links: kept.length,
    significant: summary.significant,
    byProvider: kept.reduce((acc, c) => { acc[c.provider] = (acc[c.provider] || 0) + 1; return acc; }, {}),
    bySignificance: summary.bySignificance,
    durable: summary.durable,
    mintOnRead: summary.mintOnly,
    excluded: summary.excluded,
    longestSec: kept.reduce((m, c) => Math.max(m, Number(c.durationSec || 0)), 0),
    totalTalkSec: kept.reduce((s, c) => s + Number(c.durationSec || 0), 0),
  };

  if (!apply) return summary;

  for (const c of kept) {
    try {
      await M.Index.updateOne(
        { provider: c.provider, providerCallId: c.providerCallId },
        { $set: { ...c, capturedAt: new Date() } },
        { upsert: true },
      );
      summary.written += 1;
    } catch (error) {
      summary.errors.push(`${c.provider}:${c.providerCallId}: ${String(error.message).slice(0, 100)}`);
    }
  }

  // ── Close the snapshot's open question ──────────────────────────────────
  //
  // The index has just finished counting the day's calls, so this is the
  // moment the snapshot's call projection can stop being "pending". Nothing
  // has ever called attachDailyCallFacts, which is why every stored day marks
  // itself incomplete however good its data is.
  //
  // Deliberately AFTER the writes: the counts describe what actually landed,
  // not what was planned. And deliberately non-fatal — the index is the
  // product here, and a missing snapshot must not fail the capture that
  // produced it. `missing-day` is the ordinary answer on a day whose report
  // has not run yet, not an error.
  if (attachCallFacts) {
    try {
      const r = await attachCallFacts({
        dateKey,
        callFacts: summary.callFacts,
        // A source we could not READ makes the projection unavailable, not
        // complete — a partial count must never be recorded as the whole day.
        status: errors.length ? "unavailable" : "complete",
      });
      summary.snapshot = r?.status || null;
    } catch (error) {
      summary.snapshot = "failed";
      summary.errors.push(`snapshot: ${String(error.message).slice(0, 120)}`);
      logger?.warn?.("recording_index.snapshot_attach_failed", { dateKey });
    }
  }

  return summary;
}

module.exports = {
  gatherRecordingLinks,
  resolveProvider,
  resolveProviderFromUri,
  exSkipReason,
  significanceFor,
  INDEX_LONG_CALL_SECONDS,
  PACIFIC,
};
