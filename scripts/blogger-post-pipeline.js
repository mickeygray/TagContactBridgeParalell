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

  // Duplicate-slug guard. If the id already appears in the file, throw
  // a clear error rather than silently prepending a second copy. The
  // daily-runner has its own pre-publish dedup via readPublishedIds(),
  // but this is a belt-and-suspenders safety net for any code path
  // that bypasses the runner (one-off scripts, manual invocations).
  const idLiteral = JSON.stringify(blogObject.id);
  if (original.includes(`id: ${idLiteral}`)) {
    throw new Error(
      `prependBlogToFile: slug ${blogObject.id} already exists in ${filePath} — refusing to prepend a duplicate`,
    );
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

// ── Image generation: SVG (default) or OpenAI photographic ──────
//
// Two providers, switchable via env so we can A/B without code edits:
//
//   BLOG_IMAGE_PROVIDER=svg      (default)
//     Existing programmatic SVG → PNG pipeline. Bakes the slide
//     title + eyebrow + badge into a clean editorial graphic.
//     Free, deterministic, includes legible text.
//
//   BLOG_IMAGE_PROVIDER=openai
//     gpt-image-2 (or whatever OPENAI_IMAGE_MODEL is) generates a
//     photographic editorial-style hero. No text on the image —
//     subject suggests the topic. ~$0.01–0.04/image depending on
//     quality. Slower (~10–25s per image).
//
// The OpenAI prompt is taken from `draft.imagePrompt` if the upstream
// writer set it. Otherwise we synthesize a generic editorial prompt
// from the slide eyebrow + headlines so existing drafts still work.

function buildOpenAiImagePrompt(draft) {
  if (typeof draft.imagePrompt === "string" && draft.imagePrompt.trim()) {
    return draft.imagePrompt.trim();
  }
  const eyebrow = String(draft.slide?.eyebrow || draft.category || "").trim();
  const headline = String(
    [draft.slide?.headline1, draft.slide?.headline2].filter(Boolean).join(" "),
  ).trim() || String(draft.title || "").trim();
  const subject = headline || "tax relief topic";

  // Editorial / magazine-cover style works well for tax/finance topics:
  // suggests authority without crossing into the "stock image" trap.
  // No text on the image (gpt-image-2 can render text but blog cards
  // already overlay the title, and AI-rendered numbers/letters are
  // still occasionally wrong).
  return [
    `Editorial photographic hero image for a tax-relief article about ${subject}.`,
    eyebrow ? `Editorial category: ${eyebrow}.` : "",
    "Style: clean magazine cover, soft natural daylight, blurred bookshelf or office background.",
    "Subject: relevant objects (paperwork, calculator, coffee mug, fountain pen, glasses, plant) staged on a wooden desk.",
    "Mood: hopeful, professional, calm. No people's faces visible. No legible text, no numbers, no logos.",
    "Aspect: square 1:1. Sharp focus on the main subject with depth-of-field bokeh behind.",
  ]
    .filter(Boolean)
    .join(" ");
}

async function renderOpenAiHeaderBuffer(draft) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("BLOG_IMAGE_PROVIDER=openai but OPENAI_API_KEY is not set");
  }
  const model = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2";
  const quality = process.env.OPENAI_IMAGE_QUALITY || "low";
  const size = process.env.OPENAI_IMAGE_SIZE || "1024x1024";
  const prompt = buildOpenAiImagePrompt(draft);

  const startedAt = Date.now();
  const r = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, prompt, n: 1, size, quality }),
  });
  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    const err = new Error(
      `OpenAI images.generations HTTP ${r.status}: ${errText.slice(0, 400)}`,
    );
    err.status = r.status;
    err.elapsedMs = Date.now() - startedAt;
    throw err;
  }
  const json = await r.json();
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error("OpenAI returned no b64_json");
  }
  const buffer = Buffer.from(b64, "base64");
  return {
    buffer,
    model,
    quality,
    size,
    elapsedMs: Date.now() - startedAt,
    usage: json.usage || null,
    promptUsed: prompt,
  };
}

