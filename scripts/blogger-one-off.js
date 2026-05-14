"use strict";

// One-off blogger — produces today's Wynn + TAG blog post. Until the
// daily-cron-scheduled bot is built, this script does the manual
// flow end-to-end:
//   1. holds the canonical blog object (one piece of content)
//   2. renders the Wynn header image as a PNG (SVG -> sharp)
//   3. prepends the entry to BOTH blogData.js files (Wynn keeps the
//      `image:` field; TAG omits it per house style)
//   4. shells out to the existing TagContactBridge deploy script for
//      both brands
//   5. emails mgray@taxadvocategroup.com a summary
//
// Today's pick: the IRS collection-notice sequence (CP14 → LT11).
// Wednesday slot is Current Event; this is two weeks past Tax Day so
// the cascade is timely. All facts are IRS-published — no
// hallucination risk.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

require("dotenv").config({
  path: path.resolve(__dirname, "..", ".env"),
});

const {
  loadSharp,
  npmCommand,
  TAG_REPO,
  TCB_DEPLOY_DIR,
  WYNN_REPO,
} = require("./blogger-paths");

const sharp = loadSharp();

const BLOG_ID = "irs-collection-notice-sequence-after-tax-day";
const TITLE =
  "The IRS Collection Notice Sequence After Tax Day: CP14, CP501, CP503, CP504, and LT11 Explained";
const SLIDE_HEADLINE_LINE_1 = "After Tax Day:";
const SLIDE_HEADLINE_LINE_2 = "The Notices.";
const SLIDE_EYEBROW = "IRS COLLECTION NOTICES";
const SLIDE_BADGE_TOP = "5 NOTICE";
const SLIDE_BADGE_BOTTOM = "SEQUENCE";
const TEASER =
  "If you didn't file or pay by April 15, the IRS doesn't call — they mail. Here's the exact order of the five notices that arrive over the next several months, what each one means, and the one that triggers a 30-day window where stopping the levy gets dramatically harder.";

