"use strict";

const fs = require("fs");
const path = require("path");

// v2 prompt — designed for use as the `system` parameter in the
// Anthropic Messages API. We load it from the sibling .md file rather
// than inlining as a template literal because the prompt contains
// triple-backticks, inline-code spans, and tens of thousands of
// characters of structured markdown. Keeping it in markdown means the
// prompt is editable as prose, diffs cleanly, and won't accumulate JS
// escape gymnastics over time.
//
// Recommended models (from the v2 doc header):
//   - claude-sonnet-4-6  → live call simulation (default)
//   - claude-opus-4-6    → high-stakes evaluation / scorecard runs
//
// These constants are advisory; the runtime model is still env-driven
// via SALES_TRAINER_ANTHROPIC_MODEL. Anything that wants to honor the
// doc-recommended default without an env var can import these.
const RECOMMENDED_LIVE_MODEL = "claude-sonnet-4-6";
const RECOMMENDED_EVAL_MODEL = "claude-opus-4-6";

// Read once at module load. The .md file is shipped with the package
// so this is a synchronous read of a few tens of KB on cold start —
// not worth making async. If the file is missing we want to fail loud
// at boot, not at first request, which is what readFileSync gives us.
const PROMPT_PATH = path.join(__dirname, "taxResolutionSalesTrainerPrompt.md");
const TAX_RESOLUTION_SALES_TRAINER_PROMPT = fs
  .readFileSync(PROMPT_PATH, "utf8")
  .trim();

// Slim live-turn prompt — used for EVERY live turn. The slim prompt
// carries the load-bearing training-mode block, behavioral rules, and
// phase pacing. The per-turn session header (built by buildSessionHeader)
// injects personality, current state, recent-message awareness, and a
// compact training-mode reminder. Together those give Sonnet enough
// context to behave on-spec without the 27k master prompt loaded.
//
// Why this works: the "what should I do this turn" decisions come from
// the session header's situational context (personality + state +
// recent messages + training directive), not from the 27k reference
// library. The simulator doesn't need the full objection encyclopedia
// every turn — it needs the right move to fire NEXT, which the
// recent-message awareness handles directly.
//
// Token math at runtime:
//   - Slim + session header (cached): ~3k tokens per turn
//   - Full master prompt (~28k tokens): reserved for evals, "break
//     character" recovery turns, coaching panel, and scorecard runs.
//     NOT loaded on live turns.
const LIVE_TURN_PROMPT_PATH = path.join(
  __dirname,
  "taxResolutionSalesTrainerPrompt.liveTurn.md",
);
const TAX_RESOLUTION_SALES_TRAINER_LIVE_TURN_PROMPT = fs
  .readFileSync(LIVE_TURN_PROMPT_PATH, "utf8")
  .trim();

module.exports = {
  TAX_RESOLUTION_SALES_TRAINER_PROMPT,
  TAX_RESOLUTION_SALES_TRAINER_LIVE_TURN_PROMPT,
  RECOMMENDED_LIVE_MODEL,
  RECOMMENDED_EVAL_MODEL,
};
