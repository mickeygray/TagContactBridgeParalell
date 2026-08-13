"use strict";

const envTrue = (env, key) => String(env?.[key] || "false").trim().toLowerCase() === "true";

function nightlyOwnsStandaloneTask(taskFlag, {
  env = process.env,
  nightlyConfigured = false,
} = {}) {
  return (nightlyConfigured === true || envTrue(env, "NIGHTLY_HYGIENE_ENABLED"))
    && envTrue(env, taskFlag);
}

module.exports = {
  envTrue,
  nightlyOwnsStandaloneTask,
};
