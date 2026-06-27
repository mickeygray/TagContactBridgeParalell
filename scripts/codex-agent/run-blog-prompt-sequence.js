"use strict";

// Sequential Codex blog prompt runner.
//
// Default mode renders ONLY the setup prompt and writes it to runtime for review.
// It does not call Codex, publish, commit, deploy, email, or mutate blogger state.
//
// Examples:
//   node scripts/codex-agent/run-blog-prompt-sequence.js
//   node scripts/codex-agent/run-blog-prompt-sequence.js --codex --through setup
//   node scripts/codex-agent/run-blog-prompt-sequence.js --codex --through audit

const fs = require("fs");
const path = require("path");

const { WYNN_REPO } = require("../blogger-paths");
const { createCodexMcpClient } = require("./codexMcpClient");

const PROMPT_DIR = path.resolve(__dirname, "prompts", "blog");
const DEFAULT_OUT_ROOT = path.resolve(__dirname, "..", "..", "runtime", "codex-agent", "blog-sequence");
const DRAFTS_DIR = path.resolve(__dirname, "..", "blog-drafts");
const STATE_FILE = path.resolve(__dirname, "..", "blogger-state.json");
const WYNN_BLOGDATA = path.join(WYNN_REPO, "client", "src", "data", "blogData.js");

const STEPS = Object.freeze([
  { id: "setup", file: "01-setup.md" },
  { id: "topic", file: "02-topic-plan.md" },
  { id: "research", file: "03-research-brief.md" },
  { id: "draft", file: "04-draft.md" },
  { id: "audit", file: "05-accuracy-audit.md" },
  { id: "finalize", file: "06-finalize.md" },
]);

const ALLOWED_CURRENT_EVENT_DOMAINS = Object.freeze([
  "irs.gov",
  "treasury.gov",
  "taxnotes.com",
  "bloombergtax.com",
  "accountingtoday.com",
  "journalofaccountancy.com",
  "natlawreview.com",
  "ntu.org",
  "taxfoundation.org",
]);

function readArg(argv, name, fallback = "") {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  if (index >= 0 && index < argv.length - 1) return argv[index + 1];
  return fallback;
}

function hasArg(argv, name) {
  return argv.includes(name);
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function todayDateKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
  }).format(new Date());
}

function dayOfWeekName() {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "long",
  }).format(new Date());
}

function safeReadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function readPublishedIds(limit = 40) {
  if (!fs.existsSync(WYNN_BLOGDATA)) return [];
  const text = fs.readFileSync(WYNN_BLOGDATA, "utf8");
  const out = [];
  const seen = new Set();
  const regex = /id:\s*"([^"]+)"/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const id = match[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= limit) break;
  }
  return out;
}

function readRecentPublishedTitles(limit = 15) {
  if (!fs.existsSync(WYNN_BLOGDATA)) return [];
  const text = fs.readFileSync(WYNN_BLOGDATA, "utf8");
  const out = [];
  const regex = /title:\s*\n?\s*"([^"]+)"/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    out.push(match[1]);
    if (out.length >= limit) break;
  }
  return out;
}

