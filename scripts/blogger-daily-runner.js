"use strict";

// Blogger daily runner — fired once per business day by Windows
// Task Scheduler. Picks today's topic per day-of-week, posts it,
// emails the summary. Designed to be safely re-runnable: if today's
// post already went out, it short-circuits.
//
// Day-of-week schedule:
//   Mon  → enforcement-doc draft (FIFO from drafts/)
//   Tue  → relief-type draft (FIFO from drafts/)
//   Wed  → current-event (web search via Sonnet)
//   Thu  → success-story (reads success-stories/queue.json)
//   Fri  → rotates: enforcement-doc → relief-type → current-event → success-story
//   Sat/Sun → no-op
//
// State persists in scripts/blogger-state.json:
//   {
//     lastRunDate: "YYYY-MM-DD",
//     lastPostedId: "...",
//     lastFridayCategory: "enforcement-doc" | "relief-type" | ...
//   }
//
// Usage:
//   node scripts/blogger-daily-runner.js                  # normal cron run
//   node scripts/blogger-daily-runner.js --dry-run        # show plan, no writes
//   node scripts/blogger-daily-runner.js --preflight      # verify publish prerequisites, no writes
//   node scripts/blogger-daily-runner.js --force          # ignore "already ran today"
//   node scripts/blogger-daily-runner.js --override <day> # pretend it's a specific day
//                                                          (mon|tue|wed|thu|fri)

const fs = require("fs");
const path = require("path");

require("dotenv").config({
  path: path.resolve(__dirname, "..", ".env"),
  override: true,
});

const { publishBlog, runPreflight } = require("./blogger-post-pipeline");
const { generateCurrentEventBlog } = require("./blogger-current-event");

const DRAFTS_DIR = path.resolve(__dirname, "blog-drafts");
const POSTED_DIR = path.join(DRAFTS_DIR, "posted");
const STATE_FILE = path.resolve(__dirname, "blogger-state.json");
const SUCCESS_STORIES_QUEUE = path.resolve(__dirname, "success-stories-queue.json");
const SUCCESS_STORIES_POSTED = path.resolve(__dirname, "success-stories-posted.json");
const WYNN_BLOGDATA = "C:/Users/Admin/Code/WynnTax/client/src/data/blogData.js";
const RUNTIME_DIR = path.resolve(__dirname, "..", "runtime", "blogger");
const RUN_LOG_DIR = path.join(RUNTIME_DIR, "runs");
const CURRENT_EVENT_TIMEOUT_MS = readPositiveIntegerEnv(
  "BLOGGER_CURRENT_EVENT_TIMEOUT_MS",
  90 * 1000,
);

fs.mkdirSync(POSTED_DIR, { recursive: true });
fs.mkdirSync(RUN_LOG_DIR, { recursive: true });

const RUN_LOG_FILE = path.join(
  RUN_LOG_DIR,
  `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-daily-runner.log`,
);

installRunLogger();

function readPositiveIntegerEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function serializeLogArg(arg) {
  if (arg instanceof Error) return arg.stack || arg.message;
  if (typeof arg === "string") return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function installRunLogger() {
  const originalLog = console.log.bind(console);
  const originalError = console.error.bind(console);
  const append = (level, args) => {
    const line = `[${new Date().toISOString()}] [${level}] ${args
      .map(serializeLogArg)
      .join(" ")}`;
    try {
      fs.appendFileSync(RUN_LOG_FILE, `${line}\n`, "utf8");
    } catch {
      // If disk logging fails, keep stdout/stderr behavior unchanged.
    }
  };

  console.log = (...args) => {
    originalLog(...args);
    append("info", args);
  };
  console.error = (...args) => {
    originalError(...args);
    append("error", args);
  };

  console.log(`[daily-runner] run log: ${RUN_LOG_FILE}`);
}

// Pull every published id out of the live blogData.js so we never
// re-post a duplicate. Cheap regex scan — `id: "..."` is the literal
// shape both repos use; we read just one (Wynn) since both repos are
// kept in lockstep by the publish pipeline.
function readPublishedIds() {
  if (!fs.existsSync(WYNN_BLOGDATA)) return new Set();
  const text = fs.readFileSync(WYNN_BLOGDATA, "utf8");
  const ids = new Set();
  const regex = /id:\s*"([^"]+)"/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    ids.add(match[1]);
  }
  return ids;
}

