"use strict";

// One-shot smoke test: verify the OPENAI_API_KEY in Parallel's .env
// works for image generation under gpt-image-1. Generates a single
// 1024x1024 low-quality image to keep cost minimal (~$0.011) and
// writes it to runtime/openai-image-test.png.
//
// Usage: node scripts/test-openai-image.js [prompt]

require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");
  console.log(`key: sk-proj-...${apiKey.slice(-6)} (len ${apiKey.length})`);

  const prompt =
    process.argv[2] ||
    "A clean, professional hero image for a tax-relief landing page: a desk with an open IRS letter, a calculator, and a steaming coffee mug, soft natural light, blurred bookshelf background, photographic, no text overlay.";

  const model = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
  const quality = process.env.OPENAI_IMAGE_QUALITY || "low";
  const body = {
    model,
    prompt,
    n: 1,
    size: "1024x1024",
    quality,
  };

  console.log("requesting image…");
  console.log("  model:", body.model);
  console.log("  size:", body.size);
  console.log("  quality:", body.quality);
  console.log("  prompt:", prompt);

  const start = Date.now();
  const r = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  if (!r.ok) {
    const errText = await r.text();
    console.error(`HTTP ${r.status} after ${elapsed}s`);
    console.error(errText.slice(0, 1000));
    process.exit(1);
  }

  const json = await r.json();
  console.log(`HTTP 200 in ${elapsed}s`);

  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) {
    console.error("no b64_json in response");
    console.error(JSON.stringify(json, null, 2).slice(0, 500));
    process.exit(1);
  }

  const outDir = path.resolve(__dirname, "..", "runtime");
  fs.mkdirSync(outDir, { recursive: true });
  const safeModel = String(model).replace(/[^a-z0-9.-]/gi, "_");
  const outPath = path.join(outDir, `openai-image-test-${safeModel}-${quality}.png`);
  fs.writeFileSync(outPath, Buffer.from(b64, "base64"));
  const stat = fs.statSync(outPath);
  console.log(`wrote ${outPath} (${(stat.size / 1024).toFixed(1)} KB)`);
  console.log("usage:", json.usage || "(not returned)");
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
