"use strict";

// Second one-off post — Wednesday's "current event" slot. Topic
// sourced via web search: IRS launched the "Tax Debt Help" online
// tool on April 16, 2026 (IR-2026-53). Reused infrastructure from
// blogger-one-off.js with the npm-run-build step now baked in.
//
// Sources cited inline in the post body:
//   - irs.gov/newsroom/irs-launches-new-online-tool-to-help-taxpayers-resolve-tax-debt
//   - journalofaccountancy.com/news/2026/apr/irs-launches-online-tool-to-help-taxpayers-manage-tax-debt
//   - accountingtoday.com/news/irs-creates-online-tax-debt-tool

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

require("dotenv").config({
  path: path.resolve(__dirname, "..", ".env"),
});

const sharp = require(path.resolve(
  "C:/Users/Admin/Code/WynnTax/client/node_modules/sharp",
));

const WYNN_REPO = "C:/Users/Admin/Code/WynnTax";
const TAG_REPO = "C:/Users/Admin/Code/TaxAdvocateGroup";

const BLOG_ID = "irs-tax-debt-help-online-tool-launched-april-2026";
const TITLE =
  "The IRS Just Launched a 'Tax Debt Help' Online Tool — Here's What It Actually Does";
const TEASER =
  "On April 16, 2026, the IRS rolled out a new online tool that walks taxpayers through their resolution options without asking for an SSN. Here's what it tells you, what it stops short of, and where you still need a person — not a chatbot.";
const SLIDE_EYEBROW = "IRS NEWS — APRIL 2026";
const SLIDE_HEADLINE_LINE_1 = "Tax Debt Help.";
const SLIDE_HEADLINE_LINE_2 = "Now Online.";
const SLIDE_BADGE_TOP = "LAUNCHED";
const SLIDE_BADGE_CENTER = "APR 16";
const SLIDE_BADGE_BOTTOM = "2026";