async function renderHeaderImage(draft) {
  const outPath = path.join(WYNN_REPO, "client", "public", "images", `${draft.id}.png`);
  const provider = String(process.env.BLOG_IMAGE_PROVIDER || "svg")
    .trim()
    .toLowerCase();

  if (provider === "openai") {
    try {
      const result = await renderOpenAiHeaderBuffer(draft);
      // Re-encode through sharp to normalize PNG format + apply a mild
      // quality clamp consistent with the SVG path (also strips any
      // metadata that came with the OpenAI response).
      await sharp(result.buffer).png({ quality: 95 }).toFile(outPath);
      console.log(
        `[blog-image] openai ${result.model} ${result.quality} ` +
          `${(result.buffer.length / 1024).toFixed(0)}KB in ` +
          `${(result.elapsedMs / 1000).toFixed(1)}s`,
      );
      if (result.usage) {
        console.log(`[blog-image] usage:`, JSON.stringify(result.usage));
      }
      return outPath;
    } catch (error) {
      // Don't take down the whole post pipeline on a transient OpenAI
      // hiccup. Fall back to the SVG path so the post still ships,
      // and surface the error in the run log.
      console.warn(
        `[blog-image] openai failed (${error.message}); falling back to SVG`,
      );
    }
  }

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

// Paths that the bot exclusively owns. If a dirty file matches one of
// these patterns AND HEAD's most recent commit is one of ours
// ("Auto blog:" prefix), we infer the dirty state is leftover from a
// prior partial run and auto-restore it from HEAD rather than hard-
// blocking the new run. Anything outside these patterns is presumed
// human-edited and blocks the run for review.
const BOT_OWNED_PATH_PATTERNS = [
  /^client\/src\/data\/blogData\.js$/,
  /^client\/public\/images\/.+\.png$/,
];

function isBotOwnedPath(porcelainPath) {
  // porcelain lines look like " M client/src/data/blogData.js" or
  // " D client/public/images/foo.png" — strip the status flag.
  const clean = porcelainPath.replace(/^[\s\?DM!ARCU]+/, "").trim();
  return BOT_OWNED_PATH_PATTERNS.some((rx) => rx.test(clean));
}

function lastCommitSubject(repoDir) {
  try {
    return execFileSync("git", ["log", "-1", "--format=%s"], {
      cwd: repoDir,
      stdio: "pipe",
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

function gitRestoreAll(repoDir) {
  try {
    execFileSync("git", ["restore", "."], {
      cwd: repoDir,
      stdio: "pipe",
      encoding: "utf8",
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

function checkRepoIsClean(repoDir) {
  try {
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: repoDir,
      stdio: "pipe",
      encoding: "utf8",
    }).trim();
    if (!status) return { ok: true };

    const lines = status.split("\n").filter(Boolean);
    const allBotOwned = lines.every(isBotOwnedPath);
    const lastSubject = lastCommitSubject(repoDir);
    const lastCommitIsBot = lastSubject.startsWith("Auto blog:");

    // Auto-restore path: all dirty files are bot-owned AND HEAD's last
    // commit was a bot publish. The dirty state is almost certainly
    // leftover from a partial rollback (we saw this in May 2026 when
    // a TAG deploy failure created "uncommitted reverts" on Wynn
    // that sat for 4 days and blocked every subsequent run).
    if (allBotOwned && lastCommitIsBot) {
      const restored = gitRestoreAll(repoDir);
      if (restored.ok) {
        return {
          ok: true,
          autoRestored: true,
          note: `Auto-restored ${lines.length} bot-owned dirty file(s) in ${repoDir} from HEAD before run.`,
        };
      }
      return {
        ok: false,
        reason: `${repoDir} auto-restore failed: ${restored.reason}\n${status}`,
      };
    }

    return { ok: false, reason: `${repoDir} has uncommitted changes:\n${status}` };
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

// Pull every `id: "..."` slug out of a repo's blogData.js plus the
// count of occurrences per slug — used to detect dup-slug accidents
// (the same partial-deploy bug that bit us in May 2026 would have
// surfaced here if the dirty state ever made it through prepend).
function readBlogIdCounts(repoDir) {
  const filePath = path.join(repoDir, "client", "src", "data", "blogData.js");
  if (!fs.existsSync(filePath)) {
    throw new Error(`blogData.js not found at ${filePath}`);
  }
  const text = fs.readFileSync(filePath, "utf8");
  const counts = new Map();
  const regex = /id:\s*"([^"]+)"/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    counts.set(match[1], (counts.get(match[1]) || 0) + 1);
  }
  return counts;
}

// Cross-repo ID consistency check. Both Wynn and TAG must hold the
// same set of slugs in blogData.js — they're kept in lockstep by the
// publish pipeline. Any drift means a prior run partially published
// (Wynn-only or TAG-only) and the two sites are out of sync. Also
// catches accidental duplicate slugs within a single repo (the false
// alarm we investigated in May 2026 — and the real failure mode that
// could happen if a one-off script bypasses the prepend guard).
function checkBlogIdsInSync() {
  let wynnCounts, tagCounts;
  try {
    wynnCounts = readBlogIdCounts(WYNN_REPO);
    tagCounts = readBlogIdCounts(TAG_REPO);
  } catch (err) {
    return { ok: false, reason: err.message };
  }

  const wynnDupes = [...wynnCounts.entries()].filter(([, n]) => n > 1);
  const tagDupes = [...tagCounts.entries()].filter(([, n]) => n > 1);
  if (wynnDupes.length > 0 || tagDupes.length > 0) {
    const fmt = (list) => list.map(([id, n]) => `${id} (×${n})`).join(", ");
    const parts = [];
    if (wynnDupes.length > 0) parts.push(`wynn dupes: ${fmt(wynnDupes)}`);
    if (tagDupes.length > 0) parts.push(`tag dupes: ${fmt(tagDupes)}`);
    return { ok: false, reason: `duplicate slugs in blogData.js — ${parts.join(" | ")}` };
  }

  const wynnIds = new Set(wynnCounts.keys());
  const tagIds = new Set(tagCounts.keys());
  const inWynnOnly = [...wynnIds].filter((id) => !tagIds.has(id));
  const inTagOnly = [...tagIds].filter((id) => !wynnIds.has(id));
  if (inWynnOnly.length > 0 || inTagOnly.length > 0) {
    const wynnList = inWynnOnly.slice(0, 5).join(", ") +
      (inWynnOnly.length > 5 ? `, +${inWynnOnly.length - 5} more` : "");
    const tagList = inTagOnly.slice(0, 5).join(", ") +
      (inTagOnly.length > 5 ? `, +${inTagOnly.length - 5} more` : "");
    const parts = [];
    if (inWynnOnly.length > 0) parts.push(`wynn-only (${inWynnOnly.length}): ${wynnList}`);
    if (inTagOnly.length > 0) parts.push(`tag-only (${inTagOnly.length}): ${tagList}`);
    return {
      ok: false,
      reason: `wynn + tag blogData.js are out of sync — ${parts.join(" | ")}. Backfill the missing side or revert the orphaned commit before re-running.`,
    };
  }

  return { ok: true, note: `${wynnIds.size} slugs aligned between wynn + tag` };
}

// Verify state.lastPostedId (if set) actually appears in BOTH repos.
// Pre-this-check, state could lie — say "I posted X today" while
// only one site actually got X. The failure-recovery agent + the
// state-on-fail fix close most of the gap; this is the
// belt-and-suspenders catch that surfaces residual drift to the
// next preflight.
function checkStateLastPostedIsPublished() {
  const statePath = path.join(__dirname, "blogger-state.json");
  if (!fs.existsSync(statePath)) return { ok: true, note: "no state file" };
  let state;
  try {
    state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch (err) {
    return { ok: false, reason: `state file unreadable: ${err.message}` };
  }
  if (!state.lastPostedId) return { ok: true, note: "state.lastPostedId is null" };
  const wynnIds = new Set(readBlogIdCounts(WYNN_REPO).keys());
  const tagIds = new Set(readBlogIdCounts(TAG_REPO).keys());
  const missingFromWynn = !wynnIds.has(state.lastPostedId);
  const missingFromTag = !tagIds.has(state.lastPostedId);
  if (missingFromWynn || missingFromTag) {
    const where = [missingFromWynn && "wynn", missingFromTag && "tag"]
      .filter(Boolean)
      .join(" + ");
    return {
      ok: false,
      reason: `state.lastPostedId="${state.lastPostedId}" is not in ${where} blogData.js — prior run reported success but the post never landed. Backfill or unset state.lastPostedId before re-running.`,
    };
  }
  return { ok: true, note: `state.lastPostedId="${state.lastPostedId}" found in both repos` };
}

async function runPreflight(draft) {
  const checks = [
    { name: "draft-shape", fn: () => checkDraftShape(draft) },
    { name: "env-vars", fn: () => checkRequiredEnv() },
    { name: "blog-ids-in-sync", fn: () => checkBlogIdsInSync() },
    { name: "state-vs-published", fn: () => checkStateLastPostedIsPublished() },
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

    // 2. Restore local blogData.js only for repos that did NOT deploy.
    //    A deploy means `deployBrand` ran, which commits + pushes the
    //    mutated blogData.js as part of its flow. If we then restored
    //    the working tree, we'd create "uncommitted reverts" (commit
    //    in git history shows the new entry, but local file shows the
    //    old one). The May 2026 outage we just cleaned up was exactly
    //    that pattern: TAG failed mid-deploy, rollback restored Wynn's
    //    local blogData.js even though the Wynn commit was already
    //    pushed, and the resulting dirty state blocked every
    //    subsequent run for 4 days. Leave deployed repos at HEAD; the
    //    EC2 rollback above handles the live-site side.
    if (!wynnDeployed) {
      const wynnRestore = restoreSnapshot(wynnBlogPath, wynnSnapshot);
      if (wynnRestore.ok) {
        summary.rollbackActions.push("restored wynn blogData.js (no deploy committed)");
      } else {
        summary.rollbackActions.push(`FAILED ${wynnRestore.reason}`);
      }
    } else {
      summary.rollbackActions.push(
        "skipped wynn blogData.js restore — deploy already committed, working tree matches HEAD",
      );
    }
    if (!tagDeployed) {
      const tagRestore = restoreSnapshot(tagBlogPath, tagSnapshot);
      if (tagRestore.ok) {
        summary.rollbackActions.push("restored tag blogData.js (no deploy committed)");
      } else {
        summary.rollbackActions.push(`FAILED ${tagRestore.reason}`);
      }
    } else {
      summary.rollbackActions.push(
        "skipped tag blogData.js restore — deploy already committed, working tree matches HEAD",
      );
    }

    // 3. Image cleanup — only delete the image if no deploy committed
    //    it. If Wynn deployed, the image is part of HEAD; deleting it
    //    locally would create the same "uncommitted delete" wart we're
    //    avoiding for blogData.js above.
    if (wynnImagePath && !wynnDeployed) {
      try {
        fs.unlinkSync(wynnImagePath);
        summary.rollbackActions.push("removed orphan header image");
      } catch {
        // Already gone or never rendered — fine.
      }
    } else if (wynnImagePath && wynnDeployed) {
      summary.rollbackActions.push(
        "kept header image — committed to HEAD via wynn deploy",
      );
    }

    // 4. Email the rollback summary.
    await sendSummaryEmail(summary).catch((emailErr) => {
      console.error("[pipeline] rollback email failed:", emailErr.message);
    });

    // 5. Hand off to the recovery agent. It gathers the run context,
    //    asks Claude to classify the failure + propose a recovery
    //    plan, and either auto-recovers (when BLOG_FAILURE_AUTO_RECOVER
    //    is true AND the plan is high-confidence rollback-aftermath
    //    on bot-owned files) or emails the operator with a diagnosis
    //    and suggested manual steps. The agent's action allowlist is
    //    tight (only `git restore` on blogData.js / images/*.png), so
    //    even a hallucinated plan can't damage anything. Wrapped in a
    //    catch so a recovery-agent failure doesn't shadow the
    //    pipeline's own failure summary.
    if (
      String(process.env.BLOG_FAILURE_RECOVERY_ENABLED || "true")
        .toLowerCase() !== "false"
    ) {
      try {
        const { runRecovery } = require("./blogger-failure-recovery");
        await runRecovery({ auto: false });
      } catch (recErr) {
        console.error("[pipeline] recovery agent failed:", recErr.message);
      }
    }

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
