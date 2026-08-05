"use strict";

/**
 * july-callrail-to-agent-to-payment
 *
 * Mickey 2026-08-05: "break those unique leads in callrail by agents who touched
 * them as best you can and then tie those payments to them."
 *
 * Inputs (all supplied by Mickey, all read-only):
 *   Call List-2026-08-05.xlsx        unique CallRail calls
 *   PaymentsReport_*110526.csv       WYNN initial payments
 *   PaymentsReport_*110615.csv       TAG initial payments
 *
 * THE JOIN IS BY PHONE, and that is not a choice — a CallRail call carries no
 * case id. The chain is:
 *
 *   CallRail call --phone--> case --touches--> agent --caseId--> payment
 *
 * Every hop can fail, and each failure is COUNTED rather than dropped. A call
 * whose phone matches no case is not "an agent handled zero" — it is a call we
 * could not tie, and the difference is the whole reason this exists as a
 * cross-check rather than a report.
 */

require("dotenv").config({ quiet: true });
if (process.env.DNS_SERVERS) {
  require("dns").setServers(String(process.env.DNS_SERVERS).split(",").map((s) => s.trim()));
}

const path = require("path");
const { readSheet } = require("./xlsxSheet");
const { readText, parseCsv, toObjects } = require("./logicsPaymentsCsv");
const { connectMongo, disconnectMongo } = require(path.join(__dirname, "../../packages/event-core/src"));
const { getSharedConfig } = require(path.join(__dirname, "../../packages/shared-config/src"));
const M = require(path.join(__dirname, "../../packages/shared-models/src"));

const XLSX_DIR = path.join(__dirname, "../../.tmp_xlsx");
const PAY_FILES = [
  ["WYNN", "C:/Users/micke/Downloads/PaymentsReport_20260805110526.csv"],
  ["TAG", "C:/Users/micke/Downloads/PaymentsReport_20260805110615.csv"],
];

const last10 = (p) => String(p || "").replace(/\D/g, "").slice(-10);
const money = (s) => Number(String(s).replace(/[$,]/g, "")) || 0;
const pad = (s, n) => String(s).padEnd(n);

/** Excel serial -> YYYY-MM-DD. Epoch is 1899-12-30 for the 1900 system. */
function excelDate(serial) {
  const n = Number(serial);
  if (!Number.isFinite(n)) return null;
  return new Date(Math.round((n - 25569) * 86400000)).toISOString().slice(0, 10);
}

