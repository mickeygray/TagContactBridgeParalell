"use strict";

// Generate OpenAI-driven hero images for a handful of real blog
// topics so we can A/B against the existing SVG headers.
//
// Writes to runtime/blog-openai-samples/<slug>.png. Does NOT touch
// the live Wynn repo's images/ directory — purely a side-by-side
// experiment.
//
// Usage:
//   node scripts/test-blog-openai-images.js
//
// Env overrides (same as the main pipeline):
//   OPENAI_IMAGE_MODEL=gpt-image-1    (default)
//   OPENAI_IMAGE_QUALITY=low | medium | high
//   OPENAI_IMAGE_SIZE=1024x1024       (default)

require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");

// Sample drafts modeled on the canonical shape used by the post
// pipeline. These mirror real recent topics so the AB compare is
// against output that's actually being shipped.
const SAMPLE_DRAFTS = [
  {
    id: "offer-in-compromise-pennies-on-the-dollar-myth-vs-reality",
    title:
      "Offer in Compromise: Pennies on the Dollar — Myth vs Reality",
    category: "relief-type",
    slide: {
      eyebrow: "OFFER IN COMPROMISE",
      headline1: "Pennies on the Dollar:",
      headline2: "Myth vs Reality",
    },
  },
  {
    id: "irs-currently-not-collectible-cnc-status-explained",
    title: "Currently Not Collectible: How the IRS's 'We'll Wait' Status Works",
    category: "relief-type",
    slide: {
      eyebrow: "CURRENTLY NOT COLLECTIBLE",
      headline1: "When the IRS",
      headline2: "Has to Wait",
    },
  },
  {
    id: "what-is-a-substitute-for-return-sfr-and-why-it-hurts",
    title:
      "What Is a Substitute for Return (SFR) — and Why an IRS-Filed Return Is Almost Always Worse Than Your Own",
    category: "enforcement-doc",
    slide: {
      eyebrow: "SUBSTITUTE FOR RETURN",
      headline1: "When the IRS",
      headline2: "Files for You",
    },
  },
];

function buildPrompt(draft) {
  const eyebrow = String(draft.slide?.eyebrow || draft.category || "").trim();
  const headline = String(
    [draft.slide?.headline1, draft.slide?.headline2].filter(Boolean).join(" "),
  ).trim() || String(draft.title || "").trim();
  const subject = headline || "tax relief topic";

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

async function generateOne(draft, outDir) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  const model = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
  const quality = process.env.OPENAI_IMAGE_QUALITY || "low";
  const size = process.env.OPENAI_IMAGE_SIZE || "1024x1024";
  const prompt = buildPrompt(draft);

  console.log(`\n--- ${draft.id} ---`);
  console.log(`prompt: ${prompt}`);
  const start = Date.now();
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
    console.error(`HTTP ${r.status}: ${errText.slice(0, 300)}`);
    return null;
  }
  const json = await r.json();
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) {
    console.error("no b64_json", JSON.stringify(json).slice(0, 200));
    return null;
  }
  const buffer = Buffer.from(b64, "base64");
  const outPath = path.join(outDir, `${draft.id}.png`);
  fs.writeFileSync(outPath, buffer);
  console.log(
    `wrote ${outPath} (${(buffer.length / 1024).toFixed(0)} KB) in ${((Date.now() - start) / 1000).toFixed(1)}s`,
  );
  return outPath;
}

async function main() {
  const outDir = path.resolve(__dirname, "..", "runtime", "blog-openai-samples");
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`out dir: ${outDir}`);
  for (const draft of SAMPLE_DRAFTS) {
    await generateOne(draft, outDir);
  }
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
