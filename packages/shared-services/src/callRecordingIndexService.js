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

/** Provider from evidence, never from `platform`. Null when unprovable. */
function resolveProviderFromUri(uri, platform) {
  const s = String(uri || "").toLowerCase();
  if (s.includes("callrail")) return "callrail";
  if (s.includes("phoneburner")) return "phoneburner";
  if (s.includes("ringcentral")) return "ringcentral";
  // No URI to judge by: only "cx" is unambiguous on its own. "ex" is the mixed
  // bucket and is exactly what must not be guessed.
  if (String(platform || "").toLowerCase() === "cx") return "ringcx";
  return null;
}

/** One row's worth of exclusion verdict, applied identically to every source. */
function exclusionFor(names = []) {
  const hit = findExcludedAgentMatch(names.filter(Boolean));
  return hit ? { excluded: true, excludedReason: `excluded-agent:${hit}` } : { excluded: false, excludedReason: null };
}

// ── READERS. Each returns normalized candidates; none writes. ───────────────

async function readPhoneBurner(dateKey, { DailyDial }) {
  const rows = await DailyDial.find({ dateKey, recordingUrl: { $nin: [null, ""] } })
    .select({
      caseId: 1, domain: 1, recordingUrl: 1, callStartedAt: 1, durationSeconds: 1,
      lastAgentId: 1, lastOutcome: 1, leadSnapshot: 1,
    }).lean();
  return rows.map((r) => ({
    provider: "phoneburner",
    // DailyDial is one row per case per day, so the case+day IS the call
    // identity here — there is no separate provider call id on it.
    providerCallId: `pb:${r.domain}:${r.caseId}:${dateKey}`,
    domain: r.domain || null,
    dateKey,
    startedAt: r.callStartedAt || null,
    durationSec: Number(r.durationSeconds || 0),
    agentName: r.lastAgentId || null,
    agentId: r.lastAgentId || null,
    caseId: Number(r.caseId) || null,
    phone: r.leadSnapshot?.phone || null,
    sourceName: r.leadSnapshot?.sourceName || null,
    outcome: r.lastOutcome || null,
    direction: "outbound",
    playbackUrl: r.recordingUrl,
    providerRef: null,
    captureSource: "dailydial",
  }));
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
  for (const r of rows) {
    const uri = r.recordingArchive?.sourceUri || r.recordingArchive?.driveWebViewLink || "";
    const provider = resolveProviderFromUri(uri, r.platform);
    if (!provider) { unresolved.push(r.providerCallId || r.telephonySessionId); continue; }
    // RingCentral's stored value is an identifier, not a servable URL. Anything
    // else keeps its durable link.
    const isRc = provider === "ringcentral";
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
      playbackUrl: isRc ? null : (r.recordingArchive?.driveWebViewLink || uri || null),
      providerRef: isRc ? (r.recordingArchive?.sourceUri || uri || null) : null,
      captureSource: "calllog",
    });
  }
  return { rows: out, unresolved };
}

/**
 * Gather every provider's recording links for one Pacific day and store them.
 *
 * @param {string}  dateKey  YYYY-MM-DD (Pacific)
 * @param {boolean} apply    false (default) = full dry run, nothing written
 */
async function gatherRecordingLinks({ dateKey, apply = false, models = {}, logger = null } = {}) {
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

  for (const [name, read] of [
    ["phoneburner", () => readPhoneBurner(dateKey, M)],
    ["callrail", () => readCallRail(dateKey, M)],
    ["calllog", async () => {
      const r = await readCallLogProviders(dateKey, M);
      unresolved = r.unresolved;
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

  // Exclusion applied ONCE, to every source alike.
  for (const c of candidates) {
    Object.assign(c, exclusionFor([c.agentName, c.agentId]));
  }

  const summary = {
    dateKey,
    apply,
    bySource: perSource,
    candidates: candidates.length,
    excluded: candidates.filter((c) => c.excluded).length,
    durable: candidates.filter((c) => c.playbackUrl && c.provider !== "ringcentral").length,
    mintOnly: candidates.filter((c) => !c.playbackUrl && c.providerRef).length,
    unresolvedProvider: unresolved.length,
    written: 0,
    errors,
  };

  if (!apply) return summary;

  for (const c of candidates) {
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
  return summary;
}

module.exports = {
  gatherRecordingLinks,
  resolveProviderFromUri,
  PACIFIC,
};
