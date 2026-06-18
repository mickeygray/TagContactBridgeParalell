"use strict";

// SANDBOX — loads the file-based prompts that were cp'd into ./ from the live
// tree (read once at require, like the live server does). Big prose prompts live
// as .md so they stay clean and diffable.

const fs = require("fs");
const path = require("path");

function load(name) {
  try {
    return fs.readFileSync(path.join(__dirname, name), "utf8");
  } catch {
    return "";
  }
}

module.exports = {
  UNIVERSAL_SALES_SCRIPT: load("universalSalesScript.md"), // ← packages/shared-services/src/universalSalesScript.md
  RESOLUTION_PITCH_DOCTRINE: load("resolutionPitchDoctrine.md"), // ← packages/shared-services/src/resolutionPitchDoctrine.md
  SALES_TRAINER_FULL: load("salesTrainer.full.md"), // ← taxResolutionSalesTrainerPrompt.md (v2, ~27k tokens)
  SALES_TRAINER_LIVE_TURN: load("salesTrainer.liveTurn.md"), // ← taxResolutionSalesTrainerPrompt.liveTurn.md
};
