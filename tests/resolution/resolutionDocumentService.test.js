"use strict";

// Resolution document pipeline tests — synthetic fixtures only (the real
// sample documents carry PII and never enter the repo).
// Run: node --test tests/resolution/resolutionDocumentService.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  parseWitHtml,
  parseRtHtml,
  parseLexisText,
  scrubText,
  scrubDeep,
} = require("../../packages/shared-services/src/resolutionDocumentService");

test("scrubText masks SSNs in every separator style — including underscore-glued filenames", () => {
  assert.equal(scrubText("WIT_2024_123 45 6789.html"), "WIT_2024_***-**-****.html");
  assert.equal(scrubText("Tax_Analysis_JANE SAMPLE 123-45-6789.pdf"), "Tax_Analysis_JANE SAMPLE ***-**-****.pdf");
  assert.equal(scrubText("ssn 123-45-6789 and 987 65 4321"), "ssn ***-**-**** and ***-**-****");
  // CONTIGUOUS 9-digit runs are SSN-shaped (the no-separator filename leak).
  assert.equal(scrubText("WIT_2023_123456789.html"), "WIT_2023_***-**-****.html");
  // Contact coordinates are not part of the stored case dossier.
  assert.equal(scrubText("714-683-3790"), "[phone]");
  assert.equal(scrubText("7146833790"), "[phone]");
  assert.equal(scrubText("client@example.com"), "[email]");
  // Non-contact shapes survive: money, dashed EIN, 12-digit tracking numbers.
  assert.equal(scrubText("$11,558.41 EIN 83-2522335 trk 110639339770"), "$11,558.41 EIN 83-2522335 trk 110639339770");
});

test("scrubDeep walks structured values — and passes Dates through intact", () => {
  const asOf = new Date("2026-06-12T12:00:00Z");
  const scrubbed = scrubDeep({
    a: "file_123 45 6789.html",
    list: ["clean", { nested: "123-45-6789" }],
    n: 42,
    asOf,
  });
  assert.equal(scrubbed.a, "file_***-**-****.html");
  assert.equal(scrubbed.list[1].nested, "***-**-****");
  assert.equal(scrubbed.n, 42);
  assert.ok(scrubbed.asOf instanceof Date); // was silently becoming {}
  assert.equal(scrubbed.asOf.getTime(), asOf.getTime());
});

const SYNTH_WIT = `
<html><body>
<dt class="item-label">Tax Period Requested:</dt><dd class="item-value">12-31-2024</dd>
<dt class="header-label">Tracking Number:</dt><dd class="header-value">100000000001</dd>
<h2 class="form-number">Form W-2 Wage and Tax Statement</h2>
<h3 class="waid-header">Employer:</h3>
<dt class="item-label">Employer Identification Number (EIN):</dt><dd class="item-value">12-3456789</dd>
<dt class="item-label">ACME SAMPLE CORP</dt><dd class="item-value"></dd>
<dt class="item-label">Wages, Tips and Other Compensation:</dt><dd class="item-value">$10,000.00</dd>
<dt class="item-label">Social Security Tax Withheld:</dt><dd class="item-value">$620.00</dd>
</body></html>`;

test("WIT parser: forms, entities, amounts, income rollup from e-Services HTML", () => {
  const result = parseWitHtml(SYNTH_WIT);
  assert.match(result.docLabel, /2024/);
  assert.ok(result.fields.wit_2024);
  assert.equal(result.fields.wit_2024.value.income.w2Wages, 10000);
  assert.equal(result.fields.wit_2024.value.forms[0].entity, "ACME SAMPLE CORP");
  assert.equal(result.fields.wit_2024_income.value.w2Wages, 10000);
  // Non-income withholding still transcribed on the form itself.
  assert.equal(result.fields.wit_2024.value.forms[0].amounts["Social Security Tax Withheld"], 620);
});

