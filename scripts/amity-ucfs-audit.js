"use strict";

// AMITY UCFS LOAN AUDIT
//
// "how many amity clients have ucfs approved loans that do not also have a
//  tag equivalent case with a loan posted there. how many of them have one
//  loan instead of two. when was their last soft pull and what was it."
//
// Composed entirely from primitives already proven this session:
//   · range-native ActivityReport (one call per domain, any window)
//   · Billing/CasePayment for posted money (type 8 = Loan, 9 = Loan Offset)
//   · casePhoneFoldService for cross-tenant identity (spouse phones included)
//   · Find/FindCaseByPhone to reach the TAG equivalent case
//
// READ-ONLY.
//   node scripts/amity-ucfs-audit.js
//   node scripts/amity-ucfs-audit.js --from 2024-01-01 --json

require("dotenv").config();

const { connectMongo } = require("../packages/event-core/src");
const { getSharedConfig } = require("../packages/shared-config/src");
const { createLogicsClient } = require("../packages/shared-integrations/src");
const { unwrapLogics, mapLimit } = require("../packages/shared-services/src/paymentTruthService");
const { foldCasePhones } = require("../packages/shared-services/src/casePhoneFoldService");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

const money = (n) => `$${(Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (k) => { const [y, m, d] = String(k).split("-"); return `${m}/${d}/${y}`; };

// A posted loan on the Billing side. Type 8 = Loan, 9 = Loan Offset
// (live-pinned this session); the UCFS comment is the belt-and-braces.
// POSTED means the money landed. A declined loan attempt is not a posted
// loan — without the status check a failed attempt would inflate someone's
// loan count and move them from the "one loan" bucket to "two". Every row
// in the 2026-07-28 run happened to be SUCCESS, so the emailed CSV was
// correct, but by luck rather than by rule.
const isLoanPayment = (p) => {
  if (String(p.TransactionStatus || "").toUpperCase() !== "SUCCESS") return false;
  return Number(p.PaymentTypeID) === 8
    || Number(p.PaymentTypeID) === 9
    || /ucfs|loan/i.test(String(p.Comment || ""));
};

const UCFS_APPROVED = /ucfs\s+approved/i;
const UCFS_ANY = /ucfs|loan/i;
const SOFTPULL = /softpull|soft pull/i;
// Real subjects vary more than expected — all of these are live examples:
//   "iSoftpull TransUnion Score: 705 (Lisa)"   colon
//   "iSoftpull Transunion Score 646 (Russell)" NO colon
//   "Isoftpull Transunion (JOHN) 559"          score trails the name
//   "iSoftpull Equifax Score 719 (Donna)"      DIFFERENT BUREAU
const SCORE = /score\s*:?\s*([0-9]{1,3})\b|\)\s*([0-9]{3})\s*$|\b([0-9]{3})\s*$/i;
const BUREAU = /(transunion|equifax|experian)/i;

function parseSoftPull(subject) {
  const m = String(subject).match(SCORE);
  const raw = m ? (m[1] ?? m[2] ?? m[3]) : null;
  const score = raw != null ? Number(raw) : null;
  const bureau = (String(subject).match(BUREAU) || [])[1] || null;
  return {
    score: Number.isFinite(score) ? score : null,
    bureau: bureau ? bureau.charAt(0).toUpperCase() + bureau.slice(1).toLowerCase() : null,
  };
}
const ACCOUNT = /account\s*#?\s*([0-9]{5,})/i;
const AMOUNT = /\$\s*([0-9,]+)/;

const ROW_CAP = 50000;

function addDays(dateKey, n) {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function pullWindow(client, from, to) {
  const res = await client.requestActivityReport({
    StartDate: fmtDate(from), EndDate: fmtDate(to),
    ReportName: "ActivityReport",
    Email: process.env.LOGICS_REPORT_EMAIL || "mgray@taxadvocategroup.com",
  });
  const d = unwrapLogics(res);
  return Array.isArray(d) ? d : (d?.Data || []);
}

/**
 * The ActivityReport CAPS AT 50,000 ROWS and truncates SILENTLY — proven:
 * a single 19-month TAG pull returns exactly 50,000, and so does each half,
 * summing to 100,000. A capped window is not an answer, it is a partial one
 * wearing an answer's clothes.
 *
 * So: walk the range in slices, and RECURSIVELY HALVE any slice that comes
 * back at the cap until every window is under it. Dedupe on the immutable
 * (case, subject, Created) triple, the same key the event parser uses.
 */
async function pullActivity(domain, from, to, { sliceDays = 90, logger = console } = {}) {
  const client = createLogicsClient(domain);
  const seen = new Set();
  const rows = [];
  let windows = 0;
  let stillCapped = 0;

  async function take(a, b, depth = 0) {
    const batch = await pullWindow(client, a, b);
    windows += 1;
    if (batch.length >= ROW_CAP && depth < 6 && a !== b) {
      // Split and retry — a capped window hides an unknown remainder.
      const mid = addDays(a, Math.max(1, Math.floor((Date.parse(b) - Date.parse(a)) / 86400000 / 2)));
      await take(a, mid, depth + 1);
      await take(addDays(mid, 1), b, depth + 1);
      return;
    }
    if (batch.length >= ROW_CAP) stillCapped += 1;
    for (const r of batch) {
      const key = `${r.CaseID}|${r.ActivitySubject}|${r.Created}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(r);
    }
  }

  let cursor = from;
  while (cursor <= to) {
    const end = addDays(cursor, sliceDays - 1) > to ? to : addDays(cursor, sliceDays - 1);
    await take(cursor, end);
    cursor = addDays(end, 1);
  }
  logger.log?.(`  ${domain}: ${rows.length} unique rows across ${windows} window(s)${stillCapped ? `  ⚠ ${stillCapped} still capped` : ""}`);
  return { rows, capped: stillCapped > 0, windows };
}

