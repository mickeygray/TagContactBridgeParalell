"use strict";

/**
 * rc-callers-by-agent — FRESH pull from RingCentral, one number at a time.
 *
 * Mickey 2026-08-05: "do a pacing fresh from rc, one number at a time pull."
 *
 * For each CallRail phone we ask RingCentral's account call-log who answered,
 * rather than inferring it from anything we already stored. Detailed view gives
 * the legs; the leg that was Accepted by an internal extension names the agent.
 *
 * ── PACING, AND WHY IT IS NOT OPTIONAL ──────────────────────────────────────
 *
 * The client caches its token (tokenState, reused until 60s before expiry), so
 * this authenticates ONCE. Re-authing per request is the documented way to earn
 * a hundred thousand 429s in thirty seconds, and it is the single rule this
 * script exists to respect.
 *
 * Account-level call-log is a HEAVY endpoint. We read RC's own X-Rate-Limit
 * headers after each call and sleep to stay inside the advertised window rather
 * than guessing a delay — and back off hard on a 429 instead of retrying into it.
 *
 * Resumable: results append to a JSON file after every number, so a stop at
 * number 300 does not cost the first 299.
 *
 *   node scripts/analysis/rc-callers-by-agent.js [limit]
 */

require("dotenv").config({ quiet: true });
if (process.env.DNS_SERVERS) {
  require("dns").setServers(String(process.env.DNS_SERVERS).split(",").map((s) => s.trim()));
}

const fs = require("fs");
const path = require("path");
const { readSheet } = require("./xlsxSheet");
const { createRingCentralClient } = require(path.join(__dirname, "../../packages/shared-integrations/src/ringcentralClient"));

const OUT = path.join(__dirname, "../../.rc-callers.json");
const XLSX_DIR = path.join(__dirname, "../../.tmp_xlsx2");
const FROM = "2026-07-01T00:00:00.000Z";
const TO = "2026-08-01T00:00:00.000Z";

const last10 = (p) => String(p || "").replace(/\D/g, "").slice(-10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Queues, menus and tracking extensions are not people.
const QUEUE = /^(customer service|sales|support|main|reception|operator|voicemail|queue|ivr|urgent|3rd day|affordab|mailer|test|fax|park)/i;
const norm = (n) => String(n).replace(/\s*[-–]\s*(TAG|WYNN|AMITY)\s*$/i, "").replace(/\s+/g, " ").trim();

/** Agent names on any leg an internal extension actually accepted. */
function agentsFromRecord(rec) {
  const out = new Set();
  const legs = Array.isArray(rec?.legs) && rec.legs.length ? rec.legs : [rec];
  for (const leg of legs) {
    if (leg?.result !== "Accepted" && leg?.result !== "Call connected") continue;
    for (const side of ["to", "from"]) {
      const s = leg?.[side];
      if (!s?.extensionId || !s?.name || QUEUE.test(s.name)) continue;
      out.add(norm(s.name));
    }
  }
  return [...out];
}

async function main() {
  const limit = Number(process.argv[2]) || 0;

  const rows = readSheet(XLSX_DIR, "sheet2.xml");
  const h = rows[0].map((x) => String(x).trim());
  const iPhone = h.indexOf("Phone Number");
  const iPiece = h.indexOf("Number Name");
  const calls = rows.slice(1).filter((r) => r[iPhone])
    .map((r) => ({ phone: last10(r[iPhone]), piece: r[iPiece] }));
  const phones = [...new Set(calls.map((c) => c.phone))].filter(Boolean);
  const pieceByPhone = new Map(calls.map((c) => [c.phone, c.piece]));

  const done = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : {};
  const todo = phones.filter((p) => !(p in done));
  const work = limit ? todo.slice(0, limit) : todo;
  console.log(`  phones: ${phones.length}   already done: ${Object.keys(done).length}   this run: ${work.length}`);
  if (!work.length) { report(done, pieceByPhone); return; }

  // ONE client, ONE auth, reused for every number.
  const rc = createRingCentralClient();
  let delayMs = 6500; // ~9/min, under the usual Heavy allowance until told otherwise.
  let n = 0;

  for (const phone of work) {
    n += 1;
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        const res = await rc.getAccountCallLog({
          phoneNumber: phone,
          dateFrom: FROM,
          dateTo: TO,
          view: "Detailed",
          perPage: 100,
          withRecording: false,
        });
        const records = res?.records || res?.data?.records || [];
        const agents = [...new Set(records.flatMap(agentsFromRecord))];
        done[phone] = { agents, records: records.length };

        // Follow RC's own headers rather than a guessed delay.
        const remaining = Number(res?.headers?.["x-rate-limit-remaining"]);
        const window = Number(res?.headers?.["x-rate-limit-window"]);
        if (Number.isFinite(remaining) && Number.isFinite(window) && remaining > 0) {
          delayMs = Math.max(1200, Math.ceil((window * 1000) / Math.max(remaining, 1)));
        }
        break;
      } catch (error) {
        const status = error?.status || error?.response?.status;
        if (status === 429 && attempt <= 5) {
          const wait = Math.min(60000, 5000 * attempt * attempt);
          console.log(`    429 on ${phone} — backing off ${Math.round(wait / 1000)}s`);
          await sleep(wait);
          delayMs = Math.min(15000, delayMs * 2);
          continue;
        }
        done[phone] = { agents: [], records: 0, error: String(error.message || error).slice(0, 120) };
        break;
      }
    }
    fs.writeFileSync(OUT, JSON.stringify(done));
    if (n % 10 === 0 || n === work.length) {
      console.log(`    ${n}/${work.length}   delay ${delayMs}ms   tied so far: `
        + `${Object.values(done).filter((d) => d.agents?.length).length}`);
    }
    await sleep(delayMs);
  }
  report(done, pieceByPhone);
}

function report(done, pieceByPhone) {
  const entries = Object.entries(done);
  const tied = entries.filter(([, d]) => d.agents?.length);
  const errored = entries.filter(([, d]) => d.error);
  console.log(`\n  RESULT: ${tied.length} of ${entries.length} pulled numbers tie to a named agent`
    + `   (${errored.length} errored)`);
  const per = {};
  for (const [phone, d] of tied) {
    for (const a of d.agents) {
      per[a] = per[a] || { phones: new Set(), pieces: {} };
      per[a].phones.add(phone);
      const pc = pieceByPhone.get(phone) || "(none)";
      per[a].pieces[pc] = (per[a].pieces[pc] || 0) + 1;
    }
  }
  console.log("\n  AGENT                leads   cost@$78.89");
  for (const [a, v] of Object.entries(per).sort((x, y) => y[1].phones.size - x[1].phones.size)) {
    console.log("  " + a.padEnd(21) + String(v.phones.size).padStart(5)
      + "   $" + (v.phones.size * 78.89).toFixed(2).padStart(9));
  }
}

main().catch((e) => { console.error("FAILED " + e.message); process.exitCode = 1; });