test("WIT parser: fails loudly on non-WIT HTML (nothing silently recorded)", () => {
  assert.throws(() => parseWitHtml("<html><body><p>hello</p></body></html>"), /WIT parse failed/);
});

test("WIT parser: every money number transcribes — zeros kept, parens in LABELS stay positive, accounts masked", () => {
  const synth = `
<dt class="item-label">Tax Period Requested:</dt><dd class="item-value">12-31-2023</dd>
<h2 class="form-number">Form 1099-R</h2>
<h3 class="waid-header">Payer:</h3>
<dt class="item-label">Payer's Federal Identification Number (FIN):</dt><dd class="item-value">11-1111111</dd>
<dt class="item-label">SAMPLE RETIREMENT TRUST</dt><dd class="item-value"></dd>
<dt class="item-label">Account Number (Optional):</dt><dd class="item-value">IRA000777654321</dd>
<dt class="item-label">Gross Distribution:</dt><dd class="item-value">$40,000.00</dd>
<dt class="item-label">Taxable Amount:</dt><dd class="item-value">$40,000.00</dd>
<dt class="item-label">Federal Income Tax Withheld:</dt><dd class="item-value">$0.00</dd>
<h2 class="form-number">Form 1098 Mortgage Interest Statement</h2>
<dt class="item-label">Mortgage Interest Received from Payer(s)/Borrower(s):</dt><dd class="item-value">$9,000.00</dd>`;
  const result = parseWitHtml(synth);
  const form1099r = result.fields.wit_2023.value.forms[0];
  assert.equal(form1099r.amounts["Gross Distribution"], 40000);
  assert.equal(form1099r.amounts["Federal Income Tax Withheld"], 0); // zero KEPT
  assert.equal(form1099r.account, "*4321"); // masked to last 4
  const income = result.fields.wit_2023_income.value;
  assert.equal(income.retirementDistributions, 40000);
  assert.equal(income.mortgageInterestPaid, 9000); // POSITIVE — label parens must not negate
  assert.equal(income.federalWithholding, undefined); // zero rollups trimmed
});

test("RT parser: headline figures + per-section money capture", () => {
  const synth = `
<h1 class="transcript-title">Form 1040 Tax Return Transcript</h1>
<dt class="item-label">Report for Tax Period Ending:</dt><dd class="item-value">12-31-2023</dd>
<section class="HEADER2"><dl>
<dt class="item-label">Filing status:</dt><dd class="item-value">Single Taxpayer</dd>
<dt class="item-label">Received date:</dt><dd class="item-value">04-10-2024</dd>
</dl></section>
<section class="INCOME"><dl>
<dt class="item-label">Total income:</dt><dd class="item-value">$55,000.00</dd>
</dl></section>
<section class="TAX"><dl>
<dt class="item-label">Adjusted gross income:</dt><dd class="item-value">$52,000.00</dd>
<dt class="item-label">Taxable income:</dt><dd class="item-value">$38,000.00</dd>
<dt class="item-label">Total tax liability TP figures per computer:</dt><dd class="item-value">$4,400.00</dd>
<dt class="item-label">Balance due:</dt><dd class="item-value">$1,200.00</dd>
</dl></section>`;
  const result = parseRtHtml(synth);
  const rt = result.fields.rt_2023.value;
  assert.equal(rt.filingStatus, "Single Taxpayer");
  assert.equal(rt.headline.totalIncome, 55000);
  assert.equal(rt.headline.adjustedGrossIncome, 52000);
  assert.equal(rt.headline.balanceDue, 1200);
  assert.equal(rt.sections.INCOME["Total income"], 55000);
  assert.match(result.fields.rt_2023.snippet, /balanceDue \$1,200/);
});

test("RT parser: rejects non-RT HTML", () => {
  assert.throws(() => parseRtHtml("<html><body>nope</body></html>"), /RT parse failed/);
});

