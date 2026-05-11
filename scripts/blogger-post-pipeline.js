"use strict";

// Shared post pipeline. Takes a blog-draft object and runs the full
// publish flow: render image → mutate both blogData.js files → build
// both clients → run deploy CLI for both brands → email summary.
//
// Used by:
//   - blogger-daily-runner.js (cron-fired, picks topic per day-of-week)
//   - any one-off script that has a draft already and just needs to post
//
// Draft shape (canonical):
//   {
//     id, title, teaser, contentTitle, contentBody (string[]),
//     body (legacy alias for contentBody),
//     category, slide: { eyebrow, headline1, headline2, badgeTop,
//       badgeCenter, badgeBottom, subhead1, subhead2 },
//     sourceNotes?, generatedBy?, generatedAt?
//   }

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const sharp = require(path.resolve(
  "C:/Users/Admin/Code/WynnTax/client/node_modules/sharp",
));

const WYNN_REPO = "C:/Users/Admin/Code/WynnTax";
const TAG_REPO = "C:/Users/Admin/Code/TaxAdvocateGroup";
const TCB_DEPLOY_DIR = "C:/Users/Admin/Code/TagContactBridge";

// ── Brand interpolation ──────────────────────────────────────────

function interpolateBrand(text, brandName) {
  return String(text || "").replace(/\{brand\}/g, brandName);
}

function draftContentBody(draft) {
  if (Array.isArray(draft.contentBody)) return draft.contentBody;
  if (Array.isArray(draft.body)) return draft.body;
  return null;
}

function buildBlogObject({ draft, brandName, includeImage }) {
  const contentBody = draftContentBody(draft);
  const obj = {
    id: draft.id,
    title: draft.title,
    ...(includeImage ? { image: `/images/${draft.id}.png` } : {}),
    teaser: draft.teaser,
    contentTitle: draft.contentTitle || draft.title,
    contentBody: contentBody.map((entry) =>
      interpolateBrand(entry, brandName),
    ),
  };
  return obj;
}

// ── blogData.js mutation ─────────────────────────────────────────

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

// ── Image renderer (Wynn-only) ───────────────────────────────────

