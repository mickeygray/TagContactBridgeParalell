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

// Slim live-turn prompt — used only during in-character chat turns.
// The full prompt is loaded for profile generation, playbook generation,
// coaching panel, and end-of-call scorecard, where the deeper reference
// material is needed. For live turns, the locked profile + playbook
// already encoded the per-caller specifics, so the model doesn't need
// to re-attend over the full reference library every turn.
//
// Expected savings vs. full prompt at runtime:
//   - Full: ~27,500 input tokens (cached) per turn
//   - Slim: ~2,300 input tokens (cached) per turn
//   - Difference: ~25k tokens of attention math eliminated per response
//     ≈ 500-1500ms saved per turn even with cache hit
//
// The slim prompt is still cached — it just has a different cache key
// from the full prompt, so they're cached independently.
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
