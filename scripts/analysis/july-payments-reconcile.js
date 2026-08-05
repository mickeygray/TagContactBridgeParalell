"use strict";
require("dotenv").config({ quiet: true });
require("dns").setServers(["8.8.8.8"]);
const path = require("path");
const { readText, parseCsv, toObjects } = require("./logicsPaymentsCsv");

const { connectMongo, disconnectMongo } = require(path.join(__dirname, "../../packages/event-core/src"));
const { getSharedConfig } = require(path.join(__dirname, "../../packages/shared-config/src"));
const M = require(path.join(__dirname, "../../packages/shared-models/src"));

const money = (s) => Number(String(s).replace(/[$,]/g, "")) || 0;
const dateKeyOf = (s) => {
  const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${String(m[1]).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}`;
};

(async () => {
  await connectMongo(getSharedConfig());

  const files = [
    ["WYNN", "C:/Users/micke/Downloads/PaymentsReport_20260805110526.csv"],
    ["TAG", "C:/Users/micke/Downloads/PaymentsReport_20260805110615.csv"],
  ];

  const theirs = [];
  for (const [domain, f] of files) {
    for (const o of toObjects(parseCsv(readText(f)))) {
      if (!/^\d+$/.test(o["Case ID"] || "")) continue;
      theirs.push({
        domain,
        caseId: Number(o["Case ID"]),
        amount: money(o.Amount),
        officer: o["Settlement Officer"] || null,
        source: o["Source Name"] || null,
        dateKey: dateKeyOf(o["Transaction Time"]),
        status: o["Payment Status"],
        type: o["Payment Type"],
      });
    }
  }

  const days = theirs.map((t) => t.dateKey).filter(Boolean).sort();
  console.log(`  THEIR FILES: ${theirs.length} rows, $${theirs.reduce((s, t) => s + t.amount, 0).toFixed(2)}`);
  console.log(`    date range: ${days[0]} .. ${days[days.length - 1]}`);
  const statuses = {};
  for (const t of theirs) statuses[t.status] = (statuses[t.status] || 0) + 1;
  console.log(`    statuses: ${Object.entries(statuses).map(([k, v]) => `${k}=${v}`).join("  ")}`);

  // Mine, same window, same definition.
  const from = days[0];
  const to = days[days.length - 1];
  const mine = await M.PaymentTruth.find({
    paymentDateKey: { $gte: from, $lte: to },
    paymentType: "initial",
    isChargeback: { $ne: true },
  }).select("domain caseId amount officerAtSale paymentDateKey").lean();
  console.log(`\n  MINE (PaymentTruth ${from}..${to}, initial, no chargebacks): ${mine.length} rows, `
    + `$${mine.reduce((s, m) => s + Number(m.amount || 0), 0).toFixed(2)}`);

  const keyOf = (d, c) => `${String(d).toUpperCase()}:${Number(c)}`;
  const mineSet = new Map(mine.map((m) => [keyOf(m.domain, m.caseId), m]));
  const theirSet = new Map(theirs.map((t) => [keyOf(t.domain, t.caseId), t]));

  const missingFromMine = theirs.filter((t) => !mineSet.has(keyOf(t.domain, t.caseId)));
  const extraInMine = mine.filter((m) => !theirSet.has(keyOf(m.domain, m.caseId)));

  console.log(`\n  IN THEIR FILE, NOT IN MINE: ${missingFromMine.length}`
    + `  ($${missingFromMine.reduce((s, t) => s + t.amount, 0).toFixed(2)})`);
  for (const t of missingFromMine) {
    console.log(`    ${t.dateKey}  ${t.domain.padEnd(5)} ${String(t.caseId).padEnd(8)}`
      + `$${t.amount.toFixed(2).padStart(9)}  ${String(t.officer || "-").padEnd(13)} ${t.source || ""}`);
  }

  console.log(`\n  IN MINE, NOT IN THEIRS: ${extraInMine.length}`
    + `  ($${extraInMine.reduce((s, m) => s + Number(m.amount || 0), 0).toFixed(2)})`);
  for (const m of extraInMine.slice(0, 20)) {
    console.log(`    ${m.paymentDateKey}  ${String(m.domain).padEnd(5)} ${String(m.caseId).padEnd(8)}`
      + `$${Number(m.amount).toFixed(2).padStart(9)}  ${m.officerAtSale || "-"}`);
  }

  // Amount disagreements on cases BOTH have.
  const bothDiffer = [];
  for (const [k, t] of theirSet) {
    const m = mineSet.get(k);
    if (m && Math.abs(Number(m.amount) - t.amount) > 0.005) bothDiffer.push({ k, theirs: t.amount, mine: Number(m.amount) });
  }
  console.log(`\n  SAME CASE, DIFFERENT AMOUNT: ${bothDiffer.length}`);
  for (const b of bothDiffer) console.log(`    ${b.k}  theirs $${b.theirs}  mine $${b.mine}`);

  await disconnectMongo();
})().catch((e) => { console.error("FAILED " + e.message); process.exitCode = 1; });