function buildSvg(slide) {
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
        font-size="20" letter-spacing="6" font-weight="700">${escapeXml(slide.eyebrow)}</text>
  <text x="120" y="320" fill="${ink}"
        font-family="Georgia, 'Times New Roman', serif"
        font-size="72" font-weight="700">${escapeXml(slide.headline1)}</text>
  <text x="120" y="402" fill="${accent}"
        font-family="Georgia, 'Times New Roman', serif"
        font-size="72" font-weight="700">${escapeXml(slide.headline2)}</text>
  <circle cx="1000" cy="320" r="120" fill="none" stroke="${accent}" stroke-width="1.5" opacity="0.85" />
  <text x="1000" y="288" fill="${muted}" text-anchor="middle"
        font-family="Georgia, 'Times New Roman', serif" font-size="18" letter-spacing="4" font-weight="700">${escapeXml(slide.badgeTop)}</text>
  <text x="1000" y="345" fill="${accent}" text-anchor="middle"
        font-family="Georgia, 'Times New Roman', serif" font-size="44" font-weight="700">${escapeXml(slide.badgeCenter)}</text>
  <text x="1000" y="375" fill="${muted}" text-anchor="middle"
        font-family="Georgia, 'Times New Roman', serif" font-size="16" letter-spacing="6" font-weight="700">${escapeXml(slide.badgeBottom)}</text>
  <text x="120" y="465" fill="${muted}"
        font-family="Georgia, 'Times New Roman', serif" font-size="22">${escapeXml(slide.subhead1 || "")}</text>
  <text x="120" y="495" fill="${muted}"
        font-family="Georgia, 'Times New Roman', serif" font-size="22">${escapeXml(slide.subhead2 || "")}</text>
  <text x="120" y="${h - 50}" fill="${accent}"
        font-family="Georgia, 'Times New Roman', serif" font-size="20" letter-spacing="4" font-weight="700">WYNN TAX SOLUTIONS</text>
  <text x="465" y="${h - 50}" fill="${muted}"
        font-family="Georgia, 'Times New Roman', serif" font-size="20">|  wynntaxsolutions.com</text>
</svg>`;
}

function escapeXml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function renderHeaderImage(draft) {
  const outPath = path.join(WYNN_REPO, "client", "public", "images", `${draft.id}.png`);
  await sharp(Buffer.from(buildSvg(draft.slide), "utf8"))
    .png({ quality: 95 })
    .toFile(outPath);
  return outPath;
}

// ── Build + deploy ───────────────────────────────────────────────

function buildClient(repoDir) {
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
      cwd: TCB_DEPLOY_DIR,
      stdio: "pipe",
      encoding: "utf8",
      maxBuffer: 200 * 1024 * 1024,
    },
  );
}

// ── Email ────────────────────────────────────────────────────────

async function sendSummaryEmail(summary) {
  const { sendPlainEmail } = require(
    "../packages/shared-services/src/sendgridMailService",
  );
  const subject = summary.rolledBack
    ? `Blog auto-post ROLLED BACK: ${summary.id}`
    : summary.failed
      ? `Blog auto-post FAILED: ${summary.id}`
      : `Blog auto-posted: ${summary.id}`;
  const sectionLines = [
    `Topic: ${summary.title}`,
    `Day type: ${summary.dayType || "n/a"}`,
    "",
  ];
  if (!summary.failed) {
    sectionLines.push(
      `Wynn URL: https://www.wynntaxsolutions.com/tax-news/${summary.id}`,
      `TAG URL: https://www.taxadvocategroup.com/tax-news/${summary.id}`,
      "",
    );
  }
  sectionLines.push(
    "Pipeline results:",
    `  Image:       ${summary.imagePath || "skipped"}`,
    `  blogData:    ${summary.blogDataUpdated ? "ok" : "skipped"}`,
    `  Wynn build:  ${summary.wynnBuild || "n/a"}`,
    `  TAG build:   ${summary.tagBuild || "n/a"}`,
    `  Wynn deploy: ${summary.wynnDeploy || "n/a"}`,
    `  TAG deploy:  ${summary.tagDeploy || "n/a"}`,
    "",
  );
  if (summary.preflightFailures && summary.preflightFailures.length > 0) {
    sectionLines.push(
      "Preflight blocked the run before any changes were made:",
      ...summary.preflightFailures.map((f) => `  - ${f.name}: ${f.reason}`),
      "",
    );
  }
  if (summary.errors && summary.errors.length > 0) {
    sectionLines.push(
      "Errors:",
      ...summary.errors.map((e) => `  ${e}`),
      "",
    );
  }
  if (summary.rollbackActions && summary.rollbackActions.length > 0) {
    sectionLines.push(
      "Rollback actions:",
      ...summary.rollbackActions.map((a) => `  - ${a}`),
      "",
    );
  }
  if (summary.sourceNotes) sectionLines.push(`Source: ${summary.sourceNotes}`);
  const lines = sectionLines.filter((l) => l !== undefined).join("\n");
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

// ── Preflight checks ─────────────────────────────────────────────
//
// Every check returns either { ok: true } or { ok: false, reason }.
// We run all checks before any mutation so a failure at the gate
// produces zero changes — clean abort, email, exit.

function checkRequiredEnv() {
  // SendGrid keys are per-company, named via companyConfig.js
  // (TAG_API_KEY, WYNN_API_KEY). The earlier check looked for
  // SENDGRID_API_KEY / SENDGRID_TAG_API_KEY — neither exists, so the
  // gate failed even on perfectly healthy environments. The funny
  // tell: the failure email itself was sent via TAG_API_KEY, proving
  // SendGrid was wired up correctly.
  const missing = [];
  if (!process.env.ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY");
  if (!process.env.TAG_API_KEY) missing.push("TAG_API_KEY");
  if (!process.env.WYNN_API_KEY) missing.push("WYNN_API_KEY");
  return missing.length > 0
    ? { ok: false, reason: `missing env vars: ${missing.join(", ")}` }
    : { ok: true };
}

function checkRepoIsClean(repoDir) {
  try {
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: repoDir,
      stdio: "pipe",
      encoding: "utf8",
    }).trim();
    return status
      ? { ok: false, reason: `${repoDir} has uncommitted changes:\n${status}` }
      : { ok: true };
  } catch (err) {
    return { ok: false, reason: `${repoDir} git status failed: ${err.message}` };
  }
}

