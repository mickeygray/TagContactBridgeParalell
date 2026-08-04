"use strict";

/**
 * call-links-coverage-probe — for ONE day, how many calls exist per provider and
 * how many of them we could actually hand somebody a playable link to.
 *
 * READ ONLY. Writes nothing, fetches nothing, mints nothing.
 *
 * The question this answers is not "how many recordings are there" but "how many
 * could we SERVE". Those differ per provider and that difference is the whole
 * design problem:
 *
 *   CallRail     durable public URL — serves HTTP 200 audio unauthenticated
 *   PhoneBurner  durable URL on www.phoneburner.com
 *   RingCentral  401s. The stored value is an IDENTIFIER, and a playable URL has
 *                to be minted per request through the signed forwarder, because
 *                a URL with a token baked in dies when the token rotates.
 *
 * A row counted as "has a recording" that cannot be served is worse than a row
 * with none — it reads as coverage we do not have.
 *
 *   node scripts/call-links-coverage-probe.js [YYYY-MM-DD]
 */

require("dotenv").config({ quiet: true });
if (process.env.DNS_SERVERS) {
  require("dns").setServers(String(process.env.DNS_SERVERS).split(",").map((s) => s.trim()));
}

const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
const { getSharedConfig } = require("../packages/shared-config/src");
const { CallLog, DailyDial } = require("../packages/shared-models/src");
const MarketingCallLink = require("../packages/shared-models/src/MarketingCallLink");

const PACIFIC = "America/Los_Angeles";
const pad = (s, n) => String(s).padEnd(n);
const num = (n) => String(n).padStart(7);

const pacificYesterday = () => new Intl.DateTimeFormat("en-CA", {
  timeZone: PACIFIC, year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date(Date.now() - 86400000));

const dayWindow = (dateKey) => {
  // Pacific day boundaries, expressed in UTC. Deliberately not a string prefix
  // match: stored timestamps are UTC and a naive prefix silently shifts the day
  // by up to eight hours.
  const start = new Date(`${dateKey}T00:00:00-07:00`);
  const end = new Date(start.getTime() + 86400000);
  return { $gte: start, $lt: end };
};

async function main() {
  const dateKey = process.argv[2] || pacificYesterday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw new Error(`bad date ${dateKey}`);
  await connectMongo(getSharedConfig());
  const window = dayWindow(dateKey);

  console.log(`\nCALL LINK COVERAGE — ${dateKey} (Pacific)\n`);

  // ── CallLog, split by platform ────────────────────────────────────────────
  // The time field is `callStartTime`. An earlier version of this probe matched
  // on `startedAt`, which does not exist on the document, and reported ZERO
  // calls for a day with thousands — a guessed field name reads exactly like a
  // quiet day.
  const byPlatform = await CallLog.aggregate([
    { $match: { callStartTime: window } },
    {
      $group: {
        _id: { platform: "$platform", provider: "$provider" },
        calls: { $sum: 1 },
        withArchive: { $sum: { $cond: [{ $ifNull: ["$recordingArchive.driveWebViewLink", false] }, 1, 0] } },
        withSourceUri: { $sum: { $cond: [{ $ifNull: ["$recordingArchive.sourceUri", false] }, 1, 0] } },
      },
    },
    { $sort: { calls: -1 } },
  ]);

  console.log("CallLog");
  console.log("  " + pad("platform", 12) + pad("provider", 13) + num("calls") + num("archived") + num("srcUri"));
  if (!byPlatform.length) console.log("  (no rows)");
  for (const r of byPlatform) {
    console.log("  " + pad(r._id.platform || "(none)", 12) + pad(r._id.provider || "(none)", 13)
      + num(r.calls) + num(r.withArchive) + num(r.withSourceUri));
  }

  // ── PhoneBurner, via DailyDial ────────────────────────────────────────────
  // DailyDial keys on a Pacific `dateKey` STRING, not a timestamp, and holds the
  // link at top level as `recordingUrl`.
  const dialTotal = await DailyDial.countDocuments({ dateKey });
  const dialWithRef = await DailyDial.countDocuments({
    dateKey, recordingUrl: { $nin: [null, ""] },
  });
  console.log("\nDailyDial (PhoneBurner)");
  console.log("  " + pad("dials", 28) + num(dialTotal));
  console.log("  " + pad("with a recording reference", 28) + num(dialWithRef));

  // ── CallRail, via MarketingCallLink ───────────────────────────────────────
  const mclTotal = await MarketingCallLink.countDocuments({ dateKey });
  const mclWithUrl = await MarketingCallLink.countDocuments({ dateKey, listenUrl: { $ne: null } });
  console.log("\nMarketingCallLink (CallRail)");
  console.log("  " + pad("rows captured", 28) + num(mclTotal));
  console.log("  " + pad("with a listen URL", 28) + num(mclWithUrl));

  // ── The gap, stated plainly ───────────────────────────────────────────────
  const rcRows = byPlatform.filter((r) => /ringcentral|^rc$/i.test(r._id.platform || r._id.provider || ""));
  const rcCalls = rcRows.reduce((a, r) => a + r.calls, 0);
  const rcWithUri = rcRows.reduce((a, r) => a + r.withSourceUri, 0);
  console.log("\nSERVABLE TODAY");
  console.log("  CallRail      " + mclWithUrl + " — durable public URL, nothing to do");
  console.log("  PhoneBurner   " + dialWithRef + " — durable URL, promotion gate already allows the host");
  console.log("  RingCentral   " + rcWithUri + " of " + rcCalls
    + " calls — identifier only; a playable URL must be MINTED per request");
  console.log("\n  A RingCentral row is not servable by storing its URL. The stored");
  console.log("  value is an id, and the link is signed at read time through the");
  console.log("  existing forwarder. Counting these as 'has a link' overstates");
  console.log("  coverage by exactly this number.\n");

  await disconnectMongo();
}

main().catch((e) => { console.error("FAILED " + e.message); process.exitCode = 1; });