async function main() {
  await connectMongo(getSharedConfig());

  // ── 1. the calls ──────────────────────────────────────────────────────────
  const rows = readSheet(XLSX_DIR, "sheet2.xml");
  const header = rows[0].map((h) => String(h).trim());
  const col = (name) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const iStatus = col("Call Status"); const iPiece = col("Number Name");
  const iStart = col("Start Time"); const iDur = col("Duration (seconds)");
  const iName = col("Name"); const iPhone = col("Phone Number");
  const iFirst = col("First-Time Caller"); const iRec = col("Recording Url");

  const calls = rows.slice(1)
    .filter((r) => r[iPhone])
    .map((r) => ({
      status: r[iStatus], piece: r[iPiece], dateKey: excelDate(r[iStart]),
      durationSec: Number(r[iDur]) || 0, name: r[iName],
      phone: last10(r[iPhone]), firstTime: String(r[iFirst]) === "1",
      recordingUrl: r[iRec] || null,
    }));

  const uniquePhones = [...new Set(calls.map((c) => c.phone).filter(Boolean))];
  console.log(`\nCALLRAIL: ${calls.length} calls, ${uniquePhones.length} unique phones`);
  const july = calls.filter((c) => c.dateKey >= "2026-07-01" && c.dateKey <= "2026-07-31");
  console.log(`  in July: ${july.length}   answered: ${july.filter((c) => /answer/i.test(c.status)).length}`
    + `   first-time: ${july.filter((c) => c.firstTime).length}`
    + `   with a recording: ${july.filter((c) => c.recordingUrl).length}`);
  const byPiece = {};
  for (const c of july) byPiece[c.piece || "(none)"] = (byPiece[c.piece || "(none)"] || 0) + 1;
  console.log("  by piece: " + Object.entries(byPiece).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`).join("  "));

  // ── 2. phone -> case ──────────────────────────────────────────────────────
  //
  // CallLog.normalizedPhone, NOT CaseProfile.normalizedPhones. The profile phone
  // index covers only 20,547 of 111,200 cases (18%), and these callers are mail
  // respondents who are largely not in it — joining through it tied 1 of 570.
  // CallLog records the call itself and ties 1,367 rows over the same phones.
  const callLogs = await M.CallLog.find({ normalizedPhone: { $in: uniquePhones } })
    .select("domain caseId normalizedPhone agentName platform callStartTime").lean();

  const caseByPhone = new Map();
  for (const l of callLogs) {
    if (l.caseId == null || l.caseId === 0) continue;
    if (!caseByPhone.has(l.normalizedPhone)) caseByPhone.set(l.normalizedPhone, []);
    const list = caseByPhone.get(l.normalizedPhone);
    if (!list.some((x) => String(x.caseId) === String(l.caseId))) {
      list.push({ domain: l.domain, caseId: l.caseId });
    }
  }
  const tied = uniquePhones.filter((p) => caseByPhone.has(p));
  console.log(`\nPHONE -> CASE (via CallLog): ${tied.length} of ${uniquePhones.length} phones tie to a case`
    + `  (${uniquePhones.length - tied.length} untied)`);

  // ── 3. case -> agents who touched it ──────────────────────────────────────
  const allCases = [...new Set([...caseByPhone.values()].flat().map((c) => String(c.caseId)))];
  const dials = await M.DailyDial.find({ caseId: { $in: allCases } })
    .select("caseId domain lastAgentId dateKey attempts").lean();
  // OUTBOUND platforms only. On an inbound `ex` row, agentName holds the CALLER
  // ("Mailer - TIA HARPER VELA"), not one of ours — counting those would invent
  // agents out of customer names.
  const logs = await M.CallLog.find({
    caseId: { $in: allCases.map(Number) },
    platform: { $in: ["phoneburner", "cx"] },
  }).select("caseId domain agentName callStartTime platform").lean();

  const agentsByCase = new Map();
  const addAgent = (caseId, agent) => {
    if (!agent) return;
    const k = String(caseId);
    if (!agentsByCase.has(k)) agentsByCase.set(k, new Set());
    agentsByCase.get(k).add(String(agent));
  };
  for (const d of dials) addAgent(d.caseId, d.lastAgentId);
  for (const l of logs) addAgent(l.caseId, l.agentName);

  // ── 4. the payments ───────────────────────────────────────────────────────
  const payments = [];
  for (const [domain, f] of PAY_FILES) {
    for (const o of toObjects(parseCsv(readText(f)))) {
      if (!/^\d+$/.test(o["Case ID"] || "")) continue;
      payments.push({
        domain, caseId: String(o["Case ID"]), amount: money(o.Amount),
        officer: o["Settlement Officer"] || "(none)", source: o["Source Name"] || null,
      });
    }
  }
  console.log(`\nPAYMENTS: ${payments.length} initials, $${payments.reduce((s, p) => s + p.amount, 0).toFixed(2)}`);

  // ── 5. the join ───────────────────────────────────────────────────────────
  const perAgent = new Map();
  const bump = (agent, field, n = 1) => {
    if (!perAgent.has(agent)) perAgent.set(agent, { leads: new Set(), deals: new Set(), money: 0, calls: 0 });
    const a = perAgent.get(agent);
    if (field === "money") a.money += n; else if (field === "calls") a.calls += n;
  };

  let callsTied = 0;
  let callsNoCase = 0;
  let callsNoAgent = 0;
  for (const c of july) {
    const cases = caseByPhone.get(c.phone) || [];
    if (!cases.length) { callsNoCase += 1; continue; }
    callsTied += 1;
    let sawAgent = false;
    for (const cs of cases) {
      const agents = agentsByCase.get(String(cs.caseId));
      if (!agents) continue;
      sawAgent = true;
      for (const a of agents) {
        bump(a, "calls");
        perAgent.get(a).leads.add(`${cs.domain}:${cs.caseId}`);
      }
    }
    if (!sawAgent) callsNoAgent += 1;
  }

  // Tie payments through the same case set.
  const paidByCase = new Map(payments.map((p) => [String(p.caseId), p]));
  for (const [caseId, agents] of agentsByCase) {
    const pay = paidByCase.get(caseId);
    if (!pay) continue;
    for (const a of agents) {
      bump(a, "money", pay.amount / agents.size);
      perAgent.get(a).deals.add(caseId);
    }
  }

  console.log(`\nCALL -> CASE -> AGENT: ${callsTied} tied to a case, `
    + `${callsNoAgent} of those had NO agent touch, ${callsNoCase} tied to no case at all`);

  console.log("\nPER AGENT (CallRail-sourced leads only)");
  console.log("  " + pad("agent", 18) + pad("calls", 7) + pad("leads", 7) + pad("deals", 7) + "money");
  const sorted = [...perAgent.entries()].sort((a, b) => b[1].money - a[1].money);
  for (const [agent, a] of sorted) {
    console.log("  " + pad(agent, 18) + pad(a.calls, 7) + pad(a.leads.size, 7)
      + pad(a.deals.size, 7) + "$" + a.money.toFixed(2));
  }

  // Deals in the payment files that NO CallRail call explains.
  const callrailCases = new Set([...caseByPhone.values()].flat().map((c) => String(c.caseId)));
  const unexplained = payments.filter((p) => !callrailCases.has(String(p.caseId)));
  console.log(`\nDEALS WITH NO CALLRAIL CALL BEHIND THEM: ${unexplained.length}`
    + `  ($${unexplained.reduce((s, p) => s + p.amount, 0).toFixed(2)})`);
  const bySrc = {};
  for (const p of unexplained) bySrc[p.source || "(none)"] = (bySrc[p.source || "(none)"] || 0) + 1;
  console.log("  by source: " + Object.entries(bySrc).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`).join("  "));

  await disconnectMongo();
}

main().catch((e) => { console.error("FAILED " + e.message); process.exitCode = 1; });