// Each <p>, <h2>, <ul>, <ol>, etc. is its own array entry in the
// canonical blogData shape. Keep paragraphs short; readers skim.
function buildContentBody(brand) {
  return [
    `<p><em>Quick note:</em> This article is general information, not tax or legal advice. The IRS notice sequence below is the standard automated track for individual taxpayers; specific cases (audits, business returns, state issues) can deviate.</p>`,

    `<h2>You owe and didn't pay by April 15. Now what?</h2>`,
    `<p>The IRS doesn't call you. They don't email. They send physical letters in a specific, predictable order — and they expect you to read every one. Most people don't, which is how a balance you could've handled with one phone call turns into a wage garnishment six months later.</p>`,
    `<p>If you filed on time but didn't pay, or didn't file at all, here's the sequence you're about to get mail from. Each notice in this chain has a specific name, a specific timeline, and a specific level of escalation.</p>`,

    `<h2>The big picture: 5 notices, then enforcement</h2>`,
    `<p>For an individual taxpayer with a balance due, the IRS works through a standard sequence:</p>`,
    `<ol>`,
    `<li><strong>CP14</strong> — First notice. "You owe X."</li>`,
    `<li><strong>CP501</strong> — First reminder. Same balance, accruing.</li>`,
    `<li><strong>CP503</strong> — Second reminder. Tone sharpens.</li>`,
    `<li><strong>CP504</strong> — Notice of Intent to Levy your state tax refund.</li>`,
    `<li><strong>LT11 / Letter 1058</strong> — Final Notice of Intent to Levy and Notice of Your Right to a Hearing.</li>`,
    `</ol>`,
    `<p>The first four are warnings. The fifth one starts a 30-day clock that, if you let it expire, hands the IRS the legal authority to levy your bank accounts, garnish your wages, and seize property. We'll come back to that.</p>`,

    `<h2>CP14: The first notice of balance due</h2>`,
    `<p>This is the IRS's official "you owe us money" letter. It typically arrives 4–6 weeks after the IRS processes your return — so for taxpayers who filed by April 15 with an unpaid balance, CP14 is landing right around now through late May.</p>`,
    `<p>What it includes:</p>`,
    `<ul>`,
    `<li>The tax year and form (e.g., 2025 Form 1040)</li>`,
    `<li>The unpaid balance, broken into tax owed, penalties, and interest</li>`,
    `<li>A deadline to pay in full (usually 21 days from the notice date)</li>`,
    `<li>Payment instructions and online options</li>`,
    `</ul>`,
    `<p><strong>What to do:</strong> Pay if you can. If you can't, this is the cheapest stage to set up an installment agreement or apply for hardship status. The failure-to-pay penalty (0.5% per month) and interest (federal short-term rate plus 3%, compounded daily) are already running, but they're smaller now than they will be at any point going forward.</p>`,

    `<h2>CP501: First reminder</h2>`,
    `<p>If CP14 went unanswered, CP501 arrives roughly 5 weeks later. Same balance, plus another month of penalties and interest. The language stays neutral but the math has gotten worse — on a $10,000 balance, you've added about $50 in penalty plus accrued interest since the last notice.</p>`,
    `<p>CP501 still treats you as a cooperative taxpayer who just needs another nudge. The IRS is signaling: "We see you. We're patient — but we're not infinitely patient."</p>`,
    `<p><strong>What to do:</strong> Same options as CP14 — pay, set up an installment agreement, or apply for Currently Not Collectible if you genuinely can't pay. None of those options have closed. They will close down if you keep ignoring this.</p>`,

    `<h2>CP503: Urgent — second reminder</h2>`,
    `<p>About 5 more weeks after CP501. CP503 escalates the tone. The phrase "Immediate Action Required" appears in larger type. The IRS is now telegraphing that the next step in the chain is enforcement, not another reminder.</p>`,
    `<p>CP503 is also typically when the balance becomes large enough that an Online Payment Agreement (no financial disclosure required, available for balances under $50,000) is the cleanest exit ramp. Set one up at this stage and the chain stops here.</p>`,

    `<h2>CP504: Notice of Intent to Levy State Tax Refund</h2>`,
    `<p>This is the first notice that mentions the word "levy" in big letters. The IRS is telling you that if you don't resolve the balance, they will seize any state tax refund you're owed and apply it to your federal tax debt.</p>`,
    `<p>CP504 sounds scary, and it should. But it's also a narrower threat than people assume — it specifically authorizes the IRS to grab state refunds, not (yet) to levy your bank account or wages. That bigger authority comes from the next letter.</p>`,
    `<p><strong>This is the last warning before the legal process accelerates.</strong> If you've been waiting for "the right time" to deal with the balance, CP504 is the loudest signal you'll get that the right time is now.</p>`,

    `<h2>LT11 / Letter 1058: Final Notice — and a 30-day clock starts</h2>`,
    `<p>This is the most important letter in the chain. LT11 (sometimes labeled Letter 1058) is officially titled <strong>Final Notice of Intent to Levy and Notice of Your Right to a Hearing</strong>. It does two things at once:</p>`,
    `<ul>`,
    `<li><strong>It tells the IRS legal staff they may begin levy action against you in 30 days</strong> — bank accounts, wages, brokerage accounts, business receivables, or other property.</li>`,
    `<li><strong>It tells you that you have 30 days to request a Collection Due Process (CDP) hearing.</strong> Filing the CDP request before the deadline freezes the levy and puts your case in front of an Office of Appeals officer where you can negotiate alternatives.</li>`,
    `</ul>`,
    `<p>That second point is the entire reason this notice matters more than the first four combined. <strong>Once the 30-day window closes without a CDP request, you lose the easiest, cheapest path to stopping the levy.</strong> You still have options afterward, but they're slower, more expensive, and have lower success rates.</p>`,

    `<h2>What "Collection Due Process" actually buys you</h2>`,
    `<p>A CDP hearing is your chance to argue — in front of an independent IRS Appeals officer — that the levy shouldn't proceed for any of several reasons:</p>`,
    `<ul>`,
    `<li>You qualify for an installment agreement and want one set up</li>`,
    `<li>You qualify for Currently Not Collectible status (paying would cause hardship)</li>`,
    `<li>You want to be considered for an Offer in Compromise</li>`,
    `<li>You believe the underlying tax assessment is wrong (limited circumstances)</li>`,
    `<li>You're an innocent or injured spouse</li>`,
    `</ul>`,
    `<p>You don't have to win the hearing. You just have to file the request — Form 12153 — within the 30 days. That alone freezes collection and gets you in front of someone with the authority to negotiate.</p>`,

    `<h2>If the 30 days have already expired</h2>`,
    `<p>You can still request what's called an "equivalent hearing" up to a year after the LT11 date. The downside: an equivalent hearing doesn't freeze collection while it's pending, and you lose the right to take the IRS Appeals decision to Tax Court. It's a real option but a much weaker one.</p>`,
    `<p>You can also still apply for any of the resolution options (installment agreement, CNC, Offer in Compromise) — but you're now negotiating against an active collection backdrop. Bank levies, wage garnishments, and tax liens become real risks during the negotiation.</p>`,

    `<h2>What not to do at any stage</h2>`,
    `<ul>`,
    `<li><strong>Don't ignore the mail.</strong> The IRS treats every notice as legally delivered whether or not you opened it. "I never got it" is not a defense.</li>`,
    `<li><strong>Don't assume calling the 1-800 number on the notice is your only path.</strong> The phone agents can take payments and set up basic installment agreements, but they cannot resolve complex situations or override automated collection.</li>`,
    `<li><strong>Don't wait for the LT11 to act.</strong> The cheapest, fastest resolutions happen at CP14 and CP501. Every notice that arrives after means more penalty, more interest, and tighter options.</li>`,
    `<li><strong>Don't pay a "tax debt resolution" pitch that promises pennies on the dollar without reviewing your actual financial situation.</strong> Legitimate Offers in Compromise require detailed financial disclosure and are case-specific. Anyone selling a guarantee in the first phone call is selling marketing, not tax help.</li>`,
    `</ul>`,

    `<h2>The cleanest path from CP14 forward</h2>`,
    `<ol>`,
    `<li><strong>Open the notice the day it arrives.</strong> Verify the tax year, form, and balance match what you actually owe.</li>`,
    `<li><strong>Pick a resolution path before the next notice in the chain.</strong> Pay in full, online installment agreement, hardship status, or Offer in Compromise pre-qualification.</li>`,
    `<li><strong>If you're at CP504 or LT11, get help.</strong> The math of waiting another 30 days is no longer in your favor.</li>`,
    `<li><strong>If LT11 has already arrived, mark the 30-day deadline on a calendar today.</strong> Filing Form 12153 within that window preserves every other option you have.</li>`,
    `</ol>`,

    `<h2>How ${brand} can help</h2>`,
    `<p>If you've received any of the notices in this chain — or you're not sure which one is in your mailbox — ${brand} can review your situation and pick the path that actually applies to you. We work with taxpayers at every stage of IRS collection, from the first CP14 to active levies that need to be released. If you authorize us and we're engaged, we communicate with the IRS directly so you don't have to.</p>`,
    `<p><strong>Bottom line:</strong> The IRS notice sequence is predictable. Every letter you ignore makes the next one bigger, the next option narrower, and the eventual resolution more expensive. The cheapest move is whichever one you make today.</p>`,
    `<p>Reference: For the official notice descriptions and what to expect, see the IRS Understanding Your IRS Notice or Letter pages at <a href="https://www.irs.gov/individuals/understanding-your-irs-notice-or-letter">irs.gov/individuals/understanding-your-irs-notice-or-letter</a>.</p>`,
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

// Pretty-print the JS object so it slots into blogData.js cleanly.
// We can't JSON.stringify because the file uses bare property names
// and the contentBody strings need to live as plain strings (not
// JSON-escaped). Hand-format with conservative quoting.
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
  // The marker line in the file is just `const blogData = [` followed
  // by a newline. Insert the new object literal directly after, with
  // its own newline before for readability.
  const next = `${head}\n${literal}\n${tail.replace(/^\n/, "")}`;
  fs.writeFileSync(filePath, next, "utf8");
}

// SVG template for the Wynn header image. 1200x628 (Open Graph
// standard), dark navy background, gold accents, serif headline.
// Shapes are programmatic so we never depend on local fonts beyond
// the basic web-safe Georgia/serif fallback.
function buildSvg() {
  const w = 1200;
  const h = 628;
  // Dark navy/cream/gold palette mirrors the existing Tax Day banner.
  const bg = "#0a1733";
  const grid = "#162342";
  const ink = "#f4ead3";
  const accent = "#c8a14a";
  const muted = "#7a8398";
  // Soft grid in the background (decorative)
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
  <!-- decorative corner brackets -->
  <path d="M 30 30 L 90 30 M 30 30 L 30 90" stroke="${accent}" stroke-width="2" fill="none" opacity="0.6" />
  <path d="M ${w - 30} ${h - 30} L ${w - 90} ${h - 30} M ${w - 30} ${h - 30} L ${w - 30} ${h - 90}" stroke="${accent}" stroke-width="2" fill="none" opacity="0.6" />
  <!-- left vertical accent bar next to headline -->
  <line x1="80" y1="280" x2="80" y2="380" stroke="${accent}" stroke-width="3" />
  <!-- Eyebrow -->
  <text x="120" y="232" fill="${accent}"
        font-family="Georgia, 'Times New Roman', serif"
        font-size="20" letter-spacing="6" font-weight="700">${SLIDE_EYEBROW}</text>
  <!-- Big headline (two lines) -->
  <text x="120" y="320" fill="${ink}"
        font-family="Georgia, 'Times New Roman', serif"
        font-size="72" font-weight="700">${SLIDE_HEADLINE_LINE_1}</text>
  <text x="120" y="402" fill="${accent}"
        font-family="Georgia, 'Times New Roman', serif"
        font-size="72" font-weight="700">${SLIDE_HEADLINE_LINE_2}</text>
  <!-- Right side circular badge -->
  <circle cx="1000" cy="320" r="120" fill="none" stroke="${accent}" stroke-width="1.5" opacity="0.85" />
  <text x="1000" y="290" fill="${muted}" text-anchor="middle"
        font-family="Georgia, 'Times New Roman', serif" font-size="18" letter-spacing="4" font-weight="700">${SLIDE_BADGE_TOP}</text>
  <text x="1000" y="345" fill="${accent}" text-anchor="middle"
        font-family="Georgia, 'Times New Roman', serif" font-size="48" font-weight="700">CP14 → LT11</text>
  <text x="1000" y="375" fill="${muted}" text-anchor="middle"
        font-family="Georgia, 'Times New Roman', serif" font-size="16" letter-spacing="6" font-weight="700">${SLIDE_BADGE_BOTTOM}</text>
  <!-- Subhead under headline -->
  <text x="120" y="465" fill="${muted}"
        font-family="Georgia, 'Times New Roman', serif" font-size="22">CP14, CP501, CP503, CP504, LT11 — the order, the timing,</text>
  <text x="120" y="495" fill="${muted}"
        font-family="Georgia, 'Times New Roman', serif" font-size="22">and the one that starts a 30-day clock.</text>
  <!-- Footer -->
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
  // The legacy deploy CLI does NOT run `npm run build` — it commits +
  // pushes + has the EC2 box pull the repo (build output is committed
  // to git). So the build step has to happen here, before the deploy
  // commits. Without this, EC2 pulls the new blogData.js but serves
  // the stale client/build/ from the last manual rebuild.
  return execFileSync(npmCommand(), ["run", "build"], {
    cwd: path.join(repoDir, "client"),
    stdio: "pipe",
    encoding: "utf8",
    maxBuffer: 500 * 1024 * 1024,
  });
}

function deployBrand(brandKey, commitMsg) {
  // Shells out to the legacy deploy CLI which already knows about the
  // EC2 hosts, SSH keys, and PM2 wiring. CWD must be the legacy repo
  // because the deploy CLI loads .env relative to its cwd.
  const stdout = execFileSync(
    "node",
    ["scripts/deploy.js", "deploy", brandKey, commitMsg, "--pull"],
    {
      cwd: TCB_DEPLOY_DIR,
      stdio: "pipe",
      encoding: "utf8",
      maxBuffer: 200 * 1024 * 1024,
    },
  );
  return stdout;
}

async function sendSummaryEmail(summary) {
  // Use SendGrid via the existing parallel mailer.
  const { sendPlainEmail } = require(
    "../packages/shared-services/src/sendgridMailService",
  );
  const subject = `Blog auto-posted: ${summary.id}`;
  const lines = [
    `Topic: ${summary.title}`,
    "",
    // Both sites route blog detail pages under /tax-news/:id, not /blog/.
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

  // 1. Render the Wynn header image
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

  // 3. Build each client BEFORE deploy. The deploy CLI commits +
  // pushes whatever's currently on disk and has EC2 pull the repo —
  // build output is part of the commit.
  console.log(`[blogger] building wynn client (this takes ~30-60s)...`);
  buildBrand(WYNN_REPO);
  console.log(`[blogger] wynn build complete`);
  console.log(`[blogger] building tag client...`);
  buildBrand(TAG_REPO);
  console.log(`[blogger] tag build complete`);

  // 4. Deploy each brand. Commit msg follows the existing pattern
  // (see the legacy deploy CLI README for accepted shapes).
  const commitMsg = `Auto blog: ${BLOG_ID}`;
  try {
    summary.wynnDeploy = "deploying...";
    const wynnOut = deployBrand("wynn", commitMsg);
    summary.wynnDeploy = `ok (${wynnOut.split("\n").filter(Boolean).slice(-3).join(" | ")})`;
    console.log(`[blogger] wynn deploy ok`);
  } catch (err) {
    summary.wynnDeploy = `FAILED: ${err.message}`;
    console.error(`[blogger] wynn deploy failed:`, err.message);
  }
  try {
    summary.tagDeploy = "deploying...";
    const tagOut = deployBrand("tag", commitMsg);
    summary.tagDeploy = `ok (${tagOut.split("\n").filter(Boolean).slice(-3).join(" | ")})`;
    console.log(`[blogger] tag deploy ok`);
  } catch (err) {
    summary.tagDeploy = `FAILED: ${err.message}`;
    console.error(`[blogger] tag deploy failed:`, err.message);
  }

  // 4. Email summary
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
