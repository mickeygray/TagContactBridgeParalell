"use strict";

// MAIL PERFORMANCE BY AGENT — spend, closings and every long call, with audio.
//
//   node scripts/mail-agent-report.js --month                    (writes HTML)
//   node scripts/mail-agent-report.js --from 2026-07-01 --to 2026-07-30
//   node scripts/mail-agent-report.js --month --send owner@example.com
//   node scripts/mail-agent-report.js --month --out reports/mail.html
//
// WHY THIS IS NOT A REPORT BLOCK. It needs three things the block composer does
// not gather: the RingCentral extension roster, the settlement officer resolved
// from a case's assignment ACTIVITY, and CallRail recording links per call. It
// is a script so it can be run and checked by hand before it is ever scheduled.
//
// THE THREE RULES IT EXISTS TO KEEP (all learned the hard way on 2026-07-30):
//   · NO SOURCE FILTER on per-agent money. Filtering on payment.sourceAtSale —
//     blank on ~35% of cases — lost $10,258.80 of a $40,710.84 month. An agent
//     who works mail has mail money by definition; a filter can only subtract.
//   · ONE CASE, ONE AGENT. Crediting a case to every caller who reached it put
//     one case on two agents and inflated a month by $1,000.
//   · CHARGEBACKS NET THE CASH, NEVER THE DEAL, and land on recurring before
//     they can touch an initial.

require("dotenv").config();

// Escape hatch for a box whose resolver is wrong. A disconnected VPN can leave
// 127.0.0.1 as the only DNS server with nothing listening on it, which breaks
// the mongodb+srv lookup while ordinary hostnames still resolve. Opt-in only:
//   DNS_SERVERS=192.168.1.1,1.1.1.1 node scripts/mail-agent-report.js --month
if (process.env.DNS_SERVERS) {
  try { require("dns").setServers(process.env.DNS_SERVERS.split(",").map((s) => s.trim()).filter(Boolean)); }
  catch (error) { console.warn(`DNS_SERVERS ignored — ${error.message}`); }
}

const fs = require("fs");
const path = require("path");
const { connectMongo } = require("../packages/event-core/src");
const { getSharedConfig } = require("../packages/shared-config/src");
const {
  netChargebacks, claimOnce, balanceCheck, round2,
} = require("../packages/shared-services/src/reportMoneyGuards");

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return !v || v.startsWith("--") ? true : v;
};
const has = (name) => process.argv.includes(`--${name}`);

const usd = (n, d = 0) => "$" + Number(round2(n)).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const tel = (p) => (String(p).length === 10 ? `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}` : String(p));
const last10 = (p) => { const d = String(p || "").replace(/\D/g, ""); return d.length >= 10 ? d.slice(-10) : null; };
const pacificKey = (at = new Date()) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
}).format(at);

const LONG_MINUTES = Number(process.env.MAIL_REPORT_LONG_MINUTES) || 10;