// Pull the most recent N titles from blogData.js. Used to give the
// web-search Sonnet active "do not repeat" context — the dedup guard
// catches exact id matches but a soft-list of recent titles helps
// Sonnet pick a fresh angle even when the underlying news is similar.
function readRecentPublishedTitles(limit = 15) {
  if (!fs.existsSync(WYNN_BLOGDATA)) return [];
  const text = fs.readFileSync(WYNN_BLOGDATA, "utf8");
  // Titles can be on the same line (`title: "..."`) or wrap onto the
  // next (`title:\n  "..."`) — match both.
  const regex = /title:\s*\n?\s*"([^"]+)"/g;
  const titles = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    titles.push(match[1]);
    if (titles.length >= limit) break;
  }
  return titles;
}

// Friday rotation. Success-story is excluded until the case queue
// (scripts/success-stories-queue.json) gets populated — wire it
// back into the array when that lands.
const FRIDAY_ROTATION = [
  "enforcement-doc",
  "relief-type",
  "current-event",
];

// ── State ────────────────────────────────────────────────────────

function readState() {
  if (!fs.existsSync(STATE_FILE)) {
    return { lastRunDate: null, lastPostedId: null, lastFridayCategory: null };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { lastRunDate: null, lastPostedId: null, lastFridayCategory: null };
  }
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function todayDateKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
  }).format(new Date());
}

function todayDayOfWeek(override = null) {
  if (override) {
    const map = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5 };
    return map[override.toLowerCase()] ?? null;
  }
  // 0=Sun, 1=Mon, ..., 6=Sat in PT
  const ptDate = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }),
  );
  return ptDate.getDay();
}

function dayName(dow) {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dow] || `?${dow}`;
}

// ── Topic resolution ─────────────────────────────────────────────

