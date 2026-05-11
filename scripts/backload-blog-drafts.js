"use strict";

// Backloader — pre-writes blog drafts from the source corpus (Wynn
// 82-day calendar, Leo Collins teleprompter scripts, podcast FAQs,
// blog FAQ notes) so the daily bot has a queue to pull from.
//
// Each draft is written as a standalone JSON file under
// `scripts/blog-drafts/`. The daily bot picks one off the top of the
// queue (oldest pending first), renders the image, prepends to
// blogData.js, builds, deploys, emails. After a successful post the
// draft is moved to `scripts/blog-drafts/posted/`.
//
// This script is idempotent — if a draft already exists for an id it
// is left alone (operator can hand-edit). Run again to add more.

const fs = require("fs");
const path = require("path");

const DRAFTS_DIR = path.resolve(__dirname, "blog-drafts");
fs.mkdirSync(DRAFTS_DIR, { recursive: true });
fs.mkdirSync(path.join(DRAFTS_DIR, "posted"), { recursive: true });

// ── Drafts ────────────────────────────────────────────────────────
//
// Categories track the schedule slots the user named:
//   "enforcement-doc"  — Monday slot (notices, forms, IRS process)
//   "relief-type"      — Tuesday slot (CNC, OIC, installment, etc)
//   "current-event"    — Wednesday slot (web-search-driven)
//   "success-story"    — Thursday slot (waiting on case list)
//   "education"        — Friday rotation; broad explainer
//
// Each draft is brand-agnostic on the body except for the brand
// closing paragraph — the daily bot interpolates the brand name and
// flips the image: field on/off when it picks the draft up.

