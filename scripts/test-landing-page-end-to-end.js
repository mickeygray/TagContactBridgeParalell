"use strict";

// End-to-end smoke test of the landing-page creator pipeline. Fills
// the structured composer with my-choice values, composes the prompt,
// calls Claude tool-use, calls gpt-image-2 for the hero, and writes
// the result to runtime/landing-pages/<slug>.{json,png}.
//
// Surfaces the generated content so the operator can see what comes
// back BEFORE we wire up the full git-branch + auto-deploy flow.

require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");

const {
  createAnthropicClient,
  extractToolUse,
} = require("../packages/shared-integrations/src/anthropicClient");

// ── Test draft: CNC relief landing page for Wynn ───────────────
//
// Goal: meaningful real content, with rich form construction (3
// steps, card-grid + slider + name/email/phone), authoritative voice,
// stagger entry motion. Picked to mirror the kind of page the operator
// would actually want to ship.
const DRAFT = {
  brand: "wynn",
  brandLabel: "Wynn Tax Solutions",
  slug: "cnc-relief-self-employed",
  subject:
    "Currently Not Collectible status for self-employed taxpayers buried in IRS debt",
  audience:
    "1099 contractors, gig workers, and small-business owners in CA/NV/TX with $15k+ IRS debt, behind on at least one year of returns, payment plan rejected or unaffordable",
  cta: "See if I qualify in 2 minutes",
  bareNav: true,

  visualMood: "Authoritative",
  density: "Balanced",
  imagery: "Photographic",
  colorLeaning: "warm navy + muted cream, single gold accent",
  designNotes:
    "Lean editorial like a NYT business section piece. Single hero image. Trust badges as small monochrome icons, not stock-logo-bar. Numbers should feel quoted (large quote-graphic style).",

  voice: "Empathetic",
  readingLevel: "Conversational (~8th grade)",
  forbiddenPhrases:
    "pennies on the dollar, settle for less, drowning, life-changing, miracle",
  requiredPhrases: "Currently Not Collectible",
  voiceNotes:
    "Talk to the reader like a calm advisor. They're scared but they're not stupid. No hype, no fake urgency, no exclamation points. First-person from the brand POV (\"we\"), second-person to the reader (\"you\").",

  steps: 3,
  fields: [
    {
      step: 1,
      label: "What's the biggest issue right now?",
      type: "Card grid (visual tiles)",
      options: [
        "I owe more than I can pay",
        "I haven't filed in years",
        "IRS started garnishing my wages",
        "IRS levied my bank account",
        "I got an audit notice",
        "I'm not sure where to start",
      ],
      required: true,
      postsToBackend: true,
    },
    {
      step: 2,
      label: "Roughly how much do you owe?",
      type: "Slider",
      options: [],
      required: true,
      postsToBackend: true,
    },
    {
      step: 3,
      label: "Full name",
      type: "Short text",
      required: true,
      postsToBackend: true,
      locked: "name",
    },
    {
      step: 3,
      label: "Email",
      type: "Short text",
      required: true,
      postsToBackend: true,
      locked: "email",
    },
    {
      step: 3,
      label: "Phone",
      type: "Short text",
      required: true,
      postsToBackend: true,
      locked: "phone",
    },
  ],

  motionEntry: "Staggered",
  motionSection: "Soft fade",
  motionInteraction: "Card lift",
  motionSpeed: "Standard (~250ms)",
  motionNotes:
    "Hero copy fades in first, then the form slides up. As the user scrolls, trust badges stagger in. Buttons get a soft scale-up on hover, not a jumpy bloom.",

  freeFormNotes:
    "Reference: the calm tone of FreshBooks' landing pages, the trust signaling of TurboTax for self-employed, the editorial photography of Notion's product pages. No happy-stock-photo families. No salesman vibe.",
};

function describeFields(fields, stepCount) {
  const byStep = new Map();
  for (const f of fields) {
    const arr = byStep.get(f.step) || [];
    arr.push(f);
    byStep.set(f.step, arr);
  }
  const lines = [];
  for (let s = 1; s <= stepCount; s++) {
    const list = byStep.get(s) || [];
    if (!list.length) continue;
    lines.push(`  Step ${s}:`);
    for (const f of list) {
      const opts =
        f.options && f.options.length ? ` — options: [${f.options.join(", ")}]` : "";
      const posts = f.locked
        ? " [posts to backend]"
        : f.postsToBackend
          ? " [posts to backend as metadata]"
          : " [presentation-only, NOT posted]";
      const req = f.required ? " (required)" : "";
      lines.push(`    • ${f.label} — ${f.type}${req}${opts}${posts}`);
    }
  }
  return lines.join("\n");
}