test("Lexis parser: person export extracts liens, NODs, property, but not contact identity", () => {
  const synth = [
    "1 OF 1 RECORD(S)",
    "SmartLinx®Person Report",
    "Real Property                                          2",
    "1.                 555-000-1111.                                 1/2020 - 6/2026.        Possible Wireless.",
    "sample.client@example.com",
    "State Tax Lien                See Details          $1,234.00         01/15/2025          25000000001",
    "Recording Date: 02/01/2025",
    "Document Type: NOTICE OF DEFAULT",
    "Assessed Value: $100,000.00",
  ].join("\r\n");
  const result = parseLexisText(synth);
  assert.equal(result.docLabel, "Lexis SmartLinx Person");
  assert.equal(result.fields.lexis_tax_liens.value[0].amount, 1234);
  assert.ok(result.fields.lexis_real_property.value.assessedValue === 100000);
  assert.equal(result.fields.lexis_phones, undefined);
  assert.equal(result.fields.lexis_emails, undefined);
});

test("Lexis parser: SOS export extracts corp status with CRLF endings", () => {
  const synth = [
    "California Secretary of State",
    "          Name:SAMPLE WIDGETS, INC.",
    "          Name Type:LEGAL",
    "          Status:SUSPENDED - FTB",
    "          Status Date:12/01/2021",
    "          Status Comment:NOT IN GOOD STANDING WITH FTB",
    "          Date Incorporated:07/30/2018",
  ].join("\r\n");
  const result = parseLexisText(synth);
  assert.equal(result.docLabel, "Lexis SOS Corporate");
  assert.equal(result.fields.lexis_corp_status.value.name, "SAMPLE WIDGETS, INC.");
  assert.equal(result.fields.lexis_corp_status.value.status, "SUSPENDED - FTB");
  assert.match(result.fields.lexis_corp_status.snippet, /SUSPENDED - FTB since 12\/01\/2021/);
});

test("Lexis parser: unknown export rejects with 422", () => {
  try {
    parseLexisText("just some random text file");
    assert.fail("should have thrown");
  } catch (e) {
    assert.equal(e.status, 422);
  }
});

const { parsePitchVerdict } = require("../../packages/shared-services/src/resolutionPitchVerdict");

test("pitch verdict: extracts the fence, strips it from the reply, validates the class", () => {
  const text = [
    "## Read",
    "- Client owes [ths_balances] and is penalty-clean 2016-18.",
    "",
    "```verdict",
    '{"class":"PITCH_NOW","headline":"FTA layup plus 5-year compliance","plays":["FTA","compliance"],"angle":"Penalties are the lever","fee":{"low":6500,"high":9500,"monthly":1500,"path":"lender"},"clocks":[{"what":"CP504 window","by":"2026-07-01"}],"missingDocs":[],"citations":["ths_balances"]}',
    "```",
  ].join("\n");
  const { reply, verdict } = parsePitchVerdict(text);
  assert.ok(!reply.includes("```verdict"));
  assert.match(reply, /penalty-clean/);
  assert.equal(verdict.class, "PITCH_NOW");
  assert.equal(verdict.fee.low, 6500);
  assert.equal(verdict.clocks[0].what, "CP504 window");
});

test("pitch verdict: last fence wins; malformed JSON degrades to null verdict, prose intact", () => {
  const twoFences = 'old\n```verdict\n{"class":"DEVELOP","headline":"old"}\n```\nnew\n```verdict\n{"class":"NURTURE","headline":"new"}\n```';
  assert.equal(parsePitchVerdict(twoFences).verdict.class, "NURTURE");
  const malformed = 'Solid read here.\n```verdict\n{not json}\n```';
  const result = parsePitchVerdict(malformed);
  assert.equal(result.verdict, null);
  assert.match(result.reply, /Solid read here/);
  // Unknown class rejected too.
  assert.equal(parsePitchVerdict('x\n```verdict\n{"class":"MAYBE"}\n```').verdict, null);
  // No fence at all: full text is the reply.
  assert.equal(parsePitchVerdict("just prose").reply, "just prose");
});
