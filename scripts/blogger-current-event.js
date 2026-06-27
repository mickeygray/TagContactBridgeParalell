"use strict";

// Wednesday's slot — generates a fresh current-event blog by giving
// Sonnet the web-search tool and letting it pick + write the story.
// Strict guardrails: only IRS / reputable tax-press sources, real
// citations with URLs, no fabricated stats. Returns a draft in the
// canonical shape ready to feed `publishBlog()`.
//
// The daily-runner calls this on Wednesdays AND when the Friday
// rotation lands on "current-event".

const { createAnthropicClient } = require("../packages/shared-integrations/src");
const { createAiProviders } = require("../packages/shared-services/src/aiProviders");
const { createAiTaskRunner } = require("../packages/shared-services/src/aiTaskRunner");
const { SUBMIT_CURRENT_EVENT_BLOG } = require("../packages/shared-services/src/aiSandbox/schemas");
const { splitBodyIntoBlocks } = require("./bloggerContentUtils");

// The current-event blog now runs through the unified AI bus as the agentic
// `blogger.currentEvent` task (kind: "search" — a web_search → submit loop). The
// bus owns provider routing, failover-readiness, contract validation, fail-closed,
// and telemetry; the agent (`claude -p`) provider slots in ahead of the API later.
const BLOG_TASK = "blogger.currentEvent";
const DEFAULT_TOTAL_TIMEOUT_MS = readPositiveIntegerEnv(
  "BLOGGER_CURRENT_EVENT_TIMEOUT_MS",
  90 * 1000,
);

const ALLOWED_DOMAINS = [
  "irs.gov",
  "treasury.gov",
  "taxnotes.com",
  "bloombergtax.com",
  "accountingtoday.com",
  "journalofaccountancy.com",
  "natlawreview.com",
  "ntu.org",
  "taxfoundation.org",
];

function readPositiveIntegerEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function buildSystemPrompt() {
  return [
    "You are a senior tax-resolution writer producing a current-event blog post for two firms (Wynn Tax Solutions and Tax Advocate Group). Both serve taxpayers with IRS collection issues, unfiled returns, audits, and tax debt resolution.",
    "",
    "Your job today: use the web_search tool to find a recent (last 14 days) news item from the IRS, Treasury, or reputable tax press that's relevant to taxpayers with IRS debt or compliance issues. Then write the blog about it.",
    "",
    "Acceptable sources (cite URL inline as <a> tags):",
    "  - irs.gov (announcements, fact sheets, IRS bulletins)",
    "  - treasury.gov",
    "  - taxnotes.com, bloombergtax.com",
    "  - accountingtoday.com, journalofaccountancy.com",
    "  - natlawreview.com, taxfoundation.org",
    "",
    "Search strategy: start with `IRS news last week`, then narrow based on what looks blog-worthy for our audience. Look for: new IRS programs/tools, enforcement priorities, court rulings affecting collections, regulatory changes, deadline reminders. Avoid: obvious press-release filler, generic 'tax season' coverage, partisan opinion pieces.",
    "",
    "Hard rules (same as our normal posts):",
    "- DO NOT FABRICATE stats, dates, dollar thresholds, percentages, or named officials. Only use facts directly supported by your search results.",
    "- Cite source URLs inline as <a> tags. Multiple sources strengthen the post.",
    "- Use {brand} as a placeholder where the firm name appears in the body. The daily bot interpolates the actual brand at post time.",
    "- Voice: candid, expert, no hype. Match the existing canonical posts on each site (long-form, multiple <h2> sections, lists with concrete numbers and timing, real form/statute references).",
    "- Length target: 1,400-2,000 words across the body.",
    "- bodyHtml is the COMPLETE blog body as one HTML string. Each block-level element (<h2>, <p>, <ul>, <ol>) on its own line, separated by a single newline. First element must be the disclaimer; last must be a Bottom line paragraph.",
    "",
    "When you have all the research and the draft is ready, call the `submit_current_event_blog` tool. Don't respond with prose — only the tool call.",
  ].join("\n");
}

