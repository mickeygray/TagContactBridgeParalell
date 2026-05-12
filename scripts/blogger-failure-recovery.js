"use strict";

// Failure-recovery agent for the blog bot pipeline.
//
// When `blogger-post-pipeline.js` exits with summary.failed === true,
// this script gathers the failure context (run log, git state of both
// repos, blogger state.json) and asks Claude to:
//   1. Classify the failure (rollback-aftermath / dirty-state /
//      build-failure / deploy-failure / unknown)
//   2. Propose a recovery plan as a list of strictly-typed actions
//   3. Indicate whether the plan is safe to auto-execute
//
// The agent CAN ONLY propose actions from a strict allowlist:
//   - `git-restore` on bot-owned paths (blogData.js, /images/*.png)
//
// Anything else (force-push, deploy, modifying state.json, touching
// node_modules, etc.) is rejected at execution time. So even if
// Claude hallucinates a wildly wrong plan, the worst it can do is
// have its plan rejected and we email a diagnosis to the operator.
//
// Auto-execution gates:
//   - Plan's `autoExecutable === true`
//   - Confidence is "high"
//   - Either env flag BLOG_FAILURE_AUTO_RECOVER=true OR --auto CLI
//
// Without those gates, the recovery script just emails the operator
// with the diagnosis + the suggested commands to run manually.
//
// Triggered from:
//   - `blogger-post-pipeline.js` catch block (automatic)
//   - Operator manually: node scripts/blogger-failure-recovery.js [--auto]
//
// Designed to never make the situation worse: any unrecognized action,
// unparseable response, or validation failure causes a clean exit
// with a "human required" email — never a destructive default.

const fs = require("fs");
const path = require("path");
const { execFileSync, execSync } = require("child_process");
const Anthropic = require("@anthropic-ai/sdk");

require("dotenv").config({
  path: path.resolve(__dirname, "..", ".env"),
});

const SONNET_MODEL = "claude-sonnet-4-5-20250929";

const WYNN_REPO = "C:/Users/Admin/Code/WynnTax";
const TAG_REPO = "C:/Users/Admin/Code/TaxAdvocateGroup";
const PARALLEL_ROOT = path.resolve(__dirname, "..");

const STATE_FILE = path.join(PARALLEL_ROOT, "scripts", "blogger-state.json");
const RUN_LOG_DIR = path.join(PARALLEL_ROOT, "runtime", "blogger", "runs");
const AUDIT_DIR = path.join(
  PARALLEL_ROOT,
  "runtime",
  "blogger",
  "recovery-audit",
);

// ── Action allowlist ────────────────────────────────────────────────
//
// The agent can ONLY return these action types/repos/paths. Anything
// else is rejected at validation time. Keep this list small — every
// addition is a new attack surface for a hallucinated recovery plan.

const ALLOWED_ACTION_TYPES = new Set(["git-restore"]);
const REPO_KEY_TO_DIR = { wynn: WYNN_REPO, tag: TAG_REPO };
const ALLOWED_PATH_PATTERNS = [
  /^client\/src\/data\/blogData\.js$/,
  /^client\/public\/images\/[a-z0-9-]+\.png$/,
];

function isAllowedPath(p) {
  const clean = String(p || "").trim();
  return ALLOWED_PATH_PATTERNS.some((rx) => rx.test(clean));
}

// ── Context gathering ───────────────────────────────────────────────

function safeReadFile(filePath, maxBytes = 64 * 1024) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > maxBytes) {
      // Tail it — keep the last maxBytes
      const fd = fs.openSync(filePath, "r");
      const buffer = Buffer.alloc(maxBytes);
      fs.readSync(fd, buffer, 0, maxBytes, stat.size - maxBytes);
      fs.closeSync(fd);
      return `[truncated to last ${maxBytes} bytes]\n` + buffer.toString("utf8");
    }
    return fs.readFileSync(filePath, "utf8");
  } catch (err) {
    return `[unreadable: ${err.message}]`;
  }
}

