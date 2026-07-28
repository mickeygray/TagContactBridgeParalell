"use strict";

// REPORT BLOCKS — the tickable calculations.
//
// Mickey 2026-07-28: "this is the kind of thing where its like i want to
// click a box and include this calculation in the email / csv is the idea."
//
// So a report is not a fixed thing you pick from a menu. It is a SELECTION
// of calculations, a date range, and an output. Tick "money", "by source"
// and "client since", get those three in an email; tick one and get one.
//
// ── WHY BLOCKS DECLARE `needs` ──────────────────────────────────────────
// Every block says which raw material it requires. The composer takes the
// union across the selection and gathers ONCE — so picking five blocks that
// all read payments costs exactly one gather, not five. Without that, a
// picker quietly multiplies API cost by the number of boxes ticked.
//
// Live by default, per the faceplate thesis: blocks read from the
// authoritative services, not from a stats table.

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const money = (n) => `$${(Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (n) => (n == null ? "—" : `${n}%`);

// ── the catalog ─────────────────────────────────────────────────────────
// id · label · needs · compute · renderText · csv
const NEWLINE = String.fromCharCode(10);

const LAG_REASON = Object.freeze({
  "no-phone-on-file": "(no phone on file)",
  "no-callrail-match": "(CallRail didn't see it)",
  "callrail-is-tag-only": "(not a CallRail tenant)",
});

const BLOCKS = [
  {
    id: "money",
    label: "Money in",
    hint: "Cash collected, split new vs recurring, with deal count",
    needs: ["payments"],
    compute({ payments }) {
      const ok = payments.filter((p) => !p.isChargeback);
      const initial = ok.filter((p) => p.paymentType === "initial");
      const recurring = ok.filter((p) => p.paymentType !== "initial");
      const cb = payments.filter((p) => p.isChargeback);
      return {
        cash: round2(ok.reduce((s, p) => s + p.amount, 0)),
        payments: ok.length,
        // A SALE, not a payment row. Case 394513 took its first invoice as two
        // $500 installments on the same day; counting rows called that two
        // deals. Doctrine: deals count SALES.
        deals: new Set(initial.map((p) => `${p.domain}:${p.caseId}`)).size,
        newCash: round2(initial.reduce((s, p) => s + p.amount, 0)),
        recurringCash: round2(recurring.reduce((s, p) => s + p.amount, 0)),
        chargebacks: cb.length,
        chargebackAmount: round2(cb.reduce((s, p) => s + Math.abs(p.amount), 0)),
      };
    },
    renderText(d) {
      return [
        `Money in            ${money(d.cash)}  (${d.payments} payments)`,
        `  new business      ${money(d.newCash)}  · ${d.deals} deal(s)`,
        `  recurring         ${money(d.recurringCash)}`,
        d.chargebacks ? `  chargebacks       ${d.chargebacks} · ${money(d.chargebackAmount)}` : null,
      ].filter(Boolean).join("\n");
    },
    csv(d) {
      return {
        rows: [d],
        columns: [
          { header: "cash", get: (x) => x.cash },
          { header: "payments", get: (x) => x.payments },
          { header: "deals", get: (x) => x.deals },
          { header: "new_cash", get: (x) => x.newCash },
          { header: "recurring_cash", get: (x) => x.recurringCash },
          { header: "chargebacks", get: (x) => x.chargebacks },
          { header: "chargeback_amount", get: (x) => x.chargebackAmount },
        ],
      };
    },
  },

  {
    id: "spend",
    label: "Spend",
    hint: "LD, mail and BCD cost for the window",
    needs: ["spend"],
    compute({ spend }) { return spend; },
    renderText(d) {
      return [
        `Spend               ${money(d.total)}`,
        `  LD                ${money(d.ld)}  · ${d.ldLeads} lead(s)`,
        `  mail              ${money(d.mail)}  · ${d.mailPieces} piece(s)`,
        d.bcdCalls ? `  BCD               ${money(d.bcd)}  · ${d.bcdCalls} call(s) x ${money(d.bcdRate)}` : null,
      ].filter(Boolean).join("\n");
    },
    csv(d) {
      return {
        rows: [d],
        columns: [
          { header: "total_spend", get: (x) => x.total },
          { header: "ld_spend", get: (x) => x.ld },
          { header: "ld_leads", get: (x) => x.ldLeads },
          { header: "mail_spend", get: (x) => x.mail },
          { header: "mail_pieces", get: (x) => x.mailPieces },
          { header: "bcd_spend", get: (x) => x.bcd },
          { header: "bcd_calls", get: (x) => x.bcdCalls },
        ],
      };
    },
  },

  {
    id: "net",
    label: "Net / ROI",
    hint: "Cash minus spend, and return on spend",
    needs: ["payments", "spend"],
    compute({ payments, spend }) {
      const cash = round2(payments.filter((p) => !p.isChargeback).reduce((s, p) => s + p.amount, 0));
      const total = spend.total || 0;
      return { cash, spend: total, net: round2(cash - total), roi: total > 0 ? round2(((cash - total) / total) * 100) : null };
    },
    renderText(d) {
      return `Net                 ${money(d.net)}   (${money(d.cash)} in − ${money(d.spend)} spend${d.roi != null ? ` · ${pct(d.roi)} ROI` : ""})`;
    },
    csv(d) {
      return { rows: [d], columns: [
        { header: "cash", get: (x) => x.cash }, { header: "spend", get: (x) => x.spend },
        { header: "net", get: (x) => x.net }, { header: "roi_pct", get: (x) => x.roi },
      ] };
    },
  },

  {
    id: "source",
    label: "By source",
    hint: "Deals, cash, spend and cost-per for each active source",
    // caseContacts is what reads SourceCampaignID off the Logics case. Without
    // it this block only sees stored snapshots and reports attributed deals as
    // "(unsourced)" — 34 of 39 over July 2026.
    needs: ["payments", "spend", "calls", "caseContacts"],
    compute({ payments, spendBySource, callsBySource }) {
      const { canonicalSourceName } = require("./logicsSourceWriterService");
      const by = new Map();
      const row = (k) => {
        if (!by.has(k)) by.set(k, { source: k, deals: 0, dealCases: new Set(), newCash: 0, recurringCash: 0, spend: 0, responses: 0, leads: 0 });
        return by.get(k);
      };
      for (const p of payments.filter((x) => !x.isChargeback)) {
        const r = row(canonicalSourceName(p.domain, p.sourceAtSale)
          || (p.sourceOrigin === "catch-all"
            ? (p.catchAllLabel ? `${p.catchAllLabel} (catch-all)` : "(Logics catch-all)")
            : "(unsourced)"));
        if (p.paymentType === "initial") {
          r.dealCases.add(`${p.domain}:${p.caseId}`);
          r.deals = r.dealCases.size;                     // sales, not payment rows
          r.newCash = round2(r.newCash + p.amount);
        }
        else r.recurringCash = round2(r.recurringCash + p.amount);
      }
      // Spend and CallRail responses arrive under their own spellings of the
      // same piece; fold them onto the same row or the money and the calls
      // never meet and every cost-per reads as "—".
      for (const [src, v] of Object.entries(spendBySource || {})) {
        const r = row(canonicalSourceName("TAG", src) || src);
        r.spend = round2(r.spend + v.spend); r.leads += v.leads || 0;
      }
      for (const [src, v] of Object.entries(callsBySource || {})) {
        const r = row(canonicalSourceName("TAG", src) || src);
        r.responses += v.responses || 0;
      }
      return [...by.values()].map(({ dealCases, ...r }) => {
        const totalCash = round2(r.newCash + r.recurringCash);
        const denom = r.responses || r.leads || 0;
        return { ...r, totalCash, costPer: denom > 0 && r.spend > 0 ? round2(r.spend / denom) : null, net: round2(totalCash - r.spend) };
      })
        // A row that is zero in EVERY column is noise, not a finding. Spend
        // with no deals is kept — that is a source failing to convert, which
        // is exactly what the board is for.
        .filter((r) => r.deals || r.totalCash || r.spend || r.responses || r.leads)
        .sort((a, b) => b.newCash - a.newCash || b.spend - a.spend);
    },
    renderText(rows) {
      // TOTAL $ as well as NEW $: a source carrying only recurring money was
      // rendering as an empty row, which reads as "this piece made nothing"
      // when it is really "this piece made nothing NEW". "what money made and
      // where from" means all of it.
      const L = ["By source".padEnd(34) + "DEALS".padStart(6) + "NEW $".padStart(13) + "TOTAL $".padStart(13) + "SPEND".padStart(12) + "RESP".padStart(6) + "COST EA".padStart(10)];
      L.push("-".repeat(94));
      for (const r of rows) {
        L.push(String(r.source).slice(0, 33).padEnd(34) + String(r.deals).padStart(6)
          + money(r.newCash).padStart(13) + money(r.totalCash).padStart(13) + money(r.spend).padStart(12)
          + String(r.responses || 0).padStart(6) + (r.costPer != null ? money(r.costPer) : "—").padStart(10));
      }
      return L.join("\n");
    },
    csv(rows) {
      return { rows, columns: [
        { header: "source", get: (x) => x.source }, { header: "deals", get: (x) => x.deals },
        { header: "new_cash", get: (x) => x.newCash }, { header: "recurring_cash", get: (x) => x.recurringCash },
        { header: "total_cash", get: (x) => x.totalCash }, { header: "spend", get: (x) => x.spend },
        { header: "responses", get: (x) => x.responses }, { header: "leads", get: (x) => x.leads },
        { header: "cost_per", get: (x) => x.costPer }, { header: "net", get: (x) => x.net },
      ] };
    },
  },

  {
    id: "officer",
    label: "By settlement officer",
    hint: "Deals and cash closed, alongside calls handled",
    needs: ["payments", "queue"],
    compute({ payments, queueByAgent }) {
      const by = new Map();
      const row = (k) => {
        if (!by.has(k)) by.set(k, { officer: k, deals: 0, dealCases: new Set(), cash: 0, mailCalls: 0, ldDials: 0, bcdCalls: 0 });
        return by.get(k);
      };
      for (const p of payments.filter((x) => !x.isChargeback)) {
        const r = row(p.officerAtSale
          ? canonicalStaffName(p.officerAtSale)
          : (p.attributionSnapshot === "missing" ? "(no snapshot)" : "(unassigned)"));
        r.cash = round2(r.cash + p.amount);
        if (p.paymentType === "initial") {
          r.dealCases.add(`${p.domain}:${p.caseId}`);
          r.deals = r.dealCases.size;                     // sales, not payment rows
        }
      }
      for (const [agent, v] of Object.entries(queueByAgent || {})) {
        const r = row(agent);
        r.mailCalls += v.MAILER || 0; r.bcdCalls += v.BCD || 0; r.ldDials += v.LD || 0;
      }
      return [...by.values()].sort((a, b) => b.cash - a.cash || (b.mailCalls + b.ldDials) - (a.mailCalls + a.ldDials));
    },
    renderText(rows) {
      const L = ["By settlement officer".padEnd(24) + "DEALS".padStart(6) + "COLLECTED".padStart(13) + "MAIL".padStart(7) + "LD".padStart(8)];
      L.push("-".repeat(58));
      for (const r of rows) {
        L.push(String(r.officer).slice(0, 23).padEnd(24) + String(r.deals).padStart(6)
          + money(r.cash).padStart(13) + String(r.mailCalls || "—").padStart(7) + String(r.ldDials || "—").padStart(8));
      }
      return L.join("\n");
    },
    csv(rows) {
      return { rows, columns: [
        { header: "officer", get: (x) => x.officer }, { header: "deals", get: (x) => x.deals },
        { header: "collected", get: (x) => x.cash }, { header: "mail_calls", get: (x) => x.mailCalls },
        { header: "bcd_calls", get: (x) => x.bcdCalls }, { header: "ld_dials", get: (x) => x.ldDials },
      ] };
    },
  },

  {
    id: "cohort",
    label: "Client since (vintage)",
    hint: "What share of revenue comes from each signing year",
    needs: ["payments"],
    compute({ payments }) {
      const by = new Map();
      for (const p of payments.filter((x) => !x.isChargeback)) {
        // Same rule as reportOps.dimensionValue: no snapshot means we do NOT
        // know the signing year, and guessing it from the payment date books
        // a long-standing client as a new one.
        const first = p.metricsTreatment?.firstPaidDateKey;
        const year = first ? String(first).slice(0, 4) : "(unattributed)";
        if (!by.has(year)) by.set(year, { cohort: year, cash: 0, newCash: 0, recurringCash: 0, cases: new Set() });
        const b = by.get(year);
        b.cash = round2(b.cash + p.amount);
        b.cases.add(`${p.domain}:${p.caseId}`);
        if (p.paymentType === "initial") b.newCash = round2(b.newCash + p.amount);
        else b.recurringCash = round2(b.recurringCash + p.amount);
      }
      const total = round2([...by.values()].reduce((s, b) => s + b.cash, 0));
      return [...by.values()]
        .map((b) => ({ ...b, cases: b.cases.size, pctOfRevenue: total > 0 ? Math.round((b.cash / total) * 1000) / 10 : null }))
        .sort((a, b) => String(b.cohort).localeCompare(String(a.cohort)));
    },
    renderText(rows) {
      const L = ["Client since".padEnd(16) + "CASES".padStart(7) + "NEW $".padStart(13) + "RECURRING $".padStart(14) + "TOTAL $".padStart(13) + "% REV".padStart(8)];
      L.push("-".repeat(71));
      for (const r of rows) {
        L.push(String(r.cohort).padEnd(16) + String(r.cases).padStart(7) + money(r.newCash).padStart(13)
          + money(r.recurringCash).padStart(14) + money(r.cash).padStart(13) + pct(r.pctOfRevenue).padStart(8));
      }
      return L.join("\n");
    },
    csv(rows) {
      return { rows, columns: [
        { header: "client_since", get: (x) => x.cohort }, { header: "cases", get: (x) => x.cases },
        { header: "new_cash", get: (x) => x.newCash }, { header: "recurring_cash", get: (x) => x.recurringCash },
        { header: "total_cash", get: (x) => x.cash }, { header: "pct_of_revenue", get: (x) => x.pctOfRevenue },
      ] };
    },
  },

  {
    id: "status",
    label: "Status movement",
    hint: "DNC, post-dates, suspensions and conversions",
    needs: ["activity"],
    compute({ events }) {
      const c = { dnc: 0, postdate: 0, suspended: 0, conversions: 0, other: 0 };
      for (const e of events) {
        if (e.kind === "conversion") { c.conversions += 1; continue; }
        if (e.kind !== "status-change" || e.payload?.selfTransition) continue;
        const k = e.payload?.safetyClass;
        if (k === "dnc") c.dnc += 1;
        else if (k === "postdate") c.postdate += 1;
        else if (k === "suspended") c.suspended += 1;
        else c.other += 1;
      }
      return c;
    },
    renderText(d) {
      return `Status              ${d.dnc} DNC · ${d.postdate} post-date · ${d.suspended} suspended · ${d.conversions} converted`;
    },
    csv(d) {
      return { rows: [d], columns: [
        { header: "dnc", get: (x) => x.dnc }, { header: "postdate", get: (x) => x.postdate },
        { header: "suspended", get: (x) => x.suspended }, { header: "converted", get: (x) => x.conversions },
        { header: "other_status", get: (x) => x.other },
      ] };
    },
  },

  {
    id: "recordings",
    label: "Calls to review",
    hint: "Deals, post dates and 10 min+ calls, with listen links",
    // PAYMENTS is required, not optional: a call is only knowable as a DEAL
    // call by matching it to a sale. Declaring only "recordings" meant
    // picking this block alone gathered no payments, so every deal call was
    // silently tagged LONG and landed in an outcome=no-deal filter — the
    // exact opposite of the truth.
    needs: ["recordings", "payments"],
    compute({ recordings }) { return recordings || []; },
    renderText(rows) {
      if (!rows.length) return "Calls to review     (none)";
      const L = ["Calls to review"];
      for (const c of rows.slice(0, 15)) {
        // SOURCE marks the call the attribution actually came from — the
        // longest on the close day. Without it a three-call deal shows three
        // DEAL rows and the reader cannot tell which one earned the source.
        L.push(`  [${(c.reasons || []).join("·")}] ${c.minutes}m ${c.caller || c.phone || "?"}${c.officer ? ` → ${c.officer}` : ""}`
          + (c.isAttributionCall && c.source ? `  (source: ${c.source})` : ""));
        L.push(`      ${c.listenUrl || "(no link)"}`);
      }
      return L.join("\n");
    },
    csv(rows) {
      return { rows, columns: [
        { header: "reasons", get: (x) => (x.reasons || []).join("|") },
        { header: "minutes", get: (x) => x.minutes }, { header: "platform", get: (x) => x.platform },
        { header: "caller", get: (x) => x.caller || x.phone }, { header: "case_id", get: (x) => x.caseId },
        { header: "officer", get: (x) => x.officer }, { header: "listen_url", get: (x) => x.listenUrl },
      ] };
    },
  },
  {
    id: "postdates",
    label: "Post-dates: kept or lost",
    hint: "Cases promised for a later date, and whether the money actually arrived",
    needs: ["activity", "postdateBilling"],
    compute({ postdateBilling = [] }) {
      return [...postdateBilling]
        .map((c) => ({
          ...c,
          outcome: c.error ? "unknown"
            : c.paidAfter ? "converted"
              : c.noBillingRecord ? "no-billing-record"
                : c.declinedCount > 0 ? "declined"
                  : "not-yet",
        }))
        .sort((a, b) => String(a.postdatedOn).localeCompare(String(b.postdatedOn)));
    },
    renderText(rows) {
      const n = rows.length;
      const won = rows.filter((r) => r.outcome === "converted");
      const rate = n > 0 ? Math.round((won.length / n) * 1000) / 10 : null;
      const L = [`${n} post-dated · ${won.length} converted (${pct(rate)}) · ${money(won.reduce((s2, r) => s2 + r.amountAfter, 0))} collected`, ""];
      L.push("DOMAIN".padEnd(7) + "CASE".padStart(9) + "  POSTDATED  " + "OUTCOME".padEnd(18) + "COLLECTED".padStart(12));
      L.push("-".repeat(62));
      for (const r of rows) {
        L.push(String(r.domain).padEnd(7) + String(r.caseId).padStart(9) + "  " + String(r.postdatedOn).padEnd(11)
          + String(r.outcome).padEnd(18) + money(r.amountAfter).padStart(12));
      }
      // "declined" and "no-billing-record" are different failures: one tried
      // and the card bounced, the other never got entered. Do not merge them.
      const by = {};
      for (const r of rows) by[r.outcome] = (by[r.outcome] || 0) + 1;
      L.push("", Object.entries(by).map(([k, v]) => `${k}: ${v}`).join(" · "));
      return L.join("\n");
    },
    csv(rows) {
      return { rows, columns: [
        { header: "domain", get: (x) => x.domain }, { header: "case_id", get: (x) => x.caseId },
        { header: "postdated_on", get: (x) => x.postdatedOn }, { header: "to_status", get: (x) => x.toStatus },
        { header: "outcome", get: (x) => x.outcome }, { header: "collected_after", get: (x) => x.amountAfter },
        { header: "declined_count", get: (x) => x.declinedCount }, { header: "declined_amount", get: (x) => x.declinedAmount },
      ] };
    },
  },
  {
    id: "declines",
    label: "Declines to chase",
    hint: "Money that was attempted and bounced — recoverable if worked today",
    needs: ["payments", "caseContacts"],
    compute({ declines = [] }) {
      const by = new Map();
      for (const d of declines) {
        const key = `${d.domain}:${d.caseId}`;
        if (!by.has(key)) {
          by.set(key, {
            domain: d.domain, caseId: d.caseId, name: d.name || null,
            officer: d.officerAtSale || null, phone: d.phone || null,
            attempts: 0, amount: 0, lastTried: null,
          });
        }
        const b = by.get(key);
        b.attempts += 1;
        b.amount = round2(b.amount + Math.abs(Number(d.amount) || 0));
        const when = d.paymentDateKey || null;
        if (when && (!b.lastTried || when > b.lastTried)) b.lastTried = when;
      }
      return [...by.values()].sort((a, b) => b.amount - a.amount);
    },
    renderText(rows) {
      const total = round2(rows.reduce((s2, r) => s2 + r.amount, 0));
      const L = [`${rows.length} case(s) with declined attempts · ${money(total)} attempted and not captured`, ""];
      L.push("DOMAIN".padEnd(7) + "CASE".padStart(9) + "  " + "CLIENT".padEnd(22) + "TRIES".padStart(6) + "AMOUNT".padStart(12) + "  LAST");
      L.push("-".repeat(74));
      for (const r of rows) {
        L.push(String(r.domain).padEnd(7) + String(r.caseId).padStart(9) + "  " + String(r.name || "—").slice(0, 21).padEnd(22)
          + String(r.attempts).padStart(6) + money(r.amount).padStart(12) + "  " + String(r.lastTried || "—"));
      }
      return L.join("\n");
    },
    csv(rows) {
      return { rows, columns: [
        { header: "domain", get: (x) => x.domain }, { header: "case_id", get: (x) => x.caseId },
        { header: "client", get: (x) => x.name }, { header: "phone", get: (x) => x.phone },
        { header: "officer", get: (x) => x.officer }, { header: "attempts", get: (x) => x.attempts },
        { header: "amount_attempted", get: (x) => x.amount }, { header: "last_tried", get: (x) => x.lastTried },
      ] };
    },
  },
  {
    id: "effort",
    label: "Effort to close",
    hint: "How much contact it took before a case paid — inbound for TAG, dials for WYNN",
    // Two lanes, never one median. A WYNN outbound dial attempt and a TAG
    // inbound call are different units with OPPOSITE agency; averaging them
    // is a category error. Routing is by PAYMENT domain, never by dial domain.
    needs: ["payments", "dials", "callsRange", "caseContacts"],
    compute({ payments = [], dials = [], callsRange = [] }) {
      const ops = require("./reportOpsService");
      const deals = payments.filter((p) => p.paymentType === "initial" && !p.isChargeback);

      // ── Inbound lane. CallRail is one shared account: mail is bought for
      //    TAG only, but BCD runs for several tenants, so a WYNN deal can
      //    legitimately arrive on a BCD call. Eligibility is decided per call
      //    by sourceFitsDomain, not by excluding whole tenants.
      const tagDeals = deals.filter((d) => {
        const dom = String(d.domain).toUpperCase();
        return dom === "TAG" || dom === "WYNN";
      });
      const byPhone = new Map();
      for (const c of callsRange) {
        const k = ops.last10 ? ops.last10(c.phone) : String(c.phone || "").replace(/\D/g, "").slice(-10);
        if (!k) continue;
        if (!byPhone.has(k)) byPhone.set(k, []);
        byPhone.get(k).push(c);
      }
      const inbound = tagDeals.map((d) => {
        const keys = [...new Set([d.phone, ...(d.phones || [])]
          .map((x) => String(x || "").replace(/\D/g, "").slice(-10)).filter((x) => x.length === 10))];
        const calls = keys.flatMap((k) => byPhone.get(k) || [])
          .filter((c) => ops.sourceFitsDomain(c.source, d.domain));
        const paid = d.paymentDateKey || null;
        const before = calls.filter((c) => String(c.dateKey) < String(paid)).length;
        const sameDay = calls.filter((c) => String(c.dateKey) === String(paid)).length;
        // CallRail counts prior calls itself, including ones we never joined
        // to a case — prefer its number and say which we used.
        const priors = calls.map((c) => c.priorCalls).filter((n) => Number.isFinite(n));
        return {
          domain: d.domain, caseId: d.caseId, basis: "inbound-callrail",
          covered: calls.length > 0,
          touchesBeforeClose: before, sameDayTouches: sameDay, touchesToClose: before + sameDay,
          providerPriorCalls: priors.length ? Math.max(...priors) : null,
          firstCallClose: calls.length === 1 && sameDay === 1,
          closedOn: paid,
          reason: calls.length ? null : (keys.length ? "no-callrail-match" : "no-phone-on-file"),
        };
      });

      // ── WYNN: outbound dial attempts.
      // WYNN also has an outbound lane; a WYNN deal can appear in both, which
      // is correct — they are different questions, never summed.
      const wynnDeals = deals.filter((d) => String(d.domain).toUpperCase() === "WYNN");
      const outbound = ops.joinAttempts(wynnDeals, dials).map((r) => ({
        ...r, basis: "outbound-dials", covered: r.hadDialRecord,
        touchesBeforeClose: r.attemptsBeforeClose, sameDayTouches: r.sameDayAttempts,
        touchesToClose: r.attemptsToClose,
        reason: r.hadDialRecord ? null : "no-dial-record",
      }));

      // AMITY has neither source. Say so; do not leave it out and let the
      // reader assume it was zero-effort.
      const other = deals
        .filter((d) => !["TAG", "WYNN"].includes(String(d.domain).toUpperCase()))
        .map((d) => ({
          domain: d.domain, caseId: d.caseId, basis: "none", covered: false,
          touchesBeforeClose: null, sameDayTouches: null, touchesToClose: null,
          closedOn: d.paymentDateKey || null, reason: "no-contact-source-for-domain",
        }));

      const dist = (rows) => ops.distribution(rows.filter((r) => r.covered).map((r) => r.touchesToClose));
      return {
        rows: [...inbound, ...outbound, ...other],
        lanes: [
          { basis: "inbound-callrail", label: "Inbound calls before close (TAG mail + BCD)", rows: inbound, dist: dist(inbound) },
          { basis: "outbound-dials", label: "Outbound dial attempts before close (WYNN)", rows: outbound, dist: dist(outbound) },
        ].filter((l) => l.rows.length),
        unmeasurable: other,
      };
    },
    renderText(data) {
      const L = [];
      for (const lane of data.lanes) {
        const cov = lane.rows.filter((r) => r.covered).length;
        L.push(`${lane.label} — ${lane.rows.length} deal(s) · ${cov} with contact history · ${lane.rows.length - cov} without`);
        if (lane.dist.n > 0) {
          L.push(`  touches to close: median ${lane.dist.median} · p90 ${lane.dist.p90} · max ${lane.dist.max}`);
          if (lane.basis === "inbound-callrail") {
            const first = lane.rows.filter((r) => r.firstCallClose).length;
            L.push(`  closed on the FIRST inbound call: ${first} of ${cov} (${pct(cov ? Math.round((first / cov) * 1000) / 10 : null)})`);
          }
        }
        L.push("");
        L.push("DOMAIN".padEnd(7) + "CASE".padStart(9) + "BEFORE".padStart(8) + "SAME DAY".padStart(10) + "TOTAL".padStart(7) + "  CLOSED      WHY NOT");
        L.push("-".repeat(78));
        for (const r of lane.rows.slice(0, 30)) {
          L.push(String(r.domain).padEnd(7) + String(r.caseId).padStart(9)
            + (r.covered ? String(r.touchesBeforeClose).padStart(8) : "—".padStart(8))
            + (r.covered ? String(r.sameDayTouches).padStart(10) : "—".padStart(10))
            + (r.covered ? String(r.touchesToClose).padStart(7) : "—".padStart(7))
            + "  " + String(r.closedOn || "").padEnd(12) + (r.reason || ""));
        }
        L.push("");
      }
      if (data.unmeasurable.length) {
        L.push(`${data.unmeasurable.length} deal(s) have no contact source for their domain (${[...new Set(data.unmeasurable.map((r) => r.domain))].join(", ")}) — not counted as zero effort.`);
      }
      // The two medians are never combined: different units, opposite agency.
      return L.join(NEWLINE);
    },
    csv(data) {
      return { rows: data.rows, columns: [
        { header: "domain", get: (x) => x.domain }, { header: "case_id", get: (x) => x.caseId },
        { header: "measurement_basis", get: (x) => x.basis },
        { header: "has_contact_history", get: (x) => x.covered },
        { header: "touches_before_close", get: (x) => x.touchesBeforeClose },
        { header: "same_day_touches", get: (x) => x.sameDayTouches },
        { header: "touches_to_close", get: (x) => x.touchesToClose },
        { header: "callrail_prior_calls", get: (x) => x.providerPriorCalls ?? null },
        { header: "first_call_close", get: (x) => x.firstCallClose ?? null },
        { header: "closed_on", get: (x) => x.closedOn },
        { header: "why_not_covered", get: (x) => x.reason },
      ] };
    },
  },
  {
    id: "lag",
    // Each reason is a DIFFERENT fact and none of them means "nobody called".
    // CallRail sees tracking numbers only, so an unmatched TAG deal may still
    // have had a long inbound call on the main DID.
    label: "Call to close lag",
    hint: "Days from first inbound call to the first payment",
    needs: ["payments", "callsRange", "caseContacts"],
    compute({ payments = [], callsRange = [] }) {
      const ops = require("./reportOpsService");
      const deals = payments.filter((p) => p.paymentType === "initial" && !p.isChargeback);
      const rows = ops.lag(deals, callsRange);
      const matched = rows.filter((r) => r.coverage === "matched");
      return { rows, dist: ops.distribution(matched.map((r) => r.days)), matched: matched.length };
    },
    renderText(data) {
      const { rows, dist, matched } = data;
      const offTenant = rows.filter((r) => r.reason === "callrail-is-tag-only").length;
      const L = [`${rows.length} deal(s) · ${matched} matched to a CallRail call · ${rows.length - matched} unmatched`
        + (offTenant ? ` (${offTenant} not a CallRail tenant)` : "")];
      if (dist.n > 0) L.push(`days to close — median ${dist.median} · p90 ${dist.p90} · max ${dist.max}`);
      L.push("");
      L.push("DOMAIN".padEnd(7) + "CASE".padStart(9) + "DAYS".padStart(7) + "  " + "SOURCE".padEnd(26) + "AMOUNT".padStart(11));
      L.push("-".repeat(63));
      for (const r of rows.slice(0, 40)) {
        L.push(String(r.domain).padEnd(7) + String(r.caseId).padStart(9)
          + (r.days === null ? "—".padStart(7) : String(r.days).padStart(7))
          + "  " + String(r.source || LAG_REASON[r.reason] || "—").slice(0, 25).padEnd(26)
          + money(r.amount).padStart(11));
      }
      return L.join("\n");
    },
    csv(data) {
      return { rows: data.rows, columns: [
        { header: "domain", get: (x) => x.domain }, { header: "case_id", get: (x) => x.caseId },
        { header: "coverage", get: (x) => x.coverage }, { header: "reason", get: (x) => x.reason },
        { header: "days_to_close", get: (x) => x.days }, { header: "inbound_calls", get: (x) => x.calls },
        { header: "first_call_at", get: (x) => x.firstCallAt }, { header: "source", get: (x) => x.source },
        { header: "amount", get: (x) => x.amount },
      ] };
    },
  },
  {
    id: "streams",
    label: "Queue performance by stream",
    hint: "Connected calls per paid stream, and who took them",
    needs: ["queue"],
    compute({ queueStreams = {}, queueByAgent = {} }) {
      const streams = Object.entries(queueStreams).map(([key, v]) => ({
        stream: key, calls: v.calls || 0, connected: v.connected || 0, missed: v.missed || 0,
        connectRate: v.calls > 0 ? Math.round((v.connected / v.calls) * 1000) / 10 : null,
      })).sort((a, b) => b.connected - a.connected);
      const agents = Object.entries(queueByAgent).map(([agent, byStream]) => ({
        agent, ...byStream, total: Object.values(byStream).reduce((s2, n) => s2 + n, 0),
      })).sort((a, b) => b.total - a.total);
      return { streams, agents };
    },
    renderText(data) {
      const L = ["STREAM".padEnd(22) + "CALLS".padStart(8) + "CONNECTED".padStart(11) + "MISSED".padStart(9) + "CONNECT %".padStart(11)];
      L.push("-".repeat(61));
      for (const r of data.streams) {
        L.push(String(r.stream).padEnd(22) + String(r.calls).padStart(8) + String(r.connected).padStart(11)
          + String(r.missed).padStart(9) + pct(r.connectRate).padStart(11));
      }
      if (data.agents.length) {
        L.push("", "AGENT".padEnd(24) + "CONNECTED");
        L.push("-".repeat(36));
        for (const a of data.agents) L.push(String(a.agent).slice(0, 23).padEnd(24) + String(a.total).padStart(9));
      }
      return L.join("\n");
    },
    csv(data) {
      return { rows: data.streams, columns: [
        { header: "stream", get: (x) => x.stream }, { header: "calls", get: (x) => x.calls },
        { header: "connected", get: (x) => x.connected }, { header: "missed", get: (x) => x.missed },
        { header: "connect_rate", get: (x) => x.connectRate },
      ] };
    },
  },
  {
    id: "worked",
    label: "Work today",
    hint: "Calls received, taken and made, and deals written, per person",
    // queue carries BOTH sides: MAILER/BCD are inbound calls CONNECTED to an
    // agent, LD is PhoneBurner OUTBOUND dials. Deliberately NOT declaring
    // "dials" as well — readLdDials reads the same DailyDial rows the LD
    // counts come from (verified 2026-07-27: chris_bolt 528, phil_olson 79,
    // bruce_allen 26 identical in both), so using both would double every
    // outbound number.
    needs: ["queue", "payments"],
    compute({ queueByAgent = {}, queueStreams = {}, payments = [] }) {
      const {
        ROLES, canonicalStaffName, staffRole,
      } = require("../../shared-config/src/staffRoster");
      const INBOUND = new Set(["MAILER", "BCD"]);
      const by = new Map();
      const row = (name) => {
        if (!by.has(name)) by.set(name, { agent: name, taken: 0, made: 0, deals: 0, dealCases: new Set(), cash: 0 });
        return by.get(name);
      };

      for (const [agent, streams] of Object.entries(queueByAgent)) {
        const r = row(canonicalStaffName(agent));
        for (const [key, n] of Object.entries(streams || {})) {
          if (INBOUND.has(key)) r.taken += n || 0;
          else r.made += n || 0;
        }
      }

      for (const p of payments.filter((x) => !x.isChargeback && x.paymentType === "initial")) {
        // Someone with deals but no queue activity still belongs on the board;
        // so does someone with calls and no deals. Union, never intersect.
        const r = row(p.officerAtSale
          || (p.attributionSnapshot === "missing" ? "(no snapshot)" : "(unassigned)"));
        r.dealCases.add(`${p.domain}:${p.caseId}`);
        r.deals = r.dealCases.size;                       // sales, not payment rows
        r.cash = round2(r.cash + p.amount);
      }

      // Received vs taken is a QUEUE fact, not a per-agent one: a missed call
      // never reached an agent, so it can only be reported in the total.
      const totals = { received: 0, taken: 0, missed: 0 };
      for (const s of Object.values(queueStreams || {})) {
        totals.received += s.calls || 0;
        totals.taken += s.connected || 0;
        totals.missed += s.missed || 0;
      }

      const all = [...by.values()]
        .map(({ dealCases, ...r }) => ({ ...r, touches: r.taken + r.made, role: staffRole(r.agent) }))
        .filter((r) => r.taken || r.made || r.deals);

      // The sales board ranks the SALES FLOOR only. Ranking the owner or a
      // customer-service rep at zero deals reads as underperformance for work
      // they were never doing - and lands in the owner's inbox saying it.
      const rows = all
        .filter((r) => r.role === ROLES.SALES || r.agent.startsWith("("))
        .sort((a, b) => b.deals - a.deals || b.touches - a.touches);

      // Answering the phone is real work; it is just not selling. Credited by
      // name, never ranked, and never shown with a deals column.
      const alsoAnswering = all
        .filter((r) => r.role === ROLES.CSERV)
        .sort((a, b) => b.touches - a.touches);

      // The owner is not staff being measured. His calls still belong in the
      // queue totals - those are facts about the queue, not about a person -
      // but he is not named in a report telling people their work is seen.
      const offBoard = all.filter((r) => r.role === ROLES.OWNER);

      return { rows, alsoAnswering, offBoard, totals };
    },
    renderText(data) {
      const { rows, alsoAnswering = [], offBoard = [], totals } = data;
      const L = [`Work today · ${totals.received} call(s) received · ${totals.taken} taken · ${totals.missed} missed`];
      if (!rows.length && !alsoAnswering.length) return L[0] + NEWLINE + "  (nothing recorded yet)";
      L.push("");
      L.push("PERSON".padEnd(20) + "TAKEN".padStart(7) + "MADE".padStart(8) + "DEALS".padStart(7) + "CASH".padStart(13));
      L.push("-".repeat(55));
      for (const r of rows) {
        L.push(String(r.agent).slice(0, 19).padEnd(20) + String(r.taken).padStart(7)
          + String(r.made).padStart(8) + String(r.deals).padStart(7) + money(r.cash).padStart(13));
      }
      const sum = rows.reduce((a, r) => ({
        taken: a.taken + r.taken, made: a.made + r.made, deals: a.deals + r.deals, cash: round2(a.cash + r.cash),
      }), { taken: 0, made: 0, deals: 0, cash: 0 });
      L.push("-".repeat(55));
      L.push("TOTAL".padEnd(20) + String(sum.taken).padStart(7) + String(sum.made).padStart(8)
        + String(sum.deals).padStart(7) + money(sum.cash).padStart(13));
      if (alsoAnswering.length) {
        L.push("", "Also answering (customer service — not on the sales board):");
        for (const r of alsoAnswering) {
          L.push(`  ${r.agent} — ${r.taken} taken${r.made ? `, ${r.made} made` : ""}`);
        }
      }
      if (totals.missed) {
        // Missed calls have no agent, so they belong to the queue, not a person.
        L.push("", `${totals.missed} call(s) rang and were not answered — queue-wide, not attributable to a person.`);
      }
      // Keep the arithmetic honest: if named rows do not account for every
      // connected call, say where the rest went rather than letting the
      // header and the table quietly disagree.
      const named = [...rows, ...alsoAnswering].reduce((a, r) => a + r.taken, 0);
      const unnamed = totals.taken - named;
      if (unnamed > 0) {
        L.push(`${unnamed} taken by ${offBoard.length ? "someone off the sales board" : "an unidentified extension"}`
          + " — counted in the header, not in the table.");
      }
      return L.join(NEWLINE);
    },
    csv(data) {
      return { rows: data.rows, columns: [
        { header: "person", get: (x) => x.agent },
        { header: "calls_taken", get: (x) => x.taken },
        { header: "calls_made", get: (x) => x.made },
        { header: "deals_written", get: (x) => x.deals },
        { header: "cash", get: (x) => x.cash },
      ] };
    },
  },
];

// Every source name a block may declare. gatherMaterial keys its gathers on
// exactly these strings, so a typo here is not a typo — it means the gather
// never runs and the block renders a confident, EMPTY table. That has now
// happened three times (recordings needing payments; "money" as both a block
// and a preset; "events" instead of "activity"), so it fails at load instead.
const SOURCES = Object.freeze([
  "payments", "activity", "spend", "calls", "queue",
  "recordings", "dials", "postdateBilling", "callsRange", "caseContacts",
]);

for (const b of BLOCKS) {
  const bad = (b.needs || []).filter((n) => !SOURCES.includes(n));
  if (bad.length) {
    throw new Error(
      `report block "${b.id}" declares unknown source(s) ${bad.join(", ")} — `
      + `valid sources: ${SOURCES.join(", ")}`,
    );
  }
}

const BY_ID = new Map(BLOCKS.map((b) => [b.id, b]));

/** Presets — a named tick-set, so common asks stay one word. */
// Preset names must never collide with a block id — "money" as both meant
// ticking one box silently expanded to three.
const PRESETS = Object.freeze({
  // THE NIGHT BOARD. Mickey 2026-07-28: "the night board can be very basic
  // unless we add to it. so how much spent what money made and where from.
  // and then you can add stuff to it." Four blocks answer exactly that, and
  // adding to it is now editing a saved definition rather than editing code.
  board: ["spend", "money", "net", "source"],
  // The 1pm nudge and the same lines again in the EOD roll-up.
  worklog: ["worked"],
  daily: ["money", "spend", "net", "source", "officer", "status", "recordings"],
  financials: ["money", "spend", "net", "declines"],
  marketing: ["source", "spend", "net"],
  people: ["officer", "effort", "streams"],
  health: ["cohort", "money"],
  pipeline: ["postdates", "declines", "lag"],
});

function resolveSelection(selection) {
  const raw = Array.isArray(selection) ? selection : String(selection || "daily").split(",");
  const ids = [];
  for (const item of raw.map((x) => String(x).trim()).filter(Boolean)) {
    // A block id ALWAYS wins over a preset of the same name — the specific
    // thing you ticked must not silently become a bundle.
    if (BY_ID.has(item)) ids.push(item);
    else if (PRESETS[item]) ids.push(...PRESETS[item]);
    else ids.push(item);
  }
  const seen = new Set();
  const blocks = [];
  const unknown = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (BY_ID.has(id)) blocks.push(BY_ID.get(id));
    else unknown.push(id);
  }
  return { blocks, unknown };
}

/** The union of raw material the ticked blocks require. */
function neededSources(blocks) {
  const needs = new Set();
  for (const b of blocks) for (const n of b.needs) needs.add(n);
  return [...needs];
}

module.exports = { BLOCKS, BY_ID, PRESETS, SOURCES, neededSources, resolveSelection };