function buildUserPrompt({ recentPublishedTitles = [] } = {}) {
  const recentBlock = recentPublishedTitles.length
    ? [
        "",
        "Recently published posts on these sites — DO NOT cover any of these topics; pick something different. If your search returns a story we already covered, dig deeper or pick a different angle/event:",
        ...recentPublishedTitles.map((title) => `  - ${title}`),
        "",
      ].join("\n")
    : "";
  return [
    `Today is ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}.`,
    "",
    "Find a current event from the last 14 days that's relevant to taxpayers with IRS debt or compliance issues. Write a long-form blog about it.",
    "",
    "Choose the topic and id yourself based on what you find. Use kebab-case for the id (e.g., 'irs-launches-tax-debt-tool-april-2026' or 'treasury-no-tax-on-tips-final-regs-april-2026'). Title should be a headline, not a question.",
    "",
    "Pick the slide values (eyebrow, headlines, badge, subheads) to match the topic. Eyebrow should be a tag like 'IRS NEWS — APRIL 2026'. Headlines should be two short lines that work together. Badge should be a 3-line stack of meaningful labels (e.g., LAUNCHED / APR 16 / 2026). Subheads should be the one-sentence value prop.",
    recentBlock,
    "Call `submit_current_event_blog` when done.",
  ].join("\n");
}

const WEB_SEARCH_TOOL = {
  type: "web_search_20250305",
  name: "web_search",
  max_uses: 6,
  allowed_domains: ALLOWED_DOMAINS,
};

// Anthropic-only in-process runner — the web_search agentic loop is Anthropic's
// server-side tool (OpenAI can't do it), so the task's providerOrder is
// ["anthropic"] and we wire only that client. Lazy; injectable for tests.
// Telemetry emits the bus's standard `ai_task.run` row (task/provider/model/
// status/usage) so blog spend is attributed on the same shape as every other bus
// task — closing the split-brain-telemetry gap for this service.
let _runner = null;
function defaultRunner() {
  if (_runner) return _runner;
  _runner = createAiTaskRunner({
    providers: createAiProviders({ anthropic: createAnthropicClient() }),
    telemetry: {
      record: (row) => {
        try {
          console.log("[blogger] ai_task.run", JSON.stringify(row));
        } catch {
          /* telemetry must never break the post */
        }
      },
    },
  });
  return _runner;
}

async function generateCurrentEventBlog(options = {}) {
  const runner = options.runner || defaultRunner();
  const totalTimeoutMs =
    Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
      ? Number(options.timeoutMs)
      : DEFAULT_TOTAL_TIMEOUT_MS;

  const res = await runner.runAiTask(
    BLOG_TASK,
    {
      system: buildSystemPrompt(),
      user: buildUserPrompt(options),
      tools: [WEB_SEARCH_TOOL],
      submitTool: {
        name: SUBMIT_CURRENT_EVENT_BLOG.name,
        description: SUBMIT_CURRENT_EVENT_BLOG.description,
        schema: SUBMIT_CURRENT_EVENT_BLOG.input_schema,
      },
      maxToolTurns: 8,
      timeoutMs: totalTimeoutMs,
    },
    { label: BLOG_TASK },
  );

  // Bus failure (provider error / timeout / contract-invalid / disabled) comes
  // back as ok:false. Throw so the daily-runner's static-draft fallback fires —
  // preserving the original contract exactly.
  if (!res || res.ok === false) {
    const lastAttempt =
      res && Array.isArray(res.attempts) && res.attempts.length
        ? res.attempts[res.attempts.length - 1]
        : null;
    const reason =
      (res && res.code) ||
      (lastAttempt && (lastAttempt.error || lastAttempt.reason)) ||
      "unknown";
    throw new Error(`current-event generation failed: ${reason}`);
  }

  const result = res.result || {};
  const contentBody = splitBodyIntoBlocks(result.bodyHtml);
  if (contentBody.length < 5) {
    throw new Error(
      `bodyHtml split into only ${contentBody.length} blocks — likely missing newlines`,
    );
  }

  return {
    id: result.id,
    title: result.title,
    teaser: result.teaser,
    contentTitle: result.contentTitle || result.title,
    contentBody,
    category: "current-event",
    slide: result.slide,
    sourceNotes: `Web search (${(result.sourcesUsed || []).length} sources)`,
    sourcesUsed: result.sourcesUsed || [],
    generatedBy: res.model || "anthropic",
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { generateCurrentEventBlog };
