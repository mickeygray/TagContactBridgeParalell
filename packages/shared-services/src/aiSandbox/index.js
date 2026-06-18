"use strict";

// AI Bus SANDBOX — one place that holds the real background material (prompts,
// schemas, caches, rules, plumbing) copied out of the live services, so the bus
// can be built + tested around it WITHOUT invoking the live code or starting
// from scratch. Duplication is intentional; see README.md for the drift policy.

const liveCoach = require("./prompts/liveCoach");
const compliance = require("./prompts/compliance");
const scoring = require("./prompts/scoring");
const files = require("./prompts/files");
const schemas = require("./schemas");
const { CACHE } = require("./cache");
const rules = require("./rules");
const { TASKS, getSandboxTask, listSandboxTasks } = require("./tasks");

module.exports = {
  prompts: { ...liveCoach, ...compliance, ...scoring, ...files },
  schemas,
  cache: CACHE,
  rules,
  tasks: TASKS,
  getSandboxTask,
  listSandboxTasks,
};