function composePrompt(d) {
  return `You are an expert landing-page generator for ${d.brandLabel} (a tax-relief brand operated alongside Tax Advocate Group). Your output strictly matches the JSON tool schema you've been given. Do NOT generate code — only structured content; the post-processor renders the JSX.

== SUBJECT ==
${d.subject}

== AUDIENCE ==
${d.audience}

== CTA ==
${d.cta}

== DESIGN LANGUAGE ==
Visual mood: ${d.visualMood}
Color leaning: ${d.colorLeaning}
Density: ${d.density}
Imagery direction: ${d.imagery}
Notes: ${d.designNotes}

== COPY VOICE ==
Voice: ${d.voice}
Reading level: ${d.readingLevel}
Forbidden phrases: ${d.forbiddenPhrases}
Required phrases: ${d.requiredPhrases}
Notes: ${d.voiceNotes}

== FORM CONSTRUCTION (PRESENTATION) ==
Steps: ${d.steps}
${describeFields(d.fields, d.steps)}

IMPORTANT: the lead form POSTS only name, email, phone (+ metadata) to the existing /lead-contact webhook. Other fields are presentation-only — they qualify visually but get stamped on the payload as metadata where marked. Do not redesign the post payload.

== MOTION & ANIMATION ==
Entry: ${d.motionEntry}
Section transitions: ${d.motionSection}
Interaction motion: ${d.motionInteraction}
Speed: ${d.motionSpeed}
Notes: ${d.motionNotes}

== LAYOUT ==
${d.bareNav ? "Bare route — no Navbar, no Footer." : "Full route — Navbar + Footer wrap the page."}

== OPERATOR FREE-FORM NOTES ==
${d.freeFormNotes}
`;
}

const TOOL_SCHEMA = {
  name: "submit_landing_page_draft",
  description:
    "Submit the structured landing-page draft. The post-processor renders this into JSX, attaches the form, generates the hero image, and commits on a feature branch.",
  input_schema: {
    type: "object",
    required: [
      "headline",
      "subhead",
      "bullets",
      "sections",
      "faq",
      "imagePrompt",
      "seoTitle",
      "seoDescription",
      "jsonLd",
    ],
    properties: {
      headline: {
        type: "string",
        description: "Hero headline. <= 90 chars. No exclamation points.",
      },
      subhead: {
        type: "string",
        description:
          "Supporting subhead under the headline. <= 240 chars. Sets up the page promise + qualifier.",
      },
      bullets: {
        type: "array",
        items: { type: "string", description: "<= 90 chars per bullet" },
        description:
          "3-5 short proof/promise bullets that appear under the form. Concrete, not vague.",
      },
      sections: {
        type: "array",
        items: {
          type: "object",
          required: ["title", "body"],
          properties: {
            title: { type: "string" },
            body: {
              type: "array",
              items: { type: "string" },
              description: "1-3 short paragraphs for this section.",
            },
          },
        },
        description:
          "3-4 supporting content blocks below the form. Build the case the audience needs to see.",
      },
      faq: {
        type: "array",
        items: {
          type: "object",
          required: ["q", "a"],
          properties: {
            q: { type: "string" },
            a: { type: "string" },
          },
        },
        description: "3-5 plain-conversational Q&A.",
      },
      imagePrompt: {
        type: "string",
        description:
          "Concept prompt for gpt-image-2. NO text, NO faces, photographic editorial style. Should suggest the subject matter without showing literal IRS letters that would render as gibberish text.",
      },
      seoTitle: { type: "string", description: "<= 60 chars" },
      seoDescription: { type: "string", description: "<= 155 chars" },
      jsonLd: {
        type: "object",
        description:
          "JSON-LD schema graph. Must be a valid schema.org WebPage + Service object. Returned object is serialized as <script type=\"application/ld+json\">.",
      },
    },
  },
};

