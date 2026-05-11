"use strict";

// Topic seeds for the backloader. Each seed is a tight description of
// a blog idea — drawn from the Wynn 82-day calendar, Leo Collins
// teleprompter scripts (Tax Forms + Collection Notices), the blog FAQ
// doc, and the podcast FAQs cheat sheet. The actual blog body is
// written by Claude (Sonnet) at backload time using these seeds.
//
// `category` maps to the schedule slots:
//   "enforcement-doc"  — Monday slot (notices, forms, IRS process)
//   "relief-type"      — Tuesday slot (CNC, OIC, installment, etc.)
//   "current-event"    — Wednesday slot (web-search-driven, NOT seeded)
//   "success-story"    — Thursday slot (case-list-driven, NOT seeded)
//   "education"        — Friday rotation; broad explainer
//
// `slide` is the image template hint passed straight through to the
// SVG renderer. `keyAngles` are the must-cover content beats — Claude
// uses them to hit the right notes without inventing facts.

const SEEDS = [
  // ── Enforcement docs (notices, forms, IRS process) ───────────────
  {
    id: "irs-cp14-first-balance-due-notice-deep-dive",
    category: "enforcement-doc",
    title:
      "Your First IRS Notice Was a CP14: What It Actually Means and the One Action That Saves the Most",
    slide: {
      eyebrow: "IRS NOTICES",
      headline1: "CP14.",
      headline2: "First Balance Due.",
      badgeTop: "READ",
      badgeCenter: "21 DAYS",
      badgeBottom: "TO ACT",
      subhead1: "The first notice in the IRS collection ladder —",
      subhead2: "and the cheapest stage to resolve.",
    },
    keyAngles: [
      "CP14 is the first balance-due notice, typically arriving 4-6 weeks after IRS processes the return",
      "Three things to check: tax year matches, balance breakdown, deadline (usually 21 days)",
      "Common mistake: payment applied to wrong year",
      "Cheapest stage to act — penalties and interest only grow from here",
      "Online Payment Agreement available for balances under $50,000",
    ],
  },
  {
    id: "irs-cp504-final-notice-of-intent-to-levy-state-refund",
    category: "enforcement-doc",
    title:
      "CP504 Explained: Why the IRS Is Threatening Your State Refund and What Comes Next",
    slide: {
      eyebrow: "IRS NOTICES",
      headline1: "CP504.",
      headline2: "Levy Warning.",
      badgeTop: "BEFORE",
      badgeCenter: "LT11",
      badgeBottom: "ACT NOW",
      subhead1: "The last warning before the IRS gains full",
      subhead2: "levy authority over your accounts.",
    },
    keyAngles: [
      "CP504 is a Notice of Intent to Levy state tax refund — narrower than full levy authority",
      "Sets up LT11/Letter 1058, which grants levy authority over bank/wage/property",
      "30-day window after CP504 to act before the IRS issues the LT11",
      "Resolution paths still fully open: installment, CNC, OIC",
    ],
  },
  {
    id: "lt11-letter-1058-final-notice-30-day-cdp-window",
    category: "enforcement-doc",
    title:
      "LT11 / Letter 1058: The 30-Day Clock You Cannot Afford to Miss",
    slide: {
      eyebrow: "IRS NOTICES",
      headline1: "LT11.",
      headline2: "30 Days to Act.",
      badgeTop: "FORM",
      badgeCenter: "12153",
      badgeBottom: "CDP",
      subhead1: "Final Notice of Intent to Levy — request a CDP",
      subhead2: "hearing on Form 12153 within 30 days.",
    },
    keyAngles: [
      "LT11 is the Final Notice of Intent to Levy and Notice of Right to a Hearing",
      "30 days to file Form 12153 for Collection Due Process hearing — freezes collection",
      "After 30 days: equivalent hearing only, doesn't freeze collection, no Tax Court right",
      "What CDP hearing actually buys you: installment, CNC, OIC, lien withdrawal arguments",
      "Common mistake: assuming the 30 days starts when you opened the letter (it doesn't — it's notice date)",
    ],
  },
  {
    id: "irs-substitute-for-return-vs-original-return",
    category: "enforcement-doc",
    title:
      "The IRS Filed a Return for You? Here's How a Substitute for Return Differs from Your Own",
    slide: {
      eyebrow: "IRS PROCESS",
      headline1: "Substitute for",
      headline2: "Return (SFR).",
      badgeTop: "WORST",
      badgeCenter: "CASE",
      badgeBottom: "MATH",
      subhead1: "The IRS files for you with zero deductions",
      subhead2: "and the worst filing status.",
    },
    keyAngles: [
      "SFR is built from third-party reporting only (W-2, 1099, K-1, 1099-B)",
      "Default filing status: Single or MFS — no HoH, no MFJ",
      "No deductions claimed beyond standard, no credits, no cost basis on sales",
      "Can be replaced by filing your own original return",
      "Refund window: 3 years from original due date (most refunds lost forever after that)",
    ],
  },
  {
    id: "form-1040-x-amended-return-when-and-how",
    category: "enforcement-doc",
    title:
      "Form 1040-X (Amended Return): When You Should File One and What It Cannot Do",
    slide: {
      eyebrow: "TAX FORMS",
      headline1: "Form 1040-X.",
      headline2: "Amend Carefully.",
      badgeTop: "WINDOW",
      badgeCenter: "3 YEARS",
      badgeBottom: "FOR REFUNDS",
      subhead1: "Amend to fix mistakes — but know what",
      subhead2: "the form does and doesn't cover.",
    },
    keyAngles: [
      "1040-X corrects an already-filed return — different from filing a missing return",
      "3-year refund window from original due date",
      "Common reasons: missed income, missed deduction/credit, wrong filing status",
      "Doesn't replace an SFR (that's a different process — audit reconsideration)",
      "Can trigger amended state return obligation",
    ],
  },
  {
    id: "form-2210-underpayment-penalty-estimated-tax",
    category: "enforcement-doc",
    title:
      "Why You Owe a Penalty for Owing: Form 2210 and the Underpayment Penalty",
    slide: {
      eyebrow: "TAX FORMS",
      headline1: "Form 2210.",
      headline2: "Underpaid?",
      badgeTop: "SAFE",
      badgeCenter: "HARBOR",
      badgeBottom: "RULES",
      subhead1: "The IRS expects you to pay as you earn —",
      subhead2: "not just on April 15.",
    },
    keyAngles: [
      "IRS expects pay-as-you-go via withholding or estimated payments",
      "Safe harbor: pay at least 100% of last year's tax (110% if AGI > $150k) OR 90% of current",
      "Penalty calculated quarter-by-quarter at federal short-term rate + 3%",
      "Common trigger: 1099 income added without estimated payments, big year-over-year jump",
      "How to fix going forward: increase withholding (W-4) or quarterly 1040-ES",
    ],
  },
  {
    id: "irs-tax-lien-vs-levy-difference",
    category: "enforcement-doc",
    title:
      "Tax Lien vs. Levy: The Difference the IRS Hopes You Don't Understand Until Too Late",
    slide: {
      eyebrow: "IRS COLLECTIONS",
      headline1: "Lien vs. Levy.",
      headline2: "Two Different",
      badgeTop: "LIEN",
      badgeCenter: "≠",
      badgeBottom: "LEVY",
      subhead1: "A claim on your stuff is not the same",
      subhead2: "as actually taking it.",
    },
    keyAngles: [
      "Lien = legal claim against your property; Levy = actual seizure",
      "Notice of Federal Tax Lien (NFTL) is filed publicly — affects credit/title/sale",
      "Levy requires LT11 first; lien doesn't have the same 30-day CDP requirement (though one exists)",
      "Lien withdrawal vs release vs subordination — different IRS programs",
      "Common confusion: 'I got a lien notice so they're taking my house' (no, not directly)",
    ],
  },
  {
    id: "irs-trust-fund-recovery-penalty-payroll-taxes",
    category: "enforcement-doc",
    title:
      "Trust Fund Recovery Penalty: Why Unpaid Payroll Taxes Become Personal",
    slide: {
      eyebrow: "BUSINESS TAX",
      headline1: "Trust Fund",
      headline2: "Penalty.",
      badgeTop: "PERSONAL",
      badgeCenter: "100%",
      badgeBottom: "LIABILITY",
      subhead1: "Unpaid payroll taxes can pierce the corporate",
      subhead2: "veil and become your personal debt.",
    },
    keyAngles: [
      "Section 6672: 100% of withheld income tax + employee FICA assessed against responsible persons",
      "Targets owners, officers, anyone with check-signing authority",
      "Survives entity dissolution and bankruptcy in many cases",
      "Cannot be discharged in bankruptcy",
      "Defenses: not a 'responsible person', no 'willful' failure",
    ],
  },
  {
    id: "irs-revenue-officer-vs-acs-collection",
    category: "enforcement-doc",
    title:
      "When the IRS Assigns a Revenue Officer to Your Case — and Why That Matters",
    slide: {
      eyebrow: "IRS COLLECTIONS",
      headline1: "Revenue Officer",
      headline2: "Assigned.",
      badgeTop: "REAL",
      badgeCenter: "PERSON",
      badgeBottom: "REAL CASE",
      subhead1: "ACS to RO assignment means your case left",
      subhead2: "the automated track.",
    },
    keyAngles: [
      "Most cases handled by Automated Collection System (ACS) — phone reps, no individual case ownership",
      "Revenue Officer (RO): individual case-owner with broader authority, in-person visits, 90-day plans",
      "Triggers for RO assignment: balance size ($100k+ typical), unfiled returns, business taxes, failed installment defaults",
      "RO can issue summonses, conduct interviews, request bank records — ACS rarely does",
      "Once assigned, the case stays with that RO until resolved",
    ],
  },

  // ── Relief types ────────────────────────────────────────────────
  {
    id: "irs-installment-agreement-types-streamlined-vs-financial",
    category: "relief-type",
    title:
      "IRS Installment Agreements: Streamlined vs. Financial Disclosure — Which One You Actually Qualify For",
    slide: {
      eyebrow: "TAX RELIEF",
      headline1: "Payment Plans.",
      headline2: "Three Tiers.",
      badgeTop: "UNDER",
      badgeCenter: "$50K",
      badgeBottom: "STREAMLINED",
      subhead1: "Under $50k is the easy zone. Above that,",
      subhead2: "the IRS wants your numbers.",
    },
    keyAngles: [
      "Streamlined IA: balances ≤$50k, no financial disclosure, online setup",
      "Partial Pay IA: pay part of debt over remaining CSED, requires Form 433-F",
      "Full disclosure IA: balances >$50k, Form 433-A or 433-F, IRS uses ALE standards",
      "Setup fees: $31 online, up to $225 mailed; reduced for low-income",
      "Why plans default: IRS expects payment based on ALE, not what feels comfortable",
    ],
  },
  {
    id: "innocent-spouse-vs-injured-spouse-relief",
    category: "relief-type",
    title:
      "Innocent Spouse vs. Injured Spouse: Two Names, Two Completely Different Reliefs",
    slide: {
      eyebrow: "TAX RELIEF",
      headline1: "Innocent vs.",
      headline2: "Injured Spouse.",
      badgeTop: "8857",
      badgeCenter: "vs.",
      badgeBottom: "8379",
      subhead1: "Two reliefs that share a confusing label —",
      subhead2: "and serve completely different problems.",
    },
    keyAngles: [
      "Innocent Spouse (Form 8857): relief from joint liability for spouse's understated/unreported tax",
      "Injured Spouse (Form 8379): get YOUR portion of a joint refund the IRS took to satisfy SPOUSE'S separate debt",
      "Innocent: undoes liability; Injured: protects refund",
      "Three innocent spouse paths: traditional, separation of liability, equitable relief",
      "Common confusion: people apply for the wrong one",
    ],
  },
  {
    id: "first-time-penalty-abatement-fta",
    category: "relief-type",
    title:
      "First-Time Penalty Abatement: A Free Reduction the IRS Doesn't Advertise",
    slide: {
      eyebrow: "TAX RELIEF",
      headline1: "First-Time",
      headline2: "Abatement.",
      badgeTop: "CLEAN",
      badgeCenter: "3 YEARS",
      badgeBottom: "QUALIFIES",
      subhead1: "If you've been clean for 3 years, the IRS",
      subhead2: "will erase one year's penalties.",
    },
    keyAngles: [
      "FTA is administrative (no need to prove reasonable cause)",
      "Eligibility: clean compliance for 3 prior tax years (no penalties, all returns filed)",
      "Removes failure-to-file, failure-to-pay, failure-to-deposit penalties",
      "Does NOT remove interest (interest continues on the underlying tax)",
      "Request via phone, written request, or with the return",
    ],
  },
  {
    id: "irs-collection-statute-csed-10-year-rule",
    category: "relief-type",
    title:
      "The 10-Year Rule: How the IRS Collection Statute (CSED) Actually Works",
    slide: {
      eyebrow: "TAX RELIEF",
      headline1: "10 Years.",
      headline2: "Then It's Gone.",
      badgeTop: "CSED",
      badgeCenter: "10 YEAR",
      badgeBottom: "CLOCK",
      subhead1: "The IRS has 10 years from assessment to collect —",
      subhead2: "but the clock can pause.",
    },
    keyAngles: [
      "CSED = Collection Statute Expiration Date, 10 years from assessment",
      "Tolling events that pause the clock: bankruptcy, OIC under review, CDP appeal pending, Form 911 (Taxpayer Advocate), being outside US for 6+ months",
      "After CSED expires, IRS can no longer collect — debt is statute-barred",
      "How to find your CSED: IRS account transcript",
      "Strategy implication: sometimes 'wait it out' (in CNC) is mathematically the right path",
    ],
  },
  {
    id: "audit-reconsideration-when-original-return-was-wrong",
    category: "relief-type",
    title:
      "Audit Reconsideration: How to Reopen a Case the IRS Already Closed Against You",
    slide: {
      eyebrow: "TAX RELIEF",
      headline1: "Audit",
      headline2: "Reconsideration.",
      badgeTop: "REOPEN",
      badgeCenter: "WITH",
      badgeBottom: "EVIDENCE",
      subhead1: "Closed audits aren't always permanent —",
      subhead2: "if you have new information or evidence.",
    },
    keyAngles: [
      "Audit reconsideration: process to challenge IRS-imposed assessment after audit closure or SFR",
      "Requires NEW information not previously considered",
      "Used for: wrong filing status, missing deductions, unfiled return replaced after SFR",
      "Different from CDP, different from Tax Court — administrative review",
      "Can stop active collection while pending",
    ],
  },
  {
    id: "passport-revocation-seriously-delinquent-tax-debt",
    category: "relief-type",
    title:
      "Can the IRS Take Your Passport? The 'Seriously Delinquent Tax Debt' Rule Explained",
    slide: {
      eyebrow: "IRS COLLECTIONS",
      headline1: "Passport?",
      headline2: "Seriously.",
      badgeTop: "OVER",
      badgeCenter: "$62,000",
      badgeBottom: "TRIGGERS",
      subhead1: "Owe enough and the State Department",
      subhead2: "can deny or revoke your passport.",
    },
    keyAngles: [
      "Section 7345: certified seriously delinquent tax debt = >$62,000 (2024 threshold, indexed)",
      "IRS certifies to State Department; State can deny new passport, revoke existing",
      "Decertification triggers: pay in full, OIC accepted, IA in place, CDP pending, innocent spouse pending",
      "Bankruptcy and identity theft also pause certification",
      "Travel emergencies: limited expedited decertification process",
    ],
  },
  {
    id: "currently-non-collectible-vs-installment-agreement-comparison",
    category: "relief-type",
    title:
      "CNC vs. Installment Agreement: Which One Actually Helps Most?",
    slide: {
      eyebrow: "TAX RELIEF",
      headline1: "CNC vs. IA.",
      headline2: "Pick Wisely.",
      badgeTop: "PAUSE",
      badgeCenter: "OR",
      badgeBottom: "PAY",
      subhead1: "Pause everything (CNC) or pay slowly (IA) —",
      subhead2: "two paths with very different math.",
    },
    keyAngles: [
      "CNC: nothing paid, debt grows, CSED still runs",
      "IA: monthly payment, debt slowly shrinks, CSED still runs",
      "Both require similar financial disclosure",
      "When CNC wins: short remaining CSED, no foreseeable income improvement, high-hardship",
      "When IA wins: stable income above ALE, debt small enough to clear before CSED, want lien release",
    ],
  },
  {
    id: "tax-debt-and-bankruptcy-discharge-rules",
    category: "relief-type",
    title:
      "Can You Discharge Tax Debt in Bankruptcy? The Three Rules Most People Miss",
    slide: {
      eyebrow: "TAX RELIEF",
      headline1: "Tax Debt &",
      headline2: "Bankruptcy.",
      badgeTop: "3-2-240",
      badgeCenter: "RULES",
      badgeBottom: "DISCHARGE",
      subhead1: "Income tax CAN be discharged — but only",
      subhead2: "if three timing rules all align.",
    },
    keyAngles: [
      "Three-year rule: tax due date >3 years before bankruptcy filing",
      "Two-year rule: return filed >2 years before bankruptcy filing",
      "240-day rule: assessment >240 days before bankruptcy filing",
      "Plus: no fraud, no willful evasion, return wasn't an SFR (key exception)",
      "Trust fund taxes (TFRP) and recent income tax: NOT dischargeable",
    ],
  },

  // ── Education (Friday rotation; broad explainers) ────────────────
  {
    id: "what-an-extension-actually-buys-you-form-4868",
    category: "education",
    title:
      "What a Tax Extension Actually Buys You — and What It Doesn't (Form 4868)",
    slide: {
      eyebrow: "TAX FORMS",
      headline1: "Form 4868.",
      headline2: "Extension.",
      badgeTop: "TIME TO",
      badgeCenter: "FILE",
      badgeBottom: "NOT TIME TO PAY",
      subhead1: "Six more months to file. Not six more",
      subhead2: "months to pay.",
    },
    keyAngles: [
      "Form 4868 extends time to FILE to October 15 — does NOT extend time to PAY",
      "Failure-to-pay penalty (0.5%/month) starts April 16 even with valid extension",
      "Failure-to-file penalty (5%/month) eliminated for the extension period",
      "Estimate liability and pay it with extension to minimize penalty",
      "Free to file via IRS Free File",
    ],
  },
  {
    id: "estimated-tax-payments-1040-es-explained",
    category: "education",
    title:
      "Quarterly Estimated Tax: How to Stop Owing Every April (Form 1040-ES)",
    slide: {
      eyebrow: "TAX EDUCATION",
      headline1: "1040-ES.",
      headline2: "Pay as You Go.",
      badgeTop: "FOUR",
      badgeCenter: "DATES",
      badgeBottom: "PER YEAR",
      subhead1: "1099 workers, side hustlers, retirees with",
      subhead2: "investment income — this is for you.",
    },
    keyAngles: [
      "Required when you'll owe $1,000+ at filing time",
      "Four quarterly due dates: ~April 15, June 15, September 15, January 15",
      "Safe harbor: 100% of last year's tax (110% if AGI >$150k) OR 90% of current year",
      "Pay via IRS Direct Pay, EFTPS, or check with Form 1040-ES voucher",
      "Underpayment penalty if missed; Form 2210 calculates",
    ],
  },
  {
    id: "head-of-household-vs-single-filing-status",
    category: "education",
    title:
      "Head of Household: The Filing Status That Saves Real Money — and the Rules That Disqualify Most People",
    slide: {
      eyebrow: "TAX EDUCATION",
      headline1: "Head of",
      headline2: "Household.",
      badgeTop: "QUALIFY",
      badgeCenter: "OR",
      badgeBottom: "DON'T",
      subhead1: "A bigger standard deduction and lower brackets —",
      subhead2: "if you actually qualify.",
    },
    keyAngles: [
      "HoH: unmarried/considered unmarried + paid >half of household + qualifying person lived >half year",
      "Bigger standard deduction than Single (~50% more)",
      "Wider tax brackets (more income at lower rates)",
      "Common mistake: assuming a roommate or older parent qualifies — strict tests",
      "Audit risk: HoH is a frequent IRS target when documentation is weak",
    ],
  },
  {
    id: "multi-state-tax-residency-vs-source-income",
    category: "education",
    title:
      "Working in Multiple States: Residency vs. Source Income, and the Credit That Stops Double Taxation",
    slide: {
      eyebrow: "TAX EDUCATION",
      headline1: "Multi-State.",
      headline2: "Filing Right.",
      badgeTop: "CREDIT",
      badgeCenter: "FOR",
      badgeBottom: "OTHER STATES",
      subhead1: "Two states can claim the same income —",
      subhead2: "the credit prevents paying tax twice.",
    },
    keyAngles: [
      "Resident state taxes worldwide income; non-resident state taxes only source income",
      "Reciprocity agreements between some states (PA/NJ, DC/MD/VA) eliminate cross-filing",
      "Credit for taxes paid to other states prevents double taxation",
      "Common pitfalls: remote work to a state with income tax, snowbirds, college students",
      "Domicile vs. residency: where you intend to return matters",
    ],
  },
  {
    id: "1099-k-third-party-payment-thresholds",
    category: "education",
    title:
      "1099-K from Venmo, PayPal, Etsy: What the Lower Threshold Actually Means for You",
    slide: {
      eyebrow: "TAX EDUCATION",
      headline1: "1099-K.",
      headline2: "New Reality.",
      badgeTop: "WHO",
      badgeCenter: "GETS",
      badgeBottom: "ONE",
      subhead1: "Third-party payment platforms now report",
      subhead2: "small-dollar transactions — you may owe tax.",
    },
    keyAngles: [
      "1099-K threshold has dropped (transition rules to $5,000 for 2024, eventually $600)",
      "Personal payments (rent split, gifts) shouldn't trigger tax — but may trigger 1099-K",
      "Business income via these platforms: still taxable",
      "How to reconcile: track personal vs business carefully",
      "What to do if you get a 1099-K for non-business: report and back out personal portion",
    ],
  },
  {
    id: "saver-credit-form-8880-retirement",
    category: "education",
    title:
      "The Saver's Credit (Form 8880): A Tax Credit Most Eligible Filers Miss",
    slide: {
      eyebrow: "TAX CREDITS",
      headline1: "Saver's Credit.",
      headline2: "Form 8880.",
      badgeTop: "UP TO",
      badgeCenter: "$1,000",
      badgeBottom: "BACK",
      subhead1: "Contribute to an IRA or 401(k) and earn",
      subhead2: "a tax credit on top of the deduction.",
    },
    keyAngles: [
      "Credit (not just deduction) for contributions to retirement accounts",
      "AGI thresholds: lower-income filers get the higher rate (50%/20%/10%)",
      "Up to $1,000 single, $2,000 MFJ",
      "Form 8880 calculates",
      "Common miss: people who qualify don't realize they do",
    ],
  },
  {
    id: "premium-tax-credit-form-8962-marketplace",
    category: "education",
    title:
      "Premium Tax Credit (Form 8962): Why Marketplace Insurance Triggers Tax Forms — and How to Avoid Owing",
    slide: {
      eyebrow: "TAX CREDITS",
      headline1: "8962 + 1095-A.",
      headline2: "Reconcile.",
      badgeTop: "MARKETPLACE",
      badgeCenter: "1095-A",
      badgeBottom: "REQUIRED",
      subhead1: "Marketplace health insurance comes with a",
      subhead2: "tax-time reconciliation everyone forgets.",
    },
    keyAngles: [
      "Marketplace plans use advance payments of premium tax credit (APTC)",
      "Form 1095-A from marketplace; Form 8962 reconciles APTC vs actual",
      "If income was higher than estimated: you owe back the excess credit",
      "If lower: you get additional credit",
      "Common mistake: filing without 1095-A or skipping 8962 — IRS rejects/holds refund",
    ],
  },

  // ── Education / authority — broader IRS topics ──────────────────
  {
    id: "what-the-irs-actually-checks-in-an-audit",
    category: "education",
    title:
      "What the IRS Actually Checks in an Audit — and the Three Things They Almost Always Want",
    slide: {
      eyebrow: "TAX EDUCATION",
      headline1: "Audit Reality.",
      headline2: "What They Want.",
      badgeTop: "DOCS",
      badgeCenter: "DOCS",
      badgeBottom: "DOCS",
      subhead1: "Audits are about documentation, not drama.",
      subhead2: "Here's what the IRS actually pulls.",
    },
    keyAngles: [
      "Three audit types: correspondence (mail), office (in IRS office), field (at your home/office)",
      "Most audits are correspondence — narrow scope, defined deficiency notice",
      "Top audit triggers: unreported income, large/unusual deductions, Schedule C losses, HoH",
      "What to provide: receipts, bank statements, contracts, business mileage logs",
      "When to get help: any field audit, any criminal referral risk",
    ],
  },
  {
    id: "irs-cp2000-underreporter-notice",
    category: "education",
    title:
      "CP2000 'Underreporter' Notice: When the IRS Found Income You Didn't Report",
    slide: {
      eyebrow: "IRS NOTICES",
      headline1: "CP2000.",
      headline2: "Underreporter.",
      badgeTop: "MATCHING",
      badgeCenter: "PROGRAM",
      badgeBottom: "OUTPUT",
      subhead1: "The IRS's automated matching program found",
      subhead2: "income on a 1099 you didn't report.",
    },
    keyAngles: [
      "CP2000 is automated — IRS computers compare your return to all 1099s/W-2s in their system",
      "Common triggers: missed 1099-INT, brokerage 1099-B without basis, side gig 1099-NEC",
      "Not the same as an audit — but ignoring it leads to assessment",
      "Response: agree, partially agree, or disagree (with documentation)",
      "Default if no response: full assessment + penalty",
    ],
  },
  {
    id: "tax-debt-divorce-joint-liability-fallout",
    category: "education",
    title:
      "Tax Debt After Divorce: Joint Liability Doesn't End When the Marriage Does",
    slide: {
      eyebrow: "TAX EDUCATION",
      headline1: "Divorce.",
      headline2: "Joint Debt Stays.",
      badgeTop: "EVEN",
      badgeCenter: "AFTER",
      badgeBottom: "DIVORCE",
      subhead1: "A divorce decree assigns the debt between you —",
      subhead2: "but the IRS doesn't sign the decree.",
    },
    keyAngles: [
      "Joint return = joint and several liability — IRS can collect 100% from either spouse",
      "Divorce decree assigning debt to one spouse is binding between them, not against IRS",
      "Innocent spouse relief (Form 8857) is the IRS-side path",
      "Injured spouse (Form 8379) protects YOUR refund from spouse's separate debt (student loans, child support, prior tax)",
      "Best practice during divorce: don't sign joint return if there's any concern; MFS protects",
    ],
  },
];

module.exports = { SEEDS };
