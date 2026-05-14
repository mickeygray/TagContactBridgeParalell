"use strict";

// Blog bot status feed for the Deploy workspace.
//
// Surfaces everything an operator might want to see about the blog
// pipeline without having to spelunk:
//   - The bot's persistent state file (last run date, last posted id,
//     last Friday category)
//   - Most-recent N daily-runner logs (timestamp + parsed status line)
//   - Most-recent N recovery-audit entries (the failure-recovery
//     agent's classifications + actions)
//   - The current cross-repo slug-consistency state (same check the
//     pipeline preflight runs — surfaced here so drift is visible
//     BEFORE the next bot run)
//   - The most-recent "Auto blog:" commit per repo (the last thing
//     the bot actually shipped, with hash + age)
//
// All best-effort: any individual data source that's missing or
// unreadable degrades gracefully to a null/empty placeholder, so the
// UI never gets a 500 from this endpoint.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { TAG_REPO, WYNN_REPO } = require("../../../scripts/blogger-paths");

const PARALLEL_ROOT = path.resolve(__dirname, "..", "..", "..");
const STATE_FILE = path.join(PARALLEL_ROOT, "scripts", "blogger-state.json");
const RUN_LOG_DIR = path.join(PARALLEL_ROOT, "runtime", "blogger", "runs");
const RECOVERY_AUDIT_DIR = path.join(
  PARALLEL_ROOT,
  "runtime",
  "blogger",
  "recovery-audit",
);

function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readBlogState() {
  return safeReadJson(STATE_FILE);
}