function buildContentBody(brand) {
  return [
    `<p><em>Quick note:</em> This article is general information about a new IRS tool, not tax or legal advice for your specific situation. The tool described below is a triage resource — it points you toward options but does not actually negotiate with the IRS on your behalf.</p>`,

    `<h2>What the IRS just launched</h2>`,
    `<p>On April 16, 2026 — the day after the filing-season deadline — the IRS rolled out a new online tool called <strong>Tax Debt Help</strong>. The announcement (IR-2026-53) is straightforward: walk taxpayers through a series of questions about their financial situation, and based on their answers, point them at the resolution options that fit. No phone tree, no notice required, no Social Security number needed to use it.</p>`,
    `<p>If you owe back taxes, just got a CP14 notice, or have been putting off dealing with a balance because you didn't know where to start, this tool is meant to be the on-ramp. Here's what it actually does, what it leaves out, and how to think about the three paths it can recommend.</p>`,

    `<h2>What the tool walks you through</h2>`,
    `<p>The Tax Debt Help tool is essentially a guided questionnaire. You answer questions about:</p>`,
    `<ul>`,
    `<li>How much you owe (rough estimate is fine — no exact number required)</li>`,
    `<li>Whether you've filed all required returns</li>`,
    `<li>Your current income and basic financial picture</li>`,
    `<li>Whether you're in active hardship</li>`,
    `</ul>`,
    `<p>Based on those answers, it surfaces the resolution path most likely to apply to you. The IRS is explicit that this is a navigation tool, not a binding application — none of your answers result in an actual installment agreement, hardship status, or settlement until you go through the standard paperwork.</p>`,

    `<h2>The three paths it can recommend</h2>`,
    `<p>The tool's recommendations narrow to three core resolution options the IRS already offers. None of these are new — what's new is having a single front door that helps non-experts figure out which one applies.</p>`,

    `<h3>1. A payment plan (installment agreement)</h3>`,
    `<p>If you can pay the balance off over time but not all at once, the tool typically points to an installment agreement. For balances under $50,000 with all returns filed, the IRS allows a streamlined Online Payment Agreement that doesn't require detailed financial disclosure. Larger balances or non-streamlined cases require Form 433-F or 433-A and a full review of income, assets, and necessary expenses.</p>`,
    `<p>The plan you can afford is usually not the same as the one the IRS will agree to. The agency uses national and local "Allowable Living Expense" standards to decide what counts as a reasonable monthly payment — which is often higher than what feels comfortable. Setting up a plan you can't actually sustain is one of the most common ways people end up in default and back at square one.</p>`,

    `<h3>2. Currently Not Collectible (CNC) status</h3>`,
    `<p>If paying anything would prevent you from meeting basic living expenses, the tool can flag CNC status as the right path. CNC is the IRS's "we'll wait" category — collection activity pauses, but the debt and interest don't go away. To qualify, you generally need to demonstrate that your income covers only allowable expenses, with little or nothing left for the IRS.</p>`,
    `<p>CNC is reviewed periodically. If your income improves, the IRS can move you out of CNC and back into active collection. It's a useful pressure release for genuine hardship situations — not a permanent solution, but a real one.</p>`,

    `<h3>3. Offer in Compromise (OIC)</h3>`,
    `<p>The settle-for-less option. If your assets and future income aren't enough to pay the full debt before the collection statute expires, you may qualify to settle. The tool can flag OIC eligibility based on your inputs, but the actual application is significant: Form 656, Form 433-A(OIC) or 433-B(OIC), supporting documentation, and a non-refundable application fee. The IRS rejects most OICs that come in without the math worked out correctly.</p>`,
    `<p>The IRS's <a href="https://irs.treasury.gov/oic_pre_qualifier/">Offer in Compromise Pre-Qualifier</a> has been online for years; the new Tax Debt Help tool is a friendlier front-end that points qualifying users to it. If the tool says "you may qualify for an Offer in Compromise," that's a starting flag, not a guarantee.</p>`,

    `<h2>The privacy angle (and why it cuts both ways)</h2>`,
    `<p>The IRS's most-touted feature on this tool is that it does not require personally identifiable information. You can use it without entering your name, SSN, or address. That's a real benefit — it lowers the bar for taxpayers who'd otherwise be intimidated about handing data to the IRS just to ask a question.</p>`,
    `<p>The flip side: because the tool isn't authenticated, it doesn't know your actual balance, your filing status, or whether the IRS has already started enforcement on you. You're describing your situation in your own words, and the tool's recommendation is only as good as your description. People often underestimate how much they owe, or don't realize an unfiled year is silently growing the problem. The tool can't catch any of that.</p>`,

    `<h2>Who this tool is best for</h2>`,
    `<ul>`,
    `<li><strong>Newer balances under $50,000.</strong> Streamlined installment agreement is well-suited to the tool's flow.</li>`,
    `<li><strong>People who haven't engaged with the IRS yet.</strong> If you've been putting it off, this is a no-risk first step that won't show up on your IRS account.</li>`,
    `<li><strong>Taxpayers who want to know their options before committing to a path.</strong> Better than guessing or trusting a Google ad.</li>`,
    `</ul>`,

    `<h2>Who needs more than the tool offers</h2>`,
    `<ul>`,
    `<li><strong>Active enforcement (LT11/Letter 1058 received, levies threatened, wage garnishment in progress).</strong> The tool can't pause collection or extend a Collection Due Process deadline. Those need actual filings.</li>`,
    `<li><strong>Multiple unfiled years.</strong> Compliance has to come before any resolution path. The tool will note this; it can't fix it.</li>`,
    `<li><strong>Larger balances or business taxes.</strong> The tool's questions are designed for individual taxpayers with relatively standard situations. Trust fund recovery, payroll tax debt, and high-balance individual cases need professional review.</li>`,
    `<li><strong>Disagreements about the underlying assessment.</strong> The tool assumes the balance is correct. If you think the IRS got the number wrong, that's an audit reconsideration or appeal — a different track entirely.</li>`,
    `</ul>`,

    `<h2>The honest take</h2>`,
    `<p>This is a genuinely useful tool for the right person — someone with a relatively simple situation who has been frozen by not knowing where to start. The IRS is signaling that they want resolution paths to be more visible and accessible, which is good for everyone, especially taxpayers who might otherwise have ignored the problem until enforcement started.</p>`,
    `<p>It's also not a substitute for representation when the situation is actually complicated. The tool tells you which door to walk through. Walking through the door — preparing the right form correctly, handling the IRS's follow-up requests, defending the financial picture you presented — is still the part where most cases succeed or fail.</p>`,

    `<h2>How ${brand} can help</h2>`,
    `<p>If you've used the new tool and it pointed you toward an installment agreement, CNC, or Offer in Compromise — and you want help actually getting it across the finish line — that's where ${brand} comes in. We work with taxpayers through the entire resolution process, from compliance work through final acceptance, including the cases where the IRS pushes back and a tool can't help. If you authorize us and we're engaged, we communicate with the IRS directly so you don't have to.</p>`,
    `<p><strong>Bottom line:</strong> The IRS just made it easier to find the right resolution path. The path itself hasn't changed — and neither have the consequences of waiting. If you've been putting off dealing with a balance, today is a better day to start than yesterday was.</p>`,
    `<p>Sources: IRS announcement at <a href="https://www.irs.gov/newsroom/irs-launches-new-online-tool-to-help-taxpayers-resolve-tax-debt">irs.gov/newsroom/irs-launches-new-online-tool-to-help-taxpayers-resolve-tax-debt</a>. Background coverage at <a href="https://www.journalofaccountancy.com/news/2026/apr/irs-launches-online-tool-to-help-taxpayers-manage-tax-debt/">Journal of Accountancy</a> and <a href="https://www.accountingtoday.com/news/irs-creates-online-tax-debt-tool">Accounting Today</a>.</p>`,
  ];
}