function checkDeployCliConfigured() {
  const scriptPath = path.join(TCB_DEPLOY_DIR, "scripts", "deploy.js");
  if (!fs.existsSync(scriptPath)) {
    return { ok: false, reason: `deploy CLI not found: ${scriptPath}` };
  }
  try {
    const output = execFileSync("node", ["scripts/deploy.js", "sites"], {
      cwd: TCB_DEPLOY_DIR,
      stdio: "pipe",
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    if (/incomplete/i.test(output)) {
      return { ok: false, reason: "legacy deploy CLI has incomplete site config" };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `deploy CLI config check failed: ${err.message}` };
  }
}

function checkDraftShape(draft) {
  const required = ["id", "title", "teaser", "slide"];
  for (const key of required) {
    if (!draft[key]) return { ok: false, reason: `draft missing field: ${key}` };
  }
  const contentBody = draftContentBody(draft);
  if (!Array.isArray(contentBody) || contentBody.length < 5) {
    const foundType = typeof draft.contentBody === "object"
      ? draft.contentBody?.length
      : typeof draft.contentBody;
    return { ok: false, reason: `draft contentBody/body must be array with 5+ entries (got ${foundType})` };
  }
  return { ok: true };
}

async function runPreflight(draft) {
  const checks = [
    { name: "draft-shape", fn: () => checkDraftShape(draft) },
    { name: "env-vars", fn: () => checkRequiredEnv() },
    { name: "wynn-clean", fn: () => checkRepoIsClean(WYNN_REPO) },
    { name: "tag-clean", fn: () => checkRepoIsClean(TAG_REPO) },
    { name: "deploy-cli-config", fn: () => checkDeployCliConfigured() },
  ];
  const failures = [];
  for (const { name, fn } of checks) {
    const result = await fn();
    if (!result.ok) failures.push({ name, reason: result.reason });
  }
  return failures;
}

// ── Rollback helpers ─────────────────────────────────────────────

// Run TCB's existing `rollback` command for a given brand. The
// legacy CLI handles the EC2 git-reset + nginx + pm2 dance.
function rollbackBrandOnEc2(brandKey) {
  return execFileSync("node", ["scripts/deploy.js", "rollback", brandKey], {
    cwd: TCB_DEPLOY_DIR,
    stdio: "pipe",
    encoding: "utf8",
    maxBuffer: 200 * 1024 * 1024,
  });
}

// Restore a snapshot of blogData.js (full file content, captured
// pre-mutation). Catches any IO error so partial rollback doesn't
// leave us in a worse state than failure.
function restoreSnapshot(filePath, snapshot) {
  try {
    fs.writeFileSync(filePath, snapshot, "utf8");
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `restore ${filePath}: ${err.message}` };
  }
}

// ── Main publish flow ────────────────────────────────────────────

async function publishBlog(draft, options = {}) {
  const summary = {
    id: draft.id,
    title: draft.title,
    dayType: options.dayType || draft.category || null,
    sourceNotes: draft.sourceNotes || null,
    errors: [],
    rolledBack: false,
    rollbackActions: [],
  };

  const wynnBlogPath = path.join(WYNN_REPO, "client", "src", "data", "blogData.js");
  const tagBlogPath = path.join(TAG_REPO, "client", "src", "data", "blogData.js");

  // 0. Preflight — all checks before any mutation. Fail-clean if anything is off.
  const preflightFailures = await runPreflight(draft);
  if (preflightFailures.length > 0) {
    summary.failed = true;
    summary.preflightFailures = preflightFailures;
    summary.errors = preflightFailures.map((f) => `preflight ${f.name}: ${f.reason}`);
    await sendSummaryEmail(summary).catch(() => {});
    return summary;
  }

  // 1. Snapshot blogData.js for both repos so we can roll back
  //    exactly to current state if anything below fails. Captured
  //    BEFORE any mutation. We don't snapshot images since we name
  //    them by id and a re-run with the same id is idempotent.
  const wynnSnapshot = fs.readFileSync(wynnBlogPath, "utf8");
  const tagSnapshot = fs.readFileSync(tagBlogPath, "utf8");
  let wynnImagePath = null;
  let wynnDeployed = false;
  let tagDeployed = false;

  // Wrap the whole post in try/catch so we can route any failure
  // through the rollback path. The summary already carries the
  // accumulated step outcomes.
  try {
    // 2. Image
    wynnImagePath = await renderHeaderImage(draft);
    summary.imagePath = wynnImagePath;

    // 3. blogData.js mutation (both repos)
    prependBlogToFile(
      wynnBlogPath,
      buildBlogObject({ draft, brandName: "Wynn Tax Solutions", includeImage: true }),
    );
    prependBlogToFile(
      tagBlogPath,
      buildBlogObject({ draft, brandName: "Tax Advocate Group", includeImage: false }),
    );
    summary.blogDataUpdated = true;

    // 4. Build (both clients)
    buildClient(WYNN_REPO);
    summary.wynnBuild = "ok";
    buildClient(TAG_REPO);
    summary.tagBuild = "ok";

    // 5. Deploy (both brands). Ordered: Wynn first; if Wynn fails
    //    we never deploy TAG. If Wynn succeeds and TAG fails we
    //    rollback Wynn so the two sites stay in sync.
    const commitMsg = `Auto blog: ${draft.id}`;
    deployBrand("wynn", commitMsg);
    summary.wynnDeploy = "ok";
    wynnDeployed = true;
    deployBrand("tag", commitMsg);
    summary.tagDeploy = "ok";
    tagDeployed = true;

    // Success path — email and return.
    await sendSummaryEmail(summary).catch((err) => {
      console.error("[pipeline] success email failed:", err.message);
    });
    return summary;
  } catch (err) {
    // ── Rollback ──────────────────────────────────────────────
    summary.failed = true;
    summary.errors.push(`pipeline: ${err.message}`);
    summary.rolledBack = true;

    // 1. If Wynn EC2 was deployed but TAG failed, roll Wynn back.
    if (wynnDeployed && !tagDeployed) {
      try {
        rollbackBrandOnEc2("wynn");
        summary.rollbackActions.push("rolled-back wynn EC2 to previous commit");
      } catch (rbErr) {
        summary.rollbackActions.push(`FAILED to rollback wynn EC2: ${rbErr.message}`);
      }
    }
    // (No TAG-only deploy is possible since we always deploy Wynn first.)

    // 2. Restore local blogData.js for both repos. This undoes the
    //    prepend so a re-run starts from the same state. The deploy
    //    CLI already commit+pushed by this point if a deploy ran, so
    //    GitHub keeps the historical commit; the LIVE site is rolled
    //    back via step 1, and the LOCAL repos are reset for the next run.
    const wynnRestore = restoreSnapshot(wynnBlogPath, wynnSnapshot);
    if (wynnRestore.ok) {
      summary.rollbackActions.push("restored wynn blogData.js");
    } else {
      summary.rollbackActions.push(`FAILED ${wynnRestore.reason}`);
    }
    const tagRestore = restoreSnapshot(tagBlogPath, tagSnapshot);
    if (tagRestore.ok) {
      summary.rollbackActions.push("restored tag blogData.js");
    } else {
      summary.rollbackActions.push(`FAILED ${tagRestore.reason}`);
    }

    // 3. Image cleanup — if we rendered a fresh image and the post
    //    didn't go live, drop it so the next attempt re-renders
    //    cleanly. (No-op if the deploy never moved the image to the
    //    served build.)
    if (wynnImagePath) {
      try {
        fs.unlinkSync(wynnImagePath);
        summary.rollbackActions.push("removed orphan header image");
      } catch {
        // Already gone or never rendered — fine.
      }
    }

    // 4. Email the rollback summary and return (don't re-throw —
    //    the caller's behavior on returned failure is enough).
    await sendSummaryEmail(summary).catch((emailErr) => {
      console.error("[pipeline] rollback email failed:", emailErr.message);
    });
    return summary;
  }
}

module.exports = {
  publishBlog,
  runPreflight,
  renderHeaderImage,
  prependBlogToFile,
  buildBlogObject,
  buildClient,
  deployBrand,
  sendSummaryEmail,
};