// List the most-recent N run logs in runtime/blogger/runs/. Each is
// named `<iso-timestamp>-<pid>-daily-runner.log`. We don't parse the
// full body here — just surface the filename + mtime + a short tail
// so the UI can render a list quickly. The Deploy workspace can fetch
// a full log on demand if we ever wire that.
function listRecentRunLogs(limit = 8) {
  try {
    if (!fs.existsSync(RUN_LOG_DIR)) return [];
    const files = fs
      .readdirSync(RUN_LOG_DIR)
      .filter((name) => name.endsWith("-daily-runner.log"))
      .map((name) => {
        const fullPath = path.join(RUN_LOG_DIR, name);
        return { name, mtime: fs.statSync(fullPath).mtimeMs, fullPath };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);
    return files.map((f) => {
      // Last 600 chars of the log — usually contains the runner's
      // closing line ("[daily-runner] posted X successfully" or the
      // error). Cheap signal for the UI.
      let tail = "";
      try {
        const buf = fs.readFileSync(f.fullPath, "utf8");
        tail = buf.length > 600 ? buf.slice(-600) : buf;
      } catch {
        tail = "";
      }
      // Inferred outcome from tail text.
      let outcome = "unknown";
      if (/posted .+ successfully/.test(tail)) outcome = "success";
      else if (/preflight failed|publish failed|rolled back/i.test(tail)) outcome = "failed";
      else if (/no post today|already published — skipping/i.test(tail)) outcome = "skipped";
      else if (/posting:/.test(tail)) outcome = "started";
      return {
        name: f.name,
        mtime: new Date(f.mtime).toISOString(),
        outcome,
        tail: tail.trim().slice(-400),
      };
    });
  } catch {
    return [];
  }
}

function listRecentRecoveryAudits(limit = 6) {
  try {
    if (!fs.existsSync(RECOVERY_AUDIT_DIR)) return [];
    const files = fs
      .readdirSync(RECOVERY_AUDIT_DIR)
      .filter((name) => name.endsWith("-recovery.json"))
      .map((name) => {
        const fullPath = path.join(RECOVERY_AUDIT_DIR, name);
        return { name, mtime: fs.statSync(fullPath).mtimeMs, fullPath };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);
    return files
      .map((f) => {
        const data = safeReadJson(f.fullPath);
        if (!data) return null;
        return {
          name: f.name,
          mtime: new Date(f.mtime).toISOString(),
          classification: data.plan?.classification || "unknown",
          confidence: data.plan?.confidence || "unknown",
          autoExecuted: Boolean(data.autoExecuted),
          actionCount: Array.isArray(data.plan?.actions)
            ? data.plan.actions.length
            : 0,
          diagnosisExcerpt:
            typeof data.plan?.diagnosis === "string"
              ? data.plan.diagnosis.slice(0, 200)
              : null,
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function readBlogIdsInRepo(repoDir) {
  try {
    const file = path.join(
      repoDir,
      "client",
      "src",
      "data",
      "blogData.js",
    );
    if (!fs.existsSync(file)) return null;
    const text = fs.readFileSync(file, "utf8");
    const ids = new Set();
    const counts = new Map();
    const regex = /id:\s*"([^"]+)"/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      ids.add(match[1]);
      counts.set(match[1], (counts.get(match[1]) || 0) + 1);
    }
    const duplicates = [...counts.entries()].filter(([, n]) => n > 1);
    return { ids, duplicates, count: ids.size };
  } catch {
    return null;
  }
}

function gitLastAutoBlogCommit(repoDir) {
  try {
    const out = execFileSync(
      "git",
      [
        "log",
        "-1",
        "--grep=^Auto blog:",
        "--format=%H%x09%s%x09%ai",
      ],
      {
        cwd: repoDir,
        stdio: "pipe",
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      },
    ).trim();
    if (!out) return null;
    const [hash, subject, isoDate] = out.split("\t");
    return { hash, subject, committedAt: isoDate };
  } catch {
    return null;
  }
}

function computeSlugSync() {
  const wynn = readBlogIdsInRepo(WYNN_REPO);
  const tag = readBlogIdsInRepo(TAG_REPO);
  if (!wynn || !tag) {
    return {
      inSync: false,
      reason: "could not read both blogData.js files",
      wynnCount: wynn?.count ?? null,
      tagCount: tag?.count ?? null,
      duplicates: { wynn: [], tag: [] },
      wynnOnly: [],
      tagOnly: [],
    };
  }
  const wynnOnly = [...wynn.ids].filter((id) => !tag.ids.has(id));
  const tagOnly = [...tag.ids].filter((id) => !wynn.ids.has(id));
  const duplicates = {
    wynn: wynn.duplicates.map(([id, n]) => ({ id, count: n })),
    tag: tag.duplicates.map(([id, n]) => ({ id, count: n })),
  };
  const inSync =
    wynnOnly.length === 0 &&
    tagOnly.length === 0 &&
    duplicates.wynn.length === 0 &&
    duplicates.tag.length === 0;
  return {
    inSync,
    wynnCount: wynn.count,
    tagCount: tag.count,
    duplicates,
    wynnOnly: wynnOnly.slice(0, 10),
    tagOnly: tagOnly.slice(0, 10),
  };
}

async function buildBlogBotStatus({
  runLogLimit = 8,
  recoveryAuditLimit = 6,
} = {}) {
  const [state, recentRuns, recentRecoveries, slugSync, wynnLast, tagLast] =
    [
      readBlogState(),
      listRecentRunLogs(runLogLimit),
      listRecentRecoveryAudits(recoveryAuditLimit),
      computeSlugSync(),
      gitLastAutoBlogCommit(WYNN_REPO),
      gitLastAutoBlogCommit(TAG_REPO),
    ];

  // Last run outcome — whatever the most-recent run log says. If the
  // tail says "preflight failed" or a recovery-audit fired right after
  // the run, classify as failed; if it says "posted X successfully",
  // success; otherwise unknown.
  const lastRunOutcome = recentRuns[0]?.outcome || "unknown";

  // Health summary for the workspace header pill.
  const healthIssues = [];
  if (!slugSync.inSync) {
    if (slugSync.wynnOnly.length > 0) {
      healthIssues.push(`${slugSync.wynnOnly.length} slug(s) in wynn not in tag`);
    }
    if (slugSync.tagOnly.length > 0) {
      healthIssues.push(`${slugSync.tagOnly.length} slug(s) in tag not in wynn`);
    }
    if (slugSync.duplicates.wynn.length > 0) {
      healthIssues.push(
        `wynn duplicate slug(s): ${slugSync.duplicates.wynn.map((d) => d.id).join(", ")}`,
      );
    }
    if (slugSync.duplicates.tag.length > 0) {
      healthIssues.push(
        `tag duplicate slug(s): ${slugSync.duplicates.tag.map((d) => d.id).join(", ")}`,
      );
    }
  }
  // state.lastPostedId should exist in both repos if it's set.
  if (state?.lastPostedId) {
    const wynnIds = readBlogIdsInRepo(WYNN_REPO);
    const tagIds = readBlogIdsInRepo(TAG_REPO);
    if (wynnIds && !wynnIds.ids.has(state.lastPostedId)) {
      healthIssues.push(`state.lastPostedId not in wynn`);
    }
    if (tagIds && !tagIds.ids.has(state.lastPostedId)) {
      healthIssues.push(`state.lastPostedId not in tag`);
    }
  }

  return {
    capturedAt: new Date().toISOString(),
    state,
    lastRunOutcome,
    recentRuns,
    recentRecoveries,
    slugSync,
    lastPublished: {
      wynn: wynnLast,
      tag: tagLast,
    },
    health: {
      ok: healthIssues.length === 0,
      issues: healthIssues,
    },
  };
}

module.exports = {
  buildBlogBotStatus,
  // Exposed for tests / direct callers
  readBlogState,
  listRecentRunLogs,
  listRecentRecoveryAudits,
  computeSlugSync,
};
