"use strict";

/**
 * logics-task-create — create ONE task in Logics, to learn what the API returns.
 *
 * POST https://taxag.logiqsapi.com/publicapi/V4/Task/Task
 *
 * Required: CaseID, Subject, Reminder, TaskType, DueDate, UserID (array)
 * Optional: EndDate, PriorityID, StatusID, TaskCategoryID, Comments, AllDayEvent
 *
 * THIS WRITES TO PRODUCTION. The task appears in a real Logics queue. Everything
 * about it is therefore labelled as a test, and the created id is printed so it
 * can be found and removed.
 *
 * The point is not the task — it is the RESPONSE. We need to know whether Logics
 * returns a TaskID, because without one there is nothing to update or delete
 * later, and a Jira mirror with no handle back to its task can only ever create,
 * never correct.
 *
 *   node scripts/analysis/logics-task-create.js <caseId> <userId> [domain]
 */

require("dotenv").config({ quiet: true });
if (process.env.DNS_SERVERS) {
  require("dns").setServers(String(process.env.DNS_SERVERS).split(",").map((s) => s.trim()));
}

const path = require("path");
const { connectMongo, disconnectMongo } = require(path.join(__dirname, "../../packages/event-core/src"));
const { getSharedConfig } = require(path.join(__dirname, "../../packages/shared-config/src"));
const { createLogicsClient } = require(path.join(__dirname, "../../packages/shared-integrations/src"));

const iso = (d) => new Date(d).toISOString();

async function main() {
  const caseId = Number(process.argv[2]);
  const userId = process.argv[3];
  const domain = (process.argv[4] || "TAG").toUpperCase();
  if (!Number.isFinite(caseId)) throw new Error("usage: logics-task-create <caseId> <userId> [domain]");

  await connectMongo(getSharedConfig());
  const client = createLogicsClient(domain);

  const now = Date.now();
  const payload = {
    CaseID: caseId,
    Subject: "TEST — integration probe (safe to delete)",
    // Required. Tomorrow morning, so it cannot fire a reminder at somebody now.
    Reminder: iso(now + 24 * 3600 * 1000),
    TaskType: 1,
    DueDate: iso(now + 48 * 3600 * 1000),
    UserID: userId ? [Number(userId)].filter(Number.isFinite) : [],
    Comments: "Created by an integration probe to test create/update/delete. Not real work.",
    AllDayEvent: false,
  };

  console.log("  POST Task/Task");
  console.log("  payload: " + JSON.stringify(payload, null, 2).split("\n").join("\n  "));

  try {
    const res = await client.createTask(payload);
    console.log("\n  RESPONSE:");
    console.log("  " + JSON.stringify(res, null, 2).split("\n").join("\n  ").slice(0, 1400));
    // The handle we actually need.
    const body = res?.Data ?? res?.data ?? res;
    const id = body?.TaskID ?? body?.taskId ?? body?.ID ?? body?.Id
      ?? (Array.isArray(body) ? body[0]?.TaskID : undefined);
    console.log("\n  TaskID returned: " + (id ?? "(none — nothing to update or delete by)"));
  } catch (error) {
    console.log("\n  FAILED: " + error.message);
    if (error.status) console.log("  status: " + error.status);
    if (error.body) console.log("  body: " + JSON.stringify(error.body).slice(0, 600));
    if (error.response) console.log("  response: " + JSON.stringify(error.response).slice(0, 600));
  }

  await disconnectMongo();
}

main().catch((e) => { console.error("FAILED " + e.message); process.exitCode = 1; });