function gitInfo(repoDir) {
  function run(args) {
    try {
      return execFileSync("git", args, {
        cwd: repoDir,
        stdio: "pipe",
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      }).trim();
    } catch (err) {
      return `[git ${args.join(" ")} failed: ${err.message}]`;
    }
  }
  return {
    repoDir,
    status: run(["status", "--porcelain"]),
    headHash: run(["log", "-1", "--format=%H"]),
    headSubject: run(["log", "-1", "--format=%s"]),
    headAge: run(["log", "-1", "--format=%ar"]),
    recentCommits: run(["log", "--oneline", "-5"]),
    branch: run(["rev-parse", "--abbrev-ref", "HEAD"]),
    aheadBehind: run(["rev-list", "--left-right", "--count", "HEAD...@{u}"]),
  };
}

function mostRecentRunLog() {
  if (!fs.existsSync(RUN_LOG_DIR)) return null;
  const files = fs
    .readdirSync(RUN_LOG_DIR)
    .filter((name) => name.endsWith("-daily-runner.log"))
    .map((name) => ({
      name,
      mtime: fs.statSync(path.join(RUN_LOG_DIR, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);
  if (files.length === 0) return null;
  return path.join(RUN_LOG_DIR, files[0].name);
}

function gatherContext({ runLogPath: explicit = null } = {}) {
  const runLogPath = explicit || mostRecentRunLog();
  const runLog = runLogPath
    ? safeReadFile(runLogPath)
    : "[no recent run log found]";
  const stateFile = safeReadFile(STATE_FILE, 8 * 1024);
  return {
    runLogPath,
    runLog,
    stateFile,
    wynn: gitInfo(WYNN_REPO),
    tag: gitInfo(TAG_REPO),
    capturedAt: new Date().toISOString(),
  };
}

// ── Prompt + tool schema ────────────────────────────────────────────

const SYSTEM_PROMPT = [
  "You are a recovery agent for the TagContactBridge blog pipeline.",
  "",
  "The blog pipeline runs once a day, publishing a post to two sites",
  "(Wynn Tax Solutions and Tax Advocate Group). When a pipeline run",
  "fails, you are invoked with the run log, the git state of both",
  "repos, and the bot's persistent state file.",
  "",
  "Your job:",
  "  1. CLASSIFY the failure — what went wrong?",
  "  2. DIAGNOSE — explain in plain English, including evidence from",
  "     the inputs.",
  "  3. PROPOSE a recovery plan as a list of actions from the strict",
  "     allowlist below.",
  "",
  "Allowed action types:",
  '  - { "type": "git-restore", "repo": "wynn"|"tag", "paths": [<paths>] }',
  "",
  "Allowed paths for git-restore (regex match against each path):",
  "  - client/src/data/blogData.js",
  "  - client/public/images/<slug>.png",
  "",
  "Any other action type / repo / path will be rejected at execution",
  "time. If you think a different action is needed (force push,",
  "deploy, npm install, etc.), DO NOT invent a new action type —",
  "instead set autoExecutable=false and describe the manual steps in",
  "the `manualSteps` field. A human operator will read it.",
  "",
  "Classification taxonomy:",
  "  - rollback-aftermath: dirty working tree from a prior partial",
  "    deploy/rollback. The dirty files are exclusively bot-owned",
  "    (blogData.js, images/<slug>.png) and HEAD's most recent",
  "    commit is an `Auto blog:` commit matching those slugs. Safe",
  "    to auto-restore.",
  "  - dirty-state: dirty working tree but the files are NOT clearly",
  "    bot-owned, OR the head commit doesn't match a recent Auto",
  "    blog. Could be a human in-flight edit. Don't auto-recover —",
  "    surface for review.",
  "  - build-failure: the pipeline's npm run build step failed. No",
  "    auto-recover; surface the build error for a human.",
  "  - deploy-failure: SSH/EC2 step failed mid-publish. No auto-",
  "    recover — operator should retry the deploy manually after",
  "    investigating.",
  "  - unknown: anything you can't classify with high confidence.",
  "",
  "Confidence: use 'high' only when you have direct evidence in the",
  "context (e.g., dirty file list explicitly matches bot-owned",
  "patterns AND HEAD subject starts with 'Auto blog:'). Use 'medium'",
  "or 'low' otherwise.",
  "",
  "Auto-executable: set true ONLY when classification is",
  "'rollback-aftermath' with high confidence and every proposed",
  "action is a git-restore on bot-owned paths. Otherwise false.",
  "",
  "When ready, call the `propose_recovery_plan` tool. Do NOT respond",
  "with prose — only the tool call.",
].join("\n");

const RECOVERY_TOOL = {
  name: "propose_recovery_plan",
  description:
    "Submit the recovery plan after analyzing the failure context.",
  input_schema: {
    type: "object",
    required: [
      "classification",
      "confidence",
      "diagnosis",
      "actions",
      "autoExecutable",
    ],
    properties: {
      classification: {
        type: "string",
        enum: [
          "rollback-aftermath",
          "dirty-state",
          "build-failure",
          "deploy-failure",
          "unknown",
        ],
      },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      diagnosis: {
        type: "string",
        description:
          "1-3 paragraphs explaining what went wrong, citing specific evidence from the run log / git state.",
      },
      actions: {
        type: "array",
        items: {
          type: "object",
          required: ["type", "repo", "paths"],
          properties: {
            type: { type: "string", enum: ["git-restore"] },
            repo: { type: "string", enum: ["wynn", "tag"] },
            paths: { type: "array", items: { type: "string" } },
            reason: { type: "string" },
          },
        },
      },
      autoExecutable: {
        type: "boolean",
        description:
          "True only if classification is 'rollback-aftermath' with high confidence and all actions are bot-owned git-restores.",
      },
      manualSteps: {
        type: "string",
        description:
          "If autoExecutable is false, plain-English instructions for the operator. Otherwise can be a short verification note.",
      },
    },
  },
};

function buildUserMessage(context) {
  return [
    `Captured at: ${context.capturedAt}`,
    `Run log file: ${context.runLogPath || "(none found)"}`,
    "",
    "── Bot state file ──",
    context.stateFile,
    "",
    "── Recent run log (last entries) ──",
    context.runLog,
    "",
    "── Wynn repo state ──",
    `path: ${context.wynn.repoDir}`,
    `branch: ${context.wynn.branch}`,
    `HEAD: ${context.wynn.headHash} (${context.wynn.headAge})`,
    `HEAD subject: ${context.wynn.headSubject}`,
    `ahead/behind upstream: ${context.wynn.aheadBehind}`,
    "git status --porcelain:",
    context.wynn.status || "(clean)",
    "recent commits:",
    context.wynn.recentCommits,
    "",
    "── TAG repo state ──",
    `path: ${context.tag.repoDir}`,
    `branch: ${context.tag.branch}`,
    `HEAD: ${context.tag.headHash} (${context.tag.headAge})`,
    `HEAD subject: ${context.tag.headSubject}`,
    `ahead/behind upstream: ${context.tag.aheadBehind}`,
    "git status --porcelain:",
    context.tag.status || "(clean)",
    "recent commits:",
    context.tag.recentCommits,
    "",
    "Analyze the failure and call propose_recovery_plan.",
  ].join("\n");
}

// ── Claude call ─────────────────────────────────────────────────────

async function requestRecoveryPlan(context) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not set");
  }
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: SONNET_MODEL,
    max_tokens: 4000,
    system: SYSTEM_PROMPT,
    tools: [RECOVERY_TOOL],
    tool_choice: { type: "tool", name: "propose_recovery_plan" },
    messages: [{ role: "user", content: buildUserMessage(context) }],
  });
  const toolUse = response.content.find(
    (block) =>
      block.type === "tool_use" && block.name === "propose_recovery_plan",
  );
  if (!toolUse) {
    throw new Error(
      `Claude did not call propose_recovery_plan (stop_reason: ${response.stop_reason || "unknown"})`,
    );
  }
  return { plan: toolUse.input, rawResponse: response };
}

