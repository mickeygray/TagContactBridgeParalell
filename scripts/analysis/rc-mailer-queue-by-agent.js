"use strict";

/**
 * rc-mailer-queue-by-agent — who answered the mailer calls, from RingCentral.
 *
 * Mickey 2026-08-05 described the routing: "they call an 800 number (in
 * RingCentral), that 800 number rings a local number in CallRail (tracking),
 * that tracking number rings the mailer queue (ext 500 forwards to agent)."
 *
 * That is why every earlier attempt failed. The call LEAVES RingCentral to
 * CallRail and RE-ENTERS at ext 500, so RC never indexes it under the caller's
 * number — a per-number pull returned zero for all 570 callers AND for the
 * tracking numbers. The queue is the key, not the phone.
 *
 * Ext 500 = id 63712730004, type Department, name "Mailer". It was invisible
 * earlier only because listExtensions defaults to type=User; the account has 139
 * extensions, 82 of them Departments.
 *
 * PACING: one client, one auth, reused. perPage 100 means ~10-20 requests for a
 * month rather than 570, and the delay follows RC's own rate-limit headers.
 *
 *   node scripts/analysis/rc-mailer-queue-by-agent.js [from] [to]
 */

require("dotenv").config({ quiet: true });
if (process.env.DNS_SERVERS) {
  require("dns").setServers(String(process.env.DNS_SERVERS).split(",").map((s) => s.trim()));
}

const path = require("path");
const { createRingCentralClient } = require(path.join(__dirname, "../../packages/shared-integrations/src/ringcentralClient"));

const MAILER_EXT_ID = "63712730004";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The queue itself, menus and voicemail are not the agent who took the call.
const NOT_AN_AGENT = /^(mailer|customer service|sales|support|main|reception|operator|voicemail|queue|ivr|announcement)/i;
// One human, several extensions: "Bruce Allen - TAG", "Bruce Allen-Wynn".
const norm = (n) => String(n).replace(/\s*[-–]\s*(TAG|WYNN|AMITY)\s*$/i, "").replace(/\s+/g, " ").trim();

/** The agent a queue call was forwarded to, or null if nobody took it. */
function answeringAgent(record) {
  const legs = Array.isArray(record?.legs) && record.legs.length ? record.legs : [record];
  for (const leg of legs) {
    if (leg?.result !== "Accepted" && leg?.result !== "Call connected") continue;
    // The forward lands ON an agent extension, so `to` is the answerer.
    for (const side of ["to", "from"]) {
      const s = leg?.[side];
      if (!s?.name || NOT_AN_AGENT.test(s.name)) continue;
      if (!s.extensionId && !s.extensionNumber) continue;
      return norm(s.name);
    }
  }
  return null;
}

async function main() {
  const from = process.argv[2] || "2026-07-01";
  const to = process.argv[3] || "2026-08-01";
  const rc = createRingCentralClient();

  const records = [];
  let page = 1;
  let delayMs = 3000;
  for (;;) {
    let res;
    for (let attempt = 1; ; attempt += 1) {
      try {
        res = await rc.getExtensionCallLog(MAILER_EXT_ID, {
          dateFrom: `${from}T00:00:00.000Z`,
          dateTo: `${to}T00:00:00.000Z`,
          view: "Detailed",
          direction: "Inbound",
          perPage: 100,
          page,
        });
        break;
      } catch (error) {
        const status = error?.status || error?.response?.status;
        if (status === 429 && attempt <= 5) {
          const wait = Math.min(60000, 5000 * attempt * attempt);
          console.log(`    429 on page ${page} — backing off ${Math.round(wait / 1000)}s`);
          await sleep(wait);
          delayMs = Math.min(15000, delayMs * 2);
          continue;
        }
        throw error;
      }
    }
    const batch = res?.records || [];
    records.push(...batch);
    console.log(`    page ${page}: ${batch.length} record(s)   running total ${records.length}`);
    if (batch.length < 100) break;
    page += 1;
    await sleep(delayMs);
  }

  console.log(`\n  MAILER QUEUE (ext 500), ${from} .. ${to}: ${records.length} inbound call(s)`);

  const per = new Map();
  let answered = 0;
  let missed = 0;
  const callers = new Set();
  for (const r of records) {
    const caller = String(r.from?.phoneNumber || "").replace(/\D/g, "").slice(-10);
    if (caller) callers.add(caller);
    const agent = answeringAgent(r);
    if (!agent) { missed += 1; continue; }
    answered += 1;
    if (!per.has(agent)) per.set(agent, { calls: 0, callers: new Set() });
    per.get(agent).calls += 1;
    if (caller) per.get(agent).callers.add(caller);
  }

  console.log(`  answered by a named agent: ${answered}    no agent leg (missed/abandoned): ${missed}`);
  console.log(`  distinct callers: ${callers.size}`);

  console.log("\n  AGENT                calls   unique callers");
  for (const [a, v] of [...per.entries()].sort((x, y) => y[1].callers.size - x[1].callers.size)) {
    console.log("  " + a.padEnd(21) + String(v.calls).padStart(5) + String(v.callers.size).padStart(16));
  }
}

// Only when RUN, never when required. Without this guard, importing the helpers
// re-ran the whole paged pull and immediately earned a 429 — the exact rate-limit
// failure the pacing exists to avoid.
if (require.main === module) {
  main().catch((e) => { console.error("FAILED " + e.message); process.exitCode = 1; });
}

// ── intersect mode ──────────────────────────────────────────────────────────
// Exported so the queue pull can be restricted to the 570 unique PAID-PIECE
// callers. Mickey 2026-08-05: the queue's 838 is "non unique, some unpaid for" —
// it answers WHO TOOK the call, never how many leads we bought.
module.exports = { answeringAgent, MAILER_EXT_ID, norm, NOT_AN_AGENT };
