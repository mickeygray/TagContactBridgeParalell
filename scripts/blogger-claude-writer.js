"use strict";

// Claude-driven blog writer. Takes a topic seed (id, title, category,
// keyAngles, slide block) and asks Sonnet to produce a draft in our
// canonical shape — same fields the daily bot eventually publishes.
//
// Strict ground rules in the system prompt:
//   - No fabricated stats or fake citations.
//   - Use IRM, IRS.gov, and reputable accounting/tax-news sources only.
//   - Hit every angle in `keyAngles` (the seed's required beats).
//   - Match the canonical Wynn / TAG voice (long-form, candid, no hype).
//   - {brand} as a placeholder where the brand name goes — the daily
//     bot interpolates "Wynn Tax Solutions" or "Tax Advocate Group".

const Anthropic = require("@anthropic-ai/sdk");

const SONNET_MODEL = "claude-sonnet-4-5-20250929";

function buildSystemPrompt() {
  return [
    "You are a senior tax-resolution writer producing long-form blog posts for two firms (Wynn Tax Solutions and Tax Advocate Group). Both firms help taxpayers with IRS collection issues, unfiled returns, audits, and tax debt resolution.",
    "",
    "Voice: Candid, expert, never hype-y. Write like a respected enrolled agent or tax attorney who refuses to sell pennies-on-the-dollar promises. Match the existing canonical post on each site (long-form, multiple <h2> sections, lists with concrete dollar examples and timing, real form numbers, no marketing fluff).",
    "",
    "Hard rules:",
    "- DO NOT FABRICATE statistics, citations, percentages, dollar thresholds, dates, or named officials. If you're unsure of an exact number, use a defensible range or omit the specific.",
    "- Cite the IRM (Internal Revenue Manual section number) or IRS.gov pages when supporting a procedural claim. Backlinks to https://www.irs.gov/* are encouraged for verifiable IRS-published facts.",
    "- Use reputable accounting/tax-press sources for non-IRS claims (Journal of Accountancy, Accounting Today, Tax Notes, Bloomberg Tax). Do NOT cite Reddit, Quora, social media, or random blogs.",
    "- Use {brand} as a placeholder where the firm name appears in the body. The daily bot interpolates the actual brand at post time.",
    "- Cover every required angle from the seed's `keyAngles` array. Each angle should land in the body somewhere, even if not as a dedicated section.",
    "- bodyHtml is the COMPLETE blog body as one HTML string. Each block-level element (<h2>, <p>, <ul>, <ol>) must be on its own line, separated by a single newline. The first element must be a disclaimer paragraph (\"<p><em>Quick note:</em> ...</p>\"). The last element must be a \"<p><strong>Bottom line:</strong> ...</p>\" paragraph. Aim for 12-20 elements total.",
    "",
    "Length target: 1,400-2,000 words across the body. Match the depth of a senior practitioner explaining a concept to a client who's just received a notice.",
    "",
    "When you have the draft ready, call the `submit_blog_draft` tool with the structured fields. Do not respond with prose — only the tool call.",
  ].join("\n");
}

function buildUserPrompt(seed) {
  return [
    "Write a blog draft for the following topic seed.",
    "",
    `id: ${seed.id}`,
    `category: ${seed.category}`,
    `title: ${seed.title}`,
    "",
    "Required angles (each must land somewhere in the body):",
    ...seed.keyAngles.map((angle) => `  - ${angle}`),
    "",
    "Slide template hint (don't reference this in the body — it's just for image rendering metadata):",
    `  eyebrow: ${seed.slide.eyebrow}`,
    `  headlines: ${seed.slide.headline1} ${seed.slide.headline2}`,
    `  subhead: ${seed.slide.subhead1} ${seed.slide.subhead2}`,
    "",
    "Call the `submit_blog_draft` tool with the structured fields when done.",
  ].join("\n");
}

// Tool schema = our canonical blog object. Asking for the body as a
// single HTML string (split client-side into the array shape
// blogData.js expects) avoids array-of-strings escaping issues we
// hit when contentBody had 15+ long HTML entries — Claude
// occasionally stringified the whole array instead of emitting it
// as structured array tool input.
const SUBMIT_TOOL = {
  name: "submit_blog_draft",
  description:
    "Submit the finished blog draft. bodyHtml must be the complete blog body as a single HTML string with each block element (<h2>, <p>, <ul>, <ol>) on its own line, separated by a newline.",
  input_schema: {
    type: "object",
    required: ["teaser", "contentTitle", "bodyHtml"],
    properties: {
      teaser: {
        type: "string",
        description: "1-2 sentence hook (~200-280 chars).",
      },
      contentTitle: {
        type: "string",
        description: "Same value as the seed's title.",
      },
      bodyHtml: {
        type: "string",
        description:
          "The complete blog body as one HTML string. Each block-level element on its own line, separated by a single newline. First element must be the Quick note disclaimer <p>; last must be the Bottom line <p>.",
      },
    },
  },
};

// Split the single HTML string into the array shape blogData.js wants
// (one entry per top-level block element). Regex matches each
// block-level element greedily but non-overlappingly.
function splitBodyIntoBlocks(html) {
  const text = String(html || "").trim();
  if (!text) return [];
  // Match <h2>...</h2>, <h3>...</h3>, <p>...</p>, <ul>...</ul>,
  // <ol>...</ol>, <blockquote>...</blockquote>. Greedy on the
  // same tag, non-overlapping across tags.
  const blocks = text.match(
    /<(h[1-6]|p|ul|ol|blockquote|figure|hr)\b[^>]*>[\s\S]*?<\/\1>/gi,
  );
  if (blocks && blocks.length > 0) return blocks.map((b) => b.trim());
  // Fallback: split by blank lines.
  return text
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
}

async function writeBlogDraft(client, seed) {
  const response = await client.messages.create({
    model: SONNET_MODEL,
    max_tokens: 8000,
    system: buildSystemPrompt(),
    tools: [SUBMIT_TOOL],
    tool_choice: { type: "tool", name: "submit_blog_draft" },
    messages: [{ role: "user", content: buildUserPrompt(seed) }],
  });

  const toolUse = response.content.find(
    (block) => block.type === "tool_use" && block.name === "submit_blog_draft",
  );
  if (!toolUse) {
    const stopReason = response.stop_reason || "unknown";
    throw new Error(
      `Claude did not call submit_blog_draft (stop_reason: ${stopReason})`,
    );
  }
  const parsed = toolUse.input;
  if (typeof parsed.bodyHtml !== "string" || !parsed.bodyHtml.trim()) {
    throw new Error("bodyHtml missing or not a string");
  }
  const contentBody = splitBodyIntoBlocks(parsed.bodyHtml);
  if (contentBody.length < 5) {
    throw new Error(
      `bodyHtml split into only ${contentBody.length} blocks — likely missing newlines between elements`,
    );
  }

  // Re-attach the seed metadata so the daily bot has everything it needs.
  return {
    id: seed.id,
    title: seed.title,
    teaser: parsed.teaser,
    contentTitle: parsed.contentTitle || seed.title,
    contentBody,
    category: seed.category,
    slide: seed.slide,
    sourceNotes: seed.sourceNotes || null,
    generatedBy: SONNET_MODEL,
    generatedAt: new Date().toISOString(),
  };
}

function createWriter() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not set in env");
  }
  const client = new Anthropic({ apiKey });
  return {
    writeBlogDraft: (seed) => writeBlogDraft(client, seed),
  };
}

module.exports = { createWriter, SONNET_MODEL };