function buildBlogObject({ brand, includeImage }) {
  const obj = {
    id: BLOG_ID,
    title: TITLE,
    ...(includeImage ? { image: `/images/${BLOG_ID}.png` } : {}),
    teaser: TEASER,
    contentTitle: TITLE,
    contentBody: buildContentBody(brand),
  };
  return obj;
}

function formatBlogObjectAsJsLiteral(obj) {
  const lines = [];
  lines.push("  {");
  lines.push(`    id: ${JSON.stringify(obj.id)},`);
  lines.push(`    title:`);
  lines.push(`      ${JSON.stringify(obj.title)},`);
  if (obj.image) {
    lines.push(`    image: ${JSON.stringify(obj.image)},`);
  }
  lines.push(`    teaser:`);
  lines.push(`      ${JSON.stringify(obj.teaser)},`);
  lines.push(`    contentTitle:`);
  lines.push(`      ${JSON.stringify(obj.contentTitle)},`);
  lines.push(`    contentBody: [`);
  for (const item of obj.contentBody) {
    lines.push(`      ${JSON.stringify(item)},`);
  }
  lines.push(`    ],`);
  lines.push(`  },`);
  return lines.join("\n");
}

function prependBlogToFile(filePath, blogObject) {
  const original = fs.readFileSync(filePath, "utf8");
  const marker = "const blogData = [";
  const idx = original.indexOf(marker);
  if (idx < 0) {
    throw new Error(`Could not find "${marker}" in ${filePath}`);
  }
  const insertionPoint = idx + marker.length;
  const literal = formatBlogObjectAsJsLiteral(blogObject);
  const head = original.slice(0, insertionPoint);
  const tail = original.slice(insertionPoint);
  const next = `${head}\n${literal}\n${tail.replace(/^\n/, "")}`;
  fs.writeFileSync(filePath, next, "utf8");
}