async function callClaude(prompt) {
  const client = createAnthropicClient();
  const result = await client.createMessage({
    system:
      "You are an expert landing-page writer for tax-relief brands. You output structured JSON via the submit_landing_page_draft tool. Never write code or JSX — only content. Follow the operator's design + voice + motion direction precisely. Honor forbidden phrases (never use them) and required phrases (use exactly the wording given). Concrete, calm, honest tone. Numbers and proof beat adjectives.",
    messages: [{ role: "user", content: prompt }],
    tools: [TOOL_SCHEMA],
    toolChoice: { type: "tool", name: "submit_landing_page_draft" },
    maxTokens: 4096,
    temperature: 0.4,
    timeoutMs: 60_000,
  });
  const toolUse = extractToolUse(result, "submit_landing_page_draft");
  if (!toolUse) {
    throw new Error("Claude did not call the submit_landing_page_draft tool");
  }
  return { draft: toolUse.input, raw: result };
}

async function callOpenAiImage(prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");
  const r = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-2",
      prompt,
      n: 1,
      size: "1024x1024",
      quality: process.env.OPENAI_IMAGE_QUALITY || "low",
    }),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`OpenAI HTTP ${r.status}: ${txt.slice(0, 400)}`);
  }
  const json = await r.json();
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) throw new Error("no b64_json in OpenAI response");
  return Buffer.from(b64, "base64");
}

async function main() {
  const outDir = path.resolve(__dirname, "..", "runtime", "landing-pages");
  fs.mkdirSync(outDir, { recursive: true });

  const prompt = composePrompt(DRAFT);
  const promptPath = path.join(outDir, `${DRAFT.slug}.prompt.txt`);
  fs.writeFileSync(promptPath, prompt);
  console.log(`composed prompt → ${promptPath} (${prompt.length} chars)`);

  console.log("\n[1/2] calling Claude…");
  const claudeStart = Date.now();
  const { draft: pageDraft, raw } = await callClaude(prompt);
  const claudeElapsed = ((Date.now() - claudeStart) / 1000).toFixed(1);
  console.log(`  ✓ Claude returned in ${claudeElapsed}s`);
  console.log(`  model: ${raw?.model}`);
  console.log(`  usage: in=${raw?.usage?.input_tokens} out=${raw?.usage?.output_tokens}`);

  const jsonPath = path.join(outDir, `${DRAFT.slug}.json`);
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        slug: DRAFT.slug,
        brand: DRAFT.brand,
        generatedAt: new Date().toISOString(),
        claudeModel: raw?.model,
        claudeUsage: raw?.usage,
        composerDraft: DRAFT,
        pageDraft,
      },
      null,
      2,
    ),
  );
  console.log(`  → ${jsonPath}`);

  console.log("\n[2/2] calling OpenAI gpt-image-2…");
  console.log(`  prompt: ${pageDraft.imagePrompt}`);
  const imgStart = Date.now();
  const imgBuffer = await callOpenAiImage(pageDraft.imagePrompt);
  const imgElapsed = ((Date.now() - imgStart) / 1000).toFixed(1);
  const imgPath = path.join(outDir, `${DRAFT.slug}.png`);
  fs.writeFileSync(imgPath, imgBuffer);
  console.log(
    `  ✓ hero image in ${imgElapsed}s (${(imgBuffer.length / 1024).toFixed(0)} KB) → ${imgPath}`,
  );

  console.log("\n── headline ──");
  console.log(pageDraft.headline);
  console.log("\n── subhead ──");
  console.log(pageDraft.subhead);
  console.log("\n── bullets ──");
  for (const b of pageDraft.bullets) console.log(`  • ${b}`);
  console.log("\n── sections ──");
  for (const s of pageDraft.sections) {
    console.log(`  ▸ ${s.title}`);
    for (const p of s.body) console.log(`     ${p.slice(0, 120)}${p.length > 120 ? "…" : ""}`);
  }
  console.log("\n── FAQ ──");
  for (const f of pageDraft.faq) {
    console.log(`  Q: ${f.q}`);
    console.log(`  A: ${f.a.slice(0, 120)}${f.a.length > 120 ? "…" : ""}`);
  }
  console.log("\n── SEO ──");
  console.log(`  title: ${pageDraft.seoTitle}`);
  console.log(`  description: ${pageDraft.seoDescription}`);
  console.log("\n── done ──");
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  if (err.details) console.error(err.details);
  process.exit(1);
});
