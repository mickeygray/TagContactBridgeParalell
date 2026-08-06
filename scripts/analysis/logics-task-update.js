"use strict";

/**
 * logics-task-update — can a Logics task be changed or removed after creation?
 *
 * The Jira mirror depends on this. A create-only API means the mirror can never
 * correct itself: a renamed or cancelled Jira issue would leave a stale Logics
 * task with no way to fix it except telling somebody.
 *
 * The public docs describe POST Task/Task for creation and say nothing about
 * update or delete, so this probes the plausible shapes and reports which the
 * API actually accepts. Each attempt is reported whether it works or not —
 * a 404 or 405 is as much of an answer as a 200.
 *
 *   node scripts/analysis/logics-task-update.js <taskId> <caseId> [domain]
 */

require("dotenv").config({ quiet: true });
if (process.env.DNS_SERVERS) {
  require("dns").setServers(String(process.env.DNS_SERVERS).split(",").map((s) => s.trim()));
}

const path = require("path");
const { connectMongo, disconnectMongo } = require(path.join(__dirname, "../../packages/event-core/src"));
const { getSharedConfig } = require(path.join(__dirname, "../../packages/shared-config/src"));
const { getSharedConfig: cfg } = require(path.join(__dirname, "../../packages/shared-config/src"));

const iso = (d) => new Date(d).toISOString();

async function main() {
  const taskId = Number(process.argv[2]);
  const caseId = Number(process.argv[3]);
  const domain = (process.argv[4] || "TAG").toUpperCase();
  if (!Number.isFinite(taskId)) throw new Error("usage: logics-task-update <taskId> <caseId> [domain]");

  await connectMongo(getSharedConfig());

  // Reach the transport directly so arbitrary verbs/paths can be probed — the
  // typed client only exposes createTask.
  const conf = cfg();
  const tenant = (conf.logics?.tenants || {})[domain] || conf.logics || {};
  const base = String(tenant.baseUrl || "https://taxag.logiqsapi.com/publicapi/V4").replace(/\/$/, "");
  const apiKey = tenant.apiKey || tenant.key || process.env.LOGICS_API_KEY;

  const call = async (label, method, urlPath, body) => {
    const url = `${base}/${urlPath}`;
    try {
      const res = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { apikey: apiKey } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      console.log(`  ${label.padEnd(34)} ${method} ${urlPath} -> ${res.status}`);
      console.log(`      ${text.slice(0, 220)}`);
      return { status: res.status, text };
    } catch (error) {
      console.log(`  ${label.padEnd(34)} ${method} ${urlPath} -> ERROR ${error.message}`);
      return null;
    }
  };

  const updated = {
    TaskID: taskId,
    CaseID: caseId,
    Subject: "TEST — SUBJECT CHANGED BY PROBE",
    Reminder: iso(Date.now() + 24 * 3600 * 1000),
    TaskType: 1,
    DueDate: iso(Date.now() + 48 * 3600 * 1000),
    UserID: [],
    Comments: "Subject updated by the integration probe.",
  };

  console.log(`\n  Probing UPDATE paths for TaskID ${taskId}:\n`);
  await call("POST Task/Task with TaskID", "POST", "Task/Task", updated);
  await call("PUT Task/Task", "PUT", "Task/Task", updated);
  await call("PUT Task/Task/{id}", "PUT", `Task/Task/${taskId}`, updated);
  await call("POST Task/UpdateTask", "POST", "Task/UpdateTask", updated);

  console.log(`\n  Probing DELETE paths:\n`);
  await call("DELETE Task/Task/{id}", "DELETE", `Task/Task/${taskId}`);
  await call("DELETE Task/Task?TaskID=", "DELETE", `Task/Task?TaskID=${taskId}`);
  await call("POST Task/DeleteTask", "POST", "Task/DeleteTask", { TaskID: taskId });

  await disconnectMongo();
}

main().catch((e) => { console.error("FAILED " + e.message); process.exitCode = 1; });
