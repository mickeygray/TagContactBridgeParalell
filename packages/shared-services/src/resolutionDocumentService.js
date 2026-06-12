"use strict";

// resolutionDocumentService — the parse-and-delete pipeline.
//
// DOCTRINE: documents are NEVER persisted. Files arrive as in-memory buffers
// (multer memoryStorage), are parsed into a SCRAPED OBJECT (structured fields
// with bounded provenance snippets), merged into the clientProfile's
// shorthand, recorded as a content hash — and the buffer is released. A
// failed parse throws loudly BEFORE anything is recorded, so the uploader
// re-uploads; never a silent loss.
//
// Main three document families (user-selected at upload):
//   ths   — Tax Help Software "Tax Analysis" PDF (the tax-posture crown jewel)
//   wit   — IRS e-Services Wage & Income transcript HTML
//   lexis — LexisNexis TXT exports (Person / SOS / Business sub-types)

const crypto = require("crypto");
const {
  mergeShorthandFields,
  recordDocumentHash,
  getClientProfileByCaseNumber,
} = require("../../shared-repositories/src/clientProfileRepository");

const SNIPPET_MAX = 240;

// ── Sensitivity scrub (defense in depth) ─────────────────────────────────────
// The shorthand is "verbose but non-sensitive": rich structure, no national
// identifiers. Even though parsers don't target SSNs, they can leak in via
// FILENAMES (Logics names documents "<TYPE>_<year>_<ssn with spaces>") and
// free-text snippets — so everything persisted passes through this scrub.
const SSN_PATTERNS = [
  // 608-82-7503 / 608 82 7503 — digit-lookbehind instead of \b because
  // underscores are word chars and Logics filenames glue SSNs to them
  // ("WIT_2024_608 82 7503.html" slips a \b).
  /(?<!\d)\d{3}[-\s]\d{2}[-\s]\d{4}(?!\d)/g,
  // EXACTLY 9 contiguous digits ("WIT_2023_608827503.html") — SSN-shaped.
  // IRS tracking numbers (12 digits) and phone numbers (10) survive; a
  // contiguous EIN is acceptable collateral (we keep EINs only when dashed).
  /(?<!\d)\d{9}(?!\d)/g,
];
const CONTACT_PATTERNS = [
  /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi,
  /(?<!\d)(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}(?!\d)/g,
];

function scrubText(value) {
  let s = String(value ?? "");
  for (const re of SSN_PATTERNS) s = s.replace(re, "***-**-****");
  s = s.replace(CONTACT_PATTERNS[0], "[email]");
  s = s.replace(CONTACT_PATTERNS[1], "[phone]");
  return s;
}

// Recursively scrub every string leaf of a structured value.
function scrubDeep(value) {
  if (typeof value === "string") return scrubText(value);
  if (Array.isArray(value)) return value.map(scrubDeep);
  // Dates are typeof "object" but Object.entries(date) is [] — walking them
  // silently turns every asOf stamp into {} (bit the Logics refresh live).
  if (value instanceof Date) return value;
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubDeep(v);
    return out;
  }
  return value;
}

function snip(value) {
  return scrubText(String(value || "")).replace(/\s+/g, " ").trim().slice(0, SNIPPET_MAX);
}