// FIFO: oldest unposted draft in the requested category.
// Mtime is a reasonable proxy — older files = older mtime.
function pickDraftForCategory(category) {
  const publishedIds = readPublishedIds();
  const files = fs.readdirSync(DRAFTS_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(DRAFTS_DIR, name));
  const candidates = [];
  for (const file of files) {
    let draft;
    try {
      draft = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (draft.category !== category) continue;
    if (draft.id && publishedIds.has(draft.id)) continue;
    candidates.push({ file, draft, mtime: fs.statSync(file).mtimeMs });
  }
  candidates.sort((left, right) => left.mtime - right.mtime);
  return candidates[0] || null;
}

function planFromDraftFile(found) {
  return {
    draft: found.draft,
    onPosted: () => {
      const dest = path.join(POSTED_DIR, path.basename(found.file));
      fs.renameSync(found.file, dest);
    },
  };
}

function pickFallbackStaticDraft(error) {
  const categories = ["education", "enforcement-doc", "relief-type"];
  const publishedIds = readPublishedIds();
  const files = fs.readdirSync(DRAFTS_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(DRAFTS_DIR, name));
  const candidates = [];

  for (const file of files) {
    let draft;
    try {
      draft = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (!categories.includes(draft.category)) continue;
    if (publishedIds.has(draft.id)) continue;
    candidates.push({ file, draft, mtime: fs.statSync(file).mtimeMs });
  }

  candidates.sort((left, right) => left.mtime - right.mtime);
  const found = candidates[0];
  if (!found) return null;

  const plan = planFromDraftFile(found);
  const fallbackNote = `Fallback selected because current-event generation failed: ${error.message}`;
  plan.fallbackReason = fallbackNote;
  plan.draft = {
    ...plan.draft,
    sourceNotes: [plan.draft.sourceNotes, fallbackNote].filter(Boolean).join("\n"),
  };
  return plan;
}

async function planForCurrentEvent() {
  try {
    console.log(
      `[daily-runner] current-event generation timeout: ${CURRENT_EVENT_TIMEOUT_MS}ms`,
    );
    return {
      draft: await generateCurrentEventBlog({
        recentPublishedTitles: readRecentPublishedTitles(15),
        timeoutMs: CURRENT_EVENT_TIMEOUT_MS,
      }),
      onPosted: () => {
        // Current-event drafts are generated fresh, no draft file to move.
      },
    };
  } catch (err) {
    console.error(
      `[daily-runner] current-event generation failed; trying static fallback: ${err.message}`,
    );
    const fallback = pickFallbackStaticDraft(err);
    if (fallback) return fallback;
    return {
      draft: null,
      reason: `current-event generation failed and no fallback draft was available: ${err.message}`,
    };
  }
}

function readSuccessStoryQueue() {
  if (!fs.existsSync(SUCCESS_STORIES_QUEUE)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(SUCCESS_STORIES_QUEUE, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeSuccessStoryQueue(queue) {
  fs.writeFileSync(SUCCESS_STORIES_QUEUE, JSON.stringify(queue, null, 2), "utf8");
}

function appendSuccessStoryPosted(entry) {
  let posted = [];
  if (fs.existsSync(SUCCESS_STORIES_POSTED)) {
    try {
      posted = JSON.parse(fs.readFileSync(SUCCESS_STORIES_POSTED, "utf8"));
      if (!Array.isArray(posted)) posted = [];
    } catch {
      posted = [];
    }
  }
  posted.push(entry);
  fs.writeFileSync(SUCCESS_STORIES_POSTED, JSON.stringify(posted, null, 2), "utf8");
}

// ── Per-day topic selection ──────────────────────────────────────

async function pickTopicForDay(dow, state) {
  // Each branch returns either a draft + onPostHook, or null with
  // an explanation for the no-op email.
  const planFor = (category) => async () => {
    const found = pickDraftForCategory(category);
    if (!found) {
      return {
        draft: null,
        reason: `no draft available for category "${category}"`,
      };
    }
    return planFromDraftFile(found);
  };

  if (dow === 1) return planFor("enforcement-doc")();
  if (dow === 2) return planFor("relief-type")();
  if (dow === 3) return planForCurrentEvent();
  if (dow === 4) {
    // Until scripts/success-stories-queue.json is populated, Thursday
    // doubles as a second current-event slot. The dedup guard in
    // main() catches Sonnet picking a story we already covered.
    const queue = readSuccessStoryQueue();
    if (queue.length > 0) {
      return {
        draft: null,
        reason: "success-story generation not yet implemented (queue exists, awaiting wire-up)",
        pending: { type: "success-story", queueLength: queue.length },
      };
    }
    return planForCurrentEvent();
  }
  if (dow === 5) {
    // Round-robin
    const lastIdx = FRIDAY_ROTATION.indexOf(state.lastFridayCategory);
    const nextCategory = FRIDAY_ROTATION[(lastIdx + 1) % FRIDAY_ROTATION.length];
    if (nextCategory === "current-event") {
      const plan = await planForCurrentEvent();
      plan.chosenFridayCategory = "current-event";
      return plan;
    }
    const plan = await planFor(nextCategory)();
    plan.chosenFridayCategory = nextCategory;
    return plan;
  }

  return { draft: null, reason: `weekend (${dayName(dow)}) — no run` };
}

// ── Main ─────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || "");
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || String(next).startsWith("--")) {
      args[key] = "true";
      continue;
    }
    args[key] = String(next);
    i += 1;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = args["dry-run"] === "true";
  const preflight = args.preflight === "true";
  const force = args.force === "true";
  const override = args.override || null;

  const state = readState();
  const today = todayDateKey();
  const dow = todayDayOfWeek(override);

  console.log(JSON.stringify({
    event: "daily-runner-start",
    today,
    dayOfWeek: dayName(dow),
    overridden: Boolean(override),
    lastRunDate: state.lastRunDate,
    lastPostedId: state.lastPostedId,
    lastFridayCategory: state.lastFridayCategory,
    dryRun,
    preflight,
    force,
    currentEventTimeoutMs: CURRENT_EVENT_TIMEOUT_MS,
    runLogFile: RUN_LOG_FILE,
  }));

  if (!preflight && !force && state.lastRunDate === today) {
    console.log("[daily-runner] already ran today — skipping (use --force to override)");
    return;
  }

  if (dow === 0 || dow === 6) {
    console.log(`[daily-runner] ${dayName(dow)} — weekend, skipping`);
    state.lastRunDate = today;
    if (!dryRun && !preflight) writeState(state);
    return;
  }

  const plan = await pickTopicForDay(dow, state);
  if (!plan.draft) {
    console.log(`[daily-runner] no post today — ${plan.reason}`);
    if (!dryRun && !preflight) {
      // Still mark as ran so we don't keep retrying within the day.
      state.lastRunDate = today;
      writeState(state);
    }
    return;
  }

  // Dedup guard — if the picked draft's id is already in the live
  // blogData.js, skip. Most likely on Wednesdays: Sonnet's
  // web-search picks a story we already covered. Cheap regex scan
  // beats accidentally double-posting the same id.
  const publishedIds = readPublishedIds();
  if (publishedIds.has(plan.draft.id)) {
    console.log(
      `[daily-runner] draft "${plan.draft.id}" already published — skipping`,
    );
    if (!dryRun && !preflight) {
      state.lastRunDate = today;
      writeState(state);
    }
    return;
  }

  if (dryRun) {
    console.log(JSON.stringify({
      event: "dry-run-plan",
      day: dayName(dow),
      draftId: plan.draft.id,
      draftCategory: plan.draft.category,
      title: plan.draft.title,
      fallbackReason: plan.fallbackReason || null,
    }, null, 2));
    return;
  }

  if (preflight) {
    const failures = await runPreflight(plan.draft);
    console.log(JSON.stringify({
      event: "preflight",
      day: dayName(dow),
      draftId: plan.draft.id,
      draftCategory: plan.draft.category,
      title: plan.draft.title,
      fallbackReason: plan.fallbackReason || null,
      ok: failures.length === 0,
      failures,
    }, null, 2));
    if (failures.length > 0) {
      process.exitCode = 1;
    }
    return;
  }

  console.log(`[daily-runner] posting: ${plan.draft.id}`);
  let summary;
  try {
    summary = await publishBlog(plan.draft, { dayType: dayName(dow) });
  } catch (err) {
    console.error(`[daily-runner] publish failed:`, err.message);
    state.lastRunDate = today;
    writeState(state);
    process.exit(1);
  }

  if (summary.failed) {
    console.error(`[daily-runner] post completed with errors:`, summary.errors);
    process.exitCode = 1;
  } else {
    console.log(`[daily-runner] posted ${plan.draft.id} successfully`);
    if (typeof plan.onPosted === "function") {
      try {
        plan.onPosted();
      } catch (err) {
        console.error(`[daily-runner] onPosted hook failed:`, err.message);
      }
    }
  }

  state.lastRunDate = today;
  state.lastPostedId = plan.draft.id;
  if (dow === 5 && plan.chosenFridayCategory) {
    state.lastFridayCategory = plan.chosenFridayCategory.startsWith(
      "success-story-fallback-",
    )
      ? "success-story" // mark as if success-story ran so rotation moves on
      : plan.chosenFridayCategory;
  }
  writeState(state);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