// ── Validation ──────────────────────────────────────────────────────

function validatePlan(plan) {
  const reasons = [];
  if (
    !plan ||
    typeof plan.classification !== "string" ||
    typeof plan.confidence !== "string" ||
    !Array.isArray(plan.actions)
  ) {
    reasons.push("plan is missing required fields");
    return { ok: false, reasons };
  }
  for (const action of plan.actions) {
    if (!ALLOWED_ACTION_TYPES.has(action.type)) {
      reasons.push(`disallowed action type: ${action.type}`);
      continue;
    }
    if (!REPO_KEY_TO_DIR[action.repo]) {
      reasons.push(`disallowed repo: ${action.repo}`);
      continue;
    }
    for (const p of action.paths || []) {
      if (!isAllowedPath(p)) {
        reasons.push(`disallowed path: ${p}`);
      }
    }
  }
  return { ok: reasons.length === 0, reasons };
}

// ── Execution ───────────────────────────────────────────────────────

function executeAction(action) {
  const repoDir = REPO_KEY_TO_DIR[action.repo];
  if (action.type === "git-restore") {
    if (!Array.isArray(action.paths) || action.paths.length === 0) {
      return { ok: false, reason: "no paths" };
    }
    try {
      execFileSync("git", ["restore", ...action.paths], {
        cwd: repoDir,
        stdio: "pipe",
        encoding: "utf8",
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }
  return { ok: false, reason: `unknown action type: ${action.type}` };
}

// ── Audit + email ───────────────────────────────────────────────────

function writeAuditEntry({ context, plan, executions, autoExecuted }) {
  try {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = path.join(AUDIT_DIR, `${stamp}-recovery.json`);
    fs.writeFileSync(
      filePath,
      JSON.stringify(
        { capturedAt: context.capturedAt, plan, executions, autoExecuted },
        null,
        2,
      ),
    );
    return filePath;
  } catch (err) {
    return `[audit write failed: ${err.message}]`;
  }
}

async function emailRecoverySummary({
  plan,
  executions,
  autoExecuted,
  validation,
  auditPath,
}) {
  let sendPlainEmail;
  try {
    ({ sendPlainEmail } = require(
      path.resolve(PARALLEL_ROOT, "packages", "shared-services", "src", "sendgridMailService"),
    ));
  } catch (err) {
    console.error("[recovery] sendgrid module load failed:", err.message);
    return;
  }
  const subject = autoExecuted
    ? `Blog bot — auto-recovered (${plan.classification})`
    : `Blog bot — recovery needed (${plan.classification || "unknown"})`;
  const lines = [
    `Classification: ${plan?.classification || "(unparsed)"}`,
    `Confidence: ${plan?.confidence || "(unparsed)"}`,
    `Auto-executable per agent: ${plan?.autoExecutable ? "yes" : "no"}`,
    `Validation passed: ${validation.ok ? "yes" : "no"}`,
    autoExecuted ? "Auto-executed by recovery agent." : "Not auto-executed — manual review required.",
    "",
    "── Diagnosis ──",
    plan?.diagnosis || "(none)",
    "",
    "── Proposed actions ──",
    plan?.actions?.length
      ? plan.actions
          .map(
            (a, i) =>
              `  ${i + 1}. ${a.type} on ${a.repo}: ${(a.paths || []).join(", ")}\n     reason: ${a.reason || "(none)"}`,
          )
          .join("\n")
      : "  (no actions proposed)",
    "",
    !validation.ok ? `── Validation rejections ──\n${validation.reasons.join("\n")}\n` : "",
    "── Execution results ──",
    executions.length
      ? executions
          .map(
            (e, i) =>
              `  ${i + 1}. ${e.ok ? "OK" : "FAILED"}${e.reason ? ` — ${e.reason}` : ""}`,
          )
          .join("\n")
      : "  (none — not executed)",
    "",
    plan?.manualSteps ? `── Suggested manual steps ──\n${plan.manualSteps}\n` : "",
    `Audit log: ${auditPath}`,
  ];
  try {
    const fromEmail = String(
      process.env.AUTH_OTP_FROM_EMAIL ||
        process.env.SENDGRID_FROM_EMAIL ||
        "",
    ).trim();
    const recoveryTo = String(
      process.env.BLOG_FAILURE_RECOVERY_TO ||
        process.env.BLOG_FAILURE_TO ||
        process.env.SENDGRID_FROM_EMAIL ||
        "",
    ).trim();
    if (!fromEmail || !recoveryTo) {
      console.warn("[recovery] email skipped — missing from/to env");
      return;
    }
    await sendPlainEmail("TAG", {
      personalizations: [
        {
          to: [{ email: recoveryTo }],
          custom_args: { channel: "blog-recovery" },
        },
      ],
      from: { email: fromEmail, name: "Blog Bot Recovery" },
      reply_to: { email: fromEmail, name: "Blog Bot Recovery" },
      subject,
      content: [{ type: "text/plain", value: lines.filter(Boolean).join("\n") }],
    });
  } catch (err) {
    console.error("[recovery] email send failed:", err.message);
  }
}

// ── Main ────────────────────────────────────────────────────────────

async function runRecovery({ auto = false, runLogPath = null } = {}) {
  const context = gatherContext({ runLogPath });
  let plan = null;
  let rawResponse = null;
  try {
    ({ plan, rawResponse } = await requestRecoveryPlan(context));
  } catch (err) {
    console.error("[recovery] Claude call failed:", err.message);
    // Even on Claude failure, write an audit and notify.
    const auditPath = writeAuditEntry({
      context,
      plan: { error: err.message },
      executions: [],
      autoExecuted: false,
    });
    await emailRecoverySummary({
      plan: {
        classification: "unknown",
        diagnosis: `Recovery agent could not reach Claude: ${err.message}. Operator must investigate manually.`,
        actions: [],
        autoExecutable: false,
      },
      executions: [],
      autoExecuted: false,
      validation: { ok: false, reasons: ["claude-api-failed"] },
      auditPath,
    });
    return { ok: false, reason: "claude-failed" };
  }

  const validation = validatePlan(plan);
  const envAllowsAuto =
    String(process.env.BLOG_FAILURE_AUTO_RECOVER || "").toLowerCase() ===
    "true";
  const shouldAutoExecute =
    validation.ok &&
    plan.autoExecutable === true &&
    plan.confidence === "high" &&
    plan.classification === "rollback-aftermath" &&
    (auto || envAllowsAuto);

  const executions = [];
  if (shouldAutoExecute) {
    for (const action of plan.actions) {
      executions.push(executeAction(action));
    }
  }
  const autoExecuted = shouldAutoExecute && executions.every((e) => e.ok);
  const auditPath = writeAuditEntry({
    context,
    plan,
    executions,
    autoExecuted,
  });

  console.log(
    JSON.stringify(
      {
        event: "recovery-complete",
        classification: plan.classification,
        confidence: plan.confidence,
        validationOk: validation.ok,
        autoExecuted,
        actionsExecuted: executions.length,
        auditPath,
      },
      null,
      2,
    ),
  );

  await emailRecoverySummary({
    plan,
    executions,
    autoExecuted,
    validation,
    auditPath,
  });

  return {
    ok: true,
    plan,
    executions,
    autoExecuted,
    auditPath,
  };
}

if (require.main === module) {
  const args = new Set(process.argv.slice(2));
  const auto = args.has("--auto");
  const runLogPath = (() => {
    const flag = process.argv.find((arg) => arg.startsWith("--run-log="));
    return flag ? flag.slice(10) : null;
  })();
  runRecovery({ auto, runLogPath })
    .then((result) => {
      if (!result.ok) process.exit(1);
    })
    .catch((err) => {
      console.error("[recovery] fatal:", err.stack || err.message);
      process.exit(1);
    });
}

module.exports = {
  runRecovery,
  gatherContext,
  validatePlan,
  ALLOWED_ACTION_TYPES,
  ALLOWED_PATH_PATTERNS,
};