function money(value) {
  const raw = String(value || "").trim();
  const negative = /^\(.*\)$/.test(raw); // accounting parens = negative
  const n = Number(raw.replace(/[$,()]/g, ""));
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

// Mask an account identifier to its last 4 — we track WHICH account without
// storing the full number ("Account Number (Optional): MTG0082149451" → *9451).
function acctRef(value) {
  const s = String(value || "").replace(/\s+/g, "");
  if (!s) return null;
  const tail = s.slice(-4);
  return s.length > 4 ? `*${tail}` : s;
}

// ── WIT: IRS e-Services Wage & Income HTML ───────────────────────────────────
// Structured dl/dt/dd with one <h2 class="form-number"> per form. We walk the
// form blocks and collect the entity line + dollar amounts per form.
function parseWitHtml(html) {
  const text = String(html || "");
  const period = text.match(/Tax Period Requested:<\/dt>\s*<dd[^>]*>([\d-]+)<\/dd>/i)?.[1] || null;
  // Match the year anywhere in the period — slice(-4) on an ISO-ordered
  // "2024-12-31" would mint a garbage "wit_2-31" key.
  const year = period?.match(/(?:19|20)\d{2}/)?.[0] || null;
  const tracking = text.match(/Tracking Number:<\/dt>\s*<dd[^>]*>(\d+)<\/dd>/i)?.[1] || null;

  const blocks = text.split(/<h2 class="form-number">/i).slice(1);
  const forms = [];
  for (const block of blocks) {
    const formName = block.match(/^([^<]+)/)?.[1]?.trim() || "Unknown form";
    // First non-label dt line after Employer/Payer header = the entity name.
    // Gaps are BOUNDED — two chained unbounded lazy [\s\S]*? scans gave
    // O(n²) backtracking on non-matching 25MB uploads (event-loop stall).
    const entity = block.match(/<h3 class="waid-header">(?:Employer|Payer|Recipient\/Lender)[\s\S]{0,400}?<dt class="item-label">[^<]*<\/dt>[\s\S]{0,400}?<dt class="item-label">([A-Z][^<]{2,60})<\/dt>/)?.[1]?.trim() || null;
    // EVERY money number transcribes — including $0.00 (a zero withholding on
    // a big 1099-R is itself a balance-due signal).
    const amounts = {};
    // Parens detection must look at the VALUE cell only — labels like
    // "Mortgage Interest Received from Payer(s)/Borrower(s)" carry parens too.
    const amountRe = /<dt class="item-label">([^<]{3,80}):<\/dt>\s*<dd class="item-value">(\(?)\$([\d,.]+)(\)?)<\/dd>/g;
    let m;
    while ((m = amountRe.exec(block))) {
      const label = m[1].trim();
      const val = money(m[2] && m[4] ? `($${m[3]})` : m[3]);
      if (val !== null) amounts[label] = val;
    }
    // Account ref (masked to last 4) so multiple 1099-Rs/1098s from different
    // custodians stay distinguishable across years.
    const account = acctRef(block.match(/Account Number[^<]*:<\/dt>\s*<dd class="item-value">([^<]+)<\/dd>/i)?.[1]?.trim() || "");
    forms.push({ form: formName, entity, account, amounts });
  }
  if (!forms.length && !period) {
    throw Object.assign(new Error("WIT parse failed: no Tax Period or form blocks found — is this an e-Services W&I HTML?"), { status: 422 });
  }

  // Income classification rollup: the per-category money picture for the year.
  const pick = (formRe, labelRe) => forms
    .filter((f) => formRe.test(f.form))
    .reduce((sum, f) => {
      for (const [label, val] of Object.entries(f.amounts)) {
        if (labelRe.test(label)) sum += val || 0;
      }
      return sum;
    }, 0);
  const incomeSummary = {
    w2Wages: pick(/W-2/i, /^Wages, Tips and Other Compensation$/i),
    retirementDistributions: pick(/1099-R/i, /Gross Distribution/i),
    retirementTaxable: pick(/1099-R/i, /Taxable Amount/i),
    nonemployeeComp: pick(/1099-(NEC|MISC)/i, /Non-?Employee Compensation|Nonemployee/i),
    miscOther: pick(/1099-MISC/i, /Other Income|Rents|Royalties/i),
    interest: pick(/1099-INT/i, /^Interest$|Interest Income/i),
    dividends: pick(/1099-DIV/i, /Ordinary Dividend|Total Capital Gain/i),
    unemployment: pick(/1099-G/i, /Unemployment Compensation/i),
    socialSecurity: pick(/SSA-1099|SSA/i, /Benefits Paid|Net Benefits/i),
    gambling: pick(/W-2G/i, /Gross Winnings/i),
    debtCancellation: pick(/1099-C/i, /Amount of Debt/i),
    proceeds1099B: pick(/1099-B/i, /Proceeds/i),
    proceeds1099S: pick(/1099-S/i, /Gross Proceeds/i),
    paymentsCard1099K: pick(/1099-K/i, /Gross Amount/i),
    // Strictly "Federal Income Tax Withheld" — a bare /Tax Withheld$/ sweeps in
    // Social Security / Medicare payroll tax and inflates the figure.
    federalWithholding: pick(/./, /Federal Income Tax Withheld/i),
    mortgageInterestPaid: pick(/1098/i, /Mortgage Interest Received/i),
    mortgagePrincipalOutstanding: pick(/1098/i, /Outstanding mortgage principle/i),
  };
  // Trim zero categories from the rollup (the per-form amounts keep them all).
  const income = Object.fromEntries(Object.entries(incomeSummary).filter(([, v]) => v !== 0));

  const summary = forms
    .map((f) => `${f.form.replace(/Form\s*/i, "")}${f.entity ? ` (${f.entity.slice(0, 24)})` : ""}${f.account ? ` ${f.account}` : ""}`)
    .join("; ")
    .slice(0, 200);

  const fields = {};
  if (year) {
    fields[`wit_${year}`] = {
      value: { period, tracking, formCount: forms.length, income, forms },
      snippet: snip(`${forms.length} forms: ${summary}`),
    };
    fields[`wit_${year}_income`] = {
      value: income,
      snippet: snip(
        Object.entries(income)
          .map(([k, v]) => `${k} $${Number(v).toLocaleString()}`)
          .join("; ") || "no nonzero income categories",
      ),
    };
  }
  return { docLabel: `W&I transcript ${year || "?"}`, fields };
}

// ── RT: IRS e-Services Form 1040 Return Transcript HTML ─────────────────────
// Same template family as WIT, organized by named sections (INCOME,
// ADJUSTMENTS TO INCOME, TAX AND CREDITS, PAYMENTS, ...). EVERY money number
// transcribes, keyed by section; headline figures surface separately.
function parseRtHtml(html) {
  const text = String(html || "");
  if (!/Tax Return Transcript/i.test(text)) {
    throw Object.assign(new Error("RT parse failed: not a Form 1040 Tax Return Transcript HTML"), { status: 422 });
  }
  const period = text.match(/Tax Period Ending:<\/dt>\s*<dd[^>]*>([\d-]+)<\/dd>/i)?.[1] || null;
  const year = period?.match(/(?:19|20)\d{2}/)?.[0] || null;
  const filingStatus = text.match(/Filing status:<\/dt>\s*<dd[^>]*>([^<]+)<\/dd>/i)?.[1]?.trim() || null;
  const received = text.match(/Received date:<\/dt>\s*<dd[^>]*>([\d-]+)<\/dd>/i)?.[1] || null;

  const sections = {};
  const sectionBlocks = text.split(/<section class="([A-Z0-9]+)">/).slice(1);
  for (let i = 0; i + 1 < sectionBlocks.length; i += 2) {
    const name = sectionBlocks[i];
    const block = sectionBlocks[i + 1];
    const amounts = {};
    const amountRe = /<dt class="item-label">([^<]{3,90}):<\/dt>\s*<dd class="item-value">(\(?\$[\d,.]+\)?)<\/dd>/g;
    let m;
    while ((m = amountRe.exec(block))) {
      const val = money(m[2]);
      if (val !== null) amounts[m[1].trim()] = val;
    }
    if (Object.keys(amounts).length) sections[name] = amounts;
  }
  if (!Object.keys(sections).length) {
    throw Object.assign(new Error("RT parse failed: no money sections found"), { status: 422 });
  }

  // Headline figures by label search across all sections.
  const find = (re) => {
    for (const amounts of Object.values(sections)) {
      for (const [label, val] of Object.entries(amounts)) {
        if (re.test(label)) return val;
      }
    }
    return null;
  };
  const headline = {
    totalIncome: find(/^Total income$/i),
    adjustedGrossIncome: find(/^Adjusted gross income$/i),
    taxableIncome: find(/^Taxable income$/i),
    totalTax: find(/^Total tax liability.*per computer|^Total tax$/i),
    totalPayments: find(/^Total payments$/i),
    withholding: find(/federal income tax withheld/i),
    balanceDue: find(/^(Balance due|BAL DUE)/i) ?? find(/balance due.*per computer/i),
    refund: find(/^(Refund|Amount to be refunded|Overpayment)/i),
  };
  const headlineClean = Object.fromEntries(Object.entries(headline).filter(([, v]) => v !== null));

  const fields = {};
  if (year) {
    fields[`rt_${year}`] = {
      value: { period, filingStatus, received, headline: headlineClean, sections },
      snippet: snip(
        `1040 ${year} (${filingStatus || "?"}, recv ${received || "?"}): ` +
        (Object.entries(headlineClean).map(([k, v]) => `${k} $${Number(v).toLocaleString()}`).join("; ") || "amounts captured"),
      ),
    };
  }
  return { docLabel: `Return transcript ${year || "?"}`, fields };
}

// ── THS: Tax Help Software "Tax Analysis" PDF ────────────────────────────────
// Text PDF with stable sections. v1 extracts the ACCOUNT STATUS DASHBOARD
// (per-year filed/balances), the IRS NOTICES table, and the report date.
async function parseThsPdf(buffer) {
  const { PDFParse } = require("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  let text;
  try {
    const result = await parser.getText();
    text = String(result.text || "");
  } finally {
    await parser.destroy().catch(() => {});
  }
  if (!/IRS ACCOUNT STATUS DASHBOARD/i.test(text)) {
    throw Object.assign(new Error("THS parse failed: ACCOUNT STATUS DASHBOARD section not found — is this a Tax Help Software Tax Analysis PDF?"), { status: 422 });
  }

  const dash = text.split(/IRS ACCOUNT STATUS DASHBOARD/i)[1] || "";
  const dashLines = dash.split("\n").slice(0, 60);
  const years = [];
  const unfiled = [];
  let totalAssessed = null;
  let totalAccrued = null;
  for (const line of dashLines) {
    const t = line.trim();
    const yearRow = t.match(/^((?:19|20)\d{2})\s+(\S+)\s+(\S+)/);
    if (yearRow) {
      const amounts = [...t.matchAll(/\$([\d,]+\.\d{2})/g)].map((a) => money(a[1]));
      const row = {
        year: yearRow[1],
        returnFiled: yearRow[2],
        filingStatus: yearRow[3] || null,
        assessedBalance: amounts.length >= 2 ? amounts[amounts.length - 2] : null,
        accruedBalance: amounts.length >= 1 ? amounts[amounts.length - 1] : null,
      };
      years.push(row);
      if (/^no$/i.test(row.returnFiled)) unfiled.push(row.year);
      continue;
    }
    const total = t.match(/^Total\**\s+\$([\d,]+\.\d{2})\s+\$([\d,]+\.\d{2})/);
    if (total) {
      totalAssessed = money(total[1]);
      totalAccrued = money(total[2]);
    }
  }

  const notices = [];
  const noticesSection = text.split(/IRS NOTICES/i)[1] || "";
  const noticeRe = /^((?:19|20)\d{2})\s+(.{4,60}?)\s+(\d{1,2}\/\d{1,2}\/\d{4})\s*$/gm;
  let nm;
  while ((nm = noticeRe.exec(noticesSection.split(/Notice Number/i)[0] || ""))) {
    notices.push({ year: nm[1], notice: nm[2].trim(), date: nm[3] });
  }

  const balanceYears = years.filter((y) => (y.accruedBalance || 0) > 0);
  // Balance decomposition (ACCOUNT BALANCE SUMMARY): the full money anatomy
  // per year — assessed tax + penalty + interest + other − payments + refunds
  // = assessed balance + accrued penalty + accrued interest = total.
  const decomposition = [];
  const balSection = text.split(/IRS ACCOUNT BALANCE SUMMARY/i)[1] || "";
  for (const line of balSection.split("\n").slice(0, 60)) {
    const t = line.trim();
    const ym = t.match(/^((?:19|20)\d{2})\s+(\S+)/);
    if (!ym) continue;
    const nums = [...t.matchAll(/(\(?\$[\d,]+\.\d{2}\)?)/g)].map((a) => money(a[1]));
    if (nums.length < 10) continue;
    const [assessedTax, assessedPenalty, assessedInterest, assessedOther, payments, refunds, assessedBalance, accruedPenalty, accruedInterest, totalBalance] = nums;
    if ((totalBalance || 0) !== 0 || (assessedTax || 0) !== 0 || (payments || 0) !== 0) {
      decomposition.push({
        year: ym[1], returnFiled: ym[2],
        assessedTax, assessedPenalty, assessedInterest, assessedOther,
        payments, refunds, assessedBalance, accruedPenalty, accruedInterest, totalBalance,
      });
    }
  }

  // Income history (10 YEAR TAX RETURN SUMMARY): AGI / taxable / tax / SE tax
  // per year — the earning trajectory.
  const incomeHistory = [];
  const incSection = text.split(/10 YEAR TAX RETURN SUMMARY/i)[1] || "";
  for (const line of incSection.split("\n").slice(0, 30)) {
    const t = line.trim();
    const im = t.match(/^((?:19|20)\d{2})\s+(\S+)\s+(\d+)\s/);
    if (!im) continue;
    const nums = [...t.matchAll(/\$([\d,]+)/g)].map((a) => money(a[1]));
    if (!nums.length) continue;
    incomeHistory.push({
      year: im[1], filingStatus: im[2], exemptions: Number(im[3]),
      agi: nums[0] ?? null, taxableIncome: nums[1] ?? null,
      taxPerReturn: nums[2] ?? null, selfEmploymentTax: nums[3] ?? null,
    });
  }

  const fields = {
    ths_balances: {
      value: { years: balanceYears, totalAssessed, totalAccrued },
      snippet: snip(
        balanceYears.length
          ? `Owes on ${balanceYears.map((y) => `${y.year} ($${(y.accruedBalance || 0).toLocaleString()})`).join(", ")} — total accrued $${(totalAccrued || 0).toLocaleString()}`
          : "No assessed balances on transcript",
      ),
    },
    ths_unfiled_years: {
      value: unfiled,
      snippet: snip(unfiled.length ? `Unfiled: ${unfiled.join(", ")}` : "All years filed"),
    },
  };
  if (decomposition.length) {
    // Snippet shows only the years that still owe; the value keeps the full
    // history (paid-off years included — payment behavior is signal too).
    const owing = decomposition.filter((d) => (d.totalBalance || 0) > 0);
    fields.ths_balance_detail = {
      value: decomposition,
      snippet: snip((owing.length ? owing : decomposition.slice(0, 4)).map((d) =>
        `${d.year}: tax $${(d.assessedTax || 0).toLocaleString()} + pen $${((d.assessedPenalty || 0) + (d.accruedPenalty || 0)).toLocaleString()} + int $${((d.assessedInterest || 0) + (d.accruedInterest || 0)).toLocaleString()} → $${(d.totalBalance || 0).toLocaleString()}`,
      ).join("; ")),
    };
  }
  if (incomeHistory.length) {
    const earning = incomeHistory.filter((r) => (r.agi || 0) > 0);
    fields.ths_income_history = {
      value: incomeHistory,
      snippet: snip(earning.map((r) =>
        `${r.year} AGI $${(r.agi || 0).toLocaleString()}${r.selfEmploymentTax ? ` (SE tax $${r.selfEmploymentTax.toLocaleString()})` : ""}`,
      ).join("; ") || "no filed-year income rows"),
    };
  }
  if (notices.length) {
    fields.ths_notices = {
      value: notices.slice(0, 20),
      snippet: snip(notices.slice(0, 6).map((n) => `${n.year} ${n.notice} ${n.date}`).join("; ")),
    };
  }
  return {
    docLabel: `THS Tax Analysis (${years.length} years, total accrued $${(totalAccrued || 0).toLocaleString()})`,
    fields,
  };
}

// ── Lexis: LexisNexis TXT exports ────────────────────────────────────────────
// Sub-type detected by header. v1 extracts the means/exposure signals.
function parseLexisText(raw) {
  // Normalize CRLF — the exports carry \r\n, which silently breaks $-anchored
  // and \n-terminated patterns.
  const text = String(raw || "").replace(/\r\n?/g, "\n");
  const fields = {};
  let docLabel = "LexisNexis export";

  if (/SmartLinx.{0,3}Person Report/i.test(text)) {
    docLabel = "Lexis SmartLinx Person";
    const liens = [...text.matchAll(/(State|Federal) Tax Lien\s+(?:See Details\s+)?\$([\d,]+(?:\.\d{2})?)\s+(\d{2}\/\d{2}\/\d{4})/g)]
      .map((m) => ({ type: `${m[1]} Tax Lien`, amount: money(m[2]), filed: m[3] }));
    if (liens.length) {
      fields.lexis_tax_liens = {
        value: liens,
        snippet: snip(liens.map((l) => `${l.type} $${(l.amount || 0).toLocaleString()} (${l.filed})`).join("; ")),
      };
    }
    const nods = [...text.matchAll(/Document Type: NOTICE OF DEFAULT[\s\S]{0,120}?Recording Date: (\d{2}\/\d{2}\/\d{4})/g)];
    const nodDates = [...new Set([...text.matchAll(/Recording Date: (\d{2}\/\d{2}\/\d{4})\s*\nDocument Type: NOTICE OF DEFAULT/g)].map((m) => m[1]))];
    const nodCount = Math.max(nods.length, nodDates.length, (text.match(/NOTICE OF DEFAULT/g) || []).length / 2);
    if (nodCount > 0) {
      fields.lexis_notice_of_default = {
        value: { count: Math.round(nodCount), dates: nodDates },
        snippet: snip(`${Math.round(nodCount)} Notice(s) of Default${nodDates.length ? ` (${nodDates.join(", ")})` : ""}`),
      };
    }
    const assessed = text.match(/Assessed Value: \$([\d,]+\.?\d*)/);
    const propCount = text.match(/Real Property\s+(\d+)/);
    if (assessed || propCount) {
      fields.lexis_real_property = {
        value: { count: propCount ? Number(propCount[1]) : null, assessedValue: assessed ? money(assessed[1]) : null },
        snippet: snip(`Real property: ${propCount ? propCount[1] : "?"} | assessed $${assessed ? money(assessed[1]).toLocaleString() : "?"}`),
      };
    }
    // Do not persist contact identity in the resolution bank. If a user
    // explicitly needs contact details, fetch them live from Logics for the
    // case instead of storing phone/email inside this financial dossier.
  } else if (/Comprehensive Business Report/i.test(text)) {
    docLabel = "Lexis SmartLinx Business";
    const bizName = text.match(/Business Summary\s*\nName[\s\S]{0,200}?\n([A-Z0-9 .,&'-]{3,60}?)\s{2,}/)?.[1]?.trim()
      || text.match(/^\s*([A-Z][A-Z0-9 .,&'-]{4,60}(?:INC|LLC|CORP)\.?)\s{2,}/m)?.[1]?.trim()
      || null;
    const ucc = [...text.matchAll(/Secured Party Info \d+\s*\n([A-Z0-9 .,&'-]+?)\s*\n/g)].map((m) => m[1].trim());
    const uccDates = [...text.matchAll(/(?:ORIG\. FILING DATE[\s\S]{0,200}?|Date Filed:\s*)(\d{2}\/\d{2}\/\d{4})/g)].map((m) => m[1]);
    if (ucc.length || /UCC Filings \([1-9]/.test(text)) {
      fields.lexis_ucc_filings = {
        value: { business: bizName, securedParties: ucc, dates: [...new Set(uccDates)] },
        snippet: snip(`${bizName || "business"} UCC: ${ucc.join(", ") || "filing present"}${uccDates.length ? ` (${[...new Set(uccDates)].join(", ")})` : ""}`),
      };
    }
    const execs = text.match(/Executives: Current[\s\S]{0,300}?\n\s*\d+\.\s+([A-Za-z ,.'-]{4,50})\s/)?.[1]?.trim() || null;
    if (execs) {
      fields.lexis_business_exec = { value: { business: bizName, executive: execs }, snippet: snip(`${bizName || "business"} exec: ${execs}`) };
    }
  } else if (/Secretary of State/i.test(text)) {
    docLabel = "Lexis SOS Corporate";
    // Label:Value pairs are right-aligned with heavy leading whitespace.
    // "Name Type:" also exists — anchor on line start + exact label.
    const grab = (label) => {
      const re = new RegExp(`^\\s*${label}:(.+)$`, "m");
      return text.match(re)?.[1]?.trim() || null;
    };
    const name = grab("Name");
    const status = grab("Status");
    const statusDate = grab("Status Date");
    const comment = grab("Status Comment");
    const incorporated = grab("Date Incorporated");
    fields.lexis_corp_status = {
      value: { name, status, statusDate, comment, incorporated },
      snippet: snip(`${name || "corp"}: ${status || "?"}${statusDate ? ` since ${statusDate}` : ""}${comment ? ` — ${comment}` : ""}`),
    };
  } else if (/Experian Business Data/i.test(text)) {
    docLabel = /Comprehensive Business/i.test(text) ? "Lexis SmartLinx Business" : "Lexis Experian Business";
    const ucc = [...text.matchAll(/Secured Party Info \d+\s*\n([A-Z0-9 .,&'-]+)/g)].map((m) => m[1].trim());
    const uccDates = [...text.matchAll(/Date Filed:\s*(\d{2}\/\d{2}\/\d{4})/g)].map((m) => m[1]);
    if (ucc.length || uccDates.length || /UCC-FILED/.test(text)) {
      fields.lexis_ucc_filings = {
        value: { securedParties: ucc, dates: uccDates },
        snippet: snip(`UCC: ${ucc.join(", ") || "filing present"}${uccDates.length ? ` (${uccDates.join(", ")})` : ""}`),
      };
    }
  } else {
    throw Object.assign(new Error("Lexis parse failed: unrecognized export header — expected SmartLinx Person/Business, SOS, or Experian"), { status: 422 });
  }

  if (!Object.keys(fields).length) {
    throw Object.assign(new Error(`${docLabel}: recognized the document but extracted no signal fields`), { status: 422 });
  }
  return { docLabel, fields };
}

// ── The pipeline ─────────────────────────────────────────────────────────────
async function parseResolutionDocument({ buffer, filename = "", docType }) {
  const type = String(docType || "").toLowerCase();
  if (type === "wit") return parseWitHtml(buffer.toString("utf8"));
  if (type === "rt") return parseRtHtml(buffer.toString("utf8"));
  if (type === "ths") return parseThsPdf(buffer);
  if (type === "lexis") return parseLexisText(buffer.toString("utf8"));
  throw Object.assign(new Error(`Unknown docType "${docType}" — expected ths | wit | rt | lexis`), { status: 400 });
}

async function ingestClientDocument({
  caseNumber,
  domain = "TAG",
  buffer,
  filename = "",
  docType,
  uploadedBy = null,
  force = false,
}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw Object.assign(new Error("Empty upload"), { status: 400 });
  }
  const profile = await getClientProfileByCaseNumber(caseNumber, domain);
  if (!profile) {
    throw Object.assign(new Error(`No client profile for case ${caseNumber}`), { status: 404 });
  }

  const hash = crypto.createHash("sha256").update(buffer).digest("hex");
  const already = (profile.documentHashes || []).find((d) => d.hash === hash);
  if (already && !force) {
    return {
      ok: true,
      deduped: true,
      docLabel: already.label,
      message: `Already parsed on ${already.parsedAt ? new Date(already.parsedAt).toISOString().slice(0, 10) : "a prior date"} — nothing stored twice (force re-parses after parser upgrades)`,
    };
  }

  // Parse FIRST — a failure here throws before anything is recorded.
  const parsed = await parseResolutionDocument({ buffer, filename, docType });

  const asOf = new Date();
  const safeFilename = scrubText(filename || "upload");
  // Dot-path merge per field + atomic hash record: a Logics refresh (or a
  // second upload) running concurrently can no longer clobber these keys
  // the way the old whole-object shorthand replace could.
  const fields = {};
  for (const [key, entry] of Object.entries(parsed.fields)) {
    fields[key] = {
      value: scrubDeep(entry.value),
      snippet: scrubText(entry.snippet),
      asOf,
      source: `${docType}:${safeFilename}`,
      uploadedBy,
    };
  }
  await mergeShorthandFields(caseNumber, fields, { domain });
  await recordDocumentHash(caseNumber, {
    domain, hash, docType, parsedAt: asOf, label: scrubText(parsed.docLabel),
  });
  // The buffer goes out of scope here — the document is gone.

  return {
    ok: true,
    deduped: false,
    docLabel: parsed.docLabel,
    fieldsExtracted: Object.keys(parsed.fields),
    snippets: Object.fromEntries(Object.entries(parsed.fields).map(([k, v]) => [k, v.snippet])),
  };
}

module.exports = {
  parseResolutionDocument,
  ingestClientDocument,
  // Exported for tests + migrations
  parseWitHtml,
  parseRtHtml,
  parseLexisText,
  scrubText,
  scrubDeep,
};
