"use strict";

// Wednesday's slot — generates a fresh current-event blog by giving
// Sonnet the web-search tool and letting it pick + write the story.
// Strict guardrails: only IRS / reputable tax-press sources, real
// citations with URLs, no fabricated stats. Returns a draft in the
// canonical shape ready to feed `publishBlog()`.
//
// The daily-runner calls this on Wednesdays AND when the Friday
// rotation lands on "current-event".

const Anthropic = require("@anthropic-ai/sdk");

const SONNET_MODEL = "claude-sonnet-4-5-20250929";
const DEFAULT_TOTAL_TIMEOUT_MS = readPositiveIntegerEnv(
  "BLOGGER_CURRENT_EVENT_TIMEOUT_MS",
  90 * 1000,
);
const DEFAULT_REQUEST_TIMEOUT_MS = readPositiveIntegerEnv(
  "BLOGGER_CURRENT_EVENT_REQUEST_TIMEOUT_MS",
  45 * 1000,
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

function createRequestAbort(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`request timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  if (typeof timer.unref === "function") timer.unref();
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
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

const SUBMIT_TOOL = {
  name: "submit_current_event_blog",
  description:
    "Submit the finished current-event blog draft. bodyHtml must be the complete blog body as one HTML string with each block element on its own line, separated by newlines.",
  input_schema: {
    type: "object",
    required: [
      "id",
      "title",
      "teaser",
      "contentTitle",
      "bodyHtml",
      "slide",
      "sourcesUsed",
    ],
    properties: {
      id: {
        type: "string",
        description: "kebab-case slug, includes a date hint (e.g., 'foo-bar-april-2026').",
      },
      title: { type: "string" },
      teaser: { type: "string" },
      contentTitle: { type: "string" },
      bodyHtml: {
        type: "string",
        description:
          "Complete body HTML, block elements separated by single newlines. First element is disclaimer; last is Bottom line.",
      },
      slide: {
        type: "object",
        required: [
          "eyebrow",
          "headline1",
          "headline2",
          "badgeTop",
          "badgeCenter",
          "badgeBottom",
          "subhead1",
          "subhead2",
        ],
        properties: {
          eyebrow: { type: "string" },
          headline1: { type: "string" },
          headline2: { type: "string" },
          badgeTop: { type: "string" },
          badgeCenter: { type: "string" },
          badgeBottom: { type: "string" },
          subhead1: { type: "string" },
          subhead2: { type: "string" },
        },
      },
      sourcesUsed: {
        type: "array",
        items: { type: "string" },
        description: "URLs of the sources used to support the post.",
      },
    },
  },
};

function splitBodyIntoBlocks(html) {
  const text = String(html || "").trim();
  if (!text) return [];
  const blocks = text.match(
    /<(h[1-6]|p|ul|ol|blockquote|figure|hr)\b[^>]*>[\s\S]*?<\/\1>/gi,
  );
  if (blocks && blocks.length > 0) return blocks.map((b) => b.trim());
  return text
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
}

async function generateCurrentEventBlog(options = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  const totalTimeoutMs =
    Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
      ? Number(options.timeoutMs)
      : DEFAULT_TOTAL_TIMEOUT_MS;
  const startedAt = Date.now();
  const deadlineAt = startedAt + totalTimeoutMs;
  const client = new Anthropic({
    apiKey,
    maxRetries: 0,
    timeout: Math.min(DEFAULT_REQUEST_TIMEOUT_MS, totalTimeoutMs),
  });

  // Anthropic's web-search tool is built-in. We allow Claude to make
  // multiple search/fetch calls before finally calling our submit tool.
  let messages = [{ role: "user", content: buildUserPrompt(options) }];
  let result = null;
  const MAX_TURNS = 8;
  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      throw new Error(
        `current-event generation timed out after ${totalTimeoutMs}ms`,
      );
    }

    const requestTimeoutMs = Math.max(
      1000,
      Math.min(DEFAULT_REQUEST_TIMEOUT_MS, remainingMs),
    );
    const abort = createRequestAbort(requestTimeoutMs);
    let response;
    try {
      response = await client.messages.create(
        {
          model: SONNET_MODEL,
          max_tokens: 8000,
          system: buildSystemPrompt(),
          tools: [
            {
              type: "web_search_20250305",
              name: "web_search",
              max_uses: 6,
              allowed_domains: ALLOWED_DOMAINS,
            },
            SUBMIT_TOOL,
          ],
          messages,
        },
        {
          maxRetries: 0,
          signal: abort.signal,
          timeout: requestTimeoutMs,
        },
      );
    } catch (err) {
      if (abort.signal.aborted) {
        throw new Error(
          `current-event generation timed out after ${Date.now() - startedAt}ms`,
        );
      }
      throw err;
    } finally {
      abort.clear();
    }

    // Did Claude call the submit tool? If so, we're done.
    const submitCall = response.content.find(
      (block) =>
        block.type === "tool_use" && block.name === "submit_current_event_blog",
    );
    if (submitCall) {
      result = submitCall.input;
      break;
    }

    // If Claude stopped without calling submit and didn't request more
    // tool input, that means it gave up. Bail.
    if (response.stop_reason !== "tool_use") {
      throw new Error(
        `Claude stopped without calling submit_current_event_blog (stop_reason: ${response.stop_reason})`,
      );
    }

    // Append the assistant turn and let the SDK auto-handle the
    // server-side web_search tool — actually, web_search is a
    // server-side tool, results come back inline. We just need to
    // pass the response back through and continue the loop.
    messages = messages.concat([
      { role: "assistant", content: response.content },
    ]);
    // For server-side tools (web_search_20250305), Anthropic handles
    // the tool execution and returns the result inline in the
    // assistant message. The next iteration's `messages.create` call
    // will let Claude continue from that state. No manual tool_result
    // injection needed.
  }

  if (!result) {
    throw new Error(
      `Hit MAX_TURNS (${MAX_TURNS}) without Claude calling submit_current_event_blog`,
    );
  }

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
    sourceNotes: `Web search (${result.sourcesUsed.length} sources)`,
    sourcesUsed: result.sourcesUsed,
    generatedBy: SONNET_MODEL,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { generateCurrentEventBlog };