function readDraftInventory(limitPerCategory = 8) {
  const inventory = {};
  if (!fs.existsSync(DRAFTS_DIR)) return inventory;
  const files = fs.readdirSync(DRAFTS_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort();
  for (const name of files) {
    const file = path.join(DRAFTS_DIR, name);
    const draft = safeReadJson(file, null);
    if (!draft || typeof draft !== "object") continue;
    const category = String(draft.category || "unknown");
    if (!inventory[category]) inventory[category] = { count: 0, samples: [] };
    inventory[category].count += 1;
    if (inventory[category].samples.length < limitPerCategory) {
      inventory[category].samples.push({
        id: draft.id || null,
        title: draft.title || null,
        file: path.relative(path.resolve(__dirname, "..", ".."), file).replace(/\\/g, "/"),
      });
    }
  }
  return inventory;
}

function buildContext(options = {}) {
  return {
    schemaVersion: "codex.blog.context.v1",
    generatedAt: new Date().toISOString(),
    dateKey: options.dateKey || todayDateKey(),
    dayOfWeek: dayOfWeekName(),
    purpose: "Prepare a sequential Codex blog workflow without publishing or mutating state.",
    runnerFiles: [
      "scripts/blogger-daily-runner.js",
      "scripts/blogger-current-event.js",
      "scripts/blogger-claude-writer.js",
      "scripts/blogger-post-pipeline.js",
      "scripts/bloggerContentUtils.js",
      "packages/shared-services/src/aiTaskRegistry.js",
      "packages/shared-services/src/aiSandbox/schemas.js",
    ],
    canonicalDraftShape: {
      fields: [
        "id",
        "title",
        "teaser",
        "contentTitle",
        "contentBody",
        "category",
        "slide",
        "sourceNotes",
        "sourcesUsed",
        "generatedBy",
        "generatedAt",
      ],
      currentEventBodyFieldBeforeFinalize: "bodyHtml",
      requiredSlideFields: [
        "eyebrow",
        "headline1",
        "headline2",
        "badgeTop",
        "badgeCenter",
        "badgeBottom",
        "subhead1",
        "subhead2",
      ],
      bodyHtmlRules: [
        "First block must be a Quick note disclaimer paragraph.",
        "Last block must be a Bottom line paragraph.",
        "Block-level elements must be separated by newlines.",
        "Draft must split into at least 5 blocks before publish path accepts it.",
      ],
    },
    sideEffectBoundary: {
      codexMayPublish: false,
      codexMayCommit: false,
      codexMayDeploy: false,
      codexMayEmail: false,
      codexMayMutateBloggerState: false,
      publishGate: "scripts/blogger-daily-runner.js -> scripts/blogger-post-pipeline.js",
    },
    sources: {
      allowedCurrentEventDomains: ALLOWED_CURRENT_EVENT_DOMAINS,
      forbiddenSources: ["Reddit", "Quora", "social media", "random blogs", "unsourced model memory"],
    },
    guardrails: [
      "Do not fabricate statistics, citations, percentages, dollar thresholds, dates, named officials, or legal rules.",
      "Use {brand} as the brand placeholder in body copy.",
      "Current-event posts must cite source URLs inline and include sourcesUsed.",
      "Duplicate slug guard exists in daily runner and post pipeline; do not bypass it.",
      "Current-event generation throws on failure so daily runner can select a static fallback.",
      "The current-event AI task is Anthropic search-only today; Codex prompt sequence is a separate draft-prep sidecar.",
    ],
    knownDuplication: [
      "scripts/blogger-current-event.js and scripts/blogger-claude-writer.js both produce canonical drafts through different paths.",
      "Seed/static drafts use contentBody; current-event generation receives bodyHtml and splits it later.",
    ],
    runtimeState: {
      bloggerState: safeReadJson(STATE_FILE, {
        lastRunDate: null,
        lastPostedId: null,
        lastFridayCategory: null,
      }),
      recentPublishedTitles: readRecentPublishedTitles(15),
      publishedIdsSample: readPublishedIds(40),
      draftInventory: readDraftInventory(),
    },
  };
}

function renderTemplate(template, values) {
  return template
    .replaceAll("{{contextJson}}", JSON.stringify(values.context, null, 2))
    .replaceAll("{{previousJson}}", JSON.stringify(values.previous || {}, null, 2));
}

function safeJsonParse(text) {
  const value = String(text || "").trim();
  if (!value) throw new Error("empty response");
  try {
    return JSON.parse(value);
  } catch {
    const first = value.indexOf("{");
    const last = value.lastIndexOf("}");
    if (first >= 0 && last > first) {
      return JSON.parse(value.slice(first, last + 1));
    }
    throw new Error("response did not contain a JSON object");
  }
}

function parseOptions(argv) {
  const through = readArg(argv, "--through", "setup").toLowerCase();
  const stepIndex = STEPS.findIndex((step) => step.id === through);
  return {
    help: hasArg(argv, "--help") || hasArg(argv, "-h"),
    codex: hasArg(argv, "--codex"),
    through: stepIndex >= 0 ? through : "setup",
    stepCount: stepIndex >= 0 ? stepIndex + 1 : 1,
    dateKey: readArg(argv, "--date", todayDateKey()),
    outRoot: readArg(argv, "--out-dir", DEFAULT_OUT_ROOT),
    model: readArg(argv, "--model", process.env.CODEX_BLOGGER_MODEL || process.env.CODEX_AGENT_MODEL || ""),
    timeoutMs: Math.max(30000, Number(readArg(argv, "--timeout-ms", process.env.CODEX_BLOGGER_TIMEOUT_MS || "180000")) || 180000),
  };
}

function printHelp() {
  // eslint-disable-next-line no-console
  console.log([
    "Sequential Codex blog prompt runner",
    "",
    "Render setup prompt only, no model call:",
    "  node scripts/codex-agent/run-blog-prompt-sequence.js",
    "",
    "Call Codex for setup only:",
    "  node scripts/codex-agent/run-blog-prompt-sequence.js --codex --through setup",
    "",
    "Call Codex through the audit step:",
    "  node scripts/codex-agent/run-blog-prompt-sequence.js --codex --through audit",
    "",
    "Valid --through values: setup, topic, research, draft, audit, finalize",
  ].join("\n"));
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const runDir = path.join(options.outRoot, `${options.dateKey}-${stamp()}`);
  fs.mkdirSync(runDir, { recursive: true });

  const context = buildContext({ dateKey: options.dateKey });
  fs.writeFileSync(path.join(runDir, "context.json"), JSON.stringify(context, null, 2), "utf8");

  const selectedSteps = STEPS.slice(0, options.stepCount);
  const outputs = [];
  let previous = null;
  let threadId = null;
  let client = null;

  try {
    if (options.codex) {
      client = createCodexMcpClient({
        model: options.model || undefined,
        timeoutMs: options.timeoutMs,
      });
      await client.start();
    }

    for (const step of selectedSteps) {
      const template = fs.readFileSync(path.join(PROMPT_DIR, step.file), "utf8");
      const prompt = renderTemplate(template, { context, previous });
      const promptPath = path.join(runDir, `${step.id}.prompt.md`);
      fs.writeFileSync(promptPath, prompt, "utf8");

      const row = {
        step: step.id,
        promptPath,
        status: options.codex ? "pending" : "rendered",
        outputPath: null,
        error: null,
      };

      if (options.codex) {
        try {
          const response = threadId
            ? await client.reply(threadId, prompt, { timeoutMs: options.timeoutMs })
            : await client.ask(prompt, {
                baseInstructions: "Return JSON only. Do not publish, write files, commit, deploy, email, or mutate external systems.",
                model: options.model || undefined,
                timeoutMs: options.timeoutMs,
                sandbox: "read-only",
                approvalPolicy: "never",
                cwd: path.resolve(__dirname, "..", ".."),
              });
          threadId = response.threadId || threadId;
          const parsed = safeJsonParse(response.text);
          previous = parsed;
          row.status = parsed.status === "blocked" ? "blocked" : "ok";
          row.outputPath = path.join(runDir, `${step.id}.output.json`);
          fs.writeFileSync(row.outputPath, JSON.stringify(parsed, null, 2), "utf8");
          if (row.status === "blocked") {
            outputs.push(row);
            break;
          }
        } catch (error) {
          row.status = "failed";
          row.error = error.message;
          outputs.push(row);
          break;
        }
      }

      outputs.push(row);
    }
  } finally {
    if (client) client.stop();
  }

  const summary = {
    ok: outputs.every((row) => !["failed"].includes(row.status)),
    mode: options.codex ? "codex" : "render-only",
    runDir,
    through: options.through,
    steps: outputs,
  };
  fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
