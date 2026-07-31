"use strict";

// POST DATES THAT NEVER BECAME CLIENTS — and the calls behind them.
//
// A post-date is a PROMISE: the prospect committed to pay on a future day.
// So the only honest test of "did it turn into a client" is whether money
// ever actually arrived — not whether the status looks tidy. This walks a
// range of post-date status changes, checks each case's FULL payment
// history against Logics, and lists the ones with nothing.
//
//   node scripts/postdate-followup.js --from 2026-06-28 --to 2026-07-28
//   node scripts/postdate-followup.js --from 2026-06-28 --to 2026-07-28 --calls
//
// READ-ONLY. --calls adds the CallRail lookup + listen links (slower).

require("dotenv").config();

const { connectMongo } = require("../packages/event-core/src");
const { getSharedConfig } = require("../packages/shared-config/src");
const { createLogicsClient } = require("../packages/shared-integrations/src");
const { gatherActivityRange } = require("../packages/shared-services/src/liveGatherService");
const { unwrapLogics, mapLimit } = require("../packages/shared-services/src/paymentTruthService");
const { foldCasePhones } = require("../packages/shared-services/src/casePhoneFoldService");
const { createCallrailClient } = require("../packages/shared-integrations/src");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

const money = (n) => `$${(Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dayOf = (v) => String(v || "").slice(0, 10);

async function main() {
  const from = String(arg("from", "2026-06-28"));
  const to = String(arg("to", "2026-07-28"));
  const wantCalls = process.argv.includes("--calls");

  console.log(`\n${"═".repeat(72)}`);
  console.log(`  POST DATES · ${from} → ${to}`);
  console.log(`${"═".repeat(72)}\n`);

  await connectMongo(getSharedConfig());

  // 1 ── every post-date status change in the window. One activity call per
  //      domain covers the whole month (the report is range-native).
  const t0 = Date.now();
  const activity = await gatherActivityRange({
    from, to, logger: { info: (m) => console.log(`  ${m}`) },
  });
  const postdates = activity.events.filter(
    (e) => e.kind === "status-change" && e.payload?.safetyClass === "postdate" && !e.payload?.selfTransition,
  );
  console.log(`\n  ${activity.rows} activity rows → ${postdates.length} post-date event(s)`);

  // A case can be post-dated more than once; keep the FIRST in the window.
  const byCase = new Map();
  for (const e of postdates) {
    const key = `${e.domain}:${e.caseId}`;
    const at = dayOf(e.createdAt ? new Date(e.createdAt).toISOString() : null) || from;
    const prev = byCase.get(key);
    if (!prev || at < prev.postdatedOn) {
      byCase.set(key, {
        domain: e.domain, caseId: e.caseId, postdatedOn: at,
        toStatus: e.payload?.toStatus || null, by: e.createdBy || null,
        times: (prev?.times || 0) + 1,
      });
    } else if (prev) prev.times += 1;
  }
  const cases = [...byCase.values()];
  console.log(`  ${cases.length} distinct case(s) post-dated\n`);
  if (!cases.length) { console.log("  nothing to check.\n"); process.exit(0); }

  // 2 ── did money EVER arrive? Full history per case, straight from Billing.
  const clients = new Map(
    [...new Set(cases.map((c) => c.domain))].map((d) => [d, createLogicsClient(d)]),
  );
  const checked = await mapLimit(cases, 3, async (c) => {
    try {
      const rows = unwrapLogics(await clients.get(c.domain).getCasePayments(c.caseId)) || [];
      const paid = rows.filter((p) => String(p.TransactionStatus).toUpperCase() === "SUCCESS" && Number(p.Amount) > 0);
      const declined = rows.filter((p) => String(p.TransactionStatus).toUpperCase() === "DECLINED");
      const after = paid.filter((p) => dayOf(p.PaidDate) >= c.postdatedOn);
      return {
        ...c,
        everPaid: paid.length > 0,
        paidAfter: after.length > 0,
        firstPaidAfter: after.map((p) => dayOf(p.PaidDate)).sort()[0] || null,
        amountAfter: Math.round(after.reduce((s, p) => s + Number(p.Amount), 0) * 100) / 100,
        declinedCount: declined.length,
        declinedAmount: Math.round(declined.reduce((s, p) => s + Math.abs(Number(p.Amount)), 0) * 100) / 100,
      };
    } catch (error) {
      // A 404 from Billing means the case has NO payment records — which is
      // the whole point of this report, not a failure to look. Treating it
      // as "could not confirm" hid 21 of 51 cases behind a shrug.
      if (error?.details?.responseStatus === 404 || /: 404$/.test(String(error.message))) {
        return {
          ...c, everPaid: false, paidAfter: false, firstPaidAfter: null,
          amountAfter: 0, declinedCount: 0, declinedAmount: 0, noBillingRecord: true,
        };
      }
      return { ...c, error: String(error.message).slice(0, 90) };
    }
  });

  const converted = checked.filter((c) => c.paidAfter);
  const failed = checked.filter((c) => !c.paidAfter && !c.error);
  const unknown = checked.filter((c) => c.error);

  console.log(`${"─".repeat(72)}`);
  console.log(`  POST DATES CREATED   ${cases.length}`);
  console.log(`  became clients       ${converted.length}   ${money(converted.reduce((s, c) => s + c.amountAfter, 0))}`);
  console.log(`  never paid           ${failed.length}`);
  if (unknown.length) console.log(`  could not confirm    ${unknown.length}`);
  const rate = cases.length ? Math.round((converted.length / cases.length) * 1000) / 10 : null;
  console.log(`  conversion rate      ${rate}%`);
  console.log(`${"─".repeat(72)}\n`);

  // 3 ── the ones that never paid, with their calls.
  let callIndex = new Map();
  if (wantCalls && failed.length) {
    const cr = createCallrailClient("TAG");
    const days = [...new Set(failed.map((c) => c.postdatedOn))].sort();
    console.log(`  fetching calls for ${days.length} day(s)…\n`);
    for (const day of days) {
      try {
        const res = await cr.listInboundCallsForRange({ startDate: day, endDate: day });
        for (const call of res?.calls || []) {
          const digits = String(call.customer_phone_number || "").replace(/[^0-9]/g, "").slice(-10);
          if (!digits) continue;
          if (!callIndex.has(digits)) callIndex.set(digits, []);
          callIndex.get(digits).push(call);
        }
      } catch { /* a missing day must not sink the report */ }
    }
  }

  console.log("NEVER PAID");
  console.log("─".repeat(72));
  for (const c of failed.sort((a, b) => a.postdatedOn.localeCompare(b.postdatedOn))) {
    let name = null; let phones = [];
    try {
      const info = unwrapLogics(await clients.get(c.domain).getCaseInfo(c.caseId));
      name = `${info?.FirstName || ""} ${info?.LastName || ""}`.trim() || null;
      phones = foldCasePhones(info || {}).normalizedPhones;
    } catch { /* identity is a nicety here */ }

    console.log(`  ${c.postdatedOn}  ${c.domain} ${c.caseId}  ${(name || "?").slice(0, 26)}`);
    console.log(`      → ${c.toStatus || "post date"}${c.by ? ` (by ${c.by})` : ""}${c.times > 1 ? ` · post-dated ${c.times}x` : ""}`);
    if (c.declinedCount) console.log(`      ${c.declinedCount} declined attempt(s) · ${money(c.declinedAmount)} — the money was tried and failed`);
    else if (c.everPaid) console.log("      paid BEFORE the post date only — no money after");
    else if (c.noBillingRecord) console.log("      no billing record at all — never even set up to pay");
    else console.log("      no payment attempt on record at all");

    if (wantCalls) {
      const calls = phones.flatMap((p) => callIndex.get(p) || []);
      if (!calls.length) console.log("      (no CallRail call that day)");
      for (const call of calls.sort((a, b) => b.duration - a.duration).slice(0, 2)) {
        let url = null;
        try { url = (await createCallrailClient("TAG").getCallRecording(call.id))?.url || null; } catch { /* keep */ }
        console.log(`      ${Math.round(call.duration / 6) / 10}m · ${call.source_name || "?"} · ${url || "(no recording)"}`);
      }
    }
  }

  if (unknown.length) {
    console.log(`\nCOULD NOT CONFIRM (${unknown.length})`);
    for (const c of unknown) console.log(`  ${c.domain} ${c.caseId}: ${c.error}`);
  }
  console.log(`\ntotal ${Math.round((Date.now() - t0) / 1000)}s\n`);
  process.exit(0);
}

main().catch((e) => { console.error("postdate followup failed:", e.stack || e.message); process.exit(1); });