async function main() {
  const today = pacificKey();
  const from = arg("from") || (has("month") ? `${today.slice(0, 7)}-01` : today);
  const to = arg("to") || today;
  const sendTo = arg("send");
  const outPath = arg("out") || `reports/mail-agent-${from}_${to}.html`;

  await connectMongo(getSharedConfig());
  const { gatherMaterial } = require("../packages/shared-services/src/reportComposerService");
  const { isActiveSource } = require("../packages/shared-config/src/activeSources");
  const { mapLimit, unwrapLogics } = require("../packages/shared-services/src/paymentTruthService");
  const { createLogicsClient, createRingCentralClient, createCallrailClient } = require("../packages/shared-integrations/src");
  const { AgentState } = require("../packages/shared-models/src");
  const CallLog = require("../packages/shared-models/src/CallLog");
  const MarketingCallLink = require("../packages/shared-models/src/MarketingCallLink");
  const notes = [];
  const say = (m) => console.log(m);

  // ── 1. who answers the phones ────────────────────────────────────────────
  // AgentState is the roster of record. RingCentral turns the dialable
  // extension into the internal id that CallLog actually stores; the two are
  // different numbers and joining on the wrong one silently attributes nothing.
  const roster = await AgentState.find({}).select("extensionId name company").lean();
  const nameOf = new Map(roster.filter((a) => a.extensionId && a.name).map((a) => [String(a.extensionId), a.name]));
  try {
    const rc = await createRingCentralClient("TAG").listExtensions();
    for (const r of (rc?.records || rc || [])) {
      const id = String(r.id || "");
      const nm = r.name || [r.contact?.firstName, r.contact?.lastName].filter(Boolean).join(" ");
      if (id && nm && !nameOf.has(id)) nameOf.set(id, nm);
    }
  } catch (error) {
    notes.push(`RingCentral extension list unavailable — ${String(error.message).slice(0, 80)}`);
  }
  // Extensions proven SHARED: they appear on every leg regardless of who
  // answered, so attributing them to a person is a coin flip. Measured
  // 2026-07-30: the busiest of them carried 485 calls and three different names.
  const SHARED = new Set(String(process.env.MAIL_REPORT_SHARED_EXTENSIONS || "63712730004,63751309004")
    .split(",").map((s) => s.trim()).filter(Boolean));
  say(`  roster: ${nameOf.size} extension(s) map to a person, ${SHARED.size} shared line(s) excluded`);

  // ── 2. the calls the mail produced ───────────────────────────────────────
  const cm = await gatherMaterial({ needs: ["callsRange"], from, to, domain: null, live: true });
  const calls = (cm.callsRange || [])
    .filter((c) => (!c.dateKey || (c.dateKey >= from && c.dateKey <= to)) && c.source && isActiveSource(c.source))
    .map((c) => ({
      callId: c.callId, dateKey: c.dateKey, source: c.source, phone: last10(c.phone),
      minutes: Math.round((Number(c.durationSec) || 0) / 6) / 10,
    }))
    .filter((c) => c.phone);
  const longCalls = calls.filter((c) => c.minutes >= LONG_MINUTES).sort((a, b) => b.minutes - a.minutes);
  say(`  ${calls.length} mail call(s), ${longCalls.length} over ${LONG_MINUTES} minutes`);

  // ── 3. whose case is each caller, and who owns that case ─────────────────
  const phones = [...new Set(longCalls.map((c) => c.phone))];
  const legs = await CallLog.find({ normalizedPhone: { $in: phones }, direction: "inbound" })
    .select("normalizedPhone extensionId durationSec").lean();
  const legAgent = new Map();
  const grouped = new Map();
  for (const l of legs) {
    const k = String(l.normalizedPhone);
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k).push(l);
  }
  for (const [k, g] of grouped) {
    g.sort((a, b) => (Number(b.durationSec) || 0) - (Number(a.durationSec) || 0));
    for (const l of g) {
      const id = String(l.extensionId || "");
      if (!id || SHARED.has(id)) continue;
      if (nameOf.has(id)) { legAgent.set(k, nameOf.get(id)); break; }
    }
  }

  const lc = createLogicsClient("TAG");
  const { caseIdsFrom, isNotFound } = require("../packages/shared-services/src/logicsSourceSanitizerService");
  const caseOf = new Map(); const statusOf = new Map(); const officerOf = new Map();
  await mapLimit(phones, 3, async (p) => {
    try {
      const ids = caseIdsFrom(await lc.findCaseByPhone(p));
      if (ids.length) caseOf.set(p, String(ids[0]));
    } catch (error) { if (!isNotFound(error)) notes.push(`case lookup failed for one caller`); }
  });
  await mapLimit([...new Set(caseOf.values())], 3, async (id) => {
    try {
      const info = unwrapLogics(await lc.getCaseInfo(id));
      if (info?.StatusName) statusOf.set(id, info.StatusName);
    } catch { /* one unreadable case must not cost the section */ }
    try {
      // The settlement officer is NOT a field on the case — it is an activity
      // whose subject reads "Assigned to Set. Officer: <name>". Latest wins.
      const acts = unwrapLogics(await lc.getActivities(id));
      const hit = (Array.isArray(acts) ? acts : [])
        .map((a) => ({ s: String(a?.Subject || a?.ActivitySubject || ""), at: a?.ActivityDate || a?.CreatedDate || null }))
        .filter((a) => /^Assigned to\s+Set\.?\s*Officer\s*:/i.test(a.s))
        .sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0))[0];
      const nm = hit ? hit.s.split(":").slice(1).join(":").trim() : null;
      if (nm && !/^--\s*Unassigned\s*--$/i.test(nm)) officerOf.set(id, nm);
    } catch { /* activities unreadable — leave the officer blank */ }
  });

  for (const c of longCalls) {
    c.caseId = caseOf.get(c.phone) || null;
    c.status = c.caseId ? statusOf.get(c.caseId) || null : null;
    c.agent = (c.caseId && officerOf.get(c.caseId)) || legAgent.get(c.phone) || null;
  }
  say(`  ${longCalls.filter((c) => c.agent).length} of ${longCalls.length} long call(s) traced to a person`);

  // ── 4. recording links ───────────────────────────────────────────────────
  const ids = longCalls.map((c) => String(c.callId));
  const pooled = await MarketingCallLink.find({ callId: { $in: ids } }).select("callId listenUrl").lean();
  const linkOf = new Map(pooled.map((p) => [String(p.callId), p.listenUrl]));
  const cr = createCallrailClient("TAG");
  for (const c of longCalls) {
    c.listen = linkOf.get(String(c.callId)) || null;
    if (c.listen) continue;
    try {
      const rec = await cr.getCallRecording(c.callId);
      c.listen = rec?.url || rec?.recording || rec?.player || null;
    } catch { c.listen = null; }
  }
  const noAudio = longCalls.filter((c) => !c.listen).length;
  if (noAudio) notes.push(`${noAudio} long call(s) have no recording link`);

  // ── 5. money, per agent, with each case claimed once ─────────────────────
  const pm = await gatherMaterial({ needs: ["payments", "spend"], from, to, domain: null, live: true });
  const paid = new Map();
  for (const p of (pm.payments || [])) {
    const k = String(p.caseId);
    if (!paid.has(k)) paid.set(k, { initial: 0, recurring: 0, chargeback: 0, officer: null });
    const x = paid.get(k);
    const amt = Number(p.amount) || 0;
    if (p.isChargeback) x.chargeback = round2(x.chargeback + Math.abs(amt));
    else if (p.paymentType === "initial") x.initial = round2(x.initial + amt);
    else x.recurring = round2(x.recurring + amt);
    if (!x.officer && p.officerAtSale) x.officer = p.officerAtSale;
  }
  // Officer, in order of authority: the payment, then the case's own
  // assignment activity. NO source filter — see the header.
  const owner = claimOnce([...paid.entries()].map(([caseId, v]) => ({ caseId, v })), {
    caseOf: (r) => r.caseId,
    ownerOf: (r) => r.v.officer || officerOf.get(r.caseId) || null,
    scoreOf: (r) => r.v.initial + r.v.recurring,
  });

  const byAgent = new Map();
  const bump = (name) => {
    if (!byAgent.has(name)) {
      byAgent.set(name, { agent: name, calls: 0, longCalls: 0, cases: 0, initial: 0, recurring: 0, chargeback: 0 });
    }
    return byAgent.get(name);
  };
  for (const [caseId, v] of paid) {
    const who = owner.get(caseId)?.owner || "(no officer)";
    const n = netChargebacks(v);
    const x = bump(who);
    x.cases += 1;
    x.initial = round2(x.initial + n.initialNet);
    x.recurring = round2(x.recurring + n.recurringNet);
    x.chargeback = round2(x.chargeback + v.chargeback);
  }
  for (const c of longCalls) if (c.agent) bump(c.agent).longCalls += 1;
  for (const [ext, name] of nameOf) {
    void ext;
    if (byAgent.has(name)) continue;
  }

  const rows = [...byAgent.values()].filter((r) => r.cases || r.longCalls)
    .sort((a, b) => b.initial - a.initial);
  const TI = round2(rows.reduce((s, r) => s + r.initial, 0));
  const TA = round2(rows.reduce((s, r) => s + r.initial + r.recurring, 0));

  // The parts must equal the whole, and the report says so if they do not.
  const wholeInitial = round2([...paid.values()].reduce((s, v) => s + netChargebacks(v).initialNet, 0));
  const imbalance = balanceCheck(rows.map((r) => r.initial), wholeInitial, "initials by agent");
  if (imbalance) notes.push(imbalance);

  const mailSpend = round2(Number(pm.spend?.mail) || 0);
  say(`  initials ${usd(TI, 2)} · all ${usd(TA, 2)} · mail spend ${usd(mailSpend, 2)}`);
  if (imbalance) say(`  !! ${imbalance}`);

  // ── 6. render ────────────────────────────────────────────────────────────
  const CSS = ["body{margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#15201c}",
    ".c{max-width:760px;background:#fff;border-radius:8px}",
    ".h{font-size:21px;font-weight:600;color:#0f172a}.s{font-size:13px;color:#6b7b74;padding-top:3px}",
    ".a{font-size:15px;font-weight:600;color:#0f172a;border-bottom:2px solid #0f172a;padding-bottom:5px}",
    ".m{font-size:12px;color:#6b7b74;padding:5px 0 8px}",
    "table.t{border-collapse:collapse;width:100%}",
    "table.t th{padding:7px 9px;border-bottom:1px solid #cfdad4;font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:#6b7b74;text-align:left;white-space:nowrap}",
    "table.t td{padding:7px 9px;border-bottom:1px solid #eef1ef;font-size:13.5px}",
    "table.t td.n,table.t th.n{text-align:right}table.t td.b{font-weight:600}",
    "table.t td.w{white-space:nowrap}table.t td.g{color:#9aa8a1}",
    "table.t tr.tot td{border-top:2px solid #cfdad4;border-bottom:none;font-weight:600}",
    ".note{font-size:11.5px;color:#94a3b8;line-height:1.5}"].join("");

  const agentRow = (r) => `<tr><td>${esc(r.agent)}</td><td class="n">${r.longCalls || "&mdash;"}</td>`
    + `<td class="n">${r.cases}</td><td class="n b">${usd(r.initial)}</td>`
    + `<td class="n">${usd(r.initial + r.recurring)}</td>`
    + `<td class="n${r.chargeback ? "" : " g"}">${r.chargeback ? "-" + usd(r.chargeback) : "&mdash;"}</td></tr>`;

  const callRow = (c) => `<tr><td class="n b">${c.minutes}</td><td>${esc(String(c.dateKey).slice(5))}</td>`
    + `<td class="w">${tel(c.phone)}</td><td>${c.caseId ? esc(c.caseId) : '<span class="g">no case</span>'}</td>`
    + `<td>${c.status ? esc(c.status) : "&mdash;"}</td>`
    + `<td class="w">${c.listen ? `<a href="${esc(c.listen)}" style="color:#0f6b4f;font-weight:600">&#9654; listen</a>` : '<span class="g">&mdash;</span>'}</td></tr>`;

  const groups = new Map();
  for (const c of longCalls) {
    const k = c.agent || "Not traced to a person";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  const order = [...groups.entries()].filter(([k]) => k !== "Not traced to a person")
    .sort((a, b) => b[1].length - a[1].length);
  if (groups.has("Not traced to a person")) order.push(["Not traced to a person", groups.get("Not traced to a person")]);

  const section = ([agent, list]) => `<tr><td style="padding:24px 22px 0"><div class="a">${esc(agent)}</div>`
    + `<div class="m">${list.length} call${list.length === 1 ? "" : "s"} &middot; `
    + `${Math.round(list.reduce((s, c) => s + c.minutes, 0))} minutes</div>`
    + '<table class="t" role="presentation" cellpadding="0" cellspacing="0">'
    + '<tr><th class="n">Min</th><th>Date</th><th>Phone</th><th>Case</th><th>Status now</th><th>Audio</th></tr>'
    + list.map(callRow).join("") + "</table></td></tr>";

  const title = `Mail by agent — ${from}${to !== from ? ` to ${to}` : ""}`;
  const html = '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<title>${esc(title)}</title><style>${CSS}</style></head><body>`
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:20px 10px">'
    + '<tr><td align="center"><table role="presentation" class="c" width="100%" cellpadding="0" cellspacing="0">'
    + `<tr><td style="padding:22px 22px 6px"><div class="h">${esc(title)}</div>`
    + `<div class="s">${usd(mailSpend)} mail spend &middot; ${calls.length} calls &middot; `
    + `${usd(TI)} initials</div></td></tr>`
    + '<tr><td style="padding:10px 22px 0"><table class="t" role="presentation" cellpadding="0" cellspacing="0">'
    + `<tr><th>Agent</th><th class="n">${LONG_MINUTES} min+</th><th class="n">Cases paid</th>`
    + '<th class="n">Initials</th><th class="n">All money</th><th class="n">Chargebacks</th></tr>'
    + rows.map(agentRow).join("")
    + `<tr class="tot"><td>Total</td><td class="n">${longCalls.length}</td>`
    + `<td class="n">${paid.size}</td><td class="n">${usd(TI)}</td><td class="n">${usd(TA)}</td>`
    + `<td class="n">${usd(round2(rows.reduce((s, r) => s + r.chargeback, 0)) * -1)}</td></tr>`
    + "</table></td></tr>"
    + `<tr><td style="padding:26px 22px 0"><div class="a">Calls over ${LONG_MINUTES} minutes</div></td></tr>`
    + order.map(section).join("")
    + '<tr><td style="padding:22px"><div class="note">'
    + "Cash is net of chargebacks; the deal count is not. Recording links open in CallRail. Internal."
    + (notes.length ? `<br><br>${notes.map(esc).join("<br>")}` : "")
    + "</div></td></tr></table></td></tr></table></body></html>";

  const kb = Math.round(html.length / 1024);
  if (kb > 100) notes.push(`email is ${kb} KB — Gmail clips at about 102 KB and will hide the tail`);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html);
  say(`  wrote ${outPath} (${kb} KB)`);

  if (sendTo && sendTo !== true) {
    const { sendMail } = require("../packages/shared-services/src/mailerService");
    const info = await sendMail("TAG", {
      to: String(sendTo).split(",").map((s) => s.trim()).filter(Boolean),
      from: process.env.MAIL_REPORT_FROM || undefined,
      subject: title,
      html,
      text: rows.map((r) => `${r.agent}: ${r.cases} cases, ${usd(r.initial)} initials, `
        + `${usd(r.initial + r.recurring)} all money`).join("\n"),
    });
    say(`  SENT to ${info.to}`);
  } else {
    say("  (not sent — pass --send <address> to mail it)");
  }
  for (const n of notes) say(`  note: ${n}`);
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(`mail-agent-report failed: ${error.message}`);
  console.error(error.stack.split("\n").slice(1, 3).join("\n"));
  process.exit(1);
});