function buildSvg() {
  const w = 1200;
  const h = 628;
  const bg = "#0a1733";
  const grid = "#162342";
  const ink = "#f4ead3";
  const accent = "#c8a14a";
  const muted = "#7a8398";
  const gridLines = [];
  for (let x = 60; x < w; x += 60) {
    gridLines.push(
      `<line x1="${x}" y1="0" x2="${x}" y2="${h}" stroke="${grid}" stroke-width="1" />`,
    );
  }
  for (let y = 60; y < h; y += 60) {
    gridLines.push(
      `<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="${grid}" stroke-width="1" />`,
    );
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="${w}" height="${h}" fill="${bg}" />
  <g opacity="0.55">
    ${gridLines.join("\n    ")}
  </g>
  <path d="M 30 30 L 90 30 M 30 30 L 30 90" stroke="${accent}" stroke-width="2" fill="none" opacity="0.6" />
  <path d="M ${w - 30} ${h - 30} L ${w - 90} ${h - 30} M ${w - 30} ${h - 30} L ${w - 30} ${h - 90}" stroke="${accent}" stroke-width="2" fill="none" opacity="0.6" />
  <line x1="80" y1="280" x2="80" y2="380" stroke="${accent}" stroke-width="3" />
  <text x="120" y="232" fill="${accent}"
        font-family="Georgia, 'Times New Roman', serif"
        font-size="20" letter-spacing="6" font-weight="700">${SLIDE_EYEBROW}</text>
  <text x="120" y="320" fill="${ink}"
        font-family="Georgia, 'Times New Roman', serif"
        font-size="72" font-weight="700">${SLIDE_HEADLINE_LINE_1}</text>
  <text x="120" y="402" fill="${accent}"
        font-family="Georgia, 'Times New Roman', serif"
        font-size="72" font-weight="700">${SLIDE_HEADLINE_LINE_2}</text>
  <circle cx="1000" cy="320" r="120" fill="none" stroke="${accent}" stroke-width="1.5" opacity="0.85" />
  <text x="1000" y="288" fill="${muted}" text-anchor="middle"
        font-family="Georgia, 'Times New Roman', serif" font-size="18" letter-spacing="4" font-weight="700">${SLIDE_BADGE_TOP}</text>
  <text x="1000" y="345" fill="${accent}" text-anchor="middle"
        font-family="Georgia, 'Times New Roman', serif" font-size="48" font-weight="700">${SLIDE_BADGE_CENTER}</text>
  <text x="1000" y="375" fill="${muted}" text-anchor="middle"
        font-family="Georgia, 'Times New Roman', serif" font-size="16" letter-spacing="6" font-weight="700">${SLIDE_BADGE_BOTTOM}</text>
  <text x="120" y="465" fill="${muted}"
        font-family="Georgia, 'Times New Roman', serif" font-size="22">A new IRS tool walks taxpayers through their</text>
  <text x="120" y="495" fill="${muted}"
        font-family="Georgia, 'Times New Roman', serif" font-size="22">resolution options without asking for an SSN.</text>
  <text x="120" y="${h - 50}" fill="${accent}"
        font-family="Georgia, 'Times New Roman', serif" font-size="20" letter-spacing="4" font-weight="700">WYNN TAX SOLUTIONS</text>
  <text x="465" y="${h - 50}" fill="${muted}"
        font-family="Georgia, 'Times New Roman', serif" font-size="20">|  wynntaxsolutions.com</text>
</svg>`;
}

async function renderPng(svg, outPath) {
  await sharp(Buffer.from(svg, "utf8"))
    .png({ quality: 95 })
    .toFile(outPath);
}

function buildBrand(repoDir) {
  return execFileSync("npm", ["run", "build"], {
    cwd: path.join(repoDir, "client"),
    stdio: "pipe",
    encoding: "utf8",
    maxBuffer: 500 * 1024 * 1024,
    shell: true,
  });
}

function deployBrand(brandKey, commitMsg) {
  return execFileSync(
    "node",
    ["scripts/deploy.js", "deploy", brandKey, commitMsg, "--pull"],
    {
      cwd: "C:/Users/Admin/Code/TagContactBridge",
      stdio: "pipe",
      encoding: "utf8",
      maxBuffer: 200 * 1024 * 1024,
    },
  );
}

async function sendSummaryEmail(summary) {
  const { sendPlainEmail } = require(
    "../packages/shared-services/src/sendgridMailService",
  );
  const subject = `Blog auto-posted: ${summary.id}`;
  const lines = [
    `Topic: ${summary.title}`,
    "",
    `Wynn URL: https://www.wynntaxsolutions.com/tax-news/${summary.id}`,
    `TAG URL: https://www.taxadvocategroup.com/tax-news/${summary.id}`,
    "",
    "Deploy results:",
    `  Wynn:  ${summary.wynnDeploy}`,
    `  TAG:   ${summary.tagDeploy}`,
    "",
    `Image: ${summary.imagePath}`,
  ].join("\n");
  await sendPlainEmail("TAG", {
    personalizations: [
      {
        to: [{ email: "mgray@taxadvocategroup.com" }],
        custom_args: { channel: "blogger-bot", blogId: summary.id },
      },
    ],
    from: { email: "mgray@taxadvocategroup.com", name: "Blogger Bot" },
    reply_to: { email: "mgray@taxadvocategroup.com", name: "Blogger Bot" },
    subject,
    content: [{ type: "text/plain", value: lines }],
  });
}