const DRAFTS = [
  {
    category: "enforcement-doc",
    sourceNotes:
      "82-day calendar Day 2 'What Happens If You Haven't Filed in Years' + podcast FAQ on unfiled returns.",
    id: "what-is-a-substitute-for-return-sfr-and-why-it-hurts",
    title:
      "What Is a Substitute for Return (SFR) — and Why an IRS-Filed Return Is Almost Always Worse Than Your Own",
    teaser:
      "If you stop filing, the IRS doesn't stop. They file for you — usually with zero deductions and the worst possible filing status. Here's what an SFR actually is, what it costs, and how to undo one.",
    slide: {
      eyebrow: "IRS COLLECTIONS",
      headline1: "Substitute for",
      headline2: "Return.",
      badgeTop: "WHAT IT",
      badgeCenter: "COSTS",
      badgeBottom: "YOU",
      subhead1: "When you don't file, the IRS files for you —",
      subhead2: "and they don't take your deductions.",
    },
    body: [
      `<p><em>Quick note:</em> This article is general information, not tax or legal advice. SFR procedure varies by year and circumstance — but the underlying mechanics below are consistent across cases.</p>`,
      `<h2>What an SFR actually is</h2>`,
      `<p>If you've had a balance due (or wages reported) for a year you didn't file, the IRS doesn't forget. After enough time passes — typically 2–3 years from the original due date — the IRS can prepare a return on your behalf. That's a Substitute for Return, or SFR.</p>`,
      `<p>The SFR pulls together the income the IRS already has on file from third-party reporting: W-2s, 1099s, K-1s, bank interest, brokerage proceeds, anything reported under your SSN. They run that income through the calculation and send you a bill.</p>`,
      `<h2>Why an SFR is almost always worse than your own return</h2>`,
      `<p>The IRS's job in preparing an SFR isn't to find your best outcome. It's to assess a tax based on what they can prove. So:</p>`,
      `<ul>`,
      `<li><strong>You get filing status "Single" or "MFS" by default.</strong> Even if you're married filing jointly, head of household, or qualifying surviving spouse — none of which the IRS knows from third-party reporting.</li>`,
      `<li><strong>You get the standard deduction at most.</strong> Mortgage interest, state taxes, charitable contributions, medical expenses — none of those reach the IRS through third-party reporting, so none of those reach the SFR.</li>`,
      `<li><strong>You get zero credits.</strong> Child tax credit, dependent care credit, education credits, Earned Income Credit — all gone unless you file your own return claiming them.</li>`,
      `<li><strong>You get gross sales price as basis.</strong> If you sold stock or crypto, the IRS sees the proceeds (1099-B) but often not your cost basis. Without basis, the entire sale becomes taxable gain.</li>`,
      `</ul>`,
      `<p>The combined effect can easily double or triple what you'd actually owe if you'd filed yourself. The IRS doesn't care that the number is wrong from your perspective. They care that the number is defensible from theirs.</p>`,
      `<h2>What happens after the SFR is assessed</h2>`,
      `<p>Once the SFR posts to your account, it triggers the standard collection cascade — CP14, CP501, CP503, CP504, LT11. Your CSED (Collection Statute Expiration Date — the IRS has 10 years from assessment to collect) starts running from the SFR assessment date, not your original due date.</p>`,
      `<p>The IRS can also start collection enforcement: liens, levies, wage garnishment. The SFR is fully assessed tax in the eyes of the law until you replace it with your own correct return.</p>`,
      `<h2>How to undo an SFR</h2>`,
      `<p>The good news: you can almost always supersede an SFR by filing your own return for that year. The IRS calls this an "audit reconsideration" or, depending on timing, a "post-assessment original return." Either way, the steps are:</p>`,
      `<ol>`,
      `<li>Gather every document for that tax year — W-2s, 1099s, mortgage interest statements, donation records, anything that supports deductions or credits.</li>`,
      `<li>Prepare a complete, accurate Form 1040 for the year (don't use the current year's form — use the form from the year being filed).</li>`,
      `<li>Mark it clearly as a replacement for the SFR (a written request along with the return helps).</li>`,
      `<li>Mail it to the address that processes audit reconsiderations or the address on the most recent SFR notice.</li>`,
      `</ol>`,
      `<p>If your real liability is lower than the SFR, the IRS will adjust the assessment. You may not get a refund (the statute of limitations on refund claims is generally 3 years from the original due date), but you'll stop the bleeding.</p>`,
      `<h2>Common mistakes</h2>`,
      `<ul>`,
      `<li><strong>Ignoring the SFR notice.</strong> Once the assessment is final, undoing it requires more steps than addressing it during the proposal stage.</li>`,
      `<li><strong>Filing the wrong year's form.</strong> Use the actual prior-year form. Tax brackets, standard deductions, and credits all differ by year.</li>`,
      `<li><strong>Filing without supporting records.</strong> The IRS won't reverse an SFR just because you wrote a smaller number — they want the documentation behind it.</li>`,
      `<li><strong>Assuming "I never got the SFR notice" is a defense.</strong> Last-known-address rules apply. If the IRS sent it to where you used to live, that still counts as delivered.</li>`,
      `</ul>`,
      `<h2>The bigger lesson</h2>`,
      `<p>SFRs are the IRS's way of saying: we'd rather you file. Even a late-filed return with a balance due is a better starting point than letting the IRS guess. If you have unfiled years, the cheapest move is filing them yourself before the IRS takes the first crack.</p>`,
      `<h2>How {brand} can help</h2>`,
      `<p>If you've received an SFR notice, you have an SFR already on your account, or you have multiple unfiled years and are not sure where to start, {brand} can prepare the missing returns, supersede SFRs where it helps, and coordinate the right resolution path for the resulting balance. Many cases that look catastrophic at first end up significantly more manageable once a real return replaces the IRS's version.</p>`,
      `<p><strong>Bottom line:</strong> The IRS files SFRs the way they always do — with the math that hurts you most. Replacing it with your own return is one of the highest-leverage moves available in tax debt resolution.</p>`,
    ],
  },

  {
    category: "education",
    sourceNotes:
      "Blog FAQ #5 (W-2/1099 basics) + podcast FAQ #11 (Difference between 1099 and W2). Targets the 'why I owe every year' audience.",
    id: "w2-vs-1099-tax-difference-why-1099-workers-owe-every-april",
    title:
      "W-2 vs. 1099: Why 1099 Workers End Up Owing Every April (and How to Stop It)",
    teaser:
      "If you switched from a W-2 job to 1099 work and got a tax bill that felt like a punch in the gut, you're not alone. Here's why the IRS treats the two completely differently — and what to set up before next year so it doesn't happen again.",
    slide: {
      eyebrow: "TAX EDUCATION",
      headline1: "W-2 vs. 1099.",
      headline2: "Why You Owe.",
      badgeTop: "SELF-EMPLOY",
      badgeCenter: "15.3%",
      badgeBottom: "TAX",
      subhead1: "1099 income skips withholding entirely —",
      subhead2: "the bill comes due in April.",
    },
    body: [
      `<p><em>Quick note:</em> This article is general information about how W-2 and 1099 income are taxed differently. Specific situations — multi-state, mixed income, business entity choices — can change the math significantly.</p>`,
      `<h2>The mechanical difference</h2>`,
      `<p>When you work as a W-2 employee, your employer withholds federal income tax, Social Security, and Medicare from each paycheck and sends those amounts to the IRS on your behalf. By the end of the year, you've already paid in roughly what you owe (sometimes more, sometimes less, depending on how your W-4 is set up).</p>`,
      `<p>When you work as a 1099 contractor, none of that happens. The company paying you sends you the gross amount, reports it to the IRS on a 1099-NEC, and treats you as a separate small business. <strong>You're responsible for paying your own income tax, plus self-employment tax, throughout the year.</strong></p>`,
      `<h2>The self-employment tax surprise</h2>`,
      `<p>This is the part most newly-1099 workers miss. Self-employment tax is the contractor version of the Social Security and Medicare tax that gets split between employer and employee on a W-2. When you're 1099, you pay both halves — that's <strong>15.3% on the first $168,600 of net self-employment income</strong> (2024 figures; the cap rises annually), plus 2.9% on the rest, plus an additional 0.9% Medicare surtax above $200,000.</p>`,
      `<p>That's on top of whatever your regular federal income tax bracket is. So a 1099 worker in the 22% federal bracket who didn't make estimated payments is looking at roughly 37% combined — not counting state tax — by the time April rolls around.</p>`,
      `<h2>Why the bill is bigger than the math suggests</h2>`,
      `<p>Two amplifiers compound the surprise:</p>`,
      `<ul>`,
      `<li><strong>The income looks bigger than it is.</strong> A $100,000 1099 contract feels like more than a $100,000 W-2 salary — but after self-employment tax and federal/state income tax, take-home is often comparable or lower than the equivalent W-2 number.</li>`,
      `<li><strong>The penalty for not paying quarterly stacks on top.</strong> The IRS expects you to pay estimated tax four times a year if you'll owe $1,000 or more. Skipping those payments triggers an underpayment penalty, calculated quarter-by-quarter at the federal short-term rate plus 3%.</li>`,
      `</ul>`,
      `<h2>What to set up before next year</h2>`,
      `<p>Three changes prevent the April surprise:</p>`,
      `<ol>`,
      `<li><strong>Set aside a percentage from each invoice.</strong> A reasonable starting point is 25–30% in a separate savings account. Adjust based on your bracket and state.</li>`,
      `<li><strong>Make quarterly estimated payments.</strong> Use Form 1040-ES. Due dates are roughly April 15, June 15, September 15, and January 15 of the following year. Pay through IRS Direct Pay (free) or EFTPS.</li>`,
      `<li><strong>Track deductible business expenses.</strong> Home office, mileage, equipment, software, professional development — all reduce net self-employment income. Bad recordkeeping is what turns a manageable tax situation into a recurring problem.</li>`,
      `</ol>`,
      `<h2>If you also have W-2 income</h2>`,
      `<p>Many 1099 workers have a side hustle on top of a day job. The W-2 withholding may not be enough to cover the additional 1099 income's tax. Two ways to fix it:</p>`,
      `<ul>`,
      `<li>Make estimated payments on the 1099 income.</li>`,
      `<li>Submit a new W-4 to your W-2 employer asking for additional withholding (line 4(c)). Withholding is treated as paid evenly throughout the year, which can avoid underpayment penalties more cleanly than estimated payments alone.</li>`,
      `</ul>`,
      `<h2>The S-corp question (briefly)</h2>`,
      `<p>If your 1099 income is consistent and significant — generally $50,000+ in net profit per year — converting your business to an S-corporation can reduce self-employment tax meaningfully. The trade-off is real overhead: payroll, separate tax filings, reasonable-compensation rules. This decision is case-specific and worth a real conversation with a tax professional, not a TikTok video.</p>`,
      `<h2>If you're already in the hole</h2>`,
      `<p>If you owe for a prior 1099 year and didn't make estimated payments, the IRS treats that balance like any other tax debt. You have the same resolution paths available: payment plans, hardship status, Offer in Compromise. The fix going forward is the same regardless of how big the back balance is — set up estimated payments so next year doesn't add to the pile.</p>`,
      `<h2>How {brand} can help</h2>`,
      `<p>If you have multiple years of 1099 returns to clean up, an unpaid balance from prior years, or you want to set up the right estimated-payment plan and avoid this becoming a recurring problem, {brand} can help on both fronts — resolving what's behind you and structuring what's ahead. Tax debt almost always has a planning problem behind it; fixing the planning is what makes the resolution stick.</p>`,
      `<p><strong>Bottom line:</strong> 1099 income isn't worse than W-2 income — it just needs different plumbing. Set up the plumbing and the April surprise stops happening.</p>`,
    ],
  },

  {
    category: "relief-type",
    sourceNotes:
      "Podcast FAQ on resolution programs + Leo Collins module on collection options. Frames CNC as a real but underused option.",
    id: "irs-currently-not-collectible-cnc-status-explained",
    title:
      "Currently Not Collectible: How the IRS's 'We'll Wait' Status Actually Works",
    teaser:
      "If you owe the IRS but paying anything would prevent you from covering rent, food, and utilities, there's a status that pauses collection — without requiring you to pay a dollar. Here's what Currently Not Collectible is, who qualifies, and what it costs.",
    slide: {
      eyebrow: "TAX RELIEF",
      headline1: "Currently Not",
      headline2: "Collectible.",
      badgeTop: "STATUS",
      badgeCenter: "53",
      badgeBottom: "CNC HARDSHIP",
      subhead1: "When paying would cause real hardship,",
      subhead2: "the IRS can pause collection — but not interest.",
    },
    body: [
      `<p><em>Quick note:</em> This article is general information about CNC status, not tax or legal advice. Eligibility depends on a complete review of your income, expenses, and assets — the framework below shows how the IRS thinks, not whether you specifically qualify.</p>`,
      `<h2>What "Currently Not Collectible" actually means</h2>`,
      `<p>If you genuinely cannot pay the IRS without preventing yourself from meeting basic living expenses, the IRS can place your account in <strong>Currently Not Collectible</strong> — sometimes called "Status 53" or CNC hardship. What that does:</p>`,
      `<ul>`,
      `<li><strong>Active collection stops.</strong> No bank levies, no wage garnishments, no asset seizures while you're in CNC.</li>`,
      `<li><strong>The debt does not go away.</strong> Your balance, plus interest and any accrued penalties, continues to grow in the background. CNC pauses collection — it doesn't forgive anything.</li>`,
      `<li><strong>The IRS reviews your status periodically.</strong> If your income improves, they can move you back into active collection.</li>`,
      `<li><strong>The collection statute keeps running.</strong> The IRS generally has 10 years from assessment to collect a tax debt (the CSED). Time spent in CNC counts toward that 10 years — meaning if your situation doesn't improve, the debt can eventually expire while you're still in CNC.</li>`,
      `</ul>`,
      `<h2>Who qualifies (in IRS terms)</h2>`,
      `<p>The IRS uses national and local "Allowable Living Expense" standards to decide what counts as a reasonable monthly expense. The basic test is:</p>`,
      `<p><strong>Monthly income, minus allowable living expenses, equals what the IRS thinks you can pay them. If that number is zero or negative, you're a CNC candidate.</strong></p>`,
      `<p>Allowable expenses include national standards for food, clothing, personal care, and out-of-pocket healthcare; local standards for housing and utilities (varies by county); local transportation standards (varies by region); and certain other necessary expenses (court-ordered payments, child support, life-saving medical needs).</p>`,
      `<p>The IRS does not consider every actual expense allowable — luxury items, voluntary retirement contributions beyond a baseline, and some lifestyle expenses get pulled out of the calculation even if you actually pay them.</p>`,
      `<h2>What you have to provide</h2>`,
      `<p>To request CNC, you typically need to submit Form 433-F (Collection Information Statement) or Form 433-A (the longer version) showing:</p>`,
      `<ul>`,
      `<li>Income from all sources (pay stubs, 1099 records, benefit statements)</li>`,
      `<li>Bank account balances and recent statements</li>`,
      `<li>Asset values (home equity, vehicles, retirement accounts)</li>`,
      `<li>Monthly living expenses (rent/mortgage, utilities, food, healthcare, transportation)</li>`,
      `<li>Court orders, medical bills, or other special circumstances</li>`,
      `</ul>`,
      `<p>The IRS will compare your stated expenses to their allowable standards and may ask for supporting documentation. The numbers have to be defensible — overstating expenses to make CNC fit is one of the fastest ways to disqualify yourself.</p>`,
      `<h2>What CNC doesn't do</h2>`,
      `<ul>`,
      `<li><strong>It doesn't release a tax lien.</strong> If the IRS already filed a Notice of Federal Tax Lien, CNC doesn't make that go away. The lien stays in place and continues to attach to property until the underlying debt is resolved or expires.</li>`,
      `<li><strong>It doesn't stop interest.</strong> Interest compounds daily on the unpaid balance for as long as it exists.</li>`,
      `<li><strong>It doesn't refund seized money.</strong> If the IRS already levied your bank account or paycheck before CNC was granted, those funds typically don't come back.</li>`,
      `</ul>`,
      `<h2>CNC vs. an Offer in Compromise</h2>`,
      `<p>People sometimes confuse the two. The difference:</p>`,
      `<ul>`,
      `<li><strong>CNC</strong> says: "I can't pay you anything right now. Wait." The full debt remains.</li>`,
      `<li><strong>Offer in Compromise</strong> says: "I can pay you a portion, and we agree to call it square." The accepted amount settles the debt for less than the full balance.</li>`,
      `</ul>`,
      `<p>Some taxpayers cycle from CNC into an OIC when their financial picture stabilizes enough to make a credible offer. Others stay in CNC long-term and ride out the CSED. Which path makes sense depends entirely on the specifics.</p>`,
      `<h2>The downside to know about</h2>`,
      `<p>CNC isn't free of cost. The interest meter continues. Some taxpayers in CNC for several years see the balance grow significantly even though they're not paying anything. If the CSED is far away, that growth matters; if the CSED is close, it doesn't, because the whole thing expires anyway.</p>`,
      `<p>The other downside: CNC can flag you for periodic re-review. The IRS will look at your filed returns each year. A jump in income — even one good year — can move you out of CNC and into an installment agreement faster than expected.</p>`,
      `<h2>How {brand} can help</h2>`,
      `<p>CNC is one of the most effective options for taxpayers in genuine hardship, but it's also one of the most paperwork-heavy. Getting the financial statement right, mapping your real expenses to the IRS's allowable categories, and presenting the case in a way that the IRS accepts the first time — that's where {brand} can make the difference between an approval and an extended back-and-forth. If you authorize us, we communicate with the IRS directly so you don't have to navigate the financial-disclosure process alone.</p>`,
      `<p><strong>Bottom line:</strong> If you're in real hardship and the IRS is breathing down your neck, CNC is a real, named option that's specifically designed for your situation. It's not a stigma and it's not a trick — it's a recognized status that millions of taxpayers use every year.</p>`,
    ],
  },

  {
    category: "relief-type",
    sourceNotes:
      "Podcast FAQ on OIC + Wynn 82-day calendar 'Myth Bust' content type. Counters the 'pennies on the dollar' marketing.",
    id: "offer-in-compromise-pennies-on-the-dollar-myth-vs-reality",
    title:
      "Offer in Compromise: What 'Pennies on the Dollar' Actually Means (and What It Doesn't)",
    teaser:
      "You've seen the late-night ads. You've heard the radio promises. Here's what an Offer in Compromise actually requires, who actually gets approved, and the difference between an OIC and an OIC pitch.",
    slide: {
      eyebrow: "TAX RELIEF",
      headline1: "Offer in",
      headline2: "Compromise.",
      badgeTop: "MYTH",
      badgeCenter: "VS",
      badgeBottom: "REALITY",
      subhead1: "OICs are real. Pennies-on-the-dollar guarantees",
      subhead2: "are not.",
    },
    body: [
      `<p><em>Quick note:</em> This article is general information about how Offers in Compromise work, not tax or legal advice. OIC eligibility is highly fact-specific — the framework below shows how the IRS evaluates an offer, not whether yours specifically would be accepted.</p>`,
      `<h2>What an Offer in Compromise actually is</h2>`,
      `<p>An Offer in Compromise (OIC) is a real IRS program that lets qualifying taxpayers settle their tax debt for less than the full amount owed. It's not a marketing gimmick. The IRS's own pre-qualifier tool lives on irs.gov, and several thousand offers are accepted every year.</p>`,
      `<p>What it isn't: a default outcome for anyone with tax debt. The IRS accepts an offer when paying the full balance through installments or asset liquidation would cause genuine financial hardship — and when the offered amount is at least equal to what the IRS could realistically collect from you over the remaining collection statute.</p>`,
      `<h2>The math the IRS actually uses</h2>`,
      `<p>The IRS calculates what they call your <strong>Reasonable Collection Potential (RCP)</strong>. The formula:</p>`,
      `<p style="padding-left: 16px;"><strong>RCP = (net realizable equity in your assets) + (future income for a defined period × disposable monthly income)</strong></p>`,
      `<p>If your offer is at least RCP, the IRS will generally accept it. If it's below RCP, they generally won't — regardless of how compelling your story is.</p>`,
      `<ul>`,
      `<li><strong>Net realizable equity</strong> means the quick-sale value of your assets (typically 80% of fair market value) minus what you owe on them. Real estate equity, vehicle equity, retirement accounts, business assets — all counted.</li>`,
      `<li><strong>Disposable monthly income</strong> is your monthly income minus allowable living expenses (the same standards used for CNC). The IRS multiplies this by 12 (for a "Lump Sum Cash" offer) or 24 (for a "Periodic Payment" offer).</li>`,
      `</ul>`,
      `<h2>Why most offers get rejected</h2>`,
      `<p>The IRS rejects roughly 60–65% of OICs in any given year. The most common reasons:</p>`,
      `<ul>`,
      `<li><strong>The math doesn't support the offer.</strong> Taxpayers (or unscrupulous "tax debt resolution" companies) submit offers that are well below the calculated RCP. The IRS rejects those by formula.</li>`,
      `<li><strong>The taxpayer isn't compliant.</strong> All required tax returns must be filed, current-year withholding or estimated payments must be on track, and federal employment tax obligations must be current. An OIC won't move forward if any of those are off.</li>`,
      `<li><strong>The financial disclosure is incomplete or inconsistent.</strong> Form 433-A(OIC) and 433-B(OIC) require detailed financial information. Numbers that don't match supporting documents trigger rejection.</li>`,
      `<li><strong>Asset values are wrong.</strong> Underestimating your home's value, leaving out a vehicle, missing a retirement account — any of these can sink an offer when the IRS verifies.</li>`,
      `</ul>`,
      `<h2>What the application requires</h2>`,
      `<ul>`,
      `<li><strong>Form 656</strong> — the offer itself.</li>`,
      `<li><strong>Form 433-A(OIC)</strong> — individual financial information statement. Long form, lots of documentation.</li>`,
      `<li><strong>Form 433-B(OIC)</strong> — business financial information (if applicable).</li>`,
      `<li><strong>Application fee</strong> — currently $205 (waived for low-income certified applicants).</li>`,
      `<li><strong>Initial payment</strong> — depending on offer type, either 20% of the lump-sum offer or the first periodic payment.</li>`,
      `<li><strong>Documentation</strong> — bank statements, pay stubs, mortgage statements, vehicle titles, retirement account statements, supporting medical/court records.</li>`,
      `</ul>`,
      `<p>The application fee and initial payment are <strong>non-refundable</strong> if the offer is rejected. The IRS keeps both and applies them to your tax debt.</p>`,
      `<h2>How long it actually takes</h2>`,
      `<p>OIC review typically takes <strong>6 to 12 months</strong>. During that time, collection on the offered debt is paused, but interest continues to accrue. If accepted, you have specific timelines to make the rest of the agreed payment (5 months for lump sum, up to 24 months for periodic).</p>`,
      `<p>One catch: for the next 5 years after acceptance, you have to stay in compliance — file all returns on time, pay all taxes when due. Default during that window and the IRS can revive the original debt.</p>`,
      `<h2>Who actually qualifies</h2>`,
      `<p>The OIC program is best fit for taxpayers who:</p>`,
      `<ul>`,
      `<li>Have a real tax debt (often $10,000+, though smaller balances can qualify)</li>`,
      `<li>Have limited equity in assets relative to the debt</li>`,
      `<li>Have ongoing income that's not significantly above necessary expenses</li>`,
      `<li>Are current on filings and withholding/estimated payments</li>`,
      `<li>Don't expect a major financial improvement (inheritance, settlement, business windfall) in the near term</li>`,
      `</ul>`,
      `<p>If you have substantial home equity, a paid-off vehicle, healthy retirement balances, or income that comfortably exceeds allowable expenses — an OIC is probably not your fit. The math won't work and the application fee will be forfeit.</p>`,
      `<h2>What to be skeptical of</h2>`,
      `<ul>`,
      `<li><strong>"We can settle your taxes for pennies on the dollar — guaranteed."</strong> No one can guarantee an OIC outcome. If they're guaranteeing it without seeing your financial picture, they're selling marketing, not tax help.</li>`,
      `<li><strong>"$10,000 fee paid up front for OIC representation."</strong> Some firms collect large upfront fees, then submit weak applications that get rejected. The application fee and initial payment are non-refundable to the IRS; the firm's fee is non-refundable to them.</li>`,
      `<li><strong>"You qualify — we just need your retainer."</strong> Real OIC qualification requires a thorough financial review, not a sales call.</li>`,
      `</ul>`,
      `<h2>How {brand} can help</h2>`,
      `<p>If you've reviewed the IRS's pre-qualifier tool and it suggests you may be a candidate, or if the new IRS Tax Debt Help tool pointed you toward an OIC — the next step is a real financial review against the IRS's collection-potential math. {brand} can run those numbers honestly: if an OIC fits your situation, we'll prepare the application correctly the first time; if it doesn't fit, we'll tell you what does. We'd rather lose the work than charge you for an offer the IRS will reject.</p>`,
      `<p><strong>Bottom line:</strong> Offer in Compromise is real. The math is also real. Anyone selling OIC outcomes without reviewing your specific Reasonable Collection Potential is selling something else.</p>`,
    ],
  },

  {
    category: "enforcement-doc",
    sourceNotes:
      "Leo Collins Episode 4 (Liens, levies, garnishments) + podcast FAQ #9 (How collection gets more serious).",
    id: "wage-garnishment-vs-bank-levy-what-the-irs-actually-does",
    title:
      "Wage Garnishment vs. Bank Levy: What the IRS Actually Does to Collect — and What Stops It",
    teaser:
      "Both pull money out of your control. They work very differently. Here's what triggers each one, what they take, what they leave behind, and the specific actions that actually stop them.",
    slide: {
      eyebrow: "IRS COLLECTIONS",
      headline1: "Wage Garnishment",
      headline2: "vs. Bank Levy.",
      badgeTop: "WHAT IT",
      badgeCenter: "TAKES",
      badgeBottom: "FROM YOU",
      subhead1: "Two enforcement tools. Different mechanics.",
      subhead2: "Different ways out.",
    },
    body: [
      `<p><em>Quick note:</em> This article is general information about how the IRS collects unpaid tax debts, not tax or legal advice. Stopping an active levy or garnishment requires action against specific deadlines that vary by case.</p>`,
      `<h2>The shared trigger</h2>`,
      `<p>Both wage garnishment and bank levy are downstream of the same notice: <strong>LT11 / Letter 1058 — Final Notice of Intent to Levy and Notice of Your Right to a Hearing.</strong> Once that notice has been delivered and 30 days have passed without a Collection Due Process (CDP) hearing request, the IRS has the legal authority to levy.</p>`,
      `<p>If you got an LT11 and didn't request a CDP hearing in time, the IRS can issue a levy without further warning. The form they use is <strong>Form 668-W</strong> for wage garnishments and <strong>Form 668-A</strong> for bank levies. Both go to a third party — your employer or your bank — not to you.</p>`,
      `<h2>How a wage garnishment works</h2>`,
      `<p>Form 668-W is delivered to your employer. It's a <strong>continuous levy</strong> — the IRS doesn't have to send a new one each pay period. Once your employer receives it, they're legally required to redirect a portion of every paycheck to the IRS until the debt is paid in full or the levy is released.</p>`,
      `<p>The IRS doesn't take all of your paycheck. Instead, your employer is required to leave you a small amount based on a published exemption table that depends on your filing status, dependents, and pay frequency. The leftover amount is typically far below what most households need to operate. Above that floor, the IRS gets everything else.</p>`,
      `<p>Your employer doesn't have discretion. If they fail to comply, they can become personally liable for the amount they should have remitted. That's why they don't negotiate.</p>`,
      `<h2>How a bank levy works</h2>`,
      `<p>Form 668-A goes to your bank. Unlike wage garnishment, it's a <strong>one-time freeze</strong>. The bank is required to immediately freeze the funds in your account up to the amount of the levy and hold them for <strong>21 days</strong>. After 21 days, those funds are sent to the IRS.</p>`,
      `<p>Three things to know about bank levies:</p>`,
      `<ul>`,
      `<li><strong>Only the funds in the account at the moment of receipt are levied.</strong> Money deposited after the bank receives the levy is not captured by that levy. (The IRS can issue another levy later, but it's a separate action.)</li>`,
      `<li><strong>The 21-day hold is a window to act.</strong> If you can negotiate a release with the IRS during those 21 days, the bank returns the funds to you. After day 22, the money has been sent.</li>`,
      `<li><strong>Joint accounts are fully exposed.</strong> If your name is on a joint account, the IRS can levy the entire balance regardless of whose money it actually is. Recovery for a non-debtor co-owner is possible but slow.</li>`,
      `</ul>`,
      `<h2>What stops each one</h2>`,
      `<p>Both wage garnishment and bank levy can be released by the IRS — but the path to release depends on getting the underlying tax debt into a recognized resolution status. The IRS doesn't release levies because you ask nicely; they release them because you're now in an installment agreement, CNC, or actively negotiating an OIC.</p>`,
      `<h3>What stops a wage garnishment</h3>`,
      `<ul>`,
      `<li><strong>Pay the balance in full.</strong> Levy releases automatically.</li>`,
      `<li><strong>Set up an installment agreement.</strong> Once approved, the IRS issues a release to your employer.</li>`,
      `<li><strong>Get into Currently Not Collectible.</strong> CNC requires a financial review proving hardship; if approved, the levy is released.</li>`,
      `<li><strong>Demonstrate the levy itself causes financial hardship.</strong> The IRS can release a levy that's preventing you from meeting basic living expenses, even before a formal resolution is in place. This is fact-specific and requires good documentation.</li>`,
      `</ul>`,
      `<h3>What stops a bank levy</h3>`,
      `<ul>`,
      `<li><strong>Same resolution paths as garnishment.</strong> Installment agreement, CNC, or hardship release.</li>`,
      `<li><strong>Filing a CDP appeal during the 30-day window after LT11 prevents the levy entirely.</strong> If the LT11 deadline hasn't passed yet and a levy hasn't been issued, requesting a hearing on Form 12153 freezes collection.</li>`,
      `<li><strong>Showing the funds aren't yours (or aren't accessible).</strong> Direct deposits of certain federal benefits (Social Security, VA disability, federal employee retirement) are largely protected. Employer error, bank error, or wrongful levy claims can also reverse a levy.</li>`,
      `</ul>`,
      `<h2>What both have in common</h2>`,
      `<p>Speed matters more than anything. Each day a wage garnishment continues, more of your paycheck is gone. Each day during the bank levy's 21-day hold is a day you can negotiate; after that, the funds are gone. The IRS's automated systems don't slow down for anyone — but human contact, financial documentation, and the right requests can produce releases within days when handled correctly.</p>`,
      `<h2>What not to do</h2>`,
      `<ul>`,
      `<li><strong>Don't quit your job to dodge a wage garnishment.</strong> The IRS will find your next employer, often within weeks. It also disqualifies you from many resolution options.</li>`,
      `<li><strong>Don't move money out of an account that's just been levied.</strong> The bank's freeze prevents withdrawal anyway, and attempting to defeat a levy can have consequences.</li>`,
      `<li><strong>Don't ignore the LT11 if you receive one.</strong> Once the 30-day CDP window closes, the IRS gains levy authority that's much harder to reverse than to prevent.</li>`,
      `</ul>`,
      `<h2>How {brand} can help</h2>`,
      `<p>If you have an active wage garnishment or bank levy — or you've received an LT11 and the 30-day clock is running — {brand} can move quickly. The first step is usually a financial review and an immediate request for release through the appropriate resolution path. Most levies that get released, get released within days of the right paperwork landing on the right desk. The cases that take longer almost always started later than they needed to.</p>`,
      `<p><strong>Bottom line:</strong> A levy isn't the end of the road — it's a forced acceleration of what should have happened earlier. Whether it's a garnishment that's already running or a freeze that's about to send your bank balance to the IRS, every option for stopping it requires the same thing: action measured in hours, not weeks.</p>`,
    ],
  },
];

function writeDraft(draft) {
  const filename = path.join(DRAFTS_DIR, `${draft.id}.json`);
  if (fs.existsSync(filename)) {
    return { skipped: true, filename };
  }
  fs.writeFileSync(filename, JSON.stringify(draft, null, 2), "utf8");
  return { skipped: false, filename };
}

let written = 0;
let skipped = 0;
for (const draft of DRAFTS) {
  const result = writeDraft(draft);
  if (result.skipped) {
    skipped += 1;
    console.log(`[backloader] skipped (exists): ${path.basename(result.filename)}`);
  } else {
    written += 1;
    console.log(`[backloader] wrote: ${path.basename(result.filename)}`);
  }
}

console.log(JSON.stringify({
  draftsDir: DRAFTS_DIR,
  written,
  skipped,
  totalDrafts: DRAFTS.length,
  byCategory: DRAFTS.reduce((acc, d) => {
    acc[d.category] = (acc[d.category] || 0) + 1;
    return acc;
  }, {}),
}, null, 2));