async function main() {
  const from = String(arg("from", "2024-01-01"));
  const to = String(arg("to", new Date().toISOString().slice(0, 10)));

  console.log(`\n${"═".repeat(74)}`);
  console.log(`  AMITY UCFS LOAN AUDIT · ${from} → ${to}`);
  console.log(`${"═".repeat(74)}\n`);

  await connectMongo(getSharedConfig());

  // 1 ── AMITY activity: who was approved, and every soft pull.
  const amity = await pullActivity("AMITY", from, to);
  if (amity.capped) console.log("  ⚠ some windows still capped — narrow --slice-days");

  const approvedByCase = new Map();
  const softByCase = new Map();
  for (const r of amity.rows) {
    const caseId = Number(r.CaseID);
    if (!caseId) continue;
    const subject = String(r.ActivitySubject || "");
    if (UCFS_APPROVED.test(subject)) {
      const list = approvedByCase.get(caseId) || [];
      list.push({
        at: r.Created, subject: subject.slice(0, 120),
        amount: (subject.match(AMOUNT) || [])[1] ? Number((subject.match(AMOUNT))[1].replace(/,/g, "")) : null,
        account: (subject.match(ACCOUNT) || [])[1] || null,
        by: r.CreatedBy || null,
      });
      approvedByCase.set(caseId, list);
    }
    // A row filed under a softpull activity TYPE is not automatically a soft
    // pull — one UCFS approval was logged under that type and would have
    // been reported as this client's latest credit check. The SUBJECT has
    // to actually look like a pull.
    const looksLikePull = SOFTPULL.test(subject) || BUREAU.test(subject);
    if (looksLikePull && !UCFS_APPROVED.test(subject)) {
      const { score, bureau } = parseSoftPull(subject);
      const list = softByCase.get(caseId) || [];
      list.push({ at: r.Created, score, bureau, subject: subject.slice(0, 90) });
      softByCase.set(caseId, list);
    }
  }
  console.log(`  UCFS approvals: ${[...approvedByCase.values()].flat().length} event(s) across ${approvedByCase.size} AMITY case(s)`);
  console.log(`  soft pulls:     ${[...softByCase.values()].flat().length} across ${softByCase.size} case(s)\n`);

  // 2 ── per approved case: identity, AMITY posted loans, TAG equivalent.
  const amityClient = createLogicsClient("AMITY");
  const tagClient = createLogicsClient("TAG");

  const results = await mapLimit([...approvedByCase.keys()], 3, async (caseId) => {
    const out = {
      caseId, approvals: approvedByCase.get(caseId),
      name: null, phones: [], status: null,
      amityLoans: [], tagCaseId: null, tagLoans: [], tagMatchedBy: null,
      lastSoft: null, error: null,
    };
    try {
      const info = unwrapLogics(await amityClient.getCaseInfo(caseId));
      out.name = `${info?.FirstName || ""} ${info?.LastName || ""}`.trim() || null;
      out.status = info?.StatusName || null;
      out.phones = foldCasePhones(info || {}).normalizedPhones;
    } catch (e) { out.error = String(e.message).slice(0, 70); }

    // AMITY posted loans
    try {
      const rows = unwrapLogics(await amityClient.getCasePayments(caseId)) || [];
      out.amityLoans = (Array.isArray(rows) ? rows : []).filter(isLoanPayment).map((p) => ({
        id: p.CasePaymentID, amount: Number(p.Amount), paidOn: String(p.PaidDate).slice(0, 10),
        type: p.PaymentTypeName || p.PaymentTypeID, status: p.TransactionStatus,
      }));
    } catch (e) { if (!/404/.test(String(e.message))) out.error = out.error || String(e.message).slice(0, 70); }

    // TAG equivalent, found by any folded phone (spouse included)
    for (const phone of out.phones) {
      try {
        const found = unwrapLogics(await tagClient.findCaseByPhone(phone));
        const id = Number(found?.CaseID ?? found?.caseId ?? (Array.isArray(found) ? found[0]?.CaseID : null));
        if (Number.isFinite(id) && id > 0) { out.tagCaseId = id; out.tagMatchedBy = phone; break; }
      } catch { /* 404 = no TAG case on that number */ }
    }
    if (out.tagCaseId) {
      try {
        const rows = unwrapLogics(await tagClient.getCasePayments(out.tagCaseId)) || [];
        out.tagLoans = (Array.isArray(rows) ? rows : []).filter(isLoanPayment).map((p) => ({
          id: p.CasePaymentID, amount: Number(p.Amount), paidOn: String(p.PaidDate).slice(0, 10),
          type: p.PaymentTypeName || p.PaymentTypeID, status: p.TransactionStatus,
        }));
      } catch { /* 404 = no billing on the TAG case */ }
    }

    const softs = (softByCase.get(caseId) || [])
      .slice().sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    out.lastSoft = softs[0] || null;
    return out;
  });

  // 3 ── the answers
  const noTagLoan = results.filter((r) => r.tagLoans.length === 0);
  const withTagLoan = results.filter((r) => r.tagLoans.length > 0);
  const oneLoan = noTagLoan.filter((r) => r.amityLoans.length === 1);
  const twoPlus = noTagLoan.filter((r) => r.amityLoans.length >= 2);
  const zeroPosted = noTagLoan.filter((r) => r.amityLoans.length === 0);

  console.log("─".repeat(74));
  console.log(`  AMITY cases with a UCFS APPROVAL        ${results.length}`);
  console.log(`    …that also have a TAG case with a loan  ${withTagLoan.length}`);
  console.log(`    …with NO TAG loan posted               ${noTagLoan.length}   ← the ask`);
  console.log("");
  console.log(`  Of those ${noTagLoan.length}, posted loans on the AMITY case:`);
  console.log(`    exactly one                            ${oneLoan.length}`);
  console.log(`    two or more                            ${twoPlus.length}`);
  console.log(`    approved but nothing posted            ${zeroPosted.length}`);
  console.log("─".repeat(74));

  console.log("\nNO TAG LOAN — detail\n");
  for (const r of noTagLoan.sort((a, b) => (b.approvals[0]?.at || "").localeCompare(a.approvals[0]?.at || ""))) {
    const a = r.approvals[0];
    console.log(`  AMITY ${r.caseId}  ${(r.name || "?").slice(0, 26).padEnd(28)}${r.status || ""}`);
    console.log(`    approved: ${a?.subject || "?"}`);
    if (r.approvals.length > 1) console.log(`              (+${r.approvals.length - 1} more approval event(s))`);
    console.log(`    posted loans on AMITY: ${r.amityLoans.length}${r.amityLoans.map((l) => ` · ${money(l.amount)} ${l.paidOn} ${l.status}`).join("")}`);
    console.log(`    TAG case: ${r.tagCaseId ? `${r.tagCaseId} (matched ${r.tagMatchedBy}) — no loan posted` : "none found by phone"}`);
    console.log(`    last soft pull: ${r.lastSoft ? `${String(r.lastSoft.at).slice(0, 19)}  ${r.lastSoft.bureau || "?"} ${r.lastSoft.score ?? "?"}` : "none on record"}`);
    console.log("");
  }

  // ── CSV + email ────────────────────────────────────────────────────────
  // ONE ROW PER LOAN so a spreadsheet can sort and sum. A case with two
  // loans gets two rows (loan_number 1 and 2); a case approved but never
  // funded still gets ONE row with empty loan cells — dropping it would
  // hide the six cases that matter most.
  if (process.argv.includes("--csv") || process.argv.includes("--email")) {
    const NEWLINE = String.fromCharCode(10);
    const QUOTE = String.fromCharCode(34);
    const cell = (v) => {
      if (v == null) return "";
      const t = String(v);
      const needs = t.includes(",") || t.includes(QUOTE) || t.includes(NEWLINE);
      return needs ? QUOTE + t.split(QUOTE).join(QUOTE + QUOTE) + QUOTE : t;
    };
    // "1/7/2025 8:51:31 PM" → 2025-01-07, so dates sort as dates.
    const isoDay = (v) => {
      const t = Date.parse(v);
      return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : "";
    };

    const columns = [
      "case_id", "name", "status",
      "loan_number", "loan_date", "loan_amount", "loan_status",
      "soft_pull_date", "soft_pull_score", "soft_pull_bureau",
      "tag_case_id",
    ];
    const lines = [columns.join(",")];
    for (const r of noTagLoan.sort((a, b) => (a.name || "").localeCompare(b.name || ""))) {
      const soft = r.lastSoft || {};
      const base = [r.caseId, r.name, r.status];
      const tail = [isoDay(soft.at), soft.score ?? "", soft.bureau ?? "", r.tagCaseId ?? ""];
      if (!r.amityLoans.length) {
        lines.push([...base, "", "", "", "", ...tail].map(cell).join(","));
        continue;
      }
      const loans = r.amityLoans.slice().sort((a, b) => String(a.paidOn).localeCompare(b.paidOn));
      loans.forEach((l, i) => {
        lines.push([...base, i + 1, l.paidOn, l.amount, l.status, ...tail].map(cell).join(","));
      });
    }
    const csv = lines.join(NEWLINE) + NEWLINE;

    const fs = require("fs");
    const path = require("path");
    const { ROOT_DIR } = require("../packages/shared-config/src");
    const outDir = path.join(ROOT_DIR, "runtime", "reports");
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `amity-ucfs-no-tag-loan-${to}.csv`);
    fs.writeFileSync(file, csv);
    console.log(`
wrote ${file}  (${lines.length - 1} row(s))`);

    if (process.argv.includes("--email")) {
      const { sendMail } = require("../packages/shared-services/src/mailerService");
      const { getInternalFromEmail } = require("../packages/shared-config/src");
      const fromEmail = getInternalFromEmail();
      const oneLoan = noTagLoan.filter((x) => x.amityLoans.length === 1).length;
      const twoPlus = noTagLoan.filter((x) => x.amityLoans.length >= 2).length;
      const none = noTagLoan.filter((x) => !x.amityLoans.length).length;
      const hasTagCase = noTagLoan.filter((x) => x.tagCaseId).length;
      const text = [
        `AMITY clients with a UCFS approved loan and NO loan posted on a TAG case.`,
        `Window ${from} to ${to}.`,
        "",
        `${results.length} AMITY cases have a UCFS approval.`,
        `  ${results.length - noTagLoan.length} also have a TAG case with a loan posted.`,
        `  ${noTagLoan.length} do not — those are attached.`,
        "",
        `Of the ${noTagLoan.length}:`,
        `  ${oneLoan} have exactly one loan posted on AMITY`,
        `  ${twoPlus} have two or more`,
        `  ${none} were approved but nothing was ever posted`,
        "",
        `  ${hasTagCase} have a TAG case that exists but carries no loan`,
        `  ${noTagLoan.length - hasTagCase} have no TAG case found at all`,
        "",
        `CSV is one row per posted loan, so a client with two loans appears twice`,
        `(loan_number 1 and 2). Cases approved with nothing posted appear once`,
        `with empty loan cells. Soft pull is the most recent on record.`,
      ].join(NEWLINE);

      const res = await sendMail("TAG", {
        to: String(arg("to-addr", process.env.REPORT_RECIPIENTS || "mgray@taxadvocategroup.com")),
        subject: `AMITY UCFS approved, no TAG loan — ${noTagLoan.length} clients`,
        text,
        attachments: [{ filename: path.basename(file), content: csv, contentType: "text/csv" }],
        from: `Parallel Reports <${fromEmail}>`,
        replyTo: `Parallel Reports <${fromEmail}>`,
        transportDomain: "TAG",
      });
      console.log(`emailed (messageId ${res?.messageId || "?"})`);
    }
  }

  if (process.argv.includes("--json")) {
    require("fs").writeFileSync("runtime/reports/amity-ucfs-audit.json", JSON.stringify({ from, to, results }, null, 1));
    console.log("wrote runtime/reports/amity-ucfs-audit.json");
  }
  process.exit(0);
}

main().catch((e) => { console.error("audit failed:", e.stack || e.message); process.exit(1); });