async function main() {
  const summary = { id: BLOG_ID, title: TITLE };

  // 1. Render image
  const imagePath = path.join(WYNN_REPO, "client", "public", "images", `${BLOG_ID}.png`);
  await renderPng(buildSvg(), imagePath);
  summary.imagePath = imagePath;
  console.log(`[blogger] image written: ${imagePath}`);

  // 2. Mutate blogData.js for both repos
  const wynnBlogPath = path.join(WYNN_REPO, "client", "src", "data", "blogData.js");
  const tagBlogPath = path.join(TAG_REPO, "client", "src", "data", "blogData.js");
  prependBlogToFile(
    wynnBlogPath,
    buildBlogObject({ brand: "Wynn Tax Solutions", includeImage: true }),
  );
  console.log(`[blogger] wynn blogData updated`);
  prependBlogToFile(
    tagBlogPath,
    buildBlogObject({ brand: "Tax Advocate Group", includeImage: false }),
  );
  console.log(`[blogger] tag blogData updated`);

  // 3. Build clients (the deploy CLI doesn't do this — it only commits
  //    + pushes + has EC2 git pull).
  console.log(`[blogger] building wynn client...`);
  buildBrand(WYNN_REPO);
  console.log(`[blogger] wynn build complete`);
  console.log(`[blogger] building tag client...`);
  buildBrand(TAG_REPO);
  console.log(`[blogger] tag build complete`);

  // 4. Deploy
  const commitMsg = `Auto blog: ${BLOG_ID}`;
  try {
    summary.wynnDeploy = "deploying...";
    deployBrand("wynn", commitMsg);
    summary.wynnDeploy = "ok";
    console.log(`[blogger] wynn deploy ok`);
  } catch (err) {
    summary.wynnDeploy = `FAILED: ${err.message}`;
    console.error(`[blogger] wynn deploy failed:`, err.message);
  }
  try {
    summary.tagDeploy = "deploying...";
    deployBrand("tag", commitMsg);
    summary.tagDeploy = "ok";
    console.log(`[blogger] tag deploy ok`);
  } catch (err) {
    summary.tagDeploy = `FAILED: ${err.message}`;
    console.error(`[blogger] tag deploy failed:`, err.message);
  }

  // 5. Email summary
  try {
    await sendSummaryEmail(summary);
    console.log(`[blogger] summary email sent`);
  } catch (err) {
    console.error(`[blogger] email failed:`, err.message);
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
